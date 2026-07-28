import { createHash } from "node:crypto";

import { z } from "zod";

import { workItemIdSchema } from "./work-item";
import { workspaceRelativePosixPathSchema } from "./workspace-path";

export const SHAPING_SCHEMA_VERSION = 1 as const;
export const SHAPING_PHASES = ["brainstorm", "spec"] as const;
export type ShapingPhase = (typeof SHAPING_PHASES)[number];

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

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const nonEmptyTrimmedStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be empty")
  .refine(
    (value) => value === value.trim(),
    "must not have leading or trailing whitespace",
  );
const boundedReasonSchema = nonEmptyTrimmedStringSchema.max(500);

function uniqueNonEmptyStringListSchema(label: string) {
  return z
    .array(nonEmptyTrimmedStringSchema)
    .min(1, `${label} must not be empty`)
    .refine(
      (values) =>
        new Set(values.map((value) => value.toLocaleLowerCase())).size ===
        values.length,
      `${label} must not contain case-insensitive duplicates`,
    );
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

export interface ShapingPaths {
  task_path: string;
  output_path: string;
}

export interface BrainstormShapingInput {
  phase: "brainstorm";
  title: string;
  notes?: string;
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

export interface ShapingImportReceipt<
  TPhase extends ShapingPhase = ShapingPhase,
> {
  shaping_schema_version: 1;
  identity: ShapingIdentity<TPhase>;
  shaping_mission_content_sha256: string;
  result_content_sha256: string;
  outcome: "applied" | "rejected";
  imported_at: string;
  reasons: string[];
}

export interface ShapingAcceptanceReceipt {
  shaping_schema_version: 1;
  identity: ShapingIdentity<"brainstorm">;
  brainstorm_mission_content_sha256: string;
  brainstorm_result_content_sha256: string;
  accepted_at: string;
}

export interface SpecShapingInput {
  phase: "spec";
  title: string;
  notes?: string;
  brainstorm_acceptance_sha256: string;
  brainstorm_acceptance: ShapingAcceptanceReceipt;
  brainstorm_result: BrainstormResultSubmission;
}

export type ShapingInput = BrainstormShapingInput | SpecShapingInput;

export interface SpecResultSubmission {
  result_schema_version: 1;
  spec_mission_content_sha256: string;
  identity: ShapingIdentity<"spec">;
  proposal: {
    purpose: string;
    acceptance_criteria: string[];
    non_goals: string[];
    allowed_scope: string[];
    review_ready: string[];
  };
}

interface ShapingResultContract<TRequiredFields extends readonly string[]> {
  schema_version: 1;
  output_path: string;
  result_schema_version: 1;
  required_fields: TRequiredFields;
}

interface ShapingMissionPackageBase<
  TPhase extends ShapingPhase,
  TInput extends ShapingInput,
  TRequiredFields extends readonly string[],
> {
  shaping_schema_version: 1;
  identity: ShapingIdentity<TPhase>;
  input: TInput;
  result_contract: ShapingResultContract<TRequiredFields>;
  task_path: string;
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

export type ShapingMissionPackage =
  | BrainstormMissionPackage
  | SpecMissionPackage;

export type ShapingResultSubmission =
  | BrainstormResultSubmission
  | SpecResultSubmission;

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
  TReceipt extends ShapingImportReceipt | ShapingAcceptanceReceipt,
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
  acceptance: {
    receipt: ShapingAcceptanceReceipt;
    acceptance_path: string;
    acceptance_content_sha256: string;
  } | null;
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

export const shapingIdentitySchema: z.ZodType<ShapingIdentity> = z.union([
  brainstormIdentitySchema,
  specIdentitySchema,
]);

export const brainstormShapingInputSchema: z.ZodType<BrainstormShapingInput> =
  z.strictObject({
    phase: z.literal("brainstorm"),
    title: nonEmptyTrimmedStringSchema,
    notes: nonEmptyTrimmedStringSchema.optional(),
  });

export const brainstormResultSubmissionSchema: z.ZodType<BrainstormResultSubmission> =
  z.strictObject({
    result_schema_version: z.literal(1),
    brainstorm_mission_content_sha256: sha256Schema,
    identity: brainstormIdentitySchema,
    problem_statement: nonEmptyTrimmedStringSchema,
    approach: nonEmptyTrimmedStringSchema,
    non_goals: uniqueNonEmptyStringListSchema("non_goals"),
    open_questions: uniqueNonEmptyStringListSchema("open_questions"),
  });

export const shapingAcceptanceReceiptSchema: z.ZodType<ShapingAcceptanceReceipt> =
  z.strictObject({
    shaping_schema_version: z.literal(SHAPING_SCHEMA_VERSION),
    identity: brainstormIdentitySchema,
    brainstorm_mission_content_sha256: sha256Schema,
    brainstorm_result_content_sha256: sha256Schema,
    accepted_at: z.iso.datetime(),
  });

export const specShapingInputSchema: z.ZodType<SpecShapingInput> = z
  .strictObject({
    phase: z.literal("spec"),
    title: nonEmptyTrimmedStringSchema,
    notes: nonEmptyTrimmedStringSchema.optional(),
    brainstorm_acceptance_sha256: sha256Schema,
    brainstorm_acceptance: shapingAcceptanceReceiptSchema,
    brainstorm_result: brainstormResultSubmissionSchema,
  })
  .superRefine((input, context) => {
    const acceptance = input.brainstorm_acceptance;
    const result = input.brainstorm_result;
    if (
      acceptance.brainstorm_mission_content_sha256 !==
      result.brainstorm_mission_content_sha256
    ) {
      context.addIssue({
        code: "custom",
        message: "accepted mission SHA must match the Brainstorm result",
        path: ["brainstorm_result", "brainstorm_mission_content_sha256"],
        input: result.brainstorm_mission_content_sha256,
      });
    }
    if (!sameIdentity(acceptance.identity, result.identity)) {
      context.addIssue({
        code: "custom",
        message: "accepted identity must match the Brainstorm result identity",
        path: ["brainstorm_result", "identity"],
        input: result.identity,
      });
    }
  });

export const shapingInputSchema: z.ZodType<ShapingInput> = z.union([
  brainstormShapingInputSchema,
  specShapingInputSchema,
]);

export const specResultSubmissionSchema: z.ZodType<SpecResultSubmission> =
  z.strictObject({
    result_schema_version: z.literal(1),
    spec_mission_content_sha256: sha256Schema,
    identity: specIdentitySchema,
    proposal: z.strictObject({
      purpose: nonEmptyTrimmedStringSchema,
      acceptance_criteria: uniqueNonEmptyStringListSchema(
        "acceptance_criteria",
      ),
      non_goals: uniqueNonEmptyStringListSchema("non_goals"),
      allowed_scope: allowedScopeSchema,
      review_ready: uniqueNonEmptyStringListSchema("review_ready"),
    }),
  });

export const shapingResultSubmissionSchema: z.ZodType<ShapingResultSubmission> =
  z.union([brainstormResultSubmissionSchema, specResultSubmissionSchema]);

const shapingImportReceiptBaseShape = {
  shaping_schema_version: z.literal(SHAPING_SCHEMA_VERSION),
  shaping_mission_content_sha256: sha256Schema,
  result_content_sha256: sha256Schema,
  imported_at: z.iso.datetime(),
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
  output_path: workspaceRelativePosixPathSchema,
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
  output_path: workspaceRelativePosixPathSchema,
  result_schema_version: z.literal(1),
  required_fields: z.tuple([
    z.literal("result_schema_version"),
    z.literal("spec_mission_content_sha256"),
    z.literal("identity"),
    z.literal("proposal"),
  ]),
});

const shapingPackageCommonShape = {
  shaping_schema_version: z.literal(SHAPING_SCHEMA_VERSION),
  task_path: workspaceRelativePosixPathSchema,
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

  const directory = `.founder/shaping/${mission.identity.work_item_id}/${mission.identity.phase}-${mission.identity.input_sha256}`;
  if (mission.task_path !== `${directory}/TASK.md`) {
    context.addIssue({
      code: "custom",
      message: "task_path must match the shaping identity",
      path: ["task_path"],
      input: mission.task_path,
    });
  }
  if (mission.result_contract.output_path !== `${directory}/result.json`) {
    context.addIssue({
      code: "custom",
      message: "output_path must match the shaping identity",
      path: ["result_contract", "output_path"],
      input: mission.result_contract.output_path,
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

export const shapingMissionPackageSchema: z.ZodType<ShapingMissionPackage> =
  z.union([brainstormMissionPackageSchema, specMissionPackageSchema]);

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

function canonicalAcceptance(receipt: ShapingAcceptanceReceipt) {
  return {
    shaping_schema_version: receipt.shaping_schema_version,
    identity: canonicalIdentity(receipt.identity),
    brainstorm_mission_content_sha256:
      receipt.brainstorm_mission_content_sha256,
    brainstorm_result_content_sha256:
      receipt.brainstorm_result_content_sha256,
    accepted_at: receipt.accepted_at,
  };
}

function canonicalShapingInput(input: ShapingInput) {
  if (input.phase === "brainstorm") {
    return {
      phase: input.phase,
      title: input.title,
      ...(input.notes === undefined ? {} : { notes: input.notes }),
    };
  }
  return {
    phase: input.phase,
    title: input.title,
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    brainstorm_acceptance_sha256: input.brainstorm_acceptance_sha256,
    brainstorm_acceptance: canonicalAcceptance(input.brainstorm_acceptance),
    brainstorm_result: canonicalBrainstormResult(input.brainstorm_result),
  };
}

function canonicalResultContract(
  resultContract: ShapingMissionPackage["result_contract"],
) {
  return {
    schema_version: resultContract.schema_version,
    output_path: resultContract.output_path,
    result_schema_version: resultContract.result_schema_version,
    required_fields: resultContract.required_fields,
  };
}

function shapingContent(mission: ShapingMissionPackage) {
  return {
    shaping_schema_version: mission.shaping_schema_version,
    identity: canonicalIdentity(mission.identity),
    input: canonicalShapingInput(mission.input),
    result_contract: canonicalResultContract(mission.result_contract),
    task_path: mission.task_path,
  };
}

function hashShapingArtifact(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function hashShapingInput(input: ShapingInput): string {
  const parsed = shapingInputSchema.parse(input);
  return hashShapingArtifact(canonicalShapingInput(parsed));
}

export function serializeShapingContent(
  mission: ShapingMissionPackage,
): string {
  return JSON.stringify(shapingContent(mission));
}

export function hashShapingContent(mission: ShapingMissionPackage): string {
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

export function compileBrainstormMission(input: {
  work_item_id: string;
  shaping_input: BrainstormShapingInput;
  paths: ShapingPaths;
}): BrainstormMissionPackage {
  const shapingInput = brainstormShapingInputSchema.parse(input.shaping_input);
  const identity: ShapingIdentity<"brainstorm"> = {
    phase: "brainstorm",
    work_item_id: workItemIdSchema.parse(input.work_item_id),
    input_sha256: hashShapingInput(shapingInput),
  };
  const draft: Omit<BrainstormMissionPackage, "content_sha256"> = {
    shaping_schema_version: SHAPING_SCHEMA_VERSION,
    identity,
    input: shapingInput,
    result_contract: {
      schema_version: 1,
      output_path: input.paths.output_path,
      result_schema_version: 1,
      required_fields: BRAINSTORM_RESULT_REQUIRED_FIELDS,
    },
    task_path: input.paths.task_path,
  };
  return brainstormMissionPackageSchema.parse({
    ...draft,
    content_sha256: hashShapingContent(draft as BrainstormMissionPackage),
  });
}

export function compileSpecMission(input: {
  work_item_id: string;
  shaping_input: SpecShapingInput;
  paths: ShapingPaths;
}): SpecMissionPackage {
  const shapingInput = specShapingInputSchema.parse(input.shaping_input);
  const identity: ShapingIdentity<"spec"> = {
    phase: "spec",
    work_item_id: workItemIdSchema.parse(input.work_item_id),
    input_sha256: hashShapingInput(shapingInput),
  };
  const draft: Omit<SpecMissionPackage, "content_sha256"> = {
    shaping_schema_version: SHAPING_SCHEMA_VERSION,
    identity,
    input: shapingInput,
    result_contract: {
      schema_version: 1,
      output_path: input.paths.output_path,
      result_schema_version: 1,
      required_fields: SPEC_RESULT_REQUIRED_FIELDS,
    },
    task_path: input.paths.task_path,
  };
  return specMissionPackageSchema.parse({
    ...draft,
    content_sha256: hashShapingContent(draft as SpecMissionPackage),
  });
}

export function renderShapingTaskMd(mission: ShapingMissionPackage): string {
  const validated = shapingMissionPackageSchema.parse(mission);
  const resultFields = validated.result_contract.required_fields
    .map((field) => `- \`${field}\``)
    .join("\n");
  return `# ${validated.identity.phase === "brainstorm" ? "Brainstorm" : "Spec"} shaping task

Use the immutable input below. Write one JSON result to \`${validated.result_contract.output_path}\`.

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
