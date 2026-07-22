import { z } from "zod";

import {
  workItemIdSchema,
  type WorkItemCapture,
  type WorkItemPhase,
} from "../domain/work-item";
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
    phases: ["review", "test"],
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
