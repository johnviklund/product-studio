import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  ControllerRunManifest,
  WorkItem,
  WorkItemType,
} from "./work-item";

const MISSION_SCHEMA_VERSION = 1 as const;
const RESULT_CONTRACT_SCHEMA_VERSION = 1 as const;
const RESULT_REQUIRED_FIELDS = [
  "summary",
  "changed_files",
  "verification",
] as const;

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
const nonEmptyStringListSchema = z
  .array(nonEmptyTrimmedStringSchema)
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

function isSafeWorkspaceRelativePosixPath(value: string): boolean {
  return (
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value
      .split("/")
      .every(
        (segment) => segment !== "" && segment !== "." && segment !== "..",
      )
  );
}

const workspaceRelativePosixPathSchema = z
  .string()
  .refine(
    isSafeWorkspaceRelativePosixPath,
    "must be a safe workspace-relative POSIX path",
  );

export interface MissionIdentity {
  work_item_id: string;
  goal_version: number;
  input_revision: number;
  attempt: number;
}

export interface MissionPackage {
  mission_schema_version: 1;
  identity: MissionIdentity;
  controller_run: {
    run_id: string;
    idempotency_key: string;
    phase: "execute";
    started_at: string;
    completed_at: string;
  };
  goal: {
    title: string;
    type?: WorkItemType;
    acceptance_criteria: string[];
    allowed_scope: string[];
    review_ready: string[];
  };
  result_contract: {
    schema_version: 1;
    output_path: string;
    required_fields: ["summary", "changed_files", "verification"];
  };
  task_path: string;
  content_sha256: string;
}

export interface MissionPaths {
  task_path: string;
  output_path: string;
}

export interface MissionArtifactWriteResult {
  mission: MissionPackage;
  workspace_path: string;
  task_path: string;
  mission_path: string;
}

export type MissionPackageBuilder = (paths: MissionPaths) => MissionPackage;

export const missionIdentitySchema: z.ZodType<MissionIdentity> = z.strictObject({
  work_item_id: workItemIdSchema,
  goal_version: positiveSafeIntegerSchema,
  input_revision: positiveSafeIntegerSchema,
  attempt: nonNegativeSafeIntegerSchema,
});

const missionPackageBaseSchema = z.strictObject({
  mission_schema_version: z.literal(MISSION_SCHEMA_VERSION),
  identity: missionIdentitySchema,
  controller_run: z.strictObject({
    run_id: z.uuid(),
    idempotency_key: nonEmptyTrimmedStringSchema,
    phase: z.literal("execute"),
    started_at: z.iso.datetime(),
    completed_at: z.iso.datetime(),
  }),
  goal: z.strictObject({
    title: nonEmptyTrimmedStringSchema,
    type: z.enum(missionWorkItemTypes).optional(),
    acceptance_criteria: nonEmptyStringListSchema,
    allowed_scope: nonEmptyStringListSchema,
    review_ready: nonEmptyStringListSchema,
  }),
  result_contract: z.strictObject({
    schema_version: z.literal(RESULT_CONTRACT_SCHEMA_VERSION),
    output_path: workspaceRelativePosixPathSchema,
    required_fields: z.tuple([
      z.literal(RESULT_REQUIRED_FIELDS[0]),
      z.literal(RESULT_REQUIRED_FIELDS[1]),
      z.literal(RESULT_REQUIRED_FIELDS[2]),
    ]),
  }),
  task_path: workspaceRelativePosixPathSchema,
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const missionPackageSchema: z.ZodType<MissionPackage> =
  missionPackageBaseSchema.superRefine((mission, context) => {
    if (mission.content_sha256 !== hashMissionContent(mission)) {
      context.addIssue({
        code: "custom",
        message: "content_sha256 must match the canonical mission content",
        path: ["content_sha256"],
        input: mission.content_sha256,
      });
    }
  });

const compilableWorkItemSchema = z.object({
  goal: z.object({
    schema_version: z.literal(1),
    work_item_id: workItemIdSchema,
    title: nonEmptyTrimmedStringSchema,
    type: z.enum(missionWorkItemTypes).optional(),
    goal_version: positiveSafeIntegerSchema,
    acceptance_criteria: nonEmptyStringListSchema,
    allowed_scope: nonEmptyStringListSchema,
    review_ready: nonEmptyStringListSchema,
  }),
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

const missionPathsSchema = z
  .strictObject({
    task_path: workspaceRelativePosixPathSchema,
    output_path: workspaceRelativePosixPathSchema,
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
    work_item: compilableWorkItemSchema,
    execute_manifest: appliedExecuteManifestSchema,
    paths: missionPathsSchema,
  })
  .superRefine(({ work_item: workItem, execute_manifest: manifest }, context) => {
    const expected = {
      work_item_id: workItem.goal.work_item_id,
      goal_version: workItem.goal.goal_version,
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

function missionContent(
  mission: Omit<MissionPackage, "content_sha256"> | MissionPackage,
) {
  return {
    mission_schema_version: mission.mission_schema_version,
    identity: {
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
      acceptance_criteria: mission.goal.acceptance_criteria,
      allowed_scope: mission.goal.allowed_scope,
      review_ready: mission.goal.review_ready,
    },
    result_contract: {
      schema_version: mission.result_contract.schema_version,
      output_path: mission.result_contract.output_path,
      required_fields: mission.result_contract.required_fields,
    },
    task_path: mission.task_path,
  };
}

export function serializeMissionContent(
  mission: Omit<MissionPackage, "content_sha256"> | MissionPackage,
): string {
  return JSON.stringify(missionContent(mission));
}

export function hashMissionContent(
  mission: Omit<MissionPackage, "content_sha256"> | MissionPackage,
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

export function compileMission(
  workItem: WorkItem,
  executeManifest: ControllerRunManifest,
  paths: MissionPaths,
): MissionPackage {
  const input = missionCompileInputSchema.parse({
    work_item: workItem,
    execute_manifest: executeManifest,
    paths,
  });
  const content: Omit<MissionPackage, "content_sha256"> = {
    mission_schema_version: MISSION_SCHEMA_VERSION,
    identity: {
      work_item_id: input.work_item.goal.work_item_id,
      goal_version: input.work_item.goal.goal_version,
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
    goal: {
      title: input.work_item.goal.title,
      ...(input.work_item.goal.type === undefined
        ? {}
        : { type: input.work_item.goal.type }),
      acceptance_criteria: input.work_item.goal.acceptance_criteria,
      allowed_scope: input.work_item.goal.allowed_scope,
      review_ready: input.work_item.goal.review_ready,
    },
    result_contract: {
      schema_version: RESULT_CONTRACT_SCHEMA_VERSION,
      output_path: input.paths.output_path,
      required_fields: [...RESULT_REQUIRED_FIELDS],
    },
    task_path: input.paths.task_path,
  };

  return missionPackageSchema.parse({
    ...content,
    content_sha256: hashMissionContent(content),
  });
}

function renderList(values: string[]): string {
  return values.map((value) => `- ${value}`).join("\n");
}

export function renderTaskMd(mission: MissionPackage): string {
  const validatedMission = missionPackageSchema.parse(mission);
  const typeLine =
    validatedMission.goal.type === undefined
      ? []
      : [`Type: ${validatedMission.goal.type}`, ""];

  return [
    `# ${validatedMission.goal.title}`,
    "",
    `Mission schema version: ${validatedMission.mission_schema_version}`,
    `Package hash: ${validatedMission.content_sha256}`,
    "",
    ...typeLine,
    "## Acceptance criteria",
    "",
    renderList(validatedMission.goal.acceptance_criteria),
    "",
    "## Allowed scope",
    "",
    renderList(validatedMission.goal.allowed_scope),
    "",
    "## Review ready when",
    "",
    renderList(validatedMission.goal.review_ready),
    "",
    "## Result contract",
    "",
    `Write the structured result to \`${validatedMission.result_contract.output_path}\`.`,
    `Include these fields: ${validatedMission.result_contract.required_fields.join(", ")}.`,
    "",
    "## Next gate",
    "",
    "Return the result for validation; do not advance controller state.",
    "",
  ].join("\n");
}
