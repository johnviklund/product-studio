import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  capabilityRequestMatchesEnvelope,
  resolveCapabilityEnvelope,
  type CanonicalCapabilityRequest,
  type ExecutionDefaultsV1,
} from "../../../src/domain/capability-envelope";
import type { ConnectedRunLimits } from "../../../src/domain/connected-run";
import {
  hashAcpSessionConfigOptions,
  StdioAcpClientAdapter,
  type AcpEvidenceEvent,
  type AcpEventSink,
  type AcpRuntimeProfile,
} from "../../../src/infrastructure/acp/acp-client";

const createdRoots: string[] = [];
const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../helpers/fake-acp-agent.mjs",
);
const defaults: ExecutionDefaultsV1 = {
  schema_version: 1,
  approved_command_forms: [{ executable: "npm", args: ["run", "test"] }],
  approved_url_operations: [
    {
      method: "GET",
      protocol: "https",
      host: "example.com",
      path: "/status",
    },
  ],
  mcp: "forbidden",
  credentials: "forbidden",
};
const limits: ConnectedRunLimits = {
  wall_clock_timeout_ms: 2_000,
  max_event_count: 100,
  max_event_bytes: 100_000,
  max_output_bytes: 100_000,
  termination_grace_ms: 100,
  drain_grace_ms: 100,
};

class MemoryEventSink implements AcpEventSink {
  readonly events: AcpEvidenceEvent[] = [];

  async append(event: AcpEvidenceEvent): Promise<{ limit_reached: boolean }> {
    this.events.push(event);
    return { limit_reached: false };
  }
}

class FailFirstConfigUpdateSink extends MemoryEventSink {
  private failed = false;

  override async append(
    event: AcpEvidenceEvent,
  ): Promise<{ limit_reached: boolean }> {
    if (
      !this.failed &&
      event.kind === "session_update" &&
      event.payload.update_kind === "config_option_update"
    ) {
      this.failed = true;
      throw new Error("Injected config evidence failure.");
    }
    return super.append(event);
  }
}

class NeverSettlingPermissionSink extends MemoryEventSink {
  readonly permissionStarted: Promise<void>;
  private markPermissionStarted!: () => void;

  constructor() {
    super();
    this.permissionStarted = new Promise<void>((resolveStarted) => {
      this.markPermissionStarted = resolveStarted;
    });
  }

  override async append(
    event: AcpEvidenceEvent,
  ): Promise<{ limit_reached: boolean }> {
    if (event.kind === "permission") {
      this.markPermissionStarted();
      await new Promise<void>(() => undefined);
    }
    return super.append(event);
  }
}

class NeverSettlingRunFinishedSink extends MemoryEventSink {
  override async append(
    event: AcpEvidenceEvent,
  ): Promise<{ limit_reached: boolean }> {
    if (event.kind === "run_finished") {
      await new Promise<void>(() => undefined);
    }
    return super.append(event);
  }
}

class DelayedRunFinishedSink extends MemoryEventSink {
  readonly appendStarted: Promise<void>;
  readonly appendFinished: Promise<void>;
  private markAppendStarted!: () => void;
  private releaseAppend!: () => void;
  private markAppendFinished!: () => void;
  private readonly appendReleased: Promise<void>;

  constructor() {
    super();
    this.appendStarted = new Promise<void>((resolveStarted) => {
      this.markAppendStarted = resolveStarted;
    });
    this.appendReleased = new Promise<void>((resolveReleased) => {
      this.releaseAppend = resolveReleased;
    });
    this.appendFinished = new Promise<void>((resolveFinished) => {
      this.markAppendFinished = resolveFinished;
    });
  }

  release(): void {
    this.releaseAppend();
  }

  override async append(
    event: AcpEvidenceEvent,
    signal?: AbortSignal,
  ): Promise<{ limit_reached: boolean }> {
    if (event.kind !== "run_finished") {
      return super.append(event);
    }
    this.markAppendStarted();
    await this.appendReleased;
    try {
      return signal?.aborted === true
        ? { limit_reached: false }
        : await super.append(event);
    } finally {
      this.markAppendFinished();
    }
  }
}

class RejectConcurrentAppendSink extends MemoryEventSink {
  private appendInProgress = false;
  maximumConcurrentAppends = 0;

  override async append(
    event: AcpEvidenceEvent,
  ): Promise<{ limit_reached: boolean }> {
    if (this.appendInProgress) {
      this.maximumConcurrentAppends = 2;
      throw new Error("Another event append is already in progress.");
    }
    this.appendInProgress = true;
    this.maximumConcurrentAppends = Math.max(this.maximumConcurrentAppends, 1);
    try {
      await new Promise((resolveAppend) => setTimeout(resolveAppend, 20));
      return await super.append(event);
    } finally {
      this.appendInProgress = false;
    }
  }
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "product-studio-acp-client-"));
  createdRoots.push(root);
  return root;
}

function capabilityRequest(raw: unknown): CanonicalCapabilityRequest | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const candidate = raw as Partial<CanonicalCapabilityRequest>;
  if (
    candidate.schema_version !== 1 ||
    typeof candidate.kind !== "string"
  ) {
    return null;
  }
  return candidate as CanonicalCapabilityRequest;
}

function profile(
  root: string,
  scenario: unknown,
  sentinelPath: string,
): AcpRuntimeProfile {
  const envelope = resolveCapabilityEnvelope(["src", "tests"], defaults);
  return {
    adapter_id: "fake-acp",
    executable: process.execPath,
    args: [fixturePath],
    environment: {
      PRODUCT_STUDIO_FAKE_ACP_SCENARIO: JSON.stringify(scenario),
      PRODUCT_STUDIO_FAKE_ACP_SENTINEL: sentinelPath,
    },
    workspace_cwd: root,
    evaluate_permission: (request) =>
      capabilityRequestMatchesEnvelope(request, envelope)
        ? { decision: "allow_once", reason: null }
        : {
            decision: "reject_once",
            reason: "outside_capability_envelope",
          },
    limits,
    normalize_permission: (request) => capabilityRequest(request.toolCall.rawInput),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("stdio ACP client adapter", () => {
  it("starts one zero-MCP session, auto-allows exact envelope requests, and persists ordered hashed evidence before presentation", async () => {
    const root = await createRoot();
    const sentinel = join(root, "sentinel");
    const sink = new MemoryEventSink();
    const updates: string[] = [];
    const adapter = new StdioAcpClientAdapter({
      now: () => new Date("2026-07-26T20:00:00.000Z"),
    });
    const session = await adapter.start(
      profile(
        root,
        {
          write_cwd: true,
          requests: [
            {
              schema_version: 1,
              kind: "workspace_write",
              path: "src/example.ts",
            },
            {
              schema_version: 1,
              kind: "command",
              executable: "npm",
              args: ["run", "test"],
            },
            {
              schema_version: 1,
              kind: "url",
              method: "GET",
              protocol: "https",
              host: "example.com",
              path: "/status",
            },
          ],
        },
        sentinel,
      ),
      sink,
      {
        on_session_update: async (event) => {
          expect(sink.events.at(-1)?.kind).toBe("session_update");
          updates.push(event.update_kind);
        },
      },
    );

    expect(session.requested_mcp_server_count).toBe(0);
    const result = await session.run("Apply the bounded changes.");

    expect(result).toMatchObject({ outcome: "completed", partial: false });
    expect(result.permissions).toHaveLength(3);
    expect(result.permissions.every((entry) => entry.kind === "in_envelope")).toBe(true);
    const observedCwd = (await readFile(`${sentinel}.cwd`, "utf8")).trim();
    expect(await realpath(observedCwd)).toBe(await realpath(root));
    await expect(readFile(`${sentinel}.1`, "utf8")).resolves.toBe("allowed\n");
    await expect(readFile(`${sentinel}.2`, "utf8")).resolves.toBe("allowed\n");
    await expect(readFile(`${sentinel}.3`, "utf8")).resolves.toBe("allowed\n");
    expect(updates).toContain("agent_message_chunk");
    expect(sink.events.map((event) => event.sequence)).toEqual(
      sink.events.map((_, index) => index + 1),
    );
    expect(sink.events[0]).toMatchObject({
      kind: "session_started",
      payload: { requested_mcp_server_count: 0 },
    });
    for (let index = 1; index < sink.events.length; index += 1) {
      expect(sink.events[index].previous_event_sha256).toBe(
        sink.events[index - 1].event_sha256,
      );
    }
    expect(JSON.stringify(sink.events)).not.toContain(
      "This terminal-shaped message must not become durable evidence.",
    );
  });

  it("runs a profile initializer after newSession before making mission work available", async () => {
    const root = await createRoot();
    const sink = new MemoryEventSink();
    const startupPrompts: string[] = [];
    const initialModelConfig = {
      type: "select" as const,
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "claude-opus-5",
      options: [
        { value: "gpt-5.4", name: "GPT-5.4" },
        { value: "claude-opus-5", name: "Claude Opus 5" },
      ],
    };
    const configUpdates: string[] = [];
    const sentinel = join(root, "initializer-sentinel");
    const session = await new StdioAcpClientAdapter().start(
      {
        ...profile(
          root,
          {
            session_config_options: [initialModelConfig],
            notify_set_config_option: false,
          },
          sentinel,
        ),
        initialize_session: async (initializer) => {
          expect(initializer.config_options).toEqual([initialModelConfig]);
          startupPrompts.push("/sandbox enable");
          await expect(initializer.prompt("/sandbox enable")).resolves.toEqual({
            stopReason: "end_turn",
          });
          await expect(
            initializer.set_config_option("model", "gpt-5.4"),
          ).resolves.toEqual({
            configOptions: [
              { ...initialModelConfig, currentValue: "gpt-5.4" },
            ],
          });
        },
      },
      sink,
      {
        on_session_update: (event) => {
          configUpdates.push(event.update_kind);
        },
      },
    );

    expect(startupPrompts).toEqual(["/sandbox enable"]);
    await expect(readFile(`${sentinel}.set-config`, "utf8")).resolves.toContain(
      '"configId":"model"',
    );
    expect(configUpdates).toContain("config_option_update");
    await expect(session.run("Begin the mission.")).resolves.toMatchObject({
      outcome: "completed",
    });
  });

  it("advertises and mediates write-only client filesystem capability only when a writer is supplied", async () => {
    const root = await createRoot();
    const sentinel = join(root, "client-fs-sentinel");
    const writeTextFile = vi.fn(async () => undefined);
    const target = join(root, "src", "result.json");
    const session = await new StdioAcpClientAdapter().start(
      {
        ...profile(
          root,
          {
            record_client_capabilities: true,
            client_write_path: target,
            client_write_content: '{"ok":true}\n',
          },
          sentinel,
        ),
        write_text_file: writeTextFile,
      },
      new MemoryEventSink(),
    );

    await expect(session.run("Use the client filesystem channel.")).resolves.toMatchObject({
      outcome: "completed",
      permissions: [expect.objectContaining({ kind: "in_envelope" })],
    });
    expect(writeTextFile).toHaveBeenCalledWith({
      sessionId: session.session_id,
      path: target,
      content: '{"ok":true}\n',
    }, expect.any(AbortSignal));
    await expect(
      readFile(`${sentinel}.client-capabilities`, "utf8").then(JSON.parse),
    ).resolves.toMatchObject({
      fs: { readTextFile: false, writeTextFile: true },
      terminal: false,
    });

    const disabledSentinel = join(root, "disabled-client-fs-sentinel");
    const disabled = await new StdioAcpClientAdapter().start(
      profile(
        root,
        { record_client_capabilities: true },
        disabledSentinel,
      ),
      new MemoryEventSink(),
    );
    await disabled.close();
    await expect(
      readFile(`${disabledSentinel}.client-capabilities`, "utf8").then(JSON.parse),
    ).resolves.toMatchObject({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
  });

  it("rejects a direct client filesystem write outside the runtime evaluator", async () => {
    const root = await createRoot();
    const writeTextFile = vi.fn(async () => undefined);
    const session = await new StdioAcpClientAdapter().start(
      {
        ...profile(
          root,
          {
            client_write_path: join(dirname(root), "outside-client-fs.json"),
            client_write_content: '{"blocked":true}\n',
            ignore_client_write_error: true,
          },
          join(root, "denied-client-fs-sentinel"),
        ),
        write_text_file: writeTextFile,
      },
      new MemoryEventSink(),
    );

    await expect(session.run("Try a denied client filesystem write.")).resolves.toMatchObject({
      outcome: "missing_permission",
    });
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it("serializes concurrent client filesystem writes through permission recording and persistence", async () => {
    const root = await createRoot();
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    const writeTextFile = vi.fn(async () => {
      activeWrites += 1;
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
      await new Promise((resolveWrite) => setTimeout(resolveWrite, 20));
      activeWrites -= 1;
    });
    const session = await new StdioAcpClientAdapter().start(
      {
        ...profile(
          root,
          {
            client_write_path: join(root, "src", "result.json"),
            client_write_content: '{"ok":true}\n',
            client_write_count: 2,
          },
          join(root, "concurrent-client-fs-sentinel"),
        ),
        write_text_file: writeTextFile,
      },
      new MemoryEventSink(),
    );

    await expect(session.run("Issue concurrent client filesystem writes.")).resolves.toMatchObject({
      outcome: "completed",
    });
    expect(writeTextFile).toHaveBeenCalledTimes(2);
    expect(maximumActiveWrites).toBe(1);
  });

  it("serializes startup evidence with concurrent session notifications", async () => {
    const root = await createRoot();
    const sink = new RejectConcurrentAppendSink();
    const session = await new StdioAcpClientAdapter().start(
      profile(
        root,
        { session_new_notification_delay_ms: 25 },
        join(root, "concurrent-notification-sentinel"),
      ),
      sink,
    );

    await expect(session.run("Observe the concurrent notification.")).resolves.toMatchObject({
      outcome: "completed",
    });
    expect(sink.maximumConcurrentAppends).toBe(1);
    expect(sink.events.map((event) => event.sequence)).toEqual(
      sink.events.map((_event, index) => index + 1),
    );
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        kind: "session_update",
        payload: expect.objectContaining({
          update_kind: "available_commands_update",
        }),
      }),
    );
  });

  it("allows an exact unrestricted read without invoking the capability evaluator", async () => {
    const root = await createRoot();
    const evaluator = vi.fn(() => ({
      decision: "reject_once" as const,
      reason: "request_kind_forbidden",
    }));
    const sink = new MemoryEventSink();
    const session = await new StdioAcpClientAdapter().start(
      {
        ...profile(
          root,
          {
            requests: [{ path: "TASK.md" }],
            request_tool_kinds: ["read"],
          },
          join(root, "unrestricted-read-sentinel"),
        ),
        evaluate_permission: evaluator,
        allow_unrestricted_read: (request) =>
          request.toolCall.kind === "read" &&
          request.toolCall.rawInput !== null &&
          typeof request.toolCall.rawInput === "object" &&
          "path" in request.toolCall.rawInput &&
          request.toolCall.rawInput.path === "TASK.md",
      },
      sink,
    );

    await expect(session.run("Read the immutable task.")).resolves.toMatchObject({
      outcome: "completed",
      permissions: [],
    });
    expect(evaluator).not.toHaveBeenCalled();
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        kind: "permission",
        payload: {
          decision: "unrestricted_read",
          operation_sha256: null,
          reason: null,
        },
      }),
    );
  });

  it("aborts and settles an accepted client filesystem write before cancellation completes", async () => {
    const root = await createRoot();
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolveStarted) => {
      markWriteStarted = resolveStarted;
    });
    let observedSignal: AbortSignal = new AbortController().signal;
    const session = await new StdioAcpClientAdapter().start(
      {
        ...profile(
          root,
          {
            client_write_path: join(root, "src", "result.json"),
            client_write_content: '{"ok":true}\n',
          },
          join(root, "cancel-client-fs-sentinel"),
        ),
        write_text_file: async (_request, signal) => {
          observedSignal = signal;
          markWriteStarted();
          await new Promise<void>((resolveAborted) => {
            if (signal.aborted) {
              resolveAborted();
              return;
            }
            signal.addEventListener("abort", () => resolveAborted(), {
              once: true,
            });
          });
        },
      },
      new MemoryEventSink(),
    );

    const run = session.run("Begin a delayed client filesystem write.");
    await writeStarted;
    await session.cancel();
    await expect(run).resolves.toMatchObject({ outcome: "cancelled" });
    expect(observedSignal.aborted).toBe(true);
    expect(isRunning(session.process.pid)).toBe(false);
  });

  it("bounds timeout terminalization when an accepted client filesystem writer never settles", async () => {
    const root = await createRoot();
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolveStarted) => {
      markWriteStarted = resolveStarted;
    });
    const session = await new StdioAcpClientAdapter().start(
      {
        ...profile(
          root,
          {
            client_write_path: join(root, "src", "result.json"),
            client_write_content: '{"ok":true}\n',
          },
          join(root, "timeout-client-fs-sentinel"),
        ),
        limits: {
          ...limits,
          wall_clock_timeout_ms: 30,
        },
        write_text_file: async () => {
          markWriteStarted();
          await new Promise<void>(() => undefined);
        },
      },
      new MemoryEventSink(),
    );

    const run = session.run(
      "Begin a noncooperative client filesystem write before timeout.",
    );
    await writeStarted;
    await expect(run).resolves.toMatchObject({ outcome: "timed_out" });
    expect(isRunning(session.process.pid)).toBe(false);
  });

  it("bounds timeout terminalization when permission evidence never settles before the writer", async () => {
    const root = await createRoot();
    const sink = new NeverSettlingPermissionSink();
    const writeTextFile = vi.fn(async () => undefined);
    const session = await new StdioAcpClientAdapter().start(
      {
        ...profile(
          root,
          {
            client_write_path: join(root, "src", "result.json"),
            client_write_content: '{"ok":true}\n',
          },
          join(root, "timeout-permission-sentinel"),
        ),
        limits: { ...limits, wall_clock_timeout_ms: 30 },
        write_text_file: writeTextFile,
      },
      sink,
    );

    const run = session.run("Begin a write whose permission evidence stalls.");
    await sink.permissionStarted;
    await expect(run).resolves.toMatchObject({
      outcome: "timed_out",
      permissions: [expect.objectContaining({ kind: "in_envelope" })],
    });
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(isRunning(session.process.pid)).toBe(false);
    expect(sink.events.some((event) => event.kind === "run_finished")).toBe(
      false,
    );
  });

  it("bounds the wall clock when terminal evidence never settles", async () => {
    const root = await createRoot();
    const sink = new NeverSettlingRunFinishedSink();
    const session = await new StdioAcpClientAdapter().start(
      {
        ...profile(root, {}, join(root, "terminal-evidence-sentinel")),
        limits: { ...limits, wall_clock_timeout_ms: 30 },
      },
      sink,
    );

    await expect(session.run("Complete before terminal evidence stalls.")).resolves.toMatchObject({
      outcome: "timed_out",
    });
    expect(isRunning(session.process.pid)).toBe(false);
    expect(sink.events.some((event) => event.kind === "run_finished")).toBe(
      false,
    );
  });

  it("aborts terminal evidence that reaches publication after the wall deadline", async () => {
    const root = await createRoot();
    const sink = new DelayedRunFinishedSink();
    const session = await new StdioAcpClientAdapter().start(
      {
        ...profile(root, {}, join(root, "delayed-terminal-evidence-sentinel")),
        limits: { ...limits, wall_clock_timeout_ms: 30 },
      },
      sink,
    );

    const run = session.run("Delay terminal evidence until after timeout.");
    await sink.appendStarted;
    await expect(run).resolves.toMatchObject({ outcome: "timed_out" });
    sink.release();
    await sink.appendFinished;

    expect(sink.events.some((event) => event.kind === "run_finished")).toBe(
      false,
    );
  });

  it("bounds session initialization and terminates the child when model configuration stalls", async () => {
    const root = await createRoot();
    const sink = new MemoryEventSink();
    const sentinel = join(root, "initializer-timeout-sentinel");
    const modelConfig = {
      type: "select" as const,
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "gpt-5.4",
      options: [{ value: "gpt-5.4", name: "GPT-5.4" }],
    };
    const adapter = new StdioAcpClientAdapter({
      session_initialization_timeout_ms: 20,
    });
    const outcome = await adapter
      .start(
        {
          ...profile(
            root,
            {
              session_config_options: [modelConfig],
              set_config_option_delay_ms: 150,
            },
            sentinel,
          ),
          initialize_session: async (initializer) => {
            await initializer.set_config_option("model", "gpt-5.4");
          },
        },
        sink,
      )
      .then(
        (session) => ({ kind: "resolved" as const, session }),
        (error: unknown) => ({
          kind: "rejected" as const,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    if (outcome.kind === "resolved") {
      await outcome.session.close();
    }

    expect(outcome).toEqual({
      kind: "rejected",
      message: "ACP session initialization timed out.",
    });
    const pid = Number(
      (await readFile(`${sentinel}.set-config-pid`, "utf8")).trim(),
    );
    await expect.poll(() => isRunning(pid)).toBe(false);
  });

  it("retries config-option evidence from the setter response when notification persistence fails", async () => {
    const root = await createRoot();
    const sink = new FailFirstConfigUpdateSink();
    const modelConfig = {
      type: "select" as const,
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "gpt-5.4",
      options: [{ value: "gpt-5.4", name: "GPT-5.4" }],
    };
    const updates: string[] = [];
    const session = await new StdioAcpClientAdapter().start(
      {
        ...profile(
          root,
          {
            session_config_options: [modelConfig],
            ignore_set_config_notification_failure: true,
          },
          join(root, "config-evidence-sentinel"),
        ),
        initialize_session: async (initializer) => {
          await initializer.set_config_option("model", "gpt-5.4");
        },
      },
      sink,
      {
        on_session_update: (event) => {
          updates.push(event.update_kind);
        },
      },
    );

    expect(updates).toEqual(["config_option_update"]);
    expect(
      sink.events.filter(
        (event) => event.payload.update_kind === "config_option_update",
      ),
    ).toHaveLength(1);
    await session.close();
  });

  it("rejects an exact out-of-envelope request, keeps its canonical identity, and prevents its sentinel", async () => {
    const root = await createRoot();
    const sentinel = join(root, "out-of-envelope-sentinel");
    const sink = new MemoryEventSink();
    const session = await new StdioAcpClientAdapter().start(
      profile(
        root,
        {
          requests: [
            {
              schema_version: 1,
              kind: "command",
              executable: "git",
              args: ["push"],
            },
          ],
        },
        sentinel,
      ),
      sink,
    );

    const result = await session.run("Try the blocked operation.");

    expect(result).toMatchObject({ outcome: "missing_permission", partial: true });
    expect(result.permissions).toEqual([
      expect.objectContaining({
        kind: "missing_permission",
        request: {
          schema_version: 1,
          kind: "command",
          executable: "git",
          args: ["push"],
        },
      }),
    ]);
    expect(await exists(`${sentinel}.1`)).toBe(false);
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        kind: "permission",
        payload: expect.objectContaining({ decision: "missing_permission" }),
      }),
    );
  });

  it("fails closed for unnormalizable requests and silent refusals without fabricating missing-permission attention", async () => {
    const root = await createRoot();
    const sentinel = join(root, "invalid-sentinel");
    const invalidSink = new MemoryEventSink();
    const invalidSession = await new StdioAcpClientAdapter().start(
      profile(root, { requests: [{ kind: "unknown" }] }, sentinel),
      invalidSink,
    );

    const invalidResult = await invalidSession.run("Try an unnormalizable request.");

    expect(invalidResult).toMatchObject({ outcome: "completed", partial: false });
    expect(invalidResult.permissions).toEqual([
      {
        kind: "invalid_request",
        reason: "missing_or_unnormalizable_permission_detail",
      },
    ]);
    expect(await exists(`${sentinel}.1`)).toBe(false);

    const refusalSink = new MemoryEventSink();
    const refusalSession = await new StdioAcpClientAdapter().start(
      profile(root, { kind: "silent_refusal" }, join(root, "refusal-sentinel")),
      refusalSink,
    );
    const refusalResult = await refusalSession.run("Refuse without a permission callback.");

    expect(refusalResult).toMatchObject({ outcome: "failed", partial: true });
    expect(refusalResult.permissions).toEqual([]);
    expect(refusalSink.events.some((event) => event.kind === "permission")).toBe(false);
  });

  it("bounds timeout and cancellation by terminating the detached stdio process group", async () => {
    const root = await createRoot();
    const timeoutProfile = profile(
      root,
      { delay_ms: 500 },
      join(root, "timeout-sentinel"),
    );
    const timedOutSession = await new StdioAcpClientAdapter().start(
      {
        ...timeoutProfile,
        limits: { ...limits, wall_clock_timeout_ms: 100 },
      },
      new MemoryEventSink(),
    );

    await expect(timedOutSession.run("Time out.")).resolves.toMatchObject({
      outcome: "timed_out",
      partial: true,
    });
    expect(isRunning(timedOutSession.process.pid)).toBe(false);

    const cancellingSession = await new StdioAcpClientAdapter().start(
      profile(root, { delay_ms: 500 }, join(root, "cancel-sentinel")),
      new MemoryEventSink(),
    );
    const running = cancellingSession.run("Cancel this run.");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    await cancellingSession.cancel();

    await expect(running).resolves.toMatchObject({
      outcome: "cancelled",
      partial: true,
    });
    expect(isRunning(cancellingSession.process.pid)).toBe(false);
  });

  it("records only redacted model-observation scalars and exposes initial and updated config options", async () => {
    const root = await createRoot();
    const sink = new MemoryEventSink();
    const initial = [
      {
        type: "select" as const,
        id: "model",
        name: "MODEL_NAME_CANARY",
        description: "MODEL_DESCRIPTION_CANARY",
        category: "model",
        currentValue: "gpt-5.4",
        options: [
          { value: "gpt-5.4", name: "CHOICE_NAME_CANARY" },
          { value: "gpt-5.5", name: "OTHER_CHOICE_CANARY" },
        ],
        _meta: {
          deployment_id: "regional-gpt-5.4",
          private_note: "META_CANARY",
        },
      },
    ];
    const updated = [
      {
        ...initial[0],
        currentValue: "gpt-5.5",
        _meta: {
          deployment_id: "regional-gpt-5.5",
          private_note: "UPDATED_META_CANARY",
        },
      },
    ];
    const callbacks: Array<{ kind: string; optionCount: number | null }> = [];
    const session = await new StdioAcpClientAdapter().start(
      profile(
        root,
        {
          session_config_options: initial,
          config_option_update: updated,
        },
        join(root, "model-sentinel"),
      ),
      sink,
      {
        on_session_update: (event) => {
          callbacks.push({
            kind: event.update_kind,
            optionCount: event.config_options?.length ?? null,
          });
        },
      },
    );

    expect(session.config_options).toEqual(initial);
    await expect(session.run("Observe model configuration.")).resolves.toMatchObject({
      outcome: "completed",
    });
    expect(callbacks).toContainEqual({
      kind: "agent_message_chunk",
      optionCount: null,
    });
    expect(callbacks).toContainEqual({
      kind: "config_option_update",
      optionCount: 1,
    });
    const observations = sink.events.filter(
      (event) =>
        event.kind === "session_update" &&
        ["session_new", "config_option_update"].includes(
          String(event.payload.update_kind),
        ),
    );
    expect(observations).toHaveLength(2);
    for (const observation of observations) {
      expect(Object.keys(observation.payload).sort()).toEqual([
        "model_option_count",
        "observed_event_sha256",
        "update_kind",
      ]);
      expect(observation.payload.model_option_count).toBe(1);
      expect(observation.payload.observed_event_sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
    const evidence = JSON.stringify(sink.events);
    for (const canary of [
      "MODEL_NAME_CANARY",
      "MODEL_DESCRIPTION_CANARY",
      "CHOICE_NAME_CANARY",
      "OTHER_CHOICE_CANARY",
      "META_CANARY",
      "UPDATED_META_CANARY",
    ]) {
      expect(evidence).not.toContain(canary);
    }
  });

  it("hashes only the allowed config scalars and normalizes unsafe deployment metadata to null", () => {
    const option = {
      type: "select" as const,
      id: "model",
      name: "Model display name",
      description: "Display description",
      category: "model",
      currentValue: "gpt-5.4",
      options: [{ value: "gpt-5.4", name: "Choice display name" }],
      _meta: { deployment_id: "deployment-a", private_note: "secret-a" },
    };
    const first = hashAcpSessionConfigOptions([option]);
    expect(
      hashAcpSessionConfigOptions([
        {
          ...option,
          _meta: { deployment_id: "deployment-b", private_note: "secret-b" },
        },
      ]),
    ).not.toBe(first);
    expect(
      hashAcpSessionConfigOptions([
        {
          ...option,
          name: "Renamed model",
          description: "Renamed description",
          options: [{ value: "gpt-5.4", name: "Renamed choice" }],
          _meta: { deployment_id: "deployment-a", private_note: "changed" },
        },
      ]),
    ).toBe(first);
    expect(
      hashAcpSessionConfigOptions([
        {
          ...option,
          _meta: { deployment_id: "unsafe secret deployment" },
        },
      ]),
    ).toBe(hashAcpSessionConfigOptions([{ ...option, _meta: {} }]));
  });

  it("delegates a mediated write decision to the injected shaping evaluator", async () => {
    const root = await createRoot();
    const sentinel = join(root, "shaping-evaluator-sentinel");
    const evaluator = vi.fn(() => ({
      decision: "reject_once" as const,
      reason: "write_path_not_allowed",
    }));
    const session = await new StdioAcpClientAdapter().start(
      {
        ...profile(
          root,
          {
            requests: [
              {
                schema_version: 1,
                kind: "workspace_write",
                path: "src/example.ts",
              },
            ],
          },
          sentinel,
        ),
        evaluate_permission: evaluator,
      },
      new MemoryEventSink(),
    );

    await expect(session.run("Try the shaping write.")).resolves.toMatchObject({
      outcome: "missing_permission",
    });
    expect(evaluator).toHaveBeenCalledWith({
      schema_version: 1,
      kind: "workspace_write",
      path: "src/example.ts",
    });
    expect(await exists(`${sentinel}.1`)).toBe(false);
  });
});
