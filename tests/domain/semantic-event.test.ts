import { describe, expect, it } from "vitest";

import {
  SEMANTIC_EVENT_OUTCOME_MAX_BYTES,
  canonicalSerializeSemanticEvent,
  canonicalSerializeSemanticEventIntent,
  deriveSemanticEventId,
  deriveSemanticIntentId,
  semanticActorSchema,
  semanticEventIntentSchema,
  semanticEventSchema,
  semanticWorkflowBindingSchema,
  type SemanticEventIntentV1,
  type SemanticEventV1,
  type SemanticWorkflowBindingV1,
} from "../../src/domain/semantic-event";

const workItemId = "wi_550e8400-e29b-41d4-a716-446655440000";
const controllerRunId = "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1";
const connectedRunId = "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b2";
const contentSha256 = "a".repeat(64);
const operationSha256 = "b".repeat(64);
const governedBinding: SemanticWorkflowBindingV1 = {
  kind: "governed",
  governed_tuple: {
    goal_version: 2,
    input_revision: 3,
    attempt: 1,
    patch_cycle: 0,
  },
  phase: "execute",
  status: "active",
};
const shapingBinding: SemanticWorkflowBindingV1 = {
  kind: "shaping",
  identity: {
    phase: "brainstorm",
    work_item_id: workItemId,
    input_sha256: "c".repeat(64),
  },
};

function controllerIntent(
  overrides: Partial<SemanticEventIntentV1> = {},
): SemanticEventIntentV1 {
  const source = {
    kind: "controller_run" as const,
    controller_run_id: controllerRunId,
    expected_outcome: "applied" as const,
  };
  const kind = overrides.kind ?? "permission_decided";
  const slot = overrides.slot ?? "permission-decision";
  return {
    schema_version: 1,
    intent_id: deriveSemanticIntentId({ source, kind, slot }),
    source,
    slot,
    kind,
    work_item_id: workItemId,
    binding: governedBinding,
    run: {
      family: "connected",
      connected_run_id: connectedRunId,
      phase: "execute",
    },
    actor: { kind: "founder" },
    outcome: "Allowed the exact denied command and prepared a retry.",
    occurred_at: "2026-08-12T07:00:00.000Z",
    evidence: [
      {
        kind: "controller_run",
        path: `.founder/work-items/${workItemId}/runs/${controllerRunId}.json`,
        expected_content_sha256: contentSha256,
      },
    ],
    action: null,
    details: {
      kind: "permission_decided",
      decision: "allow_once",
      operation_sha256: operationSha256,
      next_attempt: 2,
    },
    ...overrides,
  };
}

function eventForIntent(
  intent: SemanticEventIntentV1,
  streamSequence = 1,
): SemanticEventV1 {
  const idInput = {
    schema_version: 1 as const,
    work_item_id: intent.work_item_id,
    binding: intent.binding,
    kind: intent.kind,
    stream_sequence: streamSequence,
  };
  return {
    schema_version: 1,
    event_id: deriveSemanticEventId(idInput),
    stream_sequence: streamSequence,
    kind: intent.kind,
    work_item_id: intent.work_item_id,
    binding: intent.binding,
    run: intent.run,
    actor: intent.actor,
    outcome: intent.outcome,
    occurred_at: intent.occurred_at,
    recorded_at: "2026-08-12T07:00:01.000Z",
    evidence: intent.evidence.map((handle) => ({
      kind: handle.kind,
      path: handle.path,
      content_sha256: handle.expected_content_sha256,
    })) as SemanticEventV1["evidence"],
    action: intent.action,
    details: intent.details,
    intent_id: intent.intent_id,
  };
}

describe("semantic-event domain", () => {
  it("strictly parses intents and events and rejects unknown fields", () => {
    const intent = controllerIntent();
    const event = eventForIntent(intent);

    expect(semanticEventIntentSchema.parse(intent)).toEqual(intent);
    expect(semanticEventSchema.parse(event)).toEqual(event);
    expect(() =>
      semanticEventIntentSchema.parse({ ...intent, provider: "vendor" }),
    ).toThrow();
    expect(() =>
      semanticEventSchema.parse({
        ...event,
        details: { ...event.details, raw_output: "private" },
      }),
    ).toThrow();
    expect(() =>
      semanticEventIntentSchema.parse({
        ...intent,
        details: { ...intent.details, kind: "attention_requested" },
      }),
    ).toThrow();
  });

  it("accepts exact governed and shaping bindings", () => {
    expect(semanticWorkflowBindingSchema.parse(governedBinding)).toEqual(
      governedBinding,
    );
    expect(semanticWorkflowBindingSchema.parse(shapingBinding)).toEqual(
      shapingBinding,
    );
    expect(() =>
      semanticWorkflowBindingSchema.parse({
        ...shapingBinding,
        governed_tuple: governedBinding.governed_tuple,
      }),
    ).toThrow();
  });

  it("preserves unknown run provenance without upgrading its assurance", () => {
    const actor = {
      kind: "connected_run" as const,
      connected_run_id: connectedRunId,
      provenance: {
        role: { value: null, assurance: "unknown" as const },
        seat: { value: null, assurance: "unknown" as const },
        requested_model: { value: null, assurance: "unknown" as const },
        effective_model: {
          assurance: "unknown" as const,
          model_id: null,
          deployment_id: null,
          observed_event_sha256: null,
        },
        effort: { value: null, assurance: "unknown" as const },
        harness: { value: null, assurance: "unknown" as const },
        adapter_profile: { value: null, assurance: "unknown" as const },
        resolved_profile_sha256: {
          value: null,
          assurance: "unknown" as const,
        },
        resolved_skill_set_sha256: {
          value: null,
          assurance: "unknown" as const,
        },
        authorization_sha256: {
          value: null,
          assurance: "unknown" as const,
        },
      },
    };

    const parsed = semanticActorSchema.parse(actor);
    expect(parsed).toEqual(actor);
    expect(parsed.kind).toBe("connected_run");
    if (parsed.kind !== "connected_run") {
      throw new Error("Expected connected-run actor provenance.");
    }
    expect(parsed.provenance.effective_model.assurance).toBe("unknown");
    expect(() =>
      semanticActorSchema.parse({
        ...actor,
        provenance: {
          ...actor.provenance,
          effective_model: {
            ...actor.provenance.effective_model,
            assurance: "adapter_attested",
          },
        },
      }),
    ).toThrow();
  });

  it("serializes canonically regardless of caller key order", () => {
    const intent = controllerIntent();
    const reordered = {
      details: intent.details,
      action: intent.action,
      evidence: intent.evidence,
      occurred_at: intent.occurred_at,
      outcome: intent.outcome,
      actor: intent.actor,
      run: intent.run,
      binding: intent.binding,
      work_item_id: intent.work_item_id,
      kind: intent.kind,
      slot: intent.slot,
      source: intent.source,
      intent_id: intent.intent_id,
      schema_version: intent.schema_version,
    } satisfies SemanticEventIntentV1;
    const event = eventForIntent(intent);

    expect(canonicalSerializeSemanticEventIntent(reordered)).toBe(
      canonicalSerializeSemanticEventIntent(intent),
    );
    expect(canonicalSerializeSemanticEvent(event)).toBe(
      `${JSON.stringify(event, null, 2)}\n`,
    );
  });

  it("derives deterministic collision-free intent and event IDs", () => {
    const first = controllerIntent();
    const second = controllerIntent({ slot: "workflow-transition" });

    second.intent_id = deriveSemanticIntentId(second);
    expect(deriveSemanticIntentId(first)).toBe(first.intent_id);
    expect(deriveSemanticIntentId({ ...first })).toBe(first.intent_id);
    expect(second.intent_id).not.toBe(first.intent_id);

    const eventOne = eventForIntent(first, 1);
    const replayedEventOne = eventForIntent(first, 1);
    const eventTwo = eventForIntent(first, 2);
    expect(eventOne.event_id).toBe(replayedEventOne.event_id);
    expect(eventTwo.event_id).not.toBe(eventOne.event_id);
  });

  it("caps multibyte outcomes at 280 UTF-8 bytes without splitting a character", () => {
    const parsed = semanticEventIntentSchema.parse(
      controllerIntent({ outcome: "å".repeat(200) }),
    );

    expect(Buffer.byteLength(parsed.outcome, "utf8")).toBeLessThanOrEqual(
      SEMANTIC_EVENT_OUTCOME_MAX_BYTES,
    );
    expect(parsed.outcome.endsWith("...[TRUNCATED]")).toBe(true);
    expect(parsed.outcome).not.toContain("�");
    expect(() =>
      semanticEventIntentSchema.parse(
        controllerIntent({ outcome: "Allowed\nthen retried" }),
      ),
    ).toThrow("must not contain control characters");
  });

  it.each([
    "/absolute/evidence.json",
    "../outside/evidence.json",
    ".founder/../outside/evidence.json",
    ".founder\\semantic-events\\event.json",
  ])("rejects unsafe evidence path %s", (path) => {
    const intent = controllerIntent();
    expect(() =>
      semanticEventIntentSchema.parse({
        ...intent,
        evidence: [{ ...intent.evidence[0], path }],
      }),
    ).toThrow("must be a safe workspace-relative POSIX path");
  });

  it("does not admit keep_denied without a durable decision source", () => {
    const intent = controllerIntent();
    expect(() =>
      semanticEventIntentSchema.parse({
        ...intent,
        details: { ...intent.details, decision: "keep_denied" },
      }),
    ).toThrow();
  });

  it("rejects a terminal run_launched detail while accepting a terminal source", () => {
    const source = {
      kind: "connected_run" as const,
      connected_run_id: connectedRunId,
      expected_lifecycle_status: "terminal" as const,
      mission_content_sha256: contentSha256,
    };
    const intent = controllerIntent({
      source,
      slot: "run-launch",
      kind: "run_launched",
      details: {
        kind: "run_launched",
        run_family: "connected",
        phase: "execute",
        run_id: connectedRunId,
        lifecycle_status: "starting",
      },
    });
    intent.intent_id = deriveSemanticIntentId(intent);

    expect(semanticEventIntentSchema.parse(intent).source).toEqual(source);
    expect(() =>
      semanticEventIntentSchema.parse({
        ...intent,
        details: { ...intent.details, lifecycle_status: "terminal" },
      }),
    ).toThrow();
  });
});
