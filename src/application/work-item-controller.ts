import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";
import { parse as parseYaml } from "yaml";

import {
  MISSION_SCHEMA_VERSION,
  reviewSubjectSchema,
  type MissionIdentity,
  type MissionPhase,
  type ReadableMissionPackage,
  type ReviewSubject,
} from "../domain/mission";
import {
  capabilityRequestMatchesEnvelope,
  executionDefaultsFromCapabilityEnvelope,
  extendExecutionDefaultsWithRequest,
} from "../domain/capability-envelope";
import {
  connectedRunRecordV2Schema,
  connectedRunLaunchFingerprint,
  launchConnectedInputSchema,
  type ConnectedRunRecordV2,
  type LaunchConnectedInput,
} from "../domain/connected-run";
import {
  commandEvidenceRecordSchema,
  createImportRunId,
  executeExternalResultSubmissionSchema,
  hashResultContent,
  importEvidenceEnvelopeSchema,
  patchExternalResultSubmissionSchema,
  reviewExternalResultSubmissionForSubjectSchema,
  type CommandEvidenceRecord,
  type ActiveMissionResultSnapshot,
  type ExecuteExternalResultSubmission,
  type ImportEvidenceOutcome,
  type ImportEvidenceSummary,
  type MissionResultSnapshot,
  type PatchExternalResultSubmission,
  type ReviewExternalResultSubmission,
  type StoredImportEvidence,
} from "../domain/result";
import type {
  GitVerificationAdapter,
  VerificationRunner,
} from "../domain/verification";
import {
  brainstormResultSubmissionSchema,
  compileBrainstormMission,
  compilePlanMission,
  compileSpecMission,
  deriveShapingDecisionId,
  goalContractFromSpecProposal,
  hashGoalContract,
  hashGoalInput,
  hashShapingDecisionState,
  isShapingPhase,
  normalizeShapingGoalInput,
  planResultSubmissionSchema,
  serializeShapingPackage,
  shapingDecisionReceiptSchema,
  shapingMissionPackageSchema,
  specResultSubmissionSchema,
  type PlanApprovalReceipt,
  type ShapingDecisionIntentV1,
  type ShapingDecisionManifestV1,
  type ShapingDecisionOperation,
  type ShapingDecisionReceipt,
  type ShapingDecisionState,
  type BrainstormMissionPackage,
  type PlanMissionPackage,
  type ShapingIdentity,
  type ShapingMissionPackage,
  type ShapingPhase,
  type ShapingReceiptWriteResult,
  type SpecMissionPackage,
  type StoredShapingArtifact,
} from "../domain/shaping";
import {
  shapingRunLaunchFingerprint,
  type ShapingRunRecordV1,
} from "../domain/shaping-run";
import {
  ControllerConflictError,
  InvalidWorkspaceError,
  acceptPatchPlanInputSchema,
  approvePlanResultInputSchema,
  applyScopeCorrectionInputSchema,
  createControllerCapabilityGrant,
  controllerRunManifestSchema,
  controllerTransitionInputSchema,
  commandAuthorizationDecisionInputSchema,
  commandAuthorizationProposalSchema,
  connectedPermissionResolutionInputSchema,
  importExternalResultInputSchema,
  importPatchResultInputSchema,
  importReviewResultInputSchema,
  retryExecuteAttemptInputSchema,
  recordConnectedPermissionDenialInputSchema,
  saveWorkItemInputSchema,
  hashScopeCorrectionProposal,
  hashCommandAuthorizationProposal,
  scopeCorrectionProposalSchema,
  deriveControllerRunId,
  derivePlanApprovalId,
  parseWorkItemStateForRead,
  workItemIdSchema,
  workItemGoalSchema,
  workItemSchema,
  workItemStateSchema,
  type ActiveRun,
  type AcceptPatchPlanInput,
  type ApprovePlanResultInput,
  type ApplyScopeCorrectionInput,
  type ControllerLease,
  type ControllerCapabilityGrant,
  type CommandAuthorizationDecisionInput,
  type CommandAuthorizationProposalV1,
  type ControllerMutationResult,
  type ControllerRunManifest,
  type ControllerTransitionInput,
  type ControllerWorkItemRepository,
  type ImportExternalResultInput,
  type ImportPatchResultInput,
  type ImportReviewResultInput,
  type ProductManifest,
  type ConnectedPermissionResolutionInput,
  type MissingPermissionOperation,
  type PlanApprovalIntentV1,
  type PlanApprovalManifestV1,
  type RecordConnectedPermissionDenialInput,
  type RetryExecuteAttemptInput,
  type SaveWorkItemInput,
  type ScopeCorrectionProposalV1,
  type WorkItem,
  type WorkItemAttention,
  type WorkItemPhase,
  type WorkItemStatus,
} from "../domain/work-item";
import {
  canUpdateGoalContract,
  dedicatedTransitionPolicy,
  validateWorkItemTransition,
} from "../domain/workflow-policy";
import {
  scopeMatchesPath,
  workspaceRelativePosixPathSchema,
} from "../domain/workspace-path";

type Clock = () => Date;

const SHA256_SCHEMA = z.string().regex(/^[0-9a-f]{64}$/u);
const nonEmptyTrimmedStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be empty")
  .refine(
    (value) => value === value.trim(),
    "must not have leading or trailing whitespace",
  );

function shellLiteralPathPattern(path: string): string {
  return Array.from(path, (character) => {
    if (character === "[") {
      return "[[]";
    }
    if (character === "]") {
      return "[]]";
    }
    return character;
  }).join("");
}

const shapingLaunchInputShape = {
  launch_mode: z.enum(["connected", "manual"]),
  next_requested_model: nonEmptyTrimmedStringSchema.nullable(),
};

function validateShapingLaunchInput(
  input: { launch_mode: "connected" | "manual"; next_requested_model: string | null },
  context: z.RefinementCtx,
): void {
  const connected = input.launch_mode === "connected";
  if (connected !== (input.next_requested_model !== null)) {
    context.addIssue({
      code: "custom",
      message:
        "connected launch mode requires one model and manual launch mode forbids it",
      path: ["next_requested_model"],
      input: input.next_requested_model,
    });
  }
}

const startBrainstormDecisionInputSchema = z
  .strictObject({
    ...shapingLaunchInputShape,
    expected_mission_content_sha256: z.null(),
    expected_result_content_sha256: z.null(),
    expected_shaping_state_sha256: SHA256_SCHEMA,
  })
  .superRefine(validateShapingLaunchInput);

const shapingResultDecisionInputSchema = z
  .strictObject({
    ...shapingLaunchInputShape,
    expected_mission_content_sha256: SHA256_SCHEMA,
    expected_result_content_sha256: SHA256_SCHEMA,
    expected_shaping_state_sha256: SHA256_SCHEMA,
  })
  .superRefine(validateShapingLaunchInput);

const requestShapingChangesInputSchema = z
  .strictObject({
    ...shapingLaunchInputShape,
    expected_mission_content_sha256: SHA256_SCHEMA,
    expected_result_content_sha256: SHA256_SCHEMA,
    expected_shaping_state_sha256: SHA256_SCHEMA,
    feedback: nonEmptyTrimmedStringSchema,
  })
  .superRefine(validateShapingLaunchInput);

const approveSpecDecisionInputSchema = z
  .strictObject({
    ...shapingLaunchInputShape,
    expected_mission_content_sha256: SHA256_SCHEMA,
    expected_result_content_sha256: SHA256_SCHEMA,
    expected_shaping_state_sha256: SHA256_SCHEMA,
    goal_contract_sha256: SHA256_SCHEMA,
  })
  .superRefine(validateShapingLaunchInput);

const replanWithUpdatedContractInputSchema = z
  .strictObject({
    ...shapingLaunchInputShape,
    expected_mission_content_sha256: SHA256_SCHEMA,
    expected_result_content_sha256: SHA256_SCHEMA,
    expected_shaping_state_sha256: SHA256_SCHEMA,
    goal_contract_sha256: SHA256_SCHEMA,
  })
  .superRefine(validateShapingLaunchInput);

export type StartBrainstormDecisionInput = z.input<
  typeof startBrainstormDecisionInputSchema
>;
export type ShapingResultDecisionInput = z.input<
  typeof shapingResultDecisionInputSchema
>;
export type RequestShapingChangesInput = z.input<
  typeof requestShapingChangesInputSchema
>;
export type ApproveSpecDecisionInput = z.input<
  typeof approveSpecDecisionInputSchema
>;
export type ReplanWithUpdatedContractInput = z.input<
  typeof replanWithUpdatedContractInputSchema
>;

export interface ShapingDecisionControllerResult {
  work_item: WorkItem;
  manifest: ShapingDecisionManifestV1;
  intent: ShapingDecisionIntentV1;
  decision_id: string;
  launch_mode: "connected" | "manual";
  next_requested_model: string | null;
  launch_fingerprint: string | null;
  next_mission: {
    identity: ShapingIdentity;
    content_sha256: string;
  };
  next_launch:
    | {
        status: "manual";
        shaping_run_id: null;
        reason: "founder_selected_manual";
      }
    | null;
}

export interface PlanApprovalControllerResult {
  work_item: WorkItem;
  manifest: PlanApprovalManifestV1;
  intent: PlanApprovalIntentV1;
  approval_id: string;
  launch_mode: "connected" | "manual";
  requested_model: string | null;
  execute_tuple: PlanApprovalReceipt["execute_tuple"];
}

interface ShapingDecisionRepository extends ControllerWorkItemRepository {
  listShapingArtifacts(workItemId: string): Promise<StoredShapingArtifact[]>;
  listShapingRuns(workItemId: string): Promise<ShapingRunRecordV1[]>;
  writeShapingDecisionReceipt<TReceipt extends ShapingDecisionReceipt>(
    receipt: TReceipt,
  ): Promise<ShapingReceiptWriteResult<TReceipt>>;
}

interface ShapingDecisionBinding {
  operation: ShapingDecisionOperation;
  work_item_id: string;
  goal_input_sha256: string;
  mission_content_sha256: string | null;
  result_content_sha256: string | null;
  feedback_sha256: string | null;
  expected_shaping_state_sha256: string;
  launch_mode: "connected" | "manual";
  next_requested_model: string | null;
}

interface PlanApprovalBinding {
  work_item_id: string;
  launch_mode: "connected" | "manual";
  requested_model: string | null;
  expected_mission_content_sha256: string;
  expected_result_content_sha256: string;
  expected_shaping_state_sha256: string;
  goal_contract_sha256: string;
  goal_version: number;
}

interface PreparedShapingDecision {
  phase_from: "idea" | ShapingPhase;
  phase_to: ShapingPhase;
  next_goal?: WorkItem["goal"];
  next_state: WorkItem["state"];
  next_mission: ShapingMissionPackage;
  decision_receipt: ShapingDecisionReceipt | null;
  plan_repository_base_commit: string | null;
  plan_goal_contract_sha256: string | null;
  plan_goal_version: number | null;
}

interface PreparedPlanApproval {
  next_state: WorkItem["state"];
  receipt: PlanApprovalReceipt;
}

export interface ImportExternalResultResult extends ControllerMutationResult {
  evidence: ImportEvidenceSummary;
}

export interface ImportReviewResultResult {
  work_item: WorkItem;
  manifest: ControllerRunManifest | null;
  evidence: ImportEvidenceSummary;
  result?: ReviewExternalResultSubmission;
}

export interface ImportPatchResultResult {
  work_item: WorkItem;
  manifest: ControllerRunManifest | null;
  evidence: ImportEvidenceSummary;
  result?: PatchExternalResultSubmission;
}

export interface ConnectedLaunchResult extends ControllerMutationResult {
  connected_run: ConnectedRunRecordV2;
  created: boolean;
}

export interface ScopeCorrectionControllerResult extends ControllerMutationResult {
  proposal: ScopeCorrectionProposalV1;
}

export interface CommandAuthorizationControllerResult {
  work_item: WorkItem;
  manifest: ControllerRunManifest | null;
  proposal: CommandAuthorizationProposalV1;
}

export interface ConnectedPermissionDecisionResult {
  work_item: WorkItem;
  manifest: ControllerRunManifest | null;
}

interface ExecuteExpectation {
  expected_phase: "execute";
  expected_status: WorkItemStatus;
  expected_schema_version: 2;
  expected_goal_version: number;
  expected_input_revision: number;
  attempt: number;
}

interface ConnectedExpectation {
  expected_phase: MissionPhase;
  expected_status: WorkItemStatus;
  expected_schema_version: 2;
  expected_goal_version: number;
  expected_input_revision: number;
  attempt: number;
}

interface ExternalResultAssessment {
  outcome: ImportEvidenceOutcome;
  reasons: string[];
  result?: ExecuteExternalResultSubmission;
  verification: CommandEvidenceRecord[];
}

interface ReviewResultAssessment {
  outcome: "rejected" | "applied";
  reasons: string[];
  result?: ReviewExternalResultSubmission;
}

interface PatchResultAssessment {
  outcome: "rejected" | "applied";
  reasons: string[];
  result?: PatchExternalResultSubmission;
  verification: CommandEvidenceRecord[];
}

export function deriveControllerIdempotencyKey(
  workItemId: string,
  targetPhase: WorkItemPhase,
  goalVersion: number,
  inputRevision: number,
  attempt: number,
): string {
  return [
    workItemId,
    targetPhase,
    goalVersion,
    inputRevision,
    attempt,
  ].join(":");
}

function nextTimestamp(currentTimestamp: string, clock: Clock): string {
  return new Date(
    Math.max(clock().getTime(), Date.parse(currentTimestamp) + 1),
  ).toISOString();
}

function withoutAttention(state: WorkItem["state"]): WorkItem["state"] {
  const nextState = { ...state };
  delete nextState.attention;
  return nextState;
}

function manifestMatches(
  manifest: ControllerRunManifest,
  input: {
    work_item_id: string;
    run_id: string;
    idempotency_key: string;
    phase: WorkItemPhase;
    goal_version: number;
    input_revision: number;
    attempt: number;
    capability_grant?: ControllerCapabilityGrant;
  },
): boolean {
  return (
    manifest.outcome === "applied" &&
    manifest.work_item_id === input.work_item_id &&
    manifest.run_id === input.run_id &&
    manifest.idempotency_key === input.idempotency_key &&
    manifest.phase === input.phase &&
    manifest.goal_version === input.goal_version &&
    manifest.input_revision === input.input_revision &&
    manifest.attempt === input.attempt &&
    (input.capability_grant === undefined ||
      isDeepStrictEqual(manifest.capability_grant, input.capability_grant))
  );
}

function goalMatchesSaveInput(
  goal: WorkItem["goal"],
  input: SaveWorkItemInput,
  goalVersion: number,
): boolean {
  const contract = goal.goal_contract;
  return (
    goal.title === input.title &&
    goal.type === (input.type ?? undefined) &&
    goal.priority === (input.priority ?? undefined) &&
    JSON.stringify(goal.tags ?? []) === JSON.stringify(input.tags) &&
    goal.notes === (input.notes ?? undefined) &&
    contract?.schema_version === 1 &&
    contract.goal_version === goalVersion &&
    contract.purpose === input.goal_contract?.purpose &&
    JSON.stringify(contract.acceptance_criteria) ===
      JSON.stringify(input.goal_contract?.acceptance_criteria) &&
    JSON.stringify(contract.non_goals) ===
      JSON.stringify(input.goal_contract?.non_goals) &&
    JSON.stringify(contract.allowed_scope) ===
      JSON.stringify(input.goal_contract?.allowed_scope) &&
    JSON.stringify(contract.review_ready) ===
      JSON.stringify(input.goal_contract?.review_ready)
  );
}

export class WorkItemController {
  constructor(
    private readonly repository: ControllerWorkItemRepository,
    private readonly clock: Clock,
    private readonly git: GitVerificationAdapter,
    private readonly verificationRunner: VerificationRunner,
  ) {}

  async startBrainstorm(
    workItemId: string,
    input: StartBrainstormDecisionInput,
  ): Promise<ShapingDecisionControllerResult> {
    return this.executeShapingDecision(
      workItemId,
      "start_brainstorm",
      startBrainstormDecisionInputSchema.parse(input),
    );
  }

  async proposeScopeCorrection(
    workItemId: string,
  ): Promise<ScopeCorrectionProposalV1 | null> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const item = await this.repository.read(validatedId);
    if (item === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
      );
    }
    return this.buildScopeCorrectionProposal(item);
  }

  async applyScopeCorrection(
    workItemId: string,
    input: ApplyScopeCorrectionInput,
  ): Promise<ScopeCorrectionControllerResult> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const validatedInput = applyScopeCorrectionInputSchema.parse(input);
    const idempotencyKey = [
      validatedId,
      "scope-correction",
      validatedInput.proposal_sha256,
    ].join(":");
    const runId = deriveControllerRunId(
      idempotencyKey,
      JSON.stringify({ operation: "apply_scope_correction", input: validatedInput }),
    );
    const activeRun = this.activeRun(runId, idempotencyKey);
    const lease = await this.repository.acquireControllerLease(
      validatedId,
      activeRun,
    );
    if (lease === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
      );
    }

    try {
      const existing = await this.repository.readControllerRunManifest(
        validatedId,
        runId,
      );
      if (existing?.outcome === "applied") {
        const correction = existing.scope_correction;
        if (
          correction === undefined ||
          correction.proposal_sha256 !== validatedInput.proposal_sha256 ||
          correction.source_goal_contract_sha256 !==
            validatedInput.source_goal_contract_sha256 ||
          !isDeepStrictEqual(
            correction.governed_tuple,
            validatedInput.governed_tuple,
          ) ||
          lease.work_item.goal.goal_contract?.goal_version !==
            existing.goal_version ||
          !isDeepStrictEqual(
            lease.work_item.goal.goal_contract.allowed_scope,
            correction.proposed_allowed_scope,
          ) ||
          lease.work_item.state.input_revision !== existing.input_revision ||
          lease.work_item.state.attempt !== 0
        ) {
          throw this.conflict(
            "idempotency_conflict",
            validatedId,
            `Scope correction ${runId} does not match the durable work item.`,
          );
        }
        return {
          work_item: lease.work_item,
          manifest: existing,
          proposal: correction,
        };
      }
      if (existing !== null) {
        throw this.conflict(
          "repair_required",
          validatedId,
          `Scope correction ${runId} has a non-applied controller manifest.`,
        );
      }

      const proposal = await this.buildScopeCorrectionProposal(lease.work_item);
      if (
        proposal === null ||
        proposal.proposal_sha256 !== validatedInput.proposal_sha256 ||
        proposal.source_goal_contract_sha256 !==
          validatedInput.source_goal_contract_sha256 ||
        !isDeepStrictEqual(
          proposal.governed_tuple,
          validatedInput.governed_tuple,
        )
      ) {
        throw this.conflict(
          "stale_expectation",
          validatedId,
          "The scope-correction proposal no longer matches the governed goal and retained worktree.",
        );
      }

      const nextGoalVersion = this.incrementVersion(
        proposal.governed_tuple.goal_version,
        validatedId,
        "goal_version",
      );
      const nextInputRevision = this.incrementVersion(
        proposal.governed_tuple.input_revision,
        validatedId,
        "input_revision",
      );
      const contract = lease.work_item.goal.goal_contract!;
      const nextItem = workItemSchema.parse({
        goal: {
          ...lease.work_item.goal,
          goal_contract: {
            ...contract,
            goal_version: nextGoalVersion,
            allowed_scope: proposal.proposed_allowed_scope,
          },
        },
        state: {
          ...withoutAttention(lease.work_item.state),
          phase: "execute",
          status: "active",
          goal_version: nextGoalVersion,
          input_revision: nextInputRevision,
          attempt: 0,
          patch_cycle: 0,
          updated_at: nextTimestamp(
            lease.work_item.state.updated_at,
            this.clock,
          ),
        },
      });
      const manifest = {
        ...this.pendingManifest(
          {
            work_item_id: validatedId,
            run_id: runId,
            idempotency_key: idempotencyKey,
            phase: "execute" as const,
            goal_version: nextGoalVersion,
            input_revision: nextInputRevision,
            attempt: 0,
          },
          activeRun.acquired_at,
        ),
        scope_correction: proposal,
      };
      const committed = await this.repository.commitControllerMutation(lease, {
        goal: nextItem.goal,
        state: nextItem.state,
        manifest,
      });
      return { ...committed, proposal };
    } finally {
      await this.repository.releaseControllerLease(lease);
    }
  }

  async prepareCommandAuthorization(
    workItemId: string,
    expectedPhase: "execute" | "patch",
  ): Promise<CommandAuthorizationControllerResult> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const preLockItem = await this.repository.read(validatedId);
    if (preLockItem === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
      );
    }
    const preLockSnapshot = await this.currentWritableMission(
      preLockItem,
      expectedPhase,
    );
    const preLockProposal = await this.buildCommandAuthorizationProposal(
      preLockItem,
      preLockSnapshot.mission,
    );
    const idempotencyKey = [
      validatedId,
      expectedPhase,
      "command-authorization",
      preLockProposal.proposal_sha256,
    ].join(":");
    const runId = deriveControllerRunId(
      idempotencyKey,
      JSON.stringify({ operation: "prepare_command_authorization" }),
    );
    const activeRun = this.activeRun(runId, idempotencyKey);
    const lease = await this.repository.acquireControllerLease(
      validatedId,
      activeRun,
    );
    if (lease === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
      );
    }

    try {
      const existing = await this.repository.readControllerRunManifest(
        validatedId,
        runId,
      );
      if (existing?.outcome === "applied") {
        const attention = lease.work_item.state.attention;
        if (
          existing.command_authorization?.proposal_sha256 !==
            preLockProposal.proposal_sha256 ||
          attention?.kind !== "command_authorization" ||
          attention.proposal.proposal_sha256 !==
            preLockProposal.proposal_sha256
        ) {
          throw this.conflict(
            "idempotency_conflict",
            validatedId,
            `Command authorization ${runId} does not match durable attention.`,
          );
        }
        return {
          work_item: lease.work_item,
          manifest: existing,
          proposal: attention.proposal,
        };
      }
      if (existing !== null) {
        throw this.conflict(
          "repair_required",
          validatedId,
          `Command authorization ${runId} has a non-applied controller manifest.`,
        );
      }
      if (lease.work_item.state.attention !== undefined) {
        throw this.conflict(
          "stale_expectation",
          validatedId,
          "Command authorization requires no unresolved attention.",
        );
      }
      const snapshot = await this.currentWritableMission(
        lease.work_item,
        expectedPhase,
      );
      const proposal = await this.buildCommandAuthorizationProposal(
        lease.work_item,
        snapshot.mission,
      );
      if (proposal.proposal_sha256 !== preLockProposal.proposal_sha256) {
        throw this.conflict(
          "stale_expectation",
          validatedId,
          "The command-authorization proposal changed while acquiring its lease.",
        );
      }
      const nextItem = workItemSchema.parse({
        goal: lease.work_item.goal,
        state: {
          ...lease.work_item.state,
          attention: {
            kind: "command_authorization",
            question: "Allow these exact commands once in a fresh writable attempt?",
            recommendation:
              "Review every command and keep denied unless each is required by the governed result contract.",
            created_at: activeRun.acquired_at,
            governed_tuple: proposal.governed_tuple,
            pins: {
              artifact_paths: [snapshot.mission_path],
              evidence_paths: [],
              mission_content_sha256:
                proposal.source_mission_content_sha256,
            },
            proposal,
          },
          updated_at: nextTimestamp(
            lease.work_item.state.updated_at,
            this.clock,
          ),
        },
      });
      const manifest = {
        ...this.pendingManifest(
          {
            work_item_id: validatedId,
            run_id: runId,
            idempotency_key: idempotencyKey,
            phase: expectedPhase,
            goal_version: proposal.governed_tuple.goal_version,
            input_revision: proposal.governed_tuple.input_revision,
            attempt: proposal.governed_tuple.attempt,
          },
          activeRun.acquired_at,
        ),
        command_authorization: proposal,
      };
      const committed = await this.repository.commitControllerMutation(lease, {
        goal: nextItem.goal,
        state: nextItem.state,
        manifest,
      });
      return { ...committed, proposal };
    } finally {
      await this.repository.releaseControllerLease(lease);
    }
  }

  async decideCommandAuthorization(
    workItemId: string,
    input: CommandAuthorizationDecisionInput,
  ): Promise<CommandAuthorizationControllerResult> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const validatedInput = commandAuthorizationDecisionInputSchema.parse(input);
    const nextAttempt = this.incrementVersion(
      validatedInput.governed_tuple.attempt,
      validatedId,
      "attempt",
    );
    const idempotencyKey = deriveControllerIdempotencyKey(
      validatedId,
      validatedInput.expected_phase,
      validatedInput.governed_tuple.goal_version,
      validatedInput.governed_tuple.input_revision,
      nextAttempt,
    );
    const runId = deriveControllerRunId(
      idempotencyKey,
      JSON.stringify({ operation: "decide_command_authorization", input: validatedInput }),
    );
    const activeRun = this.activeRun(runId, idempotencyKey);
    const lease = await this.repository.acquireControllerLease(
      validatedId,
      activeRun,
    );
    if (lease === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
      );
    }
    try {
      const attention = lease.work_item.state.attention;
      const proposal =
        attention?.kind === "command_authorization"
          ? attention.proposal
          : null;
      const existing = await this.repository.readControllerRunManifest(
        validatedId,
        runId,
      );
      if (existing?.outcome === "applied") {
        const storedProposal = existing.command_authorization;
        if (
          validatedInput.decision !== "allow_once" ||
          storedProposal?.proposal_sha256 !== validatedInput.proposal_sha256 ||
          existing.capability_grant?.source_mission_content_sha256 !==
            validatedInput.source_mission_content_sha256 ||
          lease.work_item.state.attempt !== nextAttempt
        ) {
          throw this.conflict(
            "idempotency_conflict",
            validatedId,
            `Command-authorization decision ${runId} does not match durable state.`,
          );
        }
        return {
          work_item: lease.work_item,
          manifest: existing,
          proposal: storedProposal,
        };
      }
      if (existing !== null) {
        throw this.conflict(
          "repair_required",
          validatedId,
          `Command-authorization decision ${runId} is not applied.`,
        );
      }
      if (
        proposal === null ||
        proposal.phase !== validatedInput.expected_phase ||
        proposal.proposal_sha256 !== validatedInput.proposal_sha256 ||
        proposal.source_mission_content_sha256 !==
          validatedInput.source_mission_content_sha256 ||
        proposal.terminal_connected_run_id !==
          validatedInput.terminal_connected_run_id ||
        !isDeepStrictEqual(
          proposal.governed_tuple,
          validatedInput.governed_tuple,
        )
      ) {
        throw this.conflict(
          "stale_expectation",
          validatedId,
          "The command decision does not match the exact unresolved attention.",
        );
      }
      if (validatedInput.decision === "keep_denied") {
        return { work_item: lease.work_item, manifest: null, proposal };
      }
      const snapshot = await this.currentWritableMission(
        lease.work_item,
        validatedInput.expected_phase,
      );
      if (
        snapshot.mission.content_sha256 !==
        proposal.source_mission_content_sha256 ||
        !("capability_envelope" in snapshot.mission)
      ) {
        throw this.conflict(
          "stale_expectation",
          validatedId,
          "The command decision no longer binds the current writable mission.",
        );
      }
      let executionDefaults = executionDefaultsFromCapabilityEnvelope(
        snapshot.mission.capability_envelope,
      );
      for (const command of proposal.commands) {
        executionDefaults = extendExecutionDefaultsWithRequest(
          executionDefaults,
          command,
        );
      }
      const capabilityGrant = createControllerCapabilityGrant({
        source_mission_content_sha256:
          proposal.source_mission_content_sha256,
        execution_defaults: executionDefaults,
      });
      const nextItem = workItemSchema.parse({
        goal: lease.work_item.goal,
        state: {
          ...withoutAttention(lease.work_item.state),
          attempt: nextAttempt,
          updated_at: nextTimestamp(
            lease.work_item.state.updated_at,
            this.clock,
          ),
        },
      });
      const manifest = {
        ...this.pendingManifest(
          {
            work_item_id: validatedId,
            run_id: runId,
            idempotency_key: idempotencyKey,
            phase: validatedInput.expected_phase,
            goal_version: proposal.governed_tuple.goal_version,
            input_revision: proposal.governed_tuple.input_revision,
            attempt: nextAttempt,
          },
          activeRun.acquired_at,
        ),
        capability_grant: capabilityGrant,
        command_authorization: proposal,
      };
      const committed = await this.repository.commitControllerMutation(lease, {
        goal: nextItem.goal,
        state: nextItem.state,
        manifest,
      });
      return { ...committed, proposal };
    } finally {
      await this.repository.releaseControllerLease(lease);
    }
  }

  async requestShapingChanges(
    workItemId: string,
    input: RequestShapingChangesInput,
  ): Promise<ShapingDecisionControllerResult> {
    return this.executeShapingDecision(
      workItemId,
      "request_changes",
      requestShapingChangesInputSchema.parse(input),
    );
  }

  async useBrainstormResult(
    workItemId: string,
    input: ShapingResultDecisionInput,
  ): Promise<ShapingDecisionControllerResult> {
    return this.executeShapingDecision(
      workItemId,
      "use_brainstorm_result",
      shapingResultDecisionInputSchema.parse(input),
    );
  }

  async approveSpecResult(
    workItemId: string,
    input: ApproveSpecDecisionInput,
  ): Promise<ShapingDecisionControllerResult> {
    return this.executeShapingDecision(
      workItemId,
      "approve_spec",
      approveSpecDecisionInputSchema.parse(input),
    );
  }

  async replanWithUpdatedContract(
    workItemId: string,
    input: ReplanWithUpdatedContractInput,
  ): Promise<ShapingDecisionControllerResult> {
    return this.executeShapingDecision(
      workItemId,
      "replan_with_updated_contract",
      replanWithUpdatedContractInputSchema.parse(input),
    );
  }

  async approvePlanResult(
    workItemId: string,
    input: ApprovePlanResultInput,
  ): Promise<PlanApprovalControllerResult> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const validatedInput = approvePlanResultInputSchema.parse(input);
    const repository = this.shapingRepository();
    const preLockItem = await repository.read(validatedId);
    if (preLockItem === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
      );
    }
    const goalVersion = preLockItem.state.goal_version;
    if (goalVersion === undefined) {
      throw this.conflict(
        "stale_expectation",
        validatedId,
        "Plan approval requires a governed goal version.",
      );
    }
    const binding: PlanApprovalBinding = {
      work_item_id: validatedId,
      ...validatedInput,
      goal_version: goalVersion,
    };
    const approvalId = derivePlanApprovalId(binding);
    const idempotencyKey = `${validatedId}:plan-approval:${approvalId}`;
    const activeRun = this.activeRun(
      deriveControllerRunId(idempotencyKey, "approve-plan-result"),
      idempotencyKey,
    );
    const lease = await repository.acquireControllerLease(
      validatedId,
      activeRun,
    );
    if (lease === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
      );
    }

    try {
      let storedManifest: PlanApprovalManifestV1 | null;
      try {
        storedManifest = await repository.readPlanApprovalManifest(
          validatedId,
          approvalId,
        );
      } catch (error) {
        if (
          error instanceof ControllerConflictError &&
          error.kind === "repair_required" &&
          error.reason.includes("receipt without a manifest")
        ) {
          const recoverableIntent =
            await repository.readPlanApprovalIntent(
              validatedId,
              approvalId,
            );
          if (recoverableIntent !== null) {
            this.assertPlanApprovalIntentMatchesBinding(
              recoverableIntent,
              binding,
            );
            await this.assertResumablePlanApprovalIntent(
              repository,
              lease.work_item,
              recoverableIntent,
            );
            return await this.materializePlanApproval(
              repository,
              lease,
              recoverableIntent,
            );
          }
        }
        throw error;
      }
      if (storedManifest?.outcome === "applied") {
        const storedIntent = await this.requirePlanApprovalIntent(
          repository,
          binding,
          approvalId,
        );
        this.assertPlanApprovalManifestMatchesIntent(
          storedManifest,
          storedIntent,
        );
        return this.planApprovalResult(storedIntent, storedManifest);
      }
      if (storedManifest?.outcome === "failed") {
        throw this.conflict(
          "idempotency_conflict",
          validatedId,
          `Plan approval ${approvalId} is already failed.`,
        );
      }

      const storedIntent = await repository.readPlanApprovalIntent(
        validatedId,
        approvalId,
      );
      if (storedIntent !== null) {
        this.assertPlanApprovalIntentMatchesBinding(storedIntent, binding);
        if (storedManifest?.outcome === "pending") {
          this.assertPlanApprovalManifestMatchesIntent(
            storedManifest,
            storedIntent,
          );
          const reconciled = await repository.reconcilePlanApprovalCommit(
            lease,
            approvalId,
          );
          return this.planApprovalResult(
            storedIntent,
            reconciled.manifest,
          );
        }
        await this.assertResumablePlanApprovalIntent(
          repository,
          lease.work_item,
          storedIntent,
        );
        return await this.materializePlanApproval(
          repository,
          lease,
          storedIntent,
        );
      }
      if (storedManifest !== null) {
        throw this.conflict(
          "repair_required",
          validatedId,
          `Plan approval ${approvalId} has a manifest but no durable intent.`,
        );
      }

      const artifacts = await repository.listShapingArtifacts(validatedId);
      const planTip = this.resolveShapingTip(
        validatedId,
        "plan",
        artifacts,
      );
      if (planTip?.decision !== null && planTip?.decision !== undefined) {
        throw this.conflict(
          "idempotency_conflict",
          validatedId,
          "The Plan tip already has a different durable approval binding.",
        );
      }
      const runs = await repository.listShapingRuns(validatedId);
      const currentShapingState = this.shapingDecisionState(
        lease.work_item,
        artifacts,
        runs,
      );
      if (
        hashShapingDecisionState(currentShapingState) !==
        binding.expected_shaping_state_sha256
      ) {
        throw this.conflict(
          "stale_expectation",
          validatedId,
          "Expected Plan shaping state does not match the durable work item and artifact tip.",
        );
      }

      const prepared = this.preparePlanApproval(
        lease.work_item,
        artifacts,
        binding,
      );
      const receiptBytes = this.serializeDecisionReceipt(
        prepared.receipt,
      );
      const writtenIntent = await repository.writePlanApprovalIntent(
        lease,
        {
          intent: {
            schema_version: 1,
            work_item_id: validatedId,
            launch_mode: binding.launch_mode,
            requested_model: binding.requested_model,
            expected_mission_content_sha256:
              binding.expected_mission_content_sha256,
            expected_result_content_sha256:
              binding.expected_result_content_sha256,
            expected_shaping_state_sha256:
              binding.expected_shaping_state_sha256,
            goal_contract_sha256: binding.goal_contract_sha256,
            goal_version: binding.goal_version,
            receipt_bytes: receiptBytes,
            receipt_sha256: this.hashSource(receiptBytes),
            execute_tuple: prepared.receipt.execute_tuple,
          },
          state: prepared.next_state,
        },
      );
      return await this.materializePlanApproval(
        repository,
        lease,
        writtenIntent.intent,
      );
    } finally {
      await repository.releaseControllerLease(lease);
    }
  }

  private async executeShapingDecision(
    workItemId: string,
    operation: ShapingDecisionOperation,
    input:
      | z.output<typeof startBrainstormDecisionInputSchema>
      | z.output<typeof shapingResultDecisionInputSchema>
      | z.output<typeof requestShapingChangesInputSchema>
      | z.output<typeof approveSpecDecisionInputSchema>
      | z.output<typeof replanWithUpdatedContractInputSchema>,
  ): Promise<ShapingDecisionControllerResult> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const repository = this.shapingRepository();
    const preLockItem = await repository.read(validatedId);
    if (preLockItem === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
      );
    }

    const feedbackSha256 =
      operation === "request_changes"
        ? this.hashSource(
            requestShapingChangesInputSchema.parse(input).feedback,
          )
        : null;
    const binding: ShapingDecisionBinding = {
      operation,
      work_item_id: validatedId,
      goal_input_sha256: hashGoalInput({
        title: preLockItem.goal.title,
        notes: preLockItem.goal.notes,
      }),
      mission_content_sha256: input.expected_mission_content_sha256,
      result_content_sha256: input.expected_result_content_sha256,
      feedback_sha256: feedbackSha256,
      expected_shaping_state_sha256: input.expected_shaping_state_sha256,
      launch_mode: input.launch_mode,
      next_requested_model: input.next_requested_model,
    };
    const decisionId = deriveShapingDecisionId({
      operation: binding.operation,
      work_item_id: binding.work_item_id,
      goal_input_sha256: binding.goal_input_sha256,
      mission_content_sha256: binding.mission_content_sha256,
      result_content_sha256: binding.result_content_sha256,
      feedback_sha256: binding.feedback_sha256,
      expected_shaping_state_sha256:
        binding.expected_shaping_state_sha256,
    });
    const idempotencyKey = `${validatedId}:shaping-decision:${decisionId}`;
    const activeRun = this.activeRun(
      deriveControllerRunId(idempotencyKey, "shaping-decision"),
      idempotencyKey,
    );
    const lease = await repository.acquireControllerLease(
      validatedId,
      activeRun,
    );
    if (lease === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
      );
    }

    try {
      const storedManifest = await repository.readShapingDecisionManifest(
        validatedId,
        decisionId,
      );
      if (storedManifest?.outcome === "applied") {
        const storedIntent = await this.requireShapingDecisionIntent(
          repository,
          binding,
          decisionId,
        );
        this.assertShapingDecisionManifestMatchesIntent(
          storedManifest,
          storedIntent,
        );
        return this.shapingDecisionResult(
          this.workItemFromShapingIntent(storedIntent),
          storedManifest,
          storedIntent,
        );
      }
      if (storedManifest?.outcome === "failed") {
        throw this.conflict(
          "idempotency_conflict",
          validatedId,
          `Shaping decision ${decisionId} is already failed.`,
        );
      }

      const storedIntent = await repository.readShapingDecisionIntent(
        validatedId,
        decisionId,
      );
      if (storedIntent !== null) {
        this.assertShapingDecisionIntentMatchesBinding(storedIntent, binding);
        if (storedManifest?.outcome === "pending") {
          this.assertShapingDecisionManifestMatchesIntent(
            storedManifest,
            storedIntent,
          );
          const reconciled =
            await repository.reconcileShapingDecisionCommit(
              lease,
              decisionId,
            );
          return this.shapingDecisionResult(
            reconciled.work_item,
            reconciled.manifest,
            storedIntent,
          );
        }
        await this.assertResumableShapingIntent(
          repository,
          lease.work_item,
          storedIntent,
        );
        return await this.materializeShapingDecision(
          repository,
          lease,
          storedIntent,
        );
      }
      if (storedManifest !== null) {
        throw this.conflict(
          "repair_required",
          validatedId,
          `Shaping decision ${decisionId} has a manifest but no durable intent.`,
        );
      }

      const artifacts = await repository.listShapingArtifacts(validatedId);
      const runs = await repository.listShapingRuns(validatedId);
      const currentShapingState = this.shapingDecisionState(
        lease.work_item,
        artifacts,
        runs,
      );
      if (
        hashShapingDecisionState(currentShapingState) !==
        binding.expected_shaping_state_sha256
      ) {
        throw this.conflict(
          "stale_expectation",
          validatedId,
          "Expected shaping state does not match the durable work item and artifact tip.",
        );
      }

      const prepared = await this.prepareShapingDecision(
        operation,
        lease.work_item,
        artifacts,
        input,
      );
      const missionBytes = serializeShapingPackage(prepared.next_mission);
      const receiptBytes =
        prepared.decision_receipt === null
          ? null
          : this.serializeDecisionReceipt(prepared.decision_receipt);
      const launchFingerprint =
        binding.next_requested_model === null
          ? null
          : shapingRunLaunchFingerprint(
              prepared.next_mission.content_sha256,
              binding.next_requested_model,
            );
      const writtenIntent = await repository.writeShapingDecisionIntent(
        lease,
        {
          intent: {
            schema_version: 1,
            work_item_id: validatedId,
            operation,
            launch_mode: binding.launch_mode,
            phase_from: prepared.phase_from,
            phase_to: prepared.phase_to,
            goal_input_sha256: binding.goal_input_sha256,
            mission_content_sha256: binding.mission_content_sha256,
            result_content_sha256: binding.result_content_sha256,
            feedback_sha256: binding.feedback_sha256,
            expected_shaping_state_sha256:
              binding.expected_shaping_state_sha256,
            next_requested_model: binding.next_requested_model,
            next_mission_content_sha256:
              prepared.next_mission.content_sha256,
            next_mission_input_sha256:
              prepared.next_mission.identity.input_sha256,
            plan_repository_base_commit:
              prepared.plan_repository_base_commit,
            plan_goal_contract_sha256:
              prepared.plan_goal_contract_sha256,
            plan_goal_version: prepared.plan_goal_version,
            launch_fingerprint: launchFingerprint,
            decision_receipt_bytes: receiptBytes,
            next_mission_package_bytes: missionBytes,
          },
          ...(prepared.next_goal === undefined
            ? {}
            : { goal: prepared.next_goal }),
          state: prepared.next_state,
        },
      );
      return await this.materializeShapingDecision(
        repository,
        lease,
        writtenIntent.intent,
      );
    } finally {
      await repository.releaseControllerLease(lease);
    }
  }

  async saveWorkItem(
    workItemId: string,
    input: SaveWorkItemInput,
  ): Promise<ControllerMutationResult> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const validatedInput = saveWorkItemInputSchema.parse(input);
    const preLockItem = await this.repository.read(validatedId);
    if (preLockItem === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
      );
    }
    const contractInput = validatedInput.goal_contract;
    if (contractInput === undefined) {
      throw this.conflict(
        "contract_required",
        validatedId,
        "Controller saves require a goal contract.",
      );
    }

    const nextGoalVersion =
      validatedInput.expected_goal_version === undefined
        ? 1
        : this.incrementVersion(
            validatedInput.expected_goal_version,
            validatedId,
            "goal_version",
          );
    const nextInputRevision =
      validatedInput.expected_input_revision === undefined
        ? 1
        : this.incrementVersion(
            validatedInput.expected_input_revision,
            validatedId,
            "input_revision",
          );
    const idempotencyKey = deriveControllerIdempotencyKey(
      validatedId,
      preLockItem.state.phase,
      nextGoalVersion,
      nextInputRevision,
      0,
    );
    const runId = deriveControllerRunId(
      idempotencyKey,
      JSON.stringify({ operation: "save_work_item", input: validatedInput }),
    );
    const activeRun = this.activeRun(runId, idempotencyKey);
    const lease = await this.repository.acquireControllerLease(
      validatedId,
      activeRun,
    );
    if (lease === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
      );
    }

    try {
      if (!canUpdateGoalContract(lease.work_item.state.phase)) {
        throw this.conflict(
          "goal_contract_locked",
          validatedId,
          `Goal contracts are locked after entering ${lease.work_item.state.phase}.`,
        );
      }
      const existing = await this.repository.readControllerRunManifest(
        validatedId,
        runId,
      );
      const manifestIdentity = {
        work_item_id: validatedId,
        run_id: runId,
        idempotency_key: idempotencyKey,
        phase: lease.work_item.state.phase,
        goal_version: nextGoalVersion,
        input_revision: nextInputRevision,
        attempt: 0,
      };
      if (existing !== null) {
        if (
          manifestMatches(existing, manifestIdentity) &&
          goalMatchesSaveInput(
            lease.work_item.goal,
            validatedInput,
            nextGoalVersion,
          ) &&
          lease.work_item.state.goal_version === nextGoalVersion &&
          lease.work_item.state.input_revision === nextInputRevision &&
          lease.work_item.state.attempt === 0
        ) {
          return { work_item: lease.work_item, manifest: existing };
        }
        throw this.conflict(
          "idempotency_conflict",
          validatedId,
          `Run ${runId} already has a non-matching durable manifest.`,
        );
      }

      this.validateSaveExpectations(
        validatedId,
        lease.work_item,
        validatedInput,
      );
      if (lease.work_item.state.phase !== preLockItem.state.phase) {
        throw this.conflict(
          "stale_expectation",
          validatedId,
          "Work-item phase changed while the save was acquiring its lease.",
        );
      }

      const nextItem = workItemSchema.parse({
        goal: {
          schema_version: 2,
          work_item_id: lease.work_item.goal.work_item_id,
          title: validatedInput.title,
          ...(validatedInput.type === null
            ? {}
            : { type: validatedInput.type }),
          ...(lease.work_item.goal.capture === undefined
            ? {}
            : { capture: lease.work_item.goal.capture }),
          ...(validatedInput.priority === null
            ? {}
            : { priority: validatedInput.priority }),
          ...(validatedInput.tags.length === 0
            ? {}
            : { tags: validatedInput.tags }),
          ...(validatedInput.notes === null
            ? {}
            : { notes: validatedInput.notes }),
          goal_contract: {
            schema_version: 1,
            goal_version: nextGoalVersion,
            purpose: contractInput.purpose,
            acceptance_criteria: contractInput.acceptance_criteria,
            non_goals: contractInput.non_goals,
            allowed_scope: contractInput.allowed_scope,
            review_ready: contractInput.review_ready,
          },
        },
        state: {
          ...lease.work_item.state,
          goal_version: nextGoalVersion,
          input_revision: nextInputRevision,
          attempt: 0,
          patch_cycle: 0,
          updated_at: nextTimestamp(
            lease.work_item.state.updated_at,
            this.clock,
          ),
        },
      });
      const manifest = this.pendingManifest(
        manifestIdentity,
        activeRun.acquired_at,
      );

      return await this.repository.commitControllerMutation(lease, {
        goal: nextItem.goal,
        state: nextItem.state,
        manifest,
      });
    } finally {
      await this.repository.releaseControllerLease(lease);
    }
  }

  async transition(
    workItemId: string,
    input: ControllerTransitionInput,
  ): Promise<ControllerMutationResult> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const validatedInput = controllerTransitionInputSchema.parse(input);
    const idempotencyKey = deriveControllerIdempotencyKey(
      validatedId,
      validatedInput.target_phase,
      validatedInput.expected_goal_version,
      validatedInput.expected_input_revision,
      validatedInput.attempt,
    );
    const runId = deriveControllerRunId(
      idempotencyKey,
      JSON.stringify({ operation: "transition", input: validatedInput }),
    );
    const activeRun = this.activeRun(runId, idempotencyKey);
    const lease = await this.repository.acquireControllerLease(
      validatedId,
      activeRun,
    );
    if (lease === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
      );
    }

    try {
      const manifestIdentity = {
        work_item_id: validatedId,
        run_id: runId,
        idempotency_key: idempotencyKey,
        phase: validatedInput.target_phase,
        goal_version: validatedInput.expected_goal_version,
        input_revision: validatedInput.expected_input_revision,
        attempt: validatedInput.attempt,
      };
      const existing = await this.repository.readControllerRunManifest(
        validatedId,
        runId,
      );
      if (existing !== null) {
        if (
          manifestMatches(existing, manifestIdentity) &&
          lease.work_item.state.phase === validatedInput.target_phase &&
          lease.work_item.state.status === validatedInput.target_status &&
          lease.work_item.state.goal_version ===
            validatedInput.expected_goal_version &&
          lease.work_item.state.input_revision ===
            validatedInput.expected_input_revision &&
          lease.work_item.state.attempt === validatedInput.attempt
        ) {
          return { work_item: lease.work_item, manifest: existing };
        }
        throw this.conflict(
          "idempotency_conflict",
          validatedId,
          `Run ${runId} already has a non-matching durable result.`,
        );
      }

      const dedicatedPolicy = dedicatedTransitionPolicy(
        lease.work_item.state.phase,
        validatedInput.target_phase,
      );
      if (dedicatedPolicy.kind !== "generic_allowed") {
        throw this.conflict(
          "invalid_transition",
          validatedId,
          dedicatedPolicy.kind === "dedicated_operation_required"
            ? `${dedicatedPolicy.action_label} — ${dedicatedPolicy.explanation}`
            : dedicatedPolicy.explanation,
        );
      }

      this.validateTransitionExpectations(
        validatedId,
        lease.work_item,
        validatedInput,
      );
      const transition = validateWorkItemTransition(
        lease.work_item.state.phase,
        validatedInput.target_phase,
        lease.work_item.state.status,
        validatedInput.target_status,
      );
      if (!transition.ok) {
        throw this.conflict(
          "invalid_transition",
          validatedId,
          transition.reason,
        );
      }

      const nextItem = workItemSchema.parse({
        goal: lease.work_item.goal,
        state: {
          ...lease.work_item.state,
          phase: validatedInput.target_phase,
          status: validatedInput.target_status,
          updated_at: nextTimestamp(
            lease.work_item.state.updated_at,
            this.clock,
          ),
        },
      });
      const manifest = this.pendingManifest(
        manifestIdentity,
        activeRun.acquired_at,
      );

      return await this.repository.commitControllerMutation(lease, {
        goal: nextItem.goal,
        state: nextItem.state,
        manifest,
      });
    } finally {
      await this.repository.releaseControllerLease(lease);
    }
  }

  async importExternalResult(
    workItemId: string,
    input: ImportExternalResultInput,
  ): Promise<ImportExternalResultResult> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const validatedInput = importExternalResultInputSchema.parse(input);
    const repository = this.repository;
    const identity = {
      phase: "execute" as const,
      work_item_id: validatedId,
      goal_version: validatedInput.expected_goal_version,
      input_revision: validatedInput.expected_input_revision,
      attempt: validatedInput.attempt,
    };
    const snapshot = await repository.readMissionResult(identity);
    this.requireActiveMissionSnapshot(snapshot, validatedId);
    const resultContentSha256 = hashResultContent(snapshot.result_source);
    const importRunId = createImportRunId(
      snapshot.mission.content_sha256,
      resultContentSha256,
    );
    const idempotencyKey = [
      deriveControllerIdempotencyKey(
        validatedId,
        "execute",
        identity.goal_version,
        identity.input_revision,
        identity.attempt,
      ),
      "import",
      resultContentSha256,
    ].join(":");
    const runId = deriveControllerRunId(
      idempotencyKey,
      JSON.stringify({ operation: "import_external_result", importRunId }),
    );
    const storedEvidence = await repository.readImportEvidence(
      identity,
      importRunId,
    );
    const activeRun = this.activeRun(runId, idempotencyKey);
    const lease = await repository.acquireControllerLease(validatedId, activeRun);
    if (lease === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
      );
    }

    try {
      const existingManifest = await repository.readControllerRunManifest(
        validatedId,
        runId,
      );
      if (storedEvidence !== null) {
        return await this.reconcileStoredImport(
          repository,
          lease,
          existingManifest,
          storedEvidence,
          validatedInput,
          activeRun,
          idempotencyKey,
        );
      }
      if (existingManifest !== null) {
        throw this.conflict(
          "repair_required",
          validatedId,
          `Import run ${runId} has a controller manifest but no immutable evidence.`,
        );
      }

      this.validateExecuteExpectation(
        validatedId,
        lease.work_item,
        validatedInput,
      );

      const manifest = await repository.readManifest();
      const assessment = await this.assessExternalResult(
        snapshot,
        identity,
        manifest,
      );
      const targetPhase: WorkItemPhase =
        assessment.outcome === "applied" ? "review" : "execute";
      const targetStatus: WorkItemStatus =
        assessment.outcome === "applied" ? "active" : "blocked";
      const transition = validateWorkItemTransition(
        lease.work_item.state.phase,
        targetPhase,
        lease.work_item.state.status,
        targetStatus,
      );
      if (!transition.ok) {
        throw this.conflict(
          "invalid_transition",
          validatedId,
          transition.reason,
        );
      }

      const completedAt = nextTimestamp(activeRun.acquired_at, this.clock);
      const evidence = importEvidenceEnvelopeSchema.parse({
        schema_version: 2,
        phase: "execute",
        import_run_id: importRunId,
        result_content_sha256: resultContentSha256,
        mission_content_sha256: snapshot.mission.content_sha256,
        identity,
        git_base_commit: snapshot.mission.source_revision.git_base_commit,
        result_commit: assessment.result?.commit ?? null,
        controller_run_id: runId,
        started_at: activeRun.acquired_at,
        completed_at: completedAt,
        outcome: assessment.outcome,
        reasons: assessment.reasons,
      });
      const evidenceSummary = await repository.writeImportEvidence({
        submission_source: snapshot.result_source,
        evidence,
        verification: assessment.verification,
      });
      const nextItem = workItemSchema.parse({
        goal: lease.work_item.goal,
        state: {
          ...lease.work_item.state,
          phase: targetPhase,
          status: targetStatus,
          updated_at: nextTimestamp(
            lease.work_item.state.updated_at,
            this.clock,
          ),
        },
      });
      const pendingManifest = this.pendingManifest(
        {
          work_item_id: validatedId,
          run_id: runId,
          idempotency_key: idempotencyKey,
          phase: targetPhase,
          goal_version: identity.goal_version,
          input_revision: identity.input_revision,
          attempt: identity.attempt,
        },
        activeRun.acquired_at,
      );
      const mutation = await repository.commitControllerMutation(lease, {
        goal: nextItem.goal,
        state: nextItem.state,
        manifest: pendingManifest,
      });

      return { ...mutation, evidence: evidenceSummary };
    } finally {
      await repository.releaseControllerLease(lease);
    }
  }

  async importReviewResult(
    workItemId: string,
    input: ImportReviewResultInput,
  ): Promise<ImportReviewResultResult> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const validatedInput = importReviewResultInputSchema.parse(input);
    const repository = this.repository;
    const identity = {
      phase: "review" as const,
      work_item_id: validatedId,
      goal_version: validatedInput.expected_goal_version,
      input_revision: validatedInput.expected_input_revision,
      attempt: validatedInput.attempt,
    };
    const snapshot = await repository.readMissionResult(
      identity,
      validatedInput.expected_patch_cycle === 0
        ? undefined
        : validatedInput.expected_patch_cycle,
    );
    this.requireActiveMissionSnapshot(snapshot, validatedId);
    if (!("review_subject" in snapshot.mission)) {
      throw this.conflict(
        "mission_not_ready",
        validatedId,
        "Review result import requires an immutable review mission.",
      );
    }
    const resultContentSha256 = hashResultContent(snapshot.result_source);
    const importRunId = createImportRunId(
      snapshot.mission.content_sha256,
      resultContentSha256,
    );
    const idempotencyKey = [
      deriveControllerIdempotencyKey(
        validatedId,
        "review",
        identity.goal_version,
        identity.input_revision,
        identity.attempt,
      ),
      `patch-cycle-${validatedInput.expected_patch_cycle}`,
      "import",
      resultContentSha256,
    ].join(":");
    const runId = deriveControllerRunId(
      idempotencyKey,
      JSON.stringify({ operation: "import_review_result", importRunId }),
    );
    const storedEvidence = await repository.readImportEvidence(
      identity,
      importRunId,
    );
    const activeRun = this.activeRun(runId, idempotencyKey);
    const lease = await repository.acquireControllerLease(validatedId, activeRun);
    if (lease === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
      );
    }

    try {
      const existingManifest = await repository.readControllerRunManifest(
        validatedId,
        runId,
      );
      if (storedEvidence !== null) {
        return await this.reconcileStoredReviewImport(
          repository,
          lease,
          existingManifest,
          storedEvidence,
          validatedInput,
          activeRun,
          idempotencyKey,
          snapshot,
        );
      }
      if (existingManifest !== null) {
        throw this.conflict(
          "repair_required",
          validatedId,
          `Review import run ${runId} has a controller manifest but no immutable evidence.`,
        );
      }

      this.validateReviewExpectation(
        validatedId,
        lease.work_item,
        validatedInput,
      );
      const currentSubject = await this.currentReviewSubject(
        repository,
        identity,
        snapshot.mission.review_subject,
        validatedInput.expected_patch_cycle,
      );
      const assessment = await this.assessReviewResult(
        snapshot,
        identity,
        currentSubject,
      );
      const completedAt = nextTimestamp(activeRun.acquired_at, this.clock);
      const evidence = importEvidenceEnvelopeSchema.parse({
        schema_version: 2,
        phase: "review",
        import_run_id: importRunId,
        result_content_sha256: resultContentSha256,
        mission_content_sha256: snapshot.mission.content_sha256,
        identity,
        git_base_commit: snapshot.mission.review_subject.git_base_commit,
        result_commit:
          snapshot.mission.review_subject.accepted_result_commit,
        controller_run_id: runId,
        started_at: activeRun.acquired_at,
        completed_at: completedAt,
        outcome: assessment.outcome,
        reasons: assessment.reasons,
      });
      const evidenceSummary = await repository.writeImportEvidence({
        submission_source: snapshot.result_source,
        evidence,
        verification: [],
      });
      if (assessment.outcome === "rejected") {
        return {
          work_item: lease.work_item,
          manifest: null,
          evidence: evidenceSummary,
          ...(assessment.result === undefined
            ? {}
            : { result: assessment.result }),
        };
      }

      const pendingManifest = this.pendingManifest(
        {
          work_item_id: validatedId,
          run_id: runId,
          idempotency_key: idempotencyKey,
          phase: "review",
          goal_version: identity.goal_version,
          input_revision: identity.input_revision,
          attempt: identity.attempt,
        },
        activeRun.acquired_at,
      );
      const nextItem = workItemSchema.parse({
        goal: lease.work_item.goal,
        state: {
          ...lease.work_item.state,
          attention: this.reviewAttention(
            lease.work_item,
            snapshot,
            evidenceSummary,
            resultContentSha256,
            assessment.result!,
            completedAt,
          ),
          updated_at: nextTimestamp(
            lease.work_item.state.updated_at,
            this.clock,
          ),
        },
      });
      const mutation = await repository.commitControllerMutation(lease, {
        goal: nextItem.goal,
        state: nextItem.state,
        manifest: pendingManifest,
      });
      return {
        ...mutation,
        evidence: evidenceSummary,
        result: assessment.result,
      };
    } finally {
      await repository.releaseControllerLease(lease);
    }
  }

  async acceptPatchPlan(
    workItemId: string,
    input: AcceptPatchPlanInput,
  ): Promise<ControllerMutationResult> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const validatedInput = acceptPatchPlanInputSchema.parse(input);
    if (validatedInput.expected_patch_cycle >= 3) {
      throw this.conflict(
        "invalid_transition",
        validatedId,
        "A fourth patch cycle is not permitted.",
      );
    }
    const nextPatchCycle = this.incrementVersion(
      validatedInput.expected_patch_cycle,
      validatedId,
      "patch_cycle",
    );
    const identity: MissionIdentity<"review"> = {
      phase: "review",
      work_item_id: validatedId,
      goal_version: validatedInput.expected_goal_version,
      input_revision: validatedInput.expected_input_revision,
      attempt: validatedInput.attempt,
    };
    const snapshot = await this.repository.readMissionResult(
      identity,
      validatedInput.expected_patch_cycle === 0
        ? undefined
        : validatedInput.expected_patch_cycle,
    );
    this.requireActiveMissionSnapshot(snapshot, validatedId);
    if (!("review_subject" in snapshot.mission)) {
      throw this.conflict(
        "mission_not_ready",
        validatedId,
        "Patch-plan approval requires an immutable review mission.",
      );
    }
    const resultContentSha256 = hashResultContent(snapshot.result_source);
    const importRunId = createImportRunId(
      snapshot.mission.content_sha256,
      resultContentSha256,
    );
    const idempotencyKey = [
      deriveControllerIdempotencyKey(
        validatedId,
        "patch",
        identity.goal_version,
        identity.input_revision,
        identity.attempt,
      ),
      `cycle-${nextPatchCycle}`,
      "accept-plan",
      resultContentSha256,
    ].join(":");
    const runId = deriveControllerRunId(
      idempotencyKey,
      JSON.stringify({ operation: "accept_patch_plan", input: validatedInput }),
    );
    const activeRun = this.activeRun(runId, idempotencyKey);
    const lease = await this.repository.acquireControllerLease(
      validatedId,
      activeRun,
    );
    if (lease === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
      );
    }

    try {
      const manifestIdentity = {
        work_item_id: validatedId,
        run_id: runId,
        idempotency_key: idempotencyKey,
        phase: "patch" as const,
        goal_version: identity.goal_version,
        input_revision: identity.input_revision,
        attempt: identity.attempt,
      };
      const existing = await this.repository.readControllerRunManifest(
        validatedId,
        runId,
      );
      if (existing !== null) {
        return this.reconcileStoredAcceptPatchPlan(
          lease,
          existing,
          manifestIdentity,
          nextPatchCycle,
        );
      }

      this.validateReviewExpectation(
        validatedId,
        lease.work_item,
        validatedInput,
      );
      const attention = lease.work_item.state.attention;
      if (
        attention?.kind !== "patch_plan_approval" ||
        attention.pins.mission_content_sha256 !==
          snapshot.mission.content_sha256 ||
        attention.pins.result_content_sha256 !== resultContentSha256 ||
        attention.pins.git_commit !==
          snapshot.mission.review_subject.accepted_result_commit ||
        JSON.stringify(attention.pins.artifact_paths) !==
          JSON.stringify([snapshot.mission_path, snapshot.result_path]) ||
        attention.pins.evidence_paths.length !== 1
      ) {
        throw this.conflict(
          "stale_expectation",
          validatedId,
          "Patch-plan approval does not match the current pinned review decision.",
        );
      }
      const currentSubject = await this.currentReviewSubject(
        this.repository,
        identity,
        snapshot.mission.review_subject,
        validatedInput.expected_patch_cycle,
      );
      const assessment = await this.assessReviewResult(
        snapshot,
        identity,
        currentSubject,
      );
      if (
        assessment.outcome !== "applied" ||
        assessment.result?.verdict !== "findings"
      ) {
        throw this.conflict(
          "repair_required",
          validatedId,
          "Patch-plan approval requires a valid applied review with findings.",
        );
      }
      const stored = await this.repository.readImportEvidence(
        identity,
        importRunId,
      );
      const reviewImportManifest =
        stored === null
          ? null
          : await this.repository.readControllerRunManifest(
              validatedId,
              stored.evidence.controller_run_id,
            );
      if (
        stored === null ||
        stored.evidence.phase !== "review" ||
        stored.evidence.outcome !== "applied" ||
        JSON.stringify(stored.evidence.identity) !== JSON.stringify(identity) ||
        stored.evidence.mission_content_sha256 !==
          snapshot.mission.content_sha256 ||
        stored.evidence.result_content_sha256 !== resultContentSha256 ||
        stored.evidence.git_base_commit !==
          snapshot.mission.review_subject.git_base_commit ||
        stored.evidence.result_commit !==
          snapshot.mission.review_subject.accepted_result_commit ||
        stored.summary.phase !== "review" ||
        stored.summary.import_run_id !== importRunId ||
        stored.summary.outcome !== "applied" ||
        stored.summary.evidence_path !== attention.pins.evidence_paths[0] ||
        reviewImportManifest === null ||
        reviewImportManifest.phase !== "review" ||
        reviewImportManifest.outcome !== "applied" ||
        reviewImportManifest.goal_version !== identity.goal_version ||
        reviewImportManifest.input_revision !== identity.input_revision ||
        reviewImportManifest.attempt !== identity.attempt
      ) {
        throw this.conflict(
          "repair_required",
          validatedId,
          "Patch-plan approval requires matching applied review evidence.",
        );
      }
      const transition = validateWorkItemTransition(
        lease.work_item.state.phase,
        "patch",
        lease.work_item.state.status,
        "active",
      );
      if (!transition.ok) {
        throw this.conflict(
          "invalid_transition",
          validatedId,
          transition.reason,
        );
      }
      const nextItem = workItemSchema.parse({
        goal: lease.work_item.goal,
        state: {
          ...withoutAttention(lease.work_item.state),
          phase: "patch",
          status: "active",
          patch_cycle: nextPatchCycle,
          updated_at: nextTimestamp(
            lease.work_item.state.updated_at,
            this.clock,
          ),
        },
      });
      return await this.repository.commitControllerMutation(lease, {
        goal: nextItem.goal,
        state: nextItem.state,
        manifest: this.pendingManifest(
          manifestIdentity,
          activeRun.acquired_at,
        ),
      });
    } finally {
      await this.repository.releaseControllerLease(lease);
    }
  }

  async importPatchResult(
    workItemId: string,
    input: ImportPatchResultInput,
  ): Promise<ImportPatchResultResult> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const validatedInput = importPatchResultInputSchema.parse(input);
    const repository = this.repository;
    const identity: MissionIdentity<"patch"> = {
      phase: "patch",
      work_item_id: validatedId,
      goal_version: validatedInput.expected_goal_version,
      input_revision: validatedInput.expected_input_revision,
      attempt: validatedInput.attempt,
      patch_cycle: validatedInput.expected_patch_cycle,
    };
    const snapshot = await repository.readMissionResult(identity);
    this.requireActiveMissionSnapshot(snapshot, validatedId);
    if (!("patch_subject" in snapshot.mission)) {
      throw this.conflict(
        "mission_not_ready",
        validatedId,
        "Patch result import requires an immutable patch mission.",
      );
    }
    const resultContentSha256 = hashResultContent(snapshot.result_source);
    const importRunId = createImportRunId(
      snapshot.mission.content_sha256,
      resultContentSha256,
    );
    const idempotencyKey = [
      deriveControllerIdempotencyKey(
        validatedId,
        "patch",
        identity.goal_version,
        identity.input_revision,
        identity.attempt,
      ),
      `cycle-${identity.patch_cycle}`,
      "import",
      resultContentSha256,
    ].join(":");
    const runId = deriveControllerRunId(
      idempotencyKey,
      JSON.stringify({ operation: "import_patch_result", importRunId }),
    );
    const storedEvidence = await repository.readImportEvidence(
      identity,
      importRunId,
    );
    const activeRun = this.activeRun(runId, idempotencyKey);
    const lease = await repository.acquireControllerLease(validatedId, activeRun);
    if (lease === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
      );
    }

    try {
      const existingManifest = await repository.readControllerRunManifest(
        validatedId,
        runId,
      );
      if (storedEvidence !== null) {
        return await this.reconcileStoredPatchImport(
          repository,
          lease,
          existingManifest,
          storedEvidence,
          validatedInput,
          activeRun,
          idempotencyKey,
          snapshot,
        );
      }
      if (existingManifest !== null) {
        throw this.conflict(
          "repair_required",
          validatedId,
          `Patch import run ${runId} has a controller manifest but no immutable evidence.`,
        );
      }
      this.validatePatchExpectation(
        validatedId,
        lease.work_item,
        validatedInput,
      );
      const manifest = await repository.readManifest();
      const assessment = await this.assessPatchResult(
        snapshot,
        identity,
        manifest,
      );
      const completedAt = nextTimestamp(activeRun.acquired_at, this.clock);
      const evidence = importEvidenceEnvelopeSchema.parse({
        schema_version: 2,
        phase: "patch",
        import_run_id: importRunId,
        result_content_sha256: resultContentSha256,
        mission_content_sha256: snapshot.mission.content_sha256,
        identity,
        git_base_commit: snapshot.mission.source_revision.git_base_commit,
        result_commit:
          assessment.result?.commit ??
          snapshot.mission.source_revision.git_base_commit,
        controller_run_id: runId,
        started_at: activeRun.acquired_at,
        completed_at: completedAt,
        outcome: assessment.outcome,
        reasons: assessment.reasons,
      });
      const evidenceSummary = await repository.writeImportEvidence({
        submission_source: snapshot.result_source,
        evidence,
        verification: assessment.verification,
      });
      if (assessment.outcome === "rejected") {
        return {
          work_item: lease.work_item,
          manifest: null,
          evidence: evidenceSummary,
          ...(assessment.result === undefined
            ? {}
            : { result: assessment.result }),
        };
      }
      const transition = validateWorkItemTransition(
        lease.work_item.state.phase,
        "review",
        lease.work_item.state.status,
        "active",
      );
      if (!transition.ok) {
        throw this.conflict(
          "invalid_transition",
          validatedId,
          transition.reason,
        );
      }
      const nextItem = workItemSchema.parse({
        goal: lease.work_item.goal,
        state: {
          ...withoutAttention(lease.work_item.state),
          phase: "review",
          status: "active",
          updated_at: nextTimestamp(
            lease.work_item.state.updated_at,
            this.clock,
          ),
        },
      });
      const manifestIdentity = {
        work_item_id: validatedId,
        run_id: runId,
        idempotency_key: idempotencyKey,
        phase: "review" as const,
        goal_version: identity.goal_version,
        input_revision: identity.input_revision,
        attempt: identity.attempt,
      };
      const mutation = await repository.commitControllerMutation(lease, {
        goal: nextItem.goal,
        state: nextItem.state,
        manifest: this.pendingManifest(
          manifestIdentity,
          activeRun.acquired_at,
        ),
      });
      return {
        ...mutation,
        evidence: evidenceSummary,
        result: assessment.result,
      };
    } finally {
      await repository.releaseControllerLease(lease);
    }
  }

  async retryExecuteAttempt(
    workItemId: string,
    input: RetryExecuteAttemptInput,
  ): Promise<ControllerMutationResult> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const validatedInput = retryExecuteAttemptInputSchema.parse(input);
    const nextAttempt = this.incrementVersion(
      validatedInput.attempt,
      validatedId,
      "attempt",
    );
    const idempotencyKey = deriveControllerIdempotencyKey(
      validatedId,
      "execute",
      validatedInput.expected_goal_version,
      validatedInput.expected_input_revision,
      nextAttempt,
    );
    const runId = deriveControllerRunId(
      idempotencyKey,
      JSON.stringify({ operation: "retry_execute_attempt", input: validatedInput }),
    );
    const activeRun = this.activeRun(runId, idempotencyKey);
    const lease = await this.repository.acquireControllerLease(
      validatedId,
      activeRun,
    );
    if (lease === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
      );
    }

    try {
      const manifestIdentity = {
        work_item_id: validatedId,
        run_id: runId,
        idempotency_key: idempotencyKey,
        phase: "execute" as const,
        goal_version: validatedInput.expected_goal_version,
        input_revision: validatedInput.expected_input_revision,
        attempt: nextAttempt,
      };
      return await this.retryConnectedAttemptWithLease({
        work_item_id: validatedId,
        phase: "execute",
        lease,
        active_run: activeRun,
        manifest_identity: manifestIdentity,
        next_attempt: nextAttempt,
        clear_attention: false,
        validate_current: () =>
          this.validateExecuteExpectation(
            validatedId,
            lease.work_item,
            validatedInput,
          ),
      });
    } finally {
      await this.repository.releaseControllerLease(lease);
    }
  }

  async launchConnectedExecute(
    workItemId: string,
    input: LaunchConnectedInput & { expected_phase: "execute" },
    record: ConnectedRunRecordV2,
  ): Promise<ConnectedLaunchResult> {
    return this.launchConnectedRun(workItemId, input, record);
  }

  async launchConnectedRun(
    workItemId: string,
    input: LaunchConnectedInput,
    record: ConnectedRunRecordV2,
  ): Promise<ConnectedLaunchResult> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const validatedInput = launchConnectedInputSchema.parse(input);
    const validatedRecord = connectedRunRecordV2Schema.parse(record);
    const expectation = this.connectedExpectationFromInput(
      validatedInput,
    );
    const idempotencyKey = deriveControllerIdempotencyKey(
      validatedId,
      validatedInput.expected_phase,
      expectation.expected_goal_version,
      expectation.expected_input_revision,
      expectation.attempt,
    );
    const runId = deriveControllerRunId(
      idempotencyKey,
      JSON.stringify({
        operation: `launch_connected_${validatedInput.expected_phase}`,
        input: validatedInput,
      }),
    );
    const activeRun = this.activeRun(runId, idempotencyKey);
    const lease = await this.repository.acquireControllerLease(
      validatedId,
      activeRun,
    );
    if (lease === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
      );
    }

    try {
      const manifestIdentity = {
        work_item_id: validatedId,
        run_id: runId,
        idempotency_key: idempotencyKey,
        phase: validatedInput.expected_phase,
        goal_version: expectation.expected_goal_version,
        input_revision: expectation.expected_input_revision,
        attempt: expectation.attempt,
      };
      const existing = await this.repository.readControllerRunManifest(
        validatedId,
        runId,
      );
      if (existing !== null) {
        if (
          manifestMatches(existing, manifestIdentity) &&
          this.matchesActiveConnectedState(
            lease.work_item,
            expectation,
            expectation.attempt,
            true,
          )
        ) {
          const activeConnectedRuns = (
            await this.repository.listConnectedRuns(validatedId)
          ).filter((record) => record.lifecycle.status !== "terminal");
          if (activeConnectedRuns.length !== 1) {
            throw this.conflict(
              "repair_required",
              validatedId,
              "A connected launch replay requires exactly one durable active run.",
            );
          }
          const connected = activeConnectedRuns[0];
          await this.validateConnectedMissionReference(
            validatedId,
            connected,
            validatedInput.expected_phase,
            validatedInput.governed_tuple,
            validatedInput.mission_content_sha256,
          );
          if (
            validatedInput.model_override !== undefined &&
            connected.provenance.requested_model.value !==
              validatedInput.model_override
          ) {
            throw this.conflict(
              "idempotency_conflict",
              validatedId,
              "A connected launch replay cannot change its requested one-run model.",
            );
          }
          if (
            connectedRunLaunchFingerprint(connected) !==
            connectedRunLaunchFingerprint(validatedRecord)
          ) {
            throw this.conflict(
              "idempotency_conflict",
              validatedId,
              "A connected launch replay cannot change its phase, mission, tuple, model, or authorization.",
            );
          }
          return {
            work_item: lease.work_item,
            manifest: existing,
            connected_run: connected,
            created: false,
          };
        }
        throw this.conflict(
          "idempotency_conflict",
          validatedId,
          `Run ${runId} already has a non-matching durable result.`,
        );
      }

      await this.validateConnectedLaunch(
        validatedId,
        lease.work_item,
        validatedInput,
        validatedRecord,
      );
      const connected = await this.repository.createConnectedRun(validatedRecord);
      const nextItem = workItemSchema.parse({
        goal: lease.work_item.goal,
        state: {
          ...lease.work_item.state,
          updated_at: nextTimestamp(
            lease.work_item.state.updated_at,
            this.clock,
          ),
        },
      });
      const mutation = await this.repository.commitControllerMutation(lease, {
        goal: nextItem.goal,
        state: nextItem.state,
        manifest: this.pendingManifest(manifestIdentity, activeRun.acquired_at),
      });
      return {
        ...mutation,
        connected_run: connected.record,
        created: connected.created,
      };
    } finally {
      await this.repository.releaseControllerLease(lease);
    }
  }

  async recordConnectedPermissionDenial(
    workItemId: string,
    input: RecordConnectedPermissionDenialInput,
  ): Promise<ControllerMutationResult> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const validatedInput = recordConnectedPermissionDenialInputSchema.parse(
      input,
    );
    const expectation = this.connectedExpectationFromInput(
      validatedInput,
    );
    const idempotencyKey = deriveControllerIdempotencyKey(
      validatedId,
      validatedInput.expected_phase,
      expectation.expected_goal_version,
      expectation.expected_input_revision,
      expectation.attempt,
    );
    const runId = deriveControllerRunId(
      idempotencyKey,
      JSON.stringify({
        operation: "record_connected_permission_denial",
        input: validatedInput,
      }),
    );
    const activeRun = this.activeRun(runId, idempotencyKey);
    const lease = await this.repository.acquireControllerLease(
      validatedId,
      activeRun,
    );
    if (lease === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
      );
    }

    try {
      const manifestIdentity = {
        work_item_id: validatedId,
        run_id: runId,
        idempotency_key: idempotencyKey,
        phase: validatedInput.expected_phase,
        goal_version: expectation.expected_goal_version,
        input_revision: expectation.expected_input_revision,
        attempt: expectation.attempt,
      };
      const existing = await this.repository.readControllerRunManifest(
        validatedId,
        runId,
      );
      if (existing !== null) {
        if (
          manifestMatches(existing, manifestIdentity) &&
          this.matchesMissingPermissionAttention(
            lease.work_item,
            validatedInput,
          )
        ) {
          return { work_item: lease.work_item, manifest: existing };
        }
        throw this.conflict(
          "idempotency_conflict",
          validatedId,
          `Run ${runId} already has a non-matching durable result.`,
        );
      }

      const record = await this.validateConnectedPermissionDenial(
        validatedId,
        lease.work_item,
        validatedInput,
      );
      const updatedAt = nextTimestamp(lease.work_item.state.updated_at, this.clock);
      const nextItem = workItemSchema.parse({
        goal: lease.work_item.goal,
        state: {
          ...lease.work_item.state,
          attention: this.missingPermissionAttention(
            validatedId,
            validatedInput.operation,
            validatedInput.governed_tuple,
            validatedInput.mission_content_sha256,
            record,
            updatedAt,
          ),
          updated_at: updatedAt,
        },
      });
      return await this.repository.commitControllerMutation(lease, {
        goal: nextItem.goal,
        state: nextItem.state,
        manifest: this.pendingManifest(manifestIdentity, activeRun.acquired_at),
      });
    } finally {
      await this.repository.releaseControllerLease(lease);
    }
  }

  async resolveConnectedPermission(
    workItemId: string,
    input: ConnectedPermissionResolutionInput,
  ): Promise<ConnectedPermissionDecisionResult> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const validatedInput = connectedPermissionResolutionInputSchema.parse(input);
    const nextAttempt = this.incrementVersion(
      validatedInput.governed_tuple.attempt,
      validatedId,
      "attempt",
    );
    const idempotencyKey = deriveControllerIdempotencyKey(
      validatedId,
      validatedInput.expected_phase,
      validatedInput.governed_tuple.goal_version,
      validatedInput.governed_tuple.input_revision,
      nextAttempt,
    );
    const runId = deriveControllerRunId(
      idempotencyKey,
      JSON.stringify({
        operation: "resolve_connected_permission",
        input: validatedInput,
      }),
    );
    const activeRun = this.activeRun(runId, idempotencyKey);
    const lease = await this.repository.acquireControllerLease(
      validatedId,
      activeRun,
    );
    if (lease === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
      );
    }

    try {
      const manifestIdentity = {
        work_item_id: validatedId,
        run_id: runId,
        idempotency_key: idempotencyKey,
        phase: validatedInput.expected_phase,
        goal_version: validatedInput.governed_tuple.goal_version,
        input_revision: validatedInput.governed_tuple.input_revision,
        attempt: nextAttempt,
      };
      if (validatedInput.decision === "allow_once") {
        const existing = await this.repository.readControllerRunManifest(
          validatedId,
          runId,
        );
        if (existing !== null) {
          if (
            manifestMatches(existing, manifestIdentity) &&
            existing.capability_grant?.source_mission_content_sha256 ===
              validatedInput.mission_content_sha256 &&
            this.matchesActiveConnectedState(
              lease.work_item,
              {
                expected_phase: validatedInput.expected_phase,
                expected_status: "active",
                expected_schema_version: 2,
                expected_goal_version:
                  validatedInput.governed_tuple.goal_version,
                expected_input_revision:
                  validatedInput.governed_tuple.input_revision,
                attempt: validatedInput.governed_tuple.attempt,
              },
              nextAttempt,
              true,
            )
          ) {
            return { work_item: lease.work_item, manifest: existing };
          }
          throw this.conflict(
            "idempotency_conflict",
            validatedId,
            `Run ${runId} already has a non-matching durable result.`,
          );
        }
      }

      const record = await this.validateConnectedPermissionResolution(
        validatedId,
        lease.work_item,
        validatedInput,
      );
      if (validatedInput.decision === "keep_denied") {
        return { work_item: lease.work_item, manifest: null };
      }
      const capabilityGrant = this.connectedCapabilityGrant(
        lease.work_item,
        record,
      );
      const mutation = await this.retryConnectedAttemptWithLease({
        work_item_id: validatedId,
        phase: validatedInput.expected_phase,
        lease,
        active_run: activeRun,
        manifest_identity: {
          ...manifestIdentity,
          capability_grant: capabilityGrant,
        },
        next_attempt: nextAttempt,
        clear_attention: true,
        validate_current: async () => {
          await this.validateConnectedPermissionResolution(
            validatedId,
            lease.work_item,
            validatedInput,
            record,
          );
        },
      });
      return mutation;
    } finally {
      await this.repository.releaseControllerLease(lease);
    }
  }

  private async retryConnectedAttemptWithLease(input: {
    work_item_id: string;
    phase: "execute" | "patch";
    lease: ControllerLease;
    active_run: ActiveRun;
    manifest_identity: Omit<
      ControllerRunManifest,
      "schema_version" | "started_at" | "completed_at" | "outcome"
    >;
    next_attempt: number;
    clear_attention: boolean;
    validate_current: () => void | Promise<void>;
  }): Promise<ControllerMutationResult> {
    const existing = await this.repository.readControllerRunManifest(
      input.work_item_id,
      input.manifest_identity.run_id,
    );
    if (existing !== null) {
      if (
        manifestMatches(existing, input.manifest_identity) &&
        this.matchesActiveConnectedState(
          input.lease.work_item,
          {
            expected_phase: input.phase,
            expected_status: "active",
            expected_schema_version: 2,
            expected_goal_version: input.manifest_identity.goal_version,
            expected_input_revision: input.manifest_identity.input_revision,
            attempt: input.next_attempt,
          },
          input.next_attempt,
          input.clear_attention,
        )
      ) {
        return { work_item: input.lease.work_item, manifest: existing };
      }
      throw this.conflict(
        "idempotency_conflict",
        input.work_item_id,
        `Run ${input.manifest_identity.run_id} already has a non-matching durable result.`,
      );
    }

    await input.validate_current();
    const nextState = {
      ...input.lease.work_item.state,
      status: "active" as const,
      attempt: input.next_attempt,
      updated_at: nextTimestamp(
        input.lease.work_item.state.updated_at,
        this.clock,
      ),
    };
    if (input.clear_attention) {
      delete nextState.attention;
    }
    const nextItem = workItemSchema.parse({
      goal: input.lease.work_item.goal,
      state: nextState,
    });
    return this.repository.commitControllerMutation(input.lease, {
      goal: nextItem.goal,
      state: nextItem.state,
      manifest: this.pendingManifest(
        input.manifest_identity,
        input.active_run.acquired_at,
      ),
    });
  }

  private connectedExpectationFromInput(input: {
    expected_phase: MissionPhase;
    expected_status: "active";
    expected_schema_version: 2;
    governed_tuple: {
      goal_version: number;
      input_revision: number;
      attempt: number;
    };
  }): ConnectedExpectation {
    return {
      expected_phase: input.expected_phase,
      expected_status: input.expected_status,
      expected_schema_version: input.expected_schema_version,
      expected_goal_version: input.governed_tuple.goal_version,
      expected_input_revision: input.governed_tuple.input_revision,
      attempt: input.governed_tuple.attempt,
    };
  }

  private matchesActiveConnectedState(
    current: WorkItem,
    expectation: ConnectedExpectation,
    attempt: number,
    requires_no_attention: boolean,
  ): boolean {
    return (
      current.state.phase === expectation.expected_phase &&
      current.state.status === "active" &&
      current.state.schema_version === expectation.expected_schema_version &&
      current.state.goal_version === expectation.expected_goal_version &&
      current.state.input_revision === expectation.expected_input_revision &&
      current.state.attempt === attempt &&
      (!requires_no_attention || current.state.attention === undefined)
    );
  }

  private matchesMissingPermissionAttention(
    current: WorkItem,
    input: RecordConnectedPermissionDenialInput,
  ): boolean {
    const attention = current.state.attention;
    return (
      this.matchesActiveConnectedState(
        current,
        this.connectedExpectationFromInput(input),
        input.governed_tuple.attempt,
        false,
      ) &&
      attention?.kind === "missing_permission" &&
      this.governedTuplesMatch(attention.governed_tuple, input.governed_tuple) &&
      attention.pins.mission_content_sha256 === input.mission_content_sha256 &&
      JSON.stringify(attention.operation) === JSON.stringify(input.operation)
    );
  }

  private async validateConnectedLaunch(
    workItemId: string,
    current: WorkItem,
    input: LaunchConnectedInput,
    record: ConnectedRunRecordV2,
  ): Promise<void> {
    this.validateConnectedExpectation(
      workItemId,
      current,
      this.connectedExpectationFromInput(input),
    );
    this.validateGovernedTuple(workItemId, current, input.governed_tuple);
    const priorRuns = await this.repository.listConnectedRuns(workItemId);
    if (priorRuns.some((run) => run.lifecycle.status !== "terminal")) {
      throw this.conflict(
        "lease_held",
        workItemId,
        "A different connected run is already active for this work item.",
      );
    }
    if (
      priorRuns.filter((run) => run.lifecycle.status === "terminal").length !==
      input.run_ordinal
    ) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        "Connected launch ordinal does not match durable run history.",
      );
    }
    if (current.state.attention !== undefined) {
      throw this.conflict(
        "invalid_transition",
        workItemId,
        "A connected run cannot start while the work item requires attention.",
      );
    }
    if (record.lifecycle.status !== "starting") {
      throw this.conflict(
        "invalid_transition",
        workItemId,
        "A controller launch record must be persisted in starting state.",
      );
    }
    if (
      input.model_override !== undefined &&
      record.provenance.requested_model.value !== input.model_override
    ) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        "The connected record does not bind the requested one-run model override.",
      );
    }
    await this.validateConnectedMissionReference(
      workItemId,
      record,
      input.expected_phase,
      input.governed_tuple,
      input.mission_content_sha256,
    );
  }

  private async validateConnectedPermissionDenial(
    workItemId: string,
    current: WorkItem,
    input: RecordConnectedPermissionDenialInput,
  ): Promise<ConnectedRunRecordV2> {
    this.validateConnectedExpectation(
      workItemId,
      current,
      this.connectedExpectationFromInput(input),
    );
    this.validateGovernedTuple(workItemId, current, input.governed_tuple);
    if (current.state.attention !== undefined) {
      throw this.conflict(
        "invalid_transition",
        workItemId,
        "A work item with unresolved attention cannot record a second permission denial.",
      );
    }
    const record = await this.requireConnectedRun(
      workItemId,
      input.operation.connected_run_id,
    );
    await this.validateConnectedMissionReference(
      workItemId,
      record,
      input.expected_phase,
      input.governed_tuple,
      input.mission_content_sha256,
    );
    if (record.authorization.kind !== "capability_envelope") {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        "Connected permission denial requires capability-envelope authorization.",
      );
    }
    if (
      input.operation.resolved_envelope_sha256 !==
      record.authorization.envelope_sha256
    ) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        "The permission denial does not bind the connected run's resolved envelope.",
      );
    }
    if (
      capabilityRequestMatchesEnvelope(
        input.operation.normalized_operation,
        record.authorization.envelope,
      )
    ) {
      throw this.conflict(
        "invalid_transition",
        workItemId,
        "An in-envelope operation cannot produce missing-permission attention.",
      );
    }
    return record;
  }

  private async validateConnectedPermissionResolution(
    workItemId: string,
    current: WorkItem,
    input: ConnectedPermissionResolutionInput,
    knownRecord?: ConnectedRunRecordV2,
  ): Promise<ConnectedRunRecordV2> {
    const expectation: ConnectedExpectation = {
      expected_phase: input.expected_phase,
      expected_status: "active",
      expected_schema_version: 2,
      expected_goal_version: input.governed_tuple.goal_version,
      expected_input_revision: input.governed_tuple.input_revision,
      attempt: input.governed_tuple.attempt,
    };
    this.validateConnectedExpectation(workItemId, current, expectation);
    this.validateGovernedTuple(workItemId, current, input.governed_tuple);
    const attention = current.state.attention;
    if (
      attention?.kind !== "missing_permission" ||
      !this.governedTuplesMatch(attention.governed_tuple, input.governed_tuple) ||
      attention.operation.operation_sha256 !== input.operation_sha256 ||
      attention.operation.connected_run_id !== input.connected_run_id ||
      attention.pins.mission_content_sha256 !== input.mission_content_sha256
    ) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        "The permission decision does not match the exact unresolved attention.",
      );
    }
    const record =
      knownRecord ??
      (await this.requireConnectedRun(workItemId, input.connected_run_id));
    if (record.connected_run_id !== input.connected_run_id) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        "The permission decision does not match the connected run.",
      );
    }
    await this.validateConnectedMissionReference(
      workItemId,
      record,
      input.expected_phase,
      input.governed_tuple,
      input.mission_content_sha256,
    );
    if (record.authorization.kind !== "capability_envelope") {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        "Connected permission resolution requires capability-envelope authorization.",
      );
    }
    if (
      attention.operation.resolved_envelope_sha256 !==
        record.authorization.envelope_sha256 ||
      capabilityRequestMatchesEnvelope(
        attention.operation.normalized_operation,
        record.authorization.envelope,
      )
    ) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        "The permission decision no longer binds an out-of-envelope operation.",
      );
    }
    return record;
  }

  private connectedCapabilityGrant(
    current: WorkItem,
    record: ConnectedRunRecordV2,
  ): ControllerCapabilityGrant {
    const attention = current.state.attention;
    if (
      attention?.kind !== "missing_permission" ||
      record.authorization.kind !== "capability_envelope"
    ) {
      throw this.conflict(
        "stale_expectation",
        current.goal.work_item_id,
        "Connected capability grant requires exact missing-permission attention.",
      );
    }
    const operation = attention.operation.normalized_operation;
    if (operation.kind !== "command" && operation.kind !== "url") {
      throw this.conflict(
        "invalid_transition",
        current.goal.work_item_id,
        "Only an exact command or URL operation can be allowed on a fresh attempt.",
      );
    }
    const executionDefaults = extendExecutionDefaultsWithRequest(
      executionDefaultsFromCapabilityEnvelope(record.authorization.envelope),
      operation,
    );
    return createControllerCapabilityGrant({
      source_mission_content_sha256: record.mission.content_sha256,
      execution_defaults: executionDefaults,
    });
  }

  private async validateConnectedMissionReference(
    workItemId: string,
    record: ConnectedRunRecordV2,
    expectedPhase: MissionPhase,
    governedTuple: {
      goal_version: number;
      input_revision: number;
      attempt: number;
      patch_cycle: number;
    },
    missionContentSha256: string,
  ): Promise<void> {
    if (
      record.mission.identity.work_item_id !== workItemId ||
      record.mission.identity.phase !== expectedPhase ||
      !this.governedTuplesMatch(record.governed_tuple, governedTuple) ||
      record.mission.content_sha256 !== missionContentSha256
    ) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        "The connected record does not match the governed mission tuple.",
      );
    }
    const snapshot = await this.repository.readMissionPackage(
      record.mission.identity,
    );
    if (snapshot.mission.mission_schema_version !== MISSION_SCHEMA_VERSION) {
      throw this.conflict(
        "mission_not_ready",
        workItemId,
        "Historical mission packages cannot start or recover connected execution.",
      );
    }
    if (
      JSON.stringify(snapshot.mission.identity) !==
        JSON.stringify(record.mission.identity) ||
      snapshot.mission_path !== record.mission.path ||
      snapshot.mission.content_sha256 !== record.mission.content_sha256 ||
      snapshot.mission.source_revision.git_base_commit !==
        record.mission.source_commit
    ) {
      throw this.conflict(
        "mission_not_ready",
        workItemId,
        "The connected record does not match the immutable active mission package.",
      );
    }
  }

  private validateGovernedTuple(
    workItemId: string,
    current: WorkItem,
    expected: {
      goal_version: number;
      input_revision: number;
      attempt: number;
      patch_cycle: number;
    },
  ): void {
    const state = current.state;
    if (
      state.goal_version === undefined ||
      state.input_revision === undefined ||
      state.attempt === undefined ||
      state.patch_cycle === undefined ||
      !this.governedTuplesMatch(
        {
          goal_version: state.goal_version,
          input_revision: state.input_revision,
          attempt: state.attempt,
          patch_cycle: state.patch_cycle,
        },
        expected,
      )
    ) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        "Connected execution does not match the durable governed tuple.",
      );
    }
  }

  private governedTuplesMatch(
    left: {
      goal_version: number;
      input_revision: number;
      attempt: number;
      patch_cycle: number;
    },
    right: {
      goal_version: number;
      input_revision: number;
      attempt: number;
      patch_cycle: number;
    },
  ): boolean {
    return (
      left.goal_version === right.goal_version &&
      left.input_revision === right.input_revision &&
      left.attempt === right.attempt &&
      left.patch_cycle === right.patch_cycle
    );
  }

  private async requireConnectedRun(
    workItemId: string,
    connectedRunId: string,
  ): Promise<ConnectedRunRecordV2> {
    const record = await this.repository.readConnectedRun(
      workItemId,
      connectedRunId,
    );
    if (record === null) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        "The exact connected run is no longer available for this decision.",
      );
    }
    return record;
  }

  private missingPermissionAttention(
    workItemId: string,
    operation: MissingPermissionOperation,
    governedTuple: {
      goal_version: number;
      input_revision: number;
      attempt: number;
      patch_cycle: number;
    },
    missionContentSha256: string,
    record: ConnectedRunRecordV2,
    createdAt: string,
  ): WorkItemAttention {
    const runPath = workspaceRelativePosixPathSchema.parse(
      `.founder/connected-runs/${workItemId}/${record.connected_run_id}/run.json`,
    );
    return {
      kind: "missing_permission",
      question: `Allow this exact out-of-envelope operation once and retry the fresh ${record.mission.identity.phase} attempt?`,
      recommendation:
        "Keep it denied unless it is required; allowing once creates a new immutable attempt.",
      created_at: createdAt,
      governed_tuple: governedTuple,
      pins: {
        artifact_paths: [record.mission.path, runPath],
        evidence_paths: [],
        git_commit: record.mission.source_commit,
        mission_content_sha256: missionContentSha256,
      },
      operation,
    };
  }

  private reviewAttention(
    workItem: WorkItem,
    snapshot: ActiveMissionResultSnapshot,
    evidence: ImportEvidenceSummary,
    resultContentSha256: string,
    result: ReviewExternalResultSubmission,
    createdAt: string,
  ): WorkItemAttention {
    const patchCycle = workItem.state.patch_cycle;
    if (
      workItem.state.goal_version === undefined ||
      workItem.state.input_revision === undefined ||
      workItem.state.attempt === undefined ||
      patchCycle === undefined
    ) {
      throw this.conflict(
        "contract_required",
        workItem.goal.work_item_id,
        "Review attention requires a complete governed tuple.",
      );
    }
    const common = {
      created_at: createdAt,
      governed_tuple: {
        goal_version: workItem.state.goal_version,
        input_revision: workItem.state.input_revision,
        attempt: workItem.state.attempt,
        patch_cycle: patchCycle,
      },
      pins: {
        artifact_paths: [
          snapshot.mission_path,
          snapshot.result_path,
        ] as [string, ...string[]],
        evidence_paths: [evidence.evidence_path],
        git_commit: result.accepted_result_commit,
        mission_content_sha256: snapshot.mission.content_sha256,
        result_content_sha256: resultContentSha256,
      },
    };

    if (result.verdict === "clean") {
      return {
        kind: "review_ready",
        question:
          "The pinned result passed deterministic checks and independent review. What human decision should happen next?",
        recommendation:
          "Open the exact review evidence; completion remains governed by the authorized human or policy gate.",
        ...common,
      };
    }

    const unresolvedIds =
      "resolutions" in result
        ? result.resolutions
            .filter((resolution) => resolution.status === "unresolved")
            .map((resolution) => resolution.finding_id)
        : [];
    if (unresolvedIds.length > 0) {
      return {
        kind: "unresolved_finding",
        question: `Assigned ${unresolvedIds.length === 1 ? "finding" : "findings"} ${unresolvedIds.join(", ")} remain unresolved after patch cycle ${patchCycle}. What human decision should happen next?`,
        recommendation:
          "Open the pinned re-review evidence and decide whether to change the goal or scope, pause the item, or handle the residual risk through a later authorized gate.",
        ...common,
      };
    }

    if (patchCycle >= 3) {
      return {
        kind: "cycle_limit",
        question:
          "The three permitted patch cycles are exhausted. What governed human decision should happen next?",
        recommendation:
          "Open the pinned evidence and change the goal or scope, pause or cancel the item, or handle residual risk through a later authorized gate.",
        ...common,
      };
    }

    return {
      kind: "patch_plan_approval",
      question: "Approve one patch that addresses these exact findings?",
      recommendation:
        "Approve the bounded patch plan, or open the work item to change its governed goal or scope.",
      ...common,
    };
  }

  private async currentReviewSubject(
    repository: ControllerWorkItemRepository,
    identity: MissionIdentity<"review">,
    missionSubject: ReviewSubject,
    patchCycle: number,
  ): Promise<ReviewSubject> {
    const currentSubject =
      missionSubject.source === "execute"
        ? (
            await repository.readAppliedExecuteReviewSubject({
              ...identity,
              phase: "execute",
            })
          ).review_subject
        : (
            await repository.readAppliedPatchReviewSubject({
              ...identity,
              phase: "patch",
              patch_cycle: patchCycle,
            })
          ).review_subject;
    return reviewSubjectSchema.parse(currentSubject);
  }

  private async assessReviewResult(
    snapshot: ActiveMissionResultSnapshot,
    identity: ReviewExternalResultSubmission["identity"],
    currentSubject: ReviewSubject,
    validateWorkspace = true,
  ): Promise<ReviewResultAssessment> {
    const mission = snapshot.mission;
    if (!("review_subject" in mission)) {
      return {
        outcome: "rejected",
        reasons: ["Mission snapshot is not a review mission."],
      };
    }

    const reasons: string[] = [];
    if (JSON.stringify(mission.identity) !== JSON.stringify(identity)) {
      reasons.push("Review mission identity does not match the requested governed tuple.");
    }
    if (mission.result_contract.output_path !== snapshot.result_path) {
      reasons.push("Review result path does not match the immutable snapshot path.");
    }
    if (
      JSON.stringify(mission.review_subject) !== JSON.stringify(currentSubject)
    ) {
      reasons.push("Review mission subject is stale or does not match applied execute evidence.");
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(snapshot.result_source);
    } catch {
      return {
        outcome: "rejected",
        reasons: [...reasons, "result.json is not valid JSON."],
      };
    }
    const parsedResult =
      reviewExternalResultSubmissionForSubjectSchema(
        mission.review_subject,
      ).safeParse(parsedJson);
    if (!parsedResult.success) {
      return {
        outcome: "rejected",
        reasons: [
          ...reasons,
          ...parsedResult.error.issues.map(
            (issue) =>
              `result.json ${issue.path.map(String).join(".") || "value"}: ${issue.message}`,
          ),
        ],
      };
    }

    const result = parsedResult.data;
    if (result.review_mission_content_sha256 !== mission.content_sha256) {
      reasons.push("Review result mission hash does not match the immutable review mission.");
    }
    if (JSON.stringify(result.identity) !== JSON.stringify(identity)) {
      reasons.push("Review result identity does not match the requested governed tuple.");
    }
    const deterministicChecks = new Set(
      mission.review_subject.command_evidence.map((record) =>
        record.argv.join(" "),
      ),
    );
    for (const finding of result.findings) {
      switch (finding.link.type) {
        case "acceptance_criteria":
          if (
            !mission.goal.acceptance_criteria.includes(finding.link.criterion)
          ) {
            reasons.push(
              `Review finding ${finding.finding_id} does not name an exact pinned acceptance criterion.`,
            );
          }
          break;
        case "non_goals":
          if (!mission.goal.non_goals.includes(finding.link.non_goal)) {
            reasons.push(
              `Review finding ${finding.finding_id} does not name an exact pinned non-goal.`,
            );
          }
          break;
        case "deterministic_checks":
          if (!deterministicChecks.has(finding.link.command)) {
            reasons.push(
              `Review finding ${finding.finding_id} does not name an exact pinned deterministic check.`,
            );
          }
          break;
        case "defect":
        case "security":
          break;
      }
    }
    if (validateWorkspace) {
      if (
        (await this.git.readHeadCommit()) !==
        currentSubject.accepted_result_commit
      ) {
        reasons.push("Workspace HEAD no longer equals the accepted subject commit.");
      }
      if (!(await this.git.isWorktreeCleanExcludingFounder())) {
        reasons.push("Workspace has uncommitted changes outside .founder/.");
      }
    }

    return reasons.length === 0
      ? { outcome: "applied", reasons: [], result }
      : { outcome: "rejected", reasons, result };
  }

  private async assessExternalResult(
    snapshot: ActiveMissionResultSnapshot,
    identity: ExecuteExternalResultSubmission["identity"],
    manifest: ProductManifest,
  ): Promise<ExternalResultAssessment> {
    const reasons: string[] = [];
    if (JSON.stringify(snapshot.mission.identity) !== JSON.stringify(identity)) {
      reasons.push("Mission identity does not match the requested governed tuple.");
    }
    if (snapshot.mission.result_contract.output_path !== snapshot.result_path) {
      reasons.push("Mission result path does not match the immutable snapshot path.");
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(snapshot.result_source);
    } catch {
      return {
        outcome: "rejected",
        reasons: [...reasons, "result.json is not valid JSON."],
        verification: [],
      };
    }
    const parsedResult =
      executeExternalResultSubmissionSchema.safeParse(parsedJson);
    if (!parsedResult.success) {
      return {
        outcome: "rejected",
        reasons: [
          ...reasons,
          ...parsedResult.error.issues.map(
            (issue) =>
              `result.json ${issue.path.map(String).join(".") || "value"}: ${issue.message}`,
          ),
        ],
        verification: [],
      };
    }
    const result = parsedResult.data;
    if (result.mission_content_sha256 !== snapshot.mission.content_sha256) {
      reasons.push("Result mission hash does not match the immutable mission.");
    }
    if (JSON.stringify(result.identity) !== JSON.stringify(identity)) {
      reasons.push("Result identity does not match the requested governed tuple.");
    }
    if (reasons.length === 0) {
      reasons.push(...(await this.validateGitProof(snapshot, result)));
    }
    if (reasons.length > 0) {
      return { outcome: "rejected", reasons, result, verification: [] };
    }

    const verification = await this.runAuthoritativeVerification(manifest);
    reasons.push(...verification.reasons);

    return reasons.length === 0
      ? {
          outcome: "applied",
          reasons: [],
          result,
          verification: verification.records,
        }
      : {
          outcome: "failed",
          reasons,
          result,
          verification: verification.records,
        };
  }

  private async assessPatchResult(
    snapshot: ActiveMissionResultSnapshot,
    identity: MissionIdentity<"patch">,
    manifest: ProductManifest,
  ): Promise<PatchResultAssessment> {
    const reasons: string[] = [];
    if (!("patch_subject" in snapshot.mission)) {
      return {
        outcome: "rejected",
        reasons: ["Mission snapshot is not a patch mission."],
        verification: [],
      };
    }
    if (JSON.stringify(snapshot.mission.identity) !== JSON.stringify(identity)) {
      reasons.push("Patch mission identity does not match the requested governed tuple.");
    }
    if (snapshot.mission.result_contract.output_path !== snapshot.result_path) {
      reasons.push("Patch result path does not match the immutable snapshot path.");
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(snapshot.result_source);
    } catch {
      return {
        outcome: "rejected",
        reasons: [...reasons, "result.json is not valid JSON."],
        verification: [],
      };
    }
    const parsedResult = patchExternalResultSubmissionSchema.safeParse(parsedJson);
    if (!parsedResult.success) {
      return {
        outcome: "rejected",
        reasons: [
          ...reasons,
          ...parsedResult.error.issues.map(
            (issue) =>
              `result.json ${issue.path.map(String).join(".") || "value"}: ${issue.message}`,
          ),
        ],
        verification: [],
      };
    }
    const result = parsedResult.data;
    if (
      result.patch_mission_content_sha256 !== snapshot.mission.content_sha256
    ) {
      reasons.push("Patch result mission hash does not match the immutable mission.");
    }
    if (JSON.stringify(result.identity) !== JSON.stringify(identity)) {
      reasons.push("Patch result identity does not match the governed tuple.");
    }
    if (reasons.length === 0) {
      reasons.push(...(await this.validateGitProof(snapshot, result)));
    }
    if (reasons.length > 0) {
      return { outcome: "rejected", reasons, result, verification: [] };
    }

    const verification = await this.runAuthoritativeVerification(manifest);
    return verification.reasons.length === 0
      ? {
          outcome: "applied",
          reasons: [],
          result,
          verification: verification.records,
        }
      : {
          outcome: "rejected",
          reasons: verification.reasons,
          result,
          verification: verification.records,
        };
  }

  private async runAuthoritativeVerification(
    manifest: ProductManifest,
  ): Promise<{ reasons: string[]; records: CommandEvidenceRecord[] }> {
    const reasons: string[] = [];
    const records: CommandEvidenceRecord[] = [];
    for (
      let index = 0;
      index < manifest.verification.required_commands.length;
      index += 1
    ) {
      const command = manifest.verification.required_commands[index];
      let record: CommandEvidenceRecord;
      try {
        record = commandEvidenceRecordSchema.parse(
          await this.verificationRunner.run(command),
        );
        if (
          record.name !== command.name ||
          JSON.stringify(record.argv) !== JSON.stringify(command.argv)
        ) {
          throw new Error(
            "verification runner returned evidence for a different command",
          );
        }
      } catch (error) {
        const startedAt = this.clock().toISOString();
        record = commandEvidenceRecordSchema.parse({
          name: command.name,
          argv: command.argv,
          started_at: startedAt,
          completed_at: nextTimestamp(startedAt, this.clock),
          duration_ms: 0,
          status: "spawn_error",
          exit_code: null,
          signal: null,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          output_truncated: false,
        });
      }
      records.push(record);
      if (record.status !== "passed") {
        reasons.push(
          `Required verification command ${command.name} ended with ${record.status}.`,
        );
        for (
          let remaining = index + 1;
          remaining < manifest.verification.required_commands.length;
          remaining += 1
        ) {
          records.push(
            this.notRunEvidence(
              manifest.verification.required_commands[remaining],
            ),
          );
        }
        break;
      }
    }

    return { reasons, records };
  }

  private async validateGitProof(
    snapshot: ActiveMissionResultSnapshot,
    result: ExecuteExternalResultSubmission | PatchExternalResultSubmission,
  ): Promise<string[]> {
    const resolvedCommit = await this.git.resolveCommit(result.commit);
    if (resolvedCommit === null || resolvedCommit !== result.commit) {
      return ["Result commit is not a canonical local commit object."];
    }
    const baseCommit = snapshot.mission.source_revision.git_base_commit;
    if (!(await this.git.isAncestor(baseCommit, resolvedCommit))) {
      return ["Mission Git base is not an ancestor of the result commit."];
    }
    if ((await this.git.readHeadCommit()) !== resolvedCommit) {
      return ["Workspace HEAD does not equal the submitted result commit."];
    }
    if (!(await this.git.isWorktreeCleanExcludingFounder())) {
      return ["Workspace has uncommitted changes outside .founder/."];
    }

    const changedFiles = await this.git.listChangedFiles(
      baseCommit,
      resolvedCommit,
    );
    if (changedFiles.length === 0) {
      return ["Git reports no changed files for the result commit."];
    }
    for (const path of changedFiles) {
      if (!workspaceRelativePosixPathSchema.safeParse(path).success) {
        return [`Git reported an unsafe changed path: ${path}`];
      }
      if (path === ".founder" || path.startsWith(".founder/")) {
        return [`Controller-owned path is outside external result scope: ${path}`];
      }
      if (
        !snapshot.mission.goal.allowed_scope.some((scopeEntry) =>
          scopeMatchesPath(scopeEntry, path),
        )
      ) {
        return [`Changed path is outside allowed_scope: ${path}`];
      }
    }
    const canonicalGitFiles = [...changedFiles].sort();
    const canonicalReportedFiles = [...result.changed_files].sort();
    if (
      JSON.stringify(canonicalGitFiles) !==
      JSON.stringify(canonicalReportedFiles)
    ) {
      return ["Result changed_files do not exactly match the Git diff."];
    }
    return [];
  }

  private async buildScopeCorrectionProposal(
    item: WorkItem,
  ): Promise<ScopeCorrectionProposalV1 | null> {
    const contract = item.goal.goal_contract;
    const state = item.state;
    if (
      contract === undefined ||
      state.phase !== "execute" ||
      state.status !== "active" ||
      state.goal_version === undefined ||
      state.input_revision === undefined ||
      state.attempt === undefined ||
      state.patch_cycle === undefined ||
      state.goal_version !== contract.goal_version ||
      state.active_run !== undefined
    ) {
      return null;
    }
    if (this.git.listWorktreeChangedFilesExcludingFounder === undefined) {
      return null;
    }
    const changedFiles =
      await this.git.listWorktreeChangedFilesExcludingFounder();
    if (changedFiles.length === 0) {
      return null;
    }
    for (const path of changedFiles) {
      if (
        !workspaceRelativePosixPathSchema.safeParse(path).success ||
        path === ".founder" ||
        path.startsWith(".founder/")
      ) {
        throw this.conflict(
          "repair_required",
          item.goal.work_item_id,
          `Git reported an unsafe scope-correction path: ${path}`,
        );
      }
    }
    const proposedAllowedScope = [...new Set(changedFiles)].sort();
    if (
      proposedAllowedScope.every((path) =>
        contract.allowed_scope.some((entry) => scopeMatchesPath(entry, path)),
      )
    ) {
      return null;
    }
    const content = {
      schema_version: 1 as const,
      work_item_id: item.goal.work_item_id,
      source_goal_contract_sha256: hashGoalContract(contract),
      governed_tuple: {
        goal_version: state.goal_version,
        input_revision: state.input_revision,
        attempt: state.attempt,
        patch_cycle: state.patch_cycle,
      },
      current_allowed_scope: [...contract.allowed_scope],
      proposed_allowed_scope: proposedAllowedScope,
    };
    return scopeCorrectionProposalSchema.parse({
      ...content,
      proposal_sha256: hashScopeCorrectionProposal(content),
    });
  }

  private async currentWritableMission(
    item: WorkItem,
    expectedPhase: "execute" | "patch",
  ): Promise<{
    mission: ReadableMissionPackage;
    mission_path: string;
  }> {
    const state = item.state;
    if (
      state.phase !== expectedPhase ||
      state.status !== "active" ||
      state.goal_version === undefined ||
      state.input_revision === undefined ||
      state.attempt === undefined ||
      state.patch_cycle === undefined ||
      item.goal.goal_contract?.goal_version !== state.goal_version
    ) {
      throw this.conflict(
        "stale_expectation",
        item.goal.work_item_id,
        "Command authorization requires one current active writable tuple.",
      );
    }
    const identity: MissionIdentity<"execute"> | MissionIdentity<"patch"> =
      expectedPhase === "execute"
        ? {
            phase: "execute",
            work_item_id: item.goal.work_item_id,
            goal_version: state.goal_version,
            input_revision: state.input_revision,
            attempt: state.attempt,
          }
        : {
            phase: "patch",
            work_item_id: item.goal.work_item_id,
            goal_version: state.goal_version,
            input_revision: state.input_revision,
            attempt: state.attempt,
            patch_cycle: state.patch_cycle,
          };
    const snapshot = await this.repository.readMissionPackage(identity);
    if (
      snapshot.mission.identity.phase !== expectedPhase ||
      !isDeepStrictEqual(snapshot.mission.identity, identity) ||
      !("capability_envelope" in snapshot.mission)
    ) {
      throw this.conflict(
        "stale_expectation",
        item.goal.work_item_id,
        "The current writable mission is absent or does not match its governed tuple.",
      );
    }
    return snapshot;
  }

  private async buildCommandAuthorizationProposal(
    item: WorkItem,
    mission: ReadableMissionPackage,
  ): Promise<CommandAuthorizationProposalV1> {
    const phase = item.state.phase;
    if (
      (phase !== "execute" && phase !== "patch") ||
      item.state.status !== "active" ||
      item.state.goal_version === undefined ||
      item.state.input_revision === undefined ||
      item.state.attempt === undefined ||
      item.state.patch_cycle === undefined ||
      mission.identity.phase !== phase ||
      !("capability_envelope" in mission)
    ) {
      throw this.conflict(
        "stale_expectation",
        item.goal.work_item_id,
        "Command authorization requires an active writable mission.",
      );
    }
    const governedTuple = {
      goal_version: item.state.goal_version,
      input_revision: item.state.input_revision,
      attempt: item.state.attempt,
      patch_cycle: item.state.patch_cycle,
    };
    const runs = (await this.repository.listConnectedRuns(
      item.goal.work_item_id,
    ))
      .filter(
        (run) =>
          run.mission.identity.phase === phase &&
          run.lifecycle.status === "terminal",
      )
      .sort(
        (left, right) =>
          right.lifecycle.updated_at.localeCompare(left.lifecycle.updated_at) ||
          right.connected_run_id.localeCompare(left.connected_run_id),
      );
    const latest = runs[0];
    if (
      latest === undefined ||
      latest.lifecycle.terminal?.outcome !== "completed" ||
      latest.lifecycle.terminal.partial
    ) {
      throw this.conflict(
        "mission_not_ready",
        item.goal.work_item_id,
        "Command authorization requires a latest complete writable run with no result.",
      );
    }
    const evidence = await this.repository.listImportEvidence(
      item.goal.work_item_id,
    );
    if (
      evidence.some(
        (stored) =>
          stored.evidence.mission_content_sha256 ===
          latest.mission.content_sha256,
      )
    ) {
      throw this.conflict(
        "mission_not_ready",
        item.goal.work_item_id,
        "The latest writable run already has immutable import evidence.",
      );
    }
    if (this.git.listWorktreeChangedFilesExcludingFounder === undefined) {
      throw this.conflict(
        "mission_not_ready",
        item.goal.work_item_id,
        "The Git adapter cannot derive an exact worktree proposal.",
      );
    }
    const changedFiles = [
      ...new Set(await this.git.listWorktreeChangedFilesExcludingFounder()),
    ].sort();
    if (changedFiles.length === 0) {
      throw this.conflict(
        "mission_not_ready",
        item.goal.work_item_id,
        "The retained worktree is clean; no command authorization is needed.",
      );
    }
    for (const path of changedFiles) {
      if (
        !workspaceRelativePosixPathSchema.safeParse(path).success ||
        path === ".founder" ||
        path.startsWith(".founder/") ||
        !mission.goal.allowed_scope.some((scopeEntry) =>
          scopeMatchesPath(scopeEntry, path),
        )
      ) {
        throw this.conflict(
          "mission_not_ready",
          item.goal.work_item_id,
          `The retained worktree path is outside the current mission scope: ${path}`,
        );
      }
    }
    const manifest = await this.repository.readManifest();
    const [firstRequiredCommand, ...remainingRequiredCommands] =
      manifest.verification.required_commands;
    const commandOperation = (command: ProductManifest["verification"]["required_commands"][number]) => ({
        schema_version: 1 as const,
        kind: "command" as const,
        executable: command.argv[0],
        args: command.argv.slice(1),
      });
    const commands: CommandAuthorizationProposalV1["commands"] = [
      commandOperation(firstRequiredCommand),
      ...remainingRequiredCommands.map(commandOperation),
      {
        schema_version: 1 as const,
        kind: "command" as const,
        executable: "git",
        args: [
          "add",
          "--",
          ...changedFiles.map(shellLiteralPathPattern),
        ],
      },
      {
        schema_version: 1 as const,
        kind: "command" as const,
        executable: "git",
        args: ["commit", "-m", item.goal.title],
      },
    ];
    const content = {
      schema_version: 1 as const,
      phase,
      work_item_id: item.goal.work_item_id,
      governed_tuple: governedTuple,
      source_mission_content_sha256: mission.content_sha256,
      terminal_connected_run_id: latest.connected_run_id,
      changed_files: changedFiles,
      commands,
    };
    return commandAuthorizationProposalSchema.parse({
      ...content,
      proposal_sha256: hashCommandAuthorizationProposal(content),
    });
  }

  private reconcileStoredAcceptPatchPlan(
    lease: ControllerLease,
    existingManifest: ControllerRunManifest,
    manifestIdentity: {
      work_item_id: string;
      run_id: string;
      idempotency_key: string;
      phase: "patch";
      goal_version: number;
      input_revision: number;
      attempt: number;
    },
    nextPatchCycle: number,
  ): ControllerMutationResult {
    if (
      manifestMatches(existingManifest, manifestIdentity) &&
      lease.work_item.state.phase === "patch" &&
      lease.work_item.state.status === "active" &&
      lease.work_item.state.goal_version === manifestIdentity.goal_version &&
      lease.work_item.state.input_revision ===
        manifestIdentity.input_revision &&
      lease.work_item.state.attempt === manifestIdentity.attempt &&
      lease.work_item.state.patch_cycle === nextPatchCycle &&
      lease.work_item.state.attention === undefined
    ) {
      return { work_item: lease.work_item, manifest: existingManifest };
    }
    throw this.conflict(
      "idempotency_conflict",
      manifestIdentity.work_item_id,
      `Patch-plan run ${manifestIdentity.run_id} already has a non-matching durable result.`,
    );
  }

  private async reconcileStoredPatchImport(
    repository: ControllerWorkItemRepository,
    lease: ControllerLease,
    existingManifest: ControllerRunManifest | null,
    stored: StoredImportEvidence,
    input: ImportPatchResultInput,
    activeRun: ActiveRun,
    idempotencyKey: string,
    snapshot: ActiveMissionResultSnapshot,
  ): Promise<ImportPatchResultResult> {
    const workItemId = lease.work_item.goal.work_item_id;
    const identity: MissionIdentity<"patch"> = {
      phase: "patch",
      work_item_id: workItemId,
      goal_version: input.expected_goal_version,
      input_revision: input.expected_input_revision,
      attempt: input.attempt,
      patch_cycle: input.expected_patch_cycle,
    };
    if (!("patch_subject" in snapshot.mission)) {
      throw this.conflict(
        "repair_required",
        workItemId,
        "Stored patch evidence is not backed by a patch mission snapshot.",
      );
    }
    const resultContentSha256 = hashResultContent(snapshot.result_source);
    const importRunId = createImportRunId(
      snapshot.mission.content_sha256,
      resultContentSha256,
    );
    const parsed = patchExternalResultSubmissionSchema.safeParse(
      (() => {
        try {
          return JSON.parse(snapshot.result_source) as unknown;
        } catch {
          return null;
        }
      })(),
    );
    const result = parsed.success ? parsed.data : undefined;
    if (
      stored.evidence.phase !== "patch" ||
      stored.evidence.controller_run_id !== activeRun.run_id ||
      stored.evidence.import_run_id !== importRunId ||
      JSON.stringify(stored.evidence.identity) !== JSON.stringify(identity) ||
      stored.evidence.mission_content_sha256 !==
        snapshot.mission.content_sha256 ||
      stored.evidence.result_content_sha256 !== resultContentSha256 ||
      stored.evidence.git_base_commit !==
        snapshot.mission.source_revision.git_base_commit ||
      stored.summary.import_run_id !== stored.evidence.import_run_id ||
      stored.summary.phase !== "patch" ||
      stored.summary.outcome !== stored.evidence.outcome ||
      JSON.stringify(stored.summary.reasons) !==
        JSON.stringify(stored.evidence.reasons)
    ) {
      throw this.conflict(
        "repair_required",
        workItemId,
        "Stored patch import evidence does not match its controller run or summary.",
      );
    }

    if (stored.evidence.outcome === "rejected") {
      this.validatePatchExpectation(workItemId, lease.work_item, input);
      if (existingManifest !== null) {
        throw this.conflict(
          "idempotency_conflict",
          workItemId,
          `Rejected patch run ${activeRun.run_id} must not have a controller manifest.`,
        );
      }
      return {
        work_item: lease.work_item,
        manifest: null,
        evidence: stored.summary,
        ...(result === undefined ? {} : { result }),
      };
    }

    if (
      result === undefined ||
      result.patch_mission_content_sha256 !== snapshot.mission.content_sha256 ||
      JSON.stringify(result.identity) !== JSON.stringify(identity) ||
      stored.evidence.result_commit !== result.commit ||
      stored.verification.length === 0
    ) {
      throw this.conflict(
        "repair_required",
        workItemId,
        "Applied patch evidence no longer validates for recovery.",
      );
    }
    const requiredCommands = (await repository.readManifest()).verification
      .required_commands;
    if (
      stored.verification.length !== requiredCommands.length ||
      stored.verification.some(
        (record, index) =>
          record.name !== requiredCommands[index]?.name ||
          JSON.stringify(record.argv) !==
            JSON.stringify(requiredCommands[index]?.argv) ||
          record.status !== "passed" ||
          record.started_at === null ||
          record.completed_at === null ||
          record.exit_code !== 0 ||
          record.signal !== null,
      )
    ) {
      throw this.conflict(
        "repair_required",
        workItemId,
        "Applied patch evidence does not match the required command set.",
      );
    }
    const manifestIdentity = {
      work_item_id: workItemId,
      run_id: activeRun.run_id,
      idempotency_key: idempotencyKey,
      phase: "review" as const,
      goal_version: input.expected_goal_version,
      input_revision: input.expected_input_revision,
      attempt: input.attempt,
    };
    const isTargetState =
      lease.work_item.state.phase === "review" &&
      lease.work_item.state.status === "active" &&
      lease.work_item.state.goal_version === input.expected_goal_version &&
      lease.work_item.state.input_revision === input.expected_input_revision &&
      lease.work_item.state.attempt === input.attempt &&
      lease.work_item.state.patch_cycle === input.expected_patch_cycle &&
      lease.work_item.state.attention === undefined;
    if (existingManifest !== null) {
      if (manifestMatches(existingManifest, manifestIdentity) && isTargetState) {
        return {
          work_item: lease.work_item,
          manifest: existingManifest,
          evidence: stored.summary,
          result,
        };
      }
      throw this.conflict(
        "idempotency_conflict",
        workItemId,
        `Patch run ${activeRun.run_id} already has a non-matching durable result.`,
      );
    }
    if (!isTargetState) {
      this.validatePatchExpectation(workItemId, lease.work_item, input);
    }
    const nextItem = workItemSchema.parse({
      goal: lease.work_item.goal,
      state: {
        ...withoutAttention(lease.work_item.state),
        phase: "review",
        status: "active",
        updated_at: isTargetState
          ? lease.work_item.state.updated_at
          : nextTimestamp(lease.work_item.state.updated_at, this.clock),
      },
    });
    const mutation = await repository.commitControllerMutation(lease, {
      goal: nextItem.goal,
      state: nextItem.state,
      manifest: this.pendingManifest(manifestIdentity, activeRun.acquired_at),
    });
    return {
      ...mutation,
      evidence: stored.summary,
      result,
    };
  }

  private async reconcileStoredReviewImport(
    repository: ControllerWorkItemRepository,
    lease: ControllerLease,
    existingManifest: ControllerRunManifest | null,
    stored: StoredImportEvidence,
    input: ImportReviewResultInput,
    activeRun: ActiveRun,
    idempotencyKey: string,
    snapshot: ActiveMissionResultSnapshot,
  ): Promise<ImportReviewResultResult> {
    const workItemId = lease.work_item.goal.work_item_id;
    const identity = {
      phase: "review" as const,
      work_item_id: workItemId,
      goal_version: input.expected_goal_version,
      input_revision: input.expected_input_revision,
      attempt: input.attempt,
    };
    if (!("review_subject" in snapshot.mission)) {
      throw this.conflict(
        "repair_required",
        workItemId,
        "Stored review evidence is not backed by a review mission snapshot.",
      );
    }
    if (
      stored.evidence.phase !== "review" ||
      stored.evidence.controller_run_id !== activeRun.run_id ||
      JSON.stringify(stored.evidence.identity) !== JSON.stringify(identity) ||
      stored.evidence.mission_content_sha256 !==
        snapshot.mission.content_sha256 ||
      stored.evidence.result_content_sha256 !==
        hashResultContent(snapshot.result_source) ||
      stored.evidence.git_base_commit !==
        snapshot.mission.review_subject.git_base_commit ||
      stored.evidence.result_commit !==
        snapshot.mission.review_subject.accepted_result_commit ||
      stored.summary.import_run_id !== stored.evidence.import_run_id ||
      stored.summary.phase !== "review" ||
      stored.summary.outcome !== stored.evidence.outcome ||
      JSON.stringify(stored.summary.reasons) !==
        JSON.stringify(stored.evidence.reasons) ||
      stored.verification.length !== 0
    ) {
      throw this.conflict(
        "repair_required",
        workItemId,
        "Stored review import evidence does not match its controller run or summary.",
      );
    }
    this.validateReviewExpectation(workItemId, lease.work_item, input);

    let result: ReviewExternalResultSubmission | undefined;
    try {
      const parsed = reviewExternalResultSubmissionForSubjectSchema(
        snapshot.mission.review_subject,
      ).safeParse(JSON.parse(snapshot.result_source));
      result = parsed.success ? parsed.data : undefined;
    } catch {
      result = undefined;
    }

    if (stored.evidence.outcome === "rejected") {
      if (existingManifest !== null) {
        throw this.conflict(
          "idempotency_conflict",
          workItemId,
          `Rejected review run ${activeRun.run_id} must not have a controller manifest.`,
        );
      }
      return {
        work_item: lease.work_item,
        manifest: null,
        evidence: stored.summary,
        ...(result === undefined ? {} : { result }),
      };
    }

    const manifestIdentity = {
      work_item_id: workItemId,
      run_id: activeRun.run_id,
      idempotency_key: idempotencyKey,
      phase: "review" as const,
      goal_version: input.expected_goal_version,
      input_revision: input.expected_input_revision,
      attempt: input.attempt,
    };
    const currentSubject = await this.currentReviewSubject(
      repository,
      identity,
      snapshot.mission.review_subject,
      input.expected_patch_cycle,
    );
    const assessment = await this.assessReviewResult(
      snapshot,
      identity,
      currentSubject,
      false,
    );
    if (assessment.outcome !== "applied") {
      throw this.conflict(
        "repair_required",
        workItemId,
        "Applied review evidence no longer validates for state-preserving recovery.",
      );
    }

    const attention = this.reviewAttention(
      lease.work_item,
      snapshot,
      stored.summary,
      stored.evidence.result_content_sha256,
      assessment.result!,
      stored.evidence.completed_at,
    );
    if (existingManifest !== null) {
      if (
        manifestMatches(existingManifest, manifestIdentity) &&
        JSON.stringify(lease.work_item.state.attention) ===
          JSON.stringify(attention)
      ) {
        return {
          work_item: lease.work_item,
          manifest: existingManifest,
          evidence: stored.summary,
          result: assessment.result,
        };
      }
      throw this.conflict(
        "idempotency_conflict",
        workItemId,
        `Review run ${activeRun.run_id} already has a non-matching durable result.`,
      );
    }

    const nextItem = workItemSchema.parse({
      goal: lease.work_item.goal,
      state: {
        ...lease.work_item.state,
        attention,
        updated_at: nextTimestamp(
          lease.work_item.state.updated_at,
          this.clock,
        ),
      },
    });
    const mutation = await repository.commitControllerMutation(lease, {
      goal: nextItem.goal,
      state: nextItem.state,
      manifest: this.pendingManifest(manifestIdentity, activeRun.acquired_at),
    });
    return {
      ...mutation,
      evidence: stored.summary,
      result: assessment.result,
    };
  }

  private async reconcileStoredImport(
    repository: ControllerWorkItemRepository,
    lease: ControllerLease,
    existingManifest: ControllerRunManifest | null,
    stored: StoredImportEvidence,
    input: ImportExternalResultInput,
    activeRun: ActiveRun,
    idempotencyKey: string,
  ): Promise<ImportExternalResultResult> {
    const workItemId = lease.work_item.goal.work_item_id;
    if (
      stored.evidence.controller_run_id !== activeRun.run_id ||
      JSON.stringify(stored.evidence.identity) !==
        JSON.stringify({
          phase: "execute",
          work_item_id: workItemId,
          goal_version: input.expected_goal_version,
          input_revision: input.expected_input_revision,
          attempt: input.attempt,
        }) ||
      stored.summary.import_run_id !== stored.evidence.import_run_id ||
      stored.summary.phase !== stored.evidence.phase ||
      stored.summary.outcome !== stored.evidence.outcome ||
      JSON.stringify(stored.summary.reasons) !==
        JSON.stringify(stored.evidence.reasons)
    ) {
      throw this.conflict(
        "repair_required",
        workItemId,
        "Stored import evidence does not match its controller run or summary.",
      );
    }
    const outcome = stored.evidence.outcome;
    const targetPhase: WorkItemPhase =
      outcome === "applied" ? "review" : "execute";
    const targetStatus: WorkItemStatus =
      outcome === "applied" ? "active" : "blocked";
    const manifestIdentity = {
      work_item_id: workItemId,
      run_id: activeRun.run_id,
      idempotency_key: idempotencyKey,
      phase: targetPhase,
      goal_version: input.expected_goal_version,
      input_revision: input.expected_input_revision,
      attempt: input.attempt,
    };
    const isTargetState =
      lease.work_item.state.phase === targetPhase &&
      lease.work_item.state.status === targetStatus &&
      lease.work_item.state.goal_version === input.expected_goal_version &&
      lease.work_item.state.input_revision === input.expected_input_revision &&
      lease.work_item.state.attempt === input.attempt;
    if (existingManifest !== null) {
      if (manifestMatches(existingManifest, manifestIdentity) && isTargetState) {
        return {
          work_item: lease.work_item,
          manifest: existingManifest,
          evidence: stored.summary,
        };
      }
      throw this.conflict(
        "idempotency_conflict",
        workItemId,
        `Run ${activeRun.run_id} already has a non-matching durable result.`,
      );
    }
    if (!isTargetState) {
      this.validateExecuteExpectation(workItemId, lease.work_item, input);
    }

    const nextItem = workItemSchema.parse({
      goal: lease.work_item.goal,
      state: {
        ...lease.work_item.state,
        phase: targetPhase,
        status: targetStatus,
        updated_at: isTargetState
          ? lease.work_item.state.updated_at
          : nextTimestamp(lease.work_item.state.updated_at, this.clock),
      },
    });
    const mutation = await repository.commitControllerMutation(lease, {
      goal: nextItem.goal,
      state: nextItem.state,
      manifest: this.pendingManifest(
        manifestIdentity,
        activeRun.acquired_at,
      ),
    });
    return { ...mutation, evidence: stored.summary };
  }

  private notRunEvidence(
    command: ProductManifest["verification"]["required_commands"][number],
  ): CommandEvidenceRecord {
    return commandEvidenceRecordSchema.parse({
      name: command.name,
      argv: command.argv,
      started_at: null,
      completed_at: null,
      duration_ms: 0,
      status: "not_run",
      exit_code: null,
      signal: null,
      stdout: "",
      stderr: "",
      output_truncated: false,
    });
  }

  private validateExecuteExpectation(
    workItemId: string,
    current: WorkItem,
    input: ExecuteExpectation,
  ): void {
    if (current.goal.goal_contract === undefined) {
      throw this.conflict(
        "contract_required",
        workItemId,
        "External result operations require an active goal contract.",
      );
    }
    if (
      current.state.phase !== input.expected_phase ||
      current.state.status !== input.expected_status ||
      current.state.schema_version !== input.expected_schema_version ||
      current.state.goal_version !== input.expected_goal_version ||
      current.state.input_revision !== input.expected_input_revision
    ) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        "External result expectations do not match durable state.",
      );
    }
    if (current.state.attempt !== input.attempt) {
      throw this.conflict(
        "attempt_conflict",
        workItemId,
        `Expected attempt ${input.attempt} but found ${current.state.attempt}.`,
      );
    }
  }

  private validateConnectedExpectation(
    workItemId: string,
    current: WorkItem,
    input: ConnectedExpectation,
  ): void {
    if (current.goal.goal_contract === undefined) {
      throw this.conflict(
        "contract_required",
        workItemId,
        "Connected launches require an active goal contract.",
      );
    }
    if (
      current.state.phase !== input.expected_phase ||
      current.state.status !== input.expected_status ||
      current.state.schema_version !== input.expected_schema_version ||
      current.state.goal_version !== input.expected_goal_version ||
      current.state.input_revision !== input.expected_input_revision
    ) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        "Connected launch expectations do not match durable state.",
      );
    }
    if (current.state.attempt !== input.attempt) {
      throw this.conflict(
        "attempt_conflict",
        workItemId,
        `Expected attempt ${input.attempt} but found ${current.state.attempt}.`,
      );
    }
  }

  private validateReviewExpectation(
    workItemId: string,
    current: WorkItem,
    input: ImportReviewResultInput | AcceptPatchPlanInput,
  ): void {
    if (current.goal.goal_contract === undefined) {
      throw this.conflict(
        "contract_required",
        workItemId,
        "Review result import requires an active goal contract.",
      );
    }
    if (
      current.state.phase !== input.expected_phase ||
      current.state.status !== input.expected_status ||
      current.state.schema_version !== input.expected_schema_version ||
      current.state.goal_version !== input.expected_goal_version ||
      current.state.input_revision !== input.expected_input_revision
    ) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        "Review result expectations do not match durable state.",
      );
    }
    if (current.state.attempt !== input.attempt) {
      throw this.conflict(
        "attempt_conflict",
        workItemId,
        `Expected attempt ${input.attempt} but found ${current.state.attempt}.`,
      );
    }
    if (current.state.patch_cycle !== input.expected_patch_cycle) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        `Expected patch cycle ${input.expected_patch_cycle} but found ${current.state.patch_cycle}.`,
      );
    }
  }

  private validatePatchExpectation(
    workItemId: string,
    current: WorkItem,
    input: ImportPatchResultInput,
  ): void {
    if (current.goal.goal_contract === undefined) {
      throw this.conflict(
        "contract_required",
        workItemId,
        "Patch result import requires an active goal contract.",
      );
    }
    if (
      current.state.phase !== input.expected_phase ||
      current.state.status !== input.expected_status ||
      current.state.schema_version !== input.expected_schema_version ||
      current.state.goal_version !== input.expected_goal_version ||
      current.state.input_revision !== input.expected_input_revision ||
      current.state.attempt !== input.attempt ||
      current.state.patch_cycle !== input.expected_patch_cycle
    ) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        "Patch result expectations do not match durable state.",
      );
    }
  }

  private requireActiveMissionSnapshot(
    snapshot: MissionResultSnapshot,
    workItemId: string,
  ): asserts snapshot is ActiveMissionResultSnapshot {
    if (
      snapshot.mission.mission_schema_version !== MISSION_SCHEMA_VERSION
    ) {
      throw this.conflict(
        "mission_not_ready",
        workItemId,
        "Historical mission packages are read-only and cannot drive an active controller operation.",
      );
    }
  }

  private shapingRepository(): ShapingDecisionRepository {
    return this.repository as ShapingDecisionRepository;
  }

  private async prepareShapingDecision(
    operation: ShapingDecisionOperation,
    item: WorkItem,
    artifacts: StoredShapingArtifact[],
    input:
      | z.output<typeof startBrainstormDecisionInputSchema>
      | z.output<typeof shapingResultDecisionInputSchema>
      | z.output<typeof requestShapingChangesInputSchema>
      | z.output<typeof approveSpecDecisionInputSchema>
      | z.output<typeof replanWithUpdatedContractInputSchema>,
  ): Promise<PreparedShapingDecision> {
    const workItemId = item.goal.work_item_id;
    if (item.state.status !== "active" || item.state.schema_version !== 2) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        "Shaping decisions require an active schema-v2 work item.",
      );
    }
    const goalInput = normalizeShapingGoalInput(item.goal);

    if (operation === "start_brainstorm") {
      if (item.state.phase !== "idea") {
        throw this.conflict(
          "stale_expectation",
          workItemId,
          "Start Brainstorm requires the durable item to remain in Idea.",
        );
      }
      if (
        item.goal.goal_contract !== undefined ||
        item.state.goal_version !== undefined ||
        item.state.input_revision !== undefined
      ) {
        throw this.conflict(
          "stale_expectation",
          workItemId,
          "Start Brainstorm requires an ungoverned Idea item.",
        );
      }
      if (artifacts.length !== 0) {
        throw this.conflict(
          "stale_expectation",
          workItemId,
          "Start Brainstorm requires no existing shaping mission.",
        );
      }
      return {
        phase_from: "idea",
        phase_to: "brainstorm",
        next_state: workItemStateSchema.parse({
          ...item.state,
          phase: "brainstorm",
          updated_at: nextTimestamp(item.state.updated_at, this.clock),
        }),
        next_mission: compileBrainstormMission({
          work_item_id: workItemId,
          shaping_input: { phase: "brainstorm", ...goalInput },
        }),
        decision_receipt: null,
        plan_repository_base_commit: null,
        plan_goal_contract_sha256: null,
        plan_goal_version: null,
      };
    }

    if (operation === "request_changes") {
      const validated = requestShapingChangesInputSchema.parse(input);
      const phase = this.requireShapingPhase(item);
      const artifact = this.requireBoundAppliedShapingTip(
        workItemId,
        phase,
        artifacts,
        validated.expected_mission_content_sha256,
        validated.expected_result_content_sha256,
      );
      if (phase === "plan") {
        this.assertPlanMissionUsesCurrentContract(item, artifact);
      }
      const revision = {
        ordinal: (artifact.mission.input.revision?.ordinal ?? 0) + 1,
        supersedes_input_sha256:
          artifact.mission.identity.input_sha256,
        superseded_result_sha256:
          validated.expected_result_content_sha256,
        feedback: validated.feedback,
      };
      let nextMission: ShapingMissionPackage;
      switch (phase) {
        case "brainstorm": {
          const currentMission =
            artifact.mission as BrainstormMissionPackage;
          nextMission = compileBrainstormMission({
            work_item_id: workItemId,
            shaping_input: {
              ...currentMission.input,
              ...goalInput,
              phase,
              revision,
            },
          });
          break;
        }
        case "spec": {
          const currentMission = artifact.mission as SpecMissionPackage;
          nextMission = compileSpecMission({
            work_item_id: workItemId,
            shaping_input: {
              ...currentMission.input,
              ...goalInput,
              phase,
              revision,
            },
          });
          break;
        }
        case "plan": {
          const currentMission = artifact.mission as PlanMissionPackage;
          nextMission = compilePlanMission({
            work_item_id: workItemId,
            shaping_input: {
              ...currentMission.input,
              ...goalInput,
              phase,
              revision,
            },
          });
          break;
        }
      }
      const nextPlanMission =
        phase === "plan" ? (nextMission as PlanMissionPackage) : null;
      return {
        phase_from: phase,
        phase_to: phase,
        next_state: workItemStateSchema.parse({
          ...item.state,
          updated_at: nextTimestamp(item.state.updated_at, this.clock),
        }),
        next_mission: nextMission,
        decision_receipt: null,
        plan_repository_base_commit:
          nextPlanMission?.input.repository_base_commit ?? null,
        plan_goal_contract_sha256:
          nextPlanMission?.input.goal_contract_sha256 ?? null,
        plan_goal_version: nextPlanMission?.input.goal_version ?? null,
      };
    }

    if (operation === "use_brainstorm_result") {
      const validated = shapingResultDecisionInputSchema.parse(input);
      this.requirePhase(item, "brainstorm");
      this.requireUngovernedShapingItem(item);
      const artifact = this.requireBoundAppliedShapingTip(
        workItemId,
        "brainstorm",
        artifacts,
        validated.expected_mission_content_sha256,
        validated.expected_result_content_sha256,
      );
      if (artifact.decision !== null) {
        throw this.conflict(
          "stale_expectation",
          workItemId,
          "The Brainstorm revision already carries a decision receipt.",
        );
      }
      const result = brainstormResultSubmissionSchema.parse(
        JSON.parse(artifact.result!.result_source) as unknown,
      );
      const receipt: ShapingDecisionReceipt = {
        shaping_schema_version: 2,
        identity: result.identity,
        mission_content_sha256:
          validated.expected_mission_content_sha256,
        result_content_sha256: validated.expected_result_content_sha256,
        selected_at: this.clock().toISOString(),
      };
      const nextMission = compileSpecMission({
        work_item_id: workItemId,
        shaping_input: {
          phase: "spec",
          ...goalInput,
          brainstorm_selection_sha256: this.hashSource(
            this.serializeDecisionReceipt(receipt),
          ),
          brainstorm_selection: receipt,
          brainstorm_result: result,
        },
      });
      return {
        phase_from: "brainstorm",
        phase_to: "spec",
        next_state: workItemStateSchema.parse({
          ...item.state,
          phase: "spec",
          updated_at: nextTimestamp(item.state.updated_at, this.clock),
        }),
        next_mission: nextMission,
        decision_receipt: receipt,
        plan_repository_base_commit: null,
        plan_goal_contract_sha256: null,
        plan_goal_version: null,
      };
    }

    if (operation === "approve_spec") {
      const validated = approveSpecDecisionInputSchema.parse(input);
      this.requirePhase(item, "spec");
      const artifact = this.requireBoundAppliedShapingTip(
        workItemId,
        "spec",
        artifacts,
        validated.expected_mission_content_sha256,
        validated.expected_result_content_sha256,
      );
      if (artifact.decision !== null) {
        throw this.conflict(
          "stale_expectation",
          workItemId,
          "The Spec revision already carries a decision receipt.",
        );
      }
      const result = specResultSubmissionSchema.parse(
        JSON.parse(artifact.result!.result_source) as unknown,
      );
      const nextGoalVersion = this.incrementVersion(
        item.goal.goal_contract?.goal_version ?? 0,
        workItemId,
        "goal_version",
      );
      const nextInputRevision = this.incrementVersion(
        item.state.input_revision ?? 0,
        workItemId,
        "input_revision",
      );
      const goalContract = goalContractFromSpecProposal(
        result.proposal,
        nextGoalVersion,
      );
      const goalContractSha256 = hashGoalContract(goalContract);
      if (goalContractSha256 !== validated.goal_contract_sha256) {
        throw this.conflict(
          "stale_expectation",
          workItemId,
          "The approved Spec no longer derives the expected goal contract.",
        );
      }
      const receipt: ShapingDecisionReceipt = {
        shaping_schema_version: 2,
        identity: result.identity,
        mission_content_sha256:
          validated.expected_mission_content_sha256,
        result_content_sha256: validated.expected_result_content_sha256,
        goal_contract_sha256: goalContractSha256,
        approved_at: this.clock().toISOString(),
      };
      const repositoryBaseCommit = await this.git.readHeadCommit();
      const nextMission = compilePlanMission({
        work_item_id: workItemId,
        shaping_input: {
          phase: "plan",
          ...goalInput,
          spec_approval_sha256: this.hashSource(
            this.serializeDecisionReceipt(receipt),
          ),
          spec_approval: receipt,
          spec_result: result,
          repository_base_commit: repositoryBaseCommit,
          goal_contract_sha256: goalContractSha256,
          goal_version: nextGoalVersion,
        },
      });
      return {
        phase_from: "spec",
        phase_to: "plan",
        next_goal: workItemGoalSchema.parse({
          ...item.goal,
          goal_contract: goalContract,
        }),
        next_state: workItemStateSchema.parse({
          ...item.state,
          phase: "plan",
          goal_version: nextGoalVersion,
          input_revision: nextInputRevision,
          attempt: 0,
          patch_cycle: 0,
          updated_at: nextTimestamp(item.state.updated_at, this.clock),
        }),
        next_mission: nextMission,
        decision_receipt: receipt,
        plan_repository_base_commit: repositoryBaseCommit,
        plan_goal_contract_sha256: goalContractSha256,
        plan_goal_version: nextGoalVersion,
      };
    }

    const validated = replanWithUpdatedContractInputSchema.parse(input);
    this.requirePhase(item, "plan");
    const artifact = this.requireBoundAppliedShapingTip(
      workItemId,
      "plan",
      artifacts,
      validated.expected_mission_content_sha256,
      validated.expected_result_content_sha256,
    );
    const currentPlanMission = artifact.mission as PlanMissionPackage;
    planResultSubmissionSchema.parse(
      JSON.parse(artifact.result!.result_source) as unknown,
    );
    const goalContract = item.goal.goal_contract;
    const goalVersion = item.state.goal_version;
    if (
      goalContract === undefined ||
      goalVersion === undefined ||
      item.state.input_revision === undefined ||
      goalContract.goal_version !== goalVersion
    ) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        "Replan requires one current governed goal contract.",
      );
    }
    const goalContractSha256 = hashGoalContract(goalContract);
    if (goalContractSha256 !== validated.goal_contract_sha256) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        "Replan is bound to a stale goal contract.",
      );
    }
    if (
      currentPlanMission.input.goal_contract_sha256 === goalContractSha256 &&
      currentPlanMission.input.goal_version === goalVersion
    ) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        "The current Plan revision is already bound to the durable contract.",
      );
    }
    const repositoryBaseCommit = await this.git.readHeadCommit();
    const nextMission = compilePlanMission({
      work_item_id: workItemId,
      shaping_input: {
        ...currentPlanMission.input,
        ...goalInput,
        phase: "plan",
        repository_base_commit: repositoryBaseCommit,
        goal_contract_sha256: goalContractSha256,
        goal_version: goalVersion,
        revision: {
          ordinal: (currentPlanMission.input.revision?.ordinal ?? 0) + 1,
          supersedes_input_sha256:
            artifact.mission.identity.input_sha256,
          superseded_result_sha256:
            validated.expected_result_content_sha256,
          feedback: `Replan for updated goal contract version ${goalVersion} (${goalContractSha256}).`,
        },
      },
    });
    return {
      phase_from: "plan",
      phase_to: "plan",
      next_state: workItemStateSchema.parse({
        ...item.state,
        updated_at: nextTimestamp(item.state.updated_at, this.clock),
      }),
      next_mission: nextMission,
      decision_receipt: null,
      plan_repository_base_commit: repositoryBaseCommit,
      plan_goal_contract_sha256: goalContractSha256,
      plan_goal_version: goalVersion,
    };
  }

  private preparePlanApproval(
    item: WorkItem,
    artifacts: StoredShapingArtifact[],
    binding: PlanApprovalBinding,
  ): PreparedPlanApproval {
    const workItemId = item.goal.work_item_id;
    if (
      item.state.schema_version !== 2 ||
      item.state.phase !== "plan" ||
      item.state.status !== "active"
    ) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        "Plan approval requires an active schema-v2 Plan work item.",
      );
    }
    const goalContract = item.goal.goal_contract;
    const goalVersion = item.state.goal_version;
    const inputRevision = item.state.input_revision;
    if (
      goalContract === undefined ||
      goalVersion === undefined ||
      inputRevision === undefined ||
      item.state.attempt !== 0 ||
      goalContract.goal_version !== goalVersion ||
      binding.goal_version !== goalVersion ||
      binding.goal_contract_sha256 !== hashGoalContract(goalContract)
    ) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        "Plan approval requires the current governed contract and unchanged execution tuple.",
      );
    }
    const artifact = this.requireBoundAppliedShapingTip(
      workItemId,
      "plan",
      artifacts,
      binding.expected_mission_content_sha256,
      binding.expected_result_content_sha256,
    );
    if (artifact.decision !== null) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        "Plan approval requires an undecided Plan tip.",
      );
    }
    this.assertPlanMissionUsesCurrentContract(item, artifact);
    const mission = artifact.mission as PlanMissionPackage;
    const executeTuple = {
      goal_version: goalVersion,
      input_revision: inputRevision,
      attempt: 0 as const,
    };
    const receipt: PlanApprovalReceipt = {
      shaping_schema_version: 2,
      identity: mission.identity,
      mission_content_sha256: mission.content_sha256,
      result_content_sha256: binding.expected_result_content_sha256,
      goal_contract_sha256: binding.goal_contract_sha256,
      goal_version: goalVersion,
      execute_tuple: executeTuple,
      approved_at: this.clock().toISOString(),
    };
    return {
      next_state: workItemStateSchema.parse({
        ...this.withoutControllerActiveRun(item).state,
        phase: "execute",
        status: "active",
        updated_at: nextTimestamp(item.state.updated_at, this.clock),
        goal_version: goalVersion,
        input_revision: inputRevision,
        attempt: 0,
      }),
      receipt,
    };
  }

  private shapingDecisionState(
    item: WorkItem,
    artifacts: StoredShapingArtifact[],
    runs: ShapingRunRecordV1[],
  ): ShapingDecisionState {
    const phase = item.state.phase;
    const tip = isShapingPhase(phase)
      ? this.resolveShapingTip(item.goal.work_item_id, phase, artifacts)
      : null;
    const nonTerminalRuns = runs.filter(
      (run) => run.lifecycle.status !== "terminal",
    );
    const currentRuns =
      tip === null
        ? []
        : nonTerminalRuns.filter(
            (run) =>
              run.mission.phase === tip.mission.identity.phase &&
              run.mission.input_sha256 ===
                tip.mission.identity.input_sha256 &&
              run.mission.content_sha256 === tip.mission.content_sha256,
          );
    if (
      currentRuns.length > 1 ||
      nonTerminalRuns.length !== currentRuns.length
    ) {
      throw this.conflict(
        "repair_required",
        item.goal.work_item_id,
        "Shaping state has an ambiguous non-terminal run.",
      );
    }
    return {
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
    };
  }

  private resolveShapingTip(
    workItemId: string,
    phase: ShapingPhase,
    artifacts: StoredShapingArtifact[],
  ): StoredShapingArtifact | null {
    const phaseArtifacts = artifacts.filter(
      (artifact) => artifact.mission.identity.phase === phase,
    );
    if (phaseArtifacts.length === 0) {
      return null;
    }
    const byInput = new Map<string, StoredShapingArtifact>();
    for (const artifact of phaseArtifacts) {
      const inputSha256 = artifact.mission.identity.input_sha256;
      if (byInput.has(inputSha256)) {
        throw this.conflict(
          "repair_required",
          workItemId,
          `Shaping phase ${phase} contains duplicate mission identity ${inputSha256}.`,
        );
      }
      byInput.set(inputSha256, artifact);
    }
    const superseded = new Set<string>();
    for (const artifact of phaseArtifacts) {
      const revision = artifact.mission.input.revision;
      if (revision === undefined) {
        continue;
      }
      const predecessor = byInput.get(revision.supersedes_input_sha256);
      const expectedOrdinal =
        (predecessor?.mission.input.revision?.ordinal ?? 0) + 1;
      if (
        predecessor === undefined ||
        revision.ordinal !== expectedOrdinal ||
        predecessor.result === null ||
        predecessor.result.result_content_sha256 !==
          revision.superseded_result_sha256
      ) {
        throw this.conflict(
          "repair_required",
          workItemId,
          `Shaping revision ${artifact.mission.identity.input_sha256} has an invalid predecessor.`,
        );
      }
      superseded.add(revision.supersedes_input_sha256);
    }
    const tips = phaseArtifacts.filter(
      (artifact) =>
        !superseded.has(artifact.mission.identity.input_sha256),
    );
    if (tips.length !== 1) {
      throw this.conflict(
        "repair_required",
        workItemId,
        `Shaping phase ${phase} must have exactly one revision tip; found ${tips.length}.`,
      );
    }
    return tips[0];
  }

  private requireBoundAppliedShapingTip(
    workItemId: string,
    phase: ShapingPhase,
    artifacts: StoredShapingArtifact[],
    missionContentSha256: string,
    resultContentSha256: string,
  ): StoredShapingArtifact {
    const tip = this.resolveShapingTip(workItemId, phase, artifacts);
    if (
      tip === null ||
      tip.mission.content_sha256 !== missionContentSha256 ||
      tip.result?.result_content_sha256 !== resultContentSha256 ||
      tip.import_receipt?.outcome !== "applied" ||
      tip.applied_marker === null
    ) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        `The bound ${phase} mission is not the tip with its applied result.`,
      );
    }
    return tip;
  }

  private requirePhase(item: WorkItem, phase: ShapingPhase): void {
    if (item.state.phase !== phase) {
      throw this.conflict(
        "stale_expectation",
        item.goal.work_item_id,
        `Expected shaping phase ${phase} but found ${item.state.phase}.`,
      );
    }
  }

  private requireShapingPhase(item: WorkItem): ShapingPhase {
    const phase = item.state.phase;
    if (!isShapingPhase(phase)) {
      throw this.conflict(
        "stale_expectation",
        item.goal.work_item_id,
        `Request changes requires a shaping phase; found ${phase}.`,
      );
    }
    return phase;
  }

  private requireUngovernedShapingItem(item: WorkItem): void {
    if (
      item.goal.goal_contract !== undefined ||
      item.state.goal_version !== undefined ||
      item.state.input_revision !== undefined
    ) {
      throw this.conflict(
        "stale_expectation",
        item.goal.work_item_id,
        "This shaping decision requires an item without a governed goal contract.",
      );
    }
  }

  private assertPlanMissionUsesCurrentContract(
    item: WorkItem,
    artifact: StoredShapingArtifact,
  ): void {
    const mission = artifact.mission as PlanMissionPackage;
    if (
      artifact.mission.identity.phase !== "plan" ||
      item.goal.goal_contract === undefined ||
      item.state.goal_version === undefined ||
      mission.input.goal_contract_sha256 !==
        hashGoalContract(item.goal.goal_contract) ||
      mission.input.goal_version !== item.state.goal_version
    ) {
      throw this.conflict(
        "stale_expectation",
        item.goal.work_item_id,
        "The Plan decision is bound to a superseded goal contract.",
      );
    }
  }

  private async requirePlanApprovalIntent(
    repository: ShapingDecisionRepository,
    binding: PlanApprovalBinding,
    approvalId: string,
  ): Promise<PlanApprovalIntentV1> {
    const intent = await repository.readPlanApprovalIntent(
      binding.work_item_id,
      approvalId,
    );
    if (intent === null) {
      throw this.conflict(
        "repair_required",
        binding.work_item_id,
        `Applied Plan approval ${approvalId} has no durable intent.`,
      );
    }
    this.assertPlanApprovalIntentMatchesBinding(intent, binding);
    return intent;
  }

  private assertPlanApprovalIntentMatchesBinding(
    intent: PlanApprovalIntentV1,
    binding: PlanApprovalBinding,
  ): void {
    const expectedApprovalId = derivePlanApprovalId(binding);
    if (
      intent.approval_id !== expectedApprovalId ||
      intent.work_item_id !== binding.work_item_id ||
      intent.expected_mission_content_sha256 !==
        binding.expected_mission_content_sha256 ||
      intent.expected_result_content_sha256 !==
        binding.expected_result_content_sha256 ||
      intent.expected_shaping_state_sha256 !==
        binding.expected_shaping_state_sha256 ||
      intent.goal_contract_sha256 !== binding.goal_contract_sha256 ||
      intent.goal_version !== binding.goal_version
    ) {
      throw this.conflict(
        "idempotency_conflict",
        binding.work_item_id,
        `Stored Plan approval intent ${intent.approval_id} does not match the decision request.`,
      );
    }
    if (
      intent.launch_mode !== binding.launch_mode ||
      intent.requested_model !== binding.requested_model
    ) {
      throw this.conflict(
        "idempotency_conflict",
        binding.work_item_id,
        "A Plan approval replay cannot change its launch mode or requested model.",
      );
    }
  }

  private assertPlanApprovalManifestMatchesIntent(
    manifest: PlanApprovalManifestV1,
    intent: PlanApprovalIntentV1,
  ): void {
    const manifestIdentity = {
      schema_version: manifest.schema_version,
      approval_id: manifest.approval_id,
      work_item_id: manifest.work_item_id,
      launch_mode: manifest.launch_mode,
      requested_model: manifest.requested_model,
      expected_mission_content_sha256:
        manifest.expected_mission_content_sha256,
      expected_result_content_sha256:
        manifest.expected_result_content_sha256,
      expected_shaping_state_sha256:
        manifest.expected_shaping_state_sha256,
      goal_contract_sha256: manifest.goal_contract_sha256,
      goal_version: manifest.goal_version,
      receipt_sha256: manifest.receipt_sha256,
      execute_tuple: manifest.execute_tuple,
      goal_sha256: manifest.goal_sha256,
      state_sha256: manifest.state_sha256,
    };
    const intentIdentity = {
      schema_version: 1 as const,
      approval_id: intent.approval_id,
      work_item_id: intent.work_item_id,
      launch_mode: intent.launch_mode,
      requested_model: intent.requested_model,
      expected_mission_content_sha256:
        intent.expected_mission_content_sha256,
      expected_result_content_sha256:
        intent.expected_result_content_sha256,
      expected_shaping_state_sha256:
        intent.expected_shaping_state_sha256,
      goal_contract_sha256: intent.goal_contract_sha256,
      goal_version: intent.goal_version,
      receipt_sha256: intent.receipt_sha256,
      execute_tuple: intent.execute_tuple,
      goal_sha256: intent.next_goal_sha256,
      state_sha256: intent.next_state_sha256,
    };
    if (!isDeepStrictEqual(manifestIdentity, intentIdentity)) {
      throw this.conflict(
        "idempotency_conflict",
        intent.work_item_id,
        `Stored Plan approval manifest ${manifest.approval_id} differs from its intent.`,
      );
    }
  }

  private async assertResumablePlanApprovalIntent(
    repository: ShapingDecisionRepository,
    currentItem: WorkItem,
    intent: PlanApprovalIntentV1,
  ): Promise<void> {
    const previousItem = this.workItemFromPreviousShapingBytes(
      intent.previous_goal_bytes,
      intent.previous_state_bytes,
    );
    const nextItem = this.workItemFromShapingBytes(
      intent.next_goal_bytes,
      intent.next_state_bytes,
    );
    const currentWithoutRun = this.withoutControllerActiveRun(currentItem);
    const previousWithoutRun = this.withoutControllerActiveRun(previousItem);
    const nextWithoutRun = this.withoutControllerActiveRun(nextItem);
    const isPrevious = isDeepStrictEqual(
      currentWithoutRun,
      previousWithoutRun,
    );
    const isNext = isDeepStrictEqual(currentWithoutRun, nextWithoutRun);
    if (!isPrevious && !isNext) {
      throw this.conflict(
        "repair_required",
        intent.work_item_id,
        "Durable work-item state is neither the previous nor next pair recorded by the Plan approval intent.",
      );
    }
    if (isNext) {
      throw this.conflict(
        "repair_required",
        intent.work_item_id,
        "A Plan approval intent reached Execute without a pending or applied manifest.",
      );
    }

    const artifacts = await repository.listShapingArtifacts(
      intent.work_item_id,
    );
    const tip = this.resolveShapingTip(
      intent.work_item_id,
      "plan",
      artifacts,
    );
    if (
      tip === null ||
      tip.mission.content_sha256 !==
        intent.expected_mission_content_sha256 ||
      tip.result?.result_content_sha256 !==
        intent.expected_result_content_sha256 ||
      tip.import_receipt?.outcome !== "applied" ||
      tip.applied_marker === null
    ) {
      throw this.conflict(
        "repair_required",
        intent.work_item_id,
        "The pending Plan approval no longer matches the applied Plan tip.",
      );
    }
    const reconstructedArtifacts = artifacts.map((artifact) => {
      if (
        artifact.mission.content_sha256 !==
        intent.expected_mission_content_sha256
      ) {
        return artifact;
      }
      if (
        artifact.decision !== null &&
        this.serializeDecisionReceipt(artifact.decision.receipt) !==
          intent.receipt_bytes
      ) {
        throw this.conflict(
          "idempotency_conflict",
          intent.work_item_id,
          "The stored Plan receipt differs from the pending approval intent.",
        );
      }
      return { ...artifact, decision: null };
    });
    const reconstructedState = this.shapingDecisionState(
      previousWithoutRun,
      reconstructedArtifacts,
      await repository.listShapingRuns(intent.work_item_id),
    );
    if (
      hashShapingDecisionState(reconstructedState) !==
      intent.expected_shaping_state_sha256
    ) {
      throw this.conflict(
        "repair_required",
        intent.work_item_id,
        "Durable artifacts drifted beyond the receipt predicted by the Plan approval intent.",
      );
    }
  }

  private async materializePlanApproval(
    repository: ShapingDecisionRepository,
    lease: ControllerLease,
    intent: PlanApprovalIntentV1,
  ): Promise<PlanApprovalControllerResult> {
    const parsedReceipt = shapingDecisionReceiptSchema.parse(
      JSON.parse(intent.receipt_bytes) as unknown,
    );
    if (
      parsedReceipt.identity.phase !== "plan" ||
      this.serializeDecisionReceipt(parsedReceipt) !== intent.receipt_bytes
    ) {
      throw this.conflict(
        "repair_required",
        intent.work_item_id,
        "The Plan approval intent receipt bytes are not canonical.",
      );
    }
    const writtenReceipt =
      await repository.writeShapingDecisionReceipt(parsedReceipt);
    if (
      writtenReceipt.receipt_content_sha256 !== intent.receipt_sha256 ||
      this.serializeDecisionReceipt(writtenReceipt.receipt) !==
        intent.receipt_bytes
    ) {
      throw this.conflict(
        "idempotency_conflict",
        intent.work_item_id,
        "The durable Plan receipt differs from its approval intent.",
      );
    }

    const nextItem = this.workItemFromShapingBytes(
      intent.next_goal_bytes,
      intent.next_state_bytes,
    );
    const pendingManifest: PlanApprovalManifestV1 = {
      schema_version: 1,
      approval_id: intent.approval_id,
      work_item_id: intent.work_item_id,
      launch_mode: intent.launch_mode,
      requested_model: intent.requested_model,
      expected_mission_content_sha256:
        intent.expected_mission_content_sha256,
      expected_result_content_sha256:
        intent.expected_result_content_sha256,
      expected_shaping_state_sha256:
        intent.expected_shaping_state_sha256,
      goal_contract_sha256: intent.goal_contract_sha256,
      goal_version: intent.goal_version,
      receipt_sha256: intent.receipt_sha256,
      execute_tuple: intent.execute_tuple,
      goal_sha256: intent.next_goal_sha256,
      state_sha256: intent.next_state_sha256,
      started_at: intent.created_at,
      outcome: "pending",
    };
    const committed = await repository.commitPlanApproval(lease, {
      state: nextItem.state,
      manifest: pendingManifest,
    });
    return this.planApprovalResult(intent, committed.manifest);
  }

  private planApprovalResult(
    intent: PlanApprovalIntentV1,
    manifest: PlanApprovalManifestV1,
  ): PlanApprovalControllerResult {
    return {
      work_item: this.workItemFromShapingBytes(
        intent.next_goal_bytes,
        intent.next_state_bytes,
      ),
      manifest,
      intent,
      approval_id: intent.approval_id,
      launch_mode: intent.launch_mode,
      requested_model: intent.requested_model,
      execute_tuple: intent.execute_tuple,
    };
  }

  private async requireShapingDecisionIntent(
    repository: ShapingDecisionRepository,
    binding: ShapingDecisionBinding,
    decisionId: string,
  ): Promise<ShapingDecisionIntentV1> {
    const intent = await repository.readShapingDecisionIntent(
      binding.work_item_id,
      decisionId,
    );
    if (intent === null) {
      throw this.conflict(
        "repair_required",
        binding.work_item_id,
        `Applied shaping decision ${decisionId} has no durable intent.`,
      );
    }
    this.assertShapingDecisionIntentMatchesBinding(intent, binding);
    return intent;
  }

  private assertShapingDecisionIntentMatchesBinding(
    intent: ShapingDecisionIntentV1,
    binding: ShapingDecisionBinding,
  ): void {
    const expectedDecisionId = deriveShapingDecisionId({
      operation: binding.operation,
      work_item_id: binding.work_item_id,
      goal_input_sha256: binding.goal_input_sha256,
      mission_content_sha256: binding.mission_content_sha256,
      result_content_sha256: binding.result_content_sha256,
      feedback_sha256: binding.feedback_sha256,
      expected_shaping_state_sha256:
        binding.expected_shaping_state_sha256,
    });
    const identityMatches =
      intent.decision_id === expectedDecisionId &&
      intent.operation === binding.operation &&
      intent.work_item_id === binding.work_item_id &&
      intent.goal_input_sha256 === binding.goal_input_sha256 &&
      intent.mission_content_sha256 === binding.mission_content_sha256 &&
      intent.result_content_sha256 === binding.result_content_sha256 &&
      intent.feedback_sha256 === binding.feedback_sha256 &&
      intent.expected_shaping_state_sha256 ===
        binding.expected_shaping_state_sha256;
    if (!identityMatches) {
      throw this.conflict(
        "idempotency_conflict",
        binding.work_item_id,
        `Stored shaping intent ${intent.decision_id} does not match the decision request.`,
      );
    }
    if (
      intent.launch_mode !== binding.launch_mode ||
      intent.next_requested_model !== binding.next_requested_model
    ) {
      throw this.conflict(
        "idempotency_conflict",
        binding.work_item_id,
        "A shaping decision replay cannot change its launch mode or requested model.",
      );
    }
  }

  private assertShapingDecisionManifestMatchesIntent(
    manifest: ShapingDecisionManifestV1,
    intent: ShapingDecisionIntentV1,
  ): void {
    const manifestIdentity = {
      schema_version: manifest.schema_version,
      decision_id: manifest.decision_id,
      work_item_id: manifest.work_item_id,
      operation: manifest.operation,
      phase_from: manifest.phase_from,
      phase_to: manifest.phase_to,
      mission_content_sha256: manifest.mission_content_sha256,
      result_content_sha256: manifest.result_content_sha256,
      feedback_sha256: manifest.feedback_sha256,
      expected_shaping_state_sha256:
        manifest.expected_shaping_state_sha256,
      next_mission_content_sha256:
        manifest.next_mission_content_sha256,
      goal_sha256: manifest.goal_sha256,
      state_sha256: manifest.state_sha256,
      goal_version: manifest.goal_version,
      input_revision: manifest.input_revision,
    };
    const intentIdentity = {
      schema_version: 1 as const,
      decision_id: intent.decision_id,
      work_item_id: intent.work_item_id,
      operation: intent.operation,
      phase_from: intent.phase_from,
      phase_to: intent.phase_to,
      mission_content_sha256: intent.mission_content_sha256,
      result_content_sha256: intent.result_content_sha256,
      feedback_sha256: intent.feedback_sha256,
      expected_shaping_state_sha256:
        intent.expected_shaping_state_sha256,
      next_mission_content_sha256:
        intent.next_mission_content_sha256,
      goal_sha256: intent.next_goal_sha256,
      state_sha256: intent.next_state_sha256,
      goal_version:
        intent.operation === "approve_spec"
          ? intent.plan_goal_version
          : null,
      input_revision:
        intent.operation === "approve_spec"
          ? this.workItemFromShapingIntent(intent).state.input_revision ?? null
          : null,
    };
    if (!isDeepStrictEqual(manifestIdentity, intentIdentity)) {
      throw this.conflict(
        "idempotency_conflict",
        intent.work_item_id,
        `Stored shaping manifest ${manifest.decision_id} differs from its intent.`,
      );
    }
  }

  private async assertResumableShapingIntent(
    repository: ShapingDecisionRepository,
    currentItem: WorkItem,
    intent: ShapingDecisionIntentV1,
  ): Promise<void> {
    const previousItem = this.workItemFromPreviousShapingBytes(
      intent.previous_goal_bytes,
      intent.previous_state_bytes,
    );
    const nextItem = this.workItemFromShapingIntent(intent);
    const currentWithoutRun = this.withoutControllerActiveRun(currentItem);
    const previousWithoutRun = this.withoutControllerActiveRun(previousItem);
    const nextWithoutRun = this.withoutControllerActiveRun(nextItem);
    const isPrevious = isDeepStrictEqual(
      currentWithoutRun,
      previousWithoutRun,
    );
    const isNext = isDeepStrictEqual(currentWithoutRun, nextWithoutRun);
    if (!isPrevious && !isNext) {
      throw this.conflict(
        "repair_required",
        intent.work_item_id,
        "Durable work-item state is neither the previous nor next pair recorded by the shaping intent.",
      );
    }
    if (isNext) {
      throw this.conflict(
        "repair_required",
        intent.work_item_id,
        "A shaping intent reached its next goal/state pair without a pending or applied manifest.",
      );
    }

    let artifacts: StoredShapingArtifact[];
    try {
      artifacts = await repository.listShapingArtifacts(
        intent.work_item_id,
      );
    } catch (error) {
      if (error instanceof InvalidWorkspaceError) {
        throw this.conflict(
          "repair_required",
          intent.work_item_id,
          `The pending shaping decision found a non-identical durable artifact: ${error.message}`,
        );
      }
      throw error;
    }
    let predictedMissionCount = 0;
    const reconstructedArtifacts = artifacts.flatMap((artifact) => {
      if (
        artifact.mission.content_sha256 ===
        intent.next_mission_content_sha256
      ) {
        predictedMissionCount += 1;
        return [];
      }
      if (
        intent.decision_receipt_bytes !== null &&
        artifact.mission.content_sha256 === intent.mission_content_sha256
      ) {
        if (
          artifact.decision !== null &&
          this.serializeDecisionReceipt(artifact.decision.receipt) !==
            intent.decision_receipt_bytes
        ) {
          throw this.conflict(
            "idempotency_conflict",
            intent.work_item_id,
            "The stored shaping decision receipt differs from the pending intent.",
          );
        }
        return [{ ...artifact, decision: null }];
      }
      return [artifact];
    });
    if (predictedMissionCount > 1) {
      throw this.conflict(
        "repair_required",
        intent.work_item_id,
        "More than one mission matches the pending intent's predicted content hash.",
      );
    }

    const runs = await repository.listShapingRuns(intent.work_item_id);
    const reconstructedRuns = runs.filter((run) => {
      if (
        run.mission.content_sha256 !==
          intent.next_mission_content_sha256 ||
        run.lifecycle.status === "terminal"
      ) {
        return true;
      }
      const requestedModel = run.provenance.requested_model.value;
      const fingerprint =
        requestedModel === null
          ? null
          : shapingRunLaunchFingerprint(
              run.mission.content_sha256,
              requestedModel,
            );
      if (fingerprint !== intent.launch_fingerprint) {
        throw this.conflict(
          "lease_held",
          intent.work_item_id,
          "A different active shaping run conflicts with the pending decision.",
        );
      }
      return false;
    });
    const reconstructedState = this.shapingDecisionState(
      previousWithoutRun,
      reconstructedArtifacts,
      reconstructedRuns,
    );
    if (
      hashShapingDecisionState(reconstructedState) !==
      intent.expected_shaping_state_sha256
    ) {
      throw this.conflict(
        "repair_required",
        intent.work_item_id,
        "Durable artifacts contain drift beyond the exact receipt and mission predicted by the shaping intent.",
      );
    }
  }

  private async materializeShapingDecision(
    repository: ShapingDecisionRepository,
    lease: ControllerLease,
    intent: ShapingDecisionIntentV1,
  ): Promise<ShapingDecisionControllerResult> {
    if (intent.decision_receipt_bytes !== null) {
      const parsedReceipt = shapingDecisionReceiptSchema.parse(
        JSON.parse(intent.decision_receipt_bytes) as unknown,
      );
      if (
        this.serializeDecisionReceipt(parsedReceipt) !==
        intent.decision_receipt_bytes
      ) {
        throw this.conflict(
          "repair_required",
          intent.work_item_id,
          "The intent's decision receipt bytes are not canonical.",
        );
      }
      const writtenReceipt =
        await repository.writeShapingDecisionReceipt(parsedReceipt);
      if (
        writtenReceipt.receipt_content_sha256 !==
        this.hashSource(intent.decision_receipt_bytes) ||
        this.serializeDecisionReceipt(writtenReceipt.receipt) !==
          intent.decision_receipt_bytes
      ) {
        throw this.conflict(
          "idempotency_conflict",
          intent.work_item_id,
          "The durable decision receipt differs from the shaping intent.",
        );
      }
    }

    const mission = shapingMissionPackageSchema.parse(
      JSON.parse(intent.next_mission_package_bytes) as unknown,
    );
    if (
      serializeShapingPackage(mission) !==
        intent.next_mission_package_bytes ||
      mission.content_sha256 !== intent.next_mission_content_sha256 ||
      mission.identity.input_sha256 !== intent.next_mission_input_sha256
    ) {
      throw this.conflict(
        "repair_required",
        intent.work_item_id,
        "The pending shaping mission bytes do not match their intent hashes.",
      );
    }
    await repository.publishLeasedShapingMission(
      lease,
      mission.identity,
      intent.next_mission_package_bytes,
      { decision_id: intent.decision_id },
    );

    const nextItem = this.workItemFromShapingIntent(intent);
    const pendingManifest: ShapingDecisionManifestV1 = {
      schema_version: 1,
      decision_id: intent.decision_id,
      work_item_id: intent.work_item_id,
      operation: intent.operation,
      phase_from: intent.phase_from,
      phase_to: intent.phase_to,
      mission_content_sha256: intent.mission_content_sha256,
      result_content_sha256: intent.result_content_sha256,
      feedback_sha256: intent.feedback_sha256,
      expected_shaping_state_sha256:
        intent.expected_shaping_state_sha256,
      next_mission_content_sha256:
        intent.next_mission_content_sha256,
      goal_sha256: intent.next_goal_sha256,
      state_sha256: intent.next_state_sha256,
      goal_version:
        intent.operation === "approve_spec"
          ? nextItem.state.goal_version ?? null
          : null,
      input_revision:
        intent.operation === "approve_spec"
          ? nextItem.state.input_revision ?? null
          : null,
      started_at: intent.created_at,
      outcome: "pending",
    };
    const committed = await repository.commitShapingDecision(lease, {
      ...(intent.operation === "approve_spec"
        ? { goal: nextItem.goal }
        : {}),
      state: nextItem.state,
      manifest: pendingManifest,
    });
    return this.shapingDecisionResult(
      committed.work_item,
      committed.manifest,
      intent,
    );
  }

  private shapingDecisionResult(
    workItem: WorkItem,
    manifest: ShapingDecisionManifestV1,
    intent: ShapingDecisionIntentV1,
  ): ShapingDecisionControllerResult {
    const mission = shapingMissionPackageSchema.parse(
      JSON.parse(intent.next_mission_package_bytes) as unknown,
    );
    return {
      work_item: workItem,
      manifest,
      intent,
      decision_id: intent.decision_id,
      launch_mode: intent.launch_mode,
      next_requested_model: intent.next_requested_model,
      launch_fingerprint: intent.launch_fingerprint,
      next_mission: {
        identity: mission.identity,
        content_sha256: mission.content_sha256,
      },
      next_launch:
        intent.launch_mode === "manual"
          ? {
              status: "manual",
              shaping_run_id: null,
              reason: "founder_selected_manual",
            }
          : null,
    };
  }

  private workItemFromShapingIntent(
    intent: ShapingDecisionIntentV1,
  ): WorkItem {
    return this.workItemFromShapingBytes(
      intent.next_goal_bytes,
      intent.next_state_bytes,
    );
  }

  private workItemFromShapingBytes(
    goalBytes: string,
    stateBytes: string,
  ): WorkItem {
    return workItemSchema.parse({
      goal: workItemGoalSchema.parse(parseYaml(goalBytes) as unknown),
      state: workItemStateSchema.parse(JSON.parse(stateBytes) as unknown),
    });
  }

  private workItemFromPreviousShapingBytes(
    goalBytes: string,
    stateBytes: string,
  ): WorkItem {
    return workItemSchema.parse({
      goal: workItemGoalSchema.parse(parseYaml(goalBytes) as unknown),
      state: parseWorkItemStateForRead(JSON.parse(stateBytes) as unknown),
    });
  }

  private withoutControllerActiveRun(item: WorkItem): WorkItem {
    const state = { ...item.state };
    delete state.active_run;
    return workItemSchema.parse({ goal: item.goal, state });
  }

  private serializeDecisionReceipt(
    receipt: ShapingDecisionReceipt,
  ): string {
    const parsed = shapingDecisionReceiptSchema.parse(receipt);
    return `${JSON.stringify(parsed, null, 2)}\n`;
  }

  private hashSource(source: string): string {
    return createHash("sha256").update(source).digest("hex");
  }

  private activeRun(runId: string, idempotencyKey: string): ActiveRun {
    return {
      run_id: runId,
      idempotency_key: idempotencyKey,
      acquired_at: this.clock().toISOString(),
    };
  }

  private pendingManifest(
    identity: Omit<
      ControllerRunManifest,
      "schema_version" | "started_at" | "completed_at" | "outcome"
    >,
    startedAt: string,
  ): ControllerRunManifest {
    return controllerRunManifestSchema.parse({
      schema_version: 1,
      ...identity,
      started_at: startedAt,
      outcome: "pending",
    });
  }

  private validateSaveExpectations(
    workItemId: string,
    current: WorkItem,
    input: SaveWorkItemInput,
  ): void {
    const currentGoalVersion = current.goal.goal_contract?.goal_version;
    if (currentGoalVersion === undefined) {
      if (
        input.expected_goal_version !== undefined ||
        input.expected_input_revision !== undefined
      ) {
        throw this.conflict(
          "stale_expectation",
          workItemId,
          "First contract activation requires absent expected versions.",
        );
      }
      return;
    }

    if (
      input.expected_goal_version === undefined ||
      input.expected_input_revision === undefined ||
      input.expected_goal_version !== currentGoalVersion ||
      input.expected_input_revision !== current.state.input_revision
    ) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        `Expected goal/input versions ${String(input.expected_goal_version)}/${String(input.expected_input_revision)} but found ${currentGoalVersion}/${current.state.input_revision}.`,
      );
    }
  }

  private validateTransitionExpectations(
    workItemId: string,
    current: WorkItem,
    input: ControllerTransitionInput,
  ): void {
    if (current.goal.goal_contract === undefined) {
      throw this.conflict(
        "contract_required",
        workItemId,
        "Controller transitions require an active goal contract.",
      );
    }
    if (
      current.state.phase !== input.expected_phase ||
      current.state.status !== input.expected_status ||
      current.state.schema_version !== input.expected_schema_version ||
      current.state.goal_version !== input.expected_goal_version ||
      current.state.input_revision !== input.expected_input_revision
    ) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        "Controller transition expectations do not match durable state.",
      );
    }
    if (current.state.attempt !== input.attempt) {
      throw this.conflict(
        "attempt_conflict",
        workItemId,
        `Expected attempt ${input.attempt} but found ${current.state.attempt}.`,
      );
    }
  }

  private incrementVersion(
    version: number,
    workItemId: string,
    field: string,
  ): number {
    const nextVersion = version + 1;
    if (!Number.isSafeInteger(nextVersion)) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        `${field} cannot be incremented beyond the safe-integer range.`,
      );
    }
    return nextVersion;
  }

  private conflict(
    kind: ConstructorParameters<typeof ControllerConflictError>[0],
    workItemId: string,
    reason: string,
  ): ControllerConflictError {
    return new ControllerConflictError(kind, workItemId, reason);
  }
}
