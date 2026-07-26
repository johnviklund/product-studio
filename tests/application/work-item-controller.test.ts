import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
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
  type ExecuteReviewSubject,
  type MissionIdentity,
  type PatchReviewSubject,
  type PatchSubject,
} from "../../src/domain/mission";
import {
  hashCanonicalCapabilityRequest,
  resolveCapabilityEnvelope,
  type ExecutionDefaultsV1,
} from "../../src/domain/capability-envelope";
import {
  hashResolvedCapabilityEnvelope,
  type ConnectedRunRecordV1,
} from "../../src/domain/connected-run";
import {
  hashResultContent,
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
import type {
  GitVerificationAdapter,
  VerificationRunner,
} from "../../src/domain/verification";
import {
  ControllerConflictError,
  workItemSchema,
  type ControllerRunManifest,
  type VerificationCommand,
  type WorkItem,
} from "../../src/domain/work-item";
import { ProductWorkspace } from "../../src/workspace/product-workspace";

const createdRoots: string[] = [];
const fixedClock = () => new Date("2026-07-21T21:00:00.000Z");
const testCommit = "a".repeat(40);
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

async function createWorkspace(): Promise<{
  root: string;
  repository: ProductWorkspace;
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
    repository: new ProductWorkspace(root, {
      git: passingGit,
      verificationRunner: passingRunner,
    }),
  };
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
  for (const targetPhase of ["spec", "plan", "execute"] as const) {
    mutation = await controller.transition(created.goal.work_item_id, {
      target_phase: targetPhase,
      target_status: "active",
      expected_phase: mutation.work_item.state.phase,
      expected_status: mutation.work_item.state.status,
      expected_schema_version: 2,
      expected_goal_version: mutation.work_item.state.goal_version!,
      expected_input_revision: mutation.work_item.state.input_revision!,
      attempt: mutation.work_item.state.attempt!,
    });
  }
  return { workItem: mutation.work_item, manifest: mutation.manifest };
}

async function createImportFixture(options?: {
  resultSource?: string;
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
  const paths = {
    task_path: `.founder/missions/${identity.work_item_id}/execute-${identity.goal_version}-${identity.input_revision}-${identity.attempt}/TASK.md`,
    output_path: `.founder/missions/${identity.work_item_id}/execute-${identity.goal_version}-${identity.input_revision}-${identity.attempt}/result.json`,
    git_base_commit: "0".repeat(40),
  };
  const mission = compileMission(workItem, manifest, paths);
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
    mission_path: paths.task_path.replace(/TASK\.md$/, "mission.json"),
    result_path: paths.output_path,
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
    governed_tuple: {
      goal_version: number;
      input_revision: number;
      attempt: number;
      patch_cycle: number;
    };
    mission_content_sha256: string;
  };
  record: ConnectedRunRecordV1;
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
  const artifact = await repository.writeMissionPackage(identity, (paths) =>
    compileMission(workItem, manifest, paths),
  );
  const defaults: ExecutionDefaultsV1 = {
    schema_version: 1,
    approved_command_forms: [{ executable: "npm", args: ["run", "test"] }],
    approved_url_operations: [],
    mcp: "forbidden",
    credentials: "forbidden",
  };
  const envelope = resolveCapabilityEnvelope(["src", "tests"], defaults);
  const envelopeSha256 = hashResolvedCapabilityEnvelope(envelope);
  const input = {
    expected_phase: "execute" as const,
    expected_status: "active" as const,
    expected_schema_version: 2 as const,
    governed_tuple: {
      goal_version: identity.goal_version,
      input_revision: identity.input_revision,
      attempt: identity.attempt,
      patch_cycle: workItem.state.patch_cycle!,
    },
    mission_content_sha256: artifact.mission.content_sha256,
  };
  const record: ConnectedRunRecordV1 = {
    schema_version: 1,
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
      capability_envelope_sha256: {
        value: envelopeSha256,
        assurance: "controller_observed",
      },
      authorization_sha256: {
        value: "d".repeat(64),
        assurance: "controller_observed",
      },
    },
    resolved_capability_envelope: {
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
        fixture.record.resolved_capability_envelope.envelope_sha256,
      connected_run_id: fixture.record.connected_run_id,
    };

    const denied = await fixture.controller.recordConnectedPermissionDenial(
      fixture.workItem.goal.work_item_id,
      { ...fixture.input, operation },
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
        fixture.record.resolved_capability_envelope.envelope_sha256,
      connected_run_id: fixture.record.connected_run_id,
    };

    await expect(
      fixture.controller.recordConnectedPermissionDenial(
        fixture.workItem.goal.work_item_id,
        { ...fixture.input, operation: inEnvelopeOperation },
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
        fixture.record.resolved_capability_envelope.envelope_sha256,
      connected_run_id: fixture.record.connected_run_id,
    };
    const denied = await fixture.controller.recordConnectedPermissionDenial(
      fixture.workItem.goal.work_item_id,
      { ...fixture.input, operation },
    );
    const decision = {
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
    const created = await createUncontractedItem(repository);
    const controller = createController(repository);
    let mutation = await controller.updateGoalContract(
      created.goal.work_item_id,
      firstContract,
    );

    for (const targetPhase of ["spec", "plan", "execute"] as const) {
      mutation = await controller.transition(created.goal.work_item_id, {
        target_phase: targetPhase,
        target_status: "active",
        expected_phase: mutation.work_item.state.phase,
        expected_status: mutation.work_item.state.status,
        expected_schema_version: 2,
        expected_goal_version: mutation.work_item.state.goal_version!,
        expected_input_revision: mutation.work_item.state.input_revision!,
        attempt: mutation.work_item.state.attempt!,
      });
    }

    const before = await repository.read(created.goal.work_item_id);
    const runsPath = join(
      root,
      ".founder",
      "work-items",
      created.goal.work_item_id,
      "runs",
    );
    const runsBefore = await readdir(runsPath);

    await expect(
      controller.updateGoalContract(created.goal.work_item_id, {
        ...firstContract,
        acceptance_criteria: ["Execute contracts stay fixed"],
        expected_goal_version: 1,
        expected_input_revision: 1,
      }),
    ).rejects.toMatchObject({
      name: "ControllerConflictError",
      kind: "goal_contract_locked",
    });
    expect(await repository.read(created.goal.work_item_id)).toEqual(before);
    expect(await readdir(runsPath)).toEqual(runsBefore);

    const afterRejectedUpdate = await repository.read(created.goal.work_item_id);
    const transitioned = await controller.transition(created.goal.work_item_id, {
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

  it("applies and replays an exact transition without changing durable state twice", async () => {
    const { root, repository } = await createWorkspace();
    const created = await createUncontractedItem(repository);
    const controller = createController(repository);
    await controller.updateGoalContract(created.goal.work_item_id, firstContract);
    const input = {
      target_phase: "spec" as const,
      target_status: "active" as const,
      expected_phase: "idea" as const,
      expected_status: "active" as const,
      expected_schema_version: 2 as const,
      expected_goal_version: 1,
      expected_input_revision: 1,
      attempt: 0,
    };

    const applied = await controller.transition(created.goal.work_item_id, input);
    expect(applied.work_item.state).toMatchObject({
      phase: "spec",
      status: "active",
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
    });
    const durableAfterFirst = await repository.read(created.goal.work_item_id);

    const replay = await controller.transition(created.goal.work_item_id, input);
    expect(replay).toEqual(applied);
    expect(await repository.read(created.goal.work_item_id)).toEqual(
      durableAfterFirst,
    );
    expect(
      await readdir(
        join(
          root,
          ".founder",
          "work-items",
          created.goal.work_item_id,
          "runs",
        ),
      ),
    ).toHaveLength(2);
  });

  it("rejects missing contracts, stale expectations, invalid moves, and attempt conflicts", async () => {
    const { repository } = await createWorkspace();
    const created = await createUncontractedItem(repository);
    const controller = createController(repository);

    await expect(
      controller.transition(created.goal.work_item_id, {
        target_phase: "spec",
        target_status: "active",
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
          target_phase: "spec" as const,
          target_status: "active" as const,
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
          target_phase: "spec" as const,
          target_status: "active" as const,
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
    },
  );

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
});
