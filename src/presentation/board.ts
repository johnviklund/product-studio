import { z } from "zod";

import {
  workItemIdSchema,
  type WorkItemCapture,
  type WorkItemAttention,
  type WorkItemPhase,
  type WorkItemStatus,
} from "../domain/work-item";
import { INBOX_SOURCE_ID } from "../domain/portfolio-source";
import type { ExternalResultSubmission } from "../domain/result";
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
      mode: "hidden";
      phase: null;
      required_input: null;
      can_compile: false;
      can_import: false;
    };

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

export function shapingHandoffForItem(item: {
  source_id: string;
  work_item: {
    state: {
      phase: WorkItemPhase;
      status: WorkItemStatus;
    };
  };
}): ShapingHandoffProjection {
  const { phase, status } = item.work_item.state;
  if (
    item.source_id === INBOX_SOURCE_ID ||
    status !== "active" ||
    (phase !== "brainstorm" && phase !== "spec")
  ) {
    return {
      mode: "hidden",
      phase: null,
      required_input: null,
      can_compile: false,
      can_import: false,
    };
  }

  return phase === "brainstorm"
    ? {
        mode: "active",
        phase,
        required_input: "none",
        can_compile: true,
        can_import: true,
      }
    : {
        mode: "active",
        phase,
        required_input: "brainstorm_acceptance_sha256",
        can_compile: true,
        can_import: true,
      };
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
