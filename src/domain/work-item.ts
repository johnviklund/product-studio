import { createHash } from "node:crypto";

import { z } from "zod";

import {
  canonicalCapabilityRequestSchema,
  executionDefaultsV1Schema,
  hashCanonicalCapabilityRequest,
  type CanonicalCapabilityRequest,
  type ExecutionDefaultsV1,
} from "./capability-envelope";
import type {
  MissionArtifactReadResult,
  MissionArtifactWriteResult,
  MissionIdentity,
  MissionPackageBuilder,
  PatchMissionPackage,
  PatchSubject,
  ReviewMissionPackage,
} from "./mission";
import type { ConnectedRunRecordV2 } from "./connected-run";
import type {
  PlanApprovalExecuteTuple,
  ShapingArtifactWriteResult,
  ShapingDecisionIntentV1,
  ShapingDecisionManifestV1,
  ShapingIdentity,
} from "./shaping";
import { portfolioSourceIdSchema } from "./portfolio-source";
import type {
  AppliedExecuteReviewSubject,
  AppliedPatchReviewSubject,
  ConnectedReviewResultRecoveryInput,
  ConnectedReviewResultRecoveryReceiptV1,
  ImportEvidenceSummary,
  ImportEvidenceWriteInput,
  MissionResultSnapshot,
  StoredImportEvidence,
} from "./result";
import type {
  GitVerificationAdapter,
  VerificationRunner,
} from "./verification";
import { workspaceRelativePosixPathSchema } from "./workspace-path";

export const WORK_ITEM_TYPES = [
  "Explore",
  "Prototype",
  "MVP",
  "Feature",
  "Fix",
  "Maintenance",
  "Incident",
] as const;

export const WORK_ITEM_PHASES = [
  "idea",
  "brainstorm",
  "spec",
  "plan",
  "execute",
  "review",
  "patch",
  "test",
  "ship",
  "learn",
] as const;

export const WORK_ITEM_STATUSES = [
  "active",
  "paused",
  "blocked",
  "cancelled",
] as const;

export const CAPTURE_KINDS = ["idea", "todo"] as const;

export const WORK_ITEM_PRIORITIES = ["low", "normal", "high"] as const;

export const WORK_ITEM_ATTENTION_KINDS = [
  "spec_approval",
  "plan_approval",
  "patch_plan_approval",
  "unresolved_finding",
  "ambiguous_goal",
  "cycle_limit",
  "missing_permission",
  "command_authorization",
  "review_ready",
] as const;

export const CONTROLLER_RUN_OUTCOMES = [
  "pending",
  "applied",
  "rejected",
  "failed",
] as const;

export const CONTROLLER_CONFLICT_KINDS = [
  "work_item_not_found",
  "contract_required",
  "stale_expectation",
  "invalid_transition",
  "attempt_conflict",
  "lease_held",
  "repair_required",
  "idempotency_conflict",
  "contracted_details",
  "goal_contract_locked",
  "project_locked",
  "mission_not_ready",
] as const;

export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];
export type WorkItemPhase = (typeof WORK_ITEM_PHASES)[number];
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];
export type CaptureKind = (typeof CAPTURE_KINDS)[number];
export type WorkItemPriority = (typeof WORK_ITEM_PRIORITIES)[number];
export type WorkItemAttentionKind =
  (typeof WORK_ITEM_ATTENTION_KINDS)[number];
export type ControllerRunOutcome = (typeof CONTROLLER_RUN_OUTCOMES)[number];
export type ControllerConflictKind =
  (typeof CONTROLLER_CONFLICT_KINDS)[number];

export const PLAN_APPROVAL_MANIFEST_OUTCOMES = [
  "pending",
  "applied",
  "failed",
] as const;

export type PlanApprovalManifestOutcome =
  (typeof PLAN_APPROVAL_MANIFEST_OUTCOMES)[number];

export interface VerificationCommand {
  name: string;
  argv: [string, ...string[]];
  timeout_seconds: number;
}

export interface ProductManifest {
  schema_version: 2;
  product_name: string;
  verification: {
    required_commands: [VerificationCommand, ...VerificationCommand[]];
  };
}

export interface GoalContract {
  schema_version: 1;
  goal_version: number;
  purpose: string;
  acceptance_criteria: string[];
  non_goals: string[];
  allowed_scope: string[];
  review_ready: string[];
}

export interface WorkItemGoal {
  schema_version: 2;
  work_item_id: string;
  title: string;
  type?: WorkItemType;
  capture?: WorkItemCapture;
  priority?: WorkItemPriority;
  tags?: string[];
  notes?: string;
  goal_contract?: GoalContract;
}

export interface WorkItemCapture {
  kind: CaptureKind;
  original_title: string;
  captured_at: string;
}

export interface GovernedTuple {
  goal_version: number;
  input_revision: number;
  attempt: number;
  patch_cycle: number;
}

export interface WorkItemAttentionPins {
  artifact_paths: [string, ...string[]];
  evidence_paths: string[];
  git_commit?: string;
  mission_content_sha256?: string;
  result_content_sha256?: string;
}

interface WorkItemAttentionBase {
  question: string;
  recommendation: string;
  created_at: string;
  governed_tuple: GovernedTuple;
  pins: WorkItemAttentionPins;
}

export type CommandAuthorizationCommand = Extract<
  CanonicalCapabilityRequest,
  { kind: "command" }
>;

export interface CommandAuthorizationProposalV1 {
  schema_version: 1;
  phase: "execute" | "patch";
  work_item_id: string;
  governed_tuple: GovernedTuple;
  source_mission_content_sha256: string;
  terminal_connected_run_id: string;
  changed_files: string[];
  commands: [CommandAuthorizationCommand, ...CommandAuthorizationCommand[]];
  proposal_sha256: string;
}

export interface MissingPermissionOperation {
  normalized_operation: CanonicalCapabilityRequest;
  canonical_args_sha256: string;
  operation_sha256: string;
  reason: string;
  resolved_envelope_sha256: string;
  connected_run_id: string;
}

type StandardWorkItemAttentionKind = Exclude<
  WorkItemAttentionKind,
  "missing_permission" | "command_authorization"
>;

type StandardWorkItemAttention = {
  [TKind in StandardWorkItemAttentionKind]: WorkItemAttentionBase & {
    kind: TKind;
  };
}[StandardWorkItemAttentionKind];

export type WorkItemAttention =
  | StandardWorkItemAttention
  | (WorkItemAttentionBase & {
      kind: "missing_permission";
      operation: MissingPermissionOperation;
    })
  | (WorkItemAttentionBase & {
      kind: "command_authorization";
      proposal: CommandAuthorizationProposalV1;
    });

export type ConnectedPermissionDecision =
  | "allow_once"
  | "retry_without_allowing"
  | "keep_denied";

export interface ConnectedPermissionResolutionInput {
  decision: ConnectedPermissionDecision;
  expected_phase: "execute" | "patch";
  governed_tuple: GovernedTuple;
  operation_sha256: string;
  connected_run_id: string;
  mission_content_sha256: string;
}

export interface CommandAuthorizationDecisionInput {
  decision: "allow_once" | "keep_denied";
  expected_phase: "execute" | "patch";
  governed_tuple: GovernedTuple;
  source_mission_content_sha256: string;
  terminal_connected_run_id: string;
  proposal_sha256: string;
}

export interface RecordConnectedPermissionDenialInput {
  expected_phase: "execute" | "patch";
  expected_status: "active";
  expected_schema_version: 2;
  governed_tuple: GovernedTuple;
  mission_content_sha256: string;
  operation: MissingPermissionOperation;
}

export interface WorkItemState {
  schema_version: 2;
  work_item_id: string;
  phase: WorkItemPhase;
  status: WorkItemStatus;
  updated_at: string;
  goal_version?: number;
  input_revision?: number;
  attempt?: number;
  patch_cycle?: number;
  attention?: WorkItemAttention;
  active_run?: ActiveRun;
}

export interface ActiveRun {
  run_id: string;
  idempotency_key: string;
  acquired_at: string;
}

export interface WorkItem {
  goal: WorkItemGoal;
  state: WorkItemState;
}

export interface CreateWorkItemInput {
  title: string;
  type: WorkItemType;
}

export interface CreateCaptureInput {
  title: string;
  capture_kind: CaptureKind;
  source_id?: string;
  priority?: WorkItemPriority;
  tags?: string[];
  notes?: string;
}

export interface UpdateWorkItemPhaseInput {
  target_phase: WorkItemPhase;
}

export interface SaveWorkItemInput {
  target_source_id: string;
  title: string;
  type: WorkItemType | null;
  priority: WorkItemPriority | null;
  tags: string[];
  notes: string | null;
  goal_contract?: {
    purpose: string;
    acceptance_criteria: string[];
    non_goals: string[];
    allowed_scope: string[];
    review_ready: string[];
  };
  expected_goal_version?: number;
  expected_input_revision?: number;
}

export interface ControllerTransitionInput {
  target_phase: WorkItemPhase;
  target_status: WorkItemStatus;
  expected_phase: WorkItemPhase;
  expected_status: WorkItemStatus;
  expected_schema_version: 2;
  expected_goal_version: number;
  expected_input_revision: number;
  attempt: number;
}

export interface ImportExternalResultInput {
  expected_phase: "execute";
  expected_status: "active";
  expected_schema_version: 2;
  expected_goal_version: number;
  expected_input_revision: number;
  attempt: number;
}

export interface ImportReviewResultInput {
  expected_phase: "review";
  expected_status: "active";
  expected_schema_version: 2;
  expected_goal_version: number;
  expected_input_revision: number;
  attempt: number;
  expected_patch_cycle: number;
}

export interface AcceptPatchPlanInput {
  expected_phase: "review";
  expected_status: "active";
  expected_schema_version: 2;
  expected_goal_version: number;
  expected_input_revision: number;
  attempt: number;
  expected_patch_cycle: number;
}

export interface ImportPatchResultInput {
  expected_phase: "patch";
  expected_status: "active";
  expected_schema_version: 2;
  expected_goal_version: number;
  expected_input_revision: number;
  attempt: number;
  expected_patch_cycle: number;
}

export interface RetryExecuteAttemptInput {
  expected_phase: "execute";
  expected_status: "blocked";
  expected_schema_version: 2;
  expected_goal_version: number;
  expected_input_revision: number;
  attempt: number;
}

export interface ApprovePlanResultInput {
  launch_mode: "connected" | "manual";
  requested_model: string | null;
  expected_mission_content_sha256: string;
  expected_result_content_sha256: string;
  expected_shaping_state_sha256: string;
  goal_contract_sha256: string;
}

export interface PlanApprovalIntentV1 {
  schema_version: 1;
  approval_id: string;
  work_item_id: string;
  launch_mode: "connected" | "manual";
  requested_model: string | null;
  expected_mission_content_sha256: string;
  expected_result_content_sha256: string;
  expected_shaping_state_sha256: string;
  goal_contract_sha256: string;
  goal_version: number;
  previous_goal_bytes: string;
  previous_goal_sha256: string;
  previous_state_bytes: string;
  previous_state_sha256: string;
  next_goal_bytes: string;
  next_goal_sha256: string;
  next_state_bytes: string;
  next_state_sha256: string;
  receipt_bytes: string;
  receipt_sha256: string;
  execute_tuple: PlanApprovalExecuteTuple;
  created_at: string;
}

export type PlanApprovalIdInput = Pick<
  PlanApprovalIntentV1,
  | "work_item_id"
  | "expected_mission_content_sha256"
  | "expected_result_content_sha256"
  | "expected_shaping_state_sha256"
  | "goal_contract_sha256"
  | "goal_version"
>;

export interface PlanApprovalManifestV1 {
  schema_version: 1;
  approval_id: string;
  work_item_id: string;
  launch_mode: "connected" | "manual";
  requested_model: string | null;
  expected_mission_content_sha256: string;
  expected_result_content_sha256: string;
  expected_shaping_state_sha256: string;
  goal_contract_sha256: string;
  goal_version: number;
  receipt_sha256: string;
  execute_tuple: PlanApprovalExecuteTuple;
  goal_sha256: string;
  state_sha256: string;
  started_at: string;
  completed_at?: string;
  outcome: PlanApprovalManifestOutcome;
}

export interface ControllerRunManifest {
  schema_version: 1;
  run_id: string;
  work_item_id: string;
  idempotency_key: string;
  phase: WorkItemPhase;
  goal_version: number;
  input_revision: number;
  attempt: number;
  started_at: string;
  completed_at?: string;
  outcome: ControllerRunOutcome;
  capability_grant?: ControllerCapabilityGrant;
  capability_carry_forward?: ControllerCapabilityCarryForward;
  scope_correction?: ScopeCorrectionProposalV1;
  review_import_drift_recovery?: ReviewImportDriftRecoveryProposalV1;
  command_authorization?: CommandAuthorizationProposalV1;
}

export interface ScopeCorrectionProposalV1 {
  schema_version: 1;
  work_item_id: string;
  source_goal_contract_sha256: string;
  governed_tuple: GovernedTuple;
  current_allowed_scope: string[];
  proposed_allowed_scope: string[];
  proposal_sha256: string;
}

export interface ApplyScopeCorrectionInput {
  source_goal_contract_sha256: string;
  governed_tuple: GovernedTuple;
  proposal_sha256: string;
}

export interface ReviewImportDriftRecoveryProposalV1 {
  schema_version: 1;
  work_item_id: string;
  identity: MissionIdentity<"review">;
  patch_cycle: number;
  review_mission_content_sha256: string;
  result_content_sha256: string;
  rejected_import_run_id: string;
  rejected_import_controller_run_id: string;
  rejected_import_evidence_path: string;
  accepted_result_commit: string;
  current_head_commit: string;
  changed_files: [string, ...string[]];
  /** Advisory overlap disclosed to the founder; non-empty overlap does not block recovery. */
  subject_changed_files: string[];
  proposal_sha256: string;
}

export interface ApplyReviewImportDriftRecoveryInput {
  decision: "accept_exact_drift";
  governed_tuple: GovernedTuple;
  review_mission_content_sha256: string;
  result_content_sha256: string;
  rejected_import_run_id: string;
  accepted_result_commit: string;
  current_head_commit: string;
  proposal_sha256: string;
}

export interface ControllerCapabilityGrant {
  schema_version: 1;
  source_mission_content_sha256: string;
  execution_defaults: ExecutionDefaultsV1;
  grant_sha256: string;
}

export interface ControllerCapabilityCarryForward {
  schema_version: 1;
  kind: "carry_forward";
  source_mission_content_sha256: string;
  execution_defaults: ExecutionDefaultsV1;
  carry_forward_sha256: string;
}

export interface ControllerLease {
  work_item: WorkItem;
  active_run: ActiveRun;
  acquired_goal_bytes: string;
  acquired_state_bytes: string;
}

export interface ControllerMutationInput {
  goal: WorkItemGoal;
  state: WorkItemState;
  manifest: ControllerRunManifest;
}

export interface ControllerMutationResult {
  work_item: WorkItem;
  manifest: ControllerRunManifest;
}

export type ShapingDecisionIntentDraft = Omit<
  ShapingDecisionIntentV1,
  | "decision_id"
  | "previous_goal_bytes"
  | "previous_goal_sha256"
  | "previous_state_bytes"
  | "previous_state_sha256"
  | "next_goal_bytes"
  | "next_goal_sha256"
  | "next_state_bytes"
  | "next_state_sha256"
  | "created_at"
>;

export interface ShapingDecisionIntentCaptureInput {
  intent: ShapingDecisionIntentDraft;
  goal?: WorkItemGoal;
  state: WorkItemState;
}

export interface ShapingDecisionIntentWriteResult {
  intent: ShapingDecisionIntentV1;
  intent_path: string;
  intent_source: string;
}

export interface ShapingDecisionCommitInput {
  goal?: WorkItemGoal;
  state: WorkItemState;
  manifest: ShapingDecisionManifestV1;
}

export interface ShapingDecisionCommitResult {
  work_item: WorkItem;
  manifest: ShapingDecisionManifestV1;
}

export type PlanApprovalIntentDraft = Omit<
  PlanApprovalIntentV1,
  | "approval_id"
  | "previous_goal_bytes"
  | "previous_goal_sha256"
  | "previous_state_bytes"
  | "previous_state_sha256"
  | "next_goal_bytes"
  | "next_goal_sha256"
  | "next_state_bytes"
  | "next_state_sha256"
  | "created_at"
>;

export interface PlanApprovalIntentCaptureInput {
  intent: PlanApprovalIntentDraft;
  goal?: WorkItemGoal;
  state: WorkItemState;
}

export interface PlanApprovalIntentWriteResult {
  intent: PlanApprovalIntentV1;
  intent_path: string;
  intent_source: string;
}

export interface PlanApprovalCommitInput {
  goal?: WorkItemGoal;
  state: WorkItemState;
  manifest: PlanApprovalManifestV1;
}

export interface PlanApprovalCommitResult {
  work_item: WorkItem;
  manifest: PlanApprovalManifestV1;
}

export interface RetainedControllerLeaseRepairResult {
  repaired: boolean;
  reason: "repaired" | "nothing_retained";
  retained_run: ActiveRun | null;
}

export interface WorkItemRepository {
  readManifest(): Promise<ProductManifest>;
  create(input: CreateWorkItemInput): Promise<WorkItem>;
  createCapture(input: CreateCaptureInput): Promise<WorkItem>;
  read(workItemId: string): Promise<WorkItem | null>;
  list(): Promise<WorkItem[]>;
  updateGoal(
    workItemId: string,
    nextGoal: WorkItemGoal,
  ): Promise<WorkItem | null>;
  updatePhase(
    workItemId: string,
    input: UpdateWorkItemPhaseInput,
  ): Promise<WorkItem | null>;
  hasWorkItem(workItemId: string): Promise<boolean>;
  stageIncomingWorkItem(
    item: WorkItem,
    manifest?: ControllerRunManifest,
  ): Promise<string>;
  publishStagedWorkItem(
    workItemId: string,
    stagingPath: string,
  ): Promise<void>;
  discardStagedWorkItem(
    workItemId: string,
    stagingPath: string,
  ): Promise<void>;
  removeWorkItem(workItemId: string): Promise<void>;
  acquireControllerLease(
    workItemId: string,
    activeRun: ActiveRun,
  ): Promise<ControllerLease | null>;
  repairRetainedControllerLease(
    workItemId: string,
    input: { acknowledged_run_id: string },
  ): Promise<RetainedControllerLeaseRepairResult>;
  readControllerRunManifest(
    workItemId: string,
    runId: string,
  ): Promise<ControllerRunManifest | null>;
  findAppliedExecuteManifest(
    identity: MissionIdentity<"execute">,
  ): Promise<ControllerRunManifest | null>;
  findAppliedPatchManifest(
    identity: MissionIdentity<"patch">,
  ): Promise<ControllerRunManifest | null>;
  findAppliedPatchAttemptManifest(
    identity: MissionIdentity<"patch">,
  ): Promise<ControllerRunManifest | null>;
  writeMissionPackage<TMission extends import("./mission").MissionPackage>(
    identity: MissionIdentity,
    buildPackage: MissionPackageBuilder<TMission>,
  ): Promise<MissionArtifactWriteResult<TMission>>;
  readMissionResult(
    identity: MissionIdentity,
    reviewPatchCycle?: number,
  ): Promise<MissionResultSnapshot>;
  readMissionPackage(
    identity: MissionIdentity,
    reviewPatchCycle?: number,
  ): Promise<MissionArtifactReadResult>;
  createConnectedRun(
    record: ConnectedRunRecordV2,
  ): Promise<{ record: ConnectedRunRecordV2; created: boolean }>;
  readConnectedRun(
    workItemId: string,
    connectedRunId: string,
  ): Promise<ConnectedRunRecordV2 | null>;
  listConnectedRuns(workItemId: string): Promise<ConnectedRunRecordV2[]>;
  recoverConnectedReviewResult(
    input: ConnectedReviewResultRecoveryInput,
  ): Promise<ConnectedReviewResultRecoveryReceiptV1>;
  readImportEvidence(
    identity: MissionIdentity,
    importRunId: string,
  ): Promise<StoredImportEvidence | null>;
  writeImportEvidence(
    input: ImportEvidenceWriteInput,
  ): Promise<ImportEvidenceSummary>;
  listImportEvidence(workItemId: string): Promise<StoredImportEvidence[]>;
  gitVerificationAdapter(): GitVerificationAdapter;
  verificationRunner(): VerificationRunner;
  commitControllerMutation(
    lease: ControllerLease,
    input: ControllerMutationInput,
  ): Promise<ControllerMutationResult>;
  writeShapingDecisionIntent(
    lease: ControllerLease,
    input: ShapingDecisionIntentCaptureInput,
  ): Promise<ShapingDecisionIntentWriteResult>;
  readShapingDecisionIntent(
    workItemId: string,
    decisionId: string,
  ): Promise<ShapingDecisionIntentV1 | null>;
  readShapingDecisionManifest(
    workItemId: string,
    decisionId: string,
  ): Promise<ShapingDecisionManifestV1 | null>;
  publishLeasedShapingMission(
    lease: ControllerLease,
    identity: ShapingIdentity,
    missionBytes: string,
    input: { decision_id: string },
  ): Promise<ShapingArtifactWriteResult>;
  commitShapingDecision(
    lease: ControllerLease,
    input: ShapingDecisionCommitInput,
  ): Promise<ShapingDecisionCommitResult>;
  reconcileShapingDecisionCommit(
    lease: ControllerLease,
    decisionId: string,
  ): Promise<ShapingDecisionCommitResult>;
  writePlanApprovalIntent(
    lease: ControllerLease,
    input: PlanApprovalIntentCaptureInput,
  ): Promise<PlanApprovalIntentWriteResult>;
  readPlanApprovalIntent(
    workItemId: string,
    approvalId: string,
  ): Promise<PlanApprovalIntentV1 | null>;
  readPlanApprovalManifest(
    workItemId: string,
    approvalId: string,
  ): Promise<PlanApprovalManifestV1 | null>;
  commitPlanApproval(
    lease: ControllerLease,
    input: PlanApprovalCommitInput,
  ): Promise<PlanApprovalCommitResult>;
  reconcilePlanApprovalCommit(
    lease: ControllerLease,
    approvalId: string,
  ): Promise<PlanApprovalCommitResult>;
  releaseControllerLease(lease: ControllerLease): Promise<void>;
}

export interface ReviewWorkItemRepository extends WorkItemRepository {
  readAppliedExecuteReviewSubject(
    identity: MissionIdentity<"execute">,
  ): Promise<AppliedExecuteReviewSubject>;
  readAppliedPatchReviewSubject(
    identity: MissionIdentity<"patch">,
  ): Promise<AppliedPatchReviewSubject>;
  writePatchMissionPackage(
    identity: MissionIdentity<"patch">,
    patchSubject: PatchSubject,
    buildPackage: MissionPackageBuilder<PatchMissionPackage>,
  ): Promise<MissionArtifactWriteResult<PatchMissionPackage>>;
  writeReviewMissionPackage(
    identity: MissionIdentity<"review">,
    reviewSubject: ReviewMissionPackage["review_subject"],
    buildPackage: MissionPackageBuilder<ReviewMissionPackage>,
  ): Promise<MissionArtifactWriteResult<ReviewMissionPackage>>;
}

export type ControllerWorkItemRepository = ReviewWorkItemRepository;

export const workItemIdSchema = z
  .string()
  .regex(
    /^wi_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "work_item_id must use the wi_<uuid> format",
  );

const titleSchema = z
  .string()
  .refine((title) => title.trim().length > 0, "title must not be empty")
  .refine(
    (title) => title === title.trim(),
    "title must not have leading or trailing whitespace",
  );

const tagSchema = z.string().trim().min(1, "tags must not be empty");

const tagsSchema: z.ZodType<string[]> = z
  .array(tagSchema)
  .refine(
    (tags) => new Set(tags.map((tag) => tag.toLocaleLowerCase())).size === tags.length,
    "tags must not contain case-insensitive duplicates",
  );

const notesSchema = z
  .string()
  .refine((notes) => notes.trim().length > 0, "notes must not be empty");

const positiveSafeIntegerSchema = z.number().int().positive().safe();
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();

function uniqueNonEmptyListSchema(label: string): z.ZodType<string[]> {
  return z
    .array(z.string().trim().min(1, `${label} entries must not be empty`))
    .min(1, `${label} must not be empty`)
    .refine(
      (entries) =>
        new Set(entries.map((entry) => entry.toLocaleLowerCase())).size ===
        entries.length,
      `${label} must not contain case-insensitive duplicates`,
    );
}

const acceptanceCriteriaSchema = uniqueNonEmptyListSchema(
  "acceptance_criteria",
);
const purposeSchema = z
  .string()
  .refine((purpose) => purpose.trim().length > 0, "purpose must not be empty")
  .refine(
    (purpose) => purpose === purpose.trim(),
    "purpose must not have leading or trailing whitespace",
  )
  .refine(
    (purpose) => !/[\r\n]/u.test(purpose),
    "purpose must not contain line breaks",
  );
const nonGoalsSchema = uniqueNonEmptyListSchema("non_goals");
const allowedScopeSchema = z
  .array(workspaceRelativePosixPathSchema)
  .min(1, "allowed_scope must not be empty")
  .refine(
    (entries) =>
      new Set(entries.map((entry) => entry.toLocaleLowerCase())).size ===
      entries.length,
    "allowed_scope must not contain case-insensitive duplicates",
  );
const reviewReadySchema = uniqueNonEmptyListSchema("review_ready");

const nonEmptyIdentifierSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be empty")
  .refine(
    (value) => value === value.trim(),
    "must not have leading or trailing whitespace",
  );

export const controllerRunIdSchema = z.uuid();

export const verificationCommandSchema: z.ZodType<VerificationCommand> =
  z.strictObject({
    name: nonEmptyIdentifierSchema,
    argv: z.tuple([nonEmptyIdentifierSchema], z.string()),
    timeout_seconds: z.number().int().min(1).max(900),
  });

const requiredVerificationCommandsSchema = z
  .tuple([verificationCommandSchema], verificationCommandSchema)
  .refine(
    (commands) =>
      new Set(commands.map((command) => command.name.toLocaleLowerCase()))
        .size === commands.length,
    "verification command names must not contain case-insensitive duplicates",
  );

export const productManifestSchema: z.ZodType<ProductManifest> = z.strictObject({
  schema_version: z.literal(2),
  product_name: z.string(),
  verification: z.strictObject({
    required_commands: requiredVerificationCommandsSchema,
  }),
});

export const workItemCaptureSchema: z.ZodType<WorkItemCapture> = z.strictObject({
  kind: z.enum(CAPTURE_KINDS),
  original_title: titleSchema,
  captured_at: z.iso.datetime(),
});

export const goalContractSchema: z.ZodType<GoalContract> = z.strictObject({
  schema_version: z.literal(1),
  goal_version: positiveSafeIntegerSchema,
  purpose: purposeSchema,
  acceptance_criteria: acceptanceCriteriaSchema,
  non_goals: nonGoalsSchema,
  allowed_scope: allowedScopeSchema,
  review_ready: reviewReadySchema,
});

export const workItemGoalSchema: z.ZodType<WorkItemGoal> = z.strictObject({
  schema_version: z.literal(2),
  work_item_id: workItemIdSchema,
  title: titleSchema,
  type: z.enum(WORK_ITEM_TYPES).optional(),
  capture: workItemCaptureSchema.optional(),
  priority: z.enum(WORK_ITEM_PRIORITIES).optional(),
  tags: tagsSchema.optional(),
  notes: notesSchema.optional(),
  goal_contract: goalContractSchema.optional(),
});

export const activeRunSchema: z.ZodType<ActiveRun> = z.strictObject({
  run_id: controllerRunIdSchema,
  idempotency_key: nonEmptyIdentifierSchema,
  acquired_at: z.iso.datetime(),
});

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const gitCommitSchema = z.string().regex(/^[0-9a-f]{40}$/);
const nonEmptyPathListSchema: z.ZodType<[string, ...string[]]> = z
  .tuple([workspaceRelativePosixPathSchema], workspaceRelativePosixPathSchema)
  .refine(
    (paths) => new Set(paths).size === paths.length,
    "artifact_paths must not contain duplicates",
  );
const evidencePathListSchema = z
  .array(workspaceRelativePosixPathSchema)
  .refine(
    (paths) => new Set(paths).size === paths.length,
    "evidence_paths must not contain duplicates",
  );

export const governedTupleSchema: z.ZodType<GovernedTuple> = z.strictObject({
  goal_version: positiveSafeIntegerSchema,
  input_revision: positiveSafeIntegerSchema,
  attempt: nonNegativeSafeIntegerSchema,
  patch_cycle: nonNegativeSafeIntegerSchema,
});

const planApprovalExecuteTupleSchema: z.ZodType<PlanApprovalExecuteTuple> =
  z.strictObject({
    goal_version: positiveSafeIntegerSchema,
    input_revision: positiveSafeIntegerSchema,
    attempt: z.literal(0),
  });

function validatePlanApprovalLaunchBinding(
  input: { launch_mode: "connected" | "manual"; requested_model: string | null },
  context: z.RefinementCtx,
): void {
  if ((input.launch_mode === "connected") !== (input.requested_model !== null)) {
    context.addIssue({
      code: "custom",
      message:
        input.launch_mode === "connected"
          ? "connected launch mode requires one requested model"
          : "manual launch mode forbids a requested model",
      path: ["requested_model"],
      input: input.requested_model,
    });
  }
}

function validatePlanApprovalGoalVersion(
  input: { goal_version: number; execute_tuple: PlanApprovalExecuteTuple },
  context: z.RefinementCtx,
): void {
  if (input.goal_version !== input.execute_tuple.goal_version) {
    context.addIssue({
      code: "custom",
      message: "Execute tuple goal version must match approval goal version",
      path: ["execute_tuple", "goal_version"],
      input: input.execute_tuple.goal_version,
    });
  }
}

export const planApprovalIntentSchema: z.ZodType<PlanApprovalIntentV1> = z
  .strictObject({
    schema_version: z.literal(1),
    approval_id: sha256Schema,
    work_item_id: workItemIdSchema,
    launch_mode: z.enum(["connected", "manual"]),
    requested_model: nonEmptyIdentifierSchema.nullable(),
    expected_mission_content_sha256: sha256Schema,
    expected_result_content_sha256: sha256Schema,
    expected_shaping_state_sha256: sha256Schema,
    goal_contract_sha256: sha256Schema,
    goal_version: positiveSafeIntegerSchema,
    previous_goal_bytes: z.string(),
    previous_goal_sha256: sha256Schema,
    previous_state_bytes: z.string(),
    previous_state_sha256: sha256Schema,
    next_goal_bytes: z.string(),
    next_goal_sha256: sha256Schema,
    next_state_bytes: z.string(),
    next_state_sha256: sha256Schema,
    receipt_bytes: z.string(),
    receipt_sha256: sha256Schema,
    execute_tuple: planApprovalExecuteTupleSchema,
    created_at: z.iso.datetime(),
  })
  .superRefine((intent, context) => {
    validatePlanApprovalLaunchBinding(intent, context);
    validatePlanApprovalGoalVersion(intent, context);
  });

export const planApprovalManifestSchema: z.ZodType<PlanApprovalManifestV1> = z
  .strictObject({
    schema_version: z.literal(1),
    approval_id: sha256Schema,
    work_item_id: workItemIdSchema,
    launch_mode: z.enum(["connected", "manual"]),
    requested_model: nonEmptyIdentifierSchema.nullable(),
    expected_mission_content_sha256: sha256Schema,
    expected_result_content_sha256: sha256Schema,
    expected_shaping_state_sha256: sha256Schema,
    goal_contract_sha256: sha256Schema,
    goal_version: positiveSafeIntegerSchema,
    receipt_sha256: sha256Schema,
    execute_tuple: planApprovalExecuteTupleSchema,
    goal_sha256: sha256Schema,
    state_sha256: sha256Schema,
    started_at: z.iso.datetime(),
    completed_at: z.iso.datetime().optional(),
    outcome: z.enum(PLAN_APPROVAL_MANIFEST_OUTCOMES),
  })
  .superRefine((manifest, context) => {
    validatePlanApprovalLaunchBinding(manifest, context);
    validatePlanApprovalGoalVersion(manifest, context);
  });

export const workItemAttentionPinsSchema: z.ZodType<WorkItemAttentionPins> =
  z.strictObject({
    artifact_paths: nonEmptyPathListSchema,
    evidence_paths: evidencePathListSchema,
    git_commit: gitCommitSchema.optional(),
    mission_content_sha256: sha256Schema.optional(),
    result_content_sha256: sha256Schema.optional(),
  });

export const missingPermissionOperationSchema: z.ZodType<MissingPermissionOperation> =
  z
    .strictObject({
      normalized_operation: canonicalCapabilityRequestSchema,
      canonical_args_sha256: sha256Schema,
      operation_sha256: sha256Schema,
      reason: nonEmptyIdentifierSchema,
      resolved_envelope_sha256: sha256Schema,
      connected_run_id: controllerRunIdSchema,
    })
    .superRefine((operation, context) => {
      const expectedOperationSha256 = hashCanonicalCapabilityRequest(
        operation.normalized_operation,
      );
      if (operation.operation_sha256 !== expectedOperationSha256) {
        context.addIssue({
          code: "custom",
          message: "operation_sha256 must hash normalized_operation",
          path: ["operation_sha256"],
          input: operation.operation_sha256,
        });
      }
    });

const attentionRecordFields = {
  question: nonEmptyIdentifierSchema,
  recommendation: nonEmptyIdentifierSchema,
  created_at: z.iso.datetime(),
  governed_tuple: governedTupleSchema,
  pins: workItemAttentionPinsSchema,
};

const commandAuthorizationCommandSchema: z.ZodType<CommandAuthorizationCommand> =
  canonicalCapabilityRequestSchema.refine(
    (operation): operation is CommandAuthorizationCommand =>
      operation.kind === "command",
    "command authorization accepts only command operations",
  );

const commandAuthorizationProposalContentSchema = z.strictObject({
  schema_version: z.literal(1),
  phase: z.enum(["execute", "patch"]),
  work_item_id: workItemIdSchema,
  governed_tuple: governedTupleSchema,
  source_mission_content_sha256: sha256Schema,
  terminal_connected_run_id: controllerRunIdSchema,
  changed_files: z
    .array(workspaceRelativePosixPathSchema)
    .min(1)
    .refine(
      (paths) => new Set(paths).size === paths.length,
      "changed_files must not contain duplicates",
    ),
  commands: z.tuple(
    [commandAuthorizationCommandSchema],
    commandAuthorizationCommandSchema,
  ),
});

export function hashCommandAuthorizationProposal(
  input: Omit<CommandAuthorizationProposalV1, "proposal_sha256">,
): string {
  const parsed = commandAuthorizationProposalContentSchema.parse({
    schema_version: input.schema_version,
    phase: input.phase,
    work_item_id: input.work_item_id,
    governed_tuple: input.governed_tuple,
    source_mission_content_sha256: input.source_mission_content_sha256,
    terminal_connected_run_id: input.terminal_connected_run_id,
    changed_files: input.changed_files,
    commands: input.commands,
  });
  return createHash("sha256")
    .update(`${JSON.stringify(parsed, null, 2)}\n`)
    .digest("hex");
}

export const commandAuthorizationProposalSchema: z.ZodType<CommandAuthorizationProposalV1> =
  commandAuthorizationProposalContentSchema
    .extend({ proposal_sha256: sha256Schema })
    .superRefine((proposal, context) => {
      if (
        proposal.proposal_sha256 !==
        hashCommandAuthorizationProposal(proposal)
      ) {
        context.addIssue({
          code: "custom",
          message: "proposal_sha256 must hash the command-authorization proposal",
          path: ["proposal_sha256"],
          input: proposal.proposal_sha256,
        });
      }
    });

export const workItemAttentionSchema: z.ZodType<WorkItemAttention> =
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("spec_approval"),
      ...attentionRecordFields,
    }),
    z.strictObject({
      kind: z.literal("plan_approval"),
      ...attentionRecordFields,
    }),
    z.strictObject({
      kind: z.literal("patch_plan_approval"),
      ...attentionRecordFields,
    }),
    z.strictObject({
      kind: z.literal("unresolved_finding"),
      ...attentionRecordFields,
    }),
    z.strictObject({
      kind: z.literal("ambiguous_goal"),
      ...attentionRecordFields,
    }),
    z.strictObject({
      kind: z.literal("cycle_limit"),
      ...attentionRecordFields,
    }),
    z.strictObject({
      kind: z.literal("missing_permission"),
      ...attentionRecordFields,
      operation: missingPermissionOperationSchema,
    }),
    z.strictObject({
      kind: z.literal("command_authorization"),
      ...attentionRecordFields,
      proposal: commandAuthorizationProposalSchema,
    }),
    z.strictObject({
      kind: z.literal("review_ready"),
      ...attentionRecordFields,
    }),
  ]);

const connectedPermissionResolutionFields = {
  expected_phase: z.enum(["execute", "patch"]),
  governed_tuple: governedTupleSchema,
  operation_sha256: sha256Schema,
  connected_run_id: controllerRunIdSchema,
  mission_content_sha256: sha256Schema,
};

export const allowOnceConnectedPermissionInputSchema = z.strictObject({
  decision: z.literal("allow_once"),
  ...connectedPermissionResolutionFields,
});

export const keepDeniedConnectedPermissionInputSchema = z.strictObject({
  decision: z.literal("keep_denied"),
  ...connectedPermissionResolutionFields,
});

export const retryWithoutAllowingConnectedPermissionInputSchema =
  z.strictObject({
    decision: z.literal("retry_without_allowing"),
    ...connectedPermissionResolutionFields,
  });

export const connectedPermissionResolutionInputSchema: z.ZodType<ConnectedPermissionResolutionInput> =
  z.discriminatedUnion("decision", [
    allowOnceConnectedPermissionInputSchema,
    retryWithoutAllowingConnectedPermissionInputSchema,
    keepDeniedConnectedPermissionInputSchema,
  ]);

const commandAuthorizationDecisionFields = {
  expected_phase: z.enum(["execute", "patch"]),
  governed_tuple: governedTupleSchema,
  source_mission_content_sha256: sha256Schema,
  terminal_connected_run_id: controllerRunIdSchema,
  proposal_sha256: sha256Schema,
};

export const commandAuthorizationDecisionInputSchema: z.ZodType<CommandAuthorizationDecisionInput> =
  z.discriminatedUnion("decision", [
    z.strictObject({
      decision: z.literal("allow_once"),
      ...commandAuthorizationDecisionFields,
    }),
    z.strictObject({
      decision: z.literal("keep_denied"),
      ...commandAuthorizationDecisionFields,
    }),
  ]);

export const recordConnectedPermissionDenialInputSchema: z.ZodType<RecordConnectedPermissionDenialInput> =
  z.strictObject({
    expected_phase: z.enum(["execute", "patch"]),
    expected_status: z.literal("active"),
    expected_schema_version: z.literal(2),
    governed_tuple: governedTupleSchema,
    mission_content_sha256: sha256Schema,
    operation: missingPermissionOperationSchema,
  });

interface VersionedStateFields {
  goal_version?: number;
  input_revision?: number;
  attempt?: number;
}

function validateVersionedStateFields(
  state: VersionedStateFields,
  context: z.RefinementCtx,
): void {
  const versionedFields = [
    "goal_version",
    "input_revision",
    "attempt",
  ] as const;
  const presentFields = versionedFields.filter(
    (field) => state[field] !== undefined,
  );

  if (presentFields.length > 0 && presentFields.length < versionedFields.length) {
    for (const field of versionedFields) {
      if (state[field] === undefined) {
        context.addIssue({
          code: "custom",
          message: `${field} is required when controller state is present`,
          path: [field],
          input: state,
        });
      }
    }
  }
}

const legacyWorkItemStateSchema = z
  .strictObject({
    schema_version: z.literal(1),
    work_item_id: workItemIdSchema,
    phase: z.enum(WORK_ITEM_PHASES),
    status: z.enum(WORK_ITEM_STATUSES),
    updated_at: z.iso.datetime(),
    goal_version: positiveSafeIntegerSchema.optional(),
    input_revision: positiveSafeIntegerSchema.optional(),
    attempt: nonNegativeSafeIntegerSchema.optional(),
    active_run: activeRunSchema.optional(),
  })
  .superRefine(validateVersionedStateFields);

export const workItemStateSchema: z.ZodType<WorkItemState> = z
  .strictObject({
    schema_version: z.literal(2),
    work_item_id: workItemIdSchema,
    phase: z.enum(WORK_ITEM_PHASES),
    status: z.enum(WORK_ITEM_STATUSES),
    updated_at: z.iso.datetime(),
    goal_version: positiveSafeIntegerSchema.optional(),
    input_revision: positiveSafeIntegerSchema.optional(),
    attempt: nonNegativeSafeIntegerSchema.optional(),
    patch_cycle: nonNegativeSafeIntegerSchema.optional(),
    attention: workItemAttentionSchema.optional(),
    active_run: activeRunSchema.optional(),
  })
  .superRefine((state, context) => {
    validateVersionedStateFields(state, context);

    const hasControllerState =
      state.goal_version !== undefined &&
      state.input_revision !== undefined &&
      state.attempt !== undefined;

    if (hasControllerState && state.patch_cycle === undefined) {
      context.addIssue({
        code: "custom",
        message: "patch_cycle is required when controller state is present",
        path: ["patch_cycle"],
        input: state,
      });
    } else if (!hasControllerState && state.patch_cycle !== undefined) {
      context.addIssue({
        code: "custom",
        message: "patch_cycle requires controller state",
        path: ["patch_cycle"],
        input: state,
      });
    }

    if (state.attention !== undefined && !hasControllerState) {
      context.addIssue({
        code: "custom",
        message: "attention requires controller state",
        path: ["attention"],
        input: state,
      });
    }

    if (state.attention !== undefined && state.patch_cycle !== undefined) {
      const expectedTuple = {
        goal_version: state.goal_version,
        input_revision: state.input_revision,
        attempt: state.attempt,
        patch_cycle: state.patch_cycle,
      };
      for (const field of Object.keys(expectedTuple) as Array<
        keyof GovernedTuple
      >) {
        if (state.attention.governed_tuple[field] !== expectedTuple[field]) {
          context.addIssue({
            code: "custom",
            message: `attention governed_tuple ${field} must match state ${field}`,
            path: ["attention", "governed_tuple", field],
            input: state.attention.governed_tuple[field],
          });
        }
      }
    }
  });

export function parseWorkItemStateForRead(input: unknown): WorkItemState {
  if (
    typeof input === "object" &&
    input !== null &&
    "schema_version" in input &&
    input.schema_version === 2
  ) {
    return workItemStateSchema.parse(input);
  }

  const legacyState = legacyWorkItemStateSchema.parse(input);
  const hasControllerState =
    legacyState.goal_version !== undefined &&
    legacyState.input_revision !== undefined &&
    legacyState.attempt !== undefined;

  return workItemStateSchema.parse({
    ...legacyState,
    schema_version: 2,
    ...(hasControllerState ? { patch_cycle: 0 } : {}),
  });
}

export const workItemSchema: z.ZodType<WorkItem> = z
  .strictObject({
    goal: workItemGoalSchema,
    state: workItemStateSchema,
  })
  .superRefine(({ goal, state }, context) => {
    if (goal.work_item_id !== state.work_item_id) {
      context.addIssue({
        code: "custom",
        message: "goal.yaml and state.json work_item_id values must agree",
        path: ["state", "work_item_id"],
        input: state.work_item_id,
      });
    }

    const goalContract = goal.goal_contract;
    const hasContract = goalContract !== undefined;
    const hasControllerState =
      state.goal_version !== undefined ||
      state.input_revision !== undefined ||
      state.attempt !== undefined ||
      state.patch_cycle !== undefined ||
      state.attention !== undefined ||
      state.active_run !== undefined;

    if (hasContract) {
      if (state.goal_version !== goalContract.goal_version) {
        context.addIssue({
          code: "custom",
          message: "state goal_version must match goal contract goal_version",
          path: ["state", "goal_version"],
          input: state.goal_version,
        });
      }
      if (state.input_revision === undefined) {
        context.addIssue({
          code: "custom",
          message: "input_revision is required for a contracted item",
          path: ["state", "input_revision"],
          input: state,
        });
      }
      if (state.attempt === undefined) {
        context.addIssue({
          code: "custom",
          message: "attempt is required for a contracted item",
          path: ["state", "attempt"],
          input: state,
        });
      }
    } else if (hasControllerState) {
      context.addIssue({
        code: "custom",
        message: "controller state requires a goal contract",
        path: ["state"],
        input: state,
      });
    }
  });

export const saveWorkItemInputSchema: z.ZodType<SaveWorkItemInput> = z
  .strictObject({
    target_source_id: portfolioSourceIdSchema,
    title: titleSchema,
    type: z.enum(WORK_ITEM_TYPES).nullable(),
    priority: z.enum(WORK_ITEM_PRIORITIES).nullable(),
    tags: tagsSchema,
    notes: notesSchema.nullable(),
    goal_contract: z
      .strictObject({
        purpose: purposeSchema,
        acceptance_criteria: acceptanceCriteriaSchema,
        non_goals: nonGoalsSchema,
        allowed_scope: allowedScopeSchema,
        review_ready: reviewReadySchema,
      })
      .optional(),
    expected_goal_version: positiveSafeIntegerSchema.optional(),
    expected_input_revision: positiveSafeIntegerSchema.optional(),
  })
  .superRefine((input, context) => {
    const hasExpectedGoalVersion = input.expected_goal_version !== undefined;
    const hasExpectedInputRevision =
      input.expected_input_revision !== undefined;

    if (hasExpectedGoalVersion !== hasExpectedInputRevision) {
      context.addIssue({
        code: "custom",
        message:
          "expected_goal_version and expected_input_revision must be provided together",
        path: hasExpectedGoalVersion
          ? ["expected_input_revision"]
          : ["expected_goal_version"],
        input,
      });
    }

    if (
      (hasExpectedGoalVersion || hasExpectedInputRevision) &&
      input.goal_contract === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "expected versions require a goal contract",
        path: ["goal_contract"],
        input,
      });
    }
  });

export const controllerTransitionInputSchema: z.ZodType<ControllerTransitionInput> =
  z.strictObject({
    target_phase: z.enum(WORK_ITEM_PHASES),
    target_status: z.enum(WORK_ITEM_STATUSES),
    expected_phase: z.enum(WORK_ITEM_PHASES),
    expected_status: z.enum(WORK_ITEM_STATUSES),
    expected_schema_version: z.literal(2),
    expected_goal_version: positiveSafeIntegerSchema,
    expected_input_revision: positiveSafeIntegerSchema,
    attempt: nonNegativeSafeIntegerSchema,
  });

export const importExternalResultInputSchema: z.ZodType<ImportExternalResultInput> =
  z.strictObject({
    expected_phase: z.literal("execute"),
    expected_status: z.literal("active"),
    expected_schema_version: z.literal(2),
    expected_goal_version: positiveSafeIntegerSchema,
    expected_input_revision: positiveSafeIntegerSchema,
    attempt: nonNegativeSafeIntegerSchema,
  });

export const importReviewResultInputSchema: z.ZodType<ImportReviewResultInput> =
  z.strictObject({
    expected_phase: z.literal("review"),
    expected_status: z.literal("active"),
    expected_schema_version: z.literal(2),
    expected_goal_version: positiveSafeIntegerSchema,
    expected_input_revision: positiveSafeIntegerSchema,
    attempt: nonNegativeSafeIntegerSchema,
    expected_patch_cycle: nonNegativeSafeIntegerSchema,
  });

export const acceptPatchPlanInputSchema: z.ZodType<AcceptPatchPlanInput> =
  z.strictObject({
    expected_phase: z.literal("review"),
    expected_status: z.literal("active"),
    expected_schema_version: z.literal(2),
    expected_goal_version: positiveSafeIntegerSchema,
    expected_input_revision: positiveSafeIntegerSchema,
    attempt: nonNegativeSafeIntegerSchema,
    expected_patch_cycle: nonNegativeSafeIntegerSchema,
  });

export const importPatchResultInputSchema: z.ZodType<ImportPatchResultInput> =
  z.strictObject({
    expected_phase: z.literal("patch"),
    expected_status: z.literal("active"),
    expected_schema_version: z.literal(2),
    expected_goal_version: positiveSafeIntegerSchema,
    expected_input_revision: positiveSafeIntegerSchema,
    attempt: nonNegativeSafeIntegerSchema,
    expected_patch_cycle: positiveSafeIntegerSchema,
  });

export const retryExecuteAttemptInputSchema: z.ZodType<RetryExecuteAttemptInput> =
  z.strictObject({
    expected_phase: z.literal("execute"),
    expected_status: z.literal("blocked"),
    expected_schema_version: z.literal(2),
    expected_goal_version: positiveSafeIntegerSchema,
    expected_input_revision: positiveSafeIntegerSchema,
    attempt: nonNegativeSafeIntegerSchema,
  });

export const approvePlanResultInputSchema: z.ZodType<ApprovePlanResultInput> = z
  .strictObject({
    launch_mode: z.enum(["connected", "manual"]),
    requested_model: nonEmptyIdentifierSchema.nullable(),
    expected_mission_content_sha256: sha256Schema,
    expected_result_content_sha256: sha256Schema,
    expected_shaping_state_sha256: sha256Schema,
    goal_contract_sha256: sha256Schema,
  })
  .superRefine(validatePlanApprovalLaunchBinding);

export function derivePlanApprovalId(input: PlanApprovalIdInput): string {
  const parsed = z
    .strictObject({
      work_item_id: workItemIdSchema,
      expected_mission_content_sha256: sha256Schema,
      expected_result_content_sha256: sha256Schema,
      expected_shaping_state_sha256: sha256Schema,
      goal_contract_sha256: sha256Schema,
      goal_version: positiveSafeIntegerSchema,
    })
    .parse({
      work_item_id: input.work_item_id,
      expected_mission_content_sha256:
        input.expected_mission_content_sha256,
      expected_result_content_sha256:
        input.expected_result_content_sha256,
      expected_shaping_state_sha256:
        input.expected_shaping_state_sha256,
      goal_contract_sha256: input.goal_contract_sha256,
      goal_version: input.goal_version,
    });
  return createHash("sha256")
    .update(
      JSON.stringify({
        work_item_id: parsed.work_item_id,
        expected_mission_content_sha256:
          parsed.expected_mission_content_sha256,
        expected_result_content_sha256:
          parsed.expected_result_content_sha256,
        expected_shaping_state_sha256:
          parsed.expected_shaping_state_sha256,
        goal_contract_sha256: parsed.goal_contract_sha256,
        goal_version: parsed.goal_version,
      }),
    )
    .digest("hex");
}

export function deriveControllerRunId(
  idempotencyKey: string,
  operationFingerprint: string,
): string {
  const digest = createHash("sha256")
    .update(idempotencyKey)
    .update("\0")
    .update(operationFingerprint)
    .digest("hex")
    .slice(0, 32)
    .split("");

  digest[12] = "5";
  digest[16] = ((Number.parseInt(digest[16], 16) & 0x3) | 0x8).toString(16);
  const value = digest.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export const controllerCapabilityGrantSchema: z.ZodType<ControllerCapabilityGrant> =
  z
    .strictObject({
      schema_version: z.literal(1),
      source_mission_content_sha256: sha256Schema,
      execution_defaults: executionDefaultsV1Schema,
      grant_sha256: sha256Schema,
    })
    .superRefine((grant, context) => {
      const expected = hashControllerCapabilityGrant({
        source_mission_content_sha256: grant.source_mission_content_sha256,
        execution_defaults: grant.execution_defaults,
      });
      if (grant.grant_sha256 !== expected) {
        context.addIssue({
          code: "custom",
          message: "grant_sha256 must hash the capability grant content",
          path: ["grant_sha256"],
          input: grant.grant_sha256,
        });
      }
    });

export const controllerCapabilityCarryForwardSchema: z.ZodType<ControllerCapabilityCarryForward> =
  z
    .strictObject({
      schema_version: z.literal(1),
      kind: z.literal("carry_forward"),
      source_mission_content_sha256: sha256Schema,
      execution_defaults: executionDefaultsV1Schema,
      carry_forward_sha256: sha256Schema,
    })
    .superRefine((carryForward, context) => {
      const expected = hashControllerCapabilityCarryForward(carryForward);
      if (carryForward.carry_forward_sha256 !== expected) {
        context.addIssue({
          code: "custom",
          message:
            "carry_forward_sha256 must hash the capability carry-forward content",
          path: ["carry_forward_sha256"],
          input: carryForward.carry_forward_sha256,
        });
      }
    });

export const controllerRunManifestSchema: z.ZodType<ControllerRunManifest> =
  z.strictObject({
    schema_version: z.literal(1),
    run_id: controllerRunIdSchema,
    work_item_id: workItemIdSchema,
    idempotency_key: nonEmptyIdentifierSchema,
    phase: z.enum(WORK_ITEM_PHASES),
    goal_version: positiveSafeIntegerSchema,
    input_revision: positiveSafeIntegerSchema,
    attempt: nonNegativeSafeIntegerSchema,
    started_at: z.iso.datetime(),
    completed_at: z.iso.datetime().optional(),
    outcome: z.enum(CONTROLLER_RUN_OUTCOMES),
    capability_grant: controllerCapabilityGrantSchema.optional(),
    capability_carry_forward:
      controllerCapabilityCarryForwardSchema.optional(),
    scope_correction: z.lazy(() => scopeCorrectionProposalSchema).optional(),
    review_import_drift_recovery: z
      .lazy(() => reviewImportDriftRecoveryProposalSchema)
      .optional(),
    command_authorization: z
      .lazy(() => commandAuthorizationProposalSchema)
      .optional(),
  }).superRefine((manifest, context) => {
    if (
      manifest.capability_grant !== undefined &&
      manifest.capability_carry_forward !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message:
          "controller manifests cannot grant and carry forward capability authorization together",
        path: ["capability_carry_forward"],
        input: manifest.capability_carry_forward,
      });
    }
  });

const scopeCorrectionProposalContentSchema = z.strictObject({
  schema_version: z.literal(1),
  work_item_id: workItemIdSchema,
  source_goal_contract_sha256: sha256Schema,
  governed_tuple: governedTupleSchema,
  current_allowed_scope: allowedScopeSchema,
  proposed_allowed_scope: allowedScopeSchema,
});

export function hashScopeCorrectionProposal(
  input: Omit<ScopeCorrectionProposalV1, "proposal_sha256">,
): string {
  const parsed = scopeCorrectionProposalContentSchema.parse({
    schema_version: input.schema_version,
    work_item_id: input.work_item_id,
    source_goal_contract_sha256: input.source_goal_contract_sha256,
    governed_tuple: input.governed_tuple,
    current_allowed_scope: input.current_allowed_scope,
    proposed_allowed_scope: input.proposed_allowed_scope,
  });
  return createHash("sha256")
    .update(`${JSON.stringify(parsed, null, 2)}\n`)
    .digest("hex");
}

export const scopeCorrectionProposalSchema: z.ZodType<ScopeCorrectionProposalV1> =
  scopeCorrectionProposalContentSchema
    .extend({ proposal_sha256: sha256Schema })
    .superRefine((proposal, context) => {
      if (proposal.proposal_sha256 !== hashScopeCorrectionProposal(proposal)) {
        context.addIssue({
          code: "custom",
          message: "proposal_sha256 must hash the scope-correction proposal",
          path: ["proposal_sha256"],
          input: proposal.proposal_sha256,
        });
      }
    });

export const applyScopeCorrectionInputSchema: z.ZodType<ApplyScopeCorrectionInput> =
  z.strictObject({
    source_goal_contract_sha256: sha256Schema,
    governed_tuple: governedTupleSchema,
    proposal_sha256: sha256Schema,
  });

const reviewImportDriftIdentitySchema: z.ZodType<MissionIdentity<"review">> =
  z.strictObject({
    phase: z.literal("review"),
    work_item_id: workItemIdSchema,
    goal_version: positiveSafeIntegerSchema,
    input_revision: positiveSafeIntegerSchema,
    attempt: nonNegativeSafeIntegerSchema,
  });

const sortedDriftPathListSchema = z
  .array(workspaceRelativePosixPathSchema)
  .refine(
    (paths) => new Set(paths).size === paths.length,
    "drift paths must not contain duplicates",
  )
  .refine(
    (paths) => paths.every((path, index) => index === 0 || paths[index - 1] < path),
    "drift paths must use canonical sorted order",
  );

const sortedNonEmptyDriftPathListSchema = z
  .tuple(
    [workspaceRelativePosixPathSchema],
    workspaceRelativePosixPathSchema,
  )
  .refine(
    (paths) => new Set(paths).size === paths.length,
    "drift paths must not contain duplicates",
  )
  .refine(
    (paths) =>
      paths.every((path, index) => index === 0 || paths[index - 1] < path),
    "drift paths must use canonical sorted order",
  );

const reviewImportDriftRecoveryProposalContentSchema = z.strictObject({
  schema_version: z.literal(1),
  work_item_id: workItemIdSchema,
  identity: reviewImportDriftIdentitySchema,
  patch_cycle: nonNegativeSafeIntegerSchema,
  review_mission_content_sha256: sha256Schema,
  result_content_sha256: sha256Schema,
  rejected_import_run_id: sha256Schema,
  rejected_import_controller_run_id: controllerRunIdSchema,
  rejected_import_evidence_path: workspaceRelativePosixPathSchema,
  accepted_result_commit: gitCommitSchema,
  current_head_commit: gitCommitSchema,
  changed_files: sortedNonEmptyDriftPathListSchema,
  subject_changed_files: sortedDriftPathListSchema,
});

export function hashReviewImportDriftRecoveryProposal(
  input: Omit<ReviewImportDriftRecoveryProposalV1, "proposal_sha256">,
): string {
  const parsed = reviewImportDriftRecoveryProposalContentSchema.parse({
    schema_version: input.schema_version,
    work_item_id: input.work_item_id,
    identity: input.identity,
    patch_cycle: input.patch_cycle,
    review_mission_content_sha256: input.review_mission_content_sha256,
    result_content_sha256: input.result_content_sha256,
    rejected_import_run_id: input.rejected_import_run_id,
    rejected_import_controller_run_id:
      input.rejected_import_controller_run_id,
    rejected_import_evidence_path: input.rejected_import_evidence_path,
    accepted_result_commit: input.accepted_result_commit,
    current_head_commit: input.current_head_commit,
    changed_files: input.changed_files,
    subject_changed_files: input.subject_changed_files,
  });
  return createHash("sha256")
    .update(`${JSON.stringify(parsed, null, 2)}\n`)
    .digest("hex");
}

export const reviewImportDriftRecoveryProposalSchema: z.ZodType<ReviewImportDriftRecoveryProposalV1> =
  reviewImportDriftRecoveryProposalContentSchema
    .extend({ proposal_sha256: sha256Schema })
    .superRefine((proposal, context) => {
      if (proposal.work_item_id !== proposal.identity.work_item_id) {
        context.addIssue({
          code: "custom",
          message: "identity.work_item_id must match work_item_id",
          path: ["identity", "work_item_id"],
          input: proposal.identity.work_item_id,
        });
      }
      const changedFiles = new Set(proposal.changed_files);
      if (
        proposal.subject_changed_files.some((path) => !changedFiles.has(path))
      ) {
        context.addIssue({
          code: "custom",
          message: "subject_changed_files must be a subset of changed_files",
          path: ["subject_changed_files"],
          input: proposal.subject_changed_files,
        });
      }
      if (proposal.accepted_result_commit === proposal.current_head_commit) {
        context.addIssue({
          code: "custom",
          message: "current_head_commit must differ from accepted_result_commit",
          path: ["current_head_commit"],
          input: proposal.current_head_commit,
        });
      }
      if (
        proposal.proposal_sha256 !==
        hashReviewImportDriftRecoveryProposal(proposal)
      ) {
        context.addIssue({
          code: "custom",
          message: "proposal_sha256 must hash the Review import drift proposal",
          path: ["proposal_sha256"],
          input: proposal.proposal_sha256,
        });
      }
    });

export const applyReviewImportDriftRecoveryInputSchema: z.ZodType<ApplyReviewImportDriftRecoveryInput> =
  z.strictObject({
    decision: z.literal("accept_exact_drift"),
    governed_tuple: governedTupleSchema,
    review_mission_content_sha256: sha256Schema,
    result_content_sha256: sha256Schema,
    rejected_import_run_id: sha256Schema,
    accepted_result_commit: gitCommitSchema,
    current_head_commit: gitCommitSchema,
    proposal_sha256: sha256Schema,
  });

export function hashControllerCapabilityGrant(input: {
  source_mission_content_sha256: string;
  execution_defaults: ExecutionDefaultsV1;
}): string {
  const content = {
    schema_version: 1,
    source_mission_content_sha256: sha256Schema.parse(
      input.source_mission_content_sha256,
    ),
    execution_defaults: executionDefaultsV1Schema.parse(
      input.execution_defaults,
    ),
  } as const;
  return createHash("sha256")
    .update(`${JSON.stringify(content, null, 2)}\n`)
    .digest("hex");
}

export function createControllerCapabilityGrant(input: {
  source_mission_content_sha256: string;
  execution_defaults: ExecutionDefaultsV1;
}): ControllerCapabilityGrant {
  const content = {
    schema_version: 1 as const,
    source_mission_content_sha256: input.source_mission_content_sha256,
    execution_defaults: input.execution_defaults,
  };
  return controllerCapabilityGrantSchema.parse({
    ...content,
    grant_sha256: hashControllerCapabilityGrant(content),
  });
}

export function hashControllerCapabilityCarryForward(input: {
  source_mission_content_sha256: string;
  execution_defaults: ExecutionDefaultsV1;
}): string {
  const content = {
    schema_version: 1,
    kind: "carry_forward",
    source_mission_content_sha256: sha256Schema.parse(
      input.source_mission_content_sha256,
    ),
    execution_defaults: executionDefaultsV1Schema.parse(
      input.execution_defaults,
    ),
  } as const;
  return createHash("sha256")
    .update(`${JSON.stringify(content, null, 2)}\n`)
    .digest("hex");
}

export function createControllerCapabilityCarryForward(input: {
  source_mission_content_sha256: string;
  execution_defaults: ExecutionDefaultsV1;
}): ControllerCapabilityCarryForward {
  const content = {
    schema_version: 1 as const,
    kind: "carry_forward" as const,
    source_mission_content_sha256: input.source_mission_content_sha256,
    execution_defaults: input.execution_defaults,
  };
  return controllerCapabilityCarryForwardSchema.parse({
    ...content,
    carry_forward_sha256: hashControllerCapabilityCarryForward(content),
  });
}

export const createWorkItemInputSchema: z.ZodType<CreateWorkItemInput> =
  z.strictObject({
    title: titleSchema,
    type: z.enum(WORK_ITEM_TYPES),
  });

export const createCaptureInputSchema: z.ZodType<CreateCaptureInput> =
  z.strictObject({
    title: titleSchema,
    capture_kind: z.enum(CAPTURE_KINDS),
    source_id: portfolioSourceIdSchema.optional(),
    priority: z.enum(WORK_ITEM_PRIORITIES).optional(),
    tags: tagsSchema.optional(),
    notes: notesSchema.optional(),
  });

export const updateWorkItemPhaseInputSchema: z.ZodType<UpdateWorkItemPhaseInput> =
  z.strictObject({
    target_phase: z.enum(WORK_ITEM_PHASES),
  });

export class InvalidWorkspaceError extends Error {
  readonly kind = "invalid_workspace" as const;

  constructor(
    readonly artifactPath: string,
    readonly reason: string,
  ) {
    super(`${artifactPath}: ${reason}`);
    this.name = "InvalidWorkspaceError";
  }
}

export class ControllerConflictError extends Error {
  constructor(
    readonly kind: ControllerConflictKind,
    readonly workItemId: string,
    readonly reason: string,
  ) {
    super(reason);
    this.name = "ControllerConflictError";
  }
}

export class WorkItemTargetCollisionError extends Error {
  readonly kind = "target_collision" as const;

  constructor(
    readonly sourceId: string,
    readonly workItemId: string,
    readonly targetSourceId: string,
  ) {
    super(
      `Work item ${workItemId} from source ${sourceId} already exists in target ${targetSourceId}`,
    );
    this.name = "WorkItemTargetCollisionError";
  }
}

export class WorkItemTransferFailedError extends Error {
  readonly kind = "transfer_failed" as const;

  constructor(
    readonly sourceId: string,
    readonly workItemId: string,
    readonly targetSourceId: string,
    readonly reason: string,
  ) {
    super(
      `Failed to transfer work item ${workItemId} from ${sourceId} to ${targetSourceId}: ${reason}`,
    );
    this.name = "WorkItemTransferFailedError";
  }
}
