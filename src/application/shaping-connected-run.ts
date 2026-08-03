import type { SessionConfigOption } from "@agentclientprotocol/sdk";

import type { EffectiveModelIdentity } from "../domain/connected-run";
import {
  evaluateShapingPermissionRequest,
  shapingRunWritePolicySchema,
  type ShapingRunWritePolicy,
} from "../domain/shaping-run";
import {
  shapingIngressInstructionSchema,
  type ShapingIngressInstructionV1,
} from "../domain/shaping";
import {
  hashAcpSessionConfigOptions,
  type AcpClientAdapter,
  type AcpRunResult,
  type AcpSession,
  type AcpSessionCallbacks,
  type AcpWriteTextFileHandler,
} from "../infrastructure/acp/acp-client";
import {
  COPILOT_ADAPTER_ID,
  COPILOT_PROFILE_ID,
  createCopilotRuntimeProfile,
  extractEffectiveModel,
  type CopilotRuntimeProfileInput,
} from "../infrastructure/acp/copilot-runtime-profile";
import type {
  ConnectedShapingRuntime,
  PreparedShapingRuntime,
  ShapingRuntimePrepareInput,
} from "./portfolio";

type AdapterAttestedEffectiveModel = Extract<
  EffectiveModelIdentity,
  { assurance: "adapter_attested" }
>;

interface ModelObservation {
  readonly source: "session_new" | "config_option_update";
  readonly config_options: readonly SessionConfigOption[];
  readonly signal: AbortSignal;
}

function signalWasAborted(signal: AbortSignal | null): boolean {
  return signal?.aborted === true;
}

async function runWithAbort<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw new Error("Model observation persistence was interrupted.");
  }
  let rejectAborted!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = () => {
    rejectAborted(new Error("Model observation persistence was interrupted."));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export interface ConnectedAcpRunHooks<RunningRecord, TerminalRecord> {
  readonly start_session: (
    callbacks: AcpSessionCallbacks,
  ) => Promise<AcpSession>;
  readonly mark_running: (session: AcpSession) => Promise<RunningRecord>;
  readonly persist_effective_model: (
    effectiveModel: AdapterAttestedEffectiveModel,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly prompt: string;
  readonly complete: (result: AcpRunResult) => Promise<TerminalRecord>;
  readonly fail: (error: unknown) => Promise<void>;
  readonly started?: (
    handle: OwnedConnectedAcpRun,
    running: RunningRecord,
  ) => void;
  readonly after_complete?: (
    result: AcpRunResult,
    terminal: TerminalRecord,
  ) => Promise<void>;
  readonly settled?: (session: AcpSession) => Promise<void>;
}

export interface StartedConnectedAcpRun<RunningRecord> {
  readonly session: AcpSession;
  readonly cancel: () => Promise<void>;
  readonly running: RunningRecord;
  readonly completion: Promise<void>;
}

export interface OwnedConnectedAcpRun {
  readonly session: AcpSession;
  readonly cancel: () => Promise<void>;
}

function observationFromUpdate(
  event: Parameters<
    NonNullable<AcpSessionCallbacks["on_session_update"]>
  >[0],
  signal: AbortSignal,
): ModelObservation | null {
  return event.config_options === null
    ? null
    : {
        source: "config_option_update",
        config_options: event.config_options,
        signal,
      };
}

async function persistObservation(
  observation: ModelObservation,
  persist: ConnectedAcpRunHooks<unknown, unknown>["persist_effective_model"],
): Promise<void> {
  const extracted = extractEffectiveModel({
    source: observation.source,
    verification: "acp_observed",
    observed_event_sha256: hashAcpSessionConfigOptions(
      observation.config_options,
    ),
    config_options: observation.config_options,
  });
  if (extracted !== null) {
    await runWithAbort(
      () =>
        persist(
          { assurance: "adapter_attested", ...extracted },
          observation.signal,
        ),
      observation.signal,
    );
  }
}

export async function startConnectedAcpRun<RunningRecord, TerminalRecord>(
  hooks: ConnectedAcpRunHooks<RunningRecord, TerminalRecord>,
): Promise<StartedConnectedAcpRun<RunningRecord>> {
  const pendingUpdates: ModelObservation[] = [];
  let runtimeSignal: AbortSignal | null = null;
  let activated = false;
  let observationQueue: Promise<void> = Promise.resolve();
  const enqueue = (observation: ModelObservation): Promise<void> => {
    observationQueue = observationQueue.then(() =>
      persistObservation(observation, hooks.persist_effective_model),
    );
    return observationQueue;
  };

  let session: AcpSession | undefined;
  try {
    session = await hooks.start_session({
      on_session_update: (event, signal) => {
        runtimeSignal = signal;
        const observation = observationFromUpdate(event, signal);
        if (observation === null) {
          return;
        }
        if (!activated) {
          pendingUpdates.push(observation);
          return;
        }
        return enqueue(observation);
      },
    });
    const running = await hooks.mark_running(session);
    const startupController = new AbortController();
    const startupTimeout = setTimeout(() => {
      startupController.abort();
    }, session.wall_clock_timeout_ms);
    startupTimeout.unref();
    try {
      await enqueue({
        source: "session_new",
        config_options: session.config_options,
        signal: startupController.signal,
      });
      for (const observation of pendingUpdates) {
        await enqueue({
          ...observation,
          signal: startupController.signal,
        });
      }
    } finally {
      clearTimeout(startupTimeout);
    }
    activated = true;

    const activeSession = session;
    let beginCompletion!: () => void;
    const completionGate = new Promise<void>((resolve) => {
      beginCompletion = resolve;
    });
    const completion = (async () => {
      await completionGate;
      try {
        const result = await activeSession.run(hooks.prompt);
        if (!signalWasAborted(runtimeSignal)) {
          await observationQueue;
        }
        const terminal = await hooks.complete(result);
        await hooks.after_complete?.(result, terminal);
      } catch (error) {
        await hooks.fail(error).catch(() => undefined);
      } finally {
        await hooks.settled?.(activeSession).catch(() => undefined);
        await activeSession.close().catch(() => undefined);
      }
    })();
    const cancel = async () => {
      await activeSession.cancel().catch(() => undefined);
      if (!signalWasAborted(runtimeSignal)) {
        await observationQueue.catch(() => undefined);
      }
      await completion;
    };
    hooks.started?.({ session: activeSession, cancel }, running);
    beginCompletion();
    return { session: activeSession, cancel, running, completion };
  } catch (error) {
    if (session !== undefined) {
      await session.close().catch(() => undefined);
    }
    await hooks.fail(error).catch(() => undefined);
    throw error;
  }
}

export function composeConnectedShapingPrompt(
  instructionInput: ShapingIngressInstructionV1,
): string {
  const instruction = shapingIngressInstructionSchema.parse(instructionInput);
  return [
    `Read the immutable shaping task at ${instruction.task_path}.`,
    `Mission content SHA-256: ${instruction.mission_content_sha256}.`,
    `Write exactly one JSON result to ${instruction.ingress_path}.`,
    `Result schema version: ${instruction.result_schema_version}.`,
    `Required fields: ${instruction.required_fields.join(", ")}.`,
    `Maximum result bytes: ${instruction.max_result_bytes}.`,
    "Do not modify workflow state, make approval decisions, or write any other path.",
  ].join("\n");
}

export interface CopilotConnectedShapingRuntimeOptions {
  readonly profile: Omit<
    CopilotRuntimeProfileInput,
    | "requested_model"
    | "required_available_tools"
    | "workspace_cwd"
    | "evaluate_permission"
    | "write_text_file"
    | "limits"
  >;
}

export class CopilotConnectedShapingRuntime implements ConnectedShapingRuntime {
  constructor(
    private readonly adapter: AcpClientAdapter,
    private readonly options: CopilotConnectedShapingRuntimeOptions,
  ) {}

  configuration() {
    return {
      adapter_id: COPILOT_ADAPTER_ID,
      adapter_version: this.options.profile.preflight.version,
      profile_id: COPILOT_PROFILE_ID,
      available_model_ids: [
        ...this.options.profile.preflight.available_model_ids,
      ],
    };
  }

  async prepare(
    input: ShapingRuntimePrepareInput,
  ): Promise<PreparedShapingRuntime> {
    const base = {
      ...this.options.profile,
      requested_model: input.requested_model,
      required_available_tools: ["view", "apply_patch"],
      workspace_cwd: input.workspace_cwd,
      limits: input.limits,
    };
    const prepared = createCopilotRuntimeProfile({
      ...base,
      write_text_file: async () => {
        throw new Error("Prepared shaping runtime cannot write before launch.");
      },
      evaluate_permission: () => ({
        decision: "reject_once",
        reason: "shaping_instruction_not_loaded",
      }),
    });
    return {
      requested_model: input.requested_model,
      reasoning_effort: this.options.profile.reasoning_effort,
      sanitized_profile: prepared.sanitized_profile_evidence,
      start: (
        instructionInput,
        policyInput,
        eventSink,
        writeTextFile: AcpWriteTextFileHandler,
        callbacks,
      ) => {
        const instruction = shapingIngressInstructionSchema.parse(
          instructionInput,
        );
        const policy: ShapingRunWritePolicy =
          shapingRunWritePolicySchema.parse(policyInput);
        const profile = createCopilotRuntimeProfile({
          ...base,
          write_text_file: writeTextFile,
          evaluate_permission: (request) =>
            evaluateShapingPermissionRequest(instruction, policy, request),
        });
        return this.adapter.start(profile.runtime_profile, eventSink, callbacks);
      },
    };
  }
}
