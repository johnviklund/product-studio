import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";

import {
  compileMission,
  compilePatchMission,
  compileReviewMission,
  hashHistoricalMissionContentV3,
  renderReadableTaskMd,
  renderTaskMd,
  serializeReadableMissionPackage,
  serializeMissionPackage,
  type HistoricalExecuteMissionPackageV3,
  type HistoricalReviewMissionPackageV3,
  type MissionIdentity,
  type PatchSubject,
  type ReviewMissionControllerRun,
} from "../src/domain/mission";
import {
  createImportRunId,
  hashResultContent,
  serializeExternalResult,
  type ImportEvidenceEnvelope,
} from "../src/domain/result";
import {
  compileBrainstormMission,
  compilePlanMission,
  compileSpecMission,
  deriveShapingDecisionId,
  hashGoalContract,
  hashGoalInput,
  hashShapingIngressInstruction,
  hashShapingInput,
  serializeShapingPackage,
  SHAPING_INGRESS_MAX_BYTES,
  type BrainstormResultSubmission,
  type PlanApprovalReceipt,
  type PlanResultSubmission,
  type ShapingArtifactWriteResult,
  type ShapingIdentity,
  type ShapingDecisionManifestV1,
  type ShapingMissionPackage,
  type ShapingSelectionReceipt,
  type SpecApprovalReceipt,
  type SpecResultSubmission,
} from "../src/domain/shaping";
import { deriveManualShapingProductionId } from "../src/domain/shaping-run";
import {
  InvalidWorkspaceError,
  type ActiveRun,
  type ControllerMutationInput,
  type ControllerRunManifest,
  type PlanApprovalIntentDraft,
  type PlanApprovalManifestV1,
  type ShapingDecisionIntentDraft,
  type WorkItem,
} from "../src/domain/work-item";
import type { GitVerificationAdapter } from "../src/domain/verification";
import { ProductWorkspace } from "../src/workspace/product-workspace";

const execFileAsync = promisify(execFile);

const createdRoots: string[] = [];
const firstId = "wi_123e4567-e89b-12d3-a456-426614174000";
const secondId = "wi_550e8400-e29b-41d4-a716-446655440000";
const firstRunId = "550e8400-e29b-41d4-a716-446655440000";
const secondRunId = "123e4567-e89b-42d3-a456-426614174000";
const thirdRunId = "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1";
const testGit: GitVerificationAdapter = {
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
    return ["src/domain/result.ts"];
  },
};

function missionWorkspace(root: string) {
  return new ProductWorkspace(root, { git: testGit });
}

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "product-studio-workspace-"));
  createdRoots.push(root);

  const founderDirectory = join(root, ".founder");
  await mkdir(founderDirectory, { recursive: true });
  await writeFile(
    join(founderDirectory, "product.yaml"),
    stringify({
      schema_version: 2,
      product_name: "Test Workspace",
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

async function writeWorkItem(
  root: string,
  workItemId: string,
  updatedAt: string,
): Promise<void> {
  const directory = join(root, ".founder", "work-items", workItemId);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "goal.yaml"),
    stringify({
      schema_version: 2,
      work_item_id: workItemId,
      title: `Item ${workItemId}`,
      type: "Explore",
    }),
    "utf8",
  );
  await writeFile(
    join(directory, "state.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        work_item_id: workItemId,
        phase: "idea",
        status: "active",
        updated_at: updatedAt,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function writeContractedWorkItem(
  root: string,
  workItemId: string,
): Promise<void> {
  const directory = join(root, ".founder", "work-items", workItemId);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "goal.yaml"),
    stringify({
      schema_version: 2,
      work_item_id: workItemId,
      title: `Item ${workItemId}`,
      type: "Explore",
      goal_contract: {
        schema_version: 1,
        goal_version: 1,
        purpose: "Keep workspace contracts strict.",
        acceptance_criteria: ["Reject stale state"],
        non_goals: ["Do not infer missing state."],
        allowed_scope: ["src/domain"],
        review_ready: ["Checks pass"],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(directory, "state.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        work_item_id: workItemId,
        phase: "idea",
        status: "active",
        updated_at: "2026-07-21T20:00:00.000Z",
        goal_version: 1,
        input_revision: 1,
        attempt: 0,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function writeShapingReadyWorkItem(
  root: string,
  workItemId: string,
  phase: "idea" | "brainstorm" | "spec" | "plan" = "brainstorm",
): Promise<WorkItem> {
  const directory = join(root, ".founder", "work-items", workItemId);
  const goal = {
    schema_version: 2 as const,
    work_item_id: workItemId,
    title: `Shape item ${workItemId}`,
    type: "Feature" as const,
    notes: "Keep shaping artifacts immutable.",
  };
  const state = {
    schema_version: 2 as const,
    work_item_id: workItemId,
    phase,
    status: "active" as const,
    updated_at: "2026-07-29T00:00:00.000Z",
  };
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "goal.yaml"), stringify(goal), "utf8");
  await writeFile(
    join(directory, "state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
  return { goal, state };
}

async function writeBrainstormShapingArtifact(
  root: string,
  workItemId: string,
) {
  const item = await writeShapingReadyWorkItem(root, workItemId);
  const input = {
    phase: "brainstorm" as const,
    title: item.goal.title,
    notes: item.goal.notes,
  };
  const identity: ShapingIdentity<"brainstorm"> = {
    phase: "brainstorm",
    work_item_id: workItemId,
    input_sha256: hashShapingInput(input),
  };
  const workspace = new ProductWorkspace(root);
  const artifact = await workspace.writeShapingMissionPackage(
    identity,
    (paths) =>
      compileBrainstormMission({
        work_item_id: workItemId,
        shaping_input: input,
        paths,
      }),
  );
  return { artifact, workspace };
}

function hashSource(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function brainstormResultFor(
  artifact: ShapingArtifactWriteResult<ShapingMissionPackage>,
  problemStatement = "Publish the exact bounded ingress bytes.",
): BrainstormResultSubmission {
  if (artifact.mission.identity.phase !== "brainstorm") {
    throw new Error("Expected a Brainstorm shaping artifact");
  }
  return {
    result_schema_version: 1,
    brainstorm_mission_content_sha256: artifact.mission.content_sha256,
    identity: artifact.mission.identity,
    problem_statement: problemStatement,
    approach: "Validate once and publish one atomic bundle.",
    non_goals: ["Do not write into the immutable mission root."],
    open_questions: ["Which controller step consumes this result next?"],
  };
}

async function writeManualShapingIngress(
  root: string,
  workspace: ProductWorkspace,
  artifact: ShapingArtifactWriteResult<ShapingMissionPackage>,
  resultSource: string,
) {
  const instruction = await workspace.writeShapingIngressInstruction({
    origin: "manual_import",
    shaping_run_id: null,
    mission: artifact.mission,
  });
  const ingressPath = join(
    root,
    ...instruction.instruction.ingress_path.split("/"),
  );
  await writeFile(ingressPath, resultSource, "utf8");
  return { ...instruction, ingressPath };
}

const connectedShapingProduction = {
  origin: "connected_run" as const,
  shaping_run_id: firstRunId,
  requested_model: {
    value: "model-a",
    assurance: "user_declared" as const,
  },
  effective_model: {
    assurance: "adapter_attested" as const,
    model_id: "model-a",
    deployment_id: null,
    observed_event_sha256: "a".repeat(64),
  },
};

async function prepareStartShapingDecision(
  root: string,
  workspace: ProductWorkspace,
  options: { contracted?: boolean; legacyState?: boolean } = {},
) {
  let item: WorkItem;
  if (options.contracted === true) {
    await writeContractedWorkItem(root, firstId);
    const stored = await workspace.read(firstId);
    if (stored === null) {
      throw new Error("Expected contracted shaping work item");
    }
    item = stored;
  } else if (options.legacyState === true) {
    const stored = await workspace.read(firstId);
    if (stored === null) {
      throw new Error("Expected legacy shaping work item");
    }
    item = stored;
  } else {
    item = await writeShapingReadyWorkItem(root, firstId, "idea");
  }
  const shapingInput = {
    phase: "brainstorm" as const,
    title: item.goal.title,
    notes: item.goal.notes,
  };
  const identity: ShapingIdentity<"brainstorm"> = {
    phase: "brainstorm",
    work_item_id: firstId,
    input_sha256: hashShapingInput(shapingInput),
  };
  const directory = `.founder/shaping/${firstId}/brainstorm-${identity.input_sha256}`;
  const mission = compileBrainstormMission({
    work_item_id: firstId,
    shaping_input: shapingInput,
    paths: {
      task_path: `${directory}/TASK.md`,
      output_path: `${directory}/result.json`,
    },
  });
  const missionBytes = serializeShapingPackage(mission);
  const nextState = {
    ...item.state,
    phase: "brainstorm" as const,
    updated_at: "2026-08-02T10:01:00.000Z",
  };
  const draft: ShapingDecisionIntentDraft = {
    schema_version: 1,
    work_item_id: firstId,
    operation: "start_brainstorm",
    launch_mode: "manual",
    phase_from: "idea",
    phase_to: "brainstorm",
    goal_input_sha256: hashGoalInput({
      title: item.goal.title,
      notes: item.goal.notes,
    }),
    mission_content_sha256: null,
    result_content_sha256: null,
    feedback_sha256: null,
    expected_shaping_state_sha256: "b".repeat(64),
    next_requested_model: null,
    next_mission_content_sha256: mission.content_sha256,
    next_mission_input_sha256: identity.input_sha256,
    plan_repository_base_commit: null,
    plan_goal_contract_sha256: null,
    plan_goal_version: null,
    launch_fingerprint: null,
    decision_receipt_bytes: null,
    next_mission_package_bytes: missionBytes,
  };
  const run = activeRun(
    firstRunId,
    `${firstId}:shaping:start-brainstorm`,
  );
  const lease = await workspace.acquireControllerLease(firstId, run);
  if (lease === null) {
    throw new Error("Expected shaping decision lease");
  }
  const writtenIntent = await workspace.writeShapingDecisionIntent(lease, {
    intent: draft,
    state: nextState,
  });
  const manifest: ShapingDecisionManifestV1 = {
    schema_version: 1,
    decision_id: writtenIntent.intent.decision_id,
    work_item_id: firstId,
    operation: draft.operation,
    phase_from: draft.phase_from,
    phase_to: draft.phase_to,
    mission_content_sha256: draft.mission_content_sha256,
    result_content_sha256: draft.result_content_sha256,
    feedback_sha256: draft.feedback_sha256,
    expected_shaping_state_sha256:
      draft.expected_shaping_state_sha256,
    next_mission_content_sha256: draft.next_mission_content_sha256,
    goal_sha256: writtenIntent.intent.next_goal_sha256,
    state_sha256: writtenIntent.intent.next_state_sha256,
    goal_version: null,
    input_revision: null,
    started_at: "2026-08-02T10:00:00.000Z",
    outcome: "pending",
  };
  return {
    item,
    identity,
    mission,
    missionBytes,
    nextState,
    draft,
    run,
    lease,
    writtenIntent,
    manifest,
  };
}

async function writeAppliedShapingBundle(
  artifact: ShapingArtifactWriteResult<ShapingMissionPackage>,
  result:
    | BrainstormResultSubmission
    | SpecResultSubmission
    | PlanResultSubmission,
) {
  const appliedDirectory = join(dirname(artifact.mission_path), "applied");
  const resultSource = `${JSON.stringify(result, null, 2)}\n`;
  const resultContentSha256 = hashSource(resultSource);
  const importReceipt = {
    shaping_schema_version: 2 as const,
    identity: artifact.mission.identity,
    shaping_mission_content_sha256: artifact.mission.content_sha256,
    result_content_sha256: resultContentSha256,
    outcome: "applied" as const,
    first_published_at: "2026-08-01T12:00:00.000Z",
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
    produced_at: "2026-08-01T12:00:01.000Z",
    requested_model: { value: null, assurance: "unknown" as const },
    effective_model: {
      assurance: "unknown" as const,
      model_id: null,
      deployment_id: null,
      observed_event_sha256: null,
    },
    ingress_path: `.founder/shaping-ingress/${artifact.mission.identity.work_item_id}/${artifact.mission.identity.phase}-${artifact.mission.identity.input_sha256}/result.json`,
    result_content_sha256: resultContentSha256,
  };
  const importSource = `${JSON.stringify(importReceipt, null, 2)}\n`;
  const productionSource = `${JSON.stringify(productionReceipt, null, 2)}\n`;
  const appliedMarker = {
    schema_version: 1 as const,
    mission_content_sha256: artifact.mission.content_sha256,
    result_content_sha256: resultContentSha256,
    component_sha256: {
      result: hashSource(resultSource),
      import: hashSource(importSource),
      production: hashSource(productionSource),
    },
    component_bytes: {
      result: Buffer.byteLength(resultSource),
      import: Buffer.byteLength(importSource),
      production: Buffer.byteLength(productionSource),
    },
    committed_at: "2026-08-01T12:00:02.000Z",
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
    `${JSON.stringify(appliedMarker, null, 2)}\n`,
    "utf8",
  );

  return {
    appliedDirectory,
    resultSource,
    resultContentSha256,
    importReceipt,
    productionReceipt,
    appliedMarker,
  };
}

async function preparePlanApprovalCommit(
  root: string,
  workspace: ProductWorkspace,
) {
  const executeItem = await writeMissionReadyWorkItem(root, firstId);
  const item: WorkItem = {
    ...executeItem,
    state: {
      ...executeItem.state,
      phase: "plan",
      updated_at: "2026-08-03T09:00:00.000Z",
    },
  };
  await writeFile(
    join(root, ".founder", "work-items", firstId, "state.json"),
    `${JSON.stringify(item.state, null, 2)}\n`,
    "utf8",
  );
  if (item.goal.goal_contract === undefined) {
    throw new Error("Expected a contracted Plan work item");
  }

  const goalContractSha256 = hashGoalContract(item.goal.goal_contract);
  const specIdentity: ShapingIdentity<"spec"> = {
    phase: "spec",
    work_item_id: firstId,
    input_sha256: "1".repeat(64),
  };
  const specMissionContentSha256 = "2".repeat(64);
  const specResult: SpecResultSubmission = {
    result_schema_version: 1,
    spec_mission_content_sha256: specMissionContentSha256,
    identity: specIdentity,
    proposal: {
      purpose: item.goal.goal_contract.purpose,
      acceptance_criteria: item.goal.goal_contract.acceptance_criteria,
      non_goals: item.goal.goal_contract.non_goals,
      allowed_scope: item.goal.goal_contract.allowed_scope,
      review_ready: item.goal.goal_contract.review_ready,
    },
  };
  const specApproval: SpecApprovalReceipt = {
    shaping_schema_version: 2,
    identity: specIdentity,
    mission_content_sha256: specMissionContentSha256,
    result_content_sha256: "3".repeat(64),
    goal_contract_sha256: goalContractSha256,
    approved_at: "2026-08-03T09:01:00.000Z",
  };
  const planInput = {
    phase: "plan" as const,
    title: item.goal.title,
    notes: item.goal.notes,
    spec_approval_sha256: hashSource(
      `${JSON.stringify(specApproval, null, 2)}\n`,
    ),
    spec_approval: specApproval,
    spec_result: specResult,
    repository_base_commit: "a".repeat(40),
    goal_contract_sha256: goalContractSha256,
    goal_version: item.goal.goal_contract.goal_version,
  };
  const planIdentity: ShapingIdentity<"plan"> = {
    phase: "plan",
    work_item_id: firstId,
    input_sha256: hashShapingInput(planInput),
  };
  const plan = await workspace.writeShapingMissionPackage(
    planIdentity,
    (paths) =>
      compilePlanMission({
        work_item_id: firstId,
        shaping_input: planInput,
        paths,
      }),
  );
  const planResult: PlanResultSubmission = {
    result_schema_version: 1,
    plan_mission_content_sha256: plan.mission.content_sha256,
    identity: planIdentity,
    summary: "Approve one immutable Plan result into Execute.",
    checklist: [
      {
        id: "step-1",
        step: "Commit the exact Execute transition.",
        verification_check: "Run the workspace contract test.",
      },
    ],
    relevant_skills: [],
    product_doc_impacts: [],
    todo_impacts: [],
    open_questions: [],
  };
  const appliedPlan = await writeAppliedShapingBundle(plan, planResult);
  const receipt: PlanApprovalReceipt = {
    shaping_schema_version: 2,
    identity: planIdentity,
    mission_content_sha256: plan.mission.content_sha256,
    result_content_sha256: appliedPlan.resultContentSha256,
    goal_contract_sha256: goalContractSha256,
    goal_version: item.goal.goal_contract.goal_version,
    execute_tuple: {
      goal_version: item.state.goal_version!,
      input_revision: item.state.input_revision!,
      attempt: 0,
    },
    approved_at: "2026-08-03T09:02:00.000Z",
  };
  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  const draft: PlanApprovalIntentDraft = {
    schema_version: 1,
    work_item_id: firstId,
    launch_mode: "manual",
    requested_model: null,
    expected_mission_content_sha256: plan.mission.content_sha256,
    expected_result_content_sha256: appliedPlan.resultContentSha256,
    expected_shaping_state_sha256: "4".repeat(64),
    goal_contract_sha256: goalContractSha256,
    goal_version: item.goal.goal_contract.goal_version,
    receipt_bytes: receiptBytes,
    receipt_sha256: hashSource(receiptBytes),
    execute_tuple: receipt.execute_tuple,
  };
  const nextState = {
    ...item.state,
    phase: "execute" as const,
    updated_at: "2026-08-03T09:03:00.000Z",
    attempt: 0,
  };
  const run = activeRun(firstRunId, `${firstId}:approve-plan`);
  const lease = await workspace.acquireControllerLease(firstId, run);
  if (lease === null) {
    throw new Error("Expected Plan approval lease");
  }
  const writtenIntent = await workspace.writePlanApprovalIntent(lease, {
    intent: draft,
    state: nextState,
  });
  const writtenReceipt = await workspace.writeShapingDecisionReceipt(receipt);
  const manifest: PlanApprovalManifestV1 = {
    schema_version: 1,
    approval_id: writtenIntent.intent.approval_id,
    work_item_id: firstId,
    launch_mode: draft.launch_mode,
    requested_model: draft.requested_model,
    expected_mission_content_sha256:
      draft.expected_mission_content_sha256,
    expected_result_content_sha256: draft.expected_result_content_sha256,
    expected_shaping_state_sha256: draft.expected_shaping_state_sha256,
    goal_contract_sha256: draft.goal_contract_sha256,
    goal_version: draft.goal_version,
    receipt_sha256: writtenReceipt.receipt_content_sha256,
    execute_tuple: draft.execute_tuple,
    goal_sha256: writtenIntent.intent.next_goal_sha256,
    state_sha256: writtenIntent.intent.next_state_sha256,
    started_at: "2026-08-03T09:04:00.000Z",
    outcome: "pending",
  };
  return {
    item,
    plan,
    receipt,
    draft,
    nextState,
    run,
    lease,
    writtenIntent,
    manifest,
  };
}

async function writeMissionReadyWorkItem(
  root: string,
  workItemId: string,
  phase: "execute" | "review" | "patch" = "execute",
  patchCycle = phase === "patch" ? 1 : 0,
): Promise<WorkItem> {
  const directory = join(root, ".founder", "work-items", workItemId);
  const goal = {
    schema_version: 2 as const,
    work_item_id: workItemId,
    title: `Mission item ${workItemId}`,
    type: "Feature" as const,
    goal_contract: {
      schema_version: 1 as const,
      goal_version: 1,
      purpose: "Keep the mission reproducible.",
      acceptance_criteria: ["The mission is reproducible"],
      non_goals: ["Do not mutate unrelated state."],
      allowed_scope: ["src/domain"],
      review_ready: ["Checks pass"],
    },
  };
  const state = {
    schema_version: 2 as const,
    work_item_id: workItemId,
    phase,
    status: "active" as const,
    updated_at: "2026-07-22T12:00:01.000Z",
    goal_version: 1,
    input_revision: 1,
    attempt: 0,
    patch_cycle: patchCycle,
  };
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "goal.yaml"), stringify(goal), "utf8");
  await writeFile(
    join(directory, "state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
  return { goal, state };
}

function missionIdentity(
  workItemId = firstId,
  overrides: Partial<
    Omit<MissionIdentity<"execute">, "phase" | "work_item_id">
  > = {},
): MissionIdentity<"execute"> {
  return {
    phase: "execute",
    work_item_id: workItemId,
    goal_version: overrides.goal_version ?? 1,
    input_revision: overrides.input_revision ?? 1,
    attempt: overrides.attempt ?? 0,
  };
}

async function writeRejectedEvidence(
  workspace: ProductWorkspace,
  identity: MissionIdentity<"execute">,
  submissionSource: string,
  completedAt: string,
): Promise<ImportEvidenceEnvelope> {
  const missionContentSha256 = "b".repeat(64);
  const resultContentSha256 = hashResultContent(submissionSource);
  const evidence: ImportEvidenceEnvelope = {
    schema_version: 2,
    phase: identity.phase,
    import_run_id: createImportRunId(
      missionContentSha256,
      resultContentSha256,
    ),
    result_content_sha256: resultContentSha256,
    mission_content_sha256: missionContentSha256,
    identity,
    git_base_commit: "a".repeat(40),
    result_commit: null,
    controller_run_id: thirdRunId,
    started_at: "2026-07-22T12:00:00.000Z",
    completed_at: completedAt,
    outcome: "rejected",
    reasons: ["The result did not satisfy its governed contract."],
  };
  await workspace.writeImportEvidence({
    submission_source: submissionSource,
    evidence,
    verification: [],
  });
  return evidence;
}

function appliedExecuteManifest(
  runId = firstRunId,
  overrides: Partial<ControllerRunManifest> = {},
): ControllerRunManifest {
  return {
    schema_version: 1,
    run_id: runId,
    work_item_id: firstId,
    idempotency_key: `${firstId}:execute:1:1:0:${runId}`,
    phase: "execute",
    goal_version: 1,
    input_revision: 1,
    attempt: 0,
    started_at: "2026-07-22T12:00:00.000Z",
    completed_at: "2026-07-22T12:00:01.000Z",
    outcome: "applied",
    ...overrides,
  };
}

async function writeRunManifest(
  root: string,
  manifest: ControllerRunManifest,
): Promise<void> {
  const runsDirectory = join(
    root,
    ".founder",
    "work-items",
    manifest.work_item_id,
    "runs",
  );
  await mkdir(runsDirectory, { recursive: true });
  await writeFile(
    join(runsDirectory, `${manifest.run_id}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

function activeRun(
  runId = firstRunId,
  idempotencyKey = `${firstId}:spec:1:1:0`,
): ActiveRun {
  return {
    run_id: runId,
    idempotency_key: idempotencyKey,
    acquired_at: "2026-07-21T20:01:00.000Z",
  };
}

function controllerMutation(
  current: WorkItem,
  run: ActiveRun,
  overrides: {
    goalVersion?: number;
    inputRevision?: number;
    phase?: "idea" | "spec";
  } = {},
): ControllerMutationInput {
  const goalVersion = overrides.goalVersion ?? 1;
  const inputRevision = overrides.inputRevision ?? 1;
  const phase = overrides.phase ?? "spec";

  return {
    goal: {
      ...current.goal,
      goal_contract: {
        schema_version: 1,
        goal_version: goalVersion,
        purpose: "Keep controller mutations safe.",
        acceptance_criteria: ["Reject stale state"],
        non_goals: ["Do not bypass controller checks."],
        allowed_scope: ["src/domain"],
        review_ready: ["Checks pass"],
      },
    },
    state: {
      ...current.state,
      phase,
      updated_at: "2026-07-21T20:02:00.000Z",
      goal_version: goalVersion,
      input_revision: inputRevision,
      attempt: 0,
      patch_cycle: 0,
    },
    manifest: {
      schema_version: 1,
      run_id: run.run_id,
      work_item_id: current.goal.work_item_id,
      idempotency_key: run.idempotency_key,
      phase,
      goal_version: goalVersion,
      input_revision: inputRevision,
      attempt: 0,
      started_at: "2026-07-21T20:01:00.000Z",
      outcome: "pending",
    },
  };
}

class FailingControllerWorkspace extends ProductWorkspace {
  protected override async afterControllerGoalReplaced(): Promise<void> {
    throw new Error("injected controller state write failure");
  }
}

class FailingRetainedLeaseRepairWorkspace extends ProductWorkspace {
  protected override async afterRetainedControllerStateCleared(): Promise<void> {
    throw new Error("injected retained-lease repair failure");
  }
}

class FailingPendingShapingDecisionWorkspace extends ProductWorkspace {
  protected override async afterShapingDecisionPendingManifestWritten(): Promise<void> {
    throw new Error("injected failure before shaping decision rename");
  }
}

class FailingAppliedManifestWorkspace extends ProductWorkspace {
  protected override async afterShapingDecisionStateReplaced(): Promise<void> {
    throw new Error("injected failure before applied decision manifest");
  }
}

class MutatingShapingIngressWorkspace extends ProductWorkspace {
  constructor(
    root: string,
    private readonly mutateAfterOpen: (ingressPath: string) => Promise<void>,
  ) {
    super(root);
  }

  protected override async afterShapingIngressOpened(
    ingressPath: string,
  ): Promise<void> {
    await this.mutateAfterOpen(ingressPath);
  }
}

type ShapingPublicationFailureBoundary =
  | "instruction"
  | "result"
  | "import"
  | "production"
  | "applied"
  | "renamed";

class FailingShapingPublicationWorkspace extends ProductWorkspace {
  constructor(
    root: string,
    private readonly boundary: ShapingPublicationFailureBoundary,
  ) {
    super(root);
  }

  protected override async afterShapingIngressInstructionWritten(): Promise<void> {
    if (this.boundary === "instruction") {
      throw new Error("injected failure after instruction write");
    }
  }

  protected override async afterShapingAppliedComponentWritten(
    component: "result" | "import" | "production" | "applied",
  ): Promise<void> {
    if (this.boundary === component) {
      throw new Error(`injected failure after ${component} write`);
    }
  }

  protected override async afterShapingAppliedBundleRenamed(): Promise<void> {
    if (this.boundary === "renamed") {
      throw new Error("injected failure after applied bundle rename");
    }
  }
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ProductWorkspace", () => {
  it("creates, reads, and lists a durable work item", async () => {
    const root = await createWorkspace();
    const workspace = missionWorkspace(root);

    const created = await workspace.create({
      title: "Prove durable files",
      type: "MVP",
    });

    const itemDirectory = join(
      root,
      ".founder",
      "work-items",
      created.goal.work_item_id,
    );
    expect((await readdir(itemDirectory)).sort()).toEqual([
      "goal.yaml",
      "state.json",
    ]);
    expect(parse(await readFile(join(itemDirectory, "goal.yaml"), "utf8"))).toEqual(
      created.goal,
    );
    expect(
      JSON.parse(await readFile(join(itemDirectory, "state.json"), "utf8")),
    ).toEqual(created.state);
    expect(created.state).toMatchObject({ phase: "idea", status: "active" });
    expect(await workspace.read(created.goal.work_item_id)).toEqual(created);
    expect(await workspace.list()).toEqual([created]);
    expect(await workspace.read(secondId)).toBeNull();
  });

  it("creates an untyped capture with immutable provenance", async () => {
    const root = await createWorkspace();
    const workspace = new ProductWorkspace(root);

    const created = await workspace.createCapture({
      title: "Capture this exact sentence",
      capture_kind: "todo",
      priority: "high",
      tags: ["Question"],
      notes: "Keep the context durable.",
    });

    expect(created.goal).toMatchObject({
      schema_version: 2,
      title: "Capture this exact sentence",
      capture: {
        kind: "todo",
        original_title: "Capture this exact sentence",
      },
      priority: "high",
      tags: ["Question"],
      notes: "Keep the context durable.",
    });
    expect(created.goal).not.toHaveProperty("type");
    expect(created.goal.capture?.captured_at).toMatch(/Z$/);
    expect(created.state).toMatchObject({ phase: "idea", status: "active" });
    expect(await workspace.read(created.goal.work_item_id)).toEqual(created);
  });

  it("upgrades a v1 governed state on read without rewriting its durable bytes", async () => {
    const root = await createWorkspace();
    await writeContractedWorkItem(root, firstId);
    const workspace = new ProductWorkspace(root);
    const statePath = join(
      root,
      ".founder",
      "work-items",
      firstId,
      "state.json",
    );
    const originalStateSource = await readFile(statePath, "utf8");

    const item = await workspace.read(firstId);

    expect(item?.state).toMatchObject({
      schema_version: 2,
      patch_cycle: 0,
    });
    expect(await readFile(statePath, "utf8")).toBe(originalStateSource);
  });

  it("orders newest items first and uses work_item_id as the tie-breaker", async () => {
    const root = await createWorkspace();
    await writeWorkItem(root, secondId, "2026-07-17T12:00:00.000Z");
    await writeWorkItem(root, firstId, "2026-07-17T12:00:00.000Z");
    const newestId = "wi_ffffffff-ffff-4fff-afff-ffffffffffff";
    await writeWorkItem(root, newestId, "2026-07-17T12:00:01.000Z");

    const items = await new ProductWorkspace(root).list();

    expect(items.map(({ goal }) => goal.work_item_id)).toEqual([
      newestId,
      firstId,
      secondId,
    ]);
  });

  it("atomically updates only the validated state phase", async () => {
    const root = await createWorkspace();
    await writeWorkItem(root, firstId, "2026-07-17T12:00:00.000Z");
    const workspace = new ProductWorkspace(root);
    const itemDirectory = join(root, ".founder", "work-items", firstId);
    const goalPath = join(itemDirectory, "goal.yaml");
    const statePath = join(itemDirectory, "state.json");
    const goalBefore = await readFile(goalPath, "utf8");

    const updated = await workspace.updatePhase(firstId, {
      target_phase: "spec",
    });

    expect(updated).not.toBeNull();
    if (updated === null) {
      throw new Error("Expected the existing item to be updated");
    }
    expect(updated.state).toMatchObject({ phase: "spec", status: "active" });
    expect(Date.parse(updated.state.updated_at)).toBeGreaterThan(
      Date.parse("2026-07-17T12:00:00.000Z"),
    );
    expect(await workspace.read(firstId)).toEqual(updated);
    expect(await readFile(goalPath, "utf8")).toBe(goalBefore);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual(updated.state);
    expect((await readdir(itemDirectory)).sort()).toEqual([
      "goal.yaml",
      "state.json",
    ]);
  });

  it("atomically updates only goal metadata and preserves capture provenance", async () => {
    const root = await createWorkspace();
    const workspace = new ProductWorkspace(root);
    const created = await workspace.createCapture({
      title: "Original capture",
      capture_kind: "idea",
      priority: "normal",
      tags: ["Idea"],
      notes: "Original notes",
    });
    const itemDirectory = join(
      root,
      ".founder",
      "work-items",
      created.goal.work_item_id,
    );
    const statePath = join(itemDirectory, "state.json");
    const stateBefore = await readFile(statePath, "utf8");

    const updated = await workspace.updateGoal(created.goal.work_item_id, {
      ...created.goal,
      title: "Refined capture",
      type: "Feature",
      priority: "high",
      tags: ["Front-end"],
      notes: "Refined notes",
    });

    expect(updated?.goal).toMatchObject({
      title: "Refined capture",
      type: "Feature",
      priority: "high",
      tags: ["Front-end"],
      notes: "Refined notes",
      capture: created.goal.capture,
    });
    expect(await readFile(statePath, "utf8")).toBe(stateBefore);
    expect((await readdir(itemDirectory)).sort()).toEqual([
      "goal.yaml",
      "state.json",
    ]);

    const cleared = await workspace.updateGoal(created.goal.work_item_id, {
      schema_version: 2,
      work_item_id: created.goal.work_item_id,
      title: "Refined capture",
      capture: created.goal.capture,
    });
    expect(cleared?.goal).toEqual({
      schema_version: 2,
      work_item_id: created.goal.work_item_id,
      title: "Refined capture",
      capture: created.goal.capture,
    });

    await expect(
      workspace.updateGoal(created.goal.work_item_id, {
        ...cleared!.goal,
        capture: {
          ...created.goal.capture!,
          original_title: "Rewritten provenance",
        },
      }),
    ).rejects.toMatchObject({
      kind: "invalid_workspace",
      reason: "capture provenance must not change",
    });
    await expect(
      workspace.updateGoal(created.goal.work_item_id, {
        ...cleared!.goal,
        work_item_id: secondId,
      }),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
    expect((await workspace.read(created.goal.work_item_id))?.goal).toEqual(
      cleared?.goal,
    );
  });

  it("stages, publishes, and removes a work item without exposing partial state", async () => {
    const sourceRoot = await createWorkspace();
    const targetRoot = await createWorkspace();
    const source = new ProductWorkspace(sourceRoot);
    const target = new ProductWorkspace(targetRoot);
    const item = await source.createCapture({
      title: "Move this capture",
      capture_kind: "idea",
      tags: ["Portable"],
    });

    const stagingPath = await target.stageIncomingWorkItem(item);
    expect(await target.list()).toEqual([]);
    expect(await target.hasWorkItem(item.goal.work_item_id)).toBe(false);

    await target.publishStagedWorkItem(item.goal.work_item_id, stagingPath);
    expect(await target.read(item.goal.work_item_id)).toEqual(item);
    expect(await source.read(item.goal.work_item_id)).toEqual(item);

    await source.removeWorkItem(item.goal.work_item_id);
    expect(await source.read(item.goal.work_item_id)).toBeNull();
    expect(await target.read(item.goal.work_item_id)).toEqual(item);
    await source.removeWorkItem(item.goal.work_item_id);
  });

  it("rejects a concurrent controller lease and releases durable active state", async () => {
    const root = await createWorkspace();
    await writeContractedWorkItem(root, firstId);
    const workspace = new ProductWorkspace(root);
    const firstLease = await workspace.acquireControllerLease(
      firstId,
      activeRun(),
    );

    expect(firstLease).not.toBeNull();
    expect((await workspace.read(firstId))?.state.active_run).toEqual(
      activeRun(),
    );
    await expect(
      workspace.acquireControllerLease(
        firstId,
        activeRun(secondRunId, `${firstId}:plan:1:1:0`),
      ),
    ).rejects.toMatchObject({ kind: "repair_required", workItemId: firstId });

    await workspace.releaseControllerLease(firstLease!);
    expect((await workspace.read(firstId))?.state).not.toHaveProperty(
      "active_run",
    );
    expect(
      await readdir(join(root, ".founder", "work-items", firstId)),
    ).not.toContain(".controller.lock");
  });

  it("repairs retained controller representations explicitly and fail-closed", async () => {
    const root = await createWorkspace();
    await writeContractedWorkItem(root, firstId);
    const workspace = new ProductWorkspace(root);
    const retained = activeRun();
    await workspace.acquireControllerLease(firstId, retained);
    const itemDirectory = join(root, ".founder", "work-items", firstId);
    const lockPath = join(itemDirectory, ".controller.lock");

    await expect(
      workspace.acquireControllerLease(
        firstId,
        activeRun(secondRunId, `${firstId}:plan:1:1:0`),
      ),
    ).rejects.toMatchObject({
      kind: "repair_required",
      reason: expect.stringMatching(
        new RegExp(
          `${firstId}.*${retained.run_id}.*${retained.acquired_at}.*repairRetainedControllerLease`,
        ),
      ),
    });

    await unlink(lockPath);
    await expect(
      workspace.acquireControllerLease(
        firstId,
        activeRun(secondRunId, `${firstId}:plan:1:1:0`),
      ),
    ).rejects.toMatchObject({
      kind: "repair_required",
      reason: expect.stringMatching(
        new RegExp(
          `${firstId}.*${retained.run_id}.*${retained.acquired_at}.*repairRetainedControllerLease`,
        ),
      ),
    });
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await expect(
      workspace.repairRetainedControllerLease(firstId, {
        acknowledged_run_id: secondRunId,
      }),
    ).rejects.toMatchObject({ kind: "stale_expectation" });
    expect((await workspace.read(firstId))?.state.active_run).toEqual(retained);
    expect(
      await workspace.repairRetainedControllerLease(firstId, {
        acknowledged_run_id: retained.run_id,
      }),
    ).toMatchObject({ repaired: true, retained_run: retained });
    expect((await workspace.read(firstId))?.state).not.toHaveProperty(
      "active_run",
    );
    expect(
      await workspace.repairRetainedControllerLease(firstId, {
        acknowledged_run_id: retained.run_id,
      }),
    ).toEqual({
      repaired: false,
      reason: "nothing_retained",
      retained_run: null,
    });

    const mismatchRoot = await createWorkspace();
    await writeContractedWorkItem(mismatchRoot, firstId);
    const mismatchWorkspace = new ProductWorkspace(mismatchRoot);
    await mismatchWorkspace.acquireControllerLease(firstId, retained);
    const mismatchStatePath = join(
      mismatchRoot,
      ".founder",
      "work-items",
      firstId,
      "state.json",
    );
    const mismatchedState = JSON.parse(
      await readFile(mismatchStatePath, "utf8"),
    );
    const otherRun = activeRun(
      secondRunId,
      `${firstId}:shaping:other`,
    );
    await writeFile(
      mismatchStatePath,
      `${JSON.stringify(
        { ...mismatchedState, active_run: otherRun },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await expect(
      mismatchWorkspace.repairRetainedControllerLease(firstId, {
        acknowledged_run_id: retained.run_id,
      }),
    ).rejects.toMatchObject({
      kind: "repair_required",
      reason: expect.stringMatching(
        new RegExp(`${retained.run_id}.*${otherRun.run_id}`),
      ),
    });
    expect(await readFile(join(dirname(mismatchStatePath), ".controller.lock"), "utf8"))
      .toContain(retained.run_id);
    expect(JSON.parse(await readFile(mismatchStatePath, "utf8")).active_run)
      .toEqual(otherRun);

    const interruptedRoot = await createWorkspace();
    await writeContractedWorkItem(interruptedRoot, firstId);
    const interrupted = new FailingRetainedLeaseRepairWorkspace(
      interruptedRoot,
    );
    await interrupted.acquireControllerLease(firstId, retained);
    const interruptedDirectory = join(
      interruptedRoot,
      ".founder",
      "work-items",
      firstId,
    );
    const decisionsDirectory = join(
      interruptedDirectory,
      "shaping-decisions",
    );
    const pendingPath = join(decisionsDirectory, `${"c".repeat(64)}.json`);
    await mkdir(decisionsDirectory);
    await writeFile(pendingPath, "pending bytes stay exact\n", "utf8");
    const pendingBefore = await readFile(pendingPath, "utf8");
    await expect(
      interrupted.repairRetainedControllerLease(firstId, {
        acknowledged_run_id: retained.run_id,
      }),
    ).rejects.toThrow("injected retained-lease repair failure");
    expect((await interrupted.read(firstId))?.state).not.toHaveProperty(
      "active_run",
    );
    expect(
      await readFile(join(interruptedDirectory, ".controller.lock"), "utf8"),
    ).toContain(retained.run_id);
    expect(
      await new ProductWorkspace(
        interruptedRoot,
      ).repairRetainedControllerLease(firstId, {
        acknowledged_run_id: retained.run_id,
      }),
    ).toMatchObject({ repaired: true });
    expect(await readFile(pendingPath, "utf8")).toBe(pendingBefore);

    const precontractRoot = await createWorkspace();
    await writeShapingReadyWorkItem(precontractRoot, firstId, "idea");
    const precontractWorkspace = new ProductWorkspace(precontractRoot);
    await precontractWorkspace.acquireControllerLease(firstId, retained);
    expect(
      (await precontractWorkspace.read(firstId))?.state.active_run,
    ).toBeUndefined();
    expect(
      await precontractWorkspace.repairRetainedControllerLease(firstId, {
        acknowledged_run_id: retained.run_id,
      }),
    ).toMatchObject({ repaired: true });

    const replayRoot = await createWorkspace();
    const interruptedDecision = new FailingPendingShapingDecisionWorkspace(
      replayRoot,
    );
    const prepared = await prepareStartShapingDecision(
      replayRoot,
      interruptedDecision,
      { contracted: true },
    );
    await expect(
      interruptedDecision.commitShapingDecision(prepared.lease, {
        state: prepared.nextState,
        manifest: prepared.manifest,
      }),
    ).rejects.toThrow("before shaping decision rename");
    await expect(
      new ProductWorkspace(replayRoot).acquireControllerLease(
        firstId,
        activeRun(secondRunId, `${firstId}:shaping:replay`),
      ),
    ).rejects.toMatchObject({ kind: "repair_required" });

    const replayWorkspace = new ProductWorkspace(replayRoot);
    await expect(
      replayWorkspace.repairRetainedControllerLease(firstId, {
        acknowledged_run_id: prepared.run.run_id,
      }),
    ).resolves.toMatchObject({ repaired: true });
    const replayLease = await replayWorkspace.acquireControllerLease(
      firstId,
      prepared.run,
    );
    if (replayLease === null) {
      throw new Error("Expected repaired shaping decision lease");
    }
    const reconciled = await replayWorkspace.reconcileShapingDecisionCommit(
      replayLease,
      prepared.writtenIntent.intent.decision_id,
    );
    expect(reconciled).toMatchObject({
      work_item: { state: { phase: "brainstorm" } },
      manifest: { outcome: "applied" },
    });
    expect(
      (
        await readdir(
          join(
            replayRoot,
            ".founder",
            "work-items",
            firstId,
            "shaping-decisions",
          ),
        )
      ).filter((entry) => entry.endsWith(".json") && !entry.endsWith(".intent.json")),
    ).toHaveLength(1);
    await replayWorkspace.releaseControllerLease(replayLease);
  });

  it("captures exact shaping intent pairs, publishes under the lease, and commits pre-contract state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T10:00:00.000Z"));
    const root = await createWorkspace();
    const workspace = new ProductWorkspace(root);
    const prepared = await prepareStartShapingDecision(root, workspace);

    expect(prepared.writtenIntent.intent.decision_id).toBe(
      deriveShapingDecisionId({
        operation: prepared.draft.operation,
        work_item_id: prepared.draft.work_item_id,
        goal_input_sha256: prepared.draft.goal_input_sha256,
        mission_content_sha256: prepared.draft.mission_content_sha256,
        result_content_sha256: prepared.draft.result_content_sha256,
        feedback_sha256: prepared.draft.feedback_sha256,
        expected_shaping_state_sha256:
          prepared.draft.expected_shaping_state_sha256,
      }),
    );
    expect(prepared.writtenIntent.intent.next_goal_bytes).toBe(
      prepared.writtenIntent.intent.previous_goal_bytes,
    );
    expect(prepared.writtenIntent.intent.next_goal_sha256).toBe(
      prepared.writtenIntent.intent.previous_goal_sha256,
    );
    expect(prepared.writtenIntent.intent.next_state_bytes).not.toBe(
      prepared.writtenIntent.intent.previous_state_bytes,
    );

    vi.setSystemTime(new Date("2026-08-02T11:00:00.000Z"));
    expect(
      await workspace.writeShapingDecisionIntent(prepared.lease, {
        intent: prepared.draft,
        state: prepared.nextState,
      }),
    ).toEqual(prepared.writtenIntent);
    expect(prepared.writtenIntent.intent.created_at).toBe(
      "2026-08-02T10:00:00.000Z",
    );

    await expect(
      workspace.writeShapingMissionPackage(prepared.identity, () =>
        prepared.mission,
      ),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });
    await expect(
      workspace.publishLeasedShapingMission(
        prepared.lease,
        prepared.identity,
        `${prepared.missionBytes} `,
        { decision_id: prepared.writtenIntent.intent.decision_id },
      ),
    ).rejects.toMatchObject({ kind: "repair_required" });
    const published = await workspace.publishLeasedShapingMission(
      prepared.lease,
      prepared.identity,
      prepared.missionBytes,
      { decision_id: prepared.writtenIntent.intent.decision_id },
    );
    expect(published.mission).toEqual(prepared.mission);

    const committed = await workspace.commitShapingDecision(
      prepared.lease,
      {
        state: prepared.nextState,
        manifest: prepared.manifest,
      },
    );
    expect(committed.work_item.goal).not.toHaveProperty("goal_contract");
    expect(committed.work_item.state.phase).toBe("brainstorm");
    expect(committed.manifest).toMatchObject({
      outcome: "applied",
      goal_sha256: prepared.writtenIntent.intent.next_goal_sha256,
      goal_version: null,
      input_revision: null,
    });
    await workspace.releaseControllerLease(prepared.lease);

    vi.setSystemTime(new Date("2026-08-02T12:00:00.000Z"));
    const replayLease = await workspace.acquireControllerLease(
      firstId,
      prepared.run,
    );
    if (replayLease === null) {
      throw new Error("Expected shaping decision replay lease");
    }
    const replay = await workspace.commitShapingDecision(replayLease, {
      state: prepared.nextState,
      manifest: {
        ...prepared.manifest,
        started_at: "2026-08-02T12:00:00.000Z",
      },
    });
    expect(replay).toEqual(committed);
    await workspace.releaseControllerLease(replayLease);

    const conflictingLease = await workspace.acquireControllerLease(
      firstId,
      prepared.run,
    );
    if (conflictingLease === null) {
      throw new Error("Expected conflicting shaping decision lease");
    }
    await expect(
      workspace.commitShapingDecision(conflictingLease, {
        state: prepared.nextState,
        manifest: {
          ...prepared.manifest,
          feedback_sha256: "d".repeat(64),
        },
      }),
    ).rejects.toMatchObject({ kind: "idempotency_conflict" });
    await workspace.releaseControllerLease(conflictingLease);

    const missingIntentRoot = await createWorkspace();
    const missingIntentWorkspace = new ProductWorkspace(missingIntentRoot);
    const missing = await prepareStartShapingDecision(
      missingIntentRoot,
      missingIntentWorkspace,
    );
    await unlink(missing.writtenIntent.intent_path);
    await expect(
      missingIntentWorkspace.publishLeasedShapingMission(
        missing.lease,
        missing.identity,
        missing.missionBytes,
        { decision_id: missing.writtenIntent.intent.decision_id },
      ),
    ).rejects.toMatchObject({ kind: "repair_required" });

    const noOwnershipRoot = await createWorkspace();
    const noOwnershipWorkspace = new ProductWorkspace(noOwnershipRoot);
    const noOwnership = await prepareStartShapingDecision(
      noOwnershipRoot,
      noOwnershipWorkspace,
    );
    await unlink(
      join(
        noOwnershipRoot,
        ".founder",
        "work-items",
        firstId,
        ".controller.lock",
      ),
    );
    await expect(
      noOwnershipWorkspace.publishLeasedShapingMission(
        noOwnership.lease,
        noOwnership.identity,
        noOwnership.missionBytes,
        { decision_id: noOwnership.writtenIntent.intent.decision_id },
      ),
    ).rejects.toMatchObject({ kind: "repair_required" });

    const specRoot = await createWorkspace();
    const specItem = await writeShapingReadyWorkItem(
      specRoot,
      firstId,
      "brainstorm",
    );
    const specWorkspace = new ProductWorkspace(specRoot);
    const brainstormInput = {
      phase: "brainstorm" as const,
      title: specItem.goal.title,
      notes: specItem.goal.notes,
    };
    const brainstormIdentity: ShapingIdentity<"brainstorm"> = {
      phase: "brainstorm",
      work_item_id: firstId,
      input_sha256: hashShapingInput(brainstormInput),
    };
    const brainstormArtifact = await specWorkspace.writeShapingMissionPackage(
      brainstormIdentity,
      (paths) =>
        compileBrainstormMission({
          work_item_id: firstId,
          shaping_input: brainstormInput,
          paths,
        }),
    );
    const brainstormResult = brainstormResultFor(brainstormArtifact);
    const appliedBrainstorm = await writeAppliedShapingBundle(
      brainstormArtifact,
      brainstormResult,
    );
    const selection: ShapingSelectionReceipt = {
      shaping_schema_version: 2,
      identity: brainstormIdentity,
      mission_content_sha256: brainstormArtifact.mission.content_sha256,
      result_content_sha256: appliedBrainstorm.resultContentSha256,
      selected_at: "2026-08-02T12:10:00.000Z",
    };
    const accepted = await specWorkspace.writeShapingDecisionReceipt(
      selection,
    );
    const specInput = {
      phase: "spec" as const,
      title: specItem.goal.title,
      notes: specItem.goal.notes,
      brainstorm_selection_sha256: accepted.receipt_content_sha256,
      brainstorm_selection: selection,
      brainstorm_result: brainstormResult,
    };
    const specIdentity: ShapingIdentity<"spec"> = {
      phase: "spec",
      work_item_id: firstId,
      input_sha256: hashShapingInput(specInput),
    };
    const specDirectory = `.founder/shaping/${firstId}/spec-${specIdentity.input_sha256}`;
    const specMission = compileSpecMission({
      work_item_id: firstId,
      shaping_input: specInput,
      paths: {
        task_path: `${specDirectory}/TASK.md`,
        output_path: `${specDirectory}/result.json`,
      },
    });
    const specMissionBytes = serializeShapingPackage(specMission);
    const specRun = activeRun(
      firstRunId,
      `${firstId}:shaping:use-brainstorm-result`,
    );
    const specLease = await specWorkspace.acquireControllerLease(
      firstId,
      specRun,
    );
    if (specLease === null) {
      throw new Error("Expected leased Spec publication");
    }
    const specState = {
      ...specItem.state,
      phase: "spec" as const,
      updated_at: "2026-08-02T12:11:00.000Z",
    };
    const specIntent = await specWorkspace.writeShapingDecisionIntent(
      specLease,
      {
        intent: {
          schema_version: 1,
          work_item_id: firstId,
          operation: "use_brainstorm_result",
          launch_mode: "manual",
          phase_from: "brainstorm",
          phase_to: "spec",
          goal_input_sha256: hashGoalInput({
            title: specItem.goal.title,
            notes: specItem.goal.notes,
          }),
          mission_content_sha256:
            brainstormArtifact.mission.content_sha256,
          result_content_sha256: appliedBrainstorm.resultContentSha256,
          feedback_sha256: null,
          expected_shaping_state_sha256: "e".repeat(64),
          next_requested_model: null,
          next_mission_content_sha256: specMission.content_sha256,
          next_mission_input_sha256: specIdentity.input_sha256,
          plan_repository_base_commit: null,
          plan_goal_contract_sha256: null,
          plan_goal_version: null,
          launch_fingerprint: null,
          decision_receipt_bytes: await readFile(
            accepted.receipt_path,
            "utf8",
          ),
          next_mission_package_bytes: specMissionBytes,
        },
        state: specState,
      },
    );
    await expect(
      specWorkspace.publishLeasedShapingMission(
        specLease,
        specIdentity,
        specMissionBytes,
        { decision_id: specIntent.intent.decision_id },
      ),
    ).resolves.toMatchObject({
      mission: { identity: { phase: "spec" } },
    });
    expect((await specWorkspace.read(firstId))?.state.phase).toBe(
      "brainstorm",
    );

    const driftRoot = await createWorkspace();
    const driftWorkspace = new ProductWorkspace(driftRoot);
    const drift = await prepareStartShapingDecision(
      driftRoot,
      driftWorkspace,
    );
    await unlink(drift.writtenIntent.intent_path);
    const driftStatePath = join(
      driftRoot,
      ".founder",
      "work-items",
      firstId,
      "state.json",
    );
    const driftState = JSON.parse(await readFile(driftStatePath, "utf8"));
    await writeFile(
      driftStatePath,
      `${JSON.stringify(
        { ...driftState, updated_at: "2026-08-02T12:20:00.000Z" },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await expect(
      driftWorkspace.writeShapingDecisionIntent(drift.lease, {
        intent: drift.draft,
        state: drift.nextState,
      }),
    ).rejects.toMatchObject({ kind: "repair_required" });
    await expect(
      readFile(drift.writtenIntent.intent_path, "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("captures exact legacy-v1 pre-contract bytes before a shaping decision", async () => {
    const root = await createWorkspace();
    await writeWorkItem(
      root,
      firstId,
      "2026-07-17T12:00:00.000Z",
    );
    const workspace = new ProductWorkspace(root);
    const itemDirectory = join(
      root,
      ".founder",
      "work-items",
      firstId,
    );
    const goalPath = join(itemDirectory, "goal.yaml");
    const previousGoalBytes = `# Preserve this valid noncanonical YAML.\n${await readFile(
      goalPath,
      "utf8",
    )}`;
    await writeFile(goalPath, previousGoalBytes, "utf8");
    const previousStateBytes = await readFile(
      join(itemDirectory, "state.json"),
      "utf8",
    );

    expect(JSON.parse(previousStateBytes)).toMatchObject({
      schema_version: 1,
      phase: "idea",
      status: "active",
    });

    const prepared = await prepareStartShapingDecision(root, workspace, {
      legacyState: true,
    });

    expect(prepared.writtenIntent.intent.previous_state_bytes).toBe(
      previousStateBytes,
    );
    expect(prepared.writtenIntent.intent.previous_goal_bytes).toBe(
      previousGoalBytes,
    );
    expect(prepared.writtenIntent.intent.next_goal_bytes).toBe(
      previousGoalBytes,
    );
    expect(
      JSON.parse(prepared.writtenIntent.intent.next_state_bytes),
    ).toMatchObject({
      schema_version: 2,
      phase: "brainstorm",
      status: "active",
    });

    await workspace.publishLeasedShapingMission(
      prepared.lease,
      prepared.identity,
      prepared.missionBytes,
      { decision_id: prepared.writtenIntent.intent.decision_id },
    );
    await expect(
      workspace.commitShapingDecision(prepared.lease, {
        state: prepared.nextState,
        manifest: prepared.manifest,
      }),
    ).resolves.toMatchObject({
      work_item: { state: { schema_version: 2, phase: "brainstorm" } },
      manifest: { outcome: "applied" },
    });
    expect(await readFile(goalPath, "utf8")).toBe(previousGoalBytes);

    await workspace.releaseControllerLease(prepared.lease);
    expect(await readdir(itemDirectory)).not.toContain(".controller.lock");
  });

  it("captures all decision operations and makes approve_spec the only goal-changing commit", async () => {
    const stateOnlyOperations = [
      "start_brainstorm",
      "use_brainstorm_result",
      "request_changes",
      "replan_with_updated_contract",
    ] as const;
    for (const operation of stateOnlyOperations) {
      const root = await createWorkspace();
      const workspace = new ProductWorkspace(root);
      const prepared = await prepareStartShapingDecision(root, workspace);
      const written =
        operation === "start_brainstorm"
          ? prepared.writtenIntent
          : await workspace.writeShapingDecisionIntent(prepared.lease, {
              intent: { ...prepared.draft, operation },
              state: prepared.nextState,
            });
      expect(written.intent.operation).toBe(operation);
      expect(written.intent.next_goal_bytes).toBe(
        written.intent.previous_goal_bytes,
      );
      expect(written.intent.next_goal_sha256).toBe(
        written.intent.previous_goal_sha256,
      );
      expect(written.intent.next_state_bytes).not.toBe(
        written.intent.previous_state_bytes,
      );
    }

    const root = await createWorkspace();
    const item = await writeShapingReadyWorkItem(root, firstId, "spec");
    const workspace = new ProductWorkspace(root);
    const specIdentity: ShapingIdentity<"spec"> = {
      phase: "spec",
      work_item_id: firstId,
      input_sha256: "1".repeat(64),
    };
    const specResult: SpecResultSubmission = {
      result_schema_version: 1,
      spec_mission_content_sha256: "2".repeat(64),
      identity: specIdentity,
      proposal: {
        purpose: "Commit the first real governed contract.",
        acceptance_criteria: ["The approval commit reaches Plan."],
        non_goals: ["Do not create a placeholder contract."],
        allowed_scope: ["src/workspace"],
        review_ready: ["The workspace contract test passes."],
      },
    };
    const goalContract = {
      schema_version: 1 as const,
      goal_version: 1,
      ...specResult.proposal,
    };
    const goalContractSha256 = hashGoalContract(goalContract);
    const approval: SpecApprovalReceipt = {
      shaping_schema_version: 2,
      identity: specIdentity,
      mission_content_sha256: specResult.spec_mission_content_sha256,
      result_content_sha256: "3".repeat(64),
      goal_contract_sha256: goalContractSha256,
      approved_at: "2026-08-02T13:00:00.000Z",
    };
    const planInput = {
      phase: "plan" as const,
      title: item.goal.title,
      notes: item.goal.notes,
      spec_approval_sha256: "4".repeat(64),
      spec_approval: approval,
      spec_result: specResult,
      repository_base_commit: "a".repeat(40),
      goal_contract_sha256: goalContractSha256,
      goal_version: 1,
    };
    const planIdentity: ShapingIdentity<"plan"> = {
      phase: "plan",
      work_item_id: firstId,
      input_sha256: hashShapingInput(planInput),
    };
    const planDirectory = `.founder/shaping/${firstId}/plan-${planIdentity.input_sha256}`;
    const planMission = compilePlanMission({
      work_item_id: firstId,
      shaping_input: planInput,
      paths: {
        task_path: `${planDirectory}/TASK.md`,
        output_path: `${planDirectory}/result.json`,
      },
    });
    const nextGoal = { ...item.goal, goal_contract: goalContract };
    const nextState = {
      ...item.state,
      phase: "plan" as const,
      updated_at: "2026-08-02T13:01:00.000Z",
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
      patch_cycle: 0,
    };
    const draft: ShapingDecisionIntentDraft = {
      schema_version: 1,
      work_item_id: firstId,
      operation: "approve_spec",
      launch_mode: "manual",
      phase_from: "spec",
      phase_to: "plan",
      goal_input_sha256: hashGoalInput({
        title: item.goal.title,
        notes: item.goal.notes,
      }),
      mission_content_sha256: approval.mission_content_sha256,
      result_content_sha256: approval.result_content_sha256,
      feedback_sha256: null,
      expected_shaping_state_sha256: "5".repeat(64),
      next_requested_model: null,
      next_mission_content_sha256: planMission.content_sha256,
      next_mission_input_sha256: planIdentity.input_sha256,
      plan_repository_base_commit: planInput.repository_base_commit,
      plan_goal_contract_sha256: goalContractSha256,
      plan_goal_version: 1,
      launch_fingerprint: null,
      decision_receipt_bytes: `${JSON.stringify(approval)}\n`,
      next_mission_package_bytes: serializeShapingPackage(planMission),
    };
    const run = activeRun(
      firstRunId,
      `${firstId}:shaping:approve-spec`,
    );
    const lease = await workspace.acquireControllerLease(firstId, run);
    if (lease === null) {
      throw new Error("Expected approve_spec lease");
    }
    const written = await workspace.writeShapingDecisionIntent(lease, {
      intent: draft,
      goal: nextGoal,
      state: nextState,
    });
    expect(written.intent.next_goal_bytes).not.toBe(
      written.intent.previous_goal_bytes,
    );
    const manifest: ShapingDecisionManifestV1 = {
      schema_version: 1,
      decision_id: written.intent.decision_id,
      work_item_id: firstId,
      operation: "approve_spec",
      phase_from: "spec",
      phase_to: "plan",
      mission_content_sha256: approval.mission_content_sha256,
      result_content_sha256: approval.result_content_sha256,
      feedback_sha256: null,
      expected_shaping_state_sha256:
        draft.expected_shaping_state_sha256,
      next_mission_content_sha256: planMission.content_sha256,
      goal_sha256: written.intent.next_goal_sha256,
      state_sha256: written.intent.next_state_sha256,
      goal_version: 1,
      input_revision: 1,
      started_at: "2026-08-02T13:00:00.000Z",
      outcome: "pending",
    };
    await expect(
      workspace.commitShapingDecision(lease, {
        goal: nextGoal,
        state: nextState,
        manifest: { ...manifest, goal_version: 2 },
      }),
    ).rejects.toMatchObject({ kind: "idempotency_conflict" });
    const committed = await workspace.commitShapingDecision(lease, {
      goal: nextGoal,
      state: nextState,
      manifest,
    });
    expect(committed.work_item.goal.goal_contract).toEqual(goalContract);
    expect(committed.work_item.state).toMatchObject({
      phase: "plan",
      goal_version: 1,
      input_revision: 1,
    });
    expect(committed.manifest.goal_sha256).toBe(
      written.intent.next_goal_sha256,
    );

    const invalidRoot = await createWorkspace();
    const invalidWorkspace = new ProductWorkspace(invalidRoot);
    const invalid = await prepareStartShapingDecision(
      invalidRoot,
      invalidWorkspace,
    );
    await expect(
      invalidWorkspace.commitShapingDecision(invalid.lease, {
        state: invalid.nextState,
        manifest: {
          ...invalid.manifest,
          goal_version: 1,
          input_revision: 1,
        },
      }),
    ).rejects.toMatchObject({ kind: "idempotency_conflict" });
  });

  it("reconciles every shaping decision crash boundary from durable byte pairs", async () => {
    const crashWorkspaces = [
      {
        label: "before_goal",
        create: (root: string) =>
          new FailingPendingShapingDecisionWorkspace(root),
      },
      {
        label: "mixed_pair",
        create: (root: string) => new FailingControllerWorkspace(root),
      },
      {
        label: "after_both",
        create: (root: string) => new FailingAppliedManifestWorkspace(root),
      },
    ] as const;
    for (const crash of crashWorkspaces) {
      const root = await createWorkspace();
      const failing = crash.create(root);
      const prepared = await prepareStartShapingDecision(root, failing);
      await expect(
        failing.commitShapingDecision(prepared.lease, {
          state: prepared.nextState,
          manifest: prepared.manifest,
        }),
      ).rejects.toThrow();
      const pending = await failing.readShapingDecisionManifest(
        firstId,
        prepared.writtenIntent.intent.decision_id,
      );
      expect(pending?.outcome).toBe("pending");

      const reconciled = await new ProductWorkspace(
        root,
      ).reconcileShapingDecisionCommit(
        prepared.lease,
        prepared.writtenIntent.intent.decision_id,
      );
      expect(reconciled).toMatchObject({
        work_item: { state: { phase: "brainstorm" } },
        manifest: { outcome: "applied" },
      });
      expect(
        await readFile(
          join(root, ".founder", "work-items", firstId, "goal.yaml"),
          "utf8",
        ),
      ).toBe(prepared.writtenIntent.intent.next_goal_bytes);
      expect(
        await readFile(
          join(root, ".founder", "work-items", firstId, "state.json"),
          "utf8",
        ),
      ).toBe(prepared.writtenIntent.intent.next_state_bytes);
    }

    const unknownRoot = await createWorkspace();
    const unknownFailing = new FailingPendingShapingDecisionWorkspace(
      unknownRoot,
    );
    const unknown = await prepareStartShapingDecision(
      unknownRoot,
      unknownFailing,
    );
    await expect(
      unknownFailing.commitShapingDecision(unknown.lease, {
        state: unknown.nextState,
        manifest: unknown.manifest,
      }),
    ).rejects.toThrow("before shaping decision rename");
    const unknownState = {
      ...unknown.item.state,
      updated_at: "2026-08-02T19:00:00.000Z",
    };
    await writeFile(
      join(
        unknownRoot,
        ".founder",
        "work-items",
        firstId,
        "state.json",
      ),
      `${JSON.stringify(unknownState, null, 2)}\n`,
      "utf8",
    );
    await expect(
      new ProductWorkspace(unknownRoot).reconcileShapingDecisionCommit(
        unknown.lease,
        unknown.writtenIntent.intent.decision_id,
      ),
    ).rejects.toMatchObject({
      kind: "repair_required",
      reason: expect.stringMatching(/Durable.*goal.*next.*previous.*state.*next.*previous/u),
    });

    const competingRoot = await createWorkspace();
    const competingFailing = new FailingPendingShapingDecisionWorkspace(
      competingRoot,
    );
    const competing = await prepareStartShapingDecision(
      competingRoot,
      competingFailing,
    );
    await expect(
      competingFailing.commitShapingDecision(competing.lease, {
        state: competing.nextState,
        manifest: competing.manifest,
      }),
    ).rejects.toThrow();
    const otherIntent = await competingFailing.writeShapingDecisionIntent(
      competing.lease,
      {
        intent: { ...competing.draft, operation: "request_changes" },
        state: competing.nextState,
      },
    );
    const otherManifest: ShapingDecisionManifestV1 = {
      ...competing.manifest,
      decision_id: otherIntent.intent.decision_id,
      operation: "request_changes",
    };
    await expect(
      competingFailing.commitShapingDecision(competing.lease, {
        state: competing.nextState,
        manifest: otherManifest,
      }),
    ).rejects.toMatchObject({
      kind: "repair_required",
      reason: expect.stringContaining(
        competing.writtenIntent.intent.decision_id,
      ),
    });
  });

  it("commits exact Plan approval bytes and replays the applied manifest", async () => {
    const root = await createWorkspace();
    const workspace = new ProductWorkspace(root);
    const prepared = await preparePlanApprovalCommit(root, workspace);

    const committed = await workspace.commitPlanApproval(prepared.lease, {
      state: prepared.nextState,
      manifest: prepared.manifest,
    });
    expect(committed).toMatchObject({
      work_item: {
        goal: prepared.item.goal,
        state: { phase: "execute", status: "active", attempt: 0 },
      },
      manifest: {
        approval_id: prepared.writtenIntent.intent.approval_id,
        outcome: "applied",
      },
    });
    expect(
      await readFile(
        join(root, ".founder", "work-items", firstId, "goal.yaml"),
        "utf8",
      ),
    ).toBe(prepared.writtenIntent.intent.next_goal_bytes);
    expect(
      await readFile(
        join(root, ".founder", "work-items", firstId, "state.json"),
        "utf8",
      ),
    ).toBe(prepared.writtenIntent.intent.next_state_bytes);
    await expect(
      workspace.readPlanApprovalManifest(
        firstId,
        prepared.writtenIntent.intent.approval_id,
      ),
    ).resolves.toEqual(committed.manifest);
    await workspace.releaseControllerLease(prepared.lease);

    const replayLease = await workspace.acquireControllerLease(
      firstId,
      prepared.run,
    );
    if (replayLease === null) {
      throw new Error("Expected Plan approval replay lease");
    }
    await expect(
      workspace.commitPlanApproval(replayLease, {
        state: prepared.nextState,
        manifest: {
          ...prepared.manifest,
          started_at: "2026-08-03T10:00:00.000Z",
        },
      }),
    ).resolves.toEqual(committed);
    await workspace.releaseControllerLease(replayLease);
  });

  it("fails closed when a Plan approval manifest has no intent", async () => {
    const root = await createWorkspace();
    const approvalId = "a".repeat(64);
    const directory = join(
      root,
      ".founder",
      "work-items",
      firstId,
      "plan-approvals",
    );
    const manifest: PlanApprovalManifestV1 = {
      schema_version: 1,
      approval_id: approvalId,
      work_item_id: firstId,
      launch_mode: "manual",
      requested_model: null,
      expected_mission_content_sha256: "b".repeat(64),
      expected_result_content_sha256: "c".repeat(64),
      expected_shaping_state_sha256: "d".repeat(64),
      goal_contract_sha256: "e".repeat(64),
      goal_version: 1,
      receipt_sha256: "f".repeat(64),
      execute_tuple: { goal_version: 1, input_revision: 1, attempt: 0 },
      goal_sha256: "1".repeat(64),
      state_sha256: "2".repeat(64),
      started_at: "2026-08-03T09:04:00.000Z",
      outcome: "pending",
    };
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${approvalId}.json`),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    await expect(
      new ProductWorkspace(root).readPlanApprovalManifest(firstId, approvalId),
    ).rejects.toMatchObject({
      kind: "repair_required",
      reason: expect.stringContaining("manifest without an intent"),
    });
  });

  it("refuses Plan approval intent bytes outside the exact Execute contract", async () => {
    const root = await createWorkspace();
    const workspace = new ProductWorkspace(root);
    const prepared = await preparePlanApprovalCommit(root, workspace);

    await expect(
      workspace.writePlanApprovalIntent(prepared.lease, {
        intent: prepared.draft,
        state: { ...prepared.nextState, phase: "plan" },
      }),
    ).rejects.toMatchObject({ kind: "idempotency_conflict" });
    await expect(
      workspace.writePlanApprovalIntent(prepared.lease, {
        intent: prepared.draft,
        goal: {
          ...prepared.item.goal,
          goal_contract: {
            ...prepared.item.goal.goal_contract!,
            purpose: "Change the approved contract bytes.",
          },
        },
        state: prepared.nextState,
      }),
    ).rejects.toMatchObject({ kind: "idempotency_conflict" });
    await expect(
      workspace.readPlanApprovalIntent(
        firstId,
        prepared.writtenIntent.intent.approval_id,
      ),
    ).resolves.toEqual(prepared.writtenIntent.intent);
    await workspace.releaseControllerLease(prepared.lease);
  });

  it("persists an applied manifest and returns it on idempotent replay", async () => {
    const root = await createWorkspace();
    await writeWorkItem(root, firstId, "2026-07-21T20:00:00.000Z");
    const workspace = new ProductWorkspace(root);
    const run = activeRun();
    const firstLease = await workspace.acquireControllerLease(firstId, run);
    if (firstLease === null) {
      throw new Error("Expected first controller lease");
    }
    const mutation = controllerMutation(firstLease.work_item, run);

    const firstResult = await workspace.commitControllerMutation(
      firstLease,
      mutation,
    );
    await workspace.releaseControllerLease(firstLease);

    expect(firstResult.manifest).toMatchObject({ outcome: "applied" });
    expect(firstResult.manifest.completed_at).toMatch(/Z$/);
    expect(await workspace.readControllerRunManifest(firstId, run.run_id)).toEqual(
      firstResult.manifest,
    );
    expect(await workspace.read(firstId)).toEqual(firstResult.work_item);

    const replayLease = await workspace.acquireControllerLease(firstId, run);
    if (replayLease === null) {
      throw new Error("Expected replay controller lease");
    }
    const replay = await workspace.commitControllerMutation(
      replayLease,
      mutation,
    );
    await workspace.releaseControllerLease(replayLease);

    expect(replay).toEqual(firstResult);
    expect(await workspace.read(firstId)).toEqual(firstResult.work_item);
    expect(
      await readdir(
        join(root, ".founder", "work-items", firstId, "runs"),
      ),
    ).toEqual([`${run.run_id}.json`]);
  });

  it("selects the one applied execute manifest matching durable controller state", async () => {
    const root = await createWorkspace();
    const item = await writeMissionReadyWorkItem(root, firstId);
    const selected = appliedExecuteManifest();
    await writeRunManifest(root, selected);
    await writeRunManifest(
      root,
      appliedExecuteManifest(secondRunId, { outcome: "failed" }),
    );
    await writeRunManifest(
      root,
      appliedExecuteManifest(thirdRunId, {
        input_revision: 2,
        idempotency_key: `${firstId}:execute:1:2:0`,
      }),
    );

    const result = await new ProductWorkspace(root).findAppliedExecuteManifest(
      missionIdentity(),
    );

    expect(result).toEqual(selected);
    expect({
      goal_version: item.state.goal_version,
      input_revision: item.state.input_revision,
      attempt: item.state.attempt,
    }).toEqual({
      goal_version: result?.goal_version,
      input_revision: result?.input_revision,
      attempt: result?.attempt,
    });
  });

  it("distinguishes missing and duplicate applied execute manifests", async () => {
    const missingRoot = await createWorkspace();
    await writeMissionReadyWorkItem(missingRoot, firstId);
    const missingWorkspace = new ProductWorkspace(missingRoot);
    expect(
      await missingWorkspace.findAppliedExecuteManifest(missionIdentity()),
    ).toBeNull();

    const duplicateRoot = await createWorkspace();
    await writeMissionReadyWorkItem(duplicateRoot, firstId);
    await writeRunManifest(duplicateRoot, appliedExecuteManifest());
    await writeRunManifest(
      duplicateRoot,
      appliedExecuteManifest(secondRunId),
    );
    await expect(
      new ProductWorkspace(duplicateRoot).findAppliedExecuteManifest(
        missionIdentity(),
      ),
    ).rejects.toMatchObject({
      kind: "mission_not_ready",
      workItemId: firstId,
    });
  });

  it("validates every run manifest candidate and rejects unsafe entries", async () => {
    const malformedRoot = await createWorkspace();
    await writeMissionReadyWorkItem(malformedRoot, firstId);
    const malformedRunsDirectory = join(
      malformedRoot,
      ".founder",
      "work-items",
      firstId,
      "runs",
    );
    await mkdir(malformedRunsDirectory, { recursive: true });
    await writeFile(
      join(malformedRunsDirectory, `${firstRunId}.json`),
      "{invalid",
      "utf8",
    );
    await expect(
      new ProductWorkspace(malformedRoot).findAppliedExecuteManifest(
        missionIdentity(),
      ),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });

    const symlinkRoot = await createWorkspace();
    const outsideRoot = await createWorkspace();
    await writeMissionReadyWorkItem(symlinkRoot, firstId);
    const symlinkRunsDirectory = join(
      symlinkRoot,
      ".founder",
      "work-items",
      firstId,
      "runs",
    );
    await mkdir(symlinkRunsDirectory, { recursive: true });
    const outsideManifestPath = join(outsideRoot, "manifest.json");
    await writeFile(
      outsideManifestPath,
      `${JSON.stringify(appliedExecuteManifest(), null, 2)}\n`,
      "utf8",
    );
    await symlink(
      outsideManifestPath,
      join(symlinkRunsDirectory, `${firstRunId}.json`),
      "file",
    );
    await expect(
      new ProductWorkspace(symlinkRoot).findAppliedExecuteManifest(
        missionIdentity(),
      ),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
  });

  it("publishes an immutable mission snapshot and replays identical bytes", async () => {
    const root = await createWorkspace();
    const item = await writeMissionReadyWorkItem(root, firstId);
    const manifest = appliedExecuteManifest();
    const workspace = missionWorkspace(root);
    const buildPackage = (paths: Parameters<typeof compileMission>[2]) =>
      compileMission(item, manifest, paths);

    const first = await workspace.writeMissionPackage(
      missionIdentity(),
      buildPackage,
    );
    const missionSource = await readFile(first.mission_path, "utf8");
    const taskSource = await readFile(first.task_path, "utf8");
    const second = await workspace.writeMissionPackage(
      missionIdentity(),
      buildPackage,
    );

    expect(second).toEqual(first);
    expect(first.workspace_path).toBe(root);
    expect(first.mission.task_path).toBe(
      `.founder/missions/${firstId}/execute-1-1-0/TASK.md`,
    );
    expect(first.mission.result_contract.output_path).toBe(
      `.founder/missions/${firstId}/execute-1-1-0/result.json`,
    );
    expect(missionSource).toBe(serializeMissionPackage(first.mission));
    expect(taskSource).toBe(renderTaskMd(first.mission));
    expect(await readFile(second.mission_path, "utf8")).toBe(missionSource);
    expect(await readFile(second.task_path, "utf8")).toBe(taskSource);
    expect(
      await readdir(join(root, ".founder", "missions", firstId)),
    ).toEqual(["execute-1-1-0"]);
    expect(
      (
        await readdir(
          join(root, ".founder", "missions", firstId, "execute-1-1-0"),
        )
      ).sort(),
    ).toEqual(["TASK.md", "mission.json"]);
  });

  it("publishes byte-identical v2 Brainstorm, Spec, and Plan missions without Git", async () => {
    const root = await createWorkspace();
    const item = await writeShapingReadyWorkItem(root, firstId);
    let gitHeadReads = 0;
    const workspace = new ProductWorkspace(root, {
      git: {
        ...testGit,
        async readHeadCommit() {
          gitHeadReads += 1;
          throw new Error("Git HEAD is unavailable");
        },
      },
    });
    const brainstormInput = {
      phase: "brainstorm" as const,
      title: item.goal.title,
      notes: item.goal.notes,
    };
    const brainstormIdentity: ShapingIdentity<"brainstorm"> = {
      phase: "brainstorm",
      work_item_id: firstId,
      input_sha256: hashShapingInput(brainstormInput),
    };
    const buildBrainstorm = (paths: Parameters<typeof compileBrainstormMission>[0]["paths"]) =>
      compileBrainstormMission({
        work_item_id: firstId,
        shaping_input: brainstormInput,
        paths,
      });

    const first = await workspace.writeShapingMissionPackage(
      brainstormIdentity,
      buildBrainstorm,
    );
    const missionSource = await readFile(first.mission_path, "utf8");
    const taskSource = await readFile(first.task_path, "utf8");
    const replay = await workspace.writeShapingMissionPackage(
      brainstormIdentity,
      buildBrainstorm,
    );
    expect(replay).toEqual(first);
    expect(await readFile(replay.mission_path, "utf8")).toBe(missionSource);
    expect(await readFile(replay.task_path, "utf8")).toBe(taskSource);
    expect(
      await readFile(
        join(root, ".founder", "shaping-ingress", ".gitignore"),
        "utf8",
      ),
    ).toBe("*\n");
    await expect(
      workspace.readAppliedShapingResult(brainstormIdentity),
    ).resolves.toBeNull();

    const brainstormResult: BrainstormResultSubmission = {
      result_schema_version: 1,
      brainstorm_mission_content_sha256: first.mission.content_sha256,
      identity: brainstormIdentity,
      problem_statement: "Shaping lacks a durable artifact loop.",
      approach: "Publish a content-addressed shaping snapshot.",
      non_goals: ["Do not widen Execute missions."],
      open_questions: ["How should Plan shaping work later?"],
    };
    const appliedBrainstorm = await writeAppliedShapingBundle(
      first,
      brainstormResult,
    );
    await expect(
      workspace.readAppliedShapingResult(brainstormIdentity),
    ).resolves.toMatchObject({
      result_path: `.founder/shaping/${firstId}/brainstorm-${brainstormIdentity.input_sha256}/applied/result.json`,
      result_source: appliedBrainstorm.resultSource,
    });

    const acceptance: ShapingSelectionReceipt = {
      shaping_schema_version: 2,
      identity: brainstormIdentity,
      mission_content_sha256: first.mission.content_sha256,
      result_content_sha256: appliedBrainstorm.resultContentSha256,
      selected_at: "2026-07-29T00:02:00.000Z",
    };
    const accepted = await workspace.writeShapingDecisionReceipt(acceptance);
    expect(
      await workspace.writeShapingDecisionReceipt(acceptance),
    ).toEqual(accepted);
    expect(accepted.receipt_path).toBe(
      join(dirname(first.mission_path), "decision.json"),
    );

    const specItem = {
      ...item,
      state: {
        ...item.state,
        phase: "spec" as const,
        updated_at: "2026-07-29T00:03:00.000Z",
      },
    };
    await writeFile(
      join(root, ".founder", "work-items", firstId, "state.json"),
      `${JSON.stringify(specItem.state, null, 2)}\n`,
      "utf8",
    );
    const specInput = {
      phase: "spec" as const,
      title: specItem.goal.title,
      notes: specItem.goal.notes,
      brainstorm_selection_sha256: accepted.receipt_content_sha256,
      brainstorm_selection: acceptance,
      brainstorm_result: brainstormResult,
    };
    const specIdentity: ShapingIdentity<"spec"> = {
      phase: "spec",
      work_item_id: firstId,
      input_sha256: hashShapingInput(specInput),
    };
    const spec = await workspace.writeShapingMissionPackage(
      specIdentity,
      (paths) =>
        compileSpecMission({
          work_item_id: firstId,
          shaping_input: specInput,
          paths,
        }),
    );
    const specResult: SpecResultSubmission = {
      result_schema_version: 1,
      spec_mission_content_sha256: spec.mission.content_sha256,
      identity: specIdentity,
      proposal: {
        purpose: "Deliver a guided shaping handoff.",
        acceptance_criteria: ["All three shaping phases publish."],
        non_goals: ["Do not authorize Execute."],
        allowed_scope: ["src/workspace"],
        review_ready: ["The workspace contract test passes."],
      },
    };
    const appliedSpec = await writeAppliedShapingBundle(spec, specResult);
    const goalContractSha256 = "9".repeat(64);
    const specApproval: SpecApprovalReceipt = {
      shaping_schema_version: 2,
      identity: specIdentity,
      mission_content_sha256: spec.mission.content_sha256,
      result_content_sha256: appliedSpec.resultContentSha256,
      goal_contract_sha256: goalContractSha256,
      approved_at: "2026-07-29T00:04:00.000Z",
    };
    await expect(
      workspace.writeShapingDecisionReceipt({
        ...specApproval,
        result_content_sha256: appliedBrainstorm.resultContentSha256,
      }),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
    const approved = await workspace.writeShapingDecisionReceipt(
      specApproval,
    );

    const planState = {
      ...specItem.state,
      phase: "plan" as const,
      updated_at: "2026-07-29T00:05:00.000Z",
    };
    await writeFile(
      join(root, ".founder", "work-items", firstId, "state.json"),
      `${JSON.stringify(planState, null, 2)}\n`,
      "utf8",
    );
    const planInput = {
      phase: "plan" as const,
      title: specItem.goal.title,
      notes: specItem.goal.notes,
      spec_approval_sha256: approved.receipt_content_sha256,
      spec_approval: specApproval,
      spec_result: specResult,
      repository_base_commit: "a".repeat(40),
      goal_contract_sha256: goalContractSha256,
      goal_version: 1,
    };
    const planIdentity: ShapingIdentity<"plan"> = {
      phase: "plan",
      work_item_id: firstId,
      input_sha256: hashShapingInput(planInput),
    };
    const plan = await workspace.writeShapingMissionPackage(
      planIdentity,
      (paths) =>
        compilePlanMission({
          work_item_id: firstId,
          shaping_input: planInput,
          paths,
        }),
    );
    const planMissionSource = await readFile(plan.mission_path, "utf8");
    const planTaskSource = await readFile(plan.task_path, "utf8");
    expect(
      await workspace.writeShapingMissionPackage(planIdentity, (paths) =>
        compilePlanMission({
          work_item_id: firstId,
          shaping_input: planInput,
          paths,
        }),
      ),
    ).toEqual(plan);
    expect(await readFile(plan.mission_path, "utf8")).toBe(
      planMissionSource,
    );
    expect(await readFile(plan.task_path, "utf8")).toBe(planTaskSource);
    const planResult: PlanResultSubmission = {
      result_schema_version: 1,
      plan_mission_content_sha256: plan.mission.content_sha256,
      identity: planIdentity,
      summary: "Implement the bounded shaping handoff.",
      checklist: [
        {
          id: "step-1",
          step: "Publish the shaping family.",
          verification_check: "Run the workspace contract test.",
        },
      ],
      relevant_skills: [],
      product_doc_impacts: [],
      todo_impacts: [],
      open_questions: [],
    };
    const appliedPlan = await writeAppliedShapingBundle(plan, planResult);
    const planApproval: PlanApprovalReceipt = {
      shaping_schema_version: 2,
      identity: planIdentity,
      mission_content_sha256: plan.mission.content_sha256,
      result_content_sha256: appliedPlan.resultContentSha256,
      goal_contract_sha256: goalContractSha256,
      goal_version: 1,
      execute_tuple: {
        goal_version: 1,
        input_revision: 1,
        attempt: 0,
      },
      approved_at: "2026-07-29T00:06:00.000Z",
    };
    const writtenPlanApproval =
      await workspace.writeShapingDecisionReceipt(planApproval);
    await expect(
      workspace.writeShapingDecisionReceipt(planApproval),
    ).resolves.toEqual(writtenPlanApproval);
    await expect(
      workspace.writeShapingDecisionReceipt({
        ...planApproval,
        approved_at: "2026-07-29T00:07:00.000Z",
      }),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
    await expect(
      workspace.writeShapingDecisionReceipt({
        ...planApproval,
        identity: specIdentity,
      } as unknown as PlanApprovalReceipt),
    ).rejects.toThrow();
    expect(writtenPlanApproval.receipt_path).toBe(
      join(dirname(plan.mission_path), "decision.json"),
    );

    expect(spec.mission.input).toMatchObject({
      brainstorm_selection_sha256: accepted.receipt_content_sha256,
    });
    expect(
      (await workspace.listShapingArtifacts(firstId)).map(
        (artifact) => artifact.mission.identity.phase,
      ),
    ).toEqual(["brainstorm", "plan", "spec"]);
    expect(await workspace.readShapingMissionPackage(specIdentity)).toEqual({
      mission: spec.mission,
      mission_path: spec.mission_path.slice(root.length + 1),
    });
    expect(gitHeadReads).toBe(0);
  });

  it("resolves one- and two-link revision chains from structural supersession", async () => {
    const root = await createWorkspace();
    const item = await writeShapingReadyWorkItem(root, firstId);
    const workspace = new ProductWorkspace(root);
    const originalInput = {
      phase: "brainstorm" as const,
      title: item.goal.title,
      notes: item.goal.notes,
    };
    const originalIdentity: ShapingIdentity<"brainstorm"> = {
      phase: "brainstorm",
      work_item_id: firstId,
      input_sha256: hashShapingInput(originalInput),
    };
    const original = await workspace.writeShapingMissionPackage(
      originalIdentity,
      (paths) =>
        compileBrainstormMission({
          work_item_id: firstId,
          shaping_input: originalInput,
          paths,
        }),
    );
    const originalApplied = await writeAppliedShapingBundle(original, {
      result_schema_version: 1,
      brainstorm_mission_content_sha256: original.mission.content_sha256,
      identity: originalIdentity,
      problem_statement: "The original mission needs refinement.",
      approach: "Revise it with explicit feedback.",
      non_goals: ["Do not mutate the original."],
      open_questions: ["Which verification should the revision name?"],
    });

    const revisionOneInput = {
      ...originalInput,
      revision: {
        ordinal: 1,
        supersedes_input_sha256: originalIdentity.input_sha256,
        superseded_result_sha256: originalApplied.resultContentSha256,
        feedback: "Make the approach more concrete.",
      },
    };
    const revisionOneIdentity: ShapingIdentity<"brainstorm"> = {
      phase: "brainstorm",
      work_item_id: firstId,
      input_sha256: hashShapingInput(revisionOneInput),
    };
    const revisionOne = await workspace.writeShapingMissionPackage(
      revisionOneIdentity,
      (paths) =>
        compileBrainstormMission({
          work_item_id: firstId,
          shaping_input: revisionOneInput,
          paths,
        }),
    );
    const revisionOneApplied = await writeAppliedShapingBundle(revisionOne, {
      result_schema_version: 1,
      brainstorm_mission_content_sha256: revisionOne.mission.content_sha256,
      identity: revisionOneIdentity,
      problem_statement: "The revised mission is concrete.",
      approach: "Keep the structural chain explicit.",
      non_goals: ["Do not use timestamps for ordering."],
      open_questions: ["Which final verification should the next revision name?"],
    });
    await expect(
      workspace.resolveCurrentMissionRevision(firstId, "brainstorm"),
    ).resolves.toMatchObject({ mission: { identity: revisionOneIdentity } });

    const revisionTwoInput = {
      ...originalInput,
      revision: {
        ordinal: 2,
        supersedes_input_sha256: revisionOneIdentity.input_sha256,
        superseded_result_sha256: revisionOneApplied.resultContentSha256,
        feedback: "Name the final verification explicitly.",
      },
    };
    const revisionTwoIdentity: ShapingIdentity<"brainstorm"> = {
      phase: "brainstorm",
      work_item_id: firstId,
      input_sha256: hashShapingInput(revisionTwoInput),
    };
    await workspace.writeShapingMissionPackage(
      revisionTwoIdentity,
      (paths) =>
        compileBrainstormMission({
          work_item_id: firstId,
          shaping_input: revisionTwoInput,
          paths,
        }),
    );
    await expect(
      workspace.resolveCurrentMissionRevision(firstId, "brainstorm"),
    ).resolves.toMatchObject({ mission: { identity: revisionTwoIdentity } });
  });

  it("fails repair-required when a revision names no prior mission", async () => {
    const root = await createWorkspace();
    const item = await writeShapingReadyWorkItem(root, firstId);
    const workspace = new ProductWorkspace(root);
    const input = {
      phase: "brainstorm" as const,
      title: item.goal.title,
      notes: item.goal.notes,
      revision: {
        ordinal: 1,
        supersedes_input_sha256: "7".repeat(64),
        superseded_result_sha256: "8".repeat(64),
        feedback: "This predecessor does not exist.",
      },
    };
    const identity: ShapingIdentity<"brainstorm"> = {
      phase: "brainstorm",
      work_item_id: firstId,
      input_sha256: hashShapingInput(input),
    };
    await workspace.writeShapingMissionPackage(identity, (paths) =>
      compileBrainstormMission({
        work_item_id: firstId,
        shaping_input: input,
        paths,
      }),
    );

    await expect(
      workspace.resolveCurrentMissionRevision(firstId, "brainstorm"),
    ).rejects.toMatchObject({
      kind: "repair_required",
      reason: expect.stringContaining("missing predecessor"),
    });
  });

  it("recognizes no result without applied.json and fails repair-required on component drift", async () => {
    const root = await createWorkspace();
    const { artifact, workspace } = await writeBrainstormShapingArtifact(
      root,
      firstId,
    );
    await expect(
      workspace.readAppliedShapingResult(artifact.mission.identity),
    ).resolves.toBeNull();

    const persistedBrainstormIdentity = artifact.mission.identity;
    if (persistedBrainstormIdentity.phase !== "brainstorm") {
      throw new Error("Expected persisted Brainstorm shaping identity");
    }
    const applied = await writeAppliedShapingBundle(artifact, {
      result_schema_version: 1,
      brainstorm_mission_content_sha256: artifact.mission.content_sha256,
      identity: persistedBrainstormIdentity,
      problem_statement: "The marker binds every component.",
      approach: "Reject any mismatched sibling.",
      non_goals: [],
      open_questions: [],
    });
    await writeFile(
      join(applied.appliedDirectory, "applied.json"),
      `${JSON.stringify(
        {
          ...applied.appliedMarker,
          component_sha256: {
            ...applied.appliedMarker.component_sha256,
            production: "0".repeat(64),
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(
      workspace.readAppliedShapingResult(artifact.mission.identity),
    ).rejects.toMatchObject({
      kind: "repair_required",
      reason: expect.stringContaining("production.json"),
    });
  });

  it("rejects v1 shaping artifacts with the exact directory and archive-or-reset remedy", async () => {
    const root = await createWorkspace();
    const { artifact, workspace } = await writeBrainstormShapingArtifact(
      root,
      firstId,
    );
    const artifactDirectory = dirname(artifact.mission_path);
    await writeFile(
      artifact.mission_path,
      '{"shaping_schema_version":1}\n',
      "utf8",
    );

    await expect(workspace.listShapingArtifacts(firstId)).rejects.toMatchObject({
      kind: "invalid_workspace",
      artifactPath: artifactDirectory.slice(root.length + 1),
      reason: expect.stringMatching(/schema version 1.*archive or reset/u),
    });
  });

  it("writes hash-bound ingress instructions read-first and replays stored bytes under an advanced clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T13:00:00.000Z"));
    const root = await createWorkspace();
    const { artifact, workspace } = await writeBrainstormShapingArtifact(
      root,
      firstId,
    );

    const first = await workspace.writeShapingIngressInstruction({
      origin: "manual_import",
      shaping_run_id: null,
      mission: artifact.mission,
    });
    vi.setSystemTime(new Date("2026-08-01T14:00:00.000Z"));
    const replay = await workspace.writeShapingIngressInstruction({
      origin: "manual_import",
      shaping_run_id: null,
      mission: artifact.mission,
    });

    expect(replay).toEqual(first);
    expect(replay.instruction.created_at).toBe("2026-08-01T13:00:00.000Z");
    expect(await readFile(first.instruction_path, "utf8")).toBe(
      first.instruction_source,
    );

    const tamperedInstruction = {
      ...first.instruction,
      task_path: ".founder/other/TASK.md",
    };
    tamperedInstruction.instruction_sha256 =
      hashShapingIngressInstruction(tamperedInstruction);
    await writeFile(
      first.instruction_path,
      `${JSON.stringify(tamperedInstruction, null, 2)}\n`,
      "utf8",
    );
    await expect(
      workspace.writeShapingIngressInstruction({
        origin: "manual_import",
        shaping_run_id: null,
        mission: artifact.mission,
      }),
    ).rejects.toMatchObject({ kind: "repair_required" });

    const failureRoot = await createWorkspace();
    const { artifact: failureArtifact } =
      await writeBrainstormShapingArtifact(failureRoot, firstId);
    const failing = new FailingShapingPublicationWorkspace(
      failureRoot,
      "instruction",
    );
    await expect(
      failing.writeShapingIngressInstruction({
        origin: "manual_import",
        shaping_run_id: null,
        mission: failureArtifact.mission,
      }),
    ).rejects.toThrow("injected failure after instruction write");
    vi.setSystemTime(new Date("2026-08-01T15:00:00.000Z"));
    const recovered = await new ProductWorkspace(
      failureRoot,
    ).writeShapingIngressInstruction({
      origin: "manual_import",
      shaping_run_id: null,
      mission: failureArtifact.mission,
    });
    expect(recovered.instruction.created_at).toBe(
      "2026-08-01T14:00:00.000Z",
    );
  });

  it("rejects symlinks, a FIFO, a directory, empty bytes, and oversize ingress without publication", async () => {
    const cases = ["symlink", "fifo", "directory", "empty", "oversize"] as const;
    for (const kind of cases) {
      const root = await createWorkspace();
      const { artifact, workspace } = await writeBrainstormShapingArtifact(
        root,
        firstId,
      );
      const written = await workspace.writeShapingIngressInstruction({
        origin: "manual_import",
        shaping_run_id: null,
        mission: artifact.mission,
      });
      const ingressPath = join(
        root,
        ...written.instruction.ingress_path.split("/"),
      );
      if (kind === "symlink") {
        const target = join(root, "symlink-target.json");
        await writeFile(
          target,
          `${JSON.stringify(brainstormResultFor(artifact))}\n`,
          "utf8",
        );
        await symlink(target, ingressPath);
      } else if (kind === "fifo") {
        await execFileAsync("mkfifo", [ingressPath]);
      } else if (kind === "directory") {
        await mkdir(ingressPath);
      } else if (kind === "empty") {
        await writeFile(ingressPath, "", "utf8");
      } else {
        await writeFile(
          ingressPath,
          Buffer.alloc(SHAPING_INGRESS_MAX_BYTES + 1, 0x20),
        );
      }

      await expect(
        workspace.publishAppliedShapingResult(
          written.instruction,
          artifact.mission,
          { origin: "manual_import", shaping_run_id: null },
        ),
      ).rejects.toMatchObject({ kind: "mission_not_ready" });
      await expect(
        workspace.readAppliedShapingResult(artifact.mission.identity),
      ).resolves.toBeNull();
    }

    const parentRoot = await createWorkspace();
    const { artifact: parentArtifact } =
      await writeBrainstormShapingArtifact(parentRoot, firstId);
    const runDirectory = join(
      parentRoot,
      ".founder",
      "shaping-runs",
      firstId,
      firstRunId,
    );
    await mkdir(runDirectory, { recursive: true });
    const parentWorkspace = new ProductWorkspace(parentRoot);
    const connectedInstruction =
      await parentWorkspace.writeShapingIngressInstruction({
        origin: "connected_run",
        shaping_run_id: firstRunId,
        mission: parentArtifact.mission,
      });
    const ingressDirectory = dirname(
      join(
        parentRoot,
        ...connectedInstruction.instruction.ingress_path.split("/"),
      ),
    );
    const realIngressDirectory = `${ingressDirectory}.real`;
    await rename(ingressDirectory, realIngressDirectory);
    await writeFile(
      join(realIngressDirectory, "result.json"),
      `${JSON.stringify(brainstormResultFor(parentArtifact))}\n`,
      "utf8",
    );
    await symlink(realIngressDirectory, ingressDirectory, "dir");

    await expect(
      parentWorkspace.publishAppliedShapingResult(
        connectedInstruction.instruction,
        parentArtifact.mission,
        connectedShapingProduction,
      ),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });
    await expect(
      parentWorkspace.readAppliedShapingResult(
        parentArtifact.mission.identity,
      ),
    ).resolves.toBeNull();
  });

  it("bounds a growing descriptor and publishes the originally opened file after a path swap", async () => {
    const growthRoot = await createWorkspace();
    const { artifact: growthArtifact } =
      await writeBrainstormShapingArtifact(growthRoot, firstId);
    let grew = false;
    const growthWorkspace = new MutatingShapingIngressWorkspace(
      growthRoot,
      async (ingressPath) => {
        if (!grew) {
          grew = true;
          await appendFile(
            ingressPath,
            Buffer.alloc(SHAPING_INGRESS_MAX_BYTES + 1, 0x20),
          );
        }
      },
    );
    const growthSource = `${JSON.stringify(brainstormResultFor(growthArtifact))}\n`;
    const growthInstruction = await writeManualShapingIngress(
      growthRoot,
      growthWorkspace,
      growthArtifact,
      growthSource,
    );
    await expect(
      growthWorkspace.publishAppliedShapingResult(
        growthInstruction.instruction,
        growthArtifact.mission,
        { origin: "manual_import", shaping_run_id: null },
      ),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });
    await expect(
      growthWorkspace.readAppliedShapingResult(growthArtifact.mission.identity),
    ).resolves.toBeNull();

    const swapRoot = await createWorkspace();
    const { artifact: swapArtifact } =
      await writeBrainstormShapingArtifact(swapRoot, firstId);
    const originalSource = `  ${JSON.stringify(
      brainstormResultFor(swapArtifact, "The opened inode must win."),
    )}\n`;
    const replacementSource = `${JSON.stringify(
      brainstormResultFor(swapArtifact, "The replacement path must not win."),
    )}\n`;
    let swapped = false;
    const swapWorkspace = new MutatingShapingIngressWorkspace(
      swapRoot,
      async (ingressPath) => {
        if (!swapped) {
          swapped = true;
          await rename(ingressPath, `${ingressPath}.opened`);
          await writeFile(ingressPath, replacementSource, "utf8");
        }
      },
    );
    const swapInstruction = await writeManualShapingIngress(
      swapRoot,
      swapWorkspace,
      swapArtifact,
      originalSource,
    );
    const published = await swapWorkspace.publishAppliedShapingResult(
      swapInstruction.instruction,
      swapArtifact.mission,
      { origin: "manual_import", shaping_run_id: null },
    );
    expect(published.result_source).toBe(originalSource);
    expect(
      await readFile(
        join(dirname(swapArtifact.mission_path), "applied", "result.json"),
        "utf8",
      ),
    ).toBe(originalSource);
    expect(await readFile(swapInstruction.ingressPath, "utf8")).toBe(
      replacementSource,
    );
  });

  it("publishes one exact atomic bundle, replays it verbatim, and refuses a differing result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T16:00:00.000Z"));
    const root = await createWorkspace();
    const { artifact, workspace } = await writeBrainstormShapingArtifact(
      root,
      firstId,
    );
    const resultSource = `\n${JSON.stringify(
      brainstormResultFor(artifact),
      null,
      2,
    )}\n`;
    const written = await writeManualShapingIngress(
      root,
      workspace,
      artifact,
      resultSource,
    );
    const staleStagingName =
      `.${artifact.mission.identity.phase}-${artifact.mission.identity.input_sha256}.${firstRunId}.applied.staging`;
    const staleStagingPath = join(
      dirname(dirname(artifact.mission_path)),
      staleStagingName,
    );
    await mkdir(staleStagingPath);
    await writeFile(join(staleStagingPath, "partial"), "stale", "utf8");

    const first = await workspace.publishAppliedShapingResult(
      written.instruction,
      artifact.mission,
      { origin: "manual_import", shaping_run_id: null },
    );
    expect(
      await readFile(
        join(dirname(artifact.mission_path), "applied", "result.json"),
        "utf8",
      ),
    ).toBe(resultSource);
    expect(await readdir(dirname(dirname(artifact.mission_path)))).not.toContain(
      staleStagingName,
    );

    vi.setSystemTime(new Date("2026-08-01T17:00:00.000Z"));
    const replay = await workspace.publishAppliedShapingResult(
      written.instruction,
      artifact.mission,
      { origin: "manual_import", shaping_run_id: null },
    );
    expect(replay).toEqual(first);
    expect(replay.import_receipt.first_published_at).toBe(
      "2026-08-01T16:00:00.000Z",
    );
    expect(replay.production_receipt.produced_at).toBe(
      "2026-08-01T16:00:00.000Z",
    );
    expect(replay.applied_marker.committed_at).toBe(
      "2026-08-01T16:00:00.000Z",
    );

    const differingSource = `${JSON.stringify(
      brainstormResultFor(artifact, "A conflicting result."),
      null,
      2,
    )}\n`;
    await writeFile(written.ingressPath, differingSource, "utf8");
    await expect(
      workspace.publishAppliedShapingResult(
        written.instruction,
        artifact.mission,
        { origin: "manual_import", shaping_run_id: null },
      ),
    ).rejects.toMatchObject({ kind: "idempotency_conflict" });
    expect(
      await readFile(
        join(dirname(artifact.mission_path), "applied", "result.json"),
        "utf8",
      ),
    ).toBe(resultSource);
  });

  it("recovers byte-identically after every staged component and the atomic rename", async () => {
    vi.useFakeTimers();
    const boundaries = [
      "result",
      "import",
      "production",
      "applied",
      "renamed",
    ] as const;
    for (const [index, boundary] of boundaries.entries()) {
      vi.setSystemTime(new Date(`2026-08-0${index + 1}T10:00:00.000Z`));
      const root = await createWorkspace();
      const { artifact } = await writeBrainstormShapingArtifact(root, firstId);
      const failing = new FailingShapingPublicationWorkspace(root, boundary);
      const resultSource = `${JSON.stringify(
        brainstormResultFor(artifact),
        null,
        2,
      )}\n`;
      const written = await writeManualShapingIngress(
        root,
        failing,
        artifact,
        resultSource,
      );

      await expect(
        failing.publishAppliedShapingResult(
          written.instruction,
          artifact.mission,
          { origin: "manual_import", shaping_run_id: null },
        ),
      ).rejects.toThrow(`injected failure after ${
        boundary === "renamed" ? "applied bundle rename" : `${boundary} write`
      }`);

      const workspace = new ProductWorkspace(root);
      const afterFailure = await workspace.readAppliedShapingResult(
        artifact.mission.identity,
      );
      expect(afterFailure === null).toBe(boundary !== "renamed");
      vi.setSystemTime(new Date(`2026-08-0${index + 1}T11:00:00.000Z`));
      const recovered = await workspace.publishAppliedShapingResult(
        written.instruction,
        artifact.mission,
        { origin: "manual_import", shaping_run_id: null },
      );
      vi.setSystemTime(new Date(`2026-08-0${index + 1}T12:00:00.000Z`));
      const replay = await workspace.publishAppliedShapingResult(
        written.instruction,
        artifact.mission,
        { origin: "manual_import", shaping_run_id: null },
      );
      expect(replay).toEqual(recovered);
      expect(replay.result_source).toBe(resultSource);
      expect(
        (await readdir(dirname(dirname(artifact.mission_path)))).filter(
          (name) => name.endsWith(".applied.staging"),
        ),
      ).toEqual([]);
    }
  });

  it("ignores unrelated files when listing shaping artifacts", async () => {
    const root = await createWorkspace();
    const { artifact, workspace } = await writeBrainstormShapingArtifact(
      root,
      firstId,
    );
    const expected = await workspace.listShapingArtifacts(firstId);
    await writeFile(
      join(dirname(dirname(artifact.task_path)), ".DS_Store"),
      "",
      "utf8",
    );

    expect(await workspace.listShapingArtifacts(firstId)).toEqual(expected);
  });

  it("ignores valid leftover shaping staging directories", async () => {
    const root = await createWorkspace();
    const { artifact, workspace } = await writeBrainstormShapingArtifact(
      root,
      firstId,
    );
    const expected = await workspace.listShapingArtifacts(firstId);
    await mkdir(
      join(
        dirname(dirname(artifact.task_path)),
        `.brainstorm-${"b".repeat(64)}.${firstRunId}.shaping.tmp`,
      ),
    );

    expect(await workspace.listShapingArtifacts(firstId)).toEqual(expected);
  });

  it("rejects near-miss shaping directory names", async () => {
    const root = await createWorkspace();
    const { artifact, workspace } = await writeBrainstormShapingArtifact(
      root,
      firstId,
    );
    await mkdir(join(dirname(dirname(artifact.task_path)), "brainstorm-abc"));

    await expect(workspace.listShapingArtifacts(firstId)).rejects.toMatchObject({
      kind: "invalid_workspace",
    });
  });

  it("rejects symlinked exact shaping artifact names", async () => {
    const root = await createWorkspace();
    const outsideRoot = await createWorkspace();
    const { artifact, workspace } = await writeBrainstormShapingArtifact(
      root,
      firstId,
    );
    await symlink(
      outsideRoot,
      join(
        dirname(dirname(artifact.task_path)),
        `brainstorm-${"b".repeat(64)}`,
      ),
      "dir",
    );

    await expect(workspace.listShapingArtifacts(firstId)).rejects.toMatchObject({
      kind: "invalid_workspace",
    });
  });

  it("fails closed on stale, divergent, unsafe, and symlinked shaping state", async () => {
    const staleRoot = await createWorkspace();
    const staleItem = await writeShapingReadyWorkItem(staleRoot, firstId);
    const staleInput = {
      phase: "brainstorm" as const,
      title: staleItem.goal.title,
      notes: staleItem.goal.notes,
    };
    const staleIdentity: ShapingIdentity<"brainstorm"> = {
      phase: "brainstorm",
      work_item_id: firstId,
      input_sha256: hashShapingInput(staleInput),
    };
    await writeFile(
      join(staleRoot, ".founder", "work-items", firstId, "goal.yaml"),
      stringify({ ...staleItem.goal, title: "Changed after compile" }),
      "utf8",
    );
    await expect(
      new ProductWorkspace(staleRoot).writeShapingMissionPackage(
        staleIdentity,
        (paths) =>
          compileBrainstormMission({
            work_item_id: firstId,
            shaping_input: staleInput,
            paths,
          }),
      ),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });
    await expect(
      new ProductWorkspace(staleRoot).writeShapingMissionPackage(
        { ...staleIdentity, work_item_id: "../escape" },
        () => {
          throw new Error("builder must not run");
        },
      ),
    ).rejects.toBeInstanceOf(Error);

    const divergentRoot = await createWorkspace();
    const divergentItem = await writeShapingReadyWorkItem(divergentRoot, firstId);
    const divergentInput = {
      phase: "brainstorm" as const,
      title: divergentItem.goal.title,
      notes: divergentItem.goal.notes,
    };
    const divergentIdentity: ShapingIdentity<"brainstorm"> = {
      phase: "brainstorm",
      work_item_id: firstId,
      input_sha256: hashShapingInput(divergentInput),
    };
    const divergentWorkspace = new ProductWorkspace(divergentRoot);
    const artifact = await divergentWorkspace.writeShapingMissionPackage(
      divergentIdentity,
      (paths) =>
        compileBrainstormMission({
          work_item_id: firstId,
          shaping_input: divergentInput,
          paths,
        }),
    );
    const result: BrainstormResultSubmission = {
      result_schema_version: 1,
      brainstorm_mission_content_sha256: artifact.mission.content_sha256,
      identity: divergentIdentity,
      problem_statement: "A problem.",
      approach: "An approach.",
      non_goals: ["A non-goal."],
      open_questions: ["A question?"],
    };
    const applied = await writeAppliedShapingBundle(artifact, result);
    const resultSource = applied.resultSource;
    const receipt = applied.importReceipt;
    await writeFile(
      join(applied.appliedDirectory, "result.json"),
      `${resultSource} `,
      "utf8",
    );
    await expect(
      divergentWorkspace.readShapingResult(divergentIdentity),
    ).rejects.toMatchObject({ kind: "repair_required" });
    await expect(
      divergentWorkspace.writeShapingImportReceipt({
        result_source: resultSource,
        receipt,
      }),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
    await writeFile(
      join(applied.appliedDirectory, "result.json"),
      resultSource,
      "utf8",
    );
    await writeFile(
      join(applied.appliedDirectory, "import.json"),
      `${JSON.stringify({ ...receipt, first_published_at: "2026-07-29T00:02:00.000Z" }, null, 2)}\n`,
      "utf8",
    );
    await expect(
      divergentWorkspace.readShapingResult(divergentIdentity),
    ).rejects.toMatchObject({ kind: "repair_required" });
    await writeFile(artifact.mission_path, "{}\n", "utf8");
    await expect(
      divergentWorkspace.writeShapingMissionPackage(
        divergentIdentity,
        (paths) =>
          compileBrainstormMission({
            work_item_id: firstId,
            shaping_input: divergentInput,
            paths,
          }),
      ),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });

    const symlinkRoot = await createWorkspace();
    const outsideRoot = await createWorkspace();
    const symlinkItem = await writeShapingReadyWorkItem(symlinkRoot, firstId);
    await symlink(
      outsideRoot,
      join(symlinkRoot, ".founder", "shaping"),
      "dir",
    );
    const symlinkInput = {
      phase: "brainstorm" as const,
      title: symlinkItem.goal.title,
      notes: symlinkItem.goal.notes,
    };
    const symlinkIdentity: ShapingIdentity<"brainstorm"> = {
      phase: "brainstorm",
      work_item_id: firstId,
      input_sha256: hashShapingInput(symlinkInput),
    };
    await expect(
      new ProductWorkspace(symlinkRoot).writeShapingMissionPackage(
        symlinkIdentity,
        (paths) =>
          compileBrainstormMission({
            work_item_id: firstId,
            shaping_input: symlinkInput,
            paths,
          }),
      ),
    ).rejects.toMatchObject({
      kind: "invalid_workspace",
      artifactPath: ".founder/shaping",
    });
    expect(await readdir(outsideRoot)).toEqual([".founder"]);
  });

  it("reads the mission result and publishes immutable regular-file evidence", async () => {
    const root = await createWorkspace();
    const item = await writeMissionReadyWorkItem(root, firstId);
    const manifest = appliedExecuteManifest();
    const workspace = missionWorkspace(root);
    const artifact = await workspace.writeMissionPackage(
      missionIdentity(),
      (paths) => compileMission(item, manifest, paths),
    );
    const resultPath = join(dirname(artifact.task_path), "result.json");
    const submissionSource = "{invalid";
    await writeFile(resultPath, submissionSource, "utf8");

    const snapshot = await workspace.readMissionResult(missionIdentity());
    expect(snapshot.mission).toEqual(artifact.mission);
    expect(snapshot.result_source).toBe(submissionSource);
    expect(snapshot.result_path).toBe(
      `.founder/missions/${firstId}/execute-1-1-0/result.json`,
    );

    const resultContentSha256 = hashResultContent(submissionSource);
    const importRunId = createImportRunId(
      artifact.mission.content_sha256,
      resultContentSha256,
    );
    const evidence = {
      schema_version: 2 as const,
      phase: "execute" as const,
      import_run_id: importRunId,
      result_content_sha256: resultContentSha256,
      mission_content_sha256: artifact.mission.content_sha256,
      identity: missionIdentity(),
      git_base_commit: artifact.mission.source_revision.git_base_commit,
      result_commit: null,
      controller_run_id: thirdRunId,
      started_at: "2026-07-22T12:00:00.000Z",
      completed_at: "2026-07-22T12:00:01.000Z",
      outcome: "rejected" as const,
      reasons: ["result.json is not valid JSON."],
    };
    const first = await workspace.writeImportEvidence({
      submission_source: submissionSource,
      evidence,
      verification: [],
    });
    const second = await workspace.writeImportEvidence({
      submission_source: submissionSource,
      evidence,
      verification: [],
    });
    expect(second).toEqual(first);
    expect(await workspace.readImportEvidence(missionIdentity(), importRunId))
      .toMatchObject({ evidence, summary: first, verification: [] });

    const evidenceDirectory = join(root, first.evidence_path);
    expect((await readdir(evidenceDirectory)).sort()).toEqual([
      "import.json",
      "submission.json",
      "verification.json",
    ]);
    await expect(
      workspace.writeImportEvidence({
        submission_source: submissionSource,
        evidence: { ...evidence, reasons: ["Divergent reason"] },
        verification: [],
      }),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
    expect(
      JSON.parse(await readFile(join(evidenceDirectory, "import.json"), "utf8")),
    ).toEqual(evidence);

    const outside = join(root, "outside-verification.json");
    await writeFile(outside, "[]\n", "utf8");
    await rm(join(evidenceDirectory, "verification.json"));
    await symlink(outside, join(evidenceDirectory, "verification.json"), "file");
    await expect(
      workspace.readImportEvidence(missionIdentity(), importRunId),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
  });

  it("reads historical v3 execute/review artifacts without rewriting their bytes", async () => {
    const root = await createWorkspace();
    const executeItem = await writeMissionReadyWorkItem(root, firstId);
    const workspace = missionWorkspace(root);
    const commandEvidence = [
      {
        name: "Tests",
        argv: ["npm", "test"] as [string, ...string[]],
        started_at: "2026-07-20T12:00:00.000Z",
        completed_at: "2026-07-20T12:00:01.000Z",
        duration_ms: 1_000,
        status: "passed" as const,
        exit_code: 0 as const,
        signal: null,
        stdout: "green",
        stderr: "",
        output_truncated: false,
      },
    ];
    const historicalExecuteDraft: HistoricalExecuteMissionPackageV3 = {
      mission_schema_version: 3,
      identity: missionIdentity(),
      controller_run: {
        run_id: firstRunId,
        idempotency_key: `${firstId}:execute:1:1:0:historical`,
        phase: "execute",
        started_at: "2026-07-20T12:00:00.000Z",
        completed_at: "2026-07-20T12:00:01.000Z",
      },
      goal: {
        title: executeItem.goal.title,
        type: executeItem.goal.type,
        purpose: executeItem.goal.goal_contract!.purpose,
        acceptance_criteria:
          executeItem.goal.goal_contract!.acceptance_criteria,
        non_goals: executeItem.goal.goal_contract!.non_goals,
        allowed_scope: executeItem.goal.goal_contract!.allowed_scope,
        review_ready: executeItem.goal.goal_contract!.review_ready,
      },
      source_revision: { git_base_commit: "a".repeat(40) },
      result_contract: {
        schema_version: 3,
        output_path: `.founder/missions/${firstId}/execute-1-1-0/result.json`,
        result_schema_version: 2,
        required_fields: [
          "result_schema_version",
          "mission_content_sha256",
          "identity",
          "commit",
          "summary",
          "changed_files",
          "verification",
        ],
      },
      task_path: `.founder/missions/${firstId}/execute-1-1-0/TASK.md`,
      content_sha256: "0".repeat(64),
    };
    const historicalExecute = {
      ...historicalExecuteDraft,
      content_sha256: hashHistoricalMissionContentV3(
        historicalExecuteDraft,
      ),
    };
    const historicalReviewDraft: HistoricalReviewMissionPackageV3 = {
      mission_schema_version: 3,
      identity: { ...missionIdentity(), phase: "review" },
      controller_run: {
        run_id: secondRunId,
        idempotency_key: `${firstId}:review:1:1:0:historical`,
        phase: "review",
        started_at: "2026-07-20T12:00:01.000Z",
        completed_at: "2026-07-20T12:00:02.000Z",
      },
      goal: historicalExecute.goal,
      source_revision: historicalExecute.source_revision,
      review_subject: {
        execute_mission_content_sha256:
          historicalExecute.content_sha256,
        execute_result_content_sha256: "7".repeat(64),
        git_base_commit: "a".repeat(40),
        accepted_result_commit: "a".repeat(40),
        changed_files: ["src/domain/result.ts"],
        execute_mission_path: `.founder/missions/${firstId}/execute-1-1-0/mission.json`,
        execute_evidence_path: `.founder/run-evidence/${firstId}/execute-1-1-0/${"8".repeat(64)}`,
        command_evidence: commandEvidence,
      },
      independence_attested: true,
      result_contract: {
        schema_version: 3,
        output_path: `.founder/missions/${firstId}/review-1-1-0/result.json`,
        result_schema_version: 2,
        required_fields: [
          "result_schema_version",
          "review_mission_content_sha256",
          "identity",
          "execute_mission_content_sha256",
          "execute_result_content_sha256",
          "git_base_commit",
          "accepted_result_commit",
          "summary",
          "verdict",
          "findings",
        ],
      },
      task_path: `.founder/missions/${firstId}/review-1-1-0/TASK.md`,
      content_sha256: "0".repeat(64),
    };
    const historicalReview = {
      ...historicalReviewDraft,
      content_sha256: hashHistoricalMissionContentV3(
        historicalReviewDraft,
      ),
    };
    const historicalSources = new Map<string, string>();
    for (const mission of [historicalExecute, historicalReview]) {
      const directory = join(root, dirname(mission.task_path));
      await mkdir(directory, { recursive: true });
      const missionSource = serializeReadableMissionPackage(mission);
      const taskSource = renderReadableTaskMd(mission);
      await writeFile(join(directory, "mission.json"), missionSource);
      await writeFile(join(directory, "TASK.md"), taskSource);
      await writeFile(join(directory, "result.json"), "{}\n");
      historicalSources.set(join(directory, "mission.json"), missionSource);
      historicalSources.set(join(directory, "TASK.md"), taskSource);
    }

    const evidenceSubmission = '{"historical":true}\n';
    const evidenceResultHash = hashResultContent(evidenceSubmission);
    const evidenceSummary = await workspace.writeImportEvidence({
      submission_source: evidenceSubmission,
      evidence: {
        schema_version: 2,
        phase: "execute",
        import_run_id: createImportRunId(
          historicalExecute.content_sha256,
          evidenceResultHash,
        ),
        result_content_sha256: evidenceResultHash,
        mission_content_sha256: historicalExecute.content_sha256,
        identity: missionIdentity(),
        git_base_commit: "a".repeat(40),
        result_commit: null,
        controller_run_id: thirdRunId,
        started_at: "2026-07-20T12:00:01.000Z",
        completed_at: "2026-07-20T12:00:02.000Z",
        outcome: "rejected",
        reasons: ["Historical rejection remains inspectable."],
      },
      verification: [],
    });
    const evidenceDirectory = join(root, evidenceSummary.evidence_path);
    for (const name of [
      "submission.json",
      "import.json",
      "verification.json",
    ]) {
      const path = join(evidenceDirectory, name);
      historicalSources.set(path, await readFile(path, "utf8"));
    }

    expect(
      (await workspace.readMissionResult(missionIdentity())).mission
        .mission_schema_version,
    ).toBe(3);
    expect(
      (
        await workspace.readMissionResult({
          ...missionIdentity(),
          phase: "review",
        })
      ).mission.mission_schema_version,
    ).toBe(3);
    expect(await workspace.listImportEvidence(firstId)).toHaveLength(1);
    await expect(
      workspace.writeMissionPackage(
        missionIdentity(),
        (paths) =>
          compileMission(executeItem, appliedExecuteManifest(), paths),
      ),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });

    for (const [path, source] of historicalSources) {
      expect(await readFile(path, "utf8")).toBe(source);
    }
  });

  it("builds one immutable execute subject and writes a phase-distinct review mission", async () => {
    const root = await createWorkspace();
    const executeItem = await writeMissionReadyWorkItem(root, firstId);
    const workspace = missionWorkspace(root);
    const executeArtifact = await workspace.writeMissionPackage(
      missionIdentity(),
      (paths) =>
        compileMission(executeItem, appliedExecuteManifest(), paths),
    );
    const submissionSource = serializeExternalResult({
      result_schema_version: 2,
      mission_content_sha256: executeArtifact.mission.content_sha256,
      identity: missionIdentity(),
      commit: "a".repeat(40),
      summary: "Implement the accepted execute result.",
      changed_files: ["src/domain/result.ts"],
      verification: [{ name: "Tests", status: "passed" }],
    });
    const resultContentSha256 = hashResultContent(submissionSource);
    const importRunId = createImportRunId(
      executeArtifact.mission.content_sha256,
      resultContentSha256,
    );
    const evidence = {
      schema_version: 2 as const,
      phase: "execute" as const,
      import_run_id: importRunId,
      result_content_sha256: resultContentSha256,
      mission_content_sha256: executeArtifact.mission.content_sha256,
      identity: missionIdentity(),
      git_base_commit:
        executeArtifact.mission.source_revision.git_base_commit,
      result_commit: "a".repeat(40),
      controller_run_id: thirdRunId,
      started_at: "2026-07-22T12:00:00.000Z",
      completed_at: "2026-07-22T12:00:01.000Z",
      outcome: "applied" as const,
      reasons: [],
    };
    const verification = [
      {
        name: "Tests",
        argv: ["npm", "test"] as [string, ...string[]],
        started_at: "2026-07-22T12:00:00.000Z",
        completed_at: "2026-07-22T12:00:01.000Z",
        duration_ms: 1_000,
        status: "passed" as const,
        exit_code: 0,
        signal: null,
        stdout: "green",
        stderr: "",
        output_truncated: false,
      },
    ];
    await workspace.writeImportEvidence({
      submission_source: submissionSource,
      evidence,
      verification,
    });
    await writeRunManifest(root, {
      schema_version: 1,
      run_id: thirdRunId,
      work_item_id: firstId,
      idempotency_key: `${firstId}:execute:1:1:0:import`,
      phase: "review",
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
      started_at: evidence.started_at,
      completed_at: evidence.completed_at,
      outcome: "applied",
    });
    await writeMissionReadyWorkItem(root, firstId, "review");

    const subject = await workspace.readAppliedExecuteReviewSubject(
      missionIdentity(),
    );
    expect(subject.submission_source).toBe(submissionSource);
    expect(subject.evidence).toEqual(evidence);
    expect(subject.review_subject).toMatchObject({
      execute_mission_content_sha256: executeArtifact.mission.content_sha256,
      execute_result_content_sha256: resultContentSha256,
      accepted_result_commit: "a".repeat(40),
      changed_files: ["src/domain/result.ts"],
      execute_mission_path: `.founder/missions/${firstId}/execute-1-1-0/mission.json`,
      execute_evidence_path: `.founder/run-evidence/${firstId}/execute-1-1-0/${importRunId}`,
    });

    const reviewItem = await workspace.read(firstId);
    if (reviewItem === null) {
      throw new Error("Expected review work item");
    }
    const reviewIdentity = {
      ...missionIdentity(),
      phase: "review" as const,
    };
    const reviewRun: ReviewMissionControllerRun = {
      schema_version: 1,
      run_id: thirdRunId,
      work_item_id: firstId,
      idempotency_key: `${firstId}:review:1:1:0`,
      phase: "review",
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
      started_at: evidence.started_at,
      completed_at: evidence.completed_at,
      outcome: "applied",
    };
    const buildReview = (paths: Parameters<typeof compileMission>[2]) =>
      compileReviewMission({
        work_item: reviewItem,
        controller_run: reviewRun,
        review_subject: subject.review_subject,
        paths,
        independence_attested: true,
      });
    const first = await workspace.writeReviewMissionPackage(
      reviewIdentity,
      subject.review_subject,
      buildReview,
    );
    const second = await workspace.writeReviewMissionPackage(
      reviewIdentity,
      subject.review_subject,
      buildReview,
    );

    expect(second).toEqual(first);
    expect(first.mission.identity.phase).toBe("review");
    expect(first.mission.review_subject).toEqual(subject.review_subject);
    expect(
      (await readdir(join(root, ".founder", "missions", firstId))).sort(),
    ).toEqual(["execute-1-1-0", "review-1-1-0"]);

    const reviewMissionSource = await readFile(first.mission_path, "utf8");
    const reviewTaskSource = await readFile(first.task_path, "utf8");
    await expect(
      workspace.writeReviewMissionPackage(
        reviewIdentity,
        subject.review_subject,
        (paths) =>
          compileReviewMission({
            work_item: reviewItem,
            controller_run: {
              ...reviewRun,
              run_id: secondRunId,
              idempotency_key: `${firstId}:review:1:1:0:divergent`,
            },
            review_subject: subject.review_subject,
            paths,
            independence_attested: true,
          }),
      ),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
    expect(await readFile(first.mission_path, "utf8")).toBe(
      reviewMissionSource,
    );
    expect(await readFile(first.task_path, "utf8")).toBe(reviewTaskSource);

    await writeFile(
      join(
        root,
        subject.review_subject.execute_evidence_path,
        "submission.json",
      ),
      `${submissionSource} `,
      "utf8",
    );
    await expect(
      workspace.readAppliedExecuteReviewSubject(missionIdentity()),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
  });

  it("fails closed when applied execute evidence is absent or duplicated", async () => {
    const root = await createWorkspace();
    await writeMissionReadyWorkItem(root, firstId, "review");
    const workspace = missionWorkspace(root);
    await expect(
      workspace.readAppliedExecuteReviewSubject(missionIdentity()),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });

    const executeItem = await writeMissionReadyWorkItem(
      root,
      firstId,
      "execute",
    );
    const artifact = await workspace.writeMissionPackage(
      missionIdentity(),
      (paths) =>
        compileMission(executeItem, appliedExecuteManifest(), paths),
    );
    await writeRunManifest(root, {
      ...appliedExecuteManifest(thirdRunId),
      phase: "review",
    });
    const verification = [
      {
        name: "Tests",
        argv: ["npm", "test"] as [string, ...string[]],
        started_at: "2026-07-22T12:00:00.000Z",
        completed_at: "2026-07-22T12:00:01.000Z",
        duration_ms: 1_000,
        status: "passed" as const,
        exit_code: 0,
        signal: null,
        stdout: "green",
        stderr: "",
        output_truncated: false,
      },
    ];
    for (const summary of ["First accepted result", "Second accepted result"]) {
      const submissionSource = serializeExternalResult({
        result_schema_version: 2,
        mission_content_sha256: artifact.mission.content_sha256,
        identity: missionIdentity(),
        commit: "a".repeat(40),
        summary,
        changed_files: ["src/domain/result.ts"],
        verification: [{ name: "Tests", status: "passed" }],
      });
      const resultHash = hashResultContent(submissionSource);
      await workspace.writeImportEvidence({
        submission_source: submissionSource,
        evidence: {
          schema_version: 2,
          phase: "execute",
          import_run_id: createImportRunId(
            artifact.mission.content_sha256,
            resultHash,
          ),
          result_content_sha256: resultHash,
          mission_content_sha256: artifact.mission.content_sha256,
          identity: missionIdentity(),
          git_base_commit: artifact.mission.source_revision.git_base_commit,
          result_commit: "a".repeat(40),
          controller_run_id: thirdRunId,
          started_at: "2026-07-22T12:00:00.000Z",
          completed_at: "2026-07-22T12:00:01.000Z",
          outcome: "applied",
          reasons: [],
        },
        verification,
      });
    }
    await expect(
      workspace.readAppliedExecuteReviewSubject(missionIdentity()),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });
  });

  it("publishes cycle-qualified patch artifacts and derives one applied patch review subject", async () => {
    const root = await createWorkspace();
    const patchItem = await writeMissionReadyWorkItem(
      root,
      firstId,
      "patch",
      1,
    );
    const workspace = missionWorkspace(root);
    const commandEvidence = [
      {
        name: "Tests",
        argv: ["npm", "test"] as [string, ...string[]],
        started_at: "2026-07-22T12:00:00.000Z",
        completed_at: "2026-07-22T12:00:01.000Z",
        duration_ms: 1_000,
        status: "passed" as const,
        exit_code: 0 as const,
        signal: null,
        stdout: "green",
        stderr: "",
        output_truncated: false,
      },
    ];
    const priorReviewSubject = {
      source: "execute" as const,
      execute_mission_content_sha256: "1".repeat(64),
      execute_result_content_sha256: "2".repeat(64),
      git_base_commit: "a".repeat(40),
      accepted_result_commit: "a".repeat(40),
      changed_files: ["src/domain/result.ts"],
      execute_mission_path: `.founder/missions/${firstId}/execute-1-1-0/mission.json`,
      execute_evidence_path: `.founder/run-evidence/${firstId}/execute-1-1-0/${"3".repeat(64)}`,
      command_evidence: commandEvidence,
    };
    const patchSubject: PatchSubject = {
      review_mission_content_sha256: "4".repeat(64),
      review_result_content_sha256: "5".repeat(64),
      review_mission_path: `.founder/missions/${firstId}/review-1-1-0/mission.json`,
      review_result_path: `.founder/missions/${firstId}/review-1-1-0/result.json`,
      review_evidence_path: `.founder/run-evidence/${firstId}/review-1-1-0/${"6".repeat(64)}`,
      reviewed_commit: "a".repeat(40),
      findings: [
        {
          finding_id: "F-1",
          severity: "P1",
          title: "Preserve immutable evidence",
          evidence: { summary: "The patch requires durable proof." },
          required_action: "Keep evidence immutable before state mutation.",
          link: {
            type: "defect",
            evidence_summary: "The controller owns durable mutation.",
          },
        },
      ],
      prior_review_subject: priorReviewSubject,
    };
    const patchIdentity = {
      phase: "patch" as const,
      work_item_id: firstId,
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
      patch_cycle: 1,
    };
    const patchArtifact = await workspace.writePatchMissionPackage(
      patchIdentity,
      patchSubject,
      (paths) =>
        compilePatchMission({
          work_item: patchItem,
          controller_run: {
            schema_version: 1,
            run_id: secondRunId,
            work_item_id: firstId,
            idempotency_key: `${firstId}:patch:1:1:0:1:mission`,
            phase: "patch",
            goal_version: 1,
            input_revision: 1,
            attempt: 0,
            started_at: "2026-07-22T12:00:00.000Z",
            completed_at: "2026-07-22T12:00:01.000Z",
            outcome: "applied",
          },
          patch_subject: patchSubject,
          paths,
        }),
    );
    expect(patchArtifact.mission_path).toContain("patch-1-1-0-1");

    const submissionSource = serializeExternalResult({
      result_schema_version: 2,
      patch_mission_content_sha256: patchArtifact.mission.content_sha256,
      identity: patchIdentity,
      commit: "a".repeat(40),
      summary: "Applied the bounded patch.",
      changed_files: ["src/domain/result.ts"],
      verification: [{ name: "Tests", status: "passed" }],
    });
    await writeFile(
      join(root, patchArtifact.mission.result_contract.output_path),
      submissionSource,
    );
    const resultContentSha256 = hashResultContent(submissionSource);
    const importRunId = createImportRunId(
      patchArtifact.mission.content_sha256,
      resultContentSha256,
    );
    const evidence = {
      schema_version: 2 as const,
      phase: "patch" as const,
      import_run_id: importRunId,
      result_content_sha256: resultContentSha256,
      mission_content_sha256: patchArtifact.mission.content_sha256,
      identity: patchIdentity,
      git_base_commit: "a".repeat(40),
      result_commit: "a".repeat(40),
      controller_run_id: thirdRunId,
      started_at: "2026-07-22T12:00:01.000Z",
      completed_at: "2026-07-22T12:00:02.000Z",
      outcome: "applied" as const,
      reasons: [],
    };
    const evidenceSummary = await workspace.writeImportEvidence({
      submission_source: submissionSource,
      evidence,
      verification: commandEvidence,
    });
    expect(evidenceSummary.evidence_path).toContain("patch-1-1-0-1");
    await writeRunManifest(root, {
      schema_version: 1,
      run_id: thirdRunId,
      work_item_id: firstId,
      idempotency_key: `${firstId}:patch:1:1:0:1:import`,
      phase: "review",
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
      started_at: evidence.started_at,
      completed_at: evidence.completed_at,
      outcome: "applied",
    });
    await writeMissionReadyWorkItem(root, firstId, "review", 1);

    const appliedSubject = await workspace.readAppliedPatchReviewSubject(
      patchIdentity,
    );
    expect(appliedSubject.review_subject).toMatchObject({
      source: "patch",
      patch_cycle: 1,
      patch_mission_path: `.founder/missions/${firstId}/patch-1-1-0-1/mission.json`,
      patch_evidence_path: evidenceSummary.evidence_path,
      resolved_from: { finding_ids: ["F-1"] },
    });
    expect(appliedSubject.submission_source).toBe(submissionSource);

    const reviewItem = await workspace.read(firstId);
    if (reviewItem === null) {
      throw new Error("Expected patch review work item");
    }
    const reviewIdentity = { ...missionIdentity(), phase: "review" as const };
    const reviewArtifact = await workspace.writeReviewMissionPackage(
      reviewIdentity,
      appliedSubject.review_subject,
      (paths) =>
        compileReviewMission({
          work_item: reviewItem,
          controller_run: {
            schema_version: 1,
            run_id: firstRunId,
            work_item_id: firstId,
            idempotency_key: `${firstId}:review:1:1:0:patch:1`,
            phase: "review",
            goal_version: 1,
            input_revision: 1,
            attempt: 0,
            started_at: "2026-07-22T12:00:02.000Z",
            completed_at: "2026-07-22T12:00:03.000Z",
            outcome: "applied",
          },
          review_subject: appliedSubject.review_subject,
          paths,
          independence_attested: true,
        }),
    );
    expect(reviewArtifact.mission_path).toContain("review-1-1-0-patch-1");
    await writeFile(
      join(root, reviewArtifact.mission.result_contract.output_path),
      "{}\n",
    );
    expect((await workspace.readMissionResult(reviewIdentity, 1)).mission).toEqual(
      reviewArtifact.mission,
    );
    expect(
      (await workspace.listImportEvidence(firstId)).map(
        (stored) => stored.evidence.identity,
      ),
    ).toContainEqual(patchIdentity);
  });

  it("rejects an applied execute subject whose evidence names a different command", async () => {
    const root = await createWorkspace();
    const executeItem = await writeMissionReadyWorkItem(root, firstId);
    const workspace = missionWorkspace(root);
    const artifact = await workspace.writeMissionPackage(
      missionIdentity(),
      (paths) =>
        compileMission(executeItem, appliedExecuteManifest(), paths),
    );
    const submissionSource = serializeExternalResult({
      result_schema_version: 2,
      mission_content_sha256: artifact.mission.content_sha256,
      identity: missionIdentity(),
      commit: "a".repeat(40),
      summary: "Accepted result with divergent command evidence.",
      changed_files: ["src/domain/result.ts"],
      verification: [{ name: "Tests", status: "passed" }],
    });
    const resultHash = hashResultContent(submissionSource);
    await workspace.writeImportEvidence({
      submission_source: submissionSource,
      evidence: {
        schema_version: 2,
        phase: "execute",
        import_run_id: createImportRunId(
          artifact.mission.content_sha256,
          resultHash,
        ),
        result_content_sha256: resultHash,
        mission_content_sha256: artifact.mission.content_sha256,
        identity: missionIdentity(),
        git_base_commit: artifact.mission.source_revision.git_base_commit,
        result_commit: "a".repeat(40),
        controller_run_id: thirdRunId,
        started_at: "2026-07-22T12:00:00.000Z",
        completed_at: "2026-07-22T12:00:01.000Z",
        outcome: "applied",
        reasons: [],
      },
      verification: [
        {
          name: "Different command",
          argv: ["npm", "run", "different"],
          started_at: "2026-07-22T12:00:00.000Z",
          completed_at: "2026-07-22T12:00:01.000Z",
          duration_ms: 1_000,
          status: "passed",
          exit_code: 0,
          signal: null,
          stdout: "green",
          stderr: "",
          output_truncated: false,
        },
      ],
    });
    await writeRunManifest(root, {
      ...appliedExecuteManifest(thirdRunId),
      phase: "review",
    });

    await expect(
      workspace.readAppliedExecuteReviewSubject(missionIdentity()),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
  });

  it("stores applied review evidence without command results", async () => {
    const root = await createWorkspace();
    const workspace = missionWorkspace(root);
    const identity = { ...missionIdentity(), phase: "review" as const };
    const submissionSource = '{"verdict":"clean"}\n';
    const resultHash = hashResultContent(submissionSource);
    const evidence = {
      schema_version: 2 as const,
      phase: "review" as const,
      import_run_id: createImportRunId("f".repeat(64), resultHash),
      result_content_sha256: resultHash,
      mission_content_sha256: "f".repeat(64),
      identity,
      git_base_commit: "a".repeat(40),
      result_commit: "a".repeat(40),
      controller_run_id: thirdRunId,
      started_at: "2026-07-22T12:00:00.000Z",
      completed_at: "2026-07-22T12:00:01.000Z",
      outcome: "applied" as const,
      reasons: [],
    };

    const input = {
      submission_source: submissionSource,
      evidence,
      verification: [],
    };
    const summary = await workspace.writeImportEvidence(input);
    expect(await workspace.writeImportEvidence(input)).toEqual(summary);
    expect(summary.phase).toBe("review");
    expect(await workspace.readImportEvidence(identity, evidence.import_run_id))
      .toMatchObject({ evidence, verification: [] });
    await expect(
      workspace.writeImportEvidence({
        submission_source: submissionSource,
        evidence,
        verification: [
          {
            name: "Tests",
            argv: ["npm", "test"],
            started_at: "2026-07-22T12:00:00.000Z",
            completed_at: "2026-07-22T12:00:01.000Z",
            duration_ms: 1_000,
            status: "passed",
            exit_code: 0,
            signal: null,
            stdout: "green",
            stderr: "",
            output_truncated: false,
          },
        ],
      }),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });

    const evidenceDirectory = join(root, summary.evidence_path);
    await writeFile(
      join(evidenceDirectory, "import.json"),
      `${JSON.stringify({ ...evidence, phase: "execute" }, null, 2)}\n`,
      "utf8",
    );
    await expect(
      workspace.readImportEvidence(identity, evidence.import_run_id),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });

    await writeFile(
      join(evidenceDirectory, "import.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      "utf8",
    );
    const outsideSubmission = join(root, "outside-review-submission.json");
    await writeFile(outsideSubmission, submissionSource, "utf8");
    await rm(join(evidenceDirectory, "submission.json"));
    await symlink(
      outsideSubmission,
      join(evidenceDirectory, "submission.json"),
      "file",
    );
    await expect(
      workspace.readImportEvidence(identity, evidence.import_run_id),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
  });

  it("lists immutable import evidence newest-first across governed identities", async () => {
    const root = await createWorkspace();
    const workspace = missionWorkspace(root);
    const oldest = await writeRejectedEvidence(
      workspace,
      missionIdentity(),
      '{"result":"oldest"}\n',
      "2026-07-22T13:00:00.000Z",
    );
    const tiedFirst = await writeRejectedEvidence(
      workspace,
      missionIdentity(firstId, { input_revision: 2, attempt: 1 }),
      '{"result":"tied-first"}\n',
      "2026-07-22T14:00:00.000Z",
    );
    const tiedSecond = await writeRejectedEvidence(
      workspace,
      missionIdentity(),
      '{"result":"tied-second"}\n',
      "2026-07-22T14:00:00.000Z",
    );

    const tiedRunIds = [tiedFirst.import_run_id, tiedSecond.import_run_id].sort(
      (left, right) => right.localeCompare(left),
    );
    const listed = await workspace.listImportEvidence(firstId);

    expect(listed.map(({ evidence }) => evidence.import_run_id)).toEqual([
      ...tiedRunIds,
      oldest.import_run_id,
    ]);
    expect(listed.map(({ evidence }) => evidence.identity)).toContainEqual(
      missionIdentity(firstId, { input_revision: 2, attempt: 1 }),
    );
    expect(await workspace.listImportEvidence(secondId)).toEqual([]);
  });

  it("fails closed when listed import evidence is unsafe or divergent", async () => {
    const symlinkRoot = await createWorkspace();
    const outsideRoot = await createWorkspace();
    const symlinkTuple = join(
      symlinkRoot,
      ".founder",
      "run-evidence",
      firstId,
      "execute-1-1-0",
    );
    await mkdir(symlinkTuple, { recursive: true });
    await symlink(outsideRoot, join(symlinkTuple, "c".repeat(64)), "dir");
    await expect(
      missionWorkspace(symlinkRoot).listImportEvidence(firstId),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });

    const malformedTupleRoot = await createWorkspace();
    await mkdir(
      join(
        malformedTupleRoot,
        ".founder",
        "run-evidence",
        firstId,
        "bad-tuple",
      ),
      { recursive: true },
    );
    await expect(
      missionWorkspace(malformedTupleRoot).listImportEvidence(firstId),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });

    const malformedRunRoot = await createWorkspace();
    await mkdir(
      join(
        malformedRunRoot,
        ".founder",
        "run-evidence",
        firstId,
        "execute-1-1-0",
        "bad-run-id",
      ),
      { recursive: true },
    );
    await expect(
      missionWorkspace(malformedRunRoot).listImportEvidence(firstId),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });

    const partialRoot = await createWorkspace();
    const partialWorkspace = missionWorkspace(partialRoot);
    const partial = await writeRejectedEvidence(
      partialWorkspace,
      missionIdentity(),
      '{"result":"partial"}\n',
      "2026-07-22T15:00:00.000Z",
    );
    const partialDirectory = join(
      partialRoot,
      ".founder",
      "run-evidence",
      firstId,
      "execute-1-1-0",
      partial.import_run_id,
    );
    await rm(join(partialDirectory, "verification.json"));
    await expect(
      partialWorkspace.listImportEvidence(firstId),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });

    const divergentRoot = await createWorkspace();
    const divergentWorkspace = missionWorkspace(divergentRoot);
    const divergent = await writeRejectedEvidence(
      divergentWorkspace,
      missionIdentity(),
      '{"result":"divergent"}\n',
      "2026-07-22T16:00:00.000Z",
    );
    const divergentDirectory = join(
      divergentRoot,
      ".founder",
      "run-evidence",
      firstId,
      "execute-1-1-0",
      divergent.import_run_id,
    );
    await writeFile(
      join(divergentDirectory, "import.json"),
      `${JSON.stringify(
        {
          ...divergent,
          identity: missionIdentity(firstId, { attempt: 1 }),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await expect(
      divergentWorkspace.listImportEvidence(firstId),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
  });

  it("fails closed for partial, malformed, or divergent mission snapshots", async () => {
    const partialRoot = await createWorkspace();
    const partialItem = await writeMissionReadyWorkItem(partialRoot, firstId);
    const partialDirectory = join(
      partialRoot,
      ".founder",
      "missions",
      firstId,
      "execute-1-1-0",
    );
    await mkdir(partialDirectory, { recursive: true });
    await writeFile(join(partialDirectory, "mission.json"), "{}\n", "utf8");
    await expect(
      missionWorkspace(partialRoot).writeMissionPackage(
        missionIdentity(),
        (paths) => compileMission(partialItem, appliedExecuteManifest(), paths),
      ),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
    expect(await readdir(partialDirectory)).toEqual(["mission.json"]);

    const malformedRoot = await createWorkspace();
    const malformedItem = await writeMissionReadyWorkItem(malformedRoot, firstId);
    const malformedDirectory = join(
      malformedRoot,
      ".founder",
      "missions",
      firstId,
      "execute-1-1-0",
    );
    await mkdir(malformedDirectory, { recursive: true });
    await writeFile(
      join(malformedDirectory, "mission.json"),
      "{invalid",
      "utf8",
    );
    await writeFile(join(malformedDirectory, "TASK.md"), "Invalid\n", "utf8");
    await expect(
      missionWorkspace(malformedRoot).writeMissionPackage(
        missionIdentity(),
        (paths) =>
          compileMission(malformedItem, appliedExecuteManifest(), paths),
      ),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });

    const divergentRoot = await createWorkspace();
    const divergentItem = await writeMissionReadyWorkItem(divergentRoot, firstId);
    const divergentWorkspace = missionWorkspace(divergentRoot);
    const first = await divergentWorkspace.writeMissionPackage(
      missionIdentity(),
      (paths) =>
        compileMission(divergentItem, appliedExecuteManifest(), paths),
    );
    await writeFile(first.task_path, "Divergent task\n", "utf8");
    await expect(
      divergentWorkspace.writeMissionPackage(missionIdentity(), (paths) =>
        compileMission(divergentItem, appliedExecuteManifest(), paths),
      ),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
    expect(await readFile(first.task_path, "utf8")).toBe("Divergent task\n");
  });

  it("rejects a symlinked missions directory without writing outside", async () => {
    const root = await createWorkspace();
    const outsideRoot = await createWorkspace();
    const item = await writeMissionReadyWorkItem(root, firstId);
    await symlink(
      outsideRoot,
      join(root, ".founder", "missions"),
      "dir",
    );

    await expect(
      missionWorkspace(root).writeMissionPackage(
        missionIdentity(),
        (paths) => compileMission(item, appliedExecuteManifest(), paths),
      ),
    ).rejects.toMatchObject({
      kind: "invalid_workspace",
      artifactPath: ".founder/missions",
    });
    expect(await readdir(outsideRoot)).toEqual([".founder"]);
  });

  it("compensates a mid-write failure and leaves an inspectable failed manifest", async () => {
    const root = await createWorkspace();
    await writeContractedWorkItem(root, firstId);
    const workspace = new FailingControllerWorkspace(root);
    const before = await workspace.read(firstId);
    if (before === null) {
      throw new Error("Expected contracted work item");
    }
    const run = activeRun(
      firstRunId,
      `${firstId}:spec:2:2:0`,
    );
    const lease = await workspace.acquireControllerLease(firstId, run);
    if (lease === null) {
      throw new Error("Expected controller lease");
    }

    await expect(
      workspace.commitControllerMutation(
        lease,
        controllerMutation(lease.work_item, run, {
          goalVersion: 2,
          inputRevision: 2,
        }),
      ),
    ).rejects.toThrow("injected controller state write failure");

    expect(await workspace.read(firstId)).toEqual(before);
    expect(await workspace.readControllerRunManifest(firstId, run.run_id)).toMatchObject({
      run_id: run.run_id,
      outcome: "failed",
    });
    const entries = await readdir(
      join(root, ".founder", "work-items", firstId),
    );
    expect(entries).not.toContain(".controller.lock");
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("refuses a publish collision without overwriting either artifact", async () => {
    const sourceRoot = await createWorkspace();
    const targetRoot = await createWorkspace();
    await writeWorkItem(sourceRoot, firstId, "2026-07-17T12:00:00.000Z");
    const source = new ProductWorkspace(sourceRoot);
    const target = new ProductWorkspace(targetRoot);
    const item = await source.read(firstId);
    if (item === null) {
      throw new Error("Expected source fixture item");
    }

    const stagingPath = await target.stageIncomingWorkItem(item);
    await writeWorkItem(targetRoot, firstId, "2026-07-21T12:00:00.000Z");
    const targetBefore = await target.read(firstId);

    await expect(
      target.publishStagedWorkItem(firstId, stagingPath),
    ).rejects.toMatchObject({
      kind: "invalid_workspace",
      reason: "target work-item already exists",
    });
    expect(await target.read(firstId)).toEqual(targetBefore);
    expect(await source.read(firstId)).toEqual(item);

    await target.discardStagedWorkItem(firstId, stagingPath);
    await target.discardStagedWorkItem(firstId, stagingPath);
    expect(await target.list()).toEqual([targetBefore]);
  });

  it("rejects an invalid existing item without changing state", async () => {
    const root = await createWorkspace();
    await writeWorkItem(root, firstId, "2026-07-17T12:00:00.000Z");
    const workspace = new ProductWorkspace(root);
    const itemDirectory = join(root, ".founder", "work-items", firstId);
    const goalPath = join(itemDirectory, "goal.yaml");
    const statePath = join(itemDirectory, "state.json");
    const goal = parse(await readFile(goalPath, "utf8"));
    const stateBefore = await readFile(statePath, "utf8");
    await writeFile(
      goalPath,
      stringify({ ...goal, work_item_id: secondId }),
      "utf8",
    );

    await expect(
      workspace.updatePhase(firstId, { target_phase: "spec" }),
    ).rejects.toBeInstanceOf(InvalidWorkspaceError);
    expect(await readFile(statePath, "utf8")).toBe(stateBefore);
  });

  it("surfaces malformed YAML and JSON as artifact-relative errors", async () => {
    const root = await createWorkspace();
    await writeWorkItem(root, firstId, "2026-07-17T12:00:00.000Z");
    const workspace = new ProductWorkspace(root);
    const directory = join(root, ".founder", "work-items", firstId);

    await writeFile(join(directory, "goal.yaml"), "title: [unterminated\n", "utf8");
    await expect(workspace.read(firstId)).rejects.toMatchObject({
      kind: "invalid_workspace",
      artifactPath: `.founder/work-items/${firstId}/goal.yaml`,
    });

    await writeWorkItem(root, firstId, "2026-07-17T12:00:00.000Z");
    await writeFile(join(directory, "state.json"), "{invalid", "utf8");
    await expect(workspace.read(firstId)).rejects.toMatchObject({
      kind: "invalid_workspace",
      artifactPath: `.founder/work-items/${firstId}/state.json`,
    });
  });

  it("fails closed with durable paths for partial and cross-file-mismatched contracts", async () => {
    const root = await createWorkspace();
    await writeWorkItem(root, firstId, "2026-07-17T12:00:00.000Z");
    const workspace = new ProductWorkspace(root);
    const itemDirectory = join(root, ".founder", "work-items", firstId);
    const goalPath = join(itemDirectory, "goal.yaml");
    const originalGoal = parse(await readFile(goalPath, "utf8"));

    await writeFile(
      goalPath,
      stringify({
        ...originalGoal,
        goal_contract: {
          schema_version: 1,
          goal_version: 1,
          purpose: "Keep workspace contracts strict.",
          non_goals: ["Do not infer missing state."],
          allowed_scope: ["src/domain"],
          review_ready: ["Checks pass"],
        },
      }),
      "utf8",
    );
    await expect(workspace.read(firstId)).rejects.toMatchObject({
      kind: "invalid_workspace",
      artifactPath: `.founder/work-items/${firstId}/goal.yaml`,
      reason: expect.stringContaining(
        "goal_contract.acceptance_criteria",
      ),
    });

    await writeFile(
      goalPath,
      stringify({
        ...originalGoal,
        goal_contract: {
          schema_version: 1,
          goal_version: 1,
          purpose: "Keep workspace contracts strict.",
          acceptance_criteria: ["Reject stale state"],
          non_goals: ["Do not infer missing state."],
          allowed_scope: ["src/domain"],
          review_ready: ["Checks pass"],
        },
      }),
      "utf8",
    );
    await expect(workspace.read(firstId)).rejects.toMatchObject({
      kind: "invalid_workspace",
      artifactPath: `.founder/work-items/${firstId}`,
      reason: expect.stringContaining(
        "state.goal_version: state goal_version must match goal contract goal_version",
      ),
    });
  });

  it("fails closed on mismatched IDs and partial directories", async () => {
    const root = await createWorkspace();
    await writeWorkItem(root, firstId, "2026-07-17T12:00:00.000Z");
    const workspace = new ProductWorkspace(root);
    const statePath = join(
      root,
      ".founder",
      "work-items",
      firstId,
      "state.json",
    );
    const state = JSON.parse(await readFile(statePath, "utf8"));
    await writeFile(
      statePath,
      `${JSON.stringify({ ...state, work_item_id: secondId }, null, 2)}\n`,
      "utf8",
    );

    await expect(workspace.read(firstId)).rejects.toBeInstanceOf(
      InvalidWorkspaceError,
    );

    const partialRoot = await createWorkspace();
    const partialDirectory = join(
      partialRoot,
      ".founder",
      "work-items",
      firstId,
    );
    await mkdir(partialDirectory, { recursive: true });
    await writeFile(
      join(partialDirectory, "goal.yaml"),
      stringify({
        schema_version: 1,
        work_item_id: firstId,
        title: "Partial item",
        type: "Fix",
      }),
      "utf8",
    );

    await expect(new ProductWorkspace(partialRoot).list()).rejects.toMatchObject({
      kind: "invalid_workspace",
      artifactPath: `.founder/work-items/${firstId}/state.json`,
    });
  });

  it("rejects unsafe IDs before reading outside the workspace", async () => {
    const root = await createWorkspace();
    const workspace = new ProductWorkspace(root);

    await expect(workspace.read("../../outside")).rejects.toThrow(
      "work_item_id must use the wi_<uuid> format",
    );
  });

  it("rejects a work-items symlink that escapes the workspace root", async () => {
    const root = await createWorkspace();
    const outsideRoot = await createWorkspace();
    await symlink(
      join(outsideRoot, ".founder", "work-items"),
      join(root, ".founder", "work-items"),
      "dir",
    );

    await expect(new ProductWorkspace(root).list()).rejects.toMatchObject({
      kind: "invalid_workspace",
      artifactPath: ".founder/work-items",
    });
  });

  it("validates the product manifest before workspace operations", async () => {
    const root = await createWorkspace();
    await writeFile(
      join(root, ".founder", "product.yaml"),
      "schema_version: 1\nproduct_name: Legacy Workspace\n",
      "utf8",
    );

    await expect(new ProductWorkspace(root).list()).rejects.toMatchObject({
      kind: "invalid_workspace",
      artifactPath: ".founder/product.yaml",
    });
  });
});
