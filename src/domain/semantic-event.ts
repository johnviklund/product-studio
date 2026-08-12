import { createHash } from "node:crypto";

import { z } from "zod";

import {
  CONNECTED_RUN_LIFECYCLE_STATUSES,
  CONNECTED_RUN_TERMINAL_OUTCOMES,
  connectedRunProvenanceSchema,
  type ConnectedRunProvenance,
  type ConnectedRunTerminalOutcome,
} from "./connected-run";
import { MISSION_PHASES, type MissionPhase } from "./mission";
import {
  SHAPING_PHASES,
  shapingIdentitySchema,
  type ShapingIdentity,
  type ShapingPhase,
} from "./shaping";
import {
  shapingRunProvenanceSchema,
  type ShapingRunProvenance,
} from "./shaping-run";
import {
  WORK_ITEM_ATTENTION_KINDS,
  WORK_ITEM_PHASES,
  WORK_ITEM_STATUSES,
  governedTupleSchema,
  workItemIdSchema,
  type GovernedTuple,
  type WorkItemAttentionKind,
  type WorkItemPhase,
  type WorkItemStatus,
} from "./work-item";
import { workspaceRelativePosixPathSchema } from "./workspace-path";

export const SEMANTIC_EVENT_SCHEMA_VERSION = 1 as const;
export const SEMANTIC_EVENT_STREAM_SCHEMA_VERSION = 1 as const;
export const SEMANTIC_EVENT_OUTCOME_MAX_BYTES = 280 as const;

export const SEMANTIC_EVENT_KINDS = [
  "run_launched",
  "run_finished",
  "permission_denied",
  "permission_decided",
  "workflow_transitioned",
  "goal_contract_revised",
  "attention_requested",
  "human_decision_recorded",
] as const;

export const SEMANTIC_EVIDENCE_KINDS = [
  "controller_run",
  "shaping_decision",
  "shaping_receipt",
  "plan_approval",
  "mission",
  "shaping_instruction",
  "applied_result",
  "import_evidence",
  "connected_run",
  "shaping_run",
] as const;

export const SEMANTIC_SOURCE_KINDS = [
  "controller_run",
  "shaping_decision",
  "plan_approval",
  "connected_run",
  "shaping_run",
] as const;

export const SEMANTIC_HUMAN_DECISIONS = [
  "start_brainstorm",
  "request_shaping_changes",
  "use_brainstorm_result",
  "approve_spec_result",
  "replan_with_updated_contract",
  "approve_plan_result",
  "accept_review_import_drift",
  "approve_review_result",
  "accept_patch_plan",
] as const;

export type SemanticEventKindV1 = (typeof SEMANTIC_EVENT_KINDS)[number];
export type SemanticEvidenceKindV1 =
  (typeof SEMANTIC_EVIDENCE_KINDS)[number];
export type SemanticSourceKindV1 = (typeof SEMANTIC_SOURCE_KINDS)[number];
export type SemanticHumanDecisionV1 =
  (typeof SEMANTIC_HUMAN_DECISIONS)[number];

export interface GovernedSemanticWorkflowBindingV1 {
  kind: "governed";
  governed_tuple: GovernedTuple;
  phase: WorkItemPhase;
  status: WorkItemStatus;
}

export interface ShapingSemanticWorkflowBindingV1 {
  kind: "shaping";
  identity: ShapingIdentity;
}

export type SemanticWorkflowBindingV1 =
  | GovernedSemanticWorkflowBindingV1
  | ShapingSemanticWorkflowBindingV1;

export type SemanticActorV1 =
  | {
      kind: "connected_run";
      connected_run_id: string;
      provenance: ConnectedRunProvenance;
    }
  | {
      kind: "shaping_run";
      shaping_run_id: string;
      provenance: ShapingRunProvenance;
    }
  | { kind: "controller" }
  | { kind: "founder" };

export type SemanticRunReferenceV1 =
  | {
      family: "connected";
      connected_run_id: string;
      phase: MissionPhase;
    }
  | {
      family: "shaping";
      shaping_run_id: string;
      phase: ShapingPhase;
    };

export interface SemanticEvidenceSelectorV1 {
  kind: SemanticEvidenceKindV1;
  path: string;
  expected_content_sha256: string;
}

export interface SemanticEvidenceHandleV1 {
  kind: SemanticEvidenceKindV1;
  path: string;
  content_sha256: string;
}

export interface SemanticActionReferenceV1 {
  kind: "work_item_attention";
  attention_kind: WorkItemAttentionKind;
  reference_sha256: string;
}

export type SemanticAuthoritativeSourceV1 =
  | {
      kind: "controller_run";
      controller_run_id: string;
      expected_outcome: "applied";
    }
  | {
      kind: "shaping_decision";
      decision_id: string;
      expected_outcome: "applied";
    }
  | {
      kind: "plan_approval";
      approval_id: string;
      expected_outcome: "applied";
    }
  | {
      kind: "connected_run";
      connected_run_id: string;
      expected_lifecycle_status: "starting" | "running" | "terminal";
      mission_content_sha256: string;
    }
  | {
      kind: "shaping_run";
      shaping_run_id: string;
      expected_lifecycle_status: "starting" | "running" | "terminal";
      mission_content_sha256: string;
    };

export type SemanticEventDetailsV1 =
  | {
      kind: "run_launched";
      run_family: "connected" | "shaping";
      phase: MissionPhase | ShapingPhase;
      run_id: string;
      lifecycle_status: "starting" | "running";
    }
  | {
      kind: "run_finished";
      run_family: "connected" | "shaping";
      phase: MissionPhase | ShapingPhase;
      run_id: string;
      terminal_outcome: ConnectedRunTerminalOutcome;
      partial: boolean;
    }
  | {
      kind: "permission_denied";
      connected_run_id: string;
      operation_sha256: string;
      canonical_args_sha256: string;
      reason_code: string;
      attention_kind: "missing_permission" | "command_authorization";
    }
  | {
      kind: "permission_decided";
      decision: "allow_once" | "retry_without_allowing";
      operation_sha256: string;
      next_attempt: number | null;
    }
  | {
      kind: "workflow_transitioned";
      before: SemanticWorkflowBindingV1;
      after: SemanticWorkflowBindingV1;
    }
  | {
      kind: "goal_contract_revised";
      previous_goal_version: number | null;
      previous_input_revision: number | null;
      next_goal_version: number;
      next_input_revision: number;
      goal_contract_sha256: string;
    }
  | {
      kind: "attention_requested";
      attention_kind: WorkItemAttentionKind;
      reference_sha256: string;
    }
  | {
      kind: "human_decision_recorded";
      decision: SemanticHumanDecisionV1;
      disposition: "accepted" | "rejected" | "request_changes";
      decision_sha256: string;
      result_content_sha256: string | null;
    };

export interface SemanticEventIntentV1 {
  schema_version: 1;
  intent_id: string;
  source: SemanticAuthoritativeSourceV1;
  slot: string;
  kind: SemanticEventKindV1;
  work_item_id: string;
  binding: SemanticWorkflowBindingV1;
  run: SemanticRunReferenceV1 | null;
  actor: SemanticActorV1;
  outcome: string;
  occurred_at: string;
  evidence: [SemanticEvidenceSelectorV1, ...SemanticEvidenceSelectorV1[]];
  action: SemanticActionReferenceV1 | null;
  details: SemanticEventDetailsV1;
}

export interface SemanticEventV1 {
  schema_version: 1;
  event_id: string;
  stream_sequence: number;
  kind: SemanticEventKindV1;
  work_item_id: string;
  binding: SemanticWorkflowBindingV1;
  run: SemanticRunReferenceV1 | null;
  actor: SemanticActorV1;
  outcome: string;
  occurred_at: string;
  recorded_at: string;
  evidence: [SemanticEvidenceHandleV1, ...SemanticEvidenceHandleV1[]];
  action: SemanticActionReferenceV1 | null;
  details: SemanticEventDetailsV1;
  intent_id: string;
}

export interface SemanticEventStreamHeaderV1 {
  schema_version: 1;
  work_item_id: string;
}

export interface SemanticIntentIdInputV1 {
  source: SemanticAuthoritativeSourceV1;
  kind: SemanticEventKindV1;
  slot: string;
}

export interface SemanticEventIdInputV1 {
  schema_version: 1;
  work_item_id: string;
  binding: SemanticWorkflowBindingV1;
  kind: SemanticEventKindV1;
  stream_sequence: number;
}

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const positiveSafeIntegerSchema = z.number().int().positive().safe();
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const uuidSchema = z.uuid();
const boundedIdentifierSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u);

const governedSemanticWorkflowBindingSchema = z.strictObject({
  kind: z.literal("governed"),
  governed_tuple: governedTupleSchema,
  phase: z.enum(WORK_ITEM_PHASES),
  status: z.enum(WORK_ITEM_STATUSES),
});

const shapingSemanticWorkflowBindingSchema = z.strictObject({
  kind: z.literal("shaping"),
  identity: shapingIdentitySchema,
});

export const semanticWorkflowBindingSchema = z.discriminatedUnion("kind", [
    governedSemanticWorkflowBindingSchema,
    shapingSemanticWorkflowBindingSchema,
  ]) as z.ZodType<SemanticWorkflowBindingV1>;

export const semanticActorSchema: z.ZodType<SemanticActorV1> =
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("connected_run"),
      connected_run_id: uuidSchema,
      provenance: connectedRunProvenanceSchema,
    }),
    z.strictObject({
      kind: z.literal("shaping_run"),
      shaping_run_id: uuidSchema,
      provenance: shapingRunProvenanceSchema,
    }),
    z.strictObject({ kind: z.literal("controller") }),
    z.strictObject({ kind: z.literal("founder") }),
  ]);

export const semanticRunReferenceSchema: z.ZodType<SemanticRunReferenceV1> =
  z.discriminatedUnion("family", [
    z.strictObject({
      family: z.literal("connected"),
      connected_run_id: uuidSchema,
      phase: z.enum(MISSION_PHASES),
    }),
    z.strictObject({
      family: z.literal("shaping"),
      shaping_run_id: uuidSchema,
      phase: z.enum(SHAPING_PHASES),
    }),
  ]);

export const semanticEvidenceSelectorSchema: z.ZodType<SemanticEvidenceSelectorV1> =
  z.strictObject({
    kind: z.enum(SEMANTIC_EVIDENCE_KINDS),
    path: workspaceRelativePosixPathSchema,
    expected_content_sha256: sha256Schema,
  });

export const semanticEvidenceHandleSchema: z.ZodType<SemanticEvidenceHandleV1> =
  z.strictObject({
    kind: z.enum(SEMANTIC_EVIDENCE_KINDS),
    path: workspaceRelativePosixPathSchema,
    content_sha256: sha256Schema,
  });

export const semanticActionReferenceSchema: z.ZodType<SemanticActionReferenceV1> =
  z.strictObject({
    kind: z.literal("work_item_attention"),
    attention_kind: z.enum(WORK_ITEM_ATTENTION_KINDS),
    reference_sha256: sha256Schema,
  });

export const semanticAuthoritativeSourceSchema: z.ZodType<SemanticAuthoritativeSourceV1> =
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("controller_run"),
      controller_run_id: uuidSchema,
      expected_outcome: z.literal("applied"),
    }),
    z.strictObject({
      kind: z.literal("shaping_decision"),
      decision_id: sha256Schema,
      expected_outcome: z.literal("applied"),
    }),
    z.strictObject({
      kind: z.literal("plan_approval"),
      approval_id: sha256Schema,
      expected_outcome: z.literal("applied"),
    }),
    z.strictObject({
      kind: z.literal("connected_run"),
      connected_run_id: uuidSchema,
      expected_lifecycle_status: z.enum(CONNECTED_RUN_LIFECYCLE_STATUSES),
      mission_content_sha256: sha256Schema,
    }),
    z.strictObject({
      kind: z.literal("shaping_run"),
      shaping_run_id: uuidSchema,
      expected_lifecycle_status: z.enum(CONNECTED_RUN_LIFECYCLE_STATUSES),
      mission_content_sha256: sha256Schema,
    }),
  ]);

const runPhaseSchema = z.union([
  z.enum(MISSION_PHASES),
  z.enum(SHAPING_PHASES),
]);

const runLaunchedDetailsSchema = z.strictObject({
  kind: z.literal("run_launched"),
  run_family: z.enum(["connected", "shaping"]),
  phase: runPhaseSchema,
  run_id: uuidSchema,
  lifecycle_status: z.enum(["starting", "running"]),
});

const runFinishedDetailsSchema = z.strictObject({
  kind: z.literal("run_finished"),
  run_family: z.enum(["connected", "shaping"]),
  phase: runPhaseSchema,
  run_id: uuidSchema,
  terminal_outcome: z.enum(CONNECTED_RUN_TERMINAL_OUTCOMES),
  partial: z.boolean(),
});

const permissionDeniedDetailsSchema = z.strictObject({
  kind: z.literal("permission_denied"),
  connected_run_id: uuidSchema,
  operation_sha256: sha256Schema,
  canonical_args_sha256: sha256Schema,
  reason_code: boundedIdentifierSchema,
  attention_kind: z.enum(["missing_permission", "command_authorization"]),
});

const permissionDecidedDetailsSchema = z.strictObject({
  kind: z.literal("permission_decided"),
  decision: z.enum(["allow_once", "retry_without_allowing"]),
  operation_sha256: sha256Schema,
  next_attempt: nonNegativeSafeIntegerSchema.nullable(),
});

const workflowTransitionedDetailsSchema = z.strictObject({
  kind: z.literal("workflow_transitioned"),
  before: semanticWorkflowBindingSchema,
  after: semanticWorkflowBindingSchema,
});

const goalContractRevisedDetailsSchema = z.strictObject({
  kind: z.literal("goal_contract_revised"),
  previous_goal_version: positiveSafeIntegerSchema.nullable(),
  previous_input_revision: positiveSafeIntegerSchema.nullable(),
  next_goal_version: positiveSafeIntegerSchema,
  next_input_revision: positiveSafeIntegerSchema,
  goal_contract_sha256: sha256Schema,
});

const attentionRequestedDetailsSchema = z.strictObject({
  kind: z.literal("attention_requested"),
  attention_kind: z.enum(WORK_ITEM_ATTENTION_KINDS),
  reference_sha256: sha256Schema,
});

const humanDecisionRecordedDetailsSchema = z.strictObject({
  kind: z.literal("human_decision_recorded"),
  decision: z.enum(SEMANTIC_HUMAN_DECISIONS),
  disposition: z.enum(["accepted", "rejected", "request_changes"]),
  decision_sha256: sha256Schema,
  result_content_sha256: sha256Schema.nullable(),
});

export const semanticEventDetailsSchema: z.ZodType<SemanticEventDetailsV1> =
  z.discriminatedUnion("kind", [
    runLaunchedDetailsSchema,
    runFinishedDetailsSchema,
    permissionDeniedDetailsSchema,
    permissionDecidedDetailsSchema,
    workflowTransitionedDetailsSchema,
    goalContractRevisedDetailsSchema,
    attentionRequestedDetailsSchema,
    humanDecisionRecordedDetailsSchema,
  ]);

function truncateUtf8(value: string, maxBytes: number): string {
  const suffix = "...[TRUNCATED]";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  if (maxBytes <= Buffer.byteLength(suffix, "utf8")) {
    return "";
  }

  const availableBytes = maxBytes - Buffer.byteLength(suffix, "utf8");
  let result = "";
  let usedBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + characterBytes > availableBytes) {
      break;
    }
    result += character;
    usedBytes += characterBytes;
  }
  return `${result}${suffix}`;
}

export function sanitizeSemanticOutcome(value: string): string {
  const parsed = z
    .string()
    .min(1)
    .refine(
      (candidate) => candidate === candidate.trim(),
      "must not have leading or trailing whitespace",
    )
    .refine(
      (candidate) => !/[\u0000-\u001f\u007f]/u.test(candidate),
      "must not contain control characters",
    )
    .parse(value);
  return truncateUtf8(parsed, SEMANTIC_EVENT_OUTCOME_MAX_BYTES);
}

export const semanticOutcomeSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value === value.trim(),
    "must not have leading or trailing whitespace",
  )
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "must not contain control characters",
  )
  .transform((value) =>
    truncateUtf8(value, SEMANTIC_EVENT_OUTCOME_MAX_BYTES),
  );

const semanticEvidenceSelectorListSchema: z.ZodType<
  [SemanticEvidenceSelectorV1, ...SemanticEvidenceSelectorV1[]]
> = z.tuple(
  [semanticEvidenceSelectorSchema],
  semanticEvidenceSelectorSchema,
);

const semanticEvidenceHandleListSchema: z.ZodType<
  [SemanticEvidenceHandleV1, ...SemanticEvidenceHandleV1[]]
> = z.tuple([semanticEvidenceHandleSchema], semanticEvidenceHandleSchema);

export const semanticEventIntentSchema: z.ZodType<SemanticEventIntentV1> = z
  .strictObject({
    schema_version: z.literal(SEMANTIC_EVENT_SCHEMA_VERSION),
    intent_id: sha256Schema,
    source: semanticAuthoritativeSourceSchema,
    slot: boundedIdentifierSchema,
    kind: z.enum(SEMANTIC_EVENT_KINDS),
    work_item_id: workItemIdSchema,
    binding: semanticWorkflowBindingSchema,
    run: semanticRunReferenceSchema.nullable(),
    actor: semanticActorSchema,
    outcome: semanticOutcomeSchema,
    occurred_at: z.iso.datetime(),
    evidence: semanticEvidenceSelectorListSchema,
    action: semanticActionReferenceSchema.nullable(),
    details: semanticEventDetailsSchema,
  })
  .superRefine((intent, context) => {
    if (intent.kind !== intent.details.kind) {
      context.addIssue({
        code: "custom",
        message: "event kind must match details kind",
        path: ["details", "kind"],
        input: intent.details.kind,
      });
    }
    if (deriveSemanticIntentId(intent) !== intent.intent_id) {
      context.addIssue({
        code: "custom",
        message: "intent_id must match the canonical source occurrence",
        path: ["intent_id"],
        input: intent.intent_id,
      });
    }
  });

export const semanticEventSchema: z.ZodType<SemanticEventV1> = z
  .strictObject({
    schema_version: z.literal(SEMANTIC_EVENT_SCHEMA_VERSION),
    event_id: sha256Schema,
    stream_sequence: positiveSafeIntegerSchema,
    kind: z.enum(SEMANTIC_EVENT_KINDS),
    work_item_id: workItemIdSchema,
    binding: semanticWorkflowBindingSchema,
    run: semanticRunReferenceSchema.nullable(),
    actor: semanticActorSchema,
    outcome: semanticOutcomeSchema,
    occurred_at: z.iso.datetime(),
    recorded_at: z.iso.datetime(),
    evidence: semanticEvidenceHandleListSchema,
    action: semanticActionReferenceSchema.nullable(),
    details: semanticEventDetailsSchema,
    intent_id: sha256Schema,
  })
  .superRefine((event, context) => {
    if (event.kind !== event.details.kind) {
      context.addIssue({
        code: "custom",
        message: "event kind must match details kind",
        path: ["details", "kind"],
        input: event.details.kind,
      });
    }
    if (deriveSemanticEventId(event) !== event.event_id) {
      context.addIssue({
        code: "custom",
        message: "event_id must match the canonical stream position",
        path: ["event_id"],
        input: event.event_id,
      });
    }
  });

export const semanticEventStreamHeaderSchema: z.ZodType<SemanticEventStreamHeaderV1> =
  z.strictObject({
    schema_version: z.literal(SEMANTIC_EVENT_STREAM_SCHEMA_VERSION),
    work_item_id: workItemIdSchema,
  });

export const semanticIntentIdInputSchema: z.ZodType<SemanticIntentIdInputV1> =
  z.strictObject({
    source: semanticAuthoritativeSourceSchema,
    kind: z.enum(SEMANTIC_EVENT_KINDS),
    slot: boundedIdentifierSchema,
  });

export const semanticEventIdInputSchema: z.ZodType<SemanticEventIdInputV1> =
  z.strictObject({
    schema_version: z.literal(SEMANTIC_EVENT_SCHEMA_VERSION),
    work_item_id: workItemIdSchema,
    binding: semanticWorkflowBindingSchema,
    kind: z.enum(SEMANTIC_EVENT_KINDS),
    stream_sequence: positiveSafeIntegerSchema,
  });

function sourceIdentity(source: SemanticAuthoritativeSourceV1): string {
  switch (source.kind) {
    case "controller_run":
      return source.controller_run_id;
    case "shaping_decision":
      return source.decision_id;
    case "plan_approval":
      return source.approval_id;
    case "connected_run":
      return source.connected_run_id;
    case "shaping_run":
      return source.shaping_run_id;
  }
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function deriveSemanticIntentId(
  input: SemanticIntentIdInputV1,
): string {
  const parsed = semanticIntentIdInputSchema.parse({
    source: input.source,
    kind: input.kind,
    slot: input.slot,
  });
  return createHash("sha256")
    .update(
      canonicalJson({
        source_family: parsed.source.kind,
        source_id: sourceIdentity(parsed.source),
        kind: parsed.kind,
        slot: parsed.slot,
      }),
    )
    .digest("hex");
}

export function deriveSemanticEventId(input: SemanticEventIdInputV1): string {
  const parsed = semanticEventIdInputSchema.parse({
    schema_version: input.schema_version,
    work_item_id: input.work_item_id,
    binding: input.binding,
    kind: input.kind,
    stream_sequence: input.stream_sequence,
  });
  return createHash("sha256")
    .update(
      canonicalJson({
        schema_version: parsed.schema_version,
        work_item_id: parsed.work_item_id,
        binding: parsed.binding,
        kind: parsed.kind,
        stream_sequence: parsed.stream_sequence,
      }),
    )
    .digest("hex");
}

export function canonicalSerializeSemanticEventIntent(
  input: SemanticEventIntentV1,
): string {
  const intent = semanticEventIntentSchema.parse(input);
  return canonicalJson({
    schema_version: intent.schema_version,
    intent_id: intent.intent_id,
    source: intent.source,
    slot: intent.slot,
    kind: intent.kind,
    work_item_id: intent.work_item_id,
    binding: intent.binding,
    run: intent.run,
    actor: intent.actor,
    outcome: intent.outcome,
    occurred_at: intent.occurred_at,
    evidence: intent.evidence,
    action: intent.action,
    details: intent.details,
  });
}

export function canonicalSerializeSemanticEvent(
  input: SemanticEventV1,
): string {
  const event = semanticEventSchema.parse(input);
  return canonicalJson({
    schema_version: event.schema_version,
    event_id: event.event_id,
    stream_sequence: event.stream_sequence,
    kind: event.kind,
    work_item_id: event.work_item_id,
    binding: event.binding,
    run: event.run,
    actor: event.actor,
    outcome: event.outcome,
    occurred_at: event.occurred_at,
    recorded_at: event.recorded_at,
    evidence: event.evidence,
    action: event.action,
    details: event.details,
    intent_id: event.intent_id,
  });
}
