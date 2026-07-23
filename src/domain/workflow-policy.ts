import type { WorkItemPhase, WorkItemStatus } from "./work-item";

export const ALLOWED_PHASE_TRANSITIONS = {
  idea: ["spec"],
  brainstorm: ["spec"],
  spec: ["brainstorm", "plan"],
  plan: ["spec", "execute"],
  execute: ["plan", "review"],
  review: ["execute", "ship"],
  test: ["execute", "ship"],
  ship: ["review", "learn"],
  learn: ["ship"],
} as const satisfies Record<WorkItemPhase, readonly WorkItemPhase[]>;

export type WorkflowTransitionResult =
  | { ok: true }
  | { ok: false; reason: string };

export function canUpdateGoalContract(phase: WorkItemPhase): boolean {
  return ["idea", "brainstorm", "spec", "plan"].includes(phase);
}

export function validatePhaseTransition(
  sourcePhase: WorkItemPhase,
  targetPhase: WorkItemPhase,
): WorkflowTransitionResult {
  const allowedTargets = ALLOWED_PHASE_TRANSITIONS[sourcePhase];

  if ((allowedTargets as readonly WorkItemPhase[]).includes(targetPhase)) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: `Phase transition from ${sourcePhase} to ${targetPhase} is not allowed.`,
  };
}

export function validateStatusTransition(
  sourcePhase: WorkItemPhase,
  targetPhase: WorkItemPhase,
  sourceStatus: WorkItemStatus,
  targetStatus: WorkItemStatus,
): WorkflowTransitionResult {
  if (sourcePhase !== targetPhase) {
    return sourceStatus === "active" && targetStatus === "active"
      ? { ok: true }
      : {
          ok: false,
          reason: "Phase movement requires active status to remain active.",
        };
  }

  const allowedTargets: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
    active: ["paused", "blocked", "cancelled"],
    paused: ["active", "cancelled"],
    blocked: ["active", "cancelled"],
    cancelled: [],
  };

  if (allowedTargets[sourceStatus].includes(targetStatus)) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: `Status transition from ${sourceStatus} to ${targetStatus} is not allowed.`,
  };
}

export function validateWorkItemTransition(
  sourcePhase: WorkItemPhase,
  targetPhase: WorkItemPhase,
  sourceStatus: WorkItemStatus,
  targetStatus: WorkItemStatus,
): WorkflowTransitionResult {
  if (sourcePhase !== targetPhase) {
    const phaseResult = validatePhaseTransition(sourcePhase, targetPhase);
    if (!phaseResult.ok) {
      return phaseResult;
    }
  }

  return validateStatusTransition(
    sourcePhase,
    targetPhase,
    sourceStatus,
    targetStatus,
  );
}
