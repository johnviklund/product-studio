import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import {
  CopilotConnectedWritableRuntime,
  PortfolioService,
  type ConnectedReviewRuntime,
  type ConnectedWritableRuntime,
  type ConnectedShapingRuntime,
  type PreparedConnectedReviewRuntime,
  type PreparedConnectedRuntime,
  type PreparedShapingRuntime,
} from "../../src/application/portfolio";
import {
  WorkItemController,
  deriveControllerIdempotencyKey,
} from "../../src/application/work-item-controller";
import {
  createImportRunId,
  hashResultContent,
  serializeExternalResult,
  type StoredImportEvidence,
} from "../../src/domain/result";
import {
  DuplicateWorkspaceError,
  INBOX_SOURCE_ID,
  INBOX_SOURCE_LABEL,
  PortfolioWorkItemNotFoundError,
  UnknownPortfolioSourceError,
  type PortfolioWorkItemIndex,
} from "../../src/domain/portfolio";
import {
  hashGoalContract,
  hashGoalInput,
  hashShapingDecisionState,
  goalContractFromSpecProposal,
  type ShapingIngressInstructionV1,
  type ShapingMissionPackage,
  type ShapingPhase,
} from "../../src/domain/shaping";
import {
  evaluateShapingPermissionRequest,
  type ShapingRunWritePolicy,
} from "../../src/domain/shaping-run";
import {
  resolveCapabilityEnvelope,
  type CanonicalCapabilityRequest,
} from "../../src/domain/capability-envelope";
import {
  WorkItemTargetCollisionError,
  WorkItemTransferFailedError,
  type ControllerRunManifest,
  type WorkItem,
  type WorkItemPhase,
  type WorkItemPriority,
  type WorkItemType,
  type VerificationCommand,
} from "../../src/domain/work-item";
import type {
  GitVerificationAdapter,
  VerificationRunner,
} from "../../src/domain/verification";
import { SQLitePortfolioIndex } from "../../src/index/work-item-index";
import { ProductWorkspace } from "../../src/workspace/product-workspace";
import { PortfolioPreferencesStore } from "../../src/workspace/portfolio-preferences";
import { PortfolioRegistry } from "../../src/workspace/portfolio-registry";
import type {
  AcpClientAdapter,
  AcpEventSink,
  AcpRuntimeProfile,
  AcpRunResult,
  AcpSession,
  AcpWriteTextFileHandler,
} from "../../src/infrastructure/acp/acp-client";
import { StdioAcpClientAdapter } from "../../src/infrastructure/acp/acp-client";

const createdRoots: string[] = [];
const controllerGit: GitVerificationAdapter = {
  async resolveCommit() {
    return "a".repeat(40);
  },
  async isAncestor() {
    return true;
  },
  async readHeadCommit() {
    return "a".repeat(40);
  },
  async isWorktreeCleanExcludingFounder() {
    return true;
  },
  async listChangedFiles() {
    return ["src/application/portfolio.ts"];
  },
};
const controllerRunner: VerificationRunner = {
  async run(command: VerificationCommand) {
    return {
      name: command.name,
      argv: command.argv,
      started_at: "2026-07-22T12:00:00.000Z",
      completed_at: "2026-07-22T12:00:01.000Z",
      duration_ms: 1000,
      status: "passed",
      exit_code: 0,
      signal: null,
      stdout: "",
      stderr: "",
      output_truncated: false,
    };
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class PausedShapingPublicationWorkspace extends ProductWorkspace {
  readonly publicationStarted = deferred<void>();
  readonly resumePublication = deferred<void>();

  protected override async afterShapingAppliedComponentWritten(
    component: "result" | "import" | "production" | "applied",
  ): Promise<void> {
    if (component === "applied") {
      this.publicationStarted.resolve(undefined);
      await this.resumePublication.promise;
    }
  }
}

function preparedRuntime(
  session: AcpSession,
  requestedModel = "copilot-default",
  onStart?: () => void,
): {
  runtime: ConnectedWritableRuntime;
  prepare: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
} {
  const start = vi.fn(async (eventSink: AcpEventSink) => {
    onStart?.();
    await eventSink.append({
      schema_version: 1,
      sequence: 1,
      observed_at: "2026-07-26T18:00:00.000Z",
      kind: "session_started",
      payload: {},
      previous_event_sha256: null,
      event_sha256: "a".repeat(64),
    });
    return session;
  });
  const prepared: PreparedConnectedRuntime = {
    requested_model: requestedModel,
    reasoning_effort: "high",
    sanitized_profile: {
      adapter_id: "copilot-acp",
      adapter_version: "1.0.0",
      profile_id: "noninteractive-execute-v1",
      executable: "copilot",
      argv: ["--acp", "--stdio"],
      requested_model: requestedModel,
      reasoning_effort: "high",
      available_tools: ["edit"],
      excluded_tools: ["delete"],
      authentication: "noninteractive_authenticated",
      execution_mode: "permission_mediated_local",
      containment_assurance: "not_independently_enforced",
      machine_authority: "launching_user",
      requested_mcp_server_count: 0,
      client_fs_read_text_file: false,
      client_fs_write_text_file: false,
      credential_environment: "explicit_allowlist_without_credential_values",
    },
    start,
  };
  const prepare = vi.fn(
    async (input: Parameters<ConnectedWritableRuntime["prepare"]>[0]) => {
      void input;
      return prepared;
    },
  );
  return {
    runtime: {
      configuration: () => ({
        adapter_id: "copilot-acp",
        adapter_version: "1.0.0",
        profile_id: "noninteractive-execute-v1",
        available_model_ids: [requestedModel],
        default_model: requestedModel,
      }),
      prepare,
    },
    prepare,
    start,
  };
}

function preparedReviewRuntime(
  session: AcpSession,
  requestedModel = "review-model",
  failStartCount = 0,
): {
  runtime: ConnectedReviewRuntime;
  prepare: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  write(path: string, content: string): Promise<void>;
} {
  let writer: AcpWriteTextFileHandler | null = null;
  let startCount = 0;
  const start = vi.fn(
    async (
      _eventSink: AcpEventSink,
      writeTextFile: AcpWriteTextFileHandler,
    ) => {
      startCount += 1;
      if (startCount <= failStartCount) {
        throw new Error("Review adapter unavailable after durable launch");
      }
      writer = writeTextFile;
      return session;
    },
  );
  const prepared: PreparedConnectedReviewRuntime = {
    requested_model: requestedModel,
    reasoning_effort: "high",
    sanitized_profile: {
      adapter_id: "copilot-acp",
      adapter_version: "1.0.0",
      profile_id: "noninteractive-review-v1",
      executable: "copilot",
      argv: ["--acp", "--stdio"],
      requested_model: requestedModel,
      reasoning_effort: "high",
      available_tools: ["apply_patch", "view"],
      excluded_tools: ["execute"],
      authentication: "noninteractive_authenticated",
      execution_mode: "permission_mediated_local",
      containment_assurance: "not_independently_enforced",
      machine_authority: "launching_user",
      requested_mcp_server_count: 0,
      client_fs_read_text_file: true,
      client_fs_write_text_file: true,
      credential_environment: "explicit_allowlist_without_credential_values",
    },
    start,
  };
  const prepare = vi.fn(async () => prepared);
  return {
    runtime: {
      configuration: () => ({
        adapter_id: "copilot-acp",
        adapter_version: "1.0.0",
        profile_id: "noninteractive-review-v1",
        available_model_ids: [requestedModel],
        default_model: requestedModel,
      }),
      prepare,
    },
    prepare,
    start,
    async write(path, content) {
      if (writer === null) {
        throw new Error("Review runtime writer is not active.");
      }
      await writer(
        {
          sessionId: session.session_id,
          path,
          content,
        } as never,
        new AbortController().signal,
      );
    },
  };
}

function preparedShapingRuntime(
  initialModels = ["brainstorm-model", "spec-model", "plan-model"],
) {
  let availableModels = [...initialModels];
  let prepareFailure: Error | null = null;
  let sessionOrdinal = 0;
  const start = vi.fn(async (): Promise<AcpSession> => {
    sessionOrdinal += 1;
    return {
      session_id: `fake-shaping-session-${sessionOrdinal}`,
      protocol_version: 1,
      requested_mcp_server_count: 0,
      config_options: [],
      wall_clock_timeout_ms: 2_000,
      process: {
        pid: 5000 + sessionOrdinal,
        process_group_id: 5000 + sessionOrdinal,
        started_at: "2026-07-30T12:00:00.000Z",
      },
      run: vi.fn(() => new Promise<AcpRunResult>(() => undefined)),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
  });
  const prepare = vi.fn(
    async (input: {
      mission: ShapingMissionPackage;
      requested_model: string;
    }): Promise<PreparedShapingRuntime> => {
      if (prepareFailure !== null) {
        throw prepareFailure;
      }
      return {
        requested_model: input.requested_model,
        reasoning_effort: "high",
        sanitized_profile: {
          adapter_id: "fake-shaping-acp",
          adapter_version: "1.0.0",
          profile_id: "artifact-only-shaping-v1",
          executable: "fake-acp",
          argv: ["--stdio", "--model", input.requested_model],
          requested_model: input.requested_model,
          reasoning_effort: "high",
          available_tools: ["edit"],
          excluded_tools: ["shell", "url", "mcp"],
          authentication: "noninteractive_authenticated",
          execution_mode: "permission_mediated_local",
          containment_assurance: "not_independently_enforced",
          machine_authority: "launching_user",
          requested_mcp_server_count: 0,
          client_fs_read_text_file: false,
          client_fs_write_text_file: true,
          credential_environment:
            "explicit_allowlist_without_credential_values",
        },
        start,
      };
    },
  );
  const runtime: ConnectedShapingRuntime = {
    configuration: () => ({
      adapter_id: "fake-shaping-acp",
      adapter_version: "1.0.0",
      profile_id: "artifact-only-shaping-v1",
      available_model_ids: availableModels,
    }),
    prepare,
  };
  return {
    runtime,
    prepare,
    start,
    setAvailableModels(models: string[]) {
      availableModels = [...models];
    },
    setPrepareFailure(error: Error | null) {
      prepareFailure = error;
    },
  };
}

function canonicalFakeRequest(raw: unknown): CanonicalCapabilityRequest | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const request = raw as Partial<CanonicalCapabilityRequest>;
  return request.schema_version === 1 && typeof request.kind === "string"
    ? (request as CanonicalCapabilityRequest)
    : null;
}

function modelConfigOption(
  currentValue: string,
  deploymentId: string,
) {
  return {
    type: "select" as const,
    id: "model",
    name: "MODEL_NAME_MUST_NOT_PERSIST",
    description: "MODEL_DESCRIPTION_MUST_NOT_PERSIST",
    category: "model",
    currentValue,
    options: [
      { value: "adapter-model-a", name: "MODEL_A_NAME_MUST_NOT_PERSIST" },
      { value: "adapter-model-b", name: "MODEL_B_NAME_MUST_NOT_PERSIST" },
    ],
    _meta: {
      deployment_id: deploymentId,
      private_note: "MODEL_META_MUST_NOT_PERSIST",
    },
  };
}

function fakeArtifactOnlyRuntime(options: {
  request?: (
    instruction: ShapingIngressInstructionV1,
  ) => CanonicalCapabilityRequest;
  session_config_options?: readonly ReturnType<typeof modelConfigOption>[];
  config_update?: readonly ReturnType<typeof modelConfigOption>[] | null;
  delay_ms?: number;
  result_source?: string;
  use_client_write?: boolean;
} = {}) {
  const adapter = new StdioAcpClientAdapter();
  const prompts: string[] = [];
  const starts = vi.fn();
  const runtime: ConnectedShapingRuntime = {
    configuration: () => ({
      adapter_id: "fake-shaping-acp",
      adapter_version: "1.0.0",
      profile_id: "artifact-only-shaping-v1",
      available_model_ids: ["requested-model"],
    }),
    prepare: async (input) => ({
      requested_model: input.requested_model,
      reasoning_effort: "high",
      sanitized_profile: {
        adapter_id: "fake-shaping-acp",
        adapter_version: "1.0.0",
        profile_id: "artifact-only-shaping-v1",
        executable: "fake-acp",
        argv: ["--stdio", "--model", input.requested_model],
        requested_model: input.requested_model,
        reasoning_effort: "high",
        available_tools: ["edit"],
        excluded_tools: ["execute", "fetch", "mcp"],
        authentication: "noninteractive_authenticated",
        execution_mode: "permission_mediated_local",
        containment_assurance: "not_independently_enforced",
        machine_authority: "launching_user",
        requested_mcp_server_count: 0,
        client_fs_read_text_file: false,
        client_fs_write_text_file: true,
        credential_environment:
          "explicit_allowlist_without_credential_values",
      },
      start: async (
        instruction: ShapingIngressInstructionV1,
        policy: ShapingRunWritePolicy,
        eventSink: AcpEventSink,
        writeTextFile,
        callbacks,
      ) => {
        starts(instruction, policy);
        const request =
          options.request?.(instruction) ??
          ({
            schema_version: 1,
            kind: "workspace_write",
            path: instruction.ingress_path,
          } as const);
        const profile: AcpRuntimeProfile = {
          adapter_id: "fake-shaping-acp",
          executable: process.execPath,
          args: [
            join(
              process.cwd(),
              "tests",
              "helpers",
              "fake-acp-agent.mjs",
            ),
          ],
          environment: {
            PRODUCT_STUDIO_FAKE_ACP_SCENARIO: JSON.stringify({
              session_config_options:
                options.session_config_options ?? [
                  modelConfigOption("adapter-model-a", "deployment-a"),
                ],
              ...(options.config_update === null
                ? {}
                : {
                    config_option_update:
                      options.config_update ?? [
                        modelConfigOption("adapter-model-b", "deployment-b"),
                      ],
                  }),
              requests: options.use_client_write === true ? [] : [request],
              ...(options.delay_ms === undefined
                ? {}
                : { delay_ms: options.delay_ms }),
              write_requested_file: options.use_client_write !== true,
              write_permission_sentinel: false,
              result_source:
                options.result_source ??
                `${JSON.stringify(
                  shapingResultForMission(input.mission),
                  null,
                  2,
                )}\n`,
              ...(options.use_client_write === true
                ? {
                    client_write_path: join(
                      input.workspace_cwd,
                      ...instruction.ingress_path.split("/"),
                    ),
                    client_write_content:
                      options.result_source ??
                      `${JSON.stringify(
                        shapingResultForMission(input.mission),
                        null,
                        2,
                      )}\n`,
                  }
                : {}),
            }),
            PRODUCT_STUDIO_FAKE_ACP_SENTINEL: join(
              input.workspace_cwd,
              ".fake-shaping-sentinel",
            ),
          },
          workspace_cwd: input.workspace_cwd,
          evaluate_permission: (requestInput) =>
            evaluateShapingPermissionRequest(
              instruction,
              policy,
              requestInput,
            ),
          limits: input.limits,
          ...(options.use_client_write === true
            ? { write_text_file: writeTextFile }
            : {}),
          normalize_permission: (requestInput) =>
            canonicalFakeRequest(requestInput.toolCall.rawInput),
        };
        const session = await adapter.start(profile, eventSink, callbacks);
        return {
          session_id: session.session_id,
          protocol_version: session.protocol_version,
          requested_mcp_server_count: session.requested_mcp_server_count,
          config_options: session.config_options,
          wall_clock_timeout_ms: session.wall_clock_timeout_ms,
          process: session.process,
          run: (prompt: string) => {
            prompts.push(prompt);
            return session.run(prompt);
          },
          cancel: () => session.cancel(),
          close: () => session.close(),
        };
      },
    }),
  };
  return { runtime, prompts, starts };
}

function createMemoryIndex() {
  let items: Parameters<PortfolioWorkItemIndex["rebuild"]>[0] = [];
  return {
    rebuild: vi.fn((nextItems: typeof items) => {
      items = [...nextItems];
    }),
    list: vi.fn(() => [...items]),
    clear: vi.fn(() => {
      items = [];
    }),
    close: vi.fn(),
  } satisfies PortfolioWorkItemIndex;
}

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  createdRoots.push(root);
  return root;
}

async function createWorkspace(productName: string): Promise<string> {
  const root = await createRoot("product-studio-service-workspace-");
  const founderDirectory = join(root, ".founder");
  await mkdir(founderDirectory, { recursive: true });
  await writeFile(
    join(founderDirectory, "product.yaml"),
    stringify({
      schema_version: 2,
      product_name: productName,
      verification: {
        required_commands: [
          {
            name: "Tests",
            argv: ["npm", "test"],
            timeout_seconds: 120,
          },
        ],
      },
    }),
    "utf8",
  );
  return root;
}

async function createService(
  index: PortfolioWorkItemIndex = new SQLitePortfolioIndex(":memory:"),
  makeWorkspace?: (workspacePath: string) => ProductWorkspace,
  writableRuntime?: ConnectedWritableRuntime,
  shapingRuntime?: ConnectedShapingRuntime,
  reviewRuntime?: ConnectedReviewRuntime,
) {
  const applicationRoot = await createRoot("product-studio-service-app-");
  const registry = new PortfolioRegistry(
    join(applicationRoot, ".local-data", "registry.json"),
  );
  const inboxRoot = join(applicationRoot, ".portfolio", "inbox");
  const service = new PortfolioService(
    registry,
    index,
    inboxRoot,
    makeWorkspace ??
      ((workspacePath) =>
        new ProductWorkspace(workspacePath, {
          git: controllerGit,
          verificationRunner: controllerRunner,
        })),
    writableRuntime,
    shapingRuntime,
    reviewRuntime,
  );
  const legacyService = Object.assign(service, {
    async updateWorkItemDetails(
      sourceId: string,
      workItemId: string,
      input: {
        title?: string;
        type?: WorkItemType | null;
        priority?: WorkItemPriority | null;
        tags?: string[];
        notes?: string | null;
      },
    ) {
      const current = (await service.list()).find(
        (item) => item.source_id === sourceId && item.work_item.goal.work_item_id === workItemId,
      );
      if (current === undefined) {
        return service.saveWorkItem(sourceId, workItemId, {
          target_source_id: sourceId, title: "Missing work item", type: null, priority: null, tags: [], notes: null,
        });
      }
      const { goal } = current.work_item;
      return service.saveWorkItem(sourceId, workItemId, {
        target_source_id: sourceId, title: input.title ?? goal.title,
        type: input.type === undefined ? goal.type ?? null : input.type,
        priority: input.priority === undefined ? goal.priority ?? null : input.priority,
        tags: input.tags ?? goal.tags ?? [], notes: input.notes === undefined ? goal.notes ?? null : input.notes,
      });
    },
    async updateGoalContract(
      sourceId: string,
      workItemId: string,
      input: { acceptance_criteria: string[]; allowed_scope: string[]; review_ready: string[]; expected_goal_version?: number; expected_input_revision?: number },
    ) {
      const current = (await service.list()).find(
        (item) => item.source_id === sourceId && item.work_item.goal.work_item_id === workItemId,
      );
      if (current === undefined) {
        return service.saveWorkItem(sourceId, workItemId, {
          target_source_id: sourceId, title: "Missing work item", type: null, priority: null, tags: [], notes: null,
          goal_contract: { purpose: "Keep portfolio work governed.", acceptance_criteria: input.acceptance_criteria, non_goals: ["Do not bypass portfolio recovery."], allowed_scope: input.allowed_scope, review_ready: input.review_ready },
          ...(input.expected_goal_version === undefined ? {} : { expected_goal_version: input.expected_goal_version, expected_input_revision: input.expected_input_revision }),
        });
      }
      const { goal } = current.work_item;
      return service.saveWorkItem(sourceId, workItemId, {
        target_source_id: sourceId, title: goal.title, type: goal.type ?? null, priority: goal.priority ?? null, tags: goal.tags ?? [], notes: goal.notes ?? null,
        goal_contract: { purpose: "Keep portfolio work governed.", acceptance_criteria: input.acceptance_criteria, non_goals: ["Do not bypass portfolio recovery."], allowed_scope: input.allowed_scope, review_ready: input.review_ready },
        ...(input.expected_goal_version === undefined ? {} : { expected_goal_version: input.expected_goal_version, expected_input_revision: input.expected_input_revision }),
      });
    },
    async assignWorkItem(sourceId: string, workItemId: string, input: { target_source_id: string }) {
      const current = (await service.list()).find(
        (item) => item.source_id === sourceId && item.work_item.goal.work_item_id === workItemId,
      );
      if (current === undefined) {
        return service.saveWorkItem(sourceId, workItemId, {
          target_source_id: input.target_source_id, title: "Missing work item", type: null, priority: null, tags: [], notes: null,
        });
      }
      const { goal } = current.work_item;
      return service.saveWorkItem(sourceId, workItemId, {
        target_source_id: input.target_source_id, title: goal.title, type: goal.type ?? null, priority: goal.priority ?? null, tags: goal.tags ?? [], notes: goal.notes ?? null,
      });
    },
  });
  return {
    registry,
    index,
    inboxRoot,
    transfersRoot: service.transfersRoot,
    service: legacyService,
  };
}

function ideaShapingStateSha256(workItem: WorkItem): string {
  return hashShapingDecisionState({
    work_item_id: workItem.goal.work_item_id,
    phase: workItem.state.phase,
    status: workItem.state.status,
    goal_input_sha256: hashGoalInput({
      title: workItem.goal.title,
      notes: workItem.goal.notes,
    }),
    goal_version: workItem.state.goal_version ?? null,
    input_revision: workItem.state.input_revision ?? null,
    goal_contract_sha256:
      workItem.goal.goal_contract === undefined
        ? null
        : hashGoalContract(workItem.goal.goal_contract),
    current_mission_input_sha256: null,
    current_mission_content_sha256: null,
    applied_result_content_sha256: null,
    decision_receipt_sha256: null,
    active_shaping_run_id: null,
  });
}

function currentPhaseArtifact(
  artifacts: Awaited<
    ReturnType<PortfolioService["listShapingArtifacts"]>
  >["artifacts"],
  phase: ShapingPhase,
) {
  const phaseArtifacts = artifacts.filter(
    (artifact) => artifact.mission.identity.phase === phase,
  );
  const superseded = new Set(
    phaseArtifacts.flatMap((artifact) =>
      artifact.mission.input.revision === undefined
        ? []
        : [artifact.mission.input.revision.supersedes_input_sha256],
    ),
  );
  const tips = phaseArtifacts.filter(
    (artifact) => !superseded.has(artifact.mission.identity.input_sha256),
  );
  if (tips.length !== 1) {
    throw new Error(`Expected one ${phase} shaping tip, found ${tips.length}.`);
  }
  return tips[0]!;
}

function shapingResultForMission(mission: ShapingMissionPackage) {
  switch (mission.identity.phase) {
    case "brainstorm":
      return {
        result_schema_version: 1 as const,
        brainstorm_mission_content_sha256: mission.content_sha256,
        identity: mission.identity,
        problem_statement: "The shaping handoff needs one durable path.",
        approach: "Use an immutable mission and one applied result.",
        non_goals: ["Do not authorize Execute."],
        open_questions: ["Which model should the next seat use?"],
      };
    case "spec":
      return {
        result_schema_version: 1 as const,
        spec_mission_content_sha256: mission.content_sha256,
        identity: mission.identity,
        proposal: {
          purpose: "Make the shaping handoff durable.",
          acceptance_criteria: ["Each phase publishes one applied result."],
          non_goals: ["Do not launch Execute."],
          allowed_scope: ["src/application", "tests/application"],
          review_ready: ["The exact deterministic check passes."],
        },
      };
    case "plan":
      return {
        result_schema_version: 1 as const,
        plan_mission_content_sha256: mission.content_sha256,
        identity: mission.identity,
        summary: "Implement the approved shaping handoff.",
        checklist: [
          {
            id: "step-1",
            step: "Implement the service boundary.",
            verification_check: "Run the focused service suite.",
          },
        ],
        relevant_skills: [],
        product_doc_impacts: [],
        todo_impacts: [],
        open_questions: [],
      };
  }
}

async function applyManualShapingResult(
  service: PortfolioService,
  workspaceRoot: string,
  sourceId: string,
  workItemId: string,
  phase: ShapingPhase,
) {
  const listing = await service.listShapingArtifacts(sourceId, workItemId);
  const artifact = currentPhaseArtifact(listing.artifacts, phase);
  const binding = {
    expected_mission_content_sha256: artifact.mission.content_sha256,
    expected_shaping_state_sha256: listing.expected_shaping_state_sha256,
  };
  const manual = await service.openManualIngress(
    sourceId,
    workItemId,
    phase,
    binding,
  );
  const result = shapingResultForMission(artifact.mission);
  await writeFile(
    join(workspaceRoot, manual.instruction.ingress_path),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  const imported =
    phase === "brainstorm"
      ? await service.importBrainstormResult(sourceId, workItemId, binding)
      : phase === "spec"
        ? await service.importSpecResult(sourceId, workItemId, binding)
        : await service.importPlanResult(sourceId, workItemId, binding);
  return { artifact, binding, imported, manual, result };
}

async function prepareReadyPlan(
  service: PortfolioService,
  workspaceRoot: string,
  sourceId: string,
  workItem: WorkItem,
) {
  const workItemId = workItem.goal.work_item_id;
  await service.startBrainstorm(sourceId, workItemId, {
    launch_mode: "manual",
    next_requested_model: null,
    expected_mission_content_sha256: null,
    expected_result_content_sha256: null,
    expected_shaping_state_sha256: ideaShapingStateSha256(workItem),
  });
  await applyManualShapingResult(
    service,
    workspaceRoot,
    sourceId,
    workItemId,
    "brainstorm",
  );
  const brainstormReady = await service.listShapingArtifacts(
    sourceId,
    workItemId,
  );
  const brainstorm = currentPhaseArtifact(
    brainstormReady.artifacts,
    "brainstorm",
  );
  await service.useBrainstormResult(sourceId, workItemId, {
    launch_mode: "manual",
    next_requested_model: null,
    expected_mission_content_sha256: brainstorm.mission.content_sha256,
    expected_result_content_sha256:
      brainstorm.result!.result_content_sha256,
    expected_shaping_state_sha256:
      brainstormReady.expected_shaping_state_sha256,
  });
  const specApplied = await applyManualShapingResult(
    service,
    workspaceRoot,
    sourceId,
    workItemId,
    "spec",
  );
  if (
    specApplied.imported.outcome !== "applied" ||
    !("proposal" in specApplied.imported.result)
  ) {
    throw new Error("Expected one applied Spec result.");
  }
  const specReady = await service.listShapingArtifacts(sourceId, workItemId);
  const spec = currentPhaseArtifact(specReady.artifacts, "spec");
  const goalContract = goalContractFromSpecProposal(
    specApplied.imported.result.proposal,
    1,
  );
  await service.approveSpecResult(sourceId, workItemId, {
    launch_mode: "manual",
    next_requested_model: null,
    expected_mission_content_sha256: spec.mission.content_sha256,
    expected_result_content_sha256: spec.result!.result_content_sha256,
    expected_shaping_state_sha256: specReady.expected_shaping_state_sha256,
    goal_contract_sha256: hashGoalContract(goalContract),
  });
  await applyManualShapingResult(
    service,
    workspaceRoot,
    sourceId,
    workItemId,
    "plan",
  );
  const planReady = await service.listShapingArtifacts(sourceId, workItemId);
  const plan = currentPhaseArtifact(planReady.artifacts, "plan");
  return {
    goalContract,
    plan,
    planReady,
    binding: {
      expected_mission_content_sha256: plan.mission.content_sha256,
      expected_result_content_sha256: plan.result!.result_content_sha256,
      expected_shaping_state_sha256:
        planReady.expected_shaping_state_sha256,
      goal_contract_sha256: hashGoalContract(goalContract),
    },
  };
}

async function governWorkItemThrough(
  repository: ProductWorkspace,
  workItem: WorkItem,
  targetPhases: WorkItemPhase[],
): Promise<{
  workItem: WorkItem;
  manifests: ControllerRunManifest[];
}> {
  const controller = new WorkItemController(
    repository,
    () => new Date("2026-07-22T12:00:00.000Z"),
    controllerGit,
    controllerRunner,
  );
  const contracted = await controller.saveWorkItem(
    workItem.goal.work_item_id,
    {
      target_source_id: "inbox",
      title: workItem.goal.title,
      type: workItem.goal.type ?? null,
      priority: workItem.goal.priority ?? null,
      tags: workItem.goal.tags ?? [],
      notes: workItem.goal.notes ?? null,
      goal_contract: {
        purpose: "Keep the mission package reproducible.",
        acceptance_criteria: ["The mission package is reproducible"],
        non_goals: ["Do not mutate unrelated workspace state."],
        allowed_scope: ["src/domain", "src/application"],
        review_ready: ["All deterministic checks pass"],
      },
    },
  );
  let current = contracted.work_item;
  const manifests = [contracted.manifest];

  for (const [index, targetPhase] of targetPhases.entries()) {
    const runId = `83000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}`;
    const idempotencyKey = deriveControllerIdempotencyKey(
      current.goal.work_item_id,
      targetPhase,
      current.state.goal_version!,
      current.state.input_revision!,
      current.state.attempt!,
    );
    const activeRun = {
      run_id: runId,
      idempotency_key: idempotencyKey,
      acquired_at: "2026-07-22T12:00:00.000Z",
    };
    const lease = await repository.acquireControllerLease(
      current.goal.work_item_id,
      activeRun,
    );
    if (lease === null) {
      throw new Error("Expected explicit portfolio fixture lease");
    }
    try {
      const result = await repository.commitControllerMutation(lease, {
        goal: current.goal,
        state: {
          ...current.state,
          phase: targetPhase,
          updated_at: new Date(
            Date.parse(current.state.updated_at) + 1,
          ).toISOString(),
        },
        manifest: {
          schema_version: 1,
          run_id: runId,
          work_item_id: current.goal.work_item_id,
          idempotency_key: idempotencyKey,
          phase: targetPhase,
          goal_version: current.state.goal_version!,
          input_revision: current.state.input_revision!,
          attempt: current.state.attempt!,
          started_at: activeRun.acquired_at,
          outcome: "pending",
        },
      });
      current = result.work_item;
      manifests.push(result.manifest);
    } finally {
      await repository.releaseControllerLease(lease);
    }
  }

  return { workItem: current, manifests };
}

async function prepareConnectedReviewItem(
  service: PortfolioService,
  sourceId: string,
  workItem: WorkItem,
) {
  const executeMission = await service.compileMission(
    sourceId,
    workItem.goal.work_item_id,
  );
  await writeFile(
    join(dirname(executeMission.task_path), "result.json"),
    serializeExternalResult({
      result_schema_version: 2,
      mission_content_sha256: executeMission.mission.content_sha256,
      identity: executeMission.mission.identity,
      commit: "a".repeat(40),
      summary: "Prepared one exact subject for connected Review.",
      changed_files: ["src/application/portfolio.ts"],
      verification: [{ name: "Tests", status: "passed" }],
    }),
    "utf8",
  );
  await service.importResult(sourceId, workItem.goal.work_item_id);
  return service.compileReviewMission(sourceId, workItem.goal.work_item_id, {
    independence_attested: true,
  });
}

async function prepareConnectedPatchReview(
  service: PortfolioService,
  sourceId: string,
  workItem: WorkItem,
) {
  const reviewMission = await prepareConnectedReviewItem(
    service,
    sourceId,
    workItem,
  );
  if (reviewMission.mission.review_subject.source !== "execute") {
    throw new Error("Initial Patch preparation must bind Execute evidence.");
  }
  await writeFile(
    join(dirname(reviewMission.task_path), "result.json"),
    serializeExternalResult({
      result_schema_version: 2,
      review_mission_content_sha256: reviewMission.mission.content_sha256,
      identity: reviewMission.mission.identity,
      execute_mission_content_sha256:
        reviewMission.mission.review_subject.execute_mission_content_sha256,
      execute_result_content_sha256:
        reviewMission.mission.review_subject.execute_result_content_sha256,
      git_base_commit: reviewMission.mission.review_subject.git_base_commit,
      accepted_result_commit:
        reviewMission.mission.review_subject.accepted_result_commit,
      summary: "Connected Review found one bounded Patch requirement.",
      verdict: "findings",
      findings: [
        {
          finding_id: "F-connected-patch",
          severity: "P1",
          title: "Keep Patch authority mission-bound",
          evidence: {
            path: "src/application/portfolio.ts",
            summary: "Patch must use the immutable mission envelope.",
          },
          required_action: "Launch Patch with narrowing-only authority.",
          link: {
            type: "acceptance_criteria",
            criterion: "The mission package is reproducible",
          },
        },
      ],
    }),
    "utf8",
  );
  await service.importReviewResult(sourceId, workItem.goal.work_item_id);
  return reviewMission;
}

async function writeTransferJournal(
  transfersRoot: string,
  record: {
    transfer_id: string;
    work_item_id: string;
    from_source_id: string;
    from_path: string;
    to_source_id: string;
    to_path: string;
    stage: "staged" | "published" | "source_removed";
  },
): Promise<void> {
  await mkdir(transfersRoot, { recursive: true });
  await writeFile(
    join(transfersRoot, `${record.transfer_id}.json`),
    `${JSON.stringify({ schema_version: 1, kind: "move", ...record }, null, 2)}\n`,
    "utf8",
  );
}

async function preparePendingTransfer(
  actualStage: "staged" | "published" | "source_removed",
  recordedStage: "staged" | "published" | "source_removed" = actualStage,
) {
  const sourceRoot = await createWorkspace(`Recovery source ${actualStage}`);
  const targetRoot = await createWorkspace(`Recovery target ${actualStage}`);
  const createdService = await createService();
  const sourceRegistration = await createdService.service.register({
    workspace_path: sourceRoot,
  });
  const targetRegistration = await createdService.service.register({
    workspace_path: targetRoot,
  });
  const created = await createdService.service.createCapture({
    title: `Recover ${recordedStage} transfer`,
    capture_kind: "idea",
    source_id: sourceRegistration.workspace.workspace_id,
  });
  const source = new ProductWorkspace(sourceRoot);
  const target = new ProductWorkspace(targetRoot);
  const stagingPath = await target.stageIncomingWorkItem(created.work_item);

  if (actualStage !== "staged") {
    await target.publishStagedWorkItem(
      created.work_item.goal.work_item_id,
      stagingPath,
    );
  }
  if (actualStage === "source_removed") {
    await source.removeWorkItem(created.work_item.goal.work_item_id);
  }

  await writeTransferJournal(createdService.transfersRoot, {
    transfer_id: "tr_123e4567-e89b-42d3-a456-426614174000",
    work_item_id: created.work_item.goal.work_item_id,
    from_source_id: sourceRegistration.workspace.workspace_id,
    from_path: sourceRoot,
    to_source_id: targetRegistration.workspace.workspace_id,
    to_path: stagingPath,
    stage: recordedStage,
  });

  return {
    ...createdService,
    source,
    target,
    sourceRegistration,
    targetRegistration,
    created,
  };
}

afterEach(async () => {
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("PortfolioService", () => {
  it("registers a validated workspace and rebuilds its durable items", async () => {
    const root = await createWorkspace("Service Workspace");
    await new ProductWorkspace(root).create({
      title: "Coordinate the portfolio",
      type: "Feature",
    });
    const { registry, index, service } = await createService();

    const result = await service.register({ workspace_path: root });

    expect(result.workspace).toMatchObject({
      workspace_id: expect.stringMatching(/^ws_[0-9a-f-]{36}$/i),
      workspace_path: root,
      product_name: "Service Workspace",
      registered_at: expect.any(String),
    });
    expect(await registry.read()).toEqual([result.workspace]);
    expect(result.rebuild.failures).toEqual([]);
    expect(result.rebuild.items).toHaveLength(1);
    expect(await service.list()).toEqual(result.rebuild.items);
    index.close();
  });

  it("rejects a duplicate normalized path and preserves one entry", async () => {
    const root = await createWorkspace("Duplicate Workspace");
    const { registry, index, service } = await createService();
    await service.register({ workspace_path: root });
    const equivalentPath = join(
      dirname(root),
      basename(root),
      "..",
      basename(root),
    );

    await expect(
      service.register({ workspace_path: equivalentPath }),
    ).rejects.toBeInstanceOf(DuplicateWorkspaceError);
    await expect(registry.read()).resolves.toHaveLength(1);
    index.close();
  });

  it("reports one invalid workspace without blocking valid indexed items", async () => {
    const invalidRoot = await createWorkspace("Invalid Later");
    const validRoot = await createWorkspace("Still Valid");
    await new ProductWorkspace(invalidRoot).create({
      title: "Removed after indexing",
      type: "Fix",
    });
    await new ProductWorkspace(validRoot).create({
      title: "Surviving item",
      type: "MVP",
    });
    const { index, service } = await createService();
    await service.register({ workspace_path: invalidRoot });
    await service.register({ workspace_path: validRoot });
    await expect(service.list()).resolves.toHaveLength(2);
    await rm(invalidRoot, { recursive: true, force: true });

    const rebuild = await service.rebuild();

    expect(rebuild.items).toHaveLength(1);
    expect(rebuild.items[0]?.project?.workspace_path).toBe(validRoot);
    expect(rebuild.failures).toMatchObject([
      {
        source_id: expect.stringMatching(/^ws_/),
        project: { workspace_path: invalidRoot },
        reason: expect.any(String),
      },
    ]);
    await expect(service.list()).resolves.toEqual(rebuild.items);
    await expect(service.listWorkspaces()).resolves.toHaveLength(2);
    index.close();
  });

  it("reconciles valid workspaces without letting a missing workspace block startup", async () => {
    const invalidRoot = await createWorkspace("Missing During Reconciliation");
    const validRoot = await createWorkspace("Reconciled During Startup");
    await new ProductWorkspace(invalidRoot).create({
      title: "Removed before startup reconciliation",
      type: "Fix",
    });
    await new ProductWorkspace(validRoot).create({
      title: "Still reconciled",
      type: "MVP",
    });
    const { index, service } = await createService();
    await service.register({ workspace_path: invalidRoot });
    await service.register({ workspace_path: validRoot });
    await rm(invalidRoot, { recursive: true, force: true });

    await expect(service.reconcileRunState()).resolves.toBeUndefined();
    const rebuild = await service.rebuild();

    expect(rebuild.items).toHaveLength(1);
    expect(rebuild.items[0]?.project?.workspace_path).toBe(validRoot);
    expect(rebuild.failures).toMatchObject([
      {
        source_id: expect.stringMatching(/^ws_/),
        project: { workspace_path: invalidRoot },
        reason: expect.any(String),
      },
    ]);
    index.close();
  });

  it("rebuilds an empty registry to zero rows", async () => {
    const { index, service } = await createService();

    await expect(service.rebuild()).resolves.toEqual({ items: [], failures: [] });
    await expect(service.list()).resolves.toEqual([]);
    index.close();
  });

  it("creates and projects the durable unassigned inbox", async () => {
    const { inboxRoot, index, service } = await createService();

    await service.rebuild();
    const inbox = new ProductWorkspace(inboxRoot);
    await expect(inbox.readManifest()).resolves.toEqual({
      schema_version: 2,
      product_name: INBOX_SOURCE_LABEL,
      verification: {
        required_commands: [
          { name: "Lint", argv: ["npm", "run", "lint"], timeout_seconds: 300 },
          {
            name: "Typecheck",
            argv: ["npm", "run", "typecheck"],
            timeout_seconds: 300,
          },
          { name: "Test", argv: ["npm", "test"], timeout_seconds: 900 },
          {
            name: "Build",
            argv: ["npm", "run", "build"],
            timeout_seconds: 900,
          },
        ],
      },
    });
    const created = await inbox.create({
      title: "Unassigned product idea",
      type: "Explore",
    });

    const rebuilt = await service.rebuild();

    expect(rebuilt.failures).toEqual([]);
    expect(rebuilt.items).toEqual([
      {
        source_id: INBOX_SOURCE_ID,
        project: null,
        work_item: created,
      },
    ]);

    await inbox.updatePhase(created.goal.work_item_id, {
      target_phase: "execute",
    });
    const updated = await service.updateWorkItemPhase(
      INBOX_SOURCE_ID,
      created.goal.work_item_id,
      { target_phase: "review" },
    );
    expect(updated).toMatchObject({
      source_id: INBOX_SOURCE_ID,
      project: null,
      work_item: { state: { phase: "review" } },
    });
    await expect(service.list()).resolves.toEqual([updated]);
    index.close();
  });

  it("creates minimal captures in Inbox or directly in a selected project", async () => {
    const projectRoot = await createWorkspace("Capture Project");
    const { inboxRoot, index, service } = await createService();
    const registration = await service.register({ workspace_path: projectRoot });

    const inboxCapture = await service.createCapture({
      title: "Unassigned capture",
      capture_kind: "idea",
    });
    expect(inboxCapture).toMatchObject({
      source_id: INBOX_SOURCE_ID,
      project: null,
      work_item: {
        goal: {
          title: "Unassigned capture",
          capture: {
            kind: "idea",
            original_title: "Unassigned capture",
          },
        },
        state: { phase: "idea", status: "active" },
      },
    });
    expect(inboxCapture.work_item.goal).not.toHaveProperty("type");
    expect(inboxCapture.work_item.goal).not.toHaveProperty("priority");

    const projectCapture = await service.createCapture({
      title: "Project capture",
      capture_kind: "todo",
      source_id: registration.workspace.workspace_id,
    });
    expect(projectCapture).toMatchObject({
      source_id: registration.workspace.workspace_id,
      project: { workspace_path: projectRoot },
      work_item: { goal: { title: "Project capture" } },
    });

    const inbox = new ProductWorkspace(inboxRoot);
    const project = new ProductWorkspace(projectRoot);
    expect(await inbox.read(projectCapture.work_item.goal.work_item_id)).toBeNull();
    expect(await project.read(projectCapture.work_item.goal.work_item_id)).toEqual(
      projectCapture.work_item,
    );
    await expect(service.list()).resolves.toHaveLength(2);
    index.close();
  });

  it("updates and clears capture details without rewriting provenance", async () => {
    const { index, service } = await createService();
    const created = await service.createCapture({
      title: "Original capture",
      capture_kind: "idea",
      priority: "normal",
      tags: ["Question"],
      notes: "Original context",
    });
    const provenance = created.work_item.goal.capture;

    const updated = await service.updateWorkItemDetails(
      INBOX_SOURCE_ID,
      created.work_item.goal.work_item_id,
      { title: "Refined capture", type: "Feature" },
    );
    expect(updated.work_item.goal).toMatchObject({
      title: "Refined capture",
      type: "Feature",
      priority: "normal",
      tags: ["Question"],
      notes: "Original context",
      capture: provenance,
    });

    const cleared = await service.updateWorkItemDetails(
      INBOX_SOURCE_ID,
      created.work_item.goal.work_item_id,
      { type: null, priority: null, tags: [], notes: null },
    );
    expect(cleared.work_item.goal).toEqual({
      schema_version: 2,
      work_item_id: created.work_item.goal.work_item_id,
      title: "Refined capture",
      capture: provenance,
    });
    await expect(service.list()).resolves.toEqual([cleared]);
    index.close();
  });

  it("updates a goal contract through the source-qualified service and rebuilds only after success", async () => {
    const root = await createWorkspace("Goal Contract Service");
    const repository = new ProductWorkspace(root);
    const created = await repository.create({
      title: "Make contracts app-reachable",
      type: "Feature",
    });
    const { index, service } = await createService();
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    const rebuildSpy = vi.spyOn(index, "rebuild");
    rebuildSpy.mockClear();
    const input = {
      acceptance_criteria: ["Goal contracts can be saved"],
      allowed_scope: ["src/application", "app/api"],
      review_ready: ["Portfolio tests pass"],
    };

    await expect(
      service.updateGoalContract(
        "ws_00000000-0000-4000-8000-000000000000",
        created.goal.work_item_id,
        input,
      ),
    ).rejects.toBeInstanceOf(UnknownPortfolioSourceError);
    await expect(
      service.updateGoalContract(
        sourceId,
        "wi_123e4567-e89b-12d3-a456-426614174000",
        input,
      ),
    ).rejects.toBeInstanceOf(PortfolioWorkItemNotFoundError);
    expect(rebuildSpy).not.toHaveBeenCalled();

    const activated = await service.updateGoalContract(
      sourceId,
      created.goal.work_item_id,
      input,
    );
    expect(activated).toMatchObject({
      source_id: sourceId,
      project: registration.workspace,
      work_item: {
        goal: {
          goal_contract: {
            ...input,
            purpose: "Keep portfolio work governed.",
            non_goals: ["Do not bypass portfolio recovery."],
            goal_version: 1,
          },
        },
        state: { goal_version: 1, input_revision: 1, attempt: 0 },
      },
    });
    expect(rebuildSpy).toHaveBeenCalledOnce();

    const revised = await service.updateGoalContract(
      sourceId,
      created.goal.work_item_id,
      {
        ...input,
        acceptance_criteria: ["Goal contracts can be revised"],
        expected_goal_version: 1,
        expected_input_revision: 1,
      },
    );
    expect(revised.work_item.state).toMatchObject({
      goal_version: 2,
      input_revision: 2,
      attempt: 0,
    });
    expect(rebuildSpy).toHaveBeenCalledTimes(2);
    index.close();
  });

  it("rejects unversioned details updates after a goal contract exists", async () => {
    const { inboxRoot, index, service } = await createService();
    const created = await service.createCapture({
      title: "Govern this capture",
      capture_kind: "idea",
    });
    const repository = new ProductWorkspace(inboxRoot);
    const controller = new WorkItemController(
      repository,
      () => new Date("2026-07-21T21:30:00.000Z"),
      controllerGit,
      controllerRunner,
    );
    await controller.saveWorkItem(created.work_item.goal.work_item_id, {
      target_source_id: "inbox",
      title: created.work_item.goal.title,
      type: created.work_item.goal.type ?? null,
      priority: created.work_item.goal.priority ?? null,
      tags: created.work_item.goal.tags ?? [],
      notes: created.work_item.goal.notes ?? null,
      goal_contract: {
        purpose: "Keep contract changes version-bound.",
        acceptance_criteria: ["Keep contract changes version-bound"],
        non_goals: ["Do not change projects."],
        allowed_scope: ["src/application"],
        review_ready: ["Tests pass"],
      },
    });
    await service.rebuild();
    const before = await repository.read(created.work_item.goal.work_item_id);
    const beforeIndex = await service.list();

    await expect(
      service.updateWorkItemDetails(
        INBOX_SOURCE_ID,
        created.work_item.goal.work_item_id,
        { title: "Unversioned rewrite" },
      ),
    ).rejects.toMatchObject({
      name: "ControllerConflictError",
      kind: "contract_required",
    });
    expect(await repository.read(created.work_item.goal.work_item_id)).toEqual(
      before,
    );
    expect(await service.list()).toEqual(beforeIndex);
    index.close();
  });

  it("assigns a capture across workspace roots and treats same-source assignment as idempotent", async () => {
    const sourceRoot = await createWorkspace("Transfer Source");
    const targetRoot = await createWorkspace("Transfer Target");
    const { index, service, transfersRoot } = await createService();
    const sourceRegistration = await service.register({
      workspace_path: sourceRoot,
    });
    const targetRegistration = await service.register({
      workspace_path: targetRoot,
    });
    const created = await service.createCapture({
      title: "Portable capture",
      capture_kind: "todo",
      source_id: sourceRegistration.workspace.workspace_id,
      tags: ["Portable"],
    });

    const unchanged = await service.assignWorkItem(
      sourceRegistration.workspace.workspace_id,
      created.work_item.goal.work_item_id,
      { target_source_id: sourceRegistration.workspace.workspace_id },
    );
    expect(unchanged).toEqual(created);

    const assigned = await service.assignWorkItem(
      sourceRegistration.workspace.workspace_id,
      created.work_item.goal.work_item_id,
      { target_source_id: targetRegistration.workspace.workspace_id },
    );
    expect(assigned).toEqual({
      source_id: targetRegistration.workspace.workspace_id,
      project: targetRegistration.workspace,
      work_item: created.work_item,
    });
    expect(
      await new ProductWorkspace(sourceRoot).read(
        created.work_item.goal.work_item_id,
      ),
    ).toBeNull();
    expect(
      await new ProductWorkspace(targetRoot).read(
        created.work_item.goal.work_item_id,
      ),
    ).toEqual(created.work_item);
    await expect(service.list()).resolves.toEqual([assigned]);
    expect(await readdir(transfersRoot)).toEqual([]);
    index.close();
  });

  it("rejects unknown, missing, and colliding assignment targets without overwriting", async () => {
    const sourceRoot = await createWorkspace("Collision Source");
    const targetRoot = await createWorkspace("Collision Target");
    const { index, service } = await createService();
    const sourceRegistration = await service.register({
      workspace_path: sourceRoot,
    });
    const targetRegistration = await service.register({
      workspace_path: targetRoot,
    });
    const created = await service.createCapture({
      title: "Collision candidate",
      capture_kind: "idea",
      source_id: sourceRegistration.workspace.workspace_id,
    });

    await expect(
      service.assignWorkItem(
        sourceRegistration.workspace.workspace_id,
        created.work_item.goal.work_item_id,
        { target_source_id: "ws_00000000-0000-4000-8000-000000000000" },
      ),
    ).rejects.toBeInstanceOf(UnknownPortfolioSourceError);
    await expect(
      service.assignWorkItem(
        sourceRegistration.workspace.workspace_id,
        "wi_123e4567-e89b-12d3-a456-426614174000",
        { target_source_id: targetRegistration.workspace.workspace_id },
      ),
    ).rejects.toBeInstanceOf(PortfolioWorkItemNotFoundError);

    const target = new ProductWorkspace(targetRoot);
    const stagingPath = await target.stageIncomingWorkItem(created.work_item);
    await target.publishStagedWorkItem(
      created.work_item.goal.work_item_id,
      stagingPath,
    );
    await expect(
      service.assignWorkItem(
        sourceRegistration.workspace.workspace_id,
        created.work_item.goal.work_item_id,
        { target_source_id: targetRegistration.workspace.workspace_id },
      ),
    ).rejects.toBeInstanceOf(WorkItemTargetCollisionError);
    expect(
      await new ProductWorkspace(sourceRoot).read(
        created.work_item.goal.work_item_id,
      ),
    ).toEqual(created.work_item);
    expect(await target.read(created.work_item.goal.work_item_id)).toEqual(
      created.work_item,
    );
    index.close();
  });

  it("rolls back a staged transfer during rebuild", async () => {
    const fixture = await preparePendingTransfer("staged");
    const workItemId = fixture.created.work_item.goal.work_item_id;

    const rebuilt = await fixture.service.rebuild();

    expect(await fixture.source.read(workItemId)).toEqual(
      fixture.created.work_item,
    );
    expect(await fixture.target.read(workItemId)).toBeNull();
    expect(rebuilt.items).toEqual([fixture.created]);
    expect(await readdir(fixture.transfersRoot)).toEqual([]);
    fixture.index.close();
  });

  it("detects crash-after-publish from a stale staged journal and completes the transfer", async () => {
    const fixture = await preparePendingTransfer("published", "staged");
    const workItemId = fixture.created.work_item.goal.work_item_id;

    const rebuilt = await fixture.service.rebuild();

    expect(await fixture.source.read(workItemId)).toBeNull();
    expect(await fixture.target.read(workItemId)).toEqual(
      fixture.created.work_item,
    );
    expect(rebuilt.items).toEqual([
      {
        source_id: fixture.targetRegistration.workspace.workspace_id,
        project: fixture.targetRegistration.workspace,
        work_item: fixture.created.work_item,
      },
    ]);
    expect(await readdir(fixture.transfersRoot)).toEqual([]);
    fixture.index.close();
  });

  it("completes a published transfer during rebuild", async () => {
    const fixture = await preparePendingTransfer("published");
    const workItemId = fixture.created.work_item.goal.work_item_id;

    await fixture.service.rebuild();

    expect(await fixture.source.read(workItemId)).toBeNull();
    expect(await fixture.target.read(workItemId)).toEqual(
      fixture.created.work_item,
    );
    expect(await readdir(fixture.transfersRoot)).toEqual([]);
    fixture.index.close();
  });

  it("finalizes a source-removed transfer during rebuild", async () => {
    const fixture = await preparePendingTransfer("source_removed");
    const workItemId = fixture.created.work_item.goal.work_item_id;

    await fixture.service.rebuild();

    expect(await fixture.source.read(workItemId)).toBeNull();
    expect(await fixture.target.read(workItemId)).toEqual(
      fixture.created.work_item,
    );
    expect(await readdir(fixture.transfersRoot)).toEqual([]);
    fixture.index.close();
  });

  it("surfaces an interrupted published transfer and recovers it idempotently", async () => {
    const sourceRoot = await createWorkspace("Interrupted Source");
    const targetRoot = await createWorkspace("Interrupted Target");
    const workspaces = new Map<string, ProductWorkspace>();
    const makeWorkspace = (workspacePath: string) => {
      let workspace = workspaces.get(workspacePath);
      if (workspace === undefined) {
        workspace = new ProductWorkspace(workspacePath);
        workspaces.set(workspacePath, workspace);
      }
      return workspace;
    };
    const { index, service, transfersRoot } = await createService(
      new SQLitePortfolioIndex(":memory:"),
      makeWorkspace,
    );
    const sourceRegistration = await service.register({
      workspace_path: sourceRoot,
    });
    const targetRegistration = await service.register({
      workspace_path: targetRoot,
    });
    const created = await service.createCapture({
      title: "Recover after denied source removal",
      capture_kind: "todo",
      source_id: sourceRegistration.workspace.workspace_id,
    });
    const source = makeWorkspace(sourceRoot);
    const target = makeWorkspace(targetRoot);
    const removeWorkItem = source.removeWorkItem.bind(source);
    source.removeWorkItem = async () => {
      throw Object.assign(new Error("source removal denied"), {
        code: "EACCES",
      });
    };

    await expect(
      service.assignWorkItem(
        sourceRegistration.workspace.workspace_id,
        created.work_item.goal.work_item_id,
        { target_source_id: targetRegistration.workspace.workspace_id },
      ),
    ).rejects.toBeInstanceOf(WorkItemTransferFailedError);
    expect(await source.read(created.work_item.goal.work_item_id)).toEqual(
      created.work_item,
    );
    expect(await target.read(created.work_item.goal.work_item_id)).toEqual(
      created.work_item,
    );
    expect(await readdir(transfersRoot)).toHaveLength(1);

    source.removeWorkItem = removeWorkItem;
    await service.rebuild();
    await service.rebuild();
    expect(await source.read(created.work_item.goal.work_item_id)).toBeNull();
    expect(await target.read(created.work_item.goal.work_item_id)).toEqual(
      created.work_item,
    );
    expect(await readdir(transfersRoot)).toEqual([]);
    index.close();
  });

  it("enforces transitions and refreshes the index after an accepted move", async () => {
    const root = await createWorkspace("Transition Workspace");
    const repository = new ProductWorkspace(root);
    const created = await repository.create({
      title: "Move through the board",
      type: "Feature",
    });
    await repository.updatePhase(created.goal.work_item_id, {
      target_phase: "execute",
    });
    const statePath = join(
      root,
      ".founder",
      "work-items",
      created.goal.work_item_id,
      "state.json",
    );
    const { index, service } = await createService();
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;

    const updated = await service.updateWorkItemPhase(
      sourceId,
      created.goal.work_item_id,
      { target_phase: "review" },
    );

    expect(updated).toMatchObject({
      source_id: sourceId,
      project: { workspace_path: root },
      work_item: { state: { phase: "review", status: "active" } },
    });
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      phase: "review",
      status: "active",
    });
    await expect(service.list()).resolves.toEqual([updated]);
    index.close();
  });

  it("compiles and replays a source-qualified mission without rebuilding the index", async () => {
    const root = await createWorkspace("Mission Workspace");
    const cacheRoot = await createRoot("product-studio-mission-cache-");
    const databasePath = join(cacheRoot, "index.sqlite");
    const repository = new ProductWorkspace(root);
    const created = await repository.create({
      title: "Compile a portable mission",
      type: "Feature",
    });
    const governed = await governWorkItemThrough(repository, created, [
      "spec",
      "plan",
      "execute",
    ]);
    const index = new SQLitePortfolioIndex(databasePath);
    const { registry, inboxRoot, service } = await createService(index);
    const registration = await service.register({ workspace_path: root });
    const rebuildSpy = vi.spyOn(index, "rebuild");
    rebuildSpy.mockClear();

    const first = await service.compileMission(
      registration.workspace.workspace_id,
      created.goal.work_item_id,
    );
    const second = await service.compileMission(
      registration.workspace.workspace_id,
      created.goal.work_item_id,
    );

    expect(second).toEqual(first);
    expect(first.workspace_path).toBe(root);
    expect(first.task_path).toBe(
      join(
        root,
        ".founder",
        "missions",
        created.goal.work_item_id,
        "execute-1-1-0",
        "TASK.md",
      ),
    );
    expect(first.mission_path).toBe(
      join(
        root,
        ".founder",
        "missions",
        created.goal.work_item_id,
        "execute-1-1-0",
        "mission.json",
      ),
    );
    expect(first.mission.controller_run.run_id).toBe(
      governed.manifests.at(-1)?.run_id,
    );
    expect(await readFile(first.task_path, "utf8")).toContain(
      "Return the result for validation; do not advance controller state.",
    );
    expect(rebuildSpy).not.toHaveBeenCalled();
    expect(await service.list()).toHaveLength(1);
    index.close();

    await rm(databasePath);
    const restartedIndex = new SQLitePortfolioIndex(databasePath);
    const restartedService = new PortfolioService(
      registry,
      restartedIndex,
      inboxRoot,
      (workspacePath) =>
        new ProductWorkspace(workspacePath, {
          git: controllerGit,
          verificationRunner: controllerRunner,
        }),
    );
    await restartedService.rebuild();

    await expect(
      restartedService.compileMission(
        registration.workspace.workspace_id,
        created.goal.work_item_id,
      ),
    ).resolves.toEqual(first);
    await expect(readFile(first.task_path, "utf8")).resolves.toContain(
      "Return the result for validation; do not advance controller state.",
    );
    restartedIndex.close();
  });

  it("keeps compilation available without a runtime and makes manual Start Brainstorm the only model-free path", async () => {
    const root = await createWorkspace("Manual Shaping Workspace");
    const repository = new ProductWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Shape without a connected runtime",
      type: "Feature",
    });
    const { service } = await createService();
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    const workItemId = created.goal.work_item_id;
    const expectedState = ideaShapingStateSha256(created);

    await expect(
      service.startBrainstorm(sourceId, workItemId, {
        launch_mode: "connected",
        next_requested_model: "missing-model",
        expected_mission_content_sha256: null,
        expected_result_content_sha256: null,
        expected_shaping_state_sha256: expectedState,
      }),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });
    expect((await repository.read(workItemId))?.state.phase).toBe("idea");
    expect(await repository.listShapingArtifacts(workItemId)).toEqual([]);

    const started = await service.startBrainstorm(sourceId, workItemId, {
      launch_mode: "manual",
      next_requested_model: null,
      expected_mission_content_sha256: null,
      expected_result_content_sha256: null,
      expected_shaping_state_sha256: expectedState,
    });
    expect(started).toMatchObject({
      work_item: { state: { phase: "brainstorm" } },
      next_launch: {
        status: "manual",
        shaping_run_id: null,
        reason: "runtime_unavailable",
      },
    });
    expect(await repository.listShapingRuns(workItemId)).toEqual([]);
    expect(
      (await service.listShapingArtifacts(sourceId, workItemId))
        .post_commit_launch_failure,
    ).toBeNull();

    const compiled = await service.compileBrainstormMission(
      sourceId,
      workItemId,
    );
    expect(compiled.mission.identity.phase).toBe("brainstorm");
    expect(service.getShapingModelAvailability()).toEqual({
      status: "unavailable",
      adapter_id: null,
      adapter_version: null,
      profile_id: null,
      available_model_ids: [],
      distinct_model_count: 0,
      has_three_distinct_models: false,
      reason: "runtime_unavailable",
    });
    await expect(
      service.launchShapingRun(sourceId, workItemId, "brainstorm", {
        requested_model: "missing-model",
      }),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });
  });

  it("lists the coherent shaping read model for assigned active Idea while refusing Inbox", async () => {
    const root = await createWorkspace("Idea Shaping Listing Workspace");
    const repository = new ProductWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Choose a Brainstorm model",
      type: "Feature",
    });
    const fake = preparedShapingRuntime(["model-a", "model-b"]);
    const { service } = await createService(
      new SQLitePortfolioIndex(":memory:"),
      undefined,
      undefined,
      fake.runtime,
    );
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    const pickerOptions = [
      {
        model_id: "model-a",
        used_by_seats: [],
        saved_preference: false,
        recommended: true,
        preselected: true,
        reuse_warning: null,
      },
      {
        model_id: "model-b",
        used_by_seats: [],
        saved_preference: false,
        recommended: false,
        preselected: false,
        reuse_warning: null,
      },
    ];

    await expect(
      service.listShapingArtifacts(sourceId, created.goal.work_item_id),
    ).resolves.toEqual({
      source_id: sourceId,
      work_item_id: created.goal.work_item_id,
      artifacts: [],
      runs: [],
      expected_shaping_state_sha256: ideaShapingStateSha256(created),
      model_availability: {
        status: "available",
        adapter_id: "fake-shaping-acp",
        adapter_version: "1.0.0",
        profile_id: "artifact-only-shaping-v1",
        available_model_ids: ["model-a", "model-b"],
        distinct_model_count: 2,
        has_three_distinct_models: false,
        reason: null,
      },
      execute_model_availability: {
        status: "unavailable",
        adapter_id: null,
        adapter_version: null,
        profile_id: null,
        available_model_ids: [],
        distinct_model_count: 0,
        has_three_distinct_models: false,
        reason: "runtime_unavailable",
      },
      model_use: [],
      model_picker_options: {
        brainstorm: pickerOptions,
        spec: pickerOptions,
        plan: pickerOptions,
        execute: [],
        review: pickerOptions,
        patch: pickerOptions,
      },
      post_commit_launch_failure: null,
    });

    const governedGoalPath = join(
      root,
      ".founder",
      "work-items",
      created.goal.work_item_id,
      "goal.yaml",
    );
    const governedStatePath = join(
      root,
      ".founder",
      "work-items",
      created.goal.work_item_id,
      "state.json",
    );
    const governedGoal = {
      ...created.goal,
      goal_contract: {
        schema_version: 1,
        goal_version: 1,
        purpose: "Keep this governed Idea out of Start Brainstorm.",
        acceptance_criteria: ["The shaping read is refused"],
        non_goals: ["Do not reinterpret a governed Idea"],
        allowed_scope: ["src/application/portfolio.ts"],
        review_ready: ["The refusal is deterministic"],
      },
    };
    const governedState = {
      ...created.state,
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
      patch_cycle: 0,
    };
    await writeFile(
      governedGoalPath,
      stringify(governedGoal),
      "utf8",
    );
    await writeFile(
      governedStatePath,
      JSON.stringify(governedState, null, 2) + "\n",
      "utf8",
    );
    await expect(
      service.listShapingArtifacts(sourceId, created.goal.work_item_id),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });

    const inboxItem = await service.createCapture({
      title: "Keep Inbox outside shaping reads",
      capture_kind: "idea",
    });
    await expect(
      service.listShapingArtifacts(
        INBOX_SOURCE_ID,
        inboxItem.work_item.goal.work_item_id,
      ),
    ).rejects.toMatchObject({
      kind: "mission_not_ready",
      workItemId: inboxItem.work_item.goal.work_item_id,
    });
  });

  it("runs the connected Brainstorm, Spec, and Plan handoffs with one commit-then-launch action each", async () => {
    const root = await createWorkspace("Connected Shaping Workspace");
    const repository = new ProductWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Run the guided shaping path",
      type: "Feature",
    });
    const fake = preparedShapingRuntime();
    const { service } = await createService(
      new SQLitePortfolioIndex(":memory:"),
      undefined,
      undefined,
      fake.runtime,
    );
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    const workItemId = created.goal.work_item_id;

    const started = await service.startBrainstorm(sourceId, workItemId, {
      launch_mode: "connected",
      next_requested_model: "brainstorm-model",
      expected_mission_content_sha256: null,
      expected_result_content_sha256: null,
      expected_shaping_state_sha256: ideaShapingStateSha256(created),
    });
    expect(started).toMatchObject({
      work_item: { state: { phase: "brainstorm" } },
      next_launch: { status: "launched", created: true },
    });
    const brainstormRunId = started.next_launch.shaping_run_id;
    if (brainstormRunId === null) {
      throw new Error("Expected a Brainstorm shaping run.");
    }
    await repository.completeShapingRun(workItemId, brainstormRunId, {
      outcome: "failed",
      partial: true,
      reason: "Deterministic fixture hands output to manual ingress.",
    });
    const brainstormApplied = await applyManualShapingResult(
      service,
      root,
      sourceId,
      workItemId,
      "brainstorm",
    );
    expect(brainstormApplied.imported).toMatchObject({
      outcome: "applied",
      receipt: { outcome: "applied" },
    });

    const brainstormReady = await service.listShapingArtifacts(
      sourceId,
      workItemId,
    );
    const brainstormTip = currentPhaseArtifact(
      brainstormReady.artifacts,
      "brainstorm",
    );
    const used = await service.useBrainstormResult(sourceId, workItemId, {
      launch_mode: "connected",
      next_requested_model: "spec-model",
      expected_mission_content_sha256:
        brainstormTip.mission.content_sha256,
      expected_result_content_sha256:
        brainstormTip.result!.result_content_sha256,
      expected_shaping_state_sha256:
        brainstormReady.expected_shaping_state_sha256,
    });
    expect(used).toMatchObject({
      work_item: { state: { phase: "spec" } },
      next_launch: { status: "launched", created: true },
    });
    const replayedUse = await service.useBrainstormResult(
      sourceId,
      workItemId,
      {
        launch_mode: "connected",
        next_requested_model: "spec-model",
        expected_mission_content_sha256:
          brainstormTip.mission.content_sha256,
        expected_result_content_sha256:
          brainstormTip.result!.result_content_sha256,
        expected_shaping_state_sha256:
          brainstormReady.expected_shaping_state_sha256,
      },
    );
    expect(replayedUse.decision_id).toBe(used.decision_id);
    expect(replayedUse.next_launch).toEqual({
      status: "launched",
      shaping_run_id: used.next_launch.shaping_run_id,
      reason: null,
      created: false,
    });

    const specRunId = used.next_launch.shaping_run_id;
    if (specRunId === null) {
      throw new Error("Expected a Spec shaping run.");
    }
    await repository.completeShapingRun(workItemId, specRunId, {
      outcome: "failed",
      partial: true,
      reason: "Deterministic fixture hands output to manual ingress.",
    });
    const specApplied = await applyManualShapingResult(
      service,
      root,
      sourceId,
      workItemId,
      "spec",
    );
    if (
      specApplied.imported.outcome !== "applied" ||
      !("proposal" in specApplied.imported.result)
    ) {
      throw new Error("Expected one applied Spec result.");
    }
    const specReady = await service.listShapingArtifacts(sourceId, workItemId);
    const specTip = currentPhaseArtifact(specReady.artifacts, "spec");
    const derivedContract = goalContractFromSpecProposal(
      specApplied.imported.result.proposal,
      1,
    );
    const approved = await service.approveSpecResult(
      sourceId,
      workItemId,
      {
        launch_mode: "connected",
        next_requested_model: "plan-model",
        expected_mission_content_sha256: specTip.mission.content_sha256,
        expected_result_content_sha256:
          specTip.result!.result_content_sha256,
        expected_shaping_state_sha256:
          specReady.expected_shaping_state_sha256,
        goal_contract_sha256: hashGoalContract(derivedContract),
      },
    );
    expect(approved).toMatchObject({
      work_item: {
        goal: { goal_contract: derivedContract },
        state: {
          phase: "plan",
          goal_version: 1,
          input_revision: 1,
        },
      },
      next_launch: { status: "launched", created: true },
    });
    await expect(
      service.compilePlanMission(sourceId, workItemId),
    ).resolves.toMatchObject({
      mission: { identity: { phase: "plan" } },
    });

    const planRunId = approved.next_launch.shaping_run_id;
    if (planRunId === null) {
      throw new Error("Expected a Plan shaping run.");
    }
    await repository.completeShapingRun(workItemId, planRunId, {
      outcome: "failed",
      partial: true,
      reason: "Deterministic fixture hands output to manual ingress.",
    });
    const planApplied = await applyManualShapingResult(
      service,
      root,
      sourceId,
      workItemId,
      "plan",
    );
    expect(planApplied.imported).toMatchObject({
      outcome: "applied",
      receipt: { outcome: "applied" },
    });
    const complete = await service.listShapingArtifacts(sourceId, workItemId);
    expect(complete.model_use).toEqual([
      expect.objectContaining({
        seat: "brainstorm",
        requested_model: null,
        effective_model: null,
      }),
      expect.objectContaining({
        seat: "spec",
        requested_model: null,
        effective_model: null,
      }),
      expect.objectContaining({
        seat: "plan",
        requested_model: null,
        effective_model: null,
      }),
    ]);
    expect(complete.artifacts).toHaveLength(3);
    await expect(
      service.launchShapingRun(sourceId, workItemId, "plan", {
        requested_model: "plan-model",
      }),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });
    expect(fake.prepare).toHaveBeenCalledTimes(3);
  });

  it("approves a ready Plan for manual Execute exactly once and replays the immutable handoff", async () => {
    const root = await createWorkspace("Manual Plan Approval Workspace");
    const repository = new ProductWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Approve one manual Execute handoff",
      type: "Feature",
    });
    const { service } = await createService(
      createMemoryIndex(),
      () => repository,
    );
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    const workItemId = created.goal.work_item_id;
    const ready = await prepareReadyPlan(
      service,
      root,
      sourceId,
      created,
    );
    const input = {
      launch_mode: "manual" as const,
      requested_model: null,
      ...ready.binding,
    };

    const first = await service.approvePlanResult(
      sourceId,
      workItemId,
      input,
    );
    expect(first).toMatchObject({
      launch_mode: "manual",
      requested_model: null,
      work_item: {
        goal: { goal_contract: ready.goalContract },
        state: {
          phase: "execute",
          status: "active",
          goal_version: 1,
          input_revision: 1,
          attempt: 0,
        },
      },
      execute_tuple: {
        goal_version: 1,
        input_revision: 1,
        attempt: 0,
      },
      mission: { mission: { identity: { phase: "execute" } } },
      connected_run: null,
      next_launch: {
        status: "manual",
        connected_run_id: null,
        reason: "runtime_unavailable",
      },
    });
    const durable = await repository.read(workItemId);
    expect(durable?.state).toMatchObject({
      phase: "execute",
      status: "active",
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
    });

    const approvalDirectory = join(
      root,
      ".founder",
      "work-items",
      workItemId,
      "plan-approvals",
    );
    const approvalEntries = (await readdir(approvalDirectory)).sort();
    expect(approvalEntries).toEqual([
      `${first.approval_id}.intent.json`,
      `${first.approval_id}.json`,
    ]);
    const decided = currentPhaseArtifact(
      await repository.listShapingArtifacts(workItemId),
      "plan",
    );
    expect(decided.decision?.receipt).toMatchObject({
      identity: ready.plan.mission.identity,
      execute_tuple: first.execute_tuple,
    });
    const receiptPath = join(
      root,
      dirname(ready.plan.mission_path),
      "decision.json",
    );
    const firstBytes = {
      receipt: await readFile(receiptPath, "utf8"),
      intent: await readFile(join(approvalDirectory, approvalEntries[0]!), "utf8"),
      manifest: await readFile(join(approvalDirectory, approvalEntries[1]!), "utf8"),
      mission: await readFile(first.mission!.mission_path, "utf8"),
      task: await readFile(first.mission!.task_path, "utf8"),
    };

    const replay = await service.approvePlanResult(
      sourceId,
      workItemId,
      input,
    );
    expect(replay).toEqual(first);
    expect((await readdir(approvalDirectory)).sort()).toEqual(approvalEntries);
    await expect(readFile(receiptPath, "utf8")).resolves.toBe(
      firstBytes.receipt,
    );
    await expect(
      readFile(join(approvalDirectory, approvalEntries[0]!), "utf8"),
    ).resolves.toBe(firstBytes.intent);
    await expect(
      readFile(join(approvalDirectory, approvalEntries[1]!), "utf8"),
    ).resolves.toBe(firstBytes.manifest);
    await expect(readFile(replay.mission!.mission_path, "utf8")).resolves.toBe(
      firstBytes.mission,
    );
    await expect(readFile(replay.mission!.task_path, "utf8")).resolves.toBe(
      firstBytes.task,
    );
    expect(
      await readdir(join(root, ".founder", "missions", workItemId)),
    ).toHaveLength(1);
  });

  it("commits a connected Plan approval before agent start and replays one governed run", async () => {
    const root = await createWorkspace("Connected Plan Approval Workspace");
    const repository = new ProductWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Approve one connected Execute handoff",
      type: "Feature",
    });
    const result = deferred<AcpRunResult>();
    const session: AcpSession = {
      session_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7c1",
      protocol_version: 1,
      requested_mcp_server_count: 0,
      config_options: [],
      wall_clock_timeout_ms: 2_000,
      process: {
        pid: 4101,
        process_group_id: 4101,
        started_at: "2026-08-05T14:00:00.000Z",
      },
      run: vi.fn(() => result.promise),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    let approvalCommitted = false;
    const fake = preparedRuntime(session, "execute-model", () => {
      expect(approvalCommitted).toBe(true);
    });
    const originalCommit = repository.commitPlanApproval.bind(repository);
    const commit = vi
      .spyOn(repository, "commitPlanApproval")
      .mockImplementation(async (lease, input) => {
        const committed = await originalCommit(lease, input);
        approvalCommitted = true;
        return committed;
      });
    const { service } = await createService(
      createMemoryIndex(),
      () => repository,
      fake.runtime,
    );
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    const workItemId = created.goal.work_item_id;
    const ready = await prepareReadyPlan(
      service,
      root,
      sourceId,
      created,
    );
    await expect(
      service.approvePlanResult(sourceId, workItemId, {
        launch_mode: "connected",
        requested_model: "unavailable-model",
        ...ready.binding,
      }),
    ).rejects.toMatchObject({
      kind: "mission_not_ready",
      reason:
        "Requested Execute model unavailable-model is not in available_model_ids.",
    });
    expect(await repository.read(workItemId)).toMatchObject({
      state: { phase: "plan", status: "active" },
    });
    expect(
      currentPhaseArtifact(
        await repository.listShapingArtifacts(workItemId),
        "plan",
      ).decision,
    ).toBeNull();
    await expect(
      readdir(
        join(
          root,
          ".founder",
          "work-items",
          workItemId,
          "plan-approvals",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(fake.prepare).not.toHaveBeenCalled();
    expect(fake.start).not.toHaveBeenCalled();
    const input = {
      launch_mode: "connected" as const,
      requested_model: "execute-model",
      ...ready.binding,
    };

    const first = await service.approvePlanResult(
      sourceId,
      workItemId,
      input,
    );
    expect(first).toMatchObject({
      launch_mode: "connected",
      requested_model: "execute-model",
      work_item: { state: { phase: "execute", status: "active" } },
      next_launch: { status: "launched" },
      connected_run: {
        provenance: {
          requested_model: {
            value: "execute-model",
            assurance: "user_declared",
          },
        },
      },
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(fake.prepare).toHaveBeenCalledOnce();
    expect(fake.start).toHaveBeenCalledOnce();
    expect(session.run).toHaveBeenCalledOnce();
    expect(fake.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ model_override: "execute-model" }),
    );
    expect(
      Object.hasOwn(fake.prepare.mock.calls[0]![0], "requested_model"),
    ).toBe(false);
    const storedRuns = await repository.listConnectedRuns(workItemId);
    expect(storedRuns).toHaveLength(1);
    expect(storedRuns[0]).toMatchObject({
      connected_run_id: first.next_launch.connected_run_id,
      provenance: {
        requested_model: {
          value: "execute-model",
          assurance: "user_declared",
        },
        authorization_sha256: { assurance: "controller_observed" },
      },
      authorization: {
        kind: "capability_envelope",
        envelope_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
      lifecycle: { status: "running" },
    });

    const replay = await service.approvePlanResult(
      sourceId,
      workItemId,
      input,
    );
    expect(replay.approval_id).toBe(first.approval_id);
    expect(replay.next_launch).toEqual(first.next_launch);
    expect(replay.connected_run?.connected_run_id).toBe(
      first.connected_run?.connected_run_id,
    );
    expect(commit).toHaveBeenCalledOnce();
    expect(fake.prepare).toHaveBeenCalledOnce();
    expect(fake.start).toHaveBeenCalledOnce();
    expect(session.run).toHaveBeenCalledOnce();
    expect(await repository.listConnectedRuns(workItemId)).toHaveLength(1);
  });

  it("keeps Execute recoverable when connected launch fails after Plan approval", async () => {
    const root = await createWorkspace("Recoverable Plan Approval Workspace");
    const repository = new ProductWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Recover a failed connected Execute launch",
      type: "Feature",
    });
    const failingPrepare = vi.fn(
      async (input: Parameters<ConnectedWritableRuntime["prepare"]>[0]) => {
        void input;
        throw new Error("Execute adapter unavailable after approval commit");
      },
    );
    const failingRuntime: ConnectedWritableRuntime = {
      configuration: () => ({
        adapter_id: "copilot-acp",
        adapter_version: "1.0.0",
        profile_id: "noninteractive-execute-v1",
        available_model_ids: ["execute-model"],
        default_model: "execute-model",
      }),
      prepare: failingPrepare,
    };
    const { service } = await createService(
      createMemoryIndex(),
      () => repository,
      failingRuntime,
    );
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    const workItemId = created.goal.work_item_id;
    const ready = await prepareReadyPlan(
      service,
      root,
      sourceId,
      created,
    );

    const failed = await service.approvePlanResult(sourceId, workItemId, {
      launch_mode: "connected",
      requested_model: "execute-model",
      ...ready.binding,
    });
    expect(failed).toMatchObject({
      work_item: { state: { phase: "execute", status: "active" } },
      connected_run: null,
      next_launch: {
        status: "failed",
        connected_run_id: null,
        reason: "Execute adapter unavailable after approval commit",
      },
    });
    expect(failingPrepare).toHaveBeenCalledOnce();
    expect(await repository.read(workItemId)).toMatchObject({
      state: { phase: "execute", status: "active", attempt: 0 },
    });
    expect(await repository.listConnectedRuns(workItemId)).toEqual([]);
    expect(
      await readdir(
        join(
          root,
          ".founder",
          "work-items",
          workItemId,
          "plan-approvals",
        ),
      ),
    ).toHaveLength(2);

    const recoveryResult = deferred<AcpRunResult>();
    const recoverySession: AcpSession = {
      session_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7c2",
      protocol_version: 1,
      requested_mcp_server_count: 0,
      config_options: [],
      wall_clock_timeout_ms: 2_000,
      process: {
        pid: 4102,
        process_group_id: 4102,
        started_at: "2026-08-05T14:01:00.000Z",
      },
      run: vi.fn(() => recoveryResult.promise),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const recoveryRuntime = preparedRuntime(recoverySession, "execute-model");
    const recovery = await createService(
      createMemoryIndex(),
      () => repository,
      recoveryRuntime.runtime,
    );
    const recoveryRegistration = await recovery.service.register({
      workspace_path: root,
    });
    const launched = await recovery.service.launchConnectedExecute(
      recoveryRegistration.workspace.workspace_id,
      workItemId,
      { model_override: "execute-model" },
    );
    expect(launched.connected_run).toMatchObject({
      lifecycle: { status: "running" },
      provenance: {
        requested_model: { value: "execute-model" },
      },
    });
    expect(recoveryRuntime.prepare).toHaveBeenCalledOnce();
    expect(await repository.listConnectedRuns(workItemId)).toHaveLength(1);
  });

  it("exposes Execute model options only for the current eligible Plan decision", async () => {
    const root = await createWorkspace("Execute Picker Workspace");
    const repository = new ProductWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Choose an independent Execute model",
      type: "Feature",
    });
    const shapingRuntime = fakeArtifactOnlyRuntime();
    const executePrepare = vi.fn(
      async (input: Parameters<ConnectedWritableRuntime["prepare"]>[0]) => {
        void input;
        throw new Error("Execute must not launch while reading picker options.");
      },
    );
    const executeRuntime: ConnectedWritableRuntime = {
      configuration: () => ({
        adapter_id: "fake-execute-acp",
        adapter_version: "1.0.0",
        profile_id: "execute-picker-v1",
        available_model_ids: ["adapter-model-b", "execute-model"],
        default_model: "execute-model",
      }),
      prepare: executePrepare,
    };
    const { service } = await createService(
      createMemoryIndex(),
      () => repository,
      executeRuntime,
      shapingRuntime.runtime,
    );
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    const workItemId = created.goal.work_item_id;
    const waitForAppliedPhase = async (phase: ShapingPhase) => {
      await expect.poll(async () => {
        const listing = await service.listShapingArtifacts(
          sourceId,
          workItemId,
        );
        const tip = currentPhaseArtifact(listing.artifacts, phase);
        const run = listing.runs.find(
          (candidate) =>
            candidate.mission.phase === phase &&
            candidate.mission.input_sha256 ===
              tip.mission.identity.input_sha256,
        );
        return (
          tip.result !== null &&
          run?.lifecycle.status === "terminal" &&
          run.lifecycle.terminal_outcome === "completed"
        );
      }).toBe(true);
      return service.listShapingArtifacts(sourceId, workItemId);
    };

    await service.startBrainstorm(sourceId, workItemId, {
      launch_mode: "connected",
      next_requested_model: "requested-model",
      expected_mission_content_sha256: null,
      expected_result_content_sha256: null,
      expected_shaping_state_sha256: ideaShapingStateSha256(created),
    });
    const brainstormReady = await waitForAppliedPhase("brainstorm");
    const brainstorm = currentPhaseArtifact(
      brainstormReady.artifacts,
      "brainstorm",
    );
    await service.useBrainstormResult(sourceId, workItemId, {
      launch_mode: "connected",
      next_requested_model: "requested-model",
      expected_mission_content_sha256: brainstorm.mission.content_sha256,
      expected_result_content_sha256:
        brainstorm.result!.result_content_sha256,
      expected_shaping_state_sha256:
        brainstormReady.expected_shaping_state_sha256,
    });
    const specReady = await waitForAppliedPhase("spec");
    const spec = currentPhaseArtifact(specReady.artifacts, "spec");
    const specResult = shapingResultForMission(spec.mission);
    if (!("proposal" in specResult) || specResult.proposal === undefined) {
      throw new Error("Expected one connected Spec proposal.");
    }
    const goalContract = goalContractFromSpecProposal(specResult.proposal, 1);
    await service.approveSpecResult(sourceId, workItemId, {
      launch_mode: "connected",
      next_requested_model: "requested-model",
      expected_mission_content_sha256: spec.mission.content_sha256,
      expected_result_content_sha256: spec.result!.result_content_sha256,
      expected_shaping_state_sha256: specReady.expected_shaping_state_sha256,
      goal_contract_sha256: hashGoalContract(goalContract),
    });
    const planReady = await waitForAppliedPhase("plan");
    const plan = currentPhaseArtifact(planReady.artifacts, "plan");

    expect(planReady.execute_model_availability).toEqual({
      status: "available",
      adapter_id: "fake-execute-acp",
      adapter_version: "1.0.0",
      profile_id: "execute-picker-v1",
      available_model_ids: ["adapter-model-b", "execute-model"],
      distinct_model_count: 2,
      has_three_distinct_models: false,
      reason: null,
    });
    expect(planReady.model_use).toEqual([
      expect.objectContaining({
        seat: "brainstorm",
        effective_model: "adapter-model-b",
      }),
      expect.objectContaining({
        seat: "spec",
        effective_model: "adapter-model-b",
      }),
      expect.objectContaining({
        seat: "plan",
        effective_model: "adapter-model-b",
      }),
    ]);
    expect(planReady.model_picker_options.execute).toEqual([
      {
        model_id: "execute-model",
        used_by_seats: [],
        saved_preference: false,
        recommended: true,
        preselected: true,
        reuse_warning: null,
      },
      {
        model_id: "adapter-model-b",
        used_by_seats: ["brainstorm", "spec", "plan"],
        saved_preference: false,
        recommended: false,
        preselected: false,
        reuse_warning:
          "adapter-model-b was already used by brainstorm, spec, plan; reuse is allowed, but an unused model improves seat independence.",
      },
    ]);
    expect(
      planReady.model_picker_options.execute.map((option) => option.model_id),
    ).not.toContain("requested-model");
    expect(executePrepare).not.toHaveBeenCalled();

    const unavailable = await createService(
      createMemoryIndex(),
      () => repository,
      undefined,
      shapingRuntime.runtime,
    );
    const unavailableRegistration = await unavailable.service.register({
      workspace_path: root,
    });
    const unavailableListing = await unavailable.service.listShapingArtifacts(
      unavailableRegistration.workspace.workspace_id,
      workItemId,
    );
    expect(unavailableListing.execute_model_availability).toMatchObject({
      status: "unavailable",
      reason: "runtime_unavailable",
    });
    expect(unavailableListing.model_picker_options.execute).toEqual([]);

    const goalPath = join(
      root,
      ".founder",
      "work-items",
      workItemId,
      "goal.yaml",
    );
    const originalGoalSource = await readFile(goalPath, "utf8");
    const governed = await repository.read(workItemId);
    if (governed?.goal.goal_contract === undefined) {
      throw new Error("Expected the governed Plan contract.");
    }
    await writeFile(
      goalPath,
      stringify({
        ...governed.goal,
        goal_contract: {
          ...governed.goal.goal_contract,
          purpose: `${governed.goal.goal_contract.purpose} (drifted)`,
        },
      }),
      "utf8",
    );
    expect(
      (
        await service.listShapingArtifacts(sourceId, workItemId)
      ).model_picker_options.execute,
    ).toEqual([]);
    await writeFile(goalPath, originalGoalSource, "utf8");

    await service.approvePlanResult(sourceId, workItemId, {
      launch_mode: "manual",
      requested_model: null,
      expected_mission_content_sha256: plan.mission.content_sha256,
      expected_result_content_sha256: plan.result!.result_content_sha256,
      expected_shaping_state_sha256:
        planReady.expected_shaping_state_sha256,
      goal_contract_sha256: hashGoalContract(goalContract),
    });
    const decided = await service.listShapingArtifacts(sourceId, workItemId);
    expect(decided.model_picker_options.execute).toEqual([]);
    expect(decided.execute_model_availability.status).toBe("available");
    expect(executePrepare).not.toHaveBeenCalled();
  });

  it("runs artifact-only shaping through ACP, publishes before ready, and persists the last adapter-observed model", async () => {
    const root = await createWorkspace("Artifact-only ACP Workspace");
    const repository = new ProductWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Produce one artifact-only shaping result",
      type: "Feature",
    });
    const fake = fakeArtifactOnlyRuntime();
    const { service } = await createService(
      new SQLitePortfolioIndex(":memory:"),
      () => repository,
      undefined,
      fake.runtime,
    );
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    const workItemId = created.goal.work_item_id;
    const launched = await service.startBrainstorm(sourceId, workItemId, {
      launch_mode: "connected",
      next_requested_model: "requested-model",
      expected_mission_content_sha256: null,
      expected_result_content_sha256: null,
      expected_shaping_state_sha256: ideaShapingStateSha256(created),
    });
    expect(launched.next_launch).toMatchObject({
      status: "launched",
      created: true,
    });
    const shapingRunId = launched.next_launch.shaping_run_id;
    if (shapingRunId === null) {
      throw new Error("Expected one artifact-only shaping run.");
    }

    await expect.poll(async () => {
      const listing = await service.listShapingArtifacts(sourceId, workItemId);
      return currentPhaseArtifact(listing.artifacts, "brainstorm").result !== null;
    }).toBe(true);
    await expect.poll(async () => {
      const listing = await service.listShapingArtifacts(sourceId, workItemId);
      const run = listing.runs.find(
        (candidate) => candidate.shaping_run_id === shapingRunId,
      );
      return (
        run?.lifecycle.status === "terminal" &&
        run.lifecycle.terminal_outcome === "completed"
      );
    }).toBe(true);
    const listing = await service.listShapingArtifacts(sourceId, workItemId);
    const artifact = currentPhaseArtifact(listing.artifacts, "brainstorm");
    const run = listing.runs.find(
      (candidate) => candidate.shaping_run_id === shapingRunId,
    );
    expect(run).toMatchObject({
      provenance: {
        requested_model: {
          value: "requested-model",
          assurance: "user_declared",
        },
        effective_model: {
          assurance: "adapter_attested",
          model_id: "adapter-model-b",
          deployment_id: "deployment-b",
        },
      },
      lifecycle: {
        status: "terminal",
        terminal_outcome: "completed",
      },
    });
    expect(artifact.production_receipt).toMatchObject({
      origin: "connected_run",
      production_id: shapingRunId,
      shaping_run_id: shapingRunId,
      requested_model: { value: "requested-model" },
      effective_model: {
        assurance: "adapter_attested",
        model_id: "adapter-model-b",
        deployment_id: "deployment-b",
      },
    });
    expect(artifact.result).not.toBeNull();

    const instructionPath = join(
      root,
      ".founder",
      "shaping-runs",
      workItemId,
      shapingRunId,
      "instruction.json",
    );
    const runPath = join(dirname(instructionPath), "run.json");
    const evidencePath = join(dirname(instructionPath), "events.ndjson");
    const prompt = fake.prompts[0]!;
    const durableSources = [
      prompt,
      await readFile(instructionPath, "utf8"),
      await readFile(runPath, "utf8"),
      await readFile(join(root, artifact.mission_path), "utf8"),
      await readFile(join(root, artifact.task_path), "utf8"),
    ].join("\n");
    expect(prompt).toContain(artifact.mission.content_sha256);
    expect(prompt).toContain(
      `.founder/shaping-runs/${workItemId}/${shapingRunId}/ingress/result.json`,
    );
    for (const forbidden of [
      "http://127.0.0.1:3000",
      "/api/",
      "expected_",
      "goal_contract_sha256",
    ]) {
      expect(durableSources).not.toContain(forbidden);
    }
    const evidence = await readFile(evidencePath, "utf8");
    for (const canary of [
      "MODEL_NAME_MUST_NOT_PERSIST",
      "MODEL_DESCRIPTION_MUST_NOT_PERSIST",
      "MODEL_A_NAME_MUST_NOT_PERSIST",
      "MODEL_B_NAME_MUST_NOT_PERSIST",
      "MODEL_META_MUST_NOT_PERSIST",
    ]) {
      expect(evidence).not.toContain(canary);
    }
  });

  it("publishes shaping output received through the advertised ACP client filesystem fallback", async () => {
    const root = await createWorkspace("ACP client filesystem Workspace");
    const repository = new ProductWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Produce shaping through ACP client filesystem",
      type: "Feature",
    });
    const fake = fakeArtifactOnlyRuntime({ use_client_write: true });
    const { service } = await createService(
      new SQLitePortfolioIndex(":memory:"),
      () => repository,
      undefined,
      fake.runtime,
    );
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;

    await service.startBrainstorm(sourceId, created.goal.work_item_id, {
      launch_mode: "connected",
      next_requested_model: "requested-model",
      expected_mission_content_sha256: null,
      expected_result_content_sha256: null,
      expected_shaping_state_sha256: ideaShapingStateSha256(created),
    });

    await expect.poll(async () => {
      const listing = await service.listShapingArtifacts(
        sourceId,
        created.goal.work_item_id,
      );
      return currentPhaseArtifact(listing.artifacts, "brainstorm").result !== null;
    }).toBe(true);
    const listing = await service.listShapingArtifacts(
      sourceId,
      created.goal.work_item_id,
    );
    expect(listing.runs[0]).toMatchObject({
      lifecycle: { status: "terminal", terminal_outcome: "completed" },
    });
  });

  it("joins cancellation to an in-flight shaping publication instead of terminalizing twice", async () => {
    const root = await createWorkspace("Serialized shaping cancellation Workspace");
    const repository = new PausedShapingPublicationWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Serialize cancellation with publication",
      type: "Feature",
    });
    const fake = fakeArtifactOnlyRuntime();
    const { service } = await createService(
      new SQLitePortfolioIndex(":memory:"),
      () => repository,
      undefined,
      fake.runtime,
    );
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    const workItemId = created.goal.work_item_id;
    const launched = await service.startBrainstorm(sourceId, workItemId, {
      launch_mode: "connected",
      next_requested_model: "requested-model",
      expected_mission_content_sha256: null,
      expected_result_content_sha256: null,
      expected_shaping_state_sha256: ideaShapingStateSha256(created),
    });
    const runId = launched.next_launch.shaping_run_id;
    if (runId === null) {
      throw new Error("Expected one shaping run with paused publication.");
    }
    await repository.publicationStarted.promise;

    const cancellation = service.cancelShapingRun(
      sourceId,
      workItemId,
      runId,
    );
    const stateBeforePublicationSettles = await Promise.race([
      cancellation.then(() => "settled" as const),
      new Promise<"waiting">((resolveWaiting) => {
        setTimeout(() => resolveWaiting("waiting"), 50);
      }),
    ]);
    repository.resumePublication.resolve(undefined);

    expect(stateBeforePublicationSettles).toBe("waiting");
    const result = await cancellation;
    if (result.shaping_run === null) {
      throw new Error("Expected the completed shaping run after cancellation joined.");
    }
    expect(result.shaping_run.lifecycle).toMatchObject({
      status: "terminal",
      terminal_outcome: "completed",
    });
    const listing = await service.listShapingArtifacts(sourceId, workItemId);
    expect(currentPhaseArtifact(listing.artifacts, "brainstorm").result).not.toBeNull();
    expect(listing.runs).toHaveLength(1);
    await expect(
      service.launchShapingRun(sourceId, workItemId, "brainstorm", {
        requested_model: "requested-model",
      }),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });
  });

  it.each([
    ["zero model options", [], null, "unknown"],
    [
      "two model options",
      [
        modelConfigOption("adapter-model-a", "deployment-a"),
        {
          ...modelConfigOption("adapter-model-b", "deployment-b"),
          id: "secondary-model",
        },
      ],
      null,
      "unknown",
    ],
    [
      "automatic model selection",
      [modelConfigOption("auto", "deployment-auto")],
      null,
      "unknown",
    ],
    [
      "an invalid later update",
      [modelConfigOption("adapter-model-a", "deployment-a")],
      [modelConfigOption("auto", "deployment-auto")],
      "adapter-model-a",
    ],
  ] as const)(
    "keeps effective-model provenance truthful for %s",
    async (_label, initialOptions, updateOptions, expectedModel) => {
      const root = await createWorkspace("Truthful model provenance Workspace");
      const repository = new ProductWorkspace(root, {
        git: controllerGit,
        verificationRunner: controllerRunner,
      });
      const created = await repository.create({
        title: "Keep unresolved model provenance unknown",
        type: "Feature",
      });
      const fake = fakeArtifactOnlyRuntime({
        session_config_options: initialOptions,
        config_update: updateOptions,
      });
      const { service } = await createService(
        new SQLitePortfolioIndex(":memory:"),
        () => repository,
        undefined,
        fake.runtime,
      );
      const registration = await service.register({ workspace_path: root });
      const sourceId = registration.workspace.workspace_id;
      await service.startBrainstorm(sourceId, created.goal.work_item_id, {
        launch_mode: "connected",
        next_requested_model: "requested-model",
        expected_mission_content_sha256: null,
        expected_result_content_sha256: null,
        expected_shaping_state_sha256: ideaShapingStateSha256(created),
      });
      await expect.poll(async () => {
        const listing = await service.listShapingArtifacts(
          sourceId,
          created.goal.work_item_id,
        );
        return currentPhaseArtifact(listing.artifacts, "brainstorm")
          .production_receipt?.effective_model.model_id;
      }).toBe(expectedModel === "unknown" ? null : expectedModel);
      const artifact = currentPhaseArtifact(
        (
          await service.listShapingArtifacts(
            sourceId,
            created.goal.work_item_id,
          )
        ).artifacts,
        "brainstorm",
      );
      expect(artifact.production_receipt?.effective_model.assurance).toBe(
        expectedModel === "unknown" ? "unknown" : "adapter_attested",
      );
    },
  );

  it.each([
    [
      "another workspace path",
      (instruction: ShapingIngressInstructionV1) => ({
        schema_version: 1 as const,
        kind: "workspace_write" as const,
        path: `${dirname(instruction.ingress_path)}/sibling.json`,
      }),
    ],
    [
      "a command",
      () => ({
        schema_version: 1 as const,
        kind: "command" as const,
        executable: "npm",
        args: ["test"],
      }),
    ],
    [
      "the configured loopback URL",
      () => ({
        schema_version: 1 as const,
        kind: "url" as const,
        method: "GET" as const,
        protocol: "http" as const,
        host: "127.0.0.1:3000",
        path: "/api/portfolio",
      }),
    ],
    [
      "an MCP server",
      () => ({
        schema_version: 1 as const,
        kind: "mcp" as const,
        server: "product-studio",
      }),
    ],
    [
      "a credential",
      () => ({
        schema_version: 1 as const,
        kind: "credential" as const,
        source: "environment",
      }),
    ],
  ])("fails a mediated shaping request for %s without applying a result", async (_label, request) => {
    const root = await createWorkspace("Denied artifact-only ACP Workspace");
    const repository = new ProductWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Deny every non-ingress capability",
      type: "Feature",
    });
    const fake = fakeArtifactOnlyRuntime({ request });
    const { service } = await createService(
      new SQLitePortfolioIndex(":memory:"),
      () => repository,
      undefined,
      fake.runtime,
    );
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    const workItemId = created.goal.work_item_id;
    const launched = await service.startBrainstorm(sourceId, workItemId, {
      launch_mode: "connected",
      next_requested_model: "requested-model",
      expected_mission_content_sha256: null,
      expected_result_content_sha256: null,
      expected_shaping_state_sha256: ideaShapingStateSha256(created),
    });
    const runId = launched.next_launch.shaping_run_id;
    if (runId === null) {
      throw new Error("Expected one denied shaping run.");
    }
    await expect.poll(async () => {
      const record = await repository.readShapingRun(workItemId, runId);
      return record?.lifecycle.status;
    }).toBe("terminal");
    const listing = await service.listShapingArtifacts(sourceId, workItemId);
    expect(currentPhaseArtifact(listing.artifacts, "brainstorm").result).toBeNull();
    expect(listing.runs).toContainEqual(
      expect.objectContaining({
        shaping_run_id: runId,
        lifecycle: expect.objectContaining({
          status: "terminal",
          terminal_outcome: "missing_permission",
        }),
        diagnostics: expect.objectContaining({ count: 1 }),
      }),
    );
    expect(await service.list()).toContainEqual(
      expect.objectContaining({
        source_id: sourceId,
        shaping_summary: expect.objectContaining({
          latest_run_status: "blocked",
        }),
      }),
    );
    expect(await service.listAttention()).toEqual([]);
  });

  it("rejects invalid shaping output without persisting its bytes in diagnostics or evidence", async () => {
    const root = await createWorkspace("Redacted shaping rejection Workspace");
    const repository = new ProductWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Reject invalid output without leaking it",
      type: "Feature",
    });
    const canary = "SHAPING_RESULT_SECRET_CANARY";
    const fake = fakeArtifactOnlyRuntime({ result_source: canary });
    const { service } = await createService(
      new SQLitePortfolioIndex(":memory:"),
      () => repository,
      undefined,
      fake.runtime,
    );
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    const workItemId = created.goal.work_item_id;
    const launched = await service.startBrainstorm(sourceId, workItemId, {
      launch_mode: "connected",
      next_requested_model: "requested-model",
      expected_mission_content_sha256: null,
      expected_result_content_sha256: null,
      expected_shaping_state_sha256: ideaShapingStateSha256(created),
    });
    const runId = launched.next_launch.shaping_run_id;
    if (runId === null) {
      throw new Error("Expected one rejected shaping run.");
    }
    await expect.poll(async () => {
      const record = await repository.readShapingRun(workItemId, runId);
      return record?.lifecycle.status;
    }).toBe("terminal");

    const runDirectory = join(
      root,
      ".founder",
      "shaping-runs",
      workItemId,
      runId,
    );
    const listing = await service.listShapingArtifacts(sourceId, workItemId);
    const retained = [
      await readFile(join(runDirectory, "run.json"), "utf8"),
      await readFile(join(runDirectory, "events.ndjson"), "utf8"),
      JSON.stringify(listing),
    ].join("\n");
    expect(retained).not.toContain(canary);
    expect(listing.runs).toContainEqual(
      expect.objectContaining({
        shaping_run_id: runId,
        lifecycle: expect.objectContaining({
          status: "terminal",
          terminal_outcome: "failed",
        }),
        diagnostics: expect.objectContaining({ count: 1 }),
      }),
    );
  });

  it("stops a tampered shaping instruction before ACP evaluation and terminalizes the durable run", async () => {
    const root = await createWorkspace("Tampered shaping instruction Workspace");
    const repository = new ProductWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const createShapingRun = repository.createShapingRun.bind(repository);
    vi.spyOn(repository, "createShapingRun").mockImplementation(async (input) => {
      const createdRun = await createShapingRun(input);
      if (createdRun.created) {
        await writeFile(
          join(
            root,
            ".founder",
            "shaping-runs",
            createdRun.record.mission.work_item_id,
            createdRun.record.shaping_run_id,
            "instruction.json",
          ),
          `${JSON.stringify(
            { ...createdRun.instruction, ingress_path: "tampered/result.json" },
            null,
            2,
          )}\n`,
          "utf8",
        );
      }
      return createdRun;
    });
    const created = await repository.create({
      title: "Reject a changed instruction",
      type: "Feature",
    });
    const fake = fakeArtifactOnlyRuntime();
    const { service } = await createService(
      new SQLitePortfolioIndex(":memory:"),
      () => repository,
      undefined,
      fake.runtime,
    );
    const registration = await service.register({ workspace_path: root });
    const launched = await service.startBrainstorm(
      registration.workspace.workspace_id,
      created.goal.work_item_id,
      {
        launch_mode: "connected",
        next_requested_model: "requested-model",
        expected_mission_content_sha256: null,
        expected_result_content_sha256: null,
        expected_shaping_state_sha256: ideaShapingStateSha256(created),
      },
    );
    expect(launched.next_launch).toMatchObject({
      status: "failed",
      shaping_run_id: expect.any(String),
    });
    expect(fake.starts).not.toHaveBeenCalled();
    const runId = launched.next_launch.shaping_run_id!;
    const rawRun = JSON.parse(
      await readFile(
        join(
          root,
          ".founder",
          "shaping-runs",
          created.goal.work_item_id,
          runId,
          "run.json",
        ),
        "utf8",
      ),
    ) as { lifecycle: { status: string; terminal: { outcome: string } } };
    expect(rawRun.lifecycle).toMatchObject({
      status: "terminal",
      terminal: { outcome: "failed" },
    });
  });

  it("cancels only an owned shaping session and leaves the mission retryable", async () => {
    const root = await createWorkspace("Cancelled artifact-only ACP Workspace");
    const repository = new ProductWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Cancel an owned shaping run",
      type: "Feature",
    });
    const fake = fakeArtifactOnlyRuntime({ delay_ms: 500 });
    const { service } = await createService(
      new SQLitePortfolioIndex(":memory:"),
      () => repository,
      undefined,
      fake.runtime,
    );
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    const launched = await service.startBrainstorm(
      sourceId,
      created.goal.work_item_id,
      {
        launch_mode: "connected",
        next_requested_model: "requested-model",
        expected_mission_content_sha256: null,
        expected_result_content_sha256: null,
        expected_shaping_state_sha256: ideaShapingStateSha256(created),
      },
    );
    const runId = launched.next_launch.shaping_run_id!;
    const cancelled = await service.cancelShapingRun(
      sourceId,
      created.goal.work_item_id,
      runId,
    );
    expect(cancelled.shaping_run).toMatchObject({
      lifecycle: {
        status: "terminal",
        terminal_outcome: "cancelled",
      },
    });
    const retry = await service.launchShapingRun(
      sourceId,
      created.goal.work_item_id,
      "brainstorm",
      { requested_model: "requested-model" },
    );
    expect(retry.next_launch).toMatchObject({
      status: "launched",
      created: true,
    });
    expect(retry.next_launch.shaping_run_id).not.toBe(runId);
    await service.cancelShapingRun(
      sourceId,
      created.goal.work_item_id,
      retry.next_launch.shaping_run_id!,
    );
  });

  it("creates an immutable feedback revision and reports fewer than three configured models without blocking launch", async () => {
    const root = await createWorkspace("Feedback Shaping Workspace");
    const repository = new ProductWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Revise one shaping result",
      type: "Feature",
    });
    const fake = preparedShapingRuntime(["model-a", "model-b"]);
    const { service } = await createService(
      new SQLitePortfolioIndex(":memory:"),
      undefined,
      undefined,
      fake.runtime,
    );
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    const workItemId = created.goal.work_item_id;
    await service.startBrainstorm(sourceId, workItemId, {
      launch_mode: "manual",
      next_requested_model: null,
      expected_mission_content_sha256: null,
      expected_result_content_sha256: null,
      expected_shaping_state_sha256: ideaShapingStateSha256(created),
    });
    await applyManualShapingResult(
      service,
      root,
      sourceId,
      workItemId,
      "brainstorm",
    );
    const ready = await service.listShapingArtifacts(sourceId, workItemId);
    expect(ready.model_availability).toMatchObject({
      status: "available",
      distinct_model_count: 2,
      has_three_distinct_models: false,
    });
    const predecessor = currentPhaseArtifact(ready.artifacts, "brainstorm");
    const predecessorMissionSource = await readFile(
      join(root, predecessor.mission_path),
      "utf8",
    );
    const changed = await service.requestShapingChanges(
      sourceId,
      workItemId,
      {
        launch_mode: "connected",
        next_requested_model: "model-a",
        expected_mission_content_sha256:
          predecessor.mission.content_sha256,
        expected_result_content_sha256:
          predecessor.result!.result_content_sha256,
        expected_shaping_state_sha256:
          ready.expected_shaping_state_sha256,
        feedback: "Keep the problem statement and narrow the approach.",
      },
    );
    expect(changed.next_launch).toMatchObject({
      status: "launched",
      created: true,
    });
    const revised = await service.listShapingArtifacts(sourceId, workItemId);
    const tip = currentPhaseArtifact(revised.artifacts, "brainstorm");
    expect(tip.mission.input.revision).toMatchObject({
      ordinal: 1,
      supersedes_input_sha256:
        predecessor.mission.identity.input_sha256,
      superseded_result_sha256:
        predecessor.result!.result_content_sha256,
      feedback: "Keep the problem statement and narrow the approach.",
    });
    expect(await readFile(join(root, predecessor.mission_path), "utf8")).toBe(
      predecessorMissionSource,
    );
    expect(await readFile(join(root, tip.task_path), "utf8")).toContain(
      "Keep the problem statement and narrow the approach.",
    );
    expect(revised.artifacts).toHaveLength(2);
  });

  it("keeps a committed decision after launch failure and applies Retry launch's ordered gates", async () => {
    const root = await createWorkspace("Retry Shaping Workspace");
    const repository = new ProductWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Recover a post-commit launch",
      type: "Feature",
    });
    const fake = preparedShapingRuntime(["locked-model", "new-model"]);
    fake.setPrepareFailure(new Error("simulated prepare failure"));
    const { service } = await createService(
      new SQLitePortfolioIndex(":memory:"),
      undefined,
      undefined,
      fake.runtime,
    );
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    const workItemId = created.goal.work_item_id;
    const decision = await service.startBrainstorm(sourceId, workItemId, {
      launch_mode: "connected",
      next_requested_model: "locked-model",
      expected_mission_content_sha256: null,
      expected_result_content_sha256: null,
      expected_shaping_state_sha256: ideaShapingStateSha256(created),
    });
    expect(decision).toMatchObject({
      work_item: { state: { phase: "brainstorm" } },
      next_launch: {
        status: "failed",
        shaping_run_id: null,
      },
    });
    expect(await repository.listShapingRuns(workItemId)).toEqual([]);
    const durableFailureListing = await service.listShapingArtifacts(
      sourceId,
      workItemId,
    );
    expect(durableFailureListing.post_commit_launch_failure).toEqual({
      decision_id: decision.decision_id,
      locked_model: "locked-model",
      reason: "The committed shaping decision has no matching shaping run.",
    });
    const { service: restartedService } = await createService(
      new SQLitePortfolioIndex(":memory:"),
      undefined,
      undefined,
      fake.runtime,
    );
    const restartedRegistration = await restartedService.register({
      workspace_path: root,
    });
    const restartedSourceId = restartedRegistration.workspace.workspace_id;
    expect(
      (
        await restartedService.listShapingArtifacts(
          restartedSourceId,
          workItemId,
        )
      ).post_commit_launch_failure,
    ).toEqual(durableFailureListing.post_commit_launch_failure);

    const decisionDirectory = join(
      root,
      ".founder",
      "work-items",
      workItemId,
      "shaping-decisions",
    );
    const manifestPath = join(
      decisionDirectory,
      decision.decision_id + ".json",
    );
    const intentPath = join(
      decisionDirectory,
      decision.decision_id + ".intent.json",
    );
    const manifestSource = await readFile(manifestPath, "utf8");
    const intentSource = await readFile(intentPath, "utf8");
    const intent = JSON.parse(intentSource) as {
      previous_state_bytes: string;
      next_state_bytes: string;
    };
    await unlink(manifestPath);
    await expect(
      service.listShapingArtifacts(sourceId, workItemId),
    ).rejects.toMatchObject({ kind: "repair_required" });
    await writeFile(manifestPath, manifestSource, "utf8");
    const retryInput = {
      decision_id: decision.decision_id,
      expected_shaping_state_sha256:
        durableFailureListing.expected_shaping_state_sha256,
    };

    const pendingManifest = JSON.parse(manifestSource) as Record<
      string,
      unknown
    >;
    pendingManifest.outcome = "pending";
    delete pendingManifest.completed_at;
    await writeFile(
      manifestPath,
      JSON.stringify(pendingManifest, null, 2) + "\n",
      "utf8",
    );
    await expect(
      service.listShapingArtifacts(sourceId, workItemId),
    ).rejects.toMatchObject({ kind: "repair_required" });
    await expect(
      service.retryShapingLaunch(
        sourceId,
        workItemId,
        "brainstorm",
        retryInput,
      ),
    ).rejects.toMatchObject({ kind: "repair_required" });
    expect(await repository.listShapingRuns(workItemId)).toEqual([]);
    await writeFile(manifestPath, manifestSource, "utf8");

    const statePath = join(
      root,
      ".founder",
      "work-items",
      workItemId,
      "state.json",
    );
    await writeFile(statePath, intent.previous_state_bytes, "utf8");
    await expect(
      service.retryShapingLaunch(
        sourceId,
        workItemId,
        "brainstorm",
        retryInput,
      ),
    ).rejects.toMatchObject({ kind: "repair_required" });
    expect(await repository.listShapingRuns(workItemId)).toEqual([]);
    await writeFile(statePath, intent.next_state_bytes, "utf8");

    fake.setPrepareFailure(null);
    const launched = await service.retryShapingLaunch(
      sourceId,
      workItemId,
      "brainstorm",
      retryInput,
    );
    expect(launched.next_launch).toMatchObject({
      status: "launched",
      created: true,
    });
    expect(
      (await service.listShapingArtifacts(sourceId, workItemId))
        .post_commit_launch_failure,
    ).toBeNull();
    expect(await readFile(intentPath, "utf8")).toBe(intentSource);
    expect(await readFile(manifestPath, "utf8")).toBe(manifestSource);

    fake.setAvailableModels(["new-model"]);
    const replayInput = {
      ...retryInput,
      expected_shaping_state_sha256: (
        await service.listShapingArtifacts(sourceId, workItemId)
      ).expected_shaping_state_sha256,
    };
    const replayed = await service.retryShapingLaunch(
      sourceId,
      workItemId,
      "brainstorm",
      replayInput,
    );
    expect(replayed.next_launch).toEqual({
      status: "launched",
      shaping_run_id: launched.next_launch.shaping_run_id,
      reason: null,
      created: false,
    });

    const second = await repository.create({
      title: "Use a new attempt when the locked model disappeared",
      type: "Feature",
    });
    fake.setAvailableModels(["locked-model", "new-model"]);
    fake.setPrepareFailure(new Error("simulated second prepare failure"));
    const failed = await service.startBrainstorm(
      sourceId,
      second.goal.work_item_id,
      {
        launch_mode: "connected",
        next_requested_model: "locked-model",
        expected_mission_content_sha256: null,
        expected_result_content_sha256: null,
        expected_shaping_state_sha256: ideaShapingStateSha256(second),
      },
    );
    fake.setPrepareFailure(null);
    fake.setAvailableModels(["new-model"]);
    const secondListing = await service.listShapingArtifacts(
      sourceId,
      second.goal.work_item_id,
    );
    expect(secondListing.post_commit_launch_failure).toMatchObject({
      decision_id: failed.decision_id,
      locked_model: "locked-model",
    });
    const secondRetryInput = {
      decision_id: failed.decision_id,
      expected_shaping_state_sha256:
        secondListing.expected_shaping_state_sha256,
    };
    await expect(
      service.retryShapingLaunch(
        sourceId,
        second.goal.work_item_id,
        "brainstorm",
        secondRetryInput,
      ),
    ).rejects.toMatchObject({
      kind: "mission_not_ready",
      message: expect.stringContaining("locked-model"),
    });
    const secondDecisionDirectory = join(
      root,
      ".founder",
      "work-items",
      second.goal.work_item_id,
      "shaping-decisions",
    );
    const secondIntentPath = join(
      secondDecisionDirectory,
      failed.decision_id + ".intent.json",
    );
    const secondManifestPath = join(
      secondDecisionDirectory,
      failed.decision_id + ".json",
    );
    const secondIntentBefore = await readFile(secondIntentPath, "utf8");
    const secondManifestBefore = await readFile(secondManifestPath, "utf8");
    const newAttempt = await service.launchShapingRun(
      sourceId,
      second.goal.work_item_id,
      "brainstorm",
      { requested_model: "new-model" },
    );
    expect(newAttempt.next_launch).toMatchObject({
      status: "launched",
      created: true,
    });
    expect(await readFile(secondIntentPath, "utf8")).toBe(secondIntentBefore);
    expect(await readFile(secondManifestPath, "utf8")).toBe(
      secondManifestBefore,
    );
    const newAttemptListing = await service.listShapingArtifacts(
      sourceId,
      second.goal.work_item_id,
    );
    expect(newAttemptListing.post_commit_launch_failure).toBeNull();
    const secondAttemptRetryInput = {
      ...secondRetryInput,
      expected_shaping_state_sha256:
        newAttemptListing.expected_shaping_state_sha256,
    };
    await expect(
      service.retryShapingLaunch(
        sourceId,
        second.goal.work_item_id,
        "brainstorm",
        secondAttemptRetryInput,
      ),
    ).rejects.toMatchObject({ kind: "lease_held" });
  });

  it("returns sanitized manual-import rejection evidence and records unknown model provenance on apply", async () => {
    const root = await createWorkspace("Manual Import Validation Workspace");
    const repository = new ProductWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Validate manual shaping ingress",
      type: "Feature",
    });
    const fake = preparedShapingRuntime();
    const { service } = await createService(
      new SQLitePortfolioIndex(":memory:"),
      undefined,
      undefined,
      fake.runtime,
    );
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    const workItemId = created.goal.work_item_id;
    await service.startBrainstorm(sourceId, workItemId, {
      launch_mode: "manual",
      next_requested_model: null,
      expected_mission_content_sha256: null,
      expected_result_content_sha256: null,
      expected_shaping_state_sha256: ideaShapingStateSha256(created),
    });
    const listing = await service.listShapingArtifacts(sourceId, workItemId);
    const artifact = currentPhaseArtifact(listing.artifacts, "brainstorm");
    const binding = {
      expected_mission_content_sha256: artifact.mission.content_sha256,
      expected_shaping_state_sha256:
        listing.expected_shaping_state_sha256,
    };
    const manual = await service.openManualIngress(
      sourceId,
      workItemId,
      "brainstorm",
      binding,
    );
    expect(manual.task).toContain(manual.instruction.ingress_path);
    expect(manual.task).toContain(artifact.mission.content_sha256);
    await writeFile(
      join(root, manual.instruction.ingress_path),
      "{invalid raw founder content",
      "utf8",
    );
    const rejected = await service.importBrainstormResult(
      sourceId,
      workItemId,
      binding,
    );
    expect(rejected).toEqual({
      source_id: sourceId,
      work_item_id: workItemId,
      outcome: "rejected",
      rejection: {
        raw_result_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        byte_length: 28,
        reasons: [{ code: "invalid_json", field_path: "$" }],
      },
    });
    expect(JSON.stringify(rejected)).not.toContain("raw founder content");
    const missionDirectory = dirname(join(root, artifact.mission_path));
    expect(await readdir(missionDirectory)).toEqual([
      "TASK.md",
      "mission.json",
    ]);

    const validResult = shapingResultForMission(artifact.mission);
    await writeFile(
      join(root, manual.instruction.ingress_path),
      JSON.stringify(validResult, null, 2) + "\n",
      "utf8",
    );
    const applied = await service.importBrainstormResult(
      sourceId,
      workItemId,
      binding,
    );
    expect(applied).toMatchObject({
      outcome: "applied",
      receipt: { outcome: "applied" },
    });
    const appliedArtifact = currentPhaseArtifact(
      (await service.listShapingArtifacts(sourceId, workItemId)).artifacts,
      "brainstorm",
    );
    expect(appliedArtifact.production_receipt).toMatchObject({
      origin: "manual_import",
      shaping_run_id: null,
      requested_model: { value: null, assurance: "unknown" },
      effective_model: {
        assurance: "unknown",
        model_id: null,
        deployment_id: null,
        observed_event_sha256: null,
      },
    });
    await expect(
      readdir(join(missionDirectory, "rejected-imports")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects every dedicated or closed shaping arrow through generic phase update and leaves post-Execute movement generic", async () => {
    const root = await createWorkspace("Closed Shaping Transition Workspace");
    const repository = new ProductWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const idea = await repository.create({
      title: "Idea arrows",
      type: "Feature",
    });
    const brainstorm = await repository.create({
      title: "Brainstorm arrows",
      type: "Feature",
    });
    await repository.updatePhase(brainstorm.goal.work_item_id, {
      target_phase: "brainstorm",
    });
    const spec = await repository.create({
      title: "Spec arrows",
      type: "Feature",
    });
    await repository.updatePhase(spec.goal.work_item_id, {
      target_phase: "spec",
    });
    const plan = await repository.create({
      title: "Plan arrows",
      type: "Feature",
    });
    await repository.updatePhase(plan.goal.work_item_id, {
      target_phase: "spec",
    });
    await repository.updatePhase(plan.goal.work_item_id, {
      target_phase: "plan",
    });
    const execute = await repository.create({
      title: "Post Execute arrows",
      type: "Feature",
    });
    await repository.updatePhase(execute.goal.work_item_id, {
      target_phase: "spec",
    });
    await repository.updatePhase(execute.goal.work_item_id, {
      target_phase: "plan",
    });
    await repository.updatePhase(execute.goal.work_item_id, {
      target_phase: "execute",
    });

    const { service } = await createService();
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    const cases = [
      [idea.goal.work_item_id, "brainstorm", "Start Brainstorm"],
      [idea.goal.work_item_id, "spec", "Spec requires a Brainstorm selection"],
      [
        brainstorm.goal.work_item_id,
        "spec",
        "Use result & run Spec",
      ],
      [spec.goal.work_item_id, "brainstorm", "Request changes"],
      [spec.goal.work_item_id, "plan", "Approve & run Plan"],
      [plan.goal.work_item_id, "spec", "Request changes"],
      [plan.goal.work_item_id, "execute", "Approve & run Execute"],
    ] as const;
    for (const [workItemId, targetPhase, message] of cases) {
      await expect(
        service.updateWorkItemPhase(sourceId, workItemId, {
          target_phase: targetPhase,
        }),
      ).rejects.toMatchObject({
        kind: "invalid_transition",
        message: expect.stringContaining(message),
      });
    }
    await expect(
      service.updateWorkItemPhase(sourceId, execute.goal.work_item_id, {
        target_phase: "review",
      }),
    ).resolves.toMatchObject({
      work_item: { state: { phase: "review" } },
    });
    await expect(
      readFile(
        join(
          process.cwd(),
          "app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/brainstorm/accept/route.ts",
        ),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });


  it("tracks connected model use while launching one run, importing its result, and never spawning a duplicate", async () => {
    const root = await createWorkspace("Connected Execute Workspace");
    const repository = new ProductWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Run a connected execute mission",
      type: "Feature",
    });
    await governWorkItemThrough(repository, created, ["spec", "plan", "execute"]);
    const result = deferred<AcpRunResult>();
    const session: AcpSession = {
      session_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1",
      protocol_version: 1,
      requested_mcp_server_count: 0,
      config_options: [],
      wall_clock_timeout_ms: 2_000,
      process: {
        pid: 4001,
        process_group_id: 4001,
        started_at: "2026-07-26T18:00:00.000Z",
      },
      run: vi.fn(() => result.promise),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const fake = preparedRuntime(session);
    const indexPath = join(
      await createRoot("product-studio-connected-index-"),
      "index.sqlite",
    );
    const index = new SQLitePortfolioIndex(indexPath);
    const { inboxRoot, registry, service } = await createService(
      index,
      () => repository,
      fake.runtime,
    );
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    const mission = await service.compileMission(sourceId, created.goal.work_item_id);
    await writeFile(
      join(dirname(mission.task_path), "result.json"),
      serializeExternalResult({
        result_schema_version: 2,
        mission_content_sha256: mission.mission.content_sha256,
        identity: mission.mission.identity,
        commit: "a".repeat(40),
        summary: "Completed through the connected ACP run.",
        changed_files: ["src/application/portfolio.ts"],
        verification: [{ name: "Tests", status: "passed" }],
      }),
      "utf8",
    );

    const first = await service.launchConnectedExecute(
      sourceId,
      created.goal.work_item_id,
    );
    const replay = await service.launchConnectedExecute(
      sourceId,
      created.goal.work_item_id,
    );
    expect(replay.connected_run.connected_run_id).toBe(
      first.connected_run.connected_run_id,
    );
    expect(fake.prepare).toHaveBeenCalledOnce();
    expect(session.run).toHaveBeenCalledOnce();
    expect(session.run).toHaveBeenCalledWith(
      expect.stringContaining(
        "You must invoke the `bash` tool with the exact first required command",
      ),
    );
    await expect(
      service.listShapingArtifacts(sourceId, created.goal.work_item_id),
    ).resolves.toMatchObject({
      model_use: [
        {
          seat: "execute",
          production_id: first.connected_run.connected_run_id,
          shaping_run_id: null,
          requested_model: "copilot-default",
          effective_model: null,
        },
      ],
    });
    expect((await service.listConnectedRuns(sourceId, created.goal.work_item_id))[0])
      .toMatchObject({ lifecycle: { status: "running" } });
    expect(index.listConnectedRunSummaries()).toEqual([
      {
        source_id: sourceId,
        work_item_id: created.goal.work_item_id,
        connected_run: first.connected_run,
      },
    ]);

    result.resolve({
      outcome: "completed",
      partial: false,
      stop_reason: "end_turn",
      permissions: [],
    });
    await expect.poll(async () => {
      const item = (await service.list()).find(
        (candidate) =>
          candidate.source_id === sourceId &&
          candidate.work_item.goal.work_item_id === created.goal.work_item_id,
      );
      return item?.work_item.state.phase;
    }).toBe("review");
    await expect.poll(async () => {
      const [run] = await service.listConnectedRuns(
        sourceId,
        created.goal.work_item_id,
      );
      return run?.lifecycle.terminal_outcome;
    }).toBe("completed");
    await service.rebuild();
    const summariesBeforeCacheDeletion = index.listConnectedRunSummaries();
    index.close();

    await unlink(indexPath);
    const rebuiltIndex = new SQLitePortfolioIndex(indexPath);
    const restartedService = new PortfolioService(
      registry,
      rebuiltIndex,
      inboxRoot,
      () => repository,
      fake.runtime,
    );
    await restartedService.rebuild();
    expect(rebuiltIndex.listConnectedRunSummaries()).toEqual(
      summariesBeforeCacheDeletion,
    );
    rebuiltIndex.close();
  });

  it("reuses the immutable Execute mission when preparing commands after launch", async () => {
    const root = await createWorkspace("Connected Command Preflight Workspace");
    const repository = new ProductWorkspace(root, {
      git: {
        ...controllerGit,
        async listWorktreeChangedFilesExcludingFounder() {
          return ["src/application/portfolio.ts"];
        },
      },
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Prepare exact connected commands",
      type: "Feature",
    });
    await governWorkItemThrough(repository, created, ["spec", "plan", "execute"]);
    const result = deferred<AcpRunResult>();
    const session: AcpSession = {
      session_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b4",
      protocol_version: 1,
      requested_mcp_server_count: 0,
      config_options: [],
      wall_clock_timeout_ms: 2_000,
      process: {
        pid: 4004,
        process_group_id: 4004,
        started_at: "2026-08-06T18:00:00.000Z",
      },
      run: vi.fn(() => result.promise),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const fake = preparedRuntime(session);
    const index = new SQLitePortfolioIndex(":memory:");
    const { service } = await createService(
      index,
      () => repository,
      fake.runtime,
    );
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    const mission = await service.compileMission(
      sourceId,
      created.goal.work_item_id,
    );
    const launched = await service.launchConnectedExecute(
      sourceId,
      created.goal.work_item_id,
    );

    result.resolve({
      outcome: "completed",
      partial: false,
      stop_reason: "end_turn",
      permissions: [],
    });
    await expect.poll(async () => {
      const run = await repository.readConnectedRun(
        created.goal.work_item_id,
        launched.connected_run.connected_run_id,
      );
      return run?.lifecycle.terminal?.outcome;
    }).toBe("completed");
    await expect.poll(() => session.close).toHaveBeenCalledOnce();

    const appliedManifestLookup = vi.spyOn(
      repository,
      "findAppliedExecuteManifest",
    );
    const prepared = await service.prepareCommandAuthorization(
      sourceId,
      created.goal.work_item_id,
      "execute",
    );

    expect(appliedManifestLookup).not.toHaveBeenCalled();
    expect(prepared.proposal).toMatchObject({
      phase: "execute",
      source_mission_content_sha256: mission.mission.content_sha256,
      terminal_connected_run_id: launched.connected_run.connected_run_id,
      changed_files: ["src/application/portfolio.ts"],
      commands: [
        { executable: "npm", args: ["test"] },
        {
          executable: "git",
          args: ["add", "--", "src/application/portfolio.ts"],
        },
        {
          executable: "git",
          args: ["commit", "-m", "Prepare exact connected commands"],
        },
      ],
    });
    expect(prepared.work_item.state.attention).toMatchObject({
      kind: "command_authorization",
      proposal: { proposal_sha256: prepared.proposal.proposal_sha256 },
    });
    index.close();
  });

  it("reuses the immutable Execute mission when repository HEAD advances before a retry", async () => {
    const firstCommit = "a".repeat(40);
    let headCommit = firstCommit;
    const root = await createWorkspace("Connected Execute Retry Workspace");
    const repository = new ProductWorkspace(root, {
      git: {
        ...controllerGit,
        async readHeadCommit() {
          return headCommit;
        },
      },
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Retry one immutable Execute mission",
      type: "Feature",
    });
    await governWorkItemThrough(repository, created, ["spec", "plan", "execute"]);
    const retryResult = deferred<AcpRunResult>();
    const run = vi
      .fn<() => Promise<AcpRunResult>>()
      .mockResolvedValueOnce({
        outcome: "failed",
        partial: true,
        stop_reason: null,
        permissions: [],
      })
      .mockImplementationOnce(() => retryResult.promise);
    const session: AcpSession = {
      session_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7d1",
      protocol_version: 1,
      requested_mcp_server_count: 0,
      config_options: [],
      wall_clock_timeout_ms: 2_000,
      process: {
        pid: 4201,
        process_group_id: 4201,
        started_at: "2026-08-06T05:00:00.000Z",
      },
      run,
      cancel: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const fake = preparedRuntime(session);
    const { index, service } = await createService(
      new SQLitePortfolioIndex(":memory:"),
      () => repository,
      fake.runtime,
    );
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    const workItemId = created.goal.work_item_id;

    const first = await service.launchConnectedExecute(sourceId, workItemId);
    await expect.poll(async () => {
      const [stored] = await repository.listConnectedRuns(workItemId);
      return stored?.lifecycle.terminal?.outcome;
    }).toBe("failed");
    headCommit = "b".repeat(40);

    const retry = await service.launchConnectedExecute(sourceId, workItemId);
    expect(retry.connected_run).toMatchObject({
      lifecycle: { status: "running" },
      mission: {
        content_sha256: first.connected_run.mission.content_sha256,
        source_commit: firstCommit,
      },
    });
    expect(retry.connected_run.connected_run_id).not.toBe(
      first.connected_run.connected_run_id,
    );
    expect(fake.prepare).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(
      (await repository.listConnectedRuns(workItemId)).find(
        (record) =>
          record.connected_run_id === retry.connected_run.connected_run_id,
      )?.limits,
    ).toMatchObject({ max_output_bytes: 1_000_000 });

    retryResult.resolve({
      outcome: "cancelled",
      partial: true,
      stop_reason: "cancelled",
      permissions: [],
    });
    await expect.poll(async () => {
      const stored = await repository.listConnectedRuns(workItemId);
      return stored.find(
        (record) =>
          record.connected_run_id === retry.connected_run.connected_run_id,
      )?.lifecycle.terminal?.outcome;
    }).toBe("cancelled");
    index.close();
  });

  it("launches connected review read-only, terminals before import, and replays without duplicate spawn", async () => {
    const root = await createWorkspace("Connected Review Workspace");
    const repository = new ProductWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Run an independent connected review",
      type: "Feature",
    });
    await governWorkItemThrough(repository, created, ["spec", "plan", "execute"]);
    const result = deferred<AcpRunResult>();
    const session: AcpSession = {
      session_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7c1",
      protocol_version: 1,
      requested_mcp_server_count: 0,
      config_options: [],
      wall_clock_timeout_ms: 2_000,
      process: {
        pid: 4101,
        process_group_id: 4101,
        started_at: "2026-08-05T18:00:00.000Z",
      },
      run: vi.fn(() => result.promise),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const fake = preparedReviewRuntime(session);
    const order: string[] = [];
    let connectedRunId: string | null = null;
    const completeConnectedRun =
      repository.completeConnectedRun.bind(repository);
    repository.completeConnectedRun = async (...args) => {
      const completed = await completeConnectedRun(...args);
      if (completed.lifecycle.terminal?.outcome === "completed") {
        order.push("terminal");
      }
      return completed;
    };
    const writeImportEvidence = repository.writeImportEvidence.bind(repository);
    repository.writeImportEvidence = async (input) => {
      if (input.evidence.phase === "review") {
        if (connectedRunId === null) {
          throw new Error("Review import requires a connected run id.");
        }
        const run = await repository.readConnectedRun(
          created.goal.work_item_id,
          connectedRunId,
        );
        expect(run?.lifecycle).toMatchObject({
          status: "terminal",
          terminal: { outcome: "completed" },
        });
        order.push("import");
      }
      return writeImportEvidence(input);
    };
    const { inboxRoot, index, service } = await createService(
      new SQLitePortfolioIndex(":memory:"),
      () => repository,
      undefined,
      undefined,
      fake.runtime,
    );
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;

    await expect(
      service.launchConnectedReview(sourceId, created.goal.work_item_id, {
        independence_attested: true,
      }),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });
    const executeMission = await service.compileMission(
      sourceId,
      created.goal.work_item_id,
    );
    await writeFile(
      join(dirname(executeMission.task_path), "result.json"),
      serializeExternalResult({
        result_schema_version: 2,
        mission_content_sha256: executeMission.mission.content_sha256,
        identity: executeMission.mission.identity,
        commit: "a".repeat(40),
        summary: "Implemented the connected Review boundary.",
        changed_files: ["src/application/portfolio.ts"],
        verification: [{ name: "Tests", status: "passed" }],
      }),
      "utf8",
    );
    await service.importResult(sourceId, created.goal.work_item_id);
    await expect(
      service.launchConnectedReview(sourceId, created.goal.work_item_id, {
        independence_attested: false,
      } as never),
    ).rejects.toMatchObject({ name: "ZodError" });

    const reviewMission = await service.compileReviewMission(
      sourceId,
      created.goal.work_item_id,
      { independence_attested: true },
    );
    const launched = await service.launchConnectedReview(
      sourceId,
      created.goal.work_item_id,
      {
        independence_attested: true,
        model_override: "review-model",
      },
    );
    connectedRunId = launched.connected_run.connected_run_id;
    await expect(
      service.cancelConnectedRun(
        sourceId,
        created.goal.work_item_id,
        connectedRunId,
      ),
    ).rejects.toMatchObject({
      kind: "stale_expectation",
      message: expect.stringContaining(
        "cannot target a durable review run",
      ),
    });
    expect(session.cancel).not.toHaveBeenCalled();
    await expect(
      service.listConnectedRunsForPhase(
        sourceId,
        created.goal.work_item_id,
        "execute",
      ),
    ).resolves.toEqual([]);
    await expect(
      service.listConnectedRunsForPhase(
        sourceId,
        created.goal.work_item_id,
        "review",
      ),
    ).resolves.toHaveLength(1);
    const replay = await service.launchConnectedReview(
      sourceId,
      created.goal.work_item_id,
      {
        independence_attested: true,
        model_override: "review-model",
      },
    );
    expect(replay.connected_run.connected_run_id).toBe(connectedRunId);
    expect(fake.prepare).toHaveBeenCalledOnce();
    expect(fake.start).toHaveBeenCalledOnce();
    expect(session.run).toHaveBeenCalledOnce();
    expect(session.run).toHaveBeenCalledWith(
      expect.not.stringContaining("You must invoke the `bash` tool"),
    );
    expect(launched.connected_run).toMatchObject({
      mission: { identity: { phase: "review" } },
      authorization: { kind: "review_result_ingress" },
      provenance: {
        role: { value: "reviewer" },
        seat: { value: "reviewer" },
      },
      lifecycle: { status: "running" },
    });
    expect(fake.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        requested_model: "review-model",
        result_ingress_policy: expect.objectContaining({
          kind: "single_result_file",
          result_path: reviewMission.mission.result_contract.output_path,
        }),
      }),
    );
    if (reviewMission.mission.review_subject.source !== "execute") {
      throw new Error("Initial connected Review must bind Execute evidence.");
    }
    await fake.write(
      join(root, reviewMission.mission.result_contract.output_path),
      serializeExternalResult({
        result_schema_version: 2,
        review_mission_content_sha256:
          reviewMission.mission.content_sha256,
        identity: reviewMission.mission.identity,
        execute_mission_content_sha256:
          reviewMission.mission.review_subject
            .execute_mission_content_sha256,
        execute_result_content_sha256:
          reviewMission.mission.review_subject
            .execute_result_content_sha256,
        git_base_commit:
          reviewMission.mission.review_subject.git_base_commit,
        accepted_result_commit:
          reviewMission.mission.review_subject.accepted_result_commit,
        summary: "Independent review found no blocking issue.",
        verdict: "clean",
        findings: [],
      }),
    );
    result.resolve({
      outcome: "completed",
      partial: false,
      stop_reason: "end_turn",
      permissions: [],
    });
    await expect.poll(async () => {
      const item = (await service.list()).find(
        (candidate) =>
          candidate.source_id === sourceId &&
          candidate.work_item.goal.work_item_id ===
            created.goal.work_item_id,
      );
      return item?.work_item.state.attention?.kind;
    }).toBe("review_ready");
    await expect.poll(async () => {
      const runs = await service.listConnectedRuns(
        sourceId,
        created.goal.work_item_id,
      );
      return runs[0]?.lifecycle.terminal_outcome;
    }).toBe("completed");
    expect(order).toEqual(["terminal", "import"]);
    const preferences = new PortfolioPreferencesStore(
      dirname(dirname(inboxRoot)),
    );
    await expect(
      preferences.getPreference("copilot-acp", "review"),
    ).resolves.toBe("review-model");
    index.close();
  });

  it("fails a completed connected Review that did not publish its required result", async () => {
    const root = await createWorkspace("Missing Connected Review Result Workspace");
    const repository = new ProductWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Reject a Review completion without result ingress",
      type: "Feature",
    });
    await governWorkItemThrough(repository, created, ["spec", "plan", "execute"]);
    const session: AcpSession = {
      session_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7cf",
      protocol_version: 1,
      requested_mcp_server_count: 0,
      config_options: [],
      wall_clock_timeout_ms: 2_000,
      process: {
        pid: 4199,
        process_group_id: 4199,
        started_at: "2026-08-05T18:00:00.000Z",
      },
      run: vi.fn(async () => ({
        outcome: "completed" as const,
        partial: false,
        stop_reason: "end_turn" as const,
        permissions: [],
      })),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const fake = preparedReviewRuntime(session);
    const { index, service } = await createService(
      new SQLitePortfolioIndex(":memory:"),
      () => repository,
      undefined,
      undefined,
      fake.runtime,
    );
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    const reviewMission = await prepareConnectedReviewItem(
      service,
      sourceId,
      created,
    );

    await service.launchConnectedReview(sourceId, created.goal.work_item_id, {
      independence_attested: true,
      model_override: "review-model",
    });

    await expect.poll(async () => {
      const runs = await service.listConnectedRuns(
        sourceId,
        created.goal.work_item_id,
      );
      return runs[0]?.lifecycle.terminal_outcome;
    }).toBe("failed");
    const current = await repository.read(created.goal.work_item_id);
    expect(current).toMatchObject({
      state: { phase: "review", status: "active" },
    });
    expect(current?.state.attention).toBeUndefined();
    await expect(
      readFile(join(dirname(reviewMission.task_path), "result.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    index.close();
  });

  it("rejects connected review when the governed tuple changes during runtime preparation", async () => {
    const root = await createWorkspace("Stale Connected Review Workspace");
    const repository = new ProductWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Reject a stale connected Review launch",
      type: "Feature",
    });
    await governWorkItemThrough(repository, created, ["spec", "plan", "execute"]);
    const session: AcpSession = {
      session_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7c2",
      protocol_version: 1,
      requested_mcp_server_count: 0,
      config_options: [],
      wall_clock_timeout_ms: 2_000,
      process: {
        pid: 4102,
        process_group_id: 4102,
        started_at: "2026-08-05T18:00:00.000Z",
      },
      run: vi.fn(),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const fake = preparedReviewRuntime(session);
    const prepare = fake.runtime.prepare.bind(fake.runtime);
    const staleRuntime: ConnectedReviewRuntime = {
      configuration: fake.runtime.configuration,
      prepare: vi.fn(async (input) => {
        const current = await repository.read(created.goal.work_item_id);
        if (current === null) {
          throw new Error("Stale Review fixture requires its work item.");
        }
        const activeRun = {
          run_id: "84000000-0000-4000-8000-000000000001",
          idempotency_key: "stale-review-runtime-preparation",
          acquired_at: "2026-08-05T18:00:00.000Z",
        };
        const lease = await repository.acquireControllerLease(
          created.goal.work_item_id,
          activeRun,
        );
        if (lease === null) {
          throw new Error("Stale Review fixture requires a controller lease.");
        }
        try {
          await repository.commitControllerMutation(lease, {
            goal: lease.work_item.goal,
            state: {
              ...lease.work_item.state,
              input_revision: lease.work_item.state.input_revision! + 1,
              updated_at: "2026-08-05T18:00:01.000Z",
            },
            manifest: {
              schema_version: 1,
              run_id: activeRun.run_id,
              work_item_id: created.goal.work_item_id,
              idempotency_key: activeRun.idempotency_key,
              phase: "review",
              goal_version: lease.work_item.state.goal_version!,
              input_revision: lease.work_item.state.input_revision! + 1,
              attempt: lease.work_item.state.attempt!,
              started_at: activeRun.acquired_at,
              outcome: "pending",
            },
          });
        } finally {
          await repository.releaseControllerLease(lease);
        }
        return prepare(input);
      }),
    };
    const { index, service } = await createService(
      new SQLitePortfolioIndex(":memory:"),
      () => repository,
      undefined,
      undefined,
      staleRuntime,
    );
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    await prepareConnectedReviewItem(service, sourceId, created);

    await expect(
      service.launchConnectedReview(sourceId, created.goal.work_item_id, {
        independence_attested: true,
      }),
    ).rejects.toMatchObject({ kind: "stale_expectation" });
    expect(fake.start).not.toHaveBeenCalled();
    await expect(
      repository.listConnectedRuns(created.goal.work_item_id),
    ).resolves.toEqual([]);
    index.close();
  });

  it("keeps connected review retry truthful after adapter start failure without duplicate spawn", async () => {
    const root = await createWorkspace("Retry Connected Review Workspace");
    const repository = new ProductWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Retry a connected Review launch",
      type: "Feature",
    });
    await governWorkItemThrough(repository, created, ["spec", "plan", "execute"]);
    const pending = deferred<AcpRunResult>();
    const session: AcpSession = {
      session_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7c3",
      protocol_version: 1,
      requested_mcp_server_count: 0,
      config_options: [],
      wall_clock_timeout_ms: 2_000,
      process: {
        pid: 4103,
        process_group_id: 4103,
        started_at: "2026-08-05T18:00:00.000Z",
      },
      run: vi.fn(() => pending.promise),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const fake = preparedReviewRuntime(session, "review-model", 1);
    const { index, service } = await createService(
      new SQLitePortfolioIndex(":memory:"),
      () => repository,
      undefined,
      undefined,
      fake.runtime,
    );
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    await prepareConnectedReviewItem(service, sourceId, created);

    await expect(
      service.launchConnectedReview(sourceId, created.goal.work_item_id, {
        independence_attested: true,
      }),
    ).rejects.toThrow("Review adapter unavailable after durable launch");
    expect((await repository.read(created.goal.work_item_id))?.state).toMatchObject({
      phase: "review",
      status: "active",
    });
    expect(await service.listConnectedRuns(sourceId, created.goal.work_item_id))
      .toEqual([
        expect.objectContaining({
          lifecycle: expect.objectContaining({
            status: "terminal",
            terminal_outcome: "failed",
          }),
        }),
      ]);

    const retry = await service.launchConnectedReview(
      sourceId,
      created.goal.work_item_id,
      { independence_attested: true },
    );
    const replay = await service.launchConnectedReview(
      sourceId,
      created.goal.work_item_id,
      { independence_attested: true },
    );
    expect(retry.connected_run.lifecycle.status).toBe("running");
    expect(replay.connected_run.connected_run_id).toBe(
      retry.connected_run.connected_run_id,
    );
    expect(fake.start).toHaveBeenCalledTimes(2);
    expect(session.run).toHaveBeenCalledOnce();
    const runs = await service.listConnectedRuns(
      sourceId,
      created.goal.work_item_id,
    );
    expect(runs).toHaveLength(2);
    expect(runs.filter((run) => run.lifecycle.status !== "terminal")).toHaveLength(
      1,
    );
    index.close();
  });

  it("launches connected patch with mission-bound narrowing and terminals before import", async () => {
    const root = await createWorkspace("Connected Patch Workspace");
    const repository = new ProductWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Run a connected Patch mission",
      type: "Feature",
    });
    await governWorkItemThrough(repository, created, ["spec", "plan", "execute"]);
    const result = deferred<AcpRunResult>();
    const session: AcpSession = {
      session_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7d1",
      protocol_version: 1,
      requested_mcp_server_count: 0,
      config_options: [],
      wall_clock_timeout_ms: 2_000,
      process: {
        pid: 4201,
        process_group_id: 4201,
        started_at: "2026-08-05T19:00:00.000Z",
      },
      run: vi.fn(() => result.promise),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const fake = preparedRuntime(session, "patch-model");
    const { inboxRoot, index, service } = await createService(
      new SQLitePortfolioIndex(":memory:"),
      () => repository,
      fake.runtime,
    );
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    const reviewMission = await prepareConnectedPatchReview(
      service,
      sourceId,
      created,
    );

    const executionDefaults = {
      schema_version: 1 as const,
      approved_command_forms: [
        { executable: "npm", args: ["run", "test"] },
      ],
      approved_url_operations: [],
      mcp: "forbidden" as const,
      credentials: "forbidden" as const,
    };
    const executionDirectory = join(root, ".founder", "execution");
    await mkdir(executionDirectory, { recursive: true });
    await writeFile(
      join(executionDirectory, "defaults.json"),
      `${JSON.stringify(executionDefaults, null, 2)}\n`,
      "utf8",
    );

    const accepted = await service.acceptPatchPlan(
      sourceId,
      created.goal.work_item_id,
    );
    const patchManifestPath = join(
      root,
      ".founder",
      "work-items",
      created.goal.work_item_id,
      "runs",
      `${accepted.controller_run.run_id}.json`,
    );
    const patchManifestSource = await readFile(patchManifestPath, "utf8");
    await unlink(patchManifestPath);
    await expect(
      service.launchConnectedPatch(sourceId, created.goal.work_item_id),
    ).rejects.toThrow("No applied patch-plan manifest");
    await writeFile(patchManifestPath, patchManifestSource, "utf8");
    await writeFile(
      patchManifestPath,
      `${JSON.stringify(
        {
          ...accepted.controller_run,
          idempotency_key: `${accepted.controller_run.idempotency_key.slice(0, -64)}${"f".repeat(64)}`,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await expect(
      service.launchConnectedPatch(sourceId, created.goal.work_item_id),
    ).rejects.toThrow("governed cycle and review result");
    await writeFile(patchManifestPath, patchManifestSource, "utf8");
    const reviewResultPath = join(dirname(reviewMission.task_path), "result.json");
    const reviewResultSource = await readFile(reviewResultPath, "utf8");
    const changedReviewResult = JSON.parse(reviewResultSource) as {
      findings: Array<{ required_action: string }>;
    };
    changedReviewResult.findings[0]!.required_action =
      "A different finding lineage must not launch.";
    await writeFile(
      reviewResultPath,
      `${JSON.stringify(changedReviewResult, null, 2)}\n`,
      "utf8",
    );
    await expect(
      service.launchConnectedPatch(sourceId, created.goal.work_item_id),
    ).rejects.toThrow("Applied review mission, result, and evidence do not match");
    await writeFile(reviewResultPath, reviewResultSource, "utf8");

    const current = await repository.read(created.goal.work_item_id);
    if (current?.goal.goal_contract === undefined) {
      throw new Error("Connected Patch requires a governed goal contract.");
    }
    const widenedEnvelope = resolveCapabilityEnvelope(
      current.goal.goal_contract.allowed_scope,
      {
        ...executionDefaults,
        approved_command_forms: [
          ...executionDefaults.approved_command_forms,
          { executable: "git", args: ["status"] },
        ],
      },
    );
    await expect(
      service.launchConnectedPatch(sourceId, created.goal.work_item_id, {
        narrowed_capability_envelope: widenedEnvelope,
      }),
    ).rejects.toThrow("may only narrow the compiled mission envelope");
    expect(fake.prepare).not.toHaveBeenCalled();

    const narrowedEnvelope = resolveCapabilityEnvelope(
      current.goal.goal_contract.allowed_scope,
      {
        ...executionDefaults,
        approved_command_forms: [],
      },
    );
    const patchMission = await service.compilePatchMission(
      sourceId,
      created.goal.work_item_id,
    );
    const order: string[] = [];
    const completeConnectedRun =
      repository.completeConnectedRun.bind(repository);
    repository.completeConnectedRun = async (...args) => {
      const completed = await completeConnectedRun(...args);
      if (completed.lifecycle.terminal?.outcome === "completed") {
        order.push("terminal");
      }
      return completed;
    };
    const writeImportEvidence = repository.writeImportEvidence.bind(repository);
    repository.writeImportEvidence = async (input) => {
      if (input.evidence.phase === "patch") {
        const runs = await repository.listConnectedRuns(
          created.goal.work_item_id,
        );
        expect(runs.at(-1)?.lifecycle).toMatchObject({
          status: "terminal",
          terminal: { outcome: "completed" },
        });
        order.push("import");
      }
      return writeImportEvidence(input);
    };
    await writeFile(
      join(dirname(patchMission.task_path), "result.json"),
      serializeExternalResult({
        result_schema_version: 2,
        patch_mission_content_sha256: patchMission.mission.content_sha256,
        identity: patchMission.mission.identity,
        commit: "a".repeat(40),
        summary: "Applied the connected Patch repair.",
        changed_files: ["src/application/portfolio.ts"],
        verification: [{ name: "Tests", status: "passed" }],
      }),
      "utf8",
    );

    const launched = await service.launchConnectedPatch(
      sourceId,
      created.goal.work_item_id,
      {
        model_override: "patch-model",
        narrowed_capability_envelope: narrowedEnvelope,
      },
    );
    const replay = await service.launchConnectedPatch(
      sourceId,
      created.goal.work_item_id,
      {
        model_override: "patch-model",
        narrowed_capability_envelope: narrowedEnvelope,
      },
    );
    expect(replay.connected_run.connected_run_id).toBe(
      launched.connected_run.connected_run_id,
    );
    expect(fake.prepare).toHaveBeenCalledOnce();
    expect(fake.start).toHaveBeenCalledOnce();
    expect(session.run).toHaveBeenCalledOnce();
    expect(session.run).toHaveBeenCalledWith(
      expect.stringContaining(
        "You must invoke the `bash` tool with the exact first required command",
      ),
    );
    expect(launched.connected_run).toMatchObject({
      mission: { identity: { phase: "patch", patch_cycle: 1 } },
      authorization: { kind: "capability_envelope" },
      provenance: {
        role: { value: "writer" },
        seat: { value: "executor" },
      },
      lifecycle: { status: "running" },
    });
    expect(fake.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ capability_envelope: narrowedEnvelope }),
    );
    await expect(
      service.launchConnectedPatch(sourceId, created.goal.work_item_id, {
        model_override: "patch-model",
        narrowed_capability_envelope: patchMission.mission.capability_envelope,
      }),
    ).rejects.toMatchObject({ kind: "idempotency_conflict" });

    result.resolve({
      outcome: "completed",
      partial: false,
      stop_reason: "end_turn",
      permissions: [],
    });
    await expect.poll(async () => {
      const item = await repository.read(created.goal.work_item_id);
      return item?.state.phase;
    }).toBe("review");
    await expect.poll(async () => {
      const runs = await service.listConnectedRuns(
        sourceId,
        created.goal.work_item_id,
      );
      return runs.at(-1)?.lifecycle.terminal_outcome;
    }).toBe("completed");
    expect(order).toEqual(["terminal", "import"]);
    const preferences = new PortfolioPreferencesStore(
      dirname(dirname(inboxRoot)),
    );
    await expect(
      preferences.getPreference("copilot-acp", "patch"),
    ).resolves.toBe("patch-model");
    index.close();
  });

  it("binds connected patch missing permission to the exact phase and operation", async () => {
    const root = await createWorkspace("Connected Patch Permission Workspace");
    const repository = new ProductWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Recover one connected Patch permission",
      type: "Feature",
    });
    await governWorkItemThrough(repository, created, ["spec", "plan", "execute"]);
    const missingResult = deferred<AcpRunResult>();
    const retryResult = deferred<AcpRunResult>();
    const session: AcpSession = {
      session_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7d2",
      protocol_version: 1,
      requested_mcp_server_count: 0,
      config_options: [],
      wall_clock_timeout_ms: 2_000,
      process: {
        pid: 4202,
        process_group_id: 4202,
        started_at: "2026-08-05T19:00:00.000Z",
      },
      run: vi
        .fn()
        .mockImplementationOnce(() => missingResult.promise)
        .mockImplementationOnce(() => retryResult.promise),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const fake = preparedRuntime(session, "patch-model");
    const { index, service } = await createService(
      new SQLitePortfolioIndex(":memory:"),
      () => repository,
      fake.runtime,
    );
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    await prepareConnectedPatchReview(service, sourceId, created);
    await service.acceptPatchPlan(sourceId, created.goal.work_item_id);

    const launched = await service.launchConnectedPatch(
      sourceId,
      created.goal.work_item_id,
    );
    const deniedOperation = {
      schema_version: 1 as const,
      kind: "command" as const,
      executable: "git",
      args: ["status"],
    };
    const { hashCanonicalCapabilityRequest } = await import(
      "../../src/domain/capability-envelope"
    );
    const operationSha256 =
      hashCanonicalCapabilityRequest(deniedOperation);
    missingResult.resolve({
      outcome: "missing_permission",
      partial: true,
      stop_reason: "end_turn",
      permissions: [
        {
          kind: "missing_permission",
          request: deniedOperation,
          operation_sha256: operationSha256,
          reason: "outside_capability_envelope",
        },
      ],
    });
    await expect.poll(async () => {
      const item = await repository.read(created.goal.work_item_id);
      return item?.state.attention?.kind;
    }).toBe("missing_permission");
    const attention = (await repository.read(created.goal.work_item_id))?.state
      .attention;
    expect(attention).toMatchObject({
      kind: "missing_permission",
      governed_tuple: { patch_cycle: 1 },
      pins: {
        mission_content_sha256: launched.connected_run.mission.content_sha256,
      },
      operation: {
        connected_run_id: launched.connected_run.connected_run_id,
        operation_sha256: operationSha256,
      },
    });
    const decision = await service.decideConnectedPermission(
      sourceId,
      created.goal.work_item_id,
      {
        decision: "allow_once",
        connected_run_id: launched.connected_run.connected_run_id,
        operation_sha256: operationSha256,
      },
    );
    expect(decision.work_item.state).toMatchObject({
      phase: "patch",
      status: "active",
      attempt: 1,
      patch_cycle: 1,
    });
    await expect(service.listAttention()).resolves.toEqual([]);
    const retry = await service.launchConnectedPatch(
      sourceId,
      created.goal.work_item_id,
    );
    expect(retry.connected_run.connected_run_id).not.toBe(
      launched.connected_run.connected_run_id,
    );
    expect(retry.connected_run).toMatchObject({
      mission: {
        identity: { phase: "patch", attempt: 1, patch_cycle: 1 },
      },
      governed_tuple: { attempt: 1, patch_cycle: 1 },
    });
    const retryReplay = await service.launchConnectedPatch(
      sourceId,
      created.goal.work_item_id,
    );
    expect(retryReplay.connected_run.connected_run_id).toBe(
      retry.connected_run.connected_run_id,
    );
    expect(fake.prepare).toHaveBeenCalledTimes(2);
    expect(fake.prepare).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        capability_envelope: expect.objectContaining({
          runtime: expect.objectContaining({
            approved_command_forms: [
              { executable: "git", args: ["status"] },
            ],
          }),
        }),
      }),
    );
    expect(session.run).toHaveBeenCalledTimes(2);
    index.close();
  });

  it("fails writable preparation before spawn when Copilot does not expose bash", async () => {
    const adapter: AcpClientAdapter = { start: vi.fn() };
    const prepareInput = {
      workspace_cwd: "/workspace/product-studio",
      capability_envelope: resolveCapabilityEnvelope(["src"], {
        schema_version: 1,
        approved_command_forms: [],
        approved_url_operations: [],
        mcp: "forbidden" as const,
        credentials: "forbidden" as const,
      }),
      limits: {
        wall_clock_timeout_ms: 2_000,
        max_event_count: 100,
        max_event_bytes: 100_000,
        max_output_bytes: 100_000,
        termination_grace_ms: 100,
        drain_grace_ms: 100,
      },
    };
    const runtime = (availableTools: readonly string[]) =>
      new CopilotConnectedWritableRuntime(adapter, {
        profile: {
          preflight: {
            executable: "/tmp/copilot",
            version: "1.0.78",
            authentication: "noninteractive_authenticated",
            available_model_ids: ["copilot-default"],
          },
          default_model: "copilot-default",
          reasoning_effort: "high",
          available_tools: availableTools,
          excluded_tools: ["ask_user", "mcp"],
          environment: { PATH: "/usr/bin" },
        },
      });

    await expect(
      runtime(["apply_patch", "shell", "view"]).prepare(prepareInput),
    ).rejects.toThrow("Required Copilot tools are unavailable: bash.");

    const prepared = await runtime(["apply_patch", "bash", "view"]).prepare(
      prepareInput,
    );
    expect(prepared.sanitized_profile.available_tools).toEqual([
      "apply_patch",
      "bash",
      "view",
    ]);
    expect(prepared.sanitized_profile.argv).toContain("apply_patch,bash,view");
    expect(adapter.start).not.toHaveBeenCalled();
  });

  it("fails an unavailable model before ACP spawn and surfaces exact missing permission attention", async () => {
    const root = await createWorkspace("Connected Permission Workspace");
    const repository = new ProductWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Require connected permission attention",
      type: "Feature",
    });
    await governWorkItemThrough(repository, created, ["spec", "plan", "execute"]);
    const unavailableAdapter: AcpClientAdapter = { start: vi.fn() };
    const unavailableRuntime = new CopilotConnectedWritableRuntime(
      unavailableAdapter,
      {
        profile: {
          preflight: {
            executable: "/tmp/copilot",
            version: "1.0.0",
            authentication: "noninteractive_authenticated",
            available_model_ids: ["copilot-default"],
          },
          default_model: "copilot-default",
          reasoning_effort: "high",
          available_tools: ["edit"],
          excluded_tools: ["delete"],
          environment: { PATH: "/usr/bin" },
        },
      },
    );
    const unavailable = await createService(
      undefined,
      () => repository,
      unavailableRuntime,
    );
    const registration = await unavailable.service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    expect(unavailable.service.getExecuteModelAvailability()).toEqual({
      status: "available",
      adapter_id: "copilot-acp",
      adapter_version: "1.0.0",
      profile_id: "noninteractive-execute-v1",
      available_model_ids: ["copilot-default"],
      distinct_model_count: 1,
      has_three_distinct_models: false,
      reason: null,
    });
    await expect(
      unavailable.service.launchConnectedExecute(
        sourceId,
        created.goal.work_item_id,
        { model_override: "unavailable-model" },
      ),
    ).rejects.toMatchObject({
      kind: "mission_not_ready",
      reason:
        "Requested Execute model unavailable-model is not in available_model_ids.",
    });
    expect(unavailableAdapter.start).not.toHaveBeenCalled();
    expect(await repository.listConnectedRuns(created.goal.work_item_id)).toEqual([]);
    unavailable.index.close();

    const missingResult = deferred<AcpRunResult>();
    const session: AcpSession = {
      session_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b2",
      protocol_version: 1,
      requested_mcp_server_count: 0,
      config_options: [],
      wall_clock_timeout_ms: 2_000,
      process: {
        pid: 4002,
        process_group_id: 4002,
        started_at: "2026-07-26T18:00:00.000Z",
      },
      run: vi.fn(() => missingResult.promise),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const fake = preparedRuntime(session);
    const connectedIndex = new SQLitePortfolioIndex(":memory:");
    const connectedService = new PortfolioService(
      unavailable.registry,
      connectedIndex,
      unavailable.inboxRoot,
      () => repository,
      fake.runtime,
    );
    await connectedService.rebuild();
    const launched = await connectedService.launchConnectedExecute(
      sourceId,
      created.goal.work_item_id,
    );
    const deniedOperation = {
      schema_version: 1 as const,
      kind: "command" as const,
      executable: "git",
      args: ["status"],
    };
    const { hashCanonicalCapabilityRequest } = await import(
      "../../src/domain/capability-envelope"
    );
    missingResult.resolve({
      outcome: "missing_permission",
      partial: true,
      stop_reason: "end_turn",
      permissions: [
        {
          kind: "missing_permission",
          request: deniedOperation,
          operation_sha256: hashCanonicalCapabilityRequest(deniedOperation),
          reason: "outside_capability_envelope",
        },
      ],
    });
    await expect.poll(async () => {
      const attention = await connectedService.listAttention();
      return attention[0]?.kind === "governed"
        ? attention[0].entry.attention.kind
        : null;
    }).toBe("missing_permission");
    const attention = (await connectedService.listAttention())[0]!;
    expect(attention).toMatchObject({
      kind: "governed",
      entry: {
        item: { source_id: sourceId },
        attention: {
          kind: "missing_permission",
          operation: {
            connected_run_id: launched.connected_run.connected_run_id,
            operation_sha256: hashCanonicalCapabilityRequest(deniedOperation),
          },
        },
      },
    });
    const decision = await connectedService.decideConnectedPermission(
      sourceId,
      created.goal.work_item_id,
      {
        decision: "allow_once",
        connected_run_id: launched.connected_run.connected_run_id,
        operation_sha256: hashCanonicalCapabilityRequest(deniedOperation),
      },
    );
    expect(decision.work_item.state).toMatchObject({
      phase: "execute",
      status: "active",
      attempt: 1,
    });
    const retryMission = await connectedService.compileMission(
      sourceId,
      created.goal.work_item_id,
    );
    expect(
      retryMission.mission.capability_envelope.runtime.approved_command_forms,
    ).toEqual([{ executable: "git", args: ["status"] }]);
    await expect(connectedService.listAttention()).resolves.toEqual([]);
    connectedIndex.close();
  });

  it("reports truthful availability for distinct writable and review runtimes", async () => {
    const unavailable = await createService();
    expect(unavailable.service.getExecuteModelAvailability()).toEqual({
      status: "unavailable",
      adapter_id: null,
      adapter_version: null,
      profile_id: null,
      available_model_ids: [],
      distinct_model_count: 0,
      has_three_distinct_models: false,
      reason: "runtime_unavailable",
    });
    expect(unavailable.service.getReviewModelAvailability()).toEqual({
      status: "unavailable",
      adapter_id: null,
      adapter_version: null,
      profile_id: null,
      available_model_ids: [],
      distinct_model_count: 0,
      has_three_distinct_models: false,
      reason: "runtime_unavailable",
    });
    unavailable.index.close();

    const emptyRuntime: ConnectedWritableRuntime = {
      configuration: () => ({
        adapter_id: "copilot-acp",
        adapter_version: "1.0.0",
        profile_id: "noninteractive-execute-v1",
        available_model_ids: [],
        default_model: "copilot-default",
      }),
      prepare: vi.fn(),
    };
    const empty = await createService(
      new SQLitePortfolioIndex(":memory:"),
      undefined,
      emptyRuntime,
    );
    expect(empty.service.getExecuteModelAvailability()).toEqual({
      status: "unavailable",
      adapter_id: "copilot-acp",
      adapter_version: "1.0.0",
      profile_id: "noninteractive-execute-v1",
      available_model_ids: [],
      distinct_model_count: 0,
      has_three_distinct_models: false,
      reason: "no_models_configured",
    });
    empty.index.close();

    const preparedReview: PreparedConnectedReviewRuntime = {
      requested_model: "review-model",
      reasoning_effort: "high",
      sanitized_profile: {
        adapter_id: "copilot-acp",
        adapter_version: "1.0.0",
        profile_id: "noninteractive-review-v1",
        executable: "copilot",
        argv: ["--acp", "--stdio"],
        requested_model: "review-model",
        reasoning_effort: "high",
        available_tools: ["view"],
        excluded_tools: ["edit", "delete"],
        authentication: "noninteractive_authenticated",
        execution_mode: "permission_mediated_local",
        containment_assurance: "not_independently_enforced",
        machine_authority: "launching_user",
        requested_mcp_server_count: 0,
        client_fs_read_text_file: true,
        client_fs_write_text_file: true,
        credential_environment: "explicit_allowlist_without_credential_values",
      },
      start: vi.fn(async () => {
        throw new Error("not started by this boundary test");
      }),
    };
    const reviewRuntime: ConnectedReviewRuntime = {
      configuration: () => ({
        adapter_id: "copilot-acp",
        adapter_version: "1.0.0",
        profile_id: "noninteractive-review-v1",
        available_model_ids: ["review-model"],
        default_model: "review-model",
      }),
      prepare: vi.fn(async () => preparedReview),
    };
    const configuredReview = await createService(
      new SQLitePortfolioIndex(":memory:"),
      undefined,
      emptyRuntime,
      undefined,
      reviewRuntime,
    );
    expect(configuredReview.service.getReviewModelAvailability()).toEqual({
      status: "available",
      adapter_id: "copilot-acp",
      adapter_version: "1.0.0",
      profile_id: "noninteractive-review-v1",
      available_model_ids: ["review-model"],
      distinct_model_count: 1,
      has_three_distinct_models: false,
      reason: null,
    });
    const prepared = await reviewRuntime.prepare({
      workspace_cwd: "/products/review",
      requested_model: "review-model",
      limits: {
        wall_clock_timeout_ms: 900_000,
        max_event_count: 1_000,
        max_event_bytes: 1_000_000,
        max_output_bytes: 1_000_000,
        termination_grace_ms: 5_000,
        drain_grace_ms: 1_000,
      },
      result_ingress_policy: {
        kind: "single_result_file",
        result_path: ".founder/review/result.json",
        mission_result_binding_sha256: "a".repeat(64),
        commands: "forbidden",
        urls: "forbidden",
        mcp: "forbidden",
        credentials: "forbidden",
        outside_workspace_writes: "forbidden",
        reads: "workspace_and_repository_unrestricted",
        execution_mode: "permission_mediated_local",
        result_assurance: "result_scope_validation",
        containment_assurance: "not_independently_enforced",
        machine_authority: "launching_user",
      },
    });
    expect(prepared.sanitized_profile.profile_id).toBe(
      "noninteractive-review-v1",
    );
    expect(prepared.sanitized_profile).not.toHaveProperty(
      "capability_envelope",
    );
    const modelRoot = await createWorkspace("Connected Model Options Workspace");
    const modelRepository = new ProductWorkspace(modelRoot);
    const modelItem = await modelRepository.create({
      title: "Inspect connected model options",
      type: "Feature",
    });
    const modelRegistration = await configuredReview.service.register({
      workspace_path: modelRoot,
    });
    await expect(
      configuredReview.service.getConnectedModelOptions(
        modelRegistration.workspace.workspace_id,
        modelItem.goal.work_item_id,
      ),
    ).resolves.toMatchObject({
      model_availability: {
        execute: {
          status: "unavailable",
          reason: "no_models_configured",
        },
        review: {
          status: "available",
          available_model_ids: ["review-model"],
          reason: null,
        },
        patch: {
          status: "unavailable",
          reason: "no_models_configured",
        },
      },
      model_picker_options: {
        execute: [],
        review: [
          {
            model_id: "review-model",
            used_by_seats: [],
            saved_preference: false,
            recommended: true,
            preselected: true,
            reuse_warning: null,
          },
        ],
        patch: [],
      },
    });
    configuredReview.index.close();
  });

  it("lists source-qualified historical evidence without controller or cache mutation", async () => {
    const root = await createWorkspace("Evidence Query Workspace");
    const repository = new ProductWorkspace(root);
    const created = await repository.create({
      title: "Read historical evidence",
      type: "Feature",
    });
    const workItemId = created.goal.work_item_id;
    const history: StoredImportEvidence[] = [
      {
        evidence: {
          schema_version: 2,
          phase: "execute",
          import_run_id: "f".repeat(64),
          result_content_sha256: "c".repeat(64),
          mission_content_sha256: "d".repeat(64),
          identity: {
            phase: "execute",
            work_item_id: workItemId,
            goal_version: 2,
            input_revision: 3,
            attempt: 1,
          },
          git_base_commit: "a".repeat(40),
          result_commit: null,
          controller_run_id: "550e8400-e29b-41d4-a716-446655440000",
          started_at: "2026-07-22T14:00:00.000Z",
          completed_at: "2026-07-22T14:00:01.000Z",
          outcome: "rejected",
          reasons: ["Rejected historical result."],
        },
        summary: {
          phase: "execute",
          import_run_id: "f".repeat(64),
          outcome: "rejected",
          evidence_path: `.founder/run-evidence/${workItemId}/execute-2-3-1/${"f".repeat(64)}`,
          reasons: ["Rejected historical result."],
        },
        verification: [],
      },
      {
        evidence: {
          schema_version: 2,
          phase: "execute",
          import_run_id: "e".repeat(64),
          result_content_sha256: "b".repeat(64),
          mission_content_sha256: "d".repeat(64),
          identity: {
            phase: "execute",
            work_item_id: workItemId,
            goal_version: 1,
            input_revision: 1,
            attempt: 0,
          },
          git_base_commit: "a".repeat(40),
          result_commit: null,
          controller_run_id: "123e4567-e89b-42d3-a456-426614174000",
          started_at: "2026-07-22T13:00:00.000Z",
          completed_at: "2026-07-22T13:00:01.000Z",
          outcome: "rejected",
          reasons: ["Rejected original result."],
        },
        summary: {
          phase: "execute",
          import_run_id: "e".repeat(64),
          outcome: "rejected",
          evidence_path: `.founder/run-evidence/${workItemId}/execute-1-1-0/${"e".repeat(64)}`,
          reasons: ["Rejected original result."],
        },
        verification: [],
      },
    ];
    const index = new SQLitePortfolioIndex(":memory:");
    const { service } = await createService(index, (workspacePath) =>
      workspacePath === root
        ? repository
        : new ProductWorkspace(workspacePath, {
            git: controllerGit,
            verificationRunner: controllerRunner,
          }),
    );
    const registration = await service.register({ workspace_path: root });
    const rebuildSpy = vi.spyOn(index, "rebuild");
    rebuildSpy.mockClear();
    const leaseSpy = vi.spyOn(repository, "acquireControllerLease");
    const listEvidenceSpy = vi
      .spyOn(repository, "listImportEvidence")
      .mockResolvedValue(history);
    const statePath = join(
      root,
      ".founder",
      "work-items",
      workItemId,
      "state.json",
    );
    const stateBefore = await readFile(statePath, "utf8");

    await expect(
      service.listImportEvidence(
        registration.workspace.workspace_id,
        workItemId,
      ),
    ).resolves.toEqual(history);
    await expect(
      service.listImportEvidence(
        registration.workspace.workspace_id,
        "wi_00000000-0000-4000-8000-000000000000",
      ),
    ).rejects.toBeInstanceOf(PortfolioWorkItemNotFoundError);

    expect(listEvidenceSpy).toHaveBeenCalledOnce();
    expect(listEvidenceSpy).toHaveBeenCalledWith(workItemId);
    expect(leaseSpy).not.toHaveBeenCalled();
    expect(rebuildSpy).not.toHaveBeenCalled();
    expect(await readFile(statePath, "utf8")).toBe(stateBefore);
    index.close();
  });

  it("imports applied and rejected results, refreshes projection, and starts repair explicitly", async () => {
    const root = await createWorkspace("Import Workspace");
    const repository = new ProductWorkspace(root);
    const appliedItem = await repository.create({
      title: "Import a verified result",
      type: "Feature",
    });
    await governWorkItemThrough(repository, appliedItem, [
      "spec",
      "plan",
      "execute",
    ]);
    const { index, service } = await createService();
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    const appliedMission = await service.compileMission(
      sourceId,
      appliedItem.goal.work_item_id,
    );
    await writeFile(
      join(dirname(appliedMission.task_path), "result.json"),
      serializeExternalResult({
        result_schema_version: 2,
        mission_content_sha256: appliedMission.mission.content_sha256,
        identity: { ...appliedMission.mission.identity, phase: "execute" },
        commit: "a".repeat(40),
        summary: "Implemented the import path",
        changed_files: ["src/application/portfolio.ts"],
        verification: [{ name: "Tests", status: "passed" }],
      }),
      "utf8",
    );

    const applied = await service.importResult(
      sourceId,
      appliedItem.goal.work_item_id,
    );
    expect(applied).toMatchObject({
      source_id: sourceId,
      work_item: { state: { phase: "review", status: "active" } },
      evidence: { outcome: "applied" },
    });
    await expect(
      service.importResult(sourceId, appliedItem.goal.work_item_id),
    ).resolves.toEqual(applied);
    expect(await service.list()).toContainEqual(
      expect.objectContaining({
        source_id: sourceId,
        work_item: expect.objectContaining({
          state: expect.objectContaining({ phase: "review", status: "active" }),
        }),
      }),
    );

    const rejectedItem = await repository.create({
      title: "Preserve a malformed result",
      type: "Fix",
    });
    await governWorkItemThrough(repository, rejectedItem, [
      "spec",
      "plan",
      "execute",
    ]);
    const rejectedMission = await service.compileMission(
      sourceId,
      rejectedItem.goal.work_item_id,
    );
    await writeFile(
      join(dirname(rejectedMission.task_path), "result.json"),
      "{invalid",
      "utf8",
    );
    const rejected = await service.importResult(
      sourceId,
      rejectedItem.goal.work_item_id,
    );
    expect(rejected).toMatchObject({
      work_item: { state: { phase: "execute", status: "blocked", attempt: 0 } },
      evidence: { outcome: "rejected" },
    });

    const retried = await service.retryExecuteAttempt(
      sourceId,
      rejectedItem.goal.work_item_id,
    );
    expect(retried).toMatchObject({
      source_id: sourceId,
      work_item: { state: { phase: "execute", status: "active", attempt: 1 } },
      controller_run: { phase: "execute", outcome: "applied", attempt: 1 },
    });
    expect(await service.list()).toContainEqual(
      expect.objectContaining({
        work_item: expect.objectContaining({
          goal: expect.objectContaining({
            work_item_id: rejectedItem.goal.work_item_id,
          }),
          state: expect.objectContaining({ status: "active", attempt: 1 }),
        }),
      }),
    );
    index.close();
  });

  it("runs the source-qualified patch loop and projects exact review attention", async () => {
    const root = await createWorkspace("Review Mission Workspace");
    const repository = new ProductWorkspace(root);
    const created = await repository.create({
      title: "Review an accepted execute result",
      type: "Feature",
    });
    await governWorkItemThrough(repository, created, [
      "spec",
      "plan",
      "execute",
    ]);
    const index = createMemoryIndex();
    const cleanWorktree = vi.fn(async () => true);
    const runVerification = vi.fn(async (command: VerificationCommand) =>
      controllerRunner.run(command),
    );
    const verificationRunner: VerificationRunner = {
      run: runVerification,
    };
    const { service } = await createService(
      index,
      (workspacePath) =>
        new ProductWorkspace(workspacePath, {
          git: {
            ...controllerGit,
            isWorktreeCleanExcludingFounder: cleanWorktree,
          },
          verificationRunner,
        }),
    );
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    const executeMission = await service.compileMission(
      sourceId,
      created.goal.work_item_id,
    );
    await writeFile(
      join(dirname(executeMission.task_path), "result.json"),
      serializeExternalResult({
        result_schema_version: 2,
        mission_content_sha256: executeMission.mission.content_sha256,
        identity: { ...executeMission.mission.identity, phase: "execute" },
        commit: "a".repeat(40),
        summary: "Implemented the review mission boundary.",
        changed_files: ["src/application/portfolio.ts"],
        verification: [{ name: "Tests", status: "passed" }],
      }),
      "utf8",
    );
    await service.importResult(sourceId, created.goal.work_item_id);

    const unrelatedRoot = await createWorkspace("Unrelated Review Source");
    const unrelated = await service.register({ workspace_path: unrelatedRoot });
    await expect(
      service.compileReviewMission(
        unrelated.workspace.workspace_id,
        created.goal.work_item_id,
        { independence_attested: true },
      ),
    ).rejects.toBeInstanceOf(PortfolioWorkItemNotFoundError);
    await expect(
      service.importReviewResult(
        unrelated.workspace.workspace_id,
        created.goal.work_item_id,
      ),
    ).rejects.toBeInstanceOf(PortfolioWorkItemNotFoundError);
    await expect(
      readdir(join(unrelatedRoot, ".founder", "missions")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      service.compileReviewMission(
        sourceId,
        created.goal.work_item_id,
        { independence_attested: false } as never,
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
    const first = await service.compileReviewMission(
      sourceId,
      created.goal.work_item_id,
      { independence_attested: true },
    );
    const second = await service.compileReviewMission(
      sourceId,
      created.goal.work_item_id,
      { independence_attested: true },
    );
    expect(second).toEqual(first);
    expect(await readFile(second.mission_path, "utf8")).toBe(
      await readFile(first.mission_path, "utf8"),
    );
    expect(await readFile(second.task_path, "utf8")).toBe(
      await readFile(first.task_path, "utf8"),
    );
    expect(first.mission).toMatchObject({
      identity: { phase: "review" },
      independence_attested: true,
      review_subject: {
        accepted_result_commit: "a".repeat(40),
        changed_files: ["src/application/portfolio.ts"],
      },
    });
    expect(first.task_path).toContain("/review-1-1-0/TASK.md");
    expect(await readFile(first.task_path, "utf8")).toContain(
      "Do not modify workspace files or execute verification commands.",
    );
    if (first.mission.review_subject.source !== "execute") {
      throw new Error("Initial review mission must bind execute evidence.");
    }

    await writeFile(
      join(dirname(first.task_path), "result.json"),
      serializeExternalResult({
        result_schema_version: 2,
        review_mission_content_sha256: first.mission.content_sha256,
        identity: first.mission.identity,
        execute_mission_content_sha256:
          first.mission.review_subject.execute_mission_content_sha256,
        execute_result_content_sha256:
          first.mission.review_subject.execute_result_content_sha256,
        git_base_commit: first.mission.review_subject.git_base_commit,
        accepted_result_commit:
          first.mission.review_subject.accepted_result_commit,
        summary: "Found one required correction.",
        verdict: "findings",
        findings: [
          {
            finding_id: "F-portfolio-1",
            severity: "P1",
            title: "Keep review imports state-neutral",
            evidence: {
              path: "src/application/portfolio.ts",
              summary: "The verdict must not route the work item.",
            },
            required_action: "Preserve review/active after import.",
            link: {
              type: "acceptance_criteria",
              criterion: "The mission package is reproducible",
            },
          },
        ],
      }),
      "utf8",
    );
    const imported = await service.importReviewResult(
      sourceId,
      created.goal.work_item_id,
    );
    expect(imported).toMatchObject({
      source_id: sourceId,
      evidence: { phase: "review", outcome: "applied" },
      work_item: {
        state: {
          phase: "review",
          status: "active",
          attempt: 0,
          attention: { kind: "patch_plan_approval" },
        },
      },
      result: {
        verdict: "findings",
        findings: [{ finding_id: "F-portfolio-1" }],
      },
    });
    await expect(
      service.importReviewResult(sourceId, created.goal.work_item_id),
    ).resolves.toEqual(imported);
    const history = await service.listImportEvidence(
      sourceId,
      created.goal.work_item_id,
    );
    expect(history.map((stored) => stored.evidence.phase).sort()).toEqual([
      "execute",
      "review",
    ]);
    expect(
      history.find((stored) => stored.evidence.phase === "review")?.submission,
    ).toMatchObject({
      identity: { phase: "review" },
      verdict: "findings",
      findings: [{ finding_id: "F-portfolio-1" }],
    });

    const rebuildCallsBeforeAttention = index.rebuild.mock.calls.length;
    expect(await service.listAttention()).toMatchObject([
      {
        kind: "governed",
        entry: {
          item: {
            source_id: sourceId,
            work_item: {
              goal: { work_item_id: created.goal.work_item_id },
            },
          },
          attention: {
            kind: "patch_plan_approval",
            governed_tuple: { patch_cycle: 0 },
          },
          acceptance_criteria: [
            {
              criterion: "The mission package is reproducible",
              status: "needs_attention",
            },
          ],
          verification: {
            status: "passed",
            commands: [{ name: "Tests", status: "passed" }],
          },
          findings: [{ finding_id: "F-portfolio-1" }],
          patch_cycle_limit: 3,
          cost_capacity: "unknown",
        },
      },
    ]);
    expect(index.rebuild).toHaveBeenCalledTimes(rebuildCallsBeforeAttention);

    const accepted = await service.acceptPatchPlan(
      sourceId,
      created.goal.work_item_id,
    );
    expect(accepted).toMatchObject({
      source_id: sourceId,
      work_item: {
        state: {
          phase: "patch",
          status: "active",
          patch_cycle: 1,
        },
      },
      controller_run: { phase: "patch", outcome: "applied" },
    });
    await expect(
      service.acceptPatchPlan(sourceId, created.goal.work_item_id),
    ).resolves.toEqual(accepted);

    const patchManifestPath = join(
      root,
      ".founder",
      "work-items",
      created.goal.work_item_id,
      "runs",
      `${accepted.controller_run.run_id}.json`,
    );
    await writeFile(
      patchManifestPath,
      `${JSON.stringify(
        {
          ...accepted.controller_run,
          idempotency_key: `${accepted.controller_run.idempotency_key.slice(0, -64)}${"f".repeat(64)}`,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await expect(
      service.compilePatchMission(sourceId, created.goal.work_item_id),
    ).rejects.toThrow("governed cycle and review result");
    await writeFile(
      patchManifestPath,
      `${JSON.stringify(accepted.controller_run, null, 2)}\n`,
      "utf8",
    );
    const executionDirectory = join(root, ".founder", "execution");
    await mkdir(executionDirectory, { recursive: true });
    await writeFile(
      join(executionDirectory, "defaults.json"),
      `${JSON.stringify(
        {
          schema_version: 1,
          approved_command_forms: [
            { executable: "npm", args: ["run", "test"] },
          ],
          approved_url_operations: [],
          mcp: "forbidden",
          credentials: "forbidden",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const patchMission = await service.compilePatchMission(
      sourceId,
      created.goal.work_item_id,
    );
    expect(patchMission.mission).toMatchObject({
      mission_schema_version: 7,
      identity: { phase: "patch", patch_cycle: 1 },
      capability_envelope: {
        runtime: {
          approved_command_forms: [
            { executable: "npm", args: ["run", "test"] },
          ],
        },
      },
      patch_subject: {
        findings: [{ finding_id: "F-portfolio-1" }],
      },
    });
    expect(patchMission.task_path).toContain("/patch-1-1-0-1/TASK.md");
    await expect(
      service.compilePatchMission(sourceId, created.goal.work_item_id),
    ).resolves.toEqual(patchMission);

    const writePatchResult = (summary: string) =>
      writeFile(
        join(dirname(patchMission.task_path), "result.json"),
        serializeExternalResult({
          result_schema_version: 2,
          patch_mission_content_sha256:
            patchMission.mission.content_sha256,
          identity: patchMission.mission.identity,
          commit: "a".repeat(40),
          summary,
          changed_files: ["src/application/portfolio.ts"],
          verification: [{ name: "Tests", status: "passed" }],
        }),
        "utf8",
      );
    await writePatchResult("Reject the dirty patch result.");
    cleanWorktree.mockResolvedValueOnce(false);
    const dirty = await service.importPatchResult(
      sourceId,
      created.goal.work_item_id,
    );
    expect(dirty).toMatchObject({
      work_item: { state: { phase: "patch", patch_cycle: 1 } },
      evidence: { phase: "patch", outcome: "rejected" },
    });

    await writePatchResult("Reject the patch with a red authoritative check.");
    runVerification.mockResolvedValueOnce({
      name: "Tests",
      argv: ["npm", "test"],
      started_at: "2026-07-22T12:00:00.000Z",
      completed_at: "2026-07-22T12:00:01.000Z",
      duration_ms: 1000,
      status: "failed",
      exit_code: 1,
      signal: null,
      stdout: "",
      stderr: "failed",
      output_truncated: false,
    });
    const red = await service.importPatchResult(
      sourceId,
      created.goal.work_item_id,
    );
    expect(red).toMatchObject({
      work_item: { state: { phase: "patch", patch_cycle: 1 } },
      evidence: { phase: "patch", outcome: "rejected" },
    });

    await writePatchResult("Applied the bounded portfolio patch.");
    const patched = await service.importPatchResult(
      sourceId,
      created.goal.work_item_id,
    );
    expect(patched).toMatchObject({
      source_id: sourceId,
      work_item: {
        state: {
          phase: "review",
          status: "active",
          patch_cycle: 1,
        },
      },
      evidence: { phase: "patch", outcome: "applied" },
      result: { identity: { phase: "patch", patch_cycle: 1 } },
    });
    expect(cleanWorktree).toHaveBeenCalled();
    expect(runVerification).toHaveBeenCalled();
    await expect(
      service.importPatchResult(sourceId, created.goal.work_item_id),
    ).resolves.toEqual(patched);

    const patchReview = await service.compileReviewMission(
      sourceId,
      created.goal.work_item_id,
      { independence_attested: true },
    );
    expect(patchReview.task_path).toContain(
      "/review-1-1-0-patch-1/TASK.md",
    );
    expect(patchReview.mission.review_subject).toMatchObject({
      source: "patch",
      patch_cycle: 1,
      resolved_from: { finding_ids: ["F-portfolio-1"] },
    });
    if (patchReview.mission.review_subject.source !== "patch") {
      throw new Error("Patch review mission must bind patch evidence.");
    }
    await writeFile(
      join(dirname(patchReview.task_path), "result.json"),
      serializeExternalResult({
        result_schema_version: 2,
        review_mission_content_sha256:
          patchReview.mission.content_sha256,
        identity: patchReview.mission.identity,
        patch_mission_content_sha256:
          patchReview.mission.review_subject
            .patch_mission_content_sha256,
        patch_result_content_sha256:
          patchReview.mission.review_subject
            .patch_result_content_sha256,
        git_base_commit:
          patchReview.mission.review_subject.git_base_commit,
        accepted_result_commit:
          patchReview.mission.review_subject.accepted_result_commit,
        summary: "The bounded patch resolves the assigned finding.",
        verdict: "clean",
        findings: [],
        resolutions: [
          { finding_id: "F-portfolio-1", status: "resolved" },
        ],
      }),
      "utf8",
    );
    const rereviewed = await service.importReviewResult(
      sourceId,
      created.goal.work_item_id,
    );
    expect(rereviewed.work_item.state.attention).toMatchObject({
      kind: "review_ready",
      governed_tuple: { patch_cycle: 1 },
    });
    expect(await service.listAttention()).toMatchObject([
      {
        kind: "governed",
        entry: {
          attention: { kind: "review_ready" },
          findings: [],
          acceptance_criteria: [{ status: "reviewed" }],
        },
      },
    ]);
    index.close();
  });

  it("keeps the attention query empty and patch operations unavailable for Inbox captures", async () => {
    const index = createMemoryIndex();
    const { inboxRoot, service } = await createService(index);
    await expect(service.listAttention()).resolves.toEqual([]);
    const captured = await service.createCapture({
      title: "Keep this unassigned capture lightweight",
      capture_kind: "todo",
    });
    const inbox = new ProductWorkspace(inboxRoot);
    const before = await inbox.read(captured.work_item.goal.work_item_id);

    await expect(
      service.acceptPatchPlan(
        INBOX_SOURCE_ID,
        captured.work_item.goal.work_item_id,
      ),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });
    await expect(
      service.compilePatchMission(
        INBOX_SOURCE_ID,
        captured.work_item.goal.work_item_id,
      ),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });
    await expect(
      service.importPatchResult(
        INBOX_SOURCE_ID,
        captured.work_item.goal.work_item_id,
      ),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });
    await expect(service.listAttention()).resolves.toEqual([]);
    expect(await inbox.read(captured.work_item.goal.work_item_id)).toEqual(
      before,
    );
    await expect(
      readdir(join(inboxRoot, ".founder", "missions")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    index.close();
  });

  it("does not synthesize approval attention without a ready Spec result or for Plan", async () => {
    const root = await createWorkspace("Phase Approval Attention");
    const repository = new ProductWorkspace(root);
    const specItem = await repository.create({
      title: "Approve the specification",
      type: "Feature",
    });
    const planItem = await repository.create({
      title: "Approve the execution plan",
      type: "Feature",
    });
    await governWorkItemThrough(repository, specItem, ["spec"]);
    await governWorkItemThrough(repository, planItem, ["spec", "plan"]);
    const index = createMemoryIndex();
    const { service } = await createService(index);
    await service.register({ workspace_path: root });
    const rebuildCallsBeforeAttention = index.rebuild.mock.calls.length;

    const attention = await service.listAttention();

    expect(attention).toEqual([]);
    expect(index.rebuild).toHaveBeenCalledTimes(rebuildCallsBeforeAttention);
    index.close();
  });

  it("projects one bound Spec shaping decision and invalidates it from durable state", async () => {
    const root = await createWorkspace("Shaping Attention Workspace");
    const repository = new ProductWorkspace(root, {
      git: controllerGit,
      verificationRunner: controllerRunner,
    });
    const created = await repository.create({
      title: "Approve one ready Spec result",
      type: "Feature",
    });
    const index = createMemoryIndex();
    const { service } = await createService(index, () => repository);
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    const workItemId = created.goal.work_item_id;

    await service.startBrainstorm(sourceId, workItemId, {
      launch_mode: "manual",
      next_requested_model: null,
      expected_mission_content_sha256: null,
      expected_result_content_sha256: null,
      expected_shaping_state_sha256: ideaShapingStateSha256(created),
    });
    await applyManualShapingResult(
      service,
      root,
      sourceId,
      workItemId,
      "brainstorm",
    );
    const brainstormReady = await service.listShapingArtifacts(
      sourceId,
      workItemId,
    );
    const brainstormTip = currentPhaseArtifact(
      brainstormReady.artifacts,
      "brainstorm",
    );
    await service.useBrainstormResult(sourceId, workItemId, {
      launch_mode: "manual",
      next_requested_model: null,
      expected_mission_content_sha256: brainstormTip.mission.content_sha256,
      expected_result_content_sha256:
        brainstormTip.result!.result_content_sha256,
      expected_shaping_state_sha256:
        brainstormReady.expected_shaping_state_sha256,
    });

    await expect(service.listAttention()).resolves.toEqual([]);
    const firstApplied = await applyManualShapingResult(
      service,
      root,
      sourceId,
      workItemId,
      "spec",
    );
    if (
      firstApplied.imported.outcome !== "applied" ||
      !("proposal" in firstApplied.imported.result)
    ) {
      throw new Error("Expected one applied Spec result.");
    }
    const firstReady = await service.listShapingArtifacts(sourceId, workItemId);
    const firstTip = currentPhaseArtifact(firstReady.artifacts, "spec");
    const [shapingEntry] = await service.listAttention();
    expect(shapingEntry).toMatchObject({
      kind: "shaping",
      item: {
        source_id: sourceId,
        work_item: {
          goal: { work_item_id: workItemId },
          state: { phase: "spec", status: "active" },
        },
      },
      shaping_attention: {
        schema_version: 1,
        kind: "spec_approval_shaping",
        work_item_id: workItemId,
        source_id: sourceId,
        recommendation: "Open the item and use Approve & run Plan.",
        binding: {
          mission_content_sha256: firstTip.mission.content_sha256,
          applied_result_content_sha256:
            firstTip.result!.result_content_sha256,
          shaping_state_sha256: firstReady.expected_shaping_state_sha256,
        },
      },
    });
    expect(shapingEntry).not.toHaveProperty("entry");
    const artifactListing = vi.spyOn(repository, "listShapingArtifacts");
    artifactListing.mockClear();
    expect(
      (await service.list()).find(
        (item) => item.work_item.goal.work_item_id === workItemId,
      ),
    ).toMatchObject({
      shaping_summary: {
        phase: "spec",
        has_applied_result: true,
        decision_kind: null,
        latest_run_status: "ready",
      },
    });
    expect(artifactListing).toHaveBeenCalledOnce();

    const resultPath = join(root, firstTip.result!.result_path);
    const originalResultSource = firstTip.result!.result_source;
    await writeFile(resultPath, `${originalResultSource} `, "utf8");
    await expect(service.listAttention()).resolves.toEqual([]);
    expect(
      (await service.list()).find(
        (item) => item.work_item.goal.work_item_id === workItemId,
      ),
    ).toMatchObject({
      shaping_summary: { latest_run_status: "needs_repair" },
    });
    await writeFile(resultPath, originalResultSource, "utf8");

    const goalPath = join(
      root,
      ".founder",
      "work-items",
      workItemId,
      "goal.yaml",
    );
    const statePath = join(
      root,
      ".founder",
      "work-items",
      workItemId,
      "state.json",
    );
    const originalGoalSource = await readFile(goalPath, "utf8");
    const originalStateSource = await readFile(statePath, "utf8");
    const current = await repository.read(workItemId);
    if (current === null) {
      throw new Error("Expected the current Spec work item.");
    }
    const governedContract = goalContractFromSpecProposal(
      firstApplied.imported.result.proposal,
      1,
    );
    await writeFile(
      goalPath,
      stringify({ ...current.goal, goal_contract: governedContract }),
      "utf8",
    );
    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          ...current.state,
          goal_version: 1,
          input_revision: 1,
          attempt: 0,
          patch_cycle: 0,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await expect(service.listAttention()).resolves.toMatchObject([
      {
        kind: "governed",
        entry: {
          attention: {
            kind: "spec_approval",
            recommendation: "Open the item and use Approve & run Plan.",
          },
        },
      },
    ]);
    await writeFile(goalPath, originalGoalSource, "utf8");
    await writeFile(statePath, originalStateSource, "utf8");

    await service.requestShapingChanges(sourceId, workItemId, {
      launch_mode: "manual",
      next_requested_model: null,
      expected_mission_content_sha256: firstTip.mission.content_sha256,
      expected_result_content_sha256:
        firstTip.result!.result_content_sha256,
      expected_shaping_state_sha256: firstReady.expected_shaping_state_sha256,
      feedback: "Narrow the ready Spec before approval.",
    });
    await expect(service.listAttention()).resolves.toEqual([]);

    const revisedApplied = await applyManualShapingResult(
      service,
      root,
      sourceId,
      workItemId,
      "spec",
    );
    if (
      revisedApplied.imported.outcome !== "applied" ||
      !("proposal" in revisedApplied.imported.result)
    ) {
      throw new Error("Expected one revised applied Spec result.");
    }
    const revisedReady = await service.listShapingArtifacts(
      sourceId,
      workItemId,
    );
    const revisedTip = currentPhaseArtifact(revisedReady.artifacts, "spec");
    await service.approveSpecResult(sourceId, workItemId, {
      launch_mode: "manual",
      next_requested_model: null,
      expected_mission_content_sha256: revisedTip.mission.content_sha256,
      expected_result_content_sha256:
        revisedTip.result!.result_content_sha256,
      expected_shaping_state_sha256:
        revisedReady.expected_shaping_state_sha256,
      goal_contract_sha256: hashGoalContract(
        goalContractFromSpecProposal(
          revisedApplied.imported.result.proposal,
          1,
        ),
      ),
    });
    await expect(service.listAttention()).resolves.toEqual([]);
    expect(
      (await service.list()).find(
        (item) => item.work_item.goal.work_item_id === workItemId,
      ),
    ).toMatchObject({
      work_item: { state: { phase: "plan" } },
      shaping_summary: {
        phase: "plan",
        has_applied_result: false,
        latest_run_status: null,
      },
    });
    index.close();
  });

  it("skips an invalid registered workspace when listing attention", async () => {
    const invalidRoot = await createWorkspace("Invalid Attention Source");
    const invalidRepository = new ProductWorkspace(invalidRoot);
    const invalidItem = await invalidRepository.create({
      title: "Invalid goal artifact",
      type: "Fix",
    });
    await writeFile(
      join(
        invalidRoot,
        ".founder",
        "work-items",
        invalidItem.goal.work_item_id,
        "goal.yaml",
      ),
      stringify({ schema_version: 1, title: "Stale goal" }),
      "utf8",
    );

    const validRoot = await createWorkspace("Valid Attention Source");
    const validRepository = new ProductWorkspace(validRoot);
    const validItem = await validRepository.create({
      title: "Approve despite another invalid workspace",
      type: "Feature",
    });
    await governWorkItemThrough(validRepository, validItem, ["spec"]);
    const { index, service } = await createService(createMemoryIndex());
    const invalidRegistration = await service.register({
      workspace_path: invalidRoot,
    });
    await service.register({ workspace_path: validRoot });

    await expect(service.listAttention()).resolves.toEqual([]);
    await expect(service.listAttention()).resolves.not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item: expect.objectContaining({
            source_id: invalidRegistration.workspace.workspace_id,
          }),
        }),
      ]),
    );
    index.close();
  });

  it("rejects connected review when a newer execute import makes the subject ambiguous", async () => {
    const root = await createWorkspace("Stale Review Subject");
    const repository = new ProductWorkspace(root);
    const created = await repository.create({
      title: "Reject a stale review subject",
      type: "Fix",
    });
    await governWorkItemThrough(repository, created, [
      "spec",
      "plan",
      "execute",
    ]);
    const { index, service } = await createService();
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;
    const mission = await service.compileMission(
      sourceId,
      created.goal.work_item_id,
    );
    await writeFile(
      join(dirname(mission.task_path), "result.json"),
      serializeExternalResult({
        result_schema_version: 2,
        mission_content_sha256: mission.mission.content_sha256,
        identity: { ...mission.mission.identity, phase: "execute" },
        commit: "a".repeat(40),
        summary: "First accepted execute result.",
        changed_files: ["src/application/portfolio.ts"],
        verification: [{ name: "Tests", status: "passed" }],
      }),
      "utf8",
    );
    await service.importResult(sourceId, created.goal.work_item_id);
    const firstEvidence = (
      await repository.listImportEvidence(created.goal.work_item_id)
    ).find(
      (stored) =>
        stored.evidence.phase === "execute" &&
        stored.evidence.outcome === "applied",
    );
    if (firstEvidence === undefined || firstEvidence.evidence.phase !== "execute") {
      throw new Error("Expected applied execute evidence");
    }
    const secondSubmission = serializeExternalResult({
      ...JSON.parse(
        await readFile(
          join(root, firstEvidence.summary.evidence_path, "submission.json"),
          "utf8",
        ),
      ),
      summary: "Newer accepted execute result.",
    });
    const secondResultHash = hashResultContent(secondSubmission);
    await repository.writeImportEvidence({
      submission_source: secondSubmission,
      evidence: {
        ...firstEvidence.evidence,
        import_run_id: createImportRunId(
          firstEvidence.evidence.mission_content_sha256,
          secondResultHash,
        ),
        result_content_sha256: secondResultHash,
        completed_at: "2026-07-22T12:00:02.000Z",
      },
      verification: firstEvidence.verification,
    });

    await expect(
      service.launchConnectedReview(sourceId, created.goal.work_item_id, {
        independence_attested: true,
      }),
    ).rejects.toMatchObject({
      kind: "mission_not_ready",
      workItemId: created.goal.work_item_id,
    });
    index.close();
  });

  it("recovers a green import evidence bundle through a fresh workspace and index rebuild", async () => {
    const root = await createWorkspace("Import Recovery Workspace");
    const cacheRoot = await createRoot("product-studio-import-cache-");
    const databasePath = join(cacheRoot, "index.sqlite");
    const repository = new ProductWorkspace(root);
    const created = await repository.create({
      title: "Recover imported evidence",
      type: "Feature",
    });
    await governWorkItemThrough(repository, created, [
      "spec",
      "plan",
      "execute",
    ]);
    const index = new SQLitePortfolioIndex(databasePath);
    const { registry, inboxRoot, service } = await createService(index);
    const registration = await service.register({ workspace_path: root });
    const mission = await service.compileMission(
      registration.workspace.workspace_id,
      created.goal.work_item_id,
    );
    const submissionSource = serializeExternalResult({
      result_schema_version: 2,
      mission_content_sha256: mission.mission.content_sha256,
      identity: { ...mission.mission.identity, phase: "execute" },
      commit: "a".repeat(40),
      summary: "Persist the import bundle",
      changed_files: ["src/application/portfolio.ts"],
      verification: [{ name: "Tests", status: "passed" }],
    });
    await writeFile(
      join(dirname(mission.task_path), "result.json"),
      submissionSource,
      "utf8",
    );

    const imported = await service.importResult(
      registration.workspace.workspace_id,
      created.goal.work_item_id,
    );
    expect(imported.work_item.state).toMatchObject({
      phase: "review",
      status: "active",
    });

    const freshWorkspace = new ProductWorkspace(root);
    const stored = await freshWorkspace.readImportEvidence(
      mission.mission.identity,
      imported.evidence.import_run_id,
    );
    expect(stored).toMatchObject({
      evidence: {
        outcome: "applied",
        git_base_commit: mission.mission.source_revision.git_base_commit,
        result_commit: "a".repeat(40),
      },
      summary: imported.evidence,
      verification: [{ name: "Tests", status: "passed" }],
    });
    await expect(
      readFile(
        join(root, imported.evidence.evidence_path, "submission.json"),
        "utf8",
      ),
    ).resolves.toBe(submissionSource);

    index.close();
    await rm(databasePath);
    const restartedIndex = new SQLitePortfolioIndex(databasePath);
    const restartedService = new PortfolioService(
      registry,
      restartedIndex,
      inboxRoot,
      (workspacePath) =>
        new ProductWorkspace(workspacePath, {
          git: controllerGit,
          verificationRunner: controllerRunner,
        }),
    );
    await restartedService.rebuild();
    await expect(restartedService.list()).resolves.toContainEqual(
      expect.objectContaining({
        source_id: registration.workspace.workspace_id,
        work_item: expect.objectContaining({
          state: expect.objectContaining({
            phase: "review",
            status: "active",
          }),
        }),
      }),
    );
    restartedIndex.close();
  });

  it("rejects Inbox, uncontracted, and wrong-phase items without writing missions", async () => {
    const root = await createWorkspace("Ineligible Missions");
    const repository = new ProductWorkspace(root);
    const uncontracted = await repository.create({
      title: "Uncontracted item",
      type: "Feature",
    });
    const wrongPhase = await repository.create({
      title: "Still in spec",
      type: "Feature",
    });
    await governWorkItemThrough(repository, wrongPhase, ["spec"]);
    const { inboxRoot, index, service } = await createService();
    const registration = await service.register({ workspace_path: root });

    await expect(
      service.compileMission(
        registration.workspace.workspace_id,
        "wi_123e4567-e89b-12d3-a456-426614174000",
      ),
    ).rejects.toBeInstanceOf(PortfolioWorkItemNotFoundError);

    for (const workItemId of [
      uncontracted.goal.work_item_id,
      wrongPhase.goal.work_item_id,
    ]) {
      await expect(
        service.compileMission(
          registration.workspace.workspace_id,
          workItemId,
        ),
      ).rejects.toMatchObject({ kind: "mission_not_ready", workItemId });
      await expect(
        service.compileReviewMission(
          registration.workspace.workspace_id,
          workItemId,
          { independence_attested: true },
        ),
      ).rejects.toMatchObject({ kind: "mission_not_ready", workItemId });
      await expect(
        service.importResult(registration.workspace.workspace_id, workItemId),
      ).rejects.toMatchObject({ kind: "mission_not_ready", workItemId });
      await expect(
        service.importReviewResult(
          registration.workspace.workspace_id,
          workItemId,
        ),
      ).rejects.toMatchObject({ kind: "mission_not_ready", workItemId });
      await expect(
        service.retryExecuteAttempt(
          registration.workspace.workspace_id,
          workItemId,
        ),
      ).rejects.toMatchObject({ kind: "mission_not_ready", workItemId });
    }
    await expect(
      readdir(join(root, ".founder", "missions")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await service.rebuild();
    const inboxRepository = new ProductWorkspace(inboxRoot);
    const inboxItem = await inboxRepository.create({
      title: "Assigned nowhere",
      type: "Feature",
    });
    await governWorkItemThrough(inboxRepository, inboxItem, [
      "spec",
      "plan",
      "execute",
    ]);
    await expect(
      service.compileMission(INBOX_SOURCE_ID, inboxItem.goal.work_item_id),
    ).rejects.toMatchObject({
      kind: "mission_not_ready",
      workItemId: inboxItem.goal.work_item_id,
    });
    await expect(
      service.compileReviewMission(
        INBOX_SOURCE_ID,
        inboxItem.goal.work_item_id,
        { independence_attested: true },
      ),
    ).rejects.toMatchObject({
      kind: "mission_not_ready",
      workItemId: inboxItem.goal.work_item_id,
    });
    await expect(
      service.importResult(INBOX_SOURCE_ID, inboxItem.goal.work_item_id),
    ).rejects.toMatchObject({
      kind: "mission_not_ready",
      workItemId: inboxItem.goal.work_item_id,
    });
    await expect(
      service.importReviewResult(INBOX_SOURCE_ID, inboxItem.goal.work_item_id),
    ).rejects.toMatchObject({
      kind: "mission_not_ready",
      workItemId: inboxItem.goal.work_item_id,
    });
    await expect(
      service.retryExecuteAttempt(INBOX_SOURCE_ID, inboxItem.goal.work_item_id),
    ).rejects.toMatchObject({
      kind: "mission_not_ready",
      workItemId: inboxItem.goal.work_item_id,
    });
    await expect(
      readdir(join(inboxRoot, ".founder", "missions")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    index.close();
  });

  it("rejects missing or duplicate execute provenance without writing a package", async () => {
    const root = await createWorkspace("Mission Provenance");
    const repository = new ProductWorkspace(root);
    const missingItem = await repository.create({
      title: "Missing execute evidence",
      type: "Feature",
    });
    const missingGoverned = await governWorkItemThrough(repository, missingItem, [
      "spec",
      "plan",
      "execute",
    ]);
    const missingExecuteManifest = missingGoverned.manifests.at(-1)!;
    await rm(
      join(
        root,
        ".founder",
        "work-items",
        missingItem.goal.work_item_id,
        "runs",
        `${missingExecuteManifest.run_id}.json`,
      ),
    );

    const duplicateItem = await repository.create({
      title: "Duplicate execute evidence",
      type: "Feature",
    });
    const duplicateGoverned = await governWorkItemThrough(
      repository,
      duplicateItem,
      ["spec", "plan", "execute"],
    );
    const executeManifest = duplicateGoverned.manifests.at(-1)!;
    const duplicateRunId = "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1";
    await writeFile(
      join(
        root,
        ".founder",
        "work-items",
        duplicateItem.goal.work_item_id,
        "runs",
        `${duplicateRunId}.json`,
      ),
      `${JSON.stringify(
        {
          ...executeManifest,
          run_id: duplicateRunId,
          idempotency_key: `${executeManifest.idempotency_key}:duplicate`,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const { index, service } = await createService();
    const registration = await service.register({ workspace_path: root });
    for (const workItemId of [
      missingItem.goal.work_item_id,
      duplicateItem.goal.work_item_id,
    ]) {
      await expect(
        service.compileMission(
          registration.workspace.workspace_id,
          workItemId,
        ),
      ).rejects.toMatchObject({ kind: "mission_not_ready", workItemId });
    }
    await expect(
      readdir(join(root, ".founder", "missions")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    index.close();
  });

  it("rejects invalid moves without changing durable state or the index", async () => {
    const root = await createWorkspace("Rejected Transition");
    const created = await new ProductWorkspace(root).create({
      title: "Do not skip gates",
      type: "Fix",
    });
    const statePath = join(
      root,
      ".founder",
      "work-items",
      created.goal.work_item_id,
      "state.json",
    );
    const { index, service } = await createService();
    const registration = await service.register({ workspace_path: root });
    const beforeState = await readFile(statePath, "utf8");
    const beforeIndex = await service.list();

    await expect(
      service.updateWorkItemPhase(
        registration.workspace.workspace_id,
        created.goal.work_item_id,
        { target_phase: "plan" },
      ),
    ).rejects.toMatchObject({
      kind: "invalid_transition",
      reason: "Phase transition from idea to plan is not allowed.",
    });
    expect(await readFile(statePath, "utf8")).toBe(beforeState);
    await expect(service.list()).resolves.toEqual(beforeIndex);
    index.close();
  });

  it("reports missing sources and work items with stable errors", async () => {
    const root = await createWorkspace("Missing Work");
    const { index, service } = await createService();
    const registration = await service.register({ workspace_path: root });

    await expect(
      service.updateWorkItemPhase(
        "ws_00000000-0000-4000-8000-000000000000",
        "wi_123e4567-e89b-12d3-a456-426614174000",
        { target_phase: "spec" },
      ),
    ).rejects.toBeInstanceOf(UnknownPortfolioSourceError);
    await expect(
      service.updateWorkItemPhase(
        registration.workspace.workspace_id,
        "wi_123e4567-e89b-12d3-a456-426614174000",
        { target_phase: "spec" },
      ),
    ).rejects.toBeInstanceOf(PortfolioWorkItemNotFoundError);
    index.close();
  });

  it("keeps project items visible when an existing inbox is malformed", async () => {
    const root = await createWorkspace("Project Survives Inbox Failure");
    await new ProductWorkspace(root).create({
      title: "Still visible",
      type: "MVP",
    });
    const { inboxRoot, index, service } = await createService();
    await service.register({ workspace_path: root });
    const manifestPath = join(inboxRoot, ".founder", "product.yaml");
    await writeFile(
      manifestPath,
      "schema_version: 2\nproduct_name: Corrupt Inbox\n",
      "utf8",
    );
    const malformedSource = await readFile(manifestPath, "utf8");

    const rebuild = await service.rebuild();

    expect(rebuild.items).toHaveLength(1);
    expect(rebuild.items[0]?.project?.workspace_path).toBe(root);
    expect(rebuild.failures).toMatchObject([
      {
        source_id: INBOX_SOURCE_ID,
        project: null,
        reason: expect.stringContaining("verification"),
      },
    ]);
    expect(await readFile(manifestPath, "utf8")).toBe(malformedSource);
    index.close();
  });

  it("preserves registration and explains recovery when the index fails", async () => {
    const root = await createWorkspace("Durable Registration");
    const indexFailure = new Error("index unavailable");
    const failingIndex: PortfolioWorkItemIndex = {
      rebuild() {
        throw indexFailure;
      },
      list() {
        return [];
      },
      clear() {},
      close() {},
    };
    const { registry, service } = await createService(failingIndex);

    await expect(
      service.register({ workspace_path: root }),
    ).rejects.toThrow(
      "Workspace was registered, but the portfolio index rebuild failed and may be stale",
    );
    await expect(registry.read()).resolves.toHaveLength(1);
  });

  it("rejects invalid input before changing the registry", async () => {
    const { registry, index, service } = await createService();

    await expect(
      service.register({ workspace_path: "relative/workspace" }),
    ).rejects.toThrow("workspace_path must be absolute");
    await expect(
      service.register({ workspace_path: join(tmpdir(), "missing-workspace") }),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
    await expect(registry.read()).resolves.toEqual([]);
    index.close();
  });

  it("does not overwrite existing registrations for a malformed manifest", async () => {
    const validRoot = await createWorkspace("Preserved Workspace");
    const malformedRoot = await createWorkspace("Malformed Workspace");
    const { registry, index, service } = await createService();
    const registered = await service.register({ workspace_path: validRoot });
    await writeFile(
      join(malformedRoot, ".founder", "product.yaml"),
      "schema_version: 2\nproduct_name: Future Workspace\n",
      "utf8",
    );

    await expect(
      service.register({ workspace_path: malformedRoot }),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
    await expect(registry.read()).resolves.toEqual([registered.workspace]);
    index.close();
  });
});
