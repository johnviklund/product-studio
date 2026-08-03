import type {
  DecisionFirstShapingHandoffProjection,
  ShapingActionProjection,
} from "./board";

export const REFRESH_INITIAL_DELAY_MS = 2_000 as const;
export const REFRESH_BACKOFF_FACTOR = 1.5 as const;
export const REFRESH_DELAY_CAP_MS = 30_000 as const;
export const REFRESH_ATTEMPT_BUDGET = 40 as const;
export const REFRESH_FAILURE_GRACE = 3 as const;

export type ShapingActionBlockedReason =
  | "action_disabled"
  | "action_not_available"
  | "feedback_required"
  | "missing_binding"
  | "missing_model"
  | "missing_route_identity"
  | "new_attempt_selection_required"
  | "unsupported_action";

export interface ShapingActionRequestInput {
  source_id: string;
  work_item_id: string;
  projection: DecisionFirstShapingHandoffProjection;
  action: ShapingActionProjection;
  selected_model?: string | null;
  feedback?: string | null;
}

export type ShapingActionRequestResult =
  | {
      status: "ready";
      method: "POST";
      route: string;
      body: Record<string, string | null>;
    }
  | {
      status: "blocked";
      reason: ShapingActionBlockedReason;
    };

function blocked(
  reason: ShapingActionBlockedReason,
): ShapingActionRequestResult {
  return { status: "blocked", reason };
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function projectedActions(
  projection: DecisionFirstShapingHandoffProjection,
): ShapingActionProjection[] {
  const actions = "actions" in projection ? [...projection.actions] : [];
  if ("request_changes" in projection) {
    actions.push(...projection.request_changes.actions);
  }
  if (projection.mode === "terminal_run_failure") {
    actions.push(projection.manual_recovery_action);
  }
  return actions;
}

function matchingProjectedAction(
  projection: DecisionFirstShapingHandoffProjection,
  action: ShapingActionProjection,
): ShapingActionProjection | null {
  return projectedActions(projection).find(
    (candidate) =>
      candidate.kind === action.kind &&
      candidate.launch_mode === action.launch_mode,
  ) ?? null;
}

function launchFields(
  action: ShapingActionProjection,
  selectedModel: string | null | undefined,
):
  | { status: "ready"; fields: Record<string, string> }
  | { status: "blocked"; reason: ShapingActionBlockedReason } {
  if (action.launch_mode === "manual") {
    return { status: "ready", fields: { launch_mode: "manual" } };
  }
  if (action.launch_mode !== "connected") {
    return { status: "blocked", reason: "unsupported_action" };
  }
  const requestedModel = selectedModel?.trim() ?? "";
  if (requestedModel.length === 0) {
    return { status: "blocked", reason: "missing_model" };
  }
  return {
    status: "ready",
    fields: {
      launch_mode: "connected",
      requested_model: requestedModel,
    },
  };
}

function readyBindings(
  projection: DecisionFirstShapingHandoffProjection,
): {
  expected_mission_content_sha256: string;
  expected_result_content_sha256: string;
  expected_shaping_state_sha256: string;
} | null {
  if (
    projection.mode !== "ready" &&
    projection.mode !== "plan_result_superseded"
  ) {
    return null;
  }
  const bindings = projection.bindings;
  if (
    !isSha256(bindings.expected_mission_content_sha256) ||
    !isSha256(bindings.expected_result_content_sha256) ||
    !isSha256(bindings.expected_shaping_state_sha256)
  ) {
    return null;
  }
  return {
    expected_mission_content_sha256:
      bindings.expected_mission_content_sha256,
    expected_result_content_sha256:
      bindings.expected_result_content_sha256,
    expected_shaping_state_sha256:
      bindings.expected_shaping_state_sha256,
  };
}

function shapingBaseRoute(sourceId: string, workItemId: string): string {
  return `/api/portfolio/work-items/${encodeURIComponent(sourceId)}/${encodeURIComponent(workItemId)}/shaping`;
}

export function shapingActionRequest(
  input: ShapingActionRequestInput,
): ShapingActionRequestResult {
  const sourceId = input.source_id.trim();
  const workItemId = input.work_item_id.trim();
  if (sourceId.length === 0 || workItemId.length === 0) {
    return blocked("missing_route_identity");
  }
  const projectedAction = matchingProjectedAction(
    input.projection,
    input.action,
  );
  if (projectedAction === null) {
    return blocked("action_not_available");
  }
  if (!projectedAction.enabled) {
    return blocked("action_disabled");
  }

  const baseRoute = shapingBaseRoute(sourceId, workItemId);
  const action = projectedAction;
  const { projection } = input;

  if (action.kind === "open_new_attempt") {
    return blocked("new_attempt_selection_required");
  }

  if (action.kind === "retry_launch") {
    if (projection.mode !== "post_commit_launch_failure") {
      return blocked("action_not_available");
    }
    const { decision_id, expected_shaping_state_sha256 } =
      projection.bindings;
    if (
      !isSha256(decision_id) ||
      !isSha256(expected_shaping_state_sha256)
    ) {
      return blocked("missing_binding");
    }
    return {
      status: "ready",
      method: "POST",
      route: `${baseRoute}/${projection.phase}/retry-launch`,
      body: { decision_id, expected_shaping_state_sha256 },
    };
  }

  if (action.kind === "launch_phase") {
    if (
      projection.mode !== "pre_ready" &&
      projection.mode !== "terminal_run_failure"
    ) {
      return blocked("action_not_available");
    }
    const launch = launchFields(action, input.selected_model);
    if (launch.status === "blocked") {
      return blocked(launch.reason);
    }
    const requestedModel = launch.fields.requested_model;
    if (requestedModel === undefined) {
      return blocked("missing_model");
    }
    return {
      status: "ready",
      method: "POST",
      route: `${baseRoute}/${projection.phase}/connected/launch`,
      body: { requested_model: requestedModel },
    };
  }

  if (action.kind === "cancel_run") {
    if (
      projection.mode !== "run_state" ||
      projection.run.status === "terminal" ||
      !isUuid(action.shaping_run_id) ||
      action.shaping_run_id !== projection.run.shaping_run_id
    ) {
      return blocked("missing_binding");
    }
    return {
      status: "ready",
      method: "POST",
      route: `${baseRoute}/${projection.phase}/connected/cancel`,
      body: { shaping_run_id: action.shaping_run_id },
    };
  }

  if (
    action.kind !== "start_brainstorm" &&
    action.kind !== "use_brainstorm_result" &&
    action.kind !== "approve_spec" &&
    action.kind !== "request_changes" &&
    action.kind !== "replan_with_updated_contract"
  ) {
    return blocked("unsupported_action");
  }

  const launch = launchFields(action, input.selected_model);
  if (launch.status === "blocked") {
    return blocked(launch.reason);
  }

  if (action.kind === "start_brainstorm") {
    if (
      projection.mode !== "idea" ||
      !isSha256(projection.expected_shaping_state_sha256)
    ) {
      return blocked("missing_binding");
    }
    return {
      status: "ready",
      method: "POST",
      route: `${baseRoute}/start-brainstorm`,
      body: {
        ...launch.fields,
        expected_mission_content_sha256: null,
        expected_result_content_sha256: null,
        expected_shaping_state_sha256:
          projection.expected_shaping_state_sha256,
      },
    };
  }

  const bindings = readyBindings(projection);
  if (bindings === null) {
    return blocked("missing_binding");
  }

  if (action.kind === "use_brainstorm_result") {
    if (projection.mode !== "ready" || projection.phase !== "brainstorm") {
      return blocked("action_not_available");
    }
    return {
      status: "ready",
      method: "POST",
      route: `${baseRoute}/brainstorm/use-result`,
      body: { ...launch.fields, ...bindings },
    };
  }

  if (action.kind === "approve_spec") {
    if (
      projection.mode !== "ready" ||
      projection.phase !== "spec" ||
      !isSha256(projection.bindings.goal_contract_sha256)
    ) {
      return blocked("missing_binding");
    }
    return {
      status: "ready",
      method: "POST",
      route: `${baseRoute}/spec/approve`,
      body: {
        ...launch.fields,
        ...bindings,
        goal_contract_sha256: projection.bindings.goal_contract_sha256,
      },
    };
  }

  if (action.kind === "request_changes") {
    if (
      projection.mode !== "ready" &&
      projection.mode !== "plan_result_superseded"
    ) {
      return blocked("action_not_available");
    }
    const feedback = input.feedback?.trim() ?? "";
    if (feedback.length === 0) {
      return blocked("feedback_required");
    }
    return {
      status: "ready",
      method: "POST",
      route: `${baseRoute}/${projection.phase}/request-changes`,
      body: { ...launch.fields, ...bindings, feedback },
    };
  }

  if (action.kind === "replan_with_updated_contract") {
    if (
      projection.mode !== "plan_result_superseded" ||
      !isSha256(projection.bindings.goal_contract_sha256)
    ) {
      return blocked("missing_binding");
    }
    return {
      status: "ready",
      method: "POST",
      route: `${baseRoute}/plan/replan`,
      body: {
        ...launch.fields,
        ...bindings,
        goal_contract_sha256: projection.bindings.goal_contract_sha256,
      },
    };
  }

  return blocked("unsupported_action");
}

export type ShapingRefreshRunStatus = "starting" | "running" | "terminal";

export type BoundedRefreshLastOutcome =
  | { kind: "initial" }
  | { kind: "unchanged_success" }
  | { kind: "forced_success" }
  | { kind: "lifecycle_changed" }
  | { kind: "updated_at_advanced" }
  | { kind: "external_lifecycle_changed" }
  | { kind: "external_updated_at_advanced" }
  | { kind: "work_item_changed" }
  | { kind: "explicit_refresh" }
  | { kind: "visibility_restored" }
  | { kind: "failure"; reason: string };

export interface BoundedRefreshInput {
  run_status: ShapingRefreshRunStatus;
  visible: boolean;
  attempt: number;
  failures: number;
  stale: boolean;
  last_checked_at: number | null;
  refresh_failure?: { reason: string } | null;
  last_outcome: BoundedRefreshLastOutcome;
  now: number;
}

interface BoundedRefreshState {
  attempt: number;
  failures: number;
  last_checked_at: number | null;
  stale: boolean;
  refresh_failure: { reason: string } | null;
}

export type BoundedRefreshDecision =
  | (BoundedRefreshState & { kind: "schedule"; delay_ms: number })
  | (BoundedRefreshState & { kind: "stop" })
  | (BoundedRefreshState & { kind: "stale" });

function normalizedAttempt(attempt: number): number {
  return Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
}

function normalizedFailures(failures: number): number {
  return Number.isFinite(failures)
    ? Math.max(0, Math.floor(failures))
    : 0;
}

function refreshDelay(attempt: number): number {
  return Math.floor(
    Math.min(
      REFRESH_INITIAL_DELAY_MS *
        REFRESH_BACKOFF_FACTOR ** (attempt - 1),
      REFRESH_DELAY_CAP_MS,
    ),
  );
}

function isStaleRestart(outcome: BoundedRefreshLastOutcome): boolean {
  return (
    outcome.kind === "explicit_refresh" ||
    outcome.kind === "visibility_restored" ||
    outcome.kind === "work_item_changed"
  );
}

function successfulOutcome(outcome: BoundedRefreshLastOutcome): boolean {
  return (
    outcome.kind === "unchanged_success" ||
    outcome.kind === "forced_success" ||
    outcome.kind === "lifecycle_changed" ||
    outcome.kind === "updated_at_advanced"
  );
}

export function boundedRefreshMachine(
  input: BoundedRefreshInput,
): BoundedRefreshDecision {
  const currentState: BoundedRefreshState = {
    attempt: normalizedAttempt(input.attempt),
    failures: normalizedFailures(input.failures),
    last_checked_at: input.last_checked_at,
    stale: input.stale,
    refresh_failure: input.refresh_failure ?? null,
  };
  const initialState: BoundedRefreshState =
    input.last_outcome.kind === "work_item_changed"
      ? {
          attempt: 1,
          failures: 0,
          last_checked_at: null,
          stale: false,
          refresh_failure: null,
        }
      : input.last_outcome.kind === "external_lifecycle_changed" ||
          input.last_outcome.kind === "external_updated_at_advanced"
        ? {
            ...currentState,
            attempt: 1,
            failures: 0,
            refresh_failure: null,
          }
        : currentState;

  if (input.run_status === "terminal") {
    return {
      ...initialState,
      ...(successfulOutcome(input.last_outcome)
        ? {
            failures: 0,
            last_checked_at: input.now,
            refresh_failure: null,
          }
        : {}),
      stale: false,
      kind: "stop",
    };
  }

  if (!input.visible) {
    return { ...initialState, stale: true, kind: "stop" };
  }

  if (input.stale && !isStaleRestart(input.last_outcome)) {
    return { ...initialState, stale: true, kind: "stale" };
  }

  let state = { ...initialState, stale: false };
  let immediate = false;

  switch (input.last_outcome.kind) {
    case "initial":
      break;
    case "unchanged_success":
      state = {
        ...state,
        attempt: state.attempt + 1,
        failures: 0,
        last_checked_at: input.now,
        refresh_failure: null,
      };
      break;
    case "forced_success":
    case "lifecycle_changed":
    case "updated_at_advanced":
      state = {
        ...state,
        attempt: 1,
        failures: 0,
        last_checked_at: input.now,
        refresh_failure: null,
      };
      break;
    case "external_lifecycle_changed":
    case "external_updated_at_advanced":
      state = {
        ...state,
        attempt: 1,
        failures: 0,
        refresh_failure: null,
      };
      break;
    case "work_item_changed":
      state = {
        ...state,
        attempt: 1,
        failures: 0,
        last_checked_at: null,
        refresh_failure: null,
      };
      break;
    case "explicit_refresh":
    case "visibility_restored":
      state = {
        ...state,
        attempt: 1,
        failures: 0,
        refresh_failure: null,
      };
      immediate = true;
      break;
    case "failure":
      state = {
        ...state,
        attempt: state.attempt + 1,
        failures: state.failures + 1,
      };
      state = {
        ...state,
        refresh_failure:
          state.failures >= REFRESH_FAILURE_GRACE
            ? { reason: input.last_outcome.reason }
            : null,
      };
      break;
  }

  if (state.attempt > REFRESH_ATTEMPT_BUDGET) {
    return { ...state, stale: true, kind: "stale" };
  }

  return {
    ...state,
    kind: "schedule",
    delay_ms: immediate ? 0 : refreshDelay(state.attempt),
  };
}

export interface ShapingRefreshObservation {
  work_item_id: string;
  run_status: ShapingRefreshRunStatus;
  updated_at: string;
}

export interface ShapingRefreshControllerInput
  extends ShapingRefreshObservation {
  visible: boolean;
  explicit_refresh?: boolean;
}

export interface ShapingRefreshControllerSnapshot
  extends BoundedRefreshState {
  active: boolean;
  work_item_id: string | null;
  refreshing: boolean;
  scheduled_delay_ms: number | null;
}

export interface ShapingRefreshController {
  start(input: ShapingRefreshControllerInput): ShapingRefreshControllerSnapshot;
  update(input: ShapingRefreshControllerInput): ShapingRefreshControllerSnapshot;
  stop(): ShapingRefreshControllerSnapshot;
  snapshot(): ShapingRefreshControllerSnapshot;
  subscribe(
    listener: (snapshot: ShapingRefreshControllerSnapshot) => void,
  ): () => void;
}

export interface ShapingRefreshControllerDependencies<TimeoutHandle> {
  machine: (input: BoundedRefreshInput) => BoundedRefreshDecision;
  setTimeout: (callback: () => void, delayMs: number) => TimeoutHandle;
  clearTimeout: (handle: TimeoutHandle) => void;
  now: () => number;
  refresh: (
    observation: ShapingRefreshObservation,
    signal: AbortSignal,
  ) => Promise<ShapingRefreshObservation>;
}

function updatedAtAdvanced(previous: string, current: string): boolean {
  const previousTime = Date.parse(previous);
  const currentTime = Date.parse(current);
  if (Number.isFinite(previousTime) && Number.isFinite(currentTime)) {
    return currentTime > previousTime;
  }
  return current > previous;
}

function refreshFailureReason(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return "Refresh failed.";
}

export function createShapingRefreshController<TimeoutHandle>(
  dependencies: ShapingRefreshControllerDependencies<TimeoutHandle>,
): ShapingRefreshController {
  let current: ShapingRefreshControllerInput | null = null;
  let timeoutHandle: TimeoutHandle | null = null;
  let refreshAbortController: AbortController | null = null;
  let generation = 0;
  const listeners = new Set<
    (snapshot: ShapingRefreshControllerSnapshot) => void
  >();
  let state: ShapingRefreshControllerSnapshot = {
    active: false,
    work_item_id: null,
    attempt: 1,
    failures: 0,
    last_checked_at: null,
    refreshing: false,
    stale: false,
    refresh_failure: null,
    scheduled_delay_ms: null,
  };

  function copySnapshot(): ShapingRefreshControllerSnapshot {
    return {
      ...state,
      refresh_failure:
        state.refresh_failure === null ? null : { ...state.refresh_failure },
    };
  }

  function publishSnapshot(): void {
    const snapshot = copySnapshot();
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  function clearScheduledTimer(): void {
    if (timeoutHandle !== null) {
      dependencies.clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    state = { ...state, scheduled_delay_ms: null };
  }

  function cancelInFlightRefresh(): void {
    if (refreshAbortController !== null) {
      refreshAbortController.abort();
      refreshAbortController = null;
    }
    state = { ...state, refreshing: false };
  }

  function machineInput(
    outcome: BoundedRefreshLastOutcome,
    now: number,
  ): BoundedRefreshInput | null {
    if (current === null) {
      return null;
    }
    return {
      run_status: current.run_status,
      visible: current.visible,
      attempt: state.attempt,
      failures: state.failures,
      stale: state.stale,
      last_checked_at: state.last_checked_at,
      refresh_failure: state.refresh_failure,
      last_outcome: outcome,
      now,
    };
  }

  function applyDecision(
    decision: BoundedRefreshDecision,
    expectedGeneration: number,
  ): void {
    if (expectedGeneration !== generation || current === null) {
      return;
    }
    clearScheduledTimer();
    state = {
      ...state,
      attempt: decision.attempt,
      failures: decision.failures,
      last_checked_at: decision.last_checked_at,
      stale: decision.stale,
      refresh_failure: decision.refresh_failure,
      refreshing: false,
    };
    if (decision.kind === "schedule") {
      const scheduledGeneration = generation;
      const scheduledDelay = decision.delay_ms;
      state = { ...state, scheduled_delay_ms: scheduledDelay };
      timeoutHandle = dependencies.setTimeout(() => {
        timeoutHandle = null;
        state = {
          ...state,
          scheduled_delay_ms: null,
          refreshing: true,
        };
        publishSnapshot();
        void executeRefresh(scheduledGeneration, scheduledDelay === 0);
      }, scheduledDelay);
    }
    publishSnapshot();
  }

  function applyMachine(
    outcome: BoundedRefreshLastOutcome,
    now: number,
    expectedGeneration: number,
  ): void {
    const input = machineInput(outcome, now);
    if (input === null) {
      return;
    }
    applyDecision(dependencies.machine(input), expectedGeneration);
  }

  async function executeRefresh(
    scheduledGeneration: number,
    forced: boolean,
  ): Promise<void> {
    const previous = current;
    if (
      previous === null ||
      scheduledGeneration !== generation ||
      !state.active
    ) {
      return;
    }
    const abortController = new AbortController();
    refreshAbortController = abortController;
    try {
      const refreshed = await dependencies.refresh({
        work_item_id: previous.work_item_id,
        run_status: previous.run_status,
        updated_at: previous.updated_at,
      }, abortController.signal);
      if (
        scheduledGeneration !== generation ||
        current === null ||
        !state.active
      ) {
        return;
      }
      if (refreshAbortController === abortController) {
        refreshAbortController = null;
      }
      const previousObservation = current;
      current = {
        ...refreshed,
        visible: previousObservation.visible,
      };
      state = {
        ...state,
        work_item_id: refreshed.work_item_id,
        refreshing: false,
      };
      const outcome: BoundedRefreshLastOutcome =
        refreshed.work_item_id !== previousObservation.work_item_id
          ? { kind: "work_item_changed" }
          : forced
            ? { kind: "forced_success" }
            : refreshed.run_status !== previousObservation.run_status
              ? { kind: "lifecycle_changed" }
              : updatedAtAdvanced(
                    previousObservation.updated_at,
                    refreshed.updated_at,
                  )
                ? { kind: "updated_at_advanced" }
                : { kind: "unchanged_success" };
      applyMachine(outcome, dependencies.now(), scheduledGeneration);
    } catch (error) {
      if (
        scheduledGeneration !== generation ||
        current === null ||
        !state.active
      ) {
        return;
      }
      if (refreshAbortController === abortController) {
        refreshAbortController = null;
      }
      state = {
        ...state,
        refreshing: false,
      };
      applyMachine(
        { kind: "failure", reason: refreshFailureReason(error) },
        state.last_checked_at ?? 0,
        scheduledGeneration,
      );
    }
  }

  function start(
    input: ShapingRefreshControllerInput,
  ): ShapingRefreshControllerSnapshot {
    generation += 1;
    cancelInFlightRefresh();
    clearScheduledTimer();
    current = { ...input, explicit_refresh: false };
    state = {
      active: true,
      work_item_id: input.work_item_id,
      attempt: 1,
      failures: 0,
      last_checked_at: null,
      refreshing: false,
      stale: false,
      refresh_failure: null,
      scheduled_delay_ms: null,
    };
    applyMachine({ kind: "initial" }, 0, generation);
    return copySnapshot();
  }

  function update(
    input: ShapingRefreshControllerInput,
  ): ShapingRefreshControllerSnapshot {
    if (current === null || !state.active) {
      return start(input);
    }
    const previous = current;
    generation += 1;
    cancelInFlightRefresh();
    clearScheduledTimer();
    current = { ...input, explicit_refresh: false };
    state = {
      ...state,
      work_item_id: input.work_item_id,
      refreshing: false,
    };

    const outcome: BoundedRefreshLastOutcome =
      input.work_item_id !== previous.work_item_id
        ? { kind: "work_item_changed" }
        : !previous.visible && input.visible
          ? { kind: "visibility_restored" }
          : input.explicit_refresh === true
            ? { kind: "explicit_refresh" }
            : input.run_status !== previous.run_status
              ? { kind: "external_lifecycle_changed" }
              : updatedAtAdvanced(previous.updated_at, input.updated_at)
                ? { kind: "external_updated_at_advanced" }
                : { kind: "initial" };
    applyMachine(
      outcome,
      state.last_checked_at ?? 0,
      generation,
    );
    return copySnapshot();
  }

  function stop(): ShapingRefreshControllerSnapshot {
    generation += 1;
    cancelInFlightRefresh();
    clearScheduledTimer();
    current = null;
    state = {
      ...state,
      active: false,
      refreshing: false,
      scheduled_delay_ms: null,
    };
    publishSnapshot();
    return copySnapshot();
  }

  function subscribe(
    listener: (snapshot: ShapingRefreshControllerSnapshot) => void,
  ): () => void {
    listeners.add(listener);
    listener(copySnapshot());
    return () => {
      listeners.delete(listener);
    };
  }

  return {
    start,
    update,
    stop,
    snapshot: copySnapshot,
    subscribe,
  };
}
