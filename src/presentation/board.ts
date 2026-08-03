import { z } from "zod";

import {
  workItemIdSchema,
  type GoalContract,
  type WorkItemCapture,
  type WorkItemAttention,
  type WorkItemPhase,
  type WorkItemStatus,
} from "../domain/work-item";
import { INBOX_SOURCE_ID } from "../domain/portfolio-source";
import type {
  ShapingModelPickerOption,
  WorkflowModelUse,
} from "../domain/portfolio-preferences";
import type { ExternalResultSubmission } from "../domain/result";
import type {
  BrainstormResultSubmission,
  PlanChecklistEntry,
  PlanResultSubmission,
  ShapingPhase,
  ShapingResultSubmission,
  SpecResultSubmission,
} from "../domain/shaping";
import {
  ALLOWED_PHASE_TRANSITIONS,
  validatePhaseTransition as validateDomainPhaseTransition,
  type WorkflowTransitionResult,
} from "../domain/workflow-policy";

export { ALLOWED_PHASE_TRANSITIONS } from "../domain/workflow-policy";

export const BOARD_VIEW_STORAGE_KEY = "product-studio.board-view.v1";

export const BOARD_COLUMNS = [
  {
    id: "todo",
    label: "Todo",
    phases: ["idea", "brainstorm"],
    target_phase: "brainstorm",
  },
  { id: "spec", label: "Spec", phases: ["spec"], target_phase: "spec" },
  { id: "plan", label: "Plan", phases: ["plan"], target_phase: "plan" },
  {
    id: "execute",
    label: "Execute",
    phases: ["execute"],
    target_phase: "execute",
  },
  {
    id: "review",
    label: "Review",
    phases: ["review", "patch", "test"],
    target_phase: "review",
  },
  { id: "ship", label: "Ship", phases: ["ship"], target_phase: "ship" },
  { id: "done", label: "Done", phases: ["learn"], target_phase: "learn" },
] as const satisfies readonly {
  id: string;
  label: string;
  phases: readonly WorkItemPhase[];
  target_phase: WorkItemPhase;
}[];

export type BoardColumn = (typeof BOARD_COLUMNS)[number];
export type BoardColumnId = BoardColumn["id"];

export type DetailPanelMode = "capture" | "governed";
export type MissionHandoffMode = "active" | "repair" | "hidden";

export const PREVIEW_PROSE_MAX_CHARS = 320 as const;
export const PREVIEW_LIST_MAX_ITEMS = 4 as const;
export const PREVIEW_LIST_ITEM_MAX_CHARS = 160 as const;
export const PREVIEW_CHECKLIST_MAX_ENTRIES = 6 as const;
export const PREVIEW_EXPANDER_LABEL = {
  prose: "Show full text",
  collection_prefix: "Show all",
} as const;

export interface ShapingTextPreview {
  full: string;
  shown: string;
  total: number;
  truncated: boolean;
  expander_label: string | null;
}

export interface ShapingListPreview {
  full: string[];
  shown: ShapingTextPreview[];
  total: number;
  truncated: boolean;
  expander_label: string | null;
}

export interface ShapingChecklistPreview {
  full: PlanChecklistEntry[];
  shown: Array<{
    id: string;
    step: ShapingTextPreview;
    verification_check: ShapingTextPreview;
  }>;
  total: number;
  truncated: boolean;
  expander_label: string | null;
}

export type ShapingProjectionActionKind =
  | "start_brainstorm"
  | "launch_phase"
  | "cancel_run"
  | "use_brainstorm_result"
  | "approve_spec"
  | "request_changes"
  | "replan_with_updated_contract"
  | "retry_launch"
  | "open_new_attempt"
  | "prepare_manual_recovery"
  | "open_advanced_recovery"
  | "retry_manual_recovery"
  | "copy_manual_task"
  | "import_manual_result";

export interface ShapingActionProjection {
  kind: ShapingProjectionActionKind;
  label: string;
  launch_mode: "connected" | "manual" | null;
  primary: boolean;
  enabled: boolean;
  shaping_run_id?: string;
}

export interface ShapingProjectedModelOption
  extends ShapingModelPickerOption {
  current_revision: boolean;
}

export interface ShapingModelPickerProjection {
  seat: ShapingPhase;
  options: ShapingProjectedModelOption[];
  selected_model: string | null;
  recommendation_note: string | null;
  reuse_warning: string | null;
}

export interface ShapingModelUseProjection {
  seat: ShapingPhase;
  requested_model: string;
  effective_model: string;
}

export interface ShapingRefreshProjection {
  last_checked_at: string | null;
  refreshing: boolean;
  stale: boolean;
  refresh_failure: { reason: string } | null;
}

export interface ShapingRunProjectionInput {
  shaping_run_id: string;
  status: "starting" | "running" | "terminal";
  terminal_outcome:
    | "completed"
    | "missing_permission"
    | "failed"
    | "cancelled"
    | "timed_out"
    | "interrupted"
    | null;
  latest_update: string | null;
  sanitized_reason: string | null;
  denied_operation_kind: string | null;
  timeout_limit: string | null;
}

export type ShapingManualRecoveryProjectionInput =
  | { state: "loading" }
  | {
      state: "ready";
      task: string;
      instruction_path: string;
      ingress_path: string;
    }
  | { state: "failure"; reason: string }
  | { state: "retry"; reason: string }
  | {
      state: "copy";
      copied_target: "task" | "instruction" | "ingress";
      task: string;
      instruction_path: string;
      ingress_path: string;
    };

export type ShapingRevisionResultProjectionInput =
  | { status: "none" }
  | {
      status: "applied";
      result_content_sha256: string;
      result: ShapingResultSubmission;
    }
  | { status: "repair"; failing_component: string };

export interface ShapingRevisionProjectionInput {
  mission_content_sha256: string;
  result: ShapingRevisionResultProjectionInput;
  plan_goal_contract_sha256?: string;
  plan_goal_version?: number;
}

export interface ShapingSurfaceContext {
  expected_shaping_state_sha256: string;
  revision: ShapingRevisionProjectionInput | null;
  run: ShapingRunProjectionInput | null;
  models: {
    status: "available" | "unavailable";
    reason: string | null;
    available_model_ids: readonly string[];
    model_use: readonly WorkflowModelUse[];
    model_picker_options: Record<
      ShapingPhase,
      readonly ShapingModelPickerOption[]
    >;
  };
  refresh?: ShapingRefreshProjection;
  derived_goal_contract_sha256?: string | null;
  current_goal_contract_sha256?: string | null;
  post_commit_launch_failure?: {
    manifest_outcome: "applied";
    decision_id: string;
    locked_model: string;
    reason: string;
  } | null;
  manual_recovery?: ShapingManualRecoveryProjectionInput | null;
}

export type ShapingLifecycleState =
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

export interface ShapingLifecycleProjection {
  state: ShapingLifecycleState;
  card_label: string;
  headline: string;
  copy: string;
  refresh_running: boolean;
  actions: ShapingActionProjection[];
}

interface ShapingProjectionBase {
  phase: ShapingPhase;
  expected_shaping_state_sha256: string;
  provenance: ShapingModelUseProjection[];
  actions: ShapingActionProjection[];
  refresh?: ShapingRefreshProjection;
}

interface ShapingRequestChangesProjection {
  feedback_required: true;
  model_picker?: ShapingModelPickerProjection;
  runtime_unavailable?: string;
  actions: ShapingActionProjection[];
}

interface ShapingReadyProjectionBase extends ShapingProjectionBase {
  mode: "ready";
  lifecycle: ShapingLifecycleProjection;
  bindings: {
    expected_mission_content_sha256: string;
    expected_result_content_sha256: string;
    expected_shaping_state_sha256: string;
  };
  request_changes: ShapingRequestChangesProjection;
}

export type BrainstormReadyProjection = ShapingReadyProjectionBase & {
  phase: "brainstorm";
  result: BrainstormResultSubmission;
  sections: {
    summary: {
      problem_statement: ShapingTextPreview;
      approach: ShapingTextPreview;
    };
    non_goals: ShapingListPreview;
    unresolved_questions: ShapingListPreview;
    provenance: ShapingModelUseProjection[];
    next_step?: ShapingModelPickerProjection;
    runtime_unavailable?: string;
  };
};

export type SpecReadyProjection = ShapingReadyProjectionBase & {
  phase: "spec";
  result: SpecResultSubmission;
  bindings: ShapingReadyProjectionBase["bindings"] & {
    goal_contract_sha256: string;
  };
  governed_contract: {
    contract: GoalContract;
    goal_contract_sha256: string;
    truncation: {
      purpose: boolean;
      acceptance_criteria: boolean;
      non_goals: boolean;
      allowed_scope: boolean;
      review_ready: boolean;
    };
  };
  sections: {
    summary: { purpose: ShapingTextPreview };
    criteria: ShapingListPreview;
    governed_fields: {
      pointer: string;
      non_goals: ShapingListPreview;
      allowed_scope: ShapingListPreview;
      review_ready: ShapingListPreview;
    };
    provenance: ShapingModelUseProjection[];
    next_step?: ShapingModelPickerProjection;
    runtime_unavailable?: string;
  };
};

export type PlanReadyProjection = ShapingReadyProjectionBase & {
  phase: "plan";
  result: PlanResultSubmission;
  sections: {
    summary: { summary: ShapingTextPreview };
    checklist: ShapingChecklistPreview;
    unresolved_questions: ShapingListPreview;
    provenance: ShapingModelUseProjection[];
    advanced_recovery: {
      relevant_skills: string[];
      product_doc_impacts: string[];
      todo_impacts: string[];
    };
  };
  execute_approval_available: false;
  execute_approval_message: "Execute approval is not available in this slice";
};

export type ShapingHandoffProjection =
  | {
      mode: "active";
      phase: "brainstorm";
      required_input: "none";
      can_compile: true;
      can_import: true;
    }
  | {
      mode: "active";
      phase: "spec";
      required_input: "brainstorm_acceptance_sha256";
      can_compile: true;
      can_import: true;
    }
  | {
      mode: "idea";
      phase: "idea";
      target_phase: "brainstorm";
      expected_shaping_state_sha256: string | null;
      card_label: "Idea";
      headline: "Start Brainstorm";
      model_picker?: ShapingModelPickerProjection;
      runtime_unavailable?: string;
      actions: ShapingActionProjection[];
    }
  | (ShapingProjectionBase & {
      mode: "pre_ready";
      lifecycle: null;
      mission_content_sha256: string | null;
      card_label: string;
      headline: string;
      copy: string;
      model_picker?: ShapingModelPickerProjection;
      runtime_unavailable?: string;
    })
  | (ShapingProjectionBase & {
      mode: "run_state";
      lifecycle: ShapingLifecycleProjection;
      run: ShapingRunProjectionInput;
      refresh: ShapingRefreshProjection;
    })
  | BrainstormReadyProjection
  | SpecReadyProjection
  | PlanReadyProjection
  | (ShapingProjectionBase & {
      mode: "post_commit_launch_failure";
      decision_id: string;
      locked_model: string;
      locked_model_unavailable: boolean;
      reason: string;
      runtime_unavailable?: string;
      bindings: {
        decision_id: string;
        expected_shaping_state_sha256: string;
      };
    })
  | (ShapingProjectionBase & {
      mode: "terminal_run_failure";
      lifecycle: ShapingLifecycleProjection;
      run: ShapingRunProjectionInput;
      model_picker?: ShapingModelPickerProjection;
      runtime_unavailable?: string;
      manual_recovery_action: ShapingActionProjection;
    })
  | (ShapingProjectionBase & {
      mode: "manual_recovery";
      recovery: ShapingManualRecoveryProjectionInput;
    })
  | (ShapingProjectionBase & {
      mode: "plan_result_superseded";
      phase: "plan";
      result: PlanResultSubmission;
      reason: string;
      bindings: {
        expected_mission_content_sha256: string;
        expected_result_content_sha256: string;
        expected_shaping_state_sha256: string;
        goal_contract_sha256: string;
      };
      model_picker?: ShapingModelPickerProjection;
      runtime_unavailable?: string;
      request_changes: ShapingRequestChangesProjection;
    })
  | (ShapingProjectionBase & {
      mode: "repair";
      lifecycle: ShapingLifecycleProjection;
      failing_component: string;
    })
  | {
      mode: "hidden";
      phase: null;
      required_input: null;
      can_compile: false;
      can_import: false;
    };

export type LegacyShapingHandoffProjection = Extract<
  ShapingHandoffProjection,
  { mode: "active" | "idea" | "hidden" }
>;

export type DecisionFirstShapingHandoffProjection = Exclude<
  ShapingHandoffProjection,
  { mode: "active" }
>;

export interface ShapingHandoffItemProjectionInput {
  source_id: string;
  work_item: {
    goal?: {
      capture?: WorkItemCapture;
      goal_contract?: GoalContract;
    };
    state: {
      phase: WorkItemPhase;
      status: WorkItemStatus;
    };
  };
}

export type ConnectedExecuteProjection =
  | {
      mode: "launch";
      can_launch: true;
      permission: null;
    }
  | {
      mode: "permission";
      can_launch: false;
      permission: Extract<WorkItemAttention, { kind: "missing_permission" }>;
    }
  | {
      mode: "hidden";
      can_launch: false;
      permission: null;
    };

export type ConnectedPermissionInboxProjection =
  | {
      mode: "active";
      action: "open_recovery";
      permission: Extract<WorkItemAttention, { kind: "missing_permission" }>;
    }
  | {
      mode: "hidden";
      action: null;
      permission: null;
    };

export type ReviewHandoffProjection =
  | {
      mode: "active";
      requires_independence_attestation: true;
      can_compile: true;
      can_import: true;
    }
  | {
      mode: "hidden";
      requires_independence_attestation: false;
      can_compile: false;
      can_import: false;
    };

type EscalationAttention = Extract<
  WorkItemAttention,
  {
    kind:
      | "unresolved_finding"
      | "ambiguous_goal"
      | "cycle_limit"
      | "missing_permission";
  }
>;

export type PatchAttentionProjection =
  | {
      mode: "patch_plan";
      action: "accept_patch_plan";
      attention: Extract<WorkItemAttention, { kind: "patch_plan_approval" }>;
      patch_cycle: number;
    }
  | {
      mode: "patch_active";
      action: "compile_or_import_patch";
      attention: null;
      patch_cycle: number;
    }
  | {
      mode: "escalation";
      action: "resolve_escalation";
      attention: EscalationAttention;
      patch_cycle: number;
    }
  | {
      mode: "review_ready";
      action: "review_result";
      attention: Extract<WorkItemAttention, { kind: "review_ready" }>;
      patch_cycle: number;
    }
  | {
      mode: "hidden";
      action: null;
      attention: null;
      patch_cycle: null;
    };

interface BoardReviewSubmissionProjection {
  review_mission_content_sha256: string;
  accepted_result_commit?: string;
  verdict?: "clean" | "findings";
  execute_mission_content_sha256?: string;
  execute_result_content_sha256?: string;
  patch_mission_content_sha256?: string;
  patch_result_content_sha256?: string;
}

interface BoardEvidenceProjection {
  evidence: {
    phase: "execute" | "review" | "patch";
    outcome: "rejected" | "failed" | "applied";
    mission_content_sha256?: string;
    result_content_sha256?: string;
    result_commit?: string | null;
    identity: {
      work_item_id: string;
      goal_version: number;
      input_revision: number;
      attempt: number;
      patch_cycle?: number;
    };
  };
  summary?: { evidence_path: string };
  submission?: ExternalResultSubmission | BoardReviewSubmissionProjection;
}

export interface BoardTransitionAction {
  target_column_id: BoardColumnId;
  target_phase: WorkItemPhase;
  label: string;
}

const NEXT_ACTION_BY_PHASE = {
  idea: "Brainstorm the idea",
  brainstorm: "Write the specification",
  spec: "Plan the work",
  plan: "Execute the plan",
  execute: "Review the result",
  review: "Test the result",
  patch: "Review the patch",
  test: "Ship the result",
  ship: "Capture the learning",
  learn: "Review the completed work",
} as const satisfies Record<WorkItemPhase, string>;

export type PhaseTransitionResult = WorkflowTransitionResult;

export type BoardDropResolution =
  | { ok: true; changed: boolean; target_phase: WorkItemPhase }
  | { ok: false; reason: string };

export interface BoardItemIdentity {
  source_id: string;
  work_item_id: string;
}

export interface BoardItemLocation extends BoardItemIdentity {
  project: unknown | null;
}

export interface BoardView {
  version: 1;
  project_source_ids: string[] | null;
  include_unassigned: boolean;
  selected_item: BoardItemIdentity | null;
  scroll: {
    x: number;
    y: number;
  };
}

const sourceIdSchema = z.string().min(1, "source_id must not be empty");

export const boardItemIdentitySchema: z.ZodType<BoardItemIdentity> =
  z.strictObject({
    source_id: sourceIdSchema,
    work_item_id: workItemIdSchema,
  });

export const boardViewSchema: z.ZodType<BoardView> = z.strictObject({
  version: z.literal(1),
  project_source_ids: z
    .array(sourceIdSchema)
    .refine(
      (sourceIds) => new Set(sourceIds).size === sourceIds.length,
      "project_source_ids must be unique",
    )
    .nullable(),
  include_unassigned: z.boolean(),
  selected_item: boardItemIdentitySchema.nullable(),
  scroll: z.strictObject({
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
  }),
});

export function boardColumnForPhase(phase: WorkItemPhase): BoardColumn {
  const column = BOARD_COLUMNS.find((candidate) =>
    (candidate.phases as readonly WorkItemPhase[]).includes(phase),
  );

  if (!column) {
    throw new Error(`No board column is configured for phase ${phase}`);
  }

  return column;
}

export function targetPhaseForColumn(columnId: BoardColumnId): WorkItemPhase {
  return BOARD_COLUMNS.find((column) => column.id === columnId)!.target_phase;
}

export function validatePhaseTransition(
  sourcePhase: WorkItemPhase,
  targetPhase: WorkItemPhase,
): PhaseTransitionResult {
  const transition = validateDomainPhaseTransition(sourcePhase, targetPhase);

  if (transition.ok) {
    return transition;
  }

  const sourceColumn = boardColumnForPhase(sourcePhase);
  const targetColumn = boardColumnForPhase(targetPhase);

  if (sourceColumn.id === targetColumn.id) {
    return { ok: false, reason: `Card is already in ${sourceColumn.label}.` };
  }

  if (targetPhase !== targetColumn.target_phase) {
    return {
      ok: false,
      reason: `Moves into ${targetColumn.label} target the ${targetColumn.target_phase} phase.`,
    };
  }

  return {
    ok: false,
    reason: `Move from ${sourceColumn.label} to ${targetColumn.label} is not allowed; move one column at a time.`,
  };
}

export function resolveBoardDrop(
  sourcePhase: WorkItemPhase,
  targetColumnId: BoardColumnId,
): BoardDropResolution {
  const sourceColumn = boardColumnForPhase(sourcePhase);

  if (sourceColumn.id === targetColumnId) {
    return { ok: true, changed: false, target_phase: sourcePhase };
  }

  const targetPhase = targetPhaseForColumn(targetColumnId);
  const transition = validatePhaseTransition(sourcePhase, targetPhase);

  if (!transition.ok) {
    return transition;
  }

  return { ok: true, changed: true, target_phase: targetPhase };
}

export function nextActionForPhase(phase: WorkItemPhase): string {
  return NEXT_ACTION_BY_PHASE[phase];
}

export function detailPanelModeForItem(item: {
  work_item: {
    goal: { capture?: WorkItemCapture };
    state: { phase: WorkItemPhase };
  };
}): DetailPanelMode {
  return item.work_item.goal.capture !== undefined &&
    boardColumnForPhase(item.work_item.state.phase).id === "todo"
    ? "capture"
    : "governed";
}

const SHAPING_PHASE_ORDER = ["brainstorm", "spec", "plan"] as const;
const DEFAULT_SHAPING_REFRESH: ShapingRefreshProjection = {
  last_checked_at: null,
  refreshing: false,
  stale: false,
  refresh_failure: null,
};

function phaseLabel(phase: ShapingPhase): string {
  return `${phase[0]!.toUpperCase()}${phase.slice(1)}`;
}

function clampAtWordBoundary(value: string, maximum: number): string {
  if (value.length <= maximum) {
    return value;
  }
  const prefix = value.slice(0, maximum);
  const boundary = prefix.search(/\s+\S*$/u);
  const clamped = boundary > 0 ? prefix.slice(0, boundary) : prefix;
  return `${clamped.trimEnd()}…`;
}

export function previewShapingText(
  value: string,
  maximum: number = PREVIEW_PROSE_MAX_CHARS,
): ShapingTextPreview {
  const truncated = value.length > maximum;
  return {
    full: value,
    shown: truncated ? clampAtWordBoundary(value, maximum) : value,
    total: value.length,
    truncated,
    expander_label: truncated ? PREVIEW_EXPANDER_LABEL.prose : null,
  };
}

export function previewShapingList(
  values: readonly string[],
): ShapingListPreview {
  const shown = values
    .slice(0, PREVIEW_LIST_MAX_ITEMS)
    .map((value) => previewShapingText(value, PREVIEW_LIST_ITEM_MAX_CHARS));
  const truncated =
    values.length > PREVIEW_LIST_MAX_ITEMS ||
    shown.some((value) => value.truncated);
  return {
    full: [...values],
    shown,
    total: values.length,
    truncated,
    expander_label: truncated
      ? `${PREVIEW_EXPANDER_LABEL.collection_prefix} ${values.length}`
      : null,
  };
}

export function previewShapingChecklist(
  entries: readonly PlanChecklistEntry[],
): ShapingChecklistPreview {
  const shown = entries
    .slice(0, PREVIEW_CHECKLIST_MAX_ENTRIES)
    .map((entry) => ({
      id: entry.id,
      step: previewShapingText(entry.step, PREVIEW_LIST_ITEM_MAX_CHARS),
      verification_check: previewShapingText(
        entry.verification_check,
        PREVIEW_LIST_ITEM_MAX_CHARS,
      ),
    }));
  const truncated =
    entries.length > PREVIEW_CHECKLIST_MAX_ENTRIES ||
    shown.some(
      (entry) => entry.step.truncated || entry.verification_check.truncated,
    );
  return {
    full: entries.map((entry) => ({ ...entry })),
    shown,
    total: entries.length,
    truncated,
    expander_label: truncated
      ? `${PREVIEW_EXPANDER_LABEL.collection_prefix} ${entries.length}`
      : null,
  };
}

function shapingAction(
  kind: ShapingProjectionActionKind,
  label: string,
  input: {
    launch_mode?: "connected" | "manual" | null;
    primary?: boolean;
    enabled?: boolean;
    shaping_run_id?: string;
  } = {},
): ShapingActionProjection {
  return {
    kind,
    label,
    launch_mode: input.launch_mode ?? null,
    primary: input.primary ?? false,
    enabled: input.enabled ?? true,
    ...(input.shaping_run_id === undefined
      ? {}
      : { shaping_run_id: input.shaping_run_id }),
  };
}

function currentRevisionModel(
  phase: ShapingPhase,
  uses: readonly WorkflowModelUse[],
): string | null {
  const current = uses.find((use) => use.seat === phase);
  return current?.effective_model ?? current?.requested_model ?? null;
}

function projectedPicker(
  context: ShapingSurfaceContext,
  seat: ShapingPhase,
  currentModel: string | null = null,
): ShapingModelPickerProjection | null {
  if (
    context.models.status !== "available" ||
    context.models.available_model_ids.length === 0
  ) {
    return null;
  }
  const source = [...context.models.model_picker_options[seat]];
  if (source.length === 0) {
    return null;
  }
  const configuredOrder = new Map(
    source.map((option, index) => [option.model_id, index]),
  );
  const saved = source.find((option) => option.saved_preference);
  const recommended = source.find((option) => option.recommended);
  const selected =
    currentModel !== null && source.some((option) => option.model_id === currentModel)
      ? currentModel
      : saved !== undefined && saved.used_by_seats.length === 0
        ? saved.model_id
        : recommended?.model_id ?? saved?.model_id ?? null;
  const options = source
    .map((option): ShapingProjectedModelOption => ({
      ...option,
      preselected: option.model_id === selected,
      current_revision:
        currentModel !== null && option.model_id === currentModel,
    }))
    .sort((left, right) => {
      const usedOrder = Number(left.used_by_seats.length > 0) -
        Number(right.used_by_seats.length > 0);
      return usedOrder !== 0
        ? usedOrder
        : (configuredOrder.get(left.model_id) ?? Number.MAX_SAFE_INTEGER) -
            (configuredOrder.get(right.model_id) ?? Number.MAX_SAFE_INTEGER);
    });
  const selectedOption = options.find((option) => option.preselected);
  const everyModelUsed = options.every(
    (option) => option.used_by_seats.length > 0,
  );
  return {
    seat,
    options,
    selected_model: selectedOption?.model_id ?? null,
    recommendation_note: everyModelUsed
      ? "Every available model has already been used in this workflow."
      : null,
    reuse_warning: selectedOption?.reuse_warning ?? null,
  };
}

function projectedProvenance(
  phase: ShapingPhase,
  uses: readonly WorkflowModelUse[],
): ShapingModelUseProjection[] {
  const maximumSeat = SHAPING_PHASE_ORDER.indexOf(phase);
  return SHAPING_PHASE_ORDER.slice(0, maximumSeat + 1).map((seat) => {
    const use = uses.find((candidate) => candidate.seat === seat);
    return {
      seat,
      requested_model: use?.requested_model ?? "unknown",
      effective_model: use?.effective_model ?? "unknown",
    };
  });
}

function unavailableReason(context: ShapingSurfaceContext): string {
  return context.models.reason ?? "No connected shaping models are available.";
}

function requestChangesProjection(
  context: ShapingSurfaceContext,
  phase: ShapingPhase,
): ShapingRequestChangesProjection {
  const picker = projectedPicker(
    context,
    phase,
    currentRevisionModel(phase, context.models.model_use),
  );
  const unavailable = picker === null;
  return {
    feedback_required: true,
    ...(picker === null
      ? { runtime_unavailable: unavailableReason(context) }
      : { model_picker: picker }),
    actions: [
      shapingAction("request_changes", "Request changes & rerun", {
        launch_mode: "connected",
        primary: !unavailable,
        enabled: !unavailable,
      }),
      shapingAction("request_changes", "Request changes & prepare rerun", {
        launch_mode: "manual",
        primary: unavailable,
      }),
    ],
  };
}

function phaseDecisionActions(
  context: ShapingSurfaceContext,
  phase: "brainstorm" | "spec",
): {
  actions: ShapingActionProjection[];
  picker: ShapingModelPickerProjection | null;
} {
  const nextSeat = phase === "brainstorm" ? "spec" : "plan";
  const picker = projectedPicker(context, nextSeat);
  const unavailable = picker === null;
  const connected =
    phase === "brainstorm"
      ? shapingAction("use_brainstorm_result", "Use result & run Spec", {
          launch_mode: "connected",
          primary: !unavailable,
          enabled: !unavailable,
        })
      : shapingAction("approve_spec", "Approve & run Plan", {
          launch_mode: "connected",
          primary: !unavailable,
          enabled: !unavailable,
        });
  const manual =
    phase === "brainstorm"
      ? shapingAction("use_brainstorm_result", "Use result & prepare Spec", {
          launch_mode: "manual",
          primary: unavailable,
        })
      : shapingAction("approve_spec", "Approve & prepare Plan", {
          launch_mode: "manual",
          primary: unavailable,
        });
  return {
    picker,
    actions: [
      shapingAction("request_changes", "Request changes"),
      connected,
      manual,
    ],
  };
}

function preReadyProjection(
  phase: ShapingPhase,
  context: ShapingSurfaceContext,
): Extract<ShapingHandoffProjection, { mode: "pre_ready" }> {
  const picker = projectedPicker(context, phase);
  const unavailable = picker === null;
  const label = phaseLabel(phase);
  const actions = [
    shapingAction("launch_phase", `Start ${label}`, {
      launch_mode: "connected",
      primary: !unavailable,
      enabled: !unavailable,
    }),
    shapingAction("prepare_manual_recovery", "Prepare manual recovery", {
      launch_mode: "manual",
      primary: unavailable,
      enabled: context.revision !== null,
    }),
  ];
  return {
    mode: "pre_ready",
    phase,
    expected_shaping_state_sha256:
      context.expected_shaping_state_sha256,
    provenance: projectedProvenance(phase, context.models.model_use),
    actions,
    lifecycle: null,
    mission_content_sha256:
      context.revision?.mission_content_sha256 ?? null,
    card_label: label,
    headline: `Start ${label}`,
    copy: `Run the current ${label} mission to produce one applied result.`,
    ...(picker === null
      ? { runtime_unavailable: unavailableReason(context) }
      : { model_picker: picker }),
  };
}

function runLifecycleProjection(
  phase: ShapingPhase,
  run: ShapingRunProjectionInput,
): ShapingLifecycleProjection {
  const label = phaseLabel(phase);
  if (run.status === "starting") {
    return {
      state: "starting",
      card_label: `${label} · Active`,
      headline: `${label} starting`,
      copy: "The agent is being launched.",
      refresh_running: true,
      actions: [
        shapingAction("cancel_run", "Cancel", {
          shaping_run_id: run.shaping_run_id,
        }),
      ],
    };
  }
  if (run.status === "running") {
    return {
      state: "running",
      card_label: `${label} · Active`,
      headline: `${label} running`,
      copy: run.latest_update ?? "The agent is working on this shaping mission.",
      refresh_running: true,
      actions: [
        shapingAction("cancel_run", "Cancel", {
          shaping_run_id: run.shaping_run_id,
        }),
      ],
    };
  }

  const retry = shapingAction("launch_phase", `Retry ${label}`, {
    launch_mode: "connected",
    primary: true,
  });
  switch (run.terminal_outcome) {
    case "missing_permission":
      return {
        state: "blocked",
        card_label: `${label} · Blocked`,
        headline: `${label} blocked`,
        copy: `The agent requested an operation outside this run's write policy.${
          run.denied_operation_kind === null
            ? ""
            : ` Operation: ${run.denied_operation_kind}.`
        }`,
        refresh_running: false,
        actions: [retry],
      };
    case "failed":
      return {
        state: "failed",
        card_label: `${label} · Failed`,
        headline: `${label} failed`,
        copy: run.sanitized_reason ?? "The agent or result validation failed.",
        refresh_running: false,
        actions: [
          retry,
          shapingAction("prepare_manual_recovery", "Prepare manual recovery", {
            launch_mode: "manual",
          }),
        ],
      };
    case "timed_out":
      return {
        state: "timed_out",
        card_label: `${label} · Failed`,
        headline: `${label} timed out`,
        copy: `${run.timeout_limit ?? "The configured limit"} was reached.`,
        refresh_running: false,
        actions: [retry],
      };
    case "cancelled":
      return {
        state: "cancelled",
        card_label: `${label} · Failed`,
        headline: `${label} cancelled`,
        copy: "You cancelled this run.",
        refresh_running: false,
        actions: [retry],
      };
    case "interrupted":
      return {
        state: "interrupted",
        card_label: `${label} · Failed`,
        headline: `${label} interrupted`,
        copy:
          "The agent process was no longer running when Product Studio recovered this run.",
        refresh_running: false,
        actions: [retry],
      };
    case "completed":
      return {
        state: "missing_result",
        card_label: `${label} · Failed`,
        headline: `${label} finished without a usable result`,
        copy: "The run reported success but published no valid result bundle.",
        refresh_running: false,
        actions: [retry],
      };
    case null:
      return {
        state: "needs_repair",
        card_label: `${label} · Needs repair`,
        headline: `${label} result needs repair`,
        copy: "The terminal run has no terminal outcome.",
        refresh_running: false,
        actions: [shapingAction("open_advanced_recovery", "Advanced recovery")],
      };
  }
}

function repairProjection(
  phase: ShapingPhase,
  context: ShapingSurfaceContext,
  failingComponent: string,
): Extract<ShapingHandoffProjection, { mode: "repair" }> {
  const label = phaseLabel(phase);
  const actions = [
    shapingAction("open_advanced_recovery", "Advanced recovery"),
  ];
  return {
    mode: "repair",
    phase,
    expected_shaping_state_sha256:
      context.expected_shaping_state_sha256,
    provenance: projectedProvenance(phase, context.models.model_use),
    actions,
    failing_component: failingComponent,
    lifecycle: {
      state: "needs_repair",
      card_label: `${label} · Needs repair`,
      headline: `${label} result needs repair`,
      copy: `The applied marker disagrees with ${failingComponent}.`,
      refresh_running: false,
      actions,
    },
    ...(context.refresh === undefined ? {} : { refresh: context.refresh }),
  };
}

function manualRecoveryActions(
  recovery: ShapingManualRecoveryProjectionInput,
): ShapingActionProjection[] {
  switch (recovery.state) {
    case "loading":
      return [];
    case "failure":
    case "retry":
      return [
        shapingAction("retry_manual_recovery", "Retry manual recovery", {
          primary: true,
        }),
      ];
    case "ready":
    case "copy":
      return [
        shapingAction("copy_manual_task", "Copy manual task", {
          primary: true,
        }),
        shapingAction("import_manual_result", "Import result"),
      ];
  }
}

function isBrainstormResult(
  result: ShapingResultSubmission,
): result is BrainstormResultSubmission {
  return result.identity.phase === "brainstorm";
}

function isSpecResult(
  result: ShapingResultSubmission,
): result is SpecResultSubmission {
  return result.identity.phase === "spec";
}

function isPlanResult(
  result: ShapingResultSubmission,
): result is PlanResultSubmission {
  return result.identity.phase === "plan";
}

export function shapingHandoffForItem(
  item: ShapingHandoffItemProjectionInput,
): LegacyShapingHandoffProjection;
export function shapingHandoffForItem(
  item: ShapingHandoffItemProjectionInput,
  context: ShapingSurfaceContext,
): DecisionFirstShapingHandoffProjection;
export function shapingHandoffForItem(
  item: ShapingHandoffItemProjectionInput,
  context?: ShapingSurfaceContext,
): ShapingHandoffProjection {
  const { phase, status } = item.work_item.state;
  if (
    item.source_id === INBOX_SOURCE_ID ||
    status !== "active"
  ) {
    return {
      mode: "hidden",
      phase: null,
      required_input: null,
      can_compile: false,
      can_import: false,
    };
  }

  if (phase === "idea") {
    const picker = context === undefined
      ? null
      : projectedPicker(context, "brainstorm");
    const unavailable = picker === null;
    return {
      mode: "idea",
      phase: "idea",
      target_phase: "brainstorm",
      expected_shaping_state_sha256:
        context?.expected_shaping_state_sha256 ?? null,
      card_label: "Idea",
      headline: "Start Brainstorm",
      actions: [
        shapingAction("start_brainstorm", "Start Brainstorm", {
          launch_mode: "connected",
          primary: !unavailable,
          enabled: !unavailable,
        }),
        shapingAction(
          "start_brainstorm",
          "Start Brainstorm without a model",
          { launch_mode: "manual", primary: unavailable },
        ),
      ],
      ...(picker === null
        ? {
            runtime_unavailable:
              context === undefined
                ? "Shaping availability has not loaded."
                : unavailableReason(context),
          }
        : { model_picker: picker }),
    };
  }

  if (phase !== "brainstorm" && phase !== "spec" && phase !== "plan") {
    return {
      mode: "hidden",
      phase: null,
      required_input: null,
      can_compile: false,
      can_import: false,
    };
  }

  if (context === undefined) {
    if (phase === "brainstorm") {
      return {
        mode: "active",
        phase,
        required_input: "none",
        can_compile: true,
        can_import: true,
      };
    }
    if (phase === "spec") {
      return {
        mode: "active",
        phase,
        required_input: "brainstorm_acceptance_sha256",
        can_compile: true,
        can_import: true,
      };
    }
    return {
      mode: "hidden",
      phase: null,
      required_input: null,
      can_compile: false,
      can_import: false,
    };
  }

  const provenance = projectedProvenance(
    phase,
    context.models.model_use,
  );
  const common = {
    phase,
    expected_shaping_state_sha256:
      context.expected_shaping_state_sha256,
    provenance,
  };

  if (context.revision?.result.status === "repair") {
    return repairProjection(
      phase,
      context,
      context.revision.result.failing_component,
    );
  }

  if (context.manual_recovery !== null && context.manual_recovery !== undefined) {
    const actions = manualRecoveryActions(context.manual_recovery);
    return {
      ...common,
      mode: "manual_recovery",
      recovery: context.manual_recovery,
      actions,
    };
  }

  const applied =
    context.revision?.result.status === "applied"
      ? context.revision.result
      : null;
  if (applied !== null && context.run?.status !== "terminal" && context.run !== null) {
    const actions: ShapingActionProjection[] = [];
    const label = phaseLabel(phase);
    return {
      ...common,
      mode: "run_state",
      actions,
      run: context.run,
      refresh: context.refresh ?? DEFAULT_SHAPING_REFRESH,
      lifecycle: {
        state: "finishing",
        card_label: `${label} · Active`,
        headline: `${label} finishing`,
        copy: "Recovering this run's result.",
        refresh_running: true,
        actions,
      },
    };
  }

  if (applied !== null) {
    const bindings = {
      expected_mission_content_sha256:
        context.revision!.mission_content_sha256,
      expected_result_content_sha256: applied.result_content_sha256,
      expected_shaping_state_sha256:
        context.expected_shaping_state_sha256,
    };
    const requestChanges = requestChangesProjection(context, phase);

    if (phase === "plan") {
      if (!isPlanResult(applied.result)) {
        return repairProjection(phase, context, "result.identity.phase");
      }
      const currentContract = item.work_item.goal?.goal_contract;
      const currentContractSha256 = context.current_goal_contract_sha256;
      if (currentContract === undefined || currentContractSha256 == null) {
        return repairProjection(phase, context, "current goal contract");
      }
      if (
        context.revision!.plan_goal_contract_sha256 !==
          currentContractSha256 ||
        context.revision!.plan_goal_version !== currentContract.goal_version
      ) {
        const picker = projectedPicker(context, "plan");
        const unavailable = picker === null;
        const actions = [
          shapingAction(
            "replan_with_updated_contract",
            "Replan with updated contract",
            {
              launch_mode: "connected",
              primary: !unavailable,
              enabled: !unavailable,
            },
          ),
          shapingAction("request_changes", "Request changes"),
          shapingAction(
            "replan_with_updated_contract",
            "Replan & prepare Plan",
            { launch_mode: "manual", primary: unavailable },
          ),
        ];
        return {
          ...common,
          mode: "plan_result_superseded",
          phase: "plan",
          result: applied.result,
          reason:
            "The governed contract changed after this plan was produced.",
          bindings: {
            ...bindings,
            goal_contract_sha256: currentContractSha256,
          },
          actions,
          request_changes: requestChanges,
          ...(picker === null
            ? { runtime_unavailable: unavailableReason(context) }
            : { model_picker: picker }),
        };
      }

      const actions = [
        shapingAction("request_changes", "Request changes"),
      ];
      const lifecycle: ShapingLifecycleProjection = {
        state: "ready",
        card_label: "Plan · Ready",
        headline: "Plan result ready",
        copy: "Review the plan result. Execute approval is not available in this slice.",
        refresh_running: false,
        actions,
      };
      return {
        ...common,
        mode: "ready",
        phase: "plan",
        result: applied.result,
        bindings,
        actions,
        lifecycle,
        request_changes: requestChanges,
        sections: {
          summary: { summary: previewShapingText(applied.result.summary) },
          checklist: previewShapingChecklist(applied.result.checklist),
          unresolved_questions: previewShapingList(
            applied.result.open_questions,
          ),
          provenance,
          advanced_recovery: {
            relevant_skills: [...applied.result.relevant_skills],
            product_doc_impacts: [...applied.result.product_doc_impacts],
            todo_impacts: [...applied.result.todo_impacts],
          },
        },
        execute_approval_available: false,
        execute_approval_message:
          "Execute approval is not available in this slice",
        ...(context.refresh === undefined ? {} : { refresh: context.refresh }),
      };
    }

    if (phase === "brainstorm") {
      if (!isBrainstormResult(applied.result)) {
        return repairProjection(phase, context, "result.identity.phase");
      }
      const decision = phaseDecisionActions(context, phase);
      const lifecycle: ShapingLifecycleProjection = {
        state: "ready",
        card_label: "Brainstorm · Ready",
        headline: "Brainstorm result ready",
        copy: "Choose the exact result to carry into Spec.",
        refresh_running: false,
        actions: decision.actions,
      };
      return {
        ...common,
        mode: "ready",
        phase,
        result: applied.result,
        bindings,
        actions: decision.actions,
        lifecycle,
        request_changes: requestChanges,
        sections: {
          summary: {
            problem_statement: previewShapingText(
              applied.result.problem_statement,
            ),
            approach: previewShapingText(applied.result.approach),
          },
          non_goals: previewShapingList(applied.result.non_goals),
          unresolved_questions: previewShapingList(
            applied.result.open_questions,
          ),
          provenance,
          ...(decision.picker === null
            ? { runtime_unavailable: unavailableReason(context) }
            : { next_step: decision.picker }),
        },
        ...(context.refresh === undefined ? {} : { refresh: context.refresh }),
      };
    }

    if (!isSpecResult(applied.result)) {
      return repairProjection(phase, context, "result.identity.phase");
    }
    const goalContractSha256 = context.derived_goal_contract_sha256;
    if (goalContractSha256 == null) {
      return repairProjection(phase, context, "derived goal contract hash");
    }
    const proposal = applied.result.proposal;
    const contract: GoalContract = {
      schema_version: 1,
      goal_version:
        (item.work_item.goal?.goal_contract?.goal_version ?? 0) + 1,
      purpose: proposal.purpose,
      acceptance_criteria: [...proposal.acceptance_criteria],
      non_goals: [...proposal.non_goals],
      allowed_scope: [...proposal.allowed_scope],
      review_ready: [...proposal.review_ready],
    };
    const purpose = previewShapingText(contract.purpose);
    const criteria = previewShapingList(contract.acceptance_criteria);
    const nonGoals = previewShapingList(contract.non_goals);
    const allowedScope = previewShapingList(contract.allowed_scope);
    const reviewReady = previewShapingList(contract.review_ready);
    const decision = phaseDecisionActions(context, phase);
    const lifecycle: ShapingLifecycleProjection = {
      state: "ready",
      card_label: "Spec · Ready",
      headline: "Spec ready for approval",
      copy: "Approve the exact derived contract and prepare Plan.",
      refresh_running: false,
      actions: decision.actions,
    };
    return {
      ...common,
      mode: "ready",
      phase,
      result: applied.result,
      bindings: { ...bindings, goal_contract_sha256: goalContractSha256 },
      actions: decision.actions,
      lifecycle,
      request_changes: requestChanges,
      governed_contract: {
        contract,
        goal_contract_sha256: goalContractSha256,
        truncation: {
          purpose: purpose.truncated,
          acceptance_criteria: criteria.truncated,
          non_goals: nonGoals.truncated,
          allowed_scope: allowedScope.truncated,
          review_ready: reviewReady.truncated,
        },
      },
      sections: {
        summary: { purpose },
        criteria,
        governed_fields: {
          pointer:
            "Purpose and acceptance criteria appear in the sections above.",
          non_goals: nonGoals,
          allowed_scope: allowedScope,
          review_ready: reviewReady,
        },
        provenance,
        ...(decision.picker === null
          ? { runtime_unavailable: unavailableReason(context) }
          : { next_step: decision.picker }),
      },
      ...(context.refresh === undefined ? {} : { refresh: context.refresh }),
    };
  }

  if (context.run !== null) {
    const lifecycle = runLifecycleProjection(phase, context.run);
    if (context.run.status !== "terminal") {
      return {
        ...common,
        mode: "run_state",
        actions: lifecycle.actions,
        lifecycle,
        run: context.run,
        refresh: context.refresh ?? DEFAULT_SHAPING_REFRESH,
      };
    }
    if (lifecycle.state === "needs_repair") {
      return repairProjection(phase, context, "terminal run outcome");
    }
    const picker = projectedPicker(context, phase);
    const connectedAvailable = picker !== null;
    const manualRecoveryAction = shapingAction(
      "prepare_manual_recovery",
      "Prepare manual recovery",
      {
        launch_mode: "manual",
        primary: !connectedAvailable,
      },
    );
    const actions = lifecycle.actions.map((action) => {
      if (action.kind === "launch_phase") {
        return {
          ...action,
          primary: connectedAvailable,
          enabled: connectedAvailable,
        };
      }
      if (action.kind === "prepare_manual_recovery") {
        return manualRecoveryAction;
      }
      return action;
    });
    if (
      !connectedAvailable &&
      actions.some((action) => action.kind === "launch_phase") &&
      !actions.some((action) => action.kind === "prepare_manual_recovery")
    ) {
      actions.push(manualRecoveryAction);
    }
    const projectedLifecycle = { ...lifecycle, actions };
    return {
      ...common,
      mode: "terminal_run_failure",
      actions,
      lifecycle: projectedLifecycle,
      run: context.run,
      manual_recovery_action: manualRecoveryAction,
      ...(context.refresh === undefined ? {} : { refresh: context.refresh }),
      ...(picker === null
        ? { runtime_unavailable: unavailableReason(context) }
        : { model_picker: picker }),
    };
  }

  const launchFailure = context.post_commit_launch_failure;
  if (launchFailure !== null && launchFailure !== undefined) {
    const lockedModelUnavailable =
      context.models.status !== "available" ||
      !context.models.available_model_ids.includes(
        launchFailure.locked_model,
      );
    const newAttemptAvailable = projectedPicker(context, phase) !== null;
    const actions = lockedModelUnavailable
      ? newAttemptAvailable
        ? [
          shapingAction("open_new_attempt", `Start ${phaseLabel(phase)}`, {
            primary: true,
          }),
        ]
        : [
            shapingAction(
              "prepare_manual_recovery",
              "Prepare manual recovery",
              { launch_mode: "manual", primary: true },
            ),
          ]
      : [
          shapingAction("retry_launch", "Retry launch", {
            primary: true,
          }),
        ];
    return {
      ...common,
      mode: "post_commit_launch_failure",
      actions,
      decision_id: launchFailure.decision_id,
      locked_model: launchFailure.locked_model,
      locked_model_unavailable: lockedModelUnavailable,
      reason: launchFailure.reason,
      bindings: {
        decision_id: launchFailure.decision_id,
        expected_shaping_state_sha256:
          context.expected_shaping_state_sha256,
      },
      ...(!lockedModelUnavailable || newAttemptAvailable
        ? {}
        : { runtime_unavailable: unavailableReason(context) }),
    };
  }

  return preReadyProjection(phase, context);
}

export function missionHandoffModeForItem(item: {
  source_id: string;
  work_item: {
    goal: { goal_contract?: { goal_version: number } };
    state: {
      phase: WorkItemPhase;
      status: WorkItemStatus;
      input_revision?: number;
      attempt?: number;
    };
  };
}): MissionHandoffMode {
  const { goal, state } = item.work_item;
  if (
    item.source_id === INBOX_SOURCE_ID ||
    goal.goal_contract === undefined ||
    state.input_revision === undefined ||
    state.attempt === undefined ||
    state.phase !== "execute"
  ) {
    return "hidden";
  }

  if (state.status === "active") {
    return "active";
  }
  if (state.status === "blocked") {
    return "repair";
  }
  return "hidden";
}

export function connectedExecuteForItem(item: {
  source_id: string;
  work_item: {
    goal: { goal_contract?: { goal_version: number } };
    state: {
      phase: WorkItemPhase;
      status: WorkItemStatus;
      goal_version?: number;
      input_revision?: number;
      attempt?: number;
      patch_cycle?: number;
      attention?: WorkItemAttention;
    };
  };
}): ConnectedExecuteProjection {
  const { goal, state } = item.work_item;
  const governedExecute =
    item.source_id !== INBOX_SOURCE_ID &&
    goal.goal_contract !== undefined &&
    state.phase === "execute" &&
    state.status === "active" &&
    state.goal_version === goal.goal_contract.goal_version &&
    state.input_revision !== undefined &&
    state.attempt !== undefined &&
    state.patch_cycle === 0;

  if (!governedExecute) {
    return { mode: "hidden", can_launch: false, permission: null };
  }

  if (state.attention === undefined) {
    return { mode: "launch", can_launch: true, permission: null };
  }

  if (
    state.attention.kind === "missing_permission" &&
    state.attention.governed_tuple.goal_version === state.goal_version &&
    state.attention.governed_tuple.input_revision === state.input_revision &&
    state.attention.governed_tuple.attempt === state.attempt &&
    state.attention.governed_tuple.patch_cycle === state.patch_cycle &&
    state.attention.pins.mission_content_sha256 !== undefined
  ) {
    return {
      mode: "permission",
      can_launch: false,
      permission: state.attention,
    };
  }

  return { mode: "hidden", can_launch: false, permission: null };
}

export function connectedPermissionInboxForItem(
  item: Parameters<typeof connectedExecuteForItem>[0],
): ConnectedPermissionInboxProjection {
  const connectedExecute = connectedExecuteForItem(item);
  if (connectedExecute.mode !== "permission") {
    return { mode: "hidden", action: null, permission: null };
  }
  return {
    mode: "active",
    action: "open_recovery",
    permission: connectedExecute.permission,
  };
}

export function reviewHandoffForItem(
  item: {
    source_id: string;
    work_item: {
      goal: {
        work_item_id: string;
        goal_contract?: { goal_version: number };
      };
      state: {
        phase: WorkItemPhase;
        status: WorkItemStatus;
        goal_version?: number;
        input_revision?: number;
        attempt?: number;
        patch_cycle?: number;
      };
    };
  },
  evidence: readonly BoardEvidenceProjection[],
): ReviewHandoffProjection {
  const { goal, state } = item.work_item;
  const matchingAppliedSubjects = evidence.filter(
    (stored) =>
      stored.evidence.phase ===
        (state.patch_cycle === 0 ? "execute" : "patch") &&
      stored.evidence.outcome === "applied" &&
      stored.evidence.identity.work_item_id === goal.work_item_id &&
      stored.evidence.identity.goal_version === state.goal_version &&
      stored.evidence.identity.input_revision === state.input_revision &&
      stored.evidence.identity.attempt === state.attempt &&
      (state.patch_cycle === 0 ||
        stored.evidence.identity.patch_cycle === state.patch_cycle),
  ).length;
  const eligible =
    item.source_id !== INBOX_SOURCE_ID &&
    goal.goal_contract !== undefined &&
    state.phase === "review" &&
    state.status === "active" &&
    state.goal_version !== undefined &&
    state.input_revision !== undefined &&
    state.attempt !== undefined &&
    state.patch_cycle !== undefined &&
    matchingAppliedSubjects === 1;

  return eligible
    ? {
        mode: "active",
        requires_independence_attestation: true,
        can_compile: true,
        can_import: true,
      }
    : {
        mode: "hidden",
        requires_independence_attestation: false,
        can_compile: false,
        can_import: false,
      };
}

function hiddenPatchAttention(): PatchAttentionProjection {
  return {
    mode: "hidden",
    action: null,
    attention: null,
    patch_cycle: null,
  };
}

function evidenceMatchesTuple(
  stored: BoardEvidenceProjection,
  tuple: {
    work_item_id: string;
    goal_version: number;
    input_revision: number;
    attempt: number;
  },
): boolean {
  return (
    stored.evidence.identity.work_item_id === tuple.work_item_id &&
    stored.evidence.identity.goal_version === tuple.goal_version &&
    stored.evidence.identity.input_revision === tuple.input_revision &&
    stored.evidence.identity.attempt === tuple.attempt
  );
}

function reviewSubmissionForEvidence(
  stored: BoardEvidenceProjection,
): BoardReviewSubmissionProjection | null {
  const { submission } = stored;
  return submission !== undefined &&
    "review_mission_content_sha256" in submission
    ? submission
    : null;
}

function attentionMatchesCurrentReview(
  attention: WorkItemAttention,
  evidence: readonly BoardEvidenceProjection[],
  tuple: {
    work_item_id: string;
    goal_version: number;
    input_revision: number;
    attempt: number;
  },
): boolean {
  const [missionPath, resultPath] = attention.pins.artifact_paths;
  if (
    attention.pins.artifact_paths.length !== 2 ||
    !missionPath.endsWith("/mission.json") ||
    !resultPath.endsWith("/result.json") ||
    attention.pins.evidence_paths.length !== 1 ||
    attention.pins.git_commit === undefined ||
    attention.pins.mission_content_sha256 === undefined ||
    attention.pins.result_content_sha256 === undefined
  ) {
    return false;
  }

  const matching = evidence.filter((stored) => {
    const submission = reviewSubmissionForEvidence(stored);
    return (
      stored.evidence.phase === "review" &&
      stored.evidence.outcome === "applied" &&
      evidenceMatchesTuple(stored, tuple) &&
      stored.evidence.mission_content_sha256 ===
        attention.pins.mission_content_sha256 &&
      stored.evidence.result_content_sha256 ===
        attention.pins.result_content_sha256 &&
      stored.evidence.result_commit === attention.pins.git_commit &&
      stored.summary?.evidence_path === attention.pins.evidence_paths[0] &&
      submission !== null &&
      submission.review_mission_content_sha256 ===
        attention.pins.mission_content_sha256 &&
      submission.accepted_result_commit === attention.pins.git_commit
    );
  });

  if (matching.length !== 1) {
    return false;
  }
  const verdict = reviewSubmissionForEvidence(matching[0])?.verdict;
  return attention.kind === "review_ready"
    ? verdict === "clean"
    : verdict === "findings";
}

function activePatchMatchesReviewLineage(
  evidence: readonly BoardEvidenceProjection[],
  tuple: {
    work_item_id: string;
    goal_version: number;
    input_revision: number;
    attempt: number;
    patch_cycle: number;
  },
): boolean {
  const subjectPhase = tuple.patch_cycle === 1 ? "execute" : "patch";
  const subjects = evidence.filter(
    (stored) =>
      stored.evidence.phase === subjectPhase &&
      stored.evidence.outcome === "applied" &&
      evidenceMatchesTuple(stored, tuple) &&
      (subjectPhase === "execute" ||
        stored.evidence.identity.patch_cycle === tuple.patch_cycle - 1),
  );
  if (subjects.length !== 1) {
    return false;
  }
  const subject = subjects[0].evidence;
  const reviews = evidence.filter((stored) => {
    const submission = reviewSubmissionForEvidence(stored);
    if (
      stored.evidence.phase !== "review" ||
      stored.evidence.outcome !== "applied" ||
      !evidenceMatchesTuple(stored, tuple) ||
      submission?.verdict !== "findings" ||
      submission.review_mission_content_sha256 !==
        stored.evidence.mission_content_sha256 ||
      submission.accepted_result_commit !== stored.evidence.result_commit
    ) {
      return false;
    }

    return subjectPhase === "execute"
      ? submission.execute_mission_content_sha256 ===
          subject.mission_content_sha256 &&
          submission.execute_result_content_sha256 ===
            subject.result_content_sha256
      : submission.patch_mission_content_sha256 ===
          subject.mission_content_sha256 &&
          submission.patch_result_content_sha256 ===
            subject.result_content_sha256;
  });
  return reviews.length === 1;
}

export function patchAttentionForItem(
  item: {
    source_id: string;
    work_item: {
      goal: {
        work_item_id: string;
        goal_contract?: { goal_version: number };
      };
      state: {
        phase: WorkItemPhase;
        status: WorkItemStatus;
        goal_version?: number;
        input_revision?: number;
        attempt?: number;
        patch_cycle?: number;
        attention?: WorkItemAttention;
      };
    };
  },
  evidence: readonly BoardEvidenceProjection[],
): PatchAttentionProjection {
  const { goal, state } = item.work_item;
  if (
    item.source_id === INBOX_SOURCE_ID ||
    goal.goal_contract === undefined ||
    state.status !== "active" ||
    state.goal_version === undefined ||
    goal.goal_contract.goal_version !== state.goal_version ||
    state.input_revision === undefined ||
    state.attempt === undefined ||
    state.patch_cycle === undefined
  ) {
    return hiddenPatchAttention();
  }
  const tuple = {
    work_item_id: goal.work_item_id,
    goal_version: state.goal_version,
    input_revision: state.input_revision,
    attempt: state.attempt,
    patch_cycle: state.patch_cycle,
  };

  if (state.phase === "patch") {
    return state.attention === undefined &&
      state.patch_cycle > 0 &&
      activePatchMatchesReviewLineage(evidence, tuple)
      ? {
          mode: "patch_active",
          action: "compile_or_import_patch",
          attention: null,
          patch_cycle: state.patch_cycle,
        }
      : hiddenPatchAttention();
  }

  const attention = state.attention;
  if (
    state.phase !== "review" ||
    attention === undefined ||
    attention.governed_tuple.goal_version !== state.goal_version ||
    attention.governed_tuple.input_revision !== state.input_revision ||
    attention.governed_tuple.attempt !== state.attempt ||
    attention.governed_tuple.patch_cycle !== state.patch_cycle ||
    !attentionMatchesCurrentReview(attention, evidence, tuple)
  ) {
    return hiddenPatchAttention();
  }

  switch (attention.kind) {
    case "patch_plan_approval":
      return {
        mode: "patch_plan",
        action: "accept_patch_plan",
        attention,
        patch_cycle: state.patch_cycle,
      };
    case "unresolved_finding":
    case "ambiguous_goal":
    case "cycle_limit":
    case "missing_permission":
      return {
        mode: "escalation",
        action: "resolve_escalation",
        attention,
        patch_cycle: state.patch_cycle,
      };
    case "review_ready":
      return {
        mode: "review_ready",
        action: "review_result",
        attention,
        patch_cycle: state.patch_cycle,
      };
    default:
      return hiddenPatchAttention();
  }
}

export function boardTransitionActionsForPhase(phase: WorkItemPhase): {
  forward: BoardTransitionAction | null;
  back: BoardTransitionAction | null;
} {
  const sourceColumnIndex = BOARD_COLUMNS.findIndex(
    (column) => column.id === boardColumnForPhase(phase).id,
  );
  let forward: BoardTransitionAction | null = null;
  let back: BoardTransitionAction | null = null;

  for (const candidatePhase of ALLOWED_PHASE_TRANSITIONS[phase]) {
    const targetColumn = boardColumnForPhase(candidatePhase);
    const resolution = resolveBoardDrop(phase, targetColumn.id);

    if (!resolution.ok || !resolution.changed) {
      continue;
    }

    const action: BoardTransitionAction = {
      target_column_id: targetColumn.id,
      target_phase: resolution.target_phase,
      label: `Move to ${targetColumn.label}`,
    };
    const targetColumnIndex = BOARD_COLUMNS.findIndex(
      (column) => column.id === targetColumn.id,
    );

    if (targetColumnIndex > sourceColumnIndex) {
      forward = action;
    } else if (targetColumnIndex < sourceColumnIndex) {
      back = action;
    }
  }

  return { forward, back };
}

export function boardItemIdentityKey(identity: BoardItemIdentity): string {
  return JSON.stringify([identity.source_id, identity.work_item_id]);
}

export function parseBoardItemIdentityKey(
  key: string,
): BoardItemIdentity | null {
  try {
    const parsed = JSON.parse(key) as unknown;
    const tuple = z.tuple([sourceIdSchema, workItemIdSchema]).safeParse(parsed);

    if (!tuple.success) {
      return null;
    }

    return { source_id: tuple.data[0], work_item_id: tuple.data[1] };
  } catch {
    return null;
  }
}

export function createDefaultBoardView(): BoardView {
  return {
    version: 1,
    project_source_ids: null,
    include_unassigned: true,
    selected_item: null,
    scroll: { x: 0, y: 0 },
  };
}

export function parseBoardView(value: unknown): BoardView {
  try {
    const parsed =
      typeof value === "string" ? (JSON.parse(value) as unknown) : value;
    const result = boardViewSchema.safeParse(parsed);
    return result.success ? result.data : createDefaultBoardView();
  } catch {
    return createDefaultBoardView();
  }
}

export function isBoardSourceVisible(
  source: { source_id: string; project: unknown | null },
  view: Pick<BoardView, "project_source_ids" | "include_unassigned">,
): boolean {
  if (source.project === null) {
    return view.include_unassigned;
  }

  return (
    view.project_source_ids === null ||
    view.project_source_ids.includes(source.source_id)
  );
}

export function revealBoardItem(
  view: BoardView,
  item: BoardItemLocation,
): BoardView {
  const selectedItem: BoardItemIdentity = {
    source_id: item.source_id,
    work_item_id: item.work_item_id,
  };

  if (item.project === null) {
    return {
      ...view,
      include_unassigned: true,
      selected_item: selectedItem,
    };
  }
  if (
    view.project_source_ids === null ||
    view.project_source_ids.includes(item.source_id)
  ) {
    return { ...view, selected_item: selectedItem };
  }
  return {
    ...view,
    project_source_ids: [...view.project_source_ids, item.source_id],
    selected_item: selectedItem,
  };
}
