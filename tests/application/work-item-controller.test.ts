import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import {
  WorkItemController,
  deriveControllerIdempotencyKey,
} from "../../src/application/work-item-controller";
import {
  MISSION_SCHEMA_VERSION,
  compileMission,
  compilePatchMission,
  compileReviewMission,
  hashHistoricalMissionContentV6,
  serializeMissionPackage,
  type ExecuteMissionPackage,
  type ExecuteReviewSubject,
  type HistoricalExecuteMissionPackageV6,
  type MissionIdentity,
  type MissionPhase,
  type PatchReviewSubject,
  type PatchSubject,
} from "../../src/domain/mission";
import {
  executionDefaultsFromCapabilityEnvelope,
  hashCanonicalCapabilityRequest,
  resolveCapabilityEnvelope,
  type ExecutionDefaultsV1,
} from "../../src/domain/capability-envelope";
import {
  hashResolvedCapabilityEnvelope,
  type ConnectedRunAuthorization,
  type ConnectedRunRecordV2,
} from "../../src/domain/connected-run";
import {
  deriveReviewMissionResultBindingSha256,
  hashReviewRunPolicy,
  type ReviewRunPolicy,
} from "../../src/domain/review-run-policy";
import {
  expectedImportRunId,
  hashResultContent,
  importEvidenceEnvelopeSchema,
  importEvidenceSummarySchema,
  serializeExternalResult,
  type AppliedExecuteReviewSubject,
  type ExecuteExternalResultSubmission,
  type ImportEvidenceWriteInput,
  type MissionResultSnapshot,
  type PatchExternalResultSubmission,
  type PatchReviewExternalResultSubmission,
  type ReviewExternalResultSubmission,
  type ReviewFindingLink,
  type StoredImportEvidence,
} from "../../src/domain/result";
import {
  compileBrainstormMission,
  goalContractFromSpecProposal,
  hashGoalContract,
  hashGoalInput,
  hashShapingDecisionState,
  isShapingPhase,
  shapingDecisionReceiptSchema,
  type BrainstormMissionPackage,
  type BrainstormResultSubmission,
  type PlanShapingInput,
  type PlanResultSubmission,
  type ShapingMissionPackage,
  type ShapingPhase,
  type SpecResultSubmission,
  type StoredShapingArtifact,
} from "../../src/domain/shaping";
import { deriveManualShapingProductionId } from "../../src/domain/shaping-run";
import type {
  SemanticAuthoritativeSourceV1,
  SemanticEventIntentV1,
  SemanticEventV1,
} from "../../src/domain/semantic-event";
import {
  CLOSED_IN_SLICE_PHASE_TRANSITIONS,
  CONTROLLER_ONLY_PHASE_TRANSITIONS,
} from "../../src/domain/workflow-policy";
import type {
  GitVerificationAdapter,
  VerificationRunner,
} from "../../src/domain/verification";
import {
  ControllerConflictError,
  deriveControllerRunId,
  workItemSchema,
  type ControllerRunManifest,
  type VerificationCommand,
  type WorkItem,
} from "../../src/domain/work-item";
import {
  ProductWorkspace,
  type ShapingRunCreateInput,
} from "../../src/workspace/product-workspace";

const createdRoots: string[] = [];
const fixedClock = () => new Date("2026-07-21T21:00:00.000Z");
const testCommit = "a".repeat(40);

// Mirrors the ProductWorkspace.writeImportEvidence identity guard so these fakes
// cannot accept evidence that production rejects.
function assertProductionImportEvidenceContract(
  input: ImportEvidenceWriteInput,
): void {
  const evidence = importEvidenceEnvelopeSchema.parse(input.evidence);
  if (
    hashResultContent(input.submission_source) !==
      evidence.result_content_sha256 ||
    expectedImportRunId(evidence) !== evidence.import_run_id
  ) {
    throw new Error(
      "import evidence identity does not match the submitted result bytes",
    );
  }
}

const passingGit: GitVerificationAdapter = {
  async resolveCommit() {
    return testCommit;
  },
  async isAncestor() {
    return true;
  },
  async readHeadCommit() {
    return testCommit;
  },
  async isWorktreeCleanExcludingFounder() {
    return true;
  },
  async listChangedFiles() {
    return ["src/domain/result.ts"];
  },
};
const passingRunner: VerificationRunner = {
  async run(command: VerificationCommand) {
    return {
      name: command.name,
      argv: command.argv,
      started_at: "2026-07-21T21:00:00.000Z",
      completed_at: "2026-07-21T21:00:01.000Z",
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

function createController(
  repository: ProductWorkspace,
  git: GitVerificationAdapter = passingGit,
  runner: VerificationRunner = passingRunner,
) {
  const controller = new WorkItemController(repository, fixedClock, git, runner);
  return Object.assign(controller, {
    updateGoalContract(
      workItemId: string,
      input: (typeof firstContract) & {
        expected_goal_version?: number;
        expected_input_revision?: number;
      },
    ) {
      return controller.saveWorkItem(workItemId, {
        target_source_id: "inbox",
        title: "Build the controller foundation",
        type: "Feature",
        priority: null,
        tags: [],
        notes: null,
        goal_contract: {
          purpose: "Keep controller transitions safe.",
          acceptance_criteria: input.acceptance_criteria,
          non_goals: ["Do not bypass the controller."],
          allowed_scope: input.allowed_scope,
          review_ready: input.review_ready,
        },
        ...(input.expected_goal_version === undefined
          ? {}
          : {
              expected_goal_version: input.expected_goal_version,
              expected_input_revision: input.expected_input_revision,
            }),
      });
    },
  });
}

async function createWorkspaceWith<TRepository extends ProductWorkspace>(
  createRepository: (root: string) => TRepository,
): Promise<{
  root: string;
  repository: TRepository;
}> {
  const root = await mkdtemp(join(tmpdir(), "product-studio-controller-"));
  createdRoots.push(root);
  const founderDirectory = join(root, ".founder");
  await mkdir(founderDirectory, { recursive: true });
  await writeFile(
    join(founderDirectory, "product.yaml"),
    stringify({
      schema_version: 2,
      product_name: "Controller Test",
      verification: {
        required_commands: [
          {
            name: "Tests",
            argv: ["npm", "test"],
            timeout_seconds: 120,
          },
          {
            name: "Typecheck",
            argv: ["npm", "run", "typecheck"],
            timeout_seconds: 120,
          },
        ],
      },
    }),
    "utf8",
  );
  return {
    root,
    repository: createRepository(root),
  };
}

async function createWorkspace(): Promise<{
  root: string;
  repository: ProductWorkspace;
}> {
  return createWorkspaceWith(
    (root) =>
      new ProductWorkspace(root, {
        git: passingGit,
        verificationRunner: passingRunner,
      }),
  );
}

async function semanticRecordsForSource(
  root: string,
  workItemId: string,
  source: SemanticAuthoritativeSourceV1,
): Promise<
  Array<{ intent: SemanticEventIntentV1; event: SemanticEventV1 }>
> {
  const semanticDirectory = join(
    root,
    ".founder",
    "semantic-events",
    workItemId,
  );
  const intents = await Promise.all(
    (await readdir(join(semanticDirectory, "intents"))).map(async (entry) =>
      JSON.parse(
        await readFile(join(semanticDirectory, "intents", entry), "utf8"),
      ) as SemanticEventIntentV1,
    ),
  );
  const matchingIntents = new Map(
    intents
      .filter((intent) => JSON.stringify(intent.source) === JSON.stringify(source))
      .map((intent) => [intent.intent_id, intent]),
  );
  const events = await Promise.all(
    (await readdir(join(semanticDirectory, "events"))).map(async (entry) =>
      JSON.parse(
        await readFile(join(semanticDirectory, "events", entry), "utf8"),
      ) as SemanticEventV1,
    ),
  );
  return events.flatMap((event) => {
    const intent = matchingIntents.get(event.intent_id);
    return intent === undefined ? [] : [{ intent, event }];
  });
}

async function expectSemanticProducer(
  root: string,
  workItemId: string,
  source: SemanticAuthoritativeSourceV1,
  expected: Array<{
    kind: SemanticEventV1["kind"];
    slot: string;
    evidence_kind: SemanticEventV1["evidence"][number]["kind"];
    evidence_path: string;
  }>,
): Promise<Array<{ intent: SemanticEventIntentV1; event: SemanticEventV1 }>> {
  const records = await semanticRecordsForSource(root, workItemId, source);
  expect(
    records.map(({ intent, event }) => ({
      kind: event.kind,
      slot: intent.slot,
      evidence_kind: event.evidence[0].kind,
      evidence_path: event.evidence[0].path,
    })),
  ).toEqual(expected);
  for (const { event } of records) {
    for (const evidence of event.evidence) {
      expect(evidence.content_sha256).toBe(
        createHash("sha256")
          .update(await readFile(join(root, evidence.path)))
          .digest("hex"),
      );
    }
  }
  return records;
}

type CommitFailureBoundary = "pending_manifest" | "applied_manifest";

class BoundaryFailingShapingDecisionWorkspace extends ProductWorkspace {
  private failureBoundary: CommitFailureBoundary | null = null;

  constructor(root: string) {
    super(root, {
      git: passingGit,
      verificationRunner: passingRunner,
    });
  }

  armFailure(boundary: CommitFailureBoundary): void {
    this.failureBoundary = boundary;
  }

  protected override async afterShapingDecisionPendingManifestWritten(): Promise<void> {
    if (this.failureBoundary === "pending_manifest") {
      this.failureBoundary = null;
      throw new Error("injected failure after pending decision manifest");
    }
  }

  protected override async afterShapingDecisionStateReplaced(): Promise<void> {
    if (this.failureBoundary === "applied_manifest") {
      this.failureBoundary = null;
      throw new Error("injected failure before applied decision manifest");
    }
  }
}

type PlanApprovalCommitFailureBoundary =
  | "pending_manifest"
  | "state_replaced"
  | "before_applied_manifest";

class BoundaryFailingPlanApprovalWorkspace extends ProductWorkspace {
  private failureBoundary: PlanApprovalCommitFailureBoundary | null = null;

  constructor(root: string) {
    super(root, {
      git: passingGit,
      verificationRunner: passingRunner,
    });
  }

  armFailure(boundary: PlanApprovalCommitFailureBoundary): void {
    this.failureBoundary = boundary;
  }

  protected override async afterPlanApprovalPendingManifestWritten(): Promise<void> {
    if (this.failureBoundary === "pending_manifest") {
      this.failureBoundary = null;
      throw new Error("injected failure after Plan approval pending manifest");
    }
  }

  protected override async afterPlanApprovalStateReplaced(): Promise<void> {
    if (this.failureBoundary === "state_replaced") {
      this.failureBoundary = null;
      throw new Error("injected failure after Plan approval state replace");
    }
  }

  protected override async beforePlanApprovalAppliedManifestWritten(): Promise<void> {
    if (this.failureBoundary === "before_applied_manifest") {
      this.failureBoundary = null;
      throw new Error("injected failure before Plan approval applied manifest");
    }
  }
}

interface ImportTestRepository extends ProductWorkspace {
  readMissionResult(identity: MissionIdentity): Promise<MissionResultSnapshot>;
  readImportEvidence(
    identity: MissionIdentity,
    importRunId: string,
  ): Promise<StoredImportEvidence | null>;
  writeImportEvidence(
    input: ImportEvidenceWriteInput,
  ): Promise<ReturnType<typeof importEvidenceSummarySchema.parse>>;
}

async function governToExecute(
  repository: ProductWorkspace,
): Promise<{ workItem: WorkItem; manifest: ControllerRunManifest }> {
  const created = await createUncontractedItem(repository);
  const controller = createController(repository);
  let mutation = await controller.updateGoalContract(
    created.goal.work_item_id,
    firstContract,
  );
  for (const [index, targetPhase] of [
    "spec",
    "plan",
    "execute",
  ].entries()) {
    const current = mutation.work_item;
    const runId = `81000000-0000-4000-8000-00000000000${index}`;
    const idempotencyKey = deriveControllerIdempotencyKey(
      created.goal.work_item_id,
      targetPhase as "spec" | "plan" | "execute",
      current.state.goal_version!,
      current.state.input_revision!,
      current.state.attempt!,
    );
    const activeRun = {
      run_id: runId,
      idempotency_key: idempotencyKey,
      acquired_at: "2026-07-21T21:00:00.000Z",
    };
    const lease = await repository.acquireControllerLease(
      created.goal.work_item_id,
      activeRun,
    );
    if (lease === null) {
      throw new Error("Expected explicit governed fixture lease");
    }
    try {
      mutation = await repository.commitControllerMutation(lease, {
        semantic_event_intents: [],
        goal: current.goal,
        state: {
          ...current.state,
          phase: targetPhase as "spec" | "plan" | "execute",
          updated_at: new Date(
            Date.parse(current.state.updated_at) + 1,
          ).toISOString(),
        },
        manifest: {
          schema_version: 1,
          run_id: runId,
          work_item_id: created.goal.work_item_id,
          idempotency_key: idempotencyKey,
          phase: targetPhase as "spec" | "plan" | "execute",
          goal_version: current.state.goal_version!,
          input_revision: current.state.input_revision!,
          attempt: current.state.attempt!,
          started_at: activeRun.acquired_at,
          outcome: "pending",
        },
      });
    } finally {
      await repository.releaseControllerLease(lease);
    }
  }
  return { workItem: mutation.work_item, manifest: mutation.manifest };
}

async function createImportFixture(options?: {
  resultSource?: string;
  executionDefaults?: ExecutionDefaultsV1;
  missionScopeBaseCommit?: string;
  transformResult?: (
    result: ExecuteExternalResultSubmission,
  ) => ExecuteExternalResultSubmission;
}): Promise<{
  repository: ImportTestRepository;
  workItem: WorkItem;
  input: {
    expected_phase: "execute";
    expected_status: "active";
    expected_schema_version: 2;
    expected_goal_version: number;
    expected_input_revision: number;
    attempt: number;
  };
  evidence: Map<string, StoredImportEvidence>;
  evidenceWrites: { count: number };
}> {
  const { repository: workspace } = await createWorkspace();
  const { workItem, manifest } = await governToExecute(workspace);
  const identity = {
    phase: "execute" as const,
    work_item_id: workItem.goal.work_item_id,
    goal_version: workItem.state.goal_version!,
    input_revision: workItem.state.input_revision!,
    attempt: workItem.state.attempt!,
  };
  const artifact = await workspace.writeMissionPackage(identity, (paths) =>
    compileMission(
      workItem,
      manifest,
      options?.missionScopeBaseCommit === undefined
        ? paths
        : { ...paths, scope_base_commit: options.missionScopeBaseCommit },
      options?.executionDefaults,
    ),
  );
  const mission = artifact.mission;
  const defaultResult: ExecuteExternalResultSubmission = {
    result_schema_version: 2,
    mission_content_sha256: mission.content_sha256,
    identity,
    commit: testCommit,
    summary: "Implemented result import",
    changed_files: ["src/domain/result.ts"],
    verification: [{ name: "Tests", status: "passed" }],
  };
  const resultSource =
    options?.resultSource ??
    serializeExternalResult(
      options?.transformResult?.(defaultResult) ?? defaultResult,
    );
  const snapshot: MissionResultSnapshot = {
    mission,
    mission_path: artifact.mission_path,
    result_path: mission.result_contract.output_path,
    result_source: resultSource,
  };
  const evidence = new Map<string, StoredImportEvidence>();
  const evidenceWrites = { count: 0 };
  const repository = Object.assign(workspace, {
    async readMissionResult() {
      return snapshot;
    },
    async readImportEvidence(_identity: MissionIdentity, importRunId: string) {
      return evidence.get(importRunId) ?? null;
    },
    async writeImportEvidence(input: ImportEvidenceWriteInput) {
      assertProductionImportEvidenceContract(input);
      evidenceWrites.count += 1;
      const summary = importEvidenceSummarySchema.parse({
        phase: input.evidence.phase,
        import_run_id: input.evidence.import_run_id,
        outcome: input.evidence.outcome,
        evidence_path: `.founder/run-evidence/${identity.work_item_id}/execute-${identity.goal_version}-${identity.input_revision}-${identity.attempt}/${input.evidence.import_run_id}`,
        reasons: input.evidence.reasons,
      });
      evidence.set(input.evidence.import_run_id, {
        evidence: input.evidence,
        summary,
        verification: input.verification,
      });
      return summary;
    },
    async listImportEvidence() {
      return [...evidence.values()];
    },
  }) as ImportTestRepository;

  return {
    repository,
    workItem,
    input: {
      expected_phase: "execute",
      expected_status: "active",
      expected_schema_version: 2,
      expected_goal_version: identity.goal_version,
      expected_input_revision: identity.input_revision,
      attempt: identity.attempt,
    },
    evidence,
    evidenceWrites,
  };
}

async function createReviewImportFixture(options?: {
  resultSource?: string;
  patchCycle?: number;
  transformResult?: (
    result: ReviewExternalResultSubmission,
  ) => ReviewExternalResultSubmission;
  transformCurrentSubject?: (
    subject: ExecuteReviewSubject,
  ) => ExecuteReviewSubject;
}): Promise<{
  repository: ImportTestRepository;
  workItem: WorkItem;
  input: {
    expected_phase: "review";
    expected_status: "active";
    expected_schema_version: 2;
    expected_goal_version: number;
    expected_input_revision: number;
    attempt: number;
    expected_patch_cycle: number;
  };
  evidence: Map<string, StoredImportEvidence>;
  evidenceWrites: { count: number };
  snapshot: MissionResultSnapshot;
}> {
  const { repository: workspace } = await createWorkspace();
  const execute = await governToExecute(workspace);
  const controller = createController(workspace);
  const transitioned = await controller.transition(
    execute.workItem.goal.work_item_id,
    {
      target_phase: "review",
      target_status: "active",
      expected_phase: "execute",
      expected_status: "active",
      expected_schema_version: 2,
      expected_goal_version: execute.workItem.state.goal_version!,
      expected_input_revision: execute.workItem.state.input_revision!,
      attempt: execute.workItem.state.attempt!,
    },
  );
  let workItem = transitioned.work_item;
  if (options?.patchCycle !== undefined) {
    const activeRun = {
      run_id: `90000000-0000-4000-8000-00000000000${options.patchCycle}`,
      idempotency_key: `test-fixture-patch-cycle-${options.patchCycle}`,
      acquired_at: "2026-07-21T21:00:00.000Z",
    };
    const lease = await workspace.acquireControllerLease(
      workItem.goal.work_item_id,
      activeRun,
    );
    if (lease === null) {
      throw new Error("Patch-cycle fixture requires a durable work item.");
    }
    const nextItem = workItemSchema.parse({
      goal: workItem.goal,
      state: {
        ...workItem.state,
        patch_cycle: options.patchCycle,
      },
    });
    try {
      const mutation = await workspace.commitControllerMutation(lease, {
        semantic_event_intents: [],
        goal: nextItem.goal,
        state: nextItem.state,
        manifest: {
          schema_version: 1,
          run_id: activeRun.run_id,
          work_item_id: nextItem.goal.work_item_id,
          idempotency_key: activeRun.idempotency_key,
          phase: "review",
          goal_version: nextItem.state.goal_version!,
          input_revision: nextItem.state.input_revision!,
          attempt: nextItem.state.attempt!,
          started_at: activeRun.acquired_at,
          outcome: "pending",
        },
      });
      workItem = mutation.work_item;
    } finally {
      await workspace.releaseControllerLease(lease);
    }
  }
  const identity = {
    phase: "review" as const,
    work_item_id: workItem.goal.work_item_id,
    goal_version: workItem.state.goal_version!,
    input_revision: workItem.state.input_revision!,
    attempt: workItem.state.attempt!,
  };
  const commandEvidence = [
    {
      name: "Tests",
      argv: ["npm", "test"] as [string, ...string[]],
      started_at: "2026-07-21T20:58:00.000Z",
      completed_at: "2026-07-21T20:58:01.000Z",
      duration_ms: 1_000,
      status: "passed" as const,
      exit_code: 0 as const,
      signal: null,
      stdout: "green",
      stderr: "",
      output_truncated: false,
    },
    {
      name: "Typecheck",
      argv: ["npm", "run", "typecheck"] as [string, ...string[]],
      started_at: "2026-07-21T20:58:01.000Z",
      completed_at: "2026-07-21T20:58:02.000Z",
      duration_ms: 1_000,
      status: "passed" as const,
      exit_code: 0 as const,
      signal: null,
      stdout: "green",
      stderr: "",
      output_truncated: false,
    },
  ];
  const subject: ExecuteReviewSubject = {
    source: "execute",
    execute_mission_content_sha256: "1".repeat(64),
    execute_result_content_sha256: "2".repeat(64),
    git_base_commit: "0".repeat(40),
    accepted_result_commit: testCommit,
    changed_files: ["src/domain/result.ts"],
    execute_mission_path: `.founder/missions/${identity.work_item_id}/execute-1-1-0/mission.json`,
    execute_evidence_path: `.founder/run-evidence/${identity.work_item_id}/execute-1-1-0/${"3".repeat(64)}`,
    command_evidence: commandEvidence,
  };
  const paths = {
    task_path: `.founder/missions/${identity.work_item_id}/review-${identity.goal_version}-${identity.input_revision}-${identity.attempt}/TASK.md`,
    output_path: `.founder/missions/${identity.work_item_id}/review-${identity.goal_version}-${identity.input_revision}-${identity.attempt}/result.json`,
    git_base_commit: subject.git_base_commit,
  };
  const mission = compileReviewMission({
    work_item: workItem,
    controller_run: {
      schema_version: 1,
      run_id: "77777777-7777-4777-8777-777777777777",
      work_item_id: identity.work_item_id,
      idempotency_key: `${identity.work_item_id}:review:1:1:0:mission`,
      phase: "review",
      goal_version: identity.goal_version,
      input_revision: identity.input_revision,
      attempt: identity.attempt,
      started_at: "2026-07-21T20:59:00.000Z",
      completed_at: "2026-07-21T20:59:01.000Z",
      outcome: "applied",
    },
    review_subject: subject,
    paths,
    independence_attested: true,
  });
  const defaultResult: ReviewExternalResultSubmission = {
    result_schema_version: 2,
    review_mission_content_sha256: mission.content_sha256,
    identity,
    execute_mission_content_sha256:
      subject.execute_mission_content_sha256,
    execute_result_content_sha256: subject.execute_result_content_sha256,
    git_base_commit: subject.git_base_commit,
    accepted_result_commit: subject.accepted_result_commit,
    summary: "Review found no blocking issues.",
    verdict: "clean",
    findings: [],
  };
  const resultSource =
    options?.resultSource ??
    serializeExternalResult(
      options?.transformResult?.(defaultResult) ?? defaultResult,
    );
  const snapshot: MissionResultSnapshot = {
    mission,
    mission_path: paths.task_path.replace(/TASK\.md$/, "mission.json"),
    result_path: paths.output_path,
    result_source: resultSource,
  };
  const evidence = new Map<string, StoredImportEvidence>();
  const evidenceWrites = { count: 0 };
  const appliedSubject: AppliedExecuteReviewSubject = {
    review_subject:
      options?.transformCurrentSubject?.(subject) ?? subject,
    submission_source: "{\"execute\":\"result\"}\n",
    evidence: {
      schema_version: 2,
      phase: "execute",
      import_run_id: "3".repeat(64),
      result_content_sha256: subject.execute_result_content_sha256,
      mission_content_sha256: subject.execute_mission_content_sha256,
      identity: { ...identity, phase: "execute" },
      git_base_commit: subject.git_base_commit,
      result_commit: subject.accepted_result_commit,
      controller_run_id: transitioned.manifest.run_id,
      started_at: "2026-07-21T20:58:00.000Z",
      completed_at: "2026-07-21T20:58:02.000Z",
      outcome: "applied",
      reasons: [],
    },
    verification: commandEvidence,
  };
  const repository = Object.assign(workspace, {
    async readMissionResult() {
      return snapshot;
    },
    async readAppliedExecuteReviewSubject() {
      return appliedSubject;
    },
    async readImportEvidence(_identity: MissionIdentity, importRunId: string) {
      return evidence.get(importRunId) ?? null;
    },
    async writeImportEvidence(input: ImportEvidenceWriteInput) {
      assertProductionImportEvidenceContract(input);
      evidenceWrites.count += 1;
      const evidenceIdentity = input.evidence.identity;
      const patchCycleSuffix =
        input.evidence.phase === "patch"
          ? `-${input.evidence.identity.patch_cycle}`
          : "";
      const summary = importEvidenceSummarySchema.parse({
        phase: input.evidence.phase,
        import_run_id: input.evidence.import_run_id,
        outcome: input.evidence.outcome,
        evidence_path: `.founder/run-evidence/${evidenceIdentity.work_item_id}/${input.evidence.phase}-${evidenceIdentity.goal_version}-${evidenceIdentity.input_revision}-${evidenceIdentity.attempt}${patchCycleSuffix}/${input.evidence.import_run_id}`,
        reasons: input.evidence.reasons,
      });
      evidence.set(input.evidence.import_run_id, {
        evidence: input.evidence,
        summary,
        verification: input.verification,
      });
      return summary;
    },
    async listImportEvidence() {
      return [...evidence.values()];
    },
  }) as ImportTestRepository;

  return {
    repository,
    workItem,
    input: {
      expected_phase: "review",
      expected_status: "active",
      expected_schema_version: 2,
      expected_goal_version: identity.goal_version,
      expected_input_revision: identity.input_revision,
      attempt: identity.attempt,
      expected_patch_cycle: workItem.state.patch_cycle!,
    },
    evidence,
    evidenceWrites,
    snapshot,
  };
}

async function createPatchImportFixture(options?: {
  severity?: "P0" | "P1" | "P2" | "P3";
  transformPatchResult?: (
    result: PatchExternalResultSubmission,
  ) => PatchExternalResultSubmission;
}): Promise<{
  repository: ImportTestRepository;
  workItem: WorkItem;
  input: {
    expected_phase: "patch";
    expected_status: "active";
    expected_schema_version: 2;
    expected_goal_version: number;
    expected_input_revision: number;
    attempt: number;
    expected_patch_cycle: number;
  };
  evidence: Map<string, StoredImportEvidence>;
  evidenceWrites: { count: number };
  patchSnapshot: MissionResultSnapshot;
  reviewSnapshot: MissionResultSnapshot;
}> {
  const reviewFixture = await createReviewImportFixture({
    transformResult: (result) => ({
      ...result,
      summary: "Review found one bounded correction.",
      verdict: "findings",
      findings: [
        {
          finding_id: "F-1",
          severity: options?.severity ?? "P1",
          title: "Preserve immutable evidence",
          evidence: {
            path: "src/application/work-item-controller.ts",
            summary: "The patch must preserve evidence before mutation.",
          },
          required_action: "Keep patch import recovery deterministic.",
          link: {
            type: "acceptance_criteria",
            criterion: "Reject stale transitions",
          },
        },
      ],
    }),
  });
  const controller = createController(reviewFixture.repository);
  const importedReview = await controller.importReviewResult(
    reviewFixture.workItem.goal.work_item_id,
    reviewFixture.input,
  );
  const accepted = await controller.acceptPatchPlan(
    reviewFixture.workItem.goal.work_item_id,
    {
      expected_phase: "review",
      expected_status: "active",
      expected_schema_version: 2,
      expected_goal_version: importedReview.work_item.state.goal_version!,
      expected_input_revision: importedReview.work_item.state.input_revision!,
      attempt: importedReview.work_item.state.attempt!,
      expected_patch_cycle: importedReview.work_item.state.patch_cycle!,
    },
  );
  const reviewResult = JSON.parse(
    reviewFixture.snapshot.result_source,
  ) as ReviewExternalResultSubmission;
  if (
    reviewResult.verdict !== "findings" ||
    reviewResult.findings.length === 0 ||
    reviewFixture.snapshot.mission.mission_schema_version !==
      MISSION_SCHEMA_VERSION ||
    !("review_subject" in reviewFixture.snapshot.mission)
  ) {
    throw new Error("Patch fixture requires an applied review with findings.");
  }
  const reviewEvidence = [...reviewFixture.evidence.values()].find(
    (stored) =>
      stored.evidence.phase === "review" &&
      stored.evidence.outcome === "applied",
  );
  if (reviewEvidence === undefined) {
    throw new Error("Patch fixture requires applied review evidence.");
  }
  const patchSubject: PatchSubject = {
    review_mission_content_sha256:
      reviewFixture.snapshot.mission.content_sha256,
    review_result_content_sha256: hashResultContent(
      reviewFixture.snapshot.result_source,
    ),
    review_mission_path: reviewFixture.snapshot.mission_path,
    review_result_path: reviewFixture.snapshot.result_path,
    review_evidence_path: reviewEvidence.summary.evidence_path,
    reviewed_commit: reviewResult.accepted_result_commit,
    findings: reviewResult.findings as PatchSubject["findings"],
    prior_review_subject: reviewFixture.snapshot.mission.review_subject,
  };
  const patchIdentity = {
    phase: "patch" as const,
    work_item_id: accepted.work_item.goal.work_item_id,
    goal_version: accepted.work_item.state.goal_version!,
    input_revision: accepted.work_item.state.input_revision!,
    attempt: accepted.work_item.state.attempt!,
    patch_cycle: accepted.work_item.state.patch_cycle!,
  };
  const patchPaths = {
    task_path: `.founder/missions/${patchIdentity.work_item_id}/patch-${patchIdentity.goal_version}-${patchIdentity.input_revision}-${patchIdentity.attempt}-${patchIdentity.patch_cycle}/TASK.md`,
    output_path: `.founder/missions/${patchIdentity.work_item_id}/patch-${patchIdentity.goal_version}-${patchIdentity.input_revision}-${patchIdentity.attempt}-${patchIdentity.patch_cycle}/result.json`,
    git_base_commit: patchSubject.reviewed_commit,
  };
  const patchMission = compilePatchMission({
    work_item: accepted.work_item,
    controller_run: {
      schema_version: 1,
      run_id: "88888888-8888-4888-8888-888888888888",
      work_item_id: patchIdentity.work_item_id,
      idempotency_key: `${patchIdentity.work_item_id}:patch:${patchIdentity.patch_cycle}:mission`,
      phase: "patch",
      goal_version: patchIdentity.goal_version,
      input_revision: patchIdentity.input_revision,
      attempt: patchIdentity.attempt,
      started_at: "2026-07-21T21:00:01.000Z",
      completed_at: "2026-07-21T21:00:02.000Z",
      outcome: "applied",
    },
    patch_subject: patchSubject,
    paths: patchPaths,
  });
  const defaultPatchResult: PatchExternalResultSubmission = {
    result_schema_version: 2,
    patch_mission_content_sha256: patchMission.content_sha256,
    identity: patchIdentity,
    commit: testCommit,
    summary: "Applied the bounded correction.",
    changed_files: ["src/domain/result.ts"],
    verification: [{ name: "Tests", status: "passed" }],
  };
  const patchSnapshot: MissionResultSnapshot = {
    mission: patchMission,
    mission_path: patchPaths.task_path.replace(/TASK\.md$/, "mission.json"),
    result_path: patchPaths.output_path,
    result_source: serializeExternalResult(
      options?.transformPatchResult?.(defaultPatchResult) ?? defaultPatchResult,
    ),
  };
  Object.assign(reviewFixture.repository, {
    async readMissionResult(identity: MissionIdentity) {
      return identity.phase === "patch"
        ? patchSnapshot
        : reviewFixture.snapshot;
    },
  });

  return {
    repository: reviewFixture.repository,
    workItem: accepted.work_item,
    input: {
      expected_phase: "patch",
      expected_status: "active",
      expected_schema_version: 2,
      expected_goal_version: patchIdentity.goal_version,
      expected_input_revision: patchIdentity.input_revision,
      attempt: patchIdentity.attempt,
      expected_patch_cycle: patchIdentity.patch_cycle,
    },
    evidence: reviewFixture.evidence,
    evidenceWrites: reviewFixture.evidenceWrites,
    patchSnapshot,
    reviewSnapshot: reviewFixture.snapshot,
  };
}

async function createPatchReviewImportFixture(options: {
  verdict: "clean" | "findings";
  findings: PatchReviewExternalResultSubmission["findings"];
  resolutions: PatchReviewExternalResultSubmission["resolutions"];
}): Promise<{
  repository: ImportTestRepository;
  workItem: WorkItem;
  input: {
    expected_phase: "review";
    expected_status: "active";
    expected_schema_version: 2;
    expected_goal_version: number;
    expected_input_revision: number;
    attempt: number;
    expected_patch_cycle: number;
  };
}> {
  const patchFixture = await createPatchImportFixture();
  const importedPatch = await createController(
    patchFixture.repository,
  ).importPatchResult(
    patchFixture.workItem.goal.work_item_id,
    patchFixture.input,
  );
  const patchEvidence = [...patchFixture.evidence.values()].find(
    (stored) =>
      stored.evidence.phase === "patch" &&
      stored.evidence.outcome === "applied",
  );
  const patchResult = JSON.parse(
    patchFixture.patchSnapshot.result_source,
  ) as PatchExternalResultSubmission;
  if (
    patchEvidence === undefined ||
    patchEvidence.evidence.phase !== "patch" ||
    !("patch_subject" in patchFixture.patchSnapshot.mission)
  ) {
    throw new Error("Re-review fixture requires applied patch evidence.");
  }
  const patchMission = patchFixture.patchSnapshot.mission;
  const reviewSubject: PatchReviewSubject = {
    source: "patch",
    patch_cycle: patchResult.identity.patch_cycle,
    patch_mission_content_sha256: patchMission.content_sha256,
    patch_result_content_sha256: hashResultContent(
      patchFixture.patchSnapshot.result_source,
    ),
    patch_mission_path: patchFixture.patchSnapshot.mission_path,
    patch_evidence_path: patchEvidence.summary.evidence_path,
    git_base_commit: patchMission.source_revision.git_base_commit,
    accepted_result_commit: patchResult.commit,
    changed_files: [...patchResult.changed_files].sort(),
    command_evidence: patchEvidence.verification.map((record) => ({
      ...record,
      status: "passed" as const,
      started_at: record.started_at!,
      completed_at: record.completed_at!,
      exit_code: 0 as const,
      signal: null,
    })),
    resolved_from: {
      review_mission_content_sha256:
        patchMission.patch_subject.review_mission_content_sha256,
      review_result_content_sha256:
        patchMission.patch_subject.review_result_content_sha256,
      finding_ids: patchMission.patch_subject.findings.map(
        (finding) => finding.finding_id,
      ) as [string, ...string[]],
    },
  };
  const reviewIdentity = {
    phase: "review" as const,
    work_item_id: importedPatch.work_item.goal.work_item_id,
    goal_version: importedPatch.work_item.state.goal_version!,
    input_revision: importedPatch.work_item.state.input_revision!,
    attempt: importedPatch.work_item.state.attempt!,
  };
  const reviewPaths = {
    task_path: `.founder/missions/${reviewIdentity.work_item_id}/review-${reviewIdentity.goal_version}-${reviewIdentity.input_revision}-${reviewIdentity.attempt}-patch-${reviewSubject.patch_cycle}/TASK.md`,
    output_path: `.founder/missions/${reviewIdentity.work_item_id}/review-${reviewIdentity.goal_version}-${reviewIdentity.input_revision}-${reviewIdentity.attempt}-patch-${reviewSubject.patch_cycle}/result.json`,
    git_base_commit: reviewSubject.git_base_commit,
  };
  const reviewMission = compileReviewMission({
    work_item: importedPatch.work_item,
    controller_run: {
      schema_version: 1,
      run_id: "99999999-9999-4999-8999-999999999999",
      work_item_id: reviewIdentity.work_item_id,
      idempotency_key: `${reviewIdentity.work_item_id}:review:${reviewSubject.patch_cycle}:mission`,
      phase: "review",
      goal_version: reviewIdentity.goal_version,
      input_revision: reviewIdentity.input_revision,
      attempt: reviewIdentity.attempt,
      started_at: "2026-07-21T21:00:03.000Z",
      completed_at: "2026-07-21T21:00:04.000Z",
      outcome: "applied",
    },
    review_subject: reviewSubject,
    paths: reviewPaths,
    independence_attested: true,
  });
  const reviewResult: PatchReviewExternalResultSubmission = {
    result_schema_version: 2,
    review_mission_content_sha256: reviewMission.content_sha256,
    identity: reviewIdentity,
    patch_mission_content_sha256: reviewSubject.patch_mission_content_sha256,
    patch_result_content_sha256: reviewSubject.patch_result_content_sha256,
    git_base_commit: reviewSubject.git_base_commit,
    accepted_result_commit: reviewSubject.accepted_result_commit,
    summary: "Re-review recorded exact assigned-finding resolutions.",
    verdict: options.verdict,
    findings: options.findings,
    resolutions: options.resolutions,
  };
  const reviewSnapshot: MissionResultSnapshot = {
    mission: reviewMission,
    mission_path: reviewPaths.task_path.replace(/TASK\.md$/, "mission.json"),
    result_path: reviewPaths.output_path,
    result_source: serializeExternalResult(reviewResult),
  };
  Object.assign(patchFixture.repository, {
    async readMissionResult(identity: MissionIdentity) {
      return identity.phase === "patch"
        ? patchFixture.patchSnapshot
        : reviewSnapshot;
    },
    async readAppliedPatchReviewSubject() {
      return {
        review_subject: reviewSubject,
        submission_source: patchFixture.patchSnapshot.result_source,
        evidence: patchEvidence.evidence,
        verification: patchEvidence.verification,
      };
    },
  });

  return {
    repository: patchFixture.repository,
    workItem: importedPatch.work_item,
    input: {
      expected_phase: "review",
      expected_status: "active",
      expected_schema_version: 2,
      expected_goal_version: reviewIdentity.goal_version,
      expected_input_revision: reviewIdentity.input_revision,
      attempt: reviewIdentity.attempt,
      expected_patch_cycle: reviewSubject.patch_cycle,
    },
  };
}

async function createUncontractedItem(repository: ProductWorkspace) {
  return repository.create({
    title: "Build the controller foundation",
    type: "Feature",
  });
}

function shapingHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

async function writeAppliedControllerShapingBundle(
  repository: ProductWorkspace,
  artifact: StoredShapingArtifact,
  result:
    | BrainstormResultSubmission
    | SpecResultSubmission
    | PlanResultSubmission,
): Promise<string> {
  const missionDirectory = dirname(
    join(repository.workspaceRoot, artifact.mission_path),
  );
  const appliedDirectory = join(missionDirectory, "applied");
  const resultSource = `${JSON.stringify(result, null, 2)}\n`;
  const resultContentSha256 = shapingHash(resultSource);
  const ingressPath = `.founder/shaping-ingress/${artifact.mission.identity.work_item_id}/${artifact.mission.identity.phase}-${artifact.mission.identity.input_sha256}/result.json`;
  const importReceipt = {
    shaping_schema_version: 2 as const,
    identity: artifact.mission.identity,
    shaping_mission_content_sha256: artifact.mission.content_sha256,
    result_content_sha256: resultContentSha256,
    outcome: "applied" as const,
    first_published_at: "2026-08-02T11:00:00.000Z",
    reasons: [],
  };
  const productionReceipt = {
    schema_version: 1 as const,
    production_id: deriveManualShapingProductionId(
      artifact.mission.content_sha256,
      resultContentSha256,
    ),
    origin: "manual_import" as const,
    shaping_run_id: null,
    produced_at: "2026-08-02T11:00:01.000Z",
    requested_model: { value: null, assurance: "unknown" as const },
    effective_model: {
      assurance: "unknown" as const,
      model_id: null,
      deployment_id: null,
      observed_event_sha256: null,
    },
    ingress_path: ingressPath,
    result_content_sha256: resultContentSha256,
  };
  const importSource = `${JSON.stringify(importReceipt, null, 2)}\n`;
  const productionSource = `${JSON.stringify(productionReceipt, null, 2)}\n`;
  const marker = {
    schema_version: 1 as const,
    mission_content_sha256: artifact.mission.content_sha256,
    result_content_sha256: resultContentSha256,
    component_sha256: {
      result: resultContentSha256,
      import: shapingHash(importSource),
      production: shapingHash(productionSource),
    },
    component_bytes: {
      result: Buffer.byteLength(resultSource),
      import: Buffer.byteLength(importSource),
      production: Buffer.byteLength(productionSource),
    },
    committed_at: "2026-08-02T11:00:02.000Z",
  };
  await mkdir(appliedDirectory);
  await writeFile(join(appliedDirectory, "result.json"), resultSource, "utf8");
  await writeFile(join(appliedDirectory, "import.json"), importSource, "utf8");
  await writeFile(
    join(appliedDirectory, "production.json"),
    productionSource,
    "utf8",
  );
  await writeFile(
    join(appliedDirectory, "applied.json"),
    `${JSON.stringify(marker, null, 2)}\n`,
    "utf8",
  );
  return resultContentSha256;
}

function shapingResultForMission(
  mission: ShapingMissionPackage,
): BrainstormResultSubmission | SpecResultSubmission | PlanResultSubmission {
  switch (mission.identity.phase) {
    case "brainstorm":
      return {
        result_schema_version: 1,
        brainstorm_mission_content_sha256: mission.content_sha256,
        identity: mission.identity,
        problem_statement: "The current workflow lacks a durable guided handoff.",
        approach: "Publish one immutable result and advance through leased decisions.",
        non_goals: ["Do not authorize Execute."],
        open_questions: ["Which evidence should the next seat verify?"],
      };
    case "spec":
      return {
        result_schema_version: 1,
        spec_mission_content_sha256: mission.content_sha256,
        identity: mission.identity,
        proposal: {
          purpose: "Make shaping handoffs durable and replayable.",
          acceptance_criteria: ["Each decision commits exactly once."],
          non_goals: ["Do not launch from the controller."],
          allowed_scope: ["src/application", "tests/application"],
          review_ready: ["The focused controller suite passes."],
        },
      };
    case "plan":
      return {
        result_schema_version: 1,
        plan_mission_content_sha256: mission.content_sha256,
        identity: mission.identity,
        summary: "Implement the approved shaping handoff in bounded steps.",
        checklist: [
          {
            id: "controller",
            step: "Implement the leased composite decision.",
            verification_check: "Run the focused controller suite.",
          },
        ],
        relevant_skills: [],
        product_doc_impacts: [],
        todo_impacts: [],
        open_questions: [],
      };
  }
}

async function currentShapingStateHash(
  repository: ProductWorkspace,
  item: WorkItem,
): Promise<string> {
  const phase = item.state.phase;
  const tip = isShapingPhase(phase)
    ? await repository.resolveCurrentMissionRevision(
        item.goal.work_item_id,
        phase,
      )
    : null;
  const runs = await repository.listShapingRuns(item.goal.work_item_id);
  const currentRuns =
    tip === null
      ? []
      : runs.filter(
          (run) =>
            run.lifecycle.status !== "terminal" &&
            run.mission.phase === tip.mission.identity.phase &&
            run.mission.input_sha256 === tip.mission.identity.input_sha256 &&
            run.mission.content_sha256 === tip.mission.content_sha256,
        );
  return hashShapingDecisionState({
    work_item_id: item.goal.work_item_id,
    phase,
    status: item.state.status,
    goal_input_sha256: hashGoalInput({
      title: item.goal.title,
      notes: item.goal.notes,
    }),
    goal_version: item.state.goal_version ?? null,
    input_revision: item.state.input_revision ?? null,
    goal_contract_sha256:
      item.goal.goal_contract === undefined
        ? null
        : hashGoalContract(item.goal.goal_contract),
    current_mission_input_sha256:
      tip?.mission.identity.input_sha256 ?? null,
    current_mission_content_sha256: tip?.mission.content_sha256 ?? null,
    applied_result_content_sha256:
      tip?.result?.result_content_sha256 ?? null,
    decision_receipt_sha256:
      tip?.decision?.decision_content_sha256 ?? null,
    active_shaping_run_id: currentRuns[0]?.shaping_run_id ?? null,
  });
}

async function currentShapingTip(
  repository: ProductWorkspace,
  item: WorkItem,
): Promise<StoredShapingArtifact> {
  const phase = item.state.phase as ShapingPhase;
  const tip = await repository.resolveCurrentMissionRevision(
    item.goal.work_item_id,
    phase,
  );
  if (tip === null) {
    throw new Error(`Expected a ${phase} shaping tip`);
  }
  return tip;
}

function createControllerAt(
  repository: ProductWorkspace,
  timestamp: string,
): WorkItemController {
  return new WorkItemController(
    repository,
    () => new Date(timestamp),
    passingGit,
    passingRunner,
  );
}

async function createAppliedBrainstormDecisionFixture(
  repository: ProductWorkspace,
) {
  const initial = await createUncontractedItem(repository);
  const controller = createController(repository);
  const started = await controller.startBrainstorm(
    initial.goal.work_item_id,
    {
      launch_mode: "manual",
      next_requested_model: null,
      expected_mission_content_sha256: null,
      expected_result_content_sha256: null,
      expected_shaping_state_sha256: await currentShapingStateHash(
        repository,
        initial,
      ),
    },
  );
  const tip = await currentShapingTip(repository, started.work_item);
  const resultContentSha256 = await writeAppliedControllerShapingBundle(
    repository,
    tip,
    shapingResultForMission(tip.mission),
  );
  return {
    initial,
    started,
    tip,
    resultContentSha256,
    input: {
      launch_mode: "manual" as const,
      next_requested_model: null,
      expected_mission_content_sha256: tip.mission.content_sha256,
      expected_result_content_sha256: resultContentSha256,
      expected_shaping_state_sha256: await currentShapingStateHash(
        repository,
        started.work_item,
      ),
    },
  };
}

async function createAppliedSpecDecisionFixture(
  repository: ProductWorkspace,
  options: { allowedScope?: string[] } = {},
) {
  const brainstorm = await createAppliedBrainstormDecisionFixture(repository);
  const used = await createController(repository).useBrainstormResult(
    brainstorm.started.work_item.goal.work_item_id,
    brainstorm.input,
  );
  const tip = await currentShapingTip(repository, used.work_item);
  const baseResult = shapingResultForMission(
    tip.mission,
  ) as SpecResultSubmission;
  const result: SpecResultSubmission = {
    ...baseResult,
    proposal: {
      ...baseResult.proposal,
      allowed_scope: options.allowedScope ?? baseResult.proposal.allowed_scope,
    },
  };
  const resultContentSha256 = await writeAppliedControllerShapingBundle(
    repository,
    tip,
    result,
  );
  return {
    ...brainstorm,
    used,
    tip,
    result,
    resultContentSha256,
    input: {
      launch_mode: "manual" as const,
      next_requested_model: null,
      expected_mission_content_sha256: tip.mission.content_sha256,
      expected_result_content_sha256: resultContentSha256,
      expected_shaping_state_sha256: await currentShapingStateHash(
        repository,
        used.work_item,
      ),
      goal_contract_sha256: hashGoalContract(
        goalContractFromSpecProposal(result.proposal, 1),
      ),
    },
  };
}

async function createAppliedPlanDecisionFixture(
  repository: ProductWorkspace,
  options: { applyResult?: boolean; allowedScope?: string[] } = {},
) {
  const spec = await createAppliedSpecDecisionFixture(repository, options);
  const approved = await createController(repository).approveSpecResult(
    spec.used.work_item.goal.work_item_id,
    spec.input,
  );
  const tip = await currentShapingTip(repository, approved.work_item);
  if (tip.mission.identity.phase !== "plan") {
    throw new Error("Expected the approved Spec to publish a Plan mission");
  }
  const result = shapingResultForMission(tip.mission) as PlanResultSubmission;
  const resultContentSha256 =
    options.applyResult === false
      ? "d".repeat(64)
      : await writeAppliedControllerShapingBundle(
          repository,
          tip,
          result,
        );
  const goalContract = approved.work_item.goal.goal_contract;
  if (goalContract === undefined) {
    throw new Error("Expected the approved Spec to create a goal contract");
  }
  return {
    ...spec,
    approved,
    tip,
    result,
    resultContentSha256,
    input: {
      launch_mode: "manual" as const,
      requested_model: null,
      expected_mission_content_sha256: tip.mission.content_sha256,
      expected_result_content_sha256: resultContentSha256,
      expected_shaping_state_sha256: await currentShapingStateHash(
        repository,
        approved.work_item,
      ),
      goal_contract_sha256: hashGoalContract(goalContract),
    },
  };
}

async function readOptionalFixtureFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function listOptionalFixtureDirectory(
  path: string,
): Promise<string[] | null> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function capturePlanApprovalDurableState(
  repository: ProductWorkspace,
  workItemId: string,
) {
  const itemDirectory = join(
    repository.workspaceRoot,
    ".founder",
    "work-items",
    workItemId,
  );
  const artifacts = await repository.listShapingArtifacts(workItemId);
  const decisions = await Promise.all(
    artifacts
      .filter((artifact) => artifact.mission.identity.phase === "plan")
      .map(async (artifact) => {
        const path = join(
          dirname(join(repository.workspaceRoot, artifact.mission_path)),
          "decision.json",
        );
        return [path, await readOptionalFixtureFile(path)] as const;
      }),
  );
  const approvalDirectory = join(itemDirectory, "plan-approvals");
  const approvalEntries = await listOptionalFixtureDirectory(
    approvalDirectory,
  );
  const approvalFiles =
    approvalEntries === null
      ? []
      : await Promise.all(
          approvalEntries.map(async (entry) => [
            entry,
            await readFile(join(approvalDirectory, entry), "utf8"),
          ] as const),
        );
  return {
    goal: await readFile(join(itemDirectory, "goal.yaml"), "utf8"),
    state: await readFile(join(itemDirectory, "state.json"), "utf8"),
    decisions,
    approvalEntries,
    approvalFiles,
  };
}

async function expectPlanApprovalRejectionWithoutMutation(
  repository: ProductWorkspace,
  workItemId: string,
  input: Parameters<WorkItemController["approvePlanResult"]>[1],
  kind: string,
) {
  const before = await capturePlanApprovalDurableState(
    repository,
    workItemId,
  );
  await expect(
    createController(repository).approvePlanResult(workItemId, input),
  ).rejects.toMatchObject({ kind });
  expect(
    await capturePlanApprovalDurableState(repository, workItemId),
  ).toEqual(before);
}

function injectPlanApprovalResponseLoss(
  repository: ProductWorkspace,
  boundary: "after_intent" | "after_receipt",
): void {
  if (boundary === "after_intent") {
    const writeIntent = repository.writePlanApprovalIntent.bind(repository);
    let fail = true;
    repository.writePlanApprovalIntent = async (lease, input) => {
      const written = await writeIntent(lease, input);
      if (fail) {
        fail = false;
        throw new Error("injected response loss after Plan approval intent");
      }
      return written;
    };
    return;
  }

  const writeReceipt = repository.writeShapingDecisionReceipt.bind(repository);
  let fail = true;
  repository.writeShapingDecisionReceipt = async (receipt) => {
    const written = await writeReceipt(receipt);
    if (fail && written.receipt.identity.phase === "plan") {
      fail = false;
      throw new Error("injected response loss after Plan approval receipt");
    }
    return written;
  };
}

type ShapingResponseLossBoundary =
  | "before_intent"
  | "after_intent"
  | "after_receipt"
  | "after_mission"
  | "after_applied_manifest";

function injectShapingResponseLoss(
  repository: ProductWorkspace,
  boundary: ShapingResponseLossBoundary,
): void {
  if (boundary === "before_intent" || boundary === "after_intent") {
    const writeIntent =
      repository.writeShapingDecisionIntent.bind(repository);
    let fail = true;
    repository.writeShapingDecisionIntent = async (lease, input) => {
      if (fail && boundary === "before_intent") {
        fail = false;
        throw new Error("injected response loss before shaping intent");
      }
      const written = await writeIntent(lease, input);
      if (fail) {
        fail = false;
        throw new Error("injected response loss after shaping intent");
      }
      return written;
    };
    return;
  }

  if (boundary === "after_receipt") {
    const writeReceipt =
      repository.writeShapingDecisionReceipt.bind(repository);
    let fail = true;
    repository.writeShapingDecisionReceipt = async (receipt) => {
      const written = await writeReceipt(receipt);
      if (fail) {
        fail = false;
        throw new Error("injected response loss after decision receipt");
      }
      return written;
    };
    return;
  }

  if (boundary === "after_mission") {
    const publishMission =
      repository.publishLeasedShapingMission.bind(repository);
    let fail = true;
    repository.publishLeasedShapingMission = async (
      lease,
      identity,
      missionBytes,
      input,
    ) => {
      const written = await publishMission(
        lease,
        identity,
        missionBytes,
        input,
      );
      if (fail) {
        fail = false;
        throw new Error("injected response loss after shaping mission");
      }
      return written;
    };
    return;
  }

  const commit = repository.commitShapingDecision.bind(repository);
  let fail = true;
  repository.commitShapingDecision = async (lease, input) => {
    const committed = await commit(lease, input);
    if (fail) {
      fail = false;
      throw new Error("injected response loss after applied manifest");
    }
    return committed;
  };
}

function shapingRunInputForMission(
  mission: ShapingMissionPackage,
  requestedModel: string,
): ShapingRunCreateInput {
  return {
    mission,
    record: {
      schema_version: 1,
      shaping_run_id: "90000000-0000-4000-8000-000000000013",
      mission: {
        phase: mission.identity.phase,
        work_item_id: mission.identity.work_item_id,
        input_sha256: mission.identity.input_sha256,
        content_sha256: mission.content_sha256,
      },
      provenance: {
        role: { value: "writer", assurance: "controller_observed" },
        seat: {
          value: mission.identity.phase,
          assurance: "controller_observed",
        },
        requested_model: {
          value: requestedModel,
          assurance: "user_declared",
        },
        effective_model: {
          assurance: "unknown",
          model_id: null,
          deployment_id: null,
          observed_event_sha256: null,
        },
        effort: { value: "high", assurance: "user_declared" },
        harness: {
          value: { id: "local-agent-cli", version: "1.0.0" },
          assurance: "adapter_attested",
        },
        adapter_profile: {
          value: {
            adapter_id: "local-acp-adapter",
            adapter_version: "1.0.0",
            profile_id: "artifact-only-shaping-v1",
          },
          assurance: "adapter_attested",
        },
        resolved_profile_sha256: {
          value: "a".repeat(64),
          assurance: "controller_observed",
        },
        resolved_skill_set_sha256: {
          value: "b".repeat(64),
          assurance: "controller_observed",
        },
      },
      lifecycle: {
        status: "starting",
        started_at: "2026-08-02T12:00:00.000Z",
        updated_at: "2026-08-02T12:00:00.000Z",
        completed_at: null,
        terminal: null,
      },
      limits: {
        wall_clock_timeout_ms: 900_000,
        max_event_count: 100,
        max_event_bytes: 100_000,
        max_output_bytes: 10_000,
        termination_grace_ms: 5_000,
        drain_grace_ms: 1_000,
      },
      process: null,
      diagnostics: { entries: [], truncated: false },
    },
  };
}

const firstContract = {
  acceptance_criteria: ["Reject stale transitions"],
  allowed_scope: ["src/domain", "src/application"],
  review_ready: ["Deterministic checks pass"],
};

function reviewFinding(
  findingId: string,
): PatchReviewExternalResultSubmission["findings"][number] {
  return {
    finding_id: findingId,
    severity: "P1",
    title: `Blocking finding ${findingId}`,
    evidence: {
      path: "src/application/work-item-controller.ts",
      summary: `Finding ${findingId} remains observable.`,
    },
    required_action: `Resolve ${findingId} without widening scope.`,
    link: {
      type: "defect",
      evidence_summary: `Deterministic evidence for ${findingId}.`,
    },
  };
}

async function createConnectedFixture(): Promise<{
  repository: ProductWorkspace;
  workItem: WorkItem;
  controller: WorkItemController;
  input: {
    expected_phase: "execute";
    expected_status: "active";
    expected_schema_version: 2;
    run_ordinal: number;
    governed_tuple: {
      goal_version: number;
      input_revision: number;
      attempt: number;
      patch_cycle: number;
    };
    mission_content_sha256: string;
  };
  record: ConnectedRunRecordV2 & {
    authorization: Extract<
      ConnectedRunAuthorization,
      { kind: "capability_envelope" }
    >;
  };
}> {
  const { repository } = await createWorkspace();
  const { workItem, manifest } = await governToExecute(repository);
  const identity = {
    phase: "execute" as const,
    work_item_id: workItem.goal.work_item_id,
    goal_version: workItem.state.goal_version!,
    input_revision: workItem.state.input_revision!,
    attempt: workItem.state.attempt!,
  };
  const defaults: ExecutionDefaultsV1 = {
    schema_version: 1,
    approved_command_forms: [{ executable: "npm", args: ["run", "test"] }],
    approved_url_operations: [],
    mcp: "forbidden",
    credentials: "forbidden",
  };
  const artifact = await repository.writeMissionPackage(identity, (paths) =>
    compileMission(workItem, manifest, paths, defaults),
  );
  const envelope = resolveCapabilityEnvelope(
    workItem.goal.goal_contract!.allowed_scope,
    defaults,
  );
  const envelopeSha256 = hashResolvedCapabilityEnvelope(envelope);
  const input = {
    expected_phase: "execute" as const,
    expected_status: "active" as const,
    expected_schema_version: 2 as const,
    run_ordinal: 0,
    governed_tuple: {
      goal_version: identity.goal_version,
      input_revision: identity.input_revision,
      attempt: identity.attempt,
      patch_cycle: workItem.state.patch_cycle!,
    },
    mission_content_sha256: artifact.mission.content_sha256,
  };
  const record: ConnectedRunRecordV2 & {
    authorization: Extract<
      ConnectedRunAuthorization,
      { kind: "capability_envelope" }
    >;
  } = {
    schema_version: 2,
    connected_run_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1",
    mission: {
      identity,
      path: artifact.mission.task_path.replace(/TASK\.md$/, "mission.json"),
      content_sha256: artifact.mission.content_sha256,
      source_commit: artifact.mission.source_revision.git_base_commit,
    },
    governed_tuple: input.governed_tuple,
    provenance: {
      role: { value: "writer", assurance: "controller_observed" },
      seat: { value: "executor", assurance: "controller_observed" },
      requested_model: { value: "default", assurance: "user_declared" },
      effective_model: {
        assurance: "unknown",
        model_id: null,
        deployment_id: null,
        observed_event_sha256: null,
      },
      effort: { value: "high", assurance: "user_declared" },
      harness: {
        value: { id: "fake-acp", version: "1.0.0" },
        assurance: "controller_observed",
      },
      adapter_profile: {
        value: {
          adapter_id: "fake-acp",
          adapter_version: "1.0.0",
          profile_id: "test",
        },
        assurance: "controller_observed",
      },
      resolved_profile_sha256: {
        value: "b".repeat(64),
        assurance: "controller_observed",
      },
      resolved_skill_set_sha256: {
        value: "c".repeat(64),
        assurance: "controller_observed",
      },
      authorization_sha256: {
        value: "d".repeat(64),
        assurance: "controller_observed",
      },
    },
    authorization: {
      kind: "capability_envelope",
      envelope,
      envelope_sha256: envelopeSha256,
    },
    acp: {
      protocol_version: { value: 1, assurance: "adapter_attested" },
      session_id: { value: "test-session", assurance: "adapter_attested" },
    },
    lifecycle: {
      status: "starting",
      started_at: "2026-07-26T18:00:00.000Z",
      updated_at: "2026-07-26T18:00:00.000Z",
      completed_at: null,
      terminal: null,
    },
    limits: {
      wall_clock_timeout_ms: 60_000,
      max_event_count: 100,
      max_event_bytes: 100_000,
      max_output_bytes: 100_000,
      termination_grace_ms: 1_000,
      drain_grace_ms: 1_000,
    },
    process: null,
    diagnostics: { entries: [], truncated: false },
  };
  return {
    repository,
    workItem,
    controller: createController(repository),
    input,
    record,
  };
}

async function createPhaseConnectedFixture(
  phase: MissionPhase,
): Promise<{
  repository: ProductWorkspace;
  workItem: WorkItem;
  controller: WorkItemController;
  input: {
    expected_phase: MissionPhase;
    expected_status: "active";
    expected_schema_version: 2;
    run_ordinal: number;
    governed_tuple: {
      goal_version: number;
      input_revision: number;
      attempt: number;
      patch_cycle: number;
    };
    mission_content_sha256: string;
  };
  record: ConnectedRunRecordV2;
}> {
  const fixture = await createConnectedFixture();
  if (phase === "execute") {
    return fixture;
  }

  let workItem: WorkItem;
  let manifest: ControllerRunManifest;
  if (phase === "review") {
    const transitioned = await fixture.controller.transition(
      fixture.workItem.goal.work_item_id,
      {
        target_phase: "review",
        target_status: "active",
        expected_phase: "execute",
        expected_status: "active",
        expected_schema_version: 2,
        expected_goal_version: fixture.workItem.state.goal_version!,
        expected_input_revision: fixture.workItem.state.input_revision!,
        attempt: fixture.workItem.state.attempt!,
      },
    );
    workItem = transitioned.work_item;
    manifest = transitioned.manifest;
  } else {
    const activeRun = {
      run_id: "82000000-0000-4000-8000-000000000003",
      idempotency_key: "phase-qualified-patch-fixture",
      acquired_at: "2026-07-21T21:00:00.000Z",
    };
    const lease = await fixture.repository.acquireControllerLease(
      fixture.workItem.goal.work_item_id,
      activeRun,
    );
    if (lease === null) {
      throw new Error("Patch connected fixture requires a durable item.");
    }
    try {
      const mutation = await fixture.repository.commitControllerMutation(
        lease,
        {
          semantic_event_intents: [],
          goal: lease.work_item.goal,
          state: {
            ...lease.work_item.state,
            phase: "patch",
            patch_cycle: 1,
            updated_at: "2026-07-21T21:00:01.000Z",
          },
          manifest: {
            schema_version: 1,
            run_id: activeRun.run_id,
            work_item_id: lease.work_item.goal.work_item_id,
            idempotency_key: activeRun.idempotency_key,
            phase: "patch",
            goal_version: lease.work_item.state.goal_version!,
            input_revision: lease.work_item.state.input_revision!,
            attempt: lease.work_item.state.attempt!,
            started_at: activeRun.acquired_at,
            outcome: "pending",
          },
        },
      );
      workItem = mutation.work_item;
      manifest = mutation.manifest;
    } finally {
      await fixture.repository.releaseControllerLease(lease);
    }
  }

  const reviewSubject: ExecuteReviewSubject = {
    source: "execute",
    execute_mission_content_sha256: "1".repeat(64),
    execute_result_content_sha256: "2".repeat(64),
    git_base_commit: testCommit,
    accepted_result_commit: testCommit,
    changed_files: ["src/application/work-item-controller.ts"],
    execute_mission_path: `.founder/missions/${workItem.goal.work_item_id}/execute-1-1-0/mission.json`,
    execute_evidence_path: `.founder/run-evidence/${workItem.goal.work_item_id}/execute-1-1-0/${"3".repeat(64)}`,
    command_evidence: [
      {
        name: "Tests",
        argv: ["npm", "test"],
        started_at: "2026-07-21T20:58:00.000Z",
        completed_at: "2026-07-21T20:58:01.000Z",
        duration_ms: 1_000,
        status: "passed",
        exit_code: 0,
        signal: null,
        stdout: "green",
        stderr: "",
        output_truncated: false,
      },
    ],
  };
  const identity =
    phase === "review"
      ? {
          phase,
          work_item_id: workItem.goal.work_item_id,
          goal_version: workItem.state.goal_version!,
          input_revision: workItem.state.input_revision!,
          attempt: workItem.state.attempt!,
        }
      : {
          phase,
          work_item_id: workItem.goal.work_item_id,
          goal_version: workItem.state.goal_version!,
          input_revision: workItem.state.input_revision!,
          attempt: workItem.state.attempt!,
          patch_cycle: workItem.state.patch_cycle!,
        };
  const phaseSuffix =
    phase === "patch"
      ? `${phase}-${identity.goal_version}-${identity.input_revision}-${identity.attempt}-${identity.patch_cycle}`
      : `${phase}-${identity.goal_version}-${identity.input_revision}-${identity.attempt}`;
  const paths = {
    task_path: `.founder/missions/${identity.work_item_id}/${phaseSuffix}/TASK.md`,
    output_path: `.founder/missions/${identity.work_item_id}/${phaseSuffix}/result.json`,
    git_base_commit: testCommit,
  };
  const mission =
    phase === "review"
      ? compileReviewMission({
          work_item: workItem,
          controller_run: {
            ...manifest,
            phase: "review",
            outcome: "applied",
            completed_at: manifest.completed_at!,
          },
          review_subject: reviewSubject,
          paths,
          independence_attested: true,
        })
      : compilePatchMission({
          work_item: workItem,
          controller_run: {
            ...manifest,
            phase: "patch",
            outcome: "applied",
            completed_at: manifest.completed_at!,
          },
          patch_subject: {
            review_mission_content_sha256: "4".repeat(64),
            review_result_content_sha256: "5".repeat(64),
            review_mission_path: `.founder/missions/${identity.work_item_id}/review-1-1-0/mission.json`,
            review_result_path: `.founder/missions/${identity.work_item_id}/review-1-1-0/result.json`,
            review_evidence_path: `.founder/run-evidence/${identity.work_item_id}/review-1-1-0/${"6".repeat(64)}`,
            reviewed_commit: testCommit,
            findings: [reviewFinding("F-connected")],
            prior_review_subject: reviewSubject,
          },
          paths,
        });
  const missionPath = paths.task_path.replace(/TASK\.md$/u, "mission.json");
  const durableMissionPath = join(
    fixture.repository.workspaceRoot,
    ...missionPath.split("/"),
  );
  await mkdir(dirname(durableMissionPath), { recursive: true });
  await writeFile(
    durableMissionPath,
    serializeMissionPackage(mission),
    "utf8",
  );
  const originalReadMissionPackage =
    fixture.repository.readMissionPackage.bind(fixture.repository);
  fixture.repository.readMissionPackage = async (requestedIdentity) =>
    JSON.stringify(requestedIdentity) === JSON.stringify(identity)
      ? { mission, mission_path: missionPath }
      : originalReadMissionPackage(requestedIdentity);

  const governedTuple = {
    goal_version: identity.goal_version,
    input_revision: identity.input_revision,
    attempt: identity.attempt,
    patch_cycle: workItem.state.patch_cycle!,
  };
  let authorization: ConnectedRunAuthorization;
  if (phase === "review") {
    const policy: ReviewRunPolicy = {
      kind: "single_result_file",
      result_path: mission.result_contract.output_path,
      mission_result_binding_sha256:
        deriveReviewMissionResultBindingSha256(
          mission.content_sha256,
          mission.result_contract.output_path,
        ),
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
    };
    authorization = {
      kind: "review_result_ingress",
      result_path: policy.result_path,
      policy_sha256: hashReviewRunPolicy(policy),
    };
  } else {
    authorization = fixture.record.authorization;
  }
  const authorizationSha256 =
    authorization.kind === "capability_envelope"
      ? authorization.envelope_sha256
      : authorization.policy_sha256;
  const record: ConnectedRunRecordV2 = {
    ...fixture.record,
    connected_run_id:
      phase === "review"
        ? "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b2"
        : "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b3",
    mission: {
      identity,
      path: missionPath,
      content_sha256: mission.content_sha256,
      source_commit: mission.source_revision.git_base_commit,
    },
    governed_tuple: governedTuple,
    provenance: {
      ...fixture.record.provenance,
      role: {
        value: phase === "review" ? "reviewer" : "writer",
        assurance: "controller_observed",
      },
      seat: {
        value: phase === "review" ? "reviewer" : "executor",
        assurance: "controller_observed",
      },
      adapter_profile: {
        value: {
          adapter_id: "fake-acp",
          adapter_version: "1.0.0",
          profile_id:
            phase === "review"
              ? "noninteractive-review-v1"
              : "noninteractive-execute-v1",
        },
        assurance: "controller_observed",
      },
      authorization_sha256: {
        value: authorizationSha256,
        assurance: "controller_observed",
      },
    },
    authorization,
  };
  return {
    repository: fixture.repository,
    workItem,
    controller: fixture.controller,
    input: {
      expected_phase: phase,
      expected_status: "active",
      expected_schema_version: 2,
      run_ordinal: 0,
      governed_tuple: governedTuple,
      mission_content_sha256: mission.content_sha256,
    },
    record,
  };
}

function withoutRunOrdinal<TInput extends { run_ordinal: number }>(
  input: TInput,
): Omit<TInput, "run_ordinal"> {
  const { run_ordinal: _runOrdinal, ...expectation } = input;
  void _runOrdinal;
  return expectation;
}

afterEach(async () => {
  await Promise.all(
    createdRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("WorkItemController", () => {
  it("persists immutable connected-run evidence before releasing the launch lease", async () => {
    const fixture = await createConnectedFixture();
    const commit = fixture.repository.commitControllerMutation.bind(
      fixture.repository,
    );
    let recordExistedBeforeMutation = false;
    fixture.repository.commitControllerMutation = async (lease, input) => {
      recordExistedBeforeMutation =
        (await fixture.repository.readConnectedRun(
          fixture.workItem.goal.work_item_id,
          fixture.record.connected_run_id,
        )) !== null;
      return commit(lease, input);
    };

    const launched = await fixture.controller.launchConnectedExecute(
      fixture.workItem.goal.work_item_id,
      fixture.input,
      fixture.record,
    );

    expect(recordExistedBeforeMutation).toBe(true);
    expect(launched).toMatchObject({
      created: true,
      connected_run: { connected_run_id: fixture.record.connected_run_id },
      work_item: { state: { phase: "execute", status: "active" } },
    });
    expect(launched.work_item.state.active_run).toBeUndefined();

    const replay = await fixture.controller.launchConnectedExecute(
      fixture.workItem.goal.work_item_id,
      fixture.input,
      fixture.record,
    );
    expect(replay).toMatchObject({
      created: false,
      connected_run: { connected_run_id: fixture.record.connected_run_id },
    });
    expect(replay.work_item.state.active_run).toBeUndefined();
  });

  it("launches and replays one durable connected run per phase", async () => {
    const runIds = new Set<string>();
    for (const phase of ["execute", "review", "patch"] as const) {
      const fixture = await createPhaseConnectedFixture(phase);
      const launched = await fixture.controller.launchConnectedRun(
        fixture.workItem.goal.work_item_id,
        fixture.input,
        fixture.record,
      );
      const replay = await fixture.controller.launchConnectedRun(
        fixture.workItem.goal.work_item_id,
        fixture.input,
        fixture.record,
      );

      expect(launched.created).toBe(true);
      expect(launched.connected_run.mission.identity.phase).toBe(phase);
      expect(launched.manifest.phase).toBe(phase);
      expect(launched.work_item.state.active_run).toBeUndefined();
      expect(replay).toMatchObject({
        created: false,
        connected_run: {
          connected_run_id: launched.connected_run.connected_run_id,
        },
        manifest: { run_id: launched.manifest.run_id },
      });
      runIds.add(launched.manifest.run_id);
    }
    expect(runIds.size).toBe(3);
    const sharedIdempotencyKey = "shared-connected-launch-key";
    expect(
      new Set(
        (["execute", "review", "patch"] as const).map((phase) =>
          deriveControllerRunId(
            sharedIdempotencyKey,
            JSON.stringify({ operation: `launch_connected_${phase}` }),
          ),
        ),
      ).size,
    ).toBe(3);
  });

  it("rejects connected replay changes to phase, model, mission, tuple, or authorization", async () => {
    const fixture = await createPhaseConnectedFixture("execute");
    await fixture.controller.launchConnectedRun(
      fixture.workItem.goal.work_item_id,
      fixture.input,
      fixture.record,
    );
    const defaults: ExecutionDefaultsV1 = {
      schema_version: 1,
      approved_command_forms: [{ executable: "npm", args: ["run", "test"] }],
      approved_url_operations: [],
      mcp: "forbidden",
      credentials: "forbidden",
    };
    const narrowedEnvelope = resolveCapabilityEnvelope(["src"], defaults);
    const narrowedEnvelopeSha256 =
      hashResolvedCapabilityEnvelope(narrowedEnvelope);
    const changedAuthorization: ConnectedRunRecordV2 = {
      ...fixture.record,
      authorization: {
        kind: "capability_envelope",
        envelope: narrowedEnvelope,
        envelope_sha256: narrowedEnvelopeSha256,
      },
      provenance: {
        ...fixture.record.provenance,
        authorization_sha256: {
          value: narrowedEnvelopeSha256,
          assurance: "controller_observed",
        },
      },
    };
    const changedModel: ConnectedRunRecordV2 = {
      ...fixture.record,
      provenance: {
        ...fixture.record.provenance,
        requested_model: {
          value: "another-model",
          assurance: "user_declared",
        },
      },
    };
    const cases: Array<{
      input: typeof fixture.input;
      record: ConnectedRunRecordV2;
    }> = [
      {
        input: { ...fixture.input, expected_phase: "review" },
        record: fixture.record,
      },
      { input: fixture.input, record: changedModel },
      {
        input: {
          ...fixture.input,
          mission_content_sha256: "f".repeat(64),
        },
        record: fixture.record,
      },
      {
        input: {
          ...fixture.input,
          governed_tuple: {
            ...fixture.input.governed_tuple,
            attempt: fixture.input.governed_tuple.attempt + 1,
          },
        },
        record: fixture.record,
      },
      { input: fixture.input, record: changedAuthorization },
    ];

    for (const replay of cases) {
      await expect(
        fixture.controller.launchConnectedRun(
          fixture.workItem.goal.work_item_id,
          replay.input,
          replay.record,
        ),
      ).rejects.toBeInstanceOf(ControllerConflictError);
    }
  });

  it("keeps permission recovery phase-bound to writable runs and excludes Review", async () => {
    const patch = await createPhaseConnectedFixture("patch");
    await patch.controller.launchConnectedRun(
      patch.workItem.goal.work_item_id,
      patch.input,
      patch.record,
    );
    if (patch.record.authorization.kind !== "capability_envelope") {
      throw new Error("Patch fixture requires capability authorization.");
    }
    const request = {
      schema_version: 1 as const,
      kind: "command" as const,
      executable: "git",
      args: ["status"],
    };
    const operation = {
      normalized_operation: request,
      canonical_args_sha256: "e".repeat(64),
      operation_sha256: hashCanonicalCapabilityRequest(request),
      reason: "outside_capability_envelope",
      resolved_envelope_sha256:
        patch.record.authorization.envelope_sha256,
      connected_run_id: patch.record.connected_run_id,
    };
    const denied = await patch.controller.recordConnectedPermissionDenial(
      patch.workItem.goal.work_item_id,
      { ...withoutRunOrdinal(patch.input), expected_phase: "patch", operation },
    );
    expect(denied.work_item.state).toMatchObject({
      phase: "patch",
      attention: { kind: "missing_permission", operation },
    });
    await expect(
      patch.controller.resolveConnectedPermission(
        patch.workItem.goal.work_item_id,
        {
          decision: "keep_denied",
          expected_phase: "patch",
          governed_tuple: patch.input.governed_tuple,
          operation_sha256: operation.operation_sha256,
          connected_run_id: operation.connected_run_id,
          mission_content_sha256: patch.input.mission_content_sha256,
        },
      ),
    ).resolves.toMatchObject({ manifest: null });
    const patchRetry = await patch.controller.resolveConnectedPermission(
      patch.workItem.goal.work_item_id,
      {
        decision: "retry_without_allowing",
        expected_phase: "patch",
        governed_tuple: patch.input.governed_tuple,
        operation_sha256: operation.operation_sha256,
        connected_run_id: operation.connected_run_id,
        mission_content_sha256: patch.input.mission_content_sha256,
      },
    );
    expect(patchRetry.work_item.state).toMatchObject({
      phase: "patch",
      status: "active",
      attempt: patch.input.governed_tuple.attempt + 1,
    });
    expect(patchRetry.work_item.state.attention).toBeUndefined();
    expect(patchRetry.manifest?.capability_grant).toBeUndefined();
    expect(patchRetry.manifest?.capability_carry_forward).toMatchObject({
      kind: "carry_forward",
      source_mission_content_sha256: patch.input.mission_content_sha256,
    });

    const review = await createPhaseConnectedFixture("review");
    await review.controller.launchConnectedRun(
      review.workItem.goal.work_item_id,
      review.input,
      review.record,
    );
    await expect(
      review.controller.recordConnectedPermissionDenial(
        review.workItem.goal.work_item_id,
        {
          ...review.input,
          expected_phase: "review",
          operation: {
            ...operation,
            connected_run_id: review.record.connected_run_id,
          },
        } as never,
      ),
    ).rejects.toThrow();
    await expect(
      review.controller.resolveConnectedPermission(
        review.workItem.goal.work_item_id,
        {
          decision: "keep_denied",
          expected_phase: "review",
          governed_tuple: review.input.governed_tuple,
          operation_sha256: operation.operation_sha256,
          connected_run_id: review.record.connected_run_id,
          mission_content_sha256: review.input.mission_content_sha256,
        } as never,
      ),
    ).rejects.toThrow();
    expect(
      (await review.repository.read(review.workItem.goal.work_item_id))?.state
        .attention,
    ).toBeUndefined();
  });

  it("creates missing-permission attention only for an exact out-of-envelope operation", async () => {
    const fixture = await createConnectedFixture();
    await fixture.controller.launchConnectedExecute(
      fixture.workItem.goal.work_item_id,
      fixture.input,
      fixture.record,
    );
    const operation = {
      normalized_operation: {
        schema_version: 1 as const,
        kind: "command" as const,
        executable: "git",
        args: ["status"],
      },
      canonical_args_sha256: "e".repeat(64),
      operation_sha256: hashCanonicalCapabilityRequest({
        schema_version: 1,
        kind: "command",
        executable: "git",
        args: ["status"],
      }),
      reason: "outside_capability_envelope",
      resolved_envelope_sha256:
        fixture.record.authorization.envelope_sha256,
      connected_run_id: fixture.record.connected_run_id,
    };

    const denied = await fixture.controller.recordConnectedPermissionDenial(
      fixture.workItem.goal.work_item_id,
      { ...withoutRunOrdinal(fixture.input), operation },
    );

    expect(denied.work_item.state).toMatchObject({
      phase: "execute",
      status: "active",
      attention: {
        kind: "missing_permission",
        governed_tuple: fixture.input.governed_tuple,
        operation,
      },
    });
    expect(denied.work_item.state.active_run).toBeUndefined();
    await expectSemanticProducer(
      fixture.repository.workspaceRoot,
      fixture.workItem.goal.work_item_id,
      {
        kind: "controller_run",
        controller_run_id: denied.manifest.run_id,
        expected_outcome: "applied",
      },
      [
        {
          kind: "permission_denied",
          slot: "permission-denial",
          evidence_kind: "controller_run",
          evidence_path: `.founder/work-items/${fixture.workItem.goal.work_item_id}/runs/${denied.manifest.run_id}.json`,
        },
        {
          kind: "attention_requested",
          slot: "missing-permission-attention",
          evidence_kind: "controller_run",
          evidence_path: `.founder/work-items/${fixture.workItem.goal.work_item_id}/runs/${denied.manifest.run_id}.json`,
        },
      ],
    );
  });

  it("does not fabricate missing-permission attention for in-envelope or non-permission signals", async () => {
    const fixture = await createConnectedFixture();
    fixture.record.diagnostics = {
      entries: [
        {
          observed_at: "2026-07-26T18:00:01.000Z",
          code: "static_analysis_decline_timeout_malformed_auth_failure",
          message: "No adapter-observed out-of-envelope permission callback occurred.",
        },
      ],
      truncated: false,
    };
    await fixture.controller.launchConnectedExecute(
      fixture.workItem.goal.work_item_id,
      fixture.input,
      fixture.record,
    );
    const inEnvelopeOperation = {
      normalized_operation: {
        schema_version: 1 as const,
        kind: "command" as const,
        executable: "npm",
        args: ["run", "test"],
      },
      canonical_args_sha256: "e".repeat(64),
      operation_sha256: hashCanonicalCapabilityRequest({
        schema_version: 1,
        kind: "command",
        executable: "npm",
        args: ["run", "test"],
      }),
      reason: "outside_capability_envelope",
      resolved_envelope_sha256:
        fixture.record.authorization.envelope_sha256,
      connected_run_id: fixture.record.connected_run_id,
    };

    await expect(
      fixture.controller.recordConnectedPermissionDenial(
        fixture.workItem.goal.work_item_id,
        {
          ...withoutRunOrdinal(fixture.input),
          operation: inEnvelopeOperation,
        },
      ),
    ).rejects.toMatchObject({ kind: "invalid_transition" });
    expect(
      (await fixture.repository.read(fixture.workItem.goal.work_item_id))?.state
        .attention,
    ).toBeUndefined();
  });

  it("binds a permission decision to its original attention and retries as a fresh attempt", async () => {
    const fixture = await createConnectedFixture();
    await fixture.controller.launchConnectedExecute(
      fixture.workItem.goal.work_item_id,
      fixture.input,
      fixture.record,
    );
    const operation = {
      normalized_operation: {
        schema_version: 1 as const,
        kind: "command" as const,
        executable: "git",
        args: ["status"],
      },
      canonical_args_sha256: "e".repeat(64),
      operation_sha256: hashCanonicalCapabilityRequest({
        schema_version: 1,
        kind: "command",
        executable: "git",
        args: ["status"],
      }),
      reason: "outside_capability_envelope",
      resolved_envelope_sha256:
        fixture.record.authorization.envelope_sha256,
      connected_run_id: fixture.record.connected_run_id,
    };
    const denied = await fixture.controller.recordConnectedPermissionDenial(
      fixture.workItem.goal.work_item_id,
      { ...withoutRunOrdinal(fixture.input), operation },
    );
    const decision = {
      expected_phase: "execute" as const,
      governed_tuple: fixture.input.governed_tuple,
      operation_sha256: operation.operation_sha256,
      connected_run_id: operation.connected_run_id,
      mission_content_sha256: fixture.input.mission_content_sha256,
    };

    await expect(
      fixture.controller.resolveConnectedPermission(
        fixture.workItem.goal.work_item_id,
        { ...decision, decision: "allow_once", operation_sha256: "f".repeat(64) },
      ),
    ).rejects.toMatchObject({ kind: "stale_expectation" });
    await expect(
      fixture.controller.resolveConnectedPermission(
        fixture.workItem.goal.work_item_id,
        {
          ...decision,
          decision: "allow_once",
          mission_content_sha256: "f".repeat(64),
        },
      ),
    ).rejects.toMatchObject({ kind: "stale_expectation" });
    await expect(
      fixture.controller.resolveConnectedPermission(
        fixture.workItem.goal.work_item_id,
        {
          ...decision,
          decision: "allow_once",
          governed_tuple: {
            ...decision.governed_tuple,
            attempt: decision.governed_tuple.attempt + 1,
          },
        },
      ),
    ).rejects.toMatchObject({ kind: "attempt_conflict" });

    const kept = await fixture.controller.resolveConnectedPermission(
      fixture.workItem.goal.work_item_id,
      { ...decision, decision: "keep_denied" },
    );
    expect(kept).toEqual({ work_item: denied.work_item, manifest: null });
    const semanticBeforeKept = await readdir(
      join(
        fixture.repository.workspaceRoot,
        ".founder",
        "semantic-events",
        fixture.workItem.goal.work_item_id,
        "events",
      ),
    );
    await fixture.controller.resolveConnectedPermission(
      fixture.workItem.goal.work_item_id,
      { ...decision, decision: "keep_denied" },
    );
    expect(
      await readdir(
        join(
          fixture.repository.workspaceRoot,
          ".founder",
          "semantic-events",
          fixture.workItem.goal.work_item_id,
          "events",
        ),
      ),
    ).toEqual(semanticBeforeKept);

    const retried = await fixture.controller.resolveConnectedPermission(
      fixture.workItem.goal.work_item_id,
      { ...decision, decision: "allow_once" },
    );
    expect(retried.work_item.state).toMatchObject({
      phase: "execute",
      status: "active",
      attempt: fixture.input.governed_tuple.attempt + 1,
    });
    expect(retried.work_item.state.attention).toBeUndefined();
    if (retried.manifest === null) {
      throw new Error("Allow once must commit a fresh execute attempt.");
    }
    expect(retried.manifest.capability_grant).toMatchObject({
      source_mission_content_sha256: fixture.input.mission_content_sha256,
      execution_defaults: {
        approved_command_forms: [
          { executable: "git", args: ["status"] },
          { executable: "npm", args: ["run", "test"] },
        ],
        approved_url_operations: [],
        mcp: "forbidden",
        credentials: "forbidden",
      },
    });
    await expectSemanticProducer(
      fixture.repository.workspaceRoot,
      fixture.workItem.goal.work_item_id,
      {
        kind: "controller_run",
        controller_run_id: retried.manifest.run_id,
        expected_outcome: "applied",
      },
      [
        {
          kind: "permission_decided",
          slot: "permission-decision",
          evidence_kind: "controller_run",
          evidence_path: `.founder/work-items/${fixture.workItem.goal.work_item_id}/runs/${retried.manifest.run_id}.json`,
        },
      ],
    );
    const semanticDirectory = join(
      fixture.repository.workspaceRoot,
      ".founder",
      "semantic-events",
      fixture.workItem.goal.work_item_id,
      "events",
    );
    const semanticBeforeMissionRecompile = await readdir(semanticDirectory);
    const retriedIdentity = {
      phase: "execute" as const,
      work_item_id: retried.work_item.goal.work_item_id,
      goal_version: retried.work_item.state.goal_version!,
      input_revision: retried.work_item.state.input_revision!,
      attempt: retried.work_item.state.attempt!,
    };
    const retriedMission = await fixture.repository.writeMissionPackage(
      retriedIdentity,
      (paths) => compileMission(retried.work_item, retried.manifest!, paths),
    );
    expect(retriedMission.mission.content_sha256).not.toBe(
      fixture.input.mission_content_sha256,
    );
    expect(
      retriedMission.mission.capability_envelope.runtime
        .approved_command_forms,
    ).toEqual([
      { executable: "git", args: ["status"] },
      { executable: "npm", args: ["run", "test"] },
    ]);
    expect(await readdir(semanticDirectory)).toEqual(
      semanticBeforeMissionRecompile,
    );
  });

  it("retries a denied operation without granting it and replays idempotently", async () => {
    const fixture = await createConnectedFixture();
    await fixture.controller.launchConnectedExecute(
      fixture.workItem.goal.work_item_id,
      fixture.input,
      fixture.record,
    );
    const request = {
      schema_version: 1 as const,
      kind: "command" as const,
      executable: "git",
      args: ["commit", "-m", "Expected message", "-m", "Extra trailer"],
    };
    const operation = {
      normalized_operation: request,
      canonical_args_sha256: "e".repeat(64),
      operation_sha256: hashCanonicalCapabilityRequest(request),
      reason: "outside_capability_envelope",
      resolved_envelope_sha256:
        fixture.record.authorization.envelope_sha256,
      connected_run_id: fixture.record.connected_run_id,
    };
    await fixture.controller.recordConnectedPermissionDenial(
      fixture.workItem.goal.work_item_id,
      { ...withoutRunOrdinal(fixture.input), operation },
    );
    const decision = {
      decision: "retry_without_allowing" as const,
      expected_phase: "execute" as const,
      governed_tuple: fixture.input.governed_tuple,
      operation_sha256: operation.operation_sha256,
      connected_run_id: operation.connected_run_id,
      mission_content_sha256: fixture.input.mission_content_sha256,
    };

    const retried = await fixture.controller.resolveConnectedPermission(
      fixture.workItem.goal.work_item_id,
      decision,
    );
    expect(retried.work_item.state).toMatchObject({
      phase: "execute",
      status: "active",
      attempt: fixture.input.governed_tuple.attempt + 1,
    });
    expect(retried.work_item.state.attention).toBeUndefined();
    expect(retried.manifest).not.toBeNull();
    expect(retried.manifest?.capability_grant).toBeUndefined();
    expect(retried.manifest?.capability_carry_forward).toMatchObject({
      kind: "carry_forward",
      source_mission_content_sha256: fixture.input.mission_content_sha256,
      execution_defaults: {
        approved_command_forms: [
          { executable: "npm", args: ["run", "test"] },
        ],
      },
    });
    expect(
      retried.manifest?.capability_carry_forward?.execution_defaults
        .approved_command_forms,
    ).not.toContainEqual({ executable: "git", args: request.args });
    await expect(
      fixture.controller.resolveConnectedPermission(
        fixture.workItem.goal.work_item_id,
        decision,
      ),
    ).resolves.toEqual(retried);
    await expectSemanticProducer(
      fixture.repository.workspaceRoot,
      fixture.workItem.goal.work_item_id,
      {
        kind: "controller_run",
        controller_run_id: retried.manifest!.run_id,
        expected_outcome: "applied",
      },
      [
        {
          kind: "permission_decided",
          slot: "permission-decision",
          evidence_kind: "controller_run",
          evidence_path: `.founder/work-items/${fixture.workItem.goal.work_item_id}/runs/${retried.manifest!.run_id}.json`,
        },
      ],
    );

    const retryMission = await fixture.repository.writeMissionPackage(
      {
        phase: "execute",
        work_item_id: retried.work_item.goal.work_item_id,
        goal_version: retried.work_item.state.goal_version!,
        input_revision: retried.work_item.state.input_revision!,
        attempt: retried.work_item.state.attempt!,
      },
      (paths) => compileMission(retried.work_item, retried.manifest!, paths),
    );
    expect(retryMission.mission.capability_envelope).toEqual(
      fixture.record.authorization.envelope,
    );
  });

  it("recovers an already-created empty repair attempt from only its exact failed predecessor", async () => {
    const fixture = await createConnectedFixture();
    const prior = await fixture.repository.readMissionPackage(
      fixture.record.mission.identity,
    );
    if (
      prior.mission.identity.phase !== "execute" ||
      !("capability_envelope" in prior.mission)
    ) {
      throw new Error("Expected a capability-bearing Execute predecessor.");
    }
    const result: ExecuteExternalResultSubmission = {
      result_schema_version: 2,
      mission_content_sha256: prior.mission.content_sha256,
      identity: prior.mission.identity,
      commit: testCommit,
      summary: "Completed before deterministic verification failed",
      changed_files: ["src/domain/result.ts"],
      verification: [{ name: "Tests", status: "passed" }],
    };
    await writeFile(
      join(
        fixture.repository.workspaceRoot,
        prior.mission.result_contract.output_path,
      ),
      serializeExternalResult(result),
      "utf8",
    );
    const redRunner: VerificationRunner = {
      async run(command) {
        return {
          ...(await passingRunner.run(command)),
          status: "failed",
          exit_code: 1,
          stderr: "native verification environment mismatch",
        };
      },
    };
    const imported = await createController(
      fixture.repository,
      passingGit,
      redRunner,
    ).importExternalResult(fixture.workItem.goal.work_item_id, {
      expected_phase: "execute",
      expected_status: "active",
      expected_schema_version: 2,
      expected_goal_version: fixture.input.governed_tuple.goal_version,
      expected_input_revision: fixture.input.governed_tuple.input_revision,
      attempt: fixture.input.governed_tuple.attempt,
    });
    expect(imported.evidence.outcome).toBe("failed");

    const repairRun = {
      run_id: "83000000-0000-4000-8000-000000000001",
      idempotency_key: "historical-empty-verification-repair",
      acquired_at: "2026-07-26T18:01:00.000Z",
    };
    const lease = await fixture.repository.acquireControllerLease(
      fixture.workItem.goal.work_item_id,
      repairRun,
    );
    if (lease === null) {
      throw new Error("Expected the blocked Execute item.");
    }
    let emptyRepair: { work_item: WorkItem; manifest: ControllerRunManifest };
    try {
      emptyRepair = await fixture.repository.commitControllerMutation(lease, {
        semantic_event_intents: [],
        goal: lease.work_item.goal,
        state: {
          ...lease.work_item.state,
          status: "active",
          attempt: lease.work_item.state.attempt! + 1,
          updated_at: "2026-07-26T18:01:01.000Z",
        },
        manifest: {
          schema_version: 1,
          run_id: repairRun.run_id,
          work_item_id: lease.work_item.goal.work_item_id,
          idempotency_key: repairRun.idempotency_key,
          phase: "execute",
          goal_version: lease.work_item.state.goal_version!,
          input_revision: lease.work_item.state.input_revision!,
          attempt: lease.work_item.state.attempt! + 1,
          started_at: repairRun.acquired_at,
          outcome: "pending",
        },
      });
    } finally {
      await fixture.repository.releaseControllerLease(lease);
    }
    const currentIdentity = {
      ...fixture.record.mission.identity,
      attempt: fixture.record.mission.identity.attempt + 1,
    };
    const currentArtifact = await fixture.repository.writeMissionPackage(
      currentIdentity,
      (paths) =>
        compileMission(emptyRepair.work_item, emptyRepair.manifest, paths),
    );
    const currentEnvelope = currentArtifact.mission.capability_envelope;
    expect(currentEnvelope.runtime.approved_command_forms).toEqual([]);
    const currentEnvelopeSha256 =
      hashResolvedCapabilityEnvelope(currentEnvelope);
    const currentInput = {
      ...fixture.input,
      governed_tuple: {
        ...fixture.input.governed_tuple,
        attempt: currentIdentity.attempt,
      },
      mission_content_sha256: currentArtifact.mission.content_sha256,
    };
    const currentRecord: typeof fixture.record = {
      ...fixture.record,
      connected_run_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b2",
      mission: {
        identity: currentIdentity,
        path: currentArtifact.mission.task_path.replace(
          /TASK\.md$/,
          "mission.json",
        ),
        content_sha256: currentArtifact.mission.content_sha256,
        source_commit: currentArtifact.mission.source_revision.git_base_commit,
      },
      governed_tuple: currentInput.governed_tuple,
      authorization: {
        kind: "capability_envelope",
        envelope: currentEnvelope,
        envelope_sha256: currentEnvelopeSha256,
      },
      acp: {
        ...fixture.record.acp,
        session_id: {
          value: "empty-repair-session",
          assurance: "adapter_attested",
        },
      },
    };
    const controller = createController(fixture.repository);
    await controller.launchConnectedExecute(
      fixture.workItem.goal.work_item_id,
      currentInput,
      currentRecord,
    );
    const deniedRequest = {
      schema_version: 1 as const,
      kind: "command" as const,
      executable: "git",
      args: ["status", "--short"],
    };
    const operation = {
      normalized_operation: deniedRequest,
      canonical_args_sha256: "e".repeat(64),
      operation_sha256: hashCanonicalCapabilityRequest(deniedRequest),
      reason: "outside_capability_envelope" as const,
      resolved_envelope_sha256: currentEnvelopeSha256,
      connected_run_id: currentRecord.connected_run_id,
    };
    await controller.recordConnectedPermissionDenial(
      fixture.workItem.goal.work_item_id,
      { ...withoutRunOrdinal(currentInput), operation },
    );
    const decision = {
      decision: "retry_without_allowing" as const,
      expected_phase: "execute" as const,
      governed_tuple: currentInput.governed_tuple,
      operation_sha256: operation.operation_sha256,
      connected_run_id: currentRecord.connected_run_id,
      mission_content_sha256: currentInput.mission_content_sha256,
    };

    const recovered = await controller.resolveConnectedPermission(
      fixture.workItem.goal.work_item_id,
      decision,
    );
    expect(recovered.manifest?.capability_grant).toBeUndefined();
    expect(recovered.manifest?.capability_carry_forward).toMatchObject({
      source_mission_content_sha256: currentInput.mission_content_sha256,
      execution_defaults: executionDefaultsFromCapabilityEnvelope(
        prior.mission.capability_envelope,
      ),
    });
    expect(
      recovered.manifest?.capability_carry_forward?.execution_defaults
        .approved_command_forms,
    ).not.toContainEqual({
      executable: deniedRequest.executable,
      args: deniedRequest.args,
    });
    await expect(
      controller.resolveConnectedPermission(
        fixture.workItem.goal.work_item_id,
        decision,
      ),
    ).resolves.toEqual(recovered);
  });

  it("keeps v6 launch-ineligible while allowing its exact permission recovery", async () => {
    const historicalFixture = async () => {
      const fixture = await createConnectedFixture();
      const snapshot = await fixture.repository.readMissionPackage(
        fixture.record.mission.identity,
      );
      const currentMission = snapshot.mission as ExecuteMissionPackage;
      const draft: HistoricalExecuteMissionPackageV6 = {
        ...currentMission,
        mission_schema_version: 6 as const,
        content_sha256: "0".repeat(64),
      };
      const historicalMission = {
        ...draft,
        content_sha256: hashHistoricalMissionContentV6(draft),
      };
      const record = {
        ...fixture.record,
        mission: {
          ...fixture.record.mission,
          content_sha256: historicalMission.content_sha256,
        },
      };
      const input = {
        ...fixture.input,
        mission_content_sha256: historicalMission.content_sha256,
      };
      return { fixture, snapshot, historicalMission, record, input };
    };

    const launch = await historicalFixture();
    vi.spyOn(launch.fixture.repository, "readMissionPackage").mockResolvedValue({
      ...launch.snapshot,
      mission: launch.historicalMission,
    });
    await expect(
      launch.fixture.controller.launchConnectedExecute(
        launch.fixture.workItem.goal.work_item_id,
        launch.input,
        launch.record,
      ),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });

    const recovery = await historicalFixture();
    const readMission = vi
      .spyOn(recovery.fixture.repository, "readMissionPackage")
      .mockResolvedValue({
        ...recovery.snapshot,
        mission: {
          ...recovery.historicalMission,
          mission_schema_version: MISSION_SCHEMA_VERSION,
        } as ExecuteMissionPackage,
      });
    await recovery.fixture.controller.launchConnectedExecute(
      recovery.fixture.workItem.goal.work_item_id,
      recovery.input,
      recovery.record,
    );
    const request = {
      schema_version: 1 as const,
      kind: "command" as const,
      executable: "git",
      args: ["commit", "-m", "Expected message", "-m", "Extra trailer"],
    };
    const operation = {
      normalized_operation: request,
      canonical_args_sha256: "e".repeat(64),
      operation_sha256: hashCanonicalCapabilityRequest(request),
      reason: "outside_capability_envelope" as const,
      resolved_envelope_sha256:
        recovery.record.authorization.envelope_sha256,
      connected_run_id: recovery.record.connected_run_id,
    };
    await recovery.fixture.controller.recordConnectedPermissionDenial(
      recovery.fixture.workItem.goal.work_item_id,
      { ...withoutRunOrdinal(recovery.input), operation },
    );
    readMission.mockResolvedValue({
      ...recovery.snapshot,
      mission: recovery.historicalMission,
    });

    const retried = await recovery.fixture.controller.resolveConnectedPermission(
      recovery.fixture.workItem.goal.work_item_id,
      {
        decision: "retry_without_allowing",
        expected_phase: "execute",
        governed_tuple: recovery.input.governed_tuple,
        operation_sha256: operation.operation_sha256,
        connected_run_id: operation.connected_run_id,
        mission_content_sha256: recovery.input.mission_content_sha256,
      },
    );
    expect(retried.work_item.state.attempt).toBe(
      recovery.input.governed_tuple.attempt + 1,
    );
    expect(retried.manifest?.capability_grant).toBeUndefined();
    expect(retried.manifest?.capability_carry_forward).toMatchObject({
      source_mission_content_sha256:
        recovery.historicalMission.content_sha256,
    });
  });

  it("never turns forbidden capability kinds into fresh-attempt grants", async () => {
    const fixture = await createConnectedFixture();
    await fixture.controller.launchConnectedExecute(
      fixture.workItem.goal.work_item_id,
      fixture.input,
      fixture.record,
    );
    const request = {
      schema_version: 1 as const,
      kind: "outside_workspace_write" as const,
      path: "/tmp/outside.txt",
    };
    const operation = {
      normalized_operation: request,
      canonical_args_sha256: "e".repeat(64),
      operation_sha256: hashCanonicalCapabilityRequest(request),
      reason: "outside_capability_envelope",
      resolved_envelope_sha256:
        fixture.record.authorization.envelope_sha256,
      connected_run_id: fixture.record.connected_run_id,
    };
    await fixture.controller.recordConnectedPermissionDenial(
      fixture.workItem.goal.work_item_id,
      { ...withoutRunOrdinal(fixture.input), operation },
    );

    await expect(
      fixture.controller.resolveConnectedPermission(
        fixture.workItem.goal.work_item_id,
        {
          decision: "allow_once",
          expected_phase: "execute",
          governed_tuple: fixture.input.governed_tuple,
          operation_sha256: operation.operation_sha256,
          connected_run_id: operation.connected_run_id,
          mission_content_sha256: fixture.input.mission_content_sha256,
        },
      ),
    ).rejects.toMatchObject({ kind: "invalid_transition" });
    expect(
      (await fixture.repository.read(fixture.workItem.goal.work_item_id))?.state
        .attention,
    ).toMatchObject({ kind: "missing_permission", operation });
  });

  it("activates and updates a goal contract exactly once per expected revision", async () => {
    const { root, repository } = await createWorkspace();
    const created = await createUncontractedItem(repository);
    const controller = createController(repository);

    const activated = await controller.updateGoalContract(
      created.goal.work_item_id,
      firstContract,
    );
    expect(activated.work_item.goal).toMatchObject({
      goal_contract: {
        ...firstContract,
        purpose: "Keep controller transitions safe.",
        non_goals: ["Do not bypass the controller."],
        goal_version: 1,
      },
    });
    expect(activated.work_item.state).toMatchObject({
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
    });
    expect(activated.manifest).toMatchObject({ outcome: "applied" });

    const secondInput = {
      acceptance_criteria: ["Reject stale transitions", "Replay is idempotent"],
      allowed_scope: ["src/domain", "src/application"],
      review_ready: ["Deterministic checks pass"],
      expected_goal_version: 1,
      expected_input_revision: 1,
    };
    const updated = await controller.updateGoalContract(
      created.goal.work_item_id,
      secondInput,
    );
    expect(updated.work_item.goal.goal_contract?.goal_version).toBe(2);
    expect(updated.work_item.state).toMatchObject({
      goal_version: 2,
      input_revision: 2,
      attempt: 0,
    });

    const replay = await controller.updateGoalContract(
      created.goal.work_item_id,
      secondInput,
    );
    expect(replay).toEqual(updated);
    for (const mutation of [activated, updated]) {
      await expectSemanticProducer(
        root,
        created.goal.work_item_id,
        {
          kind: "controller_run",
          controller_run_id: mutation.manifest.run_id,
          expected_outcome: "applied",
        },
        [
          {
            kind: "goal_contract_revised",
            slot: "goal-contract-revision",
            evidence_kind: "controller_run",
            evidence_path: `.founder/work-items/${created.goal.work_item_id}/runs/${mutation.manifest.run_id}.json`,
          },
        ],
      );
    }

    const beforeStaleAttempt = await repository.read(created.goal.work_item_id);
    const stalePromise = controller.updateGoalContract(
      created.goal.work_item_id,
      {
        ...secondInput,
        acceptance_criteria: ["Different stale contract"],
        expected_input_revision: 2,
      },
    );
    await expect(stalePromise).rejects.toMatchObject({
      name: "ControllerConflictError",
      kind: "stale_expectation",
    });
    expect(await repository.read(created.goal.work_item_id)).toEqual(
      beforeStaleAttempt,
    );

    const runEntries = await readdir(
      join(
        root,
        ".founder",
        "work-items",
        created.goal.work_item_id,
        "runs",
      ),
    );
    expect(runEntries).toHaveLength(2);
  });

  it("rejects goal-contract updates in execute without mutating or retaining its lease", async () => {
    const { root, repository } = await createWorkspace();
    const { workItem } = await governToExecute(repository);
    const controller = createController(repository);
    const before = await repository.read(workItem.goal.work_item_id);
    const runsPath = join(
      root,
      ".founder",
      "work-items",
      workItem.goal.work_item_id,
      "runs",
    );
    const runsBefore = await readdir(runsPath);

    await expect(
      controller.updateGoalContract(workItem.goal.work_item_id, {
        ...firstContract,
        acceptance_criteria: ["Execute contracts stay fixed"],
        expected_goal_version: 1,
        expected_input_revision: 1,
      }),
    ).rejects.toMatchObject({
      name: "ControllerConflictError",
      kind: "goal_contract_locked",
    });
    expect(await repository.read(workItem.goal.work_item_id)).toEqual(before);
    expect(await readdir(runsPath)).toEqual(runsBefore);

    const afterRejectedUpdate = await repository.read(workItem.goal.work_item_id);
    const transitioned = await controller.transition(workItem.goal.work_item_id, {
      target_phase: "review",
      target_status: "active",
      expected_phase: afterRejectedUpdate!.state.phase,
      expected_status: afterRejectedUpdate!.state.status,
      expected_schema_version: 2,
      expected_goal_version: afterRejectedUpdate!.state.goal_version!,
      expected_input_revision: afterRejectedUpdate!.state.input_revision!,
      attempt: afterRejectedUpdate!.state.attempt!,
    });
    expect(transitioned.work_item.state.phase).toBe("review");
  });

  it("rejects every dedicated and closed shaping arrow at the controller boundary", async () => {
    const transitions = [
      ...CONTROLLER_ONLY_PHASE_TRANSITIONS.map((transition) => ({
        ...transition,
        reason: `${transition.action_label} — ${transition.explanation}`,
      })),
      ...CLOSED_IN_SLICE_PHASE_TRANSITIONS.map((transition) => ({
        ...transition,
        reason: transition.explanation,
      })),
    ];
    expect(transitions).toHaveLength(8);

    for (const transition of transitions) {
      const { root, repository } = await createWorkspace();
      const created = await createUncontractedItem(repository);
      const contracted = (
        await createController(repository).updateGoalContract(
          created.goal.work_item_id,
          firstContract,
        )
      ).work_item;
      const itemDirectory = join(
        root,
        ".founder",
        "work-items",
        created.goal.work_item_id,
      );
      const state = {
        ...contracted.state,
        phase: transition.from,
        status: "active" as const,
        updated_at: "2026-08-05T11:00:00.000Z",
      };
      await writeFile(
        join(itemDirectory, "state.json"),
        `${JSON.stringify(state, null, 2)}\n`,
        "utf8",
      );
      const goalBefore = await readFile(join(itemDirectory, "goal.yaml"), "utf8");
      const stateBefore = await readFile(join(itemDirectory, "state.json"), "utf8");

      await expect(
        createController(repository).transition(created.goal.work_item_id, {
          target_phase: transition.to,
          target_status: "active",
          expected_phase: transition.from,
          expected_status: "active",
          expected_schema_version: 2,
          expected_goal_version: state.goal_version!,
          expected_input_revision: state.input_revision!,
          attempt: state.attempt!,
        }),
      ).rejects.toMatchObject({
        kind: "invalid_transition",
        reason: transition.reason,
      });
      expect(await readFile(join(itemDirectory, "goal.yaml"), "utf8")).toBe(
        goalBefore,
      );
      expect(await readFile(join(itemDirectory, "state.json"), "utf8")).toBe(
        stateBefore,
      );
    }
  });

  it("applies and replays an exact transition without changing durable state twice", async () => {
    const { root, repository } = await createWorkspace();
    const { workItem } = await governToExecute(repository);
    const controller = createController(repository);
    const input = {
      target_phase: "review" as const,
      target_status: "active" as const,
      expected_phase: "execute" as const,
      expected_status: "active" as const,
      expected_schema_version: 2 as const,
      expected_goal_version: 1,
      expected_input_revision: 1,
      attempt: 0,
    };

    const applied = await controller.transition(workItem.goal.work_item_id, input);
    expect(applied.work_item.state).toMatchObject({
      phase: "review",
      status: "active",
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
    });
    const durableAfterFirst = await repository.read(workItem.goal.work_item_id);

    const replay = await controller.transition(workItem.goal.work_item_id, input);
    expect(replay).toEqual(applied);
    expect(await repository.read(workItem.goal.work_item_id)).toEqual(
      durableAfterFirst,
    );
    expect(
      await readdir(
        join(
          root,
          ".founder",
          "work-items",
          workItem.goal.work_item_id,
          "runs",
        ),
      ),
    ).toHaveLength(5);
    await expectSemanticProducer(
      root,
      workItem.goal.work_item_id,
      {
        kind: "controller_run",
        controller_run_id: applied.manifest.run_id,
        expected_outcome: "applied",
      },
      [
        {
          kind: "workflow_transitioned",
          slot: "workflow-transition",
          evidence_kind: "controller_run",
          evidence_path: `.founder/work-items/${workItem.goal.work_item_id}/runs/${applied.manifest.run_id}.json`,
        },
      ],
    );
  });

  it("rejects missing contracts, stale expectations, invalid moves, and attempt conflicts", async () => {
    const { repository } = await createWorkspace();
    const created = await createUncontractedItem(repository);
    const controller = createController(repository);

    await expect(
      controller.transition(created.goal.work_item_id, {
        target_phase: "idea",
        target_status: "paused",
        expected_phase: "idea",
        expected_status: "active",
        expected_schema_version: 2,
        expected_goal_version: 1,
        expected_input_revision: 1,
        attempt: 0,
      }),
    ).rejects.toMatchObject({ kind: "contract_required" });

    await controller.updateGoalContract(created.goal.work_item_id, firstContract);
    const contracted = await repository.read(created.goal.work_item_id);

    const cases = [
      {
        kind: "stale_expectation",
        input: {
          target_phase: "idea" as const,
          target_status: "paused" as const,
          expected_phase: "plan" as const,
          expected_status: "active" as const,
          expected_schema_version: 2 as const,
          expected_goal_version: 1,
          expected_input_revision: 1,
          attempt: 0,
        },
      },
      {
        kind: "invalid_transition",
        input: {
          target_phase: "ship" as const,
          target_status: "active" as const,
          expected_phase: "idea" as const,
          expected_status: "active" as const,
          expected_schema_version: 2 as const,
          expected_goal_version: 1,
          expected_input_revision: 1,
          attempt: 0,
        },
      },
      {
        kind: "attempt_conflict",
        input: {
          target_phase: "idea" as const,
          target_status: "paused" as const,
          expected_phase: "idea" as const,
          expected_status: "active" as const,
          expected_schema_version: 2 as const,
          expected_goal_version: 1,
          expected_input_revision: 1,
          attempt: 1,
        },
      },
    ];

    for (const testCase of cases) {
      const promise = controller.transition(
        created.goal.work_item_id,
        testCase.input,
      );
      await expect(promise).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof ControllerConflictError &&
          error.kind === testCase.kind,
      );
      expect(await repository.read(created.goal.work_item_id)).toEqual(
        contracted,
      );
    }
  });

  it("imports a green result once and replays immutable evidence without rerunning", async () => {
    const { repository, workItem, input, evidence, evidenceWrites } =
      await createImportFixture();
    const commandNames: string[] = [];
    const runner: VerificationRunner = {
      async run(command) {
        commandNames.push(command.name);
        return passingRunner.run(command);
      },
    };
    const controller = createController(repository, passingGit, runner);

    const imported = await controller.importExternalResult(
      workItem.goal.work_item_id,
      input,
    );
    expect(imported.work_item.state).toMatchObject({
      phase: "review",
      status: "active",
      attempt: 0,
    });
    expect(imported.evidence).toMatchObject({ outcome: "applied" });
    expect(commandNames).toEqual(["Tests", "Typecheck"]);
    expect(evidenceWrites.count).toBe(1);

    const replay = await controller.importExternalResult(
      imported.work_item.goal.work_item_id,
      input,
    );
    expect(replay).toEqual(imported);
    expect(commandNames).toEqual(["Tests", "Typecheck"]);
    expect(evidenceWrites.count).toBe(1);
    expect(evidence.size).toBe(1);
    await expectSemanticProducer(
      repository.workspaceRoot,
      workItem.goal.work_item_id,
      {
        kind: "controller_run",
        controller_run_id: imported.manifest.run_id,
        expected_outcome: "applied",
      },
      [
        {
          kind: "workflow_transitioned",
          slot: "workflow-transition",
          evidence_kind: "controller_run",
          evidence_path: `.founder/work-items/${workItem.goal.work_item_id}/runs/${imported.manifest.run_id}.json`,
        },
      ],
    );
  });

  it.each(["failed", "timed_out", "spawn_error"] as const)(
    "blocks on a %s command, marks remaining checks not-run, and starts one repair attempt",
    async (status) => {
      const { repository, workItem, input, evidence } =
        await createImportFixture();
      let commandRuns = 0;
      const redRunner: VerificationRunner = {
        async run(command) {
          commandRuns += 1;
          return {
            ...(await passingRunner.run(command)),
            status,
            exit_code: status === "failed" ? 1 : null,
            signal: status === "timed_out" ? "SIGKILL" : null,
            stderr: `${status} verification`,
          };
        },
      };
      const controller = createController(repository, passingGit, redRunner);

      const imported = await controller.importExternalResult(
        workItem.goal.work_item_id,
        input,
      );
      expect(imported.work_item.state).toMatchObject({
        phase: "execute",
        status: "blocked",
        attempt: 0,
      });
      expect(imported.evidence.outcome).toBe("failed");
      expect(imported.manifest.outcome).toBe("applied");
      expect(commandRuns).toBe(1);
      expect(
        [...evidence.values()][0].verification.map((record) => record.status),
      ).toEqual([status, "not_run"]);
      await expectSemanticProducer(
        repository.workspaceRoot,
        workItem.goal.work_item_id,
        {
          kind: "controller_run",
          controller_run_id: imported.manifest.run_id,
          expected_outcome: "applied",
        },
        [
          {
            kind: "workflow_transitioned",
            slot: "workflow-transition",
            evidence_kind: "controller_run",
            evidence_path: `.founder/work-items/${workItem.goal.work_item_id}/runs/${imported.manifest.run_id}.json`,
          },
        ],
      );

      const commitControllerMutation =
        repository.commitControllerMutation.bind(repository);
      const retrySemanticIntentCounts: number[] = [];
      repository.commitControllerMutation = async (lease, mutationInput) => {
        retrySemanticIntentCounts.push(
          mutationInput.semantic_event_intents.length,
        );
        return commitControllerMutation(lease, mutationInput);
      };
      const retried = await controller.retryExecuteAttempt(
        workItem.goal.work_item_id,
        {
          expected_phase: "execute",
          expected_status: "blocked",
          expected_schema_version: 2,
          expected_goal_version: input.expected_goal_version,
          expected_input_revision: input.expected_input_revision,
          attempt: 0,
        },
      );
      expect(retried.work_item.state).toMatchObject({
        phase: "execute",
        status: "active",
        attempt: 1,
      });
      expect(
        await controller.retryExecuteAttempt(workItem.goal.work_item_id, {
          expected_phase: "execute",
          expected_status: "blocked",
          expected_schema_version: 2,
          expected_goal_version: input.expected_goal_version,
          expected_input_revision: input.expected_input_revision,
          attempt: 0,
        }),
      ).toEqual(retried);
      expect(retrySemanticIntentCounts).toEqual([0]);
    },
  );

  it("carries only the failed mission's exact execution defaults into its repair attempt", async () => {
    const executionDefaults: ExecutionDefaultsV1 = {
      schema_version: 1,
      approved_command_forms: [
        { executable: "git", args: ["status", "--short"] },
        { executable: "npm", args: ["run", "test"] },
      ],
      approved_url_operations: [],
      mcp: "forbidden",
      credentials: "forbidden",
    };
    const fixture = await createImportFixture({ executionDefaults });
    const redRunner: VerificationRunner = {
      async run(command) {
        return {
          ...(await passingRunner.run(command)),
          status: "failed",
          exit_code: 1,
          stderr: "deterministic verification failed",
        };
      },
    };
    const controller = createController(
      fixture.repository,
      passingGit,
      redRunner,
    );
    await controller.importExternalResult(
      fixture.workItem.goal.work_item_id,
      fixture.input,
    );

    const retried = await controller.retryExecuteAttempt(
      fixture.workItem.goal.work_item_id,
      {
        expected_phase: "execute",
        expected_status: "blocked",
        expected_schema_version: 2,
        expected_goal_version: fixture.input.expected_goal_version,
        expected_input_revision: fixture.input.expected_input_revision,
        attempt: fixture.input.attempt,
      },
    );
    const prior = await fixture.repository.readMissionPackage({
      phase: "execute",
      work_item_id: fixture.workItem.goal.work_item_id,
      goal_version: fixture.input.expected_goal_version,
      input_revision: fixture.input.expected_input_revision,
      attempt: fixture.input.attempt,
    });
    expect(retried.manifest.capability_grant).toBeUndefined();
    expect(retried.manifest.capability_carry_forward).toMatchObject({
      kind: "carry_forward",
      source_mission_content_sha256: prior.mission.content_sha256,
      execution_defaults: executionDefaults,
    });
  });

  it("carries exact execution defaults after retained work makes an empty result invalid", async () => {
    const executionDefaults: ExecutionDefaultsV1 = {
      schema_version: 1,
      approved_command_forms: [
        { executable: "npm", args: ["run", "typecheck"] },
        {
          executable: "npm",
          args: ["test", "--", "tests/detail-panel.test.tsx"],
        },
      ],
      approved_url_operations: [],
      mcp: "forbidden",
      credentials: "forbidden",
    };
    const fixture = await createImportFixture({
      executionDefaults,
      transformResult: (result) => {
        const { commit: _omitted, ...withoutCommit } = result;
        void _omitted;
        return {
          ...withoutCommit,
          changed_files: [],
        } as ExecuteExternalResultSubmission;
      },
    });
    const controller = createController(fixture.repository, {
      ...passingGit,
      async isWorktreeCleanExcludingFounder() {
        return false;
      },
    });

    const imported = await controller.importExternalResult(
      fixture.workItem.goal.work_item_id,
      fixture.input,
    );
    expect(imported.evidence).toMatchObject({
      outcome: "rejected",
      reasons: [
        "An already-satisfied result requires a clean workspace outside .founder/.",
      ],
    });

    const retried = await controller.retryExecuteAttempt(
      fixture.workItem.goal.work_item_id,
      {
        expected_phase: "execute",
        expected_status: "blocked",
        expected_schema_version: 2,
        expected_goal_version: fixture.input.expected_goal_version,
        expected_input_revision: fixture.input.expected_input_revision,
        attempt: fixture.input.attempt,
      },
    );
    const prior = await fixture.repository.readMissionPackage({
      phase: "execute",
      work_item_id: fixture.workItem.goal.work_item_id,
      goal_version: fixture.input.expected_goal_version,
      input_revision: fixture.input.expected_input_revision,
      attempt: fixture.input.attempt,
    });
    expect(retried.manifest.capability_grant).toBeUndefined();
    expect(retried.manifest.capability_carry_forward).toMatchObject({
      kind: "carry_forward",
      source_mission_content_sha256: prior.mission.content_sha256,
      execution_defaults: executionDefaults,
    });
  });

  it("releases the controller lease after timed-out verification blocks an import", async () => {
    const { repository, workItem, input } = await createImportFixture();
    const timedOutRunner: VerificationRunner = {
      async run(command) {
        return {
          ...(await passingRunner.run(command)),
          status: "timed_out",
          exit_code: null,
          signal: "SIGKILL",
          stderr: "timed_out verification",
        };
      },
    };
    const controller = createController(
      repository,
      passingGit,
      timedOutRunner,
    );

    const imported = await controller.importExternalResult(
      workItem.goal.work_item_id,
      input,
    );

    expect(imported.work_item.state).toMatchObject({
      phase: "execute",
      status: "blocked",
    });
    expect(imported.evidence.outcome).toBe("failed");
    expect(
      await readdir(
        join(
          repository.workspaceRoot,
          ".founder",
          "work-items",
          workItem.goal.work_item_id,
        ),
      ),
    ).not.toContain(".controller.lock");
    expect(
      (await repository.read(workItem.goal.work_item_id))?.state.active_run,
    ).toBeUndefined();
  });

  it("preserves malformed and out-of-scope submissions as rejected evidence", async () => {
    const malformed = await createImportFixture({ resultSource: "{invalid" });
    const malformedController = createController(malformed.repository);
    const malformedResult = await malformedController.importExternalResult(
      malformed.workItem.goal.work_item_id,
      malformed.input,
    );
    expect(malformedResult.work_item.state.status).toBe("blocked");
    expect(malformedResult.evidence).toMatchObject({ outcome: "rejected" });
    expect(malformedResult.manifest.outcome).toBe("applied");
    expect([...malformed.evidence.values()][0].evidence.reasons).toContain(
      "result.json is not valid JSON.",
    );
    const malformedRetry = await malformedController.retryExecuteAttempt(
      malformed.workItem.goal.work_item_id,
      {
        expected_phase: "execute",
        expected_status: "blocked",
        expected_schema_version: 2,
        expected_goal_version: malformed.input.expected_goal_version,
        expected_input_revision: malformed.input.expected_input_revision,
        attempt: malformed.input.attempt,
      },
    );
    expect(malformedRetry.manifest.capability_grant).toBeUndefined();
    expect(malformedRetry.manifest.capability_carry_forward).toBeUndefined();

    const outside = await createImportFixture();
    const outsideGit: GitVerificationAdapter = {
      ...passingGit,
      async listChangedFiles() {
        return ["src/outside.ts"];
      },
    };
    const outsideResult = await createController(
      outside.repository,
      outsideGit,
    ).importExternalResult(outside.workItem.goal.work_item_id, outside.input);
    expect(outsideResult.work_item.state.status).toBe("blocked");
    expect(outsideResult.evidence).toMatchObject({ outcome: "rejected" });
    expect(outsideResult.evidence.reasons[0]).toContain("allowed_scope");
  });

  it("measures result scope from the mission scope base so commits authored outside the work item cannot reject it", async () => {
    const founderCommit = "c".repeat(40);
    const fixture = await createImportFixture({
      missionScopeBaseCommit: founderCommit,
    });
    const diffBases: string[] = [];
    const soleAuthorGit: GitVerificationAdapter = {
      ...passingGit,
      async listChangedFiles(base: string) {
        diffBases.push(base);
        return base === founderCommit
          ? ["src/domain/result.ts"]
          : ["docs/unrelated-founder-note.md", "src/domain/result.ts"];
      },
    };
    const imported = await createController(
      fixture.repository,
      soleAuthorGit,
    ).importExternalResult(fixture.workItem.goal.work_item_id, fixture.input);

    expect(diffBases).toEqual([founderCommit]);
    expect(imported.evidence).toMatchObject({
      outcome: "applied",
      reasons: [],
    });
    expect([...fixture.evidence.values()][0]?.evidence.git_base_commit).toBe(
      founderCommit,
    );
    expect(imported.work_item.state.status).not.toBe("blocked");
  });

  it("commits the work an agent left in the worktree so no founder approves Git plumbing", async () => {
    const authoredCommit = "d".repeat(40);
    const fixture = await createImportFixture({
      transformResult: (result) => {
        const { commit: _omitted, ...withoutCommit } = result;
        void _omitted;
        return withoutCommit as ExecuteExternalResultSubmission;
      },
    });
    const commitMessages: string[] = [];
    let committed = false;
    const authoringGit: GitVerificationAdapter = {
      ...passingGit,
      async listWorktreeChangedFilesExcludingFounder() {
        return committed ? [] : ["src/domain/result.ts"];
      },
      async commitWorktreeExcludingFounder(message: string) {
        commitMessages.push(message);
        committed = true;
        return authoredCommit;
      },
      async resolveCommit(revision: string) {
        return revision === authoredCommit ? authoredCommit : null;
      },
      async readHeadCommit() {
        return authoredCommit;
      },
    };
    const imported = await createController(
      fixture.repository,
      authoringGit,
    ).importExternalResult(fixture.workItem.goal.work_item_id, fixture.input);

    expect(commitMessages).toEqual(["Build the controller foundation"]);
    expect(imported.evidence).toMatchObject({ outcome: "applied", reasons: [] });
    expect([...fixture.evidence.values()][0]?.evidence.result_commit).toBe(
      authoredCommit,
    );
  });

  it("accepts an already-satisfied clean result at the compiled HEAD and still verifies it", async () => {
    const fixture = await createImportFixture({
      transformResult: (result) => {
        const { commit: _omitted, ...withoutCommit } = result;
        void _omitted;
        return {
          ...withoutCommit,
          changed_files: [],
        } as ExecuteExternalResultSubmission;
      },
    });
    const run = vi.fn(passingRunner.run);
    const alreadySatisfiedGit: GitVerificationAdapter = {
      ...passingGit,
      async listWorktreeChangedFilesExcludingFounder() {
        return [];
      },
      async listChangedFiles() {
        return [];
      },
    };

    const imported = await createController(
      fixture.repository,
      alreadySatisfiedGit,
      { run },
    ).importExternalResult(fixture.workItem.goal.work_item_id, fixture.input);

    expect(imported.evidence).toMatchObject({ outcome: "applied", reasons: [] });
    expect([...fixture.evidence.values()][0]?.evidence).toMatchObject({
      result_commit: testCommit,
      outcome: "applied",
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(imported.work_item.state).toMatchObject({
      phase: "review",
      status: "active",
    });
  });

  it("measures an authored commit against its own parent so founder commits made mid-run cannot reject it", async () => {
    const staleScopeBase = "c".repeat(40);
    const founderCommitDuringRun = "e".repeat(40);
    const authoredCommit = "d".repeat(40);
    const fixture = await createImportFixture({
      missionScopeBaseCommit: staleScopeBase,
      transformResult: (result) => {
        const { commit: _omitted, ...withoutCommit } = result;
        return withoutCommit as ExecuteExternalResultSubmission;
      },
    });
    const diffBases: string[] = [];
    let committed = false;
    const midRunCommitGit: GitVerificationAdapter = {
      ...passingGit,
      async listWorktreeChangedFilesExcludingFounder() {
        return committed ? [] : ["src/domain/result.ts"];
      },
      async commitWorktreeExcludingFounder() {
        committed = true;
        return authoredCommit;
      },
      async resolveCommit(revision: string) {
        return revision === authoredCommit ? authoredCommit : null;
      },
      async readHeadCommit() {
        return committed ? authoredCommit : founderCommitDuringRun;
      },
      async listChangedFiles(base: string) {
        diffBases.push(base);
        return base === founderCommitDuringRun
          ? ["src/domain/result.ts"]
          : ["src/application/work-item-controller.ts", "src/domain/result.ts"];
      },
    };

    const imported = await createController(
      fixture.repository,
      midRunCommitGit,
    ).importExternalResult(fixture.workItem.goal.work_item_id, fixture.input);

    expect(diffBases).toEqual([founderCommitDuringRun]);
    expect(imported.evidence).toMatchObject({
      outcome: "applied",
      reasons: [],
    });
  });

  it("commits only reported result paths and preserves other retained in-scope worktree changes", async () => {
    const authoredCommit = "d".repeat(40);
    const retainedPath = "src/application/work-item-controller.ts";
    const resultPath = "src/domain/result.ts";
    const fixture = await createImportFixture({
      transformResult: (result) => {
        const { commit: _omitted, ...withoutCommit } = result;
        void _omitted;
        return withoutCommit as ExecuteExternalResultSubmission;
      },
    });
    let committed = false;
    let worktreeFiles = [retainedPath, resultPath];
    const committedPaths: string[][] = [];
    const selectiveGit: GitVerificationAdapter = {
      ...passingGit,
      async listWorktreeChangedFilesExcludingFounder() {
        return [...worktreeFiles];
      },
      async commitWorktreeExcludingFounder(_message, paths) {
        committedPaths.push([...paths]);
        const pathSet = new Set(paths);
        worktreeFiles = worktreeFiles.filter((path) => !pathSet.has(path));
        committed = true;
        return authoredCommit;
      },
      async resolveCommit(revision: string) {
        return revision === authoredCommit ? authoredCommit : null;
      },
      async readHeadCommit() {
        return committed ? authoredCommit : testCommit;
      },
      async isWorktreeCleanExcludingFounder() {
        return worktreeFiles.length === 0;
      },
      async listChangedFiles(base: string) {
        return base === testCommit ? [resultPath] : [retainedPath, resultPath];
      },
    };

    const imported = await createController(
      fixture.repository,
      selectiveGit,
    ).importExternalResult(fixture.workItem.goal.work_item_id, fixture.input);

    expect(committedPaths).toEqual([[resultPath]]);
    expect(worktreeFiles).toEqual([retainedPath]);
    expect(imported.evidence).toMatchObject({
      outcome: "applied",
      reasons: [],
    });
    expect([...fixture.evidence.values()][0]?.evidence.result_commit).toBe(
      authoredCommit,
    );
    expect(imported.work_item.state).toMatchObject({
      phase: "review",
      status: "active",
    });
  });

  it("refuses to author a commit for worktree changes outside allowed_scope", async () => {
    const fixture = await createImportFixture({
      transformResult: (result) => {
        const { commit: _omitted, ...withoutCommit } = result;
        return {
          ...withoutCommit,
          changed_files: ["src/outside.ts"],
        } as ExecuteExternalResultSubmission;
      },
    });
    let commitAttempted = false;
    const outsideGit: GitVerificationAdapter = {
      ...passingGit,
      async listWorktreeChangedFilesExcludingFounder() {
        return ["src/outside.ts"];
      },
      async commitWorktreeExcludingFounder() {
        commitAttempted = true;
        return "d".repeat(40);
      },
    };
    const rejected = await createController(
      fixture.repository,
      outsideGit,
    ).importExternalResult(fixture.workItem.goal.work_item_id, fixture.input);

    expect(commitAttempted).toBe(false);
    expect(rejected.evidence.outcome).toBe("rejected");
    expect(rejected.evidence.reasons[0]).toContain("allowed_scope");
  });

  it("refuses to author a commit when a reported path is absent from the worktree", async () => {
    const fixture = await createImportFixture({
      transformResult: (result) => {
        const { commit: _omitted, ...withoutCommit } = result;
        return withoutCommit as ExecuteExternalResultSubmission;
      },
    });
    let commitAttempted = false;
    const mismatchedGit: GitVerificationAdapter = {
      ...passingGit,
      async listWorktreeChangedFilesExcludingFounder() {
        return ["src/domain/work-item.ts"];
      },
      async commitWorktreeExcludingFounder() {
        commitAttempted = true;
        return "d".repeat(40);
      },
    };
    const rejected = await createController(
      fixture.repository,
      mismatchedGit,
    ).importExternalResult(fixture.workItem.goal.work_item_id, fixture.input);

    expect(commitAttempted).toBe(false);
    expect(rejected.evidence.outcome).toBe("rejected");
    expect(rejected.evidence.reasons[0]).toContain("not changed in the Git worktree");
  });

  it.each([
    {
      name: "a mismatched mission hash",
      transformResult: (result: ExecuteExternalResultSubmission) => ({
        ...result,
        mission_content_sha256: "f".repeat(64),
      }),
      git: passingGit,
      reason: "mission hash",
    },
    {
      name: "a mismatched governed tuple",
      transformResult: (result: ExecuteExternalResultSubmission) => ({
        ...result,
        identity: { ...result.identity, attempt: result.identity.attempt + 1 },
      }),
      git: passingGit,
      reason: "identity",
    },
    {
      name: "a non-commit object",
      git: { ...passingGit, resolveCommit: async () => null },
      reason: "canonical local commit",
    },
    {
      name: "a non-descendant commit",
      git: { ...passingGit, isAncestor: async () => false },
      reason: "not an ancestor",
    },
    {
      name: "a commit that is not HEAD",
      git: { ...passingGit, readHeadCommit: async () => "b".repeat(40) },
      reason: "HEAD",
    },
    {
      name: "a dirty worktree",
      git: {
        ...passingGit,
        isWorktreeCleanExcludingFounder: async () => false,
      },
      reason: "uncommitted changes",
    },
    {
      name: "an empty Git diff",
      git: { ...passingGit, listChangedFiles: async () => [] },
      reason: "no changed files",
    },
    {
      name: "reported files that differ from Git",
      transformResult: (result: ExecuteExternalResultSubmission) => ({
        ...result,
        changed_files: ["src/application/work-item-controller.ts"],
      }),
      git: passingGit,
      reason: "do not exactly match",
    },
  ])("rejects $name before verification or state advance", async (testCase) => {
    const fixture = await createImportFixture({
      transformResult: testCase.transformResult,
    });
    let commandRuns = 0;
    const runner: VerificationRunner = {
      async run(command) {
        commandRuns += 1;
        return passingRunner.run(command);
      },
    };

    const imported = await createController(
      fixture.repository,
      testCase.git,
      runner,
    ).importExternalResult(fixture.workItem.goal.work_item_id, fixture.input);

    expect(imported.work_item.state).toMatchObject({
      phase: "execute",
      status: "blocked",
      attempt: 0,
    });
    expect(imported.evidence).toMatchObject({ outcome: "rejected" });
    expect(imported.evidence.reasons.join(" ")).toContain(testCase.reason);
    expect(commandRuns).toBe(0);
  });

  it("routes review findings to one durable patch-plan decision", async () => {
    const fixture = await createReviewImportFixture({
      transformResult: (result) => ({
        ...result,
        summary: "Review found one correctness issue.",
        verdict: "findings",
        findings: [
          {
            finding_id: "F-1",
            severity: "P1",
            title: "Preserve immutable evidence",
            evidence: {
              path: "src/application/work-item-controller.ts",
              summary: "The rejected branch must not mutate controller state.",
            },
            required_action: "Keep rejected review imports evidence-only.",
            link: {
              type: "acceptance_criteria",
              criterion: "Reject stale transitions",
            },
          },
        ],
      }),
    });
    let commandRuns = 0;
    const runner: VerificationRunner = {
      async run(command) {
        commandRuns += 1;
        return passingRunner.run(command);
      },
    };
    const controller = createController(
      fixture.repository,
      passingGit,
      runner,
    );

    const imported = await controller.importReviewResult(
      fixture.workItem.goal.work_item_id,
      fixture.input,
    );
    expect(imported.work_item.state).toMatchObject({
      phase: "review",
      status: "active",
      patch_cycle: 0,
      attention: {
        kind: "patch_plan_approval",
        governed_tuple: { patch_cycle: 0 },
      },
    });
    expect(await fixture.repository.read(fixture.workItem.goal.work_item_id))
      .toEqual(imported.work_item);
    expect(imported).toMatchObject({
      manifest: { phase: "review", outcome: "applied" },
      evidence: { phase: "review", outcome: "applied" },
      result: { verdict: "findings", findings: [{ finding_id: "F-1" }] },
    });
    expect([...fixture.evidence.values()][0].verification).toEqual([]);
    expect(commandRuns).toBe(0);
    expect(fixture.evidenceWrites.count).toBe(1);

    const replay = await controller.importReviewResult(
      fixture.workItem.goal.work_item_id,
      fixture.input,
    );
    expect(replay).toEqual(imported);
    expect(commandRuns).toBe(0);
    expect(fixture.evidenceWrites.count).toBe(1);
    expect(fixture.evidence.size).toBe(1);
    await expectSemanticProducer(
      fixture.repository.workspaceRoot,
      fixture.workItem.goal.work_item_id,
      {
        kind: "controller_run",
        controller_run_id: imported.manifest!.run_id,
        expected_outcome: "applied",
      },
      [
        {
          kind: "attention_requested",
          slot: "attention-request",
          evidence_kind: "controller_run",
          evidence_path: `.founder/work-items/${fixture.workItem.goal.work_item_id}/runs/${imported.manifest!.run_id}.json`,
        },
      ],
    );
  });

  it.each(["P0", "P1", "P2", "P3"] as const)(
    "gives first %s findings one bounded patch opportunity",
    async (severity) => {
      const fixture = await createPatchImportFixture({ severity });

      expect(fixture.workItem.state).toMatchObject({
        phase: "patch",
        status: "active",
        patch_cycle: 1,
      });
      expect(fixture.workItem.state.attention).toBeUndefined();
    },
  );

  it("replays patch-plan acceptance idempotently", async () => {
    const fixture = await createPatchImportFixture();
    const replay = await createController(fixture.repository).acceptPatchPlan(
      fixture.workItem.goal.work_item_id,
      {
        expected_phase: "review",
        expected_status: "active",
        expected_schema_version: 2,
        expected_goal_version: fixture.workItem.state.goal_version!,
        expected_input_revision: fixture.workItem.state.input_revision!,
        attempt: fixture.workItem.state.attempt!,
        expected_patch_cycle: 0,
      },
    );

    expect(replay.work_item).toEqual(fixture.workItem);
    expect(replay.manifest).toMatchObject({ phase: "patch", outcome: "applied" });
    await expectSemanticProducer(
      fixture.repository.workspaceRoot,
      fixture.workItem.goal.work_item_id,
      {
        kind: "controller_run",
        controller_run_id: replay.manifest.run_id,
        expected_outcome: "applied",
      },
      [
        {
          kind: "workflow_transitioned",
          slot: "workflow-transition",
          evidence_kind: "controller_run",
          evidence_path: `.founder/work-items/${fixture.workItem.goal.work_item_id}/runs/${replay.manifest.run_id}.json`,
        },
        {
          kind: "human_decision_recorded",
          slot: "human-decision",
          evidence_kind: "controller_run",
          evidence_path: `.founder/work-items/${fixture.workItem.goal.work_item_id}/runs/${replay.manifest.run_id}.json`,
        },
      ],
    );
  });

  it("rejects patch-plan approval when the pinned review result changes", async () => {
    const fixture = await createReviewImportFixture({
      transformResult: (result) => ({
        ...result,
        summary: "Review found one bounded issue.",
        verdict: "findings",
        findings: [reviewFinding("F-stale")],
      }),
    });
    const controller = createController(fixture.repository);
    const imported = await controller.importReviewResult(
      fixture.workItem.goal.work_item_id,
      fixture.input,
    );
    const changedResult = JSON.parse(
      fixture.snapshot.result_source,
    ) as ReviewExternalResultSubmission;
    Object.assign(fixture.repository, {
      async readMissionResult() {
        return {
          ...fixture.snapshot,
          result_source: serializeExternalResult({
            ...changedResult,
            summary: "Review bytes changed after the decision was pinned.",
          }),
        };
      },
    });

    await expect(
      controller.acceptPatchPlan(fixture.workItem.goal.work_item_id, {
        expected_phase: "review",
        expected_status: "active",
        expected_schema_version: 2,
        expected_goal_version: imported.work_item.state.goal_version!,
        expected_input_revision: imported.work_item.state.input_revision!,
        attempt: imported.work_item.state.attempt!,
        expected_patch_cycle: 0,
      }),
    ).rejects.toThrow("current pinned review decision");
    expect(
      (await fixture.repository.read(fixture.workItem.goal.work_item_id))?.state,
    ).toEqual(imported.work_item.state);
  });

  it.each([1, 2] as const)(
    "allows patch cycle %s to advance once more",
    async (patchCycle) => {
      const fixture = await createReviewImportFixture({
        patchCycle,
        transformResult: (result) => ({
          ...result,
          summary: "Review found a new bounded issue.",
          verdict: "findings",
          findings: [reviewFinding(`F-${patchCycle + 1}`)],
        }),
      });
      const controller = createController(fixture.repository);
      const imported = await controller.importReviewResult(
        fixture.workItem.goal.work_item_id,
        fixture.input,
      );
      const accepted = await controller.acceptPatchPlan(
        fixture.workItem.goal.work_item_id,
        {
          expected_phase: "review",
          expected_status: "active",
          expected_schema_version: 2,
          expected_goal_version: imported.work_item.state.goal_version!,
          expected_input_revision: imported.work_item.state.input_revision!,
          attempt: imported.work_item.state.attempt!,
          expected_patch_cycle: patchCycle,
        },
      );

      expect(accepted.work_item.state.patch_cycle).toBe(patchCycle + 1);
      expect(accepted.work_item.state.phase).toBe("patch");
    },
  );

  it("fails closed before a fourth patch cycle", async () => {
    const fixture = await createReviewImportFixture({
      patchCycle: 3,
      transformResult: (result) => ({
        ...result,
        summary: "Review found another bounded issue.",
        verdict: "findings",
        findings: [reviewFinding("F-4")],
      }),
    });
    const controller = createController(fixture.repository);
    const imported = await controller.importReviewResult(
      fixture.workItem.goal.work_item_id,
      fixture.input,
    );

    expect(imported.work_item.state.attention?.kind).toBe("cycle_limit");
    await expect(
      controller.acceptPatchPlan(fixture.workItem.goal.work_item_id, {
        expected_phase: "review",
        expected_status: "active",
        expected_schema_version: 2,
        expected_goal_version: imported.work_item.state.goal_version!,
        expected_input_revision: imported.work_item.state.input_revision!,
        attempt: imported.work_item.state.attempt!,
        expected_patch_cycle: 3,
      }),
    ).rejects.toThrow("fourth patch cycle");
  });

  it("routes a clean review to review-ready without completing the item", async () => {
    const fixture = await createReviewImportFixture();
    const imported = await createController(
      fixture.repository,
    ).importReviewResult(fixture.workItem.goal.work_item_id, fixture.input);

    expect(imported.work_item.state).toMatchObject({
      phase: "review",
      status: "active",
      attention: { kind: "review_ready" },
    });
  });

  it("approves and replays the exact clean Review result into Ship", async () => {
    const fixture = await createReviewImportFixture();
    const controller = createController(fixture.repository);
    const imported = await controller.importReviewResult(
      fixture.workItem.goal.work_item_id,
      fixture.input,
    );
    const attention = imported.work_item.state.attention;
    if (
      attention?.kind !== "review_ready" ||
      attention.pins.mission_content_sha256 === undefined ||
      attention.pins.result_content_sha256 === undefined ||
      attention.pins.git_commit === undefined ||
      attention.pins.evidence_paths[0] === undefined
    ) {
      throw new Error("Expected exact Review-ready pins.");
    }
    const input = {
      expected_phase: "review" as const,
      expected_status: "active" as const,
      expected_schema_version: 2 as const,
      expected_goal_version: imported.work_item.state.goal_version!,
      expected_input_revision: imported.work_item.state.input_revision!,
      attempt: imported.work_item.state.attempt!,
      expected_patch_cycle: imported.work_item.state.patch_cycle!,
      expected_review_mission_content_sha256:
        attention.pins.mission_content_sha256,
      expected_result_content_sha256:
        attention.pins.result_content_sha256,
      expected_evidence_path: attention.pins.evidence_paths[0],
      expected_result_commit: attention.pins.git_commit,
    };

    const approved = await controller.approveReviewResult(
      fixture.workItem.goal.work_item_id,
      input,
    );
    expect(approved.work_item.state).toMatchObject({
      phase: "ship",
      status: "active",
    });
    expect(approved.work_item.state.attention).toBeUndefined();
    expect(approved.manifest).toMatchObject({
      phase: "ship",
      outcome: "applied",
      review_result_approval: {
        governed_tuple: {
          goal_version: input.expected_goal_version,
          input_revision: input.expected_input_revision,
          attempt: input.attempt,
          patch_cycle: input.expected_patch_cycle,
        },
        review_mission_content_sha256:
          input.expected_review_mission_content_sha256,
        result_content_sha256: input.expected_result_content_sha256,
        evidence_path: input.expected_evidence_path,
        accepted_result_commit: input.expected_result_commit,
      },
    });

    await expect(
      controller.approveReviewResult(
        fixture.workItem.goal.work_item_id,
        input,
      ),
    ).resolves.toEqual(approved);
    await expectSemanticProducer(
      fixture.repository.workspaceRoot,
      fixture.workItem.goal.work_item_id,
      {
        kind: "controller_run",
        controller_run_id: approved.manifest.run_id,
        expected_outcome: "applied",
      },
      [
        {
          kind: "workflow_transitioned",
          slot: "workflow-transition",
          evidence_kind: "controller_run",
          evidence_path: `.founder/work-items/${fixture.workItem.goal.work_item_id}/runs/${approved.manifest.run_id}.json`,
        },
        {
          kind: "human_decision_recorded",
          slot: "human-decision",
          evidence_kind: "controller_run",
          evidence_path: `.founder/work-items/${fixture.workItem.goal.work_item_id}/runs/${approved.manifest.run_id}.json`,
        },
      ],
    );
  });

  it("rejects Review approval when any displayed result pin is stale", async () => {
    const fixture = await createReviewImportFixture();
    const controller = createController(fixture.repository);
    const imported = await controller.importReviewResult(
      fixture.workItem.goal.work_item_id,
      fixture.input,
    );
    const attention = imported.work_item.state.attention;
    if (
      attention?.kind !== "review_ready" ||
      attention.pins.mission_content_sha256 === undefined ||
      attention.pins.result_content_sha256 === undefined ||
      attention.pins.git_commit === undefined ||
      attention.pins.evidence_paths[0] === undefined
    ) {
      throw new Error("Expected exact Review-ready pins.");
    }

    const validInput = {
      expected_phase: "review" as const,
      expected_status: "active" as const,
      expected_schema_version: 2 as const,
      expected_goal_version: imported.work_item.state.goal_version!,
      expected_input_revision: imported.work_item.state.input_revision!,
      attempt: imported.work_item.state.attempt!,
      expected_patch_cycle: imported.work_item.state.patch_cycle!,
      expected_review_mission_content_sha256:
        attention.pins.mission_content_sha256,
      expected_result_content_sha256: attention.pins.result_content_sha256,
      expected_evidence_path: attention.pins.evidence_paths[0],
      expected_result_commit: attention.pins.git_commit,
    };
    const staleInputs: Array<
      [Partial<typeof validInput>, "stale_expectation" | "attempt_conflict"]
    > = [
      [
        { expected_goal_version: validInput.expected_goal_version + 1 },
        "stale_expectation",
      ],
      [
        { expected_input_revision: validInput.expected_input_revision + 1 },
        "stale_expectation",
      ],
      [{ attempt: validInput.attempt + 1 }, "attempt_conflict"],
      [
        { expected_patch_cycle: validInput.expected_patch_cycle + 1 },
        "stale_expectation",
      ],
      [
        { expected_review_mission_content_sha256: "e".repeat(64) },
        "stale_expectation",
      ],
      [
        { expected_result_content_sha256: "f".repeat(64) },
        "stale_expectation",
      ],
      [
        {
          expected_evidence_path: `.founder/run-evidence/${fixture.workItem.goal.work_item_id}/review-stale/${"a".repeat(64)}`,
        },
        "stale_expectation",
      ],
      [{ expected_result_commit: "b".repeat(40) }, "stale_expectation"],
    ];

    for (const [stale, expectedKind] of staleInputs) {
      await expect(
        controller.approveReviewResult(fixture.workItem.goal.work_item_id, {
          ...validInput,
          ...stale,
        }),
      ).rejects.toMatchObject({ kind: expectedKind });
    }
    expect(
      (await fixture.repository.read(fixture.workItem.goal.work_item_id))?.state,
    ).toEqual(imported.work_item.state);
  });

  it("imports and replays one green patch without consuming another cycle", async () => {
    const fixture = await createPatchImportFixture();
    let commandRuns = 0;
    const runner: VerificationRunner = {
      async run(command) {
        commandRuns += 1;
        return passingRunner.run(command);
      },
    };
    const controller = createController(
      fixture.repository,
      passingGit,
      runner,
    );

    const imported = await controller.importPatchResult(
      fixture.workItem.goal.work_item_id,
      fixture.input,
    );
    expect(imported.work_item.state).toMatchObject({
      phase: "review",
      status: "active",
      patch_cycle: 1,
    });
    expect(imported.evidence).toMatchObject({ phase: "patch", outcome: "applied" });
    expect(commandRuns).toBe(2);

    const replay = await controller.importPatchResult(
      fixture.workItem.goal.work_item_id,
      fixture.input,
    );
    expect(replay).toEqual(imported);
    expect(commandRuns).toBe(2);
    expect(fixture.evidenceWrites.count).toBe(2);
    await expectSemanticProducer(
      fixture.repository.workspaceRoot,
      fixture.workItem.goal.work_item_id,
      {
        kind: "controller_run",
        controller_run_id: imported.manifest!.run_id,
        expected_outcome: "applied",
      },
      [
        {
          kind: "workflow_transitioned",
          slot: "workflow-transition",
          evidence_kind: "controller_run",
          evidence_path: `.founder/work-items/${fixture.workItem.goal.work_item_id}/runs/${imported.manifest!.run_id}.json`,
        },
      ],
    );
  });

  it("keeps a red patch import active in the same cycle", async () => {
    const fixture = await createPatchImportFixture();
    const failingRunner: VerificationRunner = {
      async run(command) {
        return {
          ...(await passingRunner.run(command)),
          status: "failed",
          exit_code: 1,
        };
      },
    };
    const imported = await createController(
      fixture.repository,
      passingGit,
      failingRunner,
    ).importPatchResult(fixture.workItem.goal.work_item_id, fixture.input);

    expect(imported.manifest).toBeNull();
    expect(imported.evidence.outcome).toBe("rejected");
    expect(imported.work_item.state).toMatchObject({
      phase: "patch",
      status: "active",
      patch_cycle: 1,
    });
  });

  it("recovers patch state from evidence written before a failed mutation", async () => {
    const fixture = await createPatchImportFixture();
    const commit = fixture.repository.commitControllerMutation.bind(
      fixture.repository,
    );
    Object.assign(fixture.repository, {
      async commitControllerMutation() {
        throw new Error("simulated patch commit failure");
      },
    });

    await expect(
      createController(fixture.repository).importPatchResult(
        fixture.workItem.goal.work_item_id,
        fixture.input,
      ),
    ).rejects.toThrow("simulated patch commit failure");
    expect(fixture.evidenceWrites.count).toBe(2);

    Object.assign(fixture.repository, { commitControllerMutation: commit });
    const recovered = await createController(
      fixture.repository,
    ).importPatchResult(fixture.workItem.goal.work_item_id, fixture.input);
    expect(recovered.work_item.state).toMatchObject({
      phase: "review",
      patch_cycle: 1,
    });
    expect(fixture.evidenceWrites.count).toBe(2);
  });

  it("escalates an assigned finding that remains unresolved", async () => {
    const fixture = await createPatchReviewImportFixture({
      verdict: "findings",
      findings: [reviewFinding("F-1")],
      resolutions: [{ finding_id: "F-1", status: "unresolved" }],
    });
    const imported = await createController(
      fixture.repository,
    ).importReviewResult(fixture.workItem.goal.work_item_id, fixture.input);

    expect(imported.work_item.state.attention).toMatchObject({
      kind: "unresolved_finding",
      governed_tuple: { patch_cycle: 1 },
    });
  });

  it("offers a fresh bounded patch when assigned findings resolve but a new one appears", async () => {
    const fixture = await createPatchReviewImportFixture({
      verdict: "findings",
      findings: [reviewFinding("F-2")],
      resolutions: [{ finding_id: "F-1", status: "resolved" }],
    });
    const imported = await createController(
      fixture.repository,
    ).importReviewResult(fixture.workItem.goal.work_item_id, fixture.input);

    expect(imported.work_item.state.attention).toMatchObject({
      kind: "patch_plan_approval",
      governed_tuple: { patch_cycle: 1 },
    });
  });

  it("routes a clean patch re-review to review-ready", async () => {
    const fixture = await createPatchReviewImportFixture({
      verdict: "clean",
      findings: [],
      resolutions: [{ finding_id: "F-1", status: "resolved" }],
    });
    const imported = await createController(
      fixture.repository,
    ).importReviewResult(fixture.workItem.goal.work_item_id, fixture.input);

    expect(imported.work_item.state).toMatchObject({
      phase: "review",
      status: "active",
      patch_cycle: 1,
      attention: { kind: "review_ready" },
    });
  });

  it.each<{
    name: string;
    link: ReviewFindingLink;
    reason: string;
  }>([
    {
      name: "an unknown acceptance criterion",
      link: {
        type: "acceptance_criteria",
        criterion: "A criterion that is not in the pinned goal",
      },
      reason: "acceptance criterion",
    },
    {
      name: "an unknown non-goal",
      link: {
        type: "non_goals",
        non_goal: "A non-goal that is not in the pinned goal",
      },
      reason: "non-goal",
    },
    {
      name: "an unknown deterministic check",
      link: { type: "deterministic_checks", command: "npm run unknown" },
      reason: "deterministic check",
    },
  ])("rejects a review finding linked to $name", async ({ link, reason }) => {
    const fixture = await createReviewImportFixture({
      transformResult: (result) => ({
        ...result,
        summary: "Review finding names an unpinned contract target.",
        verdict: "findings",
        findings: [
          {
            finding_id: "F-unpinned",
            severity: "P1",
            title: "Unpinned finding target",
            evidence: { summary: "The target is not in the review mission." },
            required_action: "Link the finding to an exact pinned target.",
            link,
          },
        ],
      }),
    });
    const before = await fixture.repository.read(
      fixture.workItem.goal.work_item_id,
    );
    let commandRuns = 0;
    const runner: VerificationRunner = {
      async run(command) {
        commandRuns += 1;
        return passingRunner.run(command);
      },
    };

    const imported = await createController(
      fixture.repository,
      passingGit,
      runner,
    ).importReviewResult(fixture.workItem.goal.work_item_id, fixture.input);

    expect(imported.manifest).toBeNull();
    expect(imported.evidence).toMatchObject({ outcome: "rejected" });
    expect(imported.evidence.reasons.join(" ")).toContain(reason);
    expect(imported.work_item).toEqual(before);
    expect(commandRuns).toBe(0);
    expect(fixture.evidenceWrites.count).toBe(1);
    expect(
      (await fixture.repository.read(fixture.workItem.goal.work_item_id))?.state
        .active_run,
    ).toBeUndefined();
    expect(
      await readdir(
        join(
          fixture.repository.workspaceRoot,
          ".founder",
          "work-items",
          fixture.workItem.goal.work_item_id,
        ),
      ),
    ).not.toContain(".controller.lock");
  });

  it("preserves malformed review output as replayable rejected evidence only", async () => {
    const fixture = await createReviewImportFixture({ resultSource: "{invalid" });
    const before = await fixture.repository.read(
      fixture.workItem.goal.work_item_id,
    );
    const runsDirectory = join(
      fixture.repository.workspaceRoot,
      ".founder",
      "work-items",
      fixture.workItem.goal.work_item_id,
      "runs",
    );
    const runsBefore = await readdir(runsDirectory);
    const controller = createController(fixture.repository);

    const imported = await controller.importReviewResult(
      fixture.workItem.goal.work_item_id,
      fixture.input,
    );
    expect(imported).toMatchObject({
      manifest: null,
      evidence: {
        phase: "review",
        outcome: "rejected",
        reasons: ["result.json is not valid JSON."],
      },
    });
    expect(imported.result).toBeUndefined();
    expect(imported.work_item).toEqual(before);
    expect(await fixture.repository.read(fixture.workItem.goal.work_item_id))
      .toEqual(before);
    expect(await readdir(runsDirectory)).toEqual(runsBefore);

    const replay = await controller.importReviewResult(
      fixture.workItem.goal.work_item_id,
      fixture.input,
    );
    expect(replay).toEqual(imported);
    expect(fixture.evidenceWrites.count).toBe(1);
    expect(
      await readdir(
        join(
          fixture.repository.workspaceRoot,
          ".founder",
          "work-items",
          fixture.workItem.goal.work_item_id,
        ),
      ),
    ).not.toContain(".controller.lock");
    expect(
      (await fixture.repository.read(fixture.workItem.goal.work_item_id))?.state
        .active_run,
    ).toBeUndefined();
  });

  it("recovers an applied review import from evidence written before a failed commit", async () => {
    const fixture = await createReviewImportFixture();
    const commit = fixture.repository.commitControllerMutation.bind(
      fixture.repository,
    );
    Object.assign(fixture.repository, {
      async commitControllerMutation() {
        throw new Error("simulated state-preserving commit failure");
      },
    });
    const controller = createController(fixture.repository);

    await expect(
      controller.importReviewResult(
        fixture.workItem.goal.work_item_id,
        fixture.input,
      ),
    ).rejects.toThrow("simulated state-preserving commit failure");
    expect(fixture.evidenceWrites.count).toBe(1);
    expect([...fixture.evidence.values()][0]).toMatchObject({
      evidence: { phase: "review", outcome: "applied" },
      verification: [],
    });
    expect(
      (await fixture.repository.read(fixture.workItem.goal.work_item_id))?.state
        .active_run,
    ).toBeUndefined();

    Object.assign(fixture.repository, { commitControllerMutation: commit });
    const recovered = await createController(fixture.repository, {
      ...passingGit,
      readHeadCommit: async () => "b".repeat(40),
      isWorktreeCleanExcludingFounder: async () => false,
    }).importReviewResult(fixture.workItem.goal.work_item_id, fixture.input);
    expect(recovered).toMatchObject({
      manifest: { phase: "review", outcome: "applied" },
      evidence: { phase: "review", outcome: "applied" },
      result: { verdict: "clean", findings: [] },
    });
    expect(fixture.evidenceWrites.count).toBe(1);
  });

  it.each([
    {
      name: "a changed HEAD",
      git: { ...passingGit, readHeadCommit: async () => "b".repeat(40) },
      reason: "HEAD",
    },
    {
      name: "a dirty worktree",
      git: {
        ...passingGit,
        isWorktreeCleanExcludingFounder: async () => false,
      },
      reason: "uncommitted changes",
    },
  ])("rejects review import for $name without mutating state", async ({ git, reason }) => {
    const fixture = await createReviewImportFixture();
    const before = await fixture.repository.read(
      fixture.workItem.goal.work_item_id,
    );

    const imported = await createController(
      fixture.repository,
      git,
    ).importReviewResult(fixture.workItem.goal.work_item_id, fixture.input);

    expect(imported.manifest).toBeNull();
    expect(imported.evidence).toMatchObject({ outcome: "rejected" });
    expect(imported.evidence.reasons.join(" ")).toContain(reason);
    expect(imported.work_item).toEqual(before);
    expect(await fixture.repository.read(fixture.workItem.goal.work_item_id))
      .toEqual(before);
    expect(
      (await fixture.repository.read(fixture.workItem.goal.work_item_id))?.state
        .active_run,
    ).toBeUndefined();
    expect(
      await readdir(
        join(
          fixture.repository.workspaceRoot,
          ".founder",
          "work-items",
          fixture.workItem.goal.work_item_id,
        ),
      ),
    ).not.toContain(".controller.lock");
  });

  it("hash-binds exact descendant drift before a founder-approved Review reassessment", async () => {
    const fixture = await createReviewImportFixture();
    const currentHead = "b".repeat(40);
    const driftGit: GitVerificationAdapter = {
      ...passingGit,
      readHeadCommit: async () => currentHead,
      listChangedFiles: async () => [
        "src/application/work-item-controller.ts",
        "src/domain/result.ts",
      ],
    };
    const controller = createController(fixture.repository, driftGit);
    const rejected = await controller.importReviewResult(
      fixture.workItem.goal.work_item_id,
      fixture.input,
    );
    expect(rejected).toMatchObject({
      manifest: null,
      evidence: {
        outcome: "rejected",
        reasons: ["Workspace HEAD no longer equals the accepted subject commit."],
      },
    });

    const proposal = await controller.proposeReviewImportDriftRecovery(
      fixture.workItem.goal.work_item_id,
    );
    expect(proposal).toMatchObject({
      schema_version: 1,
      accepted_result_commit: testCommit,
      current_head_commit: currentHead,
      changed_files: [
        "src/application/work-item-controller.ts",
        "src/domain/result.ts",
      ],
      subject_changed_files: ["src/domain/result.ts"],
      rejected_import_run_id: rejected.evidence.import_run_id,
      rejected_import_evidence_path: rejected.evidence.evidence_path,
    });
    if (proposal === null) {
      throw new Error("Expected an exact Review import drift proposal.");
    }

    const input = {
      decision: "accept_exact_drift" as const,
      governed_tuple: {
        goal_version: proposal.identity.goal_version,
        input_revision: proposal.identity.input_revision,
        attempt: proposal.identity.attempt,
        patch_cycle: proposal.patch_cycle,
      },
      review_mission_content_sha256:
        proposal.review_mission_content_sha256,
      result_content_sha256: proposal.result_content_sha256,
      rejected_import_run_id: proposal.rejected_import_run_id,
      accepted_result_commit: proposal.accepted_result_commit,
      current_head_commit: proposal.current_head_commit,
      proposal_sha256: proposal.proposal_sha256,
    };
    const applied = await controller.applyReviewImportDriftRecovery(
      fixture.workItem.goal.work_item_id,
      input,
    );
    expect(applied).toMatchObject({
      manifest: {
        outcome: "applied",
        review_import_drift_recovery: {
          proposal_sha256: proposal.proposal_sha256,
        },
      },
      evidence: { phase: "review", outcome: "applied", reasons: [] },
      result: { verdict: "clean", findings: [] },
      work_item: {
        state: {
          phase: "review",
          status: "active",
          attention: { kind: "review_ready" },
        },
      },
    });
    expect(applied.evidence.import_run_id).not.toBe(
      rejected.evidence.import_run_id,
    );
    expect(fixture.evidence.get(rejected.evidence.import_run_id)).toMatchObject({
      evidence: { outcome: "rejected" },
    });
    expect(fixture.evidenceWrites.count).toBe(2);

    const replay = await controller.applyReviewImportDriftRecovery(
      fixture.workItem.goal.work_item_id,
      input,
    );
    expect(replay).toEqual(applied);
    expect(fixture.evidenceWrites.count).toBe(2);

    const attention = applied.work_item.state.attention;
    if (
      attention?.kind !== "review_ready" ||
      attention.pins.mission_content_sha256 === undefined ||
      attention.pins.result_content_sha256 === undefined ||
      attention.pins.git_commit === undefined ||
      attention.pins.evidence_paths[0] === undefined
    ) {
      throw new Error("Expected exact recovered Review-ready pins.");
    }
    const approved = await controller.approveReviewResult(
      fixture.workItem.goal.work_item_id,
      {
        expected_phase: "review",
        expected_status: "active",
        expected_schema_version: 2,
        expected_goal_version: attention.governed_tuple.goal_version,
        expected_input_revision: attention.governed_tuple.input_revision,
        attempt: attention.governed_tuple.attempt,
        expected_patch_cycle: attention.governed_tuple.patch_cycle,
        expected_review_mission_content_sha256:
          attention.pins.mission_content_sha256,
        expected_result_content_sha256:
          attention.pins.result_content_sha256,
        expected_evidence_path: attention.pins.evidence_paths[0],
        expected_result_commit: attention.pins.git_commit,
      },
    );
    expect(approved.work_item.state).toMatchObject({
      phase: "ship",
      status: "active",
    });
    expect(approved.manifest.review_result_approval?.evidence_path).toBe(
      applied.evidence.evidence_path,
    );
  });

  it("offers Review drift recovery after the previously dirty workspace becomes clean", async () => {
    const fixture = await createReviewImportFixture();
    const currentHead = "b".repeat(40);
    const driftGit: GitVerificationAdapter = {
      ...passingGit,
      readHeadCommit: async () => currentHead,
      isWorktreeCleanExcludingFounder: async () => false,
      listChangedFiles: async () => ["src/domain/result.ts"],
    };
    const rejected = await createController(
      fixture.repository,
      driftGit,
    ).importReviewResult(fixture.workItem.goal.work_item_id, fixture.input);
    expect(rejected.evidence).toMatchObject({
      outcome: "rejected",
      reasons: [
        "Workspace HEAD no longer equals the accepted subject commit.",
        "Workspace has uncommitted changes outside .founder/.",
      ],
    });

    const semanticDirectory = join(
      fixture.repository.workspaceRoot,
      ".founder",
      "semantic-events",
      fixture.workItem.goal.work_item_id,
      "events",
    );
    const semanticBeforeProposal = await readdir(semanticDirectory);

    const proposal = await createController(fixture.repository, {
      ...driftGit,
      isWorktreeCleanExcludingFounder: async () => true,
    }).proposeReviewImportDriftRecovery(fixture.workItem.goal.work_item_id);

    expect(proposal).toMatchObject({
      accepted_result_commit: testCommit,
      current_head_commit: currentHead,
      changed_files: ["src/domain/result.ts"],
      subject_changed_files: ["src/domain/result.ts"],
      rejected_import_run_id: rejected.evidence.import_run_id,
    });
    expect(await readdir(semanticDirectory)).toEqual(semanticBeforeProposal);
  });

  it("rejects stale Review drift approval without writing recovery evidence", async () => {
    const fixture = await createReviewImportFixture();
    const currentHead = "b".repeat(40);
    const controller = createController(fixture.repository, {
      ...passingGit,
      readHeadCommit: async () => currentHead,
      listChangedFiles: async () => ["src/domain/result.ts"],
    });
    await controller.importReviewResult(
      fixture.workItem.goal.work_item_id,
      fixture.input,
    );
    const proposal = await controller.proposeReviewImportDriftRecovery(
      fixture.workItem.goal.work_item_id,
    );
    if (proposal === null) {
      throw new Error("Expected an exact Review import drift proposal.");
    }

    await expect(
      controller.applyReviewImportDriftRecovery(
        fixture.workItem.goal.work_item_id,
        {
          decision: "accept_exact_drift",
          governed_tuple: {
            goal_version: proposal.identity.goal_version,
            input_revision: proposal.identity.input_revision,
            attempt: proposal.identity.attempt,
            patch_cycle: proposal.patch_cycle,
          },
          review_mission_content_sha256:
            proposal.review_mission_content_sha256,
          result_content_sha256: proposal.result_content_sha256,
          rejected_import_run_id: proposal.rejected_import_run_id,
          accepted_result_commit: proposal.accepted_result_commit,
          current_head_commit: "c".repeat(40),
          proposal_sha256: proposal.proposal_sha256,
        },
      ),
    ).rejects.toMatchObject({ kind: "stale_expectation" });
    expect(fixture.evidenceWrites.count).toBe(1);
  });

  it("recovers Review drift reassessment from evidence written before a failed commit", async () => {
    const fixture = await createReviewImportFixture();
    const currentHead = "b".repeat(40);
    const driftGit: GitVerificationAdapter = {
      ...passingGit,
      readHeadCommit: async () => currentHead,
      listChangedFiles: async () => ["src/domain/result.ts"],
    };
    const controller = createController(fixture.repository, driftGit);
    await controller.importReviewResult(
      fixture.workItem.goal.work_item_id,
      fixture.input,
    );
    const proposal = await controller.proposeReviewImportDriftRecovery(
      fixture.workItem.goal.work_item_id,
    );
    if (proposal === null) {
      throw new Error("Expected an exact Review import drift proposal.");
    }
    const input = {
      decision: "accept_exact_drift" as const,
      governed_tuple: {
        goal_version: proposal.identity.goal_version,
        input_revision: proposal.identity.input_revision,
        attempt: proposal.identity.attempt,
        patch_cycle: proposal.patch_cycle,
      },
      review_mission_content_sha256:
        proposal.review_mission_content_sha256,
      result_content_sha256: proposal.result_content_sha256,
      rejected_import_run_id: proposal.rejected_import_run_id,
      accepted_result_commit: proposal.accepted_result_commit,
      current_head_commit: proposal.current_head_commit,
      proposal_sha256: proposal.proposal_sha256,
    };
    const commit = fixture.repository.commitControllerMutation.bind(
      fixture.repository,
    );
    Object.assign(fixture.repository, {
      async commitControllerMutation() {
        throw new Error("simulated Review drift commit failure");
      },
    });

    await expect(
      controller.applyReviewImportDriftRecovery(
        fixture.workItem.goal.work_item_id,
        input,
      ),
    ).rejects.toThrow("simulated Review drift commit failure");
    expect(fixture.evidenceWrites.count).toBe(2);

    Object.assign(fixture.repository, { commitControllerMutation: commit });
    const recovered = await createController(
      fixture.repository,
      driftGit,
    ).applyReviewImportDriftRecovery(
      fixture.workItem.goal.work_item_id,
      input,
    );
    expect(recovered).toMatchObject({
      manifest: {
        outcome: "applied",
        review_import_drift_recovery: {
          proposal_sha256: proposal.proposal_sha256,
        },
      },
      evidence: { outcome: "applied" },
      work_item: { state: { attention: { kind: "review_ready" } } },
    });
    expect(fixture.evidenceWrites.count).toBe(2);
    await expectSemanticProducer(
      fixture.repository.workspaceRoot,
      fixture.workItem.goal.work_item_id,
      {
        kind: "controller_run",
        controller_run_id: recovered.manifest.run_id,
        expected_outcome: "applied",
      },
      [
        {
          kind: "human_decision_recorded",
          slot: "human-decision",
          evidence_kind: "controller_run",
          evidence_path: `.founder/work-items/${fixture.workItem.goal.work_item_id}/runs/${recovered.manifest.run_id}.json`,
        },
        {
          kind: "attention_requested",
          slot: "attention-request",
          evidence_kind: "controller_run",
          evidence_path: `.founder/work-items/${fixture.workItem.goal.work_item_id}/runs/${recovered.manifest.run_id}.json`,
        },
      ],
    );
  });

  it("withholds Review drift recovery unless the only rejection is exact HEAD drift on a clean descendant", async () => {
    const fixture = await createReviewImportFixture();
    const currentHead = "b".repeat(40);
    const dirtyGit: GitVerificationAdapter = {
      ...passingGit,
      readHeadCommit: async () => currentHead,
      isWorktreeCleanExcludingFounder: async () => false,
      listChangedFiles: async () => ["src/domain/result.ts"],
    };
    const dirtyController = createController(fixture.repository, dirtyGit);
    await dirtyController.importReviewResult(
      fixture.workItem.goal.work_item_id,
      fixture.input,
    );
    expect(
      await dirtyController.proposeReviewImportDriftRecovery(
        fixture.workItem.goal.work_item_id,
      ),
    ).toBeNull();

    const cleanFixture = await createReviewImportFixture();
    const nonDescendantController = createController(cleanFixture.repository, {
      ...passingGit,
      readHeadCommit: async () => currentHead,
      isAncestor: async () => false,
      listChangedFiles: async () => ["src/domain/result.ts"],
    });
    await nonDescendantController.importReviewResult(
      cleanFixture.workItem.goal.work_item_id,
      cleanFixture.input,
    );
    expect(
      await nonDescendantController.proposeReviewImportDriftRecovery(
        cleanFixture.workItem.goal.work_item_id,
      ),
    ).toBeNull();
  });

  it.each([
    {
      name: "a mismatched review mission hash",
      options: {
        transformResult: (result: ReviewExternalResultSubmission) => ({
          ...result,
          review_mission_content_sha256: "f".repeat(64),
        }),
      },
      reason: "mission hash",
    },
    {
      name: "a stale execute subject",
      options: {
        transformCurrentSubject: (subject: ExecuteReviewSubject) => ({
          ...subject,
          accepted_result_commit: "b".repeat(40),
        }),
      },
      reason: "stale",
    },
  ])("rejects review import for $name without a controller run", async ({ options, reason }) => {
    const fixture = await createReviewImportFixture(options);
    const imported = await createController(
      fixture.repository,
    ).importReviewResult(fixture.workItem.goal.work_item_id, fixture.input);

    expect(imported.manifest).toBeNull();
    expect(imported.evidence).toMatchObject({ outcome: "rejected" });
    expect(imported.evidence.reasons.join(" ")).toContain(reason);
  });

  it("rejects repair attempts unless execute is blocked at the exact tuple", async () => {
    const { repository, workItem, input } = await createImportFixture();
    await expect(
      createController(repository).retryExecuteAttempt(
        workItem.goal.work_item_id,
        {
          expected_phase: "execute",
          expected_status: "blocked",
          expected_schema_version: 2,
          expected_goal_version: input.expected_goal_version,
          expected_input_revision: input.expected_input_revision,
          attempt: input.attempt,
        },
      ),
    ).rejects.toMatchObject({ kind: "stale_expectation" });
  });

  it("commits Start Brainstorm once and replays its stored launch contract", async () => {
    const { repository } = await createWorkspace();
    const item = await createUncontractedItem(repository);
    const input = {
      launch_mode: "connected" as const,
      next_requested_model: "brainstorm-model",
      expected_mission_content_sha256: null,
      expected_result_content_sha256: null,
      expected_shaping_state_sha256: await currentShapingStateHash(
        repository,
        item,
      ),
    };
    const first = await createController(repository).startBrainstorm(
      item.goal.work_item_id,
      input,
    );

    expect(first).toMatchObject({
      work_item: { state: { phase: "brainstorm" } },
      manifest: { operation: "start_brainstorm", outcome: "applied" },
      launch_mode: "connected",
      next_requested_model: "brainstorm-model",
      next_launch: null,
    });
    expect(first.launch_fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.intent.next_goal_bytes).toBe(
      first.intent.previous_goal_bytes,
    );
    expect(first.intent.next_state_bytes).not.toBe(
      first.intent.previous_state_bytes,
    );
    expect(await repository.listShapingRuns(item.goal.work_item_id)).toEqual(
      [],
    );

    const replay = await createControllerAt(
      repository,
      "2026-08-03T21:00:00.000Z",
    ).startBrainstorm(item.goal.work_item_id, input);
    expect(replay).toEqual(first);
    await expect(
      createController(repository).startBrainstorm(item.goal.work_item_id, {
        ...input,
        next_requested_model: "different-model",
      }),
    ).rejects.toMatchObject({ kind: "idempotency_conflict" });
    await expect(
      createController(repository).startBrainstorm(item.goal.work_item_id, {
        ...input,
        launch_mode: "manual",
        next_requested_model: null,
      }),
    ).rejects.toMatchObject({ kind: "idempotency_conflict" });

    const decisionDirectory = join(
      repository.workspaceRoot,
      ".founder",
      "work-items",
      item.goal.work_item_id,
      "shaping-decisions",
    );
    expect((await readdir(decisionDirectory)).sort()).toEqual(
      [
        `${first.decision_id}.intent.json`,
        `${first.decision_id}.json`,
      ].sort(),
    );
    expect(
      (await repository.listShapingArtifacts(item.goal.work_item_id)).filter(
        (artifact) => artifact.mission.identity.phase === "brainstorm",
      ),
    ).toHaveLength(1);
  });

  it("recovers Start Brainstorm from a legacy-v1 intent after response loss", async () => {
    const { repository } = await createWorkspace();
    const item = await createUncontractedItem(repository);
    const itemDirectory = join(
      repository.workspaceRoot,
      ".founder",
      "work-items",
      item.goal.work_item_id,
    );
    const previousStateBytes = `${JSON.stringify(
      {
        schema_version: 1,
        work_item_id: item.state.work_item_id,
        phase: item.state.phase,
        status: item.state.status,
        updated_at: item.state.updated_at,
      },
      null,
      2,
    )}\n`;
    await writeFile(
      join(itemDirectory, "state.json"),
      previousStateBytes,
      "utf8",
    );
    const legacyItem = await repository.read(item.goal.work_item_id);
    if (legacyItem === null) {
      throw new Error("Expected the legacy-v1 work item");
    }
    const input = {
      launch_mode: "manual" as const,
      next_requested_model: null,
      expected_mission_content_sha256: null,
      expected_result_content_sha256: null,
      expected_shaping_state_sha256: await currentShapingStateHash(
        repository,
        legacyItem,
      ),
    };
    injectShapingResponseLoss(repository, "after_intent");

    await expect(
      createController(repository).startBrainstorm(
        item.goal.work_item_id,
        input,
      ),
    ).rejects.toThrow(/injected response loss after shaping intent/u);

    const recovered = await createControllerAt(
      repository,
      "2026-08-04T01:00:00.000Z",
    ).startBrainstorm(item.goal.work_item_id, input);

    expect(recovered).toMatchObject({
      work_item: { state: { schema_version: 2, phase: "brainstorm" } },
      manifest: { operation: "start_brainstorm", outcome: "applied" },
    });
    expect(recovered.intent.previous_state_bytes).toBe(previousStateBytes);
    expect(await readdir(itemDirectory)).not.toContain(".controller.lock");
  });

  it("runs all five decisions in manual mode with immutable replay and no process", async () => {
    const { root, repository } = await createWorkspace();
    const commit = repository.commitShapingDecision.bind(repository);
    const commitOperations: string[] = [];
    repository.commitShapingDecision = async (lease, input) => {
      commitOperations.push(input.manifest.operation);
      return commit(lease, input);
    };
    const controller = createController(repository);
    const initial = await createUncontractedItem(repository);
    const manual = {
      launch_mode: "manual" as const,
      next_requested_model: null,
    };
    const decisions = [];

    const startInput = {
      ...manual,
      expected_mission_content_sha256: null,
      expected_result_content_sha256: null,
      expected_shaping_state_sha256: await currentShapingStateHash(
        repository,
        initial,
      ),
    };
    const started = await controller.startBrainstorm(
      initial.goal.work_item_id,
      startInput,
    );
    decisions.push(started);
    expect(
      await createControllerAt(
        repository,
        "2026-08-03T21:00:00.000Z",
      ).startBrainstorm(initial.goal.work_item_id, startInput),
    ).toEqual(started);
    await expect(
      controller.startBrainstorm(initial.goal.work_item_id, {
        ...startInput,
        launch_mode: "connected",
        next_requested_model: "brainstorm-model",
      }),
    ).rejects.toMatchObject({ kind: "idempotency_conflict" });

    let current = started.work_item;
    let tip = await currentShapingTip(repository, current);
    let resultSha256 = await writeAppliedControllerShapingBundle(
      repository,
      tip,
      shapingResultForMission(tip.mission),
    );
    const originalBrainstormBinding = {
      expected_mission_content_sha256: tip.mission.content_sha256,
      expected_result_content_sha256: resultSha256,
      expected_shaping_state_sha256: await currentShapingStateHash(
        repository,
        current,
      ),
    };
    const requestInput = {
      ...manual,
      ...originalBrainstormBinding,
      feedback: "Clarify the recovery behavior before the Spec handoff.",
    };
    const requested = await controller.requestShapingChanges(
      current.goal.work_item_id,
      requestInput,
    );
    decisions.push(requested);
    expect(requested.work_item.state.phase).toBe("brainstorm");
    expect(requested.intent.next_goal_bytes).toBe(
      requested.intent.previous_goal_bytes,
    );
    expect(
      await createControllerAt(
        repository,
        "2026-08-03T22:00:00.000Z",
      ).requestShapingChanges(current.goal.work_item_id, requestInput),
    ).toEqual(requested);
    await expect(
      controller.useBrainstormResult(
        current.goal.work_item_id,
        { ...manual, ...originalBrainstormBinding },
      ),
    ).rejects.toMatchObject({ kind: "stale_expectation" });

    current = requested.work_item;
    tip = await currentShapingTip(repository, current);
    expect(tip.mission.input.revision).toMatchObject({
      ordinal: 1,
      feedback: requestInput.feedback,
    });
    resultSha256 = await writeAppliedControllerShapingBundle(
      repository,
      tip,
      shapingResultForMission(tip.mission),
    );
    const useInput = {
      ...manual,
      expected_mission_content_sha256: tip.mission.content_sha256,
      expected_result_content_sha256: resultSha256,
      expected_shaping_state_sha256: await currentShapingStateHash(
        repository,
        current,
      ),
    };
    const used = await controller.useBrainstormResult(
      current.goal.work_item_id,
      useInput,
    );
    decisions.push(used);
    expect(used.work_item.state.phase).toBe("spec");
    expect(used.work_item.goal).not.toHaveProperty("goal_contract");
    expect(used.work_item.state).not.toHaveProperty("goal_version");
    expect(
      await createControllerAt(
        repository,
        "2026-08-03T23:00:00.000Z",
      ).useBrainstormResult(current.goal.work_item_id, useInput),
    ).toEqual(used);

    current = used.work_item;
    tip = await currentShapingTip(repository, current);
    const specResult = shapingResultForMission(
      tip.mission,
    ) as SpecResultSubmission;
    resultSha256 = await writeAppliedControllerShapingBundle(
      repository,
      tip,
      specResult,
    );
    const approvalContract = goalContractFromSpecProposal(
      specResult.proposal,
      1,
    );
    const approveInput = {
      ...manual,
      expected_mission_content_sha256: tip.mission.content_sha256,
      expected_result_content_sha256: resultSha256,
      expected_shaping_state_sha256: await currentShapingStateHash(
        repository,
        current,
      ),
      goal_contract_sha256: hashGoalContract(approvalContract),
    };
    const approved = await controller.approveSpecResult(
      current.goal.work_item_id,
      approveInput,
    );
    decisions.push(approved);
    expect(approved.work_item).toMatchObject({
      goal: { goal_contract: { goal_version: 1 } },
      state: {
        phase: "plan",
        goal_version: 1,
        input_revision: 1,
        attempt: 0,
        patch_cycle: 0,
      },
    });
    expect(
      await createControllerAt(
        repository,
        "2026-08-04T00:00:00.000Z",
      ).approveSpecResult(current.goal.work_item_id, approveInput),
    ).toEqual(approved);

    current = approved.work_item;
    tip = await currentShapingTip(repository, current);
    resultSha256 = await writeAppliedControllerShapingBundle(
      repository,
      tip,
      shapingResultForMission(tip.mission),
    );
    const stalePlanMission = tip.mission;
    const stalePlanResultSha256 = resultSha256;
    const contract = current.goal.goal_contract!;
    const edited = await controller.saveWorkItem(current.goal.work_item_id, {
      target_source_id: "ws_123e4567-e89b-12d3-a456-426614174000",
      title: current.goal.title,
      type: current.goal.type ?? null,
      priority: current.goal.priority ?? null,
      tags: current.goal.tags ?? [],
      notes: current.goal.notes ?? null,
      goal_contract: {
        purpose: `${contract.purpose} Updated after Plan.`,
        acceptance_criteria: contract.acceptance_criteria,
        non_goals: contract.non_goals,
        allowed_scope: contract.allowed_scope,
        review_ready: contract.review_ready,
      },
      expected_goal_version: current.state.goal_version,
      expected_input_revision: current.state.input_revision,
    });
    current = edited.work_item;
    const replanInput = {
      ...manual,
      expected_mission_content_sha256: stalePlanMission.content_sha256,
      expected_result_content_sha256: stalePlanResultSha256,
      expected_shaping_state_sha256: await currentShapingStateHash(
        repository,
        current,
      ),
      goal_contract_sha256: hashGoalContract(current.goal.goal_contract!),
    };
    await expect(
      controller.requestShapingChanges(current.goal.work_item_id, {
        ...manual,
        expected_mission_content_sha256:
          stalePlanMission.content_sha256,
        expected_result_content_sha256: stalePlanResultSha256,
        expected_shaping_state_sha256:
          replanInput.expected_shaping_state_sha256,
        feedback: "This stale Plan must not accept another decision.",
      }),
    ).rejects.toMatchObject({ kind: "stale_expectation" });
    await expect(
      controller.replanWithUpdatedContract(current.goal.work_item_id, {
        ...replanInput,
        goal_contract_sha256: hashGoalContract(contract),
      }),
    ).rejects.toMatchObject({ kind: "stale_expectation" });
    const replanned = await controller.replanWithUpdatedContract(
      current.goal.work_item_id,
      replanInput,
    );
    decisions.push(replanned);
    expect(replanned.work_item.state).toMatchObject({
      phase: "plan",
      goal_version: 2,
      input_revision: 2,
    });
    expect(replanned.intent.decision_receipt_bytes).toBeNull();
    expect(replanned.intent.next_goal_bytes).toBe(
      replanned.intent.previous_goal_bytes,
    );
    const replannedTip = await currentShapingTip(
      repository,
      replanned.work_item,
    );
    const requirePlanShapingInput = (
      input: ShapingMissionPackage["input"],
    ): PlanShapingInput => {
      if (input.phase !== "plan") {
        throw new Error("Expected stale Plan mission input");
      }
      return input;
    };
    const stalePlanInput = requirePlanShapingInput(stalePlanMission.input);
    expect(replannedTip.mission.input).toMatchObject({
      phase: "plan",
      goal_contract_sha256: replanInput.goal_contract_sha256,
      goal_version: 2,
      spec_approval: stalePlanInput.spec_approval,
      spec_approval_sha256:
        stalePlanInput.spec_approval_sha256,
      revision: {
        supersedes_input_sha256:
          stalePlanMission.identity.input_sha256,
        superseded_result_sha256: stalePlanResultSha256,
      },
    });
    expect(
      await createControllerAt(
        repository,
        "2026-08-04T01:00:00.000Z",
      ).replanWithUpdatedContract(current.goal.work_item_id, replanInput),
    ).toEqual(replanned);

    expect(decisions.map((decision) => decision.manifest.operation)).toEqual([
      "start_brainstorm",
      "request_changes",
      "use_brainstorm_result",
      "approve_spec",
      "replan_with_updated_contract",
    ]);
    expect(commitOperations).toEqual(
      decisions.map((decision) => decision.manifest.operation),
    );
    for (const decision of decisions) {
      expect(decision).toMatchObject({
        launch_mode: "manual",
        next_requested_model: null,
        launch_fingerprint: null,
        next_launch: {
          status: "manual",
          shaping_run_id: null,
          reason: "founder_selected_manual",
        },
        manifest: { outcome: "applied" },
      });
      expect(shapingHash(decision.intent.previous_goal_bytes)).toBe(
        decision.intent.previous_goal_sha256,
      );
      expect(shapingHash(decision.intent.previous_state_bytes)).toBe(
        decision.intent.previous_state_sha256,
      );
      expect(shapingHash(decision.intent.next_goal_bytes)).toBe(
        decision.intent.next_goal_sha256,
      );
      expect(shapingHash(decision.intent.next_state_bytes)).toBe(
        decision.intent.next_state_sha256,
      );
      expect(decision.intent.next_state_bytes).not.toBe(
        decision.intent.previous_state_bytes,
      );
      expect(
        decision.intent.next_goal_bytes ===
          decision.intent.previous_goal_bytes,
      ).toBe(decision.manifest.operation !== "approve_spec");
      const transitionExpected =
        decision.intent.phase_from === decision.intent.phase_to
          ? []
          : [
              {
                kind: "workflow_transitioned" as const,
                slot: "workflow-transition",
                evidence_kind: "shaping_decision" as const,
                evidence_path: `.founder/work-items/${initial.goal.work_item_id}/shaping-decisions/${decision.decision_id}.intent.json`,
              },
            ];
      await expectSemanticProducer(
        root,
        initial.goal.work_item_id,
        {
          kind: "shaping_decision",
          decision_id: decision.decision_id,
          expected_outcome: "applied",
        },
        [
          {
            kind: "human_decision_recorded",
            slot: "human-decision",
            evidence_kind: "shaping_decision",
            evidence_path: `.founder/work-items/${initial.goal.work_item_id}/shaping-decisions/${decision.decision_id}.intent.json`,
          },
          ...transitionExpected,
        ],
      );
    }
    const shapingArtifacts = await repository.listShapingArtifacts(
      initial.goal.work_item_id,
    );
    expect(shapingArtifacts).toHaveLength(5);
    expect(
      shapingArtifacts.filter((artifact) => artifact.decision !== null),
    ).toHaveLength(2);
    expect(
      decisions.every((decision) =>
        shapingArtifacts.some(
          (artifact) =>
            artifact.mission.content_sha256 ===
            decision.intent.next_mission_content_sha256,
        ),
      ),
    ).toBe(true);
    expect(await repository.listShapingRuns(initial.goal.work_item_id)).toEqual(
      [],
    );
    expect(replanned.work_item.state.phase).not.toBe("execute");
  });

  it.each([
    { name: "before A0", boundary: "before_intent" as const },
    { name: "between A0 and A", boundary: "after_intent" as const },
    { name: "between A and B", boundary: "after_receipt" as const },
    { name: "between B and C", boundary: "after_mission" as const },
    {
      name: "after the pending manifest and before C",
      boundary: "pending_manifest" as const,
    },
    {
      name: "between C and the applied manifest",
      boundary: "applied_manifest" as const,
    },
    {
      name: "after the applied manifest",
      boundary: "after_applied_manifest" as const,
    },
  ])(
    "recovers one shaping decision after response loss $name",
    async ({ boundary }) => {
      const { repository } = await createWorkspaceWith(
        (root) => new BoundaryFailingShapingDecisionWorkspace(root),
      );
      const fixture =
        await createAppliedBrainstormDecisionFixture(repository);
      const commit = repository.commitShapingDecision.bind(repository);
      let commitCount = 0;
      repository.commitShapingDecision = async (lease, input) => {
        commitCount += 1;
        return commit(lease, input);
      };
      if (
        boundary === "pending_manifest" ||
        boundary === "applied_manifest"
      ) {
        repository.armFailure(boundary);
      } else {
        injectShapingResponseLoss(repository, boundary);
      }

      await expect(
        createController(repository).useBrainstormResult(
          fixture.started.work_item.goal.work_item_id,
          fixture.input,
        ),
      ).rejects.toThrow(/injected/u);

      const recovered = await createControllerAt(
        repository,
        "2026-08-04T02:00:00.000Z",
      ).useBrainstormResult(
        fixture.started.work_item.goal.work_item_id,
        fixture.input,
      );
      expect(recovered).toMatchObject({
        work_item: { state: { phase: "spec" } },
        manifest: {
          operation: "use_brainstorm_result",
          outcome: "applied",
        },
        launch_mode: "manual",
        next_requested_model: null,
        launch_fingerprint: null,
      });
      expect(commitCount).toBe(1);
      expect(
        await createControllerAt(
          repository,
          "2026-08-04T03:00:00.000Z",
        ).useBrainstormResult(
          fixture.started.work_item.goal.work_item_id,
          fixture.input,
        ),
      ).toEqual(recovered);
      expect(commitCount).toBe(1);

      const decisionDirectory = join(
        repository.workspaceRoot,
        ".founder",
        "work-items",
        fixture.started.work_item.goal.work_item_id,
        "shaping-decisions",
      );
      expect(
        (await readdir(decisionDirectory))
          .filter((name) => name.startsWith(recovered.decision_id))
          .sort(),
      ).toEqual(
        [
          `${recovered.decision_id}.intent.json`,
          `${recovered.decision_id}.json`,
        ].sort(),
      );
      const artifacts = await repository.listShapingArtifacts(
        fixture.started.work_item.goal.work_item_id,
      );
      expect(
        artifacts.filter(
          (artifact) => artifact.mission.identity.phase === "brainstorm",
        ),
      ).toHaveLength(1);
      expect(
        artifacts.filter(
          (artifact) => artifact.mission.identity.phase === "spec",
        ),
      ).toHaveLength(1);
      expect(
        artifacts.filter((artifact) => artifact.decision !== null),
      ).toHaveLength(1);
      expect(
        await repository.listShapingRuns(
          fixture.started.work_item.goal.work_item_id,
        ),
      ).toEqual([]);
    },
  );

  it("approves one Plan into the unchanged Execute tuple and replays byte-identically", async () => {
    const { root, repository } = await createWorkspace();
    const fixture = await createAppliedPlanDecisionFixture(repository);
    const workItemId = fixture.approved.work_item.goal.work_item_id;
    const goalBefore = await readFile(
      join(
        repository.workspaceRoot,
        ".founder",
        "work-items",
        workItemId,
        "goal.yaml",
      ),
      "utf8",
    );

    const first = await createController(repository).approvePlanResult(
      workItemId,
      fixture.input,
    );
    expect(first).toMatchObject({
      work_item: {
        state: {
          phase: "execute",
          status: "active",
          goal_version: fixture.approved.work_item.state.goal_version,
          input_revision: fixture.approved.work_item.state.input_revision,
          attempt: 0,
        },
      },
      manifest: { outcome: "applied" },
      launch_mode: "manual",
      requested_model: null,
      execute_tuple: {
        goal_version: fixture.approved.work_item.state.goal_version,
        input_revision: fixture.approved.work_item.state.input_revision,
        attempt: 0,
      },
    });
    expect(first.intent.previous_goal_bytes).toBe(
      first.intent.next_goal_bytes,
    );
    expect(
      await readFile(
        join(
          repository.workspaceRoot,
          ".founder",
          "work-items",
          workItemId,
          "goal.yaml",
        ),
        "utf8",
      ),
    ).toBe(goalBefore);
    const approvalDirectory = join(
      repository.workspaceRoot,
      ".founder",
      "work-items",
      workItemId,
      "plan-approvals",
    );
    expect((await readdir(approvalDirectory)).sort()).toEqual(
      [
        `${first.approval_id}.intent.json`,
        `${first.approval_id}.json`,
      ].sort(),
    );
    const decidedTip = await repository.resolveCurrentMissionRevision(
      workItemId,
      "plan",
    );
    expect(decidedTip?.decision?.receipt).toMatchObject({
      identity: fixture.tip.mission.identity,
      execute_tuple: first.execute_tuple,
    });

    const replay = await createControllerAt(
      repository,
      "2026-08-05T12:00:00.000Z",
    ).approvePlanResult(workItemId, fixture.input);
    expect(replay).toEqual(first);
    await expectSemanticProducer(
      root,
      workItemId,
      {
        kind: "plan_approval",
        approval_id: first.approval_id,
        expected_outcome: "applied",
      },
      [
        {
          kind: "human_decision_recorded",
          slot: "human-decision",
          evidence_kind: "plan_approval",
          evidence_path: `.founder/work-items/${workItemId}/plan-approvals/${first.approval_id}.intent.json`,
        },
        {
          kind: "workflow_transitioned",
          slot: "workflow-transition",
          evidence_kind: "plan_approval",
          evidence_path: `.founder/work-items/${workItemId}/plan-approvals/${first.approval_id}.intent.json`,
        },
      ],
    );

    const appliedBefore = await capturePlanApprovalDurableState(
      repository,
      workItemId,
    );
    await expect(
      createController(repository).approvePlanResult(workItemId, {
        ...fixture.input,
        launch_mode: "connected",
        requested_model: "execute-model",
      }),
    ).rejects.toMatchObject({ kind: "idempotency_conflict" });
    await expect(
      createController(repository).approvePlanResult(workItemId, {
        ...fixture.input,
        expected_shaping_state_sha256: "e".repeat(64),
      }),
    ).rejects.toMatchObject({ kind: "idempotency_conflict" });
    expect(
      await capturePlanApprovalDurableState(repository, workItemId),
    ).toEqual(appliedBefore);
  });

  it("rejects a Plan approval whose allowed_scope is prose instead of concrete path prefixes", async () => {
    const { repository } = await createWorkspace();
    const fixture = await createAppliedPlanDecisionFixture(repository, {
      allowedScope: [
        "work-item details panel to full-page work-item navigation and return behavior",
      ],
    });

    await expectPlanApprovalRejectionWithoutMutation(
      repository,
      fixture.approved.work_item.goal.work_item_id,
      fixture.input,
      "stale_expectation",
    );
  });

  it("rejects every stale Plan approval hash without durable mutation", async () => {
    for (const field of [
      "expected_mission_content_sha256",
      "expected_result_content_sha256",
      "expected_shaping_state_sha256",
    ] as const) {
      const { repository } = await createWorkspace();
      const fixture = await createAppliedPlanDecisionFixture(repository);
      await expectPlanApprovalRejectionWithoutMutation(
        repository,
        fixture.approved.work_item.goal.work_item_id,
        { ...fixture.input, [field]: "f".repeat(64) },
        "stale_expectation",
      );
    }
  });

  it("rejects non-applied, non-tip, decided, stale-contract, wrong-phase, and retained-lease Plan approvals without mutation", async () => {
    const nonAppliedWorkspace = await createWorkspace();
    const nonApplied = await createAppliedPlanDecisionFixture(
      nonAppliedWorkspace.repository,
      { applyResult: false },
    );
    await expectPlanApprovalRejectionWithoutMutation(
      nonAppliedWorkspace.repository,
      nonApplied.approved.work_item.goal.work_item_id,
      nonApplied.input,
      "stale_expectation",
    );

    const nonTipWorkspace = await createWorkspace();
    const nonTip = await createAppliedPlanDecisionFixture(
      nonTipWorkspace.repository,
    );
    const requested = await createController(
      nonTipWorkspace.repository,
    ).requestShapingChanges(
      nonTip.approved.work_item.goal.work_item_id,
      {
        launch_mode: "manual",
        next_requested_model: null,
        expected_mission_content_sha256:
          nonTip.tip.mission.content_sha256,
        expected_result_content_sha256: nonTip.resultContentSha256,
        expected_shaping_state_sha256:
          nonTip.input.expected_shaping_state_sha256,
        feedback: "Supersede this Plan before approval.",
      },
    );
    await expectPlanApprovalRejectionWithoutMutation(
      nonTipWorkspace.repository,
      requested.work_item.goal.work_item_id,
      {
        ...nonTip.input,
        expected_shaping_state_sha256: await currentShapingStateHash(
          nonTipWorkspace.repository,
          requested.work_item,
        ),
      },
      "stale_expectation",
    );

    const decidedWorkspace = await createWorkspace();
    const decided = await createAppliedPlanDecisionFixture(
      decidedWorkspace.repository,
    );
    const decidedItem = decided.approved.work_item;
    await decidedWorkspace.repository.writeShapingDecisionReceipt({
      shaping_schema_version: 2,
      identity: {
        phase: "plan",
        work_item_id: decided.tip.mission.identity.work_item_id,
        input_sha256: decided.tip.mission.identity.input_sha256,
      },
      mission_content_sha256: decided.tip.mission.content_sha256,
      result_content_sha256: decided.resultContentSha256,
      goal_contract_sha256: decided.input.goal_contract_sha256,
      goal_version: decidedItem.state.goal_version!,
      execute_tuple: {
        goal_version: decidedItem.state.goal_version!,
        input_revision: decidedItem.state.input_revision!,
        attempt: 0,
      },
      approved_at: "2026-08-05T10:00:00.000Z",
    });
    await expectPlanApprovalRejectionWithoutMutation(
      decidedWorkspace.repository,
      decidedItem.goal.work_item_id,
      {
        ...decided.input,
        expected_shaping_state_sha256: await currentShapingStateHash(
          decidedWorkspace.repository,
          decidedItem,
        ),
      },
      "idempotency_conflict",
    );

    const staleContractWorkspace = await createWorkspace();
    const staleContract = await createAppliedPlanDecisionFixture(
      staleContractWorkspace.repository,
    );
    const staleItem = staleContract.approved.work_item;
    const contract = staleItem.goal.goal_contract!;
    const edited = await createController(
      staleContractWorkspace.repository,
    ).saveWorkItem(staleItem.goal.work_item_id, {
      target_source_id: "inbox",
      title: staleItem.goal.title,
      type: staleItem.goal.type ?? null,
      priority: staleItem.goal.priority ?? null,
      tags: staleItem.goal.tags ?? [],
      notes: staleItem.goal.notes ?? null,
      goal_contract: {
        purpose: `${contract.purpose} Changed.`,
        acceptance_criteria: contract.acceptance_criteria,
        non_goals: contract.non_goals,
        allowed_scope: contract.allowed_scope,
        review_ready: contract.review_ready,
      },
      expected_goal_version: staleItem.state.goal_version,
      expected_input_revision: staleItem.state.input_revision,
    });
    await expectPlanApprovalRejectionWithoutMutation(
      staleContractWorkspace.repository,
      edited.work_item.goal.work_item_id,
      {
        ...staleContract.input,
        expected_shaping_state_sha256: await currentShapingStateHash(
          staleContractWorkspace.repository,
          edited.work_item,
        ),
        goal_contract_sha256: hashGoalContract(
          edited.work_item.goal.goal_contract!,
        ),
      },
      "stale_expectation",
    );

    const wrongPhaseWorkspace = await createWorkspace();
    const wrongPhase = await createAppliedPlanDecisionFixture(
      wrongPhaseWorkspace.repository,
    );
    const wrongPhaseItem = wrongPhase.approved.work_item;
    await writeFile(
      join(
        wrongPhaseWorkspace.repository.workspaceRoot,
        ".founder",
        "work-items",
        wrongPhaseItem.goal.work_item_id,
        "state.json",
      ),
      `${JSON.stringify(
        {
          ...wrongPhaseItem.state,
          phase: "execute",
          updated_at: "2026-08-05T10:00:00.000Z",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const transitioned = await wrongPhaseWorkspace.repository.read(
      wrongPhaseItem.goal.work_item_id,
    );
    if (transitioned === null) {
      throw new Error("Expected explicit wrong-phase fixture state");
    }
    await expectPlanApprovalRejectionWithoutMutation(
      wrongPhaseWorkspace.repository,
      transitioned.goal.work_item_id,
      {
        ...wrongPhase.input,
        expected_shaping_state_sha256: await currentShapingStateHash(
          wrongPhaseWorkspace.repository,
          transitioned,
        ),
      },
      "stale_expectation",
    );

    const retainedWorkspace = await createWorkspace();
    const retained = await createAppliedPlanDecisionFixture(
      retainedWorkspace.repository,
    );
    const retainedItemId = retained.approved.work_item.goal.work_item_id;
    const retainedLease = await retainedWorkspace.repository.acquireControllerLease(
      retainedItemId,
      {
        run_id: "90000000-0000-4000-8000-000000000099",
        idempotency_key: `${retainedItemId}:retained-plan-approval-test`,
        acquired_at: "2026-08-05T10:00:00.000Z",
      },
    );
    if (retainedLease === null) {
      throw new Error("Expected retained Plan approval lease");
    }
    await expectPlanApprovalRejectionWithoutMutation(
      retainedWorkspace.repository,
      retainedItemId,
      retained.input,
      "repair_required",
    );
    await retainedWorkspace.repository.releaseControllerLease(retainedLease);
  });

  it.each([
    "after_intent",
    "after_receipt",
    "pending_manifest",
    "state_replaced",
    "before_applied_manifest",
  ] as const)(
    "recovers one exact Plan approval after %s failure",
    async (boundary) => {
      const { repository } = await createWorkspaceWith(
        (root) => new BoundaryFailingPlanApprovalWorkspace(root),
      );
      const fixture = await createAppliedPlanDecisionFixture(repository);
      const workItemId = fixture.approved.work_item.goal.work_item_id;
      if (boundary === "after_intent" || boundary === "after_receipt") {
        injectPlanApprovalResponseLoss(repository, boundary);
      } else {
        repository.armFailure(boundary);
      }

      await expect(
        createController(repository).approvePlanResult(
          workItemId,
          fixture.input,
        ),
      ).rejects.toThrow(/injected/u);
      const interrupted = await repository.read(workItemId);
      expect(interrupted?.goal).toEqual(fixture.approved.work_item.goal);
      expect(["plan", "execute"]).toContain(interrupted?.state.phase);

      const recovered = await createControllerAt(
        repository,
        "2026-08-05T13:00:00.000Z",
      ).approvePlanResult(workItemId, fixture.input);
      expect(recovered).toMatchObject({
        work_item: {
          goal: fixture.approved.work_item.goal,
          state: {
            phase: "execute",
            status: "active",
            goal_version: fixture.approved.work_item.state.goal_version,
            input_revision: fixture.approved.work_item.state.input_revision,
            attempt: 0,
          },
        },
        manifest: { outcome: "applied" },
      });
      await expect(
        createControllerAt(
          repository,
          "2026-08-05T14:00:00.000Z",
        ).approvePlanResult(workItemId, fixture.input),
      ).resolves.toEqual(recovered);

      const approvalDirectory = join(
        repository.workspaceRoot,
        ".founder",
        "work-items",
        workItemId,
        "plan-approvals",
      );
      expect((await readdir(approvalDirectory)).sort()).toEqual(
        [
          `${recovered.approval_id}.intent.json`,
          `${recovered.approval_id}.json`,
        ].sort(),
      );
      const planArtifacts = (
        await repository.listShapingArtifacts(workItemId)
      ).filter(
        (artifact) => artifact.mission.identity.phase === "plan",
      );
      expect(
        planArtifacts.filter((artifact) => artifact.decision !== null),
      ).toHaveLength(1);
      const itemEntries = await readdir(
        join(
          repository.workspaceRoot,
          ".founder",
          "work-items",
          workItemId,
        ),
      );
      expect(itemEntries).not.toContain(".controller.lock");
      expect(itemEntries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
    },
  );

  it("fails closed on contradictory Plan approval receipt, manifest, and state combinations", async () => {
    const createIntentOnly = async () => {
      const { repository } = await createWorkspaceWith(
        (root) => new BoundaryFailingPlanApprovalWorkspace(root),
      );
      const fixture = await createAppliedPlanDecisionFixture(repository);
      const workItemId = fixture.approved.work_item.goal.work_item_id;
      injectPlanApprovalResponseLoss(repository, "after_intent");
      await expect(
        createController(repository).approvePlanResult(
          workItemId,
          fixture.input,
        ),
      ).rejects.toThrow(/after Plan approval intent/u);
      const approvalDirectory = join(
        repository.workspaceRoot,
        ".founder",
        "work-items",
        workItemId,
        "plan-approvals",
      );
      const intentEntry = (await readdir(approvalDirectory)).find((entry) =>
        entry.endsWith(".intent.json"),
      );
      if (intentEntry === undefined) {
        throw new Error("Expected a durable Plan approval intent");
      }
      const approvalId = intentEntry.replace(/\.intent\.json$/u, "");
      const intent = await repository.readPlanApprovalIntent(
        workItemId,
        approvalId,
      );
      if (intent === null) {
        throw new Error("Expected a readable Plan approval intent");
      }
      return {
        repository,
        fixture,
        workItemId,
        approvalDirectory,
        approvalId,
        intent,
      };
    };

    const missingReceipt = await createIntentOnly();
    await writeFile(
      join(
        missingReceipt.approvalDirectory,
        `${missingReceipt.approvalId}.json`,
      ),
      `${JSON.stringify(
        {
          schema_version: 1,
          approval_id: missingReceipt.approvalId,
          work_item_id: missingReceipt.workItemId,
          launch_mode: missingReceipt.intent.launch_mode,
          requested_model: missingReceipt.intent.requested_model,
          expected_mission_content_sha256:
            missingReceipt.intent.expected_mission_content_sha256,
          expected_result_content_sha256:
            missingReceipt.intent.expected_result_content_sha256,
          expected_shaping_state_sha256:
            missingReceipt.intent.expected_shaping_state_sha256,
          goal_contract_sha256:
            missingReceipt.intent.goal_contract_sha256,
          goal_version: missingReceipt.intent.goal_version,
          receipt_sha256: missingReceipt.intent.receipt_sha256,
          execute_tuple: missingReceipt.intent.execute_tuple,
          goal_sha256: missingReceipt.intent.next_goal_sha256,
          state_sha256: missingReceipt.intent.next_state_sha256,
          started_at: missingReceipt.intent.created_at,
          outcome: "pending",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await expect(
      createController(missingReceipt.repository).approvePlanResult(
        missingReceipt.workItemId,
        missingReceipt.fixture.input,
      ),
    ).rejects.toMatchObject({ kind: "repair_required" });

    const stateWithoutManifest = await createIntentOnly();
    await writeFile(
      join(
        stateWithoutManifest.repository.workspaceRoot,
        ".founder",
        "work-items",
        stateWithoutManifest.workItemId,
        "state.json",
      ),
      stateWithoutManifest.intent.next_state_bytes,
      "utf8",
    );
    await expect(
      createController(stateWithoutManifest.repository).approvePlanResult(
        stateWithoutManifest.workItemId,
        stateWithoutManifest.fixture.input,
      ),
    ).rejects.toMatchObject({ kind: "repair_required" });

    const conflictingReceipt = await createIntentOnly();
    const receipt = shapingDecisionReceiptSchema.parse(
      JSON.parse(conflictingReceipt.intent.receipt_bytes) as unknown,
    );
    if (receipt.identity.phase !== "plan") {
      throw new Error("Expected a Plan approval receipt");
    }
    await conflictingReceipt.repository.writeShapingDecisionReceipt({
      ...receipt,
      approved_at: "2026-08-05T15:00:00.000Z",
    });
    await expect(
      createController(conflictingReceipt.repository).approvePlanResult(
        conflictingReceipt.workItemId,
        conflictingReceipt.fixture.input,
      ),
    ).rejects.toMatchObject({ kind: "repair_required" });

    const unknownPairWorkspace = await createWorkspaceWith(
      (root) => new BoundaryFailingPlanApprovalWorkspace(root),
    );
    const unknownPair = await createAppliedPlanDecisionFixture(
      unknownPairWorkspace.repository,
    );
    const unknownWorkItemId =
      unknownPair.approved.work_item.goal.work_item_id;
    unknownPairWorkspace.repository.armFailure("pending_manifest");
    await expect(
      createController(unknownPairWorkspace.repository).approvePlanResult(
        unknownWorkItemId,
        unknownPair.input,
      ),
    ).rejects.toThrow(/pending manifest/u);
    const unknownApprovalEntry = (
      await readdir(
        join(
          unknownPairWorkspace.repository.workspaceRoot,
          ".founder",
          "work-items",
          unknownWorkItemId,
          "plan-approvals",
        ),
      )
    ).find((entry) => entry.endsWith(".intent.json"));
    if (unknownApprovalEntry === undefined) {
      throw new Error("Expected pending Plan approval intent");
    }
    const unknownIntent = await unknownPairWorkspace.repository.readPlanApprovalIntent(
      unknownWorkItemId,
      unknownApprovalEntry.replace(/\.intent\.json$/u, ""),
    );
    if (unknownIntent === null) {
      throw new Error("Expected pending Plan approval intent bytes");
    }
    const unexpectedState = JSON.parse(
      unknownIntent.previous_state_bytes,
    ) as WorkItem["state"];
    await writeFile(
      join(
        unknownPairWorkspace.repository.workspaceRoot,
        ".founder",
        "work-items",
        unknownWorkItemId,
        "state.json",
      ),
      `${JSON.stringify(
        {
          ...unexpectedState,
          updated_at: "2026-08-05T15:30:00.000Z",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await expect(
      createController(unknownPairWorkspace.repository).approvePlanResult(
        unknownWorkItemId,
        unknownPair.input,
      ),
    ).rejects.toMatchObject({ kind: "repair_required" });
  });

  it("fails closed on a retained controller lease without claiming it", async () => {
    const { repository } = await createWorkspace();
    const item = await createUncontractedItem(repository);
    const input = {
      launch_mode: "manual" as const,
      next_requested_model: null,
      expected_mission_content_sha256: null,
      expected_result_content_sha256: null,
      expected_shaping_state_sha256: await currentShapingStateHash(
        repository,
        item,
      ),
    };
    const retainedRun = {
      run_id: "90000000-0000-4000-8000-000000000014",
      idempotency_key: "retained-step-13-lease",
      acquired_at: "2026-08-02T12:30:00.000Z",
    };
    const retainedLease = await repository.acquireControllerLease(
      item.goal.work_item_id,
      retainedRun,
    );
    if (retainedLease === null) {
      throw new Error("Expected the retained-lease fixture to exist.");
    }
    try {
      await expect(
        createController(repository).startBrainstorm(
          item.goal.work_item_id,
          input,
        ),
      ).rejects.toMatchObject({
        kind: "repair_required",
        reason: expect.stringContaining(retainedRun.run_id),
      });
    } finally {
      await repository.releaseControllerLease(retainedLease);
    }
  });

  it.each(["title", "notes"] as const)(
    "rejects a stale shaping hash when only %s changed",
    async (field) => {
      const { root, repository } = await createWorkspace();
      const item = await createUncontractedItem(repository);
      const input = {
        launch_mode: "manual" as const,
        next_requested_model: null,
        expected_mission_content_sha256: null,
        expected_result_content_sha256: null,
        expected_shaping_state_sha256: await currentShapingStateHash(
          repository,
          item,
        ),
      };
      const changedGoal =
        field === "title"
          ? { ...item.goal, title: `${item.goal.title} changed` }
          : { ...item.goal, notes: "Changed notes only." };
      await writeFile(
        join(
          root,
          ".founder",
          "work-items",
          item.goal.work_item_id,
          "goal.yaml",
        ),
        stringify(changedGoal),
        "utf8",
      );

      await expect(
        createController(repository).startBrainstorm(
          item.goal.work_item_id,
          input,
        ),
      ).rejects.toMatchObject({ kind: "stale_expectation" });
      expect(
        await repository.listShapingArtifacts(item.goal.work_item_id),
      ).toEqual([]);
      expect((await repository.read(item.goal.work_item_id))?.state.phase).toBe(
        "idea",
      );
    },
  );

  it("rejects a result that is not the revision's applied result", async () => {
    const { repository } = await createWorkspace();
    const initial = await createUncontractedItem(repository);
    const started = await createController(repository).startBrainstorm(
      initial.goal.work_item_id,
      {
        launch_mode: "manual",
        next_requested_model: null,
        expected_mission_content_sha256: null,
        expected_result_content_sha256: null,
        expected_shaping_state_sha256: await currentShapingStateHash(
          repository,
          initial,
        ),
      },
    );
    const tip = await currentShapingTip(repository, started.work_item);

    await expect(
      createController(repository).useBrainstormResult(
        started.work_item.goal.work_item_id,
        {
          launch_mode: "manual",
          next_requested_model: null,
          expected_mission_content_sha256: tip.mission.content_sha256,
          expected_result_content_sha256: "f".repeat(64),
          expected_shaping_state_sha256: await currentShapingStateHash(
            repository,
            started.work_item,
          ),
        },
      ),
    ).rejects.toMatchObject({ kind: "stale_expectation" });
  });

  it("serializes request-vs-request and request-vs-use against one new tip", async () => {
    const { repository } = await createWorkspace();
    const fixture = await createAppliedBrainstormDecisionFixture(repository);
    const firstRequest = {
      ...fixture.input,
      feedback: "First serialized revision wins.",
    };
    const requested = await createController(
      repository,
    ).requestShapingChanges(
      fixture.started.work_item.goal.work_item_id,
      firstRequest,
    );

    await expect(
      createController(repository).requestShapingChanges(
        fixture.started.work_item.goal.work_item_id,
        {
          ...fixture.input,
          feedback: "The request serialized second must lose.",
        },
      ),
    ).rejects.toMatchObject({ kind: "stale_expectation" });
    await expect(
      createController(repository).useBrainstormResult(
        fixture.started.work_item.goal.work_item_id,
        fixture.input,
      ),
    ).rejects.toMatchObject({ kind: "stale_expectation" });

    const tip = await currentShapingTip(repository, requested.work_item);
    expect(tip.mission.input.revision).toMatchObject({
      ordinal: 1,
      feedback: firstRequest.feedback,
    });
    expect(
      (await repository.listShapingArtifacts(
        fixture.started.work_item.goal.work_item_id,
      )).filter(
        (artifact) =>
          artifact.mission.identity.phase === "brainstorm" &&
          artifact.mission.input.revision !== undefined,
      ),
    ).toHaveLength(1);
  });

  it("serializes request-vs-approve and rejects a mismatched contract hash", async () => {
    const { repository } = await createWorkspace();
    const fixture = await createAppliedSpecDecisionFixture(repository);
    const controller = createController(repository);

    await expect(
      controller.approveSpecResult(
        fixture.used.work_item.goal.work_item_id,
        {
          ...fixture.input,
          goal_contract_sha256: "f".repeat(64),
        },
      ),
    ).rejects.toMatchObject({ kind: "stale_expectation" });

    const requested = await controller.requestShapingChanges(
      fixture.used.work_item.goal.work_item_id,
      {
        launch_mode: fixture.input.launch_mode,
        next_requested_model: fixture.input.next_requested_model,
        expected_mission_content_sha256:
          fixture.input.expected_mission_content_sha256,
        expected_result_content_sha256:
          fixture.input.expected_result_content_sha256,
        expected_shaping_state_sha256:
          fixture.input.expected_shaping_state_sha256,
        feedback: "Revise the Spec before approval.",
      },
    );
    await expect(
      controller.approveSpecResult(
        fixture.used.work_item.goal.work_item_id,
        fixture.input,
      ),
    ).rejects.toMatchObject({ kind: "stale_expectation" });
    expect(requested.work_item.state.phase).toBe("spec");
    expect(
      (await currentShapingTip(repository, requested.work_item)).mission.input
        .revision,
    ).toMatchObject({
      ordinal: 1,
      feedback: "Revise the Spec before approval.",
    });
  });

  it("rejects a durable manifest that disagrees with its intent", async () => {
    const { root, repository } = await createWorkspace();
    const item = await createUncontractedItem(repository);
    const input = {
      launch_mode: "connected" as const,
      next_requested_model: "brainstorm-model",
      expected_mission_content_sha256: null,
      expected_result_content_sha256: null,
      expected_shaping_state_sha256: await currentShapingStateHash(
        repository,
        item,
      ),
    };
    const started = await createController(repository).startBrainstorm(
      item.goal.work_item_id,
      input,
    );
    const manifestPath = join(
      root,
      ".founder",
      "work-items",
      item.goal.work_item_id,
      "shaping-decisions",
      `${started.decision_id}.json`,
    );
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as Record<string, unknown>;
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          ...manifest,
          next_mission_content_sha256: "e".repeat(64),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(
      createController(repository).startBrainstorm(
        item.goal.work_item_id,
        input,
      ),
    ).rejects.toMatchObject({ kind: "idempotency_conflict" });
    expect(await repository.listShapingRuns(item.goal.work_item_id)).toEqual(
      [],
    );
  });

  it("rejects a predicted decision receipt that differs from its intent", async () => {
    const { repository } = await createWorkspace();
    const fixture = await createAppliedBrainstormDecisionFixture(repository);
    injectShapingResponseLoss(repository, "after_receipt");
    await expect(
      createController(repository).useBrainstormResult(
        fixture.started.work_item.goal.work_item_id,
        fixture.input,
      ),
    ).rejects.toThrow(/injected/u);
    const tip = await currentShapingTip(
      repository,
      fixture.started.work_item,
    );
    if (tip.decision === null) {
      throw new Error("Expected the partial decision receipt.");
    }
    await writeFile(
      join(repository.workspaceRoot, tip.decision.decision_path),
      `${JSON.stringify(
        {
          ...tip.decision.receipt,
          selected_at: "2026-08-04T04:00:00.000Z",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(
      createControllerAt(
        repository,
        "2026-08-04T05:00:00.000Z",
      ).useBrainstormResult(
        fixture.started.work_item.goal.work_item_id,
        fixture.input,
      ),
    ).rejects.toMatchObject({ kind: "idempotency_conflict" });
  });

  it.each(["changed_status", "third_mission"] as const)(
    "rejects unrelated drift from a pending intent: %s",
    async (drift) => {
      const { root, repository } = await createWorkspace();
      const fixture =
        await createAppliedBrainstormDecisionFixture(repository);
      injectShapingResponseLoss(repository, "after_intent");
      await expect(
        createController(repository).useBrainstormResult(
          fixture.started.work_item.goal.work_item_id,
          fixture.input,
        ),
      ).rejects.toThrow(/injected/u);

      if (drift === "changed_status") {
        const current = await repository.read(
          fixture.started.work_item.goal.work_item_id,
        );
        if (current === null) {
          throw new Error("Expected the shaping work item.");
        }
        await writeFile(
          join(
            root,
            ".founder",
            "work-items",
            current.goal.work_item_id,
            "state.json",
          ),
          `${JSON.stringify(
            {
              ...current.state,
              status: "paused",
              updated_at: "2026-08-04T06:00:00.000Z",
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
      } else {
        const mission =
          fixture.tip.mission as BrainstormMissionPackage;
        const foreignMission = compileBrainstormMission({
          work_item_id: mission.identity.work_item_id,
          shaping_input: {
            ...mission.input,
            revision: {
              ordinal: (mission.input.revision?.ordinal ?? 0) + 1,
              supersedes_input_sha256: mission.identity.input_sha256,
              superseded_result_sha256: fixture.resultContentSha256,
              feedback: "Unrelated third mission.",
            },
          },
        });
        await repository.writeShapingMissionPackage(
          foreignMission.identity,
          () => foreignMission,
        );
      }

      await expect(
        createControllerAt(
          repository,
          "2026-08-04T07:00:00.000Z",
        ).useBrainstormResult(
          fixture.started.work_item.goal.work_item_id,
          fixture.input,
        ),
      ).rejects.toMatchObject({ kind: "repair_required" });
    },
  );

  it("maps a non-identical predicted mission to repair_required", async () => {
    const { repository } = await createWorkspace();
    const fixture = await createAppliedBrainstormDecisionFixture(repository);
    injectShapingResponseLoss(repository, "after_mission");
    await expect(
      createController(repository).useBrainstormResult(
        fixture.started.work_item.goal.work_item_id,
        fixture.input,
      ),
    ).rejects.toThrow(/injected/u);
    const predicted = (
      await repository.listShapingArtifacts(
        fixture.started.work_item.goal.work_item_id,
      )
    ).find((artifact) => artifact.mission.identity.phase === "spec");
    if (predicted === undefined) {
      throw new Error("Expected the predicted Spec mission.");
    }
    const predictedMissionPath = join(
      repository.workspaceRoot,
      dirname(predicted.task_path),
      "mission.json",
    );
    await writeFile(
      predictedMissionPath,
      JSON.stringify(
        JSON.parse(await readFile(predictedMissionPath, "utf8")),
      ),
      "utf8",
    );

    await expect(
      createControllerAt(
        repository,
        "2026-08-04T08:00:00.000Z",
      ).useBrainstormResult(
        fixture.started.work_item.goal.work_item_id,
        fixture.input,
      ),
    ).rejects.toMatchObject({ kind: "repair_required" });
  });

  it("rejects a pending manifest for a different shaping decision", async () => {
    const { root, repository } = await createWorkspaceWith(
      (workspaceRoot) =>
        new BoundaryFailingShapingDecisionWorkspace(workspaceRoot),
    );
    const item = await createUncontractedItem(repository);
    const input = {
      launch_mode: "manual" as const,
      next_requested_model: null,
      expected_mission_content_sha256: null,
      expected_result_content_sha256: null,
      expected_shaping_state_sha256: await currentShapingStateHash(
        repository,
        item,
      ),
    };
    repository.armFailure("pending_manifest");
    await expect(
      createController(repository).startBrainstorm(
        item.goal.work_item_id,
        input,
      ),
    ).rejects.toThrow(/injected/u);

    const decisionDirectory = join(
      root,
      ".founder",
      "work-items",
      item.goal.work_item_id,
      "shaping-decisions",
    );
    const manifestName = (await readdir(decisionDirectory)).find(
      (name) =>
        name.endsWith(".json") && !name.endsWith(".intent.json"),
    );
    if (manifestName === undefined) {
      throw new Error("Expected the pending shaping manifest.");
    }
    const manifestPath = join(decisionDirectory, manifestName);
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as Record<string, unknown>;
    const foreignDecisionId = "d".repeat(64);
    await writeFile(
      join(decisionDirectory, `${foreignDecisionId}.json`),
      `${JSON.stringify(
        { ...manifest, decision_id: foreignDecisionId },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await rm(manifestPath);

    await expect(
      createControllerAt(
        repository,
        "2026-08-04T09:00:00.000Z",
      ).startBrainstorm(item.goal.work_item_id, input),
    ).rejects.toMatchObject({ kind: "repair_required" });
  });

  it("rejects a different active run under a pending launch fingerprint", async () => {
    const { repository } = await createWorkspace();
    const item = await createUncontractedItem(repository);
    const input = {
      launch_mode: "connected" as const,
      next_requested_model: "brainstorm-model",
      expected_mission_content_sha256: null,
      expected_result_content_sha256: null,
      expected_shaping_state_sha256: await currentShapingStateHash(
        repository,
        item,
      ),
    };
    injectShapingResponseLoss(repository, "after_mission");
    await expect(
      createController(repository).startBrainstorm(
        item.goal.work_item_id,
        input,
      ),
    ).rejects.toThrow(/injected/u);

    const decisionDirectory = join(
      repository.workspaceRoot,
      ".founder",
      "work-items",
      item.goal.work_item_id,
      "shaping-decisions",
    );
    const intentName = (await readdir(decisionDirectory)).find((name) =>
      name.endsWith(".intent.json"),
    );
    if (intentName === undefined) {
      throw new Error("Expected the pending shaping intent.");
    }
    const intent = await repository.readShapingDecisionIntent(
      item.goal.work_item_id,
      intentName.replace(/\.intent\.json$/u, ""),
    );
    if (intent === null) {
      throw new Error("Expected the pending shaping intent.");
    }
    const mission = JSON.parse(
      intent.next_mission_package_bytes,
    ) as ShapingMissionPackage;
    await repository.createShapingRun(
      shapingRunInputForMission(mission, "different-model"),
    );

    await expect(
      createControllerAt(
        repository,
        "2026-08-04T10:00:00.000Z",
      ).startBrainstorm(item.goal.work_item_id, input),
    ).rejects.toMatchObject({ kind: "lease_held" });
    expect(await repository.listShapingRuns(item.goal.work_item_id)).toHaveLength(
      1,
    );
  });

  it("derives the transition idempotency key from exactly the governed tuple", () => {
    expect(
      deriveControllerIdempotencyKey(
        "wi_123e4567-e89b-12d3-a456-426614174000",
        "review",
        3,
        5,
        2,
      ),
    ).toBe(
      "wi_123e4567-e89b-12d3-a456-426614174000:review:3:5:2",
    );
  });

  it("applies one hash-bound exact scope correction and replays it idempotently", async () => {
    const { repository } = await createWorkspace();
    const governed = await governToExecute(repository);
    const changedFiles = [
      "app/api/workspaces/route.ts",
      "tests/api/portfolio-routes.test.ts",
    ];
    const git: GitVerificationAdapter = {
      ...passingGit,
      async listWorktreeChangedFilesExcludingFounder() {
        return [...changedFiles];
      },
    };
    const controller = createController(repository, git);
    const proposal = await controller.proposeScopeCorrection(
      governed.workItem.goal.work_item_id,
    );
    expect(proposal).toMatchObject({
      schema_version: 1,
      current_allowed_scope: firstContract.allowed_scope,
      proposed_allowed_scope: changedFiles,
      governed_tuple: {
        goal_version: 1,
        input_revision: 1,
        attempt: 0,
        patch_cycle: 0,
      },
    });
    if (proposal === null) {
      throw new Error("Expected an exact scope-correction proposal.");
    }
    const semanticDirectory = join(
      repository.workspaceRoot,
      ".founder",
      "semantic-events",
      governed.workItem.goal.work_item_id,
      "events",
    );
    const semanticBeforeProposalReplay = await readdir(semanticDirectory);
    await controller.proposeScopeCorrection(
      governed.workItem.goal.work_item_id,
    );
    expect(await readdir(semanticDirectory)).toEqual(
      semanticBeforeProposalReplay,
    );
    const commitControllerMutation =
      repository.commitControllerMutation.bind(repository);
    const correctionSemanticIntentCounts: number[] = [];
    repository.commitControllerMutation = async (lease, mutationInput) => {
      correctionSemanticIntentCounts.push(
        mutationInput.semantic_event_intents.length,
      );
      return commitControllerMutation(lease, mutationInput);
    };
    const input = {
      source_goal_contract_sha256: proposal.source_goal_contract_sha256,
      governed_tuple: proposal.governed_tuple,
      proposal_sha256: proposal.proposal_sha256,
    };
    const corrected = await controller.applyScopeCorrection(
      governed.workItem.goal.work_item_id,
      input,
    );
    expect(corrected.work_item.goal.goal_contract).toEqual({
      ...governed.workItem.goal.goal_contract,
      goal_version: 2,
      allowed_scope: changedFiles,
    });
    expect(corrected.work_item.state).toMatchObject({
      phase: "execute",
      status: "active",
      goal_version: 2,
      input_revision: 2,
      attempt: 0,
      patch_cycle: 0,
    });
    expect(corrected.manifest).toMatchObject({
      phase: "execute",
      goal_version: 2,
      input_revision: 2,
      attempt: 0,
      outcome: "applied",
      scope_correction: proposal,
    });
    const replay = await controller.applyScopeCorrection(
      governed.workItem.goal.work_item_id,
      input,
    );
    expect(replay.manifest).toEqual(corrected.manifest);
    expect(replay.work_item).toEqual(corrected.work_item);
    expect(correctionSemanticIntentCounts).toEqual([0]);
  });

  it("rejects a scope correction after the retained worktree changes", async () => {
    const { repository } = await createWorkspace();
    const governed = await governToExecute(repository);
    let changedFiles = ["app/api/workspaces/route.ts"];
    const git: GitVerificationAdapter = {
      ...passingGit,
      async listWorktreeChangedFilesExcludingFounder() {
        return [...changedFiles];
      },
    };
    const controller = createController(repository, git);
    const proposal = await controller.proposeScopeCorrection(
      governed.workItem.goal.work_item_id,
    );
    if (proposal === null) {
      throw new Error("Expected an exact scope-correction proposal.");
    }
    changedFiles = ["app/api/workspaces/route.ts", "src/unrelated.ts"];
    await expect(
      controller.applyScopeCorrection(governed.workItem.goal.work_item_id, {
        source_goal_contract_sha256:
          proposal.source_goal_contract_sha256,
        governed_tuple: proposal.governed_tuple,
        proposal_sha256: proposal.proposal_sha256,
      }),
    ).rejects.toMatchObject({ kind: "stale_expectation" });
  });

  it("renews exact command authorization after a terminal no-result attempt", async () => {
    const fixture = await createConnectedFixture();
    const changedFiles = [
      "src/application/[sourceId]/work-item-controller.ts",
      "src/domain/[workItemId].ts",
    ];
    const stagePaths = [
      "src/application/[[]sourceId[]]/work-item-controller.ts",
      "src/domain/[[]workItemId[]].ts",
    ];
    const git: GitVerificationAdapter = {
      ...passingGit,
      async listWorktreeChangedFilesExcludingFounder() {
        return [...changedFiles].reverse();
      },
    };
    const controller = createController(fixture.repository, git);
    await fixture.repository.createConnectedRun(fixture.record);
    await fixture.repository.completeConnectedRun(
      fixture.workItem.goal.work_item_id,
      fixture.record.connected_run_id,
      { outcome: "completed", partial: false, reason: null },
    );

    const prepared = await controller.prepareCommandAuthorization(
      fixture.workItem.goal.work_item_id,
      "execute",
    );
    expect(prepared.proposal).toMatchObject({
      schema_version: 1,
      phase: "execute",
      governed_tuple: fixture.input.governed_tuple,
      source_mission_content_sha256: fixture.input.mission_content_sha256,
      terminal_connected_run_id: fixture.record.connected_run_id,
      changed_files: changedFiles,
      commands: [
        { executable: "npm", args: ["test"] },
        { executable: "npm", args: ["run", "typecheck"] },
        { executable: "git", args: ["add", "--", ...stagePaths] },
        {
          executable: "git",
          args: ["commit", "-m", "Build the controller foundation"],
        },
      ],
    });
    expect(prepared.work_item.state.attention).toMatchObject({
      kind: "command_authorization",
      governed_tuple: fixture.input.governed_tuple,
      pins: {
        mission_content_sha256: fixture.input.mission_content_sha256,
      },
      proposal: {
        proposal_sha256: prepared.proposal.proposal_sha256,
      },
    });
    expect(prepared.manifest).toMatchObject({
      phase: "execute",
      attempt: 0,
      outcome: "applied",
      command_authorization: prepared.proposal,
    });
    if (prepared.manifest === null) {
      throw new Error("Expected the command-authorization manifest.");
    }
    await expectSemanticProducer(
      fixture.repository.workspaceRoot,
      fixture.workItem.goal.work_item_id,
      {
        kind: "controller_run",
        controller_run_id: prepared.manifest.run_id,
        expected_outcome: "applied",
      },
      [
        {
          kind: "attention_requested",
          slot: "attention-request",
          evidence_kind: "controller_run",
          evidence_path: `.founder/work-items/${fixture.workItem.goal.work_item_id}/runs/${prepared.manifest.run_id}.json`,
        },
      ],
    );

    const decision = {
      decision: "allow_once" as const,
      expected_phase: "execute" as const,
      governed_tuple: prepared.proposal.governed_tuple,
      source_mission_content_sha256:
        prepared.proposal.source_mission_content_sha256,
      terminal_connected_run_id:
        prepared.proposal.terminal_connected_run_id,
      proposal_sha256: prepared.proposal.proposal_sha256,
    };
    const applied = await controller.decideCommandAuthorization(
      fixture.workItem.goal.work_item_id,
      decision,
    );
    expect(applied.work_item.state).toMatchObject({
      phase: "execute",
      status: "active",
      attempt: 1,
    });
    expect(applied.work_item.state.attention).toBeUndefined();
    expect(applied.manifest).toMatchObject({
      phase: "execute",
      attempt: 1,
      outcome: "applied",
      command_authorization: prepared.proposal,
      capability_grant: {
        source_mission_content_sha256:
          prepared.proposal.source_mission_content_sha256,
      },
    });
    expect(
      applied.manifest?.capability_grant?.execution_defaults
        .approved_command_forms,
    ).toEqual(
      expect.arrayContaining(
        prepared.proposal.commands.map((command) => ({
          executable: command.executable,
          args: command.args,
        })),
      ),
    );
    await expectSemanticProducer(
      fixture.repository.workspaceRoot,
      fixture.workItem.goal.work_item_id,
      {
        kind: "controller_run",
        controller_run_id: applied.manifest!.run_id,
        expected_outcome: "applied",
      },
      [
        {
          kind: "permission_decided",
          slot: "permission-decision",
          evidence_kind: "controller_run",
          evidence_path: `.founder/work-items/${fixture.workItem.goal.work_item_id}/runs/${applied.manifest!.run_id}.json`,
        },
      ],
    );
    await expect(
      controller.decideCommandAuthorization(
        fixture.workItem.goal.work_item_id,
        decision,
      ),
    ).resolves.toEqual(applied);

    if (applied.manifest === null) {
      throw new Error("Expected the command decision manifest.");
    }
    const nextIdentity = {
      phase: "execute" as const,
      work_item_id: fixture.workItem.goal.work_item_id,
      goal_version: applied.work_item.state.goal_version!,
      input_revision: applied.work_item.state.input_revision!,
      attempt: applied.work_item.state.attempt!,
    };
    const retryMission = await fixture.repository.writeMissionPackage(
      nextIdentity,
      (paths) =>
        compileMission(applied.work_item, applied.manifest!, paths),
    );
    const retryEnvelope = retryMission.mission.capability_envelope;
    const retryRun: ConnectedRunRecordV2 = {
      ...fixture.record,
      connected_run_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b2",
      mission: {
        identity: nextIdentity,
        path: retryMission.mission.task_path.replace(/TASK\.md$/, "mission.json"),
        content_sha256: retryMission.mission.content_sha256,
        source_commit: retryMission.mission.source_revision.git_base_commit,
      },
      governed_tuple: {
        ...prepared.proposal.governed_tuple,
        attempt: 1,
      },
      provenance: {
        ...fixture.record.provenance,
        authorization_sha256: {
          value: hashResolvedCapabilityEnvelope(retryEnvelope),
          assurance: "controller_observed",
        },
      },
      authorization: {
        kind: "capability_envelope",
        envelope: retryEnvelope,
        envelope_sha256: hashResolvedCapabilityEnvelope(retryEnvelope),
      },
      lifecycle: {
        ...fixture.record.lifecycle,
        started_at: "2026-07-26T18:01:00.000Z",
        updated_at: "2026-07-26T18:01:00.000Z",
      },
    };
    await fixture.repository.createConnectedRun(retryRun);
    await fixture.repository.completeConnectedRun(
      fixture.workItem.goal.work_item_id,
      retryRun.connected_run_id,
      { outcome: "completed", partial: false, reason: null },
    );

    const renewed = await controller.prepareCommandAuthorization(
      fixture.workItem.goal.work_item_id,
      "execute",
    );
    expect(renewed.proposal).toMatchObject({
      governed_tuple: {
        ...prepared.proposal.governed_tuple,
        attempt: 1,
      },
      source_mission_content_sha256: retryMission.mission.content_sha256,
      terminal_connected_run_id: retryRun.connected_run_id,
      changed_files: changedFiles,
      commands: prepared.proposal.commands,
    });
    expect(renewed.proposal.proposal_sha256).not.toBe(
      prepared.proposal.proposal_sha256,
    );

    const renewedDecision = await controller.decideCommandAuthorization(
      fixture.workItem.goal.work_item_id,
      {
        decision: "allow_once",
        expected_phase: "execute",
        governed_tuple: renewed.proposal.governed_tuple,
        source_mission_content_sha256:
          renewed.proposal.source_mission_content_sha256,
        terminal_connected_run_id:
          renewed.proposal.terminal_connected_run_id,
        proposal_sha256: renewed.proposal.proposal_sha256,
      },
    );
    expect(renewedDecision.work_item.state).toMatchObject({
      phase: "execute",
      status: "active",
      attempt: 2,
    });
    expect(renewedDecision.manifest).toMatchObject({
      phase: "execute",
      attempt: 2,
      outcome: "applied",
      command_authorization: renewed.proposal,
      capability_grant: {
        source_mission_content_sha256:
          renewed.proposal.source_mission_content_sha256,
      },
    });
  });

  it("keeps an exact command authorization denied without advancing state", async () => {
    const fixture = await createConnectedFixture();
    const git: GitVerificationAdapter = {
      ...passingGit,
      async listWorktreeChangedFilesExcludingFounder() {
        return ["src/domain/work-item.ts"];
      },
    };
    const controller = createController(fixture.repository, git);
    await fixture.repository.createConnectedRun(fixture.record);
    await fixture.repository.completeConnectedRun(
      fixture.workItem.goal.work_item_id,
      fixture.record.connected_run_id,
      { outcome: "completed", partial: false, reason: null },
    );
    const prepared = await controller.prepareCommandAuthorization(
      fixture.workItem.goal.work_item_id,
      "execute",
    );
    const semanticBefore = await readdir(
      join(
        fixture.repository.workspaceRoot,
        ".founder",
        "semantic-events",
        fixture.workItem.goal.work_item_id,
        "events",
      ),
    );

    const denied = await controller.decideCommandAuthorization(
      fixture.workItem.goal.work_item_id,
      {
        decision: "keep_denied",
        expected_phase: "execute",
        governed_tuple: prepared.proposal.governed_tuple,
        source_mission_content_sha256:
          prepared.proposal.source_mission_content_sha256,
        terminal_connected_run_id:
          prepared.proposal.terminal_connected_run_id,
        proposal_sha256: prepared.proposal.proposal_sha256,
      },
    );
    expect(denied.manifest).toBeNull();
    expect(denied.work_item.state).toEqual(prepared.work_item.state);
    expect(denied.work_item.state.attempt).toBe(0);
    expect(denied.work_item.state.attention).toMatchObject({
      kind: "command_authorization",
      proposal: { proposal_sha256: prepared.proposal.proposal_sha256 },
    });
    expect(
      await readdir(
        join(
          fixture.repository.workspaceRoot,
          ".founder",
          "semantic-events",
          fixture.workItem.goal.work_item_id,
          "events",
        ),
      ),
    ).toEqual(semanticBefore);
  });

  it("refuses command preparation without a complete no-result run or exact in-scope changes", async () => {
    const noRun = await createConnectedFixture();
    await expect(
      noRun.controller.prepareCommandAuthorization(
        noRun.workItem.goal.work_item_id,
        "execute",
      ),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });

    const clean = await createConnectedFixture();
    await clean.repository.createConnectedRun(clean.record);
    await clean.repository.completeConnectedRun(
      clean.workItem.goal.work_item_id,
      clean.record.connected_run_id,
      { outcome: "completed", partial: false, reason: null },
    );
    await expect(
      createController(clean.repository, {
        ...passingGit,
        async listWorktreeChangedFilesExcludingFounder() {
          return [];
        },
      }).prepareCommandAuthorization(
        clean.workItem.goal.work_item_id,
        "execute",
      ),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });

    const outOfScope = await createConnectedFixture();
    await outOfScope.repository.createConnectedRun(outOfScope.record);
    await outOfScope.repository.completeConnectedRun(
      outOfScope.workItem.goal.work_item_id,
      outOfScope.record.connected_run_id,
      { outcome: "completed", partial: false, reason: null },
    );
    await expect(
      createController(outOfScope.repository, {
        ...passingGit,
        async listWorktreeChangedFilesExcludingFounder() {
          return ["app/outside-current-mission.ts"];
        },
      }).prepareCommandAuthorization(
        outOfScope.workItem.goal.work_item_id,
        "execute",
      ),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });
  });

  it("rejects command decisions that drift from the source, phase, tuple, or proposal", async () => {
    const fixture = await createConnectedFixture();
    const controller = createController(fixture.repository, {
      ...passingGit,
      async listWorktreeChangedFilesExcludingFounder() {
        return ["src/domain/work-item.ts"];
      },
    });
    await fixture.repository.createConnectedRun(fixture.record);
    await fixture.repository.completeConnectedRun(
      fixture.workItem.goal.work_item_id,
      fixture.record.connected_run_id,
      { outcome: "completed", partial: false, reason: null },
    );
    const prepared = await controller.prepareCommandAuthorization(
      fixture.workItem.goal.work_item_id,
      "execute",
    );
    const exact = {
      decision: "allow_once" as const,
      expected_phase: "execute" as const,
      governed_tuple: prepared.proposal.governed_tuple,
      source_mission_content_sha256:
        prepared.proposal.source_mission_content_sha256,
      terminal_connected_run_id:
        prepared.proposal.terminal_connected_run_id,
      proposal_sha256: prepared.proposal.proposal_sha256,
    };
    const staleInputs = [
      { ...exact, expected_phase: "patch" as const },
      {
        ...exact,
        governed_tuple: { ...exact.governed_tuple, attempt: 1 },
      },
      { ...exact, source_mission_content_sha256: "e".repeat(64) },
      { ...exact, proposal_sha256: "f".repeat(64) },
    ];

    for (const input of staleInputs) {
      await expect(
        controller.decideCommandAuthorization(
          fixture.workItem.goal.work_item_id,
          input,
        ),
      ).rejects.toMatchObject({ kind: "stale_expectation" });
    }
  });
});
