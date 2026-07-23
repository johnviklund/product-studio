import { describe, expect, it } from "vitest";

import {
  ALLOWED_PHASE_TRANSITIONS,
  canUpdateGoalContract,
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
      idea: ["spec"],
      brainstorm: ["spec"],
      spec: ["brainstorm", "plan"],
      plan: ["spec", "execute"],
      execute: ["plan", "review"],
      review: ["execute", "ship"],
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
