import { describe, expect, it } from "vitest";

import {
  BOARD_COLUMNS,
  boardColumnForPhase,
  boardItemIdentityKey,
  createDefaultBoardView,
  isBoardSourceVisible,
  nextActionForPhase,
  parseBoardItemIdentityKey,
  parseBoardView,
  resolveBoardDrop,
  targetPhaseForColumn,
  validatePhaseTransition,
} from "../src/presentation/board";

const workItemId = "wi_550e8400-e29b-41d4-a716-446655440000";

describe("board projection", () => {
  it("groups every durable phase into the seven workflow columns", () => {
    expect(BOARD_COLUMNS.map(({ label }) => label)).toEqual([
      "Todo",
      "Spec",
      "Plan",
      "Execute",
      "Review",
      "Ship",
      "Done",
    ]);
    expect(boardColumnForPhase("idea").id).toBe("todo");
    expect(boardColumnForPhase("brainstorm").id).toBe("todo");
    expect(boardColumnForPhase("review").id).toBe("review");
    expect(boardColumnForPhase("test").id).toBe("review");
    expect(boardColumnForPhase("learn").id).toBe("done");
  });

  it("uses the confirmed primary phase for multi-phase column drops", () => {
    expect(targetPhaseForColumn("todo")).toBe("brainstorm");
    expect(targetPhaseForColumn("review")).toBe("review");
    expect(resolveBoardDrop("idea", "todo")).toEqual({
      ok: true,
      changed: false,
      target_phase: "idea",
    });
    expect(resolveBoardDrop("test", "review")).toEqual({
      ok: true,
      changed: false,
      target_phase: "test",
    });
  });

  it("allows adjacent forward and backward moves only", () => {
    expect(validatePhaseTransition("idea", "spec")).toEqual({ ok: true });
    expect(validatePhaseTransition("spec", "brainstorm")).toEqual({ ok: true });
    expect(validatePhaseTransition("test", "ship")).toEqual({ ok: true });
    expect(validatePhaseTransition("learn", "ship")).toEqual({ ok: true });
    expect(resolveBoardDrop("plan", "execute")).toEqual({
      ok: true,
      changed: true,
      target_phase: "execute",
    });

    expect(validatePhaseTransition("idea", "plan")).toEqual({
      ok: false,
      reason: "Move from Todo to Plan is not allowed; move one column at a time.",
    });
    expect(validatePhaseTransition("spec", "idea")).toEqual({
      ok: false,
      reason: "Moves into Todo target the brainstorm phase.",
    });
    expect(resolveBoardDrop("plan", "ship")).toEqual({
      ok: false,
      reason: "Move from Plan to Ship is not allowed; move one column at a time.",
    });
  });

  it("provides one phase-derived next action", () => {
    expect(nextActionForPhase("idea")).toBe("Brainstorm the idea");
    expect(nextActionForPhase("execute")).toBe("Review the result");
    expect(nextActionForPhase("ship")).toBe("Capture the learning");
  });
});

describe("board identity and view state", () => {
  it("round-trips a composite source-qualified identity", () => {
    const identity = { source_id: "inbox", work_item_id: workItemId };
    const key = boardItemIdentityKey(identity);

    expect(parseBoardItemIdentityKey(key)).toEqual(identity);
    expect(parseBoardItemIdentityKey("not-json")).toBeNull();
    expect(
      boardItemIdentityKey({
        source_id: "another-source",
        work_item_id: workItemId,
      }),
    ).not.toBe(key);
  });

  it("restores a valid versioned view and fails closed on malformed storage", () => {
    const view = {
      version: 1 as const,
      project_source_ids: ["ws_one", "ws_two"],
      include_unassigned: false,
      selected_item: { source_id: "ws_one", work_item_id: workItemId },
      scroll: { x: 640, y: 120 },
    };

    expect(parseBoardView(JSON.stringify(view))).toEqual(view);
    expect(parseBoardView("not-json")).toEqual(createDefaultBoardView());
    expect(parseBoardView({ ...view, version: 2 })).toEqual(
      createDefaultBoardView(),
    );
    expect(
      parseBoardView({ ...view, project_source_ids: ["ws_one", "ws_one"] }),
    ).toEqual(createDefaultBoardView());
  });

  it("supports all-project, selected-project, and unassigned-only filters", () => {
    const project = { source_id: "ws_one", project: { name: "One" } };
    const anotherProject = { source_id: "ws_two", project: { name: "Two" } };
    const unassigned = { source_id: "inbox", project: null };

    expect(
      [project, anotherProject, unassigned].filter((source) =>
        isBoardSourceVisible(source, {
          project_source_ids: null,
          include_unassigned: true,
        }),
      ),
    ).toHaveLength(3);
    expect(
      [project, anotherProject, unassigned].filter((source) =>
        isBoardSourceVisible(source, {
          project_source_ids: ["ws_two"],
          include_unassigned: false,
        }),
      ),
    ).toEqual([anotherProject]);
    expect(
      [project, anotherProject, unassigned].filter((source) =>
        isBoardSourceVisible(source, {
          project_source_ids: [],
          include_unassigned: true,
        }),
      ),
    ).toEqual([unassigned]);
  });
});
