import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";

import { stringify } from "yaml";
import { z } from "zod";

import {
  deriveControllerIdempotencyKey,
  type ApproveSpecDecisionInput,
  type PlanApprovalControllerResult,
  type ReplanWithUpdatedContractInput,
  type RequestShapingChangesInput,
  type ShapingDecisionControllerResult,
  type ShapingResultDecisionInput,
  type StartBrainstormDecisionInput,
  WorkItemController,
} from "./work-item-controller";
import {
  DuplicateWorkspaceError,
  INBOX_SOURCE_ID,
  INBOX_SOURCE_LABEL,
  InvalidWorkItemTransitionError,
  PortfolioWorkItemNotFoundError,
  UnknownPortfolioSourceError,
  portfolioSourceIdSchema,
  registerWorkspaceInputSchema,
  registeredWorkspaceSchema,
  type PortfolioRebuildResult,
  type PortfolioConnectedRunSummary,
  type PortfolioWorkItem,
  type PortfolioWorkItemIndex,
  type RegisteredWorkspace,
  portfolioWorkItemSchema,
} from "../domain/portfolio";
import {
  MISSION_SCHEMA_VERSION,
  compileMission as compileMissionPackage,
  compilePatchMission as compilePatchMissionPackage,
  compileReviewMission as compileReviewMissionPackage,
  patchSubjectSchema,
  type ExecuteApprovedPlan,
  type ExecuteMissionPackage,
  type MissionArtifactWriteResult,
  type MissionIdentity,
  type PatchMissionPackage,
  type ReviewMissionPackage,
} from "../domain/mission";
import {
  createImportRunId,
  hashResultContent,
  reviewExternalResultSubmissionForSubjectSchema,
  reviewFindingSchema,
  serializeExternalResult,
  type ConnectedReviewResultRecoveryReceiptV1,
  type ImportEvidenceSummary,
  type PatchExternalResultSubmission,
  type ReviewFinding,
  type ReviewExternalResultSubmission,
  type StoredImportEvidence,
} from "../domain/result";
import {
  ControllerConflictError,
  InvalidWorkspaceError,
  WorkItemTargetCollisionError,
  WorkItemTransferFailedError,
  controllerRunIdSchema,
  controllerRunManifestSchema,
  createCaptureInputSchema,
  saveWorkItemInputSchema,
  updateWorkItemPhaseInputSchema,
  workItemAttentionSchema,
  workItemIdSchema,
  workItemSchema,
  workItemStateSchema,
  type ApprovePlanResultInput,
  type ApplyReviewImportDriftRecoveryInput,
  type ApplyScopeCorrectionInput,
  type CommandAuthorizationDecisionInput,
  type CreateCaptureInput,
  type ControllerRunManifest,
  type RetainedControllerLeaseRepairResult,
  type SaveWorkItemInput,
  type ScopeCorrectionProposalV1,
  type ReviewImportDriftRecoveryProposalV1,
  type CommandAuthorizationProposalV1,
  type UpdateWorkItemPhaseInput,
  type WorkItem,
  type WorkItemAttention,
  type WorkItemGoal,
} from "../domain/work-item";
import {
  canUpdateGoalContract,
  dedicatedTransitionPolicy,
  validateWorkItemTransition,
} from "../domain/workflow-policy";
import { workspaceRelativePosixPathSchema } from "../domain/workspace-path";
import {
  hashResolvedCapabilityEnvelope,
  summarizeConnectedRun,
  type ConnectedRunRecordV2,
  type ConnectedRunSummary,
  type ConnectedRunTerminal,
  type LaunchConnectedInput,
} from "../domain/connected-run";
import {
  capabilityRequestMatchesEnvelope,
  capabilityEnvelopeV1Schema,
  isCapabilityEnvelopeNarrowing,
  PERMISSION_REJECTION_EXPLANATIONS,
  type CapabilityEnvelopeV1,
  type PermissionRejectionReason,
} from "../domain/capability-envelope";
import {
  deriveReviewMissionResultBindingSha256,
  hashReviewRunPolicy,
  type ReviewRunPolicy,
} from "../domain/review-run-policy";
import {
  brainstormResultSubmissionSchema,
  compileBrainstormMission as compileBrainstormMissionPackage,
  compilePlanMission as compilePlanMissionPackage,
  compileSpecMission as compileSpecMissionPackage,
  hashGoalContract,
  hashGoalInput,
  hashShapingDecisionState,
  isShapingPhase,
  normalizeShapingGoalInput,
  planResultSubmissionSchema,
  renderShapingTaskMd,
  SHAPING_PHASES,
  shapingMissionPackageSchema,
  specResultSubmissionSchema,
  type BrainstormMissionPackage,
  type PlanMissionPackage,
  type ShapingArtifactWriteResult,
  type ShapingDecisionIntentV1,
  type ShapingDecisionState,
  type ShapingImportReceipt,
  type ShapingIngressInstructionV1,
  type ShapingMissionPackage,
  type ShapingPhase,
  type ShapingResultSubmission,
  type SpecMissionPackage,
  type StoredShapingArtifact,
} from "../domain/shaping";
import {
  shapingRunLaunchFingerprint,
  summarizeShapingRun,
  type ShapingRunRecordV1,
  type ShapingRunSummary,
} from "../domain/shaping-run";
import {
  WORKFLOW_MODEL_SEATS,
  shapingModelPickerOptions,
  summarizeWorkflowModelUse,
  type ShapingModelPickerOption,
  type WorkflowModelSeat,
  type WorkflowModelUse,
} from "../domain/portfolio-preferences";
import type {
  AcpClientAdapter,
  AcpEventSink,
  AcpRunResult,
  AcpSession,
  AcpSessionCallbacks,
  AcpWriteTextFileHandler,
} from "../infrastructure/acp/acp-client";
import {
  COPILOT_ADAPTER_ID,
  COPILOT_PROFILE_ID,
  COPILOT_REVIEW_PROFILE_ID,
  COPILOT_WRITABLE_COMMAND_TOOL,
  createCopilotReviewRuntimeProfile,
  createCopilotRuntimeProfile,
  type CopilotRuntimeProfileInput,
  type CopilotSanitizedProfileEvidence,
} from "../infrastructure/acp/copilot-runtime-profile";
import { ProductWorkspace } from "../workspace/product-workspace";
import type {
  ShapingRunCreateResult,
} from "../workspace/product-workspace";
import { PortfolioPreferencesStore } from "../workspace/portfolio-preferences";
import { PortfolioRegistry } from "../workspace/portfolio-registry";
import {
  composeConnectedShapingPrompt,
  startConnectedAcpRun,
  type OwnedConnectedAcpRun,
} from "./shaping-connected-run";

type WorkspaceGateway = Pick<
  ProductWorkspace,
  | "workspaceRoot"
  | "readManifest"
  | "create"
  | "list"
  | "read"
  | "createCapture"
  | "updateGoal"
  | "updatePhase"
  | "hasWorkItem"
  | "stageIncomingWorkItem"
  | "publishStagedWorkItem"
  | "discardStagedWorkItem"
  | "removeWorkItem"
  | "acquireControllerLease"
  | "readControllerRunManifest"
  | "findAppliedExecuteManifest"
  | "findAppliedPatchManifest"
  | "findAppliedPatchAttemptManifest"
  | "readAppliedExecuteReviewSubject"
  | "readAppliedPatchReviewSubject"
  | "readExecutionDefaults"
  | "writePatchMissionPackage"
  | "writeReviewMissionPackage"
  | "writeMissionPackage"
  | "readMissionPackage"
  | "readMissionResult"
  | "writeShapingMissionPackage"
  | "readShapingMissionPackage"
  | "listShapingArtifacts"
  | "writeShapingIngressInstruction"
  | "writeShapingAcpTextFile"
  | "readShapingIngressBytes"
  | "publishAppliedShapingResult"
  | "createShapingRun"
  | "readShapingRun"
  | "readShapingRunInstruction"
  | "listShapingRuns"
  | "startShapingRun"
  | "updateShapingRunEffectiveModel"
  | "appendShapingRunEvent"
  | "completeShapingRun"
  | "reconcileShapingRuns"
  | "readShapingDecisionIntent"
  | "readShapingDecisionManifest"
  | "listShapingDecisionManifests"
  | "writeShapingDecisionReceipt"
  | "writeShapingDecisionIntent"
  | "publishLeasedShapingMission"
  | "commitShapingDecision"
  | "reconcileShapingDecisionCommit"
  | "writePlanApprovalIntent"
  | "readPlanApprovalIntent"
  | "readPlanApprovalManifest"
  | "commitPlanApproval"
  | "reconcilePlanApprovalCommit"
  | "repairRetainedControllerLease"
  | "createConnectedRun"
  | "readConnectedRun"
  | "listConnectedRuns"
  | "startConnectedRun"
  | "updateConnectedRunEffectiveModel"
  | "appendConnectedRunEvent"
  | "writeConnectedReviewResult"
  | "recoverConnectedReviewResult"
  | "completeConnectedRun"
  | "reconcileConnectedRuns"
  | "readImportEvidence"
  | "listImportEvidence"
  | "writeImportEvidence"
  | "gitVerificationAdapter"
  | "verificationRunner"
  | "commitControllerMutation"
  | "releaseControllerLease"
>;
type WorkspaceFactory = (workspacePath: string) => WorkspaceGateway;

interface ResolvedSource {
  source_id: string;
  project: RegisteredWorkspace | null;
  workspace: WorkspaceGateway;
}

interface ShapingAttentionArtifacts {
  artifacts: StoredShapingArtifact[];
  runs: ShapingRunRecordV1[];
}

type ReadShapingAttentionArtifacts = () => Promise<ShapingAttentionArtifacts>;

const TRANSFER_STAGES = ["staged", "published", "source_removed"] as const;
const TRANSFER_TEMP_FILE_PATTERN =
  /^\.tr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;

interface TransferJournalRecordBase {
  schema_version: 1;
  transfer_id: string;
  work_item_id: string;
  from_source_id: string;
  from_path: string;
  to_source_id: string;
  to_path: string;
  stage: (typeof TRANSFER_STAGES)[number];
}

interface MoveTransferJournalRecord extends TransferJournalRecordBase {
  kind: "move";
}

interface SaveTransferJournalRecord extends TransferJournalRecordBase {
  kind: "save";
  target_sha256: string;
  staged_manifest_run_id?: string;
}

type TransferJournalRecord =
  | MoveTransferJournalRecord
  | SaveTransferJournalRecord;

const transferJournalBaseShape = {
  schema_version: z.literal(1),
  transfer_id: z
    .string()
    .regex(
      /^tr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      "transfer_id must use the tr_<uuid> format",
    ),
  work_item_id: workItemIdSchema,
  from_source_id: portfolioSourceIdSchema,
  from_path: z.string().refine(isAbsolute, "from_path must be absolute"),
  to_source_id: portfolioSourceIdSchema,
  to_path: z.string().refine(isAbsolute, "to_path must be absolute"),
  stage: z.enum(TRANSFER_STAGES),
};

const transferJournalRecordSchema: z.ZodType<TransferJournalRecord> = z
  .discriminatedUnion("kind", [
    z.strictObject({
      ...transferJournalBaseShape,
      kind: z.literal("move"),
    }),
    z.strictObject({
      ...transferJournalBaseShape,
      kind: z.literal("save"),
      target_sha256: z.string().regex(/^[0-9a-f]{64}$/i),
      staged_manifest_run_id: controllerRunIdSchema.optional(),
    }),
  ])
  .refine(
    (record) => record.from_source_id !== record.to_source_id,
    "transfer sources must differ",
  );

function fingerprintWorkItem(item: WorkItem): string {
  return createHash("sha256").update(JSON.stringify(item)).digest("hex");
}

function nextTimestamp(currentTimestamp: string): string {
  return new Date(
    Math.max(Date.now(), Date.parse(currentTimestamp) + 1),
  ).toISOString();
}

function manifestMatchesWorkItem(
  manifest: ControllerRunManifest,
  item: WorkItem,
): boolean {
  const contract = item.goal.goal_contract;
  const inputRevision = item.state.input_revision;
  const attempt = item.state.attempt;
  return (
    contract !== undefined &&
    inputRevision !== undefined &&
    attempt !== undefined &&
    manifest.outcome === "applied" &&
    manifest.completed_at !== undefined &&
    manifest.work_item_id === item.goal.work_item_id &&
    manifest.phase === item.state.phase &&
    manifest.goal_version === contract.goal_version &&
    manifest.input_revision === inputRevision &&
    manifest.attempt === attempt &&
    manifest.idempotency_key ===
      deriveControllerIdempotencyKey(
        item.goal.work_item_id,
        item.state.phase,
        contract.goal_version,
        inputRevision,
        attempt,
      )
  );
}

export interface RegisterWorkspaceResult {
  workspace: RegisteredWorkspace;
  rebuild: PortfolioRebuildResult;
}

export type MissionCompilation = MissionArtifactWriteResult<ExecuteMissionPackage>;
export type ReviewMissionCompilation =
  MissionArtifactWriteResult<ReviewMissionPackage>;
export type PatchMissionCompilation =
  MissionArtifactWriteResult<PatchMissionPackage>;
export type BrainstormMissionCompilation =
  ShapingArtifactWriteResult<BrainstormMissionPackage>;
export type SpecMissionCompilation =
  ShapingArtifactWriteResult<SpecMissionPackage>;
export type PlanMissionCompilation =
  ShapingArtifactWriteResult<PlanMissionPackage>;

export interface ShapingManualImportBinding {
  expected_mission_content_sha256: string;
  expected_shaping_state_sha256: string;
}

export interface ShapingValidationReason {
  code:
    | "invalid_json"
    | "invalid_utf8"
    | "schema_violation"
    | "mission_hash_mismatch"
    | "missing_required_field";
  field_path: string;
}

export interface ShapingRejectedImportEvidence {
  raw_result_sha256: string;
  byte_length: number;
  reasons: ShapingValidationReason[];
}

export type ShapingImportResult =
  | {
      source_id: string;
      work_item_id: string;
      outcome: "applied";
      receipt: ShapingImportReceipt;
      result: ShapingResultSubmission;
    }
  | {
      source_id: string;
      work_item_id: string;
      outcome: "rejected";
      rejection: ShapingRejectedImportEvidence;
    };

export interface ManualShapingIngressResult {
  source_id: string;
  work_item_id: string;
  task: string;
  instruction: ShapingIngressInstructionV1;
  instruction_path: string;
}

export interface ShapingRuntimeConfiguration {
  adapter_id: string;
  adapter_version: string;
  profile_id: string;
  available_model_ids: readonly string[];
}

export interface ShapingModelAvailability {
  status: "available" | "unavailable";
  adapter_id: string | null;
  adapter_version: string | null;
  profile_id: string | null;
  available_model_ids: string[];
  distinct_model_count: number;
  has_three_distinct_models: boolean;
  reason: string | null;
}

export interface ConnectedModelListing {
  model_availability: Record<ConnectedRunPhase, ShapingModelAvailability>;
  model_picker_options: Record<
    ConnectedRunPhase,
    ShapingModelPickerOption[]
  >;
}

export interface ShapingRuntimePrepareInput {
  workspace_cwd: string;
  mission: ShapingMissionPackage;
  requested_model: string;
  limits: ShapingRunRecordV1["limits"];
}

export interface PreparedShapingRuntime {
  requested_model: string;
  reasoning_effort: string;
  sanitized_profile: Omit<
    CopilotSanitizedProfileEvidence,
    "adapter_id" | "profile_id"
  > & {
    adapter_id: string;
    profile_id: string;
  };
  start(
    instruction: ShapingIngressInstructionV1,
    writePolicy: ShapingRunRecordV1["write_policy"],
    eventSink: AcpEventSink,
    writeTextFile: AcpWriteTextFileHandler,
    callbacks?: AcpSessionCallbacks,
  ): Promise<AcpSession>;
}

export interface ConnectedShapingRuntime {
  configuration(): ShapingRuntimeConfiguration;
  prepare(input: ShapingRuntimePrepareInput): Promise<PreparedShapingRuntime>;
}

export interface ShapingNextLaunch {
  status: "launched" | "failed" | "manual";
  shaping_run_id: string | null;
  reason: string | null;
  created?: boolean;
}

export interface PortfolioShapingLaunchResult {
  source_id: string;
  work_item_id: string;
  next_launch: ShapingNextLaunch;
  shaping_run: ShapingRunSummary | null;
}

export interface PortfolioShapingDecisionResult extends PortfolioWorkItem {
  decision_id: string;
  next_mission: ShapingDecisionControllerResult["next_mission"];
  next_launch: ShapingNextLaunch;
}

export type ExecuteNextLaunch =
  | {
      status: "launched";
      connected_run_id: string;
      reason: null;
    }
  | {
      status: "manual";
      connected_run_id: null;
      reason: "founder_selected_manual" | "runtime_unavailable";
    }
  | {
      status: "failed";
      connected_run_id: null;
      reason: string;
    };

export interface PortfolioPlanApprovalResult extends PortfolioWorkItem {
  approval_id: string;
  launch_mode: PlanApprovalControllerResult["launch_mode"];
  requested_model: string | null;
  execute_tuple: PlanApprovalControllerResult["execute_tuple"];
  mission: MissionCompilation | null;
  connected_run: ConnectedRunSummary | null;
  next_launch: ExecuteNextLaunch;
}

export interface ShapingRetryLaunchInput {
  decision_id: string;
  expected_shaping_state_sha256: string;
}

export interface ShapingPostCommitLaunchFailure {
  decision_id: string;
  locked_model: string;
  reason: string;
}

export interface ShapingArtifactListing {
  source_id: string;
  work_item_id: string;
  artifacts: StoredShapingArtifact[];
  runs: ShapingRunSummary[];
  expected_shaping_state_sha256: string;
  model_availability: ShapingModelAvailability;
  execute_model_availability: ShapingModelAvailability;
  model_use: WorkflowModelUse[];
  model_picker_options: Record<WorkflowModelSeat, ShapingModelPickerOption[]>;
  post_commit_launch_failure: ShapingPostCommitLaunchFailure | null;
}

export interface PortfolioImportResult extends PortfolioWorkItem {
  evidence: ImportEvidenceSummary;
}

export interface PortfolioReviewImportResult extends PortfolioWorkItem {
  evidence: ImportEvidenceSummary;
  result?: ReviewExternalResultSubmission;
}

export interface PortfolioPatchImportResult extends PortfolioWorkItem {
  evidence: ImportEvidenceSummary;
  result?: PatchExternalResultSubmission;
}

export interface PortfolioPatchPlanResult extends PortfolioWorkItem {
  controller_run: ControllerRunManifest;
}

export interface PortfolioAttentionItem {
  item: PortfolioWorkItem;
  attention: WorkItemAttention;
  acceptance_criteria: {
    criterion: string;
    status: "reviewed" | "needs_attention" | "unknown";
  }[];
  verification: {
    status: "passed" | "unknown";
    commands: { name: string; status: "passed" }[];
  };
  findings: ReviewFinding[];
  patch_cycle_limit: 3;
  elapsed_ms?: number;
  cost_capacity: "unknown";
}

export type PortfolioItemShapingRunStatus =
  | "starting"
  | "running"
  | "blocked"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "interrupted"
  | "ready"
  | "missing_result"
  | "finishing"
  | "needs_repair";

export interface PortfolioItemShapingSummary {
  phase: ShapingPhase;
  tip_mission_content_sha256: string | null;
  has_applied_result: boolean;
  decision_kind: "brainstorm_selection" | "spec_approval" | null;
  latest_run_status: PortfolioItemShapingRunStatus | null;
}

export interface PortfolioListItem extends PortfolioWorkItem {
  shaping_summary?: PortfolioItemShapingSummary;
}

export interface ShapingAttentionV1 {
  schema_version: 1;
  kind: "spec_approval_shaping";
  work_item_id: string;
  source_id: string;
  phase: "spec";
  question: "A Spec result is ready for your approval.";
  recommendation: "Open the item and use Approve & run Plan.";
  binding: {
    mission_content_sha256: string;
    applied_result_content_sha256: string;
    shaping_state_sha256: string;
  };
  pins: {
    artifact_paths: [string, string];
  };
  created_at: string;
}

export type PortfolioNeedsYouEntry =
  | { kind: "governed"; entry: PortfolioAttentionItem }
  | {
      kind: "shaping";
      item: PortfolioWorkItem;
      shaping_attention: ShapingAttentionV1;
    };

export interface PortfolioRetryResult extends PortfolioWorkItem {
  controller_run: ControllerRunManifest;
}

export interface PortfolioScopeCorrectionListing {
  source_id: string;
  work_item_id: string;
  proposal: ScopeCorrectionProposalV1 | null;
}

export interface PortfolioScopeCorrectionResult extends PortfolioWorkItem {
  controller_run: ControllerRunManifest;
  proposal: ScopeCorrectionProposalV1;
}

export interface PortfolioReviewImportDriftRecoveryListing {
  source_id: string;
  work_item_id: string;
  proposal: ReviewImportDriftRecoveryProposalV1 | null;
}

export interface PortfolioReviewImportDriftRecoveryResult
  extends PortfolioWorkItem {
  controller_run: ControllerRunManifest;
  proposal: ReviewImportDriftRecoveryProposalV1;
  evidence: ImportEvidenceSummary;
  result: ReviewExternalResultSubmission;
}

export interface PortfolioCommandAuthorizationResult extends PortfolioWorkItem {
  controller_run: ControllerRunManifest | null;
  proposal: CommandAuthorizationProposalV1;
}

export interface LaunchConnectedExecuteRequest {
  model_override?: string;
  narrowed_capability_envelope?: CapabilityEnvelopeV1;
}

export interface LaunchConnectedReviewRequest {
  independence_attested: true;
  model_override?: string;
}

export interface RecoverConnectedReviewResultRequest {
  review_mission_content_sha256: string;
  result_content_sha256: string;
  recovery_trigger_connected_run_id: string;
}

export interface LaunchConnectedPatchRequest {
  model_override?: string;
  narrowed_capability_envelope?: CapabilityEnvelopeV1;
}

export interface PortfolioConnectedRunResult extends PortfolioWorkItem {
  connected_run: ConnectedRunSummary;
}

type ConnectedRunPhase = "execute" | "review" | "patch";

interface PreparedConnectedLaunch {
  source: ResolvedSource;
  work_item_id: string;
  controller: WorkItemController;
  launch_input: LaunchConnectedInput;
  record: ConnectedRunRecordV2;
  prompt: string;
  before_complete?: (
    result: AcpRunResult,
    connected_run_id: string,
  ) => Promise<void>;
  failure_terminal?: (error: unknown) => ConnectedRunTerminal;
  start_session: (
    event_sink: AcpEventSink,
    callbacks: AcpSessionCallbacks,
    connected_run_id: string,
  ) => Promise<AcpSession>;
  preference?: {
    adapter_id: string;
    seat: Extract<WorkflowModelSeat, "review" | "patch">;
    requested_model: string;
  };
  after_complete: (
    result: AcpRunResult,
    terminal: ConnectedRunRecordV2,
    launched: ConnectedRunRecordV2,
  ) => Promise<void>;
}

export interface ConnectedWritableRuntimePrepareInput {
  workspace_cwd: string;
  capability_envelope: CapabilityEnvelopeV1;
  limits: ConnectedRunRecordV2["limits"];
  model_override?: string;
}

export interface PreparedConnectedRuntime {
  requested_model: string;
  reasoning_effort: string;
  sanitized_profile: Omit<
    CopilotSanitizedProfileEvidence,
    "adapter_id" | "profile_id"
  > & {
    adapter_id: string;
    profile_id: string;
  };
  start(
    event_sink: AcpEventSink,
    callbacks?: AcpSessionCallbacks,
  ): Promise<AcpSession>;
}

export interface ConnectedWritableRuntime {
  configuration(): ConnectedRuntimeConfiguration;
  prepare(
    input: ConnectedWritableRuntimePrepareInput,
  ): Promise<PreparedConnectedRuntime>;
}

export interface ConnectedReviewRuntimePrepareInput {
  workspace_cwd: string;
  limits: ConnectedRunRecordV2["limits"];
  requested_model: string;
  result_ingress_policy: ReviewRunPolicy;
}

export interface PreparedConnectedReviewRuntime
  extends Omit<PreparedConnectedRuntime, "start"> {
  start(
    event_sink: AcpEventSink,
    callbacks?: AcpSessionCallbacks,
  ): Promise<AcpSession>;
}

export interface ConnectedReviewRuntime {
  configuration(): ConnectedRuntimeConfiguration;
  prepare(
    input: ConnectedReviewRuntimePrepareInput,
  ): Promise<PreparedConnectedReviewRuntime>;
}

export interface ConnectedRuntimeConfiguration
  extends ShapingRuntimeConfiguration {
  default_model: string;
}

export interface CopilotConnectedWritableRuntimeOptions {
  profile: Omit<
    CopilotRuntimeProfileInput,
    | "requested_model"
    | "workspace_cwd"
    | "evaluate_permission"
    | "read_text_file"
    | "write_text_file"
    | "limits"
  > & {
    default_model: string;
  };
}

export class CopilotConnectedWritableRuntime
  implements ConnectedWritableRuntime
{
  constructor(
    private readonly adapter: AcpClientAdapter,
    private readonly options: CopilotConnectedWritableRuntimeOptions,
  ) {}

  configuration(): ConnectedRuntimeConfiguration {
    return {
      adapter_id: COPILOT_ADAPTER_ID,
      adapter_version: this.options.profile.preflight.version,
      profile_id: COPILOT_PROFILE_ID,
      available_model_ids: this.options.profile.preflight.available_model_ids,
      default_model: this.options.profile.default_model,
    };
  }

  async prepare(
    input: ConnectedWritableRuntimePrepareInput,
  ): Promise<PreparedConnectedRuntime> {
    const requestedModel = input.model_override ?? this.options.profile.default_model;
    if (!this.configuration().available_model_ids.includes(requestedModel)) {
      throw new Error("Requested Copilot model is unavailable.");
    }
    const profile = createCopilotRuntimeProfile({
      ...this.options.profile,
      required_available_tools: [COPILOT_WRITABLE_COMMAND_TOOL],
      requested_model: requestedModel,
      workspace_cwd: input.workspace_cwd,
      evaluate_permission: (request) =>
        capabilityRequestMatchesEnvelope(request, input.capability_envelope)
          ? { decision: "allow_once", reason: null }
          : {
              decision: "reject_once",
              reason: "outside_capability_envelope",
            },
      limits: input.limits,
    });
    return {
      requested_model: requestedModel,
      reasoning_effort: this.options.profile.reasoning_effort,
      sanitized_profile: profile.sanitized_profile_evidence,
      start: (eventSink, callbacks) =>
        this.adapter.start(profile.runtime_profile, eventSink, callbacks),
    };
  }
}

export interface CopilotConnectedReviewRuntimeOptions {
  profile: Omit<
    CopilotRuntimeProfileInput,
    | "requested_model"
    | "required_available_tools"
    | "workspace_cwd"
    | "evaluate_permission"
    | "read_text_file"
    | "write_text_file"
    | "limits"
  > & {
    default_model: string;
  };
}

export class CopilotConnectedReviewRuntime implements ConnectedReviewRuntime {
  constructor(
    private readonly adapter: AcpClientAdapter,
    private readonly options: CopilotConnectedReviewRuntimeOptions,
  ) {}

  configuration(): ConnectedRuntimeConfiguration {
    return {
      adapter_id: COPILOT_ADAPTER_ID,
      adapter_version: this.options.profile.preflight.version,
      profile_id: COPILOT_REVIEW_PROFILE_ID,
      available_model_ids: this.options.profile.preflight.available_model_ids,
      default_model: this.options.profile.default_model,
    };
  }

  async prepare(
    input: ConnectedReviewRuntimePrepareInput,
  ): Promise<PreparedConnectedReviewRuntime> {
    const base = {
      ...this.options.profile,
      requested_model: input.requested_model,
      workspace_cwd: input.workspace_cwd,
      review_policy: input.result_ingress_policy,
      limits: input.limits,
    };
    const prepared = createCopilotReviewRuntimeProfile(base);
    return {
      requested_model: input.requested_model,
      reasoning_effort: this.options.profile.reasoning_effort,
      sanitized_profile: prepared.sanitized_profile_evidence,
      start: (eventSink, callbacks) => {
        const profile = createCopilotReviewRuntimeProfile(base);
        return this.adapter.start(
          profile.runtime_profile,
          eventSink,
          callbacks,
        );
      },
    };
  }
}

const CONNECTED_RUN_LIMITS: ConnectedRunRecordV2["limits"] = {
  wall_clock_timeout_ms: 900_000,
  max_event_count: 50_000,
  max_event_bytes: 50_000_000,
  max_output_bytes: 1_000_000,
  termination_grace_ms: 5_000,
  drain_grace_ms: 1_000,
};

const SHAPING_RUN_LIMITS: ShapingRunRecordV1["limits"] = {
  ...CONNECTED_RUN_LIMITS,
  max_output_bytes: 100_000,
};


const WRITABLE_PERMISSION_REQUEST_GUIDANCE =
  `Pre-approved operations and permission requests are distinct. Do not return a not_run result merely because a task-required command is not listed in the capability envelope. You must invoke the \`${COPILOT_WRITABLE_COMMAND_TOOL}\` tool with the exact first required command so the controller can deny it and mediate a founder decision. That invocation is a permission request, not authority to execute: do not bypass a denial or claim the command ran.`;

const launchConnectedExecuteRequestSchema: z.ZodType<LaunchConnectedExecuteRequest> =
  z.strictObject({
    model_override: z.string().trim().min(1).max(200).optional(),
    narrowed_capability_envelope: capabilityEnvelopeV1Schema.optional(),
  });

const launchConnectedReviewRequestSchema: z.ZodType<LaunchConnectedReviewRequest> =
  z.strictObject({
    independence_attested: z.literal(true),
    model_override: z.string().trim().min(1).max(200).optional(),
  });

const recoverConnectedReviewResultRequestSchema: z.ZodType<RecoverConnectedReviewResultRequest> =
  z.strictObject({
    review_mission_content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    result_content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    recovery_trigger_connected_run_id: controllerRunIdSchema,
  });

const launchConnectedPatchRequestSchema: z.ZodType<LaunchConnectedPatchRequest> =
  z.strictObject({
    model_override: z.string().trim().min(1).max(200).optional(),
    narrowed_capability_envelope: capabilityEnvelopeV1Schema.optional(),
  });

export interface ConnectedPermissionDecisionRequest {
  connected_run_id: string;
  operation_sha256: string;
  decision: "allow_once" | "retry_without_allowing" | "keep_denied";
}

export interface PortfolioConnectedPermissionResult extends PortfolioWorkItem {
  controller_run: ControllerRunManifest | null;
}

const connectedPermissionDecisionRequestSchema: z.ZodType<ConnectedPermissionDecisionRequest> =
  z.strictObject({
    connected_run_id: controllerRunIdSchema,
    operation_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    decision: z.enum([
      "allow_once",
      "retry_without_allowing",
      "keep_denied",
    ]),
  });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const compileReviewMissionInputSchema = z.strictObject({
  independence_attested: z.literal(true),
});

const shapingSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const shapingRequestedModelSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === value.trim(), "must not have surrounding whitespace")
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "must not contain control characters",
  );

export const compileSpecMissionInputSchema = z.strictObject({
  brainstorm_acceptance_sha256: shapingSha256Schema,
});

const shapingManualImportBindingSchema: z.ZodType<ShapingManualImportBinding> =
  z.strictObject({
    expected_mission_content_sha256: shapingSha256Schema,
    expected_shaping_state_sha256: shapingSha256Schema,
  });

const shapingRetryLaunchInputSchema: z.ZodType<ShapingRetryLaunchInput> =
  z.strictObject({
    decision_id: shapingSha256Schema,
    expected_shaping_state_sha256: shapingSha256Schema,
  });

const shapingRuntimeConfigurationSchema: z.ZodType<ShapingRuntimeConfiguration> =
  z.strictObject({
    adapter_id: shapingRequestedModelSchema,
    adapter_version: shapingRequestedModelSchema,
    profile_id: shapingRequestedModelSchema,
    available_model_ids: z.array(shapingRequestedModelSchema),
  });

const connectedRuntimeConfigurationSchema: z.ZodType<ConnectedRuntimeConfiguration> =
  z.strictObject({
    adapter_id: shapingRequestedModelSchema,
    adapter_version: shapingRequestedModelSchema,
    profile_id: shapingRequestedModelSchema,
    available_model_ids: z.array(shapingRequestedModelSchema),
    default_model: shapingRequestedModelSchema,
  });

const launchShapingRunRequestSchema = z.strictObject({
  requested_model: shapingRequestedModelSchema,
});

const portfolioAttentionItemSchema: z.ZodType<PortfolioAttentionItem> =
  z.strictObject({
    item: portfolioWorkItemSchema,
    attention: workItemAttentionSchema,
    acceptance_criteria: z.array(
      z.strictObject({
        criterion: z.string().trim().min(1),
        status: z.enum(["reviewed", "needs_attention", "unknown"]),
      }),
    ),
    verification: z.strictObject({
      status: z.enum(["passed", "unknown"]),
      commands: z.array(
        z.strictObject({
          name: z.string().trim().min(1),
          status: z.literal("passed"),
        }),
      ),
    }),
    findings: z.array(reviewFindingSchema),
    patch_cycle_limit: z.literal(3),
    elapsed_ms: z.number().int().nonnegative().safe().optional(),
    cost_capacity: z.literal("unknown"),
  });

const shapingAttentionV1Schema: z.ZodType<ShapingAttentionV1> =
  z
    .strictObject({
      schema_version: z.literal(1),
      kind: z.literal("spec_approval_shaping"),
      work_item_id: workItemIdSchema,
      source_id: portfolioSourceIdSchema,
      phase: z.literal("spec"),
      question: z.literal("A Spec result is ready for your approval."),
      recommendation: z.literal(
        "Open the item and use Approve & run Plan.",
      ),
      binding: z.strictObject({
        mission_content_sha256: shapingSha256Schema,
        applied_result_content_sha256: shapingSha256Schema,
        shaping_state_sha256: shapingSha256Schema,
      }),
      pins: z.strictObject({
        artifact_paths: z.tuple([
          workspaceRelativePosixPathSchema,
          workspaceRelativePosixPathSchema,
        ]),
      }),
      created_at: z.iso.datetime(),
    })
    .refine(
      (attention) =>
        attention.pins.artifact_paths[0] !==
        attention.pins.artifact_paths[1],
      {
        message: "mission and applied artifact paths must be distinct",
        path: ["pins", "artifact_paths"],
      },
    );

const portfolioNeedsYouEntrySchema: z.ZodType<PortfolioNeedsYouEntry> =
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("governed"),
      entry: portfolioAttentionItemSchema,
    }),
    z.strictObject({
      kind: z.literal("shaping"),
      item: portfolioWorkItemSchema,
      shaping_attention: shapingAttentionV1Schema,
    }),
  ]).superRefine((candidate, context) => {
    if (candidate.kind !== "shaping") {
      return;
    }
    if (candidate.shaping_attention.source_id !== candidate.item.source_id) {
      context.addIssue({
        code: "custom",
        message: "shaping attention must match item source_id",
        path: ["shaping_attention", "source_id"],
        input: candidate.shaping_attention.source_id,
      });
    }
    if (
      candidate.shaping_attention.work_item_id !==
      candidate.item.work_item.goal.work_item_id
    ) {
      context.addIssue({
        code: "custom",
        message: "shaping attention must match item work_item_id",
        path: ["shaping_attention", "work_item_id"],
        input: candidate.shaping_attention.work_item_id,
      });
    }
    if (candidate.item.work_item.state.phase !== "spec") {
      context.addIssue({
        code: "custom",
        message: "shaping attention requires a Spec item",
        path: ["item", "work_item", "state", "phase"],
        input: candidate.item.work_item.state.phase,
      });
    }
  });

function validationReason(error: z.ZodError): string {
  return error.issues
    .map(({ path, message }) =>
      path.length > 0 ? `${path.map(String).join(".")}: ${message}` : message,
    )
    .join("; ");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isExpectedWorkspaceFailure(error: unknown): boolean {
  if (error instanceof InvalidWorkspaceError) {
    return true;
  }

  if (!isNodeError(error)) {
    return false;
  }

  return ["EACCES", "ENOENT", "ENOTDIR", "EPERM"].includes(error.code ?? "");
}

export class PortfolioService {
  constructor(
    private readonly registry: PortfolioRegistry,
    private readonly index: PortfolioWorkItemIndex,
    inboxRoot: string,
    private readonly makeWorkspace: WorkspaceFactory = (workspacePath) =>
      new ProductWorkspace(workspacePath),
    private readonly writableRuntime?: ConnectedWritableRuntime,
    private readonly shapingRuntime?: ConnectedShapingRuntime,
    private readonly reviewRuntime?: ConnectedReviewRuntime,
    preferencesStore?: PortfolioPreferencesStore,
  ) {
    this.inboxRoot = resolve(inboxRoot);
    this.transfersRoot = join(dirname(this.inboxRoot), "transfers");
    this.preferencesStore =
      preferencesStore ??
      new PortfolioPreferencesStore(dirname(dirname(this.inboxRoot)));
  }

  readonly inboxRoot: string;
  readonly transfersRoot: string;
  private readonly preferencesStore: PortfolioPreferencesStore;
  private readonly liveConnectedSessions = new Map<
    string,
    OwnedConnectedAcpRun
  >();
  private readonly liveShapingSessions = new Map<
    string,
    OwnedConnectedAcpRun
  >();

  listWorkspaces(): Promise<RegisteredWorkspace[]> {
    return this.registry.read();
  }

  async register(input: unknown): Promise<RegisterWorkspaceResult> {
    const validatedInput = registerWorkspaceInputSchema.parse(input);
    const workspacePath = resolve(validatedInput.workspace_path);
    const registered = await this.registry.read();

    if (
      registered.some(
        (workspace) => workspace.workspace_path === workspacePath,
      )
    ) {
      throw new DuplicateWorkspaceError(workspacePath);
    }

    const manifest = await this.makeWorkspace(workspacePath).readManifest();
    const workspace = registeredWorkspaceSchema.parse({
      workspace_id: `ws_${randomUUID()}`,
      workspace_path: workspacePath,
      product_name: manifest.product_name,
      registered_at: new Date().toISOString(),
    });

    await this.registry.append(workspace);

    try {
      return { workspace, rebuild: await this.rebuild() };
    } catch (error) {
      throw new Error(
        "Workspace was registered, but the portfolio index rebuild failed and may be stale. Run a rebuild to recover.",
        { cause: error },
      );
    }
  }

  async list(): Promise<PortfolioListItem[]> {
    return Promise.all(
      this.index.list().map(async (item): Promise<PortfolioListItem> => {
        if (
          item.source_id === INBOX_SOURCE_ID ||
          item.project === null ||
          item.work_item.state.status !== "active" ||
          !isShapingPhase(item.work_item.state.phase)
        ) {
          return item;
        }

        const source: ResolvedSource = {
          source_id: item.source_id,
          project: item.project,
          workspace: this.makeWorkspace(item.project.workspace_path),
        };
        try {
          return {
            ...item,
            shaping_summary: await this.portfolioItemShapingSummary(
              source,
              item.work_item,
            ),
          };
        } catch (error) {
          if (isExpectedWorkspaceFailure(error)) {
            return item;
          }
          throw error;
        }
      }),
    );
  }

  async createCapture(input: CreateCaptureInput): Promise<PortfolioWorkItem> {
    const validatedInput = createCaptureInputSchema.parse(input);
    const source = await this.resolveSource(
      validatedInput.source_id ?? INBOX_SOURCE_ID,
    );
    const created = await source.workspace.createCapture(validatedInput);

    await this.rebuild();
    return this.toPortfolioItem(source, created);
  }

  async saveWorkItem(
    sourceId: string,
    workItemId: string,
    input: SaveWorkItemInput,
  ): Promise<PortfolioWorkItem> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const validatedInput = saveWorkItemInputSchema.parse(input);
    const source = await this.resolveSource(sourceId);
    const target =
      validatedInput.target_source_id === source.source_id
        ? source
        : await this.resolveSource(validatedInput.target_source_id);
    const current = await source.workspace.read(validatedId);
    if (current === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, validatedId);
    }

    if (target.source_id === source.source_id) {
      if (validatedInput.goal_contract !== undefined) {
        const result = await this.workItemController(
          source.workspace,
        ).saveWorkItem(validatedId, validatedInput);
        await this.rebuild();
        return this.toPortfolioItem(source, result.work_item);
      }
      if (current.goal.goal_contract !== undefined) {
        throw new ControllerConflictError(
          "contract_required",
          validatedId,
          "A unified save cannot remove an existing goal contract.",
        );
      }

      const nextItem = this.buildUncontractedSave(current, validatedInput);
      const updated = await source.workspace.updateGoal(
        validatedId,
        nextItem.goal,
      );
      if (updated === null) {
        throw new PortfolioWorkItemNotFoundError(sourceId, validatedId);
      }
      await this.rebuild();
      return this.toPortfolioItem(source, updated);
    }

    if (current.goal.goal_contract !== undefined) {
      throw new ControllerConflictError(
        "project_locked",
        validatedId,
        "A contracted work item cannot change projects.",
      );
    }
    if (
      validatedInput.expected_goal_version !== undefined ||
      validatedInput.expected_input_revision !== undefined
    ) {
      throw new ControllerConflictError(
        "stale_expectation",
        validatedId,
        "First contract activation requires absent expected versions.",
      );
    }
    if (
      validatedInput.goal_contract !== undefined &&
      !canUpdateGoalContract(current.state.phase)
    ) {
      throw new ControllerConflictError(
        "goal_contract_locked",
        validatedId,
        `Goal contracts are locked after entering ${current.state.phase}.`,
      );
    }

    const saved = this.buildCrossSourceSave(current, validatedInput);
    return this.transferWorkItem(source, target, saved.work_item, {
      kind: "save",
      manifest: saved.manifest,
    });
  }

  async updateWorkItemPhase(
    sourceId: string,
    workItemId: string,
    input: UpdateWorkItemPhaseInput,
  ): Promise<PortfolioWorkItem> {
    const validatedInput = updateWorkItemPhaseInputSchema.parse(input);
    const source = await this.resolveSource(sourceId);
    const current = await source.workspace.read(workItemId);

    if (current === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }

    const dedicatedPolicy = dedicatedTransitionPolicy(
      current.state.phase,
      validatedInput.target_phase,
    );
    if (dedicatedPolicy.kind !== "generic_allowed") {
      throw new InvalidWorkItemTransitionError(
        current.state.phase,
        validatedInput.target_phase,
        dedicatedPolicy.kind === "dedicated_operation_required"
          ? `${dedicatedPolicy.action_label} — ${dedicatedPolicy.explanation}`
          : dedicatedPolicy.explanation,
      );
    }

    const transition = validateWorkItemTransition(
      current.state.phase,
      validatedInput.target_phase,
      current.state.status,
      current.state.status,
    );
    if (!transition.ok) {
      throw new InvalidWorkItemTransitionError(
        current.state.phase,
        validatedInput.target_phase,
        transition.reason,
      );
    }

    const updated = await source.workspace.updatePhase(
      workItemId,
      validatedInput,
    );
    if (updated === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }

    await this.rebuild();

    return {
      source_id: source.source_id,
      project: source.project,
      work_item: updated,
    };
  }

  async compileMission(
    sourceId: string,
    workItemId: string,
  ): Promise<MissionCompilation> {
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    if (
      source.source_id === INBOX_SOURCE_ID ||
      workItem.goal.goal_contract === undefined ||
      workItem.state.phase !== "execute" ||
      workItem.state.status !== "active" ||
      workItem.state.goal_version === undefined ||
      workItem.state.input_revision === undefined ||
      workItem.state.attempt === undefined
    ) {
      throw this.missionNotReady(
        workItemId,
        "Mission compilation requires an assigned, governed item in active execute.",
      );
    }

    const identity: MissionIdentity<"execute"> = {
      phase: "execute",
      work_item_id: workItemId,
      goal_version: workItem.state.goal_version,
      input_revision: workItem.state.input_revision,
      attempt: workItem.state.attempt,
    };
    const executeManifest =
      await source.workspace.findAppliedExecuteManifest(identity);
    if (executeManifest === null) {
      throw this.missionNotReady(
        workItemId,
        "No applied execute manifest matches the governed tuple.",
      );
    }

    const capabilityAuthorization =
      executeManifest.capability_grant ??
      executeManifest.capability_carry_forward;
    if (capabilityAuthorization !== undefined) {
      if (identity.attempt < 1) {
        throw this.missionNotReady(
          workItemId,
          "An initial Execute attempt cannot carry permission-recovery authorization.",
        );
      }
      const prior = await source.workspace.readMissionPackage({
        ...identity,
        attempt: identity.attempt - 1,
      });
      if (
        prior.mission.identity.phase !== "execute" ||
        prior.mission.content_sha256 !==
          capabilityAuthorization.source_mission_content_sha256
      ) {
        throw this.missionNotReady(
          workItemId,
          "The Execute capability authorization does not bind the immediately prior mission.",
        );
      }
    }

    const approvedPlanArtifacts = (
      await source.workspace.listShapingArtifacts(workItemId)
    ).filter(
      (artifact) =>
        artifact.mission.identity.phase === "plan" &&
        artifact.result !== null &&
        artifact.decision !== null &&
        "execute_tuple" in artifact.decision.receipt,
    );
    if (approvedPlanArtifacts.length > 1) {
      throw this.missionNotReady(
        workItemId,
        "More than one approved Plan is bound to this Execute work item.",
      );
    }
    let approvedPlan: ExecuteApprovedPlan | undefined;
    const approvedPlanArtifact = approvedPlanArtifacts[0];
    if (
      approvedPlanArtifact !== undefined &&
      approvedPlanArtifact.result !== null &&
      approvedPlanArtifact.decision !== null &&
      "execute_tuple" in approvedPlanArtifact.decision.receipt
    ) {
      const receipt = approvedPlanArtifact.decision.receipt;
      const result = planResultSubmissionSchema.parse(
        JSON.parse(approvedPlanArtifact.result.result_source),
      );
      if (
        receipt.mission_content_sha256 !==
          approvedPlanArtifact.mission.content_sha256 ||
        receipt.result_content_sha256 !==
          approvedPlanArtifact.result.result_content_sha256 ||
        result.plan_mission_content_sha256 !== receipt.mission_content_sha256
      ) {
        throw this.missionNotReady(
          workItemId,
          "The approved Plan receipt is not bound to its immutable mission and result.",
        );
      }
      approvedPlan = {
        mission_content_sha256: receipt.mission_content_sha256,
        result_content_sha256: receipt.result_content_sha256,
        goal_contract_sha256: receipt.goal_contract_sha256,
        approved_at: receipt.approved_at,
        summary: result.summary,
        checklist: result.checklist,
        relevant_skills: result.relevant_skills,
        product_doc_impacts: result.product_doc_impacts,
        todo_impacts: result.todo_impacts,
        open_questions: result.open_questions,
      };
    }

    return source.workspace.writeMissionPackage(identity, (paths) =>
      compileMissionPackage(
        workItem,
        executeManifest,
        paths,
        capabilityAuthorization?.execution_defaults,
        approvedPlan,
      ),
    ) as Promise<MissionCompilation>;
  }

  async compileBrainstormMission(
    sourceId: string,
    workItemId: string,
  ): Promise<BrainstormMissionCompilation> {
    const { source, workItem } = await this.requireActiveShapingItem(
      sourceId,
      workItemId,
      "brainstorm",
    );
    return this.currentShapingCompilation(
      source,
      workItem,
      "brainstorm",
    ) as Promise<BrainstormMissionCompilation>;
  }

  async importBrainstormResult(
    sourceId: string,
    workItemId: string,
    input?: ShapingManualImportBinding,
  ): Promise<ShapingImportResult> {
    const { source, workItem } = await this.requireActiveShapingItem(
      sourceId,
      workItemId,
      "brainstorm",
    );
    return this.importShapingResult(
      source,
      workItem,
      "brainstorm",
      shapingManualImportBindingSchema.parse(input),
    );
  }

  async compileSpecMission(
    sourceId: string,
    workItemId: string,
    input?: { brainstorm_acceptance_sha256: string },
  ): Promise<SpecMissionCompilation> {
    const { source, workItem } = await this.requireActiveShapingItem(
      sourceId,
      workItemId,
      "spec",
    );
    const compilation = (await this.currentShapingCompilation(
      source,
      workItem,
      "spec",
    )) as SpecMissionCompilation;
    if (
      input !== undefined &&
      compilation.mission.input.brainstorm_selection_sha256 !==
        compileSpecMissionInputSchema.parse(input)
          .brainstorm_acceptance_sha256
    ) {
      throw this.missionNotReady(
        workItemId,
        "The selected Brainstorm decision does not match the current Spec mission.",
      );
    }
    return compilation;
  }

  async compilePlanMission(
    sourceId: string,
    workItemId: string,
  ): Promise<PlanMissionCompilation> {
    const { source, workItem } = await this.requireActiveShapingItem(
      sourceId,
      workItemId,
      "plan",
    );
    return this.currentShapingCompilation(
      source,
      workItem,
      "plan",
    ) as Promise<PlanMissionCompilation>;
  }

  async importSpecResult(
    sourceId: string,
    workItemId: string,
    input?: ShapingManualImportBinding,
  ): Promise<ShapingImportResult> {
    const { source, workItem } = await this.requireActiveShapingItem(
      sourceId,
      workItemId,
      "spec",
    );
    return this.importShapingResult(
      source,
      workItem,
      "spec",
      shapingManualImportBindingSchema.parse(input),
    );
  }

  async importPlanResult(
    sourceId: string,
    workItemId: string,
    input?: ShapingManualImportBinding,
  ): Promise<ShapingImportResult> {
    const { source, workItem } = await this.requireActiveShapingItem(
      sourceId,
      workItemId,
      "plan",
    );
    return this.importShapingResult(
      source,
      workItem,
      "plan",
      shapingManualImportBindingSchema.parse(input),
    );
  }

  async openManualIngress(
    sourceId: string,
    workItemId: string,
    phase: ShapingPhase,
    input: ShapingManualImportBinding,
  ): Promise<ManualShapingIngressResult> {
    const validated = shapingManualImportBindingSchema.parse(input);
    const { source, workItem } = await this.requireActiveShapingItem(
      sourceId,
      workItemId,
      phase,
    );
    const artifacts = await source.workspace.listShapingArtifacts(workItemId);
    const runs = await source.workspace.listShapingRuns(workItemId);
    const artifact = this.requireCurrentShapingArtifact(
      workItem,
      phase,
      artifacts,
      validated.expected_mission_content_sha256,
    );
    this.assertExpectedShapingState(
      workItem,
      artifacts,
      runs,
      validated.expected_shaping_state_sha256,
    );
    const written = await source.workspace.writeShapingIngressInstruction({
      origin: "manual_import",
      shaping_run_id: null,
      mission: artifact.mission,
    });
    return {
      source_id: source.source_id,
      work_item_id: workItemId,
      task: this.renderManualRecoveryTask(
        artifact.mission,
        written.instruction,
      ),
      instruction: written.instruction,
      instruction_path: written.instruction_path,
    };
  }

  async launchShapingRun(
    sourceId: string,
    workItemId: string,
    phase: ShapingPhase,
    input: { requested_model: string },
  ): Promise<PortfolioShapingLaunchResult> {
    const validated = launchShapingRunRequestSchema.parse(input);
    const { source, workItem } = await this.requireActiveShapingItem(
      sourceId,
      workItemId,
      phase,
    );
    const artifacts = await source.workspace.listShapingArtifacts(workItemId);
    const mission = this.requireCurrentShapingArtifact(
      workItem,
      phase,
      artifacts,
    ).mission;
    const launched = await this.launchPreparedShapingMission(
      source,
      mission,
      validated.requested_model,
    );
    return this.portfolioShapingLaunchResult(source, workItemId, launched);
  }

  async cancelShapingRun(
    sourceId: string,
    workItemId: string,
    shapingRunId: string,
    expectedPhase?: ShapingPhase,
  ): Promise<PortfolioShapingLaunchResult> {
    const validatedRunId = controllerRunIdSchema.parse(shapingRunId);
    const { source } = await this.requireActiveShapingItem(
      sourceId,
      workItemId,
      expectedPhase,
    );
    const record = await source.workspace.readShapingRun(
      workItemId,
      validatedRunId,
    );
    if (record === null) {
      throw this.missionNotReady(workItemId, "Shaping run was not found.");
    }
    if (expectedPhase !== undefined && record.mission.phase !== expectedPhase) {
      throw this.missionNotReady(
        workItemId,
        `Shaping run ${validatedRunId} does not belong to ${expectedPhase}.`,
      );
    }
    if (record.lifecycle.status === "terminal") {
      return this.portfolioShapingLaunchResult(source, workItemId, {
        record,
        instruction: await source.workspace.readShapingRunInstruction(
          workItemId,
          validatedRunId,
        ),
        created: false,
      });
    }
    const key = this.shapingSessionKey(
      source.source_id,
      workItemId,
      validatedRunId,
    );
    const handle = this.liveShapingSessions.get(key);
    if (handle === undefined) {
      const current = await source.workspace.readShapingRun(
        workItemId,
        validatedRunId,
      );
      if (current?.lifecycle.status === "terminal") {
        return this.portfolioShapingLaunchResult(source, workItemId, {
          record: current,
          instruction: await source.workspace.readShapingRunInstruction(
            workItemId,
            validatedRunId,
          ),
          created: false,
        });
      }
      throw this.missionNotReady(
        workItemId,
        "This service cannot safely cancel a shaping run it did not start.",
      );
    }
    await handle.cancel();
    const terminal = await source.workspace.readShapingRun(
      workItemId,
      validatedRunId,
    );
    if (terminal?.lifecycle.status !== "terminal") {
      throw this.missionNotReady(
        workItemId,
        "Shaping cancellation did not reach a durable terminal state.",
      );
    }
    this.liveShapingSessions.delete(key);
    await this.rebuild();
    return this.portfolioShapingLaunchResult(source, workItemId, {
      record: terminal,
      instruction: await source.workspace.readShapingRunInstruction(
        workItemId,
        validatedRunId,
      ),
      created: false,
    });
  }

  async listShapingRuns(
    sourceId: string,
    workItemId: string,
    phase: ShapingPhase,
  ): Promise<ShapingRunSummary[]> {
    const { source } = await this.requireActiveShapingItem(
      sourceId,
      workItemId,
      phase,
    );
    return (await source.workspace.listShapingRuns(workItemId))
      .filter((run) => run.mission.phase === phase)
      .map(summarizeShapingRun);
  }

  async repairRetainedControllerLease(
    sourceId: string,
    workItemId: string,
    input: { acknowledged_run_id: string },
  ): Promise<RetainedControllerLeaseRepairResult> {
    const source = await this.resolveSource(sourceId);
    if ((await source.workspace.read(workItemId)) === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const repaired = await source.workspace.repairRetainedControllerLease(
      workItemId,
      input,
    );
    await this.rebuild();
    return repaired;
  }

  async startBrainstorm(
    sourceId: string,
    workItemId: string,
    input: StartBrainstormDecisionInput,
  ): Promise<PortfolioShapingDecisionResult> {
    const source = await this.requireDecisionSource(sourceId, workItemId);
    this.preflightDecisionLaunch(workItemId, input);
    const decided = await this.workItemController(
      source.workspace,
    ).startBrainstorm(workItemId, input);
    return this.finishShapingDecision(source, decided);
  }

  async requestShapingChanges(
    sourceId: string,
    workItemId: string,
    input: RequestShapingChangesInput,
    expectedPhase?: ShapingPhase,
  ): Promise<PortfolioShapingDecisionResult> {
    const source =
      expectedPhase === undefined
        ? await this.requireDecisionSource(sourceId, workItemId)
        : (
            await this.requireActiveShapingItem(
              sourceId,
              workItemId,
              expectedPhase,
            )
          ).source;
    this.preflightDecisionLaunch(workItemId, input);
    const decided = await this.workItemController(
      source.workspace,
    ).requestShapingChanges(workItemId, input);
    return this.finishShapingDecision(source, decided);
  }

  async useBrainstormResult(
    sourceId: string,
    workItemId: string,
    input: ShapingResultDecisionInput,
  ): Promise<PortfolioShapingDecisionResult> {
    const source = await this.requireDecisionSource(sourceId, workItemId);
    this.preflightDecisionLaunch(workItemId, input);
    const decided = await this.workItemController(
      source.workspace,
    ).useBrainstormResult(workItemId, input);
    return this.finishShapingDecision(source, decided);
  }

  async approveSpecResult(
    sourceId: string,
    workItemId: string,
    input: ApproveSpecDecisionInput,
  ): Promise<PortfolioShapingDecisionResult> {
    const source = await this.requireDecisionSource(sourceId, workItemId);
    this.preflightDecisionLaunch(workItemId, input);
    const decided = await this.workItemController(
      source.workspace,
    ).approveSpecResult(workItemId, input);
    return this.finishShapingDecision(source, decided);
  }

  async approvePlanResult(
    sourceId: string,
    workItemId: string,
    input: ApprovePlanResultInput,
  ): Promise<PortfolioPlanApprovalResult> {
    const source = await this.requireDecisionSource(sourceId, workItemId);
    this.preflightExecuteLaunch(workItemId, input);
    const approved = await this.workItemController(
      source.workspace,
    ).approvePlanResult(workItemId, input);

    let mission: MissionCompilation | null = null;
    try {
      mission = await this.compileMission(sourceId, workItemId);
      if (approved.launch_mode === "manual") {
        await this.rebuild();
        return this.planApprovalResult(source, approved, {
          mission,
          connected_run: null,
          next_launch: {
            status: "manual",
            connected_run_id: null,
            reason:
              this.executeModelAvailability().status === "unavailable"
                ? "runtime_unavailable"
                : "founder_selected_manual",
          },
        });
      }

      const launched = await this.launchConnectedExecute(
        sourceId,
        workItemId,
        { model_override: approved.requested_model! },
      );
      return this.planApprovalResult(source, approved, {
        mission,
        connected_run: launched.connected_run,
        next_launch: {
          status: "launched",
          connected_run_id: launched.connected_run.connected_run_id,
          reason: null,
        },
      });
    } catch (error) {
      await this.rebuild().catch(() => undefined);
      return this.planApprovalResult(source, approved, {
        mission,
        connected_run: null,
        next_launch: {
          status: "failed",
          connected_run_id: null,
          reason: errorMessage(error).slice(0, 500),
        },
      });
    }
  }

  async replanWithUpdatedContract(
    sourceId: string,
    workItemId: string,
    input: ReplanWithUpdatedContractInput,
  ): Promise<PortfolioShapingDecisionResult> {
    const source = await this.requireDecisionSource(sourceId, workItemId);
    this.preflightDecisionLaunch(workItemId, input);
    const decided = await this.workItemController(
      source.workspace,
    ).replanWithUpdatedContract(workItemId, input);
    return this.finishShapingDecision(source, decided);
  }

  async retryShapingLaunch(
    sourceId: string,
    workItemId: string,
    phase: ShapingPhase,
    input: ShapingRetryLaunchInput,
  ): Promise<PortfolioShapingLaunchResult> {
    const validated = shapingRetryLaunchInputSchema.parse(input);
    const source = await this.requireDecisionSource(sourceId, workItemId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const manifest = await source.workspace.readShapingDecisionManifest(
      workItemId,
      validated.decision_id,
    );
    if (
      manifest === null ||
      manifest.work_item_id !== workItemId ||
      manifest.phase_to !== phase
    ) {
      throw new ControllerConflictError(
        "stale_expectation",
        workItemId,
        `Applied shaping decision ${validated.decision_id} was not found for ${phase}.`,
      );
    }
    if (manifest.outcome === "pending") {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        `Shaping decision ${validated.decision_id} is pending; replay the leased decision before retrying launch.`,
      );
    }
    if (manifest.outcome !== "applied") {
      throw new ControllerConflictError(
        "stale_expectation",
        workItemId,
        `Shaping decision ${validated.decision_id} is not applied.`,
      );
    }
    const intent = await source.workspace.readShapingDecisionIntent(
      workItemId,
      validated.decision_id,
    );
    if (
      intent === null ||
      intent.launch_mode !== "connected" ||
      intent.next_requested_model === null ||
      intent.launch_fingerprint === null
    ) {
      throw this.missionNotReady(
        workItemId,
        "This shaping decision has no connected launch to retry.",
      );
    }
    this.assertCommittedShapingIntentState(workItem, intent);

    const artifacts = await source.workspace.listShapingArtifacts(workItemId);
    const runs = await source.workspace.listShapingRuns(workItemId);
    const shapingState = this.shapingDecisionState(workItem, artifacts, runs);
    if (
      hashShapingDecisionState(shapingState) !==
      validated.expected_shaping_state_sha256
    ) {
      throw new ControllerConflictError(
        "stale_expectation",
        workItemId,
        "Expected shaping state does not match the durable launch state.",
      );
    }
    const artifact = artifacts.find(
      (candidate) =>
        candidate.mission.content_sha256 ===
        intent.next_mission_content_sha256,
    );
    if (
      artifact === undefined ||
      artifact.mission.identity.phase !== phase ||
      artifact.mission.identity.input_sha256 !==
        intent.next_mission_input_sha256
    ) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        "The decision intent's target mission is missing or inconsistent.",
      );
    }
    if (artifact.result !== null) {
      throw this.missionNotReady(
        workItemId,
        "This shaping mission revision already has an applied result.",
      );
    }

    const nonTerminalRuns = runs.filter(
      (run) => run.lifecycle.status !== "terminal",
    );
    const matching = nonTerminalRuns.find(
      (run) => this.shapingRunFingerprint(run) === intent.launch_fingerprint,
    );
    if (matching !== undefined) {
      return this.portfolioShapingLaunchResult(source, workItemId, {
        record: matching,
        instruction: await source.workspace.readShapingRunInstruction(
          workItemId,
          matching.shaping_run_id,
        ),
        created: false,
      });
    }
    if (nonTerminalRuns.length > 0) {
      throw new ControllerConflictError(
        "lease_held",
        workItemId,
        `Shaping run ${nonTerminalRuns[0]!.shaping_run_id} is already active with a different launch fingerprint.`,
      );
    }

    this.assertShapingModelAvailable(
      workItemId,
      intent.next_requested_model,
    );
    const launched = await this.launchPreparedShapingMission(
      source,
      artifact.mission,
      intent.next_requested_model,
      intent.launch_fingerprint,
    );
    return this.portfolioShapingLaunchResult(source, workItemId, launched);
  }

  async listShapingArtifacts(
    sourceId: string,
    workItemId: string,
  ): Promise<ShapingArtifactListing> {
    const { source, workItem } = await this.requireReadableShapingItem(
      sourceId,
      workItemId,
    );
    const artifacts = await source.workspace.listShapingArtifacts(workItemId);
    if (workItem.state.phase === "idea" && artifacts.length !== 0) {
      throw this.missionNotReady(
        workItemId,
        "Start Brainstorm requires an Idea with no existing shaping mission.",
      );
    }
    const runs = await source.workspace.listShapingRuns(workItemId);
    const connectedRuns = await source.workspace.listConnectedRuns(workItemId);
    const modelAvailability = this.shapingModelAvailability();
    const executeModelAvailability = this.executeModelAvailability();
    const modelUse = this.workflowModelUse(
      workItemId,
      artifacts,
      runs,
      connectedRuns,
    );
    const modelPickerOptions = await this.modelPickerOptions(
      modelAvailability,
      executeModelAvailability,
      modelUse,
      this.isPlanDecisionEligible(workItem, artifacts, runs),
    );
    const postCommitLaunchFailure =
      await this.currentPostCommitLaunchFailure(
        source,
        workItem,
        artifacts,
        runs,
      );
    return {
      source_id: source.source_id,
      work_item_id: workItemId,
      artifacts,
      runs: runs.map(summarizeShapingRun),
      expected_shaping_state_sha256: hashShapingDecisionState(
        this.shapingDecisionState(workItem, artifacts, runs),
      ),
      model_availability: modelAvailability,
      execute_model_availability: executeModelAvailability,
      model_use: modelUse,
      model_picker_options: modelPickerOptions,
      post_commit_launch_failure: postCommitLaunchFailure,
    };
  }

  getShapingModelAvailability(): ShapingModelAvailability {
    return this.shapingModelAvailability();
  }

  getExecuteModelAvailability(): ShapingModelAvailability {
    return this.executeModelAvailability();
  }

  getReviewModelAvailability(): ShapingModelAvailability {
    return this.reviewModelAvailability();
  }

  getPatchModelAvailability(): ShapingModelAvailability {
    return this.patchModelAvailability();
  }

  async getConnectedModelOptions(
    sourceId: string,
    workItemId: string,
  ): Promise<ConnectedModelListing> {
    const source = await this.resolveSource(sourceId);
    if ((await source.workspace.read(workItemId)) === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const [artifacts, shapingRuns, connectedRuns] = await Promise.all([
      source.workspace.listShapingArtifacts(workItemId),
      source.workspace.listShapingRuns(workItemId),
      source.workspace.listConnectedRuns(workItemId),
    ]);
    const modelUse = this.workflowModelUse(
      workItemId,
      artifacts,
      shapingRuns,
      connectedRuns,
    );
    const modelAvailability = {
      execute: this.executeModelAvailability(),
      review: this.reviewModelAvailability(),
      patch: this.patchModelAvailability(),
    } satisfies Record<ConnectedRunPhase, ShapingModelAvailability>;
    const optionEntries = await Promise.all(
      (Object.keys(modelAvailability) as ConnectedRunPhase[]).map(
        async (seat) => {
          const availability = modelAvailability[seat];
          if (
            availability.status === "unavailable" ||
            availability.adapter_id === null
          ) {
            return [seat, []] as const;
          }
          const saved = await this.preferencesStore.getPreference(
            availability.adapter_id,
            seat,
          );
          return [
            seat,
            shapingModelPickerOptions(
              availability.available_model_ids,
              modelUse,
              saved,
            ),
          ] as const;
        },
      ),
    );
    return {
      model_availability: modelAvailability,
      model_picker_options: Object.fromEntries(optionEntries) as Record<
        ConnectedRunPhase,
        ShapingModelPickerOption[]
      >,
    };
  }

  async launchConnectedExecute(
    sourceId: string,
    workItemId: string,
    input: LaunchConnectedExecuteRequest = {},
  ): Promise<PortfolioConnectedRunResult> {
    const validatedInput = launchConnectedExecuteRequestSchema.parse(input);
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const identity = this.governedExecuteIdentity(source, workItem);
    const governedTuple = this.governedExecuteTuple(workItem, identity);
    const controller = this.workItemController(source.workspace);
    const connectedRuns = await source.workspace.listConnectedRuns(workItemId);
    const runOrdinal = connectedRuns.filter(
      (record) => record.lifecycle.status === "terminal",
    ).length;
    const activeRuns = connectedRuns.filter(
      (record) => record.lifecycle.status !== "terminal",
    );
    if (activeRuns.length > 1) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        "Only one connected run may be active for a governed item.",
      );
    }
    if (activeRuns.length === 1) {
      const activeRun = activeRuns[0]!;
      const replay = await controller.launchConnectedRun(
        workItemId,
        this.connectedLaunchInput(
          governedTuple,
          activeRun.mission.content_sha256,
          validatedInput.model_override,
          runOrdinal,
        ),
        activeRun,
      );
      return {
        ...this.toPortfolioItem(source, replay.work_item),
        connected_run: summarizeConnectedRun(replay.connected_run),
      };
    }
    if (this.writableRuntime === undefined) {
      throw this.missionNotReady(
        workItemId,
        "Connected execution is not configured for this Product Studio service.",
      );
    }
    if (validatedInput.model_override !== undefined) {
      this.assertExecuteModelAvailable(
        workItemId,
        validatedInput.model_override,
      );
    }

    const mission = await this.connectedExecuteMission(
      source,
      identity,
      connectedRuns,
    );
    const capabilityEnvelope = this.resolveConnectedCapabilityEnvelope(
      workItemId,
      mission.mission.capability_envelope,
      validatedInput.narrowed_capability_envelope,
    );
    const launchInput = this.connectedLaunchInput(
      governedTuple,
      mission.mission.content_sha256,
      validatedInput.model_override,
      runOrdinal,
    );

    const prepared = await this.writableRuntime.prepare({
      workspace_cwd: source.workspace.workspaceRoot,
      capability_envelope: capabilityEnvelope,
      limits: CONNECTED_RUN_LIMITS,
      ...(validatedInput.model_override === undefined
        ? {}
        : { model_override: validatedInput.model_override }),
    });
    const record = this.connectedRunRecord(
      mission,
      governedTuple,
      capabilityEnvelope,
      prepared,
    );
    return this.launchPreparedConnectedRun({
      source,
      work_item_id: workItemId,
      controller,
      launch_input: launchInput,
      record,
      prompt: `Execute the governed task in ${mission.mission.task_path} and write only the required result to ${mission.mission.result_contract.output_path}. ${WRITABLE_PERMISSION_REQUEST_GUIDANCE}`,
      start_session: (eventSink, callbacks) =>
        prepared.start(eventSink, callbacks),
      after_complete: async (result, terminal, launched) => {
        if (terminal.lifecycle.terminal?.outcome !== result.outcome) {
          return;
        }
        if (result.outcome === "missing_permission") {
          await this.recordMissingPermission(
            source,
            workItemId,
            mission,
            launched,
            result,
          );
        } else if (result.outcome === "completed") {
          await this.importResult(source.source_id, workItemId);
        }
        await this.rebuild();
      },
    });
  }

  private async connectedExecuteMission(
    source: ResolvedSource,
    identity: MissionIdentity<"execute">,
    connectedRuns: ConnectedRunRecordV2[],
  ): Promise<MissionCompilation> {
    const matchingRuns = connectedRuns.filter(
      (record) =>
        JSON.stringify(record.mission.identity) === JSON.stringify(identity),
    );
    if (matchingRuns.length === 0) {
      return this.compileMission(source.source_id, identity.work_item_id);
    }

    const snapshot = await source.workspace.readMissionPackage(identity);
    const mission = snapshot.mission;
    if (
      mission.mission_schema_version !== MISSION_SCHEMA_VERSION ||
      !("capability_envelope" in mission) ||
      "patch_subject" in mission ||
      mission.identity.phase !== "execute"
    ) {
      throw new ControllerConflictError(
        "repair_required",
        identity.work_item_id,
        "Connected Execute retry requires the current immutable Execute mission package.",
      );
    }
    const disagreesWithSnapshot = matchingRuns.some(
      (record) =>
        record.mission.path !== snapshot.mission_path ||
        record.mission.content_sha256 !== mission.content_sha256 ||
        record.mission.source_commit !==
          mission.source_revision.git_base_commit,
    );
    if (disagreesWithSnapshot) {
      throw new ControllerConflictError(
        "repair_required",
        identity.work_item_id,
        "Connected Execute history disagrees with the immutable mission package.",
      );
    }

    return {
      mission,
      workspace_path: source.workspace.workspaceRoot,
      task_path: join(source.workspace.workspaceRoot, mission.task_path),
      mission_path: join(
        source.workspace.workspaceRoot,
        snapshot.mission_path,
      ),
    };
  }

  async launchConnectedPatch(
    sourceId: string,
    workItemId: string,
    input: LaunchConnectedPatchRequest = {},
  ): Promise<PortfolioConnectedRunResult> {
    const validatedInput = launchConnectedPatchRequestSchema.parse(input);
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const identity = this.governedPatchIdentity(source, workItem);
    if (workItem.state.phase !== "patch" || workItem.state.status !== "active") {
      throw this.missionNotReady(
        workItemId,
        "Connected Patch requires an assigned, governed item in active patch.",
      );
    }
    const governedTuple = this.governedPatchTuple(workItem, identity);
    const controller = this.workItemController(source.workspace);
    const connectedRuns = await source.workspace.listConnectedRuns(workItemId);
    const runOrdinal = connectedRuns.filter(
      (record) => record.lifecycle.status === "terminal",
    ).length;
    const activeRuns = connectedRuns.filter(
      (record) => record.lifecycle.status !== "terminal",
    );
    if (activeRuns.length > 1) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        "Only one connected run may be active for a governed item.",
      );
    }
    if (activeRuns.length === 1) {
      const activeRun = activeRuns[0]!;
      const mission = await this.compilePatchMission(sourceId, workItemId);
      const capabilityEnvelope = this.resolveConnectedCapabilityEnvelope(
        workItemId,
        mission.mission.capability_envelope,
        validatedInput.narrowed_capability_envelope,
      );
      if (
        activeRun.authorization.kind !== "capability_envelope" ||
        activeRun.authorization.envelope_sha256 !==
          hashResolvedCapabilityEnvelope(capabilityEnvelope)
      ) {
        throw new ControllerConflictError(
          "idempotency_conflict",
          workItemId,
          "An active connected Patch run has a different authorization binding.",
        );
      }
      const replay = await controller.launchConnectedRun(
        workItemId,
        this.connectedPatchLaunchInput(
          governedTuple,
          mission.mission.content_sha256,
          validatedInput.model_override,
          runOrdinal,
        ),
        activeRun,
      );
      return {
        ...this.toPortfolioItem(source, replay.work_item),
        connected_run: summarizeConnectedRun(replay.connected_run),
      };
    }

    const mission = await this.compilePatchMission(sourceId, workItemId);
    if (this.writableRuntime === undefined) {
      throw this.missionNotReady(
        workItemId,
        "Connected Patch is not configured for this Product Studio service.",
      );
    }
    const configuration = connectedRuntimeConfigurationSchema.parse(
      this.writableRuntime.configuration(),
    );
    const requestedModel =
      validatedInput.model_override ?? configuration.default_model;
    this.assertPatchModelAvailable(workItemId, requestedModel);
    const capabilityEnvelope = this.resolveConnectedCapabilityEnvelope(
      workItemId,
      mission.mission.capability_envelope,
      validatedInput.narrowed_capability_envelope,
    );
    const prepared = await this.writableRuntime.prepare({
      workspace_cwd: source.workspace.workspaceRoot,
      capability_envelope: capabilityEnvelope,
      limits: CONNECTED_RUN_LIMITS,
      ...(validatedInput.model_override === undefined
        ? {}
        : { model_override: validatedInput.model_override }),
    });
    if (
      prepared.requested_model !== requestedModel ||
      prepared.sanitized_profile.requested_model !== requestedModel ||
      prepared.sanitized_profile.adapter_id !== configuration.adapter_id ||
      prepared.sanitized_profile.adapter_version !==
        configuration.adapter_version ||
      prepared.sanitized_profile.profile_id !== configuration.profile_id
    ) {
      throw this.missionNotReady(
        workItemId,
        "Prepared Patch runtime provenance does not match the validated launch request.",
      );
    }
    this.assertPatchModelAvailable(workItemId, requestedModel);
    const launchInput = this.connectedPatchLaunchInput(
      governedTuple,
      mission.mission.content_sha256,
      validatedInput.model_override,
      runOrdinal,
    );
    const record = this.connectedRunRecord(
      mission,
      governedTuple,
      capabilityEnvelope,
      prepared,
    );
    return this.launchPreparedConnectedRun({
      source,
      work_item_id: workItemId,
      controller,
      launch_input: launchInput,
      record,
      prompt: `Apply the governed Patch task in ${mission.mission.task_path} and write only the required result to ${mission.mission.result_contract.output_path}. ${WRITABLE_PERMISSION_REQUEST_GUIDANCE}`,
      start_session: (eventSink, callbacks) =>
        prepared.start(eventSink, callbacks),
      preference: {
        adapter_id: configuration.adapter_id,
        seat: "patch",
        requested_model: requestedModel,
      },
      after_complete: async (result, terminal, launched) => {
        if (terminal.lifecycle.terminal?.outcome !== result.outcome) {
          return;
        }
        if (result.outcome === "missing_permission") {
          await this.recordMissingPermission(
            source,
            workItemId,
            mission,
            launched,
            result,
          );
        } else if (result.outcome === "completed") {
          await this.importPatchResult(source.source_id, workItemId);
        }
        await this.rebuild();
      },
    });
  }

  async launchConnectedReview(
    sourceId: string,
    workItemId: string,
    input: LaunchConnectedReviewRequest,
  ): Promise<PortfolioConnectedRunResult> {
    const validatedInput = launchConnectedReviewRequestSchema.parse(input);
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const identity = this.governedReviewIdentity(source, workItem);
    if (
      workItem.state.phase !== "review" ||
      workItem.state.status !== "active"
    ) {
      throw this.missionNotReady(
        workItemId,
        "Connected Review requires an assigned, governed item in active review.",
      );
    }
    const governedTuple = this.governedReviewTuple(workItem, identity);
    const controller = this.workItemController(source.workspace);
    const connectedRuns = await source.workspace.listConnectedRuns(workItemId);
    const runOrdinal = connectedRuns.filter(
      (record) => record.lifecycle.status === "terminal",
    ).length;
    const activeRuns = connectedRuns.filter(
      (record) => record.lifecycle.status !== "terminal",
    );
    if (activeRuns.length > 1) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        "Only one connected run may be active for a governed item.",
      );
    }
    if (activeRuns.length === 1) {
      const activeRun = activeRuns[0]!;
      const replay = await controller.launchConnectedRun(
        workItemId,
        this.connectedReviewLaunchInput(
          governedTuple,
          activeRun.mission.content_sha256,
          validatedInput.model_override,
          runOrdinal,
        ),
        activeRun,
      );
      return {
        ...this.toPortfolioItem(source, replay.work_item),
        connected_run: summarizeConnectedRun(replay.connected_run),
      };
    }
    const mission = await this.compileReviewMission(sourceId, workItemId, {
      independence_attested: validatedInput.independence_attested,
    });
    if (this.reviewRuntime === undefined) {
      throw this.missionNotReady(
        workItemId,
        "Connected Review is not configured for this Product Studio service.",
      );
    }

    const configuration = connectedRuntimeConfigurationSchema.parse(
      this.reviewRuntime.configuration(),
    );
    const requestedModel =
      validatedInput.model_override ?? configuration.default_model;
    this.assertReviewModelAvailable(workItemId, requestedModel);
    const policy = this.connectedReviewPolicy(mission);
    const prepared = await this.reviewRuntime.prepare({
      workspace_cwd: source.workspace.workspaceRoot,
      limits: CONNECTED_RUN_LIMITS,
      requested_model: requestedModel,
      result_ingress_policy: policy,
    });
    if (
      prepared.requested_model !== requestedModel ||
      prepared.sanitized_profile.requested_model !== requestedModel ||
      prepared.sanitized_profile.adapter_id !== configuration.adapter_id ||
      prepared.sanitized_profile.adapter_version !==
        configuration.adapter_version ||
      prepared.sanitized_profile.profile_id !== configuration.profile_id
    ) {
      throw this.missionNotReady(
        workItemId,
        "Prepared Review runtime provenance does not match the validated launch request.",
      );
    }
    this.assertReviewModelAvailable(workItemId, requestedModel);
    const launchInput = this.connectedReviewLaunchInput(
      governedTuple,
      mission.mission.content_sha256,
      validatedInput.model_override,
      runOrdinal,
    );
    const record = this.connectedReviewRunRecord(
      mission,
      governedTuple,
      policy,
      prepared,
    );
    return this.launchPreparedConnectedRun({
      source,
      work_item_id: workItemId,
      controller,
      launch_input: launchInput,
      record,
      prompt: `Review the exact immutable subject in ${mission.mission.task_path}. Follow TASK.md's review criteria and JSON shape. TASK.md's instruction to write the result applies only to manual handoff. For this connected run, use the final response instead. Return only the strict JSON Review result as your final response. Return one JSON object as the entire final response: start with { and end with }, with no Markdown fence or surrounding prose. Do not write or modify any workspace path, run commands, use URLs, or make approval decisions. Product Studio will validate and publish the response to ${mission.mission.result_contract.output_path}.`,
      start_session: (eventSink, callbacks) =>
        prepared.start(eventSink, callbacks),
      before_complete: async (result, connectedRunId) => {
        if (result.outcome !== "completed") {
          return;
        }
        const content = this.canonicalConnectedReviewOutput(
          workItemId,
          mission.mission,
          result.output_text,
        );
        await source.workspace.writeConnectedReviewResult(
          workItemId,
          connectedRunId,
          join(
            source.workspace.workspaceRoot,
            ...mission.mission.result_contract.output_path.split("/"),
          ),
          content,
        );
      },
      failure_terminal: (error) =>
        this.connectedReviewFailureTerminal(error),
      preference: {
        adapter_id: configuration.adapter_id,
        seat: "review",
        requested_model: requestedModel,
      },
      after_complete: async (result, terminal) => {
        if (terminal.lifecycle.terminal?.outcome !== result.outcome) {
          return;
        }
        if (result.outcome === "completed") {
          await this.importReviewResult(source.source_id, workItemId);
        }
        await this.rebuild();
      },
    });
  }

  async recoverConnectedReviewResult(
    sourceId: string,
    workItemId: string,
    input: RecoverConnectedReviewResultRequest,
  ): Promise<ConnectedReviewResultRecoveryReceiptV1> {
    const validatedInput = recoverConnectedReviewResultRequestSchema.parse(input);
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const identity = this.governedReviewIdentity(source, workItem);
    if (
      workItem.state.phase !== "review" ||
      workItem.state.status !== "active"
    ) {
      throw this.missionNotReady(
        workItemId,
        "Stale Review result recovery requires an assigned, governed item in active review.",
      );
    }

    const compiled = await this.compileReviewMission(sourceId, workItemId, {
      independence_attested: true,
    });
    if (
      compiled.mission.content_sha256 !==
      validatedInput.review_mission_content_sha256
    ) {
      throw new ControllerConflictError(
        "stale_expectation",
        workItemId,
        "The current Review mission does not match the founder-confirmed recovery hash.",
      );
    }
    const recovered = await this.workItemController(
      source.workspace,
    ).recoverConnectedReviewResult(workItemId, {
      identity,
      patch_cycle: workItem.state.patch_cycle!,
      review_mission_content_sha256:
        validatedInput.review_mission_content_sha256,
      result_path: compiled.mission.result_contract.output_path,
      expected_result_content_sha256: validatedInput.result_content_sha256,
      recovery_trigger_connected_run_id:
        validatedInput.recovery_trigger_connected_run_id,
    });
    await this.rebuild();
    return recovered.recovery;
  }

  async listConnectedRuns(
    sourceId: string,
    workItemId: string,
  ): Promise<ConnectedRunSummary[]> {
    return this.listConnectedRunsForPhase(sourceId, workItemId);
  }

  async listConnectedRunsForPhase(
    sourceId: string,
    workItemId: string,
    expectedPhase?: ConnectedRunPhase,
  ): Promise<ConnectedRunSummary[]> {
    const source = await this.resolveSource(sourceId);
    if ((await source.workspace.read(workItemId)) === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    return (await source.workspace.listConnectedRuns(workItemId))
      .filter(
        (record) =>
          expectedPhase === undefined ||
          record.mission.identity.phase === expectedPhase,
      )
      .map(summarizeConnectedRun);
  }

  async cancelConnectedRun(
    sourceId: string,
    workItemId: string,
    connectedRunId: string,
  ): Promise<PortfolioConnectedRunResult> {
    return this.cancelConnectedRunForPhase(
      sourceId,
      workItemId,
      connectedRunId,
      "execute",
    );
  }

  async cancelConnectedReviewRun(
    sourceId: string,
    workItemId: string,
    connectedRunId: string,
  ): Promise<PortfolioConnectedRunResult> {
    return this.cancelConnectedRunForPhase(
      sourceId,
      workItemId,
      connectedRunId,
      "review",
    );
  }

  async cancelConnectedPatchRun(
    sourceId: string,
    workItemId: string,
    connectedRunId: string,
  ): Promise<PortfolioConnectedRunResult> {
    return this.cancelConnectedRunForPhase(
      sourceId,
      workItemId,
      connectedRunId,
      "patch",
    );
  }

  private async cancelConnectedRunForPhase(
    sourceId: string,
    workItemId: string,
    connectedRunId: string,
    expectedPhase: ConnectedRunPhase,
  ): Promise<PortfolioConnectedRunResult> {
    const validatedRunId = controllerRunIdSchema.parse(connectedRunId);
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const record = await source.workspace.readConnectedRun(
      workItemId,
      validatedRunId,
    );
    if (record === null) {
      throw this.missionNotReady(workItemId, "Connected run was not found.");
    }
    if (record.mission.identity.phase !== expectedPhase) {
      throw new ControllerConflictError(
        "stale_expectation",
        workItemId,
        `Connected ${expectedPhase} cancellation cannot target a durable ${record.mission.identity.phase} run.`,
      );
    }
    if (record.lifecycle.status === "terminal") {
      return {
        ...this.toPortfolioItem(source, workItem),
        connected_run: summarizeConnectedRun(record),
      };
    }
    const key = this.connectedSessionKey(
      source.source_id,
      workItemId,
      validatedRunId,
    );
    const handle = this.liveConnectedSessions.get(key);
    if (handle === undefined) {
      const current = await source.workspace.readConnectedRun(
        workItemId,
        validatedRunId,
      );
      if (current?.lifecycle.status === "terminal") {
        return {
          ...this.toPortfolioItem(source, workItem),
          connected_run: summarizeConnectedRun(current),
        };
      }
      throw this.missionNotReady(
        workItemId,
        "This service cannot safely cancel a connected run it did not start.",
      );
    }
    await handle.cancel();
    const terminal = await source.workspace.readConnectedRun(
      workItemId,
      validatedRunId,
    );
    if (terminal?.lifecycle.status !== "terminal") {
      throw this.missionNotReady(
        workItemId,
        "Connected cancellation did not reach a durable terminal state.",
      );
    }
    this.liveConnectedSessions.delete(key);
    await this.rebuild();
    const currentWorkItem = await source.workspace.read(workItemId);
    if (currentWorkItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    return {
      ...this.toPortfolioItem(source, currentWorkItem),
      connected_run: summarizeConnectedRun(terminal),
    };
  }

  async decideConnectedPermission(
    sourceId: string,
    workItemId: string,
    input: ConnectedPermissionDecisionRequest,
  ): Promise<PortfolioConnectedPermissionResult> {
    const validatedInput = connectedPermissionDecisionRequestSchema.parse(input);
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const attention = workItem.state.attention;
    if (attention?.kind !== "missing_permission") {
      throw this.missionNotReady(
        workItemId,
        "A connected permission decision requires active missing-permission attention.",
      );
    }
    const phase = workItem.state.phase;
    if (phase !== "execute" && phase !== "patch") {
      throw this.missionNotReady(
        workItemId,
        "Connected permission decisions are valid only for Execute or Patch.",
      );
    }
    const governedTuple =
      phase === "execute"
        ? this.governedExecuteTuple(
            workItem,
            this.governedExecuteIdentity(source, workItem),
          )
        : this.governedPatchTuple(
            workItem,
            this.governedPatchIdentity(source, workItem),
          );
    const missionContentSha256 = attention.pins.mission_content_sha256;
    if (missionContentSha256 === undefined) {
      throw this.missionNotReady(
        workItemId,
        "Missing-permission attention does not pin its connected mission.",
      );
    }
    const decided = await this.workItemController(
      source.workspace,
    ).resolveConnectedPermission(workItemId, {
      decision: validatedInput.decision,
      expected_phase: phase,
      governed_tuple: governedTuple,
      connected_run_id: validatedInput.connected_run_id,
      operation_sha256: validatedInput.operation_sha256,
      mission_content_sha256: missionContentSha256,
    });
    await this.rebuild();
    return {
      ...this.toPortfolioItem(source, decided.work_item),
      controller_run: decided.manifest,
    };
  }

  async compileReviewMission(
    sourceId: string,
    workItemId: string,
    input: { independence_attested: true },
  ): Promise<ReviewMissionCompilation> {
    const validatedInput = compileReviewMissionInputSchema.parse(input);
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const identity = this.governedReviewIdentity(source, workItem);
    if (
      workItem.state.phase !== "review" ||
      workItem.state.status !== "active"
    ) {
      throw this.missionNotReady(
        workItemId,
        "Review mission compilation requires an assigned, governed item in active review.",
      );
    }

    const patchCycle = workItem.state.patch_cycle!;
    const applied =
      patchCycle === 0
        ? await source.workspace.readAppliedExecuteReviewSubject({
            ...identity,
            phase: "execute",
          })
        : await source.workspace.readAppliedPatchReviewSubject({
            ...identity,
            phase: "patch",
            patch_cycle: patchCycle,
          });
    const controllerRun = await source.workspace.readControllerRunManifest(
      workItemId,
      applied.evidence.controller_run_id,
    );
    if (
      controllerRun === null ||
      controllerRun.phase !== "review" ||
      controllerRun.outcome !== "applied" ||
      controllerRun.completed_at === undefined
    ) {
      throw this.missionNotReady(
        workItemId,
        "Applied result evidence is missing its review transition controller run.",
      );
    }
    const reviewRun = {
      schema_version: controllerRun.schema_version,
      run_id: controllerRun.run_id,
      work_item_id: controllerRun.work_item_id,
      idempotency_key: controllerRun.idempotency_key,
      phase: "review" as const,
      goal_version: controllerRun.goal_version,
      input_revision: controllerRun.input_revision,
      attempt: controllerRun.attempt,
      started_at: controllerRun.started_at,
      completed_at: controllerRun.completed_at,
      outcome: "applied" as const,
    };

    const reviewSubject = applied.review_subject;
    return source.workspace.writeReviewMissionPackage(
      identity,
      reviewSubject,
      (paths) =>
        reviewSubject.source === "execute"
          ? compileReviewMissionPackage({
              work_item: workItem,
              controller_run: reviewRun,
              review_subject: reviewSubject,
              paths,
              independence_attested: validatedInput.independence_attested,
            })
          : compileReviewMissionPackage({
              work_item: workItem,
              controller_run: reviewRun,
              review_subject: reviewSubject,
              paths,
              independence_attested: validatedInput.independence_attested,
            }),
    );
  }

  async compilePatchMission(
    sourceId: string,
    workItemId: string,
  ): Promise<PatchMissionCompilation> {
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const identity = this.governedPatchIdentity(source, workItem);
    if (
      workItem.state.phase !== "patch" ||
      workItem.state.status !== "active"
    ) {
      throw this.missionNotReady(
        workItemId,
        "Patch mission compilation requires an assigned, governed item in active patch.",
      );
    }

    const patchManifest = await source.workspace.findAppliedPatchManifest(
      identity,
    );
    if (patchManifest === null || patchManifest.completed_at === undefined) {
      throw this.missionNotReady(
        workItemId,
        "No applied patch-plan manifest matches the governed cycle and review result.",
      );
    }
    const appliedReview = await this.readAppliedReviewResult(
      source,
      workItem,
      identity.patch_cycle - 1,
      patchManifest.attempt,
    );
    const patchPlanIdempotencyKey = [
      deriveControllerIdempotencyKey(
        workItemId,
        "patch",
        identity.goal_version,
        identity.input_revision,
        patchManifest.attempt,
      ),
      `cycle-${identity.patch_cycle}`,
      "accept-plan",
      appliedReview.resultContentSha256,
    ].join(":");
    if (
      patchManifest.idempotency_key !== patchPlanIdempotencyKey
    ) {
      throw this.missionNotReady(
        workItemId,
        "No applied patch-plan manifest matches the governed cycle and review result.",
      );
    }
    const currentAttemptManifest =
      patchManifest.attempt === identity.attempt
        ? patchManifest
        : await source.workspace.findAppliedPatchAttemptManifest(identity);
    if (
      currentAttemptManifest === null ||
      currentAttemptManifest.completed_at === undefined
    ) {
      throw this.missionNotReady(
        workItemId,
        "No applied permission-recovery manifest matches the current Patch attempt.",
      );
    }
    if (appliedReview.result.verdict !== "findings") {
      throw this.missionNotReady(
        workItemId,
        "Patch mission compilation requires an applied review with findings.",
      );
    }
    const patchSubject = patchSubjectSchema.parse({
      review_mission_content_sha256:
        appliedReview.snapshot.mission.content_sha256,
      review_result_content_sha256: appliedReview.resultContentSha256,
      review_mission_path: appliedReview.snapshot.mission_path,
      review_result_path: appliedReview.snapshot.result_path,
      review_evidence_path: appliedReview.evidence.summary.evidence_path,
      reviewed_commit: appliedReview.result.accepted_result_commit,
      findings: [...appliedReview.result.findings].sort((left, right) =>
        left.finding_id.localeCompare(right.finding_id),
      ),
      prior_review_subject: appliedReview.snapshot.mission.review_subject,
    });
    const patchRun = {
      schema_version: currentAttemptManifest.schema_version,
      run_id: currentAttemptManifest.run_id,
      work_item_id: currentAttemptManifest.work_item_id,
      idempotency_key: currentAttemptManifest.idempotency_key,
      phase: "patch" as const,
      goal_version: currentAttemptManifest.goal_version,
      input_revision: currentAttemptManifest.input_revision,
      attempt: currentAttemptManifest.attempt,
      started_at: currentAttemptManifest.started_at,
      completed_at: currentAttemptManifest.completed_at,
      outcome: "applied" as const,
    };
    const capabilityAuthorization =
      currentAttemptManifest.capability_grant ??
      currentAttemptManifest.capability_carry_forward;
    if (capabilityAuthorization !== undefined) {
      if (identity.attempt < 1) {
        throw this.missionNotReady(
          workItemId,
          "An initial Patch attempt cannot carry permission-recovery authorization.",
        );
      }
      const prior = await source.workspace.readMissionPackage(
        { ...identity, attempt: identity.attempt - 1 },
        identity.patch_cycle,
      );
      if (
        prior.mission.identity.phase !== "patch" ||
        prior.mission.content_sha256 !==
          capabilityAuthorization.source_mission_content_sha256
      ) {
        throw this.missionNotReady(
          workItemId,
          "The Patch capability authorization does not bind the immediately prior mission.",
        );
      }
    }
    const executionDefaults =
      capabilityAuthorization?.execution_defaults ??
      (await source.workspace.readExecutionDefaults());

    return source.workspace.writePatchMissionPackage(
      identity,
      patchSubject,
      (paths) =>
        compilePatchMissionPackage(
          {
            work_item: workItem,
            controller_run: patchRun,
            patch_subject: patchSubject,
            paths,
          },
          executionDefaults,
        ),
    );
  }

  async listImportEvidence(
    sourceId: string,
    workItemId: string,
  ): Promise<StoredImportEvidence[]> {
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    return source.workspace.listImportEvidence(workItemId);
  }

  async importResult(
    sourceId: string,
    workItemId: string,
  ): Promise<PortfolioImportResult> {
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const identity = this.governedExecuteIdentity(source, workItem);
    const isActiveExecute =
      workItem.state.phase === "execute" && workItem.state.status === "active";
    if (!isActiveExecute) {
      const isImportOutcomeState =
        (workItem.state.phase === "review" &&
          workItem.state.status === "active") ||
        (workItem.state.phase === "execute" &&
          workItem.state.status === "blocked");
      if (!isImportOutcomeState) {
        throw this.missionNotReady(
          workItemId,
          "Result import requires an assigned, governed item in active execute.",
        );
      }
      const snapshot = await source.workspace.readMissionResult(identity);
      const resultContentSha256 = hashResultContent(snapshot.result_source);
      const importRunId = createImportRunId(
        snapshot.mission.content_sha256,
        resultContentSha256,
      );
      if (
        (await source.workspace.readImportEvidence(identity, importRunId)) ===
        null
      ) {
        throw this.missionNotReady(
          workItemId,
          "A blocked or review item only accepts an identical import replay.",
        );
      }
    }

    const controller = this.workItemController(source.workspace);
    const imported = await controller.importExternalResult(workItemId, {
      expected_phase: "execute",
      expected_status: "active",
      expected_schema_version: 2,
      expected_goal_version: identity.goal_version,
      expected_input_revision: identity.input_revision,
      attempt: identity.attempt,
    });
    await this.rebuild();
    return {
      source_id: source.source_id,
      project: source.project,
      work_item: imported.work_item,
      evidence: imported.evidence,
    };
  }

  async importReviewResult(
    sourceId: string,
    workItemId: string,
  ): Promise<PortfolioReviewImportResult> {
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const identity = this.governedReviewIdentity(source, workItem);
    if (
      workItem.state.phase !== "review" ||
      workItem.state.status !== "active"
    ) {
      throw this.missionNotReady(
        workItemId,
        "Review result import requires an assigned, governed item in active review.",
      );
    }

    const imported = await this.workItemController(
      source.workspace,
    ).importReviewResult(workItemId, {
      expected_phase: "review",
      expected_status: "active",
      expected_schema_version: 2,
      expected_goal_version: identity.goal_version,
      expected_input_revision: identity.input_revision,
      attempt: identity.attempt,
      expected_patch_cycle: workItem.state.patch_cycle!,
    });
    await this.rebuild();
    return {
      source_id: source.source_id,
      project: source.project,
      work_item: imported.work_item,
      evidence: imported.evidence,
      ...(imported.result === undefined ? {} : { result: imported.result }),
    };
  }

  async acceptPatchPlan(
    sourceId: string,
    workItemId: string,
  ): Promise<PortfolioPatchPlanResult> {
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const identity = this.governedReviewIdentity(source, workItem);
    const patchCycle = workItem.state.patch_cycle!;
    const expectedPatchCycle =
      workItem.state.phase === "patch" ? patchCycle - 1 : patchCycle;
    if (
      workItem.state.status !== "active" ||
      !["review", "patch"].includes(workItem.state.phase) ||
      expectedPatchCycle < 0
    ) {
      throw this.missionNotReady(
        workItemId,
        "Patch-plan approval requires an assigned, governed item in active review.",
      );
    }

    const accepted = await this.workItemController(
      source.workspace,
    ).acceptPatchPlan(workItemId, {
      expected_phase: "review",
      expected_status: "active",
      expected_schema_version: 2,
      expected_goal_version: identity.goal_version,
      expected_input_revision: identity.input_revision,
      attempt: identity.attempt,
      expected_patch_cycle: expectedPatchCycle,
    });
    await this.rebuild();
    return {
      source_id: source.source_id,
      project: source.project,
      work_item: accepted.work_item,
      controller_run: accepted.manifest,
    };
  }

  async importPatchResult(
    sourceId: string,
    workItemId: string,
  ): Promise<PortfolioPatchImportResult> {
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const identity = this.governedPatchIdentity(source, workItem);
    const isActivePatch =
      workItem.state.phase === "patch" && workItem.state.status === "active";
    if (!isActivePatch) {
      const isReplayState =
        workItem.state.phase === "review" &&
        workItem.state.status === "active";
      if (!isReplayState) {
        throw this.missionNotReady(
          workItemId,
          "Patch result import requires an assigned, governed item in active patch.",
        );
      }
      const snapshot = await source.workspace.readMissionResult(identity);
      const resultContentSha256 = hashResultContent(snapshot.result_source);
      const importRunId = createImportRunId(
        snapshot.mission.content_sha256,
        resultContentSha256,
      );
      if (
        (await source.workspace.readImportEvidence(identity, importRunId)) ===
        null
      ) {
        throw this.missionNotReady(
          workItemId,
          "An active review item only accepts an identical patch import replay.",
        );
      }
    }

    const imported = await this.workItemController(
      source.workspace,
    ).importPatchResult(workItemId, {
      expected_phase: "patch",
      expected_status: "active",
      expected_schema_version: 2,
      expected_goal_version: identity.goal_version,
      expected_input_revision: identity.input_revision,
      attempt: identity.attempt,
      expected_patch_cycle: identity.patch_cycle,
    });
    await this.rebuild();
    return {
      source_id: source.source_id,
      project: source.project,
      work_item: imported.work_item,
      evidence: imported.evidence,
      ...(imported.result === undefined ? {} : { result: imported.result }),
    };
  }

  async listAttention(): Promise<PortfolioNeedsYouEntry[]> {
    const governedItems: PortfolioAttentionItem[] = [];
    const shapingItems: Extract<
      PortfolioNeedsYouEntry,
      { kind: "shaping" }
    >[] = [];
    for (const project of await this.registry.read()) {
      const source: ResolvedSource = {
        source_id: project.workspace_id,
        project,
        workspace: this.makeWorkspace(project.workspace_path),
      };
      let workItems: WorkItem[];
      try {
        workItems = await source.workspace.list();
      } catch (error) {
        if (isExpectedWorkspaceFailure(error)) {
          continue;
        }
        throw error;
      }
      for (const workItem of workItems) {
        let shapingArtifactsPromise: Promise<ShapingAttentionArtifacts> | null =
          null;
        const readShapingArtifacts: ReadShapingAttentionArtifacts = () => {
          shapingArtifactsPromise ??= Promise.all([
            source.workspace.listShapingArtifacts(
              workItem.goal.work_item_id,
            ),
            source.workspace.listShapingRuns(workItem.goal.work_item_id),
          ]).then(([artifacts, runs]) => ({ artifacts, runs }));
          return shapingArtifactsPromise;
        };
        const attentionItem = await this.projectAttention(
          source,
          workItem,
          readShapingArtifacts,
        );
        if (attentionItem !== null) {
          governedItems.push(attentionItem);
          continue;
        }
        const shapingItem = await this.projectShapingAttention(
          source,
          workItem,
          readShapingArtifacts,
        );
        if (shapingItem !== null) {
          shapingItems.push(shapingItem);
        }
      }
    }

    governedItems.sort(
      (left, right) =>
        right.attention.created_at.localeCompare(left.attention.created_at) ||
        left.item.source_id.localeCompare(right.item.source_id) ||
        left.item.work_item.goal.work_item_id.localeCompare(
          right.item.work_item.goal.work_item_id,
        ),
    );
    shapingItems.sort(
      (left, right) =>
        left.item.source_id.localeCompare(right.item.source_id) ||
        left.item.work_item.goal.work_item_id.localeCompare(
          right.item.work_item.goal.work_item_id,
        ),
    );
    return z.array(portfolioNeedsYouEntrySchema).parse([
      ...governedItems.map(
        (entry): PortfolioNeedsYouEntry => ({ kind: "governed", entry }),
      ),
      ...shapingItems,
    ]);
  }

  async retryExecuteAttempt(
    sourceId: string,
    workItemId: string,
  ): Promise<PortfolioRetryResult> {
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const identity = this.governedExecuteIdentity(source, workItem);
    if (
      workItem.state.phase !== "execute" ||
      workItem.state.status !== "blocked"
    ) {
      throw this.missionNotReady(
        workItemId,
        "Repair requires an assigned, governed item in blocked execute.",
      );
    }
    const controller = this.workItemController(source.workspace);
    const retried = await controller.retryExecuteAttempt(workItemId, {
      expected_phase: "execute",
      expected_status: "blocked",
      expected_schema_version: 2,
      expected_goal_version: identity.goal_version,
      expected_input_revision: identity.input_revision,
      attempt: identity.attempt,
    });
    await this.rebuild();
    return {
      source_id: source.source_id,
      project: source.project,
      work_item: retried.work_item,
      controller_run: retried.manifest,
    };
  }

  async getScopeCorrectionProposal(
    sourceId: string,
    workItemId: string,
  ): Promise<PortfolioScopeCorrectionListing> {
    const source = await this.resolveSource(sourceId);
    if ((await source.workspace.read(workItemId)) === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    return {
      source_id: source.source_id,
      work_item_id: workItemId,
      proposal: await this.workItemController(
        source.workspace,
      ).proposeScopeCorrection(workItemId),
    };
  }

  async applyScopeCorrection(
    sourceId: string,
    workItemId: string,
    input: ApplyScopeCorrectionInput,
  ): Promise<PortfolioScopeCorrectionResult> {
    const source = await this.resolveSource(sourceId);
    if ((await source.workspace.read(workItemId)) === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const corrected = await this.workItemController(
      source.workspace,
    ).applyScopeCorrection(workItemId, input);
    await this.rebuild();
    return {
      source_id: source.source_id,
      project: source.project,
      work_item: corrected.work_item,
      controller_run: corrected.manifest,
      proposal: corrected.proposal,
    };
  }

  async getReviewImportDriftRecoveryProposal(
    sourceId: string,
    workItemId: string,
  ): Promise<PortfolioReviewImportDriftRecoveryListing> {
    const source = await this.resolveSource(sourceId);
    if ((await source.workspace.read(workItemId)) === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    return {
      source_id: source.source_id,
      work_item_id: workItemId,
      proposal: await this.workItemController(
        source.workspace,
      ).proposeReviewImportDriftRecovery(workItemId),
    };
  }

  async applyReviewImportDriftRecovery(
    sourceId: string,
    workItemId: string,
    input: ApplyReviewImportDriftRecoveryInput,
  ): Promise<PortfolioReviewImportDriftRecoveryResult> {
    const source = await this.resolveSource(sourceId);
    if ((await source.workspace.read(workItemId)) === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const recovered = await this.workItemController(
      source.workspace,
    ).applyReviewImportDriftRecovery(workItemId, input);
    await this.rebuild();
    return {
      source_id: source.source_id,
      project: source.project,
      work_item: recovered.work_item,
      controller_run: recovered.manifest,
      proposal: recovered.proposal,
      evidence: recovered.evidence,
      result: recovered.result,
    };
  }

  async prepareCommandAuthorization(
    sourceId: string,
    workItemId: string,
    phase: "execute" | "patch",
  ): Promise<PortfolioCommandAuthorizationResult> {
    const source = await this.resolveSource(sourceId);
    const current = await source.workspace.read(workItemId);
    if (current === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const controller = this.workItemController(source.workspace);
    const prepare = () =>
      controller.prepareCommandAuthorization(workItemId, phase);
    const prepared = await (async () => {
      try {
        return await prepare();
      } catch (error) {
        const missingFreshExecuteMission =
          phase === "execute" &&
          error instanceof InvalidWorkspaceError &&
          error.reason === "required directory is missing" &&
          error.artifactPath.startsWith(
            `.founder/missions/${workItemId}/execute-`,
          );
        if (!missingFreshExecuteMission) {
          throw error;
        }
        await this.compileMission(sourceId, workItemId);
        return prepare();
      }
    })();
    await this.rebuild();
    return {
      source_id: source.source_id,
      project: source.project,
      work_item: prepared.work_item,
      controller_run: prepared.manifest,
      proposal: prepared.proposal,
    };
  }

  async decideCommandAuthorization(
    sourceId: string,
    workItemId: string,
    input: CommandAuthorizationDecisionInput,
  ): Promise<PortfolioCommandAuthorizationResult> {
    const source = await this.resolveSource(sourceId);
    if ((await source.workspace.read(workItemId)) === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const decided = await this.workItemController(
      source.workspace,
    ).decideCommandAuthorization(workItemId, input);
    await this.rebuild();
    return {
      source_id: source.source_id,
      project: source.project,
      work_item: decided.work_item,
      controller_run: decided.manifest,
      proposal: decided.proposal,
    };
  }

  async recoverPendingTransfers(): Promise<void> {
    const records = await this.readTransferJournals();
    for (const record of records) {
      await this.recoverTransfer(record);
    }
  }

  async reconcileRunState(): Promise<void> {
    try {
      const inbox = await this.ensureInboxWorkspace();
      await inbox.reconcileConnectedRuns();
      await inbox.reconcileShapingRuns();
    } catch (error) {
      if (!isExpectedWorkspaceFailure(error)) {
        throw error;
      }
    }
    for (const workspace of await this.registry.read()) {
      try {
        const repository = this.makeWorkspace(workspace.workspace_path);
        await repository.readManifest();
        await repository.reconcileConnectedRuns();
        await repository.reconcileShapingRuns();
      } catch (error) {
        if (!isExpectedWorkspaceFailure(error)) {
          throw error;
        }
      }
    }
  }

  async rebuild(): Promise<PortfolioRebuildResult> {
    await this.recoverPendingTransfers();
    const workspaces = await this.registry.read();
    const items: PortfolioWorkItem[] = [];
    const connectedRunSummaries: PortfolioConnectedRunSummary[] = [];
    const failures: PortfolioRebuildResult["failures"] = [];
    const appendSourceItems = async (
      source: ResolvedSource,
      sourceItems: WorkItem[],
    ): Promise<void> => {
      const sourceSummaries = await Promise.all(
        sourceItems.map(async (work_item) => {
          const [latest] = [...(await source.workspace.listConnectedRuns(
            work_item.goal.work_item_id,
          ))].sort(
            (left, right) =>
              right.lifecycle.updated_at.localeCompare(left.lifecycle.updated_at) ||
              right.connected_run_id.localeCompare(left.connected_run_id),
          );
          return latest === undefined
            ? undefined
            : {
                source_id: source.source_id,
                work_item_id: work_item.goal.work_item_id,
                connected_run: summarizeConnectedRun(latest),
              };
        }),
      );
      items.push(
        ...sourceItems.map((work_item) => this.toPortfolioItem(source, work_item)),
      );
      connectedRunSummaries.push(
        ...sourceSummaries.filter(
          (summary): summary is PortfolioConnectedRunSummary =>
            summary !== undefined,
        ),
      );
    };

    try {
      const inbox = await this.ensureInboxWorkspace();
      const inboxItems = await inbox.list();
      await appendSourceItems(
        { source_id: INBOX_SOURCE_ID, project: null, workspace: inbox },
        inboxItems,
      );
    } catch (error) {
      if (!isExpectedWorkspaceFailure(error)) {
        throw error;
      }
      failures.push({
        source_id: INBOX_SOURCE_ID,
        project: null,
        reason: errorMessage(error),
      });
    }

    for (const workspace of workspaces) {
      try {
        const reader = this.makeWorkspace(workspace.workspace_path);
        await reader.readManifest();
        const workspaceItems = await reader.list();
        await appendSourceItems(
          {
            source_id: workspace.workspace_id,
            project: workspace,
            workspace: reader,
          },
          workspaceItems,
        );
      } catch (error) {
        if (!isExpectedWorkspaceFailure(error)) {
          throw error;
        }
        failures.push({
          source_id: workspace.workspace_id,
          project: workspace,
          reason: errorMessage(error),
        });
      }
    }

    this.index.rebuild(items, connectedRunSummaries);

    return { items: this.index.list(), failures };
  }

  private buildSavedGoal(
    current: WorkItem,
    input: SaveWorkItemInput,
    goalContract?: WorkItemGoal["goal_contract"],
  ): WorkItemGoal {
    return {
      schema_version: 2,
      work_item_id: current.goal.work_item_id,
      title: input.title,
      ...(input.type === null ? {} : { type: input.type }),
      ...(current.goal.capture === undefined
        ? {}
        : { capture: current.goal.capture }),
      ...(input.priority === null ? {} : { priority: input.priority }),
      ...(input.tags.length === 0 ? {} : { tags: input.tags }),
      ...(input.notes === null ? {} : { notes: input.notes }),
      ...(goalContract === undefined ? {} : { goal_contract: goalContract }),
    };
  }

  private buildUncontractedSave(
    current: WorkItem,
    input: SaveWorkItemInput,
  ): WorkItem {
    return workItemSchema.parse({
      goal: this.buildSavedGoal(current, input),
      state: current.state,
    });
  }

  private buildCrossSourceSave(
    current: WorkItem,
    input: SaveWorkItemInput,
  ): { work_item: WorkItem; manifest?: ControllerRunManifest } {
    const contractInput = input.goal_contract;
    if (contractInput === undefined) {
      return { work_item: this.buildUncontractedSave(current, input) };
    }

    const completedAt = nextTimestamp(current.state.updated_at);
    const runId = randomUUID();
    const idempotencyKey = deriveControllerIdempotencyKey(
      current.goal.work_item_id,
      current.state.phase,
      1,
      1,
      0,
    );
    const workItem = workItemSchema.parse({
      goal: this.buildSavedGoal(current, input, {
        schema_version: 1,
        goal_version: 1,
        purpose: contractInput.purpose,
        acceptance_criteria: contractInput.acceptance_criteria,
        non_goals: contractInput.non_goals,
        allowed_scope: contractInput.allowed_scope,
        review_ready: contractInput.review_ready,
      }),
      state: {
        ...current.state,
        goal_version: 1,
        input_revision: 1,
        attempt: 0,
        updated_at: completedAt,
      },
    });
    const manifest = controllerRunManifestSchema.parse({
      schema_version: 1,
      run_id: runId,
      work_item_id: current.goal.work_item_id,
      idempotency_key: idempotencyKey,
      phase: current.state.phase,
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
      started_at: completedAt,
      completed_at: completedAt,
      outcome: "applied",
    });

    return { work_item: workItem, manifest };
  }

  private async transferWorkItem(
    source: ResolvedSource,
    target: ResolvedSource,
    targetItem: WorkItem,
    operation:
      | { kind: "move" }
      | { kind: "save"; manifest?: ControllerRunManifest },
  ): Promise<PortfolioWorkItem> {
    const workItemId = targetItem.goal.work_item_id;
    if (await target.workspace.hasWorkItem(workItemId)) {
      throw new WorkItemTargetCollisionError(
        source.source_id,
        workItemId,
        target.source_id,
      );
    }

    const transferId = `tr_${randomUUID()}`;
    const targetSha256 = fingerprintWorkItem(targetItem);
    let stagingPath: string | null = null;
    let record: TransferJournalRecord | null = null;

    try {
      stagingPath = await target.workspace.stageIncomingWorkItem(
        targetItem,
        operation.kind === "save" ? operation.manifest : undefined,
      );
      record = transferJournalRecordSchema.parse(
        operation.kind === "move"
          ? {
              schema_version: 1,
              kind: "move",
              transfer_id: transferId,
              work_item_id: workItemId,
              from_source_id: source.source_id,
              from_path: source.workspace.workspaceRoot,
              to_source_id: target.source_id,
              to_path: stagingPath,
              stage: "staged",
            }
          : {
              schema_version: 1,
              kind: "save",
              transfer_id: transferId,
              work_item_id: workItemId,
              from_source_id: source.source_id,
              from_path: source.workspace.workspaceRoot,
              to_source_id: target.source_id,
              to_path: stagingPath,
              stage: "staged",
              target_sha256: targetSha256,
              ...(operation.manifest === undefined
                ? {}
                : { staged_manifest_run_id: operation.manifest.run_id }),
            },
      );
      await this.writeTransferJournal(record);

      await target.workspace.publishStagedWorkItem(workItemId, stagingPath);
      const published = await target.workspace.read(workItemId);
      if (published === null) {
        throw new WorkItemTransferFailedError(
          source.source_id,
          workItemId,
          target.source_id,
          "published target could not be read",
        );
      }
      await this.validatePublishedTransferTarget(
        record,
        target,
        published,
        targetItem,
      );
      record = { ...record, stage: "published" };
      await this.writeTransferJournal(record);

      await source.workspace.removeWorkItem(workItemId);
      if ((await source.workspace.read(workItemId)) !== null) {
        throw new WorkItemTransferFailedError(
          source.source_id,
          workItemId,
          target.source_id,
          "source work item still exists after removal",
        );
      }
      record = { ...record, stage: "source_removed" };
      await this.writeTransferJournal(record);
      await this.deleteTransferJournal(record.transfer_id);

      await this.rebuild();
      return this.toPortfolioItem(target, published);
    } catch (error) {
      let cleanupError: unknown;
      const targetCollision =
        error instanceof InvalidWorkspaceError &&
        error.reason === "target work-item already exists";
      try {
        const durableTarget = await target.workspace.read(workItemId);
        if (
          targetCollision ||
          durableTarget === null ||
          fingerprintWorkItem(durableTarget) !== targetSha256
        ) {
          if (stagingPath !== null) {
            await target.workspace.discardStagedWorkItem(
              workItemId,
              stagingPath,
            );
          }
          if (record !== null) {
            await this.deleteTransferJournal(record.transfer_id);
          }
        }
      } catch (candidateCleanupError) {
        cleanupError = candidateCleanupError;
      }

      if (cleanupError === undefined && targetCollision) {
        throw new WorkItemTargetCollisionError(
          source.source_id,
          workItemId,
          target.source_id,
        );
      }
      if (
        cleanupError === undefined &&
        (error instanceof WorkItemTargetCollisionError ||
          error instanceof WorkItemTransferFailedError)
      ) {
        throw error;
      }

      const reason =
        cleanupError === undefined
          ? errorMessage(error)
          : `${errorMessage(error)}; cleanup also failed: ${errorMessage(cleanupError)}`;
      throw new WorkItemTransferFailedError(
        source.source_id,
        workItemId,
        target.source_id,
        reason,
      );
    }
  }

  private async validatePublishedTransferTarget(
    record: TransferJournalRecord,
    target: ResolvedSource,
    targetItem: WorkItem,
    expectedItem?: WorkItem,
  ): Promise<void> {
    const expectedSha256 =
      record.kind === "save"
        ? record.target_sha256
        : expectedItem === undefined
          ? undefined
          : fingerprintWorkItem(expectedItem);
    if (
      expectedSha256 !== undefined &&
      fingerprintWorkItem(targetItem) !== expectedSha256
    ) {
      throw new WorkItemTransferFailedError(
        record.from_source_id,
        record.work_item_id,
        record.to_source_id,
        "published target does not match the staged work item",
      );
    }

    if (record.kind !== "save") {
      return;
    }
    if (record.staged_manifest_run_id === undefined) {
      if (targetItem.goal.goal_contract !== undefined) {
        throw new WorkItemTransferFailedError(
          record.from_source_id,
          record.work_item_id,
          record.to_source_id,
          "published target has a contract without a staged manifest reference",
        );
      }
      return;
    }

    const manifest = await target.workspace.readControllerRunManifest(
      record.work_item_id,
      record.staged_manifest_run_id,
    );
    if (
      manifest === null ||
      manifest.run_id !== record.staged_manifest_run_id ||
      !manifestMatchesWorkItem(manifest, targetItem)
    ) {
      throw new WorkItemTransferFailedError(
        record.from_source_id,
        record.work_item_id,
        record.to_source_id,
        "published target manifest is missing or does not match the saved work item",
      );
    }
  }

  private toPortfolioItem(
    source: ResolvedSource,
    workItem: WorkItem,
  ): PortfolioWorkItem {
    return {
      source_id: source.source_id,
      project: source.project,
      work_item: workItem,
    };
  }

  private async requireActiveShapingItem(
    sourceId: string,
    workItemId: string,
    phase?: ShapingPhase,
  ): Promise<{ source: ResolvedSource; workItem: WorkItem }> {
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const shapingPhase = isShapingPhase(workItem.state.phase);
    if (
      source.source_id === INBOX_SOURCE_ID ||
      workItem.state.status !== "active" ||
      !shapingPhase ||
      (phase !== undefined && workItem.state.phase !== phase)
    ) {
      throw this.missionNotReady(
        workItemId,
        phase === undefined
          ? "Shaping operations require an assigned item in active Brainstorm, Spec, or Plan."
          : `Shaping operations require an assigned item in active ${phase}.`,
      );
    }
    return { source, workItem };
  }

  private async requireReadableShapingItem(
    sourceId: string,
    workItemId: string,
  ): Promise<{ source: ResolvedSource; workItem: WorkItem }> {
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    if (
      source.source_id === INBOX_SOURCE_ID ||
      workItem.state.status !== "active" ||
      (workItem.state.phase !== "idea" &&
        !isShapingPhase(workItem.state.phase) &&
        workItem.state.phase !== "execute") ||
      (workItem.state.phase === "idea" &&
        (workItem.state.schema_version !== 2 ||
          workItem.goal.goal_contract !== undefined ||
          workItem.state.goal_version !== undefined ||
          workItem.state.input_revision !== undefined))
    ) {
      throw this.missionNotReady(
        workItemId,
        "Shaping reads require an assigned item in active Idea, Brainstorm, Spec, Plan, or Execute.",
      );
    }
    return { source, workItem };
  }

  private async requireDecisionSource(
    sourceId: string,
    workItemId: string,
  ): Promise<ResolvedSource> {
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    if (
      source.source_id === INBOX_SOURCE_ID ||
      workItem.state.status !== "active"
    ) {
      throw this.missionNotReady(
        workItemId,
        "Shaping decisions require an assigned, active work item.",
      );
    }
    return source;
  }

  private async currentShapingCompilation(
    source: ResolvedSource,
    workItem: WorkItem,
    phase: ShapingPhase,
  ): Promise<ShapingArtifactWriteResult> {
    const artifacts = await source.workspace.listShapingArtifacts(
      workItem.goal.work_item_id,
    );
    const artifact = this.requireCurrentShapingArtifact(
      workItem,
      phase,
      artifacts,
    );
    switch (phase) {
      case "brainstorm": {
        const mission = artifact.mission as BrainstormMissionPackage;
        return source.workspace.writeShapingMissionPackage(
          mission.identity,
          (paths) =>
            compileBrainstormMissionPackage({
              work_item_id: workItem.goal.work_item_id,
              shaping_input: mission.input,
              paths,
            }),
        );
      }
      case "spec": {
        const mission = artifact.mission as SpecMissionPackage;
        return source.workspace.writeShapingMissionPackage(
          mission.identity,
          (paths) =>
            compileSpecMissionPackage({
              work_item_id: workItem.goal.work_item_id,
              shaping_input: mission.input,
              paths,
            }),
        );
      }
      case "plan": {
        const mission = artifact.mission as PlanMissionPackage;
        return source.workspace.writeShapingMissionPackage(
          mission.identity,
          (paths) =>
            compilePlanMissionPackage({
              work_item_id: workItem.goal.work_item_id,
              shaping_input: mission.input,
              paths,
            }),
        );
      }
    }
  }

  private async importShapingResult(
    source: ResolvedSource,
    workItem: WorkItem,
    phase: ShapingPhase,
    input: ShapingManualImportBinding,
  ): Promise<ShapingImportResult> {
    const artifacts = await source.workspace.listShapingArtifacts(
      workItem.goal.work_item_id,
    );
    const runs = await source.workspace.listShapingRuns(
      workItem.goal.work_item_id,
    );
    const artifact = this.requireCurrentShapingArtifact(
      workItem,
      phase,
      artifacts,
      input.expected_mission_content_sha256,
    );
    this.assertExpectedShapingState(
      workItem,
      artifacts,
      runs,
      input.expected_shaping_state_sha256,
    );
    if (artifact.result !== null && artifact.import_receipt?.outcome === "applied") {
      return {
        source_id: source.source_id,
        work_item_id: workItem.goal.work_item_id,
        outcome: "applied",
        receipt: artifact.import_receipt,
        result: this.parseAppliedShapingResult(
          artifact,
          workItem.goal.work_item_id,
          phase,
        ),
      };
    }

    const instruction = await source.workspace.writeShapingIngressInstruction({
      origin: "manual_import",
      shaping_run_id: null,
      mission: artifact.mission,
    });
    const bytes = await source.workspace.readShapingIngressBytes(
      instruction.instruction,
    );
    const parsed = this.parseManualShapingBytes(bytes, artifact.mission);
    if (parsed.result === null) {
      return {
        source_id: source.source_id,
        work_item_id: workItem.goal.work_item_id,
        outcome: "rejected",
        rejection: parsed.rejection,
      };
    }
    const published = await source.workspace.publishAppliedShapingResult(
      instruction.instruction,
      artifact.mission,
      { origin: "manual_import", shaping_run_id: null },
    );
    const result = this.parseShapingResultSource(
      published.result_source,
      artifact.mission,
      workItem.goal.work_item_id,
    );
    return {
      source_id: source.source_id,
      work_item_id: workItem.goal.work_item_id,
      outcome: "applied",
      receipt: published.import_receipt,
      result,
    };
  }

  private parseManualShapingBytes(
    bytes: Buffer,
    mission: ShapingMissionPackage,
  ):
    | { result: ShapingResultSubmission; rejection: null }
    | { result: null; rejection: ShapingRejectedImportEvidence } {
    const reject = (
      reasons: ShapingValidationReason[],
    ): { result: null; rejection: ShapingRejectedImportEvidence } => ({
      result: null,
      rejection: {
        raw_result_sha256: createHash("sha256").update(bytes).digest("hex"),
        byte_length: bytes.byteLength,
        reasons: reasons.slice(0, 20),
      },
    });
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return reject([{ code: "invalid_utf8", field_path: "$" }]);
    }
    let value: unknown;
    try {
      value = JSON.parse(source) as unknown;
    } catch {
      return reject([{ code: "invalid_json", field_path: "$" }]);
    }
    const missing =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? mission.result_contract.required_fields
            .filter((field) => !(field in value))
            .map(
              (field): ShapingValidationReason => ({
                code: "missing_required_field",
                field_path: field,
              }),
            )
        : [];
    const schema = this.shapingResultSchema(mission.identity.phase);
    const validated = schema.safeParse(value);
    if (!validated.success) {
      const missingPaths = new Set(missing.map(({ field_path }) => field_path));
      const schemaReasons = validated.error.issues
        .map(
          ({ path }): ShapingValidationReason => ({
            code: "schema_violation",
            field_path: path.length === 0 ? "$" : path.map(String).join("."),
          }),
        )
        .filter(({ field_path }) => !missingPaths.has(field_path));
      return reject([...missing, ...schemaReasons]);
    }
    const result = validated.data;
    const reasons: ShapingValidationReason[] = [];
    if (JSON.stringify(result.identity) !== JSON.stringify(mission.identity)) {
      reasons.push({ code: "mission_hash_mismatch", field_path: "identity" });
    }
    const missionHashField = this.missionHashField(mission.identity.phase);
    if (this.resultMissionContentSha256(result) !== mission.content_sha256) {
      reasons.push({
        code: "mission_hash_mismatch",
        field_path: missionHashField,
      });
    }
    return reasons.length === 0
      ? { result, rejection: null }
      : reject(reasons);
  }

  private parseAppliedShapingResult(
    artifact: StoredShapingArtifact,
    workItemId: string,
    phase: ShapingPhase,
  ): ShapingResultSubmission {
    if (artifact.result === null) {
      throw this.missionNotReady(
        workItemId,
        "Applied shaping evidence is missing result.json.",
      );
    }
    if (artifact.mission.identity.phase !== phase) {
      throw this.missionNotReady(
        workItemId,
        "Applied shaping evidence does not match its requested phase.",
      );
    }
    return this.parseShapingResultSource(
      artifact.result.result_source,
      artifact.mission,
      workItemId,
    );
  }

  private parseShapingResultSource(
    source: string,
    mission: ShapingMissionPackage,
    workItemId: string,
  ): ShapingResultSubmission {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(source) as unknown;
    } catch {
      throw this.missionNotReady(
        workItemId,
        "Applied shaping result is not valid JSON.",
      );
    }
    const parsed = this.shapingResultSchema(
      mission.identity.phase,
    ).safeParse(parsedJson);
    if (!parsed.success) {
      throw this.missionNotReady(
        workItemId,
        "Applied shaping result no longer satisfies its structural contract.",
      );
    }
    if (
      JSON.stringify(parsed.data.identity) !== JSON.stringify(mission.identity) ||
      this.resultMissionContentSha256(parsed.data) !== mission.content_sha256
    ) {
      throw this.missionNotReady(
        workItemId,
        "Applied shaping result no longer matches its immutable mission.",
      );
    }
    return parsed.data;
  }

  private shapingResultSchema(phase: ShapingPhase) {
    switch (phase) {
      case "brainstorm":
        return brainstormResultSubmissionSchema;
      case "spec":
        return specResultSubmissionSchema;
      case "plan":
        return planResultSubmissionSchema;
    }
  }

  private missionHashField(
    phase: ShapingPhase,
  ):
    | "brainstorm_mission_content_sha256"
    | "spec_mission_content_sha256"
    | "plan_mission_content_sha256" {
    switch (phase) {
      case "brainstorm":
        return "brainstorm_mission_content_sha256";
      case "spec":
        return "spec_mission_content_sha256";
      case "plan":
        return "plan_mission_content_sha256";
    }
  }

  private resultMissionContentSha256(
    result: ShapingResultSubmission,
  ): string {
    if ("brainstorm_mission_content_sha256" in result) {
      return result.brainstorm_mission_content_sha256;
    }
    if ("spec_mission_content_sha256" in result) {
      return result.spec_mission_content_sha256;
    }
    return result.plan_mission_content_sha256;
  }

  private async portfolioItemShapingSummary(
    source: ResolvedSource,
    workItem: WorkItem,
  ): Promise<PortfolioItemShapingSummary> {
    const phase = workItem.state.phase;
    if (!isShapingPhase(phase)) {
      throw new Error(`Expected a shaping phase, received ${phase}.`);
    }
    const repairSummary = (): PortfolioItemShapingSummary => ({
      phase,
      tip_mission_content_sha256: null,
      has_applied_result: false,
      decision_kind: null,
      latest_run_status: "needs_repair",
    });

    try {
      const [artifacts, runs] = await Promise.all([
        source.workspace.listShapingArtifacts(workItem.goal.work_item_id),
        source.workspace.listShapingRuns(workItem.goal.work_item_id),
      ]);
      const tip = this.resolveShapingTip(
        workItem.goal.work_item_id,
        phase,
        artifacts,
      );
      this.shapingDecisionState(workItem, artifacts, runs);
      if (tip === null) {
        return {
          phase,
          tip_mission_content_sha256: null,
          has_applied_result: false,
          decision_kind: null,
          latest_run_status: null,
        };
      }

      const hasAppliedResult =
        tip.result !== null &&
        tip.import_receipt?.outcome === "applied" &&
        tip.production_receipt !== null &&
        tip.applied_marker !== null;
      const latestRun = runs
        .filter(
          (run) =>
            run.mission.phase === phase &&
            run.mission.input_sha256 === tip.mission.identity.input_sha256 &&
            run.mission.content_sha256 === tip.mission.content_sha256,
        )
        .sort(
          (left, right) =>
            left.lifecycle.started_at.localeCompare(
              right.lifecycle.started_at,
            ) || left.shaping_run_id.localeCompare(right.shaping_run_id),
        )
        .at(-1);
      let latestRunStatus: PortfolioItemShapingRunStatus | null = null;
      if (tip.result !== null && !hasAppliedResult) {
        latestRunStatus = "needs_repair";
      } else if (
        hasAppliedResult &&
        latestRun !== undefined &&
        latestRun.lifecycle.status !== "terminal"
      ) {
        latestRunStatus = "finishing";
      } else if (hasAppliedResult) {
        latestRunStatus = "ready";
      } else if (latestRun?.lifecycle.status === "starting") {
        latestRunStatus = "starting";
      } else if (latestRun?.lifecycle.status === "running") {
        latestRunStatus = "running";
      } else if (latestRun?.lifecycle.status === "terminal") {
        switch (latestRun.lifecycle.terminal?.outcome ?? null) {
          case "missing_permission":
            latestRunStatus = "blocked";
            break;
          case "completed":
            latestRunStatus = "missing_result";
            break;
          case "failed":
            latestRunStatus = "failed";
            break;
          case "cancelled":
            latestRunStatus = "cancelled";
            break;
          case "timed_out":
            latestRunStatus = "timed_out";
            break;
          case "interrupted":
            latestRunStatus = "interrupted";
            break;
          case null:
            latestRunStatus = "needs_repair";
            break;
        }
      }

      return {
        phase,
        tip_mission_content_sha256: tip.mission.content_sha256,
        has_applied_result: hasAppliedResult,
        decision_kind:
          tip.decision === null
            ? null
            : "selected_at" in tip.decision.receipt
              ? "brainstorm_selection"
              : "spec_approval",
        latest_run_status: latestRunStatus,
      };
    } catch (error) {
      if (
        error instanceof ControllerConflictError &&
        error.kind === "repair_required"
      ) {
        return repairSummary();
      }
      throw error;
    }
  }

  private requireCurrentShapingArtifact(
    workItem: WorkItem,
    phase: ShapingPhase,
    artifacts: StoredShapingArtifact[],
    expectedMissionContentSha256?: string,
  ): StoredShapingArtifact {
    const artifact = this.resolveShapingTip(
      workItem.goal.work_item_id,
      phase,
      artifacts,
    );
    const goalInput = normalizeShapingGoalInput(workItem.goal);
    if (
      artifact === null ||
      artifact.mission.input.title !== goalInput.title ||
      artifact.mission.input.notes !== goalInput.notes ||
      (expectedMissionContentSha256 !== undefined &&
        artifact.mission.content_sha256 !== expectedMissionContentSha256)
    ) {
      throw this.missionNotReady(
        workItem.goal.work_item_id,
        `No current ${phase} shaping mission matches the durable work item and requested binding.`,
      );
    }
    return artifact;
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
        throw new ControllerConflictError(
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
        throw new ControllerConflictError(
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
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        `Shaping phase ${phase} must have exactly one revision tip; found ${tips.length}.`,
      );
    }
    return tips[0]!;
  }

  private shapingDecisionState(
    workItem: WorkItem,
    artifacts: StoredShapingArtifact[],
    runs: ShapingRunRecordV1[],
  ): ShapingDecisionState {
    const phase = workItem.state.phase;
    const tip = isShapingPhase(phase)
      ? this.resolveShapingTip(
          workItem.goal.work_item_id,
          phase,
          artifacts,
        )
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
      throw new ControllerConflictError(
        "repair_required",
        workItem.goal.work_item_id,
        "Shaping state has an ambiguous non-terminal run.",
      );
    }
    return {
      work_item_id: workItem.goal.work_item_id,
      phase,
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

  private assertExpectedShapingState(
    workItem: WorkItem,
    artifacts: StoredShapingArtifact[],
    runs: ShapingRunRecordV1[],
    expectedSha256: string,
  ): void {
    if (
      hashShapingDecisionState(
        this.shapingDecisionState(workItem, artifacts, runs),
      ) !== expectedSha256
    ) {
      throw new ControllerConflictError(
        "stale_expectation",
        workItem.goal.work_item_id,
        "Expected shaping state does not match the durable work item and artifact tip.",
      );
    }
  }

  private renderManualRecoveryTask(
    mission: ShapingMissionPackage,
    instruction: ShapingIngressInstructionV1,
  ): string {
    return `${renderShapingTaskMd(mission)}
## Manual recovery

- Published task: \`${instruction.task_path}\`
- Write the result to: \`${instruction.ingress_path}\`
- Result schema version: \`${instruction.result_schema_version}\`
- Maximum result bytes: \`${instruction.max_result_bytes}\`
- Mission content SHA-256 to echo: \`${instruction.mission_content_sha256}\`

Required fields:
${instruction.required_fields.map((field) => `- \`${field}\``).join("\n")}
`;
  }

  private preflightDecisionLaunch(
    workItemId: string,
    input: {
      launch_mode: "connected" | "manual";
      next_requested_model: string | null;
    },
  ): void {
    if (input.launch_mode === "manual") {
      return;
    }
    if (input.next_requested_model === null) {
      throw this.missionNotReady(
        workItemId,
        "Connected shaping launch requires one requested model.",
      );
    }
    this.assertShapingModelAvailable(workItemId, input.next_requested_model);
  }

  private preflightExecuteLaunch(
    workItemId: string,
    input: Pick<ApprovePlanResultInput, "launch_mode" | "requested_model">,
  ): void {
    if (input.launch_mode === "manual") {
      return;
    }
    if (input.requested_model === null) {
      throw this.missionNotReady(
        workItemId,
        "Connected Execute launch requires one requested model.",
      );
    }
    this.assertExecuteModelAvailable(workItemId, input.requested_model);
  }

  private shapingModelAvailability(): ShapingModelAvailability {
    if (this.shapingRuntime === undefined) {
      return {
        status: "unavailable",
        adapter_id: null,
        adapter_version: null,
        profile_id: null,
        available_model_ids: [],
        distinct_model_count: 0,
        has_three_distinct_models: false,
        reason: "runtime_unavailable",
      };
    }
    let configuration: ShapingRuntimeConfiguration;
    try {
      configuration = shapingRuntimeConfigurationSchema.parse(
        this.shapingRuntime.configuration(),
      );
    } catch {
      return {
        status: "unavailable",
        adapter_id: null,
        adapter_version: null,
        profile_id: null,
        available_model_ids: [],
        distinct_model_count: 0,
        has_three_distinct_models: false,
        reason: "runtime_configuration_invalid",
      };
    }
    const availableModelIds = [
      ...new Set(configuration.available_model_ids),
    ];
    return {
      status: availableModelIds.length === 0 ? "unavailable" : "available",
      adapter_id: configuration.adapter_id,
      adapter_version: configuration.adapter_version,
      profile_id: configuration.profile_id,
      available_model_ids: availableModelIds,
      distinct_model_count: availableModelIds.length,
      has_three_distinct_models: availableModelIds.length >= 3,
      reason: availableModelIds.length === 0 ? "no_models_configured" : null,
    };
  }

  private assertShapingModelAvailable(
    workItemId: string,
    requestedModel: string,
  ): void {
    const validatedModel = shapingRequestedModelSchema.parse(requestedModel);
    const availability = this.shapingModelAvailability();
    if (
      availability.status !== "available" ||
      !availability.available_model_ids.includes(validatedModel)
    ) {
      throw this.missionNotReady(
        workItemId,
        availability.status === "unavailable"
          ? "Connected shaping is not configured with any available model."
          : `Requested shaping model ${validatedModel} is not in available_model_ids.`,
      );
    }
  }

  private executeModelAvailability(): ShapingModelAvailability {
    return this.connectedModelAvailability(this.writableRuntime);
  }

  private reviewModelAvailability(): ShapingModelAvailability {
    return this.connectedModelAvailability(this.reviewRuntime);
  }

  private patchModelAvailability(): ShapingModelAvailability {
    return this.connectedModelAvailability(this.writableRuntime);
  }

  private connectedModelAvailability(
    runtime: ConnectedWritableRuntime | ConnectedReviewRuntime | undefined,
  ): ShapingModelAvailability {
    if (runtime === undefined) {
      return {
        status: "unavailable",
        adapter_id: null,
        adapter_version: null,
        profile_id: null,
        available_model_ids: [],
        distinct_model_count: 0,
        has_three_distinct_models: false,
        reason: "runtime_unavailable",
      };
    }
    let configuration: ConnectedRuntimeConfiguration;
    try {
      configuration = connectedRuntimeConfigurationSchema.parse(
        runtime.configuration(),
      );
    } catch {
      return {
        status: "unavailable",
        adapter_id: null,
        adapter_version: null,
        profile_id: null,
        available_model_ids: [],
        distinct_model_count: 0,
        has_three_distinct_models: false,
        reason: "runtime_configuration_invalid",
      };
    }
    const availableModelIds = [
      ...new Set(configuration.available_model_ids),
    ];
    return {
      status: availableModelIds.length === 0 ? "unavailable" : "available",
      adapter_id: configuration.adapter_id,
      adapter_version: configuration.adapter_version,
      profile_id: configuration.profile_id,
      available_model_ids: availableModelIds,
      distinct_model_count: availableModelIds.length,
      has_three_distinct_models: availableModelIds.length >= 3,
      reason: availableModelIds.length === 0 ? "no_models_configured" : null,
    };
  }

  private assertExecuteModelAvailable(
    workItemId: string,
    requestedModel: string,
  ): void {
    const validatedModel = shapingRequestedModelSchema.parse(requestedModel);
    const availability = this.executeModelAvailability();
    if (
      availability.status !== "available" ||
      !availability.available_model_ids.includes(validatedModel)
    ) {
      throw this.missionNotReady(
        workItemId,
        availability.status === "unavailable"
          ? "Connected Execute is not configured with any available model."
          : `Requested Execute model ${validatedModel} is not in available_model_ids.`,
      );
    }
  }

  private assertReviewModelAvailable(
    workItemId: string,
    requestedModel: string,
  ): void {
    const validatedModel = shapingRequestedModelSchema.parse(requestedModel);
    const availability = this.reviewModelAvailability();
    if (
      availability.status !== "available" ||
      !availability.available_model_ids.includes(validatedModel)
    ) {
      throw this.missionNotReady(
        workItemId,
        availability.status === "unavailable"
          ? "Connected Review is not configured with any available model."
          : `Requested Review model ${validatedModel} is not in available_model_ids.`,
      );
    }
  }

  private assertPatchModelAvailable(
    workItemId: string,
    requestedModel: string,
  ): void {
    const validatedModel = shapingRequestedModelSchema.parse(requestedModel);
    const availability = this.patchModelAvailability();
    if (
      availability.status !== "available" ||
      !availability.available_model_ids.includes(validatedModel)
    ) {
      throw this.missionNotReady(
        workItemId,
        availability.status === "unavailable"
          ? "Connected Patch is not configured with any available model."
          : `Requested Patch model ${validatedModel} is not in available_model_ids.`,
      );
    }
  }

  private async launchPreparedShapingMission(
    source: ResolvedSource,
    missionInput: ShapingMissionPackage,
    requestedModelInput: string,
    expectedLaunchFingerprint?: string,
  ): Promise<ShapingRunCreateResult> {
    const mission = shapingMissionPackageSchema.parse(missionInput);
    const workItemId = mission.identity.work_item_id;
    const requestedModel = shapingRequestedModelSchema.parse(
      requestedModelInput,
    );
    const launchFingerprint = shapingRunLaunchFingerprint(
      mission.content_sha256,
      requestedModel,
    );
    if (
      expectedLaunchFingerprint !== undefined &&
      launchFingerprint !== expectedLaunchFingerprint
    ) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        "The stored shaping launch fingerprint does not match its mission and model.",
      );
    }

    const runs = await source.workspace.listShapingRuns(workItemId);
    const nonTerminalRuns = runs.filter(
      (run) => run.lifecycle.status !== "terminal",
    );
    const matching = nonTerminalRuns.find(
      (run) => this.shapingRunFingerprint(run) === launchFingerprint,
    );
    if (matching !== undefined) {
      return {
        record: matching,
        instruction: await source.workspace.readShapingRunInstruction(
          workItemId,
          matching.shaping_run_id,
        ),
        created: false,
      };
    }
    if (nonTerminalRuns.length > 0) {
      throw new ControllerConflictError(
        "lease_held",
        workItemId,
        `Shaping run ${nonTerminalRuns[0]!.shaping_run_id} is already active for this work item.`,
      );
    }
    const artifact = (
      await source.workspace.listShapingArtifacts(workItemId)
    ).find(
      (candidate) =>
        candidate.mission.content_sha256 === mission.content_sha256,
    );
    if (artifact === undefined) {
      throw this.missionNotReady(
        workItemId,
        "The requested shaping mission is not durable.",
      );
    }
    if (artifact.result !== null) {
      throw this.missionNotReady(
        workItemId,
        "This shaping mission revision already has an applied result.",
      );
    }

    this.assertShapingModelAvailable(workItemId, requestedModel);
    const runtime = this.shapingRuntime!;
    const prepared = await runtime.prepare({
      workspace_cwd: source.workspace.workspaceRoot,
      mission,
      requested_model: requestedModel,
      limits: SHAPING_RUN_LIMITS,
    });
    const configuration = shapingRuntimeConfigurationSchema.parse(
      runtime.configuration(),
    );
    if (
      prepared.requested_model !== requestedModel ||
      prepared.sanitized_profile.requested_model !== requestedModel ||
      prepared.sanitized_profile.adapter_id !== configuration.adapter_id ||
      prepared.sanitized_profile.adapter_version !==
        configuration.adapter_version ||
      prepared.sanitized_profile.profile_id !== configuration.profile_id
    ) {
      throw this.missionNotReady(
        workItemId,
        "Prepared shaping runtime provenance does not match the validated launch request.",
      );
    }
    this.assertShapingModelAvailable(workItemId, requestedModel);

    const timestamp = new Date().toISOString();
    const record: Omit<ShapingRunRecordV1, "write_policy"> = {
      schema_version: 1,
      shaping_run_id: randomUUID(),
      mission: {
        phase: mission.identity.phase,
        work_item_id: workItemId,
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
        effort: {
          value: prepared.reasoning_effort,
          assurance: "user_declared",
        },
        harness: {
          value: {
            id: prepared.sanitized_profile.adapter_id,
            version: prepared.sanitized_profile.adapter_version,
          },
          assurance: "adapter_attested",
        },
        adapter_profile: {
          value: {
            adapter_id: prepared.sanitized_profile.adapter_id,
            adapter_version: prepared.sanitized_profile.adapter_version,
            profile_id: prepared.sanitized_profile.profile_id,
          },
          assurance: "adapter_attested",
        },
        resolved_profile_sha256: {
          value: this.hashConnectedValue(prepared.sanitized_profile),
          assurance: "controller_observed",
        },
        resolved_skill_set_sha256: { value: null, assurance: "unknown" },
      },
      lifecycle: {
        status: "starting",
        started_at: timestamp,
        updated_at: timestamp,
        completed_at: null,
        terminal: null,
      },
      limits: SHAPING_RUN_LIMITS,
      process: null,
      diagnostics: { entries: [], truncated: false },
    };
    const launched = await source.workspace.createShapingRun({
      record,
      mission,
    });
    if (
      this.shapingRunFingerprint(launched.record) !== launchFingerprint
    ) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        "The created shaping run does not match its validated launch fingerprint.",
      );
    }
    await this.preferencesStore.setPreference({
      adapter_id: configuration.adapter_id,
      seat: mission.identity.phase,
      requested_model: requestedModel,
    });
    if (!launched.created) {
      return launched;
    }

    try {
      const instruction = await source.workspace.readShapingRunInstruction(
        workItemId,
        launched.record.shaping_run_id,
      );
      const eventSink: AcpEventSink = {
        append: (event, signal) =>
          source.workspace.appendShapingRunEvent(
            workItemId,
            launched.record.shaping_run_id,
            event,
            signal,
          ),
      };
      const key = this.shapingSessionKey(
        source.source_id,
        workItemId,
        launched.record.shaping_run_id,
      );
      const started = await startConnectedAcpRun({
        start_session: (callbacks) =>
          prepared.start(
            instruction,
            launched.record.write_policy,
            eventSink,
            (request, signal) =>
              source.workspace
                .writeShapingAcpTextFile(
                  instruction,
                  request.path,
                  request.content,
                  signal,
                )
                .then(() => undefined),
            callbacks,
          ),
        mark_running: (session) =>
          source.workspace.startShapingRun(
            workItemId,
            launched.record.shaping_run_id,
            session.process,
          ),
        persist_effective_model: (effectiveModel, signal) =>
          source.workspace
            .updateShapingRunEffectiveModel(
              workItemId,
              launched.record.shaping_run_id,
              effectiveModel,
              signal,
            )
            .then(() => undefined),
        prompt: composeConnectedShapingPrompt(instruction),
        complete: (result) =>
          source.workspace.completeShapingRun(
            workItemId,
            launched.record.shaping_run_id,
            this.shapingTerminalFromResult(result),
          ),
        fail: async () => {
          await this.failObservedShapingRun(
            source,
            workItemId,
            launched.record.shaping_run_id,
          );
          await this.rebuild().catch(() => undefined);
        },
        started: (handle) => {
          this.liveShapingSessions.set(key, handle);
        },
        after_complete: async () => {
          await this.rebuild();
        },
        settled: async (session) => {
          if (this.liveShapingSessions.get(key)?.session === session) {
            this.liveShapingSessions.delete(key);
          }
        },
      });
      void started.completion;
      return {
        record: started.running,
        instruction,
        created: true,
      };
    } catch {
      const failed = await this.failObservedShapingRun(
        source,
        workItemId,
        launched.record.shaping_run_id,
      );
      await this.rebuild().catch(() => undefined);
      if (failed === null) {
        throw new ControllerConflictError(
          "repair_required",
          workItemId,
          "The durable shaping run disappeared after launch.",
        );
      }
      return {
        record: failed,
        instruction: launched.instruction,
        created: true,
      };
    }
  }

  private async failObservedShapingRun(
    source: ResolvedSource,
    workItemId: string,
    shapingRunId: string,
  ): Promise<ShapingRunRecordV1 | null> {
    const current = await source.workspace
      .readShapingRun(workItemId, shapingRunId)
      .catch(() => null);
    if (current?.lifecycle.status === "terminal") {
      return current;
    }
    await source.workspace.reconcileShapingRuns().catch(() => []);
    const reconciled = await source.workspace
      .readShapingRun(workItemId, shapingRunId)
      .catch(() => null);
    if (reconciled?.lifecycle.status === "terminal") {
      return reconciled;
    }
    return source.workspace
      .completeShapingRun(
        workItemId,
        shapingRunId,
        this.failedShapingTerminal(),
      )
      .catch(() => null);
  }

  private shapingRunFingerprint(run: ShapingRunRecordV1): string {
    const requestedModel = run.provenance.requested_model.value;
    if (requestedModel === null) {
      throw new ControllerConflictError(
        "repair_required",
        run.mission.work_item_id,
        `Shaping run ${run.shaping_run_id} is missing its requested model.`,
      );
    }
    return shapingRunLaunchFingerprint(
      run.mission.content_sha256,
      requestedModel,
    );
  }

  private async finishShapingDecision(
    source: ResolvedSource,
    decided: ShapingDecisionControllerResult,
  ): Promise<PortfolioShapingDecisionResult> {
    let nextLaunch: ShapingNextLaunch;
    if (decided.launch_mode === "manual") {
      const mission = shapingMissionPackageSchema.parse(
        JSON.parse(decided.intent.next_mission_package_bytes) as unknown,
      );
      await source.workspace.writeShapingIngressInstruction({
        origin: "manual_import",
        shaping_run_id: null,
        mission,
      });
      nextLaunch = {
        status: "manual",
        shaping_run_id: null,
        reason:
          this.shapingModelAvailability().status === "unavailable"
            ? "runtime_unavailable"
            : "founder_selected_manual",
      };
    } else {
      try {
        const mission = shapingMissionPackageSchema.parse(
          JSON.parse(decided.intent.next_mission_package_bytes) as unknown,
        );
        const launched = await this.launchPreparedShapingMission(
          source,
          mission,
          decided.intent.next_requested_model!,
          decided.intent.launch_fingerprint!,
        );
        nextLaunch = this.shapingNextLaunch(launched);
      } catch (error) {
        nextLaunch = {
          status: "failed",
          shaping_run_id: null,
          reason: errorMessage(error).slice(0, 500),
        };
      }
    }
    await this.rebuild();
    return {
      ...this.toPortfolioItem(source, decided.work_item),
      decision_id: decided.decision_id,
      next_mission: decided.next_mission,
      next_launch: nextLaunch,
    };
  }

  private portfolioShapingLaunchResult(
    source: ResolvedSource,
    workItemId: string,
    launched: ShapingRunCreateResult,
  ): PortfolioShapingLaunchResult {
    return {
      source_id: source.source_id,
      work_item_id: workItemId,
      next_launch: this.shapingNextLaunch(launched),
      shaping_run: summarizeShapingRun(launched.record),
    };
  }

  private planApprovalResult(
    source: ResolvedSource,
    approved: PlanApprovalControllerResult,
    result: Pick<
      PortfolioPlanApprovalResult,
      "mission" | "connected_run" | "next_launch"
    >,
  ): PortfolioPlanApprovalResult {
    return {
      ...this.toPortfolioItem(source, approved.work_item),
      approval_id: approved.approval_id,
      launch_mode: approved.launch_mode,
      requested_model: approved.requested_model,
      execute_tuple: approved.execute_tuple,
      ...result,
    };
  }

  private shapingNextLaunch(
    launched: ShapingRunCreateResult,
  ): ShapingNextLaunch {
    const terminal = launched.record.lifecycle.terminal;
    return terminal === null
      ? {
          status: "launched",
          shaping_run_id: launched.record.shaping_run_id,
          reason: null,
          created: launched.created,
        }
      : {
          status: "failed",
          shaping_run_id: launched.record.shaping_run_id,
          reason: terminal.reason,
          created: launched.created,
        };
  }

  private assertCommittedShapingIntentState(
    workItem: WorkItem,
    intent: ShapingDecisionIntentV1,
  ): void {
    const goalBytes = stringify(workItem.goal);
    const stateBytes = `${JSON.stringify(workItem.state, null, 2)}\n`;
    const goalSha256 = createHash("sha256").update(goalBytes).digest("hex");
    const stateSha256 = createHash("sha256").update(stateBytes).digest("hex");
    if (
      goalBytes !== intent.next_goal_bytes ||
      stateBytes !== intent.next_state_bytes ||
      goalSha256 !== intent.next_goal_sha256 ||
      stateSha256 !== intent.next_state_sha256
    ) {
      throw new ControllerConflictError(
        "repair_required",
        workItem.goal.work_item_id,
        "Durable goal/state do not equal the applied shaping decision intent.",
      );
    }
  }

  private async currentPostCommitLaunchFailure(
    source: ResolvedSource,
    workItem: WorkItem,
    artifacts: StoredShapingArtifact[],
    runs: ShapingRunRecordV1[],
  ): Promise<ShapingPostCommitLaunchFailure | null> {
    const phase = workItem.state.phase;
    if (workItem.state.status !== "active" || !isShapingPhase(phase)) {
      return null;
    }
    const tip = this.resolveShapingTip(
      workItem.goal.work_item_id,
      phase,
      artifacts,
    );
    if (tip === null || tip.result !== null) {
      return null;
    }
    const hasRunForCurrentRevision = runs.some(
      (run) =>
        run.mission.phase === phase &&
        run.mission.input_sha256 === tip.mission.identity.input_sha256 &&
        run.mission.content_sha256 === tip.mission.content_sha256,
    );
    if (hasRunForCurrentRevision) {
      return null;
    }

    const candidates: ShapingDecisionIntentV1[] = [];
    const manifests =
      await source.workspace.listShapingDecisionManifests(
        workItem.goal.work_item_id,
      );
    for (const manifest of manifests) {
      if (manifest.phase_to !== phase) {
        continue;
      }
      const intent = await source.workspace.readShapingDecisionIntent(
        workItem.goal.work_item_id,
        manifest.decision_id,
      );
      if (intent === null) {
        throw new ControllerConflictError(
          "repair_required",
          workItem.goal.work_item_id,
          `Applied shaping decision ${manifest.decision_id} has no durable intent.`,
        );
      }
      let intendedState: WorkItem["state"];
      try {
        intendedState = workItemStateSchema.parse(
          JSON.parse(intent.next_state_bytes) as unknown,
        );
      } catch {
        throw new ControllerConflictError(
          "repair_required",
          workItem.goal.work_item_id,
          `Applied shaping decision ${manifest.decision_id} has an invalid intended state.`,
        );
      }
      const manifestGoalVersion =
        intent.operation === "approve_spec"
          ? intent.plan_goal_version
          : null;
      const manifestInputRevision =
        intent.operation === "approve_spec"
          ? intendedState.input_revision ?? null
          : null;
      if (
        manifest.decision_id !== intent.decision_id ||
        manifest.work_item_id !== intent.work_item_id ||
        manifest.operation !== intent.operation ||
        manifest.phase_from !== intent.phase_from ||
        manifest.phase_to !== intent.phase_to ||
        manifest.mission_content_sha256 !== intent.mission_content_sha256 ||
        manifest.result_content_sha256 !== intent.result_content_sha256 ||
        manifest.feedback_sha256 !== intent.feedback_sha256 ||
        manifest.expected_shaping_state_sha256 !==
          intent.expected_shaping_state_sha256 ||
        manifest.next_mission_content_sha256 !==
          intent.next_mission_content_sha256 ||
        manifest.goal_sha256 !== intent.next_goal_sha256 ||
        manifest.state_sha256 !== intent.next_state_sha256 ||
        manifest.goal_version !== manifestGoalVersion ||
        manifest.input_revision !== manifestInputRevision
      ) {
        throw new ControllerConflictError(
          "repair_required",
          workItem.goal.work_item_id,
          `Shaping decision ${manifest.decision_id} disagrees with its durable intent.`,
        );
      }
      const matchesCurrentTip =
        intent.next_mission_input_sha256 ===
          tip.mission.identity.input_sha256 &&
        intent.next_mission_content_sha256 === tip.mission.content_sha256;
      if (matchesCurrentTip && manifest.outcome !== "applied") {
        throw new ControllerConflictError(
          "repair_required",
          workItem.goal.work_item_id,
          `Shaping decision ${manifest.decision_id} is ${manifest.outcome}; replay the leased decision before launching its mission.`,
        );
      }
      if (
        manifest.outcome === "applied" &&
        intent.launch_mode === "connected" &&
        matchesCurrentTip
      ) {
        candidates.push(intent);
      }
    }
    if (candidates.length > 1) {
      throw new ControllerConflictError(
        "repair_required",
        workItem.goal.work_item_id,
        `Current ${phase} revision has multiple applied launch intents.`,
      );
    }
    const intent = candidates[0];
    if (intent === undefined) {
      return null;
    }
    this.assertCommittedShapingIntentState(workItem, intent);
    if (
      intent.next_requested_model === null ||
      intent.launch_fingerprint === null
    ) {
      throw new ControllerConflictError(
        "repair_required",
        workItem.goal.work_item_id,
        `Connected shaping decision ${intent.decision_id} has no locked launch binding.`,
      );
    }
    return {
      decision_id: intent.decision_id,
      locked_model: intent.next_requested_model,
      reason: "The committed shaping decision has no matching shaping run.",
    };
  }

  private workflowModelUse(
    workItemId: string,
    artifacts: StoredShapingArtifact[],
    runs: ShapingRunRecordV1[],
    connectedRuns: ConnectedRunRecordV2[],
  ): WorkflowModelUse[] {
    const productions = SHAPING_PHASES.flatMap(
      (seat) => {
        const tip = this.resolveShapingTip(workItemId, seat, artifacts);
        return tip?.production_receipt === null ||
          tip?.production_receipt === undefined
          ? []
          : [{ seat, receipt: tip.production_receipt }];
      },
    );
    return summarizeWorkflowModelUse(runs, productions, connectedRuns);
  }

  private isPlanDecisionEligible(
    workItem: WorkItem,
    artifacts: StoredShapingArtifact[],
    runs: ShapingRunRecordV1[],
  ): boolean {
    if (
      workItem.state.schema_version !== 2 ||
      workItem.state.phase !== "plan" ||
      workItem.state.status !== "active" ||
      workItem.state.attempt !== 0 ||
      workItem.goal.goal_contract === undefined ||
      workItem.state.goal_version === undefined ||
      workItem.state.input_revision === undefined ||
      workItem.goal.goal_contract.goal_version !== workItem.state.goal_version
    ) {
      return false;
    }
    const tip = this.resolveShapingTip(
      workItem.goal.work_item_id,
      "plan",
      artifacts,
    );
    if (
      tip === null ||
      tip.result === null ||
      tip.import_receipt?.outcome !== "applied" ||
      tip.production_receipt === null ||
      tip.applied_marker === null ||
      tip.decision !== null ||
      tip.mission.input.phase !== "plan" ||
      tip.mission.input.goal_version !== workItem.state.goal_version ||
      tip.mission.input.goal_contract_sha256 !==
        hashGoalContract(workItem.goal.goal_contract)
    ) {
      return false;
    }
    return runs.every((run) => run.lifecycle.status === "terminal");
  }

  private async modelPickerOptions(
    shapingAvailability: ShapingModelAvailability,
    executeAvailability: ShapingModelAvailability,
    modelUse: WorkflowModelUse[],
    executeEligible: boolean,
  ): Promise<Record<WorkflowModelSeat, ShapingModelPickerOption[]>> {
    const seats = WORKFLOW_MODEL_SEATS;
    const options = await Promise.all(
      seats.map(async (seat, seatIndex) => {
        const availability =
          seat === "execute" ? executeAvailability : shapingAvailability;
        if (
          (seat === "execute" && !executeEligible) ||
          availability.status === "unavailable" ||
          availability.adapter_id === null
        ) {
          return [seat, []] as const;
        }
        const saved = await this.preferencesStore.getPreference(
          availability.adapter_id,
          seat,
        );
        const priorUses = modelUse.filter(
          (use) => seats.indexOf(use.seat) < seatIndex,
        );
        return [
          seat,
          shapingModelPickerOptions(
            availability.available_model_ids,
            priorUses,
            saved,
          ),
        ] as const;
      }),
    );
    return Object.fromEntries(options) as Record<
      WorkflowModelSeat,
      ShapingModelPickerOption[]
    >;
  }

  private async readAppliedReviewResult(
    source: ResolvedSource,
    workItem: WorkItem,
    reviewPatchCycle: number,
    reviewAttempt?: number,
  ) {
    const currentIdentity = this.governedReviewIdentity(source, workItem);
    const identity = {
      ...currentIdentity,
      attempt: reviewAttempt ?? currentIdentity.attempt,
    };
    const snapshot = await source.workspace.readMissionResult(
      identity,
      reviewPatchCycle === 0 ? undefined : reviewPatchCycle,
    );
    if (
      snapshot.mission.mission_schema_version !== MISSION_SCHEMA_VERSION ||
      !("review_subject" in snapshot.mission)
    ) {
      throw this.missionNotReady(
        workItem.goal.work_item_id,
        "Applied review evidence must bind an active review mission.",
      );
    }
    const reviewMission = snapshot.mission;
    const reviewSnapshot = { ...snapshot, mission: reviewMission };

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(snapshot.result_source);
    } catch {
      throw this.missionNotReady(
        workItem.goal.work_item_id,
        "Applied review result is not valid JSON.",
      );
    }
    const resultParse = reviewExternalResultSubmissionForSubjectSchema(
      reviewMission.review_subject,
    ).safeParse(parsedJson);
    if (!resultParse.success) {
      throw this.missionNotReady(
        workItem.goal.work_item_id,
        "Applied review result no longer satisfies its pinned subject contract.",
      );
    }
    const result = resultParse.data;
    const resultContentSha256 = hashResultContent(snapshot.result_source);
    const importRunId = createImportRunId(
      snapshot.mission.content_sha256,
      resultContentSha256,
    );
    const evidence = await source.workspace.readImportEvidence(
      identity,
      importRunId,
    );
    if (
      evidence === null ||
      evidence.evidence.phase !== "review" ||
      evidence.evidence.outcome !== "applied" ||
      evidence.evidence.mission_content_sha256 !==
        reviewMission.content_sha256 ||
      evidence.evidence.result_content_sha256 !== resultContentSha256 ||
      evidence.evidence.git_base_commit !==
        reviewMission.review_subject.git_base_commit ||
      evidence.evidence.result_commit !== result.accepted_result_commit ||
      JSON.stringify(evidence.evidence.identity) !== JSON.stringify(identity)
    ) {
      throw this.missionNotReady(
        workItem.goal.work_item_id,
        "Applied review mission, result, and evidence do not match.",
      );
    }
    const controllerRun = await source.workspace.readControllerRunManifest(
      workItem.goal.work_item_id,
      evidence.evidence.controller_run_id,
    );
    if (
      controllerRun === null ||
      controllerRun.phase !== "review" ||
      controllerRun.outcome !== "applied" ||
      controllerRun.goal_version !== identity.goal_version ||
      controllerRun.input_revision !== identity.input_revision ||
      controllerRun.attempt !== identity.attempt
    ) {
      throw this.missionNotReady(
        workItem.goal.work_item_id,
        "Applied review evidence is missing its matching controller run.",
      );
    }

    return {
      snapshot: reviewSnapshot,
      result,
      resultContentSha256,
      evidence,
    };
  }

  private async projectAttention(
    source: ResolvedSource,
    workItem: WorkItem,
    readShapingArtifacts: ReadShapingAttentionArtifacts,
  ): Promise<PortfolioAttentionItem | null> {
    const contract = workItem.goal.goal_contract;
    const state = workItem.state;
    if (
      contract === undefined ||
      state.status !== "active" ||
      state.goal_version === undefined ||
      state.input_revision === undefined ||
      state.attempt === undefined ||
      state.patch_cycle === undefined
    ) {
      return null;
    }

    const attention =
      state.attention ??
      (await this.phaseApprovalAttention(
        workItem,
        readShapingArtifacts,
      ));
    if (attention === null) {
      return null;
    }
    const acceptanceCriteria: PortfolioAttentionItem["acceptance_criteria"] =
      contract.acceptance_criteria.map(
      (criterion) => ({
        criterion,
        status: "unknown" as const,
      }),
      );
    let verification: PortfolioAttentionItem["verification"] = {
      status: "unknown",
      commands: [],
    };
    let findings: ReviewFinding[] = [];
    let elapsedMs: number | undefined;

    if (state.attention !== undefined && state.phase === "review") {
      const appliedReview = await this.readAppliedReviewResult(
        source,
        workItem,
        state.patch_cycle,
      );
      const expectedArtifactPaths = [
        appliedReview.snapshot.mission_path,
        appliedReview.snapshot.result_path,
      ];
      if (
        JSON.stringify(attention.pins.artifact_paths) !==
          JSON.stringify(expectedArtifactPaths) ||
        JSON.stringify(attention.pins.evidence_paths) !==
          JSON.stringify([appliedReview.evidence.summary.evidence_path]) ||
        attention.pins.git_commit !==
          appliedReview.result.accepted_result_commit ||
        attention.pins.mission_content_sha256 !==
          appliedReview.snapshot.mission.content_sha256 ||
        attention.pins.result_content_sha256 !==
          appliedReview.resultContentSha256
      ) {
        throw new ControllerConflictError(
          "repair_required",
          workItem.goal.work_item_id,
          "Current attention does not match its pinned review evidence.",
        );
      }
      verification = {
        status: "passed",
        commands:
          appliedReview.snapshot.mission.review_subject.command_evidence.map(
            (record) => ({ name: record.name, status: "passed" as const }),
          ),
      };
      findings = appliedReview.result.findings;
      const needsAttention = new Set(
        findings.flatMap((finding) =>
          finding.link.type === "acceptance_criteria"
            ? [finding.link.criterion]
            : [],
        ),
      );
      for (const criterion of acceptanceCriteria) {
        criterion.status =
          appliedReview.result.verdict === "clean"
            ? "reviewed"
            : needsAttention.has(criterion.criterion)
              ? "needs_attention"
              : "unknown";
      }
      elapsedMs = Math.max(
        0,
        Date.parse(appliedReview.evidence.evidence.completed_at) -
          Date.parse(appliedReview.evidence.evidence.started_at),
      );
    }

    return portfolioAttentionItemSchema.parse({
      item: this.toPortfolioItem(source, workItem),
      attention,
      acceptance_criteria: acceptanceCriteria,
      verification,
      findings,
      patch_cycle_limit: 3,
      ...(elapsedMs === undefined ? {} : { elapsed_ms: elapsedMs }),
      cost_capacity: "unknown",
    });
  }

  private async projectShapingAttention(
    source: ResolvedSource,
    workItem: WorkItem,
    readShapingArtifacts: ReadShapingAttentionArtifacts,
  ): Promise<Extract<PortfolioNeedsYouEntry, { kind: "shaping" }> | null> {
    if (
      source.source_id === INBOX_SOURCE_ID ||
      workItem.state.status !== "active" ||
      workItem.state.phase !== "spec"
    ) {
      return null;
    }

    try {
      const { artifacts, runs } = await readShapingArtifacts();
      const tip = this.resolveShapingTip(
        workItem.goal.work_item_id,
        "spec",
        artifacts,
      );
      const shapingState = this.shapingDecisionState(
        workItem,
        artifacts,
        runs,
      );
      if (
        tip === null ||
        tip.result === null ||
        tip.import_receipt?.outcome !== "applied" ||
        tip.production_receipt === null ||
        tip.applied_marker === null ||
        tip.decision !== null ||
        shapingState.active_shaping_run_id !== null
      ) {
        return null;
      }
      const shapingAttention = shapingAttentionV1Schema.parse({
        schema_version: 1,
        kind: "spec_approval_shaping",
        work_item_id: workItem.goal.work_item_id,
        source_id: source.source_id,
        phase: "spec",
        question: "A Spec result is ready for your approval.",
        recommendation: "Open the item and use Approve & run Plan.",
        binding: {
          mission_content_sha256: tip.mission.content_sha256,
          applied_result_content_sha256: tip.result.result_content_sha256,
          shaping_state_sha256: hashShapingDecisionState(shapingState),
        },
        pins: {
          artifact_paths: [
            posix.dirname(tip.mission_path),
            posix.dirname(tip.result.result_path),
          ],
        },
        created_at: tip.applied_marker.committed_at,
      });
      return {
        kind: "shaping",
        item: this.toPortfolioItem(source, workItem),
        shaping_attention: shapingAttention,
      };
    } catch (error) {
      if (
        error instanceof ControllerConflictError &&
        error.kind === "repair_required"
      ) {
        return null;
      }
      throw error;
    }
  }

  private async phaseApprovalAttention(
    workItem: WorkItem,
    readShapingArtifacts: ReadShapingAttentionArtifacts,
  ): Promise<WorkItemAttention | null> {
    const state = workItem.state;
    if (state.phase !== "spec") {
      return null;
    }
    let tip: StoredShapingArtifact | null;
    let runs: ShapingRunRecordV1[];
    let artifacts: StoredShapingArtifact[];
    let shapingState: ShapingDecisionState;
    try {
      const snapshot = await readShapingArtifacts();
      runs = snapshot.runs;
      artifacts = snapshot.artifacts;
      tip = this.resolveShapingTip(
        workItem.goal.work_item_id,
        "spec",
        artifacts,
      );
      shapingState = this.shapingDecisionState(
        workItem,
        artifacts,
        runs,
      );
    } catch (error) {
      if (
        error instanceof ControllerConflictError &&
        error.kind === "repair_required"
      ) {
        return null;
      }
      throw error;
    }
    if (
      tip === null ||
      tip.result === null ||
      tip.import_receipt?.outcome !== "applied" ||
      tip.production_receipt === null ||
      tip.applied_marker === null ||
      tip.decision !== null ||
      shapingState.active_shaping_run_id !== null
    ) {
      return null;
    }
    const tuple = {
      goal_version: state.goal_version!,
      input_revision: state.input_revision!,
      attempt: state.attempt!,
      patch_cycle: state.patch_cycle!,
    };
    const artifactPaths = [
      tip.mission_path,
      tip.result.result_path,
    ] as [string, ...string[]];
    return workItemAttentionSchema.parse({
      kind: "spec_approval",
      question: "Does the current goal contract authorize planning this work?",
      recommendation: "Open the item and use Approve & run Plan.",
      created_at: tip.applied_marker.committed_at,
      governed_tuple: tuple,
      pins: { artifact_paths: artifactPaths, evidence_paths: [] },
    });
  }

  private resolveConnectedCapabilityEnvelope(
    workItemId: string,
    compiled: CapabilityEnvelopeV1,
    narrowed: CapabilityEnvelopeV1 | undefined,
  ): CapabilityEnvelopeV1 {
    if (narrowed === undefined) {
      return compiled;
    }
    if (!isCapabilityEnvelopeNarrowing(narrowed, compiled)) {
      throw this.missionNotReady(
        workItemId,
        "A connected capability envelope may only narrow the compiled mission envelope.",
      );
    }
    return narrowed;
  }

  private connectedRunRecord(
    mission: MissionCompilation | PatchMissionCompilation,
    governedTuple: ConnectedRunRecordV2["governed_tuple"],
    capabilityEnvelope: CapabilityEnvelopeV1,
    prepared: PreparedConnectedRuntime,
  ): ConnectedRunRecordV2 {
    const profileSha256 = this.hashConnectedValue(prepared.sanitized_profile);
    const authorizationSha256 = this.hashConnectedValue({
      mission_content_sha256: mission.mission.content_sha256,
      capability_envelope_sha256: hashResolvedCapabilityEnvelope(capabilityEnvelope),
      requested_model: prepared.requested_model,
    });
    const timestamp = new Date().toISOString();
    const envelopeSha256 = hashResolvedCapabilityEnvelope(capabilityEnvelope);
    return {
      schema_version: 2,
      connected_run_id: randomUUID(),
      mission: {
        identity: mission.mission.identity,
        path: mission.mission_path.slice(
          mission.workspace_path.length + 1,
        ),
        content_sha256: mission.mission.content_sha256,
        source_commit: mission.mission.source_revision.git_base_commit,
      },
      governed_tuple: governedTuple,
      provenance: {
        role: { value: "writer", assurance: "controller_observed" },
        seat: { value: "executor", assurance: "controller_observed" },
        requested_model: {
          value: prepared.requested_model,
          assurance: "user_declared",
        },
        effective_model: {
          assurance: "unknown",
          model_id: null,
          deployment_id: null,
          observed_event_sha256: null,
        },
        effort: {
          value: prepared.reasoning_effort,
          assurance: "user_declared",
        },
        harness: {
          value: {
            id: prepared.sanitized_profile.adapter_id,
            version: prepared.sanitized_profile.adapter_version,
          },
          assurance: "adapter_attested",
        },
        adapter_profile: {
          value: {
            adapter_id: prepared.sanitized_profile.adapter_id,
            adapter_version: prepared.sanitized_profile.adapter_version,
            profile_id: prepared.sanitized_profile.profile_id,
          },
          assurance: "adapter_attested",
        },
        resolved_profile_sha256: {
          value: profileSha256,
          assurance: "controller_observed",
        },
        resolved_skill_set_sha256: { value: null, assurance: "unknown" },
        authorization_sha256: {
          value: authorizationSha256,
          assurance: "controller_observed",
        },
      },
      authorization: {
        kind: "capability_envelope",
        envelope: capabilityEnvelope,
        envelope_sha256: envelopeSha256,
      },
      acp: {
        protocol_version: { value: null, assurance: "unknown" },
        session_id: { value: null, assurance: "unknown" },
      },
      lifecycle: {
        status: "starting",
        started_at: timestamp,
        updated_at: timestamp,
        completed_at: null,
        terminal: null,
      },
      limits: CONNECTED_RUN_LIMITS,
      process: null,
      diagnostics: { entries: [], truncated: false },
    };
  }

  private connectedReviewPolicy(
    mission: ReviewMissionCompilation,
  ): ReviewRunPolicy {
    const resultPath = mission.mission.result_contract.output_path;
    return {
      kind: "single_result_file",
      result_path: resultPath,
      mission_result_binding_sha256:
        deriveReviewMissionResultBindingSha256(
          mission.mission.content_sha256,
          resultPath,
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
  }

  private canonicalConnectedReviewOutput(
    workItemId: string,
    mission: ReviewMissionPackage,
    output: string,
  ): string {
    const outputBytes = Buffer.byteLength(output, "utf8");
    if (
      outputBytes === 0 ||
      outputBytes > CONNECTED_RUN_LIMITS.max_output_bytes
    ) {
      throw this.missionNotReady(
        workItemId,
        `Connected Review response must contain 1-${CONNECTED_RUN_LIMITS.max_output_bytes} bytes.`,
      );
    }
    const parsed = this.parseUniqueJsonObject(output);
    if (parsed === null) {
      throw this.missionNotReady(
        workItemId,
        "Connected Review response must contain exactly one JSON object.",
      );
    }
    const result = reviewExternalResultSubmissionForSubjectSchema(
      mission.review_subject,
    ).safeParse(parsed);
    if (
      !result.success ||
      result.data.review_mission_content_sha256 !== mission.content_sha256 ||
      JSON.stringify(result.data.identity) !== JSON.stringify(mission.identity)
    ) {
      throw this.missionNotReady(
        workItemId,
        "Connected Review response does not match its immutable mission contract.",
      );
    }
    return serializeExternalResult(result.data);
  }

  private parseUniqueJsonObject(output: string): unknown | null {
    try {
      const parsed: unknown = JSON.parse(output);
      return this.isJsonObject(parsed) ? parsed : null;
    } catch {
      // Connected models may wrap an otherwise valid object in prose or a Markdown fence.
    }

    const parsedObjects: unknown[] = [];
    let objectStart = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = 0; index < output.length; index += 1) {
      const character = output[index]!;
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{") {
        if (depth === 0) {
          objectStart = index;
        }
        depth += 1;
        continue;
      }
      if (character !== "}" || depth === 0) {
        continue;
      }
      depth -= 1;
      if (depth !== 0 || objectStart < 0) {
        continue;
      }
      try {
        const candidate: unknown = JSON.parse(
          output.slice(objectStart, index + 1),
        );
        if (this.isJsonObject(candidate)) {
          parsedObjects.push(candidate);
        }
      } catch {
        // Ignore balanced prose fragments that are not JSON objects.
      }
      objectStart = -1;
    }

    return parsedObjects.length === 1 ? parsedObjects[0]! : null;
  }

  private isJsonObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private connectedReviewRunRecord(
    mission: ReviewMissionCompilation,
    governedTuple: ConnectedRunRecordV2["governed_tuple"],
    policy: ReviewRunPolicy,
    prepared: PreparedConnectedReviewRuntime,
  ): ConnectedRunRecordV2 {
    const policySha256 = hashReviewRunPolicy(policy);
    const authorizationSha256 = this.hashConnectedValue({
      mission_content_sha256: mission.mission.content_sha256,
      result_path: policy.result_path,
      policy_sha256: policySha256,
      requested_model: prepared.requested_model,
    });
    const timestamp = new Date().toISOString();
    return {
      schema_version: 2,
      connected_run_id: randomUUID(),
      mission: {
        identity: mission.mission.identity,
        path: mission.mission_path.slice(mission.workspace_path.length + 1),
        content_sha256: mission.mission.content_sha256,
        source_commit: mission.mission.source_revision.git_base_commit,
      },
      governed_tuple: governedTuple,
      provenance: {
        role: { value: "reviewer", assurance: "controller_observed" },
        seat: { value: "reviewer", assurance: "controller_observed" },
        requested_model: {
          value: prepared.requested_model,
          assurance: "user_declared",
        },
        effective_model: {
          assurance: "unknown",
          model_id: null,
          deployment_id: null,
          observed_event_sha256: null,
        },
        effort: {
          value: prepared.reasoning_effort,
          assurance: "user_declared",
        },
        harness: {
          value: {
            id: prepared.sanitized_profile.adapter_id,
            version: prepared.sanitized_profile.adapter_version,
          },
          assurance: "adapter_attested",
        },
        adapter_profile: {
          value: {
            adapter_id: prepared.sanitized_profile.adapter_id,
            adapter_version: prepared.sanitized_profile.adapter_version,
            profile_id: prepared.sanitized_profile.profile_id,
          },
          assurance: "adapter_attested",
        },
        resolved_profile_sha256: {
          value: this.hashConnectedValue(prepared.sanitized_profile),
          assurance: "controller_observed",
        },
        resolved_skill_set_sha256: { value: null, assurance: "unknown" },
        authorization_sha256: {
          value: authorizationSha256,
          assurance: "controller_observed",
        },
      },
      authorization: {
        kind: "review_result_ingress",
        result_path: policy.result_path,
        policy_sha256: policySha256,
      },
      acp: {
        protocol_version: { value: null, assurance: "unknown" },
        session_id: { value: null, assurance: "unknown" },
      },
      lifecycle: {
        status: "starting",
        started_at: timestamp,
        updated_at: timestamp,
        completed_at: null,
        terminal: null,
      },
      limits: CONNECTED_RUN_LIMITS,
      process: null,
      diagnostics: { entries: [], truncated: false },
    };
  }

  private async launchPreparedConnectedRun(
    input: PreparedConnectedLaunch,
  ): Promise<PortfolioConnectedRunResult> {
    const launched = await input.controller.launchConnectedRun(
      input.work_item_id,
      input.launch_input,
      input.record,
    );
    if (input.preference !== undefined) {
      await this.preferencesStore.setPreference(input.preference);
    }
    if (!launched.created) {
      return {
        ...this.toPortfolioItem(input.source, launched.work_item),
        connected_run: summarizeConnectedRun(launched.connected_run),
      };
    }

    const connectedRunId = launched.connected_run.connected_run_id;
    const eventSink: AcpEventSink = {
      append: (event, signal) =>
        input.source.workspace.appendConnectedRunEvent(
          input.work_item_id,
          connectedRunId,
          event,
          signal,
        ),
    };
    const key = this.connectedSessionKey(
      input.source.source_id,
      input.work_item_id,
      connectedRunId,
    );
    const started = await startConnectedAcpRun({
      start_session: (callbacks) =>
        input.start_session(eventSink, callbacks, connectedRunId),
      mark_running: (session) =>
        input.source.workspace.startConnectedRun(
          input.work_item_id,
          connectedRunId,
          {
            protocol_version: {
              value: session.protocol_version,
              assurance: "adapter_attested",
            },
            session_id: {
              value: session.session_id,
              assurance: "adapter_attested",
            },
          },
          session.process,
        ),
      persist_effective_model: (effectiveModel, signal) =>
        input.source.workspace
          .updateConnectedRunEffectiveModel(
            input.work_item_id,
            connectedRunId,
            effectiveModel,
            signal,
          )
          .then(() => undefined),
      prompt: input.prompt,
      before_complete: async (result) => {
        await input.before_complete?.(result, connectedRunId);
      },
      complete: (result) =>
        this.completeObservedConnectedRun(
          input.source,
          input.work_item_id,
          connectedRunId,
          result,
        ),
      fail: async (error) => {
        await input.source.workspace
          .completeConnectedRun(
            input.work_item_id,
            connectedRunId,
            input.failure_terminal?.(error) ??
              this.failedConnectedTerminal(),
          )
          .catch(() => undefined);
        await this.rebuild().catch(() => undefined);
      },
      started: (handle) => {
        this.liveConnectedSessions.set(key, handle);
      },
      after_complete: (result, terminal) =>
        input.after_complete(result, terminal, launched.connected_run),
      settled: async (session) => {
        if (this.liveConnectedSessions.get(key)?.session === session) {
          this.liveConnectedSessions.delete(key);
        }
      },
    });
    void started.completion;
    await this.rebuild();
    return {
      ...this.toPortfolioItem(input.source, launched.work_item),
      connected_run: summarizeConnectedRun(started.running),
    };
  }

  private async completeObservedConnectedRun(
    source: ResolvedSource,
    workItemId: string,
    connectedRunId: string,
    result: AcpRunResult,
  ): Promise<ConnectedRunRecordV2> {
    const terminal = this.connectedTerminalFromResult(result);
    try {
      return await source.workspace.completeConnectedRun(
        workItemId,
        connectedRunId,
        terminal,
      );
    } catch (error) {
      const current = await source.workspace.readConnectedRun(
        workItemId,
        connectedRunId,
      );
      if (current?.lifecycle.status === "terminal") {
        return current;
      }
      throw error;
    }
  }

  private async recordMissingPermission(
    source: ResolvedSource,
    workItemId: string,
    mission: MissionCompilation | PatchMissionCompilation,
    record: ConnectedRunRecordV2,
    result: AcpRunResult,
  ): Promise<void> {
    const missing = result.permissions.find(
      (permission) => permission.kind === "missing_permission",
    );
    if (missing === undefined) {
      throw this.missionNotReady(
        workItemId,
        "A missing-permission run did not retain an exact denied operation.",
      );
    }
    if (record.authorization.kind !== "capability_envelope") {
      throw this.missionNotReady(
        workItemId,
        "Connected permission recovery requires capability-envelope authorization.",
      );
    }
    const phase = record.mission.identity.phase;
    if (
      (phase !== "execute" && phase !== "patch") ||
      mission.mission.identity.phase !== phase
    ) {
      throw this.missionNotReady(
        workItemId,
        "Connected permission recovery requires an exact writable mission phase.",
      );
    }
    await this.workItemController(source.workspace).recordConnectedPermissionDenial(
      workItemId,
      {
        expected_phase: phase,
        expected_status: "active",
        expected_schema_version: 2,
        governed_tuple: record.governed_tuple,
        mission_content_sha256: mission.mission.content_sha256,
        operation: {
          normalized_operation: missing.request,
          canonical_args_sha256: this.hashConnectedValue(missing.request),
          operation_sha256: missing.operation_sha256,
          reason: missing.reason,
          resolved_envelope_sha256:
            record.authorization.envelope_sha256,
          connected_run_id: record.connected_run_id,
        },
      },
    );
  }

  private connectedTerminalFromResult(result: AcpRunResult) {
    if (result.outcome === "completed") {
      return { outcome: "completed" as const, partial: false, reason: null };
    }
    if (result.outcome === "cancelled") {
      return this.cancelledConnectedTerminal();
    }
    return {
      outcome: result.outcome,
      partial: result.partial,
      reason:
        result.outcome === "missing_permission"
          ? "The ACP adapter denied an operation outside the approved capability envelope."
          : (this.unnormalizableRequestReason(result) ??
            "The ACP adapter did not complete the governed mission."),
    };
  }

  private unnormalizableRequestReason(result: AcpRunResult): string | null {
    const rejection = result.permissions.find(
      (outcome) => outcome.kind === "invalid_request",
    );
    if (rejection === undefined || rejection.kind !== "invalid_request") {
      return null;
    }
    return `The agent requested an operation the runtime could not interpret: ${PERMISSION_REJECTION_EXPLANATIONS[rejection.detail]}`;
  }

  private failedConnectedTerminal() {
    return {
      outcome: "failed" as const,
      partial: true,
      reason: "The ACP runtime failed before the governed mission completed.",
    };
  }

  private connectedReviewFailureTerminal(
    error: unknown,
  ): ConnectedRunTerminal {
    if (
      error instanceof ControllerConflictError &&
      error.kind === "mission_not_ready" &&
      error.reason.startsWith("Connected Review response ")
    ) {
      return {
        outcome: "failed",
        partial: true,
        reason: error.reason,
      };
    }
    return this.failedConnectedTerminal();
  }

  private cancelledConnectedTerminal() {
    return {
      outcome: "cancelled" as const,
      partial: true,
      reason: "Cancellation was requested by the Product Studio operator.",
    };
  }

  private shapingTerminalFromResult(result: AcpRunResult) {
    if (result.outcome === "completed") {
      return { outcome: "completed" as const, partial: false, reason: null };
    }
    if (result.outcome === "missing_permission") {
      return {
        outcome: "missing_permission" as const,
        partial: true,
        reason:
          "The artifact-only shaping runtime denied a mediated request outside its single-ingress write policy.",
      };
    }
    if (result.outcome === "cancelled") {
      return this.cancelledShapingTerminal();
    }
    return {
      outcome: result.outcome,
      partial: result.partial,
      reason:
        this.unnormalizableRequestReason(result) ??
        "The ACP adapter did not complete the artifact-only shaping mission.",
    };
  }

  private failedShapingTerminal() {
    return {
      outcome: "failed" as const,
      partial: true,
      reason:
        "The ACP runtime failed before the artifact-only shaping mission completed.",
    };
  }

  private cancelledShapingTerminal() {
    return {
      outcome: "cancelled" as const,
      partial: true,
      reason: "Cancellation was requested by the Product Studio operator.",
    };
  }

  private connectedSessionKey(
    sourceId: string,
    workItemId: string,
    connectedRunId: string,
  ): string {
    return `${sourceId}:${workItemId}:${connectedRunId}`;
  }

  private shapingSessionKey(
    sourceId: string,
    workItemId: string,
    shapingRunId: string,
  ): string {
    return `${sourceId}:${workItemId}:${shapingRunId}`;
  }

  private hashConnectedValue(value: unknown): string {
    return createHash("sha256")
      .update(`${JSON.stringify(value)}\n`)
      .digest("hex");
  }

  private governedExecuteIdentity(
    source: ResolvedSource,
    workItem: WorkItem,
  ): MissionIdentity<"execute"> {
    if (
      source.source_id === INBOX_SOURCE_ID ||
      workItem.goal.goal_contract === undefined ||
      workItem.state.goal_version === undefined ||
      workItem.state.input_revision === undefined ||
      workItem.state.attempt === undefined
    ) {
      throw this.missionNotReady(
        workItem.goal.work_item_id,
        "External result operations require an assigned, governed item.",
      );
    }
    return {
      phase: "execute",
      work_item_id: workItem.goal.work_item_id,
      goal_version: workItem.state.goal_version,
      input_revision: workItem.state.input_revision,
      attempt: workItem.state.attempt,
    };
  }

  private governedExecuteTuple(
    workItem: WorkItem,
    identity: MissionIdentity<"execute">,
  ): ConnectedRunRecordV2["governed_tuple"] {
    if (workItem.state.patch_cycle === undefined) {
      throw this.missionNotReady(
        workItem.goal.work_item_id,
        "Connected execution requires an explicit patch-cycle pin.",
      );
    }
    return {
      goal_version: identity.goal_version,
      input_revision: identity.input_revision,
      attempt: identity.attempt,
      patch_cycle: workItem.state.patch_cycle,
    };
  }

  private connectedLaunchInput(
    governedTuple: ConnectedRunRecordV2["governed_tuple"],
    missionContentSha256: string,
    modelOverride: string | undefined,
    runOrdinal: number,
  ) {
    return {
      expected_phase: "execute" as const,
      expected_status: "active" as const,
      expected_schema_version: 2 as const,
      run_ordinal: runOrdinal,
      governed_tuple: governedTuple,
      mission_content_sha256: missionContentSha256,
      ...(modelOverride === undefined ? {} : { model_override: modelOverride }),
    };
  }

  private governedReviewTuple(
    workItem: WorkItem,
    identity: MissionIdentity<"review">,
  ): ConnectedRunRecordV2["governed_tuple"] {
    if (workItem.state.patch_cycle === undefined) {
      throw this.missionNotReady(
        workItem.goal.work_item_id,
        "Connected Review requires an explicit patch-cycle pin.",
      );
    }
    return {
      goal_version: identity.goal_version,
      input_revision: identity.input_revision,
      attempt: identity.attempt,
      patch_cycle: workItem.state.patch_cycle,
    };
  }

  private connectedReviewLaunchInput(
    governedTuple: ConnectedRunRecordV2["governed_tuple"],
    missionContentSha256: string,
    modelOverride: string | undefined,
    runOrdinal: number,
  ) {
    return {
      expected_phase: "review" as const,
      expected_status: "active" as const,
      expected_schema_version: 2 as const,
      run_ordinal: runOrdinal,
      governed_tuple: governedTuple,
      mission_content_sha256: missionContentSha256,
      ...(modelOverride === undefined ? {} : { model_override: modelOverride }),
    };
  }

  private governedPatchTuple(
    workItem: WorkItem,
    identity: MissionIdentity<"patch">,
  ): ConnectedRunRecordV2["governed_tuple"] {
    return {
      goal_version: identity.goal_version,
      input_revision: identity.input_revision,
      attempt: identity.attempt,
      patch_cycle: identity.patch_cycle,
    };
  }

  private connectedPatchLaunchInput(
    governedTuple: ConnectedRunRecordV2["governed_tuple"],
    missionContentSha256: string,
    modelOverride: string | undefined,
    runOrdinal: number,
  ) {
    return {
      expected_phase: "patch" as const,
      expected_status: "active" as const,
      expected_schema_version: 2 as const,
      run_ordinal: runOrdinal,
      governed_tuple: governedTuple,
      mission_content_sha256: missionContentSha256,
      ...(modelOverride === undefined ? {} : { model_override: modelOverride }),
    };
  }

  private governedReviewIdentity(
    source: ResolvedSource,
    workItem: WorkItem,
  ): MissionIdentity<"review"> {
    if (
      source.source_id === INBOX_SOURCE_ID ||
      workItem.goal.goal_contract === undefined ||
      workItem.state.goal_version === undefined ||
      workItem.state.input_revision === undefined ||
      workItem.state.attempt === undefined
    ) {
      throw this.missionNotReady(
        workItem.goal.work_item_id,
        "Review operations require an assigned, governed item.",
      );
    }
    return {
      phase: "review",
      work_item_id: workItem.goal.work_item_id,
      goal_version: workItem.state.goal_version,
      input_revision: workItem.state.input_revision,
      attempt: workItem.state.attempt,
    };
  }

  private governedPatchIdentity(
    source: ResolvedSource,
    workItem: WorkItem,
  ): MissionIdentity<"patch"> {
    if (
      source.source_id === INBOX_SOURCE_ID ||
      workItem.goal.goal_contract === undefined ||
      workItem.state.goal_version === undefined ||
      workItem.state.input_revision === undefined ||
      workItem.state.attempt === undefined ||
      workItem.state.patch_cycle === undefined ||
      workItem.state.patch_cycle < 1
    ) {
      throw this.missionNotReady(
        workItem.goal.work_item_id,
        "Patch operations require an assigned, governed item with an active patch cycle.",
      );
    }
    return {
      phase: "patch",
      work_item_id: workItem.goal.work_item_id,
      goal_version: workItem.state.goal_version,
      input_revision: workItem.state.input_revision,
      attempt: workItem.state.attempt,
      patch_cycle: workItem.state.patch_cycle,
    };
  }

  private workItemController(workspace: WorkspaceGateway): WorkItemController {
    return new WorkItemController(
      workspace,
      () => new Date(),
      workspace.gitVerificationAdapter(),
      workspace.verificationRunner(),
    );
  }

  private missionNotReady(
    workItemId: string,
    reason: string,
  ): ControllerConflictError {
    return new ControllerConflictError(
      "mission_not_ready",
      workItemId,
      reason,
    );
  }

  private async recoverTransfer(record: TransferJournalRecord): Promise<void> {
    const source = await this.resolveSource(record.from_source_id);
    const target = await this.resolveSource(record.to_source_id);
    if (source.workspace.workspaceRoot !== resolve(record.from_path)) {
      throw new WorkItemTransferFailedError(
        record.from_source_id,
        record.work_item_id,
        record.to_source_id,
        "journal source path no longer matches the registered source",
      );
    }

    const sourceItem = await source.workspace.read(record.work_item_id);
    const targetItem = await target.workspace.read(record.work_item_id);

    if (targetItem === null) {
      if (sourceItem === null) {
        throw new WorkItemTransferFailedError(
          record.from_source_id,
          record.work_item_id,
          record.to_source_id,
          "transfer has neither a source item nor a published target",
        );
      }
      await target.workspace.discardStagedWorkItem(
        record.work_item_id,
        record.to_path,
      );
      await this.deleteTransferJournal(record.transfer_id);
      return;
    }

    if (
      sourceItem !== null &&
      sourceItem.goal.goal_contract !== undefined
    ) {
      throw new WorkItemTransferFailedError(
        record.from_source_id,
        record.work_item_id,
        record.to_source_id,
        "transfer source unexpectedly contains a locked goal contract",
      );
    }
    await this.validatePublishedTransferTarget(
      record,
      target,
      targetItem,
      record.kind === "move" ? (sourceItem ?? undefined) : undefined,
    );

    if (sourceItem !== null) {
      await source.workspace.removeWorkItem(record.work_item_id);
      if ((await source.workspace.read(record.work_item_id)) !== null) {
        throw new WorkItemTransferFailedError(
          record.from_source_id,
          record.work_item_id,
          record.to_source_id,
          "source work item still exists after recovery removal",
        );
      }
    }
    const completedRecord: TransferJournalRecord = {
      ...record,
      stage: "source_removed",
    };
    await this.writeTransferJournal(completedRecord);
    await this.deleteTransferJournal(record.transfer_id);
  }

  private async readTransferJournals(): Promise<TransferJournalRecord[]> {
    await this.ensureTransfersDirectory();
    const entries = await readdir(this.transfersRoot, { withFileTypes: true });
    const records: TransferJournalRecord[] = [];

    for (const entry of entries) {
      if (TRANSFER_TEMP_FILE_PATTERN.test(entry.name)) {
        if (!entry.isFile()) {
          throw new InvalidWorkspaceError(
            `.portfolio/transfers/${entry.name}`,
            "transfer journal temporary entry must be a regular file",
          );
        }
        continue;
      }
      const artifactPath = `.portfolio/transfers/${entry.name}`;
      if (!entry.isFile()) {
        throw new InvalidWorkspaceError(
          artifactPath,
          "transfer journal entry must be a regular file",
        );
      }

      const journalPath = join(this.transfersRoot, entry.name);
      const stats = await lstat(journalPath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new InvalidWorkspaceError(
          artifactPath,
          "transfer journal must be a regular file, not a symlink",
        );
      }

      let value: unknown;
      try {
        value = JSON.parse(await readFile(journalPath, "utf8"));
      } catch (error) {
        throw new InvalidWorkspaceError(
          artifactPath,
          `invalid JSON: ${errorMessage(error)}`,
        );
      }
      const result = transferJournalRecordSchema.safeParse(value);
      if (!result.success) {
        throw new InvalidWorkspaceError(
          artifactPath,
          validationReason(result.error),
        );
      }
      if (entry.name !== `${result.data.transfer_id}.json`) {
        throw new InvalidWorkspaceError(
          artifactPath,
          "journal filename must match transfer_id",
        );
      }
      records.push(result.data);
    }

    return records.sort((left, right) =>
      left.transfer_id.localeCompare(right.transfer_id),
    );
  }

  private async writeTransferJournal(
    record: TransferJournalRecord,
  ): Promise<void> {
    const validatedRecord = transferJournalRecordSchema.parse(record);
    await this.ensureTransfersDirectory();
    const journalPath = join(
      this.transfersRoot,
      `${validatedRecord.transfer_id}.json`,
    );
    const temporaryPath = join(
      this.transfersRoot,
      `.${validatedRecord.transfer_id}.json.${randomUUID()}.tmp`,
    );

    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(validatedRecord, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await rename(temporaryPath, journalPath);
    } finally {
      try {
        await unlink(temporaryPath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }

  private async deleteTransferJournal(transferId: string): Promise<void> {
    try {
      await unlink(join(this.transfersRoot, `${transferId}.json`));
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async ensureTransfersDirectory(): Promise<void> {
    const portfolioRoot = dirname(this.inboxRoot);
    await this.ensureSafeDirectory(portfolioRoot, ".portfolio");
    await this.ensureSafeDirectory(
      this.transfersRoot,
      ".portfolio/transfers",
    );
  }

  private async resolveSource(sourceId: string): Promise<ResolvedSource> {
    if (sourceId === INBOX_SOURCE_ID) {
      return {
        source_id: INBOX_SOURCE_ID,
        project: null,
        workspace: await this.ensureInboxWorkspace(),
      };
    }

    const project = (await this.registry.read()).find(
      (workspace) => workspace.workspace_id === sourceId,
    );
    if (!project) {
      throw new UnknownPortfolioSourceError(sourceId);
    }

    return {
      source_id: project.workspace_id,
      project,
      workspace: this.makeWorkspace(project.workspace_path),
    };
  }

  private async ensureInboxWorkspace(): Promise<WorkspaceGateway> {
    const portfolioRoot = dirname(this.inboxRoot);
    const founderDirectory = join(this.inboxRoot, ".founder");
    const manifestPath = join(founderDirectory, "product.yaml");

    await this.ensureSafeDirectory(portfolioRoot, ".portfolio");
    await this.ensureSafeDirectory(this.inboxRoot, ".");
    await this.ensureSafeDirectory(founderDirectory, ".founder");

    let manifestExists = false;
    try {
      const stats = await lstat(manifestPath);
      manifestExists = true;
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new InvalidWorkspaceError(
          ".founder/product.yaml",
          "path must be a regular file, not a symlink",
        );
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }

    if (!manifestExists) {
      await this.createInboxManifest(manifestPath);
    }

    const workspace = this.makeWorkspace(this.inboxRoot);
    const manifest = await workspace.readManifest();
    if (manifest.product_name !== INBOX_SOURCE_LABEL) {
      throw new InvalidWorkspaceError(
        ".founder/product.yaml",
        `product_name must be ${INBOX_SOURCE_LABEL}`,
      );
    }

    return workspace;
  }

  private async ensureSafeDirectory(
    directoryPath: string,
    artifactPath: string,
  ): Promise<void> {
    try {
      await mkdir(directoryPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
    }

    const stats = await lstat(directoryPath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new InvalidWorkspaceError(
        artifactPath,
        "path must be a directory, not a symlink",
      );
    }
  }

  private async createInboxManifest(manifestPath: string): Promise<void> {
    const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`;

    try {
      await writeFile(
        temporaryPath,
        stringify({
          schema_version: 2,
          product_name: INBOX_SOURCE_LABEL,
          verification: {
            required_commands: [
              {
                name: "Lint",
                argv: ["npm", "run", "lint"],
                timeout_seconds: 300,
              },
              {
                name: "Typecheck",
                argv: ["npm", "run", "typecheck"],
                timeout_seconds: 300,
              },
              {
                name: "Test",
                argv: ["npm", "test"],
                timeout_seconds: 900,
              },
              {
                name: "Build",
                argv: ["npm", "run", "build"],
                timeout_seconds: 900,
              },
            ],
          },
        }),
        { encoding: "utf8", flag: "wx" },
      );
      try {
        await link(temporaryPath, manifestPath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw error;
        }
      }
    } finally {
      try {
        await unlink(temporaryPath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }
}
