import { createHash } from "node:crypto";

import { z } from "zod";

import {
  controllerRunIdSchema,
  goalContractSchema,
  WORK_ITEM_PHASES,
  WORK_ITEM_STATUSES,
  workItemIdSchema,
  type GoalContract,
  type WorkItemPhase,
  type WorkItemStatus,
} from "./work-item";
import { workspaceRelativePosixPathSchema } from "./workspace-path";
import type { ShapingProductionReceipt } from "./shaping-run";

export const SHAPING_SCHEMA_VERSION = 2 as const;
export const SHAPING_PHASES = ["brainstorm", "spec", "plan"] as const;
export const SHAPING_INGRESS_MAX_BYTES = 262_144 as const;
export const SHAPING_DECISION_OPERATIONS = [
  "start_brainstorm",
  "use_brainstorm_result",
  "approve_spec",
  "request_changes",
  "replan_with_updated_contract",
] as const;

export type ShapingPhase = (typeof SHAPING_PHASES)[number];
export type ShapingDecisionOperation =
  (typeof SHAPING_DECISION_OPERATIONS)[number];

export function isShapingPhase(phase: WorkItemPhase): phase is ShapingPhase {
  return SHAPING_PHASES.some((candidate) => candidate === phase);
}

const BRAINSTORM_RESULT_REQUIRED_FIELDS = [
  "result_schema_version",
  "brainstorm_mission_content_sha256",
  "identity",
  "problem_statement",
  "approach",
  "non_goals",
  "open_questions",
] as const;

const SPEC_RESULT_REQUIRED_FIELDS = [
  "result_schema_version",
  "spec_mission_content_sha256",
  "identity",
  "proposal",
] as const;

export const PLAN_RESULT_REQUIRED_FIELDS = [
  "result_schema_version",
  "plan_mission_content_sha256",
  "identity",
  "summary",
  "checklist",
  "relevant_skills",
  "product_doc_impacts",
  "todo_impacts",
  "open_questions",
] as const;

const FORBIDDEN_MISSION_KEY_NAMES = new Set([
  "output_path",
  "task_path",
  "mission_path",
  "ingress_path",
  "result_path",
  "artifact_path",
  "workspace_path",
  "shaping_run_id",
  "run_id",
  "production_id",
  "connected_run_id",
]);

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const gitCommitSchema = z.string().regex(/^[0-9a-f]{40}$/);
const positiveSafeIntegerSchema = z.number().int().positive().safe();
const nonEmptyTrimmedStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be empty")
  .refine(
    (value) => value === value.trim(),
    "must not have leading or trailing whitespace",
  );
const boundedReasonSchema = nonEmptyTrimmedStringSchema.max(500);

function uniqueStringListSchema(label: string, minimum: 0 | 1 = 1) {
  const entries = z
    .array(nonEmptyTrimmedStringSchema)
    .refine(
      (values) =>
        new Set(values.map((value) => value.toLocaleLowerCase())).size ===
        values.length,
      `${label} must not contain case-insensitive duplicates`,
    );
  return minimum === 1
    ? entries.min(1, `${label} must not be empty`)
    : entries;
}

const allowedScopeSchema = z
  .array(workspaceRelativePosixPathSchema)
  .min(1, "allowed_scope must not be empty")
  .refine(
    (values) =>
      new Set(values.map((value) => value.toLocaleLowerCase())).size ===
      values.length,
    "allowed_scope must not contain case-insensitive duplicates",
  );

export interface ShapingIdentity<
  TPhase extends ShapingPhase = ShapingPhase,
> {
  phase: TPhase;
  work_item_id: string;
  input_sha256: string;
}

export interface ShapingRevision {
  ordinal: number;
  supersedes_input_sha256: string;
  superseded_result_sha256: string;
  feedback: string;
}

export interface ShapingPaths {
  task_path: string;
  output_path: string;
}

export interface BrainstormShapingInput {
  phase: "brainstorm";
  title: string;
  notes?: string;
  revision?: ShapingRevision;
}

export interface BrainstormResultSubmission {
  result_schema_version: 1;
  brainstorm_mission_content_sha256: string;
  identity: ShapingIdentity<"brainstorm">;
  problem_statement: string;
  approach: string;
  non_goals: string[];
  open_questions: string[];
}

export interface SpecProposal {
  purpose: string;
  acceptance_criteria: string[];
  non_goals: string[];
  allowed_scope: string[];
  review_ready: string[];
}

export interface SpecResultSubmission {
  result_schema_version: 1;
  spec_mission_content_sha256: string;
  identity: ShapingIdentity<"spec">;
  proposal: SpecProposal;
}

export interface PlanChecklistEntry {
  id: string;
  step: string;
  verification_check: string;
}

export interface PlanResultSubmission {
  result_schema_version: 1;
  plan_mission_content_sha256: string;
  identity: ShapingIdentity<"plan">;
  summary: string;
  checklist: PlanChecklistEntry[];
  relevant_skills: string[];
  product_doc_impacts: string[];
  todo_impacts: string[];
  open_questions: string[];
}

export interface ShapingSelectionReceipt {
  shaping_schema_version: 2;
  identity: ShapingIdentity<"brainstorm">;
  mission_content_sha256: string;
  result_content_sha256: string;
  selected_at: string;
}

export interface SpecApprovalReceipt {
  shaping_schema_version: 2;
  identity: ShapingIdentity<"spec">;
  mission_content_sha256: string;
  result_content_sha256: string;
  goal_contract_sha256: string;
  approved_at: string;
}

export type ShapingDecisionReceipt =
  | ShapingSelectionReceipt
  | SpecApprovalReceipt;

type EmbeddedShapingSelectionReceipt = Omit<
  ShapingSelectionReceipt,
  "selected_at"
> & {
  selected_at?: string;
};

type EmbeddedSpecApprovalReceipt = Omit<SpecApprovalReceipt, "approved_at"> & {
  approved_at?: string;
};

export interface SpecShapingInput {
  phase: "spec";
  title: string;
  notes?: string;
  brainstorm_selection_sha256: string;
  brainstorm_selection: EmbeddedShapingSelectionReceipt;
  brainstorm_result: BrainstormResultSubmission;
  revision?: ShapingRevision;
}

export interface PlanShapingInput {
  phase: "plan";
  title: string;
  notes?: string;
  spec_approval_sha256: string;
  spec_approval: EmbeddedSpecApprovalReceipt;
  spec_result: SpecResultSubmission;
  repository_base_commit: string;
  goal_contract_sha256: string;
  goal_version: number;
  revision?: ShapingRevision;
}

export type ShapingInput =
  | BrainstormShapingInput
  | SpecShapingInput
  | PlanShapingInput;

export type ShapingResultSubmission =
  | BrainstormResultSubmission
  | SpecResultSubmission
  | PlanResultSubmission;

export interface ShapingImportReceipt<
  TPhase extends ShapingPhase = ShapingPhase,
> {
  shaping_schema_version: 2;
  identity: ShapingIdentity<TPhase>;
  shaping_mission_content_sha256: string;
  result_content_sha256: string;
  outcome: "applied" | "rejected";
  first_published_at: string;
  reasons: string[];
}

interface ShapingResultContract<TRequiredFields extends readonly string[]> {
  schema_version: 1;
  result_file: "result.json";
  result_schema_version: 1;
  required_fields: TRequiredFields;
}

interface ShapingContentSource {
  shaping_schema_version: 2;
  identity: ShapingIdentity;
  input: ShapingInput;
  result_contract: ShapingResultContract<readonly string[]>;
}

interface ShapingMissionPackageBase<
  TPhase extends ShapingPhase,
  TInput extends ShapingInput,
  TRequiredFields extends readonly string[],
> {
  shaping_schema_version: 2;
  identity: ShapingIdentity<TPhase>;
  input: TInput;
  result_contract: ShapingResultContract<TRequiredFields>;
  content_sha256: string;
}

export type BrainstormMissionPackage = ShapingMissionPackageBase<
  "brainstorm",
  BrainstormShapingInput,
  typeof BRAINSTORM_RESULT_REQUIRED_FIELDS
>;

export type SpecMissionPackage = ShapingMissionPackageBase<
  "spec",
  SpecShapingInput,
  typeof SPEC_RESULT_REQUIRED_FIELDS
>;

export type PlanMissionPackage = ShapingMissionPackageBase<
  "plan",
  PlanShapingInput,
  typeof PLAN_RESULT_REQUIRED_FIELDS
>;

export type ShapingMissionPackage =
  | BrainstormMissionPackage
  | SpecMissionPackage
  | PlanMissionPackage;

export type ShapingMissionPackageBuilder<
  TMission extends ShapingMissionPackage = ShapingMissionPackage,
> = (paths: ShapingPaths) => TMission;

export interface ShapingArtifactWriteResult<
  TMission extends ShapingMissionPackage = ShapingMissionPackage,
> {
  mission: TMission;
  workspace_path: string;
  task_path: string;
  mission_path: string;
}

export interface ShapingArtifactReadResult {
  mission: ShapingMissionPackage;
  mission_path: string;
}

export interface ShapingResultSnapshot extends ShapingArtifactReadResult {
  result_path: string;
  result_source: string;
}

export interface ShapingImportReceiptWriteInput {
  result_source: string;
  receipt: ShapingImportReceipt;
}

export interface ShapingReceiptWriteResult<
  TReceipt extends ShapingImportReceipt | ShapingDecisionReceipt,
> {
  receipt: TReceipt;
  receipt_path: string;
  receipt_content_sha256: string;
}

export interface StoredShapingArtifact {
  mission: ShapingMissionPackage;
  mission_path: string;
  task_path: string;
  result: {
    result_path: string;
    result_source: string;
    result_content_sha256: string;
  } | null;
  import_receipt: ShapingImportReceipt | null;
  import_path: string | null;
  production_receipt: ShapingProductionReceipt | null;
  production_path: string | null;
  applied_marker: ShapingAppliedMarkerV1 | null;
  applied_marker_path: string | null;
  decision: {
    receipt: ShapingDecisionReceipt;
    decision_path: string;
    decision_content_sha256: string;
  } | null;
}

export interface ShapingIngressInstructionV1 {
  schema_version: 1;
  origin: "connected_run" | "manual_import";
  shaping_run_id: string | null;
  work_item_id: string;
  phase: ShapingPhase;
  mission_input_sha256: string;
  mission_content_sha256: string;
  task_path: string;
  mission_path: string;
  ingress_path: string;
  result_schema_version: 1;
  required_fields: string[];
  max_result_bytes: 262_144;
  created_at: string;
  instruction_sha256: string;
}

export interface ShapingDecisionState {
  work_item_id: string;
  phase: WorkItemPhase;
  status: WorkItemStatus;
  goal_input_sha256: string;
  goal_version: number | null;
  input_revision: number | null;
  goal_contract_sha256: string | null;
  current_mission_input_sha256: string | null;
  current_mission_content_sha256: string | null;
  applied_result_content_sha256: string | null;
  decision_receipt_sha256: string | null;
  active_shaping_run_id: string | null;
}

export interface ShapingDecisionIntentV1 {
  schema_version: 1;
  decision_id: string;
  work_item_id: string;
  operation: ShapingDecisionOperation;
  launch_mode: "connected" | "manual";
  phase_from: "idea" | ShapingPhase;
  phase_to: ShapingPhase;
  goal_input_sha256: string;
  mission_content_sha256: string | null;
  result_content_sha256: string | null;
  feedback_sha256: string | null;
  expected_shaping_state_sha256: string;
  next_requested_model: string | null;
  next_mission_content_sha256: string;
  next_mission_input_sha256: string;
  plan_repository_base_commit: string | null;
  plan_goal_contract_sha256: string | null;
  plan_goal_version: number | null;
  launch_fingerprint: string | null;
  previous_goal_bytes: string;
  previous_goal_sha256: string;
  previous_state_bytes: string;
  previous_state_sha256: string;
  next_goal_bytes: string;
  next_goal_sha256: string;
  next_state_bytes: string;
  next_state_sha256: string;
  decision_receipt_bytes: string | null;
  next_mission_package_bytes: string;
  created_at: string;
}

export type ShapingDecisionManifestOutcome =
  | "pending"
  | "applied"
  | "failed";

export interface ShapingDecisionManifestV1 {
  schema_version: 1;
  decision_id: string;
  work_item_id: string;
  operation: ShapingDecisionOperation;
  phase_from: "idea" | ShapingPhase;
  phase_to: ShapingPhase;
  mission_content_sha256: string | null;
  result_content_sha256: string | null;
  feedback_sha256: string | null;
  expected_shaping_state_sha256: string;
  next_mission_content_sha256: string;
  goal_sha256: string;
  state_sha256: string;
  goal_version: number | null;
  input_revision: number | null;
  started_at: string;
  completed_at?: string;
  outcome: ShapingDecisionManifestOutcome;
}

export type ShapingDecisionIdInput = Pick<
  ShapingDecisionIntentV1,
  | "operation"
  | "work_item_id"
  | "goal_input_sha256"
  | "mission_content_sha256"
  | "result_content_sha256"
  | "feedback_sha256"
  | "expected_shaping_state_sha256"
>;

export interface ShapingAppliedMarkerV1 {
  schema_version: 1;
  mission_content_sha256: string;
  result_content_sha256: string;
  component_sha256: {
    result: string;
    import: string;
    production: string;
  };
  component_bytes: {
    result: number;
    import: number;
    production: number;
  };
  committed_at: string;
}

const brainstormIdentitySchema: z.ZodType<
  ShapingIdentity<"brainstorm">
> = z.strictObject({
  phase: z.literal("brainstorm"),
  work_item_id: workItemIdSchema,
  input_sha256: sha256Schema,
});

const specIdentitySchema: z.ZodType<ShapingIdentity<"spec">> = z.strictObject({
  phase: z.literal("spec"),
  work_item_id: workItemIdSchema,
  input_sha256: sha256Schema,
});

export const planIdentitySchema: z.ZodType<ShapingIdentity<"plan">> =
  z.strictObject({
    phase: z.literal("plan"),
    work_item_id: workItemIdSchema,
    input_sha256: sha256Schema,
  });

export const shapingIdentitySchema: z.ZodType<ShapingIdentity> = z.union([
  brainstormIdentitySchema,
  specIdentitySchema,
  planIdentitySchema,
]);

export const brainstormResultSubmissionSchema: z.ZodType<BrainstormResultSubmission> =
  z.strictObject({
    result_schema_version: z.literal(1),
    brainstorm_mission_content_sha256: sha256Schema,
    identity: brainstormIdentitySchema,
    problem_statement: nonEmptyTrimmedStringSchema,
    approach: nonEmptyTrimmedStringSchema,
    non_goals: uniqueStringListSchema("non_goals"),
    open_questions: uniqueStringListSchema("open_questions"),
  });

const specProposalSchema: z.ZodType<SpecProposal> = z.strictObject({
  purpose: nonEmptyTrimmedStringSchema,
  acceptance_criteria: uniqueStringListSchema("acceptance_criteria"),
  non_goals: uniqueStringListSchema("non_goals"),
  allowed_scope: allowedScopeSchema,
  review_ready: uniqueStringListSchema("review_ready"),
});

export const specResultSubmissionSchema: z.ZodType<SpecResultSubmission> =
  z.strictObject({
    result_schema_version: z.literal(1),
    spec_mission_content_sha256: sha256Schema,
    identity: specIdentitySchema,
    proposal: specProposalSchema,
  });

const planChecklistEntrySchema: z.ZodType<PlanChecklistEntry> = z.strictObject({
  id: nonEmptyTrimmedStringSchema.max(100),
  step: nonEmptyTrimmedStringSchema,
  verification_check: nonEmptyTrimmedStringSchema,
});

export const planResultSubmissionSchema: z.ZodType<PlanResultSubmission> =
  z.strictObject({
    result_schema_version: z.literal(1),
    plan_mission_content_sha256: sha256Schema,
    identity: planIdentitySchema,
    summary: nonEmptyTrimmedStringSchema,
    checklist: z
      .array(planChecklistEntrySchema)
      .min(1, "checklist must not be empty")
      .refine(
        (entries) =>
          new Set(entries.map((entry) => entry.id.toLocaleLowerCase())).size ===
          entries.length,
        "checklist ids must be unique",
      ),
    relevant_skills: uniqueStringListSchema("relevant_skills", 0),
    product_doc_impacts: uniqueStringListSchema("product_doc_impacts", 0),
    todo_impacts: uniqueStringListSchema("todo_impacts", 0),
    open_questions: uniqueStringListSchema("open_questions", 0),
  });

export const shapingResultSubmissionSchema: z.ZodType<ShapingResultSubmission> =
  z.union([
    brainstormResultSubmissionSchema,
    specResultSubmissionSchema,
    planResultSubmissionSchema,
  ]);

export const shapingSelectionReceiptSchema: z.ZodType<ShapingSelectionReceipt> =
  z.strictObject({
    shaping_schema_version: z.literal(SHAPING_SCHEMA_VERSION),
    identity: brainstormIdentitySchema,
    mission_content_sha256: sha256Schema,
    result_content_sha256: sha256Schema,
    selected_at: z.iso.datetime(),
  });

export const specApprovalReceiptSchema: z.ZodType<SpecApprovalReceipt> =
  z.strictObject({
    shaping_schema_version: z.literal(SHAPING_SCHEMA_VERSION),
    identity: specIdentitySchema,
    mission_content_sha256: sha256Schema,
    result_content_sha256: sha256Schema,
    goal_contract_sha256: sha256Schema,
    approved_at: z.iso.datetime(),
  });

export const shapingDecisionReceiptSchema: z.ZodType<ShapingDecisionReceipt> =
  z.union([shapingSelectionReceiptSchema, specApprovalReceiptSchema]);

const embeddedShapingSelectionReceiptSchema: z.ZodType<EmbeddedShapingSelectionReceipt> =
  z.strictObject({
    shaping_schema_version: z.literal(SHAPING_SCHEMA_VERSION),
    identity: brainstormIdentitySchema,
    mission_content_sha256: sha256Schema,
    result_content_sha256: sha256Schema,
    selected_at: z.iso.datetime().optional(),
  });

const embeddedSpecApprovalReceiptSchema: z.ZodType<EmbeddedSpecApprovalReceipt> =
  z.strictObject({
    shaping_schema_version: z.literal(SHAPING_SCHEMA_VERSION),
    identity: specIdentitySchema,
    mission_content_sha256: sha256Schema,
    result_content_sha256: sha256Schema,
    goal_contract_sha256: sha256Schema,
    approved_at: z.iso.datetime().optional(),
  });

const shapingRevisionSchema: z.ZodType<ShapingRevision> = z.strictObject({
  ordinal: positiveSafeIntegerSchema,
  supersedes_input_sha256: sha256Schema,
  superseded_result_sha256: sha256Schema,
  feedback: nonEmptyTrimmedStringSchema,
});

export const brainstormShapingInputSchema: z.ZodType<BrainstormShapingInput> =
  z.strictObject({
    phase: z.literal("brainstorm"),
    title: nonEmptyTrimmedStringSchema,
    notes: nonEmptyTrimmedStringSchema.optional(),
    revision: shapingRevisionSchema.optional(),
  });

export const specShapingInputSchema: z.ZodType<SpecShapingInput> = z
  .strictObject({
    phase: z.literal("spec"),
    title: nonEmptyTrimmedStringSchema,
    notes: nonEmptyTrimmedStringSchema.optional(),
    brainstorm_selection_sha256: sha256Schema,
    brainstorm_selection: embeddedShapingSelectionReceiptSchema,
    brainstorm_result: brainstormResultSubmissionSchema,
    revision: shapingRevisionSchema.optional(),
  })
  .superRefine((input, context) => {
    const selection = input.brainstorm_selection;
    const result = input.brainstorm_result;
    if (
      selection.mission_content_sha256 !==
      result.brainstorm_mission_content_sha256
    ) {
      context.addIssue({
        code: "custom",
        message: "selected mission SHA must match the Brainstorm result",
        path: ["brainstorm_result", "brainstorm_mission_content_sha256"],
        input: result.brainstorm_mission_content_sha256,
      });
    }
    if (!sameIdentity(selection.identity, result.identity)) {
      context.addIssue({
        code: "custom",
        message: "selected identity must match the Brainstorm result identity",
        path: ["brainstorm_result", "identity"],
        input: result.identity,
      });
    }
  });

export const planShapingInputSchema: z.ZodType<PlanShapingInput> = z
  .strictObject({
    phase: z.literal("plan"),
    title: nonEmptyTrimmedStringSchema,
    notes: nonEmptyTrimmedStringSchema.optional(),
    spec_approval_sha256: sha256Schema,
    spec_approval: embeddedSpecApprovalReceiptSchema,
    spec_result: specResultSubmissionSchema,
    repository_base_commit: gitCommitSchema,
    goal_contract_sha256: sha256Schema,
    goal_version: positiveSafeIntegerSchema,
    revision: shapingRevisionSchema.optional(),
  })
  .superRefine((input, context) => {
    const approval = input.spec_approval;
    const result = input.spec_result;
    if (approval.mission_content_sha256 !== result.spec_mission_content_sha256) {
      context.addIssue({
        code: "custom",
        message: "approved mission SHA must match the Spec result",
        path: ["spec_result", "spec_mission_content_sha256"],
        input: result.spec_mission_content_sha256,
      });
    }
    if (!sameIdentity(approval.identity, result.identity)) {
      context.addIssue({
        code: "custom",
        message: "approved identity must match the Spec result identity",
        path: ["spec_result", "identity"],
        input: result.identity,
      });
    }
    if (
      input.revision === undefined &&
      approval.goal_contract_sha256 !== input.goal_contract_sha256
    ) {
      context.addIssue({
        code: "custom",
        message: "approved goal-contract SHA must match the Plan input",
        path: ["goal_contract_sha256"],
        input: input.goal_contract_sha256,
      });
    }
  });

export const shapingInputSchema: z.ZodType<ShapingInput> = z.union([
  brainstormShapingInputSchema,
  specShapingInputSchema,
  planShapingInputSchema,
]);

const shapingImportReceiptBaseShape = {
  shaping_schema_version: z.literal(SHAPING_SCHEMA_VERSION),
  shaping_mission_content_sha256: sha256Schema,
  result_content_sha256: sha256Schema,
  first_published_at: z.iso.datetime(),
};

const appliedShapingImportReceiptSchema = z.strictObject({
  ...shapingImportReceiptBaseShape,
  identity: shapingIdentitySchema,
  outcome: z.literal("applied"),
  reasons: z.array(boundedReasonSchema).length(0),
});

const rejectedShapingImportReceiptSchema = z.strictObject({
  ...shapingImportReceiptBaseShape,
  identity: shapingIdentitySchema,
  outcome: z.literal("rejected"),
  reasons: z.array(boundedReasonSchema).min(1).max(20),
});

export const shapingImportReceiptSchema: z.ZodType<ShapingImportReceipt> =
  z.union([
    appliedShapingImportReceiptSchema,
    rejectedShapingImportReceiptSchema,
  ]);

const brainstormResultContractSchema = z.strictObject({
  schema_version: z.literal(1),
  result_file: z.literal("result.json"),
  result_schema_version: z.literal(1),
  required_fields: z.tuple([
    z.literal("result_schema_version"),
    z.literal("brainstorm_mission_content_sha256"),
    z.literal("identity"),
    z.literal("problem_statement"),
    z.literal("approach"),
    z.literal("non_goals"),
    z.literal("open_questions"),
  ]),
});

const specResultContractSchema = z.strictObject({
  schema_version: z.literal(1),
  result_file: z.literal("result.json"),
  result_schema_version: z.literal(1),
  required_fields: z.tuple([
    z.literal("result_schema_version"),
    z.literal("spec_mission_content_sha256"),
    z.literal("identity"),
    z.literal("proposal"),
  ]),
});

const planResultContractSchema = z.strictObject({
  schema_version: z.literal(1),
  result_file: z.literal("result.json"),
  result_schema_version: z.literal(1),
  required_fields: z.tuple([
    z.literal("result_schema_version"),
    z.literal("plan_mission_content_sha256"),
    z.literal("identity"),
    z.literal("summary"),
    z.literal("checklist"),
    z.literal("relevant_skills"),
    z.literal("product_doc_impacts"),
    z.literal("todo_impacts"),
    z.literal("open_questions"),
  ]),
});

const shapingPackageCommonShape = {
  shaping_schema_version: z.literal(SHAPING_SCHEMA_VERSION),
  content_sha256: sha256Schema,
};

function validateShapingPackage(
  mission: ShapingMissionPackage,
  context: z.RefinementCtx,
): void {
  if (mission.identity.phase !== mission.input.phase) {
    context.addIssue({
      code: "custom",
      message: "identity phase must match input phase",
      path: ["identity", "phase"],
      input: mission.identity.phase,
    });
  }
  if (mission.identity.input_sha256 !== hashShapingInput(mission.input)) {
    context.addIssue({
      code: "custom",
      message: "input_sha256 must hash the canonical shaping input",
      path: ["identity", "input_sha256"],
      input: mission.identity.input_sha256,
    });
  }
  if (mission.content_sha256 !== hashShapingContent(mission)) {
    context.addIssue({
      code: "custom",
      message: "content_sha256 must match the canonical shaping content",
      path: ["content_sha256"],
      input: mission.content_sha256,
    });
  }
}

export const brainstormMissionPackageSchema: z.ZodType<BrainstormMissionPackage> =
  z
    .strictObject({
      ...shapingPackageCommonShape,
      identity: brainstormIdentitySchema,
      input: brainstormShapingInputSchema,
      result_contract: brainstormResultContractSchema,
    })
    .superRefine(validateShapingPackage);

export const specMissionPackageSchema: z.ZodType<SpecMissionPackage> = z
  .strictObject({
    ...shapingPackageCommonShape,
    identity: specIdentitySchema,
    input: specShapingInputSchema,
    result_contract: specResultContractSchema,
  })
  .superRefine(validateShapingPackage);

export const planMissionPackageSchema: z.ZodType<PlanMissionPackage> = z
  .strictObject({
    ...shapingPackageCommonShape,
    identity: planIdentitySchema,
    input: planShapingInputSchema,
    result_contract: planResultContractSchema,
  })
  .superRefine(validateShapingPackage);

export const shapingMissionPackageSchema: z.ZodType<ShapingMissionPackage> =
  z.union([
    brainstormMissionPackageSchema,
    specMissionPackageSchema,
    planMissionPackageSchema,
  ]);

export const shapingIngressInstructionSchema: z.ZodType<ShapingIngressInstructionV1> =
  z
    .strictObject({
      schema_version: z.literal(1),
      origin: z.enum(["connected_run", "manual_import"]),
      shaping_run_id: controllerRunIdSchema.nullable(),
      work_item_id: workItemIdSchema,
      phase: z.enum(SHAPING_PHASES),
      mission_input_sha256: sha256Schema,
      mission_content_sha256: sha256Schema,
      task_path: workspaceRelativePosixPathSchema,
      mission_path: workspaceRelativePosixPathSchema,
      ingress_path: workspaceRelativePosixPathSchema,
      result_schema_version: z.literal(1),
      required_fields: uniqueStringListSchema("required_fields"),
      max_result_bytes: z.literal(SHAPING_INGRESS_MAX_BYTES),
      created_at: z.iso.datetime(),
      instruction_sha256: sha256Schema,
    })
    .superRefine((instruction, context) => {
      if (
        (instruction.origin === "connected_run") !==
        (instruction.shaping_run_id !== null)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "connected instructions require a run id and manual instructions require null",
          path: ["shaping_run_id"],
          input: instruction.shaping_run_id,
        });
      }
      if (
        instruction.instruction_sha256 !==
        hashShapingIngressInstruction(instruction)
      ) {
        context.addIssue({
          code: "custom",
          message: "instruction_sha256 must hash every non-timestamp field",
          path: ["instruction_sha256"],
          input: instruction.instruction_sha256,
        });
      }
    });

export const shapingDecisionStateSchema: z.ZodType<ShapingDecisionState> =
  z.strictObject({
    work_item_id: workItemIdSchema,
    phase: z.enum(WORK_ITEM_PHASES),
    status: z.enum(WORK_ITEM_STATUSES),
    goal_input_sha256: sha256Schema,
    goal_version: positiveSafeIntegerSchema.nullable(),
    input_revision: positiveSafeIntegerSchema.nullable(),
    goal_contract_sha256: z.string().nullable(),
    current_mission_input_sha256: z.string().nullable(),
    current_mission_content_sha256: z.string().nullable(),
    applied_result_content_sha256: z.string().nullable(),
    decision_receipt_sha256: z.string().nullable(),
    active_shaping_run_id: z.string().nullable(),
  });

export const shapingDecisionIntentSchema: z.ZodType<ShapingDecisionIntentV1> =
  z
    .strictObject({
      schema_version: z.literal(1),
      decision_id: sha256Schema,
      work_item_id: workItemIdSchema,
      operation: z.enum(SHAPING_DECISION_OPERATIONS),
      launch_mode: z.enum(["connected", "manual"]),
      phase_from: z.enum(["idea", ...SHAPING_PHASES]),
      phase_to: z.enum(SHAPING_PHASES),
      goal_input_sha256: sha256Schema,
      mission_content_sha256: sha256Schema.nullable(),
      result_content_sha256: sha256Schema.nullable(),
      feedback_sha256: sha256Schema.nullable(),
      expected_shaping_state_sha256: sha256Schema,
      next_requested_model: nonEmptyTrimmedStringSchema.nullable(),
      next_mission_content_sha256: sha256Schema,
      next_mission_input_sha256: sha256Schema,
      plan_repository_base_commit: gitCommitSchema.nullable(),
      plan_goal_contract_sha256: sha256Schema.nullable(),
      plan_goal_version: positiveSafeIntegerSchema.nullable(),
      launch_fingerprint: sha256Schema.nullable(),
      previous_goal_bytes: z.string(),
      previous_goal_sha256: sha256Schema,
      previous_state_bytes: z.string(),
      previous_state_sha256: sha256Schema,
      next_goal_bytes: z.string(),
      next_goal_sha256: sha256Schema,
      next_state_bytes: z.string(),
      next_state_sha256: sha256Schema,
      decision_receipt_bytes: z.string().nullable(),
      next_mission_package_bytes: z.string().min(1),
      created_at: z.iso.datetime(),
    })
    .superRefine((intent, context) => {
      const connected = intent.launch_mode === "connected";
      if (connected !== (intent.next_requested_model !== null)) {
        context.addIssue({
          code: "custom",
          message: "connected launch mode requires one requested model",
          path: ["next_requested_model"],
          input: intent.next_requested_model,
        });
      }
      if (connected !== (intent.launch_fingerprint !== null)) {
        context.addIssue({
          code: "custom",
          message: "connected launch mode requires one launch fingerprint",
          path: ["launch_fingerprint"],
          input: intent.launch_fingerprint,
        });
      }
    });

export const shapingDecisionManifestSchema: z.ZodType<ShapingDecisionManifestV1> =
  z
    .strictObject({
      schema_version: z.literal(1),
      decision_id: sha256Schema,
      work_item_id: workItemIdSchema,
      operation: z.enum(SHAPING_DECISION_OPERATIONS),
      phase_from: z.enum(["idea", ...SHAPING_PHASES]),
      phase_to: z.enum(SHAPING_PHASES),
      mission_content_sha256: sha256Schema.nullable(),
      result_content_sha256: sha256Schema.nullable(),
      feedback_sha256: sha256Schema.nullable(),
      expected_shaping_state_sha256: sha256Schema,
      next_mission_content_sha256: sha256Schema,
      goal_sha256: sha256Schema,
      state_sha256: sha256Schema,
      goal_version: positiveSafeIntegerSchema.nullable(),
      input_revision: positiveSafeIntegerSchema.nullable(),
      started_at: z.iso.datetime(),
      completed_at: z.iso.datetime().optional(),
      outcome: z.enum(["pending", "applied", "failed"]),
    })
    .superRefine((manifest, context) => {
      const terminal = manifest.outcome !== "pending";
      if (terminal !== (manifest.completed_at !== undefined)) {
        context.addIssue({
          code: "custom",
          message:
            "terminal shaping decision manifests require completed_at and pending manifests forbid it",
          path: ["completed_at"],
          input: manifest.completed_at,
        });
      }
      if (
        (manifest.goal_version === null) !==
        (manifest.input_revision === null)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "goal_version and input_revision must either both be null or both be present",
          path: ["goal_version"],
          input: manifest.goal_version,
        });
      }
    });

export const shapingAppliedMarkerSchema: z.ZodType<ShapingAppliedMarkerV1> =
  z
    .strictObject({
      schema_version: z.literal(1),
      mission_content_sha256: sha256Schema,
      result_content_sha256: sha256Schema,
      component_sha256: z.strictObject({
        result: sha256Schema,
        import: sha256Schema,
        production: sha256Schema,
      }),
      component_bytes: z.strictObject({
        result: positiveSafeIntegerSchema,
        import: positiveSafeIntegerSchema,
        production: positiveSafeIntegerSchema,
      }),
      committed_at: z.iso.datetime(),
    })
    .superRefine((marker, context) => {
      if (marker.component_sha256.result !== marker.result_content_sha256) {
        context.addIssue({
          code: "custom",
          message: "result component hash must equal result_content_sha256",
          path: ["component_sha256", "result"],
          input: marker.component_sha256.result,
        });
      }
    });

function sameIdentity(
  left: ShapingIdentity,
  right: ShapingIdentity,
): boolean {
  return (
    left.phase === right.phase &&
    left.work_item_id === right.work_item_id &&
    left.input_sha256 === right.input_sha256
  );
}

function canonicalIdentity(identity: ShapingIdentity) {
  return {
    phase: identity.phase,
    work_item_id: identity.work_item_id,
    input_sha256: identity.input_sha256,
  };
}

function canonicalRevision(revision: ShapingRevision) {
  return {
    ordinal: revision.ordinal,
    supersedes_input_sha256: revision.supersedes_input_sha256,
    superseded_result_sha256: revision.superseded_result_sha256,
    feedback: revision.feedback,
  };
}

function canonicalBrainstormResult(result: BrainstormResultSubmission) {
  return {
    result_schema_version: result.result_schema_version,
    brainstorm_mission_content_sha256:
      result.brainstorm_mission_content_sha256,
    identity: canonicalIdentity(result.identity),
    problem_statement: result.problem_statement,
    approach: result.approach,
    non_goals: result.non_goals,
    open_questions: result.open_questions,
  };
}

function canonicalSpecResult(result: SpecResultSubmission) {
  return {
    result_schema_version: result.result_schema_version,
    spec_mission_content_sha256: result.spec_mission_content_sha256,
    identity: canonicalIdentity(result.identity),
    proposal: {
      purpose: result.proposal.purpose,
      acceptance_criteria: result.proposal.acceptance_criteria,
      non_goals: result.proposal.non_goals,
      allowed_scope: result.proposal.allowed_scope,
      review_ready: result.proposal.review_ready,
    },
  };
}

function canonicalSelection(receipt: EmbeddedShapingSelectionReceipt) {
  return {
    shaping_schema_version: receipt.shaping_schema_version,
    identity: canonicalIdentity(receipt.identity),
    mission_content_sha256: receipt.mission_content_sha256,
    result_content_sha256: receipt.result_content_sha256,
  };
}

function canonicalApproval(receipt: EmbeddedSpecApprovalReceipt) {
  return {
    shaping_schema_version: receipt.shaping_schema_version,
    identity: canonicalIdentity(receipt.identity),
    mission_content_sha256: receipt.mission_content_sha256,
    result_content_sha256: receipt.result_content_sha256,
    goal_contract_sha256: receipt.goal_contract_sha256,
  };
}

function canonicalShapingInput(input: ShapingInput) {
  const common = {
    phase: input.phase,
    title: input.title,
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  };
  const revision =
    input.revision === undefined
      ? {}
      : { revision: canonicalRevision(input.revision) };

  if (input.phase === "brainstorm") {
    return { ...common, ...revision };
  }
  if (input.phase === "spec") {
    return {
      ...common,
      brainstorm_selection_sha256: input.brainstorm_selection_sha256,
      brainstorm_selection: canonicalSelection(input.brainstorm_selection),
      brainstorm_result: canonicalBrainstormResult(input.brainstorm_result),
      ...revision,
    };
  }
  return {
    ...common,
    spec_approval_sha256: input.spec_approval_sha256,
    spec_approval: canonicalApproval(input.spec_approval),
    spec_result: canonicalSpecResult(input.spec_result),
    repository_base_commit: input.repository_base_commit,
    goal_contract_sha256: input.goal_contract_sha256,
    goal_version: input.goal_version,
    ...revision,
  };
}

function canonicalResultContract(
  resultContract: ShapingResultContract<readonly string[]>,
) {
  return {
    schema_version: resultContract.schema_version,
    result_file: resultContract.result_file,
    result_schema_version: resultContract.result_schema_version,
    required_fields: resultContract.required_fields,
  };
}

function shapingContent(mission: ShapingContentSource) {
  return {
    shaping_schema_version: mission.shaping_schema_version,
    identity: canonicalIdentity(mission.identity),
    input: canonicalShapingInput(mission.input),
    result_contract: canonicalResultContract(mission.result_contract),
  };
}

function hashShapingArtifact(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function withoutReceiptTimestamp<TInput extends ShapingInput>(
  input: TInput,
): TInput {
  return shapingInputSchema.parse(canonicalShapingInput(input)) as TInput;
}

function assertNoForbiddenMissionKeys(
  value: unknown,
  context: z.RefinementCtx,
  path: (string | number)[] = [],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoForbiddenMissionKeys(entry, context, [...path, index]),
    );
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_MISSION_KEY_NAMES.has(key)) {
      context.addIssue({
        code: "custom",
        message: `mission content must not contain the key ${key}`,
        path: [...path, key],
        input: entry,
      });
    }
    assertNoForbiddenMissionKeys(entry, context, [...path, key]);
  }
}

export function hashShapingInput(input: ShapingInput): string {
  const parsed = shapingInputSchema.parse(input);
  return hashShapingArtifact(canonicalShapingInput(parsed));
}

function normalizeGoalText(value: string): string {
  const normalizedLines = value
    .normalize("NFC")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trimEnd());

  while (
    normalizedLines.length > 0 &&
    normalizedLines[normalizedLines.length - 1] === ""
  ) {
    normalizedLines.pop();
  }

  return normalizedLines.join("\n");
}

export function hashGoalInput(goal: { title: string; notes?: string }): string {
  const parsed = z
    .strictObject({ title: z.string(), notes: z.string().optional() })
    .parse(goal);
  return createHash("sha256")
    .update(normalizeGoalText(parsed.title))
    .update("\0")
    .update(normalizeGoalText(parsed.notes ?? ""))
    .digest("hex");
}

export function goalContractFromSpecProposal(
  proposal: SpecProposal,
  goalVersion: number,
): GoalContract {
  const validated = specProposalSchema.parse(proposal);
  return goalContractSchema.parse({
    schema_version: 1,
    goal_version: goalVersion,
    purpose: validated.purpose,
    acceptance_criteria: validated.acceptance_criteria,
    non_goals: validated.non_goals,
    allowed_scope: validated.allowed_scope,
    review_ready: validated.review_ready,
  });
}

export function hashGoalContract(contract: GoalContract): string {
  const validated = goalContractSchema.parse(contract);
  return hashShapingArtifact({
    schema_version: validated.schema_version,
    goal_version: validated.goal_version,
    purpose: validated.purpose,
    acceptance_criteria: validated.acceptance_criteria,
    non_goals: validated.non_goals,
    allowed_scope: validated.allowed_scope,
    review_ready: validated.review_ready,
  });
}

export function normalizeShapingGoalInput(goal: {
  title: string;
  notes?: string;
}): { title: string; notes?: string } {
  return {
    title: goal.title.trim(),
    ...(goal.notes === undefined ? {} : { notes: goal.notes.trim() }),
  };
}

export function hashShapingDecisionState(state: ShapingDecisionState): string {
  const parsed = shapingDecisionStateSchema.parse(state);
  return hashShapingArtifact({
    work_item_id: parsed.work_item_id,
    phase: parsed.phase,
    status: parsed.status,
    goal_input_sha256: parsed.goal_input_sha256,
    goal_version: parsed.goal_version,
    input_revision: parsed.input_revision,
    goal_contract_sha256: parsed.goal_contract_sha256,
    current_mission_input_sha256: parsed.current_mission_input_sha256,
    current_mission_content_sha256: parsed.current_mission_content_sha256,
    applied_result_content_sha256: parsed.applied_result_content_sha256,
    decision_receipt_sha256: parsed.decision_receipt_sha256,
    active_shaping_run_id: parsed.active_shaping_run_id,
  });
}

export function deriveShapingDecisionId(
  input: ShapingDecisionIdInput,
): string {
  const parsed = z
    .strictObject({
      operation: z.enum(SHAPING_DECISION_OPERATIONS),
      work_item_id: workItemIdSchema,
      goal_input_sha256: sha256Schema,
      mission_content_sha256: sha256Schema.nullable(),
      result_content_sha256: sha256Schema.nullable(),
      feedback_sha256: sha256Schema.nullable(),
      expected_shaping_state_sha256: sha256Schema,
    })
    .parse(input);
  return hashShapingArtifact({
    expected_shaping_state_sha256:
      parsed.expected_shaping_state_sha256,
    feedback_sha256: parsed.feedback_sha256,
    goal_input_sha256: parsed.goal_input_sha256,
    mission_content_sha256: parsed.mission_content_sha256,
    operation: parsed.operation,
    result_content_sha256: parsed.result_content_sha256,
    work_item_id: parsed.work_item_id,
  });
}

export function hashShapingIngressInstruction(
  instruction: Omit<ShapingIngressInstructionV1, "instruction_sha256">,
): string {
  return hashShapingArtifact({
    schema_version: instruction.schema_version,
    origin: instruction.origin,
    shaping_run_id: instruction.shaping_run_id,
    work_item_id: instruction.work_item_id,
    phase: instruction.phase,
    mission_input_sha256: instruction.mission_input_sha256,
    mission_content_sha256: instruction.mission_content_sha256,
    task_path: instruction.task_path,
    mission_path: instruction.mission_path,
    ingress_path: instruction.ingress_path,
    result_schema_version: instruction.result_schema_version,
    required_fields: instruction.required_fields,
    max_result_bytes: instruction.max_result_bytes,
  });
}

export function hashShapingDecisionReceipt(
  receipt: ShapingDecisionReceipt,
): string {
  const parsed = shapingDecisionReceiptSchema.parse(receipt);
  return hashShapingArtifact(
    "selected_at" in parsed
      ? canonicalSelection(parsed)
      : canonicalApproval(parsed),
  );
}

export function serializeShapingContent(
  mission: ShapingContentSource,
): string {
  return JSON.stringify(shapingContent(mission));
}

export function hashShapingContent(mission: ShapingContentSource): string {
  return createHash("sha256")
    .update(serializeShapingContent(mission))
    .digest("hex");
}

export function serializeShapingPackage(
  mission: ShapingMissionPackage,
): string {
  const validated = shapingMissionPackageSchema.parse(mission);
  return `${JSON.stringify(
    {
      ...shapingContent(validated),
      content_sha256: validated.content_sha256,
    },
    null,
    2,
  )}\n`;
}

function compileMission<
  TPhase extends ShapingPhase,
  TInput extends ShapingInput,
  TMission extends ShapingMissionPackage,
>(input: {
  phase: TPhase;
  work_item_id: string;
  shaping_input: TInput;
  required_fields: readonly string[];
  schema: z.ZodType<TMission>;
}): TMission {
  const shapingInput = withoutReceiptTimestamp(input.shaping_input);
  const identity = {
    phase: input.phase,
    work_item_id: workItemIdSchema.parse(input.work_item_id),
    input_sha256: hashShapingInput(shapingInput),
  };
  const draft = {
    shaping_schema_version: SHAPING_SCHEMA_VERSION,
    identity,
    input: shapingInput,
    result_contract: {
      schema_version: 1 as const,
      result_file: "result.json" as const,
      result_schema_version: 1 as const,
      required_fields: input.required_fields,
    },
  };
  const mission = {
    ...draft,
    content_sha256: hashShapingContent(draft),
  };
  return input.schema.parse(mission);
}

export function compileBrainstormMission(input: {
  work_item_id: string;
  shaping_input: BrainstormShapingInput;
  paths?: ShapingPaths;
}): BrainstormMissionPackage {
  return compileMission({
    phase: "brainstorm",
    work_item_id: input.work_item_id,
    shaping_input: brainstormShapingInputSchema.parse(input.shaping_input),
    required_fields: BRAINSTORM_RESULT_REQUIRED_FIELDS,
    schema: brainstormMissionPackageSchema,
  });
}

export function compileSpecMission(input: {
  work_item_id: string;
  shaping_input: SpecShapingInput;
  paths?: ShapingPaths;
}): SpecMissionPackage {
  return compileMission({
    phase: "spec",
    work_item_id: input.work_item_id,
    shaping_input: specShapingInputSchema.parse(input.shaping_input),
    required_fields: SPEC_RESULT_REQUIRED_FIELDS,
    schema: specMissionPackageSchema,
  });
}

export function compilePlanMission(input: {
  work_item_id: string;
  shaping_input: PlanShapingInput;
  paths?: ShapingPaths;
}): PlanMissionPackage {
  return compileMission({
    phase: "plan",
    work_item_id: input.work_item_id,
    shaping_input: planShapingInputSchema.parse(input.shaping_input),
    required_fields: PLAN_RESULT_REQUIRED_FIELDS,
    schema: planMissionPackageSchema,
  });
}

export function renderShapingTaskMd(mission: ShapingMissionPackage): string {
  const validated = shapingMissionPackageSchema.superRefine(
    assertNoForbiddenMissionKeys,
  ).parse(mission);
  const titleByPhase: Record<ShapingPhase, string> = {
    brainstorm: "Brainstorm",
    spec: "Spec",
    plan: "Plan",
  };
  const resultFields = validated.result_contract.required_fields
    .map((field) => `- \`${field}\``)
    .join("\n");
  return `# ${titleByPhase[validated.identity.phase]} shaping task

Use the immutable input below. Write one JSON result named \`${validated.result_contract.result_file}\`.

Mission content SHA-256: \`${validated.content_sha256}\`

## Input

\`\`\`json
${JSON.stringify(validated.input, null, 2)}
\`\`\`

## Required result fields

${resultFields}

Do not modify the work item, advance its phase, or treat this proposal as adopted state.
`;
}
