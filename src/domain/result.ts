import { createHash } from "node:crypto";

import { z } from "zod";

import {
  type ExecuteReviewSubject,
  type ExecuteMissionPackage,
  type MissionIdentity,
  type MissionPackage,
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

export const REVIEW_VERDICTS = ["clean", "findings"] as const;
export const REVIEW_FINDING_SEVERITIES = [
  "P0",
  "P1",
  "P2",
  "P3",
] as const;

export type ReportedVerificationStatus =
  (typeof REPORTED_VERIFICATION_STATUSES)[number];
export type CommandEvidenceStatus =
  (typeof COMMAND_EVIDENCE_STATUSES)[number];
export type ImportEvidenceOutcome =
  (typeof IMPORT_EVIDENCE_OUTCOMES)[number];
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export type ReviewFindingSeverity =
  (typeof REVIEW_FINDING_SEVERITIES)[number];

export interface ReportedVerification {
  name: string;
  status: ReportedVerificationStatus;
  detail?: string;
}

export interface ExecuteExternalResultSubmission {
  result_schema_version: 2;
  mission_content_sha256: string;
  identity: MissionIdentity<"execute">;
  commit: string;
  summary: string;
  changed_files: string[];
  verification: ReportedVerification[];
}

export type ReviewFindingLink =
  | { type: "acceptance_criteria"; criterion: string }
  | { type: "non_goals"; non_goal: string }
  | { type: "defect"; evidence_summary: string }
  | { type: "security"; evidence_summary: string }
  | { type: "deterministic_checks"; command: string };

export interface ReviewFinding {
  finding_id: string;
  severity: ReviewFindingSeverity;
  title: string;
  evidence: {
    path?: string;
    summary: string;
  };
  required_action: string;
  link: ReviewFindingLink;
}

export interface ReviewExternalResultSubmission {
  result_schema_version: 2;
  review_mission_content_sha256: string;
  identity: MissionIdentity<"review">;
  execute_mission_content_sha256: string;
  execute_result_content_sha256: string;
  git_base_commit: string;
  accepted_result_commit: string;
  summary: string;
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
}

export type ExternalResultSubmission =
  | ExecuteExternalResultSubmission
  | ReviewExternalResultSubmission;

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

interface ImportEvidenceEnvelopeBase<TPhase extends MissionIdentity["phase"]> {
  schema_version: 2;
  phase: TPhase;
  import_run_id: string;
  result_content_sha256: string;
  mission_content_sha256: string;
  identity: MissionIdentity<TPhase>;
  git_base_commit: string;
  controller_run_id: string;
  started_at: string;
  completed_at: string;
  outcome: ImportEvidenceOutcome;
  reasons: string[];
}

export interface ExecuteImportEvidenceEnvelope
  extends ImportEvidenceEnvelopeBase<"execute"> {
  result_commit: string | null;
}

export interface ReviewImportEvidenceEnvelope
  extends ImportEvidenceEnvelopeBase<"review"> {
  outcome: "rejected" | "applied";
  result_commit: string;
}

export type ImportEvidenceEnvelope =
  | ExecuteImportEvidenceEnvelope
  | ReviewImportEvidenceEnvelope;

export interface ImportEvidenceSummary {
  phase: MissionIdentity["phase"];
  import_run_id: string;
  outcome: ImportEvidenceOutcome;
  evidence_path: string;
  reasons: string[];
}

export interface MissionResultSnapshot {
  mission: MissionPackage;
  mission_path: string;
  result_path: string;
  result_source: string;
}

export interface ExecuteMissionResultSnapshot extends MissionResultSnapshot {
  mission: ExecuteMissionPackage;
}

export interface ImportEvidenceWriteInput {
  submission_source: string;
  evidence: ImportEvidenceEnvelope;
  verification: CommandEvidenceRecord[];
}

export interface StoredImportEvidence {
  evidence: ImportEvidenceEnvelope;
  summary: ImportEvidenceSummary;
  verification: CommandEvidenceRecord[];
  submission?: ExternalResultSubmission;
}

export interface AppliedExecuteReviewSubject {
  review_subject: ExecuteReviewSubject;
  submission_source: string;
  evidence: ExecuteImportEvidenceEnvelope;
  verification: CommandEvidenceRecord[];
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
const workItemIdSchema = z
  .string()
  .regex(
    /^wi_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );

export const importRunIdSchema = sha256Schema;

const executeMissionIdentitySchema: z.ZodType<MissionIdentity<"execute">> =
  z.strictObject({
    phase: z.literal("execute"),
    work_item_id: workItemIdSchema,
    goal_version: z.number().int().positive().safe(),
    input_revision: z.number().int().positive().safe(),
    attempt: nonNegativeSafeIntegerSchema,
  });

const reviewMissionIdentitySchema: z.ZodType<MissionIdentity<"review">> =
  z.strictObject({
    phase: z.literal("review"),
    work_item_id: workItemIdSchema,
    goal_version: z.number().int().positive().safe(),
    input_revision: z.number().int().positive().safe(),
    attempt: nonNegativeSafeIntegerSchema,
  });

export const reportedVerificationSchema: z.ZodType<ReportedVerification> =
  z.strictObject({
    name: nonEmptyTrimmedStringSchema,
    status: z.enum(REPORTED_VERIFICATION_STATUSES),
    detail: nonEmptyTrimmedStringSchema.optional(),
  });

export const executeExternalResultSubmissionSchema: z.ZodType<ExecuteExternalResultSubmission> =
  z.strictObject({
    result_schema_version: z.literal(2),
    mission_content_sha256: sha256Schema,
    identity: executeMissionIdentitySchema,
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

export const reviewFindingLinkSchema: z.ZodType<ReviewFindingLink> =
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

export const reviewFindingSchema: z.ZodType<ReviewFinding> = z.strictObject({
  finding_id: nonEmptyTrimmedStringSchema,
  severity: z.enum(REVIEW_FINDING_SEVERITIES),
  title: nonEmptyTrimmedStringSchema,
  evidence: z.strictObject({
    path: workspaceRelativePosixPathSchema.optional(),
    summary: nonEmptyTrimmedStringSchema,
  }),
  required_action: nonEmptyTrimmedStringSchema,
  link: reviewFindingLinkSchema,
});

export const reviewExternalResultSubmissionSchema: z.ZodType<ReviewExternalResultSubmission> =
  z
    .strictObject({
      result_schema_version: z.literal(2),
      review_mission_content_sha256: sha256Schema,
      identity: reviewMissionIdentitySchema,
      execute_mission_content_sha256: sha256Schema,
      execute_result_content_sha256: sha256Schema,
      git_base_commit: gitCommitSchema,
      accepted_result_commit: gitCommitSchema,
      summary: nonEmptyTrimmedStringSchema,
      verdict: z.enum(REVIEW_VERDICTS),
      findings: z.array(reviewFindingSchema),
    })
    .superRefine((result, context) => {
      if (
        new Set(result.findings.map((finding) => finding.finding_id)).size !==
        result.findings.length
      ) {
        context.addIssue({
          code: "custom",
          message: "finding_id values must be unique",
          path: ["findings"],
          input: result.findings,
        });
      }
      if (result.verdict === "clean" && result.findings.length !== 0) {
        context.addIssue({
          code: "custom",
          message: "clean review results must not contain findings",
          path: ["findings"],
          input: result.findings,
        });
      }
      if (result.verdict === "findings" && result.findings.length === 0) {
        context.addIssue({
          code: "custom",
          message: "findings review results require at least one finding",
          path: ["findings"],
          input: result.findings,
        });
      }
    });

export const externalResultSubmissionSchema: z.ZodType<ExternalResultSubmission> =
  z.union([
    executeExternalResultSubmissionSchema,
    reviewExternalResultSubmissionSchema,
  ]);

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

const importEvidenceEnvelopeBaseShape = {
  schema_version: z.literal(2),
  import_run_id: sha256Schema,
  result_content_sha256: sha256Schema,
  mission_content_sha256: sha256Schema,
  git_base_commit: gitCommitSchema,
  controller_run_id: z.uuid(),
  started_at: z.iso.datetime(),
  completed_at: z.iso.datetime(),
  outcome: z.enum(IMPORT_EVIDENCE_OUTCOMES),
  reasons: z.array(nonEmptyTrimmedStringSchema),
};

const executeImportEvidenceEnvelopeSchema = z.strictObject({
  ...importEvidenceEnvelopeBaseShape,
  phase: z.literal("execute"),
  identity: executeMissionIdentitySchema,
  result_commit: gitCommitSchema.nullable(),
});

const reviewImportEvidenceEnvelopeSchema = z.strictObject({
  ...importEvidenceEnvelopeBaseShape,
  phase: z.literal("review"),
  identity: reviewMissionIdentitySchema,
  outcome: z.enum(["rejected", "applied"]),
  result_commit: gitCommitSchema,
});

export const importEvidenceEnvelopeSchema: z.ZodType<ImportEvidenceEnvelope> =
  z
    .discriminatedUnion("phase", [
      executeImportEvidenceEnvelopeSchema,
      reviewImportEvidenceEnvelopeSchema,
    ])
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
      if (
        evidence.phase === "execute" &&
        evidence.outcome !== "rejected" &&
        evidence.result_commit === null
      ) {
        context.addIssue({
          code: "custom",
          message: "failed or applied execute evidence requires a result commit",
          path: ["result_commit"],
          input: evidence.result_commit,
        });
      }
    });

export const importEvidenceSummarySchema: z.ZodType<ImportEvidenceSummary> =
  z.strictObject({
    phase: z.enum(["execute", "review"]),
    import_run_id: sha256Schema,
    outcome: z.enum(IMPORT_EVIDENCE_OUTCOMES),
    evidence_path: workspaceRelativePosixPathSchema,
    reasons: z.array(nonEmptyTrimmedStringSchema),
  });

function canonicalIdentity(identity: MissionIdentity) {
  return {
    phase: identity.phase,
    work_item_id: identity.work_item_id,
    goal_version: identity.goal_version,
    input_revision: identity.input_revision,
    attempt: identity.attempt,
  };
}

function canonicalFindingLink(link: ReviewFindingLink) {
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

function canonicalResultContent(result: ExternalResultSubmission) {
  if ("mission_content_sha256" in result) {
    return {
      result_schema_version: result.result_schema_version,
      mission_content_sha256: result.mission_content_sha256,
      identity: canonicalIdentity(result.identity),
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

  return {
    result_schema_version: result.result_schema_version,
    review_mission_content_sha256: result.review_mission_content_sha256,
    identity: canonicalIdentity(result.identity),
    execute_mission_content_sha256: result.execute_mission_content_sha256,
    execute_result_content_sha256: result.execute_result_content_sha256,
    git_base_commit: result.git_base_commit,
    accepted_result_commit: result.accepted_result_commit,
    summary: result.summary,
    verdict: result.verdict,
    findings: result.findings.map((finding) => ({
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
      link: canonicalFindingLink(finding.link),
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
