import { describe, expect, it } from "vitest";

import {
  capabilityRequestMatchesEnvelope,
  resolveCapabilityEnvelope,
  type CanonicalCapabilityRequest,
  type ExecutionDefaultsV1,
} from "../../src/domain/capability-envelope";
import {
  deriveManualShapingProductionId,
  evaluateShapingPermissionRequest,
  shapingProductionReceiptSchema,
  shapingRunLaunchFingerprint,
  shapingRunRecordV1Schema,
  shapingRunSummarySchema,
  summarizeShapingRun,
  type ConnectedShapingProductionReceipt,
  type ManualShapingProductionReceipt,
  type ShapingRunRecordV1,
  type ShapingRunWritePolicy,
} from "../../src/domain/shaping-run";
import {
  hashShapingIngressInstruction,
  shapingIngressInstructionSchema,
  type ShapingIngressInstructionV1,
} from "../../src/domain/shaping";

const shapingRunId = "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1";
const otherRunId = "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b2";
const workItemId = "wi_550e8400-e29b-41d4-a716-446655440000";
const inputSha256 = "a".repeat(64);
const missionSha256 = "b".repeat(64);
const resultSha256 = "c".repeat(64);
const observedEventSha256 = "d".repeat(64);
const profileSha256 = "e".repeat(64);
const skillSetSha256 = "f".repeat(64);
const ingressPath = `.founder/shaping-runs/${workItemId}/${shapingRunId}/ingress/result.json`;

function instructionFor(
  path: string = ingressPath,
): ShapingIngressInstructionV1 {
  const input: Omit<ShapingIngressInstructionV1, "instruction_sha256"> = {
    schema_version: 1,
    origin: "connected_run",
    shaping_run_id: shapingRunId,
    work_item_id: workItemId,
    phase: "brainstorm",
    mission_input_sha256: inputSha256,
    mission_content_sha256: missionSha256,
    task_path: `.founder/shaping/${workItemId}/brainstorm-${inputSha256}/TASK.md`,
    mission_path: `.founder/shaping/${workItemId}/brainstorm-${inputSha256}/mission.json`,
    ingress_path: path,
    result_schema_version: 1,
    required_fields: [
      "result_schema_version",
      "brainstorm_mission_content_sha256",
      "identity",
      "problem_statement",
      "approach",
      "non_goals",
      "open_questions",
    ],
    max_result_bytes: 262_144,
    created_at: "2026-08-01T10:00:00.000Z",
  };
  return shapingIngressInstructionSchema.parse({
    ...input,
    instruction_sha256: hashShapingIngressInstruction(input),
  });
}

function policyFor(
  instruction: ShapingIngressInstructionV1,
): ShapingRunWritePolicy {
  return {
    kind: "single_ingress_file",
    ingress_path: instruction.ingress_path,
    instruction_sha256: instruction.instruction_sha256,
    commands: "forbidden",
    urls: "forbidden",
    mcp: "forbidden",
    credentials: "forbidden",
    outside_workspace_writes: "forbidden",
    reads: "workspace_and_repository_unrestricted",
    execution_mode: "permission_mediated_local",
    result_assurance: "result_scope_validation",
    containment_assurance: "not_independently_enforced",
    machine_authority: "launching_user",
  };
}

const instruction = instructionFor();
const writePolicy = policyFor(instruction);

const record: ShapingRunRecordV1 = {
  schema_version: 1,
  shaping_run_id: shapingRunId,
  mission: {
    phase: "brainstorm",
    work_item_id: workItemId,
    input_sha256: inputSha256,
    content_sha256: missionSha256,
  },
  provenance: {
    role: { value: "writer", assurance: "controller_observed" },
    seat: { value: "brainstorm", assurance: "controller_observed" },
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
      assurance: "adapter_attested",
    },
    adapter_profile: {
      value: {
        adapter_id: "local-acp-adapter",
        adapter_version: "1.0.0",
        profile_id: "artifact-only-shaping-v1",
      },
      assurance: "adapter_attested",
    },
    resolved_profile_sha256: {
      value: profileSha256,
      assurance: "controller_observed",
    },
    resolved_skill_set_sha256: {
      value: skillSetSha256,
      assurance: "controller_observed",
    },
  },
  write_policy: writePolicy,
  lifecycle: {
    status: "starting",
    started_at: "2026-08-01T10:00:01.000Z",
    updated_at: "2026-08-01T10:00:01.000Z",
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
  process: null,
  diagnostics: { entries: [], truncated: false },
};

describe("shaping-run domain", () => {
  it("defines a strict artifact-only record and sanitized summary", () => {
    expect(shapingRunRecordV1Schema.parse(record)).toEqual(record);

    for (const [key, value] of [
      ["governed_tuple", { goal_version: 1 }],
      ["capability_envelope", { schema_version: 1 }],
      ["resolved_capability_envelope", { envelope_sha256: "0".repeat(64) }],
      ["permission", { decision: "allow_once" }],
    ] as const) {
      expect(() =>
        shapingRunRecordV1Schema.parse({ ...record, [key]: value }),
      ).toThrow();
    }

    const summary = summarizeShapingRun(record);
    expect(shapingRunSummarySchema.parse(summary)).toEqual(summary);
    expect(summary).toEqual({
      schema_version: 1,
      shaping_run_id: shapingRunId,
      mission: record.mission,
      provenance: {
        role: record.provenance.role,
        seat: record.provenance.seat,
        requested_model: record.provenance.requested_model,
        effective_model: record.provenance.effective_model,
        effort: record.provenance.effort,
        harness: record.provenance.harness,
        adapter_profile: record.provenance.adapter_profile,
      },
      write_policy: writePolicy,
      lifecycle: {
        status: "starting",
        started_at: record.lifecycle.started_at,
        updated_at: record.lifecycle.updated_at,
        completed_at: null,
        terminal_outcome: null,
        partial: false,
      },
      diagnostics: { count: 0, truncated: false },
    });
    expect(summary).not.toHaveProperty("process");
    expect(summary).not.toHaveProperty("diagnostics.entries");
    expect(summary).not.toHaveProperty("provenance.resolved_profile_sha256");
  });

  it("admits only the exact ingress file and denies every other mediated request", () => {
    expect(
      evaluateShapingPermissionRequest(instruction, writePolicy, {
        schema_version: 1,
        kind: "workspace_write",
        path: ingressPath,
      }),
    ).toEqual({ decision: "allow_once", reason: null });

    const deniedRequests: CanonicalCapabilityRequest[] = [
      {
        schema_version: 1,
        kind: "command",
        executable: "npm",
        args: ["test"],
      },
      {
        schema_version: 1,
        kind: "url",
        method: "GET",
        protocol: "https",
        host: "example.com",
        path: "/",
      },
      { schema_version: 1, kind: "mcp", server: "filesystem" },
      { schema_version: 1, kind: "credential", source: "environment" },
      {
        schema_version: 1,
        kind: "outside_workspace_write",
        path: "/tmp/result.json",
      },
      {
        schema_version: 1,
        kind: "workspace_write",
        path: "src/unrelated.ts",
      },
      {
        schema_version: 1,
        kind: "workspace_write",
        path: `.founder/shaping-runs/${workItemId}/${shapingRunId}/ingress/sibling.json`,
      },
      {
        schema_version: 1,
        kind: "url",
        method: "POST",
        protocol: "http",
        host: "127.0.0.1:3000",
        path: `/api/portfolio/work-items/${workItemId}/shaping/spec/approve`,
      },
    ];

    for (const request of deniedRequests) {
      expect(
        evaluateShapingPermissionRequest(instruction, writePolicy, request),
      ).toMatchObject({ decision: "reject_once" });
    }
  });

  it("fails closed when the parsed instruction disagrees with the policy", () => {
    expect(
      evaluateShapingPermissionRequest(
        instruction,
        { ...writePolicy, instruction_sha256: "0".repeat(64) },
        { schema_version: 1, kind: "workspace_write", path: ingressPath },
      ),
    ).toEqual({
      decision: "reject_once",
      reason: "instruction_sha256_mismatch",
    });

    const otherInstruction = instructionFor(
      `.founder/shaping-runs/${workItemId}/${otherRunId}/ingress/result.json`,
    );
    expect(
      evaluateShapingPermissionRequest(
        otherInstruction,
        {
          ...writePolicy,
          instruction_sha256: otherInstruction.instruction_sha256,
        },
        { schema_version: 1, kind: "workspace_write", path: ingressPath },
      ),
    ).toEqual({
      decision: "reject_once",
      reason: "ingress_path_mismatch",
    });
  });

  it("is filesystem-independent even when the exact ingress path does not exist", () => {
    const absentInstruction = instructionFor(
      `.founder/does-not-exist/${shapingRunId}/ingress/result.json`,
    );
    expect(
      evaluateShapingPermissionRequest(
        absentInstruction,
        policyFor(absentInstruction),
        {
          schema_version: 1,
          kind: "workspace_write",
          path: absentInstruction.ingress_path,
        },
      ),
    ).toEqual({ decision: "allow_once", reason: null });
  });

  it("keeps shaping separate because the shared envelope admits unrelated workspace writes", () => {
    const defaults: ExecutionDefaultsV1 = {
      schema_version: 1,
      approved_command_forms: [],
      approved_url_operations: [],
      mcp: "forbidden",
      credentials: "forbidden",
    };
    const envelope = resolveCapabilityEnvelope(["src"], defaults);

    expect(
      capabilityRequestMatchesEnvelope(
        {
          schema_version: 1,
          kind: "workspace_write",
          path: "src/not-the-ingress-file.ts",
        },
        envelope,
      ),
    ).toBe(true);
    expect(
      evaluateShapingPermissionRequest(instruction, writePolicy, {
        schema_version: 1,
        kind: "workspace_write",
        path: "src/not-the-ingress-file.ts",
      }),
    ).toMatchObject({ decision: "reject_once" });
  });

  it("binds connected and manual production identities to their origins", () => {
    const connectedReceipt: ConnectedShapingProductionReceipt = {
      schema_version: 1,
      production_id: shapingRunId,
      origin: "connected_run",
      shaping_run_id: shapingRunId,
      produced_at: "2026-08-01T10:05:00.000Z",
      requested_model: record.provenance.requested_model,
      effective_model: record.provenance.effective_model,
      ingress_path: ingressPath,
      result_content_sha256: resultSha256,
    };
    expect(shapingProductionReceiptSchema.parse(connectedReceipt)).toEqual(
      connectedReceipt,
    );
    expect(() =>
      shapingProductionReceiptSchema.parse({
        ...connectedReceipt,
        production_id: otherRunId,
      }),
    ).toThrow("connected production_id must equal shaping_run_id");

    const firstManualId = deriveManualShapingProductionId(
      missionSha256,
      resultSha256,
    );
    const secondManualId = deriveManualShapingProductionId(
      missionSha256,
      resultSha256,
    );
    expect(firstManualId).toBe(secondManualId);

    const manualReceipt: ManualShapingProductionReceipt = {
      schema_version: 1,
      production_id: firstManualId,
      origin: "manual_import",
      shaping_run_id: null,
      produced_at: "2026-08-01T10:05:00.000Z",
      requested_model: { value: null, assurance: "unknown" },
      effective_model: {
        assurance: "unknown",
        model_id: null,
        deployment_id: null,
        observed_event_sha256: null,
      },
      ingress_path: `.founder/shaping-ingress/${workItemId}/brainstorm-${inputSha256}/result.json`,
      result_content_sha256: resultSha256,
    };
    expect(shapingProductionReceiptSchema.parse(manualReceipt)).toEqual(
      manualReceipt,
    );

    for (const requiredKey of ["production_id", "origin"] as const) {
      const incomplete: Record<string, unknown> = { ...manualReceipt };
      delete incomplete[requiredKey];
      expect(() => shapingProductionReceiptSchema.parse(incomplete)).toThrow();
    }
  });

  it("never constructs effective identity from a requested model", () => {
    expect(() =>
      shapingProductionReceiptSchema.parse({
        schema_version: 1,
        production_id: shapingRunId,
        origin: "connected_run",
        shaping_run_id: shapingRunId,
        produced_at: "2026-08-01T10:05:00.000Z",
        requested_model: record.provenance.requested_model,
        effective_model: {
          assurance: "user_declared",
          model_id: "model-requested-by-founder",
          deployment_id: null,
          observed_event_sha256: null,
        },
        ingress_path: ingressPath,
        result_content_sha256: resultSha256,
      }),
    ).toThrow();
  });

  it("derives deterministic launch fingerprints from mission and model only", () => {
    expect(
      shapingRunLaunchFingerprint(
        missionSha256,
        "model-requested-by-founder",
      ),
    ).toBe(
      shapingRunLaunchFingerprint(
        missionSha256,
        "model-requested-by-founder",
      ),
    );
    expect(
      shapingRunLaunchFingerprint(missionSha256, "another-model"),
    ).not.toBe(
      shapingRunLaunchFingerprint(
        missionSha256,
        "model-requested-by-founder",
      ),
    );
  });
});
