import { createHash } from "node:crypto";

import { z } from "zod";

import {
  canonicalizeCapabilityRequest,
  type CanonicalCapabilityRequest,
} from "./capability-envelope";
import {
  connectedRunDiagnosticsSchema,
  connectedRunLifecycleSchema,
  connectedRunLimitsSchema,
  connectedRunProcessIdentitySchema,
  connectedRuntimeIdentitySchema,
  effectiveModelIdentitySchema,
  provenanceValueSchema,
  sanitizedAdapterProfileIdentitySchema,
  type ConnectedRunDiagnostics,
  type ConnectedRunLifecycle,
  type ConnectedRunLifecycleStatus,
  type ConnectedRunLimits,
  type ConnectedRunProcessIdentity,
  type ConnectedRunTerminalOutcome,
  type ConnectedRuntimeIdentity,
  type EffectiveModelIdentity,
  type ProvenanceValue,
  type SanitizedAdapterProfileIdentity,
} from "./connected-run";
import {
  SHAPING_PHASES,
  type ShapingIngressInstructionV1,
  type ShapingPhase,
} from "./shaping";
import { workItemIdSchema } from "./work-item";
import { workspaceRelativePosixPathSchema } from "./workspace-path";

export const SHAPING_RUN_SCHEMA_VERSION = 1 as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
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

export interface ShapingRunMissionReference {
  phase: ShapingPhase;
  work_item_id: string;
  input_sha256: string;
  content_sha256: string;
}

export interface ShapingRunWritePolicy {
  kind: "single_ingress_file";
  ingress_path: string;
  instruction_sha256: string;
  commands: "forbidden";
  urls: "forbidden";
  mcp: "forbidden";
  credentials: "forbidden";
  outside_workspace_writes: "forbidden";
  reads: "workspace_and_repository_unrestricted";
  execution_mode: "permission_mediated_local";
  result_assurance: "result_scope_validation";
  containment_assurance: "not_independently_enforced";
  machine_authority: "launching_user";
}

export interface ShapingRunProvenance {
  role: ProvenanceValue<string>;
  seat: ProvenanceValue<string>;
  requested_model: ProvenanceValue<string>;
  effective_model: EffectiveModelIdentity;
  effort: ProvenanceValue<string>;
  harness: ProvenanceValue<ConnectedRuntimeIdentity>;
  adapter_profile: ProvenanceValue<SanitizedAdapterProfileIdentity>;
  resolved_profile_sha256: ProvenanceValue<string>;
  resolved_skill_set_sha256: ProvenanceValue<string>;
}

export interface ShapingRunRecordV1 {
  schema_version: 1;
  shaping_run_id: string;
  mission: ShapingRunMissionReference;
  provenance: ShapingRunProvenance;
  write_policy: ShapingRunWritePolicy;
  lifecycle: ConnectedRunLifecycle;
  limits: ConnectedRunLimits;
  process: ConnectedRunProcessIdentity | null;
  diagnostics: ConnectedRunDiagnostics;
}

export interface ShapingRunSummary {
  schema_version: 1;
  shaping_run_id: string;
  mission: ShapingRunMissionReference;
  provenance: Pick<
    ShapingRunProvenance,
    | "role"
    | "seat"
    | "requested_model"
    | "effective_model"
    | "effort"
    | "harness"
    | "adapter_profile"
  >;
  write_policy: ShapingRunWritePolicy;
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

interface ShapingProductionReceiptBase {
  schema_version: 1;
  production_id: string;
  produced_at: string;
  ingress_path: string;
  result_content_sha256: string;
}

export interface ConnectedShapingProductionReceipt
  extends ShapingProductionReceiptBase {
  origin: "connected_run";
  shaping_run_id: string;
  requested_model: ProvenanceValue<string>;
  effective_model: EffectiveModelIdentity;
}

export interface ManualShapingProductionReceipt
  extends ShapingProductionReceiptBase {
  origin: "manual_import";
  shaping_run_id: null;
  requested_model: { value: null; assurance: "unknown" };
  effective_model: {
    assurance: "unknown";
    model_id: null;
    deployment_id: null;
    observed_event_sha256: null;
  };
}

export type ShapingProductionReceipt =
  | ConnectedShapingProductionReceipt
  | ManualShapingProductionReceipt;

export interface ShapingPermissionEvaluation {
  decision: "allow_once" | "reject_once";
  reason: string | null;
}

export const shapingRunMissionReferenceSchema: z.ZodType<ShapingRunMissionReference> =
  z.strictObject({
    phase: z.enum(SHAPING_PHASES),
    work_item_id: workItemIdSchema,
    input_sha256: sha256Schema,
    content_sha256: sha256Schema,
  });

export const shapingRunWritePolicySchema: z.ZodType<ShapingRunWritePolicy> =
  z.strictObject({
    kind: z.literal("single_ingress_file"),
    ingress_path: workspaceRelativePosixPathSchema,
    instruction_sha256: sha256Schema,
    commands: z.literal("forbidden"),
    urls: z.literal("forbidden"),
    mcp: z.literal("forbidden"),
    credentials: z.literal("forbidden"),
    outside_workspace_writes: z.literal("forbidden"),
    reads: z.literal("workspace_and_repository_unrestricted"),
    execution_mode: z.literal("permission_mediated_local"),
    result_assurance: z.literal("result_scope_validation"),
    containment_assurance: z.literal("not_independently_enforced"),
    machine_authority: z.literal("launching_user"),
  });

export const shapingRunProvenanceSchema: z.ZodType<ShapingRunProvenance> =
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
  });

export const shapingRunRecordV1Schema: z.ZodType<ShapingRunRecordV1> = z
  .strictObject({
    schema_version: z.literal(SHAPING_RUN_SCHEMA_VERSION),
    shaping_run_id: z.uuid(),
    mission: shapingRunMissionReferenceSchema,
    provenance: shapingRunProvenanceSchema,
    write_policy: shapingRunWritePolicySchema,
    lifecycle: connectedRunLifecycleSchema,
    limits: connectedRunLimitsSchema,
    process: connectedRunProcessIdentitySchema.nullable(),
    diagnostics: connectedRunDiagnosticsSchema,
  })
  .superRefine((record, context) => {
    if (record.lifecycle.status === "running" && record.process === null) {
      context.addIssue({
        code: "custom",
        message: "running shaping run requires process identity",
        path: ["process"],
        input: record.process,
      });
    }
  });

const shapingRunSummaryLifecycleSchema = z
  .strictObject({
    status: z.enum(["starting", "running", "terminal"]),
    started_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
    completed_at: z.iso.datetime().nullable(),
    terminal_outcome: z
      .enum([
        "completed",
        "missing_permission",
        "failed",
        "cancelled",
        "timed_out",
        "interrupted",
      ])
      .nullable(),
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

export const shapingRunSummarySchema: z.ZodType<ShapingRunSummary> =
  z.strictObject({
    schema_version: z.literal(SHAPING_RUN_SCHEMA_VERSION),
    shaping_run_id: z.uuid(),
    mission: shapingRunMissionReferenceSchema,
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
    write_policy: shapingRunWritePolicySchema,
    lifecycle: shapingRunSummaryLifecycleSchema,
    diagnostics: z.strictObject({
      count: nonNegativeSafeIntegerSchema,
      truncated: z.boolean(),
    }),
  });

const productionReceiptCommonShape = {
  schema_version: z.literal(SHAPING_RUN_SCHEMA_VERSION),
  produced_at: z.iso.datetime(),
  ingress_path: workspaceRelativePosixPathSchema,
  result_content_sha256: sha256Schema,
};

const connectedShapingProductionReceiptSchema: z.ZodType<ConnectedShapingProductionReceipt> =
  z
    .strictObject({
      ...productionReceiptCommonShape,
      production_id: z.uuid(),
      origin: z.literal("connected_run"),
      shaping_run_id: z.uuid(),
      requested_model: provenanceValueSchema(exactNonEmptyStringSchema),
      effective_model: effectiveModelIdentitySchema,
    })
    .superRefine((receipt, context) => {
      if (receipt.production_id !== receipt.shaping_run_id) {
        context.addIssue({
          code: "custom",
          message: "connected production_id must equal shaping_run_id",
          path: ["production_id"],
          input: receipt.production_id,
        });
      }
    });

const unknownRequestedModelSchema = z.strictObject({
  value: z.null(),
  assurance: z.literal("unknown"),
});
const unknownEffectiveModelSchema = z.strictObject({
  assurance: z.literal("unknown"),
  model_id: z.null(),
  deployment_id: z.null(),
  observed_event_sha256: z.null(),
});

const manualShapingProductionReceiptSchema: z.ZodType<ManualShapingProductionReceipt> =
  z.strictObject({
    ...productionReceiptCommonShape,
    production_id: sha256Schema,
    origin: z.literal("manual_import"),
    shaping_run_id: z.null(),
    requested_model: unknownRequestedModelSchema,
    effective_model: unknownEffectiveModelSchema,
  });

export const shapingProductionReceiptSchema: z.ZodType<ShapingProductionReceipt> =
  z.union([
    connectedShapingProductionReceiptSchema,
    manualShapingProductionReceiptSchema,
  ]);

export function summarizeShapingRun(
  input: ShapingRunRecordV1,
): ShapingRunSummary {
  const record = shapingRunRecordV1Schema.parse(input);
  return shapingRunSummarySchema.parse({
    schema_version: SHAPING_RUN_SCHEMA_VERSION,
    shaping_run_id: record.shaping_run_id,
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
    write_policy: record.write_policy,
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

export function evaluateShapingPermissionRequest(
  instruction: ShapingIngressInstructionV1,
  policy: ShapingRunWritePolicy,
  normalizedRequest: CanonicalCapabilityRequest,
): ShapingPermissionEvaluation {
  if (instruction.instruction_sha256 !== policy.instruction_sha256) {
    return { decision: "reject_once", reason: "instruction_sha256_mismatch" };
  }
  if (instruction.ingress_path !== policy.ingress_path) {
    return { decision: "reject_once", reason: "ingress_path_mismatch" };
  }

  const validatedPolicy = shapingRunWritePolicySchema.parse(policy);
  const request = canonicalizeCapabilityRequest(normalizedRequest);
  if (
    request.kind === "workspace_write" &&
    request.path === validatedPolicy.ingress_path
  ) {
    return { decision: "allow_once", reason: null };
  }
  if (request.kind === "workspace_write") {
    return { decision: "reject_once", reason: "write_path_not_allowed" };
  }
  return { decision: "reject_once", reason: "request_kind_forbidden" };
}

export function deriveManualShapingProductionId(
  missionContentSha256: string,
  resultContentSha256: string,
): string {
  const mission = sha256Schema.parse(missionContentSha256);
  const result = sha256Schema.parse(resultContentSha256);
  return createHash("sha256")
    .update(mission)
    .update("\0")
    .update(result)
    .update("\0")
    .update("manual_import")
    .digest("hex");
}

export function shapingRunLaunchFingerprint(
  missionContentSha256: string,
  requestedModel: string,
): string {
  const mission = sha256Schema.parse(missionContentSha256);
  const model = exactNonEmptyStringSchema.parse(requestedModel);
  return createHash("sha256")
    .update(mission)
    .update("\0")
    .update(model)
    .digest("hex");
}
