import { describe, expect, it } from "vitest";

import {
  ALLOWED_PHASE_TRANSITIONS,
  CLOSED_IN_SLICE_PHASE_TRANSITIONS,
  CONTROLLER_ONLY_PHASE_TRANSITIONS,
  canUpdateGoalContract,
  dedicatedTransitionPolicy,
  validatePhaseTransition,
  validateStatusTransition,
  validateWorkItemTransition,
} from "../../src/domain/workflow-policy";
import {
  WORK_ITEM_PHASES,
  type WorkItemPhase,
} from "../../src/domain/work-item";

describe("workflow transition policy", () => {
  it("allows goal-contract updates only before execute", () => {
    const editablePhases = new Set(["idea", "brainstorm", "spec", "plan"]);

    for (const phase of WORK_ITEM_PHASES) {
      expect(canUpdateGoalContract(phase)).toBe(editablePhases.has(phase));
    }
  });

  it("preserves the existing board phase matrix exactly", () => {
    const expected = {
      idea: ["brainstorm", "spec"],
      brainstorm: ["spec"],
      spec: ["brainstorm", "plan"],
      plan: ["spec", "execute"],
      execute: ["plan", "review"],
      review: ["execute", "ship", "patch"],
      patch: ["review"],
      test: ["execute", "ship"],
      ship: ["review", "learn"],
      learn: ["ship"],
    } as const;

    expect(ALLOWED_PHASE_TRANSITIONS).toEqual(expected);

    for (const source of WORK_ITEM_PHASES) {
      for (const target of WORK_ITEM_PHASES) {
        expect(validatePhaseTransition(source, target).ok).toBe(
          (expected[source] as readonly WorkItemPhase[]).includes(target),
        );
      }
    }
  });

  it("opens only the explicit idea-to-brainstorm on-ramp", () => {
    expect(validatePhaseTransition("idea", "brainstorm")).toEqual({ ok: true });
    expect(ALLOWED_PHASE_TRANSITIONS.idea).toEqual(["brainstorm", "spec"]);
  });

  it("routes the four governed advances through their dedicated operations", () => {
    expect(CONTROLLER_ONLY_PHASE_TRANSITIONS).toEqual([
      {
        from: "idea",
        to: "brainstorm",
        action_label: "Start Brainstorm",
        explanation:
          "The controller publishes the Brainstorm mission and starts the run in one action; if no model is available, use the manual recovery mode of the same action.",
      },
      {
        from: "brainstorm",
        to: "spec",
        action_label: "Use result & run Spec",
        explanation: "The Spec input must be a real Brainstorm selection.",
      },
      {
        from: "spec",
        to: "plan",
        action_label: "Approve & run Plan",
        explanation: "Approval writes the governed goal contract.",
      },
      {
        from: "plan",
        to: "execute",
        action_label: "Approve & run Execute",
        explanation:
          "Approval validates the exact Plan result and creates the governed Execute handoff.",
      },
    ]);

    for (const transition of CONTROLLER_ONLY_PHASE_TRANSITIONS) {
      expect(dedicatedTransitionPolicy(transition.from, transition.to)).toEqual({
        kind: "dedicated_operation_required",
        action_label: transition.action_label,
        explanation: transition.explanation,
      });
      expect(
        (
          ALLOWED_PHASE_TRANSITIONS[transition.from] as readonly WorkItemPhase[]
        ).includes(transition.to),
      ).toBe(true);
    }
  });

  it("keeps the three shaping arrows without a safe generic owner closed", () => {
    expect(CLOSED_IN_SLICE_PHASE_TRANSITIONS).toEqual([
      {
        from: "idea",
        to: "spec",
        explanation:
          "Spec requires a Brainstorm selection; there is no direct-Spec input in this slice. A direct-Spec input variant is separate scope.",
        alternative_action_label: null,
      },
      {
        from: "spec",
        to: "brainstorm",
        explanation:
          "Use Request changes on Spec; it creates a new revision in place instead of reopening a decided one.",
        alternative_action_label: "Request changes",
      },
      {
        from: "plan",
        to: "spec",
        explanation:
          "Use Request changes on Plan; it creates a new revision in place instead of reopening a decided one.",
        alternative_action_label: "Request changes",
      },
    ]);

    for (const transition of CLOSED_IN_SLICE_PHASE_TRANSITIONS) {
      expect(dedicatedTransitionPolicy(transition.from, transition.to)).toEqual({
        kind: "closed_in_slice",
        explanation: transition.explanation,
        alternative_action_label: transition.alternative_action_label,
      });
    }
  });

  it("is total and leaves every unlisted arrow generic", () => {
    const namedArrows = new Set(
      [
        ...CONTROLLER_ONLY_PHASE_TRANSITIONS,
        ...CLOSED_IN_SLICE_PHASE_TRANSITIONS,
      ].map(({ from, to }) => `${from}->${to}`),
    );
    const postExecutePhases = new Set<WorkItemPhase>([
      "execute",
      "review",
      "patch",
      "test",
      "ship",
      "learn",
    ]);

    for (const from of WORK_ITEM_PHASES) {
      for (const to of WORK_ITEM_PHASES) {
        const result = dedicatedTransitionPolicy(from, to);
        expect([
          "generic_allowed",
          "dedicated_operation_required",
          "closed_in_slice",
        ]).toContain(result.kind);

        if (!namedArrows.has(`${from}->${to}`)) {
          expect(result).toEqual({ kind: "generic_allowed" });
        }

        if (postExecutePhases.has(from)) {
          expect(result).toEqual({ kind: "generic_allowed" });
        }
      }
    }
  });

  it("allows only review-to-patch and patch-to-review patch edges", () => {
    expect(validatePhaseTransition("review", "patch")).toEqual({ ok: true });
    expect(validatePhaseTransition("patch", "review")).toEqual({ ok: true });

    for (const phase of WORK_ITEM_PHASES) {
      if (phase !== "review" && phase !== "patch") {
        expect(validatePhaseTransition("patch", phase).ok).toBe(false);
        expect(validatePhaseTransition(phase, "patch").ok).toBe(false);
      }
    }
  });

  it("requires active status to remain active during phase movement", () => {
    expect(
      validateWorkItemTransition("spec", "plan", "active", "active"),
    ).toEqual({ ok: true });
    expect(
      validateWorkItemTransition("spec", "plan", "active", "paused"),
    ).toEqual({
      ok: false,
      reason: "Phase movement requires active status to remain active.",
    });
    expect(
      validateWorkItemTransition("spec", "plan", "blocked", "active"),
    ).toEqual({
      ok: false,
      reason: "Phase movement requires active status to remain active.",
    });
  });

  it("allows only the bounded same-phase status transitions", () => {
    expect(validateStatusTransition("plan", "plan", "active", "paused")).toEqual({
      ok: true,
    });
    expect(validateStatusTransition("plan", "plan", "active", "blocked")).toEqual({
      ok: true,
    });
    expect(
      validateStatusTransition("plan", "plan", "active", "cancelled"),
    ).toEqual({ ok: true });
    expect(validateStatusTransition("plan", "plan", "paused", "active")).toEqual({
      ok: true,
    });
    expect(
      validateStatusTransition("plan", "plan", "blocked", "cancelled"),
    ).toEqual({ ok: true });

    expect(validateStatusTransition("plan", "plan", "active", "active").ok).toBe(
      false,
    );
    expect(validateStatusTransition("plan", "plan", "paused", "blocked").ok).toBe(
      false,
    );
    expect(
      validateStatusTransition("plan", "plan", "cancelled", "active"),
    ).toEqual({
      ok: false,
      reason: "Status transition from cancelled to active is not allowed.",
    });
  });

  it("rejects a status-valid move when the phase transition is invalid", () => {
    expect(
      validateWorkItemTransition("idea", "plan", "active", "active"),
    ).toEqual({
      ok: false,
      reason: "Phase transition from idea to plan is not allowed.",
    });
  });
});
