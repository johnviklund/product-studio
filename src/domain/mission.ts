import { createHash } from "node:crypto";

import { z } from "zod";

import {
  capabilityEnvelopeV1Schema,
  executionDefaultsV1Schema,
  resolveCapabilityEnvelope,
  type CapabilityEnvelopeV1,
  type ExecutionDefaultsV1,
} from "./capability-envelope";
import type {
  ControllerRunManifest,
  WorkItem,
  WorkItemType,
} from "./work-item";
import { workspaceRelativePosixPathSchema } from "./workspace-path";

export const MISSION_SCHEMA_VERSION = 7 as const;
const RESULT_CONTRACT_SCHEMA_VERSION = 4 as const;
const RESULT_SCHEMA_VERSION = 2 as const;
const FAIL_CLOSED_EXECUTION_DEFAULTS: ExecutionDefaultsV1 = {
  schema_version: 1,
  approved_command_forms: [],
  approved_url_operations: [],
  mcp: "forbidden",
  credentials: "forbidden",
};
const EXECUTE_RESULT_REQUIRED_FIELDS = [
  "result_schema_version",
  "mission_content_sha256",
  "identity",
  "commit",
  "summary",
  "changed_files",
  "verification",
] as const;
const REVIEW_RESULT_REQUIRED_FIELDS = [
  "result_schema_version",
  "review_mission_content_sha256",
  "identity",
  "execute_mission_content_sha256",
  "execute_result_content_sha256",
  "git_base_commit",
  "accepted_result_commit",
  "summary",
  "verdict",
  "findings",
] as const;
const PATCH_RESULT_REQUIRED_FIELDS = [
  "result_schema_version",
  "patch_mission_content_sha256",
  "identity",
  "commit",
  "summary",
  "changed_files",
  "verification",
] as const;
const PATCH_REVIEW_RESULT_REQUIRED_FIELDS = [
  "result_schema_version",
  "review_mission_content_sha256",
  "identity",
  "patch_mission_content_sha256",
  "patch_result_content_sha256",
  "git_base_commit",
  "accepted_result_commit",
  "summary",
  "verdict",
  "findings",
  "resolutions",
] as const;

export const MISSION_PHASES = ["execute", "review", "patch"] as const;
export type MissionPhase = (typeof MISSION_PHASES)[number];

const missionWorkItemTypes = Object.keys({
  Explore: true,
  Prototype: true,
  MVP: true,
  Feature: true,
  Fix: true,
  Maintenance: true,
  Incident: true,
} satisfies Record<WorkItemType, true>) as [WorkItemType, ...WorkItemType[]];

const positiveSafeIntegerSchema = z.number().int().positive().safe();
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const nonEmptyTrimmedStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be empty")
  .refine(
    (value) => value === value.trim(),
    "must not have leading or trailing whitespace",
  );
const purposeSchema = nonEmptyTrimmedStringSchema.refine(
  (value) => !/[\r\n]/u.test(value),
  "must not contain line breaks",
);
const nonEmptyStringListSchema = z
  .array(nonEmptyTrimmedStringSchema)
  .min(1, "must not be empty")
  .refine(
    (values) =>
      new Set(values.map((value) => value.toLocaleLowerCase())).size ===
      values.length,
    "must not contain case-insensitive duplicates",
  );
const allowedScopeSchema = z
  .array(workspaceRelativePosixPathSchema)
  .min(1, "must not be empty")
  .refine(
    (values) =>
      new Set(values.map((value) => value.toLocaleLowerCase())).size ===
      values.length,
    "must not contain case-insensitive duplicates",
  );
const workItemIdSchema = z
  .string()
  .regex(
    /^wi_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "work_item_id must use the wi_<uuid> format",
  );

interface MissionIdentityBase<TPhase extends MissionPhase> {
  phase: TPhase;
  work_item_id: string;
  goal_version: number;
  input_revision: number;
  attempt: number;
}

export type MissionIdentity<
  TPhase extends MissionPhase = MissionPhase,
> = TPhase extends "patch"
  ? MissionIdentityBase<TPhase> & { patch_cycle: number }
  : MissionIdentityBase<TPhase>;

interface MissionControllerRun<TPhase extends MissionPhase> {
  run_id: string;
  idempotency_key: string;
  phase: TPhase;
  started_at: string;
  completed_at: string;
}

interface MissionGoal {
  title: string;
  type?: WorkItemType;
  purpose: string;
  acceptance_criteria: string[];
  non_goals: string[];
  allowed_scope: string[];
  review_ready: string[];
}

interface MissionSourceRevision {
  git_base_commit: string;
}

interface MissionResultContract<
  TRequiredFields extends readonly string[],
> {
  schema_version: 4;
  output_path: string;
  result_schema_version: 2;
  required_fields: TRequiredFields;
}

interface MissionPackageBase<TPhase extends MissionPhase> {
  mission_schema_version: typeof MISSION_SCHEMA_VERSION;
  identity: MissionIdentity<TPhase>;
  controller_run: MissionControllerRun<TPhase>;
  goal: MissionGoal;
  source_revision: MissionSourceRevision;
  task_path: string;
  content_sha256: string;
}

export interface ExecuteMissionPackage extends MissionPackageBase<"execute"> {
  capability_envelope: CapabilityEnvelopeV1;
  result_contract: MissionResultContract<
    typeof EXECUTE_RESULT_REQUIRED_FIELDS
  >;
}

export type PatchFindingLink =
  | { type: "acceptance_criteria"; criterion: string }
  | { type: "non_goals"; non_goal: string }
  | { type: "defect"; evidence_summary: string }
  | { type: "security"; evidence_summary: string }
  | { type: "deterministic_checks"; command: string };

export interface PatchSubjectFinding {
  finding_id: string;
  severity: "P0" | "P1" | "P2" | "P3";
  title: string;
  evidence: {
    path?: string;
    summary: string;
  };
  required_action: string;
  link: PatchFindingLink;
}

export interface ReviewCommandEvidenceRecord {
  name: string;
  argv: [string, ...string[]];
  started_at: string;
  completed_at: string;
  duration_ms: number;
  status: "passed";
  exit_code: 0;
  signal: null;
  stdout: string;
  stderr: string;
  output_truncated: boolean;
}

interface ReviewSubjectBase {
  git_base_commit: string;
  accepted_result_commit: string;
  changed_files: string[];
  command_evidence: ReviewCommandEvidenceRecord[];
}

export interface ExecuteReviewSubject extends ReviewSubjectBase {
  source: "execute";
  execute_mission_content_sha256: string;
  execute_result_content_sha256: string;
  execute_mission_path: string;
  execute_evidence_path: string;
}

export interface PatchReviewSubject extends ReviewSubjectBase {
  source: "patch";
  patch_cycle: number;
  patch_mission_content_sha256: string;
  patch_result_content_sha256: string;
  patch_mission_path: string;
  patch_evidence_path: string;
  resolved_from: {
    review_mission_content_sha256: string;
    review_result_content_sha256: string;
    finding_ids: [string, ...string[]];
  };
}

export type ReviewSubject = ExecuteReviewSubject | PatchReviewSubject;

export interface PatchSubject {
  review_mission_content_sha256: string;
  review_result_content_sha256: string;
  review_mission_path: string;
  review_result_path: string;
  review_evidence_path: string;
  reviewed_commit: string;
  findings: [PatchSubjectFinding, ...PatchSubjectFinding[]];
  prior_review_subject: ReviewSubject;
}

export interface ExecuteReviewMissionPackage
  extends MissionPackageBase<"review"> {
  review_subject: ExecuteReviewSubject;
  independence_attested: true;
  result_contract: MissionResultContract<
    typeof REVIEW_RESULT_REQUIRED_FIELDS
  >;
}

export interface PatchReviewMissionPackage
  extends MissionPackageBase<"review"> {
  review_subject: PatchReviewSubject;
  independence_attested: true;
  result_contract: MissionResultContract<
    typeof PATCH_REVIEW_RESULT_REQUIRED_FIELDS
  >;
}

export type ReviewMissionPackage =
  | ExecuteReviewMissionPackage
  | PatchReviewMissionPackage;

export interface PatchMissionPackage extends MissionPackageBase<"patch"> {
  capability_envelope: CapabilityEnvelopeV1;
  patch_subject: PatchSubject;
  result_contract: MissionResultContract<
    typeof PATCH_RESULT_REQUIRED_FIELDS
  >;
}

export type MissionPackage =
  | ExecuteMissionPackage
  | ReviewMissionPackage
  | PatchMissionPackage;

type HistoricalMissionPackageVariantV6<TPackage> =
  TPackage extends MissionPackage
    ? Omit<TPackage, "mission_schema_version"> & {
        mission_schema_version: 6;
      }
    : never;

export type HistoricalExecuteMissionPackageV6 =
  HistoricalMissionPackageVariantV6<ExecuteMissionPackage>;
export type HistoricalReviewMissionPackageV6 =
  HistoricalMissionPackageVariantV6<ReviewMissionPackage>;
export type HistoricalPatchMissionPackageV6 =
  HistoricalMissionPackageVariantV6<PatchMissionPackage>;
export type HistoricalMissionPackageV6 =
  | HistoricalExecuteMissionPackageV6
  | HistoricalReviewMissionPackageV6
  | HistoricalPatchMissionPackageV6;

interface HistoricalMissionPackageBaseV5<TPhase extends MissionPhase>
  extends Omit<MissionPackageBase<TPhase>, "mission_schema_version"> {
  mission_schema_version: 5;
}

export interface HistoricalExecuteMissionPackageV5
  extends HistoricalMissionPackageBaseV5<"execute"> {
  capability_envelope: CapabilityEnvelopeV1;
  result_contract: MissionResultContract<
    typeof EXECUTE_RESULT_REQUIRED_FIELDS
  >;
}

export interface HistoricalExecuteReviewMissionPackageV5
  extends HistoricalMissionPackageBaseV5<"review"> {
  review_subject: ExecuteReviewSubject;
  independence_attested: true;
  result_contract: MissionResultContract<
    typeof REVIEW_RESULT_REQUIRED_FIELDS
  >;
}

export interface HistoricalPatchReviewMissionPackageV5
  extends HistoricalMissionPackageBaseV5<"review"> {
  review_subject: PatchReviewSubject;
  independence_attested: true;
  result_contract: MissionResultContract<
    typeof PATCH_REVIEW_RESULT_REQUIRED_FIELDS
  >;
}

export type HistoricalReviewMissionPackageV5 =
  | HistoricalExecuteReviewMissionPackageV5
  | HistoricalPatchReviewMissionPackageV5;

export interface HistoricalPatchMissionPackageV5
  extends HistoricalMissionPackageBaseV5<"patch"> {
  patch_subject: PatchSubject;
  result_contract: MissionResultContract<
    typeof PATCH_RESULT_REQUIRED_FIELDS
  >;
}

export type HistoricalMissionPackageV5 =
  | HistoricalExecuteMissionPackageV5
  | HistoricalReviewMissionPackageV5
  | HistoricalPatchMissionPackageV5;

interface HistoricalMissionResultContractV4<
  TRequiredFields extends readonly string[],
> {
  schema_version: 4;
  output_path: string;
  result_schema_version: 2;
  required_fields: TRequiredFields;
}

interface HistoricalMissionPackageBaseV4<TPhase extends MissionPhase> {
  mission_schema_version: 4;
  identity: MissionIdentity<TPhase>;
  controller_run: MissionControllerRun<TPhase>;
  goal: MissionGoal;
  source_revision: MissionSourceRevision;
  task_path: string;
  content_sha256: string;
}

export interface HistoricalExecuteMissionPackageV4
  extends HistoricalMissionPackageBaseV4<"execute"> {
  result_contract: HistoricalMissionResultContractV4<
    typeof EXECUTE_RESULT_REQUIRED_FIELDS
  >;
}

export interface HistoricalExecuteReviewMissionPackageV4
  extends HistoricalMissionPackageBaseV4<"review"> {
  review_subject: ExecuteReviewSubject;
  independence_attested: true;
  result_contract: HistoricalMissionResultContractV4<
    typeof REVIEW_RESULT_REQUIRED_FIELDS
  >;
}

export interface HistoricalPatchReviewMissionPackageV4
  extends HistoricalMissionPackageBaseV4<"review"> {
  review_subject: PatchReviewSubject;
  independence_attested: true;
  result_contract: HistoricalMissionResultContractV4<
    typeof PATCH_REVIEW_RESULT_REQUIRED_FIELDS
  >;
}

export type HistoricalReviewMissionPackageV4 =
  | HistoricalExecuteReviewMissionPackageV4
  | HistoricalPatchReviewMissionPackageV4;

export interface HistoricalPatchMissionPackageV4
  extends HistoricalMissionPackageBaseV4<"patch"> {
  patch_subject: PatchSubject;
  result_contract: HistoricalMissionResultContractV4<
    typeof PATCH_RESULT_REQUIRED_FIELDS
  >;
}

export type HistoricalMissionPackageV4 =
  | HistoricalExecuteMissionPackageV4
  | HistoricalReviewMissionPackageV4
  | HistoricalPatchMissionPackageV4;

export interface HistoricalExecuteReviewSubjectV3 extends ReviewSubjectBase {
  execute_mission_content_sha256: string;
  execute_result_content_sha256: string;
  execute_mission_path: string;
  execute_evidence_path: string;
}

interface HistoricalMissionResultContractV3<
  TRequiredFields extends readonly string[],
> {
  schema_version: 3;
  output_path: string;
  result_schema_version: 2;
  required_fields: TRequiredFields;
}

interface HistoricalMissionPackageBaseV3<TPhase extends "execute" | "review"> {
  mission_schema_version: 3;
  identity: MissionIdentity<TPhase>;
  controller_run: MissionControllerRun<TPhase>;
  goal: MissionGoal;
  source_revision: MissionSourceRevision;
  task_path: string;
  content_sha256: string;
}

export interface HistoricalExecuteMissionPackageV3
  extends HistoricalMissionPackageBaseV3<"execute"> {
  result_contract: HistoricalMissionResultContractV3<
    typeof EXECUTE_RESULT_REQUIRED_FIELDS
  >;
}

export interface HistoricalReviewMissionPackageV3
  extends HistoricalMissionPackageBaseV3<"review"> {
  review_subject: HistoricalExecuteReviewSubjectV3;
  independence_attested: true;
  result_contract: HistoricalMissionResultContractV3<
    typeof REVIEW_RESULT_REQUIRED_FIELDS
  >;
}

export type HistoricalMissionPackageV3 =
  | HistoricalExecuteMissionPackageV3
  | HistoricalReviewMissionPackageV3;

export type ReadableMissionPackage =
  | MissionPackage
  | HistoricalMissionPackageV6
  | HistoricalMissionPackageV5
  | HistoricalMissionPackageV4
  | HistoricalMissionPackageV3;

export interface ReviewMissionControllerRun {
  schema_version: 1;
  run_id: string;
  work_item_id: string;
  idempotency_key: string;
  phase: "review";
  goal_version: number;
  input_revision: number;
  attempt: number;
  started_at: string;
  completed_at: string;
  outcome: "applied";
}

export interface ReviewMissionCompileInput {
  work_item: WorkItem;
  controller_run: ReviewMissionControllerRun;
  review_subject: ReviewSubject;
  paths: MissionPaths;
  independence_attested: true;
}

export interface PatchMissionControllerRun {
  schema_version: 1;
  run_id: string;
  work_item_id: string;
  idempotency_key: string;
  phase: "patch";
  goal_version: number;
  input_revision: number;
  attempt: number;
  started_at: string;
  completed_at: string;
  outcome: "applied";
}

export interface PatchMissionCompileInput {
  work_item: WorkItem;
  controller_run: PatchMissionControllerRun;
  patch_subject: PatchSubject;
  paths: MissionPaths;
}

export interface MissionPaths {
  task_path: string;
  output_path: string;
  git_base_commit: string;
}

type MissionPathBoundPackage = Pick<
  MissionPackageBase<MissionPhase>,
  "identity" | "task_path"
> & {
  result_contract: Pick<
    MissionResultContract<readonly string[]>,
    "output_path"
  >;
};

function validateMissionPackagePaths(
  mission: MissionPathBoundPackage,
  context: z.RefinementCtx,
  reviewPatchCycle?: number,
): void {
  const identity = mission.identity;
  const patchCycleSuffix =
    identity.phase === "patch"
      ? `-${identity.patch_cycle}`
      : reviewPatchCycle === undefined
        ? ""
        : `-patch-${reviewPatchCycle}`;
  const directory = `.founder/missions/${identity.work_item_id}/${identity.phase}-${identity.goal_version}-${identity.input_revision}-${identity.attempt}${patchCycleSuffix}`;
  const expectedTaskPath = `${directory}/TASK.md`;
  const expectedOutputPath = `${directory}/result.json`;

  if (mission.task_path !== expectedTaskPath) {
    context.addIssue({
      code: "custom",
      message: "task_path must match the phase-qualified mission identity",
      path: ["task_path"],
      input: mission.task_path,
    });
  }
  if (mission.result_contract.output_path !== expectedOutputPath) {
    context.addIssue({
      code: "custom",
      message: "output_path must match the phase-qualified mission identity",
      path: ["result_contract", "output_path"],
      input: mission.result_contract.output_path,
    });
  }
}

export interface MissionArtifactWriteResult<
  TMission extends MissionPackage = MissionPackage,
> {
  mission: TMission;
  workspace_path: string;
  task_path: string;
  mission_path: string;
}

export interface MissionArtifactReadResult {
  mission: ReadableMissionPackage;
  mission_path: string;
}

export type MissionPackageBuilder<
  TMission extends MissionPackage = MissionPackage,
> = (paths: MissionPaths) => TMission;

const executeMissionIdentitySchema: z.ZodType<MissionIdentity<"execute">> =
  z.strictObject({
    phase: z.literal("execute"),
    work_item_id: workItemIdSchema,
    goal_version: positiveSafeIntegerSchema,
    input_revision: positiveSafeIntegerSchema,
    attempt: nonNegativeSafeIntegerSchema,
  });

const reviewMissionIdentitySchema: z.ZodType<MissionIdentity<"review">> =
  z.strictObject({
    phase: z.literal("review"),
    work_item_id: workItemIdSchema,
    goal_version: positiveSafeIntegerSchema,
    input_revision: positiveSafeIntegerSchema,
    attempt: nonNegativeSafeIntegerSchema,
  });

const patchMissionIdentitySchema: z.ZodType<MissionIdentity<"patch">> =
  z.strictObject({
    phase: z.literal("patch"),
    work_item_id: workItemIdSchema,
    goal_version: positiveSafeIntegerSchema,
    input_revision: positiveSafeIntegerSchema,
    attempt: nonNegativeSafeIntegerSchema,
    patch_cycle: positiveSafeIntegerSchema,
  });

export const missionIdentitySchema: z.ZodType<MissionIdentity> = z.union([
  executeMissionIdentitySchema,
  reviewMissionIdentitySchema,
  patchMissionIdentitySchema,
]);

const missionGoalSchema: z.ZodType<MissionGoal> = z.strictObject({
  title: nonEmptyTrimmedStringSchema,
  type: z.enum(missionWorkItemTypes).optional(),
  purpose: purposeSchema,
  acceptance_criteria: nonEmptyStringListSchema,
  non_goals: nonEmptyStringListSchema,
  allowed_scope: allowedScopeSchema,
  review_ready: nonEmptyStringListSchema,
});

const missionSourceRevisionSchema: z.ZodType<MissionSourceRevision> =
  z.strictObject({
    git_base_commit: z.string().regex(/^[0-9a-f]{40}$/),
  });

const reviewCommandEvidenceRecordSchema: z.ZodType<ReviewCommandEvidenceRecord> =
  z.strictObject({
    name: nonEmptyTrimmedStringSchema,
    argv: z.tuple([nonEmptyTrimmedStringSchema], z.string()),
    started_at: z.iso.datetime(),
    completed_at: z.iso.datetime(),
    duration_ms: nonNegativeSafeIntegerSchema,
    status: z.literal("passed"),
    exit_code: z.literal(0),
    signal: z.null(),
    stdout: z.string(),
    stderr: z.string(),
    output_truncated: z.boolean(),
  });

const reviewSubjectCommonShape = {
  git_base_commit: z.string().regex(/^[0-9a-f]{40}$/),
  accepted_result_commit: z.string().regex(/^[0-9a-f]{40}$/),
  changed_files: z.array(workspaceRelativePosixPathSchema),
  command_evidence: z.array(reviewCommandEvidenceRecordSchema).min(1),
};

function validateReviewSubjectEvidence(
  subject: ReviewSubjectBase,
  context: z.RefinementCtx,
): void {
  if (new Set(subject.changed_files).size !== subject.changed_files.length) {
    context.addIssue({
      code: "custom",
      message: "changed_files must not contain duplicates",
      path: ["changed_files"],
      input: subject.changed_files,
    });
  }
  const sortedChangedFiles = [...subject.changed_files].sort();
  if (
    sortedChangedFiles.some(
      (changedFile, index) => changedFile !== subject.changed_files[index],
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "changed_files must use canonical sort order",
      path: ["changed_files"],
      input: subject.changed_files,
    });
  }
  if (
    new Set(
      subject.command_evidence.map((record) =>
        record.name.toLocaleLowerCase(),
      ),
    ).size !== subject.command_evidence.length
  ) {
    context.addIssue({
      code: "custom",
      message: "command evidence names must not contain duplicates",
      path: ["command_evidence"],
      input: subject.command_evidence,
    });
  }
}

export const executeReviewSubjectSchema: z.ZodType<ExecuteReviewSubject> = z
  .strictObject({
    ...reviewSubjectCommonShape,
    source: z.literal("execute"),
    execute_mission_content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    execute_result_content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    execute_mission_path: workspaceRelativePosixPathSchema,
    execute_evidence_path: workspaceRelativePosixPathSchema,
  })
  .superRefine(validateReviewSubjectEvidence);

const nonEmptyFindingIdListSchema: z.ZodType<[string, ...string[]]> = z
  .tuple([nonEmptyTrimmedStringSchema], nonEmptyTrimmedStringSchema)
  .superRefine((findingIds, context) => {
    if (new Set(findingIds).size !== findingIds.length) {
      context.addIssue({
        code: "custom",
        message: "finding_ids must not contain duplicates",
        input: findingIds,
      });
    }
    const sortedFindingIds = [...findingIds].sort();
    if (
      sortedFindingIds.some(
        (findingId, index) => findingId !== findingIds[index],
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "finding_ids must use canonical sort order",
        input: findingIds,
      });
    }
  });

const patchReviewSubjectSchema: z.ZodType<PatchReviewSubject> = z
  .strictObject({
    ...reviewSubjectCommonShape,
    source: z.literal("patch"),
    patch_cycle: positiveSafeIntegerSchema,
    patch_mission_content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    patch_result_content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    patch_mission_path: workspaceRelativePosixPathSchema,
    patch_evidence_path: workspaceRelativePosixPathSchema,
    resolved_from: z.strictObject({
      review_mission_content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
      review_result_content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
      finding_ids: nonEmptyFindingIdListSchema,
    }),
  })
  .superRefine(validateReviewSubjectEvidence);

export const reviewSubjectSchema: z.ZodType<ReviewSubject> = z.union([
  executeReviewSubjectSchema,
  patchReviewSubjectSchema,
]);

const patchFindingLinkSchema: z.ZodType<PatchFindingLink> =
  z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("acceptance_criteria"),
      criterion: nonEmptyTrimmedStringSchema,
    }),
    z.strictObject({
      type: z.literal("non_goals"),
      non_goal: nonEmptyTrimmedStringSchema,
    }),
    z.strictObject({
      type: z.literal("defect"),
      evidence_summary: nonEmptyTrimmedStringSchema,
    }),
    z.strictObject({
      type: z.literal("security"),
      evidence_summary: nonEmptyTrimmedStringSchema,
    }),
    z.strictObject({
      type: z.literal("deterministic_checks"),
      command: nonEmptyTrimmedStringSchema,
    }),
  ]);

const patchSubjectFindingSchema: z.ZodType<PatchSubjectFinding> =
  z.strictObject({
    finding_id: nonEmptyTrimmedStringSchema,
    severity: z.enum(["P0", "P1", "P2", "P3"]),
    title: nonEmptyTrimmedStringSchema,
    evidence: z.strictObject({
      path: workspaceRelativePosixPathSchema.optional(),
      summary: nonEmptyTrimmedStringSchema,
    }),
    required_action: nonEmptyTrimmedStringSchema,
    link: patchFindingLinkSchema,
  });

const patchSubjectFindingListSchema: z.ZodType<
  [PatchSubjectFinding, ...PatchSubjectFinding[]]
> = z
  .tuple([patchSubjectFindingSchema], patchSubjectFindingSchema)
  .superRefine((findings, context) => {
    const findingIds = findings.map((finding) => finding.finding_id);
    if (new Set(findingIds).size !== findingIds.length) {
      context.addIssue({
        code: "custom",
        message: "patch findings must have unique finding_id values",
        input: findings,
      });
    }
    const sortedFindingIds = [...findingIds].sort();
    if (
      sortedFindingIds.some(
        (findingId, index) => findingId !== findingIds[index],
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "patch findings must use canonical finding_id order",
        input: findings,
      });
    }
  });

export const patchSubjectSchema: z.ZodType<PatchSubject> = z
  .strictObject({
    review_mission_content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    review_result_content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    review_mission_path: workspaceRelativePosixPathSchema,
    review_result_path: workspaceRelativePosixPathSchema,
    review_evidence_path: workspaceRelativePosixPathSchema,
    reviewed_commit: z.string().regex(/^[0-9a-f]{40}$/),
    findings: patchSubjectFindingListSchema,
    prior_review_subject: reviewSubjectSchema,
  })
  .superRefine((subject, context) => {
    if (
      subject.reviewed_commit !==
      subject.prior_review_subject.accepted_result_commit
    ) {
      context.addIssue({
        code: "custom",
        message: "reviewed_commit must match the prior review subject commit",
        path: ["reviewed_commit"],
        input: subject.reviewed_commit,
      });
    }
  });

const executeResultContractSchema = z.strictObject({
  schema_version: z.literal(RESULT_CONTRACT_SCHEMA_VERSION),
  output_path: workspaceRelativePosixPathSchema,
  result_schema_version: z.literal(RESULT_SCHEMA_VERSION),
  required_fields: z.tuple([
    z.literal(EXECUTE_RESULT_REQUIRED_FIELDS[0]),
    z.literal(EXECUTE_RESULT_REQUIRED_FIELDS[1]),
    z.literal(EXECUTE_RESULT_REQUIRED_FIELDS[2]),
    z.literal(EXECUTE_RESULT_REQUIRED_FIELDS[3]),
    z.literal(EXECUTE_RESULT_REQUIRED_FIELDS[4]),
    z.literal(EXECUTE_RESULT_REQUIRED_FIELDS[5]),
    z.literal(EXECUTE_RESULT_REQUIRED_FIELDS[6]),
  ]),
});

const reviewResultContractSchema = z.strictObject({
  schema_version: z.literal(RESULT_CONTRACT_SCHEMA_VERSION),
  output_path: workspaceRelativePosixPathSchema,
  result_schema_version: z.literal(RESULT_SCHEMA_VERSION),
  required_fields: z.tuple([
    z.literal(REVIEW_RESULT_REQUIRED_FIELDS[0]),
    z.literal(REVIEW_RESULT_REQUIRED_FIELDS[1]),
    z.literal(REVIEW_RESULT_REQUIRED_FIELDS[2]),
    z.literal(REVIEW_RESULT_REQUIRED_FIELDS[3]),
    z.literal(REVIEW_RESULT_REQUIRED_FIELDS[4]),
    z.literal(REVIEW_RESULT_REQUIRED_FIELDS[5]),
    z.literal(REVIEW_RESULT_REQUIRED_FIELDS[6]),
    z.literal(REVIEW_RESULT_REQUIRED_FIELDS[7]),
    z.literal(REVIEW_RESULT_REQUIRED_FIELDS[8]),
    z.literal(REVIEW_RESULT_REQUIRED_FIELDS[9]),
  ]),
});

const patchResultContractSchema = z.strictObject({
  schema_version: z.literal(RESULT_CONTRACT_SCHEMA_VERSION),
  output_path: workspaceRelativePosixPathSchema,
  result_schema_version: z.literal(RESULT_SCHEMA_VERSION),
  required_fields: z.tuple([
    z.literal(PATCH_RESULT_REQUIRED_FIELDS[0]),
    z.literal(PATCH_RESULT_REQUIRED_FIELDS[1]),
    z.literal(PATCH_RESULT_REQUIRED_FIELDS[2]),
    z.literal(PATCH_RESULT_REQUIRED_FIELDS[3]),
    z.literal(PATCH_RESULT_REQUIRED_FIELDS[4]),
    z.literal(PATCH_RESULT_REQUIRED_FIELDS[5]),
    z.literal(PATCH_RESULT_REQUIRED_FIELDS[6]),
  ]),
});

const patchReviewResultContractSchema = z.strictObject({
  schema_version: z.literal(RESULT_CONTRACT_SCHEMA_VERSION),
  output_path: workspaceRelativePosixPathSchema,
  result_schema_version: z.literal(RESULT_SCHEMA_VERSION),
  required_fields: z.tuple([
    z.literal(PATCH_REVIEW_RESULT_REQUIRED_FIELDS[0]),
    z.literal(PATCH_REVIEW_RESULT_REQUIRED_FIELDS[1]),
    z.literal(PATCH_REVIEW_RESULT_REQUIRED_FIELDS[2]),
    z.literal(PATCH_REVIEW_RESULT_REQUIRED_FIELDS[3]),
    z.literal(PATCH_REVIEW_RESULT_REQUIRED_FIELDS[4]),
    z.literal(PATCH_REVIEW_RESULT_REQUIRED_FIELDS[5]),
    z.literal(PATCH_REVIEW_RESULT_REQUIRED_FIELDS[6]),
    z.literal(PATCH_REVIEW_RESULT_REQUIRED_FIELDS[7]),
    z.literal(PATCH_REVIEW_RESULT_REQUIRED_FIELDS[8]),
    z.literal(PATCH_REVIEW_RESULT_REQUIRED_FIELDS[9]),
    z.literal(PATCH_REVIEW_RESULT_REQUIRED_FIELDS[10]),
  ]),
});

const missionPackageCommonShape = {
  mission_schema_version: z.literal(MISSION_SCHEMA_VERSION),
  goal: missionGoalSchema,
  source_revision: missionSourceRevisionSchema,
  task_path: workspaceRelativePosixPathSchema,
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
};

function validateCapabilityEnvelopeScope(
  mission: Pick<ExecuteMissionPackage, "goal" | "capability_envelope">,
  context: z.RefinementCtx,
): void {
  const expectedScopeDigest = resolveCapabilityEnvelope(
    mission.goal.allowed_scope,
    {
      schema_version: 1,
      approved_command_forms:
        mission.capability_envelope.runtime.approved_command_forms,
      approved_url_operations:
        mission.capability_envelope.runtime.approved_url_operations,
      mcp: mission.capability_envelope.runtime.mcp,
      credentials: mission.capability_envelope.runtime.credentials,
    },
  ).workspace.allowed_scope_digest;
  if (
    mission.capability_envelope.workspace.allowed_scope_digest !==
    expectedScopeDigest
  ) {
    context.addIssue({
      code: "custom",
      message: "capability envelope scope digest must match goal allowed_scope",
      path: ["capability_envelope", "workspace", "allowed_scope_digest"],
      input: mission.capability_envelope.workspace.allowed_scope_digest,
    });
  }
}

const executeMissionPackageSchema: z.ZodType<ExecuteMissionPackage> =
  z
    .strictObject({
      ...missionPackageCommonShape,
      identity: executeMissionIdentitySchema,
      controller_run: z.strictObject({
        run_id: z.uuid(),
        idempotency_key: nonEmptyTrimmedStringSchema,
        phase: z.literal("execute"),
        started_at: z.iso.datetime(),
        completed_at: z.iso.datetime(),
      }),
      capability_envelope: capabilityEnvelopeV1Schema,
      result_contract: executeResultContractSchema,
    })
    .superRefine((mission, context) => {
      validateMissionPackagePaths(mission, context);
      validateCapabilityEnvelopeScope(mission, context);
    });

const executeReviewMissionPackageSchema: z.ZodType<ExecuteReviewMissionPackage> =
  z
    .strictObject({
      ...missionPackageCommonShape,
      identity: reviewMissionIdentitySchema,
      controller_run: z.strictObject({
        run_id: z.uuid(),
        idempotency_key: nonEmptyTrimmedStringSchema,
        phase: z.literal("review"),
        started_at: z.iso.datetime(),
        completed_at: z.iso.datetime(),
      }),
      review_subject: executeReviewSubjectSchema,
      independence_attested: z.literal(true),
      result_contract: reviewResultContractSchema,
    })
    .superRefine((mission, context) => {
      validateMissionPackagePaths(mission, context);
      if (
        mission.source_revision.git_base_commit !==
        mission.review_subject.git_base_commit
      ) {
        context.addIssue({
          code: "custom",
          message: "source revision must match the review subject Git base",
          path: ["source_revision", "git_base_commit"],
          input: mission.source_revision.git_base_commit,
        });
      }
    });

const patchReviewMissionPackageSchema: z.ZodType<PatchReviewMissionPackage> =
  z
    .strictObject({
      ...missionPackageCommonShape,
      identity: reviewMissionIdentitySchema,
      controller_run: z.strictObject({
        run_id: z.uuid(),
        idempotency_key: nonEmptyTrimmedStringSchema,
        phase: z.literal("review"),
        started_at: z.iso.datetime(),
        completed_at: z.iso.datetime(),
      }),
      review_subject: patchReviewSubjectSchema,
      independence_attested: z.literal(true),
      result_contract: patchReviewResultContractSchema,
    })
    .superRefine((mission, context) => {
      validateMissionPackagePaths(
        mission,
        context,
        mission.review_subject.patch_cycle,
      );
      if (
        mission.source_revision.git_base_commit !==
        mission.review_subject.git_base_commit
      ) {
        context.addIssue({
          code: "custom",
          message: "source revision must match the review subject Git base",
          path: ["source_revision", "git_base_commit"],
          input: mission.source_revision.git_base_commit,
        });
      }
    });

const patchMissionPackageSchema: z.ZodType<PatchMissionPackage> = z
  .strictObject({
    ...missionPackageCommonShape,
    identity: patchMissionIdentitySchema,
    controller_run: z.strictObject({
      run_id: z.uuid(),
      idempotency_key: nonEmptyTrimmedStringSchema,
      phase: z.literal("patch"),
      started_at: z.iso.datetime(),
      completed_at: z.iso.datetime(),
    }),
    capability_envelope: capabilityEnvelopeV1Schema,
    patch_subject: patchSubjectSchema,
    result_contract: patchResultContractSchema,
  })
  .superRefine((mission, context) => {
    validateMissionPackagePaths(mission, context);
    validateCapabilityEnvelopeScope(mission, context);
    if (
      mission.source_revision.git_base_commit !==
      mission.patch_subject.reviewed_commit
    ) {
      context.addIssue({
        code: "custom",
        message: "source revision must match the reviewed patch base commit",
        path: ["source_revision", "git_base_commit"],
        input: mission.source_revision.git_base_commit,
      });
    }
  });

export const missionPackageSchema: z.ZodType<MissionPackage> = z
  .union([
    executeMissionPackageSchema,
    executeReviewMissionPackageSchema,
    patchReviewMissionPackageSchema,
    patchMissionPackageSchema,
  ])
  .superRefine((mission, context) => {
    if (mission.content_sha256 !== hashMissionContent(mission)) {
      context.addIssue({
        code: "custom",
        message: "content_sha256 must match the canonical mission content",
        path: ["content_sha256"],
        input: mission.content_sha256,
      });
    }
  });

function historicalMissionPackageV6VariantSchema<
  TCurrent extends MissionPackage,
  THistorical extends HistoricalMissionPackageV6,
>(currentSchema: z.ZodType<TCurrent>): z.ZodType<THistorical> {
  return z
    .preprocess((input) => {
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        return input;
      }
      const candidate = input as Record<string, unknown>;
      return {
        ...candidate,
        mission_schema_version:
          candidate.mission_schema_version === 6
            ? MISSION_SCHEMA_VERSION
            : null,
      };
    }, currentSchema)
    .transform(
      (mission) =>
        ({ ...mission, mission_schema_version: 6 }) as unknown as THistorical,
    ) as z.ZodType<THistorical>;
}

const historicalExecuteMissionPackageV6Schema =
  historicalMissionPackageV6VariantSchema<
    ExecuteMissionPackage,
    HistoricalExecuteMissionPackageV6
  >(executeMissionPackageSchema);
const historicalExecuteReviewMissionPackageV6Schema =
  historicalMissionPackageV6VariantSchema<
    ExecuteReviewMissionPackage,
    HistoricalMissionPackageVariantV6<ExecuteReviewMissionPackage>
  >(executeReviewMissionPackageSchema);
const historicalPatchReviewMissionPackageV6Schema =
  historicalMissionPackageV6VariantSchema<
    PatchReviewMissionPackage,
    HistoricalMissionPackageVariantV6<PatchReviewMissionPackage>
  >(patchReviewMissionPackageSchema);
const historicalPatchMissionPackageV6Schema =
  historicalMissionPackageV6VariantSchema<
    PatchMissionPackage,
    HistoricalPatchMissionPackageV6
  >(patchMissionPackageSchema);

export const historicalMissionPackageV6Schema: z.ZodType<
  HistoricalMissionPackageV6
> = z
  .union([
    historicalExecuteMissionPackageV6Schema,
    historicalExecuteReviewMissionPackageV6Schema,
    historicalPatchReviewMissionPackageV6Schema,
    historicalPatchMissionPackageV6Schema,
  ])
  .superRefine((mission, context) => {
    if (mission.content_sha256 !== hashHistoricalMissionContentV6(mission)) {
      context.addIssue({
        code: "custom",
        message:
          "content_sha256 must match the canonical historical mission content",
        path: ["content_sha256"],
        input: mission.content_sha256,
      });
    }
  });

const historicalMissionPackageCommonShapeV5 = {
  mission_schema_version: z.literal(5),
  goal: missionGoalSchema,
  source_revision: missionSourceRevisionSchema,
  task_path: workspaceRelativePosixPathSchema,
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
};

const historicalExecuteMissionPackageV5Schema: z.ZodType<
  HistoricalExecuteMissionPackageV5
> = z
  .strictObject({
    ...historicalMissionPackageCommonShapeV5,
    identity: executeMissionIdentitySchema,
    controller_run: z.strictObject({
      run_id: z.uuid(),
      idempotency_key: nonEmptyTrimmedStringSchema,
      phase: z.literal("execute"),
      started_at: z.iso.datetime(),
      completed_at: z.iso.datetime(),
    }),
    capability_envelope: capabilityEnvelopeV1Schema,
    result_contract: executeResultContractSchema,
  })
  .superRefine((mission, context) => {
    validateMissionPackagePaths(mission, context);
    validateCapabilityEnvelopeScope(mission, context);
  });

const historicalExecuteReviewMissionPackageV5Schema: z.ZodType<
  HistoricalExecuteReviewMissionPackageV5
> = z
  .strictObject({
    ...historicalMissionPackageCommonShapeV5,
    identity: reviewMissionIdentitySchema,
    controller_run: z.strictObject({
      run_id: z.uuid(),
      idempotency_key: nonEmptyTrimmedStringSchema,
      phase: z.literal("review"),
      started_at: z.iso.datetime(),
      completed_at: z.iso.datetime(),
    }),
    review_subject: executeReviewSubjectSchema,
    independence_attested: z.literal(true),
    result_contract: reviewResultContractSchema,
  })
  .superRefine((mission, context) => {
    validateMissionPackagePaths(mission, context);
    if (
      mission.source_revision.git_base_commit !==
      mission.review_subject.git_base_commit
    ) {
      context.addIssue({
        code: "custom",
        message: "source revision must match the review subject Git base",
        path: ["source_revision", "git_base_commit"],
        input: mission.source_revision.git_base_commit,
      });
    }
  });

const historicalPatchReviewMissionPackageV5Schema: z.ZodType<
  HistoricalPatchReviewMissionPackageV5
> = z
  .strictObject({
    ...historicalMissionPackageCommonShapeV5,
    identity: reviewMissionIdentitySchema,
    controller_run: z.strictObject({
      run_id: z.uuid(),
      idempotency_key: nonEmptyTrimmedStringSchema,
      phase: z.literal("review"),
      started_at: z.iso.datetime(),
      completed_at: z.iso.datetime(),
    }),
    review_subject: patchReviewSubjectSchema,
    independence_attested: z.literal(true),
    result_contract: patchReviewResultContractSchema,
  })
  .superRefine((mission, context) => {
    validateMissionPackagePaths(
      mission,
      context,
      mission.review_subject.patch_cycle,
    );
    if (
      mission.source_revision.git_base_commit !==
      mission.review_subject.git_base_commit
    ) {
      context.addIssue({
        code: "custom",
        message: "source revision must match the review subject Git base",
        path: ["source_revision", "git_base_commit"],
        input: mission.source_revision.git_base_commit,
      });
    }
  });

const historicalPatchMissionPackageV5Schema: z.ZodType<
  HistoricalPatchMissionPackageV5
> = z
  .strictObject({
    ...historicalMissionPackageCommonShapeV5,
    identity: patchMissionIdentitySchema,
    controller_run: z.strictObject({
      run_id: z.uuid(),
      idempotency_key: nonEmptyTrimmedStringSchema,
      phase: z.literal("patch"),
      started_at: z.iso.datetime(),
      completed_at: z.iso.datetime(),
    }),
    patch_subject: patchSubjectSchema,
    result_contract: patchResultContractSchema,
  })
  .superRefine((mission, context) => {
    validateMissionPackagePaths(mission, context);
    if (
      mission.source_revision.git_base_commit !==
      mission.patch_subject.reviewed_commit
    ) {
      context.addIssue({
        code: "custom",
        message: "source revision must match the reviewed patch base commit",
        path: ["source_revision", "git_base_commit"],
        input: mission.source_revision.git_base_commit,
      });
    }
  });

export const historicalMissionPackageV5Schema: z.ZodType<
  HistoricalMissionPackageV5
> = z
  .union([
    historicalExecuteMissionPackageV5Schema,
    historicalExecuteReviewMissionPackageV5Schema,
    historicalPatchReviewMissionPackageV5Schema,
    historicalPatchMissionPackageV5Schema,
  ])
  .superRefine((mission, context) => {
    if (mission.content_sha256 !== hashHistoricalMissionContentV5(mission)) {
      context.addIssue({
        code: "custom",
        message:
          "content_sha256 must match the canonical historical mission content",
        path: ["content_sha256"],
        input: mission.content_sha256,
      });
    }
  });

const historicalMissionPackageCommonShapeV4 = {
  mission_schema_version: z.literal(4),
  goal: missionGoalSchema,
  source_revision: missionSourceRevisionSchema,
  task_path: workspaceRelativePosixPathSchema,
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
};

const historicalExecuteMissionPackageV4Schema: z.ZodType<
  HistoricalExecuteMissionPackageV4
> = z
  .strictObject({
    ...historicalMissionPackageCommonShapeV4,
    identity: executeMissionIdentitySchema,
    controller_run: z.strictObject({
      run_id: z.uuid(),
      idempotency_key: nonEmptyTrimmedStringSchema,
      phase: z.literal("execute"),
      started_at: z.iso.datetime(),
      completed_at: z.iso.datetime(),
    }),
    result_contract: executeResultContractSchema,
  })
  .superRefine(validateMissionPackagePaths);

const historicalExecuteReviewMissionPackageV4Schema: z.ZodType<
  HistoricalExecuteReviewMissionPackageV4
> = z
  .strictObject({
    ...historicalMissionPackageCommonShapeV4,
    identity: reviewMissionIdentitySchema,
    controller_run: z.strictObject({
      run_id: z.uuid(),
      idempotency_key: nonEmptyTrimmedStringSchema,
      phase: z.literal("review"),
      started_at: z.iso.datetime(),
      completed_at: z.iso.datetime(),
    }),
    review_subject: executeReviewSubjectSchema,
    independence_attested: z.literal(true),
    result_contract: reviewResultContractSchema,
  })
  .superRefine((mission, context) => {
    validateMissionPackagePaths(mission, context);
    if (
      mission.source_revision.git_base_commit !==
      mission.review_subject.git_base_commit
    ) {
      context.addIssue({
        code: "custom",
        message: "source revision must match the review subject Git base",
        path: ["source_revision", "git_base_commit"],
        input: mission.source_revision.git_base_commit,
      });
    }
  });

const historicalPatchReviewMissionPackageV4Schema: z.ZodType<
  HistoricalPatchReviewMissionPackageV4
> = z
  .strictObject({
    ...historicalMissionPackageCommonShapeV4,
    identity: reviewMissionIdentitySchema,
    controller_run: z.strictObject({
      run_id: z.uuid(),
      idempotency_key: nonEmptyTrimmedStringSchema,
      phase: z.literal("review"),
      started_at: z.iso.datetime(),
      completed_at: z.iso.datetime(),
    }),
    review_subject: patchReviewSubjectSchema,
    independence_attested: z.literal(true),
    result_contract: patchReviewResultContractSchema,
  })
  .superRefine((mission, context) => {
    validateMissionPackagePaths(
      mission,
      context,
      mission.review_subject.patch_cycle,
    );
    if (
      mission.source_revision.git_base_commit !==
      mission.review_subject.git_base_commit
    ) {
      context.addIssue({
        code: "custom",
        message: "source revision must match the review subject Git base",
        path: ["source_revision", "git_base_commit"],
        input: mission.source_revision.git_base_commit,
      });
    }
  });

const historicalPatchMissionPackageV4Schema: z.ZodType<
  HistoricalPatchMissionPackageV4
> = z
  .strictObject({
    ...historicalMissionPackageCommonShapeV4,
    identity: patchMissionIdentitySchema,
    controller_run: z.strictObject({
      run_id: z.uuid(),
      idempotency_key: nonEmptyTrimmedStringSchema,
      phase: z.literal("patch"),
      started_at: z.iso.datetime(),
      completed_at: z.iso.datetime(),
    }),
    patch_subject: patchSubjectSchema,
    result_contract: patchResultContractSchema,
  })
  .superRefine((mission, context) => {
    validateMissionPackagePaths(mission, context);
    if (
      mission.source_revision.git_base_commit !==
      mission.patch_subject.reviewed_commit
    ) {
      context.addIssue({
        code: "custom",
        message: "source revision must match the reviewed patch base commit",
        path: ["source_revision", "git_base_commit"],
        input: mission.source_revision.git_base_commit,
      });
    }
  });

export const historicalMissionPackageV4Schema: z.ZodType<
  HistoricalMissionPackageV4
> = z
  .union([
    historicalExecuteMissionPackageV4Schema,
    historicalExecuteReviewMissionPackageV4Schema,
    historicalPatchReviewMissionPackageV4Schema,
    historicalPatchMissionPackageV4Schema,
  ])
  .superRefine((mission, context) => {
    if (mission.content_sha256 !== hashHistoricalMissionContentV4(mission)) {
      context.addIssue({
        code: "custom",
        message:
          "content_sha256 must match the canonical historical mission content",
        path: ["content_sha256"],
        input: mission.content_sha256,
      });
    }
  });

const historicalExecuteReviewSubjectV3Schema: z.ZodType<
  HistoricalExecuteReviewSubjectV3
> = z
  .strictObject({
    ...reviewSubjectCommonShape,
    execute_mission_content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    execute_result_content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    execute_mission_path: workspaceRelativePosixPathSchema,
    execute_evidence_path: workspaceRelativePosixPathSchema,
  })
  .superRefine(validateReviewSubjectEvidence);

const historicalExecuteResultContractV3Schema = z.strictObject({
  schema_version: z.literal(3),
  output_path: workspaceRelativePosixPathSchema,
  result_schema_version: z.literal(RESULT_SCHEMA_VERSION),
  required_fields: z.tuple([
    z.literal(EXECUTE_RESULT_REQUIRED_FIELDS[0]),
    z.literal(EXECUTE_RESULT_REQUIRED_FIELDS[1]),
    z.literal(EXECUTE_RESULT_REQUIRED_FIELDS[2]),
    z.literal(EXECUTE_RESULT_REQUIRED_FIELDS[3]),
    z.literal(EXECUTE_RESULT_REQUIRED_FIELDS[4]),
    z.literal(EXECUTE_RESULT_REQUIRED_FIELDS[5]),
    z.literal(EXECUTE_RESULT_REQUIRED_FIELDS[6]),
  ]),
});

const historicalReviewResultContractV3Schema = z.strictObject({
  schema_version: z.literal(3),
  output_path: workspaceRelativePosixPathSchema,
  result_schema_version: z.literal(RESULT_SCHEMA_VERSION),
  required_fields: z.tuple([
    z.literal(REVIEW_RESULT_REQUIRED_FIELDS[0]),
    z.literal(REVIEW_RESULT_REQUIRED_FIELDS[1]),
    z.literal(REVIEW_RESULT_REQUIRED_FIELDS[2]),
    z.literal(REVIEW_RESULT_REQUIRED_FIELDS[3]),
    z.literal(REVIEW_RESULT_REQUIRED_FIELDS[4]),
    z.literal(REVIEW_RESULT_REQUIRED_FIELDS[5]),
    z.literal(REVIEW_RESULT_REQUIRED_FIELDS[6]),
    z.literal(REVIEW_RESULT_REQUIRED_FIELDS[7]),
    z.literal(REVIEW_RESULT_REQUIRED_FIELDS[8]),
    z.literal(REVIEW_RESULT_REQUIRED_FIELDS[9]),
  ]),
});

const historicalMissionPackageCommonShapeV3 = {
  mission_schema_version: z.literal(3),
  goal: missionGoalSchema,
  source_revision: missionSourceRevisionSchema,
  task_path: workspaceRelativePosixPathSchema,
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
};

const historicalExecuteMissionPackageV3Schema: z.ZodType<
  HistoricalExecuteMissionPackageV3
> = z
  .strictObject({
    ...historicalMissionPackageCommonShapeV3,
    identity: executeMissionIdentitySchema,
    controller_run: z.strictObject({
      run_id: z.uuid(),
      idempotency_key: nonEmptyTrimmedStringSchema,
      phase: z.literal("execute"),
      started_at: z.iso.datetime(),
      completed_at: z.iso.datetime(),
    }),
    result_contract: historicalExecuteResultContractV3Schema,
  })
  .superRefine(validateMissionPackagePaths);

const historicalReviewMissionPackageV3Schema: z.ZodType<
  HistoricalReviewMissionPackageV3
> = z
  .strictObject({
    ...historicalMissionPackageCommonShapeV3,
    identity: reviewMissionIdentitySchema,
    controller_run: z.strictObject({
      run_id: z.uuid(),
      idempotency_key: nonEmptyTrimmedStringSchema,
      phase: z.literal("review"),
      started_at: z.iso.datetime(),
      completed_at: z.iso.datetime(),
    }),
    review_subject: historicalExecuteReviewSubjectV3Schema,
    independence_attested: z.literal(true),
    result_contract: historicalReviewResultContractV3Schema,
  })
  .superRefine((mission, context) => {
    validateMissionPackagePaths(mission, context);
    if (
      mission.source_revision.git_base_commit !==
      mission.review_subject.git_base_commit
    ) {
      context.addIssue({
        code: "custom",
        message: "source revision must match the review subject Git base",
        path: ["source_revision", "git_base_commit"],
        input: mission.source_revision.git_base_commit,
      });
    }
  });

export const historicalMissionPackageV3Schema: z.ZodType<
  HistoricalMissionPackageV3
> = z
  .union([
    historicalExecuteMissionPackageV3Schema,
    historicalReviewMissionPackageV3Schema,
  ])
  .superRefine((mission, context) => {
    if (mission.content_sha256 !== hashHistoricalMissionContentV3(mission)) {
      context.addIssue({
        code: "custom",
        message: "content_sha256 must match the canonical historical mission content",
        path: ["content_sha256"],
        input: mission.content_sha256,
      });
    }
  });

export const readableMissionPackageSchema: z.ZodType<ReadableMissionPackage> =
  z.union([
    missionPackageSchema,
    historicalMissionPackageV6Schema,
    historicalMissionPackageV5Schema,
    historicalMissionPackageV4Schema,
    historicalMissionPackageV3Schema,
  ]);

const compilableWorkItemGoalSchema = z.object({
  schema_version: z.literal(2),
  work_item_id: workItemIdSchema,
  title: nonEmptyTrimmedStringSchema,
  type: z.enum(missionWorkItemTypes).optional(),
  goal_contract: z.object({
    schema_version: z.literal(1),
    goal_version: positiveSafeIntegerSchema,
    purpose: purposeSchema,
    acceptance_criteria: nonEmptyStringListSchema,
    non_goals: nonEmptyStringListSchema,
    allowed_scope: allowedScopeSchema,
    review_ready: nonEmptyStringListSchema,
  }),
});

const compilableExecuteWorkItemSchema = z.object({
  goal: compilableWorkItemGoalSchema,
  state: z.object({
    schema_version: z.literal(2),
    work_item_id: workItemIdSchema,
    phase: z.literal("execute"),
    status: z.literal("active"),
    updated_at: z.iso.datetime(),
    goal_version: positiveSafeIntegerSchema,
    input_revision: positiveSafeIntegerSchema,
    attempt: nonNegativeSafeIntegerSchema,
    patch_cycle: nonNegativeSafeIntegerSchema,
  }),
});

const compilableReviewWorkItemSchema = z.object({
  goal: compilableWorkItemGoalSchema,
  state: z.object({
    schema_version: z.literal(2),
    work_item_id: workItemIdSchema,
    phase: z.literal("review"),
    status: z.literal("active"),
    updated_at: z.iso.datetime(),
    goal_version: positiveSafeIntegerSchema,
    input_revision: positiveSafeIntegerSchema,
    attempt: nonNegativeSafeIntegerSchema,
    patch_cycle: nonNegativeSafeIntegerSchema,
  }),
});

const compilablePatchWorkItemSchema = z.object({
  goal: compilableWorkItemGoalSchema,
  state: z.object({
    schema_version: z.literal(2),
    work_item_id: workItemIdSchema,
    phase: z.literal("patch"),
    status: z.literal("active"),
    updated_at: z.iso.datetime(),
    goal_version: positiveSafeIntegerSchema,
    input_revision: positiveSafeIntegerSchema,
    attempt: nonNegativeSafeIntegerSchema,
    patch_cycle: positiveSafeIntegerSchema,
  }),
});

const appliedExecuteManifestSchema = z.strictObject({
  schema_version: z.literal(1),
  run_id: z.uuid(),
  work_item_id: workItemIdSchema,
  idempotency_key: nonEmptyTrimmedStringSchema,
  phase: z.literal("execute"),
  goal_version: positiveSafeIntegerSchema,
  input_revision: positiveSafeIntegerSchema,
  attempt: nonNegativeSafeIntegerSchema,
  started_at: z.iso.datetime(),
  completed_at: z.iso.datetime(),
  outcome: z.literal("applied"),
});

const reviewMissionControllerRunSchema: z.ZodType<ReviewMissionControllerRun> =
  z.strictObject({
    schema_version: z.literal(1),
    run_id: z.uuid(),
    work_item_id: workItemIdSchema,
    idempotency_key: nonEmptyTrimmedStringSchema,
    phase: z.literal("review"),
    goal_version: positiveSafeIntegerSchema,
    input_revision: positiveSafeIntegerSchema,
    attempt: nonNegativeSafeIntegerSchema,
    started_at: z.iso.datetime(),
    completed_at: z.iso.datetime(),
    outcome: z.literal("applied"),
  });

const patchMissionControllerRunSchema: z.ZodType<PatchMissionControllerRun> =
  z.strictObject({
    schema_version: z.literal(1),
    run_id: z.uuid(),
    work_item_id: workItemIdSchema,
    idempotency_key: nonEmptyTrimmedStringSchema,
    phase: z.literal("patch"),
    goal_version: positiveSafeIntegerSchema,
    input_revision: positiveSafeIntegerSchema,
    attempt: nonNegativeSafeIntegerSchema,
    started_at: z.iso.datetime(),
    completed_at: z.iso.datetime(),
    outcome: z.literal("applied"),
  });

const missionPathsSchema = z
  .strictObject({
    task_path: workspaceRelativePosixPathSchema,
    output_path: workspaceRelativePosixPathSchema,
    git_base_commit: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .superRefine((paths, context) => {
    const taskSegments = paths.task_path.split("/");
    const outputSegments = paths.output_path.split("/");
    if (taskSegments.at(-1) !== "TASK.md") {
      context.addIssue({
        code: "custom",
        message: "task_path must end in TASK.md",
        path: ["task_path"],
        input: paths.task_path,
      });
    }
    if (outputSegments.at(-1) !== "result.json") {
      context.addIssue({
        code: "custom",
        message: "output_path must end in result.json",
        path: ["output_path"],
        input: paths.output_path,
      });
    }
    if (
      taskSegments.slice(0, -1).join("/") !==
      outputSegments.slice(0, -1).join("/")
    ) {
      context.addIssue({
        code: "custom",
        message: "task_path and output_path must share one mission directory",
        path: ["output_path"],
        input: paths.output_path,
      });
    }
  });

const missionCompileInputSchema = z
  .strictObject({
    work_item: compilableExecuteWorkItemSchema,
    execute_manifest: appliedExecuteManifestSchema,
    paths: missionPathsSchema,
    execution_defaults: executionDefaultsV1Schema,
  })
  .superRefine(({ work_item: workItem, execute_manifest: manifest }, context) => {
    const expected = {
      work_item_id: workItem.goal.work_item_id,
      goal_version: workItem.goal.goal_contract.goal_version,
      input_revision: workItem.state.input_revision,
      attempt: workItem.state.attempt,
    };

    if (workItem.state.work_item_id !== expected.work_item_id) {
      context.addIssue({
        code: "custom",
        message: "goal and state work_item_id values must match",
        path: ["work_item", "state", "work_item_id"],
        input: workItem.state.work_item_id,
      });
    }
    if (workItem.state.goal_version !== expected.goal_version) {
      context.addIssue({
        code: "custom",
        message: "goal and state goal_version values must match",
        path: ["work_item", "state", "goal_version"],
        input: workItem.state.goal_version,
      });
    }
    for (const [field, value] of Object.entries(expected)) {
      if (manifest[field as keyof typeof expected] !== value) {
        context.addIssue({
          code: "custom",
          message: `execute manifest ${field} must match the governed work item`,
          path: ["execute_manifest", field],
          input: manifest[field as keyof typeof expected],
        });
      }
    }
  });

const reviewMissionCompileInputSchema = z
  .strictObject({
    work_item: compilableReviewWorkItemSchema,
    controller_run: reviewMissionControllerRunSchema,
    review_subject: reviewSubjectSchema,
    paths: missionPathsSchema,
    independence_attested: z.literal(true),
  })
  .superRefine(({ work_item: workItem, controller_run: run, review_subject: subject, paths }, context) => {
    const expected = {
      work_item_id: workItem.goal.work_item_id,
      goal_version: workItem.goal.goal_contract.goal_version,
      input_revision: workItem.state.input_revision,
      attempt: workItem.state.attempt,
    };

    if (workItem.state.work_item_id !== expected.work_item_id) {
      context.addIssue({
        code: "custom",
        message: "goal and state work_item_id values must match",
        path: ["work_item", "state", "work_item_id"],
        input: workItem.state.work_item_id,
      });
    }
    if (workItem.state.goal_version !== expected.goal_version) {
      context.addIssue({
        code: "custom",
        message: "goal and state goal_version values must match",
        path: ["work_item", "state", "goal_version"],
        input: workItem.state.goal_version,
      });
    }
    for (const [field, value] of Object.entries(expected)) {
      if (run[field as keyof typeof expected] !== value) {
        context.addIssue({
          code: "custom",
          message: `review controller run ${field} must match the governed work item`,
          path: ["controller_run", field],
          input: run[field as keyof typeof expected],
        });
      }
    }
    if (paths.git_base_commit !== subject.git_base_commit) {
      context.addIssue({
        code: "custom",
        message: "mission paths Git base must match the review subject",
        path: ["paths", "git_base_commit"],
        input: paths.git_base_commit,
      });
    }
  });

const patchMissionCompileInputSchema = z
  .strictObject({
    work_item: compilablePatchWorkItemSchema,
    controller_run: patchMissionControllerRunSchema,
    patch_subject: patchSubjectSchema,
    paths: missionPathsSchema,
    execution_defaults: executionDefaultsV1Schema,
  })
  .superRefine(
    (
      {
        work_item: workItem,
        controller_run: run,
        patch_subject: subject,
        paths,
      },
      context,
    ) => {
      const expected = {
        work_item_id: workItem.goal.work_item_id,
        goal_version: workItem.goal.goal_contract.goal_version,
        input_revision: workItem.state.input_revision,
        attempt: workItem.state.attempt,
      };

      if (workItem.state.work_item_id !== expected.work_item_id) {
        context.addIssue({
          code: "custom",
          message: "goal and state work_item_id values must match",
          path: ["work_item", "state", "work_item_id"],
          input: workItem.state.work_item_id,
        });
      }
      if (workItem.state.goal_version !== expected.goal_version) {
        context.addIssue({
          code: "custom",
          message: "goal and state goal_version values must match",
          path: ["work_item", "state", "goal_version"],
          input: workItem.state.goal_version,
        });
      }
      for (const [field, value] of Object.entries(expected)) {
        if (run[field as keyof typeof expected] !== value) {
          context.addIssue({
            code: "custom",
            message: `patch controller run ${field} must match the governed work item`,
            path: ["controller_run", field],
            input: run[field as keyof typeof expected],
          });
        }
      }
      if (paths.git_base_commit !== subject.reviewed_commit) {
        context.addIssue({
          code: "custom",
          message: "mission paths Git base must match the reviewed commit",
          path: ["paths", "git_base_commit"],
          input: paths.git_base_commit,
        });
      }
    },
  );

type MissionPackageWithoutHash =
  | Omit<ExecuteMissionPackage, "content_sha256">
  | Omit<ExecuteReviewMissionPackage, "content_sha256">
  | Omit<PatchReviewMissionPackage, "content_sha256">
  | Omit<PatchMissionPackage, "content_sha256">;

function canonicalCommandEvidence(
  records: ReviewCommandEvidenceRecord[],
): ReviewCommandEvidenceRecord[] {
  return records.map((record) => ({
    name: record.name,
    argv: record.argv,
    started_at: record.started_at,
    completed_at: record.completed_at,
    duration_ms: record.duration_ms,
    status: record.status,
    exit_code: record.exit_code,
    signal: record.signal,
    stdout: record.stdout,
    stderr: record.stderr,
    output_truncated: record.output_truncated,
  }));
}

function canonicalReviewSubject(subject: ReviewSubject): ReviewSubject {
  const common = {
    source: subject.source,
    git_base_commit: subject.git_base_commit,
    accepted_result_commit: subject.accepted_result_commit,
    changed_files: subject.changed_files,
    command_evidence: canonicalCommandEvidence(subject.command_evidence),
  };

  if (subject.source === "execute") {
    return {
      ...common,
      source: "execute",
      execute_mission_content_sha256: subject.execute_mission_content_sha256,
      execute_result_content_sha256: subject.execute_result_content_sha256,
      execute_mission_path: subject.execute_mission_path,
      execute_evidence_path: subject.execute_evidence_path,
    };
  }

  return {
    ...common,
    source: "patch",
    patch_cycle: subject.patch_cycle,
    patch_mission_content_sha256: subject.patch_mission_content_sha256,
    patch_result_content_sha256: subject.patch_result_content_sha256,
    patch_mission_path: subject.patch_mission_path,
    patch_evidence_path: subject.patch_evidence_path,
    resolved_from: {
      review_mission_content_sha256:
        subject.resolved_from.review_mission_content_sha256,
      review_result_content_sha256:
        subject.resolved_from.review_result_content_sha256,
      finding_ids: subject.resolved_from.finding_ids,
    },
  };
}

function canonicalPatchFindingLink(link: PatchFindingLink): PatchFindingLink {
  switch (link.type) {
    case "acceptance_criteria":
      return { type: link.type, criterion: link.criterion };
    case "non_goals":
      return { type: link.type, non_goal: link.non_goal };
    case "defect":
    case "security":
      return { type: link.type, evidence_summary: link.evidence_summary };
    case "deterministic_checks":
      return { type: link.type, command: link.command };
  }
}

function canonicalPatchSubject(subject: PatchSubject): PatchSubject {
  return {
    review_mission_content_sha256: subject.review_mission_content_sha256,
    review_result_content_sha256: subject.review_result_content_sha256,
    review_mission_path: subject.review_mission_path,
    review_result_path: subject.review_result_path,
    review_evidence_path: subject.review_evidence_path,
    reviewed_commit: subject.reviewed_commit,
    findings: subject.findings.map((finding) => ({
      finding_id: finding.finding_id,
      severity: finding.severity,
      title: finding.title,
      evidence: {
        ...(finding.evidence.path === undefined
          ? {}
          : { path: finding.evidence.path }),
        summary: finding.evidence.summary,
      },
      required_action: finding.required_action,
      link: canonicalPatchFindingLink(finding.link),
    })) as [PatchSubjectFinding, ...PatchSubjectFinding[]],
    prior_review_subject: canonicalReviewSubject(subject.prior_review_subject),
  };
}

function historicalMissionContentV3(mission: HistoricalMissionPackageV3) {
  const common = {
    mission_schema_version: mission.mission_schema_version,
    identity: {
      phase: mission.identity.phase,
      work_item_id: mission.identity.work_item_id,
      goal_version: mission.identity.goal_version,
      input_revision: mission.identity.input_revision,
      attempt: mission.identity.attempt,
    },
    controller_run: {
      run_id: mission.controller_run.run_id,
      idempotency_key: mission.controller_run.idempotency_key,
      phase: mission.controller_run.phase,
      started_at: mission.controller_run.started_at,
      completed_at: mission.controller_run.completed_at,
    },
    goal: {
      title: mission.goal.title,
      ...(mission.goal.type === undefined
        ? {}
        : { type: mission.goal.type }),
      purpose: mission.goal.purpose,
      acceptance_criteria: mission.goal.acceptance_criteria,
      non_goals: mission.goal.non_goals,
      allowed_scope: mission.goal.allowed_scope,
      review_ready: mission.goal.review_ready,
    },
    source_revision: {
      git_base_commit: mission.source_revision.git_base_commit,
    },
  };
  const resultContract = {
    schema_version: mission.result_contract.schema_version,
    output_path: mission.result_contract.output_path,
    result_schema_version: mission.result_contract.result_schema_version,
    required_fields: mission.result_contract.required_fields,
  };

  if ("review_subject" in mission) {
    const subject = mission.review_subject;
    return {
      ...common,
      review_subject: {
        execute_mission_content_sha256:
          subject.execute_mission_content_sha256,
        execute_result_content_sha256:
          subject.execute_result_content_sha256,
        git_base_commit: subject.git_base_commit,
        accepted_result_commit: subject.accepted_result_commit,
        changed_files: subject.changed_files,
        execute_mission_path: subject.execute_mission_path,
        execute_evidence_path: subject.execute_evidence_path,
        command_evidence: canonicalCommandEvidence(subject.command_evidence),
      },
      independence_attested: mission.independence_attested,
      result_contract: resultContract,
      task_path: mission.task_path,
    };
  }

  return {
    ...common,
    result_contract: resultContract,
    task_path: mission.task_path,
  };
}

export function hashHistoricalMissionContentV3(
  mission: HistoricalMissionPackageV3,
): string {
  return createHash("sha256")
    .update(JSON.stringify(historicalMissionContentV3(mission)))
    .digest("hex");
}

function serializeHistoricalMissionPackageV3(
  mission: HistoricalMissionPackageV3,
): string {
  return `${JSON.stringify(
    {
      ...historicalMissionContentV3(mission),
      content_sha256: mission.content_sha256,
    },
    null,
    2,
  )}\n`;
}

function missionContentWithoutCapability(
  mission:
    | MissionPackageWithoutHash
    | MissionPackage
    | HistoricalMissionPackageV6
    | HistoricalMissionPackageV5
    | HistoricalMissionPackageV4,
) {
  const common = {
    mission_schema_version: mission.mission_schema_version,
    identity: {
      phase: mission.identity.phase,
      work_item_id: mission.identity.work_item_id,
      goal_version: mission.identity.goal_version,
      input_revision: mission.identity.input_revision,
      attempt: mission.identity.attempt,
      ...(mission.identity.phase === "patch"
        ? { patch_cycle: mission.identity.patch_cycle }
        : {}),
    },
    controller_run: {
      run_id: mission.controller_run.run_id,
      idempotency_key: mission.controller_run.idempotency_key,
      phase: mission.controller_run.phase,
      started_at: mission.controller_run.started_at,
      completed_at: mission.controller_run.completed_at,
    },
    goal: {
      title: mission.goal.title,
      ...(mission.goal.type === undefined ? {} : { type: mission.goal.type }),
      purpose: mission.goal.purpose,
      acceptance_criteria: mission.goal.acceptance_criteria,
      non_goals: mission.goal.non_goals,
      allowed_scope: mission.goal.allowed_scope,
      review_ready: mission.goal.review_ready,
    },
    source_revision: {
      git_base_commit: mission.source_revision.git_base_commit,
    },
  };

  const resultContract = {
    schema_version: mission.result_contract.schema_version,
    output_path: mission.result_contract.output_path,
    result_schema_version: mission.result_contract.result_schema_version,
    required_fields: mission.result_contract.required_fields,
  };

  if ("patch_subject" in mission) {
    return {
      ...common,
      patch_subject: canonicalPatchSubject(mission.patch_subject),
      result_contract: resultContract,
      task_path: mission.task_path,
    };
  }

  if ("review_subject" in mission) {
    return {
      ...common,
      review_subject: canonicalReviewSubject(mission.review_subject),
      independence_attested: mission.independence_attested,
      result_contract: resultContract,
      task_path: mission.task_path,
    };
  }

  return {
    ...common,
    result_contract: resultContract,
    task_path: mission.task_path,
  };
}

function historicalMissionContentV6(mission: HistoricalMissionPackageV6) {
  return missionContentWithOptionalCapability(mission);
}

export function hashHistoricalMissionContentV6(
  mission: HistoricalMissionPackageV6,
): string {
  return createHash("sha256")
    .update(JSON.stringify(historicalMissionContentV6(mission)))
    .digest("hex");
}

function serializeHistoricalMissionPackageV6(
  mission: HistoricalMissionPackageV6,
): string {
  return `${JSON.stringify(
    {
      ...historicalMissionContentV6(mission),
      content_sha256: mission.content_sha256,
    },
    null,
    2,
  )}\n`;
}

function historicalMissionContentV5(mission: HistoricalMissionPackageV5) {
  return missionContentWithOptionalCapability(mission);
}

export function hashHistoricalMissionContentV5(
  mission: HistoricalMissionPackageV5,
): string {
  return createHash("sha256")
    .update(JSON.stringify(historicalMissionContentV5(mission)))
    .digest("hex");
}

function serializeHistoricalMissionPackageV5(
  mission: HistoricalMissionPackageV5,
): string {
  return `${JSON.stringify(
    {
      ...historicalMissionContentV5(mission),
      content_sha256: mission.content_sha256,
    },
    null,
    2,
  )}\n`;
}

function historicalMissionContentV4(mission: HistoricalMissionPackageV4) {
  return missionContentWithoutCapability(mission);
}

export function hashHistoricalMissionContentV4(
  mission: HistoricalMissionPackageV4,
): string {
  return createHash("sha256")
    .update(JSON.stringify(historicalMissionContentV4(mission)))
    .digest("hex");
}

function serializeHistoricalMissionPackageV4(
  mission: HistoricalMissionPackageV4,
): string {
  return `${JSON.stringify(
    {
      ...historicalMissionContentV4(mission),
      content_sha256: mission.content_sha256,
    },
    null,
    2,
  )}\n`;
}

function missionContentWithOptionalCapability(
  mission:
    | MissionPackageWithoutHash
    | MissionPackage
    | HistoricalMissionPackageV6
    | HistoricalMissionPackageV5,
) {
  const content = missionContentWithoutCapability(mission);
  if (!("capability_envelope" in mission)) {
    return content;
  }

  const { result_contract: resultContract, task_path: taskPath, ...common } =
    content;
  return {
    ...common,
    capability_envelope: resolveCapabilityEnvelope(
      mission.goal.allowed_scope,
      {
        schema_version: 1,
        approved_command_forms:
          mission.capability_envelope.runtime.approved_command_forms,
        approved_url_operations:
          mission.capability_envelope.runtime.approved_url_operations,
        mcp: mission.capability_envelope.runtime.mcp,
        credentials: mission.capability_envelope.runtime.credentials,
      },
    ),
    result_contract: resultContract,
    task_path: taskPath,
  };
}

function missionContent(
  mission: MissionPackageWithoutHash | MissionPackage,
) {
  return missionContentWithOptionalCapability(mission);
}

export function serializeMissionContent(
  mission: MissionPackageWithoutHash | MissionPackage,
): string {
  return JSON.stringify(missionContent(mission));
}

export function hashMissionContent(
  mission: MissionPackageWithoutHash | MissionPackage,
): string {
  return createHash("sha256")
    .update(serializeMissionContent(mission))
    .digest("hex");
}

export function serializeMissionPackage(mission: MissionPackage): string {
  const validatedMission = missionPackageSchema.parse(mission);
  return `${JSON.stringify(
    {
      ...missionContent(validatedMission),
      content_sha256: validatedMission.content_sha256,
    },
    null,
    2,
  )}\n`;
}

export function serializeReadableMissionPackage(
  mission: ReadableMissionPackage,
): string {
  const validatedMission = readableMissionPackageSchema.parse(mission);
  if (validatedMission.mission_schema_version === MISSION_SCHEMA_VERSION) {
    return serializeMissionPackage(validatedMission);
  }
  if (validatedMission.mission_schema_version === 6) {
    return serializeHistoricalMissionPackageV6(validatedMission);
  }
  if (validatedMission.mission_schema_version === 5) {
    return serializeHistoricalMissionPackageV5(validatedMission);
  }
  return validatedMission.mission_schema_version === 4
    ? serializeHistoricalMissionPackageV4(validatedMission)
    : serializeHistoricalMissionPackageV3(validatedMission);
}

function missionGoal(workItem: {
  goal: {
    title: string;
    type?: WorkItemType;
    goal_contract: {
      purpose: string;
      acceptance_criteria: string[];
      non_goals: string[];
      allowed_scope: string[];
      review_ready: string[];
    };
  };
}): MissionGoal {
  return {
    title: workItem.goal.title,
    ...(workItem.goal.type === undefined
      ? {}
      : { type: workItem.goal.type }),
    purpose: workItem.goal.goal_contract.purpose,
    acceptance_criteria: workItem.goal.goal_contract.acceptance_criteria,
    non_goals: workItem.goal.goal_contract.non_goals,
    allowed_scope: workItem.goal.goal_contract.allowed_scope,
    review_ready: workItem.goal.goal_contract.review_ready,
  };
}

export function compileMission(
  workItem: WorkItem,
  executeManifest: ControllerRunManifest,
  paths: MissionPaths,
  executionDefaults?: ExecutionDefaultsV1,
): ExecuteMissionPackage {
  const missionControllerManifest = {
    schema_version: executeManifest.schema_version,
    run_id: executeManifest.run_id,
    work_item_id: executeManifest.work_item_id,
    idempotency_key: executeManifest.idempotency_key,
    phase: executeManifest.phase,
    goal_version: executeManifest.goal_version,
    input_revision: executeManifest.input_revision,
    attempt: executeManifest.attempt,
    started_at: executeManifest.started_at,
    completed_at: executeManifest.completed_at,
    outcome: executeManifest.outcome,
  };
  const input = missionCompileInputSchema.parse({
    work_item: workItem,
    execute_manifest: missionControllerManifest,
    paths,
    execution_defaults:
      executionDefaults ??
      executeManifest.capability_grant?.execution_defaults ??
      executeManifest.capability_carry_forward?.execution_defaults ??
      FAIL_CLOSED_EXECUTION_DEFAULTS,
  });
  const content: Omit<ExecuteMissionPackage, "content_sha256"> = {
    mission_schema_version: MISSION_SCHEMA_VERSION,
    identity: {
      phase: "execute",
      work_item_id: input.work_item.goal.work_item_id,
      goal_version: input.work_item.goal.goal_contract.goal_version,
      input_revision: input.work_item.state.input_revision,
      attempt: input.work_item.state.attempt,
    },
    controller_run: {
      run_id: input.execute_manifest.run_id,
      idempotency_key: input.execute_manifest.idempotency_key,
      phase: input.execute_manifest.phase,
      started_at: input.execute_manifest.started_at,
      completed_at: input.execute_manifest.completed_at,
    },
    goal: missionGoal(input.work_item),
    source_revision: {
      git_base_commit: input.paths.git_base_commit,
    },
    capability_envelope: resolveCapabilityEnvelope(
      input.work_item.goal.goal_contract.allowed_scope,
      input.execution_defaults,
    ),
    result_contract: {
      schema_version: RESULT_CONTRACT_SCHEMA_VERSION,
      output_path: input.paths.output_path,
      result_schema_version: RESULT_SCHEMA_VERSION,
      required_fields: [...EXECUTE_RESULT_REQUIRED_FIELDS],
    },
    task_path: input.paths.task_path,
  };

  return executeMissionPackageSchema.parse({
    ...content,
    content_sha256: hashMissionContent(content),
  });
}

export function compileReviewMission(
  input: ReviewMissionCompileInput & { review_subject: ExecuteReviewSubject },
): ExecuteReviewMissionPackage;
export function compileReviewMission(
  input: ReviewMissionCompileInput & { review_subject: PatchReviewSubject },
): PatchReviewMissionPackage;
export function compileReviewMission(
  input: ReviewMissionCompileInput,
): ReviewMissionPackage {
  const validated = reviewMissionCompileInputSchema.parse(input);
  const common = {
    mission_schema_version: MISSION_SCHEMA_VERSION,
    identity: {
      phase: "review",
      work_item_id: validated.work_item.goal.work_item_id,
      goal_version: validated.work_item.goal.goal_contract.goal_version,
      input_revision: validated.work_item.state.input_revision,
      attempt: validated.work_item.state.attempt,
    },
    controller_run: {
      run_id: validated.controller_run.run_id,
      idempotency_key: validated.controller_run.idempotency_key,
      phase: validated.controller_run.phase,
      started_at: validated.controller_run.started_at,
      completed_at: validated.controller_run.completed_at,
    },
    goal: missionGoal(validated.work_item),
    source_revision: {
      git_base_commit: validated.paths.git_base_commit,
    },
    review_subject: validated.review_subject,
    independence_attested: validated.independence_attested,
    task_path: validated.paths.task_path,
  } as const;

  if (validated.review_subject.source === "execute") {
    const content: Omit<ExecuteReviewMissionPackage, "content_sha256"> = {
      ...common,
      review_subject: validated.review_subject,
      result_contract: {
        schema_version: RESULT_CONTRACT_SCHEMA_VERSION,
        output_path: validated.paths.output_path,
        result_schema_version: RESULT_SCHEMA_VERSION,
        required_fields: [...REVIEW_RESULT_REQUIRED_FIELDS],
      },
    };

    return executeReviewMissionPackageSchema.parse({
      ...content,
      content_sha256: hashMissionContent(content),
    });
  }

  const content: Omit<PatchReviewMissionPackage, "content_sha256"> = {
    ...common,
    review_subject: validated.review_subject,
    result_contract: {
      schema_version: RESULT_CONTRACT_SCHEMA_VERSION,
      output_path: validated.paths.output_path,
      result_schema_version: RESULT_SCHEMA_VERSION,
      required_fields: [...PATCH_REVIEW_RESULT_REQUIRED_FIELDS],
    },
  };

  return patchReviewMissionPackageSchema.parse({
    ...content,
    content_sha256: hashMissionContent(content),
  });
}

export function compilePatchMission(
  input: PatchMissionCompileInput,
  executionDefaults: ExecutionDefaultsV1 = FAIL_CLOSED_EXECUTION_DEFAULTS,
): PatchMissionPackage {
  const validated = patchMissionCompileInputSchema.parse({
    ...input,
    execution_defaults: executionDefaults,
  });
  const content: Omit<PatchMissionPackage, "content_sha256"> = {
    mission_schema_version: MISSION_SCHEMA_VERSION,
    identity: {
      phase: "patch",
      work_item_id: validated.work_item.goal.work_item_id,
      goal_version: validated.work_item.goal.goal_contract.goal_version,
      input_revision: validated.work_item.state.input_revision,
      attempt: validated.work_item.state.attempt,
      patch_cycle: validated.work_item.state.patch_cycle,
    },
    controller_run: {
      run_id: validated.controller_run.run_id,
      idempotency_key: validated.controller_run.idempotency_key,
      phase: validated.controller_run.phase,
      started_at: validated.controller_run.started_at,
      completed_at: validated.controller_run.completed_at,
    },
    goal: missionGoal(validated.work_item),
    source_revision: {
      git_base_commit: validated.paths.git_base_commit,
    },
    capability_envelope: resolveCapabilityEnvelope(
      validated.work_item.goal.goal_contract.allowed_scope,
      validated.execution_defaults,
    ),
    patch_subject: validated.patch_subject,
    result_contract: {
      schema_version: RESULT_CONTRACT_SCHEMA_VERSION,
      output_path: validated.paths.output_path,
      result_schema_version: RESULT_SCHEMA_VERSION,
      required_fields: [...PATCH_RESULT_REQUIRED_FIELDS],
    },
    task_path: validated.paths.task_path,
  };

  return patchMissionPackageSchema.parse({
    ...content,
    content_sha256: hashMissionContent(content),
  });
}

function renderList(values: string[]): string {
  return values.map((value) => `- ${value}`).join("\n");
}

function renderMissionHeader(mission: ReadableMissionPackage): string[] {
  const typeLine =
    mission.goal.type === undefined ? [] : [`Type: ${mission.goal.type}`, ""];
  return [
    `# ${mission.goal.title}`,
    "",
    `Mission schema version: ${mission.mission_schema_version}`,
    `Mission phase: ${mission.identity.phase}`,
    `Package hash: ${mission.content_sha256}`,
    "",
    ...typeLine,
    "## Purpose",
    "",
    mission.goal.purpose,
    "",
    "## Acceptance criteria",
    "",
    renderList(mission.goal.acceptance_criteria),
    "",
    "## Non-goals",
    "",
    renderList(mission.goal.non_goals),
    "",
    "## Allowed scope",
    "",
    renderList(mission.goal.allowed_scope),
    "",
    "## Review ready when",
    "",
    renderList(mission.goal.review_ready),
    "",
  ];
}

type ReadableExecuteMissionPackage =
  | ExecuteMissionPackage
  | HistoricalExecuteMissionPackageV6
  | HistoricalExecuteMissionPackageV5
  | HistoricalExecuteMissionPackageV4
  | HistoricalExecuteMissionPackageV3;

type ReadablePatchMissionPackage =
  | PatchMissionPackage
  | HistoricalPatchMissionPackageV6
  | HistoricalPatchMissionPackageV5
  | HistoricalPatchMissionPackageV4;

type ReadableCapabilityMissionPackage =
  | ReadableExecuteMissionPackage
  | ReadablePatchMissionPackage;

function renderCapabilityEnvelope(
  mission: ReadableCapabilityMissionPackage,
  includeExactArrayGuidance = true,
): string[] {
  if (!("capability_envelope" in mission)) {
    return [];
  }
  const commandForms = mission.capability_envelope.runtime.approved_command_forms
    .map((form) => JSON.stringify([form.executable, ...form.args]));
  const urlOperations =
    mission.capability_envelope.runtime.approved_url_operations.map(
      (operation) =>
        `${operation.method} ${operation.protocol}://${operation.host}${operation.path}`,
    );
  return [
    "## Capability envelope",
    "",
    `Execution mode: ${mission.capability_envelope.workspace.execution_mode}`,
    `Scope assurance: ${mission.capability_envelope.workspace.scope_assurance}`,
    `Allowed-scope digest: \`${mission.capability_envelope.workspace.allowed_scope_digest}\``,
    `Runtime containment: ${mission.capability_envelope.runtime.containment_assurance}`,
    `Machine authority: ${mission.capability_envelope.runtime.machine_authority}`,
    `MCP: ${mission.capability_envelope.runtime.mcp}`,
    `Credentials: ${mission.capability_envelope.runtime.credentials}`,
    "",
    "Approved command forms:",
    renderList(commandForms.length === 0 ? ["None"] : commandForms),
    ...(includeExactArrayGuidance
      ? [
          "Approved command arrays are exact. Do not add arguments, message paragraphs, attribution trailers, or metadata.",
          "Every command must be a single line built only from plain words and quoted words. Newlines, control characters, pipes, redirection, chaining, and substitution cannot be interpreted: the runtime refuses such a request outright and the run ends without a result. Keep commit messages to one line.",
        ]
      : []),
    "",
    "Approved URL operations:",
    renderList(urlOperations.length === 0 ? ["None"] : urlOperations),
    "",
  ];
}

function renderExecuteTaskMd(
  mission: ReadableExecuteMissionPackage,
  includeExactArrayGuidance = true,
): string {
  return [
    ...renderMissionHeader(mission),
    ...renderCapabilityEnvelope(mission, includeExactArrayGuidance),
    "## Result contract",
    "",
    `Write the structured result to \`${mission.result_contract.output_path}\`.`,
    "Commit the code changes before returning the result.",
    "Use this complete JSON shape:",
    "",
    "```json",
    "{",
    `  \"result_schema_version\": ${mission.result_contract.result_schema_version},`,
    `  \"mission_content_sha256\": \"${mission.content_sha256}\",`,
    "  \"identity\": {",
    '    "phase": "execute",',
    `    \"work_item_id\": \"${mission.identity.work_item_id}\",`,
    `    \"goal_version\": ${mission.identity.goal_version},`,
    `    \"input_revision\": ${mission.identity.input_revision},`,
    `    \"attempt\": ${mission.identity.attempt}`,
    "  },",
    "  \"commit\": \"<full 40-character Git commit SHA>\",",
    "  \"summary\": \"<concise implementation summary>\",",
    "  \"changed_files\": [\"<workspace-relative POSIX path>\"],",
    "  \"verification\": [",
    "    { \"name\": \"<check name>\", \"status\": \"passed\", \"detail\": \"<optional detail>\" }",
    "  ]",
    "}",
    "```",
    "",
    "Each reported verification status must be passed, failed, or not_run.",
    "Reported verification is context only. The controller validates the commit and runs the authoritative checks.",
    "",
    "## Next gate",
    "",
    "Return the result for validation; do not advance controller state.",
    "",
  ].join("\n");
}

function renderReviewTaskMd(mission: ReviewMissionPackage): string {
  const subject = mission.review_subject;
  const subjectLines =
    subject.source === "execute"
      ? [
          `Execute mission hash: \`${subject.execute_mission_content_sha256}\``,
          `Execute result hash: \`${subject.execute_result_content_sha256}\``,
          `Immutable mission: \`${subject.execute_mission_path}\``,
          `Immutable evidence: \`${subject.execute_evidence_path}\``,
        ]
      : [
          `Patch mission hash: \`${subject.patch_mission_content_sha256}\``,
          `Patch result hash: \`${subject.patch_result_content_sha256}\``,
          `Immutable patch mission: \`${subject.patch_mission_path}\``,
          `Immutable patch evidence: \`${subject.patch_evidence_path}\``,
          `Resolved-from review mission hash: \`${subject.resolved_from.review_mission_content_sha256}\``,
          `Resolved-from review result hash: \`${subject.resolved_from.review_result_content_sha256}\``,
        ];
  const bindingLines =
    subject.source === "execute"
      ? [
          `  \"execute_mission_content_sha256\": \"${subject.execute_mission_content_sha256}\",`,
          `  \"execute_result_content_sha256\": \"${subject.execute_result_content_sha256}\",`,
        ]
      : [
          `  \"patch_mission_content_sha256\": \"${subject.patch_mission_content_sha256}\",`,
          `  \"patch_result_content_sha256\": \"${subject.patch_result_content_sha256}\",`,
        ];
  const resolutionLines =
    subject.source === "patch"
      ? [
          "  \"resolutions\": [",
          ...subject.resolved_from.finding_ids.map(
            (findingId, index) =>
              `    { \"finding_id\": \"${findingId}\", \"status\": \"resolved | unresolved\" }${index === subject.resolved_from.finding_ids.length - 1 ? "" : ","}`,
          ),
          "  ]",
        ]
      : [];
  return [
    ...renderMissionHeader(mission),
    "## Review assignment",
    "",
    "Assess the exact pinned implementation as a read-only reviewer.",
    "Do not modify workspace files or execute verification commands.",
    "",
    `Pinned subject commit: \`${subject.accepted_result_commit}\``,
    `Git base: \`${subject.git_base_commit}\``,
    ...subjectLines,
    "",
    "Changed files:",
    renderList(subject.changed_files),
    "",
    "Authoritative verification:",
    renderList(
      subject.command_evidence.map(
        (record) =>
          `${record.name}: ${record.status} (${record.argv.join(" ")})`,
      ),
    ),
    "",
    "## Review result contract",
    "",
    `Write the structured review to \`${mission.result_contract.output_path}\`.`,
    "Use this complete JSON shape:",
    "",
    "```json",
    "{",
    `  \"result_schema_version\": ${mission.result_contract.result_schema_version},`,
    `  \"review_mission_content_sha256\": \"${mission.content_sha256}\",`,
    "  \"identity\": {",
    '    "phase": "review",',
    `    \"work_item_id\": \"${mission.identity.work_item_id}\",`,
    `    \"goal_version\": ${mission.identity.goal_version},`,
    `    \"input_revision\": ${mission.identity.input_revision},`,
    `    \"attempt\": ${mission.identity.attempt}`,
    "  },",
    ...bindingLines,
    `  \"git_base_commit\": \"${subject.git_base_commit}\",`,
    `  \"accepted_result_commit\": \"${subject.accepted_result_commit}\",`,
    "  \"summary\": \"<concise review summary>\",",
    "  \"verdict\": \"clean | findings\",",
    "  \"findings\": [",
    "    {",
    "      \"finding_id\": \"<unique id>\",",
    "      \"severity\": \"P0 | P1 | P2 | P3\",",
    "      \"title\": \"<finding title>\",",
    "      \"evidence\": { \"summary\": \"<concrete evidence>\" },",
    "      \"required_action\": \"<required correction>\",",
    '      "link": {',
    '        "type": "defect",',
    '        "evidence_summary": "<concrete defect evidence>"',
    "      }",
    "    }",
    `  ]${resolutionLines.length === 0 ? "" : ","}`,
    ...resolutionLines,
    "}",
    "```",
    "",
    "Return the review for immutable import; do not advance controller state.",
    "",
  ].join("\n");
}

function renderPatchTaskMd(
  mission: ReadablePatchMissionPackage,
  includeExactArrayGuidance = true,
): string {
  const subject = mission.patch_subject;
  const findings = subject.findings.flatMap((finding) => [
    `- ${finding.finding_id} (${finding.severity}): ${finding.title}`,
    `  Required action: ${finding.required_action}`,
  ]);

  return [
    ...renderMissionHeader(mission),
    ...renderCapabilityEnvelope(mission, includeExactArrayGuidance),
    "## Patch assignment",
    "",
    "Apply one bounded repair that addresses every finding listed below.",
    "Modify only files within the existing allowed scope.",
    "Do not advance controller state or declare any finding resolved.",
    "",
    `Reviewed commit: \`${subject.reviewed_commit}\``,
    `Review mission hash: \`${subject.review_mission_content_sha256}\``,
    `Review result hash: \`${subject.review_result_content_sha256}\``,
    `Immutable review mission: \`${subject.review_mission_path}\``,
    `Immutable review result: \`${subject.review_result_path}\``,
    `Immutable review evidence: \`${subject.review_evidence_path}\``,
    "",
    "Blocking findings:",
    ...findings,
    "",
    "## Patch result contract",
    "",
    `Write the structured patch result to \`${mission.result_contract.output_path}\`.`,
    "Commit the code changes before returning the result.",
    "Use this complete JSON shape:",
    "",
    "```json",
    "{",
    `  \"result_schema_version\": ${mission.result_contract.result_schema_version},`,
    `  \"patch_mission_content_sha256\": \"${mission.content_sha256}\",`,
    "  \"identity\": {",
    "    \"phase\": \"patch\",",
    `    \"work_item_id\": \"${mission.identity.work_item_id}\",`,
    `    \"goal_version\": ${mission.identity.goal_version},`,
    `    \"input_revision\": ${mission.identity.input_revision},`,
    `    \"attempt\": ${mission.identity.attempt},`,
    `    \"patch_cycle\": ${mission.identity.patch_cycle}`,
    "  },",
    "  \"commit\": \"<full 40-character Git commit SHA>\",",
    "  \"summary\": \"<concise repair summary>\",",
    "  \"changed_files\": [\"<workspace-relative POSIX path>\"],",
    "  \"verification\": [",
    "    { \"name\": \"<check name>\", \"status\": \"passed\", \"detail\": \"<optional detail>\" }",
    "  ]",
    "}",
    "```",
    "",
    "Reported verification is context only. The controller validates the commit and runs the authoritative checks.",
    "Return the patch result for validation; do not advance controller state or self-declare findings resolved.",
    "",
  ].join("\n");
}

export function renderTaskMd(mission: MissionPackage): string {
  const validatedMission = missionPackageSchema.parse(mission);
  if ("patch_subject" in validatedMission) {
    return renderPatchTaskMd(validatedMission);
  }
  return "review_subject" in validatedMission
    ? renderReviewTaskMd(validatedMission)
    : renderExecuteTaskMd(validatedMission);
}

export function renderReadableTaskMd(
  mission: ReadableMissionPackage,
): string {
  const validatedMission = readableMissionPackageSchema.parse(mission);
  if (validatedMission.mission_schema_version === MISSION_SCHEMA_VERSION) {
    return renderTaskMd(validatedMission);
  }
  if (validatedMission.mission_schema_version === 6) {
    if ("patch_subject" in validatedMission) {
      return renderPatchTaskMd(validatedMission, false);
    }
    return "review_subject" in validatedMission
      ? renderReviewTaskMd(
          validatedMission as unknown as ReviewMissionPackage,
        )
      : renderExecuteTaskMd(validatedMission, false);
  }
  if (validatedMission.mission_schema_version === 5) {
    if ("patch_subject" in validatedMission) {
      return renderPatchTaskMd(validatedMission, false);
    }
    return "review_subject" in validatedMission
      ? renderReviewTaskMd(
          validatedMission as unknown as ReviewMissionPackage,
        )
      : renderExecuteTaskMd(validatedMission, false);
  }
  if (validatedMission.mission_schema_version === 4) {
    if ("patch_subject" in validatedMission) {
      return renderPatchTaskMd(validatedMission, false);
    }
    return "review_subject" in validatedMission
      ? renderReviewTaskMd(
          validatedMission as unknown as ReviewMissionPackage,
        )
      : renderExecuteTaskMd(validatedMission, false);
  }
  if ("review_subject" in validatedMission) {
    return renderReviewTaskMd({
      ...validatedMission,
      review_subject: {
        source: "execute",
        ...validatedMission.review_subject,
      },
    } as unknown as ExecuteReviewMissionPackage);
  }
  return renderExecuteTaskMd(validatedMission, false);
}
