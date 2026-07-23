import { createHash } from "node:crypto";

import { z } from "zod";

import {
  missionIdentitySchema,
  type MissionIdentity,
} from "./mission";
import { workspaceRelativePosixPathSchema } from "./workspace-path";

export const REPORTED_VERIFICATION_STATUSES = [
  "passed",
  "failed",
  "not_run",
] as const;

export const COMMAND_EVIDENCE_STATUSES = [
  "passed",
  "failed",
  "timed_out",
  "spawn_error",
  "not_run",
] as const;

export const IMPORT_EVIDENCE_OUTCOMES = [
  "rejected",
  "failed",
  "applied",
] as const;

export type ReportedVerificationStatus =
  (typeof REPORTED_VERIFICATION_STATUSES)[number];
export type CommandEvidenceStatus =
  (typeof COMMAND_EVIDENCE_STATUSES)[number];
export type ImportEvidenceOutcome =
  (typeof IMPORT_EVIDENCE_OUTCOMES)[number];

export interface ReportedVerification {
  name: string;
  status: ReportedVerificationStatus;
  detail?: string;
}

export interface ExternalResultSubmission {
  result_schema_version: 1;
  mission_content_sha256: string;
  identity: MissionIdentity;
  commit: string;
  summary: string;
  changed_files: string[];
  verification: ReportedVerification[];
}

export interface CommandEvidenceRecord {
  name: string;
  argv: [string, ...string[]];
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number;
  status: CommandEvidenceStatus;
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  output_truncated: boolean;
}

export interface ImportEvidenceEnvelope {
  schema_version: 1;
  import_run_id: string;
  result_content_sha256: string;
  mission_content_sha256: string;
  identity: MissionIdentity;
  git_base_commit: string;
  result_commit: string | null;
  controller_run_id: string;
  started_at: string;
  completed_at: string;
  outcome: ImportEvidenceOutcome;
  reasons: string[];
}

export interface ImportEvidenceSummary {
  import_run_id: string;
  outcome: ImportEvidenceOutcome;
  evidence_path: string;
  reasons: string[];
}

const nonEmptyTrimmedStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be empty")
  .refine(
    (value) => value === value.trim(),
    "must not have leading or trailing whitespace",
  );
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const gitCommitSchema = z.string().regex(/^[0-9a-f]{40}$/);
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();

export const reportedVerificationSchema: z.ZodType<ReportedVerification> =
  z.strictObject({
    name: nonEmptyTrimmedStringSchema,
    status: z.enum(REPORTED_VERIFICATION_STATUSES),
    detail: nonEmptyTrimmedStringSchema.optional(),
  });

export const externalResultSubmissionSchema: z.ZodType<ExternalResultSubmission> =
  z.strictObject({
    result_schema_version: z.literal(1),
    mission_content_sha256: sha256Schema,
    identity: missionIdentitySchema,
    commit: gitCommitSchema,
    summary: nonEmptyTrimmedStringSchema,
    changed_files: z
      .array(workspaceRelativePosixPathSchema)
      .refine(
        (paths) => new Set(paths).size === paths.length,
        "changed_files must not contain duplicates",
      ),
    verification: z
      .array(reportedVerificationSchema)
      .refine(
        (records) =>
          new Set(records.map((record) => record.name.toLocaleLowerCase()))
            .size === records.length,
        "verification names must not contain case-insensitive duplicates",
      ),
  });

export const commandEvidenceRecordSchema: z.ZodType<CommandEvidenceRecord> =
  z
    .strictObject({
      name: nonEmptyTrimmedStringSchema,
      argv: z.tuple([nonEmptyTrimmedStringSchema], z.string()),
      started_at: z.iso.datetime().nullable(),
      completed_at: z.iso.datetime().nullable(),
      duration_ms: nonNegativeSafeIntegerSchema,
      status: z.enum(COMMAND_EVIDENCE_STATUSES),
      exit_code: z.number().int().nullable(),
      signal: z.string().nullable(),
      stdout: z.string(),
      stderr: z.string(),
      output_truncated: z.boolean(),
    })
    .superRefine((record, context) => {
      const notRun = record.status === "not_run";
      if (notRun && (record.started_at !== null || record.completed_at !== null)) {
        context.addIssue({
          code: "custom",
          message: "not_run evidence must not have timestamps",
          path: ["started_at"],
          input: record,
        });
      }
      if (!notRun && (record.started_at === null || record.completed_at === null)) {
        context.addIssue({
          code: "custom",
          message: "executed command evidence requires timestamps",
          path: [record.started_at === null ? "started_at" : "completed_at"],
          input: record,
        });
      }
      if (
        notRun &&
        (record.duration_ms !== 0 ||
          record.exit_code !== null ||
          record.signal !== null ||
          record.stdout !== "" ||
          record.stderr !== "" ||
          record.output_truncated)
      ) {
        context.addIssue({
          code: "custom",
          message: "not_run evidence must use the empty result shape",
          path: ["status"],
          input: record,
        });
      }
    });

export const importEvidenceEnvelopeSchema: z.ZodType<ImportEvidenceEnvelope> =
  z
    .strictObject({
      schema_version: z.literal(1),
      import_run_id: sha256Schema,
      result_content_sha256: sha256Schema,
      mission_content_sha256: sha256Schema,
      identity: missionIdentitySchema,
      git_base_commit: gitCommitSchema,
      result_commit: gitCommitSchema.nullable(),
      controller_run_id: z.uuid(),
      started_at: z.iso.datetime(),
      completed_at: z.iso.datetime(),
      outcome: z.enum(IMPORT_EVIDENCE_OUTCOMES),
      reasons: z.array(nonEmptyTrimmedStringSchema),
    })
    .superRefine((evidence, context) => {
      if (evidence.outcome !== "applied" && evidence.reasons.length === 0) {
        context.addIssue({
          code: "custom",
          message: "rejected or failed evidence requires at least one reason",
          path: ["reasons"],
          input: evidence.reasons,
        });
      }
      if (evidence.outcome === "applied" && evidence.reasons.length > 0) {
        context.addIssue({
          code: "custom",
          message: "applied evidence must not contain rejection reasons",
          path: ["reasons"],
          input: evidence.reasons,
        });
      }
      if (evidence.outcome !== "rejected" && evidence.result_commit === null) {
        context.addIssue({
          code: "custom",
          message: "failed or applied evidence requires a result commit",
          path: ["result_commit"],
          input: evidence.result_commit,
        });
      }
    });

export const importEvidenceSummarySchema: z.ZodType<ImportEvidenceSummary> =
  z.strictObject({
    import_run_id: sha256Schema,
    outcome: z.enum(IMPORT_EVIDENCE_OUTCOMES),
    evidence_path: workspaceRelativePosixPathSchema,
    reasons: z.array(nonEmptyTrimmedStringSchema),
  });

function canonicalResultContent(result: ExternalResultSubmission) {
  return {
    result_schema_version: result.result_schema_version,
    mission_content_sha256: result.mission_content_sha256,
    identity: {
      work_item_id: result.identity.work_item_id,
      goal_version: result.identity.goal_version,
      input_revision: result.identity.input_revision,
      attempt: result.identity.attempt,
    },
    commit: result.commit,
    summary: result.summary,
    changed_files: result.changed_files,
    verification: result.verification.map((record) => ({
      name: record.name,
      status: record.status,
      ...(record.detail === undefined ? {} : { detail: record.detail }),
    })),
  };
}

export function serializeExternalResult(
  result: ExternalResultSubmission,
): string {
  const validated = externalResultSubmissionSchema.parse(result);
  return `${JSON.stringify(canonicalResultContent(validated), null, 2)}\n`;
}

export function hashResultContent(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function hashExternalResult(result: ExternalResultSubmission): string {
  return hashResultContent(serializeExternalResult(result));
}

export function createImportRunId(
  missionContentSha256: string,
  resultContentSha256: string,
): string {
  const missionHash = sha256Schema.parse(missionContentSha256);
  const resultHash = sha256Schema.parse(resultContentSha256);
  return hashResultContent(`${missionHash}:${resultHash}`);
}
