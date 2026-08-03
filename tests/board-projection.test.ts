import { describe, expect, it } from "vitest";

import {
  BOARD_COLUMNS,
  PREVIEW_CHECKLIST_MAX_ENTRIES,
  PREVIEW_LIST_ITEM_MAX_CHARS,
  PREVIEW_LIST_MAX_ITEMS,
  PREVIEW_PROSE_MAX_CHARS,
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
  previewShapingChecklist,
  previewShapingList,
  previewShapingText,
  reviewHandoffForItem,
  revealBoardItem,
  resolveBoardDrop,
  shapingHandoffForItem,
  targetPhaseForColumn,
  validatePhaseTransition,
  type ShapingRunProjectionInput,
  type ShapingSurfaceContext,
} from "../src/presentation/board";
import type { GoalContract, WorkItemPhase } from "../src/domain/work-item";
import type {
  BrainstormResultSubmission,
  PlanResultSubmission,
  ShapingPhase,
  SpecResultSubmission,
} from "../src/domain/shaping";
import type { ShapingModelPickerOption } from "../src/domain/portfolio-preferences";

const workItemId = "wi_550e8400-e29b-41d4-a716-446655440000";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);

const brainstormResult: BrainstormResultSubmission = {
  result_schema_version: 1,
  brainstorm_mission_content_sha256: SHA_A,
  identity: {
    phase: "brainstorm",
    work_item_id: workItemId,
    input_sha256: SHA_B,
  },
  problem_statement: "Founders need one guided shaping path.",
  approach: "Carry one exact result into the next seat.",
  non_goals: ["Do not launch Execute."],
  open_questions: ["Which model should run Spec?"],
};

const specResult: SpecResultSubmission = {
  result_schema_version: 1,
  spec_mission_content_sha256: SHA_A,
  identity: {
    phase: "spec",
    work_item_id: workItemId,
    input_sha256: SHA_B,
  },
  proposal: {
    purpose: "Guide one result through three shaping seats.",
    acceptance_criteria: ["Each seat exposes one exact decision."],
    non_goals: ["Do not approve Execute."],
    allowed_scope: ["src/presentation"],
    review_ready: ["Projection checks pass."],
  },
};

const planResult: PlanResultSubmission = {
  result_schema_version: 1,
  plan_mission_content_sha256: SHA_A,
  identity: {
    phase: "plan",
    work_item_id: workItemId,
    input_sha256: SHA_B,
  },
  summary: "Implement the guided decision surfaces in bounded steps.",
  checklist: [
    {
      id: "1",
      step: "Project each phase distinctly.",
      verification_check: "Run the board projection suite.",
    },
  ],
  relevant_skills: ["frontend-design"],
  product_doc_impacts: ["PRODUCT.md"],
  todo_impacts: [],
  open_questions: ["When should Execute be opened?"],
};

const goalContract: GoalContract = {
  schema_version: 1,
  goal_version: 1,
  purpose: specResult.proposal.purpose,
  acceptance_criteria: [...specResult.proposal.acceptance_criteria],
  non_goals: [...specResult.proposal.non_goals],
  allowed_scope: [...specResult.proposal.allowed_scope],
  review_ready: [...specResult.proposal.review_ready],
};

function modelOption(
  modelId: string,
  overrides: Partial<ShapingModelPickerOption> = {},
): ShapingModelPickerOption {
  return {
    model_id: modelId,
    used_by_seats: [],
    saved_preference: false,
    recommended: false,
    preselected: false,
    reuse_warning: null,
    ...overrides,
  };
}

type SurfaceContextOverrides = Omit<
  Partial<ShapingSurfaceContext>,
  "models"
> & {
  models?: Partial<ShapingSurfaceContext["models"]>;
};

function surfaceContext(
  overrides: SurfaceContextOverrides = {},
): ShapingSurfaceContext {
  const { models: modelOverrides, ...contextOverrides } = overrides;
  const models: ShapingSurfaceContext["models"] = {
    status: "available",
    reason: null,
    available_model_ids: ["model-a", "model-b", "model-c"],
    model_use: [
      {
        seat: "brainstorm",
        production_id: "prod-brainstorm",
        shaping_run_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1",
        requested_model: "model-a",
        effective_model: "model-a",
      },
    ],
    model_picker_options: {
      brainstorm: [
        modelOption("model-a", { recommended: true, preselected: true }),
        modelOption("model-b"),
        modelOption("model-c"),
      ],
      spec: [
        modelOption("model-b", { recommended: true, preselected: true }),
        modelOption("model-c"),
        modelOption("model-a", {
          used_by_seats: ["brainstorm"],
          reuse_warning:
            "model-a was already used by brainstorm; reuse is allowed, but an unused model improves seat independence.",
        }),
      ],
      plan: [
        modelOption("model-c", { recommended: true, preselected: true }),
        modelOption("model-a", {
          used_by_seats: ["brainstorm"],
          reuse_warning:
            "model-a was already used by brainstorm; reuse is allowed, but an unused model improves seat independence.",
        }),
        modelOption("model-b"),
      ],
    },
  };
  return {
    expected_shaping_state_sha256: SHA_C,
    revision: {
      mission_content_sha256: SHA_A,
      result: { status: "none" },
    },
    run: null,
    models: { ...models, ...modelOverrides },
    refresh: {
      last_checked_at: "2026-08-03T12:00:00.000Z",
      refreshing: false,
      stale: false,
      refresh_failure: null,
    },
    derived_goal_contract_sha256: SHA_D,
    current_goal_contract_sha256: SHA_D,
    post_commit_launch_failure: null,
    manual_recovery: null,
    ...contextOverrides,
  };
}

function itemFor(
  phase: WorkItemPhase,
  contract?: GoalContract,
) {
  return {
    source_id: "ws_product",
    work_item: {
      goal: contract === undefined ? {} : { goal_contract: contract },
      state: { phase, status: "active" as const },
    },
  };
}

function runFor(
  status: ShapingRunProjectionInput["status"],
  terminalOutcome: ShapingRunProjectionInput["terminal_outcome"] = null,
  overrides: Partial<ShapingRunProjectionInput> = {},
): ShapingRunProjectionInput {
  return {
    shaping_run_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1",
    status,
    terminal_outcome: terminalOutcome,
    latest_update: "Inspecting the bounded mission.",
    sanitized_reason: "The result failed validation.",
    denied_operation_kind: "url",
    timeout_limit: "The 900 second wall-clock limit",
    ...overrides,
  };
}

function appliedContext(
  phase: ShapingPhase,
  result: BrainstormResultSubmission | SpecResultSubmission | PlanResultSubmission,
  overrides: SurfaceContextOverrides = {},
): ShapingSurfaceContext {
  return surfaceContext({
    revision: {
      mission_content_sha256: SHA_A,
      result: {
        status: "applied",
        result_content_sha256: SHA_B,
        result,
      },
      ...(phase === "plan"
        ? {
            plan_goal_contract_sha256: SHA_D,
            plan_goal_version: 1,
          }
        : {}),
    },
    ...overrides,
  });
}

function countObjectKeys(value: unknown, key: string): number {
  if (Array.isArray(value)) {
    return value.reduce(
      (total, entry) => total + countObjectKeys(entry, key),
      0,
    );
  }
  if (value === null || typeof value !== "object") {
    return 0;
  }
  return Object.entries(value).reduce(
    (total, [entryKey, entryValue]) =>
      total + Number(entryKey === key) + countObjectKeys(entryValue, key),
    0,
  );
}

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
    expect(validatePhaseTransition("idea", "brainstorm")).toEqual({ ok: true });
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

  it("projects shaping independently from contracts and panel mode", () => {
    const brainstorm = {
      source_id: "ws_product",
      work_item: {
        goal: {
          capture: {
            kind: "idea" as const,
            original_title: "Shape this idea",
            captured_at: "2026-07-29T00:00:00.000Z",
          },
        },
        state: {
          phase: "brainstorm" as const,
          status: "active" as const,
        },
      },
    };

    expect(detailPanelModeForItem(brainstorm)).toBe("capture");
    expect(shapingHandoffForItem(brainstorm)).toEqual({
      mode: "active",
      phase: "brainstorm",
      required_input: "none",
      can_compile: true,
      can_import: true,
    });
    expect(
      shapingHandoffForItem({
        ...brainstorm,
        work_item: {
          ...brainstorm.work_item,
          state: { phase: "spec", status: "active" },
        },
      }),
    ).toEqual({
      mode: "active",
      phase: "spec",
      required_input: "brainstorm_acceptance_sha256",
      can_compile: true,
      can_import: true,
    });
  });

  it.each(["execute"] as const)(
    "hides shaping for the %s phase",
    (phase) => {
      expect(
        shapingHandoffForItem({
          source_id: "ws_product",
          work_item: { state: { phase, status: "active" } },
        }),
      ).toMatchObject({ mode: "hidden", required_input: null });
    },
  );

  it("keeps context-free Plan hidden until the decision-first caller supplies context", () => {
    const projection = shapingHandoffForItem(itemFor("plan", goalContract));

    expect(projection).toEqual({
      mode: "hidden",
      phase: null,
      required_input: null,
      can_compile: false,
      can_import: false,
    });
    expect(JSON.stringify(projection)).not.toContain("Execute");
  });

  it("hides unavailable shaping and exposes only the explicit on-ramp", () => {
    const brainstorm = {
      source_id: "ws_product",
      work_item: {
        state: {
          phase: "brainstorm" as const,
          status: "active" as const,
        },
      },
    };
    expect(
      shapingHandoffForItem({ ...brainstorm, source_id: "inbox" }),
    ).toMatchObject({ mode: "hidden" });
    expect(
      shapingHandoffForItem({
        ...brainstorm,
        work_item: {
          state: { phase: "brainstorm", status: "paused" },
        },
      }),
    ).toMatchObject({ mode: "hidden" });
    expect(
      shapingHandoffForItem({
        ...brainstorm,
        work_item: {
          state: { phase: "spec", status: "blocked" },
        },
      }),
    ).toMatchObject({ mode: "hidden" });

  });

  it("projects the Idea on-ramp with an always-available manual counterpart", () => {
    const available = shapingHandoffForItem(
      itemFor("idea"),
      surfaceContext({ revision: null }),
    );
    expect(available).toMatchObject({
      mode: "idea",
      phase: "idea",
      headline: "Start Brainstorm",
      expected_shaping_state_sha256: SHA_C,
    });
    if (available.mode !== "idea") {
      throw new Error("expected an Idea projection");
    }
    expect(available).toHaveProperty("model_picker");
    expect(available.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Start Brainstorm",
          launch_mode: "connected",
          primary: true,
        }),
        expect.objectContaining({
          label: "Start Brainstorm without a model",
          launch_mode: "manual",
          primary: false,
        }),
      ]),
    );

    const unavailable = shapingHandoffForItem(
      itemFor("idea"),
      surfaceContext({
        revision: null,
        models: {
          status: "unavailable",
          reason: "runtime unavailable",
          available_model_ids: [],
          model_picker_options: { brainstorm: [], spec: [], plan: [] },
        },
      }),
    );
    expect(unavailable).not.toHaveProperty("model_picker");
    expect(unavailable).toMatchObject({
      mode: "idea",
      runtime_unavailable: "runtime unavailable",
    });
    if (unavailable.mode !== "idea") {
      throw new Error("expected an unavailable Idea projection");
    }
    expect(
      unavailable.actions.find(
        (action) => action.label === "Start Brainstorm without a model",
      ),
    ).toMatchObject({ primary: true, enabled: true });
    expect(
      unavailable.actions.find(
        (action) => action.label === "Start Brainstorm",
      ),
    ).toMatchObject({ primary: false, enabled: false });
  });

  it("projects each ready phase from only the fields its result supplies", () => {
    const brainstorm = shapingHandoffForItem(
      itemFor("brainstorm"),
      appliedContext("brainstorm", brainstormResult),
    );
    if (brainstorm.mode !== "ready" || brainstorm.phase !== "brainstorm") {
      throw new Error("expected a ready Brainstorm projection");
    }
    expect(brainstorm.lifecycle).toMatchObject({
      card_label: "Brainstorm · Ready",
      headline: "Brainstorm result ready",
      refresh_running: false,
    });
    expect(brainstorm.sections.summary.problem_statement.full).toBe(
      brainstormResult.problem_statement,
    );
    expect(brainstorm.sections).not.toHaveProperty("criteria");
    expect(brainstorm.sections).not.toHaveProperty("governed_fields");
    expect(brainstorm.sections).toHaveProperty("unresolved_questions");
    expect(brainstorm.sections.next_step?.seat).toBe("spec");
    expect(brainstorm.bindings).toEqual({
      expected_mission_content_sha256: SHA_A,
      expected_result_content_sha256: SHA_B,
      expected_shaping_state_sha256: SHA_C,
    });
    expect(brainstorm.actions.map(({ label }) => label)).toEqual(
      expect.arrayContaining([
        "Use result & run Spec",
        "Use result & prepare Spec",
        "Request changes",
      ]),
    );

    const spec = shapingHandoffForItem(
      itemFor("spec"),
      appliedContext("spec", specResult),
    );
    if (spec.mode !== "ready" || spec.phase !== "spec") {
      throw new Error("expected a ready Spec projection");
    }
    expect(spec.lifecycle.headline).toBe("Spec ready for approval");
    expect(spec.sections).not.toHaveProperty("unresolved_questions");
    expect(spec.sections.summary.purpose.full).toBe(specResult.proposal.purpose);
    expect(spec.sections.criteria.full).toEqual(
      specResult.proposal.acceptance_criteria,
    );
    expect(spec.sections.governed_fields).toMatchObject({
      non_goals: { full: specResult.proposal.non_goals },
      allowed_scope: { full: specResult.proposal.allowed_scope },
      review_ready: { full: specResult.proposal.review_ready },
    });
    expect(spec.governed_contract).toEqual(
      expect.objectContaining({
        contract: goalContract,
        goal_contract_sha256: SHA_D,
      }),
    );
    expect(spec.bindings.goal_contract_sha256).toBe(SHA_D);
    expect(spec.sections.next_step?.seat).toBe("plan");
    expect(spec.actions.map(({ label }) => label)).toEqual(
      expect.arrayContaining([
        "Approve & run Plan",
        "Approve & prepare Plan",
        "Request changes",
      ]),
    );
    expect(Object.keys(spec.sections).sort()).toEqual([
      "criteria",
      "governed_fields",
      "next_step",
      "provenance",
      "summary",
    ]);
    expect(Object.keys(spec.sections.governed_fields).sort()).toEqual([
      "allowed_scope",
      "non_goals",
      "pointer",
      "review_ready",
    ]);

    const plan = shapingHandoffForItem(
      itemFor("plan", goalContract),
      appliedContext("plan", planResult),
    );
    if (plan.mode !== "ready" || plan.phase !== "plan") {
      throw new Error("expected a ready Plan projection");
    }
    expect(plan.lifecycle.headline).toBe("Plan result ready");
    expect(plan.sections).not.toHaveProperty("governed_fields");
    expect(plan.sections).not.toHaveProperty("next_step");
    expect(plan.sections).toHaveProperty("checklist");
    expect(plan.execute_approval_available).toBe(false);
    expect(plan.execute_approval_message).toBe(
      "Execute approval is not available in this slice",
    );
    expect(plan.actions.map(({ label }) => label)).toEqual([
      "Request changes",
    ]);
    expect(JSON.stringify(plan)).not.toContain("Execute the plan");
  });

  it.each([
    {
      phase: "brainstorm" as const,
      item: itemFor("brainstorm"),
      result: brainstormResult,
    },
    {
      phase: "spec" as const,
      item: itemFor("spec"),
      result: specResult,
    },
    {
      phase: "plan" as const,
      item: itemFor("plan", goalContract),
      result: planResult,
    },
  ])(
    "projects exactly one applied $phase result with no comparison affordance",
    ({ phase, item, result }) => {
      const projection = shapingHandoffForItem(
        item,
        appliedContext(phase, result, {
          run: runFor("terminal", "failed"),
        }),
      );

      expect(projection.mode).toBe("ready");
      if (projection.mode !== "ready") {
        throw new Error(`expected a ready ${phase} projection`);
      }
      expect(projection.result).toBe(result);
      expect(countObjectKeys(projection, "result")).toBe(1);
      expect(JSON.stringify(projection)).not.toMatch(
        /comparison|candidate|Run another model/i,
      );
      expect(
        projection.actions.some(
          ({ kind, label }) =>
            kind === "retry_launch" || label.startsWith("Retry "),
        ),
      ).toBe(false);
      expect(
        projection.lifecycle.actions.some(
          ({ kind, label }) =>
            kind === "retry_launch" || label.startsWith("Retry "),
        ),
      ).toBe(false);
    },
  );

  it("promotes exactly one manual primary only when runtime or models are unavailable", () => {
    const modelCases = [
      {
        name: "available",
        models: {} satisfies SurfaceContextOverrides["models"],
        connectedPrimary: true,
        pickerAvailable: true,
      },
      {
        name: "runtime unavailable",
        models: {
          status: "unavailable" as const,
          reason: "runtime unavailable",
          available_model_ids: [],
          model_picker_options: { brainstorm: [], spec: [], plan: [] },
        },
        connectedPrimary: false,
        pickerAvailable: false,
      },
      {
        name: "available runtime with an empty model list",
        models: {
          status: "available" as const,
          reason: null,
          available_model_ids: [],
          model_picker_options: { brainstorm: [], spec: [], plan: [] },
        },
        connectedPrimary: false,
        pickerAvailable: false,
      },
    ];

    function expectPrimaryPair(
      actions: Array<{
        label: string;
        primary: boolean;
        enabled: boolean;
      }>,
      connectedLabel: string,
      manualLabel: string,
      connectedPrimary: boolean,
      caseName: string,
    ) {
      expect(
        actions.filter(({ primary }) => primary),
        `${caseName}: exactly one primary action`,
      ).toHaveLength(1);
      expect(
        actions.find(({ label }) => label === connectedLabel),
        `${caseName}: connected action`,
      ).toMatchObject({
        primary: connectedPrimary,
        enabled: connectedPrimary,
      });
      expect(
        actions.find(({ label }) => label === manualLabel),
        `${caseName}: manual action`,
      ).toMatchObject({
        primary: !connectedPrimary,
        enabled: true,
      });
    }

    for (const modelCase of modelCases) {
      const idea = shapingHandoffForItem(
        itemFor("idea"),
        surfaceContext({ revision: null, models: modelCase.models }),
      );
      if (idea.mode !== "idea") {
        throw new Error(`expected an Idea projection for ${modelCase.name}`);
      }
      expectPrimaryPair(
        idea.actions,
        "Start Brainstorm",
        "Start Brainstorm without a model",
        modelCase.connectedPrimary,
        `${modelCase.name}: Idea`,
      );
      expect("model_picker" in idea, `${modelCase.name}: Idea picker`).toBe(
        modelCase.pickerAvailable,
      );

      for (const [phase, result, connectedLabel, manualLabel] of [
        [
          "brainstorm",
          brainstormResult,
          "Use result & run Spec",
          "Use result & prepare Spec",
        ],
        [
          "spec",
          specResult,
          "Approve & run Plan",
          "Approve & prepare Plan",
        ],
      ] as const) {
        const ready = shapingHandoffForItem(
          itemFor(phase),
          appliedContext(phase, result, { models: modelCase.models }),
        );
        if (ready.mode !== "ready" || ready.phase !== phase) {
          throw new Error(
            `expected a ready ${phase} projection for ${modelCase.name}`,
          );
        }
        expectPrimaryPair(
          ready.actions,
          connectedLabel,
          manualLabel,
          modelCase.connectedPrimary,
          `${modelCase.name}: ${phase} decision`,
        );
        expectPrimaryPair(
          ready.request_changes.actions,
          "Request changes & rerun",
          "Request changes & prepare rerun",
          modelCase.connectedPrimary,
          `${modelCase.name}: ${phase} request changes`,
        );
        expect(
          "next_step" in ready.sections,
          `${modelCase.name}: ${phase} next picker`,
        ).toBe(modelCase.pickerAvailable);
        expect(
          "model_picker" in ready.request_changes,
          `${modelCase.name}: ${phase} request changes picker`,
        ).toBe(modelCase.pickerAvailable);
      }

      const plan = shapingHandoffForItem(
        itemFor("plan", goalContract),
        appliedContext("plan", planResult, { models: modelCase.models }),
      );
      if (plan.mode !== "ready" || plan.phase !== "plan") {
        throw new Error(`expected a ready Plan projection for ${modelCase.name}`);
      }
      expectPrimaryPair(
        plan.request_changes.actions,
        "Request changes & rerun",
        "Request changes & prepare rerun",
        modelCase.connectedPrimary,
        `${modelCase.name}: Plan request changes`,
      );

      const superseded = shapingHandoffForItem(
        itemFor("plan", goalContract),
        appliedContext("plan", planResult, {
          models: modelCase.models,
          current_goal_contract_sha256: "e".repeat(64),
        }),
      );
      if (superseded.mode !== "plan_result_superseded") {
        throw new Error(
          `expected a superseded Plan projection for ${modelCase.name}`,
        );
      }
      expectPrimaryPair(
        superseded.actions,
        "Replan with updated contract",
        "Replan & prepare Plan",
        modelCase.connectedPrimary,
        `${modelCase.name}: superseded Plan`,
      );
      expectPrimaryPair(
        superseded.request_changes.actions,
        "Request changes & rerun",
        "Request changes & prepare rerun",
        modelCase.connectedPrimary,
        `${modelCase.name}: superseded Plan request changes`,
      );
      expect(
        "model_picker" in superseded,
        `${modelCase.name}: superseded Plan picker`,
      ).toBe(modelCase.pickerAvailable);
    }
  });

  it("treats a resultless current revision as pre-ready and never invents comparisons", () => {
    const projection = shapingHandoffForItem(
      itemFor("spec"),
      surfaceContext({
        revision: {
          mission_content_sha256: SHA_D,
          result: { status: "none" },
        },
      }),
    );
    expect(projection).toMatchObject({
      mode: "pre_ready",
      phase: "spec",
      mission_content_sha256: SHA_D,
      headline: "Start Spec",
    });
    expect(projection).not.toHaveProperty("result");
    expect(JSON.stringify(projection)).not.toContain("candidate");
    expect(JSON.stringify(projection)).not.toContain("Run another model");
  });

  it.each([
    {
      name: "contract hash",
      item: itemFor("plan", goalContract),
      context: appliedContext("plan", planResult, {
        current_goal_contract_sha256: "e".repeat(64),
      }),
    },
    {
      name: "goal version",
      item: itemFor("plan", { ...goalContract, goal_version: 2 }),
      context: appliedContext("plan", planResult),
    },
  ])("projects a superseded Plan result when the $name changes", ({ item, context }) => {
    const projection = shapingHandoffForItem(item, context);
    expect(projection).toMatchObject({
      mode: "plan_result_superseded",
      reason: "The governed contract changed after this plan was produced.",
    });
    if (projection.mode !== "plan_result_superseded") {
      throw new Error("expected a superseded Plan projection");
    }
    expect(projection.actions).toEqual([
      {
        kind: "replan_with_updated_contract",
        label: "Replan with updated contract",
        launch_mode: "connected",
        primary: true,
        enabled: true,
      },
      {
        kind: "request_changes",
        label: "Request changes",
        launch_mode: null,
        primary: false,
        enabled: true,
      },
      {
        kind: "replan_with_updated_contract",
        label: "Replan & prepare Plan",
        launch_mode: "manual",
        primary: false,
        enabled: true,
      },
    ]);
    expect(
      projection.actions.some(({ kind }) =>
        ["approve_spec", "launch_phase", "retry_launch"].includes(kind),
      ),
    ).toBe(false);
    expect(projection).not.toHaveProperty("execute_approval_available", true);
  });

  it("projects every lifecycle row with its exact refresh and action contract", () => {
    const rows = [
      {
        name: "starting",
        context: surfaceContext({ run: runFor("starting") }),
        mode: "run_state",
        state: "starting",
        card: "Brainstorm · Active",
        headline: "Brainstorm starting",
        copy: "The agent is being launched.",
        refresh: true,
        actions: ["Cancel"],
      },
      {
        name: "running",
        context: surfaceContext({ run: runFor("running") }),
        mode: "run_state",
        state: "running",
        card: "Brainstorm · Active",
        headline: "Brainstorm running",
        copy: "Inspecting the bounded mission.",
        refresh: true,
        actions: ["Cancel"],
      },
      {
        name: "blocked",
        context: surfaceContext({
          run: runFor("terminal", "missing_permission"),
        }),
        mode: "terminal_run_failure",
        state: "blocked",
        card: "Brainstorm · Blocked",
        headline: "Brainstorm blocked",
        copy:
          "The agent requested an operation outside this run's write policy. Operation: url.",
        refresh: false,
        actions: ["Retry Brainstorm"],
      },
      {
        name: "failed",
        context: surfaceContext({ run: runFor("terminal", "failed") }),
        mode: "terminal_run_failure",
        state: "failed",
        card: "Brainstorm · Failed",
        headline: "Brainstorm failed",
        copy: "The result failed validation.",
        refresh: false,
        actions: ["Retry Brainstorm", "Prepare manual recovery"],
      },
      {
        name: "timed out",
        context: surfaceContext({ run: runFor("terminal", "timed_out") }),
        mode: "terminal_run_failure",
        state: "timed_out",
        card: "Brainstorm · Failed",
        headline: "Brainstorm timed out",
        copy: "The 900 second wall-clock limit was reached.",
        refresh: false,
        actions: ["Retry Brainstorm"],
      },
      {
        name: "cancelled",
        context: surfaceContext({ run: runFor("terminal", "cancelled") }),
        mode: "terminal_run_failure",
        state: "cancelled",
        card: "Brainstorm · Failed",
        headline: "Brainstorm cancelled",
        copy: "You cancelled this run.",
        refresh: false,
        actions: ["Retry Brainstorm"],
      },
      {
        name: "interrupted",
        context: surfaceContext({ run: runFor("terminal", "interrupted") }),
        mode: "terminal_run_failure",
        state: "interrupted",
        card: "Brainstorm · Failed",
        headline: "Brainstorm interrupted",
        copy:
          "The agent process was no longer running when Product Studio recovered this run.",
        refresh: false,
        actions: ["Retry Brainstorm"],
      },
      {
        name: "ready",
        context: appliedContext("brainstorm", brainstormResult),
        mode: "ready",
        state: "ready",
        card: "Brainstorm · Ready",
        headline: "Brainstorm result ready",
        copy: "Choose the exact result to carry into Spec.",
        refresh: false,
        actions: [
          "Request changes",
          "Use result & run Spec",
          "Use result & prepare Spec",
        ],
      },
      {
        name: "missing result",
        context: surfaceContext({ run: runFor("terminal", "completed") }),
        mode: "terminal_run_failure",
        state: "missing_result",
        card: "Brainstorm · Failed",
        headline: "Brainstorm finished without a usable result",
        copy: "The run reported success but published no valid result bundle.",
        refresh: false,
        actions: ["Retry Brainstorm"],
      },
      {
        name: "finishing",
        context: appliedContext("brainstorm", brainstormResult, {
          run: runFor("running"),
        }),
        mode: "run_state",
        state: "finishing",
        card: "Brainstorm · Active",
        headline: "Brainstorm finishing",
        copy: "Recovering this run's result.",
        refresh: true,
        actions: [],
      },
      {
        name: "needs repair",
        context: surfaceContext({
          revision: {
            mission_content_sha256: SHA_A,
            result: {
              status: "repair",
              failing_component: "production receipt",
            },
          },
        }),
        mode: "repair",
        state: "needs_repair",
        card: "Brainstorm · Needs repair",
        headline: "Brainstorm result needs repair",
        copy: "The applied marker disagrees with production receipt.",
        refresh: false,
        actions: ["Advanced recovery"],
      },
    ] as const;

    for (const row of rows) {
      const projection = shapingHandoffForItem(
        itemFor("brainstorm"),
        row.context,
      );
      expect(projection.mode, row.name).toBe(row.mode);
      if (!("lifecycle" in projection) || projection.lifecycle === null) {
        throw new Error(`${row.name} must carry a lifecycle projection`);
      }
      expect(projection.lifecycle, row.name).toMatchObject({
        state: row.state,
        card_label: row.card,
        headline: row.headline,
        copy: row.copy,
        refresh_running: row.refresh,
      });
      expect(
        projection.lifecycle.actions.map(({ label }) => label),
        row.name,
      ).toEqual([...row.actions]);
      if (projection.mode === "terminal_run_failure") {
        expect(projection.model_picker, `${row.name}: terminal picker`).toMatchObject({
          seat: "brainstorm",
          selected_model: "model-a",
        });
        expect(
          projection.lifecycle.actions.some(({ label }) =>
            label.startsWith("Retry "),
          ),
          `${row.name}: retry action`,
        ).toBe(true);
      }
      if (row.state === "finishing" || row.state === "needs_repair") {
        expect(JSON.stringify(projection), row.name).not.toContain("Retry");
        expect(JSON.stringify(projection), row.name).not.toContain("Cancel");
      }
      if (row.state === "running" && projection.mode === "run_state") {
        expect(projection.refresh).toEqual({
          last_checked_at: "2026-08-03T12:00:00.000Z",
          refreshing: false,
          stale: false,
          refresh_failure: null,
        });
      }
    }
  });

  it("keeps launch failure, terminal failure, and manual recovery distinct", () => {
    const postCommit = shapingHandoffForItem(
      itemFor("brainstorm"),
      surfaceContext({
        post_commit_launch_failure: {
          manifest_outcome: "applied",
          decision_id: SHA_D,
          locked_model: "model-a",
          reason: "The adapter did not start.",
        },
      }),
    );
    expect(postCommit).toMatchObject({
      mode: "post_commit_launch_failure",
      locked_model: "model-a",
      locked_model_unavailable: false,
      bindings: {
        decision_id: SHA_D,
        expected_shaping_state_sha256: SHA_C,
      },
    });
    expect(postCommit).not.toHaveProperty("model_picker");
    if (postCommit.mode !== "post_commit_launch_failure") {
      throw new Error("expected a post-commit launch failure projection");
    }
    expect(postCommit.actions.map(({ label }) => label)).toEqual([
      "Retry launch",
    ]);

    const lockedUnavailable = shapingHandoffForItem(
      itemFor("brainstorm"),
      surfaceContext({
        post_commit_launch_failure: {
          manifest_outcome: "applied",
          decision_id: SHA_D,
          locked_model: "retired-model",
          reason: "The recorded model is unavailable.",
        },
      }),
    );
    expect(lockedUnavailable).toMatchObject({
      mode: "post_commit_launch_failure",
      locked_model_unavailable: true,
    });
    expect(lockedUnavailable).not.toHaveProperty("model_picker");
    if (lockedUnavailable.mode !== "post_commit_launch_failure") {
      throw new Error("expected a locked-model failure projection");
    }
    expect(lockedUnavailable.actions).toEqual([
      {
        kind: "open_new_attempt",
        label: "Start Brainstorm",
        launch_mode: null,
        primary: true,
        enabled: true,
      },
    ]);

    const runtimeUnavailable = shapingHandoffForItem(
      itemFor("brainstorm"),
      surfaceContext({
        models: {
          status: "unavailable",
          reason: "runtime unavailable",
          available_model_ids: [],
          model_picker_options: { brainstorm: [], spec: [], plan: [] },
        },
        post_commit_launch_failure: {
          manifest_outcome: "applied",
          decision_id: SHA_D,
          locked_model: "model-a",
          reason: "The adapter did not start.",
        },
      }),
    );
    expect(runtimeUnavailable).toMatchObject({
      mode: "post_commit_launch_failure",
      locked_model_unavailable: true,
      runtime_unavailable: "runtime unavailable",
    });
    expect(runtimeUnavailable).not.toHaveProperty("model_picker");
    if (runtimeUnavailable.mode !== "post_commit_launch_failure") {
      throw new Error("expected a runtime-unavailable launch failure");
    }
    expect(runtimeUnavailable.actions).toEqual([
      {
        kind: "prepare_manual_recovery",
        label: "Prepare manual recovery",
        launch_mode: "manual",
        primary: true,
        enabled: true,
      },
    ]);

    const terminal = shapingHandoffForItem(
      itemFor("brainstorm"),
      surfaceContext({ run: runFor("terminal", "failed") }),
    );
    expect(terminal).toMatchObject({ mode: "terminal_run_failure" });
    expect(terminal).toHaveProperty("model_picker");
    if (terminal.mode !== "terminal_run_failure") {
      throw new Error("expected a terminal run failure projection");
    }
    expect(terminal.actions.map(({ label }) => label)).toContain(
      "Retry Brainstorm",
    );

    const unavailableTerminal = shapingHandoffForItem(
      itemFor("brainstorm"),
      surfaceContext({
        models: {
          status: "unavailable",
          reason: "runtime unavailable",
          available_model_ids: [],
          model_picker_options: { brainstorm: [], spec: [], plan: [] },
        },
        run: runFor("terminal", "failed"),
      }),
    );
    expect(unavailableTerminal).toMatchObject({
      mode: "terminal_run_failure",
      runtime_unavailable: "runtime unavailable",
    });
    expect(unavailableTerminal).not.toHaveProperty("model_picker");
    if (unavailableTerminal.mode !== "terminal_run_failure") {
      throw new Error("expected a runtime-unavailable terminal failure");
    }
    expect(unavailableTerminal.actions).toEqual([
      {
        kind: "launch_phase",
        label: "Retry Brainstorm",
        launch_mode: "connected",
        primary: false,
        enabled: false,
      },
      {
        kind: "prepare_manual_recovery",
        label: "Prepare manual recovery",
        launch_mode: "manual",
        primary: true,
        enabled: true,
      },
    ]);
    expect(unavailableTerminal.lifecycle.actions).toEqual(
      unavailableTerminal.actions,
    );
    expect(unavailableTerminal.manual_recovery_action).toEqual(
      unavailableTerminal.actions[1],
    );

    const recoveryStates = [
      {
        recovery: { state: "loading" as const },
        actions: [],
      },
      {
        recovery: {
          state: "ready" as const,
          task: "Run the task",
          instruction_path: ".founder/instruction.json",
          ingress_path: ".founder/result.json",
        },
        actions: [
          {
            kind: "copy_manual_task",
            label: "Copy manual task",
            launch_mode: null,
            primary: true,
            enabled: true,
          },
          {
            kind: "import_manual_result",
            label: "Import result",
            launch_mode: null,
            primary: false,
            enabled: true,
          },
        ],
      },
      {
        recovery: {
          state: "failure" as const,
          reason: "Could not prepare ingress.",
        },
        actions: [
          {
            kind: "retry_manual_recovery",
            label: "Retry manual recovery",
            launch_mode: null,
            primary: true,
            enabled: true,
          },
        ],
      },
      {
        recovery: { state: "retry" as const, reason: "Retry requested." },
        actions: [
          {
            kind: "retry_manual_recovery",
            label: "Retry manual recovery",
            launch_mode: null,
            primary: true,
            enabled: true,
          },
        ],
      },
      {
        recovery: {
          state: "copy" as const,
          copied_target: "task" as const,
          task: "Run the task",
          instruction_path: ".founder/instruction.json",
          ingress_path: ".founder/result.json",
        },
        actions: [
          {
            kind: "copy_manual_task",
            label: "Copy manual task",
            launch_mode: null,
            primary: true,
            enabled: true,
          },
          {
            kind: "import_manual_result",
            label: "Import result",
            launch_mode: null,
            primary: false,
            enabled: true,
          },
        ],
      },
    ] as const;
    for (const { recovery, actions } of recoveryStates) {
      const projection = shapingHandoffForItem(
        itemFor("brainstorm"),
        surfaceContext({ manual_recovery: recovery }),
      );
      expect(projection).toMatchObject({
        mode: "manual_recovery",
        recovery: { state: recovery.state },
      });
      if (projection.mode !== "manual_recovery") {
        throw new Error(`expected ${recovery.state} manual recovery`);
      }
      expect(projection.actions, recovery.state).toEqual(actions);
    }

    const repairWins = shapingHandoffForItem(
      itemFor("brainstorm"),
      surfaceContext({
        revision: {
          mission_content_sha256: SHA_A,
          result: { status: "repair", failing_component: "applied marker" },
        },
        manual_recovery: recoveryStates[1].recovery,
      }),
    );
    expect(repairWins.mode).toBe("repair");
  });

  it("projects model provenance, unused-first defaults, and current-seat reruns", () => {
    const projection = shapingHandoffForItem(
      itemFor("spec"),
      appliedContext("spec", specResult, {
        models: {
          model_use: [
            {
              seat: "brainstorm",
              production_id: "prod-brainstorm",
              shaping_run_id: null,
              requested_model: "model-a",
              effective_model: null,
            },
            {
              seat: "spec",
              production_id: "prod-spec",
              shaping_run_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b2",
              requested_model: "model-b",
              effective_model: "model-c",
            },
          ],
          model_picker_options: {
            brainstorm: [modelOption("model-a")],
            spec: [
              modelOption("model-b"),
              modelOption("model-c", { recommended: true }),
              modelOption("model-a", { used_by_seats: ["brainstorm"] }),
            ],
            plan: [
              modelOption("model-a", {
                used_by_seats: ["brainstorm"],
                saved_preference: true,
                preselected: true,
                reuse_warning: "model-a was already used by brainstorm.",
              }),
              modelOption("model-c", { recommended: true }),
              modelOption("model-b"),
            ],
          },
        },
      }),
    );
    if (projection.mode !== "ready" || projection.phase !== "spec") {
      throw new Error("expected a ready Spec projection");
    }
    expect(projection.sections.provenance).toEqual([
      {
        seat: "brainstorm",
        requested_model: "model-a",
        effective_model: "unknown",
      },
      {
        seat: "spec",
        requested_model: "model-b",
        effective_model: "model-c",
      },
    ]);
    const nextOptions = projection.sections.next_step!.options;
    expect(nextOptions.map(({ model_id }) => model_id)).toEqual([
      "model-c",
      "model-b",
      "model-a",
    ]);
    expect(nextOptions.find(({ model_id }) => model_id === "model-c")).toMatchObject({
      recommended: true,
      preselected: true,
    });
    expect(nextOptions.find(({ model_id }) => model_id === "model-a")).toMatchObject({
      used_by_seats: ["brainstorm"],
      saved_preference: true,
      preselected: false,
      reuse_warning: "model-a was already used by brainstorm.",
    });
    expect(nextOptions.at(-1)?.model_id).toBe("model-a");
    expect(
      projection.request_changes.model_picker?.options.find(
        ({ model_id }) => model_id === "model-c",
      ),
    ).toMatchObject({ current_revision: true, preselected: true });
    expect(projection.request_changes.actions.map(({ label }) => label)).toEqual([
      "Request changes & rerun",
      "Request changes & prepare rerun",
    ]);
  });

  it("states plainly when every available model has already been used", () => {
    const projection = shapingHandoffForItem(
      itemFor("spec"),
      appliedContext("spec", specResult, {
        models: {
          available_model_ids: ["model-a", "model-b", "model-c"],
          model_picker_options: {
            brainstorm: [modelOption("model-a")],
            spec: [modelOption("model-b")],
            plan: [
              modelOption("model-b", { used_by_seats: ["spec"] }),
              modelOption("model-c", { used_by_seats: ["brainstorm"] }),
              modelOption("model-a", { used_by_seats: ["brainstorm"] }),
            ],
          },
        },
      }),
    );

    if (projection.mode !== "ready" || projection.phase !== "spec") {
      throw new Error("expected a ready Spec projection");
    }
    expect(projection.sections.next_step).toMatchObject({
      selected_model: null,
      reuse_warning: null,
      recommendation_note:
        "Every available model has already been used in this workflow.",
    });
    expect(
      projection.sections.next_step?.options.map(
        ({ model_id, used_by_seats, preselected }) => ({
          model_id,
          used_by_seats,
          preselected,
        }),
      ),
    ).toEqual([
      {
        model_id: "model-b",
        used_by_seats: ["spec"],
        preselected: false,
      },
      {
        model_id: "model-c",
        used_by_seats: ["brainstorm"],
        preselected: false,
      },
      {
        model_id: "model-a",
        used_by_seats: ["brainstorm"],
        preselected: false,
      },
    ]);
  });

  it("uses the exact preview boundaries and field-local truncation flags", () => {
    expect(PREVIEW_PROSE_MAX_CHARS).toBe(320);
    expect(PREVIEW_LIST_MAX_ITEMS).toBe(4);
    expect(PREVIEW_LIST_ITEM_MAX_CHARS).toBe(160);
    expect(PREVIEW_CHECKLIST_MAX_ENTRIES).toBe(6);

    const proseAtBoundary = previewShapingText("a".repeat(320));
    expect(proseAtBoundary).toMatchObject({
      truncated: false,
      total: 320,
      expander_label: null,
    });
    expect(proseAtBoundary.shown).toBe("a".repeat(320));
    const prosePastBoundary = previewShapingText("a".repeat(321));
    expect(prosePastBoundary).toMatchObject({
      truncated: true,
      total: 321,
      shown: `${"a".repeat(320)}…`,
      expander_label: "Show full text",
    });
    expect(previewShapingText("word ".repeat(65).trimEnd()).shown).toBe(
      `${"word ".repeat(63)}word…`,
    );

    const fourItems = previewShapingList(["1", "2", "3", "4"]);
    expect(fourItems).toMatchObject({
      truncated: false,
      total: 4,
    });
    expect(fourItems.shown.map(({ shown }) => shown)).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
    const fiveItems = previewShapingList(["1", "2", "3", "4", "5"]);
    expect(fiveItems).toMatchObject({
      truncated: true,
      total: 5,
      expander_label: "Show all 5",
    });
    expect(fiveItems.shown.map(({ shown }) => shown)).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
    expect(fiveItems.shown).toHaveLength(4);

    const itemAtBoundary = previewShapingList(["x".repeat(160)]);
    expect(itemAtBoundary).toMatchObject({
      truncated: false,
      shown: [
        {
          shown: "x".repeat(160),
          total: 160,
          truncated: false,
          expander_label: null,
        },
      ],
      expander_label: null,
    });
    const itemPastBoundary = previewShapingList(["x".repeat(161)]);
    expect(itemPastBoundary).toMatchObject({
      truncated: true,
      shown: [
        {
          shown: `${"x".repeat(160)}…`,
          total: 161,
          truncated: true,
          expander_label: "Show full text",
        },
      ],
      expander_label: "Show all 1",
    });

    const checklist = Array.from({ length: 7 }, (_, index) => ({
      id: String(index + 1),
      step: `Step ${index + 1}`,
      verification_check: `Check ${index + 1}`,
    }));
    const sevenEntries = previewShapingChecklist(checklist);
    expect(sevenEntries).toMatchObject({
      truncated: true,
      total: 7,
      expander_label: "Show all 7",
    });
    expect(
      sevenEntries.shown.map(({ id, step, verification_check }) => ({
        id,
        step: step.shown,
        verification_check: verification_check.shown,
      })),
    ).toEqual(
      checklist.slice(0, 6).map(({ id, step, verification_check }) => ({
        id,
        step,
        verification_check,
      })),
    );
    expect(sevenEntries.shown).toHaveLength(6);
    const sixEntries = previewShapingChecklist(checklist.slice(0, 6));
    expect(sixEntries).toMatchObject({
      truncated: false,
      total: 6,
    });
    expect(sixEntries.shown).toHaveLength(6);

    const untruncatedFlags = {
      purpose: false,
      acceptance_criteria: false,
      non_goals: false,
      allowed_scope: false,
      review_ready: false,
    };
    const truncationCases = [
      {
        field: "purpose" as const,
        proposal: { ...specResult.proposal, purpose: "p".repeat(321) },
      },
      {
        field: "acceptance_criteria" as const,
        proposal: {
          ...specResult.proposal,
          acceptance_criteria: Array.from(
            { length: 5 },
            (_, index) => `Criterion ${index + 1}`,
          ),
        },
      },
      {
        field: "non_goals" as const,
        proposal: {
          ...specResult.proposal,
          non_goals: Array.from(
            { length: 5 },
            (_, index) => `Non-goal ${index + 1}`,
          ),
        },
      },
      {
        field: "allowed_scope" as const,
        proposal: {
          ...specResult.proposal,
          allowed_scope: Array.from(
            { length: 5 },
            (_, index) => `Scope ${index + 1}`,
          ),
        },
      },
      {
        field: "review_ready" as const,
        proposal: {
          ...specResult.proposal,
          review_ready: Array.from(
            { length: 5 },
            (_, index) => `Review check ${index + 1}`,
          ),
        },
      },
    ];

    for (const truncationCase of truncationCases) {
      const longSpec: SpecResultSubmission = {
        ...specResult,
        proposal: truncationCase.proposal,
      };
      const projection = shapingHandoffForItem(
        itemFor("spec"),
        appliedContext("spec", longSpec),
      );
      if (projection.mode !== "ready" || projection.phase !== "spec") {
        throw new Error("expected a ready Spec projection");
      }
      expect(
        projection.governed_contract.truncation,
        truncationCase.field,
      ).toEqual({
        ...untruncatedFlags,
        [truncationCase.field]: true,
      });
      expect(
        projection.actions.find(({ label }) => label === "Approve & run Plan"),
        truncationCase.field,
      ).toMatchObject({ enabled: true });
      expect(JSON.stringify(projection), truncationCase.field).not.toMatch(
        /contract_review|review_gate|reviewed_state/,
      );
    }
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
