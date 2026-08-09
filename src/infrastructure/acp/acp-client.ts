import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

import {
  canonicalizeCapabilityRequest,
  hashCanonicalCapabilityRequest,
  isPermissionRejection,
  PERMISSION_REJECTION_EXPLANATIONS,
  type CanonicalCapabilityRequest,
  type PermissionRejection,
  type PermissionRejectionReason,
} from "../../domain/capability-envelope";
import type { ConnectedRunLimits } from "../../domain/connected-run";

export type NormalizedPermissionEvaluator = (
  request: CanonicalCapabilityRequest,
) => {
  readonly decision: "allow_once" | "reject_once";
  readonly reason: string | null;
};

export type AcpWriteTextFileHandler = (
  request: acp.WriteTextFileRequest,
  signal: AbortSignal,
) => Promise<void>;

export type AcpReadTextFileHandler = (
  request: acp.ReadTextFileRequest,
  signal: AbortSignal,
) => Promise<acp.ReadTextFileResponse>;

export const readAcpWorkspaceTextFile: AcpReadTextFileHandler = async (
  request,
  signal,
) => {
  const content = await readFile(request.path, { encoding: "utf8", signal });
  const lines = content.match(/.*(?:\n|$)/gu)?.filter((line) => line !== "") ?? [];
  const start = Math.max(0, (request.line ?? 1) - 1);
  const limit = request.limit ?? lines.length;
  return { content: lines.slice(start, start + limit).join("") };
};

export interface AcpRuntimeProfile {
  readonly adapter_id: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly workspace_cwd: string;
  readonly evaluate_permission: NormalizedPermissionEvaluator;
  readonly limits: ConnectedRunLimits;
  readonly normalize_permission: (
    request: acp.RequestPermissionRequest,
  ) => CanonicalCapabilityRequest | PermissionRejection;
  readonly allow_unrestricted_read?: (
    request: acp.RequestPermissionRequest,
  ) => boolean;
  readonly read_text_file?: AcpReadTextFileHandler;
  readonly write_text_file?: AcpWriteTextFileHandler;
  readonly initialize_session?: (
    session: AcpSessionInitializer,
  ) => Promise<void>;
}

export interface AcpSessionInitializer {
  readonly config_options: readonly acp.SessionConfigOption[];
  prompt(command: string): Promise<{ readonly stopReason: acp.StopReason }>;
  set_config_option(
    configId: string,
    value: string,
  ): Promise<acp.SetSessionConfigOptionResponse>;
}

export interface AcpEventSink {
  append(
    event: AcpEvidenceEvent,
    signal?: AbortSignal,
  ): Promise<{ readonly limit_reached: boolean }>;
}

export interface AcpClientAdapter {
  start(
    profile: AcpRuntimeProfile,
    eventSink: AcpEventSink,
    callbacks?: AcpSessionCallbacks,
  ): Promise<AcpSession>;
}

export interface AcpSessionCallbacks {
  on_session_update?(
    event: AcpSessionUpdateEvent,
    signal: AbortSignal,
  ): Promise<void> | void;
}

export interface AcpSession {
  readonly session_id: string;
  readonly protocol_version: number;
  readonly requested_mcp_server_count: 0;
  readonly config_options: readonly acp.SessionConfigOption[];
  readonly wall_clock_timeout_ms: number;
  readonly process: {
    readonly pid: number;
    readonly process_group_id: number;
    readonly started_at: string;
  };
  run(prompt: string): Promise<AcpRunResult>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export type AcpRunOutcome =
  | "completed"
  | "missing_permission"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface AcpRunResult {
  readonly outcome: AcpRunOutcome;
  readonly partial: boolean;
  readonly stop_reason: acp.StopReason | null;
  readonly permissions: readonly AcpPermissionOutcome[];
  readonly output_text: string;
}

export type AcpPermissionOutcome =
  | {
      readonly kind: "in_envelope";
      readonly request: CanonicalCapabilityRequest;
      readonly operation_sha256: string;
    }
  | {
      readonly kind: "missing_permission";
      readonly request: CanonicalCapabilityRequest;
      readonly operation_sha256: string;
      readonly reason: "outside_capability_envelope";
    }
  | {
      readonly kind: "invalid_request";
      readonly reason: "missing_or_unnormalizable_permission_detail";
      readonly detail: PermissionRejectionReason;
    };

export type AcpEvidenceEvent = {
  readonly schema_version: 1;
  readonly sequence: number;
  readonly observed_at: string;
  readonly kind: "session_started" | "session_update" | "permission" | "run_finished";
  readonly payload: Record<string, string | number | boolean | null>;
  readonly previous_event_sha256: string | null;
  readonly event_sha256: string;
};

export interface AcpSessionUpdateEvent {
  readonly session_id: string;
  readonly update_kind: string;
  readonly tool_call_id: string | null;
  readonly tool_kind: string | null;
  readonly tool_status: string | null;
  readonly config_options: readonly acp.SessionConfigOption[] | null;
}

interface AcpStdioClientAdapterOptions {
  now?: () => Date;
  session_initialization_timeout_ms?: number;
  spawn_process?: (
    command: string,
    args: readonly string[],
    options: {
      cwd: string;
      detached: true;
      env: NodeJS.ProcessEnv;
      shell: false;
      stdio: ["pipe", "pipe", "pipe"];
    },
  ) => ChildProcessWithoutNullStreams;
}

class AcpClientError extends Error {}

class AcpEventLimitError extends AcpClientError {}

class AcpTimeoutError extends AcpClientError {}

const ACP_HANDSHAKE_TIMEOUT_MS = 5_000;
const ACP_SESSION_INITIALIZATION_TIMEOUT_MS = 30_000;
const SAFE_CONFIG_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function hashEvent(event: Omit<AcpEvidenceEvent, "event_sha256">): string {
  return createHash("sha256")
    .update(`${canonicalJson(event)}\n`)
    .digest("hex");
}

function configOptionValues(
  options: acp.SessionConfigSelectOptions,
): string[] {
  return options.flatMap((option) =>
    "group" in option
      ? option.options.map((choice) => choice.value)
      : [option.value],
  );
}

function sanitizedDeploymentId(option: acp.SessionConfigOption): string | null {
  const value = option._meta?.deployment_id;
  return typeof value === "string" && SAFE_CONFIG_IDENTIFIER.test(value)
    ? value
    : null;
}

function sanitizedConfigOption(option: acp.SessionConfigOption) {
  const common = {
    id: option.id,
    type: option.type,
    category: option.category ?? null,
    currentValue: option.currentValue,
    deployment_id: sanitizedDeploymentId(option),
  };
  return option.type === "select"
    ? { ...common, values: configOptionValues(option.options) }
    : { ...common, values: [] as string[] };
}

export function hashAcpSessionConfigOptions(
  options: readonly acp.SessionConfigOption[],
): string {
  return createHash("sha256")
    .update(`${canonicalJson(options.map(sanitizedConfigOption))}\n`)
    .digest("hex");
}

function modelOptionCount(options: readonly acp.SessionConfigOption[]): number {
  return options.filter((option) => option.category === "model").length;
}

function selectOption(
  options: readonly acp.PermissionOption[],
  kind: "allow_once" | "reject_once",
): acp.RequestPermissionResponse {
  const selected = options.find((option) => option.kind === kind);
  return selected === undefined
    ? { outcome: { outcome: "cancelled" } }
    : {
        outcome: {
          outcome: "selected",
          optionId: selected.optionId,
        },
      };
}

function validateRuntimeProfile(profile: AcpRuntimeProfile): AcpRuntimeProfile {
  if (
    profile.adapter_id.trim() === "" ||
    profile.executable.trim() === "" ||
    !isAbsolute(profile.workspace_cwd) ||
    resolve(profile.workspace_cwd) !== profile.workspace_cwd ||
    profile.args.some((arg) => arg.includes("\u0000"))
  ) {
    throw new AcpClientError("Invalid ACP runtime profile.");
  }
  if (
    !Number.isSafeInteger(profile.limits.wall_clock_timeout_ms) ||
    profile.limits.wall_clock_timeout_ms <= 0 ||
    !Number.isSafeInteger(profile.limits.max_output_bytes) ||
    profile.limits.max_output_bytes <= 0 ||
    !Number.isSafeInteger(profile.limits.max_event_count) ||
    profile.limits.max_event_count <= 0 ||
    !Number.isSafeInteger(profile.limits.max_event_bytes) ||
    profile.limits.max_event_bytes <= 0 ||
    !Number.isSafeInteger(profile.limits.termination_grace_ms) ||
    profile.limits.termination_grace_ms < 0 ||
    !Number.isSafeInteger(profile.limits.drain_grace_ms) ||
    profile.limits.drain_grace_ms < 0
  ) {
    throw new AcpClientError("Invalid ACP runtime limits.");
  }
  return profile;
}

function normalizeWriteTextFileRequest(
  request: acp.WriteTextFileRequest,
  workspaceCwd: string,
): CanonicalCapabilityRequest | null {
  if (!isAbsolute(request.path)) {
    return null;
  }
  const absolutePath = resolve(request.path);
  const workspaceRelativePath = relative(workspaceCwd, absolutePath);
  if (
    workspaceRelativePath === "" ||
    workspaceRelativePath === ".." ||
    workspaceRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(workspaceRelativePath)
  ) {
    return workspaceRelativePath === ""
      ? null
      : {
          schema_version: 1,
          kind: "outside_workspace_write",
          path: absolutePath,
        };
  }
  return {
    schema_version: 1,
    kind: "workspace_write",
    path: workspaceRelativePath.split(sep).join("/"),
  };
}

function isWorkspaceDescendant(workspaceCwd: string, candidate: string): boolean {
  const workspaceRelativePath = relative(workspaceCwd, candidate);
  return (
    workspaceRelativePath !== "" &&
    workspaceRelativePath !== ".." &&
    !workspaceRelativePath.startsWith(`..${sep}`) &&
    !isAbsolute(workspaceRelativePath)
  );
}

async function normalizeReadTextFileRequest(
  request: acp.ReadTextFileRequest,
  workspaceCwd: string,
): Promise<acp.ReadTextFileRequest | null> {
  if (!isAbsolute(request.path)) {
    return null;
  }
  const absolutePath = resolve(request.path);
  if (!isWorkspaceDescendant(workspaceCwd, absolutePath)) {
    return null;
  }
  try {
    const [canonicalWorkspace, canonicalPath] = await Promise.all([
      realpath(workspaceCwd),
      realpath(absolutePath),
    ]);
    if (!isWorkspaceDescendant(canonicalWorkspace, canonicalPath)) {
      return null;
    }
    return { ...request, path: canonicalPath };
  } catch {
    return null;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  });
}

function abortWasRequested(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

async function withinTimeout<T>(
  operation: Promise<T>,
  timeoutMilliseconds: number,
  message = "ACP handshake timed out.",
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new AcpTimeoutError(message));
        }, timeoutMilliseconds);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

class AcpEvidenceRecorder {
  private sequence = 0;
  private previousEventSha256: string | null = null;
  private retainedBytes = 0;
  private recordQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly sink: AcpEventSink,
    private readonly maxEventBytes: number,
    private readonly now: () => Date,
  ) {}

  async record(
    kind: AcpEvidenceEvent["kind"],
    payload: AcpEvidenceEvent["payload"],
    signal?: AbortSignal,
  ): Promise<void> {
    const queued = this.recordQueue.then(() =>
      this.recordNow(kind, payload, signal),
    );
    this.recordQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private async recordNow(
    kind: AcpEvidenceEvent["kind"],
    payload: AcpEvidenceEvent["payload"],
    signal?: AbortSignal,
  ): Promise<void> {
    if (abortWasRequested(signal)) {
      throw new AcpClientError("ACP evidence recording was interrupted.");
    }
    const eventWithoutHash = {
      schema_version: 1 as const,
      sequence: this.sequence + 1,
      observed_at: this.now().toISOString(),
      kind,
      payload,
      previous_event_sha256: this.previousEventSha256,
    };
    const event: AcpEvidenceEvent = {
      ...eventWithoutHash,
      event_sha256: hashEvent(eventWithoutHash),
    };
    const eventBytes = Buffer.byteLength(`${canonicalJson(event)}\n`, "utf8");
    if (this.retainedBytes + eventBytes > this.maxEventBytes) {
      throw new AcpEventLimitError("ACP event output limit reached.");
    }
    const result = await this.sink.append(event, signal);
    if (abortWasRequested(signal)) {
      throw new AcpClientError("ACP evidence recording was interrupted.");
    }
    if (result.limit_reached) {
      throw new AcpEventLimitError("Connected-run event limit reached.");
    }
    this.sequence = event.sequence;
    this.previousEventSha256 = event.event_sha256;
    this.retainedBytes += eventBytes;
  }
}

const MAX_UNINTERPRETABLE_CONTINUATIONS = 2;

function buildUninterpretableRequestGuidance(
  reasons: readonly PermissionRejectionReason[],
): string {
  const explanations = [...new Set(reasons)].map(
    (reason) => PERMISSION_REJECTION_EXPLANATIONS[reason],
  );
  return [
    "Your previous request was refused before it reached the founder, because the runtime could not interpret it:",
    ...explanations.map((explanation) => `- ${explanation}`),
    "This was not a denial of the work itself, and nothing about the task has changed. Reissue the request in a form the runtime can read, or continue without it, and then finish the mission and write the required result file.",
  ].join("\n");
}

class StdioAcpSession implements AcpSession {
  readonly session_id: string;
  readonly protocol_version: number;
  readonly requested_mcp_server_count = 0 as const;
  readonly config_options: readonly acp.SessionConfigOption[];
  readonly process: { pid: number; process_group_id: number; started_at: string };

  private readonly permissionOutcomes: AcpPermissionOutcome[] = [];
  private finalTurnStart = 0;
  private runInFlight = false;
  private closed = false;
  private cancellationRequested = false;
  private processClosed: Promise<void>;
  private callbackQueue: Promise<void> = Promise.resolve();
  private lastConfigOptionsSha256: string | null = null;
  private readonly writeAbortController = new AbortController();
  private outputText = "";
  private observedOutputBytes = 0;
  private outputLimitExceeded = false;

  get wall_clock_timeout_ms(): number {
    return this.profile.limits.wall_clock_timeout_ms;
  }

  constructor(
    private readonly profile: AcpRuntimeProfile,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly connection: acp.ClientConnection,
    private readonly activeSession: acp.ActiveSession,
    protocolVersion: number,
    private readonly recorder: AcpEvidenceRecorder,
    private readonly callbacks: AcpSessionCallbacks,
    private readonly now: () => Date,
  ) {
    this.session_id = activeSession.sessionId;
    this.protocol_version = protocolVersion;
    this.config_options = activeSession.newSessionResponse.configOptions ?? [];
    const pid = child.pid;
    if (pid === undefined) {
      throw new AcpClientError("ACP process did not provide a process ID.");
    }
    this.process = {
      pid,
      process_group_id: pid,
      started_at: now().toISOString(),
    };
    this.processClosed = new Promise((resolveClosed) => {
      child.once("close", () => resolveClosed());
      child.once("error", () => resolveClosed());
    });
  }

  async run(prompt: string): Promise<AcpRunResult> {
    if (this.closed || this.runInFlight || prompt.trim() === "") {
      throw new AcpClientError("ACP session cannot start this prompt.");
    }
    this.runInFlight = true;
    this.outputText = "";
    this.observedOutputBytes = 0;
    this.outputLimitExceeded = false;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new AcpTimeoutError("ACP run timed out."));
        }, this.profile.limits.wall_clock_timeout_ms);
        timeout.unref();
      });
      const response = await Promise.race([
        this.activeSession.prompt(prompt),
        timedOut,
      ]);
      await Promise.race([this.callbackQueue, timedOut]);
      const finalResponse = await this.continuePastUninterpretableRequests(
        response,
        timedOut,
      );
      if (this.outputLimitExceeded) {
        throw new AcpEventLimitError("ACP agent output exceeded its byte limit.");
      }
      const result = this.resultFromStopReason(finalResponse.stopReason);
      await Promise.race([
        this.recorder.record(
          "run_finished",
          {
            outcome: result.outcome,
            partial: result.partial,
            stop_reason: result.stop_reason,
          },
          this.writeAbortController.signal,
        ),
        timedOut,
      ]);
      await this.close();
      return result;
    } catch (error) {
      await this.close(true);
      await this.callbackQueue;
      const result = this.resultFromError(error);
      return result;
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      this.runInFlight = false;
    }
  }

  async cancel(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.cancellationRequested = true;
    this.writeAbortController.abort();
    try {
      await this.connection.agent.notify(acp.methods.agent.session.cancel, {
        sessionId: this.session_id,
      });
    } finally {
      await this.close(true);
      await this.callbackQueue;
    }
  }

  async close(force = false): Promise<void> {
    if (force) {
      this.writeAbortController.abort();
    }
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.activeSession.dispose();
    this.connection.close();
    this.child.stdin.end();

    if (!force) {
      const drained = await Promise.race([
        this.processClosed.then(() => true),
        sleep(this.profile.limits.drain_grace_ms).then(() => false),
      ]);
      if (drained) {
        return;
      }
    }

    this.signalGroup("SIGTERM");
    const terminated = await Promise.race([
      this.processClosed.then(() => true),
      sleep(this.profile.limits.termination_grace_ms).then(() => false),
    ]);
    if (terminated) {
      return;
    }
    this.signalGroup("SIGKILL");
    await Promise.race([
      this.processClosed,
      sleep(this.profile.limits.drain_grace_ms),
    ]);
  }

  async handleSessionUpdate(
    notification: acp.SessionNotification,
  ): Promise<void> {
    return this.enqueueCallback(async () => {
      const signal = this.writeAbortController.signal;
      this.captureOutputText(notification);
      const event = summarizeSessionUpdate(notification);
      const configOptionsSha256 =
        event.config_options === null
          ? null
          : hashAcpSessionConfigOptions(event.config_options);
      await this.recorder.record(
        "session_update",
        event.config_options === null
          ? {
              session_id: event.session_id,
              update_kind: event.update_kind,
              tool_call_id: event.tool_call_id,
              tool_kind: event.tool_kind,
              tool_status: event.tool_status,
            }
          : {
              update_kind: event.update_kind,
              model_option_count: modelOptionCount(event.config_options),
              observed_event_sha256: configOptionsSha256,
            },
        signal,
      );
      if (signal.aborted) {
        throw new AcpClientError("ACP session update was interrupted.");
      }
      await this.callbacks.on_session_update?.(event, signal);
      if (configOptionsSha256 !== null) {
        this.lastConfigOptionsSha256 = configOptionsSha256;
      }
    });
  }

  private captureOutputText(notification: acp.SessionNotification): void {
    if (!this.runInFlight) {
      return;
    }
    const update = notification.update;
    if (update.sessionUpdate === "tool_call") {
      this.outputText = "";
      return;
    }
    if (
      update.sessionUpdate !== "agent_message_chunk" ||
      update.content.type !== "text"
    ) {
      return;
    }
    this.observedOutputBytes += Buffer.byteLength(update.content.text, "utf8");
    if (this.observedOutputBytes > this.profile.limits.max_output_bytes) {
      this.outputLimitExceeded = true;
      throw new AcpEventLimitError("ACP agent output exceeded its byte limit.");
    }
    this.outputText += update.content.text;
  }

  async handleConfigOptionResponse(
    configOptions: readonly acp.SessionConfigOption[],
  ): Promise<void> {
    await this.callbackQueue;
    if (
      this.lastConfigOptionsSha256 ===
      hashAcpSessionConfigOptions(configOptions)
    ) {
      return;
    }
    await this.handleSessionUpdate({
      sessionId: this.session_id,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [...configOptions],
      },
    });
  }

  async handlePermission(
    request: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    return this.enqueueCallback(() => this.handlePermissionRequest(request));
  }

  private async handlePermissionRequest(
    request: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    let unrestrictedRead = false;
    try {
      unrestrictedRead =
        this.profile.allow_unrestricted_read?.(request) === true;
    } catch {
      unrestrictedRead = false;
    }
    if (unrestrictedRead) {
      await this.recorder.record(
        "permission",
        {
          decision: "unrestricted_read",
          operation_sha256: null,
          reason: null,
        },
        this.writeAbortController.signal,
      );
      const allowed = selectOption(request.options, "allow_once");
      if (allowed.outcome.outcome !== "selected") {
        throw new AcpClientError("ACP request did not offer one-run approval.");
      }
      return allowed;
    }

    let normalized: CanonicalCapabilityRequest | PermissionRejection;
    try {
      const candidate = this.profile.normalize_permission(request);
      normalized = isPermissionRejection(candidate)
        ? candidate
        : canonicalizeCapabilityRequest(candidate);
    } catch {
      normalized = { rejected: "command_form_not_approvable" };
    }

    const decision = await this.recordPermissionEvaluation(normalized);
    if (decision === "invalid") {
      return selectOption(request.options, "reject_once");
    }
    if (decision === "allow") {
      const allowed = selectOption(request.options, "allow_once");
      if (allowed.outcome.outcome !== "selected") {
        throw new AcpClientError("ACP request did not offer one-run approval.");
      }
      return allowed;
    }
    return selectOption(request.options, "reject_once");
  }

  async handleWriteTextFile(
    request: acp.WriteTextFileRequest,
    writer: AcpWriteTextFileHandler,
  ): Promise<void> {
    if (request.sessionId !== this.session_id) {
      throw new AcpClientError("ACP client filesystem session does not match.");
    }
    await this.enqueueCallback(async () => {
      if (this.writeAbortController.signal.aborted) {
        throw new AcpClientError("ACP client filesystem write was interrupted.");
      }
      const normalized = normalizeWriteTextFileRequest(
        request,
        this.profile.workspace_cwd,
      );
      const decision = await this.recordPermissionEvaluation(
        normalized ?? { rejected: "path_not_uniquely_identified" },
      );
      if (decision !== "allow") {
        throw new AcpClientError("ACP client filesystem write was denied.");
      }
      await writer(request, this.writeAbortController.signal);
    });
  }

  async handleReadTextFile(
    request: acp.ReadTextFileRequest,
    reader: AcpReadTextFileHandler,
  ): Promise<acp.ReadTextFileResponse> {
    if (request.sessionId !== this.session_id) {
      throw new AcpClientError("ACP client filesystem session does not match.");
    }
    return this.enqueueCallback(async () => {
      if (this.writeAbortController.signal.aborted) {
        throw new AcpClientError("ACP client filesystem read was interrupted.");
      }
      const normalized = await normalizeReadTextFileRequest(
        request,
        this.profile.workspace_cwd,
      );
      if (normalized === null) {
        throw new AcpClientError("ACP client filesystem read was denied.");
      }
      return reader(normalized, this.writeAbortController.signal);
    });
  }

  private async recordPermissionEvaluation(
    normalized: CanonicalCapabilityRequest | PermissionRejection,
  ): Promise<"allow" | "reject" | "invalid"> {
    if (isPermissionRejection(normalized)) {
      this.permissionOutcomes.push({
        kind: "invalid_request",
        reason: "missing_or_unnormalizable_permission_detail",
        detail: normalized.rejected,
      });
      await this.recorder.record(
        "permission",
        {
          decision: "invalid_request",
          operation_sha256: null,
          reason: "missing_or_unnormalizable_permission_detail",
          detail: normalized.rejected,
        },
        this.writeAbortController.signal,
      );
      return "invalid";
    }

    const canonical = canonicalizeCapabilityRequest(normalized);
    const operationSha256 = hashCanonicalCapabilityRequest(canonical);
    const evaluation = this.profile.evaluate_permission(canonical);
    if (evaluation.decision === "allow_once") {
      this.permissionOutcomes.push({
        kind: "in_envelope",
        request: canonical,
        operation_sha256: operationSha256,
      });
      await this.recorder.record(
        "permission",
        {
          decision: "in_envelope",
          operation_sha256: operationSha256,
          reason: null,
        },
        this.writeAbortController.signal,
      );
      return "allow";
    }

    this.permissionOutcomes.push({
      kind: "missing_permission",
      request: canonical,
      operation_sha256: operationSha256,
      reason: "outside_capability_envelope",
    });
    await this.recorder.record(
      "permission",
      {
        decision: "missing_permission",
        operation_sha256: operationSha256,
        reason: "outside_capability_envelope",
      },
      this.writeAbortController.signal,
    );
    return "reject";
  }

  private enqueueCallback<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.callbackQueue.then(() =>
      this.invokeCallbackWithAbort(operation),
    );
    this.callbackQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private async invokeCallbackWithAbort<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const signal = this.writeAbortController.signal;
    if (signal.aborted) {
      throw new AcpClientError("ACP callback was interrupted.");
    }
    let rejectAborted!: (error: AcpClientError) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject;
    });
    const onAbort = () => {
      rejectAborted(new AcpClientError("ACP callback was interrupted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const running = Promise.resolve().then(operation);
    try {
      return await Promise.race([running, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * An agent that is refused an uninterpretable request typically ends its turn
   * immediately, abandoning the mission over a single malformed command. The
   * permission response itself carries no room to say why, so the explanation is
   * delivered the only way the protocol allows: another turn in the same
   * session. This is bounded, and it never grants anything — the agent still has
   * to make a request the runtime can interpret.
   */
  private async continuePastUninterpretableRequests(
    response: { readonly stopReason: acp.StopReason },
    timedOut: Promise<never>,
  ): Promise<{ readonly stopReason: acp.StopReason }> {
    let current = response;
    for (
      let continuation = 0;
      continuation < MAX_UNINTERPRETABLE_CONTINUATIONS;
      continuation += 1
    ) {
      if (current.stopReason !== "end_turn") {
        return current;
      }
      const unexplained = this.permissionOutcomes
        .slice(this.finalTurnStart)
        .flatMap((outcome) =>
          outcome.kind === "invalid_request" ? [outcome.detail] : [],
        );
      if (unexplained.length === 0) {
        return current;
      }
      this.finalTurnStart = this.permissionOutcomes.length;
      current = await Promise.race([
        this.activeSession.prompt(
          buildUninterpretableRequestGuidance(unexplained),
        ),
        timedOut,
      ]);
      await Promise.race([this.callbackQueue, timedOut]);
    }
    return current;
  }

  private resultFromStopReason(stopReason: acp.StopReason): AcpRunResult {
    const hasMissingPermission = this.permissionOutcomes.some(
      (outcome) => outcome.kind === "missing_permission",
    );
    if (hasMissingPermission) {
      return {
        outcome: "missing_permission",
        partial: true,
        stop_reason: stopReason,
        permissions: [...this.permissionOutcomes],
        output_text: this.outputText,
      };
    }
    const hasInvalidRequest = this.permissionOutcomes
      .slice(this.finalTurnStart)
      .some((outcome) => outcome.kind === "invalid_request");
    if (hasInvalidRequest) {
      return {
        outcome: "failed",
        partial: true,
        stop_reason: stopReason,
        permissions: [...this.permissionOutcomes],
        output_text: this.outputText,
      };
    }
    if (stopReason === "end_turn") {
      return {
        outcome: "completed",
        partial: false,
        stop_reason: stopReason,
        permissions: [...this.permissionOutcomes],
        output_text: this.outputText,
      };
    }
    return {
      outcome: stopReason === "cancelled" ? "cancelled" : "failed",
      partial: true,
      stop_reason: stopReason,
      permissions: [...this.permissionOutcomes],
      output_text: this.outputText,
    };
  }

  private resultFromError(error: unknown): AcpRunResult {
    return {
      outcome:
        this.cancellationRequested
          ? "cancelled"
          : error instanceof AcpTimeoutError
          ? "timed_out"
          : error instanceof AcpEventLimitError
            ? "failed"
            : "failed",
      partial: true,
      stop_reason: null,
      permissions: [...this.permissionOutcomes],
      output_text: this.outputText,
    };
  }

  private signalGroup(signal: NodeJS.Signals): void {
    try {
      process.kill(-this.process.process_group_id, signal);
      return;
    } catch {
      // The group can already be gone; direct-child signalling is the bounded fallback.
    }
    try {
      this.child.kill(signal);
    } catch {
      // The drain timer remains the final bounded cleanup path.
    }
  }
}

function summarizeSessionUpdate(
  notification: acp.SessionNotification,
): AcpSessionUpdateEvent {
  const update = notification.update;
  const isToolUpdate =
    update.sessionUpdate === "tool_call" ||
    update.sessionUpdate === "tool_call_update";
  return {
    session_id: notification.sessionId,
    update_kind: update.sessionUpdate,
    tool_call_id: isToolUpdate ? update.toolCallId : null,
    tool_kind: isToolUpdate ? (update.kind ?? null) : null,
    tool_status: isToolUpdate ? (update.status ?? null) : null,
    config_options:
      update.sessionUpdate === "config_option_update"
        ? update.configOptions
        : null,
  };
}

export class StdioAcpClientAdapter implements AcpClientAdapter {
  private readonly now: () => Date;
  private readonly sessionInitializationTimeoutMs: number;
  private readonly spawnProcess: NonNullable<
    AcpStdioClientAdapterOptions["spawn_process"]
  >;

  constructor(options: AcpStdioClientAdapterOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.sessionInitializationTimeoutMs =
      options.session_initialization_timeout_ms ??
      ACP_SESSION_INITIALIZATION_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.sessionInitializationTimeoutMs) ||
      this.sessionInitializationTimeoutMs <= 0
    ) {
      throw new AcpClientError("Invalid ACP session initialization timeout.");
    }
    this.spawnProcess = options.spawn_process ?? spawn;
  }

  async start(
    input: AcpRuntimeProfile,
    eventSink: AcpEventSink,
    callbacks: AcpSessionCallbacks = {},
  ): Promise<AcpSession> {
    const profile = validateRuntimeProfile(input);
    const environment = Object.assign(Object.create(null), profile.environment) as NodeJS.ProcessEnv;
    const child = this.spawnProcess(profile.executable, profile.args, {
      cwd: profile.workspace_cwd,
      detached: true,
      env: environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const recorder = new AcpEvidenceRecorder(
      eventSink,
      profile.limits.max_event_bytes,
      this.now,
    );

    let session: StdioAcpSession | null = null;
    const application = acp
      .client({ name: "product-studio" })
      .onRequest(acp.methods.client.session.requestPermission, async (context) => {
        if (session === null) {
          return { outcome: { outcome: "cancelled" } };
        }
        return session.handlePermission(context.params);
      })
      .onNotification(acp.methods.client.session.update, async (context) => {
        if (session !== null) {
          await session.handleSessionUpdate(context.params);
        }
      })
      .onRequest(acp.methods.client.fs.readTextFile, async (context) => {
        if (session === null || profile.read_text_file === undefined) {
          throw new AcpClientError("ACP client filesystem reads are unavailable.");
        }
        return session.handleReadTextFile(
          context.params,
          profile.read_text_file,
        );
      })
      .onRequest(acp.methods.client.fs.writeTextFile, async (context) => {
        if (session === null || profile.write_text_file === undefined) {
          throw new AcpClientError("ACP client filesystem writes are unavailable.");
        }
        await session.handleWriteTextFile(
          context.params,
          profile.write_text_file,
        );
        return {};
      });

    try {
      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
      );
      const connection = application.connect(stream);
      const initialized = await withinTimeout(
        connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: {
              readTextFile: profile.read_text_file !== undefined,
              writeTextFile: profile.write_text_file !== undefined,
            },
          },
        }),
        ACP_HANDSHAKE_TIMEOUT_MS,
      );
      if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
        connection.close();
        child.kill("SIGTERM");
        throw new AcpClientError("ACP protocol version is incompatible.");
      }
      const activeSession = await withinTimeout(
        connection.agent
          .buildSession({ cwd: profile.workspace_cwd, mcpServers: [] })
          .start(),
        ACP_HANDSHAKE_TIMEOUT_MS,
      );
      session = new StdioAcpSession(
        profile,
        child,
        connection,
        activeSession,
        initialized.protocolVersion,
        recorder,
        callbacks,
        this.now,
      );
      const initializedSession = session;
      await recorder.record("session_started", {
        adapter_id: profile.adapter_id,
        protocol_version: initialized.protocolVersion,
        requested_mcp_server_count: 0,
        session_id: initializedSession.session_id,
      });
      await recorder.record("session_update", {
        update_kind: "session_new",
        model_option_count: modelOptionCount(initializedSession.config_options),
        observed_event_sha256: hashAcpSessionConfigOptions(
          initializedSession.config_options,
        ),
      });
      if (profile.initialize_session !== undefined) {
        await withinTimeout(
          profile.initialize_session({
            config_options: initializedSession.config_options,
            prompt: async (command) => activeSession.prompt(command),
            set_config_option: async (configId, value) => {
              const response = await connection.agent.request(
                acp.methods.agent.session.setConfigOption,
                {
                  sessionId: activeSession.sessionId,
                  configId,
                  value,
                },
              );
              await initializedSession.handleConfigOptionResponse(
                response.configOptions,
              );
              return response;
            },
          }),
          this.sessionInitializationTimeoutMs,
          "ACP session initialization timed out.",
        );
      }
      return initializedSession;
    } catch (error) {
      await session?.close(true);
      child.kill("SIGTERM");
      throw error;
    }
  }
}
