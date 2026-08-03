import { describe, expect, it, vi } from "vitest";

import {
  composeConnectedShapingPrompt,
  startConnectedAcpRun,
} from "../../src/application/shaping-connected-run";
import {
  brainstormResultSubmissionSchema,
  hashShapingIngressInstruction,
  planResultSubmissionSchema,
  specResultSubmissionSchema,
  type ShapingIngressInstructionV1,
  type ShapingPhase,
} from "../../src/domain/shaping";
import type {
  AcpSession,
  AcpSessionCallbacks,
} from "../../src/infrastructure/acp/acp-client";

const requiredFieldsByPhase = {
  brainstorm: [
    "result_schema_version",
    "brainstorm_mission_content_sha256",
    "identity",
    "problem_statement",
    "approach",
    "non_goals",
    "open_questions",
  ],
  spec: [
    "result_schema_version",
    "spec_mission_content_sha256",
    "identity",
    "proposal",
  ],
  plan: [
    "result_schema_version",
    "plan_mission_content_sha256",
    "identity",
    "summary",
    "checklist",
    "relevant_skills",
    "product_doc_impacts",
    "todo_impacts",
    "open_questions",
  ],
} satisfies Record<ShapingPhase, string[]>;

function instructionForPhase(
  phase: ShapingPhase,
): ShapingIngressInstructionV1 {
  const source = {
    schema_version: 1 as const,
    origin: "connected_run" as const,
    shaping_run_id: "550e8400-e29b-41d4-a716-446655440001",
    work_item_id: "wi_550e8400-e29b-41d4-a716-446655440000",
    phase,
    mission_input_sha256: "a".repeat(64),
    mission_content_sha256: "b".repeat(64),
    task_path: `.founder/shaping/work-item/${phase}/TASK.md`,
    mission_path: `.founder/shaping/work-item/${phase}/mission.json`,
    ingress_path: `.founder/shaping-runs/work-item/run/ingress/result.json`,
    result_schema_version: 1 as const,
    required_fields: requiredFieldsByPhase[phase],
    max_result_bytes: 262_144 as const,
    created_at: "2026-08-03T20:00:00.000Z",
  };
  return {
    ...source,
    instruction_sha256: hashShapingIngressInstruction(source),
  };
}

function promptResultShape(phase: ShapingPhase): Record<string, unknown> {
  const marker = "Exact result shape: ";
  const line = composeConnectedShapingPrompt(instructionForPhase(phase))
    .split("\n")
    .find((entry) => entry.startsWith(marker));
  expect(line).toBeDefined();
  return JSON.parse(line!.slice(marker.length)) as Record<string, unknown>;
}

describe("connected ACP run orchestration", () => {
  it("gives every shaping seat an exact schema-valid result shape", () => {
    const expectedIdentity = {
      phase: "brainstorm",
      work_item_id: "wi_550e8400-e29b-41d4-a716-446655440000",
      input_sha256: "a".repeat(64),
    };
    const brainstorm = promptResultShape("brainstorm");
    expect(brainstorm).toMatchObject({
      result_schema_version: 1,
      brainstorm_mission_content_sha256: "b".repeat(64),
      identity: expectedIdentity,
    });
    expect(typeof brainstorm.approach).toBe("string");
    expect(Array.isArray(brainstorm.non_goals)).toBe(true);
    expect(Array.isArray(brainstorm.open_questions)).toBe(true);
    expect(brainstormResultSubmissionSchema.safeParse(brainstorm).success).toBe(
      true,
    );

    const spec = promptResultShape("spec");
    const specPrompt = composeConnectedShapingPrompt(
      instructionForPhase("spec"),
    );
    expect(specPrompt).toContain(
      "Replace every descriptive example value, including proposal.allowed_scope",
    );
    expect(specPrompt).toContain(
      "Preserve only result_schema_version, the mission content hash, and the identity object exactly",
    );
    expect(spec).toMatchObject({
      result_schema_version: 1,
      spec_mission_content_sha256: "b".repeat(64),
      identity: { ...expectedIdentity, phase: "spec" },
      proposal: {
        purpose: expect.any(String),
        acceptance_criteria: expect.any(Array),
        non_goals: expect.any(Array),
        allowed_scope: expect.any(Array),
        review_ready: expect.any(Array),
      },
    });
    expect(specResultSubmissionSchema.safeParse(spec).success).toBe(true);

    const plan = promptResultShape("plan");
    expect(plan).toMatchObject({
      result_schema_version: 1,
      plan_mission_content_sha256: "b".repeat(64),
      identity: { ...expectedIdentity, phase: "plan" },
      summary: expect.any(String),
      checklist: [
        {
          id: expect.any(String),
          step: expect.any(String),
          verification_check: expect.any(String),
        },
      ],
      relevant_skills: expect.any(Array),
      product_doc_impacts: expect.any(Array),
      todo_impacts: expect.any(Array),
      open_questions: expect.any(Array),
    });
    expect(planResultSubmissionSchema.safeParse(plan).success).toBe(true);
  });

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
