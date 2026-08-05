import { describe, expect, it } from "vitest";

import {
  hashResolvedCapabilityEnvelope,
  connectedRunDiagnosticSchema,
  connectedRunLifecycleSchema,
  connectedRunLimitsSchema,
  connectedRunProvenanceSchema,
  connectedRunRecordV2Schema,
  connectedRunSummarySchema,
  effectiveModelIdentitySchema,
  launchConnectedExecuteInputSchema,
  summarizeConnectedRun,
  type ConnectedRunRecordV2,
} from "../../src/domain/connected-run";
import {
  resolveCapabilityEnvelope,
  type ExecutionDefaultsV1,
} from "../../src/domain/capability-envelope";

const connectedRunId = "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1";
const workItemId = "wi_550e8400-e29b-41d4-a716-446655440000";
const missionSha256 = "a".repeat(64);
const sourceCommit = "b".repeat(40);
const observedEventSha256 = "c".repeat(64);
const authorizationSha256 = "d".repeat(64);
const profileSha256 = "e".repeat(64);
const skillSetSha256 = "f".repeat(64);
const reviewPolicySha256 = "1".repeat(64);
const defaults: ExecutionDefaultsV1 = {
  schema_version: 1,
  approved_command_forms: [
    { executable: "npm", args: ["run", "test"] },
  ],
  approved_url_operations: [],
  mcp: "forbidden",
  credentials: "forbidden",
};
const envelope = resolveCapabilityEnvelope(["src", "tests"], defaults);
const envelopeSha256 = hashResolvedCapabilityEnvelope(envelope);

const record: ConnectedRunRecordV2 = {
  schema_version: 2,
  connected_run_id: connectedRunId,
  mission: {
    identity: {
      phase: "execute",
      work_item_id: workItemId,
      goal_version: 2,
      input_revision: 3,
      attempt: 1,
    },
    path: `.founder/missions/${workItemId}/execute-2-3-1/mission.json`,
    content_sha256: missionSha256,
    source_commit: sourceCommit,
  },
  governed_tuple: {
    goal_version: 2,
    input_revision: 3,
    attempt: 1,
    patch_cycle: 0,
  },
  provenance: {
    role: { value: "writer", assurance: "controller_observed" },
    seat: { value: "executor", assurance: "controller_observed" },
    requested_model: {
      value: "model-requested-by-founder",
      assurance: "user_declared",
    },
    effective_model: {
      assurance: "adapter_attested",
      model_id: "model-observed-by-adapter",
      deployment_id: null,
      observed_event_sha256: observedEventSha256,
    },
    effort: { value: "high", assurance: "user_declared" },
    harness: {
      value: { id: "local-agent-cli", version: "1.0.0" },
      assurance: "controller_observed",
    },
    adapter_profile: {
      value: {
        adapter_id: "local-acp-adapter",
        adapter_version: "1.0.0",
        profile_id: "noninteractive-execute-v1",
      },
      assurance: "controller_observed",
    },
    resolved_profile_sha256: {
      value: profileSha256,
      assurance: "controller_observed",
    },
    resolved_skill_set_sha256: {
      value: skillSetSha256,
      assurance: "controller_observed",
    },
    authorization_sha256: {
      value: authorizationSha256,
      assurance: "controller_observed",
    },
  },
  authorization: {
    kind: "capability_envelope",
    envelope,
    envelope_sha256: envelopeSha256,
  },
  acp: {
    protocol_version: { value: 1, assurance: "adapter_attested" },
    session_id: {
      value: "session-018f1f72",
      assurance: "adapter_attested",
    },
  },
  lifecycle: {
    status: "running",
    started_at: "2026-07-26T18:00:00.000Z",
    updated_at: "2026-07-26T18:00:01.000Z",
    completed_at: null,
    terminal: null,
  },
  limits: {
    wall_clock_timeout_ms: 900_000,
    max_event_count: 10_000,
    max_event_bytes: 4_000_000,
    max_output_bytes: 1_000_000,
    termination_grace_ms: 5_000,
    drain_grace_ms: 1_000,
  },
  process: {
    pid: 1234,
    process_group_id: 1234,
    started_at: "2026-07-26T18:00:00.100Z",
  },
  diagnostics: {
    entries: [
      {
        observed_at: "2026-07-26T18:00:00.500Z",
        code: "session_initialized",
        message: "The protocol session initialized successfully.",
      },
    ],
    truncated: false,
  },
};

const reviewRecord: ConnectedRunRecordV2 = {
  ...record,
  mission: {
    ...record.mission,
    identity: {
      phase: "review",
      work_item_id: workItemId,
      goal_version: 2,
      input_revision: 3,
      attempt: 1,
    },
    path: `.founder/missions/${workItemId}/review-2-3-1/mission.json`,
  },
  provenance: {
    ...record.provenance,
    role: { value: "reviewer", assurance: "controller_observed" },
    seat: { value: "reviewer", assurance: "controller_observed" },
  },
  authorization: {
    kind: "review_result_ingress",
    result_path: `.founder/missions/${workItemId}/review-2-3-1/result.json`,
    policy_sha256: reviewPolicySha256,
  },
};

describe("connected-run domain", () => {
  it("strictly round-trips every durable contract and rejects unknown keys", () => {
    expect(connectedRunRecordV2Schema.parse(record)).toEqual(record);
    expect(connectedRunProvenanceSchema.parse(record.provenance)).toEqual(
      record.provenance,
    );
    expect(connectedRunLifecycleSchema.parse(record.lifecycle)).toEqual(
      record.lifecycle,
    );
    expect(connectedRunLimitsSchema.parse(record.limits)).toEqual(
      record.limits,
    );
    expect(
      connectedRunDiagnosticSchema.parse(record.diagnostics.entries[0]),
    ).toEqual(record.diagnostics.entries[0]);

    const launchInput = {
      expected_phase: "execute" as const,
      expected_status: "active" as const,
      expected_schema_version: 2 as const,
      governed_tuple: record.governed_tuple,
      mission_content_sha256: missionSha256,
      model_override: "one-run-model",
    };
    expect(launchConnectedExecuteInputSchema.parse(launchInput)).toEqual(
      launchInput,
    );

    expect(() =>
      connectedRunRecordV2Schema.parse({ ...record, provider: "vendor" }),
    ).toThrow();
    expect(() =>
      connectedRunProvenanceSchema.parse({
        ...record.provenance,
        token: "secret",
      }),
    ).toThrow();
    expect(() =>
      launchConnectedExecuteInputSchema.parse({
        ...launchInput,
        capability_envelope: envelope,
      }),
    ).toThrow();
  });

  it("rejects v1 records and summaries without a compatibility reader", () => {
    expect(() =>
      connectedRunRecordV2Schema.parse({ ...record, schema_version: 1 }),
    ).toThrow();

    const summary = summarizeConnectedRun(record);
    expect(() =>
      connectedRunSummarySchema.parse({ ...summary, schema_version: 1 }),
    ).toThrow();
  });

  it("binds each mission phase to its authorization kind", () => {
    expect(connectedRunRecordV2Schema.parse(reviewRecord)).toEqual(
      reviewRecord,
    );
    expect(() =>
      connectedRunRecordV2Schema.parse({
        ...reviewRecord,
        authorization: record.authorization,
      }),
    ).toThrow("review connected runs require review_result_ingress");
    expect(() =>
      connectedRunRecordV2Schema.parse({
        ...record,
        authorization: reviewRecord.authorization,
      }),
    ).toThrow("execute connected runs require capability_envelope");

    const reviewSummary = summarizeConnectedRun(reviewRecord);
    expect(reviewSummary.mission.identity.phase).toBe("review");
    expect(reviewSummary.authorization).toEqual({
      kind: "review_result_ingress",
      policy_sha256: reviewPolicySha256,
    });
    expect(reviewSummary).not.toHaveProperty("capability_envelope_sha256");
    expect(reviewSummary).not.toHaveProperty("authorization.envelope_sha256");
  });

  it("records unavailable provenance explicitly instead of omitting it", () => {
    const unknowns = {
      ...record.provenance,
      seat: { value: null, assurance: "unknown" as const },
      effective_model: {
        assurance: "unknown" as const,
        model_id: null,
        deployment_id: null,
        observed_event_sha256: null,
      },
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
    };

    expect(connectedRunProvenanceSchema.parse(unknowns)).toEqual(unknowns);
    expect(() =>
      connectedRunProvenanceSchema.parse({
        ...unknowns,
        requested_model: { assurance: "unknown" },
      }),
    ).toThrow();
  });

  it("cannot promote requested model configuration into effective identity", () => {
    expect(() =>
      effectiveModelIdentitySchema.parse({
        assurance: "user_declared",
        model_id: "model-requested-by-founder",
        deployment_id: null,
      }),
    ).toThrow();
    expect(() =>
      effectiveModelIdentitySchema.parse({
        assurance: "adapter_attested",
        model_id: "model-requested-by-founder",
        deployment_id: null,
      }),
    ).toThrow();
    expect(
      effectiveModelIdentitySchema.parse(record.provenance.effective_model),
    ).toEqual(record.provenance.effective_model);
  });

  it("binds tuple and envelope digests to the immutable mission record", () => {
    expect(() =>
      connectedRunRecordV2Schema.parse({
        ...record,
        governed_tuple: { ...record.governed_tuple, attempt: 2 },
      }),
    ).toThrow("governed_tuple attempt must match mission identity");
    expect(() =>
      connectedRunRecordV2Schema.parse({
        ...record,
        authorization: {
          ...record.authorization,
          envelope_sha256: "0".repeat(64),
        },
      }),
    ).toThrow("envelope_sha256 must hash the resolved capability envelope");
  });

  it("requires coherent terminal lifecycle and preserves partial outcomes", () => {
    const interrupted = {
      status: "terminal" as const,
      started_at: "2026-07-26T18:00:00.000Z",
      updated_at: "2026-07-26T18:01:00.000Z",
      completed_at: "2026-07-26T18:01:01.000Z",
      terminal: {
        outcome: "interrupted" as const,
        partial: true,
        reason: "The process was gone during restart reconciliation.",
      },
    };

    expect(connectedRunLifecycleSchema.parse(interrupted)).toEqual(
      interrupted,
    );
    expect(() =>
      connectedRunLifecycleSchema.parse({
        ...interrupted,
        completed_at: null,
      }),
    ).toThrow("terminal status requires completed_at");
    expect(() =>
      connectedRunLifecycleSchema.parse({
        ...interrupted,
        terminal: { outcome: "failed", partial: true, reason: null },
      }),
    ).toThrow("non-completed terminal outcomes require a reason");
  });

  it("projects a sanitized summary without process or diagnostic internals", () => {
    const summary = summarizeConnectedRun(record);

    expect(connectedRunSummarySchema.parse(summary)).toEqual(summary);
    expect(summary).toEqual({
      schema_version: 2,
      connected_run_id: connectedRunId,
      mission: {
        identity: record.mission.identity,
        content_sha256: missionSha256,
        source_commit: sourceCommit,
      },
      governed_tuple: record.governed_tuple,
      provenance: {
        role: record.provenance.role,
        seat: record.provenance.seat,
        requested_model: record.provenance.requested_model,
        effective_model: record.provenance.effective_model,
        effort: record.provenance.effort,
        harness: record.provenance.harness,
        adapter_profile: record.provenance.adapter_profile,
      },
      authorization: {
        kind: "capability_envelope",
        envelope_sha256: envelopeSha256,
      },
      acp_protocol_version: record.acp.protocol_version,
      lifecycle: {
        status: "running",
        started_at: record.lifecycle.started_at,
        updated_at: record.lifecycle.updated_at,
        completed_at: null,
        terminal_outcome: null,
        partial: false,
      },
      diagnostics: { count: 1, truncated: false },
    });
    expect(summary).toMatchObject({
      connected_run_id: connectedRunId,
      authorization: {
        kind: "capability_envelope",
        envelope_sha256: envelopeSha256,
      },
      lifecycle: {
        status: "running",
        terminal_outcome: null,
        partial: false,
      },
      diagnostics: { count: 1, truncated: false },
    });
    expect(summary).not.toHaveProperty("process");
    expect(summary).not.toHaveProperty("authorization.envelope");
    expect(summary).not.toHaveProperty("provenance.authorization_sha256");
    expect(summary).not.toHaveProperty("diagnostics.entries");
    expect(() =>
      connectedRunSummarySchema.parse({ ...summary, process: record.process }),
    ).toThrow();
    expect(() =>
      connectedRunSummarySchema.parse({
        ...summary,
        lifecycle: {
          ...summary.lifecycle,
          status: "terminal",
        },
      }),
    ).toThrow("terminal summary requires completed_at");
  });

  it("bounds retained diagnostic count and message size", () => {
    expect(() =>
      connectedRunRecordV2Schema.parse({
        ...record,
        diagnostics: {
          entries: Array.from({ length: 21 }, () =>
            record.diagnostics.entries[0],
          ),
          truncated: true,
        },
      }),
    ).toThrow();
    expect(() =>
      connectedRunDiagnosticSchema.parse({
        ...record.diagnostics.entries[0],
        message: "x".repeat(501),
      }),
    ).toThrow();
  });
});
