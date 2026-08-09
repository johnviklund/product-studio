"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  LockKeyhole,
  X,
} from "lucide-react";

import type {
  BrainstormMissionCompilation,
  ConnectedModelListing,
  ManualShapingIngressResult,
  MissionCompilation,
  PatchMissionCompilation,
  PlanMissionCompilation,
  PortfolioImportResult,
  PortfolioPatchImportResult,
  PortfolioPatchPlanResult,
  PortfolioPlanApprovalResult,
  PortfolioReviewImportDriftRecoveryListing,
  PortfolioReviewImportDriftRecoveryResult,
  PortfolioReviewImportResult,
  PortfolioRetryResult,
  PortfolioScopeCorrectionListing,
  PortfolioScopeCorrectionResult,
  PortfolioCommandAuthorizationResult,
  PortfolioShapingDecisionResult,
  PortfolioShapingLaunchResult,
  ReviewMissionCompilation,
  ShapingArtifactListing,
  ShapingImportResult,
  SpecMissionCompilation,
} from "@/src/application/portfolio";
import {
  INBOX_SOURCE_ID,
  type PortfolioWorkItem,
  type RegisteredWorkspace,
} from "@/src/domain/portfolio";
import type {
  CommandEvidenceRecord,
  ImportEvidenceOutcome,
  ReviewFinding,
  StoredImportEvidence,
} from "@/src/domain/result";
import type { ConnectedRunSummary } from "@/src/domain/connected-run";
import type { ShapingRunSummary } from "@/src/domain/shaping-run";
import type { WorkflowModelSeat } from "@/src/domain/portfolio-preferences";
import {
  isShapingPhase,
  type BrainstormResultSubmission,
  type ShapingPhase,
  type ShapingResultSubmission,
  type SpecResultSubmission,
  type StoredShapingArtifact,
} from "@/src/domain/shaping";
import {
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_TYPES,
  type ActiveRun,
  type GoalContract,
  type RetainedControllerLeaseRepairResult,
  type ReviewImportDriftRecoveryProposalV1,
  type WorkItemAttention,
  type WorkItemPhase,
  type WorkItemPriority,
  type WorkItemState,
  type WorkItemType,
} from "@/src/domain/work-item";
import { canUpdateGoalContract } from "@/src/domain/workflow-policy";
import {
  boardTransitionActionsForPhase,
  connectedExecuteForItem,
  connectedPhaseForItem,
  detailPanelModeForItem,
  missionHandoffModeForItem,
  nextActionForPhase,
  patchAttentionForItem,
  reviewHandoffForItem,
  shapingHandoffForItem,
  type BoardColumnId,
  type ConnectedExecuteProjection,
  type ConnectedPhaseProjection,
  type ConnectedWorkflowPhase,
  type DecisionFirstShapingHandoffProjection,
  type PatchAttentionProjection,
  type ShapingActionProjection,
  type ShapingChecklistPreview,
  type ShapingHandoffProjection,
  type ShapingListPreview,
  type ShapingManualRecoveryProjectionInput,
  type ShapingModelPickerProjection,
  type ShapingRefreshProjection,
  type ShapingRevisionProjectionInput,
  type ShapingSurfaceContext,
  type ShapingTextPreview,
} from "@/src/presentation/board";
import {
  boundedRefreshMachine,
  createShapingRefreshController,
  shapingActionRequest,
  type ShapingRefreshController,
  type ShapingRefreshControllerSnapshot,
  type ShapingRefreshObservation,
} from "@/src/presentation/shaping-interaction";

interface DetailPanelProps {
  item: PortfolioWorkItem;
  workspaces: RegisteredWorkspace[];
  onClose: () => void;
  onUpdated: (item: PortfolioWorkItem, message?: string) => void;
  onAssigned: (previous: PortfolioWorkItem, item: PortfolioWorkItem) => void;
  onTransition: (item: PortfolioWorkItem, targetColumnId: BoardColumnId) => void;
  transitionPending?: boolean;
}

interface MutationErrorResponse {
  error?: {
    code?: string;
    message?: string;
  };
}

type DetailTab = "overview" | "activity" | "files";

interface MissionCompilationState {
  itemKey: string;
  result: MissionCompilation;
}

interface MissionImportState {
  itemKey: string;
  result: PortfolioImportResult["evidence"];
}

interface ReviewMissionCompilationState {
  itemKey: string;
  result: ReviewMissionCompilation;
}

interface ReviewMissionImportState {
  itemKey: string;
  result: PortfolioReviewImportResult;
}

interface PatchMissionCompilationState {
  itemKey: string;
  result: PatchMissionCompilation;
}

interface PatchMissionImportState {
  itemKey: string;
  result: PortfolioPatchImportResult["evidence"];
}

type PatchMutation = "accepting_plan" | "compiling" | "importing";

interface ReviewAttestationState {
  itemKey: string;
  checked: boolean;
}

interface RunEvidenceState {
  itemKey: string;
  result: StoredImportEvidence[];
  loading: boolean;
  error: string | null;
}

interface ExpandedRunEvidenceState {
  itemKey: string;
  runIds: Set<string>;
}

interface ConnectedRunState {
  itemKey: string;
  result: ConnectedRunSummary[];
  loading: boolean;
  error: string | null;
}

interface ConnectedModelState {
  itemKey: string;
  result: ConnectedModelListing | null;
  loading: boolean;
  error: string | null;
}

interface ConnectedModelSelectionState {
  itemKey: string;
  phase: ConnectedWorkflowPhase;
  model: string;
}

interface ScopeCorrectionState {
  itemKey: string;
  listing: PortfolioScopeCorrectionListing | null;
  loading: boolean;
  error: string | null;
}

interface ReviewImportDriftRecoveryState {
  itemKey: string;
  listing: PortfolioReviewImportDriftRecoveryListing | null;
  loading: boolean;
  error: string | null;
}

interface ShapingArtifactState {
  itemKey: string;
  listing: ShapingArtifactListing | null;
  currentGoalContractSha256: string | null;
  derivedGoalContractSha256: string | null;
  loading: boolean;
  error: string | null;
}

interface ShapingRefreshBinding {
  identity: string;
  itemKey: string;
  item: PortfolioWorkItem;
  sourceId: string;
  workItemId: string;
  phase: ShapingPhase;
  missionContentSha256: string;
  shapingRunId: string;
  observation: ShapingRefreshObservation;
}

interface ShapingRefreshUiState {
  identity: string;
  snapshot: ShapingRefreshControllerSnapshot;
}

interface ShapingManualRecoveryBinding {
  identity: string;
  phase: ShapingPhase;
  expectedMissionContentSha256: string;
  expectedShapingStateSha256: string;
}

interface ShapingModelSelectionState {
  pickerKey: string;
  model: string;
}

export interface ShapingRequestChangesComposerState {
  identity: string;
  open: boolean;
  launchMode: "connected" | "manual";
  feedback: string;
  selectedModel: string | null;
  error: string | null;
}

export type ShapingRequestChangesComposerEvent =
  | {
      type: "open";
      identity: string;
      launchMode: "connected" | "manual";
      selectedModel: string | null;
    }
  | { type: "close"; identity: string }
  | { type: "feedback_changed"; identity: string; feedback: string }
  | { type: "model_selected"; identity: string; model: string }
  | { type: "request_started"; identity: string }
  | { type: "request_failed"; identity: string; reason: string }
  | { type: "request_succeeded"; identity: string };

export function updateShapingRequestChangesComposer(
  current: ShapingRequestChangesComposerState | null,
  event: ShapingRequestChangesComposerEvent,
): ShapingRequestChangesComposerState | null {
  if (event.type === "open") {
    return current?.identity === event.identity
      ? { ...current, open: true, launchMode: event.launchMode }
      : {
          identity: event.identity,
          open: true,
          launchMode: event.launchMode,
          feedback: "",
          selectedModel: event.selectedModel,
          error: null,
        };
  }
  if (current?.identity !== event.identity) {
    return current;
  }
  switch (event.type) {
    case "close":
      return { ...current, open: false };
    case "feedback_changed":
      return { ...current, feedback: event.feedback };
    case "model_selected":
      return { ...current, selectedModel: event.model };
    case "request_started":
      return { ...current, error: null };
    case "request_failed":
      return { ...current, open: true, error: event.reason };
    case "request_succeeded":
      return null;
  }
}

export interface RetainedControllerLeaseRepairUiState {
  identity: string;
  itemKey: string;
  phase: ShapingPhase;
  retainedRun: ActiveRun;
  acknowledged: boolean;
  status: "awaiting_acknowledgement" | "repairing" | "repaired";
  error: string | null;
}

export function retainedControllerLeaseRepairForConflict(input: {
  itemKey: string;
  phase: ShapingPhase;
  errorCode: string | undefined;
  errorMessage: string | undefined;
  activeRun: ActiveRun | undefined;
}): RetainedControllerLeaseRepairUiState | null {
  if (
    input.errorCode !== "repair_required" ||
    !input.errorMessage?.includes("repairRetainedControllerLease") ||
    input.activeRun === undefined
  ) {
    return null;
  }
  return {
    identity: JSON.stringify([
      input.itemKey,
      input.activeRun.run_id,
      input.activeRun.acquired_at,
    ]),
    itemKey: input.itemKey,
    phase: input.phase,
    retainedRun: input.activeRun,
    acknowledged: false,
    status: "awaiting_acknowledgement",
    error: null,
  };
}

export type RetainedControllerLeaseRepairRequest =
  | { status: "blocked"; reason: "acknowledgement_required" }
  | {
      status: "ready";
      method: "POST";
      route: string;
      body: { acknowledged_run_id: string };
    };

export function retainedControllerLeaseRepairRequest(
  sourceId: string,
  workItemId: string,
  repair: RetainedControllerLeaseRepairUiState,
): RetainedControllerLeaseRepairRequest {
  if (
    !repair.acknowledged ||
    repair.status !== "awaiting_acknowledgement"
  ) {
    return { status: "blocked", reason: "acknowledgement_required" };
  }
  return {
    status: "ready",
    method: "POST",
    route: `/api/portfolio/work-items/${encodeURIComponent(sourceId)}/${encodeURIComponent(workItemId)}/repair-controller-lease`,
    body: { acknowledged_run_id: repair.retainedRun.run_id },
  };
}

interface ShapingLaunchFailureState {
  itemKey: string;
  decision_id: string;
  locked_model: string;
  reason: string;
}

interface ShapingNewAttemptState {
  itemKey: string;
  decision_id: string;
}

interface ShapingCompilationState {
  itemKey: string;
  result: ShapingCompilation;
}

interface ShapingImportState {
  itemKey: string;
  result: ShapingImportResult;
}

export interface ShapingManualRecoveryUiState {
  identity: string;
  recovery: ShapingManualRecoveryProjectionInput;
  prepared: ManualShapingIngressResult | null;
  imported: ShapingImportResult | null;
  error: string | null;
  importing: boolean;
}

export type ShapingManualRecoveryUiEvent =
  | { type: "prepare_started"; identity: string }
  | {
      type: "prepare_succeeded";
      identity: string;
      result: ManualShapingIngressResult;
    }
  | {
      type: "prepare_failed";
      identity: string;
      reason: string;
      retried: boolean;
    }
  | {
      type: "copied";
      identity: string;
      target: "task" | "instruction" | "ingress";
    }
  | { type: "import_started"; identity: string }
  | {
      type: "import_failed";
      identity: string;
      reason: string;
    }
  | {
      type: "copy_failed";
      identity: string;
      reason: string;
    }
  | {
      type: "import_succeeded";
      identity: string;
      result: ShapingImportResult;
    };

export function updateShapingManualRecovery(
  current: ShapingManualRecoveryUiState | null,
  event: ShapingManualRecoveryUiEvent,
): ShapingManualRecoveryUiState | null {
  if (event.type === "prepare_started") {
    return {
      identity: event.identity,
      recovery: { state: "loading" },
      prepared:
        current?.identity === event.identity ? current.prepared : null,
      imported: null,
      error: null,
      importing: false,
    };
  }
  if (current?.identity !== event.identity) {
    return current;
  }
  switch (event.type) {
    case "prepare_succeeded":
      return {
        ...current,
        recovery: {
          state: "ready",
          task: event.result.task,
          instruction_path: event.result.instruction_path,
          ingress_path: event.result.instruction.ingress_path,
        },
        prepared: event.result,
        imported: null,
        error: null,
      };
    case "prepare_failed":
      return {
        ...current,
        recovery: {
          state: event.retried ? "retry" : "failure",
          reason: event.reason,
        },
        prepared: null,
        imported: null,
        error: null,
      };
    case "copied":
      if (current.prepared === null) {
        return current;
      }
      return {
        ...current,
        recovery: {
          state: "copy",
          copied_target: event.target,
          task: current.prepared.task,
          instruction_path: current.prepared.instruction_path,
          ingress_path: current.prepared.instruction.ingress_path,
        },
        error: null,
      };
    case "import_started":
      return { ...current, importing: true, error: null };
    case "import_failed":
      return { ...current, importing: false, error: event.reason };
    case "copy_failed":
      return { ...current, error: event.reason };
    case "import_succeeded":
      return {
        ...current,
        imported: event.result,
        importing: false,
        error: null,
      };
  }
}

interface ShapingSelectionState {
  itemKey: string;
  acceptanceContentSha256: string;
}

interface ShapingCopiedState {
  itemKey: string;
  target: ShapingCopyTarget;
}

type ConnectedMutation =
  | "launching"
  | "cancelling"
  | "allowing_once"
  | "retrying_without_allowing"
  | "keeping_denied"
  | "preparing_commands"
  | "authorizing_commands";

interface RunEvidenceSectionProps {
  fieldId: string;
  evidence: StoredImportEvidence[];
  loading: boolean;
  error: string | null;
  expandedRunIds: Set<string>;
  onToggle: (
    phase: "execute" | "review" | "patch",
    importRunId: string,
  ) => void;
}

const capturedAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const runCompletedAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const EMPTY_RUN_IDS = new Set<string>();

function connectedRunValue(value: { value: string | null }): string {
  return value.value ?? "unknown";
}

function connectedHarnessValue(
  value: ConnectedRunSummary["provenance"]["harness"],
): string {
  return value.value === null
    ? "unknown"
    : `${value.value.id} ${value.value.version}`;
}

function effectiveModelValue(
  value: ConnectedRunSummary["provenance"]["effective_model"],
): string {
  return value.model_id === null ? "unknown" : value.model_id;
}

function latestConnectedRun(
  runs: readonly ConnectedRunSummary[],
): ConnectedRunSummary | null {
  return runs.reduce<ConnectedRunSummary | null>((latest, run) => {
    if (
      latest === null ||
      new Date(run.lifecycle.updated_at).getTime() >
        new Date(latest.lifecycle.updated_at).getTime()
    ) {
      return run;
    }
    return latest;
  }, null);
}

export function commandAuthorizationPreflightEligible(
  state: Pick<
    WorkItemState,
    | "phase"
    | "status"
    | "attention"
    | "goal_version"
    | "input_revision"
    | "attempt"
    | "patch_cycle"
  >,
  runs: readonly ConnectedRunSummary[],
): boolean {
  if (
    (state.phase !== "execute" && state.phase !== "patch") ||
    state.status !== "active" ||
    state.attention !== undefined ||
    state.goal_version === undefined ||
    state.input_revision === undefined ||
    state.attempt === undefined ||
    state.patch_cycle === undefined
  ) {
    return false;
  }
  const latest = latestConnectedRun(
    runs.filter((run) => run.mission.identity.phase === state.phase),
  );
  if (
    latest?.lifecycle.status !== "terminal" ||
    latest.lifecycle.terminal_outcome !== "completed" ||
    latest.lifecycle.partial
  ) {
    return false;
  }
  const currentTupleMatches =
    latest.governed_tuple.goal_version === state.goal_version &&
    latest.governed_tuple.input_revision === state.input_revision &&
    latest.governed_tuple.attempt === state.attempt &&
    latest.governed_tuple.patch_cycle === state.patch_cycle;
  const correctedExecuteRestart =
    state.phase === "execute" &&
    state.attempt === 0 &&
    latest.governed_tuple.goal_version < state.goal_version &&
    latest.governed_tuple.input_revision < state.input_revision;
  return currentTupleMatches || correctedExecuteRestart;
}

function connectedStatusLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function tagsFromInput(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function goalContractLines(values: string[] | undefined): string {
  return values?.join("\n") ?? "";
}

function goalContractValues(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export interface GoalContractDraft {
  purpose: string;
  acceptanceCriteria: string;
  nonGoals: string;
  allowedScope: string;
  reviewReady: string;
}

export function specProposalToGoalContractDraft(
  proposal: SpecResultSubmission["proposal"],
): GoalContractDraft {
  return {
    purpose: proposal.purpose,
    acceptanceCriteria: goalContractLines(proposal.acceptance_criteria),
    nonGoals: goalContractLines(proposal.non_goals),
    allowedScope: goalContractLines(proposal.allowed_scope),
    reviewReady: goalContractLines(proposal.review_ready),
  };
}

function shortEvidencePath(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length <= 4) {
    return path;
  }
  return `…/${segments.slice(-4).join("/")}`;
}

async function requestRunEvidence(
  sourceId: string,
  workItemId: string,
  signal?: AbortSignal,
): Promise<
  { result: StoredImportEvidence[] | null; error: string | null } | null
> {
  try {
    const response = await fetch(
      `/api/portfolio/work-items/${encodeURIComponent(sourceId)}/${encodeURIComponent(workItemId)}/run-evidence`,
      { signal },
    );
    const body = (await response.json()) as
      | StoredImportEvidence[]
      | MutationErrorResponse;
    if (signal?.aborted) {
      return null;
    }
    if (!response.ok) {
      return {
        result: null,
        error: !Array.isArray(body)
          ? body.error?.message ?? "Run evidence could not be loaded."
          : "Run evidence could not be loaded.",
      };
    }
    return { result: body as StoredImportEvidence[], error: null };
  } catch {
    if (signal?.aborted) {
      return null;
    }
    return {
      result: null,
      error: "Run evidence could not be loaded. Check the local server and try again.",
    };
  }
}

async function requestConnectedRuns(
  sourceId: string,
  workItemId: string,
  phase: ConnectedWorkflowPhase,
  signal?: AbortSignal,
): Promise<
  { result: ConnectedRunSummary[] | null; error: string | null } | null
> {
  try {
    const connectedPath =
      phase === "execute"
        ? "mission/connected/run"
        : `mission/${phase}/connected/run`;
    const response = await fetch(
      `/api/portfolio/work-items/${encodeURIComponent(sourceId)}/${encodeURIComponent(workItemId)}/${connectedPath}`,
      { signal },
    );
    const body = (await response.json()) as
      | ConnectedRunSummary[]
      | MutationErrorResponse;
    if (signal?.aborted) {
      return null;
    }
    if (!response.ok || !Array.isArray(body)) {
      return {
        result: null,
        error:
          !Array.isArray(body) && body.error?.message
            ? body.error.message
            : "Connected run status could not be loaded.",
      };
    }
    return { result: body, error: null };
  } catch {
    if (signal?.aborted) {
      return null;
    }
    return {
      result: null,
      error: "Connected run status could not be loaded. Check the local server and try again.",
    };
  }
}

async function requestConnectedModels(
  sourceId: string,
  workItemId: string,
  signal?: AbortSignal,
): Promise<
  { result: ConnectedModelListing | null; error: string | null } | null
> {
  try {
    const response = await fetch(
      `/api/portfolio/work-items/${encodeURIComponent(sourceId)}/${encodeURIComponent(workItemId)}/mission/connected/models`,
      { signal },
    );
    const body = (await response.json()) as
      | ConnectedModelListing
      | MutationErrorResponse;
    if (signal?.aborted) {
      return null;
    }
    if (!response.ok || !("model_availability" in body)) {
      return {
        result: null,
        error:
          "error" in body
            ? body.error?.message ?? "Connected models could not be loaded."
            : "Connected models could not be loaded.",
      };
    }
    return { result: body, error: null };
  } catch {
    if (signal?.aborted) {
      return null;
    }
    return {
      result: null,
      error: "Connected models could not be loaded. Check the local server and try again.",
    };
  }
}

async function requestScopeCorrection(
  sourceId: string,
  workItemId: string,
  signal?: AbortSignal,
): Promise<
  { result: PortfolioScopeCorrectionListing | null; error: string | null } | null
> {
  try {
    const response = await fetch(
      `/api/portfolio/work-items/${encodeURIComponent(sourceId)}/${encodeURIComponent(workItemId)}/mission/scope-correction`,
      { signal },
    );
    const body = (await response.json()) as
      | PortfolioScopeCorrectionListing
      | MutationErrorResponse;
    if (signal?.aborted) {
      return null;
    }
    if (!response.ok || !("proposal" in body)) {
      return {
        result: null,
        error:
          "error" in body
            ? body.error?.message ?? "The scope correction could not be loaded."
            : "The scope correction could not be loaded.",
      };
    }
    return { result: body, error: null };
  } catch {
    if (signal?.aborted) {
      return null;
    }
    return {
      result: null,
      error: "The scope correction could not be loaded. Check the local server and try again.",
    };
  }
}

async function requestReviewImportDriftRecovery(
  sourceId: string,
  workItemId: string,
  signal?: AbortSignal,
): Promise<
  {
    result: PortfolioReviewImportDriftRecoveryListing | null;
    error: string | null;
  } | null
> {
  try {
    const response = await fetch(
      `/api/portfolio/work-items/${encodeURIComponent(sourceId)}/${encodeURIComponent(workItemId)}/mission/review/import-drift-recovery`,
      { signal },
    );
    const body = (await response.json()) as
      | PortfolioReviewImportDriftRecoveryListing
      | MutationErrorResponse;
    if (signal?.aborted) {
      return null;
    }
    if (!response.ok || !("proposal" in body)) {
      return {
        result: null,
        error:
          "error" in body
            ? body.error?.message ??
              "The Review import drift proposal could not be loaded."
            : "The Review import drift proposal could not be loaded.",
      };
    }
    return { result: body, error: null };
  } catch {
    if (signal?.aborted) {
      return null;
    }
    return {
      result: null,
      error:
        "The Review import drift proposal could not be loaded. Check the local server and try again.",
    };
  }
}

async function requestShapingArtifacts(
  sourceId: string,
  workItemId: string,
  signal?: AbortSignal,
): Promise<
  { result: ShapingArtifactListing | null; error: string | null } | null
> {
  try {
    const response = await fetch(
      `/api/portfolio/work-items/${encodeURIComponent(sourceId)}/${encodeURIComponent(workItemId)}/shaping`,
      { signal },
    );
    const body = (await response.json()) as
      | ShapingArtifactListing
      | MutationErrorResponse;
    if (signal?.aborted) {
      return null;
    }
    if (!response.ok || !("artifacts" in body)) {
      return {
        result: null,
        error:
          "error" in body
            ? body.error?.message ?? "Shaping history could not be loaded."
            : "Shaping history could not be loaded.",
      };
    }
    return { result: body, error: null };
  } catch {
    if (signal?.aborted) {
      return null;
    }
    return {
      result: null,
      error:
        "Shaping history could not be loaded. Check the local server and try again.",
    };
  }
}

function currentShapingTip(
  phase: ShapingPhase,
  artifacts: readonly StoredShapingArtifact[],
): StoredShapingArtifact | null {
  const phaseArtifacts = artifacts.filter(
    (artifact) => artifact.mission.identity.phase === phase,
  );
  if (phaseArtifacts.length === 0) {
    return null;
  }
  const superseded = new Set(
    phaseArtifacts.flatMap((artifact) => {
      const revision = artifact.mission.input.revision;
      return revision === undefined ? [] : [revision.supersedes_input_sha256];
    }),
  );
  const tips = phaseArtifacts.filter(
    (artifact) => !superseded.has(artifact.mission.identity.input_sha256),
  );
  return tips.length === 1 ? tips[0]! : null;
}

function parsedShapingResult(
  artifact: StoredShapingArtifact,
): ShapingResultSubmission | null {
  if (artifact.result === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(artifact.result.result_source) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("identity" in parsed) ||
      typeof parsed.identity !== "object" ||
      parsed.identity === null ||
      !("phase" in parsed.identity) ||
      parsed.identity.phase !== artifact.mission.identity.phase
    ) {
      return null;
    }
    return parsed as ShapingResultSubmission;
  } catch {
    return null;
  }
}

async function sha256Json(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function goalContractSha256(contract: GoalContract): Promise<string> {
  return sha256Json({
    schema_version: contract.schema_version,
    goal_version: contract.goal_version,
    purpose: contract.purpose,
    acceptance_criteria: contract.acceptance_criteria,
    non_goals: contract.non_goals,
    allowed_scope: contract.allowed_scope,
    review_ready: contract.review_ready,
  });
}

async function shapingGoalContractHashes(
  item: PortfolioWorkItem,
  listing: ShapingArtifactListing,
): Promise<{
  currentGoalContractSha256: string | null;
  derivedGoalContractSha256: string | null;
}> {
  const currentContract = item.work_item.goal.goal_contract;
  const currentGoalContractSha256 =
    currentContract === undefined
      ? null
      : await goalContractSha256(currentContract);
  if (item.work_item.state.phase !== "spec") {
    return { currentGoalContractSha256, derivedGoalContractSha256: null };
  }
  const tip = currentShapingTip("spec", listing.artifacts);
  const result = tip === null ? null : parsedShapingResult(tip);
  if (result === null || !isSpecResult(result)) {
    return { currentGoalContractSha256, derivedGoalContractSha256: null };
  }
  const proposal = result.proposal;
  const derivedContract: GoalContract = {
    schema_version: 1,
    goal_version: (currentContract?.goal_version ?? 0) + 1,
    purpose: proposal.purpose,
    acceptance_criteria: [...proposal.acceptance_criteria],
    non_goals: [...proposal.non_goals],
    allowed_scope: [...proposal.allowed_scope],
    review_ready: [...proposal.review_ready],
  };
  return {
    currentGoalContractSha256,
    derivedGoalContractSha256: await goalContractSha256(derivedContract),
  };
}

function shapingRevisionFromListing(
  phase: ShapingPhase,
  listing: ShapingArtifactListing,
): ShapingRevisionProjectionInput | null {
  const tip = currentShapingTip(phase, listing.artifacts);
  if (tip === null) {
    return null;
  }
  const planBinding =
    tip.mission.input.phase === "plan"
      ? {
          plan_goal_contract_sha256:
            tip.mission.input.goal_contract_sha256,
          plan_goal_version: tip.mission.input.goal_version,
        }
      : {};
  if (tip.result === null) {
    return {
      mission_content_sha256: tip.mission.content_sha256,
      result: { status: "none" },
      ...planBinding,
    };
  }
  const result = parsedShapingResult(tip);
  if (
    result === null ||
    tip.import_receipt?.outcome !== "applied" ||
    tip.production_receipt === null ||
    tip.applied_marker === null
  ) {
    return {
      mission_content_sha256: tip.mission.content_sha256,
      result: { status: "repair", failing_component: "applied bundle" },
      ...planBinding,
    };
  }
  return {
    mission_content_sha256: tip.mission.content_sha256,
    result: {
      status: "applied",
      result_content_sha256: tip.result.result_content_sha256,
      result,
    },
    ...planBinding,
  };
}

function shapingRunSummaryFromListing(
  phase: ShapingPhase,
  listing: ShapingArtifactListing,
): ShapingRunSummary | null {
  const tip = currentShapingTip(phase, listing.artifacts);
  if (tip === null) {
    return null;
  }
  const runs = listing.runs
    .filter(
      (run) =>
        run.mission.phase === phase &&
        run.mission.input_sha256 === tip.mission.identity.input_sha256 &&
        run.mission.content_sha256 === tip.mission.content_sha256,
    )
    .sort((left, right) =>
      left.lifecycle.started_at.localeCompare(right.lifecycle.started_at),
    );
  const run = runs.at(-1);
  return run ?? null;
}

function shapingRunFromListing(
  phase: ShapingPhase,
  listing: ShapingArtifactListing,
): ShapingSurfaceContext["run"] {
  const run = shapingRunSummaryFromListing(phase, listing);
  if (run === null) {
    return null;
  }
  return {
    shaping_run_id: run.shaping_run_id,
    status: run.lifecycle.status,
    terminal_outcome: run.lifecycle.terminal_outcome,
    latest_update: null,
    sanitized_reason: null,
    denied_operation_kind: null,
    timeout_limit: null,
  };
}

function shapingRefreshBindingForState(
  item: PortfolioWorkItem,
  state: ShapingArtifactState,
): ShapingRefreshBinding | null {
  const phase = item.work_item.state.phase;
  if (!isShapingPhase(phase)) {
    return null;
  }
  const tip = currentShapingTip(phase, state.listing?.artifacts ?? []);
  const run =
    state.listing === null
      ? null
      : shapingRunSummaryFromListing(phase, state.listing);
  if (tip === null || run === null) {
    return null;
  }
  const workItemId = item.work_item.goal.work_item_id;
  const missionContentSha256 = tip.mission.content_sha256;
  return {
    identity: JSON.stringify([
      item.source_id,
      workItemId,
      phase,
      missionContentSha256,
      run.shaping_run_id,
    ]),
    itemKey: state.itemKey,
    item,
    sourceId: item.source_id,
    workItemId,
    phase,
    missionContentSha256,
    shapingRunId: run.shaping_run_id,
    observation: {
      work_item_id: workItemId,
      run_status: run.lifecycle.status,
      updated_at: run.lifecycle.updated_at,
    },
  };
}

function shapingSurfaceContext(
  item: PortfolioWorkItem,
  state: ShapingArtifactState,
  launchFailure: ShapingLaunchFailureState | null,
  newAttempt: ShapingNewAttemptState | null,
  refresh: ShapingRefreshProjection | null = null,
): ShapingSurfaceContext | null {
  const phase = item.work_item.state.phase;
  const listing = state.listing;
  if (
    listing === null ||
    (phase !== "idea" && !isShapingPhase(phase))
  ) {
    return null;
  }
  const shapingPhase = isShapingPhase(phase) ? phase : null;
  const localLaunchFailure =
    launchFailure?.itemKey === state.itemKey ? launchFailure : null;
  const durableLaunchFailure = listing.post_commit_launch_failure;
  const run =
    shapingPhase === null
      ? null
      : shapingRunFromListing(shapingPhase, listing);
  const projectedLaunchFailure =
    durableLaunchFailure === null
      ? localLaunchFailure
      : {
          itemKey: state.itemKey,
          decision_id: durableLaunchFailure.decision_id,
          locked_model: durableLaunchFailure.locked_model,
          reason:
            localLaunchFailure?.decision_id ===
            durableLaunchFailure.decision_id
              ? localLaunchFailure.reason
              : durableLaunchFailure.reason,
        };
  const selectingNewAttempt =
    projectedLaunchFailure !== null &&
    newAttempt?.itemKey === state.itemKey &&
    newAttempt.decision_id === projectedLaunchFailure.decision_id;
  const currentLaunchFailure =
    run !== null || selectingNewAttempt
      ? null
      : projectedLaunchFailure;
  return {
    expected_shaping_state_sha256:
      listing.expected_shaping_state_sha256,
    revision:
      shapingPhase === null
        ? null
        : shapingRevisionFromListing(shapingPhase, listing),
    run,
    models: {
      status: listing.model_availability.status,
      reason: listing.model_availability.reason,
      available_model_ids: listing.model_availability.available_model_ids,
      model_use: listing.model_use,
      model_picker_options: listing.model_picker_options,
      execute: {
        status: listing.execute_model_availability.status,
        reason: listing.execute_model_availability.reason,
        available_model_ids:
          listing.execute_model_availability.available_model_ids,
      },
    },
    derived_goal_contract_sha256: state.derivedGoalContractSha256,
    current_goal_contract_sha256: state.currentGoalContractSha256,
    post_commit_launch_failure:
      currentLaunchFailure === null
        ? null
        : {
            manifest_outcome: "applied",
            decision_id: currentLaunchFailure.decision_id,
            locked_model: currentLaunchFailure.locked_model,
            reason: currentLaunchFailure.reason,
          },
    ...(refresh === null ? {} : { refresh }),
  };
}

function shapingItemStateKey(item: PortfolioWorkItem): string {
  const { goal, state } = item.work_item;
  return JSON.stringify([
    item.source_id,
    goal.work_item_id,
    state.schema_version,
    state.phase,
    state.status,
    state.goal_version ?? null,
    state.input_revision ?? null,
    goal.title,
    goal.notes ?? null,
    goal.goal_contract ?? null,
  ]);
}

interface PlanApprovalExecuteHandoff {
  stopShapingRefresh: () => void;
  clearShapingRefreshIdentity: () => void;
  clearShapingRefreshBinding: () => void;
  setShapingLaunchFailureState: (value: null) => void;
  setShapingNewAttemptState: (value: null) => void;
  setShowFullWorkItem: (value: false) => void;
}

export function clearShapingStateForExecuteHandoff({
  stopShapingRefresh,
  clearShapingRefreshIdentity,
  clearShapingRefreshBinding,
  setShapingLaunchFailureState,
  setShapingNewAttemptState,
  setShowFullWorkItem,
}: PlanApprovalExecuteHandoff): void {
  stopShapingRefresh();
  clearShapingRefreshIdentity();
  clearShapingRefreshBinding();
  setShapingLaunchFailureState(null);
  setShapingNewAttemptState(null);
  setShowFullWorkItem(false);
}

interface ReviewImportDriftRecoverySuccessTransition<T> {
  itemKey: string;
  sourceId: string;
  workItemId: string;
  updatedItem: T;
  setRecoveryState: (value: ReviewImportDriftRecoveryState) => void;
  clearReviewMissionImportState: (value: null) => void;
  markRunEvidenceLoading: () => void;
  loadRunEvidence: () => Promise<void>;
  onUpdated: (item: T, message: string) => void;
}

export async function completeReviewImportDriftRecoverySuccess<T>({
  itemKey,
  sourceId,
  workItemId,
  updatedItem,
  setRecoveryState,
  clearReviewMissionImportState,
  markRunEvidenceLoading,
  loadRunEvidence,
  onUpdated,
}: ReviewImportDriftRecoverySuccessTransition<T>): Promise<void> {
  setRecoveryState({
    itemKey,
    listing: {
      source_id: sourceId,
      work_item_id: workItemId,
      proposal: null,
    },
    loading: false,
    error: null,
  });
  clearReviewMissionImportState(null);
  markRunEvidenceLoading();
  await loadRunEvidence();
  onUpdated(
    updatedItem,
    "Exact drift accepted; the clean Review result is ready for approval.",
  );
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs} ms`;
  }
  if (durationMs < 60_000) {
    const seconds = durationMs / 1_000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes} min ${seconds} s`;
}

function runDuration(entry: StoredImportEvidence): string {
  return formatDuration(
    Math.max(
      0,
      new Date(entry.evidence.completed_at).getTime() -
        new Date(entry.evidence.started_at).getTime(),
    ),
  );
}

function outcomeLabel(outcome: ImportEvidenceOutcome): string {
  return `${outcome[0]?.toUpperCase()}${outcome.slice(1)}`;
}

function outcomeClassName(outcome: ImportEvidenceOutcome): string {
  return outcome === "applied" ? "text-success" : "text-destructive";
}

function findingSeverityClassName(severity: ReviewFinding["severity"]): string {
  if (severity === "P0" || severity === "P1") {
    return "text-destructive";
  }
  if (severity === "P2") {
    return "text-[var(--chart-3)]";
  }
  return "text-muted-foreground";
}

function findingLinkLabel(link: ReviewFinding["link"]): string {
  switch (link.type) {
    case "acceptance_criteria":
      return `Acceptance criterion · ${link.criterion}`;
    case "non_goals":
      return `Non-goal · ${link.non_goal}`;
    case "defect":
      return `Defect · ${link.evidence_summary}`;
    case "security":
      return `Security · ${link.evidence_summary}`;
    case "deterministic_checks":
      return `Deterministic check · ${link.command}`;
  }
}

function commandStatusClassName(status: CommandEvidenceRecord["status"]): string {
  if (status === "passed") {
    return "text-success";
  }
  if (status === "not_run") {
    return "text-muted-foreground";
  }
  return "text-destructive";
}

function commandExitLabel(command: CommandEvidenceRecord): string {
  if (command.signal !== null) {
    return `Signal ${command.signal}`;
  }
  if (command.exit_code !== null) {
    return `Exit ${command.exit_code}`;
  }
  return command.status === "not_run" ? "Not run" : "No exit code";
}

export function RunEvidenceSection({
  fieldId,
  evidence,
  loading,
  error,
  expandedRunIds,
  onToggle,
}: RunEvidenceSectionProps) {
  return (
    <section
      aria-labelledby={`${fieldId}-run-evidence`}
      className="border-y py-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id={`${fieldId}-run-evidence`} className="text-xs font-medium">
            Run evidence
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Immutable imported results and deterministic command records.
          </p>
        </div>
        {loading && evidence.length > 0 ? (
          <span className="text-[11px] text-muted-foreground" role="status">
            Refreshing…
          </span>
        ) : null}
      </div>

      {error ? (
        <p
          className="mt-3 border-l-2 border-destructive bg-destructive/10 px-3 py-2 text-xs text-foreground"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {loading && evidence.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground" role="status">
          Loading run evidence…
        </p>
      ) : null}

      {!loading && error === null && evidence.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No imported runs yet.
        </p>
      ) : null}

      {evidence.length > 0 ? (
        <div className="mt-3 space-y-2">
          {evidence.map((entry, index) => {
            const { evidence: run, verification, submission } = entry;
            const evidenceKey = `${run.phase}:${run.import_run_id}`;
            const expanded = expandedRunIds.has(evidenceKey);
            const detailsId = `${fieldId}-run-${run.phase}-${run.import_run_id}`;
            const shortRunId = run.import_run_id.slice(0, 12);
            const reviewSubmission =
              submission && "review_mission_content_sha256" in submission
                ? submission
                : null;

            return (
              <article key={evidenceKey} className="border bg-background">
                <div className="p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
                          {run.phase === "execute"
                            ? "Execute"
                            : run.phase === "review"
                              ? "Review"
                              : "Patch"}
                        </span>
                        <span
                          className={`text-xs font-medium ${outcomeClassName(run.outcome)}`}
                        >
                          {outcomeLabel(run.outcome)}
                        </span>
                        {index === 0 ? (
                          <span className="rounded-sm border px-1.5 py-0.5 text-[10px] font-medium tracking-[0.04em] text-muted-foreground uppercase">
                            Latest
                          </span>
                        ) : null}
                      </div>
                      <p
                        className="mt-1 truncate text-[11px] text-muted-foreground"
                        title={run.result_commit ?? undefined}
                      >
                        {run.result_commit === null
                          ? "No result commit"
                          : `${run.phase === "review" ? "Subject" : "Result"} commit · ${run.result_commit.slice(0, 12)}`}
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={detailsId}
                      aria-label={`${expanded ? "Collapse" : "Expand"} ${outcomeLabel(run.outcome).toLowerCase()} run ${shortRunId}`}
                      onClick={() => onToggle(run.phase, run.import_run_id)}
                      className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border bg-secondary px-2.5 text-[11px] font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    >
                      {expanded ? "Hide details" : "View details"}
                      <ChevronDown
                        className={`size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
                        strokeWidth={1.75}
                        aria-hidden="true"
                      />
                    </button>
                  </div>

                  <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
                    <div>
                      <dt className="text-muted-foreground">Governed identity</dt>
                      <dd className="mt-0.5">
                        Goal {run.identity.goal_version} · Revision{" "}
                        {run.identity.input_revision} · Attempt {run.identity.attempt}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Completed</dt>
                      <dd className="mt-0.5">
                        {runCompletedAtFormatter.format(new Date(run.completed_at))}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Duration</dt>
                      <dd className="mt-0.5">{runDuration(entry)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Telemetry</dt>
                      <dd className="mt-0.5">unknown</dd>
                    </div>
                  </dl>
                </div>

                {expanded ? (
                  <div id={detailsId} className="space-y-4 border-t px-3 py-3">
                    {run.reasons.length > 0 ? (
                      <div>
                        <h4 className="text-[11px] font-medium text-muted-foreground">
                          Reasons
                        </h4>
                        <ul className="mt-2 space-y-1.5 text-xs leading-5">
                          {run.reasons.map((reason, reasonIndex) => (
                            <li
                              key={`${evidenceKey}:reason:${reasonIndex}`}
                              className="border-l-2 border-destructive pl-2.5"
                            >
                              {reason}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {run.phase === "review" ? (
                      <div>
                        <h4 className="text-[11px] font-medium text-muted-foreground">
                          Review result
                        </h4>
                        {reviewSubmission === null ? (
                          <p className="mt-2 text-xs text-muted-foreground">
                            Structured review output is unavailable for this rejected import.
                          </p>
                        ) : (
                          <div className="mt-2 space-y-3">
                            <div className="border-l-2 border-border bg-muted/40 px-3 py-2.5">
                              <div className="flex items-center justify-between gap-3">
                                <span className="text-xs font-medium">Verdict</span>
                                <span
                                  className={`text-xs font-medium ${
                                    reviewSubmission.verdict === "clean"
                                      ? "text-success"
                                      : "text-destructive"
                                  }`}
                                >
                                  {reviewSubmission.verdict === "clean"
                                    ? "Clean"
                                    : `${reviewSubmission.findings.length} finding${reviewSubmission.findings.length === 1 ? "" : "s"}`}
                                </span>
                              </div>
                              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                                {reviewSubmission.summary}
                              </p>
                            </div>
                            {reviewSubmission.findings.map((finding) => (
                              <article
                                key={`${evidenceKey}:${finding.finding_id}`}
                                className="border-l-2 border-border px-3 py-2.5"
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div>
                                    <p className="text-xs font-medium">
                                      {finding.title}
                                    </p>
                                    <p className="mt-1 text-[11px] text-muted-foreground">
                                      {findingLinkLabel(finding.link)}
                                    </p>
                                  </div>
                                  <span
                                    className={`shrink-0 text-[11px] font-semibold ${findingSeverityClassName(finding.severity)}`}
                                  >
                                    {finding.severity}
                                  </span>
                                </div>
                                <p className="mt-2 text-xs leading-5">
                                  {finding.evidence.summary}
                                </p>
                                {finding.evidence.path ? (
                                  <p className="mt-1 break-all text-[11px] text-muted-foreground">
                                    {finding.evidence.path}
                                  </p>
                                ) : null}
                                <div className="mt-2 border-t pt-2">
                                  <p className="text-[10px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
                                    Required action
                                  </p>
                                  <p className="mt-1 text-xs leading-5">
                                    {finding.required_action}
                                  </p>
                                </div>
                              </article>
                            ))}
                          </div>
                        )}
                        <p className="mt-3 text-[11px] leading-5 text-muted-foreground">
                          No commands were rerun during review import.
                        </p>
                      </div>
                    ) : (
                      <div>
                        <h4 className="text-[11px] font-medium text-muted-foreground">
                          Commands
                        </h4>
                        {verification.length === 0 ? (
                          <p className="mt-2 text-xs text-muted-foreground">
                            No verification commands recorded.
                          </p>
                        ) : (
                          <div className="mt-2 space-y-3">
                            {verification.map((command, commandIndex) => (
                              <div
                                key={`${evidenceKey}:command:${commandIndex}`}
                                className="border-l-2 border-border bg-muted/40 px-3 py-2.5"
                              >
                              <div className="flex items-center justify-between gap-3 text-xs">
                                <span className="font-medium">{command.name}</span>
                                <span className={commandStatusClassName(command.status)}>
                                  {command.status.replaceAll("_", " ")}
                                </span>
                              </div>
                              <p className="mt-1 break-all text-[11px] leading-5 text-muted-foreground">
                                {command.argv.join(" ")}
                              </p>
                              <p className="mt-1 text-[11px] text-muted-foreground">
                                {formatDuration(command.duration_ms)} · {commandExitLabel(command)}
                              </p>
                              {command.output_truncated ? (
                                <p className="mt-2 text-[11px] text-destructive">
                                  Captured output was truncated.
                                </p>
                              ) : null}
                              <div className="mt-3 space-y-3">
                                <div>
                                  <p className="text-[11px] font-medium text-muted-foreground">
                                    stdout
                                  </p>
                                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words border bg-background p-2 text-[11px] leading-5">
                                    {command.stdout || "No stdout recorded."}
                                  </pre>
                                </div>
                                <div>
                                  <p className="text-[11px] font-medium text-muted-foreground">
                                    stderr
                                  </p>
                                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words border bg-background p-2 text-[11px] leading-5">
                                    {command.stderr || "No stderr recorded."}
                                  </pre>
                                </div>
                              </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

type ShapingMutation = "compiling" | "importing";
type ShapingCopyTarget = "task" | "mission" | "workspace" | "content_sha256";
type ShapingCompilation =
  | BrainstormMissionCompilation
  | SpecMissionCompilation
  | PlanMissionCompilation;

export interface ShapingAdvancedRecoveryViewState {
  identity: string;
  phase: ShapingPhase | null;
  preparationEnabled: boolean;
  currentTaskPath: string | null;
  compilation: ShapingCompilation | null;
  copiedCompilationTarget: ShapingCopyTarget | null;
  manualRecovery: ShapingManualRecoveryUiState | null;
  run: ShapingRunSummary | null;
  compiling: boolean;
}

interface ShapingSectionProps {
  fieldId: string;
  projection: Extract<ShapingHandoffProjection, { mode: "active" }>;
  artifacts: ShapingArtifactListing["artifacts"];
  loading: boolean;
  error: string | null;
  selectedAcceptanceSha256: string;
  mutation: ShapingMutation | null;
  compilation: ShapingCompilation | null;
  imported: ShapingImportResult | null;
  copiedTarget: ShapingCopyTarget | null;
  onSelectAcceptance: (acceptanceContentSha256: string) => void;
  onCompile: () => void;
  onImport: () => void;
  onCopy: (target: ShapingCopyTarget, value: string) => void;
  onUseProposal: (proposal: SpecResultSubmission["proposal"]) => void;
}

const SHAPING_PHASE_COPY = {
  brainstorm: {
    heading: "Brainstorm shaping",
    description:
      "Compile an external shaping brief, inspect its evidence, then explicitly select the input you want to carry forward.",
  },
  spec: {
    heading: "Spec shaping",
    description:
      "Choose an accepted Brainstorm input, compile the Spec brief, and inspect its proposal before filling the editor.",
  },
  plan: {
    heading: "Plan shaping",
    description:
      "Compile the exact approved contract into a Plan brief, then inspect the returned checklist.",
  },
} as const satisfies Record<ShapingPhase, { heading: string; description: string }>;

interface AcceptedBrainstormChoice {
  artifact: StoredShapingArtifact;
  result: BrainstormResultSubmission;
  acceptanceContentSha256: string;
}

function isBrainstormResult(
  result: ShapingResultSubmission | undefined,
): result is BrainstormResultSubmission {
  return result?.identity.phase === "brainstorm";
}

function isSpecResult(
  result: ShapingResultSubmission | undefined,
): result is SpecResultSubmission {
  return result?.identity.phase === "spec";
}

function acceptedBrainstormChoice(
  artifact: StoredShapingArtifact,
): AcceptedBrainstormChoice | null {
  if (
    artifact.mission.identity.phase !== "brainstorm" ||
    artifact.result === null ||
    artifact.import_receipt?.outcome !== "applied" ||
    artifact.decision === null ||
    artifact.decision.receipt.identity.phase !== "brainstorm" ||
    !("selected_at" in artifact.decision.receipt)
  ) {
    return null;
  }

  try {
    const result = JSON.parse(artifact.result.result_source) as unknown;
    if (
      typeof result !== "object" ||
      result === null ||
      !("identity" in result) ||
      typeof result.identity !== "object" ||
      result.identity === null ||
      !("phase" in result.identity) ||
      result.identity.phase !== "brainstorm" ||
      !("problem_statement" in result) ||
      typeof result.problem_statement !== "string" ||
      !("approach" in result) ||
      typeof result.approach !== "string" ||
      !("non_goals" in result) ||
      !Array.isArray(result.non_goals) ||
      !("open_questions" in result) ||
      !Array.isArray(result.open_questions)
    ) {
      return null;
    }

    return {
      artifact,
      result: result as BrainstormResultSubmission,
      acceptanceContentSha256:
        artifact.decision.decision_content_sha256,
    };
  } catch {
    return null;
  }
}

function ShapingMissionHandoff({
  compilation,
  copiedTarget,
  onCopy,
}: {
  compilation: ShapingCompilation;
  copiedTarget: ShapingCopyTarget | null;
  onCopy: ShapingSectionProps["onCopy"];
}) {
  const copyRows: readonly {
    target: ShapingCopyTarget;
    label: string;
    value: string;
  }[] = [
    { target: "task", label: "TASK.md", value: compilation.task_path },
    {
      target: "mission",
      label: "Mission JSON",
      value: compilation.mission_path,
    },
    {
      target: "workspace",
      label: "Workspace",
      value: compilation.workspace_path,
    },
    {
      target: "content_sha256",
      label: "Content SHA",
      value: compilation.mission.content_sha256,
    },
  ];

  return (
    <div className="mt-4 border-l-2 border-border bg-background px-3 py-3">
      <p className="text-[10px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
        Immutable mission handoff
      </p>
      <dl className="mt-3 space-y-3 text-xs">
        {copyRows.map((row) => (
          <div key={row.target}>
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="mt-1 flex items-start justify-between gap-3">
              <span className="min-w-0 break-all text-[11px] leading-5">
                {row.value}
              </span>
              <button
                type="button"
                onClick={() => onCopy(row.target, row.value)}
                aria-label={`Copy ${row.label}`}
                className="h-9 shrink-0 rounded-md border bg-secondary px-3 text-[11px] font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                {copiedTarget === row.target ? "Copied" : "Copy"}
              </button>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ShapingStringList({
  values,
  emptyLabel,
}: {
  values: readonly string[];
  emptyLabel: string;
}) {
  return values.length > 0 ? (
    <ul className="mt-1 space-y-1 text-xs leading-5">
      {values.map((value) => (
        <li key={value} className="border-l-2 border-border pl-2">
          {value}
        </li>
      ))}
    </ul>
  ) : (
    <p className="mt-1 text-xs text-muted-foreground">{emptyLabel}</p>
  );
}

function BrainstormEvidence({ result }: { result: BrainstormResultSubmission }) {
  return (
    <article className="mt-4 border bg-muted/30 px-3 py-3">
      <p className="text-[10px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
        Imported Brainstorm evidence
      </p>
      <div className="mt-3 space-y-4">
        <section>
          <h4 className="text-[11px] font-medium text-muted-foreground">
            Evidence · Problem statement
          </h4>
          <p className="mt-1 text-xs leading-5">{result.problem_statement}</p>
        </section>
        <section>
          <h4 className="text-[11px] font-medium text-muted-foreground">
            Evidence · Approach
          </h4>
          <p className="mt-1 text-xs leading-5">{result.approach}</p>
        </section>
        <section>
          <h4 className="text-[11px] font-medium text-muted-foreground">
            Evidence · Non-goals
          </h4>
          <ShapingStringList
            values={result.non_goals}
            emptyLabel="No non-goals proposed."
          />
        </section>
        <section>
          <h4 className="text-[11px] font-medium text-muted-foreground">
            Evidence · Open questions
          </h4>
          <ShapingStringList
            values={result.open_questions}
            emptyLabel="No open questions proposed."
          />
        </section>
      </div>
    </article>
  );
}

function SpecProposal({
  result,
  onUseProposal,
}: {
  result: SpecResultSubmission;
  onUseProposal: ShapingSectionProps["onUseProposal"];
}) {
  const proposal = result.proposal;
  return (
    <article className="mt-4 border bg-muted/30 px-3 py-3">
      <p className="text-[10px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
        Imported Spec proposal
      </p>
      <div className="mt-3 space-y-4">
        <section>
          <h4 className="text-[11px] font-medium text-muted-foreground">
            Proposal · Purpose
          </h4>
          <p className="mt-1 text-xs leading-5">{proposal.purpose}</p>
        </section>
        {(
          [
            ["Acceptance criteria", proposal.acceptance_criteria],
            ["Non-goals", proposal.non_goals],
            ["Allowed scope", proposal.allowed_scope],
            ["Review ready", proposal.review_ready],
          ] as const
        ).map(([label, values]) => (
          <section key={label}>
            <h4 className="text-[11px] font-medium text-muted-foreground">
              Proposal · {label}
            </h4>
            <ShapingStringList
              values={values}
              emptyLabel={`No ${label.toLocaleLowerCase()} proposed.`}
            />
          </section>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onUseProposal(proposal)}
        className="mt-4 h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        Use proposal as draft
      </button>
      <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
        Fills the local editor only. Save remains the single durable action.
      </p>
    </article>
  );
}

interface ReviewImportDriftRecoverySectionProps {
  fieldId: string;
  proposal: ReviewImportDriftRecoveryProposalV1;
  applying: boolean;
  onApply: () => void;
}

export function ReviewImportDriftRecoverySection({
  fieldId,
  proposal,
  applying,
  onApply,
}: ReviewImportDriftRecoverySectionProps) {
  const subjectFiles = new Set(proposal.subject_changed_files);

  return (
    <section
      aria-labelledby={`${fieldId}-review-import-drift-recovery`}
      className="border-l-2 border-amber-500 bg-amber-500/10 px-3 py-3"
    >
      <h3
        id={`${fieldId}-review-import-drift-recovery`}
        className="text-xs font-medium"
      >
        Review import drift requires approval
      </h3>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        The clean Review result was rejected because HEAD moved after its
        accepted subject. Approval reassesses that retained result against this
        exact clean descendant drift; the rejected import evidence remains
        immutable.
      </p>
      <dl className="mt-3 space-y-3 text-[11px]">
        <div>
          <dt className="font-medium text-muted-foreground">Accepted subject</dt>
          <dd className="mt-1 break-all font-mono">
            {proposal.accepted_result_commit}
          </dd>
        </div>
        <div>
          <dt className="font-medium text-muted-foreground">Current HEAD</dt>
          <dd className="mt-1 break-all font-mono">
            {proposal.current_head_commit}
          </dd>
        </div>
        <div>
          <dt className="font-medium text-muted-foreground">
            Retained clean result SHA
          </dt>
          <dd className="mt-1 break-all font-mono">
            {proposal.result_content_sha256}
          </dd>
        </div>
        <div>
          <dt className="font-medium text-muted-foreground">
            Prior rejected evidence
          </dt>
          <dd className="mt-1 break-all font-mono">
            {proposal.rejected_import_evidence_path}
          </dd>
        </div>
      </dl>
      <div className="mt-3">
        <p className="text-[11px] font-medium text-muted-foreground">
          Exact post-subject changed files
        </p>
        <ul className="mt-1 space-y-1 text-[11px]">
          {proposal.changed_files.map((path) => (
            <li key={path} className="break-all font-mono">
              {path}
              {subjectFiles.has(path) ? (
                <span className="ml-2 font-sans text-amber-700 dark:text-amber-300">
                  Touches the reviewed subject
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      <p className="mt-3 break-all text-[11px] text-muted-foreground">
        Proposal SHA: <span className="font-mono">{proposal.proposal_sha256}</span>
      </p>
      <button
        type="button"
        data-primary-action="true"
        disabled={applying}
        onClick={onApply}
        className="mt-3 h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        {applying
          ? "Reassessing exact drift…"
          : "Accept exact drift & reassess Review"}
      </button>
    </section>
  );
}

export function ShapingSection({
  fieldId,
  projection,
  artifacts,
  loading,
  error,
  selectedAcceptanceSha256,
  mutation,
  compilation,
  imported,
  copiedTarget,
  onSelectAcceptance,
  onCompile,
  onImport,
  onCopy,
  onUseProposal,
}: ShapingSectionProps) {
  const busy = mutation !== null;
  const phaseCopy = SHAPING_PHASE_COPY[projection.phase];
  const acceptedChoices = artifacts
    .map(acceptedBrainstormChoice)
    .filter((choice): choice is AcceptedBrainstormChoice => choice !== null);
  const selectedChoice = acceptedChoices.find(
    (choice) =>
      choice.acceptanceContentSha256 === selectedAcceptanceSha256,
  );
  const staleSelection =
    projection.phase === "spec" &&
    selectedAcceptanceSha256.length > 0 &&
    selectedChoice === undefined;
  const importedResult =
    imported?.outcome === "applied" ? imported.result : undefined;
  const brainstormResult = isBrainstormResult(importedResult)
    ? importedResult
    : null;
  const specResult = isSpecResult(importedResult) ? importedResult : null;
  const rejectedImport = imported?.outcome === "rejected" ? imported : null;
  const canCompileSpec =
    projection.phase !== "spec" || selectedChoice !== undefined;

  return (
    <section
      aria-labelledby={`${fieldId}-shaping`}
      className="border-y py-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id={`${fieldId}-shaping`} className="text-xs font-medium">
            {phaseCopy.heading}
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {phaseCopy.description}
          </p>
        </div>
        <span className="shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
          Active
        </span>
      </div>

      {error ? (
        <p
          className="mt-3 border-l-2 border-destructive bg-destructive/10 px-3 py-2 text-xs leading-5"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="mt-3 text-xs text-muted-foreground" role="status">
          Loading shaping history…
        </p>
      ) : null}

      {!loading && error === null && artifacts.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No shaping artifacts yet.
        </p>
      ) : null}

      {projection.phase === "spec" ? (
        <fieldset className="mt-4" disabled={busy}>
          <legend className="text-[11px] font-medium text-muted-foreground">
            Accepted Brainstorm input
          </legend>
          {acceptedChoices.length === 0 ? (
            <p className="mt-2 border-l-2 border-border bg-background px-3 py-2.5 text-xs leading-5 text-muted-foreground">
              No accepted Brainstorm results are available. Return to Brainstorm
              and explicitly accept one before compiling a Spec mission.
            </p>
          ) : (
            <div className="mt-2 space-y-2">
              {acceptedChoices.map((choice) => (
                <label
                  key={choice.acceptanceContentSha256}
                  className="flex cursor-pointer items-start gap-2.5 border bg-background px-3 py-2.5 text-xs has-checked:border-primary"
                >
                  <input
                    type="radio"
                    name={`${fieldId}-brainstorm-acceptance`}
                    value={choice.acceptanceContentSha256}
                    checked={
                      choice.acceptanceContentSha256 ===
                      selectedAcceptanceSha256
                    }
                    onChange={() =>
                      onSelectAcceptance(choice.acceptanceContentSha256)
                    }
                    className="mt-0.5 accent-primary"
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">
                      {choice.result.problem_statement}
                    </span>
                    <span className="mt-1 block leading-5 text-muted-foreground">
                      Evidence · {choice.result.approach}
                    </span>
                    <span className="mt-1 block break-all text-[10px] text-muted-foreground">
                      Acceptance · {choice.acceptanceContentSha256}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
      ) : null}

      {staleSelection ? (
        <p
          className="mt-3 border-l-2 border-destructive bg-destructive/10 px-3 py-2 text-xs leading-5"
          role="alert"
        >
          The selected Brainstorm acceptance is stale or unavailable. Choose an
          accepted result from the current history.
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || !canCompileSpec}
          onClick={onCompile}
          className="h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {mutation === "compiling"
            ? "Compiling…"
            : `Compile ${shapingPhaseLabel(projection.phase)} mission`}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onImport}
          className="h-9 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {mutation === "importing" ? "Importing…" : "Import result"}
        </button>
      </div>

      {rejectedImport !== null ? (
        <div
          className="mt-4 border-l-2 border-destructive bg-destructive/10 px-3 py-3 text-xs"
          role="alert"
        >
          <p className="font-medium">Imported result rejected</p>
          <ShapingStringList
            values={rejectedImport.rejection.reasons.map(
              (reason) => `${reason.field_path}: ${reason.code}`,
            )}
            emptyLabel="The result did not satisfy the shaping contract."
          />
        </div>
      ) : null}

      {brainstormResult ? <BrainstormEvidence result={brainstormResult} /> : null}
      {specResult ? (
        <SpecProposal result={specResult} onUseProposal={onUseProposal} />
      ) : null}

      {compilation ? (
        <ShapingMissionHandoff
          compilation={compilation}
          copiedTarget={copiedTarget}
          onCopy={onCopy}
        />
      ) : null}
    </section>
  );
}

function shapingPhaseLabel(phase: WorkflowModelSeat): string {
  return `${phase[0]?.toUpperCase()}${phase.slice(1)}`;
}

function projectionPicker(
  projection: DecisionFirstShapingHandoffProjection,
): ShapingModelPickerProjection<WorkflowModelSeat> | null {
  if (
    projection.mode === "idea" ||
    projection.mode === "pre_ready" ||
    projection.mode === "terminal_run_failure" ||
    projection.mode === "plan_result_superseded"
  ) {
    return "model_picker" in projection
      ? projection.model_picker ?? null
      : null;
  }
  if (
    projection.mode === "ready" &&
    "next_step" in projection.sections
  ) {
    return projection.sections.next_step ?? null;
  }
  return null;
}

export function selectedModelForShapingPicker(
  picker: ShapingModelPickerProjection<WorkflowModelSeat> | null,
  storedModel: string | null,
): string | null {
  if (picker === null) {
    return null;
  }

  const preferredModel = storedModel ?? picker.selected_model;
  if (
    preferredModel !== null &&
    picker.options.some((option) => option.model_id === preferredModel)
  ) {
    return preferredModel;
  }

  return picker.options[0]?.model_id ?? null;
}

export function canEditGoalContractFromFullWorkItem(
  phase: WorkItemPhase,
  hasGoalContract: boolean,
): boolean {
  return (
    canUpdateGoalContract(phase) &&
    (phase !== "idea" || hasGoalContract)
  );
}

function projectionRuntimeUnavailable(
  projection: DecisionFirstShapingHandoffProjection,
): string | null {
  if (
    projection.mode === "ready" &&
    "runtime_unavailable" in projection.sections
  ) {
    return projection.sections.runtime_unavailable ?? null;
  }
  return "runtime_unavailable" in projection
    ? projection.runtime_unavailable ?? null
    : null;
}

function projectionStatus(
  projection: DecisionFirstShapingHandoffProjection,
): { headline: string; copy: string; tone: "ready" | "active" | "error" } {
  switch (projection.mode) {
    case "ready":
      return {
        headline: projection.lifecycle.headline,
        copy: projection.lifecycle.copy,
        tone: "ready",
      };
    case "idea":
      return {
        headline: projection.headline,
        copy: "Choose the Brainstorm seat, then start one exact shaping attempt.",
        tone: "active",
      };
    case "pre_ready":
      return {
        headline: projection.headline,
        copy: projection.copy,
        tone: "active",
      };
    case "run_state":
    case "terminal_run_failure":
    case "repair":
      return {
        headline: projection.lifecycle.headline,
        copy: projection.lifecycle.copy,
        tone:
          projection.mode === "run_state" ? "active" : "error",
      };
    case "post_commit_launch_failure":
      return {
        headline: `${shapingPhaseLabel(projection.phase)} launch failed`,
        copy: projection.reason,
        tone: "error",
      };
    case "manual_recovery":
      return {
        headline: `${shapingPhaseLabel(projection.phase)} manual recovery`,
        copy: "Prepare or import the current revision through the bounded manual path.",
        tone: "active",
      };
    case "plan_result_superseded":
      return {
        headline: "Plan result superseded",
        copy: projection.reason,
        tone: "error",
      };
    case "hidden":
      return { headline: "", copy: "", tone: "active" };
  }
}

function recoveryActions(
  projection: DecisionFirstShapingHandoffProjection,
): ShapingActionProjection[] {
  if (projection.mode === "hidden") {
    return [];
  }
  const candidates = [
    ...projection.actions,
    ...(projection.mode === "ready" ||
    projection.mode === "plan_result_superseded"
      ? projection.request_changes.actions
      : []),
  ].filter(
    (action) =>
      action.launch_mode === "manual" ||
      action.kind === "prepare_manual_recovery",
  );
  const seen = new Set<string>();
  return candidates.filter((action) => {
    const key = `${action.kind}:${action.launch_mode}:${action.label}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function PreviewText({
  preview,
  expanded,
  onExpand,
  compact = false,
}: {
  preview: ShapingTextPreview;
  expanded: boolean;
  onExpand: () => void;
  compact?: boolean;
}) {
  return (
    <>
      <p
        className={
          compact
            ? "mt-1 text-[11px] leading-[14px]"
            : "mt-1 text-sm leading-6"
        }
      >
        {expanded ? preview.full : preview.shown}
      </p>
      {preview.truncated ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onExpand}
          className={`${compact ? "mt-1 text-[11px] leading-[14px]" : "mt-2 text-xs"} font-medium text-primary hover:text-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary`}
        >
          {expanded ? "Show less" : preview.expander_label}
        </button>
      ) : null}
    </>
  );
}

function PreviewList({
  preview,
  expanded,
  onExpand,
  marker = "check",
  compact = false,
  hideMarker = false,
}: {
  preview: ShapingListPreview;
  expanded: boolean;
  onExpand: () => void;
  marker?: "check" | "question" | "plain";
  compact?: boolean;
  hideMarker?: boolean;
}) {
  const values = expanded
    ? preview.full
    : preview.shown.map((value) => value.shown);
  return (
    <>
      <ul
        className={
          compact
            ? "mt-1.5 space-y-1 text-[11px] leading-[14px]"
            : "mt-3 space-y-2.5 text-sm leading-5"
        }
      >
        {values.map((value, index) => (
          <li
            key={`${index}:${value}`}
            className={`flex items-start ${compact ? "gap-1.5" : "gap-2.5"}`}
          >
            {hideMarker ? null : (
              <span
                aria-hidden="true"
                className={`mt-0.5 grid shrink-0 place-items-center rounded-full border ${compact ? "size-3 text-[8px]" : "size-4 text-[10px]"} ${
                  marker === "question"
                    ? "border-primary text-primary"
                    : marker === "check"
                      ? "border-success text-success"
                      : "border-border text-muted-foreground"
                }`}
              >
                {marker === "question" ? "?" : marker === "check" ? "✓" : "·"}
              </span>
            )}
            <span>{value}</span>
          </li>
        ))}
      </ul>
      {preview.truncated ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onExpand}
          className={`${compact ? "mt-1 text-[11px] leading-[14px]" : "mt-3 text-xs"} font-medium text-primary hover:text-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary`}
        >
          {expanded ? "Show less" : preview.expander_label}
        </button>
      ) : null}
    </>
  );
}

function CompactSpecGovernedField({
  label,
  fieldKey,
  preview,
  expanded,
  onExpand,
}: {
  label: string;
  fieldKey: string;
  preview: ShapingListPreview;
  expanded: boolean;
  onExpand: () => void;
}) {
  return (
    <div data-spec-governed-field={fieldKey} className="min-w-0">
      <h4 className="text-[10px] font-medium text-muted-foreground uppercase">
        {label}
      </h4>
      <PreviewList
        preview={preview}
        expanded={expanded}
        onExpand={onExpand}
        marker="plain"
        compact
        hideMarker
      />
    </div>
  );
}

function PreviewChecklist({
  preview,
  expanded,
  onExpand,
}: {
  preview: ShapingChecklistPreview;
  expanded: boolean;
  onExpand: () => void;
}) {
  const entries = expanded
    ? preview.full.map((entry) => ({
        id: entry.id,
        step: entry.step,
        verification_check: entry.verification_check,
      }))
    : preview.shown.map((entry) => ({
        id: entry.id,
        step: entry.step.shown,
        verification_check: preview.truncated
          ? null
          : entry.verification_check.shown,
      }));
  return (
    <>
      <ol className="mt-3 space-y-3 text-sm">
        {entries.map((entry) => (
          <li key={entry.id} className="border-l-2 border-border pl-3">
            <p className="leading-5">
              <span className="font-medium">{entry.id}</span> · {entry.step}
            </p>
            {entry.verification_check === null ? null : (
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Verification · {entry.verification_check}
              </p>
            )}
          </li>
        ))}
      </ol>
      {preview.truncated ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onExpand}
          className="mt-3 text-xs font-medium text-primary hover:text-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {expanded ? "Show less" : preview.expander_label}
        </button>
      ) : null}
    </>
  );
}

function DecisionRegion({
  region,
  heading,
  children,
  compact = false,
}: {
  region: string;
  heading: string;
  children: ReactNode;
  compact?: boolean;
}) {
  return (
    <section
      data-region={region}
      className={`border-t px-5 ${compact ? "py-2" : "py-5"}`}
    >
      <h3 className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
        {heading}
      </h3>
      {children}
    </section>
  );
}

function ModelPicker({
  picker,
  selectedModel,
  busy,
  onSelectModel,
  compact = false,
}: {
  picker: ShapingModelPickerProjection<WorkflowModelSeat>;
  selectedModel: string;
  busy: boolean;
  onSelectModel: (model: string) => void;
  compact?: boolean;
}) {
  const selected = picker.options.find(
    (option) => option.model_id === selectedModel,
  );
  return (
    <>
      <select
        aria-label={`${shapingPhaseLabel(picker.seat)} model`}
        value={selectedModel}
        disabled={busy}
        onChange={(event) => onSelectModel(event.target.value)}
        className={`${compact ? "mt-2 h-8 text-xs" : "mt-3 h-10 text-sm"} w-full rounded-md border bg-background px-3 outline-none focus:border-primary focus:ring-1 focus:ring-primary`}
      >
        {picker.options.map((option) => (
          <option key={option.model_id} value={option.model_id}>
            {option.model_id}
            {option.current_revision ? " · current revision" : ""}
            {option.used_by_seats.length > 0
              ? ` · used by ${option.used_by_seats.join(", ")}`
              : " · unused"}
          </option>
        ))}
      </select>
      {picker.recommendation_note === null ? null : (
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {picker.recommendation_note}
        </p>
      )}
      {selected?.reuse_warning === null || selected?.reuse_warning === undefined ? null : (
        <p className="mt-2 border-l-2 border-[#e4b93f] bg-[#e4b93f]/10 px-3 py-2 text-xs leading-5">
          {selected.reuse_warning}
        </p>
      )}
    </>
  );
}

export interface ShapingDecisionViewProps {
  fieldId: string;
  projection: DecisionFirstShapingHandoffProjection;
  selectedModel: string | null;
  advancedRecovery?: ShapingAdvancedRecoveryViewState;
  requestChangesComposer: {
    launchMode: "connected" | "manual";
    feedback: string;
    selectedModel: string | null;
    error: string | null;
  } | null;
  retainedControllerLeaseRepair?: RetainedControllerLeaseRepairUiState | null;
  busy?: boolean;
  error?: string | null;
  onSelectModel: (model: string) => void;
  onAction: (action: ShapingActionProjection) => void;
  onOpenRequestChanges: (launchMode: "connected" | "manual") => void;
  onCloseRequestChanges: () => void;
  onChangeRequestChangesFeedback: (feedback: string) => void;
  onSelectRequestChangesModel: (model: string) => void;
  onSubmitRequestChanges: (
    action: ShapingActionProjection,
    feedback: string,
    selectedModel: string | null,
  ) => void;
  onAcknowledgeRetainedControllerLease: (acknowledged: boolean) => void;
  onRepairRetainedControllerLease: () => void;
  onCompileManualMission?: () => void;
  onPrepareManualRecovery?: () => void;
  onRetryManualRecovery?: () => void;
  onCopyManualRecovery?: (
    target: "task" | "instruction" | "ingress",
    value: string,
  ) => void;
  onImportManualResult?: () => void;
  onCopyManualCompilation?: (
    target: ShapingCopyTarget,
    value: string,
  ) => void;
  onRefreshStatus: () => void;
  onShowFullWorkItem: () => void;
}

export interface ShapingManualRecoveryActionCallbacks {
  prepare: (() => void) | undefined;
  retry: (() => void) | undefined;
  copyTask: ((value: string) => void) | undefined;
  importResult: (() => void) | undefined;
}

export function dispatchShapingManualRecoveryAction(
  action: ShapingActionProjection,
  task: string | null,
  callbacks: ShapingManualRecoveryActionCallbacks,
): boolean {
  switch (action.kind) {
    case "prepare_manual_recovery":
      callbacks.prepare?.();
      return callbacks.prepare !== undefined;
    case "retry_manual_recovery":
      callbacks.retry?.();
      return callbacks.retry !== undefined;
    case "copy_manual_task":
      if (task === null || callbacks.copyTask === undefined) {
        return false;
      }
      callbacks.copyTask(task);
      return true;
    case "import_manual_result":
      callbacks.importResult?.();
      return callbacks.importResult !== undefined;
    default:
      return false;
  }
}

export function ShapingDecisionView({
  fieldId,
  projection,
  selectedModel,
  advancedRecovery,
  requestChangesComposer,
  retainedControllerLeaseRepair = null,
  busy = false,
  error = null,
  onSelectModel,
  onAction,
  onOpenRequestChanges,
  onCloseRequestChanges,
  onChangeRequestChangesFeedback,
  onSelectRequestChangesModel,
  onSubmitRequestChanges,
  onAcknowledgeRetainedControllerLease,
  onRepairRetainedControllerLease,
  onCompileManualMission,
  onPrepareManualRecovery,
  onRetryManualRecovery,
  onCopyManualRecovery,
  onImportManualResult,
  onCopyManualCompilation,
  onRefreshStatus,
  onShowFullWorkItem,
}: ShapingDecisionViewProps) {
  const [expandedFields, setExpandedFields] = useState<Set<string>>(
    () => new Set(),
  );
  if (projection.mode === "hidden") {
    return null;
  }
  const status = projectionStatus(projection);
  const picker = projectionPicker(projection);
  const runtimeUnavailable = projectionRuntimeUnavailable(projection);
  const currentModel =
    selectedModelForShapingPicker(picker, selectedModel) ?? "";
  const primaryAction = projection.actions.find((action) => action.primary);
  const requestChangesAction = projection.actions.find(
    (action) =>
      action.kind === "request_changes" && action.launch_mode === null,
  );
  const requestChangesProjection =
    projection.mode === "ready" ||
    projection.mode === "plan_result_superseded"
      ? projection.request_changes
      : null;
  const requestChangesPicker =
    requestChangesProjection?.model_picker ?? null;
  const requestChangesModel =
    selectedModelForShapingPicker(
      requestChangesPicker,
      requestChangesComposer?.selectedModel ?? null,
    ) ?? "";
  const requestChangesLaunchMode =
    requestChangesPicker === null
      ? "manual"
      : requestChangesComposer?.launchMode;
  const requestChangesSubmitAction = requestChangesProjection?.actions.find(
    (action) =>
      action.kind === "request_changes" &&
      action.launch_mode === requestChangesLaunchMode,
  );
  const requestChangesOpen =
    requestChangesComposer !== null && requestChangesProjection !== null;
  const requestChangesSubmitDisabled =
    requestChangesComposer === null ||
    requestChangesSubmitAction === undefined ||
    busy ||
    !requestChangesSubmitAction.enabled ||
    requestChangesComposer.feedback.trim().length === 0 ||
    (requestChangesSubmitAction.launch_mode === "connected" &&
      requestChangesModel.length === 0);
  const cancelAction = projection.actions.find(
    (action) => action.kind === "cancel_run",
  );
  const lifecycle =
    "lifecycle" in projection ? projection.lifecycle : null;
  const refresh: ShapingRefreshProjection | null =
    "refresh" in projection ? projection.refresh ?? null : null;
  const refreshRunning = lifecycle?.refresh_running === true;
  const manualActions = recoveryActions(projection).filter(
    (action) =>
      action.kind !== "prepare_manual_recovery" &&
      (projection.mode === "idea" ||
        primaryAction === undefined ||
        action.kind !== primaryAction.kind ||
        action.launch_mode !== primaryAction.launch_mode ||
        action.label !== primaryAction.label) &&
      !(
        requestChangesOpen &&
        action.kind === "request_changes" &&
        action.launch_mode === "manual"
      ),
  );
  const manualRecovery =
    advancedRecovery?.manualRecovery?.recovery ??
    (projection.mode === "manual_recovery" ? projection.recovery : null);
  const preparePromoted =
    primaryAction?.kind === "prepare_manual_recovery";
  const footerPrimaryAction =
    preparePromoted && manualRecovery !== null ? undefined : primaryAction;
  const advancedRecoveryPhase =
    advancedRecovery?.phase ??
    (projection.mode === "idea" ? null : projection.phase);
  const prepareManualAction = recoveryActions(projection).find(
    (action) => action.kind === "prepare_manual_recovery",
  );
  const retryManualAction = projection.actions.find(
    (action) => action.kind === "retry_manual_recovery",
  );
  const copyManualAction = projection.actions.find(
    (action) => action.kind === "copy_manual_task",
  );
  const importManualAction = projection.actions.find(
    (action) => action.kind === "import_manual_result",
  );
  const preparedRecovery =
    advancedRecovery?.manualRecovery?.prepared ?? null;
  const importedRecovery =
    advancedRecovery?.manualRecovery?.imported ?? null;
  const recoveryError =
    advancedRecovery?.manualRecovery?.error ?? null;
  const recoveryImporting =
    advancedRecovery?.manualRecovery?.importing ?? false;
  const projectedRecoveryValues =
    manualRecovery?.state === "ready" || manualRecovery?.state === "copy"
      ? {
          task: manualRecovery.task,
          instructionPath: manualRecovery.instruction_path,
          ingressPath: manualRecovery.ingress_path,
        }
      : null;
  const planRecovery =
    projection.mode === "ready" && projection.phase === "plan"
      ? projection.sections.advanced_recovery
      : projection.mode === "plan_result_superseded"
        ? {
            relevant_skills: projection.result.relevant_skills,
            product_doc_impacts: projection.result.product_doc_impacts,
            todo_impacts: projection.result.todo_impacts,
          }
        : null;
  const rejectedRecoveryImport =
    importedRecovery?.outcome === "rejected" ? importedRecovery : null;
  const showManualIngress =
    advancedRecoveryPhase !== null &&
    (advancedRecovery !== undefined ||
      manualRecovery !== null ||
      prepareManualAction !== undefined);
  const compactSpecDecision =
    projection.mode === "ready" && projection.phase === "spec";
  function toggleExpanded(key: string): void {
    setExpandedFields((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }
  function previewExpanded(key: string): boolean {
    return expandedFields.has(key);
  }
  function dispatchAction(action: ShapingActionProjection): void {
    const handled = dispatchShapingManualRecoveryAction(
      action,
      projectedRecoveryValues?.task ?? null,
      {
        prepare: onPrepareManualRecovery,
        retry: onRetryManualRecovery,
        copyTask:
          onCopyManualRecovery === undefined
            ? undefined
            : (value) => onCopyManualRecovery("task", value),
        importResult: onImportManualResult,
      },
    );
    if (!handled) {
      onAction(action);
    }
  }
  function renderProvenanceRegion(compact: boolean): ReactNode {
    if (!("provenance" in projection) || projection.provenance.length === 0) {
      return null;
    }
    return (
      <DecisionRegion
        region="provenance"
        heading="Provenance"
        compact={compact}
      >
        <div
          className={`${compact ? "mt-1.5 gap-1 text-[10px] leading-[13px]" : "mt-3 gap-2 text-xs"} flex flex-wrap items-center`}
        >
          {projection.provenance.map((use, index) => (
            <div key={use.seat} className="contents">
              {index === 0 ? null : (
                <span className="text-muted-foreground" aria-hidden="true">
                  →
                </span>
              )}
              <span
                className={`rounded-sm border bg-background px-2 ${compact ? "py-0.5" : "py-1.5"}`}
              >
                {shapingPhaseLabel(use.seat)} · requested {use.requested_model} ·
                effective {use.effective_model}
              </span>
            </div>
          ))}
        </div>
      </DecisionRegion>
    );
  }
  function renderNextStepRegion(compact: boolean): ReactNode {
    if (picker === null) {
      return runtimeUnavailable === null ? null : (
        <DecisionRegion
          region="runtime"
          heading="Connected runtime"
          compact={compact}
        >
          <p className="mt-2 text-sm leading-5 text-muted-foreground">
            {runtimeUnavailable}
          </p>
        </DecisionRegion>
      );
    }
    return (
      <DecisionRegion region="next-step" heading="Next step" compact={compact}>
        <ModelPicker
          picker={picker}
          selectedModel={currentModel}
          busy={busy}
          onSelectModel={onSelectModel}
          compact={compact}
        />
      </DecisionRegion>
    );
  }

  return (
    <div
      data-shaping-decision-view="true"
      data-shaping-mode={projection.mode}
      data-shaping-density={compactSpecDecision ? "compact-spec" : "default"}
      aria-labelledby={`${fieldId}-shaping-decision`}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div
        data-shaping-scroll-region="true"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <section
          data-region="status"
          data-refresh-running={lifecycle?.refresh_running ?? false}
          className={`px-5 ${compactSpecDecision ? "py-2" : "py-5"}`}
        >
          <div
            className={`flex items-start ${compactSpecDecision ? "gap-2" : "gap-3"}`}
          >
            <span
              aria-hidden="true"
              className={`mt-0.5 grid shrink-0 place-items-center rounded-full border ${compactSpecDecision ? "size-7 text-xs" : "size-8 text-sm"} ${
                status.tone === "ready"
                  ? "border-success text-success"
                  : status.tone === "error"
                    ? "border-destructive text-destructive"
                    : "border-primary text-primary"
              }`}
            >
              {status.tone === "ready" ? "✓" : status.tone === "error" ? "!" : "→"}
            </span>
            <div className="min-w-0 flex-1">
              {lifecycle === null ? null : (
                <p className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                  {lifecycle.card_label}
                </p>
              )}
              <h3
                id={`${fieldId}-shaping-decision`}
                className={
                  compactSpecDecision
                    ? "text-sm font-semibold"
                    : "text-base font-semibold"
                }
              >
                {status.headline}
              </h3>
              <p
                className={`${compactSpecDecision ? "text-xs leading-4" : "text-sm leading-5"} mt-1 text-muted-foreground`}
              >
                {status.copy}
              </p>
              <button
                type="button"
                onClick={onShowFullWorkItem}
                className={`${compactSpecDecision ? "mt-1" : "mt-2"} text-xs font-medium text-primary hover:text-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary`}
              >
                View full work item
              </button>
            </div>
          </div>
          {refresh === null ? null : (
            <div
              data-shaping-refresh-state="true"
              className="mt-4 space-y-2 border-l-2 border-border pl-3 text-xs leading-5 text-muted-foreground"
            >
              {refresh.last_checked_at === null ? null : (
                <p data-refresh-indicator="last-checked">
                  Last checked{" "}
                  <time dateTime={refresh.last_checked_at}>
                    {runCompletedAtFormatter.format(
                      new Date(refresh.last_checked_at),
                    )}
                  </time>
                </p>
              )}
              {refreshRunning && refresh.refreshing ? (
                <p data-refresh-indicator="refreshing" role="status">
                  Refreshing status…
                </p>
              ) : null}
              {refreshRunning && refresh.stale ? (
                <p data-refresh-indicator="stale">
                  Status may be stale. The bounded refresh budget has stopped.
                </p>
              ) : null}
              {!refreshRunning || refresh.refresh_failure === null ? null : (
                <p data-refresh-indicator="refresh-failure" role="alert">
                  Refresh failed: {refresh.refresh_failure.reason}
                </p>
              )}
              {refreshRunning &&
              (refresh.stale || refresh.refresh_failure !== null) ? (
                <button
                  type="button"
                  disabled={busy || refresh.refreshing}
                  onClick={onRefreshStatus}
                  className="h-8 rounded-md border bg-secondary px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Refresh status
                </button>
              ) : null}
            </div>
          )}
          {error === null ? null : (
            <p
              className="mt-4 border-l-2 border-destructive bg-destructive/10 px-3 py-2 text-xs leading-5"
              role="alert"
            >
              {error}
            </p>
          )}
          {retainedControllerLeaseRepair === null ? null : retainedControllerLeaseRepair.status ===
            "repaired" ? (
            <p
              data-retained-controller-lease="repaired"
              className="mt-4 border-l-2 border-success bg-success/10 px-3 py-2 text-xs leading-5"
              role="status"
            >
              Retained lock repaired. Submit the preserved decision again to
              replay it.
            </p>
          ) : (
            <section
              data-retained-controller-lease={
                retainedControllerLeaseRepair.status
              }
              aria-labelledby={`${fieldId}-retained-controller-lease`}
              className="mt-4 border-l-2 border-[#e4b93f] bg-[#e4b93f]/10 px-3 py-3 text-xs leading-5"
            >
              <h4
                id={`${fieldId}-retained-controller-lease`}
                className="font-semibold text-foreground"
              >
                Retained controller run
              </h4>
              <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                <dt className="text-muted-foreground">Run</dt>
                <dd className="break-all">
                  {retainedControllerLeaseRepair.retainedRun.run_id}
                </dd>
                <dt className="text-muted-foreground">Acquired</dt>
                <dd>
                  <time
                    dateTime={
                      retainedControllerLeaseRepair.retainedRun.acquired_at
                    }
                  >
                    {retainedControllerLeaseRepair.retainedRun.acquired_at}
                  </time>
                </dd>
                <dt className="text-muted-foreground">Phase</dt>
                <dd>{shapingPhaseLabel(retainedControllerLeaseRepair.phase)}</dd>
                <dt className="text-muted-foreground">Operation</dt>
                <dd className="break-all">
                  {retainedControllerLeaseRepair.retainedRun.idempotency_key}
                </dd>
              </dl>
              <label className="mt-3 flex items-start gap-2 text-foreground">
                <input
                  type="checkbox"
                  checked={retainedControllerLeaseRepair.acknowledged}
                  disabled={
                    busy ||
                    retainedControllerLeaseRepair.status === "repairing"
                  }
                  onChange={(event) =>
                    onAcknowledgeRetainedControllerLease(event.target.checked)
                  }
                  className="mt-0.5 size-4 rounded border-border bg-background accent-primary"
                />
                <span>
                  I have confirmed no operation for run{" "}
                  {retainedControllerLeaseRepair.retainedRun.run_id} is still
                  executing.
                </span>
              </label>
              {retainedControllerLeaseRepair.error === null ? null : (
                <p className="mt-3 text-destructive" role="alert">
                  {retainedControllerLeaseRepair.error}
                </p>
              )}
              <button
                type="button"
                disabled={
                  busy ||
                  !retainedControllerLeaseRepair.acknowledged ||
                  retainedControllerLeaseRepair.status === "repairing"
                }
                onClick={onRepairRetainedControllerLease}
                className="mt-3 h-9 rounded-md border bg-secondary px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                {retainedControllerLeaseRepair.status === "repairing"
                  ? "Repairing retained lock…"
                  : "Repair retained lock"}
              </button>
            </section>
          )}
        </section>

        {projection.mode === "ready" && projection.phase === "brainstorm" ? (
          <>
            <DecisionRegion region="summary" heading="Result summary">
              <p className="mt-3 text-[11px] font-medium text-muted-foreground uppercase">
                Problem statement
              </p>
              <PreviewText
                preview={projection.sections.summary.problem_statement}
                expanded={previewExpanded("brainstorm-problem")}
                onExpand={() => toggleExpanded("brainstorm-problem")}
              />
              <p className="mt-4 text-[11px] font-medium text-muted-foreground uppercase">
                Approach
              </p>
              <PreviewText
                preview={projection.sections.summary.approach}
                expanded={previewExpanded("brainstorm-approach")}
                onExpand={() => toggleExpanded("brainstorm-approach")}
              />
            </DecisionRegion>
            <DecisionRegion region="non-goals" heading="Non-goals">
              <PreviewList
                preview={projection.sections.non_goals}
                expanded={previewExpanded("brainstorm-non-goals")}
                onExpand={() => toggleExpanded("brainstorm-non-goals")}
                marker="plain"
              />
            </DecisionRegion>
            <DecisionRegion
              region="unresolved-questions"
              heading="Unresolved questions"
            >
              <PreviewList
                preview={projection.sections.unresolved_questions}
                expanded={previewExpanded("brainstorm-questions")}
                onExpand={() => toggleExpanded("brainstorm-questions")}
                marker="question"
              />
            </DecisionRegion>
          </>
        ) : null}

        {projection.mode === "ready" && projection.phase === "spec" ? (
          <>
            <DecisionRegion region="summary" heading="Proposal summary" compact>
              <PreviewText
                preview={projection.sections.summary.purpose}
                expanded={previewExpanded("spec-purpose")}
                onExpand={() => toggleExpanded("spec-purpose")}
                compact
              />
            </DecisionRegion>
            <DecisionRegion
              region="criteria"
              heading="Acceptance criteria (observable)"
              compact
            >
              <PreviewList
                preview={projection.sections.criteria}
                expanded={previewExpanded("spec-criteria")}
                onExpand={() => toggleExpanded("spec-criteria")}
                compact
              />
            </DecisionRegion>
            <DecisionRegion region="governed-fields" heading="Governed fields" compact>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                {projection.sections.governed_fields.pointer}
              </p>
              <div
                data-spec-governed-layout="compact"
                className="mt-1.5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_88px_minmax(0,1.25fr)]"
              >
                {(
                  [
                    ["Non-goals", "spec-non-goals", projection.sections.governed_fields.non_goals],
                    ["Allowed scope", "spec-allowed-scope", projection.sections.governed_fields.allowed_scope],
                    ["Review ready", "spec-review-ready", projection.sections.governed_fields.review_ready],
                  ] as const
                ).map(([label, key, preview]) => (
                  <CompactSpecGovernedField
                    key={key}
                    label={label}
                    fieldKey={key}
                    preview={preview}
                    expanded={previewExpanded(key)}
                    onExpand={() => toggleExpanded(key)}
                  />
                ))}
              </div>
            </DecisionRegion>
          </>
        ) : null}

        {projection.mode === "ready" && projection.phase === "plan" ? (
          <>
            <DecisionRegion region="summary" heading="Plan summary">
              <PreviewText
                preview={projection.sections.summary.summary}
                expanded={previewExpanded("plan-summary")}
                onExpand={() => toggleExpanded("plan-summary")}
              />
            </DecisionRegion>
            <DecisionRegion region="criteria" heading="Plan checklist">
              <PreviewChecklist
                preview={projection.sections.checklist}
                expanded={previewExpanded("plan-checklist")}
                onExpand={() => toggleExpanded("plan-checklist")}
              />
            </DecisionRegion>
            <DecisionRegion
              region="unresolved-questions"
              heading="Unresolved questions"
            >
              <PreviewList
                preview={projection.sections.unresolved_questions}
                expanded={previewExpanded("plan-questions")}
                onExpand={() => toggleExpanded("plan-questions")}
                marker="question"
              />
            </DecisionRegion>
          </>
        ) : null}

        {projection.mode === "post_commit_launch_failure" ? (
          <DecisionRegion region="launch-failure" heading="Launch state">
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">Locked model</dt>
                <dd>{projection.locked_model}</dd>
              </div>
            </dl>
            {projection.locked_model_unavailable ? (
              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                The locked model is no longer available. Start a new attempt with another model.
              </p>
            ) : null}
          </DecisionRegion>
        ) : null}

        {projection.mode === "plan_result_superseded" ? (
          <DecisionRegion region="superseded-plan" heading="Superseded result">
            <p className="mt-2 text-sm leading-6">{projection.result.summary}</p>
          </DecisionRegion>
        ) : null}

        {compactSpecDecision ? (
          <div
            data-spec-decision-controls="compact"
            className={picker === null ? undefined : "grid grid-cols-[3fr_2fr]"}
          >
            {renderProvenanceRegion(true)}
            {renderNextStepRegion(true)}
          </div>
        ) : (
          <>
            {renderProvenanceRegion(false)}
            {renderNextStepRegion(false)}
          </>
        )}

        {!requestChangesOpen ? null : (
          <section
            data-region="request-changes"
            aria-labelledby={`${fieldId}-request-changes-heading`}
            className="border-t px-5 py-5"
          >
            <h3
              id={`${fieldId}-request-changes-heading`}
              className="text-sm font-semibold"
            >
              Request changes
            </h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Describe what should change, then rerun this shaping seat against
              the same exact result binding.
            </p>
            <label className="mt-4 block">
              <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                Required feedback
              </span>
              <textarea
                aria-label="Required feedback"
                autoFocus
                required
                rows={4}
                value={requestChangesComposer.feedback}
                disabled={busy}
                onChange={(event) =>
                  onChangeRequestChangesFeedback(event.target.value)
                }
                className="mt-2 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm leading-5 outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
              />
            </label>
            {requestChangesPicker === null ? (
              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                {requestChangesProjection?.runtime_unavailable ??
                  "No connected shaping models are available."}
              </p>
            ) : requestChangesSubmitAction?.launch_mode === "manual" ? (
              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                This prepares the revision for manual recovery without
                selecting a connected model.
              </p>
            ) : (
              <div className="mt-4">
                <p className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                  Current-seat model
                </p>
                <ModelPicker
                  picker={requestChangesPicker}
                  selectedModel={requestChangesModel}
                  busy={busy}
                  onSelectModel={onSelectRequestChangesModel}
                />
              </div>
            )}
            {requestChangesComposer.error === null ? null : (
              <p
                data-request-changes-error="true"
                className="mt-4 border-l-2 border-destructive bg-destructive/10 px-3 py-2 text-xs leading-5"
                role="alert"
              >
                {requestChangesComposer.error}
              </p>
            )}
          </section>
        )}

        <details
          key={advancedRecovery?.identity}
          data-region="advanced-recovery"
          data-recovery-identity={advancedRecovery?.identity}
          data-manual-recovery-state={manualRecovery?.state ?? "idle"}
          className={`border-t px-5 ${compactSpecDecision ? "py-2" : "py-4"}`}
        >
          <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
            Advanced recovery
            <ChevronDown className="size-4 text-muted-foreground" strokeWidth={1.75} />
          </summary>
          <div className="mt-4 space-y-5">
            <p className="border-l-2 border-border pl-3 text-xs leading-5 text-muted-foreground">
              Permission requests are mediated locally. Product Studio accepts
              only the exact result-ingress path and validates that result scope
              before publication. The run uses the founder&apos;s own user
              authority and can read the workspace and repository. Operating-system
              separation is not independently enforced.
            </p>

            {advancedRecovery === undefined ||
            advancedRecoveryPhase === null ? null : (
              <section data-recovery-section="mission" className="space-y-3">
                <h4 className="text-xs font-medium">External mission handoff</h4>
                <button
                  type="button"
                  disabled={busy || advancedRecovery.compiling}
                  onClick={onCompileManualMission}
                  className="h-9 w-full rounded-md border bg-secondary px-3 text-left text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {advancedRecovery.compiling
                    ? "Compiling…"
                    : `Compile ${shapingPhaseLabel(advancedRecoveryPhase)} mission`}
                </button>
                {advancedRecovery.compilation !== null ? (
                  <ShapingMissionHandoff
                    compilation={advancedRecovery.compilation}
                    copiedTarget={advancedRecovery.copiedCompilationTarget}
                    onCopy={(target, value) =>
                      onCopyManualCompilation?.(target, value)
                    }
                  />
                ) : advancedRecovery.currentTaskPath === null ? null : (
                  <dl className="border-l-2 border-border bg-background px-3 py-3 text-xs">
                    <div>
                      <dt className="text-muted-foreground">TASK.md</dt>
                      <dd className="mt-1 flex items-start justify-between gap-3">
                        <span className="min-w-0 break-all text-[11px] leading-5">
                          {advancedRecovery.currentTaskPath}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            onCopyManualCompilation?.(
                              "task",
                              advancedRecovery.currentTaskPath!,
                            )
                          }
                          className="h-9 shrink-0 rounded-md border bg-secondary px-3 text-[11px] font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                        >
                          Copy TASK.md
                        </button>
                      </dd>
                    </div>
                  </dl>
                )}
              </section>
            )}

            {!showManualIngress ? null : (
              <section data-recovery-section="manual-ingress" className="space-y-3">
                <h4 className="text-xs font-medium">Manual result ingress</h4>
                {manualRecovery === null && preparePromoted ? (
                  <p className="text-xs leading-5 text-muted-foreground">
                    Use the primary Prepare manual recovery action below.
                  </p>
                ) : manualRecovery === null ? (
                  <button
                    type="button"
                    disabled={
                      busy ||
                      !(advancedRecovery?.preparationEnabled ??
                        prepareManualAction?.enabled ??
                        false)
                    }
                    onClick={() => {
                      if (onPrepareManualRecovery !== undefined) {
                        onPrepareManualRecovery();
                      } else if (prepareManualAction !== undefined) {
                        onAction(prepareManualAction);
                      }
                    }}
                    className="h-9 w-full rounded-md border bg-secondary px-3 text-left text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Prepare manual recovery
                  </button>
                ) : manualRecovery.state === "loading" ? (
                  <p className="text-xs leading-5 text-muted-foreground" role="status">
                    Publishing the manual recovery instruction…
                  </p>
                ) : manualRecovery.state === "failure" ||
                  manualRecovery.state === "retry" ? (
                  <div
                    className="border-l-2 border-destructive bg-destructive/10 px-3 py-3 text-xs leading-5"
                    role="alert"
                  >
                    <p className="font-medium">
                      {manualRecovery.state === "failure"
                        ? "Manual recovery preparation failed"
                        : "Manual recovery retry failed"}
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      {manualRecovery.reason}
                    </p>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (onRetryManualRecovery !== undefined) {
                          onRetryManualRecovery();
                        } else if (retryManualAction !== undefined) {
                          onAction(retryManualAction);
                        }
                      }}
                      className="mt-3 h-9 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Retry manual recovery
                    </button>
                  </div>
                ) : projectedRecoveryValues === null ? null : (
                  <div className="space-y-4">
                    <p className="text-xs font-medium text-success">
                      Manual recovery ready
                    </p>
                    {manualRecovery.state === "copy" ? (
                      <p className="text-xs text-muted-foreground" role="status">
                        Copied {manualRecovery.copied_target}.
                      </p>
                    ) : null}
                    <dl className="space-y-3 text-xs">
                      {(
                        [
                          ["Instruction path", "instruction", projectedRecoveryValues.instructionPath],
                          ["Exact ingress path", "ingress", projectedRecoveryValues.ingressPath],
                        ] as const
                      ).map(([label, target, value]) =>
                        value === null ? null : (
                          <div key={target}>
                            <dt className="text-muted-foreground">{label}</dt>
                            <dd className="mt-1 flex items-start justify-between gap-3">
                              <span className="min-w-0 break-all text-[11px] leading-5">
                                {value}
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  if (onCopyManualRecovery !== undefined) {
                                    onCopyManualRecovery(target, value);
                                  }
                                }}
                                className="h-9 shrink-0 rounded-md border bg-secondary px-3 text-[11px] font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                              >
                                Copy {label}
                              </button>
                            </dd>
                          </div>
                        ),
                      )}
                    </dl>
                    <div>
                      <p className="text-xs text-muted-foreground">Rendered recovery task</p>
                      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words border bg-background p-3 text-[11px] leading-5">
                        {projectedRecoveryValues.task}
                      </pre>
                      {advancedRecovery === undefined ? null : (
                        <button
                          type="button"
                          onClick={() => {
                            if (onCopyManualRecovery !== undefined) {
                              onCopyManualRecovery(
                                "task",
                                projectedRecoveryValues.task,
                              );
                            } else if (copyManualAction !== undefined) {
                              onAction(copyManualAction);
                            }
                          }}
                          className="mt-2 h-9 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                        >
                          Copy manual task
                        </button>
                      )}
                    </div>
                    {preparedRecovery === null ? null : (
                      <dl className="grid grid-cols-1 gap-3 border-y py-3 text-xs">
                        <div>
                          <dt className="text-muted-foreground">Result schema version</dt>
                          <dd>{preparedRecovery.instruction.result_schema_version}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">Maximum result bytes</dt>
                          <dd>{preparedRecovery.instruction.max_result_bytes}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">Mission content SHA-256</dt>
                          <dd className="break-all text-[11px]">
                            {preparedRecovery.instruction.mission_content_sha256}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">Required result fields</dt>
                          <dd>
                            <ShapingStringList
                              values={preparedRecovery.instruction.required_fields}
                              emptyLabel="No required fields were recorded."
                            />
                          </dd>
                        </div>
                      </dl>
                    )}
                    <button
                      type="button"
                      disabled={busy || recoveryImporting}
                      onClick={() => {
                        if (onImportManualResult !== undefined) {
                          onImportManualResult();
                        } else if (importManualAction !== undefined) {
                          onAction(importManualAction);
                        }
                      }}
                      className="h-9 w-full rounded-md border bg-secondary px-3 text-left text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {recoveryImporting ? "Importing…" : "Import result"}
                    </button>
                  </div>
                )}
                {manualRecovery === null ||
                manualRecovery.state === "loading" ||
                manualRecovery.state === "failure" ||
                manualRecovery.state === "retry" ? (
                  <button
                    type="button"
                    disabled
                    className="h-9 w-full rounded-md border bg-secondary px-3 text-left text-xs font-medium opacity-50"
                  >
                    Import result
                  </button>
                ) : null}
                {recoveryError === null ? null : (
                  <p
                    className="border-l-2 border-destructive bg-destructive/10 px-3 py-2 text-xs leading-5"
                    role="alert"
                  >
                    {recoveryError}
                  </p>
                )}
                {rejectedRecoveryImport === null ? null : (
                  <div
                    data-recovery-rejection="sanitized"
                    className="border-l-2 border-destructive bg-destructive/10 px-3 py-3 text-xs"
                    role="alert"
                  >
                    <p className="font-medium">Imported result rejected</p>
                    <dl className="mt-2 space-y-2">
                      <div>
                        <dt className="text-muted-foreground">Raw result SHA-256</dt>
                        <dd className="break-all text-[11px]">
                          {rejectedRecoveryImport.rejection.raw_result_sha256}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Byte length</dt>
                        <dd>{rejectedRecoveryImport.rejection.byte_length}</dd>
                      </div>
                    </dl>
                    <ShapingStringList
                      values={rejectedRecoveryImport.rejection.reasons.map(
                        (reason) => `${reason.field_path}: ${reason.code}`,
                      )}
                      emptyLabel="The result did not satisfy the shaping contract."
                    />
                  </div>
                )}
              </section>
            )}

            {advancedRecovery?.run === null ||
            advancedRecovery?.run === undefined ? null : (
              <section data-recovery-section="run-diagnostics" className="space-y-3">
                <h4 className="text-xs font-medium">Connected run diagnostics</h4>
                <dl className="space-y-2 border-l-2 border-border bg-background px-3 py-3 text-xs">
                  <div>
                    <dt className="text-muted-foreground">Run</dt>
                    <dd className="break-all text-[11px]">
                      {advancedRecovery.run.shaping_run_id}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Outcome</dt>
                    <dd>{advancedRecovery.run.lifecycle.terminal_outcome ?? advancedRecovery.run.lifecycle.status}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Partial</dt>
                    <dd>{advancedRecovery.run.lifecycle.partial ? "yes" : "no"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Requested model</dt>
                    <dd>{advancedRecovery.run.provenance.requested_model.value ?? "unknown"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Effective model</dt>
                    <dd>{advancedRecovery.run.provenance.effective_model.model_id ?? "unknown"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Exact run ingress</dt>
                    <dd className="break-all text-[11px]">
                      {advancedRecovery.run.write_policy.ingress_path}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Bounded diagnostics</dt>
                    <dd>
                      {advancedRecovery.run.diagnostics.count} recorded · {advancedRecovery.run.diagnostics.truncated ? "truncated" : "complete"}
                    </dd>
                  </div>
                </dl>
              </section>
            )}

            {planRecovery === null ? null : (
              <section data-recovery-section="plan-impacts" className="space-y-4">
                <h4 className="text-xs font-medium">Plan implementation context</h4>
                {(
                  [
                    ["Relevant skills", planRecovery.relevant_skills, "No relevant skills recorded."],
                    ["Product doc impacts", planRecovery.product_doc_impacts, "No product doc impacts recorded."],
                    ["Todo impacts", planRecovery.todo_impacts, "No todo impacts recorded."],
                  ] as const
                ).map(([label, values, emptyLabel]) => (
                  <div key={label}>
                    <p className="text-[11px] font-medium text-muted-foreground uppercase">
                      {label}
                    </p>
                    <ShapingStringList values={values} emptyLabel={emptyLabel} />
                  </div>
                ))}
              </section>
            )}

            {manualActions.length === 0 ? null : (
              <section data-recovery-section="decision-actions" className="space-y-2">
                {manualActions.map((action) => (
                <button
                  key={`${action.kind}:${action.launch_mode}:${action.label}`}
                  type="button"
                  disabled={busy || !action.enabled}
                  onClick={() =>
                    action.kind === "request_changes" &&
                    action.launch_mode === "manual"
                      ? onOpenRequestChanges("manual")
                      : onAction(action)
                  }
                  className="block h-9 w-full rounded-md border bg-secondary px-3 text-left text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {action.label}
                </button>
                ))}
              </section>
            )}
          </div>
        </details>
      </div>

      <footer
        data-region="footer"
        data-shaping-footer="persistent"
        className="flex shrink-0 items-center justify-end gap-2 border-t bg-muted px-5 py-4"
      >
        {requestChangesOpen ? (
          <button
            type="button"
            disabled={busy}
            onClick={onCloseRequestChanges}
            className="h-10 rounded-md border bg-secondary px-4 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            Close
          </button>
        ) : requestChangesAction === undefined ? null : (
          <button
            type="button"
            disabled={busy || !requestChangesAction.enabled}
            onClick={() =>
              onOpenRequestChanges(
                requestChangesPicker === null ? "manual" : "connected",
              )
            }
            className="h-10 rounded-md border bg-secondary px-4 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {requestChangesAction.label}
          </button>
        )}
        {requestChangesOpen || cancelAction === undefined ? null : (
          <button
            type="button"
            disabled={busy || !cancelAction.enabled}
            onClick={() => onAction(cancelAction)}
            className="h-10 rounded-md border bg-secondary px-4 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {cancelAction.label}
          </button>
        )}
        {requestChangesOpen ? (
          requestChangesSubmitAction === undefined ? null : (
            <button
              type="button"
              data-action-priority="primary"
              disabled={requestChangesSubmitDisabled}
              onClick={() =>
                onSubmitRequestChanges(
                  requestChangesSubmitAction,
                  requestChangesComposer.feedback,
                  requestChangesModel.length === 0
                    ? null
                    : requestChangesModel,
                )
              }
              className="h-10 rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {requestChangesSubmitAction.label}
            </button>
          )
        ) : footerPrimaryAction === undefined ? null : (
          <button
            type="button"
            data-action-priority="primary"
            disabled={busy || !footerPrimaryAction.enabled}
            onClick={() => dispatchAction(footerPrimaryAction)}
            className="h-10 rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {footerPrimaryAction.label}
          </button>
        )}
      </footer>
    </div>
  );
}

interface PatchWorkflowSectionProps {
  fieldId: string;
  projection: PatchAttentionProjection;
  patchCycle: number | null;
  mutation: PatchMutation | null;
  compilation: PatchMissionCompilation | null;
  importedEvidence: PortfolioPatchImportResult["evidence"] | null;
  copied: boolean;
  onAcceptPatchPlan: () => void;
  onCompilePatch: () => void;
  onImportPatch: () => void;
  onCopyLaunchInstruction: () => void;
}

function patchWorkflowHeading(projection: PatchAttentionProjection): string {
  switch (projection.mode) {
    case "patch_plan":
      return "Patch plan";
    case "patch_active":
      return "Patch handoff";
    case "escalation":
      return "Needs your decision";
    case "review_ready":
      return "Review ready";
    case "hidden":
      return "Patch handoff";
  }
}

function patchWorkflowStatus(projection: PatchAttentionProjection): string {
  switch (projection.mode) {
    case "patch_plan":
      return "Needs approval";
    case "patch_active":
      return "Active";
    case "escalation":
      return "Escalated";
    case "review_ready":
      return "Human gate";
    case "hidden":
      return "Processed";
  }
}

function patchWorkflowNextAction(
  projection: PatchAttentionProjection,
): string | null {
  switch (projection.mode) {
    case "patch_plan":
      return "Approve the patch plan";
    case "patch_active":
      return "Compile or import the patch";
    case "escalation":
      return "Resolve the escalation";
    case "review_ready":
      return "Review the result";
    case "hidden":
      return null;
  }
}

export function PatchWorkflowSection({
  fieldId,
  projection,
  patchCycle,
  mutation,
  compilation,
  importedEvidence,
  copied,
  onAcceptPatchPlan,
  onCompilePatch,
  onImportPatch,
  onCopyLaunchInstruction,
}: PatchWorkflowSectionProps) {
  if (
    projection.mode === "hidden" &&
    compilation === null &&
    importedEvidence === null
  ) {
    return null;
  }

  const attention = projection.attention;
  const busy = mutation !== null;

  return (
    <section
      aria-labelledby={`${fieldId}-patch-workflow`}
      className="border-y py-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id={`${fieldId}-patch-workflow`} className="text-xs font-medium">
            {patchWorkflowHeading(projection)}
          </h3>
          {projection.mode === "patch_active" ? (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Compile durable patch instructions, then import the exact result
              returned by the external agent.
            </p>
          ) : attention !== null ? (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {attention.question}
            </p>
          ) : null}
        </div>
        <span className="shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
          {patchWorkflowStatus(projection)}
        </span>
      </div>

      {attention !== null ? (
        <p className="mt-3 border-l-2 border-primary bg-background px-3 py-2.5 text-xs leading-5">
          {attention.recommendation}
        </p>
      ) : null}

      {patchCycle !== null ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-y py-3 text-[11px]">
          <div>
            <dt className="text-muted-foreground">Patch cycle</dt>
            <dd className="mt-0.5">{patchCycle} of 3</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Cost/capacity</dt>
            <dd className="mt-0.5">unknown</dd>
          </div>
          {attention?.pins.evidence_paths[0] ? (
            <div className="col-span-2">
              <dt className="text-muted-foreground">Pinned evidence</dt>
              <dd
                className="mt-0.5 break-all leading-5"
                title={attention.pins.evidence_paths[0]}
              >
                {shortEvidencePath(attention.pins.evidence_paths[0])}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {projection.mode === "patch_plan" ? (
        <button
          type="button"
          disabled={busy}
          onClick={onAcceptPatchPlan}
          className="mt-3 h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {mutation === "accepting_plan" ? "Approving…" : "Approve patch plan"}
        </button>
      ) : null}

      {projection.mode === "patch_active" ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCompilePatch}
            className="h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {mutation === "compiling" ? "Compiling…" : "Compile patch mission"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onImportPatch}
            className="h-9 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {mutation === "importing" ? "Importing…" : "Import patch result"}
          </button>
        </div>
      ) : null}

      {projection.mode === "escalation" ? (
        <p className="mt-3 text-xs font-medium" role="status">
          Resolve the decision above before another patch attempt.
        </p>
      ) : null}

      {projection.mode === "review_ready" ? (
        <p className="mt-3 text-xs font-medium" role="status">
          Review the pinned result; completion remains a separate human gate.
        </p>
      ) : null}

      {importedEvidence !== null ? (
        <div
          className={`mt-4 border-l-2 px-3 py-3 text-xs ${
            importedEvidence.outcome === "applied"
              ? "border-success bg-success/10"
              : "border-destructive bg-destructive/10"
          }`}
          role="status"
        >
          <p className="font-medium">
            {importedEvidence.outcome === "applied"
              ? "Patch imported; ready for re-review"
              : "Patch import blocked"}
          </p>
          <p
            className="mt-1 break-all leading-5 text-muted-foreground"
            title={importedEvidence.evidence_path}
          >
            Evidence · {shortEvidencePath(importedEvidence.evidence_path)}
          </p>
        </div>
      ) : null}

      {compilation !== null ? (
        <div className="mt-4 border-l-2 border-border bg-background px-3 py-3">
          <dl className="space-y-3 text-xs">
            <div>
              <dt className="text-muted-foreground">TASK.md</dt>
              <dd className="mt-1 break-all leading-5">
                {compilation.task_path}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Mission JSON</dt>
              <dd className="mt-1 break-all leading-5">
                {compilation.mission_path}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Package hash</dt>
              <dd className="mt-1 break-all text-[11px] leading-5">
                {compilation.mission.content_sha256}
              </dd>
            </div>
          </dl>
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={onCopyLaunchInstruction}
              className="h-9 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              Copy patch instruction
            </button>
            <span
              className="text-[11px] text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              {copied ? "Copied" : ""}
            </span>
          </div>
        </div>
      ) : null}
    </section>
  );
}

interface ConnectedExecuteSectionProps {
  fieldId: string;
  projection: ConnectedExecuteProjection;
  runs: readonly ConnectedRunSummary[];
  loading: boolean;
  error: string | null;
  modelOverride: string;
  mutation: ConnectedMutation | null;
  onModelOverrideChange: (value: string) => void;
  onLaunch: () => void;
  onAllowOnce: () => void;
  onRetryWithoutAllowing: () => void;
  onKeepDenied: () => void;
}

interface CommandAuthorizationSectionProps {
  fieldId: string;
  attention: Extract<
    WorkItemAttention,
    { kind: "command_authorization" }
  > | null;
  canPrepare: boolean;
  mutation: ConnectedMutation | null;
  onPrepare: () => void;
  onAllowOnce: () => void;
  onKeepDenied: () => void;
}

export function CommandAuthorizationSection({
  fieldId,
  attention,
  canPrepare,
  mutation,
  onPrepare,
  onAllowOnce,
  onKeepDenied,
}: CommandAuthorizationSectionProps) {
  if (!canPrepare && attention === null) {
    return null;
  }
  const busy = mutation !== null;
  return (
    <section
      aria-labelledby={`${fieldId}-command-authorization`}
      className="border-l-2 border-warning bg-background px-3 py-3"
    >
      <h3
        id={`${fieldId}-command-authorization`}
        className="text-xs font-medium"
      >
        Required command preflight
      </h3>
      {attention === null ? (
        <>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            The last connected writer completed without a result. Derive the exact verification, staging, and commit commands before launching another attempt.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={onPrepare}
            className="mt-3 h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {mutation === "preparing_commands"
              ? "Preparing exact commands…"
              : "Prepare exact command approval"}
          </button>
        </>
      ) : (
        <>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {attention.question}
          </p>
          <ol className="mt-3 space-y-2 text-[11px]">
            {attention.proposal.commands.map((command, index) => (
              <li
                key={`${attention.proposal.proposal_sha256}:${index}`}
                className="break-all border-l-2 border-border pl-2.5 font-mono leading-5"
              >
                {[command.executable, ...command.args].join(" ")}
              </li>
            ))}
          </ol>
          <p className="mt-3 break-all text-[11px] text-muted-foreground">
            Proposal hash · {attention.proposal.proposal_sha256}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              data-primary-action="true"
              disabled={busy}
              onClick={onAllowOnce}
              className="h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {mutation === "authorizing_commands"
                ? "Allowing exact commands…"
                : "Allow once and retry"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onKeepDenied}
              className="h-9 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {mutation === "keeping_denied"
                ? "Keeping denied…"
                : "Keep denied"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

export function ConnectedExecuteSection({
  fieldId,
  projection,
  runs,
  loading,
  error,
  modelOverride,
  mutation,
  onModelOverrideChange,
  onLaunch,
  onAllowOnce,
  onRetryWithoutAllowing,
  onKeepDenied,
}: ConnectedExecuteSectionProps) {
  const latest = latestConnectedRun(runs);
  const busy = mutation !== null;

  if (
    projection.mode === "hidden" &&
    latest === null &&
    !loading &&
    error === null
  ) {
    return null;
  }

  return (
    <section
      aria-labelledby={`${fieldId}-connected-execute`}
      className="border-y py-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id={`${fieldId}-connected-execute`} className="text-xs font-medium">
            Connected execution
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Launch the governed Execute mission here, or use the manual mission handoff below to recover.
          </p>
        </div>
        {latest ? (
          <span className="shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
            {connectedStatusLabel(latest.lifecycle.status)}
          </span>
        ) : null}
      </div>

      <p className="mt-3 border-l-2 border-border bg-background px-3 py-2.5 text-[11px] leading-5 text-muted-foreground">
        Local execution has the same machine authority as launching the agent manually. Product Studio enforces mission permissions and result gates; it does not physically sandbox approved operations.
      </p>

      {projection.mode === "launch" ? (
        <div className="mt-4 space-y-3">
          <div>
            <label
              htmlFor={`${fieldId}-connected-model-override`}
              className="mb-2 block text-xs font-medium"
            >
              Model override <span className="text-muted-foreground">(this run only)</span>
            </label>
            <input
              id={`${fieldId}-connected-model-override`}
              value={modelOverride}
              maxLength={200}
              autoComplete="off"
              onChange={(event) => onModelOverrideChange(event.target.value)}
              placeholder="Use the configured model"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none placeholder:text-[#7f8794] focus:border-primary focus:ring-1 focus:ring-primary"
            />
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onLaunch}
            className="h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {mutation === "launching" ? "Launching…" : "Launch connected run"}
          </button>
        </div>
      ) : null}

      {projection.mode === "permission" ? (
        <div className="mt-4 border-l-2 border-warning bg-background px-3 py-3">
          <p className="text-xs font-medium">Permission required</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {projection.permission.question}
          </p>
          <p className="mt-2 break-all text-[11px] text-muted-foreground">
            Exact operation hash · {projection.permission.operation.operation_sha256}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onAllowOnce}
              className="h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {mutation === "allowing_once" ? "Allowing…" : "Allow once and retry"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onRetryWithoutAllowing}
              className="h-9 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {mutation === "retrying_without_allowing"
                ? "Retrying…"
                : "Retry without allowing"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onKeepDenied}
              className="h-9 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {mutation === "keeping_denied" ? "Keeping denied…" : "Keep denied"}
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p
          className="mt-3 border-l-2 border-destructive bg-destructive/10 px-3 py-2 text-xs text-foreground"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {loading && latest === null ? (
        <p className="mt-3 text-xs text-muted-foreground" role="status">
          Loading connected run status…
        </p>
      ) : null}

      {latest ? (
        <div className="mt-4 border-l-2 border-border bg-background px-3 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium">Latest sanitized run</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {latest.connected_run_id.slice(0, 12)} · updated {runCompletedAtFormatter.format(new Date(latest.lifecycle.updated_at))}
              </p>
            </div>
            {latest.lifecycle.terminal_outcome ? (
              <span className="shrink-0 text-[11px] font-medium text-muted-foreground capitalize">
                {connectedStatusLabel(latest.lifecycle.terminal_outcome)}
              </span>
            ) : null}
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-y py-3 text-[11px]">
            <div>
              <dt className="text-muted-foreground">Runtime</dt>
              <dd className="mt-0.5 break-words">
                {connectedHarnessValue(latest.provenance.harness)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Effective model</dt>
              <dd className="mt-0.5 break-words">
                {effectiveModelValue(latest.provenance.effective_model)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Requested model</dt>
              <dd className="mt-0.5 break-words">
                {connectedRunValue(latest.provenance.requested_model)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Effort</dt>
              <dd className="mt-0.5 break-words">
                {connectedRunValue(latest.provenance.effort)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Bounded diagnostics</dt>
              <dd className="mt-0.5">
                {latest.diagnostics.count}
                {latest.diagnostics.truncated ? " (truncated)" : ""}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Run state</dt>
              <dd className="mt-0.5 capitalize">
                {connectedStatusLabel(latest.lifecycle.status)}
                {latest.lifecycle.partial ? " · partial" : ""}
              </dd>
            </div>
          </dl>
        </div>
      ) : null}
    </section>
  );
}

interface ConnectedReviewSubjectView {
  phase: "execute" | "patch";
  commit: string | null;
  mission_path: string;
  evidence_path: string;
}

interface ConnectedPhaseSectionProps {
  fieldId: string;
  projection: ConnectedPhaseProjection;
  subject?: ConnectedReviewSubjectView;
  reviewAttested: boolean;
  selectedModel: string | null;
  loading: boolean;
  modelsLoading: boolean;
  error: string | null;
  mutation: ConnectedMutation | null;
  manualRecovery?: ReactNode;
  onReviewAttestedChange: (checked: boolean) => void;
  onSelectModel: (model: string) => void;
  onLaunch: () => void;
  onCancel: () => void;
  onAllowOnce: () => void;
  onRetryWithoutAllowing: () => void;
  onKeepDenied: () => void;
}

export function ConnectedPhaseSection({
  fieldId,
  projection,
  subject,
  reviewAttested,
  selectedModel,
  loading,
  modelsLoading,
  error,
  mutation,
  manualRecovery,
  onReviewAttestedChange,
  onSelectModel,
  onLaunch,
  onCancel,
  onAllowOnce,
  onRetryWithoutAllowing,
  onKeepDenied,
}: ConnectedPhaseSectionProps) {
  if (projection.mode === "hidden") {
    return null;
  }
  const phaseLabel = shapingPhaseLabel(projection.phase);
  const busy = mutation !== null;
  const primaryAction = projection.actions.find((action) => action.primary);
  const canLaunch =
    projection.mode === "launch" &&
    projection.can_launch &&
    !modelsLoading &&
    (!projection.read_only || reviewAttested) &&
    (projection.model_picker === undefined || selectedModel !== null);
  const run = projection.run;
  const status =
    projection.read_only
      ? "Read only"
      : projection.mode === "permission"
        ? "Permission required"
        : projection.mode === "finishing"
          ? "Importing"
          : projection.mode === "repair"
            ? "Needs recovery"
            : run === null
              ? "Ready"
              : connectedStatusLabel(run.lifecycle.status);

  return (
    <section
      aria-labelledby={`${fieldId}-connected-${projection.phase}`}
      data-connected-phase={projection.phase}
      data-connected-mode={projection.mode}
      className="border-y py-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3
            id={`${fieldId}-connected-${projection.phase}`}
            className="text-xs font-medium"
          >
            Connected {phaseLabel}
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {projection.read_only
              ? "Review the pinned immutable subject and publish only the strict review result."
              : "Run the accepted Patch plan with its bounded capability authorization."}
          </p>
        </div>
        <span className="shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
          {status}
        </span>
      </div>

      {projection.read_only ? (
        <p className="mt-3 border-l-2 border-border bg-background px-3 py-2.5 text-[11px] leading-5 text-muted-foreground">
          Read only. Commands, URLs, MCP, credentials, and workspace edits are forbidden; only the pinned review result path is accepted.
        </p>
      ) : null}

      {subject === undefined ? null : (
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-y py-3 text-[11px]">
          <div>
            <dt className="text-muted-foreground">Pinned subject</dt>
            <dd className="mt-0.5 capitalize">{subject.phase}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Subject commit</dt>
            <dd className="mt-0.5 truncate" title={subject.commit ?? undefined}>
              {subject.commit?.slice(0, 12) ?? "Unavailable"}
            </dd>
          </div>
          <div className="col-span-2">
            <dt className="text-muted-foreground">Immutable mission</dt>
            <dd className="mt-0.5 break-all leading-5">
              {subject.mission_path}
            </dd>
          </div>
          <div className="col-span-2">
            <dt className="text-muted-foreground">Immutable evidence</dt>
            <dd className="mt-0.5 break-all leading-5">
              {subject.evidence_path}
            </dd>
          </div>
        </dl>
      )}

      {projection.mode === "launch" ? (
        <div className="mt-4 space-y-3">
          {projection.read_only ? (
            <label className="flex cursor-pointer items-start gap-2.5 text-xs leading-5">
              <input
                type="checkbox"
                checked={reviewAttested}
                onChange={(event) =>
                  onReviewAttestedChange(event.target.checked)
                }
                className="mt-0.5 size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              />
              <span>
                I attest that this reviewer is independent from the Execute or Patch writer.
              </span>
            </label>
          ) : null}
          {projection.model_picker === undefined || selectedModel === null ? (
            <p className="text-xs leading-5 text-muted-foreground">
              {modelsLoading
                ? "Loading connected model preflight…"
                : projection.runtime_unavailable ??
                  "No connected model is currently available."}
            </p>
          ) : (
            <div>
              <p className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                {phaseLabel} model
              </p>
              <ModelPicker
                picker={projection.model_picker}
                selectedModel={selectedModel}
                busy={busy}
                onSelectModel={onSelectModel}
                compact
              />
            </div>
          )}
          <button
            type="button"
            data-primary-action="true"
            disabled={busy || !canLaunch || primaryAction?.enabled === false}
            onClick={onLaunch}
            className="h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {mutation === "launching"
              ? "Launching…"
              : `Launch connected ${projection.phase}`}
          </button>
        </div>
      ) : null}

      {projection.mode === "running" && run !== null ? (
        <button
          type="button"
          data-primary-action="true"
          disabled={busy || primaryAction?.enabled === false}
          onClick={onCancel}
          className="mt-4 h-9 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {mutation === "cancelling"
            ? "Cancelling…"
            : `Cancel connected ${projection.phase}`}
        </button>
      ) : null}

      {projection.mode === "permission" &&
      !projection.read_only &&
      projection.permission !== null ? (
        <div className="mt-4 border-l-2 border-warning bg-background px-3 py-3">
          <p className="text-xs font-medium">Permission required</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {projection.permission.question}
          </p>
          <p className="mt-2 break-all text-[11px] text-muted-foreground">
            Exact operation hash · {projection.permission.operation.operation_sha256}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              data-primary-action="true"
              disabled={busy}
              onClick={onAllowOnce}
              className="h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {mutation === "allowing_once"
                ? "Allowing…"
                : "Allow once and retry"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onRetryWithoutAllowing}
              className="h-9 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {mutation === "retrying_without_allowing"
                ? "Retrying…"
                : "Retry without allowing"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onKeepDenied}
              className="h-9 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {mutation === "keeping_denied"
                ? "Keeping denied…"
                : "Keep denied"}
            </button>
          </div>
        </div>
      ) : null}

      {run === null ? null : (
        <div className="mt-4 border-l-2 border-border bg-background px-3 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium">Latest sanitized run</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {run.connected_run_id.slice(0, 12)} · updated {runCompletedAtFormatter.format(new Date(run.lifecycle.updated_at))}
              </p>
            </div>
            <span className="shrink-0 text-[11px] font-medium text-muted-foreground capitalize">
              {connectedStatusLabel(
                run.lifecycle.terminal_outcome ?? run.lifecycle.status,
              )}
            </span>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-y py-3 text-[11px]">
            <div>
              <dt className="text-muted-foreground">Runtime</dt>
              <dd className="mt-0.5 break-words">
                {connectedHarnessValue(run.provenance.harness)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Effective model</dt>
              <dd className="mt-0.5 break-words">
                {effectiveModelValue(run.provenance.effective_model)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Authorization</dt>
              <dd className="mt-0.5 break-words">
                {run.authorization.kind === "review_result_ingress"
                  ? "Result-only ingress"
                  : `Capability envelope · ${run.authorization.envelope_sha256.slice(0, 12)}`}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Bounded diagnostics</dt>
              <dd className="mt-0.5">
                {run.diagnostics.count}
                {run.diagnostics.truncated ? " (truncated)" : ""}
              </dd>
            </div>
          </dl>
        </div>
      )}

      {loading && run === null ? (
        <p className="mt-3 text-xs text-muted-foreground" role="status">
          Loading connected {projection.phase} status…
        </p>
      ) : null}
      {error === null ? null : (
        <p
          className="mt-3 border-l-2 border-destructive bg-destructive/10 px-3 py-2 text-xs text-foreground"
          role="alert"
        >
          {error}
        </p>
      )}
      {manualRecovery === undefined ? null : (
        <details
          data-region="governed-advanced-recovery"
          className="mt-4 border-t pt-3"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
            Advanced recovery
            <ChevronDown
              className="size-4 text-muted-foreground"
              strokeWidth={1.75}
            />
          </summary>
          <div className="mt-4">{manualRecovery}</div>
        </details>
      )}
    </section>
  );
}

export function DetailPanel({
  item,
  workspaces,
  onClose,
  onUpdated,
  onAssigned,
  onTransition,
  transitionPending = false,
}: DetailPanelProps) {
  const fieldId = useId();
  const mode = detailPanelModeForItem(item);
  const { goal, state } = item.work_item;
  const [title, setTitle] = useState(goal.title);
  const [type, setType] = useState<WorkItemType | "">(goal.type ?? "");
  const [priority, setPriority] = useState<WorkItemPriority | "">(
    goal.priority ?? "",
  );
  const [tags, setTags] = useState(goal.tags?.join(", ") ?? "");
  const [notes, setNotes] = useState(goal.notes ?? "");
  const [targetSourceId, setTargetSourceId] = useState(item.source_id);
  const [saving, setSaving] = useState(false);
  const goalContract = goal.goal_contract;
  const [purpose, setPurpose] = useState(goalContract?.purpose ?? "");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(
    goalContractLines(goalContract?.acceptance_criteria),
  );
  const [nonGoals, setNonGoals] = useState(
    goalContractLines(goalContract?.non_goals),
  );
  const [allowedScope, setAllowedScope] = useState(
    goalContractLines(goalContract?.allowed_scope),
  );
  const [reviewReady, setReviewReady] = useState(
    goalContractLines(goalContract?.review_ready),
  );
  const [compilingMission, setCompilingMission] = useState(false);
  const [importingResult, setImportingResult] = useState(false);
  const [startingRepair, setStartingRepair] = useState(false);
  const [compilingReviewMission, setCompilingReviewMission] = useState(false);
  const [importingReviewResult, setImportingReviewResult] = useState(false);
  const [patchMutation, setPatchMutation] = useState<PatchMutation | null>(null);
  const [missionCompilationState, setMissionCompilationState] =
    useState<MissionCompilationState | null>(null);
  const [missionImportState, setMissionImportState] =
    useState<MissionImportState | null>(null);
  const [reviewMissionCompilationState, setReviewMissionCompilationState] =
    useState<ReviewMissionCompilationState | null>(null);
  const [reviewMissionImportState, setReviewMissionImportState] =
    useState<ReviewMissionImportState | null>(null);
  const [patchMissionCompilationState, setPatchMissionCompilationState] =
    useState<PatchMissionCompilationState | null>(null);
  const [patchMissionImportState, setPatchMissionImportState] =
    useState<PatchMissionImportState | null>(null);
  const [reviewAttestationState, setReviewAttestationState] =
    useState<ReviewAttestationState | null>(null);
  const [copiedMissionKey, setCopiedMissionKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runEvidenceState, setRunEvidenceState] =
    useState<RunEvidenceState | null>(null);
  const [expandedRunEvidenceState, setExpandedRunEvidenceState] =
    useState<ExpandedRunEvidenceState | null>(null);
  const [connectedRunState, setConnectedRunState] =
    useState<ConnectedRunState | null>(null);
  const [connectedModelState, setConnectedModelState] =
    useState<ConnectedModelState | null>(null);
  const [connectedModelSelectionState, setConnectedModelSelectionState] =
    useState<ConnectedModelSelectionState | null>(null);
  const [connectedModelOverride, setConnectedModelOverride] = useState("");
  const [connectedMutation, setConnectedMutation] =
    useState<ConnectedMutation | null>(null);
  const connectedMutationRef = useRef(false);
  const [scopeCorrectionState, setScopeCorrectionState] =
    useState<ScopeCorrectionState | null>(null);
  const [applyingScopeCorrection, setApplyingScopeCorrection] = useState(false);
  const [reviewImportDriftRecoveryState, setReviewImportDriftRecoveryState] =
    useState<ReviewImportDriftRecoveryState | null>(null);
  const [applyingReviewImportDriftRecovery, setApplyingReviewImportDriftRecovery] =
    useState(false);
  const [shapingArtifactState, setShapingArtifactState] =
    useState<ShapingArtifactState | null>(null);
  const [shapingCompilationState, setShapingCompilationState] =
    useState<ShapingCompilationState | null>(null);
  const [shapingImportState, setShapingImportState] =
    useState<ShapingImportState | null>(null);
  const [shapingSelectionState, setShapingSelectionState] =
    useState<ShapingSelectionState | null>(null);
  const [shapingCopiedState, setShapingCopiedState] =
    useState<ShapingCopiedState | null>(null);
  const [shapingMutation, setShapingMutation] =
    useState<ShapingMutation | null>(null);
  const [shapingModelSelectionState, setShapingModelSelectionState] =
    useState<ShapingModelSelectionState | null>(null);
  const [shapingRequestChangesComposerState, setShapingRequestChangesComposerState] =
    useState<ShapingRequestChangesComposerState | null>(null);
  const [shapingManualRecoveryUiState, setShapingManualRecoveryUiState] =
    useState<ShapingManualRecoveryUiState | null>(null);
  const [shapingLaunchFailureState, setShapingLaunchFailureState] =
    useState<ShapingLaunchFailureState | null>(null);
  const [shapingNewAttemptState, setShapingNewAttemptState] =
    useState<ShapingNewAttemptState | null>(null);
  const [
    retainedControllerLeaseRepairState,
    setRetainedControllerLeaseRepairState,
  ] = useState<RetainedControllerLeaseRepairUiState | null>(null);
  const [shapingDecisionBusyIdentities, setShapingDecisionBusyIdentities] =
    useState<Set<string>>(() => new Set());
  const shapingDecisionBusyRef = useRef<Set<string>>(new Set());
  const [shapingRefreshUiState, setShapingRefreshUiState] =
    useState<ShapingRefreshUiState | null>(null);
  const [shapingRefreshRestartVersion, setShapingRefreshRestartVersion] =
    useState(0);
  const [pageVisible, setPageVisible] = useState(
    () =>
      typeof document === "undefined" ||
      document.visibilityState === "visible",
  );
  const shapingRefreshControllerRef =
    useRef<ShapingRefreshController | null>(null);
  const shapingRefreshControllerIdentityRef = useRef<string | null>(null);
  const shapingRefreshBindingRef = useRef<ShapingRefreshBinding | null>(null);
  const shapingRefreshAppliedRestartVersionRef = useRef(0);
  const shapingArtifactRequestEpochRef = useRef(0);
  const shapingManualRecoveryIdentityRef = useRef<string | null>(null);
  const shapingManualRecoveryOperationsRef = useRef<Set<string>>(new Set());
  const shapingItemKeyRef = useRef("");
  const [showFullWorkItem, setShowFullWorkItem] = useState(false);
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");
  const detailsDirty =
    title !== goal.title ||
    type !== (goal.type ?? "") ||
    priority !== (goal.priority ?? "") ||
    tags !== (goal.tags?.join(", ") ?? "") ||
    notes !== (goal.notes ?? "");
  const assignmentDirty = targetSourceId !== item.source_id;
  const acceptanceCriteriaValues = goalContractValues(acceptanceCriteria);
  const nonGoalsValues = goalContractValues(nonGoals);
  const allowedScopeValues = goalContractValues(allowedScope);
  const reviewReadyValues = goalContractValues(reviewReady);
  const canEditWorkItem = canUpdateGoalContract(state.phase);
  const canEditGoalContract = canEditGoalContractFromFullWorkItem(
    state.phase,
    goalContract !== undefined,
  );
  const contractDirty =
    canEditGoalContract &&
    (purpose !== (goalContract?.purpose ?? "") ||
      acceptanceCriteria !==
        goalContractLines(goalContract?.acceptance_criteria) ||
      nonGoals !== goalContractLines(goalContract?.non_goals) ||
      allowedScope !== goalContractLines(goalContract?.allowed_scope) ||
      reviewReady !== goalContractLines(goalContract?.review_ready));
  const hasContractInput =
    canEditGoalContract &&
    (goalContract !== undefined ||
      purpose.trim().length > 0 ||
      acceptanceCriteriaValues.length > 0 ||
      nonGoalsValues.length > 0 ||
      allowedScopeValues.length > 0 ||
      reviewReadyValues.length > 0);
  const contractComplete =
    purpose.trim().length > 0 &&
    acceptanceCriteriaValues.length > 0 &&
    nonGoalsValues.length > 0 &&
    allowedScopeValues.length > 0 &&
    reviewReadyValues.length > 0;
  const missionItemKey = [
    "execute",
    item.source_id,
    goal.work_item_id,
    goalContract?.goal_version,
    state.input_revision,
    state.attempt,
  ].join(":");
  const reviewMissionItemKey = [
    "review",
    item.source_id,
    goal.work_item_id,
    goalContract?.goal_version,
    state.input_revision,
    state.attempt,
  ].join(":");
  const patchMissionItemKey = [
    "patch",
    item.source_id,
    goal.work_item_id,
    goalContract?.goal_version,
    state.input_revision,
    state.attempt,
    state.patch_cycle,
  ].join(":");
  const missionHandoffMode = missionHandoffModeForItem(item);
  const connectedExecute = connectedExecuteForItem(item);
  const legacyShapingHandoff = shapingHandoffForItem(item);
  const shapingItemKey = shapingItemStateKey(item);
  useEffect(() => {
    shapingItemKeyRef.current = shapingItemKey;
  }, [shapingItemKey]);
  const eligibleIdea =
    state.phase !== "idea" ||
    (state.schema_version === 2 &&
      goal.goal_contract === undefined &&
      state.goal_version === undefined &&
      state.input_revision === undefined);
  const shapingEligible =
    item.source_id !== INBOX_SOURCE_ID &&
    state.status === "active" &&
    eligibleIdea &&
    (state.phase === "idea" || isShapingPhase(state.phase));
  const currentShapingState =
    shapingArtifactState?.itemKey === shapingItemKey
      ? shapingArtifactState
      : null;
  const currentShapingRefreshBinding =
    currentShapingState === null
      ? null
      : shapingRefreshBindingForState(item, currentShapingState);
  useEffect(() => {
    shapingRefreshBindingRef.current = currentShapingRefreshBinding;
  }, [currentShapingRefreshBinding]);
  const currentShapingRefreshIdentity =
    currentShapingRefreshBinding?.identity ?? null;
  const currentShapingRefreshRunStatus =
    currentShapingRefreshBinding?.observation.run_status ?? null;
  const currentShapingRefreshUpdatedAt =
    currentShapingRefreshBinding?.observation.updated_at ?? null;
  const currentShapingRefresh =
    currentShapingRefreshBinding !== null &&
    shapingRefreshUiState?.identity === currentShapingRefreshBinding.identity
      ? {
          last_checked_at:
            shapingRefreshUiState.snapshot.last_checked_at === null
              ? null
              : new Date(
                  shapingRefreshUiState.snapshot.last_checked_at,
                ).toISOString(),
          refreshing: shapingRefreshUiState.snapshot.refreshing,
          stale: shapingRefreshUiState.snapshot.stale,
          refresh_failure: shapingRefreshUiState.snapshot.refresh_failure,
        }
      : null;
  const currentShapingContext =
    currentShapingState === null
      ? null
      : shapingSurfaceContext(
          item,
          currentShapingState,
          shapingLaunchFailureState,
          shapingNewAttemptState,
          currentShapingRefresh,
        );
  const currentDecisionShapingPhase = isShapingPhase(state.phase)
    ? state.phase
    : null;
  const currentDecisionShapingTip =
    currentDecisionShapingPhase === null ||
    currentShapingState?.listing === null ||
    currentShapingState?.listing === undefined
      ? null
      : currentShapingTip(
          currentDecisionShapingPhase,
          currentShapingState.listing.artifacts,
        );
  const currentShapingManualRecoveryBinding: ShapingManualRecoveryBinding | null =
    currentDecisionShapingPhase === null ||
    currentDecisionShapingTip === null ||
    currentShapingContext?.revision === null ||
    currentShapingContext?.revision === undefined
      ? null
      : {
          identity: JSON.stringify([
            item.source_id,
            goal.work_item_id,
            currentDecisionShapingPhase,
            currentDecisionShapingTip.mission.content_sha256,
            currentShapingContext.expected_shaping_state_sha256,
          ]),
          phase: currentDecisionShapingPhase,
          expectedMissionContentSha256:
            currentDecisionShapingTip.mission.content_sha256,
          expectedShapingStateSha256:
            currentShapingContext.expected_shaping_state_sha256,
        };
  useEffect(() => {
    shapingManualRecoveryIdentityRef.current =
      currentShapingManualRecoveryBinding?.identity ?? null;
  }, [currentShapingManualRecoveryBinding?.identity]);
  const shapingDecisionProjection =
    currentShapingContext === null
      ? null
      : shapingHandoffForItem(item, currentShapingContext);
  const shapingDecisionIdentity =
    shapingDecisionProjection === null ||
    shapingDecisionProjection.mode === "hidden"
      ? null
      : JSON.stringify([
          item.source_id,
          goal.work_item_id,
          shapingDecisionProjection.mode === "idea"
            ? shapingDecisionProjection.target_phase
            : shapingDecisionProjection.phase,
          currentShapingRefreshBinding?.missionContentSha256 ??
            currentShapingContext?.revision?.mission_content_sha256 ??
            (shapingDecisionProjection.mode === "pre_ready"
              ? shapingDecisionProjection.mission_content_sha256
              : null),
          currentShapingRefreshBinding?.shapingRunId ?? null,
        ]);
  const shapingDecisionBusy =
    shapingDecisionIdentity !== null &&
    shapingDecisionBusyIdentities.has(shapingDecisionIdentity);
  const decisionPicker =
    shapingDecisionProjection === null
      ? null
      : projectionPicker(shapingDecisionProjection);
  const shapingPickerKey =
    decisionPicker === null ||
    shapingDecisionProjection === null ||
    shapingDecisionProjection.mode === "hidden"
      ? null
      : `${shapingItemKey}:${shapingDecisionProjection.expected_shaping_state_sha256}:${decisionPicker.seat}:primary`;
  const storedShapingModel =
    shapingPickerKey !== null &&
    shapingModelSelectionState?.pickerKey === shapingPickerKey
      ? shapingModelSelectionState.model
      : null;
  const selectedShapingModel = selectedModelForShapingPicker(
    decisionPicker,
    storedShapingModel,
  );
  const shapingRequestChangesProjection =
    shapingDecisionProjection?.mode === "ready" ||
    shapingDecisionProjection?.mode === "plan_result_superseded"
      ? shapingDecisionProjection.request_changes
      : null;
  const shapingRequestChangesIdentity =
    shapingRequestChangesProjection === null ||
    shapingDecisionProjection === null ||
    (shapingDecisionProjection.mode !== "ready" &&
      shapingDecisionProjection.mode !== "plan_result_superseded")
      ? null
      : JSON.stringify([
          item.source_id,
          goal.work_item_id,
          shapingDecisionProjection.phase,
          shapingDecisionProjection.bindings.expected_mission_content_sha256,
          shapingDecisionProjection.bindings.expected_result_content_sha256,
          shapingDecisionProjection.bindings.expected_shaping_state_sha256,
        ]);
  const currentShapingRequestChangesComposer =
    shapingRequestChangesIdentity !== null &&
    shapingRequestChangesComposerState?.identity ===
      shapingRequestChangesIdentity
      ? shapingRequestChangesComposerState
      : null;
  const selectedShapingRequestChangesModel = selectedModelForShapingPicker(
    shapingRequestChangesProjection?.model_picker ?? null,
    currentShapingRequestChangesComposer?.selectedModel ?? null,
  );
  const shapingRequestChangesComposer =
    currentShapingRequestChangesComposer?.open === true
      ? {
          launchMode: currentShapingRequestChangesComposer.launchMode,
          feedback: currentShapingRequestChangesComposer.feedback,
          selectedModel: selectedShapingRequestChangesModel,
          error: currentShapingRequestChangesComposer.error,
        }
      : null;
  const shapingArtifacts =
    currentShapingState?.listing?.artifacts ?? [];
  const shapingLoading =
    shapingEligible &&
    (currentShapingState === null || currentShapingState.loading);
  const shapingError = currentShapingState?.error ?? null;
  const currentRetainedControllerLeaseRepair =
    retainedControllerLeaseRepairState?.itemKey === shapingItemKey
      ? retainedControllerLeaseRepairState
      : null;
  const shapingCompilation =
    shapingCompilationState?.itemKey === shapingItemKey
      ? shapingCompilationState.result
      : null;
  const shapingImport =
    shapingImportState?.itemKey === shapingItemKey
      ? shapingImportState.result
      : null;
  const selectedAcceptanceSha256 =
    shapingSelectionState?.itemKey === shapingItemKey
      ? shapingSelectionState.acceptanceContentSha256
      : "";
  const shapingCopiedTarget =
    shapingCopiedState?.itemKey === shapingItemKey
      ? shapingCopiedState.target
      : null;
  const currentShapingManualRecovery =
    currentShapingManualRecoveryBinding !== null &&
    shapingManualRecoveryUiState?.identity ===
      currentShapingManualRecoveryBinding.identity
      ? shapingManualRecoveryUiState
      : null;
  const currentRecoveryCompilation =
    shapingCompilation !== null &&
    currentDecisionShapingTip !== null &&
    shapingCompilation.mission.identity.phase ===
      currentDecisionShapingTip.mission.identity.phase &&
    shapingCompilation.mission.content_sha256 ===
      currentDecisionShapingTip.mission.content_sha256
      ? shapingCompilation
      : null;
  const currentShapingRunSummary =
    currentDecisionShapingPhase === null ||
    currentShapingState?.listing === null ||
    currentShapingState?.listing === undefined
      ? null
      : shapingRunSummaryFromListing(
          currentDecisionShapingPhase,
          currentShapingState.listing,
        );
  const failedShapingRunSummary =
    currentShapingRunSummary?.lifecycle.status === "terminal" &&
    (currentShapingRunSummary.lifecycle.terminal_outcome !== "completed" ||
      shapingDecisionProjection?.mode === "terminal_run_failure" ||
      shapingDecisionProjection?.mode === "repair")
      ? currentShapingRunSummary
      : null;
  const shapingAdvancedRecovery: ShapingAdvancedRecoveryViewState = {
    identity:
      currentShapingManualRecoveryBinding?.identity ??
      shapingDecisionIdentity ??
      shapingItemKey,
    phase: currentDecisionShapingPhase,
    preparationEnabled: currentShapingManualRecoveryBinding !== null,
    currentTaskPath: currentDecisionShapingTip?.task_path ?? null,
    compilation: currentRecoveryCompilation,
    copiedCompilationTarget:
      currentRecoveryCompilation === null ? null : shapingCopiedTarget,
    manualRecovery: currentShapingManualRecovery,
    run: failedShapingRunSummary,
    compiling: shapingMutation === "compiling",
  };
  const missionEligible = missionHandoffMode === "active";
  const repairEligible = missionHandoffMode === "repair";
  const missionBusy = compilingMission || importingResult || startingRepair;
  const missionCompilation =
    missionCompilationState?.itemKey === missionItemKey
      ? missionCompilationState.result
      : null;
  const missionImport =
    missionImportState?.itemKey === missionItemKey
      ? missionImportState.result
      : null;
  const runEvidenceItemKey = `${item.source_id}:${goal.work_item_id}`;
  const connectedWorkflowPhase: ConnectedWorkflowPhase | null =
    state.phase === "execute" ||
    state.phase === "review" ||
    state.phase === "patch"
      ? state.phase
      : null;
  const connectedRunItemKey = [
    item.source_id,
    goal.work_item_id,
    connectedWorkflowPhase,
    state.goal_version,
    state.input_revision,
    state.attempt,
  ].join(":");
  const scopeCorrection =
    mode === "governed" &&
    scopeCorrectionState?.itemKey === connectedRunItemKey
      ? scopeCorrectionState.listing?.proposal ?? null
      : null;
  const scopeCorrectionLoading =
    mode === "governed" &&
    state.phase === "execute" &&
    (scopeCorrectionState?.itemKey !== connectedRunItemKey ||
      scopeCorrectionState.loading);
  const scopeCorrectionError =
    mode === "governed" &&
    scopeCorrectionState?.itemKey === connectedRunItemKey
      ? scopeCorrectionState.error
      : null;
  const reviewImportDriftRecovery =
    mode === "governed" &&
    reviewImportDriftRecoveryState?.itemKey === connectedRunItemKey
      ? reviewImportDriftRecoveryState.listing?.proposal ?? null
      : null;
  const reviewImportDriftRecoveryLoading =
    mode === "governed" &&
    state.phase === "review" &&
    state.status === "active" &&
    (reviewImportDriftRecoveryState?.itemKey !== connectedRunItemKey ||
      reviewImportDriftRecoveryState.loading);
  const reviewImportDriftRecoveryError =
    mode === "governed" &&
    reviewImportDriftRecoveryState?.itemKey === connectedRunItemKey
      ? reviewImportDriftRecoveryState.error
      : null;
  const runEvidence =
    mode === "governed" && runEvidenceState?.itemKey === runEvidenceItemKey
      ? runEvidenceState.result
      : [];
  const connectedRuns =
    mode === "governed" &&
    connectedRunState?.itemKey === connectedRunItemKey
      ? connectedRunState.result
      : [];
  const commandAuthorizationAttention =
    state.attention?.kind === "command_authorization"
      ? state.attention
      : null;
  const canPrepareCommandAuthorization =
    commandAuthorizationPreflightEligible(state, connectedRuns);
  const commandPreflightActive =
    canPrepareCommandAuthorization || commandAuthorizationAttention !== null;
  const connectedRunsLoading =
    mode === "governed" &&
    (connectedRunState?.itemKey !== connectedRunItemKey ||
      connectedRunState.loading);
  const connectedRunsError =
    mode === "governed" &&
    connectedRunState?.itemKey === connectedRunItemKey
      ? connectedRunState.error
      : null;
  const connectedModels =
    mode === "governed" &&
    connectedModelState?.itemKey === connectedRunItemKey
      ? connectedModelState.result
      : null;
  const connectedModelsLoading =
    mode === "governed" &&
    (connectedModelState?.itemKey !== connectedRunItemKey ||
      connectedModelState.loading);
  const connectedModelsError =
    mode === "governed" &&
    connectedModelState?.itemKey === connectedRunItemKey
      ? connectedModelState.error
      : null;
  const patchAttention = patchAttentionForItem(item, runEvidence);
  const reviewHandoff = reviewHandoffForItem(item, runEvidence);
  const reviewEligible =
    reviewHandoff.mode === "active" && patchAttention.mode === "hidden";
  const reviewAttested =
    reviewAttestationState?.itemKey === reviewMissionItemKey &&
    reviewAttestationState.checked;
  const reviewBusy = compilingReviewMission || importingReviewResult;
  const reviewMissionCompilation =
    reviewMissionCompilationState?.itemKey === reviewMissionItemKey
      ? reviewMissionCompilationState.result
      : null;
  const reviewMissionImport =
    reviewMissionImportState?.itemKey === reviewMissionItemKey
      ? reviewMissionImportState.result
      : null;
  const patchMissionCompilation =
    patchMissionCompilationState?.itemKey === patchMissionItemKey
      ? patchMissionCompilationState.result
      : null;
  const patchMissionImport =
    patchMissionImportState?.itemKey === patchMissionItemKey
      ? patchMissionImportState.result
      : null;
  const appliedReviewSubject = runEvidence.find(
    (stored) =>
      stored.evidence.phase ===
        (state.patch_cycle === 0 ? "execute" : "patch") &&
      stored.evidence.outcome === "applied" &&
      stored.evidence.identity.work_item_id === goal.work_item_id &&
      stored.evidence.identity.goal_version === state.goal_version &&
      stored.evidence.identity.input_revision === state.input_revision &&
      stored.evidence.identity.attempt === state.attempt &&
      (state.patch_cycle === 0 ||
        (stored.evidence.phase === "patch" &&
          stored.evidence.identity.patch_cycle === state.patch_cycle)),
  );
  const connectedPhaseProjection =
    connectedWorkflowPhase === "review" || connectedWorkflowPhase === "patch"
      ? connectedPhaseForItem(
          item,
          runEvidence,
          connectedWorkflowPhase,
          {
            runs: connectedRuns,
            ...(connectedModels === null ? {} : { models: connectedModels }),
          },
        )
      : null;
  const connectedPhasePicker = connectedPhaseProjection?.model_picker;
  const selectedConnectedPhaseModel =
    connectedWorkflowPhase !== null &&
    connectedModelSelectionState?.itemKey === connectedRunItemKey &&
    connectedModelSelectionState.phase === connectedWorkflowPhase &&
    connectedPhasePicker?.options.some(
      (option) => option.model_id === connectedModelSelectionState.model,
    )
      ? connectedModelSelectionState.model
      : connectedPhasePicker?.selected_model ?? null;
  const connectedReviewSubject: ConnectedReviewSubjectView | undefined =
    connectedWorkflowPhase === "review" && appliedReviewSubject !== undefined
      ? {
          phase: appliedReviewSubject.evidence.phase as "execute" | "patch",
          commit: appliedReviewSubject.evidence.result_commit ?? null,
          mission_path: `.founder/missions/${goal.work_item_id}/${appliedReviewSubject.evidence.phase}-${appliedReviewSubject.evidence.identity.goal_version}-${appliedReviewSubject.evidence.identity.input_revision}-${appliedReviewSubject.evidence.identity.attempt}${appliedReviewSubject.evidence.phase === "patch" ? `-${appliedReviewSubject.evidence.identity.patch_cycle}` : ""}/mission.json`,
          evidence_path: appliedReviewSubject.summary.evidence_path,
        }
      : undefined;
  const runEvidenceLoading =
    mode === "governed" &&
    (runEvidenceState?.itemKey !== runEvidenceItemKey ||
      runEvidenceState.loading);
  const runEvidenceError =
    mode === "governed" && runEvidenceState?.itemKey === runEvidenceItemKey
      ? runEvidenceState.error
      : null;
  const expandedRunIds =
    expandedRunEvidenceState?.itemKey === runEvidenceItemKey
      ? expandedRunEvidenceState.runIds
      : EMPTY_RUN_IDS;

  const loadRunEvidence = useCallback(
    async (signal?: AbortSignal) => {
      const loaded = await requestRunEvidence(
        item.source_id,
        goal.work_item_id,
        signal,
      );
      if (loaded === null) {
        return;
      }
      setRunEvidenceState((current) => ({
        itemKey: runEvidenceItemKey,
        result:
          loaded.result ??
          (current?.itemKey === runEvidenceItemKey ? current.result : []),
        loading: false,
        error: loaded.error,
      }));
    },
    [goal.work_item_id, item.source_id, runEvidenceItemKey],
  );

  const markRunEvidenceLoading = useCallback(() => {
    setRunEvidenceState((current) => ({
      itemKey: runEvidenceItemKey,
      result: current?.itemKey === runEvidenceItemKey ? current.result : [],
      loading: true,
      error: null,
    }));
  }, [runEvidenceItemKey]);

  const handleToggleRunEvidence = useCallback(
    (phase: "execute" | "review" | "patch", importRunId: string) => {
      setExpandedRunEvidenceState((current) => {
        const evidenceKey = `${phase}:${importRunId}`;
        const runIds =
          current?.itemKey === runEvidenceItemKey
            ? new Set(current.runIds)
            : new Set<string>();
        if (runIds.has(evidenceKey)) {
          runIds.delete(evidenceKey);
        } else {
          runIds.add(evidenceKey);
        }
        return { itemKey: runEvidenceItemKey, runIds };
      });
    },
    [runEvidenceItemKey],
  );

  const loadConnectedRuns = useCallback(
    async (signal?: AbortSignal) => {
      if (connectedWorkflowPhase === null) {
        return;
      }
      const [loaded, loadedModels] = await Promise.all([
        requestConnectedRuns(
          item.source_id,
          goal.work_item_id,
          connectedWorkflowPhase,
          signal,
        ),
        requestConnectedModels(
          item.source_id,
          goal.work_item_id,
          signal,
        ),
      ]);
      if (loaded === null || loadedModels === null) {
        return;
      }
      setConnectedRunState((current) => ({
        itemKey: connectedRunItemKey,
        result:
          loaded.result ??
          (current?.itemKey === connectedRunItemKey ? current.result : []),
        loading: false,
        error: loaded.error,
      }));
      setConnectedModelState((current) => ({
        itemKey: connectedRunItemKey,
        result:
          loadedModels.result ??
          (current?.itemKey === connectedRunItemKey
            ? current.result
            : null),
        loading: false,
        error: loadedModels.error,
      }));
    },
    [
      connectedRunItemKey,
      connectedWorkflowPhase,
      goal.work_item_id,
      item.source_id,
    ],
  );

  const markConnectedRunsLoading = useCallback(() => {
    setConnectedRunState((current) => ({
      itemKey: connectedRunItemKey,
      result:
        current?.itemKey === connectedRunItemKey ? current.result : [],
      loading: true,
      error: null,
    }));
    setConnectedModelState((current) => ({
      itemKey: connectedRunItemKey,
      result:
        current?.itemKey === connectedRunItemKey ? current.result : null,
      loading: true,
      error: null,
    }));
  }, [connectedRunItemKey]);

  const loadShapingArtifacts = useCallback(
    async (signal?: AbortSignal, expectedItemKey = shapingItemKey) => {
      const requestEpoch = ++shapingArtifactRequestEpochRef.current;
      const loaded = await requestShapingArtifacts(
        item.source_id,
        goal.work_item_id,
        signal,
      );
      if (loaded === null) {
        return;
      }
      const hashes =
        loaded.result === null
          ? null
          : await shapingGoalContractHashes(item, loaded.result);
      if (
        signal?.aborted ||
        shapingArtifactRequestEpochRef.current !== requestEpoch ||
        shapingItemKeyRef.current !== expectedItemKey
      ) {
        return;
      }
      setShapingArtifactState((current) =>
        shapingArtifactRequestEpochRef.current !== requestEpoch ||
        shapingItemKeyRef.current !== expectedItemKey
          ? current
          : {
              itemKey: expectedItemKey,
              listing:
                loaded.result ??
                (current?.itemKey === expectedItemKey
                  ? current.listing
                  : null),
              currentGoalContractSha256:
                hashes === null
                  ? current?.itemKey === expectedItemKey
                    ? current.currentGoalContractSha256
                    : null
                  : hashes.currentGoalContractSha256,
              derivedGoalContractSha256:
                hashes === null
                  ? current?.itemKey === expectedItemKey
                    ? current.derivedGoalContractSha256
                    : null
                  : hashes.derivedGoalContractSha256,
              loading: false,
              error: loaded.error,
            },
      );
    },
    [goal.work_item_id, item, shapingItemKey],
  );

  const markShapingArtifactsLoading = useCallback(
    (
      expectedItemKey = shapingItemKey,
      preserveCurrentListing = true,
    ) => {
      if (shapingItemKeyRef.current !== expectedItemKey) {
        return;
      }
      setShapingArtifactState((current) => {
        const preserve =
          preserveCurrentListing && current?.itemKey === expectedItemKey;
        return shapingItemKeyRef.current !== expectedItemKey
          ? current
          : {
              itemKey: expectedItemKey,
              listing: preserve ? current?.listing ?? null : null,
              currentGoalContractSha256: preserve
                ? current?.currentGoalContractSha256 ?? null
                : null,
              derivedGoalContractSha256: preserve
                ? current?.derivedGoalContractSha256 ?? null
                : null,
              loading: true,
              error: null,
            };
      });
    },
    [shapingItemKey],
  );

  const refreshShapingRun = useCallback(
    async (
      observation: ShapingRefreshObservation,
      signal: AbortSignal,
    ): Promise<ShapingRefreshObservation> => {
      const binding = shapingRefreshBindingRef.current;
      if (
        binding === null ||
        binding.observation.work_item_id !== observation.work_item_id ||
        binding.observation.run_status !== observation.run_status ||
        binding.observation.updated_at !== observation.updated_at
      ) {
        throw new Error("The visible shaping run changed before refresh.");
      }
      const requestEpoch = ++shapingArtifactRequestEpochRef.current;
      const loaded = await requestShapingArtifacts(
        binding.sourceId,
        binding.workItemId,
        signal,
      );
      if (signal.aborted) {
        throw new Error("The shaping refresh was aborted.");
      }
      if (loaded === null || loaded.result === null) {
        throw new Error(
          loaded?.error ?? "Shaping run status could not be refreshed.",
        );
      }
      const listing = loaded.result;
      if (
        listing.source_id !== binding.sourceId ||
        listing.work_item_id !== binding.workItemId
      ) {
        throw new Error("The shaping refresh returned a different work item.");
      }
      const run = listing.runs.find(
        (candidate) =>
          candidate.shaping_run_id === binding.shapingRunId &&
          candidate.mission.phase === binding.phase &&
          candidate.mission.content_sha256 === binding.missionContentSha256,
      );
      if (run === undefined) {
        throw new Error("The visible shaping run was absent from refresh.");
      }
      const hashes = await shapingGoalContractHashes(binding.item, listing);
      const currentBinding = shapingRefreshBindingRef.current;
      if (
        signal.aborted ||
        shapingArtifactRequestEpochRef.current !== requestEpoch ||
        currentBinding?.identity !== binding.identity ||
        currentBinding.itemKey !== binding.itemKey ||
        shapingItemKeyRef.current !== binding.itemKey
      ) {
        throw new Error("The shaping refresh no longer matches this panel.");
      }
      setShapingArtifactState((current) =>
        shapingArtifactRequestEpochRef.current !== requestEpoch ||
        shapingRefreshBindingRef.current?.identity !== binding.identity ||
        shapingItemKeyRef.current !== binding.itemKey
          ? current
          : {
              itemKey: binding.itemKey,
              listing,
              currentGoalContractSha256: hashes.currentGoalContractSha256,
              derivedGoalContractSha256: hashes.derivedGoalContractSha256,
              loading: false,
              error: null,
            },
      );
      return {
        work_item_id: binding.workItemId,
        run_status: run.lifecycle.status,
        updated_at: run.lifecycle.updated_at,
      };
    },
    [],
  );

  useEffect(() => {
    const controller = createShapingRefreshController({
      machine: boundedRefreshMachine,
      setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimeout: (handle) => window.clearTimeout(handle),
      now: () => Date.now(),
      refresh: refreshShapingRun,
    });
    shapingRefreshControllerRef.current = controller;
    const unsubscribe = controller.subscribe((snapshot) => {
      const identity = shapingRefreshControllerIdentityRef.current;
      if (identity !== null) {
        setShapingRefreshUiState({ identity, snapshot });
      }
    });
    return () => {
      unsubscribe();
      controller.stop();
      if (shapingRefreshControllerRef.current === controller) {
        shapingRefreshControllerRef.current = null;
      }
      shapingRefreshControllerIdentityRef.current = null;
    };
  }, [refreshShapingRun]);

  useEffect(() => {
    function handleVisibilityChange(): void {
      const visible = document.visibilityState === "visible";
      setPageVisible(visible);
      if (visible) {
        setShapingRefreshRestartVersion((current) => current + 1);
      }
    }

    function handleFocus(): void {
      if (document.visibilityState === "visible") {
        setPageVisible(true);
        setShapingRefreshRestartVersion((current) => current + 1);
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
    };
  }, []);

  useEffect(() => {
    const controller = shapingRefreshControllerRef.current;
    if (controller === null) {
      return;
    }
    const binding = shapingRefreshBindingRef.current;
    const nextIdentity = currentShapingRefreshIdentity;
    if (
      (binding?.identity ?? null) !== nextIdentity ||
      (binding?.observation.run_status ?? null) !==
        currentShapingRefreshRunStatus ||
      (binding?.observation.updated_at ?? null) !==
        currentShapingRefreshUpdatedAt
    ) {
      return;
    }
    const previousIdentity = shapingRefreshControllerIdentityRef.current;
    if (previousIdentity !== null && previousIdentity !== nextIdentity) {
      controller.stop();
    }
    shapingRefreshControllerIdentityRef.current = nextIdentity;

    if (
      binding !== null &&
      binding.observation.run_status === "terminal"
    ) {
      if (controller.snapshot().active) {
        controller.update({
          ...binding.observation,
          visible: pageVisible,
        });
        controller.stop();
      }
      return;
    }

    if (binding !== null && shapingDecisionBusy) {
      controller.update({
        ...binding.observation,
        visible: false,
      });
      return;
    }

    if (
      binding === null ||
      !shapingEligible ||
      showFullWorkItem
    ) {
      if (previousIdentity === nextIdentity && controller.snapshot().active) {
        controller.stop();
      }
      return;
    }

    const explicitRefresh =
      shapingRefreshAppliedRestartVersionRef.current !==
      shapingRefreshRestartVersion;
    shapingRefreshAppliedRestartVersionRef.current =
      shapingRefreshRestartVersion;
    controller.update({
      ...binding.observation,
      visible: pageVisible,
      ...(explicitRefresh ? { explicit_refresh: true } : {}),
    });
  }, [
    currentShapingRefreshIdentity,
    currentShapingRefreshRunStatus,
    currentShapingRefreshUpdatedAt,
    pageVisible,
    shapingDecisionBusy,
    shapingEligible,
    shapingRefreshRestartVersion,
    showFullWorkItem,
  ]);

  const attemptClose = useCallback(() => {
    if (
      mode === "capture" &&
      (detailsDirty || assignmentDirty || contractDirty) &&
      !window.confirm("Discard the unsaved capture changes?")
    ) {
      return;
    }
    onClose();
  }, [assignmentDirty, contractDirty, detailsDirty, mode, onClose]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        attemptClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [attemptClose]);

  useEffect(() => {
    if (mode !== "governed") {
      return;
    }
    const controller = new AbortController();
    void requestRunEvidence(
      item.source_id,
      goal.work_item_id,
      controller.signal,
    ).then((loaded) => {
      if (loaded === null) {
        return;
      }
      setRunEvidenceState((current) => ({
        itemKey: runEvidenceItemKey,
        result:
          loaded.result ??
          (current?.itemKey === runEvidenceItemKey ? current.result : []),
        loading: false,
        error: loaded.error,
      }));
    });
    return () => controller.abort();
  }, [goal.work_item_id, item.source_id, mode, runEvidenceItemKey]);

  useEffect(() => {
    if (mode !== "governed" || connectedWorkflowPhase === null) {
      return;
    }
    const controller = new AbortController();
    const requestHandle = window.setTimeout(() => {
      void loadConnectedRuns(controller.signal);
    }, 0);
    return () => {
      window.clearTimeout(requestHandle);
      controller.abort();
    };
  }, [
    connectedWorkflowPhase,
    loadConnectedRuns,
    mode,
  ]);

  useEffect(() => {
    if (
      mode !== "governed" ||
      state.phase !== "execute" ||
      state.status !== "active"
    ) {
      return;
    }
    const controller = new AbortController();
    void requestScopeCorrection(
      item.source_id,
      goal.work_item_id,
      controller.signal,
    ).then((loaded) => {
      if (loaded === null) {
        return;
      }
      setScopeCorrectionState({
        itemKey: connectedRunItemKey,
        listing: loaded.result,
        loading: false,
        error: loaded.error,
      });
    });
    return () => controller.abort();
  }, [
    connectedRunItemKey,
    goal.work_item_id,
    item.source_id,
    mode,
    state.phase,
    state.status,
  ]);

  useEffect(() => {
    if (
      mode !== "governed" ||
      state.phase !== "review" ||
      state.status !== "active"
    ) {
      return;
    }
    const controller = new AbortController();
    void requestReviewImportDriftRecovery(
      item.source_id,
      goal.work_item_id,
      controller.signal,
    ).then((loaded) => {
      if (loaded === null) {
        return;
      }
      setReviewImportDriftRecoveryState({
        itemKey: connectedRunItemKey,
        listing: loaded.result,
        loading: false,
        error: loaded.error,
      });
    });
    return () => controller.abort();
  }, [
    connectedRunItemKey,
    goal.work_item_id,
    item.source_id,
    mode,
    state.phase,
    state.status,
  ]);

  useEffect(() => {
    if (!shapingEligible) {
      return;
    }
    const controller = new AbortController();
    const requestEpoch = ++shapingArtifactRequestEpochRef.current;
    void requestShapingArtifacts(
      item.source_id,
      goal.work_item_id,
      controller.signal,
    ).then(async (loaded) => {
      if (
        loaded === null ||
        controller.signal.aborted ||
        shapingArtifactRequestEpochRef.current !== requestEpoch
      ) {
        return;
      }
      let hashes: Awaited<ReturnType<typeof shapingGoalContractHashes>> | null =
        null;
      try {
        hashes =
          loaded.result === null
            ? null
            : await shapingGoalContractHashes(item, loaded.result);
      } catch {
        if (
          !controller.signal.aborted &&
          shapingArtifactRequestEpochRef.current === requestEpoch &&
          shapingItemKeyRef.current === shapingItemKey
        ) {
          setShapingArtifactState((current) =>
            shapingArtifactRequestEpochRef.current !== requestEpoch ||
            shapingItemKeyRef.current !== shapingItemKey
              ? current
              : {
                  itemKey: shapingItemKey,
                  listing: null,
                  currentGoalContractSha256: null,
                  derivedGoalContractSha256: null,
                  loading: false,
                  error:
                    "The exact shaping contract binding could not be computed.",
                },
          );
        }
        return;
      }
      if (
        controller.signal.aborted ||
        shapingArtifactRequestEpochRef.current !== requestEpoch ||
        shapingItemKeyRef.current !== shapingItemKey
      ) {
        return;
      }
      setShapingArtifactState((current) =>
        shapingArtifactRequestEpochRef.current !== requestEpoch ||
        shapingItemKeyRef.current !== shapingItemKey
          ? current
          : {
              itemKey: shapingItemKey,
              listing:
                loaded.result ??
                (current?.itemKey === shapingItemKey
                  ? current.listing
                  : null),
              currentGoalContractSha256:
                hashes === null
                  ? current?.itemKey === shapingItemKey
                    ? current.currentGoalContractSha256
                    : null
                  : hashes.currentGoalContractSha256,
              derivedGoalContractSha256:
                hashes === null
                  ? current?.itemKey === shapingItemKey
                    ? current.derivedGoalContractSha256
                    : null
                  : hashes.derivedGoalContractSha256,
              loading: false,
              error: loaded.error,
            },
      );
    });
    return () => controller.abort();
  }, [
    goal.work_item_id,
    item,
    item.source_id,
    shapingEligible,
    shapingItemKey,
  ]);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEditWorkItem || title.trim().length === 0) {
      return;
    }
    if (hasContractInput && !contractComplete) {
      setError("Complete every goal contract field before saving it.");
      return;
    }
    if (
      goalContract === undefined &&
      hasContractInput &&
      targetSourceId === INBOX_SOURCE_ID
    ) {
      setError("Choose a project before activating a goal contract.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/edit`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            target_source_id: targetSourceId,
            title: title.trim(),
            type: type === "" ? null : type,
            priority: priority === "" ? null : priority,
            tags: tagsFromInput(tags),
            notes: notes.trim().length === 0 ? null : notes,
            ...(hasContractInput
              ? {
                  goal_contract: {
                    purpose: purpose.trim(),
                    acceptance_criteria: acceptanceCriteriaValues,
                    non_goals: nonGoalsValues,
                    allowed_scope: allowedScopeValues,
                    review_ready: reviewReadyValues,
                  },
                  ...(goalContract === undefined
                    ? {}
                    : {
                        expected_goal_version: goalContract.goal_version,
                        expected_input_revision: state.input_revision,
                      }),
                }
              : {}),
          }),
        },
      );
      const body = (await response.json()) as
        | PortfolioWorkItem
        | MutationErrorResponse;
      if (!response.ok) {
        setError(
          "error" in body
            ? body.error?.message ?? "The work item could not be saved."
            : "The work item could not be saved.",
        );
        return;
      }

      const updated = body as PortfolioWorkItem;
      setTitle(updated.work_item.goal.title);
      setType(updated.work_item.goal.type ?? "");
      setPriority(updated.work_item.goal.priority ?? "");
      setTags(updated.work_item.goal.tags?.join(", ") ?? "");
      setNotes(updated.work_item.goal.notes ?? "");
      setTargetSourceId(updated.source_id);
      setPurpose(updated.work_item.goal.goal_contract?.purpose ?? "");
      setAcceptanceCriteria(
        goalContractLines(updated.work_item.goal.goal_contract?.acceptance_criteria),
      );
      setNonGoals(goalContractLines(updated.work_item.goal.goal_contract?.non_goals));
      setAllowedScope(goalContractLines(updated.work_item.goal.goal_contract?.allowed_scope));
      setReviewReady(goalContractLines(updated.work_item.goal.goal_contract?.review_ready));
      if (updated.source_id === item.source_id) {
        onUpdated(updated, "Work item saved.");
      } else {
        onAssigned(item, updated);
      }
    } catch {
      setError("The work item could not be saved. Check the local server and try again.");
    } finally {
      setSaving(false);
    }
  }

  function setShapingActionError(
    message: string | null,
    expectedItemKey = shapingItemKey,
  ): void {
    if (shapingItemKeyRef.current !== expectedItemKey) {
      return;
    }
    setShapingArtifactState((current) =>
      shapingItemKeyRef.current !== expectedItemKey
        ? current
        : {
            itemKey: expectedItemKey,
            listing:
              current?.itemKey === expectedItemKey ? current.listing : null,
            currentGoalContractSha256:
              current?.itemKey === expectedItemKey
                ? current.currentGoalContractSha256
                : null,
            derivedGoalContractSha256:
              current?.itemKey === expectedItemKey
                ? current.derivedGoalContractSha256
                : null,
            loading: false,
            error: message,
          },
    );
  }

  async function handleCompileShapingMission(): Promise<void> {
    if (currentDecisionShapingPhase === null) {
      return;
    }
    const phase = currentDecisionShapingPhase;

    setShapingMutation("compiling");
    setShapingActionError(null);
    setShapingCopiedState(null);
    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/shaping/${phase}/mission`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const body = (await response.json()) as
        | ShapingCompilation
        | MutationErrorResponse;
      if (!response.ok || "error" in body) {
        setShapingActionError(
          "error" in body
            ? body.error?.message ?? "The shaping mission could not be compiled."
            : "The shaping mission could not be compiled.",
        );
        return;
      }
      setShapingCompilationState({
        itemKey: shapingItemKey,
        result: body as ShapingCompilation,
      });
    } catch {
      setShapingActionError(
        "The shaping mission could not be compiled. Check the local server and try again.",
      );
    } finally {
      setShapingMutation(null);
    }
  }

  async function handleImportShapingResult(): Promise<void> {
    if (currentShapingManualRecoveryBinding === null) {
      setShapingActionError(
        "Compile the current shaping mission before importing its result.",
      );
      return;
    }
    const binding = currentShapingManualRecoveryBinding;
    const phase = binding.phase;
    setShapingMutation("importing");
    setShapingActionError(null);
    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/shaping/${phase}/import`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expected_mission_content_sha256:
              binding.expectedMissionContentSha256,
            expected_shaping_state_sha256:
              binding.expectedShapingStateSha256,
          }),
        },
      );
      const body = (await response.json()) as
        | ShapingImportResult
        | MutationErrorResponse;
      if (!response.ok || "error" in body) {
        setShapingActionError(
          "error" in body
            ? body.error?.message ?? "The shaping result could not be imported."
            : "The shaping result could not be imported.",
        );
        return;
      }
      setShapingImportState({
        itemKey: shapingItemKey,
        result: body as ShapingImportResult,
      });
      markShapingArtifactsLoading();
      await loadShapingArtifacts();
    } catch {
      setShapingActionError(
        "The shaping result could not be imported. Check the local server and try again.",
      );
    } finally {
      setShapingMutation(null);
    }
  }

  async function handleCopyShapingValue(
    target: ShapingCopyTarget,
    value: string,
  ): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setShapingCopiedState({ itemKey: shapingItemKey, target });
    } catch {
      setShapingActionError("The shaping handoff value could not be copied.");
    }
  }

  async function handlePrepareShapingManualRecovery(
    retried: boolean,
  ): Promise<void> {
    const binding = currentShapingManualRecoveryBinding;
    if (binding === null) {
      return;
    }
    const operationKey = `prepare:${binding.identity}`;
    if (shapingManualRecoveryOperationsRef.current.has(operationKey)) {
      return;
    }
    shapingManualRecoveryOperationsRef.current.add(operationKey);
    setShapingManualRecoveryUiState((current) =>
      updateShapingManualRecovery(current, {
        type: "prepare_started",
        identity: binding.identity,
      }),
    );
    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/shaping/${binding.phase}/manual-ingress`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expected_mission_content_sha256:
              binding.expectedMissionContentSha256,
            expected_shaping_state_sha256:
              binding.expectedShapingStateSha256,
          }),
        },
      );
      const body = (await response.json()) as
        | ManualShapingIngressResult
        | MutationErrorResponse;
      if (shapingManualRecoveryIdentityRef.current !== binding.identity) {
        return;
      }
      if (!response.ok || "error" in body) {
        setShapingManualRecoveryUiState((current) =>
          updateShapingManualRecovery(current, {
            type: "prepare_failed",
            identity: binding.identity,
            reason:
              "error" in body
                ? body.error?.message ??
                  "The manual recovery instruction could not be published."
                : "The manual recovery instruction could not be published.",
            retried,
          }),
        );
        return;
      }
      setShapingManualRecoveryUiState((current) =>
        updateShapingManualRecovery(current, {
          type: "prepare_succeeded",
          identity: binding.identity,
          result: body as ManualShapingIngressResult,
        }),
      );
    } catch {
      if (shapingManualRecoveryIdentityRef.current === binding.identity) {
        setShapingManualRecoveryUiState((current) =>
          updateShapingManualRecovery(current, {
            type: "prepare_failed",
            identity: binding.identity,
            reason:
              "The manual recovery instruction could not be published. Check the local server and try again.",
            retried,
          }),
        );
      }
    } finally {
      shapingManualRecoveryOperationsRef.current.delete(operationKey);
    }
  }

  async function handleCopyShapingManualRecovery(
    target: "task" | "instruction" | "ingress",
    value: string,
  ): Promise<void> {
    const binding = currentShapingManualRecoveryBinding;
    if (binding === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      if (shapingManualRecoveryIdentityRef.current === binding.identity) {
        setShapingManualRecoveryUiState((current) =>
          updateShapingManualRecovery(current, {
            type: "copied",
            identity: binding.identity,
            target,
          }),
        );
      }
    } catch {
      if (shapingManualRecoveryIdentityRef.current === binding.identity) {
        setShapingManualRecoveryUiState((current) =>
          updateShapingManualRecovery(current, {
            type: "copy_failed",
            identity: binding.identity,
            reason: "The manual recovery value could not be copied.",
          }),
        );
      }
    }
  }

  async function handleImportShapingManualResult(): Promise<void> {
    const binding = currentShapingManualRecoveryBinding;
    if (binding === null) {
      return;
    }
    const operationKey = `import:${binding.identity}`;
    if (shapingManualRecoveryOperationsRef.current.has(operationKey)) {
      return;
    }
    shapingManualRecoveryOperationsRef.current.add(operationKey);
    let pausedRefresh = false;
    setShapingManualRecoveryUiState((current) =>
      updateShapingManualRecovery(current, {
        type: "import_started",
        identity: binding.identity,
      }),
    );
    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/shaping/${binding.phase}/import`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expected_mission_content_sha256:
              binding.expectedMissionContentSha256,
            expected_shaping_state_sha256:
              binding.expectedShapingStateSha256,
          }),
        },
      );
      const body = (await response.json()) as
        | ShapingImportResult
        | MutationErrorResponse;
      if (shapingManualRecoveryIdentityRef.current !== binding.identity) {
        return;
      }
      if (!response.ok || "error" in body) {
        setShapingManualRecoveryUiState((current) =>
          updateShapingManualRecovery(current, {
            type: "import_failed",
            identity: binding.identity,
            reason:
              "error" in body
                ? body.error?.message ??
                  "The manual shaping result could not be imported."
                : "The manual shaping result could not be imported.",
          }),
        );
        return;
      }
      const imported = body as ShapingImportResult;
      setShapingImportState({ itemKey: shapingItemKey, result: imported });
      setShapingManualRecoveryUiState((current) =>
        updateShapingManualRecovery(current, {
          type: "import_succeeded",
          identity: binding.identity,
          result: imported,
        }),
      );
      if (imported.outcome === "applied") {
        const refreshBinding = shapingRefreshBindingRef.current;
        if (refreshBinding !== null) {
          shapingRefreshControllerRef.current?.update({
            ...refreshBinding.observation,
            visible: false,
          });
          pausedRefresh = true;
        }
        markShapingArtifactsLoading();
        await loadShapingArtifacts();
      }
    } catch {
      if (shapingManualRecoveryIdentityRef.current === binding.identity) {
        setShapingManualRecoveryUiState((current) =>
          updateShapingManualRecovery(current, {
            type: "import_failed",
            identity: binding.identity,
            reason:
              "The manual shaping result could not be imported. Check the local server and try again.",
          }),
        );
      }
    } finally {
      shapingManualRecoveryOperationsRef.current.delete(operationKey);
      if (
        pausedRefresh &&
        shapingManualRecoveryIdentityRef.current === binding.identity
      ) {
        setShapingRefreshRestartVersion((current) => current + 1);
      }
    }
  }

  function handleUseSpecProposal(
    proposal: SpecResultSubmission["proposal"],
  ): void {
    const draft = specProposalToGoalContractDraft(proposal);
    setPurpose(draft.purpose);
    setAcceptanceCriteria(draft.acceptanceCriteria);
    setNonGoals(draft.nonGoals);
    setAllowedScope(draft.allowedScope);
    setReviewReady(draft.reviewReady);
    setShapingActionError(null);
  }

  function handleOpenShapingRequestChanges(
    launchMode: "connected" | "manual",
  ): void {
    if (
      shapingRequestChangesIdentity === null ||
      shapingRequestChangesProjection === null
    ) {
      return;
    }
    const defaultModel = selectedModelForShapingPicker(
      shapingRequestChangesProjection.model_picker ?? null,
      null,
    );
    setShapingRequestChangesComposerState((current) =>
      updateShapingRequestChangesComposer(current, {
        type: "open",
        identity: shapingRequestChangesIdentity,
        launchMode,
        selectedModel: defaultModel,
      }),
    );
  }

  function handleCloseShapingRequestChanges(): void {
    if (shapingRequestChangesIdentity === null) {
      return;
    }
    setShapingRequestChangesComposerState((current) =>
      updateShapingRequestChangesComposer(current, {
        type: "close",
        identity: shapingRequestChangesIdentity,
      }),
    );
  }

  function handleChangeShapingRequestFeedback(feedback: string): void {
    if (shapingRequestChangesIdentity === null) {
      return;
    }
    setShapingRequestChangesComposerState((current) =>
      updateShapingRequestChangesComposer(current, {
        type: "feedback_changed",
        identity: shapingRequestChangesIdentity,
        feedback,
      }),
    );
  }

  function handleSelectShapingRequestModel(model: string): void {
    if (shapingRequestChangesIdentity === null) {
      return;
    }
    setShapingRequestChangesComposerState((current) =>
      updateShapingRequestChangesComposer(current, {
        type: "model_selected",
        identity: shapingRequestChangesIdentity,
        model,
      }),
    );
  }

  async function handleShapingDecisionAction(
    action: ShapingActionProjection,
    requestChanges?: {
      identity: string;
      feedback: string;
      selectedModel: string | null;
    },
  ): Promise<void> {
    if (
      shapingDecisionProjection === null ||
      shapingDecisionIdentity === null ||
      (requestChanges !== undefined &&
        requestChanges.identity !== shapingRequestChangesIdentity) ||
      shapingDecisionBusyRef.current.has(shapingDecisionIdentity)
    ) {
      return;
    }
    const operationIdentity = shapingDecisionIdentity;
    const operationItemKey = shapingItemKey;
    const operationSelectedModel =
      requestChanges === undefined
        ? selectedShapingModel
        : requestChanges.selectedModel;
    const setActionFailure = (message: string): void => {
      if (requestChanges === undefined) {
        setShapingActionError(message, operationItemKey);
        return;
      }
      setShapingRequestChangesComposerState((current) =>
        updateShapingRequestChangesComposer(current, {
          type: "request_failed",
          identity: requestChanges.identity,
          reason: message,
        }),
      );
    };
    if (requestChanges !== undefined) {
      setShapingRequestChangesComposerState((current) =>
        updateShapingRequestChangesComposer(current, {
          type: "request_started",
          identity: requestChanges.identity,
        }),
      );
    }
    const request = shapingActionRequest({
      source_id: item.source_id,
      work_item_id: goal.work_item_id,
      projection: shapingDecisionProjection,
      action,
      selected_model: operationSelectedModel,
      feedback: requestChanges?.feedback,
    });
    if (request.status === "blocked") {
      if (request.reason === "new_attempt_selection_required") {
        if (shapingDecisionProjection.mode === "post_commit_launch_failure") {
          setShapingNewAttemptState({
            itemKey: shapingItemKey,
            decision_id: shapingDecisionProjection.decision_id,
          });
        }
        setShapingActionError(null);
        return;
      }
      setActionFailure(
        request.reason === "feedback_required"
          ? "Add feedback in the Request changes composer before submitting this action."
          : request.reason === "missing_model"
            ? "Choose a model before continuing."
            : request.reason === "unsupported_action"
              ? "This recovery action is completed in Advanced recovery."
              : "This action is no longer available for the current shaping state.",
      );
      return;
    }

    shapingDecisionBusyRef.current.add(operationIdentity);
    setShapingDecisionBusyIdentities(
      new Set(shapingDecisionBusyRef.current),
    );
    if (shapingDecisionProjection.mode === "run_state") {
      const binding = shapingRefreshBindingRef.current;
      if (binding !== null) {
        shapingRefreshControllerRef.current?.update({
          ...binding.observation,
          visible: false,
        });
      }
    }
    setShapingActionError(null);
    let crossedIntoExecute = false;
    try {
      const response = await fetch(request.route, {
        method: request.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.body),
      });
      const body = (await response.json()) as
        | PortfolioPlanApprovalResult
        | PortfolioShapingDecisionResult
        | PortfolioShapingLaunchResult
        | MutationErrorResponse;
      if (shapingItemKeyRef.current !== operationItemKey) {
        return;
      }
      if (!response.ok || "error" in body) {
        if ("error" in body && currentDecisionShapingPhase !== null) {
          const retainedRepair = retainedControllerLeaseRepairForConflict({
            itemKey: operationItemKey,
            phase: currentDecisionShapingPhase,
            errorCode: body.error?.code,
            errorMessage: body.error?.message,
            activeRun: state.active_run,
          });
          if (retainedRepair !== null) {
            setRetainedControllerLeaseRepairState(retainedRepair);
          }
        }
        setActionFailure(
          "error" in body
            ? body.error?.message ?? "The shaping action could not be completed."
            : "The shaping action could not be completed.",
        );
        return;
      }

      if (requestChanges !== undefined) {
        setShapingRequestChangesComposerState((current) =>
          updateShapingRequestChangesComposer(current, {
            type: "request_succeeded",
            identity: requestChanges.identity,
          }),
        );
      }
      setRetainedControllerLeaseRepairState(null);

      if ("work_item" in body) {
        const decision = body as
          | PortfolioPlanApprovalResult
          | PortfolioShapingDecisionResult;
        const decidedGoal = decision.work_item.goal;
        const decidedContract = decidedGoal.goal_contract;
        setTitle(decidedGoal.title);
        setType(decidedGoal.type ?? "");
        setPriority(decidedGoal.priority ?? "");
        setTags(decidedGoal.tags?.join(", ") ?? "");
        setNotes(decidedGoal.notes ?? "");
        setTargetSourceId(decision.source_id);
        setPurpose(decidedContract?.purpose ?? "");
        setAcceptanceCriteria(
          goalContractLines(decidedContract?.acceptance_criteria),
        );
        setNonGoals(goalContractLines(decidedContract?.non_goals));
        setAllowedScope(goalContractLines(decidedContract?.allowed_scope));
        setReviewReady(goalContractLines(decidedContract?.review_ready));
        if ("approval_id" in decision) {
          crossedIntoExecute = true;
          clearShapingStateForExecuteHandoff({
            stopShapingRefresh: () =>
              shapingRefreshControllerRef.current?.stop(),
            clearShapingRefreshIdentity: () => {
              shapingRefreshControllerIdentityRef.current = null;
            },
            clearShapingRefreshBinding: () => {
              shapingRefreshBindingRef.current = null;
            },
            setShapingLaunchFailureState,
            setShapingNewAttemptState,
            setShowFullWorkItem,
          });
          onUpdated(
            decision,
            decision.next_launch.status === "manual"
              ? "Plan approved; Execute is ready for manual recovery."
              : decision.next_launch.status === "failed"
                ? "Plan approved; Execute launch needs attention."
                : "Plan approved and Execute started.",
          );
          return;
        }
        setShowFullWorkItem(false);
        setShapingNewAttemptState(null);
        if (
          decision.next_launch.status === "failed" &&
          decision.next_launch.shaping_run_id === null &&
          action.launch_mode === "connected" &&
          operationSelectedModel !== null
        ) {
          setShapingLaunchFailureState({
            itemKey: shapingItemStateKey(decision),
            decision_id: decision.decision_id,
            locked_model: operationSelectedModel,
            reason:
              decision.next_launch.reason ??
              "The committed shaping decision could not launch its next seat.",
          });
        } else {
          setShapingLaunchFailureState(null);
        }
        if (action.kind === "request_changes") {
          // onUpdated replaces the item; its abortable effect owns the sole
          // artifact reload so an older parallel GET cannot win afterward.
          markShapingArtifactsLoading(operationItemKey, false);
        }
        onUpdated(
          decision,
          decision.next_launch.status === "manual"
            ? "Shaping decision committed for manual recovery."
            : decision.next_launch.status === "failed"
              ? "Shaping decision committed; launch needs attention."
              : "Shaping decision committed and the next seat started.",
        );
        return;
      }

      const launch = body as PortfolioShapingLaunchResult;
      if (
        shapingDecisionProjection.mode === "post_commit_launch_failure" &&
        launch.next_launch.status === "failed" &&
        launch.next_launch.shaping_run_id === null
      ) {
        setShapingLaunchFailureState({
          itemKey: operationItemKey,
          decision_id: shapingDecisionProjection.decision_id,
          locked_model: shapingDecisionProjection.locked_model,
          reason:
            launch.next_launch.reason ?? shapingDecisionProjection.reason,
        });
      } else {
        setShapingLaunchFailureState(null);
      }
      markShapingArtifactsLoading(operationItemKey);
      await loadShapingArtifacts(undefined, operationItemKey);
    } catch {
      setActionFailure(
        "The shaping action could not be completed. Check the local server and try again.",
      );
    } finally {
      shapingDecisionBusyRef.current.delete(operationIdentity);
      setShapingDecisionBusyIdentities(
        new Set(shapingDecisionBusyRef.current),
      );
      if (
        !crossedIntoExecute &&
        shapingItemKeyRef.current === operationItemKey
      ) {
        setShapingRefreshRestartVersion((current) => current + 1);
      }
    }
  }

  function handleAcknowledgeRetainedControllerLease(
    acknowledged: boolean,
  ): void {
    const identity = currentRetainedControllerLeaseRepair?.identity;
    if (identity === undefined) {
      return;
    }
    setRetainedControllerLeaseRepairState((current) =>
      current?.identity === identity &&
      current.status === "awaiting_acknowledgement"
        ? { ...current, acknowledged, error: null }
        : current,
    );
  }

  async function handleRepairRetainedControllerLease(): Promise<void> {
    const repair = currentRetainedControllerLeaseRepair;
    if (repair === null) {
      return;
    }
    const request = retainedControllerLeaseRepairRequest(
      item.source_id,
      goal.work_item_id,
      repair,
    );
    if (request.status === "blocked") {
      return;
    }
    const identity = repair.identity;
    setRetainedControllerLeaseRepairState((current) =>
      current?.identity === identity
        ? { ...current, status: "repairing", error: null }
        : current,
    );
    try {
      const response = await fetch(request.route, {
        method: request.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.body),
      });
      const body = (await response.json()) as
        | RetainedControllerLeaseRepairResult
        | MutationErrorResponse;
      if (!response.ok || "error" in body) {
        setRetainedControllerLeaseRepairState((current) =>
          current?.identity === identity
            ? {
                ...current,
                status: "awaiting_acknowledgement",
                error:
                  "error" in body
                    ? body.error?.message ??
                      "The retained controller lock could not be repaired."
                    : "The retained controller lock could not be repaired.",
              }
            : current,
        );
        return;
      }
      setRetainedControllerLeaseRepairState((current) =>
        current?.identity === identity
          ? {
              ...current,
              acknowledged: false,
              status: "repaired",
              error: null,
            }
          : current,
      );
      setShapingActionError(null, repair.itemKey);
      if (shapingRequestChangesIdentity !== null) {
        setShapingRequestChangesComposerState((current) =>
          updateShapingRequestChangesComposer(current, {
            type: "request_started",
            identity: shapingRequestChangesIdentity,
          }),
        );
      }
    } catch {
      setRetainedControllerLeaseRepairState((current) =>
        current?.identity === identity
          ? {
              ...current,
              status: "awaiting_acknowledgement",
              error:
                "The retained controller lock could not be repaired. Check the local server and try again.",
            }
          : current,
      );
    }
  }

  async function handleCompileMission() {
    setCompilingMission(true);
    setError(null);
    setCopiedMissionKey(null);

    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/mission`,
        { method: "POST" },
      );
      const body = (await response.json()) as
        | MissionCompilation
        | MutationErrorResponse;
      if (!response.ok) {
        setError(
          "error" in body
            ? body.error?.message ?? "The mission could not be compiled."
            : "The mission could not be compiled.",
        );
        return;
      }

      setMissionCompilationState({
        itemKey: missionItemKey,
        result: body as MissionCompilation,
      });
    } catch {
      setError(
        "The mission could not be compiled. Check the local server and try again.",
      );
    } finally {
      setCompilingMission(false);
    }
  }

  async function handleImportResult() {
    setImportingResult(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/mission/import`,
        { method: "POST" },
      );
      const body = (await response.json()) as
        | PortfolioImportResult
        | MutationErrorResponse;
      if (!response.ok) {
        setError(
          "error" in body
            ? body.error?.message ?? "The returned result could not be imported."
            : "The returned result could not be imported.",
        );
        return;
      }

      const imported = body as PortfolioImportResult;
      setMissionImportState({
        itemKey: missionItemKey,
        result: imported.evidence,
      });
      markRunEvidenceLoading();
      await loadRunEvidence();
      onUpdated(
        imported,
        imported.evidence.outcome === "applied"
          ? "Result imported and ready for review."
          : "Result imported; a repair attempt is required.",
      );
    } catch {
      setError(
        "The returned result could not be imported. Check the local server and try again.",
      );
    } finally {
      setImportingResult(false);
    }
  }

  async function handleCompileReviewMission() {
    if (!reviewAttested) {
      return;
    }
    setCompilingReviewMission(true);
    setError(null);
    setCopiedMissionKey(null);

    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/mission/review`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ independence_attested: true }),
        },
      );
      const body = (await response.json()) as
        | ReviewMissionCompilation
        | MutationErrorResponse;
      if (!response.ok) {
        setError(
          "error" in body
            ? body.error?.message ?? "The review mission could not be compiled."
            : "The review mission could not be compiled.",
        );
        return;
      }

      setReviewMissionCompilationState({
        itemKey: reviewMissionItemKey,
        result: body as ReviewMissionCompilation,
      });
    } catch {
      setError(
        "The review mission could not be compiled. Check the local server and try again.",
      );
    } finally {
      setCompilingReviewMission(false);
    }
  }

  async function handleImportReviewResult() {
    setImportingReviewResult(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/mission/review/import`,
        { method: "POST" },
      );
      const body = (await response.json()) as
        | PortfolioReviewImportResult
        | MutationErrorResponse;
      if (!response.ok) {
        setError(
          "error" in body
            ? body.error?.message ?? "The review result could not be imported."
            : "The review result could not be imported.",
        );
        return;
      }

      const imported = body as PortfolioReviewImportResult;
      setReviewMissionImportState({
        itemKey: reviewMissionItemKey,
        result: imported,
      });
      markRunEvidenceLoading();
      await loadRunEvidence();
      onUpdated(
        imported,
        imported.evidence.outcome === "applied"
          ? imported.result?.verdict === "findings"
            ? "Review findings imported; the next decision is ready."
            : "Clean review imported; human review is ready."
          : "Review output was rejected; the current workflow state is unchanged.",
      );
    } catch {
      setError(
        "The review result could not be imported. Check the local server and try again.",
      );
    } finally {
      setImportingReviewResult(false);
    }
  }

  async function handleAcceptPatchPlan() {
    setPatchMutation("accepting_plan");
    setError(null);

    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/patch-plan`,
        { method: "POST" },
      );
      const body = (await response.json()) as
        | PortfolioPatchPlanResult
        | MutationErrorResponse;
      if (!response.ok) {
        setError(
          "error" in body
            ? body.error?.message ?? "The patch plan could not be approved."
            : "The patch plan could not be approved.",
        );
        return;
      }

      const accepted = body as PortfolioPatchPlanResult;
      setPatchMissionCompilationState(null);
      setPatchMissionImportState(null);
      onUpdated(
        accepted,
        `Patch cycle ${accepted.work_item.state.patch_cycle ?? "unknown"} started.`,
      );
    } catch {
      setError(
        "The patch plan could not be approved. Check the local server and try again.",
      );
    } finally {
      setPatchMutation(null);
    }
  }

  async function handleCompilePatchMission() {
    setPatchMutation("compiling");
    setError(null);
    setCopiedMissionKey(null);

    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/mission/patch`,
        { method: "POST" },
      );
      const body = (await response.json()) as
        | PatchMissionCompilation
        | MutationErrorResponse;
      if (!response.ok) {
        setError(
          "error" in body
            ? body.error?.message ?? "The patch mission could not be compiled."
            : "The patch mission could not be compiled.",
        );
        return;
      }

      setPatchMissionCompilationState({
        itemKey: patchMissionItemKey,
        result: body as PatchMissionCompilation,
      });
    } catch {
      setError(
        "The patch mission could not be compiled. Check the local server and try again.",
      );
    } finally {
      setPatchMutation(null);
    }
  }

  async function handleImportPatchResult() {
    setPatchMutation("importing");
    setError(null);

    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/mission/patch/import`,
        { method: "POST" },
      );
      const body = (await response.json()) as
        | PortfolioPatchImportResult
        | MutationErrorResponse;
      if (!response.ok) {
        setError(
          "error" in body
            ? body.error?.message ?? "The patch result could not be imported."
            : "The patch result could not be imported.",
        );
        return;
      }

      const imported = body as PortfolioPatchImportResult;
      setPatchMissionImportState({
        itemKey: patchMissionItemKey,
        result: imported.evidence,
      });
      markRunEvidenceLoading();
      await loadRunEvidence();
      onUpdated(
        imported,
        imported.evidence.outcome === "applied"
          ? "Patch imported and ready for independent re-review."
          : "Patch imported; correct the rejected result before retrying.",
      );
    } catch {
      setError(
        "The patch result could not be imported. Check the local server and try again.",
      );
    } finally {
      setPatchMutation(null);
    }
  }

  async function handleStartRepair() {
    setStartingRepair(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/mission/retry`,
        { method: "POST" },
      );
      const body = (await response.json()) as
        | PortfolioRetryResult
        | MutationErrorResponse;
      if (!response.ok) {
        setError(
          "error" in body
            ? body.error?.message ?? "A repair attempt could not be started."
            : "A repair attempt could not be started.",
        );
        return;
      }

      setMissionCompilationState(null);
      setMissionImportState(null);
      const retried = body as PortfolioRetryResult;
      markRunEvidenceLoading();
      await loadRunEvidence();
      onUpdated(retried, "Repair attempt started.");
    } catch {
      setError(
        "A repair attempt could not be started. Check the local server and try again.",
      );
    } finally {
      setStartingRepair(false);
    }
  }

  async function handleCopyLaunchInstruction(
    compilation:
      | MissionCompilation
      | ReviewMissionCompilation
      | PatchMissionCompilation,
    itemKey: string,
  ) {
    try {
      await navigator.clipboard.writeText(
        `Open the workspace in your chosen agent and follow ${compilation.task_path}.`,
      );
      setCopiedMissionKey(itemKey);
    } catch {
      setError("The launch instruction could not be copied.");
    }
  }

  async function handleLaunchConnectedRun() {
    if (connectedMutationRef.current || !connectedExecute.can_launch) {
      return;
    }
    connectedMutationRef.current = true;
    setConnectedMutation("launching");
    markConnectedRunsLoading();

    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/mission/connected/launch`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            connectedModelOverride.trim().length === 0
              ? {}
              : { model_override: connectedModelOverride.trim() },
          ),
        },
      );
      const body = (await response.json()) as
        | ConnectedRunSummary
        | MutationErrorResponse;
      if (!response.ok) {
        setConnectedRunState((current) => ({
          itemKey: connectedRunItemKey,
          result:
            current?.itemKey === connectedRunItemKey ? current.result : [],
          loading: false,
          error:
            "error" in body
              ? body.error?.message ?? "The connected run could not be launched."
              : "The connected run could not be launched.",
        }));
        return;
      }

      setConnectedRunState({
        itemKey: connectedRunItemKey,
        result: [body as ConnectedRunSummary],
        loading: false,
        error: null,
      });
      setConnectedModelOverride("");
    } catch {
      setConnectedRunState((current) => ({
        itemKey: connectedRunItemKey,
        result:
          current?.itemKey === connectedRunItemKey ? current.result : [],
        loading: false,
        error: "The connected run could not be launched. Check the local server and try again.",
      }));
    } finally {
      connectedMutationRef.current = false;
      setConnectedMutation(null);
    }
  }

  async function handleApplyScopeCorrection() {
    if (scopeCorrection === null || applyingScopeCorrection) {
      return;
    }
    setApplyingScopeCorrection(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/mission/scope-correction`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source_goal_contract_sha256:
              scopeCorrection.source_goal_contract_sha256,
            governed_tuple: scopeCorrection.governed_tuple,
            proposal_sha256: scopeCorrection.proposal_sha256,
          }),
        },
      );
      const body = (await response.json()) as
        | PortfolioScopeCorrectionResult
        | MutationErrorResponse;
      if (!response.ok || "error" in body) {
        setError(
          "error" in body
            ? body.error?.message ?? "The scope correction could not be applied."
            : "The scope correction could not be applied.",
        );
        return;
      }
      const corrected = body as PortfolioScopeCorrectionResult;
      setScopeCorrectionState(null);
      setMissionCompilationState(null);
      setMissionImportState(null);
      onUpdated(
        corrected,
        "Exact scope approved; a fresh Execute attempt is ready.",
      );
    } catch {
      setError(
        "The scope correction could not be applied. Check the local server and try again.",
      );
    } finally {
      setApplyingScopeCorrection(false);
    }
  }

  async function handleApplyReviewImportDriftRecovery() {
    if (
      reviewImportDriftRecovery === null ||
      applyingReviewImportDriftRecovery
    ) {
      return;
    }
    setApplyingReviewImportDriftRecovery(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/mission/review/import-drift-recovery`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decision: "accept_exact_drift",
            governed_tuple: {
              goal_version: reviewImportDriftRecovery.identity.goal_version,
              input_revision: reviewImportDriftRecovery.identity.input_revision,
              attempt: reviewImportDriftRecovery.identity.attempt,
              patch_cycle: reviewImportDriftRecovery.patch_cycle,
            },
            review_mission_content_sha256:
              reviewImportDriftRecovery.review_mission_content_sha256,
            result_content_sha256:
              reviewImportDriftRecovery.result_content_sha256,
            rejected_import_run_id:
              reviewImportDriftRecovery.rejected_import_run_id,
            accepted_result_commit:
              reviewImportDriftRecovery.accepted_result_commit,
            current_head_commit:
              reviewImportDriftRecovery.current_head_commit,
            proposal_sha256: reviewImportDriftRecovery.proposal_sha256,
          }),
        },
      );
      const body = (await response.json()) as
        | PortfolioReviewImportDriftRecoveryResult
        | MutationErrorResponse;
      if (!response.ok || "error" in body) {
        setError(
          "error" in body
            ? body.error?.message ??
              "The Review import drift decision could not be applied."
            : "The Review import drift decision could not be applied.",
        );
        return;
      }
      await completeReviewImportDriftRecoverySuccess({
        itemKey: connectedRunItemKey,
        sourceId: item.source_id,
        workItemId: goal.work_item_id,
        updatedItem: body as PortfolioReviewImportDriftRecoveryResult,
        setRecoveryState: setReviewImportDriftRecoveryState,
        clearReviewMissionImportState: setReviewMissionImportState,
        markRunEvidenceLoading,
        loadRunEvidence,
        onUpdated,
      });
    } catch {
      setError(
        "The Review import drift decision could not be applied. Check the local server and try again.",
      );
    } finally {
      setApplyingReviewImportDriftRecovery(false);
    }
  }

  async function handlePrepareCommandAuthorization() {
    if (
      connectedWorkflowPhase === null ||
      connectedWorkflowPhase === "review" ||
      connectedMutationRef.current
    ) {
      return;
    }
    connectedMutationRef.current = true;
    setConnectedMutation("preparing_commands");
    setError(null);
    const prefix =
      connectedWorkflowPhase === "execute"
        ? "mission/connected"
        : "mission/patch/connected";
    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/${prefix}/command-authorization/prepare`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const body = (await response.json()) as
        | PortfolioCommandAuthorizationResult
        | MutationErrorResponse;
      if (!response.ok || "error" in body) {
        setError(
          "error" in body
            ? body.error?.message ?? "Exact commands could not be prepared."
            : "Exact commands could not be prepared.",
        );
        return;
      }
      onUpdated(
        body as PortfolioCommandAuthorizationResult,
        "Exact commands are ready for founder review.",
      );
    } catch {
      setError(
        "Exact commands could not be prepared. Check the local server and try again.",
      );
    } finally {
      connectedMutationRef.current = false;
      setConnectedMutation(null);
    }
  }

  async function handleCommandAuthorizationDecision(
    decision: "allow_once" | "keep_denied",
  ) {
    if (
      commandAuthorizationAttention === null ||
      connectedMutationRef.current
    ) {
      return;
    }
    connectedMutationRef.current = true;
    setConnectedMutation(
      decision === "allow_once" ? "authorizing_commands" : "keeping_denied",
    );
    setError(null);
    const proposal = commandAuthorizationAttention.proposal;
    const prefix =
      proposal.phase === "execute"
        ? "mission/connected"
        : "mission/patch/connected";
    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/${prefix}/command-authorization/decision`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decision,
            expected_phase: proposal.phase,
            governed_tuple: proposal.governed_tuple,
            source_mission_content_sha256:
              proposal.source_mission_content_sha256,
            terminal_connected_run_id:
              proposal.terminal_connected_run_id,
            proposal_sha256: proposal.proposal_sha256,
          }),
        },
      );
      const body = (await response.json()) as
        | PortfolioCommandAuthorizationResult
        | MutationErrorResponse;
      if (!response.ok || "error" in body) {
        setError(
          "error" in body
            ? body.error?.message ?? "The command decision could not be recorded."
            : "The command decision could not be recorded.",
        );
        return;
      }
      onUpdated(
        body as PortfolioCommandAuthorizationResult,
        decision === "allow_once"
          ? "Exact commands allowed once; a fresh writable attempt is ready."
          : "Exact commands remain denied.",
      );
    } catch {
      setError(
        "The command decision could not be recorded. Check the local server and try again.",
      );
    } finally {
      connectedMutationRef.current = false;
      setConnectedMutation(null);
    }
  }

  async function handleLaunchConnectedPhase() {
    if (
      connectedMutationRef.current ||
      connectedPhaseProjection?.mode !== "launch" ||
      !connectedPhaseProjection.can_launch ||
      connectedWorkflowPhase === null ||
      connectedWorkflowPhase === "execute" ||
      connectedModels === null ||
      connectedModelsLoading ||
      selectedConnectedPhaseModel === null ||
      (connectedWorkflowPhase === "review" && !reviewAttested)
    ) {
      return;
    }
    connectedMutationRef.current = true;
    setConnectedMutation("launching");
    markConnectedRunsLoading();
    const connectedPath = `mission/${connectedWorkflowPhase}/connected/launch`;
    const requestBody =
      connectedWorkflowPhase === "review"
        ? {
            independence_attested: true as const,
            model_override: selectedConnectedPhaseModel,
          }
        : { model_override: selectedConnectedPhaseModel };

    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/${connectedPath}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(requestBody),
        },
      );
      const body = (await response.json()) as
        | ConnectedRunSummary
        | MutationErrorResponse;
      if (!response.ok || "error" in body) {
        setConnectedRunState((current) => ({
          itemKey: connectedRunItemKey,
          result:
            current?.itemKey === connectedRunItemKey ? current.result : [],
          loading: false,
          error:
            "error" in body
              ? body.error?.message ??
                `The connected ${connectedWorkflowPhase} run could not be launched.`
              : `The connected ${connectedWorkflowPhase} run could not be launched.`,
        }));
        return;
      }
      const launchedRun = body as ConnectedRunSummary;
      setConnectedRunState((current) => ({
        itemKey: connectedRunItemKey,
        result: [
          ...(current?.itemKey === connectedRunItemKey
            ? current.result.filter(
                (run) =>
                  run.connected_run_id !== launchedRun.connected_run_id,
              )
            : []),
          launchedRun,
        ],
        loading: false,
        error: null,
      }));
      setConnectedModelState((current) => ({
        itemKey: connectedRunItemKey,
        result:
          current?.itemKey === connectedRunItemKey ? current.result : null,
        loading: false,
        error: null,
      }));
    } catch {
      setConnectedRunState((current) => ({
        itemKey: connectedRunItemKey,
        result:
          current?.itemKey === connectedRunItemKey ? current.result : [],
        loading: false,
        error: `The connected ${connectedWorkflowPhase} run could not be launched. Check the local server and try again.`,
      }));
    } finally {
      connectedMutationRef.current = false;
      setConnectedMutation(null);
    }
  }

  async function handleCancelConnectedPhase() {
    if (
      connectedMutationRef.current ||
      connectedPhaseProjection?.mode !== "running" ||
      connectedPhaseProjection.run === null ||
      connectedWorkflowPhase === null ||
      connectedWorkflowPhase === "execute"
    ) {
      return;
    }
    connectedMutationRef.current = true;
    setConnectedMutation("cancelling");
    const connectedRunId = connectedPhaseProjection.run.connected_run_id;
    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/mission/${connectedWorkflowPhase}/connected/cancel`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ connected_run_id: connectedRunId }),
        },
      );
      const body = (await response.json()) as
        | ConnectedRunSummary
        | MutationErrorResponse;
      if (!response.ok || "error" in body) {
        setConnectedRunState((current) => ({
          itemKey: connectedRunItemKey,
          result:
            current?.itemKey === connectedRunItemKey ? current.result : [],
          loading: false,
          error:
            "error" in body
              ? body.error?.message ?? "The connected run could not be cancelled."
              : "The connected run could not be cancelled.",
        }));
        return;
      }
      const cancelledRun = body as ConnectedRunSummary;
      setConnectedRunState((current) => ({
        itemKey: connectedRunItemKey,
        result: [
          ...(current?.itemKey === connectedRunItemKey
            ? current.result.filter(
                (run) =>
                  run.connected_run_id !== cancelledRun.connected_run_id,
              )
            : []),
          cancelledRun,
        ],
        loading: false,
        error: null,
      }));
    } catch {
      setConnectedRunState((current) => ({
        itemKey: connectedRunItemKey,
        result:
          current?.itemKey === connectedRunItemKey ? current.result : [],
        loading: false,
        error: "The connected run could not be cancelled. Check the local server and try again.",
      }));
    } finally {
      connectedMutationRef.current = false;
      setConnectedMutation(null);
    }
  }

  async function handleConnectedPatchPermission(
    decision: "allow_once" | "retry_without_allowing" | "keep_denied",
  ) {
    if (
      connectedMutationRef.current ||
      connectedWorkflowPhase !== "patch" ||
      connectedPhaseProjection?.mode !== "permission" ||
      connectedPhaseProjection.permission === null
    ) {
      return;
    }
    connectedMutationRef.current = true;
    setConnectedMutation(
      decision === "allow_once"
        ? "allowing_once"
        : decision === "retry_without_allowing"
          ? "retrying_without_allowing"
          : "keeping_denied",
    );
    const permission = connectedPhaseProjection.permission;
    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/mission/patch/connected/permission`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            connected_run_id: permission.operation.connected_run_id,
            operation_sha256: permission.operation.operation_sha256,
            decision,
          }),
        },
      );
      const body = (await response.json()) as
        | PortfolioWorkItem
        | MutationErrorResponse;
      if (!response.ok || "error" in body) {
        setConnectedRunState((current) => ({
          itemKey: connectedRunItemKey,
          result:
            current?.itemKey === connectedRunItemKey ? current.result : [],
          loading: false,
          error:
            "error" in body
              ? body.error?.message ??
                "The Patch permission decision could not be recorded."
              : "The Patch permission decision could not be recorded.",
        }));
        return;
      }
      const updatedItem = body as PortfolioWorkItem;
      onUpdated(
        updatedItem,
        decision === "allow_once"
          ? "Exact Patch permission allowed once; a fresh attempt is ready."
          : decision === "retry_without_allowing"
            ? "Fresh Patch attempt ready without allowing the denied operation."
          : "Exact Patch permission remains denied.",
      );
    } catch {
      setConnectedRunState((current) => ({
        itemKey: connectedRunItemKey,
        result:
          current?.itemKey === connectedRunItemKey ? current.result : [],
        loading: false,
        error: "The Patch permission decision could not be recorded. Check the local server and try again.",
      }));
    } finally {
      connectedMutationRef.current = false;
      setConnectedMutation(null);
    }
  }

  async function handleConnectedPermission(
    decision: "allow_once" | "retry_without_allowing" | "keep_denied",
  ) {
    if (
      connectedMutationRef.current ||
      connectedExecute.mode !== "permission"
    ) {
      return;
    }
    connectedMutationRef.current = true;
    setConnectedMutation(
      decision === "allow_once"
        ? "allowing_once"
        : decision === "retry_without_allowing"
          ? "retrying_without_allowing"
          : "keeping_denied",
    );

    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/mission/connected/permission`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            connected_run_id: connectedExecute.permission.operation.connected_run_id,
            operation_sha256:
              connectedExecute.permission.operation.operation_sha256,
            decision,
          }),
        },
      );
      const body = (await response.json()) as
        | PortfolioWorkItem
        | MutationErrorResponse;
      if (!response.ok) {
        setConnectedRunState((current) => ({
          itemKey: connectedRunItemKey,
          result:
            current?.itemKey === connectedRunItemKey ? current.result : [],
          loading: false,
          error:
            "error" in body
              ? body.error?.message ?? "The permission decision could not be recorded."
              : "The permission decision could not be recorded.",
        }));
        return;
      }

      markConnectedRunsLoading();
      await loadConnectedRuns();
      onUpdated(
        body as PortfolioWorkItem,
        decision === "allow_once"
          ? "Exact permission allowed once; a fresh Execute attempt is ready."
          : decision === "retry_without_allowing"
            ? "Fresh Execute attempt ready without allowing the denied operation."
          : "Exact permission remains denied.",
      );
    } catch {
      setConnectedRunState((current) => ({
        itemKey: connectedRunItemKey,
        result:
          current?.itemKey === connectedRunItemKey ? current.result : [],
        loading: false,
        error: "The permission decision could not be recorded. Check the local server and try again.",
      }));
    } finally {
      connectedMutationRef.current = false;
      setConnectedMutation(null);
    }
  }

  const transitionActions = boardTransitionActionsForPhase(state.phase);
  const displayedNextAction =
    patchWorkflowNextAction(patchAttention) ?? nextActionForPhase(state.phase);
  const reviewManualRecovery =
    connectedWorkflowPhase !== "review" ? undefined : (
      <div className="space-y-4">
        <p className="text-xs leading-5 text-muted-foreground">
          Compile or import the immutable Review mission manually when the connected path cannot be used.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={reviewBusy || !reviewAttested}
            onClick={() => void handleCompileReviewMission()}
            className="h-9 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {compilingReviewMission ? "Compiling…" : "Compile review mission"}
          </button>
          <button
            type="button"
            disabled={reviewBusy}
            onClick={() => void handleImportReviewResult()}
            className="h-9 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {importingReviewResult ? "Importing…" : "Import review findings"}
          </button>
        </div>
        {reviewMissionImport ? (
          <div
            className={`border-l-2 px-3 py-3 text-xs ${
              reviewMissionImport.evidence.outcome === "applied"
                ? "border-success bg-success/10"
                : "border-destructive bg-destructive/10"
            }`}
            role="status"
          >
            {reviewMissionImport.evidence.outcome === "applied"
              ? reviewMissionImport.result?.verdict === "findings"
                ? `${reviewMissionImport.result.findings.length} review finding${reviewMissionImport.result.findings.length === 1 ? "" : "s"} imported`
                : "Clean review imported"
              : "Review import rejected"}
          </div>
        ) : null}
        {reviewMissionCompilation ? (
          <div className="border-l-2 border-border bg-background px-3 py-3">
            <dl className="space-y-3 text-xs">
              <div>
                <dt className="text-muted-foreground">TASK.md</dt>
                <dd className="mt-1 break-all leading-5">
                  {reviewMissionCompilation.task_path}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Mission JSON</dt>
                <dd className="mt-1 break-all leading-5">
                  {reviewMissionCompilation.mission_path}
                </dd>
              </div>
            </dl>
            <button
              type="button"
              onClick={() =>
                void handleCopyLaunchInstruction(
                  reviewMissionCompilation,
                  reviewMissionItemKey,
                )
              }
              className="mt-4 h-9 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              Copy review instruction
            </button>
          </div>
        ) : null}
      </div>
    );
  const patchManualRecovery =
    connectedWorkflowPhase !== "patch" || patchAttention.mode !== "patch_active"
      ? undefined
      : (
          <PatchWorkflowSection
            fieldId={`${fieldId}-advanced`}
            projection={patchAttention}
            patchCycle={state.patch_cycle ?? null}
            mutation={patchMutation}
            compilation={patchMissionCompilation}
            importedEvidence={patchMissionImport}
            copied={copiedMissionKey === patchMissionItemKey}
            onAcceptPatchPlan={() => void handleAcceptPatchPlan()}
            onCompilePatch={() => void handleCompilePatchMission()}
            onImportPatch={() => void handleImportPatchResult()}
            onCopyLaunchInstruction={() => {
              if (patchMissionCompilation !== null) {
                void handleCopyLaunchInstruction(
                  patchMissionCompilation,
                  patchMissionItemKey,
                );
              }
            }}
          />
        );
  const connectedManualRecovery =
    connectedWorkflowPhase === "review"
      ? reviewManualRecovery
      : connectedWorkflowPhase === "patch"
        ? patchManualRecovery
        : undefined;
  const goalContractFields: Array<[string, string[] | undefined]> = [
    ["Acceptance criteria", goalContract?.acceptance_criteria],
    ["Non-goals", goalContract?.non_goals],
    ["Allowed scope", goalContract?.allowed_scope],
    ["Review-ready checks", goalContract?.review_ready],
  ];
  const goalContractContent = (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <h3 id={`${fieldId}-goal-contract`} className="text-xs font-medium">
          Goal contract
        </h3>
        <p className="text-[11px] text-muted-foreground">
          Version {goalContract?.goal_version ?? "not set"}
        </p>
      </div>
      <dl className="mt-3 space-y-4 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Purpose</dt>
          <dd className="mt-1">
            {goalContract?.purpose ?? (
              <span className="text-muted-foreground">Not recorded.</span>
            )}
          </dd>
        </div>
        {goalContractFields.map(([label, values]) => (
          <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1">
              {values !== undefined && values.length > 0 ? (
                <ul className="list-disc space-y-1 pl-4">
                  {values.map((value, index) => (
                    <li key={`${value}-${index}`}>{value}</li>
                  ))}
                </ul>
              ) : (
                <span className="text-muted-foreground">Not recorded.</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
  const workItemEditor = canEditWorkItem ? (
    <form onSubmit={(event) => void handleSave(event)} className="space-y-4 border-t pt-5">
      <div>
        <label htmlFor={`${fieldId}-project`} className="mb-2 block text-xs font-medium">
          Project
        </label>
        <select
          id={`${fieldId}-project`}
          value={targetSourceId}
          disabled={goalContract !== undefined}
          onChange={(event) => setTargetSourceId(event.target.value)}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-70"
        >
          <option value={INBOX_SOURCE_ID}>Unassigned</option>
          {workspaces.map((workspace) => (
            <option key={workspace.workspace_id} value={workspace.workspace_id}>
              {workspace.product_name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`${fieldId}-title`} className="mb-2 block text-xs font-medium">Current title</label>
        <input id={`${fieldId}-title`} value={title} onChange={(event) => setTitle(event.target.value)} required className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={`${fieldId}-type`} className="mb-2 block text-xs font-medium">Work type</label>
          <select id={`${fieldId}-type`} value={type} onChange={(event) => setType(event.target.value as WorkItemType | "")} className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary">
            <option value="">Unclassified</option>
            {WORK_ITEM_TYPES.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${fieldId}-priority`} className="mb-2 block text-xs font-medium">Priority</label>
          <select id={`${fieldId}-priority`} value={priority} onChange={(event) => setPriority(event.target.value as WorkItemPriority | "")} className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary">
            <option value="">Not set</option>
            {WORK_ITEM_PRIORITIES.map((option) => <option key={option} value={option} className="capitalize">{option[0]?.toUpperCase()}{option.slice(1)}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor={`${fieldId}-tags`} className="mb-2 block text-xs font-medium">Tags</label>
        <input id={`${fieldId}-tags`} value={tags} onChange={(event) => setTags(event.target.value)} placeholder="Question, Front-end" className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none placeholder:text-[#7f8794] focus:border-primary focus:ring-1 focus:ring-primary" />
      </div>
      <div>
        <label htmlFor={`${fieldId}-notes`} className="mb-2 block text-xs font-medium">Context</label>
        <textarea id={`${fieldId}-notes`} value={notes} onChange={(event) => setNotes(event.target.value)} rows={5} className="w-full resize-y rounded-md border bg-background px-3 py-2.5 text-sm leading-5 outline-none focus:border-primary focus:ring-1 focus:ring-primary" />
      </div>
      {canEditGoalContract ? (
        <section
          aria-labelledby={`${fieldId}-goal-contract`}
          className="space-y-4 border-t pt-5"
        >
          <div>
            <h3 id={`${fieldId}-goal-contract`} className="text-xs font-medium">Goal contract</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Complete every field to govern this item. Keep list entries one per line.</p>
          </div>
          <div>
            <label htmlFor={`${fieldId}-purpose`} className="mb-2 block text-xs font-medium">Purpose</label>
            <input id={`${fieldId}-purpose`} value={purpose} onChange={(event) => setPurpose(event.target.value)} className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary" />
          </div>
          <div>
            <label htmlFor={`${fieldId}-acceptance-criteria`} className="mb-2 block text-xs font-medium">Acceptance criteria</label>
            <textarea id={`${fieldId}-acceptance-criteria`} value={acceptanceCriteria} onChange={(event) => setAcceptanceCriteria(event.target.value)} rows={4} className="w-full resize-y rounded-md border bg-background px-3 py-2.5 text-sm leading-5 outline-none focus:border-primary focus:ring-1 focus:ring-primary" />
          </div>
          <div>
            <label htmlFor={`${fieldId}-non-goals`} className="mb-2 block text-xs font-medium">Non-goals</label>
            <textarea id={`${fieldId}-non-goals`} value={nonGoals} onChange={(event) => setNonGoals(event.target.value)} rows={3} className="w-full resize-y rounded-md border bg-background px-3 py-2.5 text-sm leading-5 outline-none focus:border-primary focus:ring-1 focus:ring-primary" />
          </div>
          <div>
            <label htmlFor={`${fieldId}-allowed-scope`} className="mb-2 block text-xs font-medium">Allowed scope</label>
            <textarea id={`${fieldId}-allowed-scope`} value={allowedScope} onChange={(event) => setAllowedScope(event.target.value)} rows={3} className="w-full resize-y rounded-md border bg-background px-3 py-2.5 text-sm leading-5 outline-none focus:border-primary focus:ring-1 focus:ring-primary" />
          </div>
          <div>
            <label htmlFor={`${fieldId}-review-ready`} className="mb-2 block text-xs font-medium">Review-ready checks</label>
            <textarea id={`${fieldId}-review-ready`} value={reviewReady} onChange={(event) => setReviewReady(event.target.value)} rows={3} className="w-full resize-y rounded-md border bg-background px-3 py-2.5 text-sm leading-5 outline-none focus:border-primary focus:ring-1 focus:ring-primary" />
          </div>
        </section>
      ) : null}
      <div className="flex justify-end">
        <button type="submit" disabled={saving || (!detailsDirty && !assignmentDirty && !contractDirty) || title.trim().length === 0 || (hasContractInput && !contractComplete) || (goalContract === undefined && hasContractInput && targetSourceId === INBOX_SOURCE_ID)} className="h-9 rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50">
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  ) : null;
  const shapingSection =
    legacyShapingHandoff.mode === "active" ? (
      <ShapingSection
        fieldId={fieldId}
        projection={legacyShapingHandoff}
        artifacts={shapingArtifacts}
        loading={shapingLoading}
        error={shapingError}
        selectedAcceptanceSha256={selectedAcceptanceSha256}
        mutation={shapingMutation}
        compilation={shapingCompilation}
        imported={shapingImport}
        copiedTarget={shapingCopiedTarget}
        onSelectAcceptance={(acceptanceContentSha256) =>
          setShapingSelectionState({
            itemKey: shapingItemKey,
            acceptanceContentSha256,
          })
        }
        onCompile={() => void handleCompileShapingMission()}
        onImport={() => void handleImportShapingResult()}
        onCopy={(target, value) =>
          void handleCopyShapingValue(target, value)
        }
        onUseProposal={handleUseSpecProposal}
      />
    ) : null;

  return (
    <>
      <button
        type="button"
        aria-label="Close work item details"
        onClick={attemptClose}
        className="fixed inset-0 z-20 bg-black/45 lg:hidden"
      />
      <aside
        aria-labelledby="detail-panel-title"
        className={`fixed inset-y-0 right-0 z-30 flex w-full shrink-0 flex-col border-l bg-muted lg:static lg:z-auto ${
          shapingDecisionProjection?.mode === "ready" &&
          shapingDecisionProjection.phase === "spec" &&
          !showFullWorkItem
            ? "sm:w-[460px]"
            : "sm:w-[410px]"
        }`}
      >
        <header className="flex h-16 shrink-0 items-center justify-between border-b px-4">
          <div className="min-w-0">
            <p className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
              {mode === "capture" ? "Capture details" : "Work item"}
            </p>
            <h2
              id="detail-panel-title"
              className="truncate text-base font-semibold tracking-[-0.005em]"
            >
              {goal.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={attemptClose}
            className="grid size-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            aria-label="Close work item details"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </header>

        {shapingEligible && !showFullWorkItem ? (
          shapingDecisionProjection === null ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 px-5 py-5" role="status">
                <p className="text-sm font-medium">
                  {shapingError === null
                    ? "Loading shaping decision…"
                    : "Shaping decision unavailable"}
                </p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {shapingError ??
                    "Reading the current revision, model choices and exact state binding."}
                </p>
                <button
                  type="button"
                  onClick={() => setShowFullWorkItem(true)}
                  className="mt-3 text-xs font-medium text-primary hover:text-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  View full work item
                </button>
              </div>
            </div>
          ) : (
            <ShapingDecisionView
              fieldId={fieldId}
              projection={shapingDecisionProjection}
              selectedModel={selectedShapingModel}
              advancedRecovery={shapingAdvancedRecovery}
              requestChangesComposer={shapingRequestChangesComposer}
              retainedControllerLeaseRepair={
                currentRetainedControllerLeaseRepair
              }
              busy={
                shapingDecisionBusy ||
                shapingLoading ||
                shapingMutation !== null ||
                currentShapingManualRecovery?.importing === true ||
                currentShapingManualRecovery?.recovery.state === "loading" ||
                currentRetainedControllerLeaseRepair?.status === "repairing"
              }
              error={shapingError}
              onSelectModel={(model) => {
                if (shapingPickerKey !== null) {
                  setShapingModelSelectionState({
                    pickerKey: shapingPickerKey,
                    model,
                  });
                }
              }}
              onAction={(action) => void handleShapingDecisionAction(action)}
              onOpenRequestChanges={handleOpenShapingRequestChanges}
              onCloseRequestChanges={handleCloseShapingRequestChanges}
              onChangeRequestChangesFeedback={
                handleChangeShapingRequestFeedback
              }
              onSelectRequestChangesModel={handleSelectShapingRequestModel}
              onSubmitRequestChanges={(action, feedback, selectedModel) => {
                if (shapingRequestChangesIdentity !== null) {
                  void handleShapingDecisionAction(action, {
                    identity: shapingRequestChangesIdentity,
                    feedback,
                    selectedModel,
                  });
                }
              }}
              onAcknowledgeRetainedControllerLease={
                handleAcknowledgeRetainedControllerLease
              }
              onRepairRetainedControllerLease={() =>
                void handleRepairRetainedControllerLease()
              }
              onCompileManualMission={() =>
                void handleCompileShapingMission()
              }
              onPrepareManualRecovery={() =>
                void handlePrepareShapingManualRecovery(false)
              }
              onRetryManualRecovery={() =>
                void handlePrepareShapingManualRecovery(true)
              }
              onCopyManualRecovery={(target, value) =>
                void handleCopyShapingManualRecovery(target, value)
              }
              onImportManualResult={() =>
                void handleImportShapingManualResult()
              }
              onCopyManualCompilation={(target, value) =>
                void handleCopyShapingValue(target, value)
              }
              onRefreshStatus={() =>
                setShapingRefreshRestartVersion((current) => current + 1)
              }
              onShowFullWorkItem={() => setShowFullWorkItem(true)}
            />
          )
        ) : mode === "capture" ? (
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
            <section aria-labelledby={`${fieldId}-provenance`}>
              <div className="mb-2 flex items-center gap-2">
                <LockKeyhole className="size-3.5 text-muted-foreground" strokeWidth={1.75} />
                <h3 id={`${fieldId}-provenance`} className="text-xs font-medium">
                  Original capture
                </h3>
              </div>
              <div className="border-l-2 border-primary bg-background px-3 py-2.5">
                <p className="text-sm leading-5 text-foreground">
                  {goal.capture?.original_title}
                </p>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  {goal.capture?.kind === "todo" ? "Todo" : "Idea"} · captured {" "}
                  {goal.capture
                    ? capturedAtFormatter.format(new Date(goal.capture.captured_at))
                    : "before provenance tracking"}
                </p>
              </div>
            </section>

            {workItemEditor}

            {shapingSection}

            {error ? (
              <p
                className="border-l-2 border-destructive bg-destructive/10 px-3 py-2 text-xs text-foreground"
                role="alert"
              >
                {error}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="border-b px-4 py-2">
              <button
                type="button"
                onClick={() => setShowFullWorkItem(false)}
                className="flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                <ArrowLeft className="size-3.5" strokeWidth={1.75} />
                {shapingDecisionProjection === null
                  ? "Back to details panel"
                  : "Back to shaping decision"}
              </button>
            </div>
            <div className="flex border-b px-4" role="tablist" aria-label="Work item details">
              {(["overview", "activity", "files"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab}
                  onClick={() => setActiveTab(tab)}
                  className={`h-11 border-b-2 px-3 text-xs font-medium capitalize transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary ${
                    activeTab === tab
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>

            <div className="space-y-5 p-4" role="tabpanel">
              {error ? (
                <p
                  className="border-l-2 border-destructive bg-destructive/10 px-3 py-2 text-xs text-foreground"
                  role="alert"
                >
                  {error}
                </p>
              ) : null}
              {activeTab === "overview" ? (
                <>
                  {workItemEditor}
                  <section aria-labelledby={`${fieldId}-summary`}>
                    <h3 id={`${fieldId}-summary`} className="text-xs font-medium text-muted-foreground">
                      Summary
                    </h3>
                    <dl className="mt-3 divide-y border-y text-sm">
                      <div className="flex items-center justify-between gap-4 py-3">
                        <dt className="text-muted-foreground">Project</dt>
                        <dd className="truncate text-right">{item.project?.product_name ?? "Unassigned"}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-4 py-3">
                        <dt className="text-muted-foreground">Type</dt>
                        <dd>{goal.type ?? "Unclassified"}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-4 py-3">
                        <dt className="text-muted-foreground">Phase</dt>
                        <dd className="capitalize">{state.phase}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-4 py-3">
                        <dt className="text-muted-foreground">Status</dt>
                        <dd className="capitalize">{state.status}</dd>
                      </div>
                    </dl>
                  </section>

                  <section aria-labelledby={`${fieldId}-next-action`} className="border-l-2 border-primary bg-background px-3 py-3">
                    <h3 id={`${fieldId}-next-action`} className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
                      Next action
                    </h3>
                    <p className="mt-1 text-sm font-medium">{displayedNextAction}</p>
                  </section>

                  <section
                    aria-labelledby={`${fieldId}-goal-contract`}
                    className="border-y py-4"
                  >
                    {goalContractContent}
                  </section>

                  {reviewImportDriftRecovery !== null ? (
                    <ReviewImportDriftRecoverySection
                      fieldId={fieldId}
                      proposal={reviewImportDriftRecovery}
                      applying={applyingReviewImportDriftRecovery}
                      onApply={() =>
                        void handleApplyReviewImportDriftRecovery()
                      }
                    />
                  ) : reviewImportDriftRecoveryLoading ? (
                    <p className="text-xs text-muted-foreground">
                      Checking Review import drift…
                    </p>
                  ) : reviewImportDriftRecoveryError ? (
                    <p className="text-xs text-destructive" role="alert">
                      {reviewImportDriftRecoveryError}
                    </p>
                  ) : null}

                  {shapingSection}

                  {scopeCorrection !== null ? (
                    <section
                      aria-labelledby={`${fieldId}-scope-correction`}
                      className="border-l-2 border-amber-500 bg-amber-500/10 px-3 py-3"
                    >
                      <h3
                        id={`${fieldId}-scope-correction`}
                        className="text-xs font-medium"
                      >
                        Exact scope correction required
                      </h3>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        The current scope cannot authorize the retained worktree paths. Approval changes only allowed scope, versions the goal, and restarts Execute at attempt 0. Prior evidence remains immutable.
                      </p>
                      <div className="mt-3 grid gap-3 text-[11px] lg:grid-cols-2">
                        <div>
                          <p className="font-medium text-muted-foreground">Current governed scope</p>
                          <ul className="mt-1 space-y-1 break-all font-mono">
                            {scopeCorrection.current_allowed_scope.map((path) => (
                              <li key={`current:${path}`}>{path}</li>
                            ))}
                          </ul>
                        </div>
                        <div>
                          <p className="font-medium text-muted-foreground">Proposed exact paths</p>
                          <ul className="mt-1 space-y-1 break-all font-mono">
                            {scopeCorrection.proposed_allowed_scope.map((path) => (
                              <li key={`proposed:${path}`}>{path}</li>
                            ))}
                          </ul>
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={applyingScopeCorrection}
                        onClick={() => void handleApplyScopeCorrection()}
                        className="mt-3 h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {applyingScopeCorrection
                          ? "Applying exact scope…"
                          : "Approve exact scope & restart Execute"}
                      </button>
                    </section>
                  ) : scopeCorrectionLoading ? (
                    <p className="text-xs text-muted-foreground">Checking executable scope…</p>
                  ) : scopeCorrectionError ? (
                    <p className="text-xs text-destructive" role="alert">
                      {scopeCorrectionError}
                    </p>
                  ) : null}

                  <CommandAuthorizationSection
                    fieldId={fieldId}
                    attention={commandAuthorizationAttention}
                    canPrepare={canPrepareCommandAuthorization}
                    mutation={connectedMutation}
                    onPrepare={() =>
                      void handlePrepareCommandAuthorization()
                    }
                    onAllowOnce={() =>
                      void handleCommandAuthorizationDecision("allow_once")
                    }
                    onKeepDenied={() =>
                      void handleCommandAuthorizationDecision("keep_denied")
                    }
                  />

                  {connectedWorkflowPhase === "execute" &&
                  !commandPreflightActive ? (
                    <ConnectedExecuteSection
                      fieldId={fieldId}
                      projection={connectedExecute}
                      runs={connectedRuns}
                      loading={connectedRunsLoading}
                      error={connectedRunsError}
                      modelOverride={connectedModelOverride}
                      mutation={connectedMutation}
                      onModelOverrideChange={setConnectedModelOverride}
                      onLaunch={() => void handleLaunchConnectedRun()}
                      onAllowOnce={() =>
                        void handleConnectedPermission("allow_once")
                      }
                      onRetryWithoutAllowing={() =>
                        void handleConnectedPermission(
                          "retry_without_allowing",
                        )
                      }
                      onKeepDenied={() =>
                        void handleConnectedPermission("keep_denied")
                      }
                    />
                  ) : null}

                  {missionEligible || repairEligible || missionImport ? (
                    <section
                      aria-labelledby={`${fieldId}-mission-handoff`}
                      className="border-y py-4"
                    >
                      <div>
                        <div>
                          <h3
                            id={`${fieldId}-mission-handoff`}
                            className="text-xs font-medium"
                          >
                            Mission handoff
                          </h3>
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            {repairEligible
                              ? "The last import is blocked. Prior evidence stays immutable when you create a new attempt."
                              : missionEligible
                                ? "Compile durable instructions, then import the result returned by the external agent."
                                : "The returned result has been processed by the controller."}
                          </p>
                        </div>
                        {missionEligible ? (
                          <div className="mt-3 flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={missionBusy}
                              onClick={() => void handleCompileMission()}
                              className="h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {compilingMission ? "Compiling…" : "Compile mission"}
                            </button>
                            <button
                              type="button"
                              disabled={missionBusy}
                              onClick={() => void handleImportResult()}
                              className="h-9 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {importingResult ? "Importing…" : "Import result"}
                            </button>
                          </div>
                        ) : null}
                        {repairEligible ? (
                          <button
                            type="button"
                            disabled={missionBusy}
                            onClick={() => void handleStartRepair()}
                            className="mt-3 h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {startingRepair
                              ? "Starting repair…"
                              : "Start repair attempt"}
                          </button>
                        ) : null}
                      </div>

                      {missionImport ? (
                        <div
                          className={`mt-4 border-l-2 px-3 py-3 text-xs ${
                            missionImport.outcome === "applied"
                              ? "border-success bg-success/10"
                              : "border-destructive bg-destructive/10"
                          }`}
                          role="status"
                        >
                          <p className="font-medium">
                            {missionImport.outcome === "applied"
                              ? "Ready for review"
                              : "Import blocked"}
                          </p>
                          <p
                            className="mt-1 break-all leading-5 text-muted-foreground"
                            title={missionImport.evidence_path}
                          >
                            Evidence · {shortEvidencePath(missionImport.evidence_path)}
                          </p>
                        </div>
                      ) : null}

                      {missionEligible && missionCompilation ? (
                        <div className="mt-4 border-l-2 border-border bg-background px-3 py-3">
                          <dl className="space-y-3 text-xs">
                            <div>
                              <dt className="text-muted-foreground">TASK.md</dt>
                              <dd className="mt-1 break-all leading-5">
                                {missionCompilation.task_path}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-muted-foreground">Mission JSON</dt>
                              <dd className="mt-1 break-all leading-5">
                                {missionCompilation.mission_path}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-muted-foreground">Workspace</dt>
                              <dd className="mt-1 break-all leading-5">
                                {missionCompilation.workspace_path}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-muted-foreground">Package hash</dt>
                              <dd className="mt-1 break-all text-[11px] leading-5">
                                {missionCompilation.mission.content_sha256}
                              </dd>
                            </div>
                          </dl>
                          <div className="mt-4 flex items-center gap-3">
                            <button
                              type="button"
                              onClick={() =>
                                void handleCopyLaunchInstruction(
                                  missionCompilation,
                                  missionItemKey,
                                )
                              }
                              className="h-9 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                            >
                              Copy launch instruction
                            </button>
                            <span
                              className="text-[11px] text-muted-foreground"
                              role="status"
                              aria-live="polite"
                            >
                              {copiedMissionKey === missionItemKey ? "Copied" : ""}
                            </span>
                          </div>
                        </div>
                      ) : null}
                    </section>
                  ) : null}

                  {patchAttention.mode === "patch_active" ? null : (
                    <PatchWorkflowSection
                      fieldId={fieldId}
                      projection={patchAttention}
                      patchCycle={state.patch_cycle ?? null}
                      mutation={patchMutation}
                      compilation={patchMissionCompilation}
                      importedEvidence={patchMissionImport}
                      copied={copiedMissionKey === patchMissionItemKey}
                      onAcceptPatchPlan={() => void handleAcceptPatchPlan()}
                      onCompilePatch={() => void handleCompilePatchMission()}
                      onImportPatch={() => void handleImportPatchResult()}
                      onCopyLaunchInstruction={() => {
                        if (patchMissionCompilation !== null) {
                          void handleCopyLaunchInstruction(
                            patchMissionCompilation,
                            patchMissionItemKey,
                          );
                        }
                      }}
                    />
                  )}

                  {connectedPhaseProjection === null ||
                  commandPreflightActive ? null : (
                    <ConnectedPhaseSection
                      fieldId={fieldId}
                      projection={connectedPhaseProjection}
                      subject={connectedReviewSubject}
                      reviewAttested={reviewAttested}
                      selectedModel={selectedConnectedPhaseModel}
                      loading={connectedRunsLoading}
                      modelsLoading={connectedModelsLoading}
                      error={connectedRunsError ?? connectedModelsError}
                      mutation={connectedMutation}
                      manualRecovery={connectedManualRecovery}
                      onReviewAttestedChange={(checked) =>
                        setReviewAttestationState({
                          itemKey: reviewMissionItemKey,
                          checked,
                        })
                      }
                      onSelectModel={(model) => {
                        if (connectedWorkflowPhase === null) {
                          return;
                        }
                        setConnectedModelSelectionState({
                          itemKey: connectedRunItemKey,
                          phase: connectedWorkflowPhase,
                          model,
                        });
                      }}
                      onLaunch={() => void handleLaunchConnectedPhase()}
                      onCancel={() => void handleCancelConnectedPhase()}
                      onAllowOnce={() =>
                        void handleConnectedPatchPermission("allow_once")
                      }
                      onRetryWithoutAllowing={() =>
                        void handleConnectedPatchPermission(
                          "retry_without_allowing",
                        )
                      }
                      onKeepDenied={() =>
                        void handleConnectedPatchPermission("keep_denied")
                      }
                    />
                  )}

                  {connectedPhaseProjection === null &&
                  reviewEligible &&
                  appliedReviewSubject ? (
                    <section
                      aria-labelledby={`${fieldId}-review-handoff`}
                      className="border-y py-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3
                            id={`${fieldId}-review-handoff`}
                            className="text-xs font-medium"
                          >
                            Review handoff
                          </h3>
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            Assess the pinned {appliedReviewSubject.evidence.phase} result without editing files or rerunning checks.
                          </p>
                        </div>
                        <span className="shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
                          Read only
                        </span>
                      </div>

                      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-y py-3 text-[11px]">
                        <div>
                          <dt className="text-muted-foreground">Subject commit</dt>
                          <dd
                            className="mt-0.5 truncate"
                            title={appliedReviewSubject.evidence.result_commit ?? undefined}
                          >
                            {appliedReviewSubject.evidence.result_commit?.slice(0, 12) ??
                              "Unavailable"}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground capitalize">
                            {appliedReviewSubject.evidence.phase} mission
                          </dt>
                          <dd
                            className="mt-0.5 truncate"
                            title={appliedReviewSubject.evidence.mission_content_sha256}
                          >
                            {appliedReviewSubject.evidence.mission_content_sha256.slice(
                              0,
                              12,
                            )}
                          </dd>
                        </div>
                        <div className="col-span-2">
                          <dt className="text-muted-foreground">Immutable mission</dt>
                          <dd className="mt-0.5 break-all leading-5">
                            {`.founder/missions/${goal.work_item_id}/${appliedReviewSubject.evidence.phase}-${appliedReviewSubject.evidence.identity.goal_version}-${appliedReviewSubject.evidence.identity.input_revision}-${appliedReviewSubject.evidence.identity.attempt}${appliedReviewSubject.evidence.phase === "patch" ? `-${appliedReviewSubject.evidence.identity.patch_cycle}` : ""}/mission.json`}
                          </dd>
                        </div>
                        <div className="col-span-2">
                          <dt className="text-muted-foreground">Immutable evidence</dt>
                          <dd className="mt-0.5 break-all leading-5">
                            {appliedReviewSubject.summary.evidence_path}
                          </dd>
                        </div>
                      </dl>

                      <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-xs leading-5">
                        <input
                          type="checkbox"
                          checked={reviewAttested}
                          onChange={(event) =>
                            setReviewAttestationState({
                              itemKey: reviewMissionItemKey,
                              checked: event.target.checked,
                            })
                          }
                          className="mt-0.5 size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                        />
                        <span>
                          I attest that this reviewer is independent from the execute writer.
                        </span>
                      </label>

                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={reviewBusy || !reviewAttested}
                          onClick={() => void handleCompileReviewMission()}
                          className="h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {compilingReviewMission
                            ? "Compiling…"
                            : "Compile review mission"}
                        </button>
                        <button
                          type="button"
                          disabled={reviewBusy}
                          onClick={() => void handleImportReviewResult()}
                          className="h-9 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {importingReviewResult
                            ? "Importing…"
                            : "Import review findings"}
                        </button>
                      </div>

                      {reviewMissionImport ? (
                        <div
                          className={`mt-4 border-l-2 px-3 py-3 text-xs ${
                            reviewMissionImport.evidence.outcome === "applied"
                              ? "border-success bg-success/10"
                              : "border-destructive bg-destructive/10"
                          }`}
                          role="status"
                        >
                          <p className="font-medium">
                            {reviewMissionImport.evidence.outcome === "applied"
                              ? reviewMissionImport.result?.verdict === "findings"
                                ? `${reviewMissionImport.result.findings.length} review finding${reviewMissionImport.result.findings.length === 1 ? "" : "s"} imported`
                                : "Clean review imported"
                              : "Review import rejected"}
                          </p>
                          <p className="mt-1 leading-5 text-muted-foreground">
                            Workflow state remains Review · Active.
                          </p>
                        </div>
                      ) : null}

                      {reviewMissionCompilation ? (
                        <div className="mt-4 border-l-2 border-border bg-background px-3 py-3">
                          <dl className="space-y-3 text-xs">
                            <div>
                              <dt className="text-muted-foreground">TASK.md</dt>
                              <dd className="mt-1 break-all leading-5">
                                {reviewMissionCompilation.task_path}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-muted-foreground">Mission JSON</dt>
                              <dd className="mt-1 break-all leading-5">
                                {reviewMissionCompilation.mission_path}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-muted-foreground">Package hash</dt>
                              <dd className="mt-1 break-all text-[11px] leading-5">
                                {reviewMissionCompilation.mission.content_sha256}
                              </dd>
                            </div>
                          </dl>
                          <div className="mt-4 flex items-center gap-3">
                            <button
                              type="button"
                              onClick={() =>
                                void handleCopyLaunchInstruction(
                                  reviewMissionCompilation,
                                  reviewMissionItemKey,
                                )
                              }
                              className="h-9 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                            >
                              Copy review instruction
                            </button>
                            <span
                              className="text-[11px] text-muted-foreground"
                              role="status"
                              aria-live="polite"
                            >
                              {copiedMissionKey === reviewMissionItemKey
                                ? "Copied"
                                : ""}
                            </span>
                          </div>
                        </div>
                      ) : null}
                    </section>
                  ) : null}

                  <RunEvidenceSection
                    fieldId={fieldId}
                    evidence={runEvidence}
                    loading={runEvidenceLoading}
                    error={runEvidenceError}
                    expandedRunIds={expandedRunIds}
                    onToggle={handleToggleRunEvidence}
                  />

                  {transitionActions.forward || transitionActions.back ? (
                    <section aria-label="Valid workflow transitions" className="flex flex-wrap gap-2">
                      {transitionActions.back ? (
                        <button
                          type="button"
                          disabled={transitionPending}
                          onClick={() => onTransition(item, transitionActions.back!.target_column_id)}
                          className="inline-flex h-9 items-center gap-2 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <ArrowLeft className="size-3.5" strokeWidth={1.75} />
                          {transitionActions.back.label}
                        </button>
                      ) : null}
                      {transitionActions.forward ? (
                        <button
                          type="button"
                          disabled={transitionPending}
                          onClick={() => onTransition(item, transitionActions.forward!.target_column_id)}
                          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {transitionActions.forward.label}
                          <ArrowRight className="size-3.5" strokeWidth={1.75} />
                        </button>
                      ) : null}
                    </section>
                  ) : null}
                </>
              ) : (
                <section className="border-l-2 border-border bg-background px-3 py-3">
                  <h3 className="text-sm font-medium capitalize">{activeTab}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {activeTab === "activity"
                      ? "No activity has been recorded yet."
                      : "No files are attached to this work item yet."}
                  </p>
                </section>
              )}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
