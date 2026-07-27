import { describe, expect, it } from "vitest";

import {
  BOARD_COLUMNS,
  boardTransitionActionsForPhase,
  boardColumnForPhase,
  boardItemIdentityKey,
  connectedExecuteForItem,
  connectedPermissionInboxForItem,
  createDefaultBoardView,
  detailPanelModeForItem,
  isBoardSourceVisible,
  missionHandoffModeForItem,
  nextActionForPhase,
  patchAttentionForItem,
  parseBoardItemIdentityKey,
  parseBoardView,
  reviewHandoffForItem,
  revealBoardItem,
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
    expect(boardColumnForPhase("patch").id).toBe("review");
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
    expect(nextActionForPhase("patch")).toBe("Review the patch");
    expect(nextActionForPhase("ship")).toBe("Capture the learning");
  });

  it("uses a capture panel only for captures still in Todo", () => {
    const capture = {
      work_item: {
        goal: {
          capture: {
            kind: "idea" as const,
            original_title: "Capture the thought",
            captured_at: "2026-07-21T00:00:00.000Z",
          },
        },
        state: { phase: "idea" as const },
      },
    };

    expect(detailPanelModeForItem(capture)).toBe("capture");
    expect(
      detailPanelModeForItem({
        ...capture,
        work_item: { ...capture.work_item, state: { phase: "spec" } },
      }),
    ).toBe("governed");
    expect(
      detailPanelModeForItem({
        work_item: {
          goal: {},
          state: { phase: "idea" },
        },
      }),
    ).toBe("governed");
  });

  it("derives active, repair, and hidden mission handoff states", () => {
    const item = {
      source_id: "ws_product",
      work_item: {
        goal: { goal_contract: { goal_version: 3 } },
        state: {
          phase: "execute" as const,
          status: "active" as const,
          input_revision: 2,
          attempt: 1,
          patch_cycle: 0,
        },
      },
    };

    expect(missionHandoffModeForItem(item)).toBe("active");
    expect(
      missionHandoffModeForItem({
        ...item,
        work_item: {
          ...item.work_item,
          state: { ...item.work_item.state, status: "blocked" },
        },
      }),
    ).toBe("repair");
    expect(
      missionHandoffModeForItem({
        ...item,
        work_item: {
          ...item.work_item,
          state: { ...item.work_item.state, phase: "review" },
        },
      }),
    ).toBe("hidden");
    expect(missionHandoffModeForItem({ ...item, source_id: "inbox" })).toBe(
      "hidden",
    );
    expect(
      missionHandoffModeForItem({
        ...item,
        work_item: {
          ...item.work_item,
          goal: {},
        },
      }),
    ).toBe("hidden");
  });

  it("exposes only a current governed connected launch or exact permission decision", () => {
    const item = {
      source_id: "ws_product",
      work_item: {
        goal: { goal_contract: { goal_version: 3 } },
        state: {
          phase: "execute" as const,
          status: "active" as const,
          goal_version: 3,
          input_revision: 2,
          attempt: 1,
          patch_cycle: 0,
        },
      },
    };

    expect(connectedExecuteForItem(item)).toEqual({
      mode: "launch",
      can_launch: true,
      permission: null,
    });

    const permission = {
      kind: "missing_permission" as const,
      question: "Allow this exact operation once?",
      recommendation: "Keep it denied unless it is required.",
      created_at: "2026-07-26T12:00:00.000Z",
      governed_tuple: {
        goal_version: 3,
        input_revision: 2,
        attempt: 1,
        patch_cycle: 0,
      },
      pins: {
        artifact_paths: [".founder/missions/wi/mission.json"] as [string, ...string[]],
        evidence_paths: [],
        mission_content_sha256: "a".repeat(64),
      },
      operation: {
        normalized_operation: {
          schema_version: 1 as const,
          kind: "command" as const,
          executable: "git",
          args: ["status"],
        },
        canonical_args_sha256: "b".repeat(64),
        operation_sha256: "c".repeat(64),
        reason: "The command is outside the governed envelope.",
        resolved_envelope_sha256: "d".repeat(64),
        connected_run_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1",
      },
    };
    expect(
      connectedExecuteForItem({
        ...item,
        work_item: {
          ...item.work_item,
          state: { ...item.work_item.state, attention: permission },
        },
      }),
    ).toEqual({
      mode: "permission",
      can_launch: false,
      permission,
    });
    expect(
      connectedPermissionInboxForItem({
        ...item,
        work_item: {
          ...item.work_item,
          state: { ...item.work_item.state, attention: permission },
        },
      }),
    ).toEqual({
      mode: "active",
      action: "open_recovery",
      permission,
    });
    expect(
      connectedExecuteForItem({
        ...item,
        work_item: {
          ...item.work_item,
          state: {
            ...item.work_item.state,
            attention: {
              ...permission,
              governed_tuple: { ...permission.governed_tuple, attempt: 0 },
            },
          },
        },
      }),
    ).toEqual({ mode: "hidden", can_launch: false, permission: null });
    expect(
      connectedPermissionInboxForItem({ ...item, source_id: "inbox" }),
    ).toEqual({ mode: "hidden", action: null, permission: null });
    expect(
      connectedExecuteForItem({ ...item, source_id: "inbox" }),
    ).toEqual({ mode: "hidden", can_launch: false, permission: null });
  });

  it("shows review handoff affordances only for the current applied execute subject", () => {
    const item = {
      source_id: "ws_product",
      work_item: {
        goal: {
          work_item_id: workItemId,
          goal_contract: { goal_version: 3 },
        },
        state: {
          phase: "review" as const,
          status: "active" as const,
          goal_version: 3,
          input_revision: 2,
          attempt: 1,
          patch_cycle: 0,
        },
      },
    };
    const appliedExecute = {
      evidence: {
        phase: "execute" as const,
        outcome: "applied" as const,
        identity: {
          work_item_id: workItemId,
          goal_version: 3,
          input_revision: 2,
          attempt: 1,
        },
      },
    };

    expect(reviewHandoffForItem(item, [appliedExecute])).toEqual({
      mode: "active",
      requires_independence_attestation: true,
      can_compile: true,
      can_import: true,
    });
    expect(
      reviewHandoffForItem(item, [
        {
          evidence: {
            ...appliedExecute.evidence,
            outcome: "rejected",
          },
        },
      ]),
    ).toMatchObject({ mode: "hidden", can_compile: false, can_import: false });
    expect(
      reviewHandoffForItem(item, [
        {
          evidence: {
            ...appliedExecute.evidence,
            identity: { ...appliedExecute.evidence.identity, attempt: 0 },
          },
        },
      ]),
    ).toMatchObject({ mode: "hidden" });
    expect(
      reviewHandoffForItem(item, [appliedExecute, appliedExecute]),
    ).toMatchObject({ mode: "hidden", can_compile: false, can_import: false });
    expect(
      reviewHandoffForItem(
        {
          ...item,
          work_item: {
            ...item.work_item,
            state: { ...item.work_item.state, phase: "execute" },
          },
        },
        [appliedExecute],
      ),
    ).toMatchObject({ mode: "hidden" });
    expect(
      reviewHandoffForItem({ ...item, source_id: "inbox" }, [appliedExecute]),
    ).toMatchObject({ mode: "hidden" });
    expect(missionHandoffModeForItem(item)).toBe("hidden");

    const appliedPatch = {
      evidence: {
        ...appliedExecute.evidence,
        phase: "patch" as const,
        identity: {
          ...appliedExecute.evidence.identity,
          patch_cycle: 1,
        },
      },
    };
    const reReviewItem = {
      ...item,
      work_item: {
        ...item.work_item,
        state: { ...item.work_item.state, patch_cycle: 1 },
      },
    };
    expect(reviewHandoffForItem(reReviewItem, [appliedPatch])).toMatchObject({
      mode: "active",
      can_compile: true,
      can_import: true,
    });
    expect(
      reviewHandoffForItem(reReviewItem, [
        {
          evidence: {
            ...appliedPatch.evidence,
            identity: { ...appliedPatch.evidence.identity, patch_cycle: 2 },
          },
        },
      ]),
    ).toMatchObject({ mode: "hidden" });
    expect(
      reviewHandoffForItem(reReviewItem, [appliedPatch, appliedPatch]),
    ).toMatchObject({ mode: "hidden" });
  });

  it("exposes one evidence-bound patch or attention action and hides stale projections", () => {
    const missionContentSha256 = "a".repeat(64);
    const resultContentSha256 = "b".repeat(64);
    const gitCommit = "c".repeat(40);
    const evidencePath = `.founder/run-evidence/${workItemId}/review-3-2-1/${"d".repeat(64)}`;
    const attention = {
      kind: "patch_plan_approval" as const,
      question: "Approve one patch that addresses these exact findings?",
      recommendation: "Approve the bounded patch plan.",
      created_at: "2026-07-25T12:00:00.000Z",
      governed_tuple: {
        goal_version: 3,
        input_revision: 2,
        attempt: 1,
        patch_cycle: 0,
      },
      pins: {
        artifact_paths: [
          `.founder/missions/${workItemId}/review-3-2-1/mission.json`,
          `.founder/missions/${workItemId}/review-3-2-1/result.json`,
        ] as [string, ...string[]],
        evidence_paths: [evidencePath],
        git_commit: gitCommit,
        mission_content_sha256: missionContentSha256,
        result_content_sha256: resultContentSha256,
      },
    };
    const item = {
      source_id: "ws_product",
      work_item: {
        goal: {
          work_item_id: workItemId,
          goal_contract: { goal_version: 3 },
        },
        state: {
          phase: "review" as const,
          status: "active" as const,
          goal_version: 3,
          input_revision: 2,
          attempt: 1,
          patch_cycle: 0,
          attention,
        },
      },
    };
    const appliedReview = {
      evidence: {
        phase: "review" as const,
        outcome: "applied" as const,
        mission_content_sha256: missionContentSha256,
        result_content_sha256: resultContentSha256,
        result_commit: gitCommit,
        identity: {
          work_item_id: workItemId,
          goal_version: 3,
          input_revision: 2,
          attempt: 1,
        },
      },
      summary: { evidence_path: evidencePath },
      submission: {
        review_mission_content_sha256: missionContentSha256,
        accepted_result_commit: gitCommit,
        verdict: "findings" as const,
      },
    };

    expect(patchAttentionForItem(item, [appliedReview])).toMatchObject({
      mode: "patch_plan",
      action: "accept_patch_plan",
      patch_cycle: 0,
    });
    expect(
      patchAttentionForItem(
        {
          ...item,
          work_item: {
            ...item.work_item,
            state: {
              ...item.work_item.state,
              attention: { ...attention, kind: "unresolved_finding" },
            },
          },
        },
        [appliedReview],
      ),
    ).toMatchObject({ mode: "escalation", action: "resolve_escalation" });
    expect(
      patchAttentionForItem(
        {
          ...item,
          work_item: {
            ...item.work_item,
            state: {
              ...item.work_item.state,
              attention: { ...attention, kind: "review_ready" },
            },
          },
        },
        [
          {
            ...appliedReview,
            submission: { ...appliedReview.submission, verdict: "clean" },
          },
        ],
      ),
    ).toMatchObject({ mode: "review_ready", action: "review_result" });
    expect(
      patchAttentionForItem(
        {
          ...item,
          work_item: {
            ...item.work_item,
            state: {
              ...item.work_item.state,
              attention: {
                ...attention,
                governed_tuple: {
                  ...attention.governed_tuple,
                  input_revision: 1,
                },
              },
            },
          },
        },
        [appliedReview],
      ),
    ).toMatchObject({ mode: "hidden", action: null });
    expect(
      patchAttentionForItem(item, [appliedReview, appliedReview]),
    ).toMatchObject({ mode: "hidden", action: null });
    expect(
      patchAttentionForItem({ ...item, source_id: "inbox" }, [appliedReview]),
    ).toMatchObject({ mode: "hidden", action: null });
    expect(
      patchAttentionForItem(
        {
          ...item,
          work_item: {
            ...item.work_item,
            goal: { work_item_id: workItemId },
          },
        },
        [appliedReview],
      ),
    ).toMatchObject({ mode: "hidden", action: null });
    expect(
      patchAttentionForItem(
        {
          ...item,
          work_item: {
            ...item.work_item,
            state: { ...item.work_item.state, status: "blocked" },
          },
        },
        [appliedReview],
      ),
    ).toMatchObject({ mode: "hidden", action: null });
  });

  it("shows active patch handoff only for one exact prompting review lineage", () => {
    const executeMissionContentSha256 = "a".repeat(64);
    const executeResultContentSha256 = "b".repeat(64);
    const reviewMissionContentSha256 = "c".repeat(64);
    const execute = {
      evidence: {
        phase: "execute" as const,
        outcome: "applied" as const,
        mission_content_sha256: executeMissionContentSha256,
        result_content_sha256: executeResultContentSha256,
        identity: {
          work_item_id: workItemId,
          goal_version: 3,
          input_revision: 2,
          attempt: 1,
        },
      },
    };
    const review = {
      evidence: {
        phase: "review" as const,
        outcome: "applied" as const,
        mission_content_sha256: reviewMissionContentSha256,
        result_content_sha256: "d".repeat(64),
        result_commit: "e".repeat(40),
        identity: { ...execute.evidence.identity },
      },
      submission: {
        review_mission_content_sha256: reviewMissionContentSha256,
        accepted_result_commit: "e".repeat(40),
        verdict: "findings" as const,
        execute_mission_content_sha256: executeMissionContentSha256,
        execute_result_content_sha256: executeResultContentSha256,
      },
    };
    const item = {
      source_id: "ws_product",
      work_item: {
        goal: {
          work_item_id: workItemId,
          goal_contract: { goal_version: 3 },
        },
        state: {
          phase: "patch" as const,
          status: "active" as const,
          goal_version: 3,
          input_revision: 2,
          attempt: 1,
          patch_cycle: 1,
        },
      },
    };

    expect(patchAttentionForItem(item, [execute, review])).toEqual({
      mode: "patch_active",
      action: "compile_or_import_patch",
      attention: null,
      patch_cycle: 1,
    });
    expect(
      patchAttentionForItem(item, [execute, review, review]),
    ).toMatchObject({ mode: "hidden" });
    expect(
      patchAttentionForItem(item, [
        execute,
        {
          ...review,
          submission: {
            ...review.submission,
            execute_result_content_sha256: "f".repeat(64),
          },
        },
      ]),
    ).toMatchObject({ mode: "hidden" });
  });

  it("derives only valid forward and backward board transition actions", () => {
    const phases = [
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

    for (const phase of phases) {
      const actions = boardTransitionActionsForPhase(phase);
      const sourceIndex = BOARD_COLUMNS.findIndex(
        (column) => column.id === boardColumnForPhase(phase).id,
      );

      for (const action of [actions.forward, actions.back]) {
        if (action === null) {
          continue;
        }

        const targetIndex = BOARD_COLUMNS.findIndex(
          (column) => column.id === action.target_column_id,
        );
        expect(resolveBoardDrop(phase, action.target_column_id)).toEqual({
          ok: true,
          changed: true,
          target_phase: action.target_phase,
        });
        expect(action.label).toBe(
          `Move to ${BOARD_COLUMNS[targetIndex].label}`,
        );
        expect(targetIndex).not.toBe(sourceIndex);
      }

      expect(actions.forward === null || actions.back === null).toBe(
        phase === "idea" ||
          phase === "brainstorm" ||
          phase === "patch" ||
          phase === "learn",
      );
    }

    expect(boardTransitionActionsForPhase("idea")).toMatchObject({
      forward: { target_column_id: "spec", target_phase: "spec" },
      back: null,
    });
    expect(boardTransitionActionsForPhase("brainstorm")).toMatchObject({
      forward: { target_column_id: "spec", target_phase: "spec" },
      back: null,
    });
    expect(boardTransitionActionsForPhase("spec")).toMatchObject({
      forward: { target_column_id: "plan", target_phase: "plan" },
      back: { target_column_id: "todo", target_phase: "brainstorm" },
    });
    expect(boardTransitionActionsForPhase("test")).toMatchObject({
      forward: { target_column_id: "ship", target_phase: "ship" },
      back: { target_column_id: "execute", target_phase: "execute" },
    });
    expect(boardTransitionActionsForPhase("learn")).toMatchObject({
      forward: null,
      back: { target_column_id: "ship", target_phase: "ship" },
    });
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

  it("supports all, single-project, multi-project, and unassigned filters", () => {
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
          project_source_ids: ["ws_one", "ws_two"],
          include_unassigned: false,
        }),
      ),
    ).toEqual([project, anotherProject]);
    expect(
      [project, anotherProject, unassigned].filter((source) =>
        isBoardSourceVisible(source, {
          project_source_ids: [],
          include_unassigned: true,
        }),
      ),
    ).toEqual([unassigned]);
  });

  it("reveals and selects confirmed mutations without changing scroll context", () => {
    const view = {
      version: 1 as const,
      project_source_ids: ["ws_one"],
      include_unassigned: false,
      selected_item: null,
      scroll: { x: 640, y: 120 },
    };

    expect(
      revealBoardItem(view, {
        source_id: "ws_two",
        work_item_id: workItemId,
        project: { name: "Two" },
      }),
    ).toEqual({
      ...view,
      project_source_ids: ["ws_one", "ws_two"],
      selected_item: { source_id: "ws_two", work_item_id: workItemId },
    });
    expect(
      revealBoardItem(view, {
        source_id: "inbox",
        work_item_id: workItemId,
        project: null,
      }),
    ).toEqual({
      ...view,
      include_unassigned: true,
      selected_item: { source_id: "inbox", work_item_id: workItemId },
    });
  });
});
