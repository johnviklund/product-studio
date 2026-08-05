import { createHash } from "node:crypto";

import { z } from "zod";

import {
  capabilityEnvelopeV1Schema,
  type CapabilityEnvelopeV1,
} from "./capability-envelope";
import {
  missionIdentitySchema,
  type MissionIdentity,
  type MissionPhase,
} from "./mission";
import {
  governedTupleSchema,
  type GovernedTuple,
} from "./work-item";
import { workspaceRelativePosixPathSchema } from "./workspace-path";

export const CONNECTED_RUN_SCHEMA_VERSION = 2 as const;
const KNOWN_PROVENANCE_ASSURANCES = [
  "controller_observed",
  "adapter_attested",
  "user_declared",
] as const;

export const PROVENANCE_ASSURANCES = [
  ...KNOWN_PROVENANCE_ASSURANCES,
  "unknown",
] as const;
export const CONNECTED_RUN_LIFECYCLE_STATUSES = [
  "starting",
  "running",
  "terminal",
] as const;
export const CONNECTED_RUN_TERMINAL_OUTCOMES = [
  "completed",
  "missing_permission",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
] as const;

export type ProvenanceAssurance =
  (typeof PROVENANCE_ASSURANCES)[number];
type KnownProvenanceAssurance =
  (typeof KNOWN_PROVENANCE_ASSURANCES)[number];
export type ConnectedRunLifecycleStatus =
  (typeof CONNECTED_RUN_LIFECYCLE_STATUSES)[number];
export type ConnectedRunTerminalOutcome =
  (typeof CONNECTED_RUN_TERMINAL_OUTCOMES)[number];

export type ProvenanceValue<T> =
  | { value: T; assurance: KnownProvenanceAssurance }
  | { value: null; assurance: "unknown" };

export type EffectiveModelIdentity =
  | {
      assurance: "adapter_attested";
      model_id: string;
      deployment_id: string | null;
      observed_event_sha256: string;
    }
  | {
      assurance: "unknown";
      model_id: null;
      deployment_id: null;
      observed_event_sha256: null;
    };

export interface ConnectedRuntimeIdentity {
  id: string;
  version: string;
}

export interface SanitizedAdapterProfileIdentity {
  adapter_id: string;
  adapter_version: string;
  profile_id: string;
}

export interface ConnectedRunProvenance {
  role: ProvenanceValue<string>;
  seat: ProvenanceValue<string>;
  requested_model: ProvenanceValue<string>;
  effective_model: EffectiveModelIdentity;
  effort: ProvenanceValue<string>;
  harness: ProvenanceValue<ConnectedRuntimeIdentity>;
  adapter_profile: ProvenanceValue<SanitizedAdapterProfileIdentity>;
  resolved_profile_sha256: ProvenanceValue<string>;
  resolved_skill_set_sha256: ProvenanceValue<string>;
  authorization_sha256: ProvenanceValue<string>;
}

export interface ConnectedRunMissionReference {
  identity: MissionIdentity<MissionPhase>;
  path: string;
  content_sha256: string;
  source_commit: string;
}

export type ConnectedRunAuthorization =
  | {
      kind: "capability_envelope";
      envelope: CapabilityEnvelopeV1;
      envelope_sha256: string;
    }
  | {
      kind: "review_result_ingress";
      result_path: string;
      policy_sha256: string;
    };

export type ConnectedRunAuthorizationSummary =
  | {
      kind: "capability_envelope";
      envelope_sha256: string;
    }
  | {
      kind: "review_result_ingress";
      policy_sha256: string;
    };

export interface ConnectedRunProtocolIdentity {
  protocol_version: ProvenanceValue<number>;
  session_id: ProvenanceValue<string>;
}

export interface ConnectedRunLimits {
  wall_clock_timeout_ms: number;
  max_event_count: number;
  max_event_bytes: number;
  max_output_bytes: number;
  termination_grace_ms: number;
  drain_grace_ms: number;
}

export interface ConnectedRunProcessIdentity {
  pid: number;
  process_group_id: number;
  started_at: string;
}

export interface ConnectedRunTerminal {
  outcome: ConnectedRunTerminalOutcome;
  partial: boolean;
  reason: string | null;
}

export interface ConnectedRunLifecycle {
  status: ConnectedRunLifecycleStatus;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  terminal: ConnectedRunTerminal | null;
}

export interface ConnectedRunDiagnostic {
  observed_at: string;
  code: string;
  message: string;
}

export interface ConnectedRunDiagnostics {
  entries: ConnectedRunDiagnostic[];
  truncated: boolean;
}

export interface ConnectedRunRecordV2 {
  schema_version: 2;
  connected_run_id: string;
  mission: ConnectedRunMissionReference;
  governed_tuple: GovernedTuple;
  provenance: ConnectedRunProvenance;
  authorization: ConnectedRunAuthorization;
  acp: ConnectedRunProtocolIdentity;
  lifecycle: ConnectedRunLifecycle;
  limits: ConnectedRunLimits;
  process: ConnectedRunProcessIdentity | null;
  diagnostics: ConnectedRunDiagnostics;
}

export interface ConnectedRunSummary {
  schema_version: 2;
  connected_run_id: string;
  mission: {
    identity: MissionIdentity<MissionPhase>;
    content_sha256: string;
    source_commit: string;
  };
  governed_tuple: GovernedTuple;
  provenance: Pick<
    ConnectedRunProvenance,
    | "role"
    | "seat"
    | "requested_model"
    | "effective_model"
    | "effort"
    | "harness"
    | "adapter_profile"
  >;
  authorization: ConnectedRunAuthorizationSummary;
  acp_protocol_version: ProvenanceValue<number>;
  lifecycle: {
    status: ConnectedRunLifecycleStatus;
    started_at: string;
    updated_at: string;
    completed_at: string | null;
    terminal_outcome: ConnectedRunTerminalOutcome | null;
    partial: boolean;
  };
  diagnostics: {
    count: number;
    truncated: boolean;
  };
}

export interface LaunchConnectedExecuteInput {
  expected_phase: "execute";
  expected_status: "active";
  expected_schema_version: 2;
  governed_tuple: GovernedTuple;
  mission_content_sha256: string;
  model_override?: string;
}

const exactNonEmptyStringSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) => value === value.trim(),
    "must not have leading or trailing whitespace",
  )
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "must not contain control characters",
  );
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const gitCommitSchema = z.string().regex(/^[0-9a-f]{40}$/);
const positiveSafeIntegerSchema = z.number().int().positive().safe();
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();

export function provenanceValueSchema<T>(
  valueSchema: z.ZodType<T>,
): z.ZodType<ProvenanceValue<T>> {
  return z.union([
    z.strictObject({
      value: valueSchema,
      assurance: z.enum(KNOWN_PROVENANCE_ASSURANCES),
    }),
    z.strictObject({
      value: z.null(),
      assurance: z.literal("unknown"),
    }),
  ]) as z.ZodType<ProvenanceValue<T>>;
}

export const connectedRuntimeIdentitySchema: z.ZodType<ConnectedRuntimeIdentity> =
  z.strictObject({
    id: exactNonEmptyStringSchema,
    version: exactNonEmptyStringSchema,
  });

export const sanitizedAdapterProfileIdentitySchema: z.ZodType<SanitizedAdapterProfileIdentity> =
  z.strictObject({
    adapter_id: exactNonEmptyStringSchema,
    adapter_version: exactNonEmptyStringSchema,
    profile_id: exactNonEmptyStringSchema,
  });

export const effectiveModelIdentitySchema: z.ZodType<EffectiveModelIdentity> =
  z.union([
    z.strictObject({
      assurance: z.literal("adapter_attested"),
      model_id: exactNonEmptyStringSchema,
      deployment_id: exactNonEmptyStringSchema.nullable(),
      observed_event_sha256: sha256Schema,
    }),
    z.strictObject({
      assurance: z.literal("unknown"),
      model_id: z.null(),
      deployment_id: z.null(),
      observed_event_sha256: z.null(),
    }),
  ]);

export const connectedRunProvenanceSchema: z.ZodType<ConnectedRunProvenance> =
  z.strictObject({
    role: provenanceValueSchema(exactNonEmptyStringSchema),
    seat: provenanceValueSchema(exactNonEmptyStringSchema),
    requested_model: provenanceValueSchema(exactNonEmptyStringSchema),
    effective_model: effectiveModelIdentitySchema,
    effort: provenanceValueSchema(exactNonEmptyStringSchema),
    harness: provenanceValueSchema(connectedRuntimeIdentitySchema),
    adapter_profile: provenanceValueSchema(
      sanitizedAdapterProfileIdentitySchema,
    ),
    resolved_profile_sha256: provenanceValueSchema(sha256Schema),
    resolved_skill_set_sha256: provenanceValueSchema(sha256Schema),
    authorization_sha256: provenanceValueSchema(sha256Schema),
  });

const connectedRunMissionReferenceSchema: z.ZodType<ConnectedRunMissionReference> =
  z.strictObject({
    identity: missionIdentitySchema,
    path: workspaceRelativePosixPathSchema,
    content_sha256: sha256Schema,
    source_commit: gitCommitSchema,
  });

export const connectedRunAuthorizationSchema: z.ZodType<ConnectedRunAuthorization> =
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("capability_envelope"),
      envelope: capabilityEnvelopeV1Schema,
      envelope_sha256: sha256Schema,
    }),
    z.strictObject({
      kind: z.literal("review_result_ingress"),
      result_path: workspaceRelativePosixPathSchema,
      policy_sha256: sha256Schema,
    }),
  ]);

const connectedRunProtocolIdentitySchema: z.ZodType<ConnectedRunProtocolIdentity> =
  z.strictObject({
    protocol_version: provenanceValueSchema(positiveSafeIntegerSchema),
    session_id: provenanceValueSchema(exactNonEmptyStringSchema),
  });

export const connectedRunLimitsSchema: z.ZodType<ConnectedRunLimits> =
  z.strictObject({
    wall_clock_timeout_ms: positiveSafeIntegerSchema,
    max_event_count: positiveSafeIntegerSchema,
    max_event_bytes: positiveSafeIntegerSchema,
    max_output_bytes: positiveSafeIntegerSchema,
    termination_grace_ms: nonNegativeSafeIntegerSchema,
    drain_grace_ms: nonNegativeSafeIntegerSchema,
  });

export const connectedRunProcessIdentitySchema: z.ZodType<ConnectedRunProcessIdentity> =
  z.strictObject({
    pid: positiveSafeIntegerSchema,
    process_group_id: positiveSafeIntegerSchema,
    started_at: z.iso.datetime(),
  });

export const connectedRunTerminalSchema: z.ZodType<ConnectedRunTerminal> =
  z.strictObject({
    outcome: z.enum(CONNECTED_RUN_TERMINAL_OUTCOMES),
    partial: z.boolean(),
    reason: exactNonEmptyStringSchema.nullable(),
  });

export const connectedRunLifecycleSchema: z.ZodType<ConnectedRunLifecycle> =
  z
    .strictObject({
      status: z.enum(CONNECTED_RUN_LIFECYCLE_STATUSES),
      started_at: z.iso.datetime(),
      updated_at: z.iso.datetime(),
      completed_at: z.iso.datetime().nullable(),
      terminal: connectedRunTerminalSchema.nullable(),
    })
    .superRefine((lifecycle, context) => {
      const isTerminal = lifecycle.status === "terminal";
      if (
        isTerminal !==
        (lifecycle.completed_at !== null && lifecycle.terminal !== null)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "terminal status requires completed_at and terminal outcome; nonterminal status forbids both",
          path: ["status"],
          input: lifecycle,
        });
      }

      if (
        lifecycle.terminal?.outcome === "completed" &&
        (lifecycle.terminal.partial || lifecycle.terminal.reason !== null)
      ) {
        context.addIssue({
          code: "custom",
          message: "completed outcome must be complete and have no failure reason",
          path: ["terminal"],
          input: lifecycle.terminal,
        });
      }
      if (
        lifecycle.terminal !== null &&
        lifecycle.terminal.outcome !== "completed" &&
        lifecycle.terminal.reason === null
      ) {
        context.addIssue({
          code: "custom",
          message: "non-completed terminal outcomes require a reason",
          path: ["terminal", "reason"],
          input: lifecycle.terminal,
        });
      }

      if (Date.parse(lifecycle.updated_at) < Date.parse(lifecycle.started_at)) {
        context.addIssue({
          code: "custom",
          message: "updated_at must not precede started_at",
          path: ["updated_at"],
          input: lifecycle.updated_at,
        });
      }
      if (
        lifecycle.completed_at !== null &&
        Date.parse(lifecycle.completed_at) < Date.parse(lifecycle.updated_at)
      ) {
        context.addIssue({
          code: "custom",
          message: "completed_at must not precede updated_at",
          path: ["completed_at"],
          input: lifecycle.completed_at,
        });
      }
    });

export const connectedRunDiagnosticSchema: z.ZodType<ConnectedRunDiagnostic> =
  z.strictObject({
    observed_at: z.iso.datetime(),
    code: exactNonEmptyStringSchema.max(100),
    message: z.string().trim().min(1).max(500),
  });

export const connectedRunDiagnosticsSchema: z.ZodType<ConnectedRunDiagnostics> =
  z.strictObject({
    entries: z.array(connectedRunDiagnosticSchema).max(20),
    truncated: z.boolean(),
  });

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalizeResolvedCapabilityEnvelope(
  envelope: CapabilityEnvelopeV1,
): CapabilityEnvelopeV1 {
  const parsed = capabilityEnvelopeV1Schema.parse(envelope);
  return {
    ...parsed,
    runtime: {
      ...parsed.runtime,
      approved_command_forms: [
        ...parsed.runtime.approved_command_forms,
      ].sort((left, right) =>
        compareCanonical(JSON.stringify(left), JSON.stringify(right)),
      ),
      approved_url_operations: [
        ...parsed.runtime.approved_url_operations,
      ].sort((left, right) =>
        compareCanonical(JSON.stringify(left), JSON.stringify(right)),
      ),
    },
  };
}

export function hashResolvedCapabilityEnvelope(
  envelope: CapabilityEnvelopeV1,
): string {
  const canonical = canonicalizeResolvedCapabilityEnvelope(envelope);
  return createHash("sha256")
    .update(`${JSON.stringify(canonical, null, 2)}\n`)
    .digest("hex");
}

export function connectedRunLaunchFingerprint(
  input: ConnectedRunRecordV2,
): string {
  const record = connectedRunRecordV2Schema.parse(input);
  const authorization =
    record.authorization.kind === "capability_envelope"
      ? {
          kind: record.authorization.kind,
          envelope_sha256: record.authorization.envelope_sha256,
        }
      : {
          kind: record.authorization.kind,
          policy_sha256: record.authorization.policy_sha256,
        };
  const launchIdentity = {
    schema_version: record.schema_version,
    phase: record.mission.identity.phase,
    mission: record.mission,
    governed_tuple: record.governed_tuple,
    provenance: {
      role: record.provenance.role,
      seat: record.provenance.seat,
      requested_model: record.provenance.requested_model,
      effort: record.provenance.effort,
      harness: record.provenance.harness,
      adapter_profile: record.provenance.adapter_profile,
      resolved_profile_sha256: record.provenance.resolved_profile_sha256,
      resolved_skill_set_sha256:
        record.provenance.resolved_skill_set_sha256,
      authorization_sha256: record.provenance.authorization_sha256,
    },
    authorization,
    acp_protocol_version: record.acp.protocol_version,
    limits: record.limits,
  };
  return createHash("sha256")
    .update(`${JSON.stringify(launchIdentity, null, 2)}\n`)
    .digest("hex");
}

export const connectedRunRecordV2Schema: z.ZodType<ConnectedRunRecordV2> =
  z
    .strictObject({
      schema_version: z.literal(CONNECTED_RUN_SCHEMA_VERSION),
      connected_run_id: z.uuid(),
      mission: connectedRunMissionReferenceSchema,
      governed_tuple: governedTupleSchema,
      provenance: connectedRunProvenanceSchema,
      authorization: connectedRunAuthorizationSchema,
      acp: connectedRunProtocolIdentitySchema,
      lifecycle: connectedRunLifecycleSchema,
      limits: connectedRunLimitsSchema,
      process: connectedRunProcessIdentitySchema.nullable(),
      diagnostics: connectedRunDiagnosticsSchema,
    })
    .superRefine((record, context) => {
      const identity = record.mission.identity;
      for (const field of [
        "goal_version",
        "input_revision",
        "attempt",
      ] as const) {
        if (record.governed_tuple[field] !== identity[field]) {
          context.addIssue({
            code: "custom",
            message: `governed_tuple ${field} must match mission identity`,
            path: ["governed_tuple", field],
            input: record.governed_tuple[field],
          });
        }
      }

      if (
        identity.phase === "patch" &&
        record.governed_tuple.patch_cycle !== identity.patch_cycle
      ) {
        context.addIssue({
          code: "custom",
          message: "governed_tuple patch_cycle must match mission identity",
          path: ["governed_tuple", "patch_cycle"],
          input: record.governed_tuple.patch_cycle,
        });
      }

      if (
        identity.phase === "review" &&
        record.authorization.kind !== "review_result_ingress"
      ) {
        context.addIssue({
          code: "custom",
          message: "review connected runs require review_result_ingress authorization",
          path: ["authorization", "kind"],
          input: record.authorization.kind,
        });
      }
      if (
        identity.phase !== "review" &&
        record.authorization.kind !== "capability_envelope"
      ) {
        context.addIssue({
          code: "custom",
          message: `${identity.phase} connected runs require capability_envelope authorization`,
          path: ["authorization", "kind"],
          input: record.authorization.kind,
        });
      }

      if (record.authorization.kind === "capability_envelope") {
        const expectedEnvelopeSha256 = hashResolvedCapabilityEnvelope(
          record.authorization.envelope,
        );
        if (record.authorization.envelope_sha256 !== expectedEnvelopeSha256) {
          context.addIssue({
            code: "custom",
            message: "envelope_sha256 must hash the resolved capability envelope",
            path: ["authorization", "envelope_sha256"],
            input: record.authorization.envelope_sha256,
          });
        }
      }

      if (record.lifecycle.status === "running" && record.process === null) {
        context.addIssue({
          code: "custom",
          message: "running connected run requires process identity",
          path: ["process"],
          input: record.process,
        });
      }
    });

const summaryLifecycleSchema = z
  .strictObject({
    status: z.enum(CONNECTED_RUN_LIFECYCLE_STATUSES),
    started_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
    completed_at: z.iso.datetime().nullable(),
    terminal_outcome: z.enum(CONNECTED_RUN_TERMINAL_OUTCOMES).nullable(),
    partial: z.boolean(),
  })
  .superRefine((lifecycle, context) => {
    const isTerminal = lifecycle.status === "terminal";
    if (
      isTerminal !==
      (lifecycle.completed_at !== null &&
        lifecycle.terminal_outcome !== null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "terminal summary requires completed_at and terminal_outcome; nonterminal summary forbids both",
        path: ["status"],
        input: lifecycle,
      });
    }
    if (
      lifecycle.partial &&
      (lifecycle.terminal_outcome === null ||
        lifecycle.terminal_outcome === "completed")
    ) {
      context.addIssue({
        code: "custom",
        message: "partial summary requires a non-completed terminal outcome",
        path: ["partial"],
        input: lifecycle.partial,
      });
    }
  });

export const connectedRunSummarySchema: z.ZodType<ConnectedRunSummary> =
  z
    .strictObject({
      schema_version: z.literal(CONNECTED_RUN_SCHEMA_VERSION),
      connected_run_id: z.uuid(),
      mission: z.strictObject({
        identity: missionIdentitySchema,
        content_sha256: sha256Schema,
        source_commit: gitCommitSchema,
      }),
      governed_tuple: governedTupleSchema,
      provenance: z.strictObject({
        role: provenanceValueSchema(exactNonEmptyStringSchema),
        seat: provenanceValueSchema(exactNonEmptyStringSchema),
        requested_model: provenanceValueSchema(exactNonEmptyStringSchema),
        effective_model: effectiveModelIdentitySchema,
        effort: provenanceValueSchema(exactNonEmptyStringSchema),
        harness: provenanceValueSchema(connectedRuntimeIdentitySchema),
        adapter_profile: provenanceValueSchema(
          sanitizedAdapterProfileIdentitySchema,
        ),
      }),
      authorization: z.discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("capability_envelope"),
          envelope_sha256: sha256Schema,
        }),
        z.strictObject({
          kind: z.literal("review_result_ingress"),
          policy_sha256: sha256Schema,
        }),
      ]),
      acp_protocol_version: provenanceValueSchema(positiveSafeIntegerSchema),
      lifecycle: summaryLifecycleSchema,
      diagnostics: z.strictObject({
        count: nonNegativeSafeIntegerSchema,
        truncated: z.boolean(),
      }),
    })
    .superRefine((summary, context) => {
      const isReview = summary.mission.identity.phase === "review";
      if (isReview !== (summary.authorization.kind === "review_result_ingress")) {
        context.addIssue({
          code: "custom",
          message: isReview
            ? "review connected-run summary requires review_result_ingress authorization"
            : `${summary.mission.identity.phase} connected-run summary requires capability_envelope authorization`,
          path: ["authorization", "kind"],
          input: summary.authorization.kind,
        });
      }
    });

export const launchConnectedExecuteInputSchema: z.ZodType<LaunchConnectedExecuteInput> =
  z.strictObject({
    expected_phase: z.literal("execute"),
    expected_status: z.literal("active"),
    expected_schema_version: z.literal(2),
    governed_tuple: governedTupleSchema,
    mission_content_sha256: sha256Schema,
    model_override: exactNonEmptyStringSchema.optional(),
  });

export function summarizeConnectedRun(
  input: ConnectedRunRecordV2,
): ConnectedRunSummary {
  const record = connectedRunRecordV2Schema.parse(input);
  return connectedRunSummarySchema.parse({
    schema_version: CONNECTED_RUN_SCHEMA_VERSION,
    connected_run_id: record.connected_run_id,
    mission: {
      identity: record.mission.identity,
      content_sha256: record.mission.content_sha256,
      source_commit: record.mission.source_commit,
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
    authorization:
      record.authorization.kind === "capability_envelope"
        ? {
            kind: record.authorization.kind,
            envelope_sha256: record.authorization.envelope_sha256,
          }
        : {
            kind: record.authorization.kind,
            policy_sha256: record.authorization.policy_sha256,
          },
    acp_protocol_version: record.acp.protocol_version,
    lifecycle: {
      status: record.lifecycle.status,
      started_at: record.lifecycle.started_at,
      updated_at: record.lifecycle.updated_at,
      completed_at: record.lifecycle.completed_at,
      terminal_outcome: record.lifecycle.terminal?.outcome ?? null,
      partial: record.lifecycle.terminal?.partial ?? false,
    },
    diagnostics: {
      count: record.diagnostics.entries.length,
      truncated: record.diagnostics.truncated,
    },
  });
}
