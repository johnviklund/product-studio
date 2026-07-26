import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import {
  CopilotConnectedExecuteRuntime,
  PortfolioService,
  type ConnectedExecuteRuntime,
  type PreparedConnectedRuntime,
} from "../../src/application/portfolio";
import { WorkItemController } from "../../src/application/work-item-controller";
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
import { PortfolioRegistry } from "../../src/workspace/portfolio-registry";
import type {
  AcpClientAdapter,
  AcpEventSink,
  AcpRunResult,
  AcpSession,
} from "../../src/infrastructure/acp/acp-client";

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

function preparedRuntime(
  session: AcpSession,
  requestedModel = "copilot-default",
): { runtime: ConnectedExecuteRuntime; prepare: ReturnType<typeof vi.fn> } {
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
      credential_environment: "explicit_allowlist_without_credential_values",
    },
    start: vi.fn(async (eventSink: AcpEventSink) => {
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
    }),
  };
  const prepare = vi.fn(async () => prepared);
  return { runtime: { prepare }, prepare };
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
  connectedRuntime?: ConnectedExecuteRuntime,
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
    connectedRuntime,
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

  for (const targetPhase of targetPhases) {
    const result = await controller.transition(current.goal.work_item_id, {
      target_phase: targetPhase,
      target_status: "active",
      expected_phase: current.state.phase,
      expected_status: current.state.status,
      expected_schema_version: 2,
      expected_goal_version: current.state.goal_version!,
      expected_input_revision: current.state.input_revision!,
      attempt: current.state.attempt!,
    });
    current = result.work_item;
    manifests.push(result.manifest);
  }

  return { workItem: current, manifests };
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

    const updated = await service.updateWorkItemPhase(
      INBOX_SOURCE_ID,
      created.goal.work_item_id,
      { target_phase: "spec" },
    );
    expect(updated).toMatchObject({
      source_id: INBOX_SOURCE_ID,
      project: null,
      work_item: { state: { phase: "spec" } },
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
    const created = await new ProductWorkspace(root).create({
      title: "Move through the board",
      type: "Feature",
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
      { target_phase: "spec" },
    );

    expect(updated).toMatchObject({
      source_id: sourceId,
      project: { workspace_path: root },
      work_item: { state: { phase: "spec", status: "active" } },
    });
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      phase: "spec",
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

  it("launches one connected run, imports its completed result, and never spawns a duplicate", async () => {
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
    const { index, service } = await createService(
      undefined,
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
    expect((await service.listConnectedRuns(sourceId, created.goal.work_item_id))[0])
      .toMatchObject({ lifecycle: { status: "running" } });

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
    index.close();
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
    const unavailableRuntime = new CopilotConnectedExecuteRuntime(
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
    await expect(
      unavailable.service.launchConnectedExecute(
        sourceId,
        created.goal.work_item_id,
        { model_override: "unavailable-model" },
      ),
    ).rejects.toThrow("Requested Copilot model is unavailable.");
    expect(unavailableAdapter.start).not.toHaveBeenCalled();
    expect(await repository.listConnectedRuns(created.goal.work_item_id)).toEqual([]);
    unavailable.index.close();

    const missingResult = deferred<AcpRunResult>();
    const session: AcpSession = {
      session_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b2",
      protocol_version: 1,
      requested_mcp_server_count: 0,
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
      kind: "outside_workspace_write" as const,
      path: "/tmp/outside-product-studio",
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
      return attention[0]?.attention.kind;
    }).toBe("missing_permission");
    const attention = (await connectedService.listAttention())[0]!;
    expect(attention).toMatchObject({
      item: { source_id: sourceId },
      attention: {
        kind: "missing_permission",
        operation: {
          connected_run_id: launched.connected_run.connected_run_id,
          operation_sha256: hashCanonicalCapabilityRequest(deniedOperation),
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
    await expect(connectedService.listAttention()).resolves.toEqual([]);
    connectedIndex.close();
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
    const { service } = await createService(index, () => repository);
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

    const patchMission = await service.compilePatchMission(
      sourceId,
      created.goal.work_item_id,
    );
    expect(patchMission.mission).toMatchObject({
      identity: { phase: "patch", patch_cycle: 1 },
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
        attention: { kind: "review_ready" },
        findings: [],
        acceptance_criteria: [{ status: "reviewed" }],
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

  it("projects one durable approval decision for each active Spec and Plan item", async () => {
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

    expect(attention.map((item) => item.attention.kind).sort()).toEqual([
      "plan_approval",
      "spec_approval",
    ]);
    expect(attention).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attention: expect.objectContaining({
            kind: "spec_approval",
            question:
              "Does the current goal contract authorize planning this work?",
          }),
          verification: { status: "unknown", commands: [] },
          findings: [],
          cost_capacity: "unknown",
        }),
        expect.objectContaining({
          attention: expect.objectContaining({
            kind: "plan_approval",
            question:
              "Does the current goal contract and allowed scope authorize execution?",
          }),
        }),
      ]),
    );
    expect(index.rebuild).toHaveBeenCalledTimes(rebuildCallsBeforeAttention);
    index.close();
  });

  it("rejects review compilation when a newer execute import makes the subject ambiguous", async () => {
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
      service.compileReviewMission(sourceId, created.goal.work_item_id, {
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
