import type { WorkItemPhase, WorkItemStatus } from "./work-item";

export const ALLOWED_PHASE_TRANSITIONS = {
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
} as const satisfies Record<WorkItemPhase, readonly WorkItemPhase[]>;

type ControllerOnlyPhaseTransition = {
  from: WorkItemPhase;
  to: WorkItemPhase;
  action_label: string;
  explanation: string;
};

type ClosedInSlicePhaseTransition = {
  from: WorkItemPhase;
  to: WorkItemPhase;
  explanation: string;
  alternative_action_label: string | null;
};

export const CONTROLLER_ONLY_PHASE_TRANSITIONS = [
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
] as const satisfies readonly ControllerOnlyPhaseTransition[];

export const CLOSED_IN_SLICE_PHASE_TRANSITIONS = [
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
] as const satisfies readonly ClosedInSlicePhaseTransition[];

export type DedicatedTransitionPolicyResult =
  | { kind: "generic_allowed" }
  | {
      kind: "dedicated_operation_required";
      action_label: string;
      explanation: string;
    }
  | {
      kind: "closed_in_slice";
      explanation: string;
      alternative_action_label: string | null;
    };

export function dedicatedTransitionPolicy(
  from: WorkItemPhase,
  to: WorkItemPhase,
): DedicatedTransitionPolicyResult {
  const controllerOnly = CONTROLLER_ONLY_PHASE_TRANSITIONS.find(
    (transition) => transition.from === from && transition.to === to,
  );

  if (controllerOnly) {
    return {
      kind: "dedicated_operation_required",
      action_label: controllerOnly.action_label,
      explanation: controllerOnly.explanation,
    };
  }

  const closed = CLOSED_IN_SLICE_PHASE_TRANSITIONS.find(
    (transition) => transition.from === from && transition.to === to,
  );

  if (closed) {
    return {
      kind: "closed_in_slice",
      explanation: closed.explanation,
      alternative_action_label: closed.alternative_action_label,
    };
  }

  return { kind: "generic_allowed" };
}

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
