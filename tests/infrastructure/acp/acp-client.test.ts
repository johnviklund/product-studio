import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveCapabilityEnvelope,
  type CanonicalCapabilityRequest,
  type ExecutionDefaultsV1,
} from "../../../src/domain/capability-envelope";
import type { ConnectedRunLimits } from "../../../src/domain/connected-run";
import {
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
  return {
    adapter_id: "fake-acp",
    executable: process.execPath,
    args: [fixturePath],
    environment: {
      PRODUCT_STUDIO_FAKE_ACP_SCENARIO: JSON.stringify(scenario),
      PRODUCT_STUDIO_FAKE_ACP_SENTINEL: sentinelPath,
    },
    workspace_cwd: root,
    capability_envelope: resolveCapabilityEnvelope(["src", "tests"], defaults),
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
    const session = await new StdioAcpClientAdapter().start(
      {
        ...profile(root, {}, join(root, "initializer-sentinel")),
        initialize_session: async (initializer) => {
          startupPrompts.push("/sandbox enable");
          await expect(initializer.prompt("/sandbox enable")).resolves.toEqual({
            stopReason: "end_turn",
          });
        },
      },
      sink,
    );

    expect(startupPrompts).toEqual(["/sandbox enable"]);
    await expect(session.run("Begin the mission.")).resolves.toMatchObject({
      outcome: "completed",
    });
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
});
