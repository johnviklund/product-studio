import { createHash } from "node:crypto";

import { z } from "zod";

import {
  type ExecuteReviewSubject,
  type ExecuteMissionPackage,
  type MissionIdentity,
  type MissionPackage,
  type PatchReviewSubject,
  type ReadableMissionPackage,
  type ReviewSubject,
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

export interface PatchExternalResultSubmission {
  result_schema_version: 2;
  patch_mission_content_sha256: string;
  identity: MissionIdentity<"patch">;
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

interface ReviewExternalResultSubmissionBase {
  result_schema_version: 2;
  review_mission_content_sha256: string;
  identity: MissionIdentity<"review">;
  git_base_commit: string;
  accepted_result_commit: string;
  summary: string;
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
}

export interface ExecuteReviewExternalResultSubmission
  extends ReviewExternalResultSubmissionBase {
  execute_mission_content_sha256: string;
  execute_result_content_sha256: string;
}

export const REVIEW_FINDING_RESOLUTION_STATUSES = [
  "resolved",
  "unresolved",
] as const;
export type ReviewFindingResolutionStatus =
  (typeof REVIEW_FINDING_RESOLUTION_STATUSES)[number];

export interface ReviewFindingResolution {
  finding_id: string;
  status: ReviewFindingResolutionStatus;
}

export interface PatchReviewExternalResultSubmission
  extends ReviewExternalResultSubmissionBase {
  patch_mission_content_sha256: string;
  patch_result_content_sha256: string;
  resolutions: [ReviewFindingResolution, ...ReviewFindingResolution[]];
}

export type ReviewExternalResultSubmission =
  | ExecuteReviewExternalResultSubmission
  | PatchReviewExternalResultSubmission;

export type ExternalResultSubmission =
  | ExecuteExternalResultSubmission
  | PatchExternalResultSubmission
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

export interface PatchImportEvidenceEnvelope
  extends ImportEvidenceEnvelopeBase<"patch"> {
  outcome: "rejected" | "applied";
  result_commit: string;
}

export type ImportEvidenceEnvelope =
  | ExecuteImportEvidenceEnvelope
  | ReviewImportEvidenceEnvelope
  | PatchImportEvidenceEnvelope;

export interface ImportEvidenceSummary {
  phase: MissionIdentity["phase"];
  import_run_id: string;
  outcome: ImportEvidenceOutcome;
  evidence_path: string;
  reasons: string[];
}

export interface MissionResultSnapshot {
  mission: ReadableMissionPackage;
  mission_path: string;
  result_path: string;
  result_source: string;
}

export interface ActiveMissionResultSnapshot extends MissionResultSnapshot {
  mission: MissionPackage;
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

export interface AppliedPatchReviewSubject {
  review_subject: PatchReviewSubject;
  submission_source: string;
  evidence: PatchImportEvidenceEnvelope;
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

const patchMissionIdentitySchema: z.ZodType<MissionIdentity<"patch">> =
  z.strictObject({
    phase: z.literal("patch"),
    work_item_id: workItemIdSchema,
    goal_version: z.number().int().positive().safe(),
    input_revision: z.number().int().positive().safe(),
    attempt: nonNegativeSafeIntegerSchema,
    patch_cycle: z.number().int().positive().safe(),
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

export const patchExternalResultSubmissionSchema: z.ZodType<PatchExternalResultSubmission> =
  z.strictObject({
    result_schema_version: z.literal(2),
    patch_mission_content_sha256: sha256Schema,
    identity: patchMissionIdentitySchema,
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

const reviewExternalResultCommonShape = {
  result_schema_version: z.literal(2),
  review_mission_content_sha256: sha256Schema,
  identity: reviewMissionIdentitySchema,
  git_base_commit: gitCommitSchema,
  accepted_result_commit: gitCommitSchema,
  summary: nonEmptyTrimmedStringSchema,
  verdict: z.enum(REVIEW_VERDICTS),
  findings: z.array(reviewFindingSchema),
};

function validateReviewResultInvariants(
  result: ReviewExternalResultSubmissionBase,
  context: z.RefinementCtx,
): void {
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
}

export const executeReviewExternalResultSubmissionSchema: z.ZodType<ExecuteReviewExternalResultSubmission> =
  z
    .strictObject({
      ...reviewExternalResultCommonShape,
      execute_mission_content_sha256: sha256Schema,
      execute_result_content_sha256: sha256Schema,
    })
    .superRefine(validateReviewResultInvariants);

const reviewFindingResolutionSchema: z.ZodType<ReviewFindingResolution> =
  z.strictObject({
    finding_id: nonEmptyTrimmedStringSchema,
    status: z.enum(REVIEW_FINDING_RESOLUTION_STATUSES),
  });

const reviewFindingResolutionListSchema: z.ZodType<
  [ReviewFindingResolution, ...ReviewFindingResolution[]]
> = z
  .tuple([reviewFindingResolutionSchema], reviewFindingResolutionSchema)
  .superRefine((resolutions, context) => {
    const findingIds = resolutions.map((resolution) => resolution.finding_id);
    if (new Set(findingIds).size !== findingIds.length) {
      context.addIssue({
        code: "custom",
        message: "resolution finding_id values must be unique",
        input: resolutions,
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
        message: "resolutions must use canonical finding_id order",
        input: resolutions,
      });
    }
  });

export const patchReviewExternalResultSubmissionSchema: z.ZodType<PatchReviewExternalResultSubmission> =
  z
    .strictObject({
      ...reviewExternalResultCommonShape,
      patch_mission_content_sha256: sha256Schema,
      patch_result_content_sha256: sha256Schema,
      resolutions: reviewFindingResolutionListSchema,
    })
    .superRefine((result, context) => {
      validateReviewResultInvariants(result, context);
      const currentFindingIds = new Set(
        result.findings.map((finding) => finding.finding_id),
      );
      for (const [index, resolution] of result.resolutions.entries()) {
        if (
          resolution.status === "unresolved" &&
          !currentFindingIds.has(resolution.finding_id)
        ) {
          context.addIssue({
            code: "custom",
            message:
              "unresolved resolution requires a matching current finding",
            path: ["resolutions", index, "finding_id"],
            input: resolution.finding_id,
          });
        }
      }
    });

export const reviewExternalResultSubmissionSchema: z.ZodType<ReviewExternalResultSubmission> =
  z.union([
    executeReviewExternalResultSubmissionSchema,
    patchReviewExternalResultSubmissionSchema,
  ]);

export function reviewExternalResultSubmissionForSubjectSchema(
  subject: ReviewSubject,
): z.ZodType<ReviewExternalResultSubmission> {
  return reviewExternalResultSubmissionSchema.superRefine(
    (result, context) => {
      if (subject.source === "execute") {
        if (!("execute_mission_content_sha256" in result)) {
          context.addIssue({
            code: "custom",
            message: "execute review subjects require an execute-bound result",
            input: result,
          });
          return;
        }
        const bindings = {
          execute_mission_content_sha256:
            subject.execute_mission_content_sha256,
          execute_result_content_sha256:
            subject.execute_result_content_sha256,
          git_base_commit: subject.git_base_commit,
          accepted_result_commit: subject.accepted_result_commit,
        };
        for (const [field, expected] of Object.entries(bindings)) {
          if (result[field as keyof typeof bindings] !== expected) {
            context.addIssue({
              code: "custom",
              message: `${field} must match the execute review subject`,
              path: [field],
              input: result[field as keyof typeof bindings],
            });
          }
        }
        return;
      }

      if (!("resolutions" in result)) {
        context.addIssue({
          code: "custom",
          message: "patch review subjects require a patch-bound result",
          input: result,
        });
        return;
      }

      const bindings = {
        patch_mission_content_sha256:
          subject.patch_mission_content_sha256,
        patch_result_content_sha256: subject.patch_result_content_sha256,
        git_base_commit: subject.git_base_commit,
        accepted_result_commit: subject.accepted_result_commit,
      };
      for (const [field, expected] of Object.entries(bindings)) {
        if (result[field as keyof typeof bindings] !== expected) {
          context.addIssue({
            code: "custom",
            message: `${field} must match the patch review subject`,
            path: [field],
            input: result[field as keyof typeof bindings],
          });
        }
      }

      const expectedFindingIds = subject.resolved_from.finding_ids;
      const resolutionFindingIds = result.resolutions.map(
        (resolution) => resolution.finding_id,
      );
      if (
        expectedFindingIds.length !== resolutionFindingIds.length ||
        expectedFindingIds.some(
          (findingId, index) => findingId !== resolutionFindingIds[index],
        )
      ) {
        context.addIssue({
          code: "custom",
          message:
            "resolutions must cover every patch-subject finding_id exactly once in canonical order",
          path: ["resolutions"],
          input: result.resolutions,
        });
      }
    },
  );
}

export const externalResultSubmissionSchema: z.ZodType<ExternalResultSubmission> =
  z.union([
    executeExternalResultSubmissionSchema,
    patchExternalResultSubmissionSchema,
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

const patchImportEvidenceEnvelopeSchema = z.strictObject({
  ...importEvidenceEnvelopeBaseShape,
  phase: z.literal("patch"),
  identity: patchMissionIdentitySchema,
  outcome: z.enum(["rejected", "applied"]),
  result_commit: gitCommitSchema,
});

export const importEvidenceEnvelopeSchema: z.ZodType<ImportEvidenceEnvelope> =
  z
    .discriminatedUnion("phase", [
      executeImportEvidenceEnvelopeSchema,
      reviewImportEvidenceEnvelopeSchema,
      patchImportEvidenceEnvelopeSchema,
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
    phase: z.enum(["execute", "review", "patch"]),
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
    ...(identity.phase === "patch"
      ? { patch_cycle: identity.patch_cycle }
      : {}),
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

function canonicalFindings(findings: ReviewFinding[]) {
  return findings.map((finding) => ({
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
  }));
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

  if ("commit" in result) {
    return {
      result_schema_version: result.result_schema_version,
      patch_mission_content_sha256: result.patch_mission_content_sha256,
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

  const common = {
    result_schema_version: result.result_schema_version,
    review_mission_content_sha256: result.review_mission_content_sha256,
    identity: canonicalIdentity(result.identity),
  };

  if ("execute_mission_content_sha256" in result) {
    return {
      ...common,
      execute_mission_content_sha256: result.execute_mission_content_sha256,
      execute_result_content_sha256: result.execute_result_content_sha256,
      git_base_commit: result.git_base_commit,
      accepted_result_commit: result.accepted_result_commit,
      summary: result.summary,
      verdict: result.verdict,
      findings: canonicalFindings(result.findings),
    };
  }

  return {
    ...common,
    patch_mission_content_sha256: result.patch_mission_content_sha256,
    patch_result_content_sha256: result.patch_result_content_sha256,
    git_base_commit: result.git_base_commit,
    accepted_result_commit: result.accepted_result_commit,
    summary: result.summary,
    verdict: result.verdict,
    findings: canonicalFindings(result.findings),
    resolutions: result.resolutions.map((resolution) => ({
      finding_id: resolution.finding_id,
      status: resolution.status,
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
