import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  ControllerRunManifest,
  WorkItem,
  WorkItemType,
} from "./work-item";
import { workspaceRelativePosixPathSchema } from "./workspace-path";

const MISSION_SCHEMA_VERSION = 3 as const;
const RESULT_CONTRACT_SCHEMA_VERSION = 3 as const;
const RESULT_SCHEMA_VERSION = 2 as const;
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

export const MISSION_PHASES = ["execute", "review"] as const;
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

export interface MissionIdentity<
  TPhase extends MissionPhase = MissionPhase,
> {
  phase: TPhase;
  work_item_id: string;
  goal_version: number;
  input_revision: number;
  attempt: number;
}

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
  schema_version: 3;
  output_path: string;
  result_schema_version: 2;
  required_fields: TRequiredFields;
}

interface MissionPackageBase<TPhase extends MissionPhase> {
  mission_schema_version: 3;
  identity: MissionIdentity<TPhase>;
  controller_run: MissionControllerRun<TPhase>;
  goal: MissionGoal;
  source_revision: MissionSourceRevision;
  task_path: string;
  content_sha256: string;
}

export interface ExecuteMissionPackage extends MissionPackageBase<"execute"> {
  result_contract: MissionResultContract<
    typeof EXECUTE_RESULT_REQUIRED_FIELDS
  >;
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

export interface ReviewSubject {
  execute_mission_content_sha256: string;
  execute_result_content_sha256: string;
  git_base_commit: string;
  accepted_result_commit: string;
  changed_files: string[];
  execute_mission_path: string;
  execute_evidence_path: string;
  command_evidence: ReviewCommandEvidenceRecord[];
}

export interface ReviewMissionPackage extends MissionPackageBase<"review"> {
  review_subject: ReviewSubject;
  independence_attested: true;
  result_contract: MissionResultContract<
    typeof REVIEW_RESULT_REQUIRED_FIELDS
  >;
}

export type MissionPackage = ExecuteMissionPackage | ReviewMissionPackage;

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

export interface MissionPaths {
  task_path: string;
  output_path: string;
  git_base_commit: string;
}

export interface MissionArtifactWriteResult<
  TMission extends MissionPackage = MissionPackage,
> {
  mission: TMission;
  workspace_path: string;
  task_path: string;
  mission_path: string;
}

export type MissionPackageBuilder<
  TMission extends MissionPackage = MissionPackage,
> = (paths: MissionPaths) => TMission;

export const missionIdentitySchema: z.ZodType<MissionIdentity> = z.strictObject({
  phase: z.enum(MISSION_PHASES),
  work_item_id: workItemIdSchema,
  goal_version: positiveSafeIntegerSchema,
  input_revision: positiveSafeIntegerSchema,
  attempt: nonNegativeSafeIntegerSchema,
});

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

export const reviewSubjectSchema: z.ZodType<ReviewSubject> = z
  .strictObject({
    execute_mission_content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    execute_result_content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    git_base_commit: z.string().regex(/^[0-9a-f]{40}$/),
    accepted_result_commit: z.string().regex(/^[0-9a-f]{40}$/),
    changed_files: z.array(workspaceRelativePosixPathSchema),
    execute_mission_path: workspaceRelativePosixPathSchema,
    execute_evidence_path: workspaceRelativePosixPathSchema,
    command_evidence: z.array(reviewCommandEvidenceRecordSchema).min(1),
  })
  .superRefine((subject, context) => {
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

const missionPackageCommonShape = {
  mission_schema_version: z.literal(MISSION_SCHEMA_VERSION),
  goal: missionGoalSchema,
  source_revision: missionSourceRevisionSchema,
  task_path: workspaceRelativePosixPathSchema,
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
};

const executeMissionPackageSchema: z.ZodType<ExecuteMissionPackage> =
  z.strictObject({
    ...missionPackageCommonShape,
    identity: executeMissionIdentitySchema,
    controller_run: z.strictObject({
      run_id: z.uuid(),
      idempotency_key: nonEmptyTrimmedStringSchema,
      phase: z.literal("execute"),
      started_at: z.iso.datetime(),
      completed_at: z.iso.datetime(),
    }),
    result_contract: executeResultContractSchema,
  });

const reviewMissionPackageSchema: z.ZodType<ReviewMissionPackage> =
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
      review_subject: reviewSubjectSchema,
      independence_attested: z.literal(true),
      result_contract: reviewResultContractSchema,
    })
    .superRefine((mission, context) => {
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

export const missionPackageSchema: z.ZodType<MissionPackage> = z
  .union([executeMissionPackageSchema, reviewMissionPackageSchema])
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
    schema_version: z.literal(1),
    work_item_id: workItemIdSchema,
    phase: z.literal("execute"),
    status: z.literal("active"),
    updated_at: z.iso.datetime(),
    goal_version: positiveSafeIntegerSchema,
    input_revision: positiveSafeIntegerSchema,
    attempt: nonNegativeSafeIntegerSchema,
  }),
});

const compilableReviewWorkItemSchema = z.object({
  goal: compilableWorkItemGoalSchema,
  state: z.object({
    schema_version: z.literal(1),
    work_item_id: workItemIdSchema,
    phase: z.literal("review"),
    status: z.literal("active"),
    updated_at: z.iso.datetime(),
    goal_version: positiveSafeIntegerSchema,
    input_revision: positiveSafeIntegerSchema,
    attempt: nonNegativeSafeIntegerSchema,
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

type MissionPackageWithoutHash =
  | Omit<ExecuteMissionPackage, "content_sha256">
  | Omit<ReviewMissionPackage, "content_sha256">;

function canonicalReviewSubject(subject: ReviewSubject): ReviewSubject {
  return {
    execute_mission_content_sha256: subject.execute_mission_content_sha256,
    execute_result_content_sha256: subject.execute_result_content_sha256,
    git_base_commit: subject.git_base_commit,
    accepted_result_commit: subject.accepted_result_commit,
    changed_files: subject.changed_files,
    execute_mission_path: subject.execute_mission_path,
    execute_evidence_path: subject.execute_evidence_path,
    command_evidence: subject.command_evidence.map((record) => ({
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
    })),
  };
}

function missionContent(
  mission: MissionPackageWithoutHash | MissionPackage,
) {
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
): ExecuteMissionPackage {
  const input = missionCompileInputSchema.parse({
    work_item: workItem,
    execute_manifest: executeManifest,
    paths,
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
  input: ReviewMissionCompileInput,
): ReviewMissionPackage {
  const validated = reviewMissionCompileInputSchema.parse(input);
  const content: Omit<ReviewMissionPackage, "content_sha256"> = {
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
    result_contract: {
      schema_version: RESULT_CONTRACT_SCHEMA_VERSION,
      output_path: validated.paths.output_path,
      result_schema_version: RESULT_SCHEMA_VERSION,
      required_fields: [...REVIEW_RESULT_REQUIRED_FIELDS],
    },
    task_path: validated.paths.task_path,
  };

  return reviewMissionPackageSchema.parse({
    ...content,
    content_sha256: hashMissionContent(content),
  });
}

function renderList(values: string[]): string {
  return values.map((value) => `- ${value}`).join("\n");
}

function renderMissionHeader(mission: MissionPackage): string[] {
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

function renderExecuteTaskMd(mission: ExecuteMissionPackage): string {
  return [
    ...renderMissionHeader(mission),
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
  return [
    ...renderMissionHeader(mission),
    "## Review assignment",
    "",
    "Assess the exact pinned implementation as a read-only reviewer.",
    "Do not modify workspace files or execute verification commands.",
    "",
    `Pinned subject commit: \`${subject.accepted_result_commit}\``,
    `Git base: \`${subject.git_base_commit}\``,
    `Execute mission hash: \`${subject.execute_mission_content_sha256}\``,
    `Execute result hash: \`${subject.execute_result_content_sha256}\``,
    `Immutable mission: \`${subject.execute_mission_path}\``,
    `Immutable evidence: \`${subject.execute_evidence_path}\``,
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
    `  \"execute_mission_content_sha256\": \"${subject.execute_mission_content_sha256}\",`,
    `  \"execute_result_content_sha256\": \"${subject.execute_result_content_sha256}\",`,
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
    "      \"link\": { \"type\": \"defect\" }",
    "    }",
    "  ]",
    "}",
    "```",
    "",
    "Return the review for immutable import; do not advance controller state.",
    "",
  ].join("\n");
}

export function renderTaskMd(mission: MissionPackage): string {
  const validatedMission = missionPackageSchema.parse(mission);
  return "review_subject" in validatedMission
    ? renderReviewTaskMd(validatedMission)
    : renderExecuteTaskMd(validatedMission);
}
