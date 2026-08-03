import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  REFRESH_ATTEMPT_BUDGET,
  REFRESH_BACKOFF_FACTOR,
  REFRESH_DELAY_CAP_MS,
  REFRESH_FAILURE_GRACE,
  REFRESH_INITIAL_DELAY_MS,
  boundedRefreshMachine,
  createShapingRefreshController,
  shapingActionRequest,
  type BoundedRefreshInput,
  type ShapingRefreshControllerInput,
  type ShapingRefreshObservation,
} from "../src/presentation/shaping-interaction";
import type {
  DecisionFirstShapingHandoffProjection,
  ShapingActionProjection,
} from "../src/presentation/board";
import type { ShapingPhase } from "../src/domain/shaping";

const SOURCE_ID = "source / one";
const WORK_ITEM_ID = "wi_550e8400-e29b-41d4-a716-446655440000";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const DECISION_ID = "e".repeat(64);
const BASE_ROUTE =
  "/api/portfolio/work-items/source%20%2F%20one/wi_550e8400-e29b-41d4-a716-446655440000/shaping";

function action(
  kind: ShapingActionProjection["kind"],
  launchMode: ShapingActionProjection["launch_mode"],
  overrides: Partial<ShapingActionProjection> = {},
): ShapingActionProjection {
  return {
    kind,
    label: kind,
    launch_mode: launchMode,
    primary: true,
    enabled: true,
    ...overrides,
  };
}

function projection(
  value: Record<string, unknown>,
): DecisionFirstShapingHandoffProjection {
  return value as unknown as DecisionFirstShapingHandoffProjection;
}

function ideaProjection(
  selectedAction: ShapingActionProjection,
): DecisionFirstShapingHandoffProjection {
  return projection({
    mode: "idea",
    phase: "idea",
    target_phase: "brainstorm",
    expected_shaping_state_sha256: SHA_C,
    actions: [selectedAction],
  });
}

function readyProjection(
  phase: ShapingPhase,
  selectedAction: ShapingActionProjection,
  options: { requestChanges?: boolean; goalContract?: boolean } = {},
): DecisionFirstShapingHandoffProjection {
  const bindings = {
    expected_mission_content_sha256: SHA_A,
    expected_result_content_sha256: SHA_B,
    expected_shaping_state_sha256: SHA_C,
    ...(options.goalContract ? { goal_contract_sha256: SHA_D } : {}),
  };
  return projection({
    mode: "ready",
    phase,
    expected_shaping_state_sha256: SHA_C,
    bindings,
    actions: options.requestChanges ? [] : [selectedAction],
    request_changes: {
      feedback_required: true,
      actions: options.requestChanges ? [selectedAction] : [],
    },
  });
}

function supersededProjection(
  selectedAction: ShapingActionProjection,
): DecisionFirstShapingHandoffProjection {
  return projection({
    mode: "plan_result_superseded",
    phase: "plan",
    expected_shaping_state_sha256: SHA_C,
    bindings: {
      expected_mission_content_sha256: SHA_A,
      expected_result_content_sha256: SHA_B,
      expected_shaping_state_sha256: SHA_C,
      goal_contract_sha256: SHA_D,
    },
    actions: [selectedAction],
    request_changes: { feedback_required: true, actions: [] },
  });
}

function retryProjection(
  phase: ShapingPhase,
  selectedAction: ShapingActionProjection,
): DecisionFirstShapingHandoffProjection {
  return projection({
    mode: "post_commit_launch_failure",
    phase,
    expected_shaping_state_sha256: SHA_C,
    decision_id: DECISION_ID,
    bindings: {
      decision_id: DECISION_ID,
      expected_shaping_state_sha256: SHA_C,
    },
    actions: [selectedAction],
  });
}

function preReadyProjection(
  phase: ShapingPhase,
  selectedAction: ShapingActionProjection,
): DecisionFirstShapingHandoffProjection {
  return projection({
    mode: "pre_ready",
    phase,
    expected_shaping_state_sha256: SHA_C,
    mission_content_sha256: SHA_A,
    actions: [selectedAction],
  });
}

function runStateProjection(
  phase: ShapingPhase,
  selectedAction: ShapingActionProjection,
): DecisionFirstShapingHandoffProjection {
  return projection({
    mode: "run_state",
    phase,
    expected_shaping_state_sha256: SHA_C,
    actions: [selectedAction],
    run: {
      shaping_run_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1",
      status: "running",
      terminal_outcome: null,
      latest_update: "Inspecting the bounded mission.",
      sanitized_reason: null,
      denied_operation_kind: null,
      timeout_limit: null,
    },
  });
}

function buildRequest(
  projected: DecisionFirstShapingHandoffProjection,
  selectedAction: ShapingActionProjection,
  options: { selected_model?: string | null; feedback?: string | null } = {},
) {
  return shapingActionRequest({
    source_id: SOURCE_ID,
    work_item_id: WORK_ITEM_ID,
    projection: projected,
    action: selectedAction,
    ...options,
  });
}

describe("shapingActionRequest", () => {
  it.each([
    {
      name: "starts Brainstorm",
      actionKind: "start_brainstorm" as const,
      route: `${BASE_ROUTE}/start-brainstorm`,
      makeProjection: ideaProjection,
      body: {
        expected_mission_content_sha256: null,
        expected_result_content_sha256: null,
        expected_shaping_state_sha256: SHA_C,
      },
    },
    {
      name: "uses the Brainstorm result",
      actionKind: "use_brainstorm_result" as const,
      route: `${BASE_ROUTE}/brainstorm/use-result`,
      makeProjection: (selectedAction: ShapingActionProjection) =>
        readyProjection("brainstorm", selectedAction),
      body: {
        expected_mission_content_sha256: SHA_A,
        expected_result_content_sha256: SHA_B,
        expected_shaping_state_sha256: SHA_C,
      },
    },
    {
      name: "approves the Spec",
      actionKind: "approve_spec" as const,
      route: `${BASE_ROUTE}/spec/approve`,
      makeProjection: (selectedAction: ShapingActionProjection) =>
        readyProjection("spec", selectedAction, { goalContract: true }),
      body: {
        expected_mission_content_sha256: SHA_A,
        expected_result_content_sha256: SHA_B,
        expected_shaping_state_sha256: SHA_C,
        goal_contract_sha256: SHA_D,
      },
    },
    {
      name: "replans against the current contract",
      actionKind: "replan_with_updated_contract" as const,
      route: `${BASE_ROUTE}/plan/replan`,
      makeProjection: supersededProjection,
      body: {
        expected_mission_content_sha256: SHA_A,
        expected_result_content_sha256: SHA_B,
        expected_shaping_state_sha256: SHA_C,
        goal_contract_sha256: SHA_D,
      },
    },
  ])("builds exact connected and manual requests when it $name", ({
    actionKind,
    route,
    makeProjection,
    body,
  }) => {
    const connectedAction = action(actionKind, "connected");
    expect(
      buildRequest(makeProjection(connectedAction), connectedAction, {
        selected_model: "model-next",
      }),
    ).toEqual({
      status: "ready",
      method: "POST",
      route,
      body: {
        launch_mode: "connected",
        requested_model: "model-next",
        ...body,
      },
    });

    const manualAction = action(actionKind, "manual");
    expect(
      buildRequest(makeProjection(manualAction), manualAction, {
        selected_model: "must-not-leak",
      }),
    ).toEqual({
      status: "ready",
      method: "POST",
      route,
      body: { launch_mode: "manual", ...body },
    });
  });

  it.each(["brainstorm", "spec", "plan"] as const)(
    "builds exact connected and manual request_changes requests for %s",
    (phase) => {
      const connectedAction = action("request_changes", "connected");
      const connectedProjection = readyProjection(phase, connectedAction, {
        requestChanges: true,
      });
      expect(
        buildRequest(connectedProjection, connectedAction, {
          selected_model: "model-rerun",
          feedback: "  Narrow the scope.  ",
        }),
      ).toEqual({
        status: "ready",
        method: "POST",
        route: `${BASE_ROUTE}/${phase}/request-changes`,
        body: {
          launch_mode: "connected",
          requested_model: "model-rerun",
          expected_mission_content_sha256: SHA_A,
          expected_result_content_sha256: SHA_B,
          expected_shaping_state_sha256: SHA_C,
          feedback: "Narrow the scope.",
        },
      });

      const manualAction = action("request_changes", "manual");
      const manualProjection = readyProjection(phase, manualAction, {
        requestChanges: true,
      });
      expect(
        buildRequest(manualProjection, manualAction, {
          selected_model: "must-not-leak",
          feedback: "Try the smaller plan.",
        }),
      ).toEqual({
        status: "ready",
        method: "POST",
        route: `${BASE_ROUTE}/${phase}/request-changes`,
        body: {
          launch_mode: "manual",
          expected_mission_content_sha256: SHA_A,
          expected_result_content_sha256: SHA_B,
          expected_shaping_state_sha256: SHA_C,
          feedback: "Try the smaller plan.",
        },
      });
    },
  );

  it.each(["brainstorm", "spec", "plan"] as const)(
    "builds retry-launch for %s with only its immutable binding",
    (phase) => {
      const retryAction = action("retry_launch", null);
      expect(
        buildRequest(retryProjection(phase, retryAction), retryAction, {
          selected_model: "must-not-leak",
        }),
      ).toEqual({
        status: "ready",
        method: "POST",
        route: `${BASE_ROUTE}/${phase}/retry-launch`,
        body: {
          decision_id: DECISION_ID,
          expected_shaping_state_sha256: SHA_C,
        },
      });
    },
  );

  it.each(["brainstorm", "spec", "plan"] as const)(
    "builds an ordinary connected %s launch request",
    (phase) => {
      const launchAction = action("launch_phase", "connected");
      expect(
        buildRequest(preReadyProjection(phase, launchAction), launchAction, {
          selected_model: "model-current",
        }),
      ).toEqual({
        status: "ready",
        method: "POST",
        route: `${BASE_ROUTE}/${phase}/connected/launch`,
        body: { requested_model: "model-current" },
      });
    },
  );

  it.each(["brainstorm", "spec", "plan"] as const)(
    "builds an exact %s cancellation request without model or binding fields",
    (phase) => {
      const cancelAction = action("cancel_run", null, {
        primary: false,
        shaping_run_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1",
      });
      expect(
        buildRequest(runStateProjection(phase, cancelAction), cancelAction, {
          selected_model: "must-not-leak",
        }),
      ).toEqual({
        status: "ready",
        method: "POST",
        route: `${BASE_ROUTE}/${phase}/connected/cancel`,
        body: {
          shaping_run_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1",
        },
      });
    },
  );

  it("fails closed when cancellation is not bound to the visible run", () => {
    const cancelAction = action("cancel_run", null, {
      shaping_run_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1",
    });
    const projected = runStateProjection("brainstorm", cancelAction);
    Object.assign(
      (projected as Extract<
        DecisionFirstShapingHandoffProjection,
        { mode: "run_state" }
      >).run,
      { shaping_run_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b2" },
    );

    expect(buildRequest(projected, cancelAction)).toEqual({
      status: "blocked",
      reason: "missing_binding",
    });
  });

  it.each([null, "", "   \n\t"])(
    "blocks request_changes with empty feedback (%j)",
    (feedback) => {
      const requestAction = action("request_changes", "connected");
      const result = buildRequest(
        readyProjection("brainstorm", requestAction, {
          requestChanges: true,
        }),
        requestAction,
        { selected_model: "model-a", feedback },
      );
      expect(result).toMatchObject({ status: "blocked" });
      expect(result).not.toHaveProperty("route");
      expect(result).not.toHaveProperty("body");
    },
  );

  it("blocks a connected action without a selected model", () => {
    const startAction = action("start_brainstorm", "connected");
    expect(buildRequest(ideaProjection(startAction), startAction)).toMatchObject(
      { status: "blocked" },
    );
  });

  it("blocks every independently required binding hash", () => {
    const missingStartState = () => {
      const selectedAction = action("start_brainstorm", "connected");
      const projected = ideaProjection(selectedAction);
      Object.assign(projected, { expected_shaping_state_sha256: null });
      return buildRequest(projected, selectedAction, {
        selected_model: "model-brainstorm",
      });
    };
    const missingReadyBinding = (
      field:
        | "expected_mission_content_sha256"
        | "expected_result_content_sha256"
        | "expected_shaping_state_sha256",
    ) => {
      const selectedAction = action("use_brainstorm_result", "connected");
      const projected = readyProjection("brainstorm", selectedAction);
      Object.assign(
        (projected as unknown as { bindings: Record<string, string> }).bindings,
        { [field]: "" },
      );
      return buildRequest(projected, selectedAction, {
        selected_model: "model-spec",
      });
    };
    const missingGoalContract = () => {
      const selectedAction = action("approve_spec", "connected");
      return buildRequest(
        readyProjection("spec", selectedAction),
        selectedAction,
        { selected_model: "model-plan" },
      );
    };
    const missingReplanGoalContract = () => {
      const selectedAction = action(
        "replan_with_updated_contract",
        "connected",
      );
      const projected = supersededProjection(selectedAction);
      Object.assign(
        (projected as unknown as { bindings: Record<string, string> }).bindings,
        { goal_contract_sha256: "" },
      );
      return buildRequest(projected, selectedAction, {
        selected_model: "model-plan",
      });
    };
    const missingRetryBinding = (
      field: "decision_id" | "expected_shaping_state_sha256",
    ) => {
      const selectedAction = action("retry_launch", null);
      const projected = retryProjection("spec", selectedAction);
      Object.assign(
        (projected as unknown as { bindings: Record<string, string> }).bindings,
        { [field]: "" },
      );
      return buildRequest(projected, selectedAction);
    };

    const cases = [
      ["start state", missingStartState()],
      ["ready mission", missingReadyBinding("expected_mission_content_sha256")],
      ["ready result", missingReadyBinding("expected_result_content_sha256")],
      ["ready state", missingReadyBinding("expected_shaping_state_sha256")],
      ["approval goal contract", missingGoalContract()],
      ["replan goal contract", missingReplanGoalContract()],
      ["retry decision", missingRetryBinding("decision_id")],
      [
        "retry state",
        missingRetryBinding("expected_shaping_state_sha256"),
      ],
    ] as const;
    for (const [name, result] of cases) {
      expect(result, name).toEqual({
        status: "blocked",
        reason: "missing_binding",
      });
      expect(result, name).not.toHaveProperty("route");
      expect(result, name).not.toHaveProperty("body");
    }
  });

  it("blocks an action that does not belong to the supplied projection", () => {
    const startAction = action("start_brainstorm", "connected");
    const mismatched = action("approve_spec", "connected");
    expect(
      buildRequest(ideaProjection(startAction), mismatched, {
        selected_model: "model-plan",
      }),
    ).toMatchObject({ status: "blocked" });
  });

  it("uses the projection's disabled state instead of a forged action copy", () => {
    const projectedAction = action("start_brainstorm", "connected", {
      enabled: false,
    });
    const forgedEnabledAction = action("start_brainstorm", "connected");

    expect(
      buildRequest(ideaProjection(projectedAction), forgedEnabledAction, {
        selected_model: "model-a",
      }),
    ).toEqual({ status: "blocked", reason: "action_disabled" });
  });

  it("blocks non-submit opener actions", () => {
    const opener = action("open_advanced_recovery", null);
    expect(buildRequest(preReadyProjection("spec", opener), opener)).toEqual({
      status: "blocked",
      reason: "unsupported_action",
    });
  });
});

function refreshInput(
  overrides: Partial<BoundedRefreshInput> = {},
): BoundedRefreshInput {
  return {
    run_status: "running",
    visible: true,
    attempt: 1,
    failures: 0,
    stale: false,
    last_checked_at: null,
    last_outcome: { kind: "initial" },
    now: 1_000,
    ...overrides,
  };
}

describe("boundedRefreshMachine", () => {
  it("exports the exact D9 bounds", () => {
    expect({
      REFRESH_INITIAL_DELAY_MS,
      REFRESH_BACKOFF_FACTOR,
      REFRESH_DELAY_CAP_MS,
      REFRESH_ATTEMPT_BUDGET,
      REFRESH_FAILURE_GRACE,
    }).toEqual({
      REFRESH_INITIAL_DELAY_MS: 2_000,
      REFRESH_BACKOFF_FACTOR: 1.5,
      REFRESH_DELAY_CAP_MS: 30_000,
      REFRESH_ATTEMPT_BUDGET: 40,
      REFRESH_FAILURE_GRACE: 3,
    });
  });

  it("uses the exact floored delay sequence and holds the cap", () => {
    expect(
      Array.from({ length: 9 }, (_, index) =>
        boundedRefreshMachine(refreshInput({ attempt: index + 1 })),
      ).map((decision) =>
        decision.kind === "schedule" ? decision.delay_ms : decision.kind,
      ),
    ).toEqual([
      2_000,
      3_000,
      4_500,
      6_750,
      10_125,
      15_187,
      22_781,
      30_000,
      30_000,
    ]);
  });

  it("stops for a terminal run", () => {
    expect(
      boundedRefreshMachine(refreshInput({ run_status: "terminal" })),
    ).toMatchObject({ kind: "stop" });
  });

  it("stops and marks the surface stale while hidden", () => {
    expect(
      boundedRefreshMachine(refreshInput({ visible: false })),
    ).toMatchObject({ kind: "stop", stale: true });
  });

  it.each([
    "lifecycle_changed",
    "updated_at_advanced",
    "work_item_changed",
    "explicit_refresh",
  ] as const)("resets cadence and failures after %s", (kind) => {
    expect(
      boundedRefreshMachine(
        refreshInput({
          attempt: 17,
          failures: 2,
          last_outcome: { kind },
        }),
      ),
    ).toMatchObject({
      kind: "schedule",
      delay_ms: kind === "explicit_refresh" ? 0 : 2_000,
      attempt: 1,
      failures: 0,
      stale: false,
    });
  });

  it("refreshes immediately when visibility is restored, then resumes at 2000ms", () => {
    const restored = boundedRefreshMachine(
      refreshInput({
        attempt: 21,
        failures: 3,
        stale: true,
        last_outcome: { kind: "visibility_restored" },
      }),
    );
    expect(restored).toMatchObject({
      kind: "schedule",
      delay_ms: 0,
      attempt: 1,
      failures: 0,
      stale: false,
    });

    expect(
      boundedRefreshMachine(
        refreshInput({
          attempt: 1,
          last_checked_at: 1_100,
          last_outcome: { kind: "forced_success" },
          now: 1_100,
        }),
      ),
    ).toMatchObject({ kind: "schedule", delay_ms: 2_000 });
  });

  it.each([
    {
      previousFailures: 0,
      previousAttempt: 1,
      failures: 1,
      attempt: 2,
      surfaced: false,
    },
    {
      previousFailures: 1,
      previousAttempt: 2,
      failures: 2,
      attempt: 3,
      surfaced: false,
    },
    {
      previousFailures: 2,
      previousAttempt: 3,
      failures: 3,
      attempt: 4,
      surfaced: true,
    },
  ])(
    "keeps scheduling after failure $failures with grace surfaced=$surfaced",
    ({ previousFailures, previousAttempt, failures, attempt, surfaced }) => {
      const decision = boundedRefreshMachine(
        refreshInput({
          failures: previousFailures,
          attempt: previousAttempt,
          last_outcome: { kind: "failure", reason: "network unavailable" },
        }),
      );
      expect(decision).toMatchObject({
        kind: "schedule",
        attempt,
        failures,
        refresh_failure: surfaced
          ? { reason: "network unavailable" }
          : null,
      });
    },
  );

  it("schedules attempt 40 and yields stale at attempt 41", () => {
    expect(
      boundedRefreshMachine(refreshInput({ attempt: 40 })),
    ).toMatchObject({ kind: "schedule", delay_ms: 30_000, attempt: 40 });
    expect(
      boundedRefreshMachine(refreshInput({ attempt: 41 })),
    ).toMatchObject({ kind: "stale", stale: true, attempt: 41 });
  });

  it.each([
    { kind: "explicit_refresh" as const, delay_ms: 0 },
    { kind: "visibility_restored" as const, delay_ms: 0 },
    { kind: "work_item_changed" as const, delay_ms: 2_000 },
  ])("restarts a stale machine only for $kind", ({ kind, delay_ms }) => {
    expect(
      boundedRefreshMachine(
        refreshInput({
          attempt: 41,
          failures: 3,
          stale: true,
          last_outcome: { kind },
        }),
      ),
    ).toMatchObject({
      kind: "schedule",
      delay_ms,
      attempt: 1,
      failures: 0,
      stale: false,
    });
  });

  it.each([
    { kind: "initial" as const },
    { kind: "unchanged_success" as const },
    { kind: "forced_success" as const },
    { kind: "lifecycle_changed" as const },
    { kind: "updated_at_advanced" as const },
    { kind: "external_lifecycle_changed" as const },
    { kind: "external_updated_at_advanced" as const },
    { kind: "failure" as const, reason: "still unavailable" },
  ])("keeps stale state stopped for disallowed restart $kind", (lastOutcome) => {
    expect(
      boundedRefreshMachine(
        refreshInput({
          attempt: 41,
          stale: true,
          last_outcome: lastOutcome,
        }),
      ),
    ).toMatchObject({ kind: "stale", stale: true });
  });

  it.each([
    "unchanged_success",
    "forced_success",
    "lifecycle_changed",
    "updated_at_advanced",
  ] as const)("updates last_checked after %s", (kind) => {
    expect(
      boundedRefreshMachine(
        refreshInput({
          last_checked_at: 400,
          last_outcome: { kind },
          now: 900,
        }),
      ),
    ).toMatchObject({ last_checked_at: 900 });
  });

  it.each([
    { kind: "initial" as const },
    { kind: "external_lifecycle_changed" as const },
    { kind: "external_updated_at_advanced" as const },
    { kind: "explicit_refresh" as const },
    { kind: "visibility_restored" as const },
    { kind: "failure" as const, reason: "offline" },
  ])("preserves last_checked after non-success $kind", (lastOutcome) => {
    expect(
      boundedRefreshMachine(
        refreshInput({
          last_checked_at: 400,
          last_outcome: lastOutcome,
          now: 900,
        }),
      ),
    ).toMatchObject({ last_checked_at: 400 });
  });

  it("records a terminal successful response before stopping", () => {
    expect(
      boundedRefreshMachine(
        refreshInput({
          run_status: "terminal",
          last_checked_at: 400,
          last_outcome: { kind: "lifecycle_changed" },
          now: 900,
        }),
      ),
    ).toMatchObject({ kind: "stop", last_checked_at: 900 });
  });

  it.each([
    "external_lifecycle_changed",
    "external_updated_at_advanced",
  ] as const)(
    "resets failed cadence for a terminal %s update without advancing last_checked",
    (kind) => {
      expect(
        boundedRefreshMachine(
          refreshInput({
            run_status: "terminal",
            attempt: 9,
            failures: 3,
            last_checked_at: 400,
            refresh_failure: { reason: "offline" },
            last_outcome: { kind },
            now: 900,
          }),
        ),
      ).toMatchObject({
        kind: "stop",
        attempt: 1,
        failures: 0,
        last_checked_at: 400,
        refresh_failure: null,
      });
    },
  );

  it("owns unchanged-success attempt advancement and failure reset", () => {
    expect(
      boundedRefreshMachine(
        refreshInput({
          attempt: 7,
          failures: 2,
          last_checked_at: 400,
          last_outcome: { kind: "unchanged_success" },
          now: 900,
        }),
      ),
    ).toMatchObject({
      kind: "schedule",
      attempt: 8,
      failures: 0,
      last_checked_at: 900,
    });
  });
});

function controllerInput(
  overrides: Partial<ShapingRefreshControllerInput> = {},
): ShapingRefreshControllerInput {
  return {
    work_item_id: WORK_ITEM_ID,
    run_status: "running",
    updated_at: "2026-08-03T10:00:00.000Z",
    visible: true,
    ...overrides,
  };
}

function observation(
  overrides: Partial<ShapingRefreshObservation> = {},
): ShapingRefreshObservation {
  return {
    work_item_id: WORK_ITEM_ID,
    run_status: "running",
    updated_at: "2026-08-03T10:00:00.000Z",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function expectAborted(signal: AbortSignal | null) {
  expect(signal).not.toBeNull();
  expect(signal?.aborted).toBe(true);
}

describe("createShapingRefreshController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeController(
    refresh: (
      observation: ShapingRefreshObservation,
      signal: AbortSignal,
    ) => Promise<ShapingRefreshObservation>,
    machine = boundedRefreshMachine,
  ) {
    return createShapingRefreshController({
      machine,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      now: () => Date.now(),
      refresh,
    });
  }

  it("executes exactly the machine delay and never owns two timers", async () => {
    const refresh = vi.fn(async () => observation());
    const machine = vi.fn((input: BoundedRefreshInput) => ({
      ...boundedRefreshMachine(input),
      kind: "schedule" as const,
      delay_ms: 1_234,
    }));
    const controller = makeController(refresh, machine);

    controller.start(controllerInput());
    expect(vi.getTimerCount()).toBe(1);
    controller.update(controllerInput());
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_233);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("starts at 2000ms and backs off after an unchanged success", async () => {
    const refresh = vi.fn(async () => observation());
    const controller = makeController(refresh);

    controller.start(controllerInput());
    expect(controller.snapshot()).toMatchObject({
      attempt: 1,
      failures: 0,
      last_checked_at: null,
      refreshing: false,
      stale: false,
      scheduled_delay_ms: 2_000,
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(
      observation(),
      expect.any(AbortSignal),
    );
    expect(controller.snapshot()).toMatchObject({
      attempt: 2,
      failures: 0,
      last_checked_at: 3_000,
      refreshing: false,
      stale: false,
      scheduled_delay_ms: 3_000,
    });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("stop clears its outstanding timer", () => {
    const controller = makeController(vi.fn(async () => observation()));
    controller.start(controllerInput());
    expect(vi.getTimerCount()).toBe(1);

    controller.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(controller.snapshot()).toMatchObject({ active: false });
  });

  it.each([
    {
      name: "lifecycle",
      update: controllerInput({ run_status: "starting" }),
    },
    {
      name: "updated_at",
      update: controllerInput({
        updated_at: "2026-08-03T10:01:00.000Z",
      }),
    },
  ])("does not advance last_checked for an external $name update", async ({
    update,
  }) => {
    const controller = makeController(vi.fn(async () => observation()));
    controller.start(controllerInput());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(controller.snapshot()).toMatchObject({ last_checked_at: 3_000 });

    controller.update(update);
    expect(controller.snapshot()).toMatchObject({
      attempt: 1,
      last_checked_at: 3_000,
    });
  });

  it("terminal and hidden work-item updates clear old item refresh state", async () => {
    const refresh = vi.fn(async () => observation());
    const terminalController = makeController(refresh);
    terminalController.start(controllerInput());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(terminalController.snapshot()).toMatchObject({
      last_checked_at: 3_000,
    });
    terminalController.update(
      controllerInput({ work_item_id: "wi_terminal", run_status: "terminal" }),
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(terminalController.snapshot()).toMatchObject({
      work_item_id: "wi_terminal",
      attempt: 1,
      failures: 0,
      last_checked_at: null,
      stale: false,
      refresh_failure: null,
    });

    const hiddenController = makeController(refresh);
    hiddenController.start(controllerInput());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(hiddenController.snapshot().last_checked_at).not.toBeNull();
    hiddenController.update(
      controllerInput({ work_item_id: "wi_hidden", visible: false }),
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(hiddenController.snapshot()).toMatchObject({
      work_item_id: "wi_hidden",
      attempt: 1,
      failures: 0,
      last_checked_at: null,
      stale: true,
      refresh_failure: null,
    });
  });

  it("refreshes immediately when visibility returns then resumes at 2000ms", async () => {
    const refresh = vi.fn(async () => observation());
    const controller = makeController(refresh);
    controller.start(controllerInput());
    controller.update(controllerInput({ visible: false }));
    expect(vi.getTimerCount()).toBe(0);

    controller.update(controllerInput({ visible: true }));
    expect(controller.snapshot()).toMatchObject({
      attempt: 1,
      scheduled_delay_ms: 0,
      stale: false,
    });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(controller.snapshot()).toMatchObject({
      attempt: 1,
      last_checked_at: 1_000,
      scheduled_delay_ms: 2_000,
      stale: false,
    });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("keeps work-item reset precedence during an immediate refresh", async () => {
    const refresh = vi.fn(async () =>
      observation({ work_item_id: "wi_other" }),
    );
    const controller = makeController(refresh);
    controller.start(controllerInput());
    controller.update(controllerInput({ explicit_refresh: true }));

    await vi.advanceTimersByTimeAsync(0);

    expect(controller.snapshot()).toMatchObject({
      work_item_id: "wi_other",
      attempt: 1,
      failures: 0,
      last_checked_at: null,
      refresh_failure: null,
      scheduled_delay_ms: 2_000,
    });
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each([
    {
      name: "lifecycle change",
      update: controllerInput({ run_status: "starting" }),
      delay: 2_000,
    },
    {
      name: "advanced updated_at",
      update: controllerInput({ updated_at: "2026-08-03T10:01:00.000Z" }),
      delay: 2_000,
    },
    {
      name: "work-item change",
      update: controllerInput({ work_item_id: "wi_other" }),
      delay: 2_000,
    },
    {
      name: "explicit Refresh status",
      update: controllerInput({ explicit_refresh: true }),
      delay: 0,
    },
  ])("resets cadence and failures on $name", async ({ update, delay }) => {
    const refresh = vi
      .fn<() => Promise<ShapingRefreshObservation>>()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockResolvedValue(observation());
    const controller = makeController(refresh);
    controller.start(controllerInput());
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(controller.snapshot()).toMatchObject({ attempt: 3, failures: 2 });

    controller.update(update);
    expect(controller.snapshot()).toMatchObject({
      attempt: 1,
      failures: 0,
      scheduled_delay_ms: delay,
    });
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each([
    {
      name: "lifecycle change",
      refreshed: observation({ run_status: "starting" }),
      workItemId: WORK_ITEM_ID,
      lastCheckedAt: 10_500,
    },
    {
      name: "advanced updated_at",
      refreshed: observation({
        updated_at: "2026-08-03T10:01:00.000Z",
      }),
      workItemId: WORK_ITEM_ID,
      lastCheckedAt: 10_500,
    },
    {
      name: "work-item change",
      refreshed: observation({ work_item_id: "wi_other" }),
      workItemId: "wi_other",
      lastCheckedAt: null,
    },
  ])("classifies a refresh-result $name and resets cadence", async ({
    refreshed,
    workItemId,
    lastCheckedAt,
  }) => {
    const refresh = vi
      .fn<() => Promise<ShapingRefreshObservation>>()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockResolvedValue(refreshed);
    const controller = makeController(refresh);
    controller.start(controllerInput());
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(controller.snapshot()).toMatchObject({ attempt: 3, failures: 2 });

    await vi.advanceTimersByTimeAsync(4_500);
    expect(controller.snapshot()).toMatchObject({
      work_item_id: workItemId,
      attempt: 1,
      failures: 0,
      last_checked_at: lastCheckedAt,
      refresh_failure: null,
      scheduled_delay_ms: 2_000,
    });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("records the response time when a refresh becomes terminal", async () => {
    const controller = makeController(
      vi.fn(async () => observation({ run_status: "terminal" })),
    );
    controller.start(controllerInput());

    await vi.advanceTimersByTimeAsync(2_000);
    expect(controller.snapshot()).toMatchObject({
      last_checked_at: 3_000,
      scheduled_delay_ms: null,
      stale: false,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("continues through three failures, surfaces only the third, and preserves last_checked", async () => {
    const refresh = vi
      .fn<() => Promise<ShapingRefreshObservation>>()
      .mockRejectedValueOnce(new Error("failure one"))
      .mockRejectedValueOnce(new Error("failure two"))
      .mockRejectedValueOnce(new Error("failure three"))
      .mockResolvedValue(observation());
    const controller = makeController(refresh);
    controller.start(controllerInput());

    await vi.advanceTimersByTimeAsync(2_000);
    expect(controller.snapshot()).toMatchObject({
      attempt: 2,
      failures: 1,
      last_checked_at: null,
      refresh_failure: null,
      scheduled_delay_ms: 3_000,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(controller.snapshot()).toMatchObject({
      attempt: 3,
      failures: 2,
      last_checked_at: null,
      refresh_failure: null,
      scheduled_delay_ms: 4_500,
    });
    await vi.advanceTimersByTimeAsync(4_500);
    expect(controller.snapshot()).toMatchObject({
      attempt: 4,
      failures: 3,
      last_checked_at: null,
      refresh_failure: { reason: "failure three" },
      scheduled_delay_ms: 6_750,
    });
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(6_750);
    expect(controller.snapshot()).toMatchObject({
      failures: 0,
      last_checked_at: 17_250,
      refresh_failure: null,
    });
  });

  it("ignores a late in-flight completion after stop", async () => {
    const pending = deferred<ShapingRefreshObservation>();
    let refreshSignal: AbortSignal | null = null;
    const refresh = vi.fn(
      (_observation: ShapingRefreshObservation, signal: AbortSignal) => {
        refreshSignal = signal;
        return pending.promise;
      },
    );
    const controller = makeController(refresh);
    controller.start(controllerInput());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(controller.snapshot()).toMatchObject({ refreshing: true });

    controller.stop();
    expectAborted(refreshSignal);
    pending.resolve(
      observation({ updated_at: "2026-08-03T10:02:00.000Z" }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(vi.getTimerCount()).toBe(0);
    expect(controller.snapshot()).toMatchObject({
      active: false,
      refreshing: false,
      last_checked_at: null,
    });
  });

  it("ignores an old completion after a work-item restart", async () => {
    const oldRefresh = deferred<ShapingRefreshObservation>();
    let oldSignal: AbortSignal | null = null;
    const refresh = vi.fn(
      (
        _current: ShapingRefreshObservation,
        signal: AbortSignal,
      ): Promise<ShapingRefreshObservation> => {
        if (oldSignal === null) {
          oldSignal = signal;
          return oldRefresh.promise;
        }
        return Promise.resolve(
          observation({
            work_item_id: "wi_other",
            updated_at: "2026-08-03T11:00:00.000Z",
          }),
        );
      },
    );
    const controller = makeController(refresh);
    controller.start(controllerInput());
    await vi.advanceTimersByTimeAsync(2_000);

    controller.update(controllerInput({ work_item_id: "wi_other" }));
    expectAborted(oldSignal);
    expect(vi.getTimerCount()).toBe(1);
    oldRefresh.resolve(
      observation({ updated_at: "2026-08-03T10:10:00.000Z" }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.snapshot()).toMatchObject({
      work_item_id: "wi_other",
      attempt: 1,
      last_checked_at: null,
      scheduled_delay_ms: 2_000,
    });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("publishes timer-driven snapshots and supports clean unsubscription", async () => {
    const snapshots: Array<ReturnType<
      ReturnType<typeof makeController>["snapshot"]
    >> = [];
    const controller = makeController(
      vi.fn(async () =>
        observation({ updated_at: "2026-08-03T10:01:00.000Z" }),
      ),
    );
    const unsubscribe = controller.subscribe((snapshot) => {
      snapshots.push(snapshot);
    });

    controller.start(controllerInput());
    expect(snapshots.at(-1)).toMatchObject({
      refreshing: false,
      scheduled_delay_ms: 2_000,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(snapshots).toContainEqual(
      expect.objectContaining({ refreshing: true }),
    );
    expect(snapshots.at(-1)).toMatchObject({
      refreshing: false,
      last_checked_at: 3_000,
      scheduled_delay_ms: 2_000,
    });

    unsubscribe();
    const publishedCount = snapshots.length;
    controller.stop();
    expect(snapshots).toHaveLength(publishedCount);
  });

  it("publishes surfaced failures and stale visibility transitions", async () => {
    const snapshots: Array<ReturnType<
      ReturnType<typeof makeController>["snapshot"]
    >> = [];
    const controller = makeController(
      vi.fn(async () => {
        throw new Error("status endpoint unavailable");
      }),
    );
    controller.subscribe((snapshot) => snapshots.push(snapshot));
    controller.start(controllerInput());

    await vi.advanceTimersByTimeAsync(2_000 + 3_000 + 4_500);
    expect(snapshots.at(-1)).toMatchObject({
      failures: 3,
      refresh_failure: { reason: "status endpoint unavailable" },
      stale: false,
    });

    controller.update(controllerInput({ visible: false }));
    expect(snapshots.at(-1)).toMatchObject({
      refresh_failure: { reason: "status endpoint unavailable" },
      stale: true,
      scheduled_delay_ms: null,
    });
  });
});
