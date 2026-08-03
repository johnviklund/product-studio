import { describe, expect, it, vi } from "vitest";

import { startConnectedAcpRun } from "../../src/application/shaping-connected-run";
import type {
  AcpSession,
  AcpSessionCallbacks,
} from "../../src/infrastructure/acp/acp-client";

describe("connected ACP run orchestration", () => {
  it("bounds initial effective-model persistence before starting the prompt", async () => {
    const session: AcpSession = {
      session_id: "initial-model-timeout-session",
      protocol_version: 1,
      requested_mcp_server_count: 0,
      config_options: [
        {
          type: "select",
          id: "model",
          name: "Model",
          category: "model",
          currentValue: "model-a",
          options: [{ value: "model-a", name: "Model A" }],
        },
      ],
      wall_clock_timeout_ms: 30,
      process: {
        pid: 1233,
        process_group_id: 1233,
        started_at: "2026-08-03T19:59:00.000Z",
      },
      run: vi.fn(async () => ({
        outcome: "completed" as const,
        partial: false,
        stop_reason: "end_turn" as const,
        permissions: [],
      })),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const fail = vi.fn(async () => undefined);

    await expect(
      startConnectedAcpRun({
        start_session: vi.fn(async () => session),
        mark_running: vi.fn(async () => ({ status: "running" as const })),
        persist_effective_model: vi.fn(
          async () => new Promise<void>(() => undefined),
        ),
        prompt: "The prompt must not start.",
        complete: vi.fn(async () => ({ status: "terminal" as const })),
        fail,
      }),
    ).rejects.toThrow("Model observation persistence was interrupted.");
    expect(session.run).not.toHaveBeenCalled();
    expect(session.close).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledOnce();
  });

  it("terminalizes a timed-out run without waiting forever on an aborted model observation", async () => {
    const controller = new AbortController();
    let callbacks: AcpSessionCallbacks = {};
    let markPersistenceStarted!: () => void;
    const persistenceStarted = new Promise<void>((resolveStarted) => {
      markPersistenceStarted = resolveStarted;
    });
    const timedOutResult = {
      outcome: "timed_out" as const,
      partial: true,
      stop_reason: null,
      permissions: [],
    };
    const session: AcpSession = {
      session_id: "timeout-session",
      protocol_version: 1,
      requested_mcp_server_count: 0,
      config_options: [],
      wall_clock_timeout_ms: 30,
      process: {
        pid: 1234,
        process_group_id: 1234,
        started_at: "2026-08-03T20:00:00.000Z",
      },
      run: vi.fn(async () => {
        const update = callbacks.on_session_update?.(
          {
            update_kind: "config_option_update",
            session_id: "timeout-session",
            tool_call_id: null,
            tool_kind: null,
            tool_status: null,
            config_options: [
              {
                type: "select",
                id: "model",
                name: "Model",
                category: "model",
                currentValue: "model-a",
                options: [{ value: "model-a", name: "Model A" }],
              },
            ],
          },
          controller.signal,
        );
        await persistenceStarted;
        controller.abort();
        void Promise.resolve(update).catch(() => undefined);
        return timedOutResult;
      }),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const complete = vi.fn(async () => ({ status: "terminal" as const }));

    const started = await startConnectedAcpRun({
      start_session: vi.fn(async (input) => {
        callbacks = input;
        return session;
      }),
      mark_running: vi.fn(async () => ({ status: "running" as const })),
      persist_effective_model: vi.fn(async () => {
        markPersistenceStarted();
        await new Promise<void>(() => undefined);
      }),
      prompt: "Run the bounded mission.",
      complete,
      fail: vi.fn(async () => undefined),
    });

    await expect(started.completion).resolves.toBeUndefined();
    expect(complete).toHaveBeenCalledWith(timedOutResult);
  });
});
