import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  linkSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual, promisify, TextDecoder } from "node:util";

import { parse, stringify } from "yaml";
import { z, type ZodType } from "zod";

import {
  ControllerConflictError,
  InvalidWorkspaceError,
  activeRunSchema,
  controllerRunIdSchema,
  controllerRunManifestSchema,
  createCaptureInputSchema,
  createWorkItemInputSchema,
  deriveControllerRunId,
  derivePlanApprovalId,
  parseWorkItemStateForRead,
  planApprovalIntentSchema,
  planApprovalManifestSchema,
  productManifestSchema,
  verificationCommandSchema,
  workItemGoalSchema,
  workItemIdSchema,
  workItemSchema,
  workItemStateSchema,
  updateWorkItemPhaseInputSchema,
  type CreateWorkItemInput,
  type CreateCaptureInput,
  type ActiveRun,
  type ControllerLease,
  type ControllerMutationInput,
  type ControllerMutationResult,
  type ControllerRunManifest,
  type PlanApprovalCommitInput,
  type PlanApprovalCommitResult,
  type PlanApprovalIntentCaptureInput,
  type PlanApprovalIntentV1,
  type PlanApprovalIntentWriteResult,
  type PlanApprovalManifestV1,
  type ProductManifest,
  type WorkItem,
  type WorkItemGoal,
  type ReviewWorkItemRepository,
  type RetainedControllerLeaseRepairResult,
  type ShapingDecisionCommitInput,
  type ShapingDecisionCommitResult,
  type ShapingDecisionIntentCaptureInput,
  type ShapingDecisionIntentWriteResult,
  type WorkItemState,
  type UpdateWorkItemPhaseInput,
  type VerificationCommand,
} from "../domain/work-item";
import {
  executeReviewSubjectSchema,
  missionIdentitySchema,
  missionPackageSchema,
  patchSubjectSchema,
  readableMissionPackageSchema,
  renderReadableTaskMd,
  renderTaskMd,
  reviewSubjectSchema,
  missionScopeBaseCommit,
  serializeReadableMissionPackage,
  serializeMissionPackage,
  type MissionArtifactWriteResult,
  type MissionIdentity,
  type MissionPackage,
  type MissionPackageBuilder,
  type MissionPaths,
  type PatchMissionPackage,
  type PatchSubject,
  type ReadableMissionPackage,
  type ReviewMissionPackage,
  type ReviewSubject,
} from "../domain/mission";
import {
  commandEvidenceRecordSchema,
  connectedReviewResultRecoveryInputSchema,
  connectedReviewResultRecoveryReceiptV1Schema,
  expectedImportRunId,
  executeExternalResultSubmissionSchema,
  externalResultSubmissionSchema,
  hashResultContent,
  importEvidenceEnvelopeSchema,
  importEvidenceSummarySchema,
  importRunIdSchema,
  type AppliedExecuteReviewSubject,
  type AppliedPatchReviewSubject,
  type CommandEvidenceRecord,
  type ConnectedReviewResultRecoveryInput,
  type ConnectedReviewResultRecoveryReceiptV1,
  type ExecuteImportEvidenceEnvelope,
  type ImportEvidenceSummary,
  type ImportEvidenceWriteInput,
  type MissionResultSnapshot,
  type PatchImportEvidenceEnvelope,
  type StoredImportEvidence,
  patchExternalResultSubmissionSchema,
} from "../domain/result";
import type {
  GitVerificationAdapter,
  VerificationRunner,
} from "../domain/verification";
import {
  executionDefaultsV1Schema,
  type ExecutionDefaultsV1,
} from "../domain/capability-envelope";
import { workspaceRelativePosixPathSchema } from "../domain/workspace-path";
import {
  connectedRunLaunchFingerprint,
  connectedRunProcessIdentitySchema,
  connectedRunRecordV2Schema,
  connectedRunTerminalSchema,
  effectiveModelIdentitySchema,
  type ConnectedRunProtocolIdentity,
  type ConnectedRunTerminal,
  type ConnectedRunProcessIdentity,
  type ConnectedRunRecordV2,
  type EffectiveModelIdentity,
} from "../domain/connected-run";
import {
  brainstormResultSubmissionSchema,
  deriveShapingDecisionId,
  hashGoalContract,
  hashShapingIngressInstruction,
  hashShapingInput,
  normalizeShapingGoalInput,
  planResultSubmissionSchema,
  planApprovalReceiptSchema,
  renderShapingTaskMd,
  serializeShapingPackage,
  shapingAppliedMarkerSchema,
  shapingDecisionReceiptSchema,
  shapingDecisionIntentSchema,
  shapingDecisionManifestSchema,
  shapingIdentitySchema,
  shapingImportReceiptSchema,
  shapingIngressInstructionSchema,
  shapingMissionPackageSchema,
  SHAPING_INGRESS_MAX_BYTES,
  SHAPING_PHASES,
  specMissionPackageSchema,
  specResultSubmissionSchema,
  type ShapingArtifactReadResult,
  type ShapingAppliedMarkerV1,
  type ShapingArtifactWriteResult,
  type ShapingDecisionReceipt,
  type ShapingDecisionIntentV1,
  type ShapingDecisionManifestV1,
  type ShapingIdentity,
  type ShapingImportReceipt,
  type ShapingImportReceiptWriteInput,
  type ShapingIngressInstructionV1,
  type ShapingMissionPackage,
  type ShapingMissionPackageBuilder,
  type ShapingPaths,
  type ShapingReceiptWriteResult,
  type ShapingResultSnapshot,
  type ShapingResultSubmission,
  type ShapingPhase,
  type PlanApprovalReceipt,
  type SpecMissionPackage,
  type StoredShapingArtifact,
} from "../domain/shaping";
import {
  deriveManualShapingProductionId,
  shapingRunLaunchFingerprint,
  shapingRunRecordV1Schema,
  shapingProductionReceiptSchema,
  type ConnectedShapingProductionReceipt,
  type ShapingRunRecordV1,
  type ShapingProductionReceipt,
} from "../domain/shaping-run";
import {
  canonicalSerializeSemanticEvent,
  canonicalSerializeSemanticEventIntent,
  deriveSemanticEventId,
  deriveSemanticIntentId,
  semanticEventIntentSchema,
  semanticEventSchema,
  semanticEventStreamHeaderSchema,
  type SemanticEventIntentV1,
  type SemanticEvidenceHandleV1,
  type SemanticEventStreamHeaderV1,
  type SemanticEventV1,
} from "../domain/semantic-event";

const FOUNDER_DIRECTORY = ".founder";
const WORK_ITEMS_DIRECTORY = "work-items";
const GOAL_FILE = "goal.yaml";
const STATE_FILE = "state.json";
const RUNS_DIRECTORY = "runs";
const MISSIONS_DIRECTORY = "missions";
const SHAPING_DIRECTORY = "shaping";
const SHAPING_RUNS_DIRECTORY = "shaping-runs";
const SHAPING_RUN_FILE = "run.json";
const SHAPING_RUN_EVENTS_FILE = "events.ndjson";
const SHAPING_RUN_PROCESS_FILE = "process.json";
const SHAPING_RUN_LAUNCH_GUARD_FILE = ".launch-guard.json";
const SHAPING_RUN_EVENTS_LOCK_FILE = ".events.lock";
const SHAPING_INGRESS_DIRECTORY = "shaping-ingress";
const SHAPING_DECISIONS_DIRECTORY = "shaping-decisions";
const PLAN_APPROVALS_DIRECTORY = "plan-approvals";
const SEMANTIC_EVENTS_DIRECTORY = "semantic-events";
const SEMANTIC_EVENT_STREAM_FILE = "stream.json";
const SEMANTIC_EVENT_INTENTS_DIRECTORY = "intents";
const SEMANTIC_EVENT_FILES_DIRECTORY = "events";
const RUN_EVIDENCE_DIRECTORY = "run-evidence";
const EXECUTION_DIRECTORY = "execution";
const EXECUTION_DEFAULTS_FILE = "defaults.json";
const CONNECTED_RUNS_DIRECTORY = "connected-runs";
const REVIEW_RESULT_RECOVERIES_DIRECTORY = "review-result-recoveries";
const CONNECTED_RUN_FILE = "run.json";
const CONNECTED_RUN_EVENTS_FILE = "events.ndjson";
const CONNECTED_RUN_PROCESS_FILE = "process.json";
const CONNECTED_RUN_LAUNCH_GUARD_FILE = ".launch-guard.json";
const CONNECTED_RUN_EVENTS_LOCK_FILE = ".events.lock";
const MISSION_JSON_FILE = "mission.json";
const TASK_MD_FILE = "TASK.md";
const RESULT_JSON_FILE = "result.json";
const SUBMISSION_JSON_FILE = "submission.json";
const IMPORT_JSON_FILE = "import.json";
const PRODUCTION_JSON_FILE = "production.json";
const APPLIED_JSON_FILE = "applied.json";
const APPLIED_DIRECTORY = "applied";
const DECISION_JSON_FILE = "decision.json";
const INSTRUCTION_JSON_FILE = "instruction.json";
const VERIFICATION_JSON_FILE = "verification.json";
const CONTROLLER_LOCK_FILE = ".controller.lock";
const VERIFICATION_LOCK_FILE = ".verification.lock";
const execFileAsync = promisify(execFile);
const COMMAND_OUTPUT_LIMIT_BYTES = 64 * 1024;
const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const STAGING_DIRECTORY_PATTERN = new RegExp(
  `^\\.wi_${UUID_PATTERN}\\.${UUID_PATTERN}\\.staging$`,
  "i",
);
const CONNECTED_RUN_STAGING_DIRECTORY_PATTERN = new RegExp(
  `^\\.${UUID_PATTERN}\\.${UUID_PATTERN}\\.staging$`,
  "i",
);
const SHAPING_RUN_STAGING_DIRECTORY_PATTERN = new RegExp(
  `^\\.${UUID_PATTERN}\\.${UUID_PATTERN}\\.shaping-run\\.staging$`,
  "i",
);
const SHAPING_STAGING_DIRECTORY_PATTERN = new RegExp(
  `^\\.(brainstorm|spec|plan)-[0-9a-f]{64}\\.${UUID_PATTERN}\\.(?:shaping\\.tmp|applied\\.staging)$`,
  "i",
);
const SEMANTIC_EVENT_FILE_PATTERN = /^(\d{16})\.json$/u;
const SEMANTIC_INTENT_FILE_PATTERN = /^([0-9a-f]{64})\.json$/u;

interface StoredAppliedShapingBundle {
  resultPath: string;
  resultSource: string;
  resultContentSha256: string;
  importPath: string;
  importSource: string;
  importReceipt: ShapingImportReceipt;
  productionPath: string;
  productionSource: string;
  productionReceipt: ShapingProductionReceipt;
  markerPath: string;
  markerSource: string;
  marker: ShapingAppliedMarkerV1;
}

const SHA256_SCHEMA = z.string().regex(/^[0-9a-f]{64}$/);
const FAIL_CLOSED_EXECUTION_DEFAULTS: ExecutionDefaultsV1 = {
  schema_version: 1,
  approved_command_forms: [],
  approved_url_operations: [],
  mcp: "forbidden",
  credentials: "forbidden",
};
const REDACTED_EVENT_VALUE = "[REDACTED]";
const TRUNCATED_EVENT_VALUE = "...[TRUNCATED]";
const MAX_EVENT_DEPTH = 8;
const MAX_EVENT_ARRAY_ITEMS = 100;
const MAX_EVENT_OBJECT_KEYS = 100;

const connectedRunLaunchGuardSchema = z
  .strictObject({
    schema_version: z.literal(1),
    work_item_id: workItemIdSchema,
    connected_run_id: controllerRunIdSchema,
    launch_fingerprint: SHA256_SCHEMA,
    record: connectedRunRecordV2Schema,
    created_at: z.iso.datetime(),
  })
  .superRefine((guard, context) => {
    if (guard.record.connected_run_id !== guard.connected_run_id) {
      context.addIssue({
        code: "custom",
        message: "record connected_run_id must match launch guard",
        path: ["record", "connected_run_id"],
        input: guard.record.connected_run_id,
      });
    }
    if (guard.record.mission.identity.work_item_id !== guard.work_item_id) {
      context.addIssue({
        code: "custom",
        message: "record work_item_id must match launch guard",
        path: ["record", "mission", "identity", "work_item_id"],
        input: guard.record.mission.identity.work_item_id,
      });
    }
  });

type ConnectedRunLaunchGuard = z.infer<typeof connectedRunLaunchGuardSchema>;

const shapingRunLaunchGuardSchema = z
  .strictObject({
    schema_version: z.literal(1),
    work_item_id: workItemIdSchema,
    shaping_run_id: controllerRunIdSchema,
    launch_fingerprint: SHA256_SCHEMA,
    record: shapingRunRecordV1Schema,
    instruction: shapingIngressInstructionSchema,
    created_at: z.iso.datetime(),
  })
  .superRefine((guard, context) => {
    const requestedModel = guard.record.provenance.requested_model.value;
    if (guard.record.shaping_run_id !== guard.shaping_run_id) {
      context.addIssue({
        code: "custom",
        message: "record shaping_run_id must match launch guard",
        path: ["record", "shaping_run_id"],
        input: guard.record.shaping_run_id,
      });
    }
    if (guard.record.mission.work_item_id !== guard.work_item_id) {
      context.addIssue({
        code: "custom",
        message: "record work_item_id must match launch guard",
        path: ["record", "mission", "work_item_id"],
        input: guard.record.mission.work_item_id,
      });
    }
    if (requestedModel === null) {
      context.addIssue({
        code: "custom",
        message: "connected shaping launches require a requested model",
        path: ["record", "provenance", "requested_model"],
        input: guard.record.provenance.requested_model,
      });
    } else if (
      guard.launch_fingerprint !==
      shapingRunLaunchFingerprint(
        guard.record.mission.content_sha256,
        requestedModel,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "launch_fingerprint must hash the shaping launch identity",
        path: ["launch_fingerprint"],
        input: guard.launch_fingerprint,
      });
    }
    if (
      guard.instruction.origin !== "connected_run" ||
      guard.instruction.shaping_run_id !== guard.shaping_run_id ||
      guard.instruction.work_item_id !== guard.work_item_id ||
      guard.instruction.phase !== guard.record.mission.phase ||
      guard.instruction.mission_input_sha256 !==
        guard.record.mission.input_sha256 ||
      guard.instruction.mission_content_sha256 !==
        guard.record.mission.content_sha256 ||
      guard.instruction.ingress_path !==
        guard.record.write_policy.ingress_path ||
      guard.instruction.instruction_sha256 !==
        guard.record.write_policy.instruction_sha256
    ) {
      context.addIssue({
        code: "custom",
        message: "instruction must match the guarded shaping run",
        path: ["instruction"],
        input: guard.instruction,
      });
    }
  });

type ShapingRunLaunchGuard = z.infer<typeof shapingRunLaunchGuardSchema>;

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unlinkFileSyncIfPresent(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

function abortWasRequested(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function validationReason(
  result: { error: { issues: Array<{ path: PropertyKey[]; message: string }> } },
): string {
  return result.error.issues
    .map(({ path, message }) =>
      path.length > 0 ? `${path.map(String).join(".")}: ${message}` : message,
    )
    .join("; ");
}

function execFileExitCode(error: unknown): number | null {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "number"
  ) {
    return error.code;
  }
  return null;
}

type SanitizedEventValue =
  | null
  | boolean
  | number
  | string
  | SanitizedEventValue[]
  | { [key: string]: SanitizedEventValue };

function isSensitiveEventKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replaceAll("-", "_")
    .toLowerCase();
  return (
    [
      "access_key",
      "api_key",
      "authorization",
      "cookie",
      "credentials",
      "env",
      "environment",
      "narration",
      "password",
      "private_key",
      "prompt",
      "raw_input",
      "raw_output",
      "secret",
      "set_cookie",
      "stderr",
      "stdout",
      "token",
    ].includes(normalized) ||
    /(?:^|_)(?:access_key|api_key|authorization|cookie|credentials|password|private_key|secret|token)$/u.test(
      normalized,
    )
  );
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  if (maxBytes <= Buffer.byteLength(TRUNCATED_EVENT_VALUE, "utf8")) {
    return "";
  }

  const availableBytes =
    maxBytes - Buffer.byteLength(TRUNCATED_EVENT_VALUE, "utf8");
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
  return `${result}${TRUNCATED_EVENT_VALUE}`;
}

function sanitizeConnectedRunEvent(
  value: unknown,
  maxStringBytes: number,
  depth = 0,
  seen = new WeakSet<object>(),
): SanitizedEventValue {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return truncateUtf8(value, maxStringBytes);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return truncateUtf8(value.toString(), maxStringBytes);
  }
  if (typeof value !== "object") {
    return null;
  }
  if (depth >= MAX_EVENT_DEPTH || seen.has(value)) {
    return TRUNCATED_EVENT_VALUE;
  }

  seen.add(value);
  if (Array.isArray(value)) {
    const sanitized = value
      .slice(0, MAX_EVENT_ARRAY_ITEMS)
      .map((item) =>
        sanitizeConnectedRunEvent(item, maxStringBytes, depth + 1, seen),
      );
    if (value.length > MAX_EVENT_ARRAY_ITEMS) {
      sanitized.push(TRUNCATED_EVENT_VALUE);
    }
    seen.delete(value);
    return sanitized;
  }

  const entries = Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, MAX_EVENT_OBJECT_KEYS);
  const sanitized: Record<string, SanitizedEventValue> = {};
  for (const [key, entryValue] of entries) {
    sanitized[key] = isSensitiveEventKey(key)
      ? REDACTED_EVENT_VALUE
      : sanitizeConnectedRunEvent(
          entryValue,
          maxStringBytes,
          depth + 1,
          seen,
        );
  }
  if (Object.keys(value).length > MAX_EVENT_OBJECT_KEYS) {
    sanitized.__truncated__ = TRUNCATED_EVENT_VALUE;
  }
  seen.delete(value);
  return sanitized;
}

function timestampAtOrAfter(...timestamps: string[]): string {
  const now = new Date().toISOString();
  return [now, ...timestamps].sort().at(-1) ?? now;
}

async function defaultConnectedProcessProbe(
  pid: number,
  signal: 0,
): Promise<boolean> {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") {
      return false;
    }
    if (isNodeError(error) && error.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

export class NodeGitVerificationAdapter implements GitVerificationAdapter {
  constructor(private readonly workspaceRoot: string) {}

  async resolveCommit(revision: string): Promise<string | null> {
    try {
      const output = await this.run([
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${revision}^{commit}`,
      ]);
      const commit = output.trim();
      return /^[0-9a-f]{40}$/.test(commit) ? commit : null;
    } catch (error) {
      if (execFileExitCode(error) !== null) {
        return null;
      }
      throw error;
    }
  }

  async isAncestor(
    ancestorCommit: string,
    descendantCommit: string,
  ): Promise<boolean> {
    try {
      await this.run([
        "merge-base",
        "--is-ancestor",
        ancestorCommit,
        descendantCommit,
      ]);
      return true;
    } catch (error) {
      if (execFileExitCode(error) === 1) {
        return false;
      }
      throw error;
    }
  }

  async readHeadCommit(): Promise<string> {
    const commit = await this.resolveCommit("HEAD");
    if (commit === null) {
      throw new Error("Workspace HEAD is not a resolvable Git commit.");
    }
    return commit;
  }

  async isWorktreeCleanExcludingFounder(): Promise<boolean> {
    const output = await this.run([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      ".",
      ":(exclude).founder",
      ":(exclude).founder/**",
    ]);
    return output.length === 0;
  }

  async listWorktreeChangedFilesExcludingFounder(): Promise<string[]> {
    const [tracked, staged, untracked] = await Promise.all([
      this.run(["diff", "--no-renames", "--name-only", "-z", "HEAD", "--"]),
      this.run([
        "diff",
        "--cached",
        "--no-renames",
        "--name-only",
        "-z",
        "HEAD",
        "--",
      ]),
      this.run(["ls-files", "--others", "--exclude-standard", "-z", "--"]),
    ]);
    return [...new Set(`${tracked}${staged}${untracked}`.split("\0"))]
      .filter(
        (path) =>
          path.length > 0 && path !== ".founder" && !path.startsWith(".founder/"),
      )
      .sort();
  }

  async listChangedFiles(
    baseCommit: string,
    resultCommit: string,
  ): Promise<string[]> {
    const output = await this.run([
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      baseCommit,
      resultCommit,
      "--",
    ]);
    return output.split("\0").filter((path) => path.length > 0);
  }

  async commitWorktreeExcludingFounder(
    message: string,
    paths: readonly string[],
  ): Promise<string> {
    const trimmed = message.trim();
    if (trimmed.length === 0 || trimmed.includes("\n")) {
      throw new Error(
        "A controller commit message must be one non-empty single line.",
      );
    }
    const exactPaths = [...new Set(paths)].sort();
    if (exactPaths.length === 0) {
      throw new Error("A controller result commit requires at least one path.");
    }
    for (const path of exactPaths) {
      workspaceRelativePosixPathSchema.parse(path);
      if (path === ".founder" || path.startsWith(".founder/")) {
        throw new Error("A controller result commit cannot include .founder/.");
      }
    }
    await this.run([
      "--literal-pathspecs",
      "add",
      "--all",
      "--",
      ...exactPaths,
    ]);
    await this.run([
      "--literal-pathspecs",
      "commit",
      "--only",
      "--no-verify",
      "-m",
      trimmed,
      "-m",
      "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>",
      "--",
      ...exactPaths,
    ]);
    return this.readHeadCommit();
  }

  private async run(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: this.workspaceRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  }
}

interface NodeVerificationRunnerOptions {
  environment?: NodeJS.ProcessEnv;
  killGraceMs?: number;
  drainGraceMs?: number;
  now?: () => Date;
  exclusiveWaitMs?: number;
  exclusivePollMs?: number;
}

export class NodeVerificationRunner implements VerificationRunner {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly killGraceMs: number;
  private readonly drainGraceMs: number;
  private readonly now: () => Date;
  private readonly exclusiveWaitMs: number;
  private readonly exclusivePollMs: number;

  constructor(
    private readonly workspaceRoot: string,
    options: NodeVerificationRunnerOptions = {},
  ) {
    this.environment = options.environment ?? process.env;
    this.killGraceMs = options.killGraceMs ?? 5_000;
    this.drainGraceMs = options.drainGraceMs ?? 1_000;
    this.now = options.now ?? (() => new Date());
    this.exclusiveWaitMs = options.exclusiveWaitMs ?? 900_000;
    this.exclusivePollMs = options.exclusivePollMs ?? 250;
  }

  private killGroup(
    child: ReturnType<typeof spawn>,
    signal: NodeJS.Signals,
  ): void {
    if (child.pid !== undefined) {
      try {
        // Product Studio targets Darwin/Linux; detached children lead their POSIX process group.
        process.kill(-child.pid, signal);
        return;
      } catch {
        // The group may already be gone (ESRCH); fall back to the direct child below.
      }
    }

    try {
      child.kill(signal);
    } catch (error) {
      if (isNodeError(error) && error.code === "ESRCH") {
        return;
      }
      // Signalling failure must not defeat the bounded drain backstop.
    }
  }

  async run(command: VerificationCommand): Promise<CommandEvidenceRecord> {
    const validated = verificationCommandSchema.parse(command);
    const release = await this.acquireExclusiveVerification(validated);
    if (release === null) {
      const startedAt = this.now().toISOString();
      return commandEvidenceRecordSchema.parse({
        name: validated.name,
        argv: validated.argv,
        started_at: startedAt,
        completed_at: this.now().toISOString(),
        duration_ms: 0,
        status: "spawn_error",
        exit_code: null,
        signal: null,
        stdout: "",
        stderr:
          "Another authoritative verification is running in this workspace; verification was not started.",
        output_truncated: false,
      });
    }
    try {
      return await this.spawnVerification(validated);
    } finally {
      await release();
    }
  }

  private async acquireExclusiveVerification(
    command: VerificationCommand,
  ): Promise<(() => Promise<void>) | null> {
    const lockPath = join(
      this.workspaceRoot,
      FOUNDER_DIRECTORY,
      VERIFICATION_LOCK_FILE,
    );
    const deadline = Date.now() + this.exclusiveWaitMs;
    for (;;) {
      try {
        await mkdir(dirname(lockPath), { recursive: true });
        const handle = await open(lockPath, "wx");
        try {
          await handle.writeFile(
            `${JSON.stringify({
              name: command.name,
              acquired_at: this.now().toISOString(),
            })}\n`,
            "utf8",
          );
        } finally {
          await handle.close();
        }
        return async () => {
          try {
            await rm(lockPath, { force: true });
          } catch {
            // A lost lock file must not mask the verification record.
          }
        };
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw error;
        }
      }
      if (Date.now() >= deadline) {
        return null;
      }
      await new Promise((resolveWait) =>
        setTimeout(resolveWait, this.exclusivePollMs),
      );
    }
  }

  private async spawnVerification(
    validated: VerificationCommand,
  ): Promise<CommandEvidenceRecord> {
    const startedAt = this.now().toISOString();
    const startedMs = Date.now();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputTruncated = false;

    const capture = (
      chunk: Buffer | string,
      chunks: Buffer[],
      currentBytes: number,
    ): number => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = COMMAND_OUTPUT_LIMIT_BYTES - currentBytes;
      if (remaining <= 0) {
        outputTruncated = true;
        return currentBytes;
      }
      if (buffer.length > remaining) {
        chunks.push(buffer.subarray(0, remaining));
        outputTruncated = true;
        return COMMAND_OUTPUT_LIMIT_BYTES;
      }
      chunks.push(buffer);
      return currentBytes + buffer.length;
    };

    const environment = Object.create(null) as NodeJS.ProcessEnv;
    environment.CI = "1";
    for (const name of [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
    ]) {
      const value = this.environment[name];
      if (value !== undefined) {
        environment[name] = value;
      }
    }

    return await new Promise<CommandEvidenceRecord>((resolveRecord) => {
      let child;
      try {
        child = spawn(validated.argv[0], validated.argv.slice(1), {
          cwd: this.workspaceRoot,
          detached: true,
          shell: false,
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        const completedAt = this.now().toISOString();
        resolveRecord(
          commandEvidenceRecordSchema.parse({
            name: validated.name,
            argv: validated.argv,
            started_at: startedAt,
            completed_at: completedAt,
            duration_ms: Math.max(0, Date.now() - startedMs),
            status: "spawn_error",
            exit_code: null,
            signal: null,
            stdout: "",
            stderr: errorMessage(error),
            output_truncated: false,
          }),
        );
        return;
      }

      let settled = false;
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;
      let drainTimer: NodeJS.Timeout | undefined;

      const finish = (
        status: "passed" | "failed" | "timed_out" | "spawn_error",
        exitCode: number | null,
        signal: string | null,
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (killTimer !== undefined) {
          clearTimeout(killTimer);
        }
        if (drainTimer !== undefined) {
          clearTimeout(drainTimer);
        }
        resolveRecord(
          commandEvidenceRecordSchema.parse({
            name: validated.name,
            argv: validated.argv,
            started_at: startedAt,
            completed_at: this.now().toISOString(),
            duration_ms: Math.max(0, Date.now() - startedMs),
            status,
            exit_code: exitCode,
            signal,
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: Buffer.concat(stderrChunks).toString("utf8"),
            output_truncated: outputTruncated,
          }),
        );
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        this.killGroup(child, "SIGTERM");
        killTimer = setTimeout(() => {
          if (settled) {
            return;
          }
          this.killGroup(child, "SIGKILL");
          drainTimer = setTimeout(() => {
            finish("timed_out", null, "SIGKILL");
          }, this.drainGraceMs);
          drainTimer.unref();
        }, this.killGraceMs);
        killTimer.unref();
      }, validated.timeout_seconds * 1_000);
      timeout.unref();

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdoutBytes = capture(chunk, stdoutChunks, stdoutBytes);
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderrBytes = capture(chunk, stderrChunks, stderrBytes);
      });
      child.once("error", (error) => {
        stderrBytes = capture(error.message, stderrChunks, stderrBytes);
        finish("spawn_error", null, null);
      });
      child.once("close", (code, signal) => {
        finish(
          timedOut
            ? "timed_out"
            : code === 0 && signal === null
              ? "passed"
              : "failed",
          code,
          signal,
        );
      });
    });
  }
}

export interface ProductWorkspaceOptions {
  git?: GitVerificationAdapter;
  verificationRunner?: VerificationRunner;
  connectedProcessProbe?: ConnectedProcessProbe;
}

export type ConnectedProcessProbe = (
  pid: number,
  signal: 0,
) => Promise<boolean>;

export type ShapingIngressInstructionWriteInput =
  | {
      origin: "connected_run";
      shaping_run_id: string;
      mission: ShapingMissionPackage;
    }
  | {
      origin: "manual_import";
      shaping_run_id: null;
      mission: ShapingMissionPackage;
    };

export interface ShapingIngressInstructionWriteResult {
  instruction: ShapingIngressInstructionV1;
  instruction_path: string;
  instruction_source: string;
}

export type ShapingProductionInput =
  | Pick<
      ConnectedShapingProductionReceipt,
      "origin" | "shaping_run_id" | "requested_model" | "effective_model"
    >
  | {
      origin: "manual_import";
      shaping_run_id: null;
    };

export interface AppliedShapingBundleWriteResult {
  applied_path: string;
  result_source: string;
  result_content_sha256: string;
  import_receipt: ShapingImportReceipt;
  import_source: string;
  production_receipt: ShapingProductionReceipt;
  production_source: string;
  applied_marker: ShapingAppliedMarkerV1;
  applied_source: string;
}

export interface ConnectedRunCreateResult {
  record: ConnectedRunRecordV2;
  created: boolean;
}

export interface ConnectedRunEventAppendResult {
  appended: boolean;
  limit_reached: boolean;
  event_count: number;
  event_bytes: number;
}

export interface ShapingRunCreateInput {
  record: Omit<ShapingRunRecordV1, "write_policy">;
  mission: ShapingMissionPackage;
}

export interface ShapingRunCreateResult {
  record: ShapingRunRecordV1;
  instruction: ShapingIngressInstructionV1;
  created: boolean;
}

export interface ShapingRunEventAppendResult {
  appended: boolean;
  limit_reached: boolean;
  event_count: number;
  event_bytes: number;
}

export class ProductWorkspace implements ReviewWorkItemRepository {
  readonly workspaceRoot: string;

  private readonly founderDirectory: string;
  private readonly workItemsDirectory: string;
  private readonly gitAdapter: GitVerificationAdapter;
  private readonly commandRunner: VerificationRunner;
  private readonly connectedProcessProbe: ConnectedProcessProbe;

  constructor(
    workspaceRoot: string,
    options: ProductWorkspaceOptions = {},
  ) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.founderDirectory = join(this.workspaceRoot, FOUNDER_DIRECTORY);
    this.workItemsDirectory = join(
      this.founderDirectory,
      WORK_ITEMS_DIRECTORY,
    );
    this.gitAdapter =
      options.git ?? new NodeGitVerificationAdapter(this.workspaceRoot);
    this.commandRunner =
      options.verificationRunner ??
      new NodeVerificationRunner(this.workspaceRoot);
    this.connectedProcessProbe =
      options.connectedProcessProbe ?? defaultConnectedProcessProbe;
  }

  gitVerificationAdapter(): GitVerificationAdapter {
    return this.gitAdapter;
  }

  verificationRunner(): VerificationRunner {
    return this.commandRunner;
  }

  async writeSemanticEventIntents(
    workItemId: string,
    intents: SemanticEventIntentV1[],
  ): Promise<SemanticEventIntentV1[]> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const validatedIntents = intents.map((intent) =>
      semanticEventIntentSchema.parse(intent),
    );
    if (
      new Set(validatedIntents.map((intent) => intent.intent_id)).size !==
      validatedIntents.length
    ) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        validatedWorkItemId,
        "Semantic event intents must not repeat an intent_id.",
      );
    }

    const written: SemanticEventIntentV1[] = [];
    for (const intent of validatedIntents) {
      if (intent.work_item_id !== validatedWorkItemId) {
        throw new ControllerConflictError(
          "idempotency_conflict",
          validatedWorkItemId,
          "Semantic event intent work_item_id must match its stream.",
        );
      }
      written.push(
        await this.writeSemanticEventIntentFile(
          validatedWorkItemId,
          intent,
        ),
      );
    }
    return written;
  }

  async publishSemanticEventIntent(
    workItemId: string,
    intentId: string,
  ): Promise<SemanticEventV1> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const validatedIntentId = SHA256_SCHEMA.parse(intentId);
    const intent = await this.readSemanticEventIntentFile(
      validatedWorkItemId,
      validatedIntentId,
    );
    if (intent === null) {
      throw new ControllerConflictError(
        "repair_required",
        validatedWorkItemId,
        `Semantic event intent ${validatedIntentId} is missing.`,
      );
    }
    if (intent.kind === "run_finished") {
      await this.publishSemanticLaunchBeforeFinish(intent);
    }
    await this.verifySemanticAuthoritativeSource(intent);
    const evidence = await this.resolveSemanticEvidence(intent);

    return this.withSemanticEventAppendLock(validatedWorkItemId, async () => {
      for (;;) {
        const events = await this.readSemanticEventFiles(validatedWorkItemId);
        const existing = events.find(
          (event) => event.intent_id === validatedIntentId,
        );
        if (existing !== undefined) {
          return this.assertSemanticEventMatchesIntent(
            intent,
            evidence,
            existing,
          );
        }

        const streamSequence = (events.at(-1)?.stream_sequence ?? 0) + 1;
        const event = semanticEventSchema.parse({
          schema_version: 1,
          event_id: deriveSemanticEventId({
            schema_version: 1,
            work_item_id: validatedWorkItemId,
            binding: intent.binding,
            kind: intent.kind,
            stream_sequence: streamSequence,
          }),
          stream_sequence: streamSequence,
          kind: intent.kind,
          work_item_id: validatedWorkItemId,
          binding: intent.binding,
          run: intent.run,
          actor: intent.actor,
          outcome: intent.outcome,
          occurred_at: intent.occurred_at,
          recorded_at: timestampAtOrAfter(intent.occurred_at),
          evidence,
          action: intent.action,
          details: intent.details,
          intent_id: intent.intent_id,
        });
        const eventPath = this.semanticEventPaths(validatedWorkItemId).event(
          streamSequence,
        );
        let eventHandle;
        try {
          eventHandle = await open(eventPath, "wx");
        } catch (error) {
          if (isNodeError(error) && error.code === "EEXIST") {
            continue;
          }
          throw error;
        }

        try {
          await this.afterSemanticSequenceReserved();
          await this.beforeSemanticEventWritten();
          await eventHandle.writeFile(canonicalSerializeSemanticEvent(event), {
            encoding: "utf8",
          });
          await eventHandle.sync();
        } finally {
          await eventHandle.close();
        }

        const publishedSource = await this.readRequiredFile(eventPath);
        if (publishedSource !== canonicalSerializeSemanticEvent(event)) {
          throw this.invalid(
            eventPath,
            "semantic event differs after immutable publication",
          );
        }
        return event;
      }
    });
  }

  async readExecutionDefaults(): Promise<ExecutionDefaultsV1> {
    await this.readManifest();
    const executionDirectory = join(
      this.founderDirectory,
      EXECUTION_DIRECTORY,
    );
    if (!(await this.hasSafeDirectory(executionDirectory))) {
      return executionDefaultsV1Schema.parse(FAIL_CLOSED_EXECUTION_DEFAULTS);
    }

    const defaultsPath = join(executionDirectory, EXECUTION_DEFAULTS_FILE);
    const source = await this.readOptionalFile(defaultsPath);
    if (source === null) {
      return executionDefaultsV1Schema.parse(FAIL_CLOSED_EXECUTION_DEFAULTS);
    }
    return this.parseJson(source, defaultsPath, executionDefaultsV1Schema);
  }

  async createConnectedRun(
    record: ConnectedRunRecordV2,
  ): Promise<ConnectedRunCreateResult> {
    const validated = connectedRunRecordV2Schema.parse(record);
    const workItemId = validated.mission.identity.work_item_id;
    if (validated.lifecycle.status === "terminal") {
      throw new ControllerConflictError(
        "invalid_transition",
        workItemId,
        "A new connected run must be nonterminal.",
      );
    }

    await this.readManifest();
    const current = await this.readValidated(workItemId);
    if (!(await this.hasSafeWorkItemsDirectory()) || current === null) {
      throw new ControllerConflictError(
        "work_item_not_found",
        workItemId,
        `Work item ${workItemId} was not found.`,
      );
    }

    const itemDirectory = await this.ensureConnectedRunItemDirectory(
      workItemId,
    );
    const existingNonterminalRuns = (
      await this.readConnectedRunsFromItemDirectory(workItemId, itemDirectory)
    ).filter((existing) => existing.lifecycle.status !== "terminal");
    if (existingNonterminalRuns.length > 1) {
      throw this.invalid(
        itemDirectory,
        "only one nonterminal connected run may exist per work item",
      );
    }
    const existingNonterminalRun = existingNonterminalRuns[0];
    if (existingNonterminalRun !== undefined) {
      if (
        connectedRunLaunchFingerprint(existingNonterminalRun) ===
        connectedRunLaunchFingerprint(validated)
      ) {
        await this.ensureConnectedRunLaunchEvent(existingNonterminalRun);
        return { record: existingNonterminalRun, created: false };
      }
      throw new ControllerConflictError(
        "lease_held",
        workItemId,
        "A different connected run is already active for this work item.",
      );
    }
    const guardPath = join(
      itemDirectory,
      CONNECTED_RUN_LAUNCH_GUARD_FILE,
    );
    const launchFingerprint = connectedRunLaunchFingerprint(validated);
    const guard = connectedRunLaunchGuardSchema.parse({
      schema_version: 1,
      work_item_id: workItemId,
      connected_run_id: validated.connected_run_id,
      launch_fingerprint: launchFingerprint,
      record: validated,
      created_at: timestampAtOrAfter(validated.lifecycle.started_at),
    });
    const launchIntent = await this.buildConnectedRunLaunchIntent(
      validated,
      current,
    );
    await this.writeSemanticEventIntents(workItemId, [launchIntent]);

    try {
      await writeFile(guardPath, `${JSON.stringify(guard, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        return this.resolveExistingConnectedRunLaunch(
          validated,
        );
      }
      throw error;
    }

    try {
      await this.publishConnectedRunDirectory(validated);
      await this.publishSemanticEventIntent(
        workItemId,
        launchIntent.intent_id,
      );
      return { record: validated, created: true };
    } catch (error) {
      try {
        await this.releaseConnectedRunGuard(guard);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Connected run creation failed and its launch guard could not be released",
        );
      }
      throw error;
    }
  }

  async readConnectedRun(
    workItemId: string,
    connectedRunId: string,
  ): Promise<ConnectedRunRecordV2 | null> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const validatedRunId = controllerRunIdSchema.parse(connectedRunId);
    await this.readManifest();
    const connectedRunsDirectory = join(
      this.founderDirectory,
      CONNECTED_RUNS_DIRECTORY,
    );
    if (!(await this.hasSafeDirectory(connectedRunsDirectory))) {
      return null;
    }
    const itemDirectory = join(
      connectedRunsDirectory,
      validatedWorkItemId,
    );
    if (!(await this.hasSafeDirectory(itemDirectory))) {
      return null;
    }
    return this.readConnectedRunFromDirectory(
      validatedWorkItemId,
      validatedRunId,
      itemDirectory,
    );
  }

  async listConnectedRuns(
    workItemId: string,
  ): Promise<ConnectedRunRecordV2[]> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    await this.readManifest();
    const connectedRunsDirectory = join(
      this.founderDirectory,
      CONNECTED_RUNS_DIRECTORY,
    );
    if (!(await this.hasSafeDirectory(connectedRunsDirectory))) {
      return [];
    }
    const itemDirectory = join(
      connectedRunsDirectory,
      validatedWorkItemId,
    );
    if (!(await this.hasSafeDirectory(itemDirectory))) {
      return [];
    }
    return this.readConnectedRunsFromItemDirectory(
      validatedWorkItemId,
      itemDirectory,
    );
  }

  async writeConnectedRunProcessIdentity(
    workItemId: string,
    connectedRunId: string,
    processIdentity: ConnectedRunProcessIdentity,
  ): Promise<ConnectedRunRecordV2> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const validatedRunId = controllerRunIdSchema.parse(connectedRunId);
    const validatedProcess = connectedRunProcessIdentitySchema.parse(
      processIdentity,
    );
    const record = await this.requireConnectedRun(
      validatedWorkItemId,
      validatedRunId,
    );
    if (record.lifecycle.status === "terminal") {
      throw new ControllerConflictError(
        "invalid_transition",
        validatedWorkItemId,
        "A terminal connected run cannot acquire a process identity.",
      );
    }

    const paths = this.connectedRunPaths(validatedWorkItemId, validatedRunId);
    const storedProcess = await this.readConnectedRunProcess(paths.process);
    if (
      storedProcess !== null &&
      JSON.stringify(storedProcess) !== JSON.stringify(validatedProcess)
    ) {
      throw this.invalid(
        paths.process,
        "connected process identity is immutable once recorded",
      );
    }
    if (
      record.process !== null &&
      JSON.stringify(record.process) !== JSON.stringify(validatedProcess)
    ) {
      throw this.invalid(
        paths.run,
        "run record process identity must match process.json",
      );
    }

    await this.writeJsonAtomically(paths.process, validatedProcess);
    const updated = connectedRunRecordV2Schema.parse({
      ...record,
      lifecycle: {
        ...record.lifecycle,
        status: "running",
        updated_at: timestampAtOrAfter(
          record.lifecycle.updated_at,
          validatedProcess.started_at,
        ),
      },
      process: validatedProcess,
    });
    await this.writeJsonAtomically(paths.run, updated);
    return updated;
  }

  async startConnectedRun(
    workItemId: string,
    connectedRunId: string,
    acp: ConnectedRunProtocolIdentity,
    processIdentity: ConnectedRunProcessIdentity,
  ): Promise<ConnectedRunRecordV2> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const validatedRunId = controllerRunIdSchema.parse(connectedRunId);
    const validatedProcess = connectedRunProcessIdentitySchema.parse(
      processIdentity,
    );
    const record = await this.requireConnectedRun(
      validatedWorkItemId,
      validatedRunId,
    );
    if (record.lifecycle.status === "terminal") {
      throw new ControllerConflictError(
        "invalid_transition",
        validatedWorkItemId,
        "A terminal connected run cannot acquire an ACP session.",
      );
    }

    const paths = this.connectedRunPaths(validatedWorkItemId, validatedRunId);
    const storedProcess = await this.readConnectedRunProcess(paths.process);
    if (
      storedProcess !== null &&
      JSON.stringify(storedProcess) !== JSON.stringify(validatedProcess)
    ) {
      throw this.invalid(
        paths.process,
        "connected process identity is immutable once recorded",
      );
    }
    const updated = connectedRunRecordV2Schema.parse({
      ...record,
      acp,
      lifecycle: {
        ...record.lifecycle,
        status: "running",
        updated_at: timestampAtOrAfter(
          record.lifecycle.updated_at,
          validatedProcess.started_at,
        ),
      },
      process: validatedProcess,
    });
    if (record.lifecycle.status === "running") {
      if (
        JSON.stringify(record.acp) !== JSON.stringify(updated.acp) ||
        JSON.stringify(record.process) !== JSON.stringify(updated.process)
      ) {
        throw this.invalid(
          paths.run,
          "running connected run identity is immutable",
        );
      }
      return record;
    }

    await this.writeJsonAtomically(paths.process, validatedProcess);
    await this.writeJsonAtomically(paths.run, updated);
    return updated;
  }

  async updateConnectedRunEffectiveModel(
    workItemId: string,
    connectedRunId: string,
    effectiveModel: Extract<
      EffectiveModelIdentity,
      { assurance: "adapter_attested" }
    >,
    signal?: AbortSignal,
  ): Promise<ConnectedRunRecordV2> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const validatedRunId = controllerRunIdSchema.parse(connectedRunId);
    const validatedEffectiveModel = effectiveModelIdentitySchema.parse(
      effectiveModel,
    );
    if (abortWasRequested(signal)) {
      throw new ControllerConflictError(
        "invalid_transition",
        validatedWorkItemId,
        "Connected-run model observation was interrupted.",
      );
    }
    if (validatedEffectiveModel.assurance !== "adapter_attested") {
      throw new ControllerConflictError(
        "invalid_transition",
        validatedWorkItemId,
        "A connected run effective model must be adapter-attested.",
      );
    }
    const record = await this.requireConnectedRun(
      validatedWorkItemId,
      validatedRunId,
    );
    if (
      isDeepStrictEqual(
        record.provenance.effective_model,
        validatedEffectiveModel,
      )
    ) {
      return record;
    }
    if (record.lifecycle.status === "terminal") {
      throw new ControllerConflictError(
        "idempotency_conflict",
        validatedWorkItemId,
        "A terminal connected run cannot record a different effective model.",
      );
    }
    if (record.lifecycle.status !== "running") {
      throw new ControllerConflictError(
        "invalid_transition",
        validatedWorkItemId,
        "A connected run must be running before it records an effective model.",
      );
    }

    const updated = connectedRunRecordV2Schema.parse({
      ...record,
      provenance: {
        ...record.provenance,
        effective_model: validatedEffectiveModel,
      },
    });
    await this.writeJsonAtomicallyAbortable(
      this.connectedRunPaths(validatedWorkItemId, validatedRunId).run,
      updated,
      signal,
    );
    return updated;
  }

  async completeConnectedRun(
    workItemId: string,
    connectedRunId: string,
    terminal: ConnectedRunTerminal,
  ): Promise<ConnectedRunRecordV2> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const validatedRunId = controllerRunIdSchema.parse(connectedRunId);
    const record = await this.requireConnectedRun(
      validatedWorkItemId,
      validatedRunId,
    );
    return this.terminalizeConnectedRun(record, terminal);
  }

  async appendConnectedRunEvent(
    workItemId: string,
    connectedRunId: string,
    event: unknown,
    signal?: AbortSignal,
  ): Promise<ConnectedRunEventAppendResult> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const validatedRunId = controllerRunIdSchema.parse(connectedRunId);
    if (abortWasRequested(signal)) {
      throw new ControllerConflictError(
        "invalid_transition",
        validatedWorkItemId,
        "Connected-run event append was interrupted.",
      );
    }
    const paths = this.connectedRunPaths(validatedWorkItemId, validatedRunId);
    const eventLockPath = join(paths.directory, CONNECTED_RUN_EVENTS_LOCK_FILE);
    try {
      await writeFile(eventLockPath, `${validatedRunId}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new ControllerConflictError(
          "lease_held",
          validatedWorkItemId,
          "Another event append is already in progress for this connected run.",
        );
      }
      throw error;
    }

    try {
      const record = await this.requireConnectedRun(
        validatedWorkItemId,
        validatedRunId,
      );
      if (record.lifecycle.status === "terminal") {
        throw new ControllerConflictError(
          "invalid_transition",
          validatedWorkItemId,
          "A terminal connected run cannot accept new events.",
        );
      }
      const stats = await this.readConnectedRunEventStats(paths.events);
      const maxStringBytes = Math.min(
        record.limits.max_output_bytes,
        record.limits.max_event_bytes,
      );
      const sanitized = sanitizeConnectedRunEvent(event, maxStringBytes);
      const line = `${JSON.stringify(sanitized)}\n`;
      const lineBytes = Buffer.byteLength(line, "utf8");
      const limitReached =
        stats.event_count + 1 > record.limits.max_event_count ||
        stats.event_bytes + lineBytes > record.limits.max_event_bytes;
      if (limitReached) {
        return {
          appended: false,
          limit_reached: true,
          ...stats,
        };
      }

      if (abortWasRequested(signal)) {
        throw new ControllerConflictError(
          "invalid_transition",
          validatedWorkItemId,
          "Connected-run event append was interrupted.",
        );
      }
      appendFileSync(paths.events, line, "utf8");
      return {
        appended: true,
        limit_reached: false,
        event_count: stats.event_count + 1,
        event_bytes: stats.event_bytes + lineBytes,
      };
    } finally {
      unlinkFileSyncIfPresent(eventLockPath);
    }
  }

  async writeConnectedReviewResult(
    workItemId: string,
    connectedRunId: string,
    requestedPath: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<{ written: boolean }> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const validatedRunId = controllerRunIdSchema.parse(connectedRunId);
    const record = await this.requireConnectedRun(
      validatedWorkItemId,
      validatedRunId,
    );
    if (
      record.mission.identity.phase !== "review" ||
      record.authorization.kind !== "review_result_ingress"
    ) {
      throw new ControllerConflictError(
        "invalid_transition",
        validatedWorkItemId,
        "Connected Review result writes require Review result-ingress authorization.",
      );
    }
    if (record.lifecycle.status !== "running") {
      throw new ControllerConflictError(
        "invalid_transition",
        validatedWorkItemId,
        "Connected Review result writes require a running Review run.",
      );
    }
    if (abortWasRequested(signal)) {
      throw new ControllerConflictError(
        "invalid_transition",
        validatedWorkItemId,
        "Connected Review result write was interrupted before publication.",
      );
    }

    const resultPath = join(
      this.workspaceRoot,
      ...record.authorization.result_path.split("/"),
    );
    if (
      !isAbsolute(requestedPath) ||
      resolve(requestedPath) !== resultPath ||
      requestedPath !== resultPath
    ) {
      throw new ControllerConflictError(
        "mission_not_ready",
        validatedWorkItemId,
        "Connected Review write path does not match the exact result path.",
      );
    }
    const contentBytes = Buffer.from(content, "utf8");
    if (
      contentBytes.byteLength === 0 ||
      contentBytes.byteLength > record.limits.max_output_bytes
    ) {
      throw new ControllerConflictError(
        "mission_not_ready",
        validatedWorkItemId,
        `Connected Review result must contain 1-${record.limits.max_output_bytes} bytes.`,
      );
    }
    await this.assertSafeWorkspaceDirectoryComponents(
      posix.dirname(record.authorization.result_path),
    );

    const stagingPath = `${resultPath}.${randomUUID()}.acp-write.tmp`;
    let descriptor: number | null = null;
    let persistenceError: unknown = null;
    try {
      if (abortWasRequested(signal)) {
        throw new Error("Connected Review result write was interrupted before staging.");
      }
      descriptor = openSync(
        stagingPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(descriptor, contentBytes);
      fsyncSync(descriptor);
    } catch (error) {
      persistenceError = error;
    } finally {
      if (descriptor !== null) {
        try {
          closeSync(descriptor);
        } catch (error) {
          persistenceError ??= error;
        }
      }
    }
    if (persistenceError !== null) {
      const failure = new ControllerConflictError(
        "mission_not_ready",
        validatedWorkItemId,
        `Connected Review result staging failed: ${errorMessage(persistenceError)}`,
      );
      try {
        unlinkFileSyncIfPresent(stagingPath);
      } catch (cleanupError) {
        throw new AggregateError(
          [failure, cleanupError],
          "Connected Review result staging failed and cleanup was incomplete",
        );
      }
      throw failure;
    }

    let outcome: { written: boolean };
    try {
      if (abortWasRequested(signal)) {
        throw new ControllerConflictError(
          "mission_not_ready",
          validatedWorkItemId,
          "Connected Review result write was interrupted before publication.",
        );
      }
      try {
        linkSync(stagingPath, resultPath);
        outcome = { written: true };
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw new ControllerConflictError(
            "mission_not_ready",
            validatedWorkItemId,
            `Connected Review result publication failed: ${errorMessage(error)}`,
          );
        }
        let handle;
        try {
          handle = await open(
            resultPath,
            fsConstants.O_RDONLY |
              fsConstants.O_NOFOLLOW |
              fsConstants.O_NONBLOCK,
          );
          const stats = await handle.stat();
          if (
            !stats.isFile() ||
            stats.size === 0 ||
            stats.size > record.limits.max_output_bytes
          ) {
            throw new Error("existing result is not a bounded regular file");
          }
          const existing = await handle.readFile();
          if (!existing.equals(contentBytes)) {
            throw new ControllerConflictError(
              "idempotency_conflict",
              validatedWorkItemId,
              "Existing Review result bytes differ from the connected write replay.",
            );
          }
        } catch (readError) {
          if (readError instanceof ControllerConflictError) {
            throw readError;
          }
          throw new ControllerConflictError(
            "mission_not_ready",
            validatedWorkItemId,
            `Existing Review result is unsafe or unreadable: ${errorMessage(readError)}`,
          );
        } finally {
          await handle?.close();
        }
        outcome = { written: false };
      }
    } catch (error) {
      try {
        unlinkFileSyncIfPresent(stagingPath);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Connected Review result publication failed and cleanup was incomplete",
        );
      }
      throw error;
    }
    try {
      unlinkFileSyncIfPresent(stagingPath);
    } catch (error) {
      throw new ControllerConflictError(
        "mission_not_ready",
        validatedWorkItemId,
        `Connected Review result staging cleanup failed: ${errorMessage(error)}`,
      );
    }
    return outcome;
  }

  async recoverConnectedReviewResult(
    input: ConnectedReviewResultRecoveryInput,
  ): Promise<ConnectedReviewResultRecoveryReceiptV1> {
    const validated = connectedReviewResultRecoveryInputSchema.parse(input);
    const workItemId = validated.identity.work_item_id;
    await this.readManifest();
    const current = await this.readValidated(workItemId);
    if (
      current === null ||
      current.state.phase !== "review" ||
      current.state.status !== "active" ||
      current.goal.goal_contract?.goal_version !==
        validated.identity.goal_version ||
      current.state.goal_version !== validated.identity.goal_version ||
      current.state.input_revision !== validated.identity.input_revision ||
      current.state.attempt !== validated.identity.attempt ||
      current.state.patch_cycle !== validated.patch_cycle
    ) {
      throw this.missionNotReady(
        workItemId,
        "Stale Review result recovery requires the exact active Review tuple.",
      );
    }

    const expectedResultPath = posix.join(
      FOUNDER_DIRECTORY,
      MISSIONS_DIRECTORY,
      workItemId,
      this.missionDirectoryName(
        validated.identity,
        validated.patch_cycle === 0 ? undefined : validated.patch_cycle,
      ),
      RESULT_JSON_FILE,
    );
    if (validated.result_path !== expectedResultPath) {
      throw new ControllerConflictError(
        "stale_expectation",
        workItemId,
        "Stale Review recovery result path does not match the active mission tuple.",
      );
    }

    const connectedRuns = await this.listConnectedRuns(workItemId);
    if (connectedRuns.some((run) => run.lifecycle.status !== "terminal")) {
      throw new ControllerConflictError(
        "lease_held",
        workItemId,
        "Stale Review result recovery requires every connected run to be terminal.",
      );
    }
    const trigger = connectedRuns.find(
      (run) =>
        run.connected_run_id ===
        validated.recovery_trigger_connected_run_id,
    );
    if (
      trigger === undefined ||
      trigger.lifecycle.status !== "terminal" ||
      trigger.lifecycle.terminal?.outcome !== "failed" ||
      !trigger.lifecycle.terminal.partial ||
      !isDeepStrictEqual(trigger.mission.identity, validated.identity) ||
      trigger.mission.content_sha256 !==
        validated.review_mission_content_sha256 ||
      trigger.governed_tuple.patch_cycle !== validated.patch_cycle ||
      trigger.authorization.kind !== "review_result_ingress" ||
      trigger.authorization.result_path !== validated.result_path
    ) {
      throw this.missionNotReady(
        workItemId,
        "Stale Review result recovery requires the exact failed partial Review run that exposed the collision.",
      );
    }

    const acceptedCurrentReview = (await this.listImportEvidence(workItemId)).some(
      ({ evidence }) =>
        evidence.phase === "review" &&
        evidence.outcome === "applied" &&
        evidence.mission_content_sha256 ===
          validated.review_mission_content_sha256 &&
        isDeepStrictEqual(evidence.identity, validated.identity),
    );
    if (acceptedCurrentReview) {
      throw this.missionNotReady(
        workItemId,
        "An applied Review result cannot be recovered as stale output.",
      );
    }

    await this.assertSafeWorkspaceDirectoryComponents(
      posix.dirname(validated.result_path),
    );
    const resultPath = join(
      this.workspaceRoot,
      ...validated.result_path.split("/"),
    );
    const recoveryRelativeDirectory = posix.join(
      FOUNDER_DIRECTORY,
      REVIEW_RESULT_RECOVERIES_DIRECTORY,
      workItemId,
      validated.recovery_trigger_connected_run_id,
    );
    const archivedResultPath = posix.join(
      recoveryRelativeDirectory,
      RESULT_JSON_FILE,
    );
    const recoveryPath = posix.join(
      recoveryRelativeDirectory,
      "recovery.json",
    );
    const archivedResultAbsolutePath = join(
      this.workspaceRoot,
      ...archivedResultPath.split("/"),
    );
    const recoveryAbsolutePath = join(
      this.workspaceRoot,
      ...recoveryPath.split("/"),
    );
    const recoveryRoot = join(
      this.founderDirectory,
      REVIEW_RESULT_RECOVERIES_DIRECTORY,
    );
    const workItemRecoveryRoot = join(recoveryRoot, workItemId);
    const recoveryDirectory = join(
      workItemRecoveryRoot,
      validated.recovery_trigger_connected_run_id,
    );
    if (
      (await this.hasSafeDirectory(recoveryRoot)) &&
      (await this.hasSafeDirectory(workItemRecoveryRoot))
    ) {
      await this.hasSafeDirectory(recoveryDirectory);
    }
    const receipt = connectedReviewResultRecoveryReceiptV1Schema.parse({
      schema_version: 1,
      work_item_id: workItemId,
      identity: validated.identity,
      patch_cycle: validated.patch_cycle,
      review_mission_content_sha256:
        validated.review_mission_content_sha256,
      result_content_sha256: validated.expected_result_content_sha256,
      original_result_path: validated.result_path,
      archived_result_path: archivedResultPath,
      recovery_path: recoveryPath,
      recovery_trigger_connected_run_id:
        validated.recovery_trigger_connected_run_id,
    });
    const receiptSource = `${JSON.stringify(receipt, null, 2)}\n`;

    const readRecoveryFile = async (
      filePath: string,
      label: string,
    ): Promise<Buffer | null> => {
      let handle;
      try {
        handle = await open(
          filePath,
          fsConstants.O_RDONLY |
            fsConstants.O_NOFOLLOW |
            fsConstants.O_NONBLOCK,
        );
        const stats = await handle.stat();
        if (
          !stats.isFile() ||
          stats.size === 0 ||
          stats.size > trigger.limits.max_output_bytes
        ) {
          throw this.invalid(
            filePath,
            `${label} must be a bounded regular file`,
          );
        }
        return await handle.readFile();
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return null;
        }
        throw error;
      } finally {
        await handle?.close();
      }
    };

    const [originalBytes, archivedBytes, existingReceiptSource] =
      await Promise.all([
        readRecoveryFile(resultPath, "Review result"),
        readRecoveryFile(archivedResultAbsolutePath, "Archived Review result"),
        this.readOptionalFile(recoveryAbsolutePath),
      ]);
    if (
      originalBytes !== null &&
      hashResultContent(originalBytes) !==
        validated.expected_result_content_sha256
    ) {
      throw new ControllerConflictError(
        "stale_expectation",
        workItemId,
        "Stale Review result bytes do not match the founder-confirmed content hash.",
      );
    }
    if (
      archivedBytes !== null &&
      hashResultContent(archivedBytes) !==
        validated.expected_result_content_sha256
    ) {
      throw this.invalid(
        archivedResultAbsolutePath,
        "archived Review result does not match its recovery content hash",
      );
    }
    if (
      originalBytes !== null &&
      archivedBytes !== null &&
      !originalBytes.equals(archivedBytes)
    ) {
      throw this.invalid(
        archivedResultAbsolutePath,
        "archived Review result differs from the stale mission output",
      );
    }
    if (existingReceiptSource !== null) {
      const existingReceipt = this.parseJson(
        existingReceiptSource,
        recoveryAbsolutePath,
        connectedReviewResultRecoveryReceiptV1Schema,
      );
      if (!isDeepStrictEqual(existingReceipt, receipt)) {
        throw this.invalid(
          recoveryAbsolutePath,
          "immutable Review result recovery receipt differs",
        );
      }
    }
    if (originalBytes === null) {
      if (archivedBytes === null || existingReceiptSource === null) {
        throw this.missionNotReady(
          workItemId,
          "The stale Review result is missing without complete recovery evidence.",
        );
      }
      return receipt;
    }

    await this.ensureDirectory(recoveryRoot);
    await this.ensureDirectory(workItemRecoveryRoot);
    await this.ensureDirectory(recoveryDirectory);
    if (archivedBytes === null) {
      try {
        linkSync(resultPath, archivedResultAbsolutePath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw error;
        }
      }
    }
    const publishedArchive = await readRecoveryFile(
      archivedResultAbsolutePath,
      "Archived Review result",
    );
    if (
      publishedArchive === null ||
      !publishedArchive.equals(originalBytes) ||
      hashResultContent(publishedArchive) !==
        validated.expected_result_content_sha256
    ) {
      throw this.invalid(
        archivedResultAbsolutePath,
        "archived Review result differs after publication",
      );
    }

    if (existingReceiptSource === null) {
      const stagingPath = `${recoveryAbsolutePath}.${randomUUID()}.tmp`;
      try {
        const descriptor = openSync(
          stagingPath,
          fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            fsConstants.O_NOFOLLOW,
          0o600,
        );
        try {
          writeFileSync(descriptor, receiptSource, "utf8");
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
        try {
          linkSync(stagingPath, recoveryAbsolutePath);
        } catch (error) {
          if (!isNodeError(error) || error.code !== "EEXIST") {
            throw error;
          }
        }
      } finally {
        await this.unlinkIfPresent(stagingPath);
      }
    }
    const publishedReceiptSource = await this.readRequiredFile(
      recoveryAbsolutePath,
    );
    if (publishedReceiptSource !== receiptSource) {
      throw this.invalid(
        recoveryAbsolutePath,
        "immutable Review result recovery receipt differs after publication",
      );
    }

    const [originalStats, archiveStats] = await Promise.all([
      lstat(resultPath),
      lstat(archivedResultAbsolutePath),
    ]);
    if (
      !originalStats.isFile() ||
      originalStats.isSymbolicLink() ||
      !archiveStats.isFile() ||
      archiveStats.isSymbolicLink() ||
      originalStats.dev !== archiveStats.dev ||
      originalStats.ino !== archiveStats.ino
    ) {
      throw this.invalid(
        resultPath,
        "stale Review result changed before recovery unlink",
      );
    }
    await this.unlinkIfPresent(resultPath);
    return receipt;
  }

  async reconcileConnectedRuns(): Promise<ConnectedRunRecordV2[]> {
    await this.readManifest();
    const connectedRunsDirectory = join(
      this.founderDirectory,
      CONNECTED_RUNS_DIRECTORY,
    );
    if (!(await this.hasSafeDirectory(connectedRunsDirectory))) {
      return [];
    }

    const reconciled: ConnectedRunRecordV2[] = [];
    const itemEntries = await readdir(connectedRunsDirectory, {
      withFileTypes: true,
    });
    for (const itemEntry of itemEntries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const itemPath = join(connectedRunsDirectory, itemEntry.name);
      if (
        !itemEntry.isDirectory() ||
        itemEntry.isSymbolicLink() ||
        !workItemIdSchema.safeParse(itemEntry.name).success
      ) {
        throw this.invalid(
          itemPath,
          "connected-runs entries must be regular work-item directories",
        );
      }
      reconciled.push(
        ...(await this.reconcileConnectedRunItem(itemEntry.name, itemPath)),
      );
    }
    return reconciled;
  }

  async createShapingRun(
    input: ShapingRunCreateInput,
  ): Promise<ShapingRunCreateResult> {
    const mission = shapingMissionPackageSchema.parse(input.mission);
    const shapingRunId = controllerRunIdSchema.parse(
      input.record.shaping_run_id,
    );
    const workItemId = workItemIdSchema.parse(
      input.record.mission.work_item_id,
    );

    await this.readManifest();
    if (
      !(await this.hasSafeWorkItemsDirectory()) ||
      (await this.readValidated(workItemId)) === null
    ) {
      throw new ControllerConflictError(
        "work_item_not_found",
        workItemId,
        `Work item ${workItemId} was not found.`,
      );
    }

    const snapshot = await this.readShapingPackageSnapshot(mission.identity);
    if (JSON.stringify(snapshot.mission) !== JSON.stringify(mission)) {
      throw this.invalid(
        snapshot.missionDirectory,
        "shaping run must reference the stored immutable mission",
      );
    }
    const instruction = this.buildShapingIngressInstruction(
      "connected_run",
      shapingRunId,
      snapshot,
      input.record.lifecycle.started_at,
    );
    const record = shapingRunRecordV1Schema.parse({
      ...input.record,
      shaping_run_id: shapingRunId,
      write_policy: this.shapingRunWritePolicy(instruction),
    });
    this.assertShapingRunMissionMatchesPackage(record, mission);
    if (
      record.lifecycle.status !== "starting" ||
      record.process !== null
    ) {
      throw new ControllerConflictError(
        "invalid_transition",
        workItemId,
        "A new shaping run must be starting without a process identity.",
      );
    }
    const requestedModel = record.provenance.requested_model.value;
    if (requestedModel === null) {
      throw new ControllerConflictError(
        "mission_not_ready",
        workItemId,
        "A connected shaping run requires a requested model.",
      );
    }
    if ((await this.readAppliedShapingBundle(snapshot)) !== null) {
      throw this.missionNotReady(
        workItemId,
        "This shaping mission revision already has an applied result.",
      );
    }

    const itemDirectory = await this.ensureShapingRunItemDirectory(
      workItemId,
    );
    const existingNonterminalRuns = (
      await this.readShapingRunsFromItemDirectory(workItemId, itemDirectory)
    ).filter((existing) => existing.lifecycle.status !== "terminal");
    if (existingNonterminalRuns.length > 1) {
      throw this.invalid(
        itemDirectory,
        "only one nonterminal shaping run may exist per work item",
      );
    }
    const launchFingerprint = shapingRunLaunchFingerprint(
      record.mission.content_sha256,
      requestedModel,
    );
    const existingNonterminalRun = existingNonterminalRuns[0];
    if (existingNonterminalRun !== undefined) {
      if (
        this.shapingRunFingerprint(existingNonterminalRun) ===
        launchFingerprint
      ) {
        return {
          record: existingNonterminalRun,
          instruction: await this.readShapingRunInstructionForRecord(
            existingNonterminalRun,
          ),
          created: false,
        };
      }
      throw new ControllerConflictError(
        "lease_held",
        workItemId,
        "A different shaping run is already active for this work item.",
      );
    }

    const guard = shapingRunLaunchGuardSchema.parse({
      schema_version: 1,
      work_item_id: workItemId,
      shaping_run_id: shapingRunId,
      launch_fingerprint: launchFingerprint,
      record,
      instruction,
      created_at: instruction.created_at,
    });
    const guardPath = join(
      itemDirectory,
      SHAPING_RUN_LAUNCH_GUARD_FILE,
    );
    try {
      await writeFile(guardPath, `${JSON.stringify(guard, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        return this.resolveExistingShapingRunLaunch(record);
      }
      throw error;
    }

    try {
      await this.publishShapingRunDirectory(record, instruction);
      return { record, instruction, created: true };
    } catch (error) {
      try {
        await this.releaseShapingRunGuard(guard);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Shaping run creation failed and its launch guard could not be released",
        );
      }
      throw error;
    }
  }

  async readShapingRun(
    workItemId: string,
    shapingRunId: string,
  ): Promise<ShapingRunRecordV1 | null> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const validatedRunId = controllerRunIdSchema.parse(shapingRunId);
    await this.readManifest();
    const shapingRunsDirectory = join(
      this.founderDirectory,
      SHAPING_RUNS_DIRECTORY,
    );
    if (!(await this.hasSafeDirectory(shapingRunsDirectory))) {
      return null;
    }
    const itemDirectory = join(
      shapingRunsDirectory,
      validatedWorkItemId,
    );
    if (!(await this.hasSafeDirectory(itemDirectory))) {
      return null;
    }
    return this.readShapingRunFromDirectory(
      validatedWorkItemId,
      validatedRunId,
      itemDirectory,
    );
  }

  async listShapingRuns(workItemId: string): Promise<ShapingRunRecordV1[]> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    await this.readManifest();
    const shapingRunsDirectory = join(
      this.founderDirectory,
      SHAPING_RUNS_DIRECTORY,
    );
    if (!(await this.hasSafeDirectory(shapingRunsDirectory))) {
      return [];
    }
    const itemDirectory = join(
      shapingRunsDirectory,
      validatedWorkItemId,
    );
    if (!(await this.hasSafeDirectory(itemDirectory))) {
      return [];
    }
    return this.readShapingRunsFromItemDirectory(
      validatedWorkItemId,
      itemDirectory,
    );
  }

  async readShapingRunInstruction(
    workItemId: string,
    shapingRunId: string,
  ): Promise<ShapingIngressInstructionV1> {
    const record = await this.requireShapingRun(
      workItemIdSchema.parse(workItemId),
      controllerRunIdSchema.parse(shapingRunId),
    );
    return this.readShapingRunInstructionForRecord(record);
  }

  async startShapingRun(
    workItemId: string,
    shapingRunId: string,
    processIdentity: ConnectedRunProcessIdentity,
  ): Promise<ShapingRunRecordV1> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const validatedRunId = controllerRunIdSchema.parse(shapingRunId);
    const validatedProcess = connectedRunProcessIdentitySchema.parse(
      processIdentity,
    );
    const record = await this.requireShapingRun(
      validatedWorkItemId,
      validatedRunId,
    );
    if (record.lifecycle.status === "terminal") {
      throw new ControllerConflictError(
        "invalid_transition",
        validatedWorkItemId,
        "A terminal shaping run cannot acquire a process identity.",
      );
    }
    await this.readShapingRunInstructionForRecord(record);

    const paths = this.shapingRunPaths(validatedWorkItemId, validatedRunId);
    const storedProcess = await this.readShapingRunProcess(paths.process);
    if (
      storedProcess !== null &&
      JSON.stringify(storedProcess) !== JSON.stringify(validatedProcess)
    ) {
      throw this.invalid(
        paths.process,
        "shaping process identity is immutable once recorded",
      );
    }
    const updated = shapingRunRecordV1Schema.parse({
      ...record,
      lifecycle: {
        ...record.lifecycle,
        status: "running",
        updated_at: timestampAtOrAfter(
          record.lifecycle.updated_at,
          validatedProcess.started_at,
        ),
      },
      process: validatedProcess,
    });
    if (record.lifecycle.status === "running") {
      if (
        JSON.stringify(record.process) !== JSON.stringify(updated.process)
      ) {
        throw this.invalid(
          paths.run,
          "running shaping process identity is immutable",
        );
      }
      return record;
    }

    await this.writeJsonAtomically(paths.process, validatedProcess);
    await this.writeJsonAtomically(paths.run, updated);
    return updated;
  }

  async updateShapingRunEffectiveModel(
    workItemId: string,
    shapingRunId: string,
    effectiveModel: Extract<
      EffectiveModelIdentity,
      { assurance: "adapter_attested" }
    >,
    signal?: AbortSignal,
  ): Promise<ShapingRunRecordV1> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const validatedRunId = controllerRunIdSchema.parse(shapingRunId);
    const validatedEffectiveModel = effectiveModelIdentitySchema.parse(
      effectiveModel,
    );
    if (abortWasRequested(signal)) {
      throw new ControllerConflictError(
        "invalid_transition",
        validatedWorkItemId,
        "Shaping-run model observation was interrupted.",
      );
    }
    if (validatedEffectiveModel.assurance !== "adapter_attested") {
      throw new ControllerConflictError(
        "invalid_transition",
        validatedWorkItemId,
        "A shaping run effective model must be adapter-attested.",
      );
    }
    const record = await this.requireShapingRun(
      validatedWorkItemId,
      validatedRunId,
    );
    if (
      isDeepStrictEqual(
        record.provenance.effective_model,
        validatedEffectiveModel,
      )
    ) {
      return record;
    }
    if (record.lifecycle.status === "terminal") {
      throw new ControllerConflictError(
        "idempotency_conflict",
        validatedWorkItemId,
        "A terminal shaping run cannot record a different effective model.",
      );
    }
    if (record.lifecycle.status !== "running") {
      throw new ControllerConflictError(
        "invalid_transition",
        validatedWorkItemId,
        "A shaping run must be running before it records an effective model.",
      );
    }

    const updated = shapingRunRecordV1Schema.parse({
      ...record,
      provenance: {
        ...record.provenance,
        effective_model: validatedEffectiveModel,
      },
    });
    await this.writeJsonAtomicallyAbortable(
      this.shapingRunPaths(validatedWorkItemId, validatedRunId).run,
      updated,
      signal,
    );
    return updated;
  }

  async completeShapingRun(
    workItemId: string,
    shapingRunId: string,
    terminal: ConnectedRunTerminal,
  ): Promise<ShapingRunRecordV1> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const validatedRunId = controllerRunIdSchema.parse(shapingRunId);
    const validatedTerminal = connectedRunTerminalSchema.parse(terminal);
    let record = await this.requireShapingRunForCompletion(
      validatedWorkItemId,
      validatedRunId,
    );
    if (record.lifecycle.status === "terminal") {
      if (
        JSON.stringify(record.lifecycle.terminal) !==
        JSON.stringify(validatedTerminal)
      ) {
        throw new ControllerConflictError(
          "idempotency_conflict",
          validatedWorkItemId,
          "A terminal shaping run cannot be completed with a different outcome.",
        );
      }
      return record;
    }

    if (validatedTerminal.outcome === "completed") {
      const snapshot = await this.readShapingPackageSnapshot({
        phase: record.mission.phase,
        work_item_id: record.mission.work_item_id,
        input_sha256: record.mission.input_sha256,
      });
      this.assertShapingRunMissionMatchesPackage(record, snapshot.mission);
      try {
        const instruction = await this.readShapingRunInstructionForRecord(
          record,
        );
        await this.publishAppliedShapingResult(
          instruction,
          snapshot.mission,
          {
            origin: "connected_run",
            shaping_run_id: record.shaping_run_id,
            requested_model: record.provenance.requested_model,
            effective_model: record.provenance.effective_model,
          },
        );
      } catch (error) {
        const applied = await this.readAppliedShapingBundle(snapshot);
        if (applied !== null) {
          throw error;
        }
        if (this.isShapingOutputRejection(error)) {
          await this.failShapingRunAfterRejectedOutput(record);
        }
        throw error;
      }
    }

    if (
      ["missing_permission", "failed", "timed_out"].includes(
        validatedTerminal.outcome,
      )
    ) {
      const entries = [...record.diagnostics.entries];
      let truncated = record.diagnostics.truncated;
      if (entries.length < 20) {
        entries.push({
          observed_at: timestampAtOrAfter(record.lifecycle.updated_at),
          code: `shaping_${validatedTerminal.outcome}`,
          message:
            truncateUtf8(
              validatedTerminal.reason ??
                "The artifact-only shaping runtime did not complete.",
              500,
            ) || "The artifact-only shaping runtime did not complete.",
        });
      } else {
        truncated = true;
      }
      record = shapingRunRecordV1Schema.parse({
        ...record,
        diagnostics: { entries, truncated },
      });
    }

    return this.terminalizeShapingRun(record, validatedTerminal);
  }

  async appendShapingRunEvent(
    workItemId: string,
    shapingRunId: string,
    event: unknown,
    signal?: AbortSignal,
  ): Promise<ShapingRunEventAppendResult> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const validatedRunId = controllerRunIdSchema.parse(shapingRunId);
    if (abortWasRequested(signal)) {
      throw new ControllerConflictError(
        "invalid_transition",
        validatedWorkItemId,
        "Shaping-run event append was interrupted.",
      );
    }
    const paths = this.shapingRunPaths(validatedWorkItemId, validatedRunId);
    const eventLockPath = join(paths.directory, SHAPING_RUN_EVENTS_LOCK_FILE);
    try {
      await writeFile(eventLockPath, `${validatedRunId}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new ControllerConflictError(
          "lease_held",
          validatedWorkItemId,
          "Another event append is already in progress for this shaping run.",
        );
      }
      throw error;
    }

    try {
      const record = await this.requireShapingRun(
        validatedWorkItemId,
        validatedRunId,
      );
      if (record.lifecycle.status === "terminal") {
        throw new ControllerConflictError(
          "invalid_transition",
          validatedWorkItemId,
          "A terminal shaping run cannot accept new events.",
        );
      }
      const stats = await this.readShapingRunEventStats(paths.events);
      const maxStringBytes = Math.min(
        record.limits.max_output_bytes,
        record.limits.max_event_bytes,
      );
      const sanitized = sanitizeConnectedRunEvent(event, maxStringBytes);
      const line = `${JSON.stringify(sanitized)}\n`;
      const lineBytes = Buffer.byteLength(line, "utf8");
      const limitReached =
        stats.event_count + 1 > record.limits.max_event_count ||
        stats.event_bytes + lineBytes > record.limits.max_event_bytes;
      if (limitReached) {
        return { appended: false, limit_reached: true, ...stats };
      }
      if (abortWasRequested(signal)) {
        throw new ControllerConflictError(
          "invalid_transition",
          validatedWorkItemId,
          "Shaping-run event append was interrupted.",
        );
      }
      appendFileSync(paths.events, line, "utf8");
      return {
        appended: true,
        limit_reached: false,
        event_count: stats.event_count + 1,
        event_bytes: stats.event_bytes + lineBytes,
      };
    } finally {
      unlinkFileSyncIfPresent(eventLockPath);
    }
  }

  async reconcileShapingRuns(): Promise<ShapingRunRecordV1[]> {
    await this.readManifest();
    const shapingRunsDirectory = join(
      this.founderDirectory,
      SHAPING_RUNS_DIRECTORY,
    );
    if (!(await this.hasSafeDirectory(shapingRunsDirectory))) {
      return [];
    }

    const reconciled: ShapingRunRecordV1[] = [];
    const itemEntries = await readdir(shapingRunsDirectory, {
      withFileTypes: true,
    });
    for (const itemEntry of itemEntries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const itemPath = join(shapingRunsDirectory, itemEntry.name);
      if (
        !itemEntry.isDirectory() ||
        itemEntry.isSymbolicLink() ||
        !workItemIdSchema.safeParse(itemEntry.name).success
      ) {
        throw this.invalid(
          itemPath,
          "shaping-runs entries must be regular work-item directories",
        );
      }
      reconciled.push(
        ...(await this.reconcileShapingRunItem(itemEntry.name, itemPath)),
      );
    }
    return reconciled;
  }

  async readManifest(): Promise<ProductManifest> {
    await this.assertDirectory(this.founderDirectory);

    const manifestPath = join(this.founderDirectory, "product.yaml");
    const source = await this.readRequiredFile(manifestPath);

    return this.parseYaml(source, manifestPath, productManifestSchema);
  }

  async create(input: CreateWorkItemInput): Promise<WorkItem> {
    const validatedInput = createWorkItemInputSchema.parse(input);

    return this.createItem({
      title: validatedInput.title,
      type: validatedInput.type,
    });
  }

  async createCapture(input: CreateCaptureInput): Promise<WorkItem> {
    const validatedInput = createCaptureInputSchema.parse(input);
    const capturedAt = new Date().toISOString();

    return this.createItem({
      title: validatedInput.title,
      capture: {
        kind: validatedInput.capture_kind,
        original_title: validatedInput.title,
        captured_at: capturedAt,
      },
      ...(validatedInput.priority === undefined
        ? {}
        : { priority: validatedInput.priority }),
      ...(validatedInput.tags === undefined
        ? {}
        : { tags: validatedInput.tags }),
      ...(validatedInput.notes === undefined
        ? {}
        : { notes: validatedInput.notes }),
    });
  }

  private async createItem(
    goalFields: Omit<WorkItemGoal, "schema_version" | "work_item_id">,
  ): Promise<WorkItem> {
    await this.readManifest();
    await this.ensureWorkItemsDirectory();

    const workItemDirectory = await this.allocateWorkItemDirectory();
    const workItemId = workItemDirectory.slice(
      workItemDirectory.lastIndexOf(sep) + 1,
    );

    const item = workItemSchema.parse({
      goal: {
        schema_version: 2,
        work_item_id: workItemId,
        ...goalFields,
      },
      state: {
        schema_version: 2,
        work_item_id: workItemId,
        phase: "idea",
        status: "active",
        updated_at: new Date().toISOString(),
      },
    });

    await this.writeAtomically(workItemDirectory, item.goal, item.state);

    return item;
  }

  async read(workItemId: string): Promise<WorkItem | null> {
    const validatedId = workItemIdSchema.parse(workItemId);
    await this.readManifest();
    if (!(await this.hasSafeWorkItemsDirectory())) {
      return null;
    }
    return this.readValidated(validatedId);
  }

  async list(): Promise<WorkItem[]> {
    await this.readManifest();
    if (!(await this.hasSafeWorkItemsDirectory())) {
      return [];
    }

    let entries;
    try {
      entries = await readdir(this.workItemsDirectory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const items: WorkItem[] = [];
    for (const entry of entries) {
      const entryPath = join(this.workItemsDirectory, entry.name);

      if (entry.isDirectory() && STAGING_DIRECTORY_PATTERN.test(entry.name)) {
        continue;
      }

      if (!entry.isDirectory()) {
        throw this.invalid(
          entryPath,
          "work-item entry must be a directory",
        );
      }

      const idResult = workItemIdSchema.safeParse(entry.name);
      if (!idResult.success) {
        throw this.invalid(entryPath, validationReason(idResult));
      }

      const item = await this.readValidated(idResult.data);
      if (item === null) {
        throw this.invalid(entryPath, "work-item directory disappeared during scan");
      }
      items.push(item);
    }

    return items.sort(
      (left, right) =>
        right.state.updated_at.localeCompare(left.state.updated_at) ||
        left.goal.work_item_id.localeCompare(right.goal.work_item_id),
    );
  }

  async updateGoal(
    workItemId: string,
    nextGoal: WorkItemGoal,
  ): Promise<WorkItem | null> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const validatedGoal = workItemGoalSchema.parse(nextGoal);

    await this.readManifest();
    if (!(await this.hasSafeWorkItemsDirectory())) {
      return null;
    }

    const current = await this.readValidated(validatedId);
    if (current === null) {
      return null;
    }

    const goalPath = join(this.workItemsDirectory, validatedId, GOAL_FILE);
    if (validatedGoal.work_item_id !== validatedId) {
      throw this.invalid(
        goalPath,
        `work_item_id must remain ${validatedId}`,
      );
    }
    if (
      JSON.stringify(validatedGoal.capture) !==
      JSON.stringify(current.goal.capture)
    ) {
      throw this.invalid(goalPath, "capture provenance must not change");
    }

    const itemResult = workItemSchema.safeParse({
      goal: validatedGoal,
      state: current.state,
    });
    if (!itemResult.success) {
      throw this.invalid(
        join(this.workItemsDirectory, validatedId),
        validationReason(itemResult),
      );
    }

    await this.replaceGoalAtomically(validatedId, itemResult.data.goal);
    return itemResult.data;
  }

  async updatePhase(
    workItemId: string,
    input: UpdateWorkItemPhaseInput,
  ): Promise<WorkItem | null> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const validatedInput = updateWorkItemPhaseInputSchema.parse(input);

    await this.readManifest();
    if (!(await this.hasSafeWorkItemsDirectory())) {
      return null;
    }

    const current = await this.readValidated(validatedId);
    if (current === null) {
      return null;
    }

    const currentTimestamp = Date.parse(current.state.updated_at);
    const updatedAt = new Date(
      Math.max(Date.now(), currentTimestamp + 1),
    ).toISOString();
    const state = workItemStateSchema.parse({
      ...current.state,
      phase: validatedInput.target_phase,
      updated_at: updatedAt,
    });
    const itemResult = workItemSchema.safeParse({ goal: current.goal, state });

    if (!itemResult.success) {
      throw this.invalid(
        join(this.workItemsDirectory, validatedId),
        validationReason(itemResult),
      );
    }

    await this.replaceStateAtomically(validatedId, itemResult.data.state);
    return itemResult.data;
  }

  async hasWorkItem(workItemId: string): Promise<boolean> {
    const validatedId = workItemIdSchema.parse(workItemId);
    await this.readManifest();
    if (!(await this.hasSafeWorkItemsDirectory())) {
      return false;
    }

    const workItemDirectory = join(this.workItemsDirectory, validatedId);
    let stats;
    try {
      stats = await lstat(workItemDirectory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }

    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw this.invalid(workItemDirectory, "work-item path must be a directory");
    }
    return true;
  }

  async stageIncomingWorkItem(
    item: WorkItem,
    manifest?: ControllerRunManifest,
  ): Promise<string> {
    const validatedItem = workItemSchema.parse(item);
    const validatedManifest =
      manifest === undefined
        ? undefined
        : controllerRunManifestSchema.parse(manifest);
    this.validateIncomingControllerManifest(
      validatedItem,
      validatedManifest,
      join(this.workItemsDirectory, validatedItem.goal.work_item_id),
    );
    await this.readManifest();
    await this.ensureWorkItemsDirectory();
    await this.assertWorkItemAbsent(validatedItem.goal.work_item_id);

    const stagingPath = join(
      this.workItemsDirectory,
      `.${validatedItem.goal.work_item_id}.${randomUUID()}.staging`,
    );
    await mkdir(stagingPath);

    try {
      await this.writeAtomically(
        stagingPath,
        validatedItem.goal,
        validatedItem.state,
      );
      if (validatedManifest !== undefined) {
        await this.writeControllerRunManifestToDirectory(
          stagingPath,
          validatedManifest,
        );
      }
    } catch (error) {
      try {
        await rm(stagingPath, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Staging failed and its temporary directory could not be removed",
        );
      }
      throw error;
    }

    return stagingPath;
  }

  async publishStagedWorkItem(
    workItemId: string,
    stagingPath: string,
  ): Promise<void> {
    const validatedId = workItemIdSchema.parse(workItemId);
    await this.readManifest();
    await this.ensureWorkItemsDirectory();
    const validatedStagingPath = await this.validateStagingDirectory(
      validatedId,
      stagingPath,
    );
    const stagedItem = await this.readValidatedDirectory(
      validatedStagingPath,
      validatedId,
    );
    const stagedManifest = await this.readStagedControllerManifest(
      validatedStagingPath,
      validatedId,
    );
    this.validateIncomingControllerManifest(
      stagedItem,
      stagedManifest,
      validatedStagingPath,
    );
    await this.assertWorkItemAbsent(validatedId);

    const targetPath = join(this.workItemsDirectory, validatedId);
    try {
      await rename(validatedStagingPath, targetPath);
    } catch (error) {
      if (
        isNodeError(error) &&
        ["EEXIST", "ENOTEMPTY"].includes(error.code ?? "")
      ) {
        throw this.invalid(targetPath, "target work-item already exists");
      }
      throw error;
    }
  }

  async discardStagedWorkItem(
    workItemId: string,
    stagingPath: string,
  ): Promise<void> {
    const validatedId = workItemIdSchema.parse(workItemId);
    await this.readManifest();
    if (!(await this.hasSafeWorkItemsDirectory())) {
      return;
    }

    let validatedStagingPath: string;
    try {
      validatedStagingPath = await this.validateStagingDirectory(
        validatedId,
        stagingPath,
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      if (
        error instanceof InvalidWorkspaceError &&
        error.reason === "required directory is missing"
      ) {
        return;
      }
      throw error;
    }

    await rm(validatedStagingPath, { recursive: true });
  }

  async removeWorkItem(workItemId: string): Promise<void> {
    const validatedId = workItemIdSchema.parse(workItemId);
    await this.readManifest();
    if (!(await this.hasSafeWorkItemsDirectory())) {
      return;
    }

    const item = await this.readValidated(validatedId);
    if (item === null) {
      return;
    }

    await rm(join(this.workItemsDirectory, validatedId), { recursive: true });
  }

  async acquireControllerLease(
    workItemId: string,
    activeRun: ActiveRun,
  ): Promise<ControllerLease | null> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const validatedRun = activeRunSchema.parse(activeRun);

    await this.readManifest();
    if (!(await this.hasSafeWorkItemsDirectory())) {
      return null;
    }

    const workItemDirectory = join(this.workItemsDirectory, validatedId);
    const lockPath = join(workItemDirectory, CONTROLLER_LOCK_FILE);
    try {
      await writeFile(lockPath, `${JSON.stringify(validatedRun, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      if (isNodeError(error) && error.code === "EEXIST") {
        const retainedSource = await this.readRequiredFile(lockPath);
        const retainedRun = this.parseJson(
          retainedSource,
          lockPath,
          activeRunSchema,
        );
        throw new ControllerConflictError(
          "repair_required",
          validatedId,
          `Controller lock ${relative(
            this.workspaceRoot,
            lockPath,
          )} for work item ${validatedId} retains run ${retainedRun.run_id} acquired at ${retainedRun.acquired_at}; use repairRetainedControllerLease after confirming that run is no longer executing.`,
        );
      }
      throw error;
    }

    try {
      const current = await this.readValidated(validatedId);
      if (current === null) {
        await this.unlinkIfPresent(lockPath);
        return null;
      }
      if (current.state.active_run !== undefined) {
        const retainedRun = current.state.active_run;
        throw new ControllerConflictError(
          "repair_required",
          validatedId,
          `Controller state for work item ${validatedId} retains run ${retainedRun.run_id} acquired at ${retainedRun.acquired_at} while lock ${relative(
            this.workspaceRoot,
            lockPath,
          )} was unavailable; use repairRetainedControllerLease after confirming that run is no longer executing.`,
        );
      }

      const goalPath = join(workItemDirectory, GOAL_FILE);
      const statePath = join(workItemDirectory, STATE_FILE);
      const acquiredGoalBytes = await this.readRequiredFile(goalPath);
      let acquiredStateBytes = await this.readRequiredFile(statePath);
      const acquiredItem = this.parseReadableWorkItemBytes(
        acquiredGoalBytes,
        acquiredStateBytes,
        validatedId,
      );
      if (!isDeepStrictEqual(acquiredItem, current)) {
        throw new ControllerConflictError(
          "repair_required",
          validatedId,
          "Durable goal/state bytes changed while the controller lease was being acquired.",
        );
      }

      if (current.goal.goal_contract !== undefined) {
        const leasedState = workItemStateSchema.parse({
          ...current.state,
          active_run: validatedRun,
        });
        await this.replaceStateAtomically(validatedId, leasedState);
        acquiredStateBytes = `${JSON.stringify(leasedState, null, 2)}\n`;
      }

      return {
        work_item: current,
        active_run: validatedRun,
        acquired_goal_bytes: acquiredGoalBytes,
        acquired_state_bytes: acquiredStateBytes,
      };
    } catch (error) {
      try {
        await this.unlinkIfPresent(lockPath);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Controller lease acquisition failed and its lock could not be removed",
        );
      }
      throw error;
    }
  }

  async repairRetainedControllerLease(
    workItemId: string,
    input: { acknowledged_run_id: string },
  ): Promise<RetainedControllerLeaseRepairResult> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const acknowledgedRunId = controllerRunIdSchema.parse(
      input.acknowledged_run_id,
    );
    await this.readManifest();
    if (!(await this.hasSafeWorkItemsDirectory())) {
      throw new ControllerConflictError(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} does not exist.`,
      );
    }

    const current = await this.readValidated(validatedId);
    if (current === null) {
      throw new ControllerConflictError(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} does not exist.`,
      );
    }
    const lockPath = join(
      this.workItemsDirectory,
      validatedId,
      CONTROLLER_LOCK_FILE,
    );
    const lockSource = await this.readOptionalFile(lockPath);
    const lockRun =
      lockSource === null
        ? null
        : this.parseJson(lockSource, lockPath, activeRunSchema);
    const stateRun = current.state.active_run ?? null;

    if (lockRun === null && stateRun === null) {
      return {
        repaired: false,
        reason: "nothing_retained",
        retained_run: null,
      };
    }
    if (
      lockRun !== null &&
      stateRun !== null &&
      !this.activeRunsMatch(lockRun, stateRun)
    ) {
      throw new ControllerConflictError(
        "repair_required",
        validatedId,
        `Controller lock retains run ${lockRun.run_id} while state.active_run retains ${stateRun.run_id}; both were left intact.`,
      );
    }

    const retainedRun = lockRun ?? stateRun;
    if (retainedRun === null) {
      throw new Error("Retained controller repair lost both run records.");
    }
    if (retainedRun.run_id !== acknowledgedRunId) {
      throw new ControllerConflictError(
        "stale_expectation",
        validatedId,
        `Acknowledged run ${acknowledgedRunId} does not match retained run ${retainedRun.run_id}.`,
      );
    }

    if (stateRun !== null) {
      const releasedState = { ...current.state };
      delete releasedState.active_run;
      await this.replaceStateAtomically(
        validatedId,
        workItemStateSchema.parse(releasedState),
      );
      await this.afterRetainedControllerStateCleared();
    }
    if (lockRun !== null) {
      await unlink(lockPath);
    }
    return {
      repaired: true,
      reason: "repaired",
      retained_run: retainedRun,
    };
  }

  async readControllerRunManifest(
    workItemId: string,
    runId: string,
  ): Promise<ControllerRunManifest | null> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const validatedRunId = controllerRunIdSchema.parse(runId);

    await this.readManifest();
    if (!(await this.hasSafeWorkItemsDirectory())) {
      return null;
    }
    if ((await this.readValidated(validatedId)) === null) {
      return null;
    }

    const runsDirectory = join(
      this.workItemsDirectory,
      validatedId,
      RUNS_DIRECTORY,
    );
    if (!(await this.hasSafeDirectory(runsDirectory))) {
      return null;
    }

    const manifestPath = join(runsDirectory, `${validatedRunId}.json`);
    const source = await this.readOptionalFile(manifestPath);
    if (source === null) {
      return null;
    }

    return this.parseControllerRunManifest(
      source,
      manifestPath,
      validatedId,
      validatedRunId,
    );
  }

  async findAppliedExecuteManifest(
    identity: MissionIdentity<"execute">,
  ): Promise<ControllerRunManifest | null> {
    const validatedIdentity = missionIdentitySchema.parse(identity);
    if (validatedIdentity.phase !== "execute") {
      throw this.missionNotReady(
        validatedIdentity.work_item_id,
        "Applied execute manifest lookup requires execute identity.",
      );
    }
    await this.readManifest();
    if (!(await this.hasSafeWorkItemsDirectory())) {
      return null;
    }
    const current = await this.readValidated(validatedIdentity.work_item_id);
    if (current === null) {
      return null;
    }
    if (
      current.goal.goal_contract?.goal_version !==
        validatedIdentity.goal_version ||
      current.state.goal_version !== validatedIdentity.goal_version ||
      current.state.input_revision !== validatedIdentity.input_revision ||
      current.state.attempt !== validatedIdentity.attempt
    ) {
      return null;
    }

    const controllerMatches = (
      await this.readControllerRunManifests(validatedIdentity.work_item_id)
    ).filter(
      (manifest) =>
        manifest.phase === "execute" &&
        manifest.outcome === "applied" &&
        manifest.goal_version === validatedIdentity.goal_version &&
        manifest.input_revision === validatedIdentity.input_revision &&
        manifest.attempt === validatedIdentity.attempt &&
        !(
          manifest.command_authorization !== undefined &&
          manifest.capability_grant === undefined
        ),
    );

    const planApprovalMatches = (
      await this.readPlanApprovalManifests(validatedIdentity.work_item_id)
    ).filter(
      (manifest) =>
        manifest.outcome === "applied" &&
        manifest.execute_tuple.goal_version ===
          validatedIdentity.goal_version &&
        manifest.execute_tuple.input_revision ===
          validatedIdentity.input_revision &&
        manifest.execute_tuple.attempt === validatedIdentity.attempt,
    );

    if (planApprovalMatches.length > 1) {
      throw new ControllerConflictError(
        "mission_not_ready",
        validatedIdentity.work_item_id,
        "More than one applied Plan approval matches the governed Execute tuple.",
      );
    }
    const approval = planApprovalMatches[0];
    if (approval !== undefined) {
      if (approval.completed_at === undefined) {
        throw new ControllerConflictError(
          "repair_required",
          validatedIdentity.work_item_id,
          `Applied Plan approval ${approval.approval_id} is missing completed_at.`,
        );
      }
      const idempotencyKey = `${approval.work_item_id}:plan-approval:${approval.approval_id}`;
      return controllerRunManifestSchema.parse({
        schema_version: 1,
        run_id: deriveControllerRunId(idempotencyKey, "approve-plan-result"),
        work_item_id: approval.work_item_id,
        idempotency_key: idempotencyKey,
        phase: "execute",
        ...approval.execute_tuple,
        started_at: approval.started_at,
        completed_at: approval.completed_at,
        outcome: "applied",
      });
    }
    if (controllerMatches.length > 1) {
      throw new ControllerConflictError(
        "mission_not_ready",
        validatedIdentity.work_item_id,
        "More than one applied execute manifest matches the governed tuple.",
      );
    }
    return controllerMatches[0] ?? null;
  }

  async findAppliedPatchManifest(
    identity: MissionIdentity<"patch">,
  ): Promise<ControllerRunManifest | null> {
    const validatedIdentity = missionIdentitySchema.parse(identity);
    if (validatedIdentity.phase !== "patch") {
      throw this.missionNotReady(
        validatedIdentity.work_item_id,
        "Applied patch manifest lookup requires patch identity.",
      );
    }
    await this.readManifest();
    if (!(await this.hasSafeWorkItemsDirectory())) {
      return null;
    }
    const current = await this.readValidated(validatedIdentity.work_item_id);
    if (
      current === null ||
      current.goal.goal_contract?.goal_version !==
        validatedIdentity.goal_version ||
      current.state.phase !== "patch" ||
      current.state.status !== "active" ||
      current.state.goal_version !== validatedIdentity.goal_version ||
      current.state.input_revision !== validatedIdentity.input_revision ||
      current.state.attempt !== validatedIdentity.attempt ||
      current.state.patch_cycle !== validatedIdentity.patch_cycle
    ) {
      return null;
    }

    const matches = (
      await this.readControllerRunManifests(validatedIdentity.work_item_id)
    ).filter(
      (manifest) => {
        const idempotencyPrefix = [
          validatedIdentity.work_item_id,
          "patch",
          validatedIdentity.goal_version,
          validatedIdentity.input_revision,
          manifest.attempt,
          `cycle-${validatedIdentity.patch_cycle}`,
          "accept-plan",
          "",
        ].join(":");
        return (
          manifest.phase === "patch" &&
          manifest.outcome === "applied" &&
          manifest.goal_version === validatedIdentity.goal_version &&
          manifest.input_revision === validatedIdentity.input_revision &&
          manifest.attempt <= validatedIdentity.attempt &&
          manifest.idempotency_key.startsWith(idempotencyPrefix)
        );
      },
    );
    if (matches.length > 1) {
      throw new ControllerConflictError(
        "mission_not_ready",
        validatedIdentity.work_item_id,
        "More than one applied patch-plan manifest matches the governed cycle.",
      );
    }
    return matches[0] ?? null;
  }

  async findAppliedPatchAttemptManifest(
    identity: MissionIdentity<"patch">,
  ): Promise<ControllerRunManifest | null> {
    const validatedIdentity = missionIdentitySchema.parse(identity);
    if (validatedIdentity.phase !== "patch") {
      throw this.missionNotReady(
        validatedIdentity.work_item_id,
        "Applied patch-attempt manifest lookup requires patch identity.",
      );
    }
    await this.readManifest();
    if (!(await this.hasSafeWorkItemsDirectory())) {
      return null;
    }
    const current = await this.readValidated(validatedIdentity.work_item_id);
    if (
      current === null ||
      current.goal.goal_contract?.goal_version !==
        validatedIdentity.goal_version ||
      current.state.phase !== "patch" ||
      current.state.status !== "active" ||
      current.state.goal_version !== validatedIdentity.goal_version ||
      current.state.input_revision !== validatedIdentity.input_revision ||
      current.state.attempt !== validatedIdentity.attempt ||
      current.state.patch_cycle !== validatedIdentity.patch_cycle
    ) {
      return null;
    }
    const expectedIdempotencyKey = [
      validatedIdentity.work_item_id,
      "patch",
      validatedIdentity.goal_version,
      validatedIdentity.input_revision,
      validatedIdentity.attempt,
    ].join(":");
    const matches = (
      await this.readControllerRunManifests(validatedIdentity.work_item_id)
    ).filter(
      (manifest) =>
        manifest.phase === "patch" &&
        manifest.outcome === "applied" &&
        manifest.goal_version === validatedIdentity.goal_version &&
        manifest.input_revision === validatedIdentity.input_revision &&
        manifest.attempt === validatedIdentity.attempt &&
        manifest.idempotency_key === expectedIdempotencyKey,
    );
    return matches.sort(
      (left, right) =>
        (left.completed_at ?? left.started_at).localeCompare(
          right.completed_at ?? right.started_at,
        ) || left.run_id.localeCompare(right.run_id),
    )[0] ?? null;
  }

  async writeMissionPackage<TMission extends MissionPackage>(
    identity: MissionIdentity,
    buildPackage: MissionPackageBuilder<TMission>,
  ): Promise<MissionArtifactWriteResult<TMission>> {
    const validatedIdentity = missionIdentitySchema.parse(identity);
    await this.readManifest();
    if (!(await this.hasSafeWorkItemsDirectory())) {
      throw this.missionNotReady(
        validatedIdentity.work_item_id,
        "The source work item does not exist.",
      );
    }

    const current = await this.readValidated(validatedIdentity.work_item_id);
    if (current === null) {
      throw this.missionNotReady(
        validatedIdentity.work_item_id,
        "The source work item does not exist.",
      );
    }
    if (
      validatedIdentity.phase !== "execute" ||
      current.state.phase !== "execute" ||
      current.state.status !== "active" ||
      current.goal.goal_contract?.goal_version !==
        validatedIdentity.goal_version ||
      current.state.goal_version !== validatedIdentity.goal_version ||
      current.state.input_revision !== validatedIdentity.input_revision ||
      current.state.attempt !== validatedIdentity.attempt
    ) {
      throw this.missionNotReady(
        validatedIdentity.work_item_id,
        "The durable work item no longer matches the active execute tuple.",
      );
    }

    const paths = this.missionPaths(
      validatedIdentity,
      await this.governedTupleGitBaseCommit(validatedIdentity),
      undefined,
      await this.resolveGitBaseCommit(),
    );
    const mission = missionPackageSchema.parse(buildPackage(paths)) as TMission;
    if (
      JSON.stringify(mission.identity) !== JSON.stringify(validatedIdentity) ||
      mission.task_path !== paths.task_path ||
      mission.result_contract.output_path !== paths.output_path
    ) {
      throw this.invalid(
        this.founderDirectory,
        "compiled mission identity and paths must match the workspace-derived snapshot",
      );
    }

    return this.publishMissionSnapshot(validatedIdentity, mission);
  }

  async writeShapingMissionPackage(
    identity: ShapingIdentity,
    buildPackage: ShapingMissionPackageBuilder,
  ): Promise<ShapingArtifactWriteResult> {
    const validatedIdentity = shapingIdentitySchema.parse(identity);
    await this.readManifest();
    if (!(await this.hasSafeWorkItemsDirectory())) {
      throw this.missionNotReady(
        validatedIdentity.work_item_id,
        "The source work item does not exist.",
      );
    }

    const current = await this.readValidated(validatedIdentity.work_item_id);
    if (
      current === null ||
      current.state.phase !== validatedIdentity.phase ||
      current.state.status !== "active"
    ) {
      throw this.missionNotReady(
        validatedIdentity.work_item_id,
        "The durable work item no longer matches the active shaping phase.",
      );
    }

    const paths = this.shapingPaths(validatedIdentity);
    const mission = shapingMissionPackageSchema.parse(buildPackage(paths));
    if (
      JSON.stringify(mission.identity) !== JSON.stringify(validatedIdentity)
    ) {
      throw this.invalid(
        this.founderDirectory,
        "compiled shaping identity must match the workspace-derived snapshot",
      );
    }
    const goalInput = normalizeShapingGoalInput(current.goal);
    if (
      mission.input.title !== goalInput.title ||
      mission.input.notes !== goalInput.notes ||
      hashShapingInput(mission.input) !== validatedIdentity.input_sha256
    ) {
      throw this.missionNotReady(
        validatedIdentity.work_item_id,
        "The durable work item no longer matches the shaping mission input.",
      );
    }
    if (mission.identity.phase === "spec") {
      await this.assertSpecShapingSelection(
        specMissionPackageSchema.parse(mission),
      );
    }

    return this.publishShapingSnapshot(validatedIdentity, mission);
  }

  async readShapingMissionPackage(
    identity: ShapingIdentity,
  ): Promise<ShapingArtifactReadResult> {
    const validatedIdentity = shapingIdentitySchema.parse(identity);
    const snapshot = await this.readShapingPackageSnapshot(validatedIdentity);
    return {
      mission: snapshot.mission,
      mission_path: snapshot.relativeMissionPath,
    };
  }

  async readShapingResult(
    identity: ShapingIdentity,
  ): Promise<ShapingResultSnapshot> {
    const applied = await this.readAppliedShapingResult(identity);
    if (applied === null) {
      const validatedIdentity = shapingIdentitySchema.parse(identity);
      const snapshot = await this.readShapingPackageSnapshot(validatedIdentity);
      throw this.invalid(
        join(snapshot.missionDirectory, APPLIED_DIRECTORY),
        "required applied shaping result is missing",
      );
    }
    return applied;
  }

  async readAppliedShapingResult(
    identity: ShapingIdentity,
  ): Promise<ShapingResultSnapshot | null> {
    const validatedIdentity = shapingIdentitySchema.parse(identity);
    const snapshot = await this.readShapingPackageSnapshot(validatedIdentity);
    const stored = await this.readStoredShapingArtifact(snapshot);
    if (stored.result === null) {
      return null;
    }
    return {
      mission: snapshot.mission,
      mission_path: snapshot.relativeMissionPath,
      result_path: stored.result.result_path,
      result_source: stored.result.result_source,
    };
  }

  async writeShapingIngressInstruction(
    input: ShapingIngressInstructionWriteInput,
  ): Promise<ShapingIngressInstructionWriteResult> {
    const mission = shapingMissionPackageSchema.parse(input.mission);
    const snapshot = await this.readShapingPackageSnapshot(mission.identity);
    if (JSON.stringify(snapshot.mission) !== JSON.stringify(mission)) {
      throw this.invalid(
        snapshot.missionDirectory,
        "shaping ingress instruction must reference the stored immutable mission",
      );
    }

    const shapingRunId =
      input.origin === "connected_run"
        ? controllerRunIdSchema.parse(input.shaping_run_id)
        : null;
    const paths = this.shapingInstructionPaths({
      origin: input.origin,
      shaping_run_id: shapingRunId,
      identity: mission.identity,
    });
    const instructionIdentity = this.buildShapingIngressInstruction(
      input.origin,
      shapingRunId,
      snapshot,
      "1970-01-01T00:00:00.000Z",
    );

    const replay = await this.readMatchingShapingInstruction(
      paths.instructionPath,
      instructionIdentity.instruction_sha256,
      mission.identity.work_item_id,
    );
    if (replay !== null) {
      if (input.origin === "manual_import") {
        await this.assertShapingIngressFamilyRoot();
      }
      return replay;
    }

    await this.prepareShapingInstructionDirectory(
      input.origin,
      paths.instructionDirectory,
      paths.ingressDirectory,
      mission.identity.work_item_id,
      shapingRunId,
    );

    const instruction = this.buildShapingIngressInstruction(
      input.origin,
      shapingRunId,
      snapshot,
      new Date().toISOString(),
    );
    const instructionSource = `${JSON.stringify(instruction, null, 2)}\n`;
    try {
      await writeFile(paths.instructionPath, instructionSource, {
        encoding: "utf8",
        flag: "wx",
      });
      await this.afterShapingIngressInstructionWritten(
        paths.instructionPath,
      );
      return {
        instruction,
        instruction_path: paths.instructionPath,
        instruction_source: instructionSource,
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        const racedReplay = await this.readMatchingShapingInstruction(
          paths.instructionPath,
          instruction.instruction_sha256,
          mission.identity.work_item_id,
        );
        if (racedReplay !== null) {
          return racedReplay;
        }
      }
      throw error;
    }
  }

  async writeShapingAcpTextFile(
    instructionInput: ShapingIngressInstructionV1,
    requestedPath: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<{ written: boolean }> {
    const instruction = await this.readDurableShapingInstruction(
      instructionInput,
    );
    if (
      instruction.origin !== "connected_run" ||
      instruction.shaping_run_id === null
    ) {
      throw this.missionNotReady(
        instruction.work_item_id,
        "ACP shaping writes require a connected-run instruction.",
      );
    }
    const record = await this.requireShapingRun(
      instruction.work_item_id,
      instruction.shaping_run_id,
    );
    const runInstruction = await this.readShapingRunInstructionForRecord(
      record,
    );
    if (
      runInstruction.instruction_sha256 !== instruction.instruction_sha256
    ) {
      throw this.invalid(
        instruction.ingress_path,
        "ACP shaping write must match the run's durable instruction",
      );
    }
    if (record.lifecycle.status !== "running") {
      throw new ControllerConflictError(
        "invalid_transition",
        instruction.work_item_id,
        "ACP shaping writes require a running shaping run.",
      );
    }
    if (abortWasRequested(signal)) {
      throw this.missionNotReady(
        instruction.work_item_id,
        "ACP shaping write was interrupted before publication.",
      );
    }

    const ingressPath = join(
      this.workspaceRoot,
      ...instruction.ingress_path.split("/"),
    );
    if (
      !isAbsolute(requestedPath) ||
      resolve(requestedPath) !== ingressPath ||
      requestedPath !== ingressPath
    ) {
      throw this.missionNotReady(
        instruction.work_item_id,
        "ACP shaping write path does not match the exact ingress path.",
      );
    }
    const contentBytes = Buffer.from(content, "utf8");
    if (
      contentBytes.byteLength === 0 ||
      contentBytes.byteLength > instruction.max_result_bytes
    ) {
      throw this.missionNotReady(
        instruction.work_item_id,
        `ACP shaping write must contain 1-${instruction.max_result_bytes} bytes.`,
      );
    }
    await this.assertSafeShapingIngressParent(instruction.ingress_path);

    const stagingPath = `${ingressPath}.${randomUUID()}.acp-write.tmp`;
    let descriptor: number | null = null;
    let persistenceError: unknown = null;
    try {
      if (abortWasRequested(signal)) {
        throw new Error("ACP shaping write was interrupted before staging.");
      }
      descriptor = openSync(
        stagingPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(descriptor, contentBytes);
      fsyncSync(descriptor);
    } catch (error) {
      persistenceError = error;
    } finally {
      if (descriptor !== null) {
        try {
          closeSync(descriptor);
        } catch (error) {
          persistenceError ??= error;
        }
      }
    }
    if (persistenceError !== null) {
      const failure = this.missionNotReady(
        instruction.work_item_id,
        `ACP shaping write could not persist staging: ${errorMessage(persistenceError)}`,
      );
      try {
        unlinkFileSyncIfPresent(stagingPath);
      } catch (cleanupError) {
        throw new AggregateError(
          [failure, cleanupError],
          "ACP shaping staging write failed and its file could not be removed",
        );
      }
      throw failure;
    }
    await this.afterShapingAcpIngressStaged();

    let outcome: { written: boolean };
    try {
      if (abortWasRequested(signal)) {
        throw this.missionNotReady(
          instruction.work_item_id,
          "ACP shaping write was interrupted before publication.",
        );
      }
      try {
        linkSync(stagingPath, ingressPath);
        outcome = { written: true };
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw this.missionNotReady(
            instruction.work_item_id,
            `ACP shaping write could not publish ingress: ${errorMessage(error)}`,
          );
        }
        const existing = await this.readShapingIngressBytes(instruction);
        if (!existing.equals(contentBytes)) {
          throw new ControllerConflictError(
            "idempotency_conflict",
            instruction.work_item_id,
            "Existing shaping ingress bytes differ from the ACP write replay.",
          );
        }
        outcome = { written: false };
      }
    } catch (error) {
      try {
        unlinkFileSyncIfPresent(stagingPath);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "ACP shaping ingress publication failed and its staging file could not be removed",
        );
      }
      throw error;
    }
    try {
      unlinkFileSyncIfPresent(stagingPath);
    } catch (error) {
      throw this.missionNotReady(
        instruction.work_item_id,
        `ACP shaping write could not remove staging: ${errorMessage(error)}`,
      );
    }
    return outcome;
  }

  async readShapingIngressBytes(
    instruction: ShapingIngressInstructionV1,
  ): Promise<Buffer> {
    const durableInstruction = await this.readDurableShapingInstruction(
      instruction,
    );
    const ingressPath = join(
      this.workspaceRoot,
      ...durableInstruction.ingress_path.split("/"),
    );

    try {
      await this.assertSafeShapingIngressParent(
        durableInstruction.ingress_path,
      );
    } catch (error) {
      if (
        error instanceof ControllerConflictError &&
        error.kind === "mission_not_ready"
      ) {
        throw error;
      }
      throw this.missionNotReady(
        durableInstruction.work_item_id,
        `Shaping ingress ${durableInstruction.ingress_path} is unreadable: ${errorMessage(error)}`,
      );
    }

    let handle;
    try {
      handle = await open(
        ingressPath,
        fsConstants.O_RDONLY |
          fsConstants.O_NOFOLLOW |
          fsConstants.O_NONBLOCK,
      );
    } catch (error) {
      throw this.missionNotReady(
        durableInstruction.work_item_id,
        `Shaping ingress ${durableInstruction.ingress_path} is unreadable: ${errorMessage(error)}`,
      );
    }

    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        throw this.missionNotReady(
          durableInstruction.work_item_id,
          `Shaping ingress ${durableInstruction.ingress_path} must be a regular file.`,
        );
      }
      if (stats.size === 0) {
        throw this.missionNotReady(
          durableInstruction.work_item_id,
          `Shaping ingress ${durableInstruction.ingress_path} must not be empty.`,
        );
      }

      await this.afterShapingIngressOpened(ingressPath);
      const bytes = Buffer.alloc(SHAPING_INGRESS_MAX_BYTES + 1);
      let byteLength = 0;
      while (byteLength < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          byteLength,
          bytes.length - byteLength,
          null,
        );
        if (bytesRead === 0) {
          break;
        }
        byteLength += bytesRead;
      }
      if (byteLength === SHAPING_INGRESS_MAX_BYTES + 1) {
        throw this.missionNotReady(
          durableInstruction.work_item_id,
          `Shaping ingress ${durableInstruction.ingress_path} exceeds ${SHAPING_INGRESS_MAX_BYTES} bytes.`,
        );
      }
      return Buffer.from(bytes.subarray(0, byteLength));
    } finally {
      await handle.close();
    }
  }

  async publishAppliedShapingResult(
    instruction: ShapingIngressInstructionV1,
    missionInput: ShapingMissionPackage,
    production: ShapingProductionInput,
  ): Promise<AppliedShapingBundleWriteResult> {
    const mission = shapingMissionPackageSchema.parse(missionInput);
    const snapshot = await this.readShapingPackageSnapshot(mission.identity);
    if (JSON.stringify(snapshot.mission) !== JSON.stringify(mission)) {
      throw this.invalid(
        snapshot.missionDirectory,
        "applied shaping publication must reference the stored immutable mission",
      );
    }
    const durableInstruction = await this.readDurableShapingInstruction(
      instruction,
    );
    this.assertShapingInstructionMatchesMission(
      durableInstruction,
      snapshot,
    );
    if (
      durableInstruction.origin !== production.origin ||
      durableInstruction.shaping_run_id !== production.shaping_run_id
    ) {
      throw this.invalid(
        durableInstruction.ingress_path,
        "shaping production origin must match the durable ingress instruction",
      );
    }

    const existing = await this.readAppliedShapingBundle(snapshot);
    const resultBytes = await this.readShapingIngressBytes(
      durableInstruction,
    );
    let resultSource: string;
    try {
      resultSource = new TextDecoder("utf-8", { fatal: true }).decode(
        resultBytes,
      );
    } catch (error) {
      throw this.invalid(
        durableInstruction.ingress_path,
        `shaping result must be valid UTF-8: ${errorMessage(error)}`,
      );
    }
    this.parseShapingResultForMission(
      resultSource,
      join(this.workspaceRoot, durableInstruction.ingress_path),
      mission,
    );
    const resultContentSha256 = this.hashArtifactSource(resultBytes);
    const importIdentity = {
      shaping_schema_version: 2 as const,
      identity: mission.identity,
      shaping_mission_content_sha256: mission.content_sha256,
      result_content_sha256: resultContentSha256,
      outcome: "applied" as const,
      reasons: [],
    };
    const productionIdentity =
      production.origin === "connected_run"
        ? {
            schema_version: 1 as const,
            production_id: production.shaping_run_id,
            origin: production.origin,
            shaping_run_id: production.shaping_run_id,
            requested_model: production.requested_model,
            effective_model: production.effective_model,
            ingress_path: durableInstruction.ingress_path,
            result_content_sha256: resultContentSha256,
          }
        : {
            schema_version: 1 as const,
            production_id: deriveManualShapingProductionId(
              mission.content_sha256,
              resultContentSha256,
            ),
            origin: production.origin,
            shaping_run_id: null,
            requested_model: {
              value: null,
              assurance: "unknown" as const,
            },
            effective_model: {
              assurance: "unknown" as const,
              model_id: null,
              deployment_id: null,
              observed_event_sha256: null,
            },
            ingress_path: durableInstruction.ingress_path,
            result_content_sha256: resultContentSha256,
          };

    if (existing !== null) {
      return this.assertAppliedShapingReplay(
        existing,
        mission,
        resultSource,
        importIdentity,
        productionIdentity,
      );
    }

    await this.removeStaleAppliedShapingStagingDirectories(snapshot);
    const firstPublishedAt = new Date().toISOString();
    const importReceipt = shapingImportReceiptSchema.parse({
      ...importIdentity,
      first_published_at: firstPublishedAt,
    });
    const productionReceipt = shapingProductionReceiptSchema.parse({
      ...productionIdentity,
      produced_at: firstPublishedAt,
    });
    const importSource = `${JSON.stringify(importReceipt, null, 2)}\n`;
    const productionSource = `${JSON.stringify(productionReceipt, null, 2)}\n`;
    const marker = shapingAppliedMarkerSchema.parse({
      schema_version: 1,
      mission_content_sha256: mission.content_sha256,
      result_content_sha256: resultContentSha256,
      component_sha256: {
        result: resultContentSha256,
        import: this.hashArtifactSource(importSource),
        production: this.hashArtifactSource(productionSource),
      },
      component_bytes: {
        result: resultBytes.byteLength,
        import: Buffer.byteLength(importSource),
        production: Buffer.byteLength(productionSource),
      },
      committed_at: firstPublishedAt,
    });
    const markerSource = `${JSON.stringify(marker, null, 2)}\n`;
    const stagingName =
      `.${mission.identity.phase}-${mission.identity.input_sha256}.${randomUUID()}.applied.staging`;
    if (!SHAPING_STAGING_DIRECTORY_PATTERN.test(stagingName)) {
      throw new Error("Generated applied shaping staging directory name is invalid.");
    }
    const stagingDirectory = join(
      snapshot.missionDirectory,
      "..",
      stagingName,
    );
    const appliedDirectory = join(
      snapshot.missionDirectory,
      APPLIED_DIRECTORY,
    );
    await mkdir(stagingDirectory);
    try {
      await writeFile(join(stagingDirectory, RESULT_JSON_FILE), resultBytes, {
        flag: "wx",
      });
      await this.afterShapingAppliedComponentWritten("result");
      await writeFile(join(stagingDirectory, IMPORT_JSON_FILE), importSource, {
        encoding: "utf8",
        flag: "wx",
      });
      await this.afterShapingAppliedComponentWritten("import");
      await writeFile(
        join(stagingDirectory, PRODUCTION_JSON_FILE),
        productionSource,
        { encoding: "utf8", flag: "wx" },
      );
      await this.afterShapingAppliedComponentWritten("production");
      await writeFile(join(stagingDirectory, APPLIED_JSON_FILE), markerSource, {
        encoding: "utf8",
        flag: "wx",
      });
      await this.afterShapingAppliedComponentWritten("applied");
      await rename(stagingDirectory, appliedDirectory);
      await this.afterShapingAppliedBundleRenamed();
    } catch (error) {
      await this.removeAppliedShapingStagingDirectory(
        stagingDirectory,
        error,
      );
      if (
        isNodeError(error) &&
        ["EEXIST", "ENOTEMPTY"].includes(error.code ?? "")
      ) {
        const raced = await this.readAppliedShapingBundle(snapshot);
        if (raced !== null) {
          return this.assertAppliedShapingReplay(
            raced,
            mission,
            resultSource,
            importIdentity,
            productionIdentity,
          );
        }
      }
      throw error;
    }

    const published = await this.readAppliedShapingBundle(snapshot);
    if (published === null) {
      throw new ControllerConflictError(
        "repair_required",
        mission.identity.work_item_id,
        "Applied shaping bundle rename completed without a readable bundle.",
      );
    }
    return this.assertAppliedShapingReplay(
      published,
      mission,
      resultSource,
      importIdentity,
      productionIdentity,
    );
  }

  async writeShapingImportReceipt(
    input: ShapingImportReceiptWriteInput,
  ): Promise<ShapingReceiptWriteResult<ShapingImportReceipt>> {
    const receipt = shapingImportReceiptSchema.parse(input.receipt);
    const snapshot = await this.readShapingPackageSnapshot(receipt.identity);
    const resultPath = join(snapshot.missionDirectory, RESULT_JSON_FILE);
    const storedResultSource = await this.readRequiredFile(resultPath);
    const resultContentSha256 = this.hashArtifactSource(storedResultSource);
    if (
      input.result_source !== storedResultSource ||
      receipt.result_content_sha256 !== resultContentSha256 ||
      receipt.shaping_mission_content_sha256 !==
        snapshot.mission.content_sha256 ||
      JSON.stringify(receipt.identity) !==
        JSON.stringify(snapshot.mission.identity)
    ) {
      throw this.invalid(
        snapshot.missionDirectory,
        "shaping import receipt does not match the immutable mission and result bytes",
      );
    }

    if (receipt.outcome === "applied") {
      const result = this.parseShapingResultForMission(
        storedResultSource,
        resultPath,
        snapshot.mission,
      );
      if (JSON.stringify(result.identity) !== JSON.stringify(receipt.identity)) {
        throw this.invalid(
          resultPath,
          "applied shaping result identity does not match its import receipt",
        );
      }
    }

    const receiptPath = join(snapshot.missionDirectory, IMPORT_JSON_FILE);
    const receiptSource = await this.writeImmutableShapingJson(
      receiptPath,
      receipt,
      "shaping import receipt",
    );
    return {
      receipt,
      receipt_path: receiptPath,
      receipt_content_sha256: this.hashArtifactSource(receiptSource),
    };
  }

  async writeShapingDecisionReceipt<
    TReceipt extends ShapingDecisionReceipt,
  >(
    input: TReceipt,
  ): Promise<ShapingReceiptWriteResult<TReceipt>> {
    const receipt = shapingDecisionReceiptSchema.parse(input) as TReceipt;
    const snapshot = await this.readShapingPackageSnapshot(receipt.identity);
    if (receipt.identity.phase !== snapshot.mission.identity.phase) {
      throw this.invalid(
        snapshot.missionDirectory,
        "shaping decision receipt phase must match its immutable mission",
      );
    }
    const stored = await this.readStoredShapingArtifact(snapshot);
    if (
      stored.result === null ||
      stored.import_receipt?.outcome !== "applied" ||
      JSON.stringify(receipt.identity) !==
        JSON.stringify(snapshot.mission.identity) ||
      receipt.mission_content_sha256 !== snapshot.mission.content_sha256 ||
      receipt.result_content_sha256 !==
        stored.result.result_content_sha256
    ) {
      throw this.invalid(
        snapshot.missionDirectory,
        "shaping decision must match one applied immutable result of its own phase",
      );
    }
    this.parseShapingResultForMission(
      stored.result.result_source,
      join(this.workspaceRoot, stored.result.result_path),
      snapshot.mission,
    );

    const decisionPath = join(
      snapshot.missionDirectory,
      DECISION_JSON_FILE,
    );
    const decisionSource = await this.writeImmutableShapingJson(
      decisionPath,
      receipt,
      "shaping decision receipt",
    );
    return {
      receipt,
      receipt_path: decisionPath,
      receipt_content_sha256: this.hashArtifactSource(decisionSource),
    };
  }

  async resolveCurrentMissionRevision(
    workItemId: string,
    phase: ShapingPhase,
  ): Promise<StoredShapingArtifact | null> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const validatedPhase = z.enum(SHAPING_PHASES).parse(phase);
    const artifacts = (await this.listShapingArtifacts(validatedWorkItemId))
      .filter((artifact) => artifact.mission.identity.phase === validatedPhase);
    if (artifacts.length === 0) {
      return null;
    }

    const byInputSha256 = new Map(
      artifacts.map((artifact) => [
        artifact.mission.identity.input_sha256,
        artifact,
      ]),
    );
    const superseded = new Set<string>();
    for (const artifact of artifacts) {
      const revision = artifact.mission.input.revision;
      if (revision === undefined) {
        continue;
      }
      const predecessor = byInputSha256.get(
        revision.supersedes_input_sha256,
      );
      if (predecessor === undefined) {
        throw new ControllerConflictError(
          "repair_required",
          validatedWorkItemId,
          `Shaping revision ${artifact.mission.identity.input_sha256} names missing predecessor ${revision.supersedes_input_sha256}.`,
        );
      }
      const predecessorOrdinal = predecessor.mission.input.revision?.ordinal ?? 0;
      if (revision.ordinal !== predecessorOrdinal + 1) {
        throw new ControllerConflictError(
          "repair_required",
          validatedWorkItemId,
          `Shaping revision ${artifact.mission.identity.input_sha256} has noncontiguous ordinal ${revision.ordinal}.`,
        );
      }
      if (
        predecessor.result === null ||
        predecessor.result.result_content_sha256 !==
          revision.superseded_result_sha256
      ) {
        throw new ControllerConflictError(
          "repair_required",
          validatedWorkItemId,
          `Shaping revision ${artifact.mission.identity.input_sha256} does not match its predecessor's applied result.`,
        );
      }
      superseded.add(revision.supersedes_input_sha256);
    }

    const tips = artifacts.filter(
      (artifact) =>
        !superseded.has(artifact.mission.identity.input_sha256),
    );
    if (tips.length !== 1) {
      throw new ControllerConflictError(
        "repair_required",
        validatedWorkItemId,
        `Shaping revision chain for ${validatedPhase} must have exactly one tip; found ${tips.length}.`,
      );
    }
    return tips[0];
  }

  async listShapingArtifacts(
    workItemId: string,
  ): Promise<StoredShapingArtifact[]> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    await this.readManifest();
    const workItemDirectory = join(
      this.founderDirectory,
      SHAPING_DIRECTORY,
      validatedWorkItemId,
    );
    if (!(await this.hasSafeDirectory(workItemDirectory))) {
      return [];
    }

    const artifacts: StoredShapingArtifact[] = [];
    const entries = await readdir(workItemDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const artifactDirectory = join(workItemDirectory, entry.name);
      if (SHAPING_STAGING_DIRECTORY_PATTERN.test(entry.name)) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw this.invalid(
            artifactDirectory,
            "shaping staging entry must be a regular directory",
          );
        }
        continue;
      }
      const match = /^(brainstorm|spec|plan)-([0-9a-f]{64})$/.exec(entry.name);
      if (match !== null) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw this.invalid(
            artifactDirectory,
            "shaping entries must be directories, not symlinks",
          );
        }
        const identity = shapingIdentitySchema.parse({
          phase: match[1],
          work_item_id: validatedWorkItemId,
          input_sha256: match[2],
        });
        const snapshot = await this.readShapingPackageSnapshot(identity);
        artifacts.push(await this.readStoredShapingArtifact(snapshot));
        continue;
      }
      if (/^\.?(brainstorm|spec|plan)-/.test(entry.name)) {
        throw this.invalid(
          artifactDirectory,
          "shaping directory must use <phase>-<input_sha256>",
        );
      }

      // This founder-browsable directory can contain harmless OS/editor files.
    }

    return artifacts.sort((left, right) =>
      left.mission.identity.phase === right.mission.identity.phase
        ? left.mission.identity.input_sha256.localeCompare(
            right.mission.identity.input_sha256,
          )
        : left.mission.identity.phase.localeCompare(
            right.mission.identity.phase,
          ),
    );
  }

  async readAppliedExecuteReviewSubject(
    identity: MissionIdentity<"execute">,
  ): Promise<AppliedExecuteReviewSubject> {
    const validatedIdentity = missionIdentitySchema.parse(identity);
    if (validatedIdentity.phase !== "execute") {
      throw this.missionNotReady(
        validatedIdentity.work_item_id,
        "Review subjects require execute identity.",
      );
    }

    const matches = (await this.listImportEvidence(validatedIdentity.work_item_id))
      .filter(
        (stored) =>
          stored.evidence.phase === "execute" &&
          stored.evidence.outcome === "applied" &&
          JSON.stringify(stored.evidence.identity) ===
            JSON.stringify(validatedIdentity),
      );
    if (matches.length !== 1) {
      throw this.missionNotReady(
        validatedIdentity.work_item_id,
        matches.length === 0
          ? "No applied execute import matches the governed tuple."
          : "More than one applied execute import matches the governed tuple.",
      );
    }

    const stored = matches[0];
    if (stored.evidence.phase !== "execute") {
      throw this.invalid(
        stored.summary.evidence_path,
        "applied execute subject has a non-execute evidence envelope",
      );
    }
    const evidence: ExecuteImportEvidenceEnvelope = stored.evidence;
    const controllerRun = await this.readControllerRunManifest(
      validatedIdentity.work_item_id,
      evidence.controller_run_id,
    );
    if (
      controllerRun === null ||
      controllerRun.phase !== "review" ||
      controllerRun.outcome !== "applied" ||
      controllerRun.goal_version !== validatedIdentity.goal_version ||
      controllerRun.input_revision !== validatedIdentity.input_revision ||
      controllerRun.attempt !== validatedIdentity.attempt
    ) {
      throw this.invalid(
        stored.summary.evidence_path,
        "applied execute evidence does not match its review transition controller run",
      );
    }
    const evidenceDirectory = this.evidenceDirectories(
      validatedIdentity,
      evidence.import_run_id,
    ).target;
    const submissionPath = join(evidenceDirectory, SUBMISSION_JSON_FILE);
    const submissionSource = await this.readRequiredFile(submissionPath);
    const submission = this.parseJson(
      submissionSource,
      submissionPath,
      executeExternalResultSubmissionSchema,
    );
    const missionSnapshot = await this.readMissionPackageSnapshot(
      validatedIdentity,
    );
    if ("review_subject" in missionSnapshot.mission) {
      throw this.invalid(
        missionSnapshot.missionPath,
        "execute evidence cannot bind to a review mission",
      );
    }
    if (
      missionSnapshot.mission.content_sha256 !==
        evidence.mission_content_sha256 ||
      missionScopeBaseCommit(missionSnapshot.mission.source_revision) !==
        evidence.git_base_commit ||
      submission.mission_content_sha256 !== evidence.mission_content_sha256 ||
      JSON.stringify(submission.identity) !==
        JSON.stringify(validatedIdentity) ||
      (submission.commit !== undefined &&
        submission.commit !== evidence.result_commit)
    ) {
      throw this.invalid(
        evidenceDirectory,
        "applied execute evidence is not bound to its immutable mission and submission",
      );
    }
    if (evidence.result_commit === null) {
      throw this.invalid(
        evidenceDirectory,
        "applied execute evidence requires an accepted result commit",
      );
    }
    const requiredCommands = (await this.readManifest()).verification
      .required_commands;
    if (
      stored.verification.length !== requiredCommands.length ||
      stored.verification.some(
        (record, index) =>
          record.name !== requiredCommands[index]?.name ||
          JSON.stringify(record.argv) !==
            JSON.stringify(requiredCommands[index]?.argv),
      )
    ) {
      throw this.invalid(
        evidenceDirectory,
        "applied execute evidence does not match the required command set",
      );
    }

    const reviewSubject = executeReviewSubjectSchema.parse({
      source: "execute",
      execute_mission_content_sha256: evidence.mission_content_sha256,
      execute_result_content_sha256: evidence.result_content_sha256,
      git_base_commit: evidence.git_base_commit,
      accepted_result_commit: evidence.result_commit,
      changed_files: [...submission.changed_files].sort(),
      execute_mission_path: missionSnapshot.relativeMissionPath,
      execute_evidence_path: stored.summary.evidence_path,
      command_evidence: stored.verification,
    });
    return {
      review_subject: reviewSubject,
      submission_source: submissionSource,
      evidence,
      verification: stored.verification,
    };
  }

  async readAppliedPatchReviewSubject(
    identity: MissionIdentity<"patch">,
  ): Promise<AppliedPatchReviewSubject> {
    const validatedIdentity = missionIdentitySchema.parse(identity);
    if (validatedIdentity.phase !== "patch") {
      throw this.missionNotReady(
        validatedIdentity.work_item_id,
        "Patch review subjects require patch identity.",
      );
    }

    const matches = (await this.listImportEvidence(validatedIdentity.work_item_id))
      .filter(
        (stored) =>
          stored.evidence.phase === "patch" &&
          stored.evidence.outcome === "applied" &&
          JSON.stringify(stored.evidence.identity) ===
            JSON.stringify(validatedIdentity),
      );
    if (matches.length !== 1) {
      throw this.missionNotReady(
        validatedIdentity.work_item_id,
        matches.length === 0
          ? "No applied patch import matches the governed tuple."
          : "More than one applied patch import matches the governed tuple.",
      );
    }

    const stored = matches[0];
    if (stored.evidence.phase !== "patch") {
      throw this.invalid(
        stored.summary.evidence_path,
        "applied patch subject has a non-patch evidence envelope",
      );
    }
    const evidence: PatchImportEvidenceEnvelope = stored.evidence;
    const controllerRun = await this.readControllerRunManifest(
      validatedIdentity.work_item_id,
      evidence.controller_run_id,
    );
    if (
      controllerRun === null ||
      controllerRun.phase !== "review" ||
      controllerRun.outcome !== "applied" ||
      controllerRun.goal_version !== validatedIdentity.goal_version ||
      controllerRun.input_revision !== validatedIdentity.input_revision ||
      controllerRun.attempt !== validatedIdentity.attempt
    ) {
      throw this.invalid(
        stored.summary.evidence_path,
        "applied patch evidence does not match its review transition controller run",
      );
    }
    const evidenceDirectory = this.evidenceDirectories(
      validatedIdentity,
      evidence.import_run_id,
    ).target;
    const submissionPath = join(evidenceDirectory, SUBMISSION_JSON_FILE);
    const submissionSource = await this.readRequiredFile(submissionPath);
    const submission = this.parseJson(
      submissionSource,
      submissionPath,
      patchExternalResultSubmissionSchema,
    );
    const missionSnapshot = await this.readMissionPackageSnapshot(
      validatedIdentity,
    );
    if (!("patch_subject" in missionSnapshot.mission)) {
      throw this.invalid(
        missionSnapshot.missionPath,
        "patch evidence must bind to a patch mission",
      );
    }
    if (
      missionSnapshot.mission.content_sha256 !==
        evidence.mission_content_sha256 ||
      missionScopeBaseCommit(missionSnapshot.mission.source_revision) !==
        evidence.git_base_commit ||
      submission.patch_mission_content_sha256 !==
        evidence.mission_content_sha256 ||
      JSON.stringify(submission.identity) !==
        JSON.stringify(validatedIdentity) ||
      submission.commit !== evidence.result_commit
    ) {
      throw this.invalid(
        evidenceDirectory,
        "applied patch evidence is not bound to its immutable mission and submission",
      );
    }
    const requiredCommands = (await this.readManifest()).verification
      .required_commands;
    if (
      stored.verification.length !== requiredCommands.length ||
      stored.verification.some(
        (record, index) =>
          record.name !== requiredCommands[index]?.name ||
          JSON.stringify(record.argv) !==
            JSON.stringify(requiredCommands[index]?.argv),
      )
    ) {
      throw this.invalid(
        evidenceDirectory,
        "applied patch evidence does not match the required command set",
      );
    }

    const reviewSubject = reviewSubjectSchema.parse({
      source: "patch",
      patch_cycle: validatedIdentity.patch_cycle,
      patch_mission_content_sha256: evidence.mission_content_sha256,
      patch_result_content_sha256: evidence.result_content_sha256,
      patch_mission_path: missionSnapshot.relativeMissionPath,
      patch_evidence_path: stored.summary.evidence_path,
      git_base_commit: evidence.git_base_commit,
      accepted_result_commit: evidence.result_commit,
      changed_files: [...submission.changed_files].sort(),
      command_evidence: stored.verification,
      resolved_from: {
        review_mission_content_sha256:
          missionSnapshot.mission.patch_subject
            .review_mission_content_sha256,
        review_result_content_sha256:
          missionSnapshot.mission.patch_subject.review_result_content_sha256,
        finding_ids: missionSnapshot.mission.patch_subject.findings.map(
          (finding) => finding.finding_id,
        ),
      },
    });
    if (reviewSubject.source !== "patch") {
      throw new Error("Patch subject parser returned an execute subject.");
    }
    return {
      review_subject: reviewSubject,
      submission_source: submissionSource,
      evidence,
      verification: stored.verification,
    };
  }

  async writePatchMissionPackage(
    identity: MissionIdentity<"patch">,
    patchSubject: PatchSubject,
    buildPackage: MissionPackageBuilder<PatchMissionPackage>,
  ): Promise<MissionArtifactWriteResult<PatchMissionPackage>> {
    const validatedIdentity = missionIdentitySchema.parse(identity);
    if (validatedIdentity.phase !== "patch") {
      throw this.missionNotReady(
        validatedIdentity.work_item_id,
        "Patch mission writes require patch identity.",
      );
    }
    await this.readManifest();
    const current = await this.readValidated(validatedIdentity.work_item_id);
    if (
      current === null ||
      current.state.phase !== "patch" ||
      current.state.status !== "active" ||
      current.goal.goal_contract?.goal_version !==
        validatedIdentity.goal_version ||
      current.state.goal_version !== validatedIdentity.goal_version ||
      current.state.input_revision !== validatedIdentity.input_revision ||
      current.state.attempt !== validatedIdentity.attempt ||
      current.state.patch_cycle !== validatedIdentity.patch_cycle
    ) {
      throw this.missionNotReady(
        validatedIdentity.work_item_id,
        "The durable work item no longer matches the active patch tuple.",
      );
    }

    const validatedSubject = patchSubjectSchema.parse(patchSubject);
    const paths = this.missionPaths(
      validatedIdentity,
      validatedSubject.reviewed_commit,
    );
    const mission = missionPackageSchema.parse(buildPackage(paths));
    if (
      !("patch_subject" in mission) ||
      JSON.stringify(mission.identity) !== JSON.stringify(validatedIdentity) ||
      JSON.stringify(mission.patch_subject) !==
        JSON.stringify(validatedSubject) ||
      mission.task_path !== paths.task_path ||
      mission.result_contract.output_path !== paths.output_path
    ) {
      throw this.invalid(
        this.founderDirectory,
        "compiled patch mission must match the workspace-derived identity, subject, and paths",
      );
    }
    return this.publishMissionSnapshot(validatedIdentity, mission);
  }

  async writeReviewMissionPackage(
    identity: MissionIdentity<"review">,
    reviewSubject: ReviewSubject,
    buildPackage: MissionPackageBuilder<ReviewMissionPackage>,
  ): Promise<MissionArtifactWriteResult<ReviewMissionPackage>> {
    const validatedIdentity = missionIdentitySchema.parse(identity);
    if (validatedIdentity.phase !== "review") {
      throw this.missionNotReady(
        validatedIdentity.work_item_id,
        "Review mission writes require review identity.",
      );
    }
    await this.readManifest();
    const current = await this.readValidated(validatedIdentity.work_item_id);
    if (
      current === null ||
      current.state.phase !== "review" ||
      current.state.status !== "active" ||
      current.goal.goal_contract?.goal_version !==
        validatedIdentity.goal_version ||
      current.state.goal_version !== validatedIdentity.goal_version ||
      current.state.input_revision !== validatedIdentity.input_revision ||
      current.state.attempt !== validatedIdentity.attempt
    ) {
      throw this.missionNotReady(
        validatedIdentity.work_item_id,
        "The durable work item no longer matches the active review tuple.",
      );
    }

    const validatedSubject = reviewSubjectSchema.parse(reviewSubject);
    if (
      current.state.patch_cycle !==
      (validatedSubject.source === "patch"
        ? validatedSubject.patch_cycle
        : 0)
    ) {
      throw this.missionNotReady(
        validatedIdentity.work_item_id,
        "The review subject does not match the active patch cycle.",
      );
    }
    const freshSubject =
      validatedSubject.source === "execute"
        ? await this.readAppliedExecuteReviewSubject({
            ...validatedIdentity,
            phase: "execute",
          })
        : await this.readAppliedPatchReviewSubject({
            ...validatedIdentity,
            phase: "patch",
            patch_cycle: validatedSubject.patch_cycle,
          });
    if (
      JSON.stringify(validatedSubject) !==
      JSON.stringify(freshSubject.review_subject)
    ) {
      throw this.missionNotReady(
        validatedIdentity.work_item_id,
        "Review subject does not match the current applied result evidence.",
      );
    }

    const paths = this.missionPaths(
      validatedIdentity,
      validatedSubject.git_base_commit,
      validatedSubject.source === "patch"
        ? validatedSubject.patch_cycle
        : undefined,
    );
    const mission = missionPackageSchema.parse(buildPackage(paths));
    if (
      !("review_subject" in mission) ||
      JSON.stringify(mission.identity) !== JSON.stringify(validatedIdentity) ||
      JSON.stringify(mission.review_subject) !==
        JSON.stringify(validatedSubject) ||
      mission.task_path !== paths.task_path ||
      mission.result_contract.output_path !== paths.output_path
    ) {
      throw this.invalid(
        this.founderDirectory,
        "compiled review mission must match the workspace-derived identity, subject, and paths",
      );
    }
    return this.publishMissionSnapshot(validatedIdentity, mission);
  }

  async readMissionResult(
    identity: MissionIdentity,
    reviewPatchCycle?: number,
  ): Promise<MissionResultSnapshot> {
    const validatedIdentity = missionIdentitySchema.parse(identity);
    const snapshot = await this.readMissionPackageSnapshot(
      validatedIdentity,
      reviewPatchCycle,
    );
    const resultPath = join(snapshot.missionDirectory, RESULT_JSON_FILE);

    return {
      mission: snapshot.mission,
      mission_path: snapshot.relativeMissionPath,
      result_path: posix.join(snapshot.relativeDirectory, RESULT_JSON_FILE),
      result_source: await this.readRequiredFile(resultPath),
    };
  }

  async readMissionPackage(
    identity: MissionIdentity,
    reviewPatchCycle?: number,
  ) {
    const validatedIdentity = missionIdentitySchema.parse(identity);
    const snapshot = await this.readMissionPackageSnapshot(
      validatedIdentity,
      reviewPatchCycle,
    );
    return {
      mission: snapshot.mission,
      mission_path: snapshot.relativeMissionPath,
    };
  }

  async readImportEvidence(
    identity: MissionIdentity,
    importRunId: string,
  ): Promise<StoredImportEvidence | null> {
    const validatedIdentity = missionIdentitySchema.parse(identity);
    const validatedImportRunId = importRunIdSchema.parse(importRunId);
    await this.readManifest();
    const directories = this.evidenceDirectories(
      validatedIdentity,
      validatedImportRunId,
    );
    for (const directory of [
      directories.root,
      directories.workItem,
      directories.tuple,
      directories.target,
    ]) {
      if (!(await this.hasSafeDirectory(directory))) {
        return null;
      }
    }
    return this.readStoredImportEvidence(
      directories.target,
      validatedIdentity,
      validatedImportRunId,
    );
  }

  async listImportEvidence(
    workItemId: string,
  ): Promise<StoredImportEvidence[]> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    await this.readManifest();

    const workItemEvidenceDirectory = join(
      this.founderDirectory,
      RUN_EVIDENCE_DIRECTORY,
      validatedWorkItemId,
    );
    if (!(await this.hasSafeDirectory(workItemEvidenceDirectory))) {
      return [];
    }

    const evidence: StoredImportEvidence[] = [];
    const identityEntries = await readdir(workItemEvidenceDirectory, {
      withFileTypes: true,
    });
    for (const identityEntry of identityEntries) {
      const identityDirectory = join(
        workItemEvidenceDirectory,
        identityEntry.name,
      );
      if (!identityEntry.isDirectory() || identityEntry.isSymbolicLink()) {
        throw this.invalid(
          identityDirectory,
          "evidence identity must be a directory, not a symlink",
        );
      }

      const standardIdentityMatch =
        /^(execute|review)-(\d+)-(\d+)-(\d+)$/.exec(identityEntry.name);
      const patchIdentityMatch = /^patch-(\d+)-(\d+)-(\d+)-(\d+)$/.exec(
        identityEntry.name,
      );
      if (standardIdentityMatch === null && patchIdentityMatch === null) {
        throw this.invalid(
          identityDirectory,
          "evidence identity directory must use <phase>-<goal_version>-<input_revision>-<attempt> with a required patch-cycle suffix for patch evidence",
        );
      }
      const identityResult = missionIdentitySchema.safeParse(
        patchIdentityMatch === null
          ? {
              phase: standardIdentityMatch![1],
              work_item_id: validatedWorkItemId,
              goal_version: Number(standardIdentityMatch![2]),
              input_revision: Number(standardIdentityMatch![3]),
              attempt: Number(standardIdentityMatch![4]),
            }
          : {
              phase: "patch",
              work_item_id: validatedWorkItemId,
              goal_version: Number(patchIdentityMatch[1]),
              input_revision: Number(patchIdentityMatch[2]),
              attempt: Number(patchIdentityMatch[3]),
              patch_cycle: Number(patchIdentityMatch[4]),
            },
      );
      if (!identityResult.success) {
        throw this.invalid(
          identityDirectory,
          validationReason(identityResult),
        );
      }

      const runEntries = await readdir(identityDirectory, {
        withFileTypes: true,
      });
      for (const runEntry of runEntries) {
        const runDirectory = join(identityDirectory, runEntry.name);
        if (!runEntry.isDirectory() || runEntry.isSymbolicLink()) {
          throw this.invalid(
            runDirectory,
            "import run evidence must be a directory, not a symlink",
          );
        }

        const importRunIdResult = importRunIdSchema.safeParse(runEntry.name);
        if (!importRunIdResult.success) {
          throw this.invalid(
            runDirectory,
            validationReason(importRunIdResult),
          );
        }

        evidence.push(
          await this.readStoredImportEvidence(
            runDirectory,
            identityResult.data,
            importRunIdResult.data,
          ),
        );
      }
    }

    return evidence.sort((left, right) => {
      const completedAtOrder = right.evidence.completed_at.localeCompare(
        left.evidence.completed_at,
      );
      return completedAtOrder !== 0
        ? completedAtOrder
        : right.evidence.import_run_id.localeCompare(
            left.evidence.import_run_id,
          );
    });
  }

  async writeImportEvidence(
    input: ImportEvidenceWriteInput,
  ): Promise<ImportEvidenceSummary> {
    const evidence = importEvidenceEnvelopeSchema.parse(input.evidence);
    const verification = z
      .array(commandEvidenceRecordSchema)
      .parse(input.verification);
    const identity = missionIdentitySchema.parse(evidence.identity);
    if (
      hashResultContent(input.submission_source) !==
        evidence.result_content_sha256 ||
      expectedImportRunId(evidence) !== evidence.import_run_id
    ) {
      throw this.invalid(
        this.founderDirectory,
        "import evidence identity does not match the submitted result bytes",
      );
    }
    this.validateEvidenceVerification(evidence, verification);
    await this.readManifest();
    const directories = this.evidenceDirectories(
      identity,
      evidence.import_run_id,
    );
    await this.ensureDirectory(directories.root);
    await this.ensureDirectory(directories.workItem);
    await this.ensureDirectory(directories.tuple);

    const submissionSource = input.submission_source;
    const importSource = `${JSON.stringify(evidence, null, 2)}\n`;
    const verificationSource = `${JSON.stringify(verification, null, 2)}\n`;
    if (await this.hasSafeDirectory(directories.target)) {
      await this.assertEvidenceSnapshot(
        directories.target,
        identity,
        evidence.import_run_id,
        { submissionSource, importSource, verificationSource },
      );
      return this.evidenceSummary(evidence);
    }

    const stagingDirectory = join(
      directories.tuple,
      `.${evidence.import_run_id}.${randomUUID()}.evidence.tmp`,
    );
    await mkdir(stagingDirectory);
    try {
      await writeFile(
        join(stagingDirectory, SUBMISSION_JSON_FILE),
        submissionSource,
        { encoding: "utf8", flag: "wx" },
      );
      await writeFile(
        join(stagingDirectory, IMPORT_JSON_FILE),
        importSource,
        { encoding: "utf8", flag: "wx" },
      );
      await writeFile(
        join(stagingDirectory, VERIFICATION_JSON_FILE),
        verificationSource,
        { encoding: "utf8", flag: "wx" },
      );
      await rename(stagingDirectory, directories.target);
    } catch (error) {
      await this.removeEvidenceStagingDirectory(stagingDirectory, error);
      if (
        isNodeError(error) &&
        ["EEXIST", "ENOTEMPTY"].includes(error.code ?? "") &&
        (await this.hasSafeDirectory(directories.target))
      ) {
        await this.assertEvidenceSnapshot(
          directories.target,
          identity,
          evidence.import_run_id,
          { submissionSource, importSource, verificationSource },
        );
        return this.evidenceSummary(evidence);
      }
      throw error;
    }

    await this.assertEvidenceSnapshot(
      directories.target,
      identity,
      evidence.import_run_id,
      { submissionSource, importSource, verificationSource },
    );
    return this.evidenceSummary(evidence);
  }

  async readShapingDecisionIntent(
    workItemId: string,
    decisionId: string,
  ): Promise<ShapingDecisionIntentV1 | null> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const validatedDecisionId = SHA256_SCHEMA.parse(decisionId);
    const paths = this.shapingDecisionPaths(
      validatedWorkItemId,
      validatedDecisionId,
    );
    const source = await this.readOptionalFile(paths.intent);
    if (source === null) {
      return null;
    }
    const intent = this.parseJson(
      source,
      paths.intent,
      shapingDecisionIntentSchema,
    );
    this.validateStoredShapingDecisionIntent(intent);
    return intent;
  }

  async writeShapingDecisionIntent(
    lease: ControllerLease,
    input: ShapingDecisionIntentCaptureInput,
  ): Promise<ShapingDecisionIntentWriteResult> {
    const validatedLease = this.validateControllerLease(lease);
    const workItemId = validatedLease.work_item.goal.work_item_id;
    const nextGoal = workItemGoalSchema.parse(
      input.goal ?? validatedLease.work_item.goal,
    );
    const nextState = workItemStateSchema.parse(input.state);
    if (
      input.intent.work_item_id !== workItemId ||
      nextGoal.work_item_id !== workItemId ||
      nextState.work_item_id !== workItemId ||
      nextState.active_run !== undefined
    ) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        "Shaping decision intent must preserve work-item identity and commit state without active_run.",
      );
    }

    const goalChanged = !isDeepStrictEqual(
      nextGoal,
      validatedLease.work_item.goal,
    );
    const stateChanged = !isDeepStrictEqual(
      nextState,
      validatedLease.work_item.state,
    );
    if (
      goalChanged !== (input.intent.operation === "approve_spec") ||
      !stateChanged
    ) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        "Only approve_spec may change the goal and every shaping decision must change state.",
      );
    }

    const decisionId = deriveShapingDecisionId({
      operation: input.intent.operation,
      work_item_id: input.intent.work_item_id,
      goal_input_sha256: input.intent.goal_input_sha256,
      mission_content_sha256: input.intent.mission_content_sha256,
      result_content_sha256: input.intent.result_content_sha256,
      feedback_sha256: input.intent.feedback_sha256,
      expected_shaping_state_sha256:
        input.intent.expected_shaping_state_sha256,
    });
    const nextGoalBytes = goalChanged
      ? stringify(nextGoal)
      : validatedLease.acquired_goal_bytes;
    const nextStateBytes = `${JSON.stringify(nextState, null, 2)}\n`;
    await this.assertControllerLeaseOwnership(validatedLease);
    const replay = await this.readMatchingShapingDecisionIntent(
      workItemId,
      decisionId,
      input.intent,
      nextGoalBytes,
      nextStateBytes,
    );
    if (replay !== null) {
      return replay;
    }

    const current = await this.readValidated(workItemId);
    if (current === null) {
      throw new ControllerConflictError(
        "work_item_not_found",
        workItemId,
        `Work item ${workItemId} disappeared while its controller lease was held.`,
      );
    }
    if (!this.matchesLeasedItem(current, validatedLease)) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        "Durable goal/state changed after shaping decision preconditions were validated.",
      );
    }

    const workItemDirectory = join(this.workItemsDirectory, workItemId);
    const goalPath = join(workItemDirectory, GOAL_FILE);
    const statePath = join(workItemDirectory, STATE_FILE);
    const durableGoalBytes = await this.readRequiredFile(goalPath);
    const durableStateBytes = await this.readRequiredFile(statePath);
    if (
      durableGoalBytes !== validatedLease.acquired_goal_bytes ||
      durableStateBytes !== validatedLease.acquired_state_bytes
    ) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        "Durable goal/state bytes changed between lease validation and shaping intent capture.",
      );
    }

    this.assertIntentMissionBytes(input.intent, workItemId);

    const intent = shapingDecisionIntentSchema.parse({
      ...input.intent,
      decision_id: decisionId,
      previous_goal_bytes: validatedLease.acquired_goal_bytes,
      previous_goal_sha256: this.hashArtifactSource(
        validatedLease.acquired_goal_bytes,
      ),
      previous_state_bytes: validatedLease.acquired_state_bytes,
      previous_state_sha256: this.hashArtifactSource(
        validatedLease.acquired_state_bytes,
      ),
      next_goal_bytes: nextGoalBytes,
      next_goal_sha256: this.hashArtifactSource(nextGoalBytes),
      next_state_bytes: nextStateBytes,
      next_state_sha256: this.hashArtifactSource(nextStateBytes),
      created_at: new Date().toISOString(),
    });
    const paths = this.shapingDecisionPaths(workItemId, decisionId);
    await this.ensureDirectory(paths.directory);
    const source = `${JSON.stringify(intent, null, 2)}\n`;
    try {
      await writeFile(paths.intent, source, {
        encoding: "utf8",
        flag: "wx",
      });
      return {
        intent,
        intent_path: paths.intent,
        intent_source: source,
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        const raced = await this.readMatchingShapingDecisionIntent(
          workItemId,
          decisionId,
          input.intent,
          nextGoalBytes,
          nextStateBytes,
        );
        if (raced !== null) {
          return raced;
        }
      }
      throw error;
    }
  }

  async readPlanApprovalIntent(
    workItemId: string,
    approvalId: string,
  ): Promise<PlanApprovalIntentV1 | null> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const validatedApprovalId = SHA256_SCHEMA.parse(approvalId);
    const paths = this.planApprovalPaths(
      validatedWorkItemId,
      validatedApprovalId,
    );
    const source = await this.readOptionalFile(paths.intent);
    if (source === null) {
      if ((await this.readOptionalFile(paths.manifest)) !== null) {
        throw new ControllerConflictError(
          "repair_required",
          validatedWorkItemId,
          `Plan approval ${validatedApprovalId} has a manifest without an intent.`,
        );
      }
      return null;
    }
    const intent = this.parseJson(
      source,
      paths.intent,
      planApprovalIntentSchema,
    );
    this.validateStoredPlanApprovalIntent(intent);
    return intent;
  }

  async writePlanApprovalIntent(
    lease: ControllerLease,
    input: PlanApprovalIntentCaptureInput,
  ): Promise<PlanApprovalIntentWriteResult> {
    const validatedLease = this.validateControllerLease(lease);
    const workItemId = validatedLease.work_item.goal.work_item_id;
    const nextGoal = workItemGoalSchema.parse(
      input.goal ?? validatedLease.work_item.goal,
    );
    const nextState = workItemStateSchema.parse(input.state);
    const receipt = this.parseCanonicalPlanApprovalReceipt(
      input.intent.receipt_bytes,
      workItemId,
    );
    const approvalId = derivePlanApprovalId(input.intent);
    const nextGoalBytes = validatedLease.acquired_goal_bytes;
    const previousStateBytes = `${JSON.stringify(
      validatedLease.work_item.state,
      null,
      2,
    )}\n`;
    const nextStateBytes = `${JSON.stringify(nextState, null, 2)}\n`;

    if (
      input.intent.work_item_id !== workItemId ||
      nextGoal.work_item_id !== workItemId ||
      nextState.work_item_id !== workItemId ||
      !isDeepStrictEqual(nextGoal, validatedLease.work_item.goal) ||
      nextState.active_run !== undefined ||
      validatedLease.work_item.state.phase !== "plan" ||
      validatedLease.work_item.state.status !== "active" ||
      validatedLease.work_item.goal.goal_contract === undefined ||
      input.intent.goal_contract_sha256 !== receipt.goal_contract_sha256 ||
      input.intent.goal_version !== receipt.goal_version ||
      input.intent.receipt_sha256 !==
        this.hashArtifactSource(input.intent.receipt_bytes) ||
      !isDeepStrictEqual(input.intent.execute_tuple, receipt.execute_tuple) ||
      nextState.phase !== "execute" ||
      nextState.status !== "active" ||
      nextState.goal_version !== receipt.execute_tuple.goal_version ||
      nextState.input_revision !== receipt.execute_tuple.input_revision ||
      nextState.attempt !== receipt.execute_tuple.attempt ||
      nextState.patch_cycle !== validatedLease.work_item.state.patch_cycle ||
      input.intent.expected_mission_content_sha256 !==
        receipt.mission_content_sha256 ||
      input.intent.expected_result_content_sha256 !==
        receipt.result_content_sha256
    ) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        "Plan approval intent must preserve the governed contract and bind one exact active Execute tuple.",
      );
    }

    await this.assertControllerLeaseOwnership(validatedLease);
    const replay = await this.readMatchingPlanApprovalIntent(
      workItemId,
      approvalId,
      input.intent,
      nextGoalBytes,
      nextStateBytes,
    );
    if (replay !== null) {
      return replay;
    }

    const current = await this.readValidated(workItemId);
    if (current === null) {
      throw new ControllerConflictError(
        "work_item_not_found",
        workItemId,
        `Work item ${workItemId} disappeared while its Plan approval lease was held.`,
      );
    }
    if (!this.matchesLeasedItem(current, validatedLease)) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        "Durable goal/state changed after Plan approval preconditions were validated.",
      );
    }
    const durableGoalBytes = await this.readRequiredFile(
      join(this.workItemsDirectory, workItemId, GOAL_FILE),
    );
    const durableStateBytes = await this.readRequiredFile(
      join(this.workItemsDirectory, workItemId, STATE_FILE),
    );
    if (
      durableGoalBytes !== validatedLease.acquired_goal_bytes ||
      durableStateBytes !== validatedLease.acquired_state_bytes
    ) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        "Durable goal/state bytes changed between lease validation and Plan approval intent capture.",
      );
    }

    const tip = await this.resolveCurrentMissionRevision(workItemId, "plan");
    if (
      tip === null ||
      tip.decision !== null ||
      JSON.stringify(tip.mission.identity) !==
        JSON.stringify(receipt.identity) ||
      tip.mission.content_sha256 !== receipt.mission_content_sha256 ||
      tip.result?.result_content_sha256 !== receipt.result_content_sha256
    ) {
      throw new ControllerConflictError(
        "stale_expectation",
        workItemId,
        "Plan approval intent must bind the undecided applied Plan tip.",
      );
    }

    const intent = planApprovalIntentSchema.parse({
      ...input.intent,
      approval_id: approvalId,
      previous_goal_bytes: validatedLease.acquired_goal_bytes,
      previous_goal_sha256: this.hashArtifactSource(
        validatedLease.acquired_goal_bytes,
      ),
      previous_state_bytes: previousStateBytes,
      previous_state_sha256: this.hashArtifactSource(
        previousStateBytes,
      ),
      next_goal_bytes: nextGoalBytes,
      next_goal_sha256: this.hashArtifactSource(nextGoalBytes),
      next_state_bytes: nextStateBytes,
      next_state_sha256: this.hashArtifactSource(nextStateBytes),
      created_at: new Date().toISOString(),
    });
    const paths = this.planApprovalPaths(workItemId, approvalId);
    await this.ensureDirectory(paths.directory);
    const source = `${JSON.stringify(intent, null, 2)}\n`;
    try {
      await writeFile(paths.intent, source, {
        encoding: "utf8",
        flag: "wx",
      });
      return {
        intent,
        intent_path: paths.intent,
        intent_source: source,
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        const raced = await this.readMatchingPlanApprovalIntent(
          workItemId,
          approvalId,
          input.intent,
          nextGoalBytes,
          nextStateBytes,
        );
        if (raced !== null) {
          return raced;
        }
      }
      throw error;
    }
  }

  async readPlanApprovalManifest(
    workItemId: string,
    approvalId: string,
  ): Promise<PlanApprovalManifestV1 | null> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const validatedApprovalId = SHA256_SCHEMA.parse(approvalId);
    const intent = await this.readPlanApprovalIntent(
      validatedWorkItemId,
      validatedApprovalId,
    );
    const manifest = await this.readPlanApprovalManifestFile(
      validatedWorkItemId,
      validatedApprovalId,
    );
    if (manifest === null) {
      if (
        intent !== null &&
        (await this.readDurablePlanApprovalReceipt(intent)) !== null
      ) {
        throw new ControllerConflictError(
          "repair_required",
          validatedWorkItemId,
          `Plan approval ${validatedApprovalId} has a receipt without a manifest.`,
        );
      }
      return null;
    }
    if (intent === null) {
      throw new ControllerConflictError(
        "repair_required",
        validatedWorkItemId,
        `Plan approval ${validatedApprovalId} has a manifest without an intent.`,
      );
    }
    this.assertPlanApprovalManifestMatchesIntent(manifest, intent);
    const receipt = await this.readDurablePlanApprovalReceipt(intent);
    if (receipt === null) {
      throw new ControllerConflictError(
        "repair_required",
        validatedWorkItemId,
        `Plan approval ${validatedApprovalId} has a manifest without its immutable Plan receipt.`,
      );
    }
    return manifest;
  }

  async publishLeasedShapingMission(
    lease: ControllerLease,
    identityInput: ShapingIdentity,
    missionBytes: string,
    input: { decision_id: string },
  ): Promise<ShapingArtifactWriteResult> {
    const validatedLease = this.validateControllerLease(lease);
    const identity = shapingIdentitySchema.parse(identityInput);
    const decisionId = SHA256_SCHEMA.parse(input.decision_id);
    const workItemId = validatedLease.work_item.goal.work_item_id;
    if (identity.work_item_id !== workItemId) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        "Leased shaping mission cannot change work_item_id.",
      );
    }
    await this.assertControllerLeaseOwnership(validatedLease);
    const current = await this.readValidated(workItemId);
    if (current === null || !this.matchesLeasedItem(current, validatedLease)) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        "Durable goal/state changed after the shaping mission lease was acquired.",
      );
    }

    const intent = await this.readRequiredShapingDecisionIntent(
      workItemId,
      decisionId,
    );
    const mission = this.parseJson(
      missionBytes,
      this.shapingDecisionPaths(workItemId, decisionId).intent,
      shapingMissionPackageSchema,
    );
    if (
      serializeShapingPackage(mission) !== missionBytes ||
      JSON.stringify(mission.identity) !== JSON.stringify(identity) ||
      intent.next_mission_package_bytes !== missionBytes ||
      intent.next_mission_content_sha256 !== mission.content_sha256 ||
      intent.next_mission_input_sha256 !== identity.input_sha256 ||
      intent.phase_to !== identity.phase ||
      current.state.phase !== intent.phase_from ||
      (identity.phase !== current.state.phase &&
        identity.phase !== intent.phase_to)
    ) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        "Leased shaping mission does not match the pending decision intent.",
      );
    }
    const existingManifest = await this.readShapingDecisionManifest(
      workItemId,
      decisionId,
    );
    if (existingManifest?.outcome === "failed") {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        "A failed shaping decision cannot publish its next mission.",
      );
    }

    const goalInput = normalizeShapingGoalInput(current.goal);
    if (
      mission.input.title !== goalInput.title ||
      mission.input.notes !== goalInput.notes ||
      hashShapingInput(mission.input) !== identity.input_sha256
    ) {
      throw this.missionNotReady(
        workItemId,
        "The durable work item no longer matches the leased shaping mission input.",
      );
    }
    if (mission.identity.phase === "spec") {
      await this.assertSpecShapingSelection(
        specMissionPackageSchema.parse(mission),
      );
    }
    return this.publishShapingSnapshot(identity, mission);
  }

  async commitShapingDecision(
    lease: ControllerLease,
    input: ShapingDecisionCommitInput,
  ): Promise<ShapingDecisionCommitResult> {
    const validatedLease = this.validateControllerLease(lease);
    const manifest = shapingDecisionManifestSchema.parse(input.manifest);
    const nextGoal = workItemGoalSchema.parse(
      input.goal ?? validatedLease.work_item.goal,
    );
    const nextState = workItemStateSchema.parse(input.state);
    const goalWasSupplied = input.goal !== undefined;
    const nextGoalBytes = goalWasSupplied
      ? stringify(nextGoal)
      : validatedLease.acquired_goal_bytes;
    const workItemId = validatedLease.work_item.goal.work_item_id;
    const semanticEventIntents = this.validateCommitSemanticEventIntents(
      validatedLease,
      workItemSchema.parse({ goal: nextGoal, state: nextState }),
      "shaping_decision",
      manifest.decision_id,
      input.semantic_event_intents,
    );
    await this.assertControllerLeaseOwnership(validatedLease);

    const pending = await this.findPendingShapingDecisionManifest(workItemId);
    if (pending !== null && pending.decision_id !== manifest.decision_id) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        `Pending shaping decision ${pending.decision_id} must be reconciled before ${manifest.decision_id}.`,
      );
    }
    const existing = await this.readShapingDecisionManifest(
      workItemId,
      manifest.decision_id,
    );
    if (existing !== null) {
      if (
        existing.outcome === "applied" &&
        this.shapingDecisionManifestIdentityMatches(existing, manifest)
      ) {
        const current = await this.readValidated(workItemId);
        if (current === null) {
          throw new ControllerConflictError(
            "work_item_not_found",
            workItemId,
            `Work item ${workItemId} disappeared after its shaping decision committed.`,
          );
        }
        await this.writeSemanticEventIntents(
          workItemId,
          semanticEventIntents,
        );
        const replay = {
          work_item: this.withoutActiveRun(current),
          manifest: existing,
        };
        await this.publishSemanticEventIntents(semanticEventIntents);
        return replay;
      }
      if (
        existing.outcome === "pending" &&
        this.shapingDecisionManifestIdentityMatches(existing, manifest)
      ) {
        return this.reconcileShapingDecisionCommit(
          validatedLease,
          manifest.decision_id,
        );
      }
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        `Decision ${manifest.decision_id} already has a non-matching durable manifest.`,
      );
    }

    this.validateShapingDecisionCommit(
      validatedLease,
      nextGoal,
      nextState,
      goalWasSupplied,
      manifest,
    );

    const current = await this.readValidated(workItemId);
    if (current === null || !this.matchesLeasedItem(current, validatedLease)) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        "Durable goal/state changed after the shaping decision lease was acquired.",
      );
    }
    const intent = await this.readRequiredShapingDecisionIntent(
      workItemId,
      manifest.decision_id,
    );
    this.assertShapingManifestMatchesIntent(manifest, intent);
    if (
      nextGoalBytes !== intent.next_goal_bytes ||
      `${JSON.stringify(nextState, null, 2)}\n` !== intent.next_state_bytes
    ) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        "Shaping commit bytes differ from the durable decision intent.",
      );
    }

    await this.writeSemanticEventIntents(workItemId, semanticEventIntents);
    await this.writeInitialShapingDecisionManifest(manifest);
    await this.afterShapingDecisionPendingManifestWritten();
    await this.writeShapingDecisionArtifacts(intent, true);
    await this.afterShapingDecisionStateReplaced();
    const appliedManifest = shapingDecisionManifestSchema.parse({
      ...manifest,
      outcome: "applied",
      completed_at: new Date().toISOString(),
    });
    await this.writeShapingDecisionManifest(appliedManifest);
    const committed = {
      work_item: workItemSchema.parse({ goal: nextGoal, state: nextState }),
      manifest: appliedManifest,
    };
    await this.publishSemanticEventIntents(semanticEventIntents);
    return committed;
  }

  async reconcileShapingDecisionCommit(
    lease: ControllerLease,
    decisionIdInput: string,
  ): Promise<ShapingDecisionCommitResult> {
    const validatedLease = this.validateControllerLease(lease);
    const decisionId = SHA256_SCHEMA.parse(decisionIdInput);
    const workItemId = validatedLease.work_item.goal.work_item_id;
    await this.assertControllerLeaseOwnership(validatedLease);

    const pending = await this.findPendingShapingDecisionManifest(workItemId);
    if (pending !== null && pending.decision_id !== decisionId) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        `Pending shaping decision ${pending.decision_id} must be reconciled before ${decisionId}.`,
      );
    }
    const manifest = await this.readShapingDecisionManifest(
      workItemId,
      decisionId,
    );
    if (manifest === null) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        `Shaping decision ${decisionId} has no durable manifest to reconcile.`,
      );
    }
    if (manifest.outcome === "applied") {
      const current = await this.readValidated(workItemId);
      if (current === null) {
        throw new ControllerConflictError(
          "work_item_not_found",
          workItemId,
          `Work item ${workItemId} disappeared after its shaping decision committed.`,
        );
      }
      const replay = {
        work_item: this.withoutActiveRun(current),
        manifest,
      };
      await this.publishStoredSemanticEventIntentsForSource(
        workItemId,
        "shaping_decision",
        decisionId,
      );
      return replay;
    }
    if (manifest.outcome !== "pending") {
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        `Shaping decision ${decisionId} is ${manifest.outcome}, not pending.`,
      );
    }

    const intent = await this.readRequiredShapingDecisionIntent(
      workItemId,
      decisionId,
    );
    this.assertShapingManifestMatchesIntent(manifest, intent);
    const workItemDirectory = join(this.workItemsDirectory, workItemId);
    const durableGoalBytes = await this.readRequiredFile(
      join(workItemDirectory, GOAL_FILE),
    );
    const durableStateBytes = await this.readRequiredFile(
      join(workItemDirectory, STATE_FILE),
    );
    const durableGoalSha256 = this.hashArtifactSource(durableGoalBytes);
    const durableStateSha256 = this.hashArtifactSource(durableStateBytes);
    const goalIsNext = durableGoalSha256 === intent.next_goal_sha256;
    const goalIsPrevious =
      durableGoalSha256 === intent.previous_goal_sha256;
    const stateIsNext = durableStateSha256 === intent.next_state_sha256;
    const stateIsPrevious =
      durableStateSha256 === intent.previous_state_sha256;

    if (!goalIsNext || !stateIsNext) {
      if (
        (goalIsNext || goalIsPrevious) &&
        (stateIsNext || stateIsPrevious)
      ) {
        await this.writeShapingDecisionArtifacts(intent, false);
      } else {
        throw new ControllerConflictError(
          "repair_required",
          workItemId,
          `Durable shaping decision pair is unknown: goal ${durableGoalSha256} (next ${intent.next_goal_sha256}, previous ${intent.previous_goal_sha256}); state ${durableStateSha256} (next ${intent.next_state_sha256}, previous ${intent.previous_state_sha256}).`,
        );
      }
    }

    const committedGoalBytes = await this.readRequiredFile(
      join(workItemDirectory, GOAL_FILE),
    );
    const committedStateBytes = await this.readRequiredFile(
      join(workItemDirectory, STATE_FILE),
    );
    if (
      this.hashArtifactSource(committedGoalBytes) !== manifest.goal_sha256 ||
      this.hashArtifactSource(committedStateBytes) !== manifest.state_sha256
    ) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        "Reconciled shaping decision bytes do not match the pending manifest.",
      );
    }
    const appliedManifest = shapingDecisionManifestSchema.parse({
      ...manifest,
      outcome: "applied",
      completed_at: new Date().toISOString(),
    });
    await this.writeShapingDecisionManifest(appliedManifest);
    const committed = {
      work_item: this.parseWorkItemBytes(
        committedGoalBytes,
        committedStateBytes,
        workItemId,
      ),
      manifest: appliedManifest,
    };
    await this.publishStoredSemanticEventIntentsForSource(
      workItemId,
      "shaping_decision",
      decisionId,
    );
    return committed;
  }

  async commitPlanApproval(
    lease: ControllerLease,
    input: PlanApprovalCommitInput,
  ): Promise<PlanApprovalCommitResult> {
    const validatedLease = this.validateControllerLease(lease);
    const manifest = planApprovalManifestSchema.parse(input.manifest);
    const nextGoal = workItemGoalSchema.parse(
      input.goal ?? validatedLease.work_item.goal,
    );
    const nextState = workItemStateSchema.parse(input.state);
    const workItemId = validatedLease.work_item.goal.work_item_id;
    const semanticEventIntents = this.validateCommitSemanticEventIntents(
      validatedLease,
      workItemSchema.parse({ goal: nextGoal, state: nextState }),
      "plan_approval",
      manifest.approval_id,
      input.semantic_event_intents,
    );
    await this.assertControllerLeaseOwnership(validatedLease);

    const pending = await this.findPendingPlanApprovalManifest(workItemId);
    if (pending !== null && pending.approval_id !== manifest.approval_id) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        `Pending Plan approval ${pending.approval_id} must be reconciled before ${manifest.approval_id}.`,
      );
    }
    const existing = await this.readPlanApprovalManifestFile(
      workItemId,
      manifest.approval_id,
    );
    if (existing !== null) {
      if (
        existing.outcome === "applied" &&
        this.planApprovalManifestIdentityMatches(existing, manifest)
      ) {
        const intent = await this.readRequiredPlanApprovalIntent(
          workItemId,
          manifest.approval_id,
        );
        this.assertPlanApprovalManifestMatchesIntent(existing, intent);
        await this.requireDurablePlanApprovalReceipt(intent);
        const current = await this.readValidated(workItemId);
        if (current === null) {
          throw new ControllerConflictError(
            "work_item_not_found",
            workItemId,
            `Work item ${workItemId} disappeared after its Plan approval committed.`,
          );
        }
        await this.writeSemanticEventIntents(
          workItemId,
          semanticEventIntents,
        );
        const replay = {
          work_item: this.withoutActiveRun(current),
          manifest: existing,
        };
        await this.publishSemanticEventIntents(semanticEventIntents);
        return replay;
      }
      if (
        existing.outcome === "pending" &&
        this.planApprovalManifestIdentityMatches(existing, manifest)
      ) {
        return this.reconcilePlanApprovalCommit(
          validatedLease,
          manifest.approval_id,
        );
      }
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        `Plan approval ${manifest.approval_id} already has a non-matching durable manifest.`,
      );
    }

    this.validatePlanApprovalCommit(
      validatedLease,
      nextGoal,
      nextState,
      manifest,
    );
    const current = await this.readValidated(workItemId);
    if (current === null || !this.matchesLeasedItem(current, validatedLease)) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        "Durable goal/state changed after the Plan approval lease was acquired.",
      );
    }
    const intent = await this.readRequiredPlanApprovalIntent(
      workItemId,
      manifest.approval_id,
    );
    this.assertPlanApprovalManifestMatchesIntent(manifest, intent);
    await this.requireDurablePlanApprovalReceipt(intent);
    if (
      validatedLease.acquired_goal_bytes !== intent.next_goal_bytes ||
      `${JSON.stringify(nextState, null, 2)}\n` !== intent.next_state_bytes
    ) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        "Plan approval commit bytes differ from the durable intent.",
      );
    }

    await this.writeSemanticEventIntents(workItemId, semanticEventIntents);
    await this.writeInitialPlanApprovalManifest(manifest);
    await this.afterPlanApprovalPendingManifestWritten();
    await this.writePlanApprovalArtifacts(intent, true);
    await this.beforePlanApprovalAppliedManifestWritten();
    const appliedManifest = planApprovalManifestSchema.parse({
      ...manifest,
      outcome: "applied",
      completed_at: new Date().toISOString(),
    });
    await this.writePlanApprovalManifest(appliedManifest);
    const committed = {
      work_item: workItemSchema.parse({ goal: nextGoal, state: nextState }),
      manifest: appliedManifest,
    };
    await this.publishSemanticEventIntents(semanticEventIntents);
    return committed;
  }

  async reconcilePlanApprovalCommit(
    lease: ControllerLease,
    approvalIdInput: string,
  ): Promise<PlanApprovalCommitResult> {
    const validatedLease = this.validateControllerLease(lease);
    const approvalId = SHA256_SCHEMA.parse(approvalIdInput);
    const workItemId = validatedLease.work_item.goal.work_item_id;
    await this.assertControllerLeaseOwnership(validatedLease);

    const pending = await this.findPendingPlanApprovalManifest(workItemId);
    if (pending !== null && pending.approval_id !== approvalId) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        `Pending Plan approval ${pending.approval_id} must be reconciled before ${approvalId}.`,
      );
    }
    const manifest = await this.readPlanApprovalManifestFile(
      workItemId,
      approvalId,
    );
    if (manifest === null) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        `Plan approval ${approvalId} has no durable manifest to reconcile.`,
      );
    }
    const intent = await this.readRequiredPlanApprovalIntent(
      workItemId,
      approvalId,
    );
    this.assertPlanApprovalManifestMatchesIntent(manifest, intent);
    await this.requireDurablePlanApprovalReceipt(intent);
    if (manifest.outcome === "applied") {
      const current = await this.readValidated(workItemId);
      if (current === null) {
        throw new ControllerConflictError(
          "work_item_not_found",
          workItemId,
          `Work item ${workItemId} disappeared after its Plan approval committed.`,
        );
      }
      const replay = {
        work_item: this.withoutActiveRun(current),
        manifest,
      };
      await this.publishStoredSemanticEventIntentsForSource(
        workItemId,
        "plan_approval",
        approvalId,
      );
      return replay;
    }
    if (manifest.outcome !== "pending") {
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        `Plan approval ${approvalId} is ${manifest.outcome}, not pending.`,
      );
    }

    const workItemDirectory = join(this.workItemsDirectory, workItemId);
    const durableGoalBytes = await this.readRequiredFile(
      join(workItemDirectory, GOAL_FILE),
    );
    const durableStateBytes = await this.readRequiredFile(
      join(workItemDirectory, STATE_FILE),
    );
    const durableGoalSha256 = this.hashArtifactSource(durableGoalBytes);
    const durableStateSha256 = this.hashArtifactSource(
      `${JSON.stringify(validatedLease.work_item.state, null, 2)}\n`,
    );
    const leasedDurableStateSha256 =
      this.hashArtifactSource(durableStateBytes);
    const goalIsNext = durableGoalSha256 === intent.next_goal_sha256;
    const goalIsPrevious =
      durableGoalSha256 === intent.previous_goal_sha256;
    const stateIsNext = durableStateSha256 === intent.next_state_sha256;
    const stateIsPrevious =
      durableStateSha256 === intent.previous_state_sha256;

    if (
      !goalIsNext ||
      leasedDurableStateSha256 !== intent.next_state_sha256
    ) {
      if (
        (goalIsNext || goalIsPrevious) &&
        (stateIsNext || stateIsPrevious)
      ) {
        await this.writePlanApprovalArtifacts(intent, false);
      } else {
        throw new ControllerConflictError(
          "repair_required",
          workItemId,
          `Durable Plan approval pair is unknown: goal ${durableGoalSha256} (next ${intent.next_goal_sha256}, previous ${intent.previous_goal_sha256}); state ${durableStateSha256} (next ${intent.next_state_sha256}, previous ${intent.previous_state_sha256}).`,
        );
      }
    }

    const committedGoalBytes = await this.readRequiredFile(
      join(workItemDirectory, GOAL_FILE),
    );
    const committedStateBytes = await this.readRequiredFile(
      join(workItemDirectory, STATE_FILE),
    );
    if (
      this.hashArtifactSource(committedGoalBytes) !== manifest.goal_sha256 ||
      this.hashArtifactSource(committedStateBytes) !== manifest.state_sha256
    ) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        "Reconciled Plan approval bytes do not match the pending manifest.",
      );
    }
    const appliedManifest = planApprovalManifestSchema.parse({
      ...manifest,
      outcome: "applied",
      completed_at: new Date().toISOString(),
    });
    await this.writePlanApprovalManifest(appliedManifest);
    const committed = {
      work_item: this.parseWorkItemBytes(
        committedGoalBytes,
        committedStateBytes,
        workItemId,
      ),
      manifest: appliedManifest,
    };
    await this.publishStoredSemanticEventIntentsForSource(
      workItemId,
      "plan_approval",
      approvalId,
    );
    return committed;
  }

  async commitControllerMutation(
    lease: ControllerLease,
    input: ControllerMutationInput,
  ): Promise<ControllerMutationResult> {
    const validatedLease = this.validateControllerLease(lease);
    const validatedManifest = controllerRunManifestSchema.parse(input.manifest);
    const nextItem = workItemSchema.parse({
      goal: input.goal,
      state: input.state,
    });
    const workItemId = validatedLease.work_item.goal.work_item_id;

    this.validateControllerMutation(
      validatedLease,
      nextItem,
      validatedManifest,
    );
    const semanticEventIntents = this.validateControllerSemanticEventIntents(
      validatedLease,
      nextItem,
      validatedManifest,
      input.semantic_event_intents,
    );
    await this.assertControllerLeaseOwnership(validatedLease);

    const current = await this.readValidated(workItemId);
    if (current === null) {
      throw new ControllerConflictError(
        "work_item_not_found",
        workItemId,
        `Work item ${workItemId} disappeared while its controller lease was held.`,
      );
    }
    if (!this.matchesLeasedItem(current, validatedLease)) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        "Durable goal/state changed after the controller lease was acquired.",
      );
    }

    const existing = await this.readControllerRunManifest(
      workItemId,
      validatedManifest.run_id,
    );
    if (existing !== null) {
      if (
        existing.outcome === "applied" &&
        this.manifestIdentityMatches(existing, validatedManifest)
      ) {
        await this.writeSemanticEventIntents(
          workItemId,
          semanticEventIntents,
        );
        const replay = {
          work_item: this.withoutActiveRun(current),
          manifest: existing,
        };
        for (const intent of semanticEventIntents) {
          await this.publishSemanticEventIntent(workItemId, intent.intent_id);
        }
        return replay;
      }
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        `Run ${validatedManifest.run_id} already has a non-matching durable manifest.`,
      );
    }

    const pendingManifest = controllerRunManifestSchema.parse({
      ...validatedManifest,
      outcome: "pending",
      completed_at: undefined,
    });
    const workItemDirectory = join(this.workItemsDirectory, workItemId);
    await this.writeSemanticEventIntents(workItemId, semanticEventIntents);

    let committed: ControllerMutationResult;
    try {
      await this.writeControllerRunManifest(pendingManifest);
      await this.writeControllerArtifacts(
        workItemDirectory,
        nextItem.goal,
        nextItem.state,
        true,
      );

      const appliedManifest = controllerRunManifestSchema.parse({
        ...pendingManifest,
        outcome: "applied",
        completed_at: new Date().toISOString(),
      });
      await this.writeControllerRunManifest(appliedManifest);
      committed = { work_item: nextItem, manifest: appliedManifest };
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try {
        await this.writeControllerArtifacts(
          workItemDirectory,
          validatedLease.work_item.goal,
          validatedLease.work_item.state,
          false,
        );
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }

      try {
        await this.writeControllerRunManifest({
          ...pendingManifest,
          outcome: "failed",
          completed_at: new Date().toISOString(),
        });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }

      try {
        await this.releaseControllerLease(validatedLease);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }

      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Controller mutation failed and recovery was incomplete",
        );
      }
      throw error;
    }
    for (const intent of semanticEventIntents) {
      await this.publishSemanticEventIntent(workItemId, intent.intent_id);
    }
    return committed;
  }

  async releaseControllerLease(lease: ControllerLease): Promise<void> {
    const validatedLease = this.validateControllerLease(lease);
    const workItemId = validatedLease.work_item.goal.work_item_id;
    const workItemDirectory = join(this.workItemsDirectory, workItemId);
    const lockPath = join(workItemDirectory, CONTROLLER_LOCK_FILE);
    const lockSource = await this.readOptionalFile(lockPath);
    const current = await this.readValidated(workItemId);

    if (lockSource === null) {
      if (current?.state.active_run !== undefined) {
        throw new ControllerConflictError(
          "repair_required",
          workItemId,
          "Controller state retains active_run but its lock file is missing.",
        );
      }
      return;
    }

    const lockRun = this.parseJson(lockSource, lockPath, activeRunSchema);
    if (!this.activeRunsMatch(lockRun, validatedLease.active_run)) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        "Controller lock ownership does not match the releasing lease.",
      );
    }

    if (current?.state.active_run !== undefined) {
      if (
        !this.activeRunsMatch(
          current.state.active_run,
          validatedLease.active_run,
        )
      ) {
        throw new ControllerConflictError(
          "repair_required",
          workItemId,
          "Controller state active_run does not match the releasing lease.",
        );
      }

      const releasedState = { ...current.state };
      delete releasedState.active_run;
      await this.replaceStateAtomically(
        workItemId,
        workItemStateSchema.parse(releasedState),
      );
    }

    await unlink(lockPath);
  }

  protected async afterControllerGoalReplaced(): Promise<void> {
    return;
  }

  protected async afterSemanticIntentWritten(): Promise<void> {
    return;
  }

  protected async afterSemanticSequenceReserved(): Promise<void> {
    return;
  }

  protected async beforeSemanticEventWritten(): Promise<void> {
    return;
  }

  protected async afterRetainedControllerStateCleared(): Promise<void> {
    return;
  }

  protected async afterShapingDecisionPendingManifestWritten(): Promise<void> {
    return;
  }

  protected async afterShapingDecisionStateReplaced(): Promise<void> {
    return;
  }

  protected async afterPlanApprovalPendingManifestWritten(): Promise<void> {
    return;
  }

  protected async afterPlanApprovalStateReplaced(): Promise<void> {
    return;
  }

  protected async beforePlanApprovalAppliedManifestWritten(): Promise<void> {
    return;
  }

  protected async afterShapingIngressInstructionWritten(
    _instructionPath: string,
  ): Promise<void> {
    return;
  }

  protected async afterShapingAcpIngressStaged(): Promise<void> {
    return;
  }

  protected async afterShapingIngressOpened(
    _ingressPath: string,
  ): Promise<void> {
    return;
  }

  protected async afterShapingAppliedComponentWritten(
    _component: "result" | "import" | "production" | "applied",
  ): Promise<void> {
    return;
  }

  protected async afterShapingAppliedBundleRenamed(): Promise<void> {
    return;
  }

  private async readControllerRunManifests(
    workItemId: string,
  ): Promise<ControllerRunManifest[]> {
    const runsDirectory = join(
      this.workItemsDirectory,
      workItemId,
      RUNS_DIRECTORY,
    );
    if (!(await this.hasSafeDirectory(runsDirectory))) {
      return [];
    }

    const entries = await readdir(runsDirectory, { withFileTypes: true });
    const manifests: ControllerRunManifest[] = [];
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (!entry.name.endsWith(".json")) {
        continue;
      }

      const manifestPath = join(runsDirectory, entry.name);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw this.invalid(
          manifestPath,
          "run manifest must be a regular file, not a symlink",
        );
      }
      const runIdResult = controllerRunIdSchema.safeParse(
        entry.name.slice(0, -".json".length),
      );
      if (!runIdResult.success) {
        throw this.invalid(manifestPath, validationReason(runIdResult));
      }
      const source = await this.readOptionalFile(manifestPath);
      if (source === null) {
        throw this.invalid(
          manifestPath,
          "run manifest disappeared during scan",
        );
      }
      manifests.push(
        this.parseControllerRunManifest(
          source,
          manifestPath,
          workItemId,
          runIdResult.data,
        ),
      );
    }
    return manifests;
  }

  private parseControllerRunManifest(
    source: string,
    manifestPath: string,
    workItemId: string,
    runId: string,
  ): ControllerRunManifest {
    const manifest = this.parseJson(
      source,
      manifestPath,
      controllerRunManifestSchema,
    );
    if (manifest.work_item_id !== workItemId) {
      throw this.invalid(
        manifestPath,
        `work_item_id must remain ${workItemId}`,
      );
    }
    if (manifest.run_id !== runId) {
      throw this.invalid(
        manifestPath,
        `run_id must equal containing filename ${runId}`,
      );
    }
    return manifest;
  }

  private evidenceDirectories(
    identity: MissionIdentity,
    importRunId: string,
  ) {
    const root = join(this.founderDirectory, RUN_EVIDENCE_DIRECTORY);
    const workItem = join(root, identity.work_item_id);
    const tuple = join(workItem, this.missionDirectoryName(identity));
    return {
      root,
      workItem,
      tuple,
      target: join(tuple, importRunId),
    };
  }

  private evidenceSummary(
    evidence: ImportEvidenceWriteInput["evidence"],
  ): ImportEvidenceSummary {
    return importEvidenceSummarySchema.parse({
      phase: evidence.phase,
      import_run_id: evidence.import_run_id,
      outcome: evidence.outcome,
      evidence_path: posix.join(
        FOUNDER_DIRECTORY,
        RUN_EVIDENCE_DIRECTORY,
        evidence.identity.work_item_id,
        this.missionDirectoryName(evidence.identity),
        evidence.import_run_id,
      ),
      reasons: evidence.reasons,
    });
  }

  private async readStoredImportEvidence(
    evidenceDirectory: string,
    identity: MissionIdentity,
    importRunId: string,
  ): Promise<StoredImportEvidence> {
    const submissionPath = join(evidenceDirectory, SUBMISSION_JSON_FILE);
    const importPath = join(evidenceDirectory, IMPORT_JSON_FILE);
    const verificationPath = join(
      evidenceDirectory,
      VERIFICATION_JSON_FILE,
    );
    const submissionSource = await this.readRequiredFile(submissionPath);
    const importSource = await this.readRequiredFile(importPath);
    const verificationSource = await this.readRequiredFile(verificationPath);
    const evidence = this.parseJson(
      importSource,
      importPath,
      importEvidenceEnvelopeSchema,
    );
    const verification = this.parseJson(
      verificationSource,
      verificationPath,
      z.array(commandEvidenceRecordSchema),
    );
    if (
      evidence.import_run_id !== importRunId ||
      JSON.stringify(evidence.identity) !== JSON.stringify(identity) ||
      hashResultContent(submissionSource) !== evidence.result_content_sha256 ||
      expectedImportRunId(evidence) !== evidence.import_run_id
    ) {
      throw this.invalid(
        evidenceDirectory,
        "stored import evidence does not match its directory or submission bytes",
      );
    }
    this.validateEvidenceVerification(evidence, verification);
    let submission: StoredImportEvidence["submission"];
    try {
      const parsed = externalResultSubmissionSchema.safeParse(
        JSON.parse(submissionSource),
      );
      if (parsed.success && parsed.data.identity.phase === evidence.phase) {
        submission = parsed.data;
      }
    } catch {
      submission = undefined;
    }
    return {
      evidence,
      summary: this.evidenceSummary(evidence),
      verification,
      ...(submission === undefined ? {} : { submission }),
    };
  }

  private async assertEvidenceSnapshot(
    evidenceDirectory: string,
    identity: MissionIdentity,
    importRunId: string,
    expected: {
      submissionSource: string;
      importSource: string;
      verificationSource: string;
    },
  ): Promise<void> {
    await this.assertDirectory(evidenceDirectory);
    await this.readStoredImportEvidence(
      evidenceDirectory,
      identity,
      importRunId,
    );
    const actual = {
      submissionSource: await this.readRequiredFile(
        join(evidenceDirectory, SUBMISSION_JSON_FILE),
      ),
      importSource: await this.readRequiredFile(
        join(evidenceDirectory, IMPORT_JSON_FILE),
      ),
      verificationSource: await this.readRequiredFile(
        join(evidenceDirectory, VERIFICATION_JSON_FILE),
      ),
    };
    if (
      actual.submissionSource !== expected.submissionSource ||
      actual.importSource !== expected.importSource ||
      actual.verificationSource !== expected.verificationSource
    ) {
      throw this.invalid(
        evidenceDirectory,
        "immutable import evidence differs from the published snapshot",
      );
    }
  }

  private validateEvidenceVerification(
    evidence: ImportEvidenceWriteInput["evidence"],
    verification: CommandEvidenceRecord[],
  ): void {
    if (evidence.phase === "review") {
      if (verification.length > 0) {
        throw this.invalid(
          this.founderDirectory,
          "review import evidence cannot contain command results",
        );
      }
      return;
    }
    const { outcome } = evidence;
    const hasRedCommand = verification.some((record) =>
      ["failed", "timed_out", "spawn_error"].includes(record.status),
    );
    if (
      outcome === "rejected" &&
      verification.length > 0 &&
      evidence.phase !== "patch"
    ) {
      throw this.invalid(
        this.founderDirectory,
        "rejected import evidence cannot contain command results",
      );
    }
    if (
      evidence.phase === "patch" &&
      outcome === "rejected" &&
      verification.length > 0 &&
      !hasRedCommand
    ) {
      throw this.invalid(
        this.founderDirectory,
        "rejected patch import evidence with command results requires a red command",
      );
    }
    if (
      outcome === "applied" &&
      (verification.length === 0 ||
        verification.some((record) => record.status !== "passed"))
    ) {
      throw this.invalid(
        this.founderDirectory,
        "applied import evidence requires every command to pass",
      );
    }
    if (
      outcome === "failed" &&
      !hasRedCommand
    ) {
      throw this.invalid(
        this.founderDirectory,
        "failed import evidence requires a red command result",
      );
    }
    let redSeen = false;
    for (const record of verification) {
      if (["failed", "timed_out", "spawn_error"].includes(record.status)) {
        if (redSeen) {
          throw this.invalid(
            this.founderDirectory,
            "verification evidence must stop after the first red command",
          );
        }
        redSeen = true;
      } else if (record.status === "not_run") {
        if (!redSeen) {
          throw this.invalid(
            this.founderDirectory,
            "not_run verification evidence requires an earlier red command",
          );
        }
      } else if (redSeen) {
        throw this.invalid(
          this.founderDirectory,
          "verification evidence must mark commands after a red result not_run",
        );
      }
    }
  }

  private async removeEvidenceStagingDirectory(
    stagingDirectory: string,
    originalError: unknown,
  ): Promise<void> {
    try {
      await rm(stagingDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [originalError, cleanupError],
        "Import evidence publication failed and staging cleanup was incomplete",
      );
    }
  }

  private shapingPaths(identity: ShapingIdentity): ShapingPaths {
    const relativeDirectory = posix.join(
      FOUNDER_DIRECTORY,
      SHAPING_DIRECTORY,
      identity.work_item_id,
      `${identity.phase}-${identity.input_sha256}`,
    );
    return {
      task_path: posix.join(relativeDirectory, TASK_MD_FILE),
      output_path: posix.join(relativeDirectory, RESULT_JSON_FILE),
    };
  }

  private shapingWriteResult<TMission extends ShapingMissionPackage>(
    mission: TMission,
    missionDirectory: string,
  ): ShapingArtifactWriteResult<TMission> {
    return {
      mission,
      workspace_path: this.workspaceRoot,
      task_path: join(missionDirectory, TASK_MD_FILE),
      mission_path: join(missionDirectory, MISSION_JSON_FILE),
    };
  }

  private async publishShapingSnapshot<
    TMission extends ShapingMissionPackage,
  >(
    identity: ShapingIdentity,
    mission: TMission,
  ): Promise<ShapingArtifactWriteResult<TMission>> {
    const missionSource = serializeShapingPackage(mission);
    const taskSource = renderShapingTaskMd(mission);
    const shapingDirectory = join(this.founderDirectory, SHAPING_DIRECTORY);
    const workItemShapingDirectory = join(
      shapingDirectory,
      identity.work_item_id,
    );
    const missionDirectory = join(
      workItemShapingDirectory,
      `${identity.phase}-${identity.input_sha256}`,
    );

    await this.ensureDirectory(shapingDirectory);
    await this.ensureDirectory(workItemShapingDirectory);
    await this.ensureShapingIngressFamilyRoot();
    if (await this.hasSafeDirectory(missionDirectory)) {
      await this.assertShapingSnapshot(
        missionDirectory,
        mission,
        missionSource,
        taskSource,
      );
      return this.shapingWriteResult(mission, missionDirectory);
    }

    const stagingName =
      `.${identity.phase}-${identity.input_sha256}.${randomUUID()}.shaping.tmp`;
    if (!SHAPING_STAGING_DIRECTORY_PATTERN.test(stagingName)) {
      throw new Error("Generated shaping staging directory name is invalid.");
    }
    const stagingDirectory = join(workItemShapingDirectory, stagingName);
    await mkdir(stagingDirectory);
    try {
      await writeFile(join(stagingDirectory, MISSION_JSON_FILE), missionSource, {
        encoding: "utf8",
        flag: "wx",
      });
      await writeFile(join(stagingDirectory, TASK_MD_FILE), taskSource, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(stagingDirectory, missionDirectory);
    } catch (error) {
      await this.removeShapingStagingDirectory(stagingDirectory, error);
      if (
        isNodeError(error) &&
        ["EEXIST", "ENOTEMPTY"].includes(error.code ?? "") &&
        (await this.hasSafeDirectory(missionDirectory))
      ) {
        await this.assertShapingSnapshot(
          missionDirectory,
          mission,
          missionSource,
          taskSource,
        );
        return this.shapingWriteResult(mission, missionDirectory);
      }
      throw error;
    }

    await this.assertShapingSnapshot(
      missionDirectory,
      mission,
      missionSource,
      taskSource,
    );
    return this.shapingWriteResult(mission, missionDirectory);
  }

  private async ensureShapingIngressFamilyRoot(): Promise<void> {
    const ingressDirectory = join(
      this.founderDirectory,
      SHAPING_INGRESS_DIRECTORY,
    );
    const gitignorePath = join(ingressDirectory, ".gitignore");
    const expectedSource = "*\n";

    await this.ensureDirectory(ingressDirectory);
    let existingSource = await this.readOptionalFile(gitignorePath);
    if (existingSource === null) {
      try {
        await writeFile(gitignorePath, expectedSource, {
          encoding: "utf8",
          flag: "wx",
        });
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw error;
        }
      }
      existingSource = await this.readRequiredFile(gitignorePath);
    }
    if (existingSource !== expectedSource) {
      throw this.invalid(
        gitignorePath,
        "shaping ingress .gitignore must contain exactly *",
      );
    }
  }

  private async assertShapingIngressFamilyRoot(): Promise<void> {
    const ingressDirectory = join(
      this.founderDirectory,
      SHAPING_INGRESS_DIRECTORY,
    );
    const gitignorePath = join(ingressDirectory, ".gitignore");
    await this.assertDirectory(ingressDirectory);
    if ((await this.readRequiredFile(gitignorePath)) !== "*\n") {
      throw this.invalid(
        gitignorePath,
        "shaping ingress .gitignore must contain exactly *",
      );
    }
  }

  private buildShapingIngressInstruction(
    origin: "connected_run" | "manual_import",
    shapingRunId: string | null,
    snapshot: {
      mission: ShapingMissionPackage;
      relativeDirectory: string;
      relativeMissionPath: string;
    },
    createdAt: string,
  ): ShapingIngressInstructionV1 {
    const paths = this.shapingInstructionPaths({
      origin,
      shaping_run_id: shapingRunId,
      identity: snapshot.mission.identity,
    });
    const instructionWithoutHash = {
      schema_version: 1 as const,
      origin,
      shaping_run_id: shapingRunId,
      work_item_id: snapshot.mission.identity.work_item_id,
      phase: snapshot.mission.identity.phase,
      mission_input_sha256: snapshot.mission.identity.input_sha256,
      mission_content_sha256: snapshot.mission.content_sha256,
      task_path: snapshot.relativeDirectory
        ? posix.join(snapshot.relativeDirectory, TASK_MD_FILE)
        : TASK_MD_FILE,
      mission_path: snapshot.relativeMissionPath,
      ingress_path: paths.relativeIngressPath,
      result_schema_version:
        snapshot.mission.result_contract.result_schema_version,
      required_fields: [...snapshot.mission.result_contract.required_fields],
      max_result_bytes: SHAPING_INGRESS_MAX_BYTES,
      created_at: createdAt,
    };
    return shapingIngressInstructionSchema.parse({
      ...instructionWithoutHash,
      instruction_sha256:
        hashShapingIngressInstruction(instructionWithoutHash),
    });
  }

  private shapingRunWritePolicy(
    instruction: ShapingIngressInstructionV1,
  ): ShapingRunRecordV1["write_policy"] {
    return {
      kind: "single_ingress_file",
      ingress_path: instruction.ingress_path,
      instruction_sha256: instruction.instruction_sha256,
      commands: "forbidden",
      urls: "forbidden",
      mcp: "forbidden",
      credentials: "forbidden",
      outside_workspace_writes: "forbidden",
      reads: "workspace_and_repository_unrestricted",
      execution_mode: "permission_mediated_local",
      result_assurance: "result_scope_validation",
      containment_assurance: "not_independently_enforced",
      machine_authority: "launching_user",
    };
  }

  private assertShapingRunMissionMatchesPackage(
    record: ShapingRunRecordV1,
    mission: ShapingMissionPackage,
  ): void {
    if (
      record.mission.phase !== mission.identity.phase ||
      record.mission.work_item_id !== mission.identity.work_item_id ||
      record.mission.input_sha256 !== mission.identity.input_sha256 ||
      record.mission.content_sha256 !== mission.content_sha256
    ) {
      throw this.invalid(
        this.founderDirectory,
        "shaping run mission reference must match the immutable mission package",
      );
    }
  }

  private shapingInstructionPaths(input: {
    origin: "connected_run" | "manual_import";
    shaping_run_id: string | null;
    identity: ShapingIdentity;
  }): {
    instructionDirectory: string;
    instructionPath: string;
    ingressDirectory: string;
    ingressPath: string;
    relativeInstructionPath: string;
    relativeIngressPath: string;
  } {
    const relativeInstructionDirectory =
      input.origin === "connected_run"
        ? posix.join(
            FOUNDER_DIRECTORY,
            SHAPING_RUNS_DIRECTORY,
            input.identity.work_item_id,
            controllerRunIdSchema.parse(input.shaping_run_id),
          )
        : posix.join(
            FOUNDER_DIRECTORY,
            SHAPING_INGRESS_DIRECTORY,
            input.identity.work_item_id,
            `${input.identity.phase}-${input.identity.input_sha256}`,
          );
    const relativeIngressDirectory =
      input.origin === "connected_run"
        ? posix.join(relativeInstructionDirectory, "ingress")
        : relativeInstructionDirectory;
    const relativeInstructionPath = posix.join(
      relativeInstructionDirectory,
      INSTRUCTION_JSON_FILE,
    );
    const relativeIngressPath = posix.join(
      relativeIngressDirectory,
      RESULT_JSON_FILE,
    );
    const instructionDirectory = join(
      this.workspaceRoot,
      ...relativeInstructionDirectory.split("/"),
    );
    const ingressDirectory = join(
      this.workspaceRoot,
      ...relativeIngressDirectory.split("/"),
    );
    return {
      instructionDirectory,
      instructionPath: join(instructionDirectory, INSTRUCTION_JSON_FILE),
      ingressDirectory,
      ingressPath: join(ingressDirectory, RESULT_JSON_FILE),
      relativeInstructionPath,
      relativeIngressPath,
    };
  }

  private async prepareShapingInstructionDirectory(
    origin: "connected_run" | "manual_import",
    instructionDirectory: string,
    ingressDirectory: string,
    workItemId: string,
    shapingRunId: string | null,
  ): Promise<void> {
    if (origin === "manual_import") {
      await this.ensureShapingIngressFamilyRoot();
      await this.ensureDirectory(
        join(
          this.founderDirectory,
          SHAPING_INGRESS_DIRECTORY,
          workItemId,
        ),
      );
      await this.ensureDirectory(instructionDirectory);
      return;
    }

    if (shapingRunId === null) {
      throw new Error("Connected shaping instructions require a run id.");
    }
    await this.assertDirectory(
      join(this.founderDirectory, SHAPING_RUNS_DIRECTORY),
    );
    await this.assertDirectory(
      join(this.founderDirectory, SHAPING_RUNS_DIRECTORY, workItemId),
    );
    await this.assertDirectory(instructionDirectory);
    await this.ensureDirectory(ingressDirectory);
  }

  private async readMatchingShapingInstruction(
    instructionPath: string,
    expectedInstructionSha256: string,
    workItemId: string,
  ): Promise<ShapingIngressInstructionWriteResult | null> {
    let source: string | null;
    try {
      const instructionDirectory = relative(
        this.workspaceRoot,
        join(instructionPath, ".."),
      )
        .split(sep)
        .join("/");
      if (
        !(await this.hasSafeWorkspaceDirectoryComponents(
          instructionDirectory,
        ))
      ) {
        return null;
      }
      source = await this.readOptionalFile(instructionPath);
    } catch (error) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        `Shaping ingress instruction at ${relative(
          this.workspaceRoot,
          instructionPath,
        )} needs repair: ${errorMessage(error)}`,
      );
    }
    if (source === null) {
      return null;
    }

    let instruction: ShapingIngressInstructionV1;
    try {
      instruction = this.parseJson(
        source,
        instructionPath,
        shapingIngressInstructionSchema,
      );
    } catch (error) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        `Shaping ingress instruction at ${relative(
          this.workspaceRoot,
          instructionPath,
        )} needs repair: ${errorMessage(error)}`,
      );
    }
    if (instruction.instruction_sha256 !== expectedInstructionSha256) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        "Stored shaping ingress instruction differs from the requested immutable instruction.",
      );
    }
    return {
      instruction,
      instruction_path: instructionPath,
      instruction_source: source,
    };
  }

  private async readDurableShapingInstruction(
    input: ShapingIngressInstructionV1,
  ): Promise<ShapingIngressInstructionV1> {
    let instruction: ShapingIngressInstructionV1;
    try {
      instruction = shapingIngressInstructionSchema.parse(input);
    } catch (error) {
      throw new ControllerConflictError(
        "repair_required",
        input.work_item_id,
        `Shaping ingress instruction is invalid: ${errorMessage(error)}`,
      );
    }
    const paths = this.shapingInstructionPaths({
      origin: instruction.origin,
      shaping_run_id: instruction.shaping_run_id,
      identity: {
        phase: instruction.phase,
        work_item_id: instruction.work_item_id,
        input_sha256: instruction.mission_input_sha256,
      },
    });
    if (instruction.ingress_path !== paths.relativeIngressPath) {
      throw new ControllerConflictError(
        "repair_required",
        instruction.work_item_id,
        "Shaping ingress instruction does not name its deterministic ingress path.",
      );
    }
    try {
      await this.assertSafeWorkspaceDirectoryComponents(
        posix.dirname(paths.relativeInstructionPath),
      );
      const source = await this.readRequiredFile(paths.instructionPath);
      const stored = this.parseJson(
        source,
        paths.instructionPath,
        shapingIngressInstructionSchema,
      );
      if (JSON.stringify(stored) !== JSON.stringify(instruction)) {
        throw new Error("provided instruction differs from durable instruction");
      }
      return stored;
    } catch (error) {
      throw new ControllerConflictError(
        "repair_required",
        instruction.work_item_id,
        `Shaping ingress instruction at ${paths.relativeInstructionPath} needs repair: ${errorMessage(error)}`,
      );
    }
  }

  private assertShapingInstructionMatchesMission(
    instruction: ShapingIngressInstructionV1,
    snapshot: {
      mission: ShapingMissionPackage;
      relativeDirectory: string;
      relativeMissionPath: string;
    },
  ): void {
    const mission = snapshot.mission;
    if (
      instruction.work_item_id !== mission.identity.work_item_id ||
      instruction.phase !== mission.identity.phase ||
      instruction.mission_input_sha256 !== mission.identity.input_sha256 ||
      instruction.mission_content_sha256 !== mission.content_sha256 ||
      instruction.task_path !==
        posix.join(snapshot.relativeDirectory, TASK_MD_FILE) ||
      instruction.mission_path !== snapshot.relativeMissionPath ||
      instruction.result_schema_version !==
        mission.result_contract.result_schema_version ||
      JSON.stringify(instruction.required_fields) !==
        JSON.stringify(mission.result_contract.required_fields) ||
      instruction.max_result_bytes !== SHAPING_INGRESS_MAX_BYTES
    ) {
      throw new ControllerConflictError(
        "repair_required",
        mission.identity.work_item_id,
        "Shaping ingress instruction does not match its immutable mission.",
      );
    }
  }

  private async assertSafeWorkspaceDirectoryComponents(
    relativeDirectory: string,
  ): Promise<void> {
    if (!(await this.hasSafeWorkspaceDirectoryComponents(relativeDirectory))) {
      throw this.invalid(
        join(this.workspaceRoot, ...relativeDirectory.split("/")),
        "required directory is missing",
      );
    }
  }

  private async hasSafeWorkspaceDirectoryComponents(
    relativeDirectory: string,
  ): Promise<boolean> {
    let current = this.workspaceRoot;
    for (const component of relativeDirectory.split("/")) {
      current = join(current, component);
      if (!(await this.hasSafeDirectory(current))) {
        return false;
      }
    }
    return true;
  }

  private async assertSafeShapingIngressParent(
    relativeIngressPath: string,
  ): Promise<void> {
    await this.assertSafeWorkspaceDirectoryComponents(
      posix.dirname(relativeIngressPath),
    );
  }

  private async removeStaleAppliedShapingStagingDirectories(snapshot: {
    mission: ShapingMissionPackage;
    missionDirectory: string;
  }): Promise<void> {
    const parentDirectory = join(snapshot.missionDirectory, "..");
    const prefix = `.${snapshot.mission.identity.phase}-${snapshot.mission.identity.input_sha256}.`;
    const entries = await readdir(parentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (
        !entry.name.startsWith(prefix) ||
        !entry.name.endsWith(".applied.staging")
      ) {
        continue;
      }
      if (
        !SHAPING_STAGING_DIRECTORY_PATTERN.test(entry.name) ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      ) {
        throw this.invalid(
          join(parentDirectory, entry.name),
          "applied shaping staging entry must be a regular directory",
        );
      }
      await rm(join(parentDirectory, entry.name), {
        recursive: true,
        force: true,
      });
    }
  }

  private async removeAppliedShapingStagingDirectory(
    stagingDirectory: string,
    originalError: unknown,
  ): Promise<void> {
    try {
      await rm(stagingDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [originalError, cleanupError],
        "Applied shaping publication failed and staging cleanup was incomplete",
      );
    }
  }

  private assertAppliedShapingReplay(
    stored: StoredAppliedShapingBundle,
    mission: ShapingMissionPackage,
    expectedResultSource: string,
    expectedImportIdentity: object,
    expectedProductionIdentity: object,
  ): AppliedShapingBundleWriteResult {
    const { first_published_at: _firstPublishedAt, ...storedImportIdentity } =
      stored.importReceipt;
    const { produced_at: _producedAt, ...storedProductionIdentity } =
      stored.productionReceipt;
    if (stored.resultSource !== expectedResultSource) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        mission.identity.work_item_id,
        "This shaping mission revision already has a different applied result.",
      );
    }
    if (
      !isDeepStrictEqual(storedImportIdentity, expectedImportIdentity) ||
      !isDeepStrictEqual(
        storedProductionIdentity,
        expectedProductionIdentity,
      )
    ) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        mission.identity.work_item_id,
        "This shaping mission revision already has different import or production evidence.",
      );
    }
    return {
      applied_path: relative(
        this.workspaceRoot,
        join(stored.markerPath, ".."),
      )
        .split(sep)
        .join("/"),
      result_source: stored.resultSource,
      result_content_sha256: stored.resultContentSha256,
      import_receipt: stored.importReceipt,
      import_source: stored.importSource,
      production_receipt: stored.productionReceipt,
      production_source: stored.productionSource,
      applied_marker: stored.marker,
      applied_source: stored.markerSource,
    };
  }

  private async removeShapingStagingDirectory(
    stagingDirectory: string,
    originalError: unknown,
  ): Promise<void> {
    try {
      await rm(stagingDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [originalError, cleanupError],
        "Shaping snapshot publication failed and staging cleanup was incomplete",
      );
    }
  }

  private async assertShapingSnapshot(
    missionDirectory: string,
    mission: ShapingMissionPackage,
    missionSource: string,
    taskSource: string,
  ): Promise<void> {
    const missionPath = join(missionDirectory, MISSION_JSON_FILE);
    const taskPath = join(missionDirectory, TASK_MD_FILE);
    const existingMissionSource = await this.readOptionalFile(missionPath);
    const existingTaskSource = await this.readOptionalFile(taskPath);
    if (existingMissionSource === null || existingTaskSource === null) {
      throw this.invalid(
        missionDirectory,
        "immutable shaping snapshot must contain both mission.json and TASK.md",
      );
    }
    const existingMission = this.parseShapingMissionSource(
      existingMissionSource,
      missionPath,
      missionDirectory,
    );
    if (
      JSON.stringify(existingMission) !== JSON.stringify(mission) ||
      existingMissionSource !== missionSource
    ) {
      throw this.invalid(
        missionDirectory,
        "immutable shaping snapshot differs from the compiled package",
      );
    }
    await this.rederiveTaskMd(
      missionDirectory,
      taskPath,
      existingTaskSource,
      taskSource,
    );
  }

  private async readShapingPackageSnapshot(
    identity: ShapingIdentity,
  ): Promise<{
    mission: ShapingMissionPackage;
    missionDirectory: string;
    relativeDirectory: string;
    relativeMissionPath: string;
  }> {
    await this.readManifest();
    const paths = this.shapingPaths(identity);
    const relativeDirectory = posix.dirname(paths.task_path);
    const shapingDirectory = join(this.founderDirectory, SHAPING_DIRECTORY);
    const workItemShapingDirectory = join(
      shapingDirectory,
      identity.work_item_id,
    );
    const missionDirectory = join(
      workItemShapingDirectory,
      `${identity.phase}-${identity.input_sha256}`,
    );
    await this.assertDirectory(shapingDirectory);
    await this.assertDirectory(workItemShapingDirectory);
    await this.assertDirectory(missionDirectory);

    const missionPath = join(missionDirectory, MISSION_JSON_FILE);
    const missionSource = await this.readRequiredFile(missionPath);
    const mission = this.parseShapingMissionSource(
      missionSource,
      missionPath,
      missionDirectory,
    );
    if (JSON.stringify(mission.identity) !== JSON.stringify(identity)) {
      throw this.invalid(
        missionDirectory,
        "shaping snapshot identity does not match its containing directory",
      );
    }
    await this.assertShapingSnapshot(
      missionDirectory,
      mission,
      serializeShapingPackage(mission),
      renderShapingTaskMd(mission),
    );
    return {
      mission,
      missionDirectory,
      relativeDirectory,
      relativeMissionPath: posix.join(relativeDirectory, MISSION_JSON_FILE),
    };
  }

  private parseShapingMissionSource(
    source: string,
    missionPath: string,
    missionDirectory: string,
  ): ShapingMissionPackage {
    const value = this.parseJsonValue(source, missionPath);
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      "shaping_schema_version" in value &&
      value.shaping_schema_version === 1
    ) {
      throw this.invalid(
        missionDirectory,
        "shaping artifact schema version 1 is unsupported; archive or reset this exact directory before continuing with shaping schema version 2",
      );
    }
    return this.parseValue(value, missionPath, shapingMissionPackageSchema);
  }

  private parseShapingResultForMission(
    resultSource: string,
    resultPath: string,
    mission: ShapingMissionPackage,
  ): ShapingResultSubmission {
    const result =
      mission.identity.phase === "brainstorm"
        ? this.parseJson(
            resultSource,
            resultPath,
            brainstormResultSubmissionSchema,
          )
        : mission.identity.phase === "spec"
          ? this.parseJson(resultSource, resultPath, specResultSubmissionSchema)
          : this.parseJson(resultSource, resultPath, planResultSubmissionSchema);
    const missionContentSha256 =
      "brainstorm_mission_content_sha256" in result
        ? result.brainstorm_mission_content_sha256
        : "spec_mission_content_sha256" in result
          ? result.spec_mission_content_sha256
          : result.plan_mission_content_sha256;
    if (
      JSON.stringify(result.identity) !== JSON.stringify(mission.identity) ||
      missionContentSha256 !== mission.content_sha256
    ) {
      throw this.invalid(
        resultPath,
        "shaping result must match its immutable mission identity and content SHA",
      );
    }
    return result;
  }

  private async writeImmutableShapingJson(
    targetPath: string,
    value: unknown,
    label: string,
  ): Promise<string> {
    const expectedSource = `${JSON.stringify(value, null, 2)}\n`;
    const existingSource = await this.readOptionalFile(targetPath);
    if (existingSource !== null) {
      if (existingSource !== expectedSource) {
        throw this.invalid(targetPath, `immutable ${label} differs`);
      }
      return existingSource;
    }

    await this.writeJsonAtomically(targetPath, value);
    const publishedSource = await this.readRequiredFile(targetPath);
    if (publishedSource !== expectedSource) {
      throw this.invalid(targetPath, `immutable ${label} differs after publish`);
    }
    return publishedSource;
  }

  private hashArtifactSource(source: string | Buffer): string {
    return createHash("sha256").update(source).digest("hex");
  }

  private async readAppliedShapingBundle(snapshot: {
    mission: ShapingMissionPackage;
    missionDirectory: string;
  }): Promise<StoredAppliedShapingBundle | null> {
    const appliedDirectory = join(
      snapshot.missionDirectory,
      APPLIED_DIRECTORY,
    );
    if (!(await this.hasSafeDirectory(appliedDirectory))) {
      return null;
    }

    try {
      const markerPath = join(appliedDirectory, APPLIED_JSON_FILE);
      const markerSource = await this.readRequiredFile(markerPath);
      const marker = this.parseJson(
        markerSource,
        markerPath,
        shapingAppliedMarkerSchema,
      );
      const resultPath = join(appliedDirectory, RESULT_JSON_FILE);
      const importPath = join(appliedDirectory, IMPORT_JSON_FILE);
      const productionPath = join(appliedDirectory, PRODUCTION_JSON_FILE);
      const resultSource = await this.readRequiredFile(resultPath);
      const importSource = await this.readRequiredFile(importPath);
      const productionSource = await this.readRequiredFile(productionPath);
      const componentSources = {
        result: resultSource,
        import: importSource,
        production: productionSource,
      };

      for (const component of ["result", "import", "production"] as const) {
        const source = componentSources[component];
        if (
          marker.component_sha256[component] !==
            this.hashArtifactSource(source) ||
          marker.component_bytes[component] !== Buffer.byteLength(source)
        ) {
          throw new ControllerConflictError(
            "repair_required",
            snapshot.mission.identity.work_item_id,
            `Applied shaping bundle component ${component}.json does not match applied.json.`,
          );
        }
      }

      const resultContentSha256 = this.hashArtifactSource(resultSource);
      if (
        marker.mission_content_sha256 !== snapshot.mission.content_sha256 ||
        marker.result_content_sha256 !== resultContentSha256
      ) {
        throw new ControllerConflictError(
          "repair_required",
          snapshot.mission.identity.work_item_id,
          "Applied shaping bundle marker does not match its immutable mission and result.",
        );
      }

      const importReceipt = this.parseJson(
        importSource,
        importPath,
        shapingImportReceiptSchema,
      );
      if (
        importReceipt.outcome !== "applied" ||
        importReceipt.result_content_sha256 !== resultContentSha256 ||
        importReceipt.shaping_mission_content_sha256 !==
          snapshot.mission.content_sha256 ||
        JSON.stringify(importReceipt.identity) !==
          JSON.stringify(snapshot.mission.identity)
      ) {
        throw new ControllerConflictError(
          "repair_required",
          snapshot.mission.identity.work_item_id,
          "Applied shaping import receipt does not match its immutable mission and result.",
        );
      }

      const productionReceipt = this.parseJson(
        productionSource,
        productionPath,
        shapingProductionReceiptSchema,
      );
      if (
        productionReceipt.result_content_sha256 !== resultContentSha256 ||
        (productionReceipt.origin === "manual_import" &&
          productionReceipt.production_id !==
            deriveManualShapingProductionId(
              snapshot.mission.content_sha256,
              resultContentSha256,
            ))
      ) {
        throw new ControllerConflictError(
          "repair_required",
          snapshot.mission.identity.work_item_id,
          "Applied shaping production receipt does not match its immutable mission and result.",
        );
      }

      this.parseShapingResultForMission(
        resultSource,
        resultPath,
        snapshot.mission,
      );
      return {
        resultPath,
        resultSource,
        resultContentSha256,
        importPath,
        importSource,
        importReceipt,
        productionPath,
        productionSource,
        productionReceipt,
        markerPath,
        markerSource,
        marker,
      };
    } catch (error) {
      if (
        error instanceof ControllerConflictError &&
        error.kind === "repair_required"
      ) {
        throw error;
      }
      throw new ControllerConflictError(
        "repair_required",
        snapshot.mission.identity.work_item_id,
        `Applied shaping bundle at ${relative(
          this.workspaceRoot,
          appliedDirectory,
        )} needs repair: ${errorMessage(error)}`,
      );
    }
  }

  private async readStoredShapingArtifact(snapshot: {
    mission: ShapingMissionPackage;
    missionDirectory: string;
    relativeDirectory: string;
    relativeMissionPath: string;
  }): Promise<StoredShapingArtifact> {
    const applied = await this.readAppliedShapingBundle(snapshot);
    const decisionPath = join(snapshot.missionDirectory, DECISION_JSON_FILE);
    const decisionSource = await this.readOptionalFile(decisionPath);
    const decisionReceipt =
      decisionSource === null
        ? null
        : this.parseJson(
            decisionSource,
            decisionPath,
            shapingDecisionReceiptSchema,
          );
    if (
      decisionReceipt !== null &&
      (applied === null ||
        decisionReceipt.identity.phase !== snapshot.mission.identity.phase ||
        JSON.stringify(decisionReceipt.identity) !==
          JSON.stringify(snapshot.mission.identity) ||
        decisionReceipt.mission_content_sha256 !==
          snapshot.mission.content_sha256 ||
        decisionReceipt.result_content_sha256 !==
          applied.resultContentSha256)
    ) {
      throw new ControllerConflictError(
        "repair_required",
        snapshot.mission.identity.work_item_id,
        "Shaping decision does not match one applied result of its own phase.",
      );
    }

    const relativeAppliedDirectory = posix.join(
      snapshot.relativeDirectory,
      APPLIED_DIRECTORY,
    );

    return {
      mission: snapshot.mission,
      mission_path: snapshot.relativeMissionPath,
      task_path: posix.join(snapshot.relativeDirectory, TASK_MD_FILE),
      result:
        applied === null
          ? null
          : {
              result_path: posix.join(
                relativeAppliedDirectory,
                RESULT_JSON_FILE,
              ),
              result_source: applied.resultSource,
              result_content_sha256: applied.resultContentSha256,
            },
      import_receipt: applied?.importReceipt ?? null,
      import_path:
        applied === null
          ? null
          : posix.join(relativeAppliedDirectory, IMPORT_JSON_FILE),
      production_receipt: applied?.productionReceipt ?? null,
      production_path:
        applied === null
          ? null
          : posix.join(relativeAppliedDirectory, PRODUCTION_JSON_FILE),
      applied_marker: applied?.marker ?? null,
      applied_marker_path:
        applied === null
          ? null
          : posix.join(relativeAppliedDirectory, APPLIED_JSON_FILE),
      decision:
        decisionReceipt === null || decisionSource === null
          ? null
          : {
              receipt: decisionReceipt,
              decision_path: posix.join(
                snapshot.relativeDirectory,
                DECISION_JSON_FILE,
              ),
              decision_content_sha256:
                this.hashArtifactSource(decisionSource),
            },
    };
  }

  private async assertSpecShapingSelection(
    mission: SpecMissionPackage,
  ): Promise<void> {
    const matches = (await this.listShapingArtifacts(mission.identity.work_item_id))
      .filter(
        (artifact) =>
          artifact.decision?.decision_content_sha256 ===
          mission.input.brainstorm_selection_sha256,
      );
    if (matches.length !== 1) {
      throw this.missionNotReady(
        mission.identity.work_item_id,
        matches.length === 0
          ? "The selected Brainstorm acceptance does not exist."
          : "More than one Brainstorm acceptance matches the selected SHA.",
      );
    }
    const selected = matches[0];
    if (
      selected.mission.identity.phase !== "brainstorm" ||
      selected.decision === null ||
      !("selected_at" in selected.decision.receipt) ||
      selected.import_receipt?.outcome !== "applied" ||
      selected.result === null
    ) {
      throw this.missionNotReady(
        mission.identity.work_item_id,
        "The selected Brainstorm artifact is not accepted and applied.",
      );
    }
    const result = this.parseShapingResultForMission(
      selected.result.result_source,
      join(this.workspaceRoot, selected.result.result_path),
      selected.mission,
    );
    const selection = {
      shaping_schema_version:
        selected.decision.receipt.shaping_schema_version,
      identity: selected.decision.receipt.identity,
      mission_content_sha256:
        selected.decision.receipt.mission_content_sha256,
      result_content_sha256:
        selected.decision.receipt.result_content_sha256,
    };
    if (
      result.identity.phase !== "brainstorm" ||
      JSON.stringify(mission.input.brainstorm_selection) !==
        JSON.stringify(selection) ||
      JSON.stringify(mission.input.brainstorm_result) !== JSON.stringify(result)
    ) {
      throw this.missionNotReady(
        mission.identity.work_item_id,
        "The Spec input does not match the selected Brainstorm acceptance.",
      );
    }
  }

  private async publishMissionSnapshot<TMission extends MissionPackage>(
    identity: MissionIdentity,
    mission: TMission,
  ): Promise<MissionArtifactWriteResult<TMission>> {
    const missionSource = serializeMissionPackage(mission);
    const taskSource = renderTaskMd(mission);
    const missionsDirectory = join(this.founderDirectory, MISSIONS_DIRECTORY);
    const workItemMissionsDirectory = join(
      missionsDirectory,
      identity.work_item_id,
    );
    const reviewPatchCycle =
      mission.identity.phase === "review" &&
      "review_subject" in mission &&
      mission.review_subject.source === "patch"
        ? mission.review_subject.patch_cycle
        : undefined;
    const missionDirectory = join(
      workItemMissionsDirectory,
      this.missionDirectoryName(identity, reviewPatchCycle),
    );

    await this.ensureDirectory(missionsDirectory);
    await this.ensureDirectory(workItemMissionsDirectory);
    if (await this.hasSafeDirectory(missionDirectory)) {
      await this.assertMissionSnapshot(
        missionDirectory,
        mission,
        missionSource,
        taskSource,
      );
      return this.missionWriteResult(mission, missionDirectory);
    }

    const stagingDirectory = join(
      workItemMissionsDirectory,
      `.${this.missionDirectoryName(identity, reviewPatchCycle)}.${randomUUID()}.mission.tmp`,
    );
    await mkdir(stagingDirectory);
    try {
      await writeFile(join(stagingDirectory, MISSION_JSON_FILE), missionSource, {
        encoding: "utf8",
        flag: "wx",
      });
      await writeFile(join(stagingDirectory, TASK_MD_FILE), taskSource, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(stagingDirectory, missionDirectory);
    } catch (error) {
      await this.removeMissionStagingDirectory(stagingDirectory, error);
      if (
        isNodeError(error) &&
        ["EEXIST", "ENOTEMPTY"].includes(error.code ?? "") &&
        (await this.hasSafeDirectory(missionDirectory))
      ) {
        await this.assertMissionSnapshot(
          missionDirectory,
          mission,
          missionSource,
          taskSource,
        );
        return this.missionWriteResult(mission, missionDirectory);
      }
      throw error;
    }

    await this.assertMissionSnapshot(
      missionDirectory,
      mission,
      missionSource,
      taskSource,
    );
    return this.missionWriteResult(mission, missionDirectory);
  }

  private async readMissionPackageSnapshot(
    identity: MissionIdentity,
    reviewPatchCycle?: number,
  ): Promise<{
    mission: ReadableMissionPackage;
    missionDirectory: string;
    missionPath: string;
    relativeDirectory: string;
    relativeMissionPath: string;
  }> {
    await this.readManifest();
    const relativeDirectory = posix.join(
      FOUNDER_DIRECTORY,
      MISSIONS_DIRECTORY,
      identity.work_item_id,
      this.missionDirectoryName(identity, reviewPatchCycle),
    );
    const missionsDirectory = join(this.founderDirectory, MISSIONS_DIRECTORY);
    const workItemMissionsDirectory = join(
      missionsDirectory,
      identity.work_item_id,
    );
    const missionDirectory = join(
      workItemMissionsDirectory,
      this.missionDirectoryName(identity, reviewPatchCycle),
    );
    await this.assertDirectory(missionsDirectory);
    await this.assertDirectory(workItemMissionsDirectory);
    await this.assertDirectory(missionDirectory);

    const missionPath = join(missionDirectory, MISSION_JSON_FILE);
    const missionSource = await this.readRequiredFile(missionPath);
    const mission = this.parseJson(
      missionSource,
      missionPath,
      readableMissionPackageSchema,
    );
    const expectedPaths = this.missionPaths(
      identity,
      mission.source_revision.git_base_commit,
      reviewPatchCycle,
    );
    if (
      JSON.stringify(mission.identity) !== JSON.stringify(identity) ||
      mission.task_path !== expectedPaths.task_path ||
      mission.result_contract.output_path !== expectedPaths.output_path
    ) {
      throw this.invalid(
        missionDirectory,
        "mission snapshot identity and paths do not match its containing directory",
      );
    }
    await this.assertMissionSnapshot(
      missionDirectory,
      mission,
      serializeReadableMissionPackage(mission),
      renderReadableTaskMd(mission),
    );
    return {
      mission,
      missionDirectory,
      missionPath,
      relativeDirectory,
      relativeMissionPath: posix.join(
        relativeDirectory,
        MISSION_JSON_FILE,
      ),
    };
  }

  private missionPaths(
    identity: MissionIdentity,
    gitBaseCommit: string,
    reviewPatchCycle?: number,
    scopeBaseCommit?: string,
  ): MissionPaths {
    const relativeDirectory = posix.join(
      FOUNDER_DIRECTORY,
      MISSIONS_DIRECTORY,
      identity.work_item_id,
      this.missionDirectoryName(identity, reviewPatchCycle),
    );
    return {
      task_path: posix.join(relativeDirectory, TASK_MD_FILE),
      output_path: posix.join(relativeDirectory, RESULT_JSON_FILE),
      git_base_commit: gitBaseCommit,
      ...(scopeBaseCommit === undefined || scopeBaseCommit === gitBaseCommit
        ? {}
        : { scope_base_commit: scopeBaseCommit }),
    };
  }

  private async resolveGitBaseCommit(): Promise<string> {
    try {
      return await this.gitAdapter.readHeadCommit();
    } catch (error) {
      throw this.invalid(
        ".git",
        `cannot resolve the mission Git base commit: ${errorMessage(error)}`,
      );
    }
  }

  private async governedTupleGitBaseCommit(
    identity: MissionIdentity,
  ): Promise<string> {
    for (let attempt = 0; attempt < identity.attempt; attempt += 1) {
      const compiledBase = await this.compiledGitBaseCommit({
        ...identity,
        attempt,
      });
      if (compiledBase !== null) {
        return compiledBase;
      }
    }
    return this.resolveGitBaseCommit();
  }

  private async compiledGitBaseCommit(
    identity: MissionIdentity,
  ): Promise<string | null> {
    const missionPath = join(
      this.founderDirectory,
      MISSIONS_DIRECTORY,
      identity.work_item_id,
      this.missionDirectoryName(identity),
      MISSION_JSON_FILE,
    );
    let source: string;
    try {
      source = await readFile(missionPath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
    const mission = this.parseJson(
      source,
      missionPath,
      readableMissionPackageSchema,
    );
    return mission.source_revision.git_base_commit;
  }

  private missionDirectoryName(
    identity: MissionIdentity,
    reviewPatchCycle?: number,
  ): string {
    const base = [
      identity.phase,
      identity.goal_version,
      identity.input_revision,
      identity.attempt,
    ].join("-");
    if (identity.phase === "patch") {
      return `${base}-${identity.patch_cycle}`;
    }
    if (identity.phase === "review" && reviewPatchCycle !== undefined) {
      return `${base}-patch-${reviewPatchCycle}`;
    }
    return base;
  }

  private missionWriteResult<TMission extends MissionPackage>(
    mission: TMission,
    missionDirectory: string,
  ): MissionArtifactWriteResult<TMission> {
    return {
      mission,
      workspace_path: this.workspaceRoot,
      task_path: join(missionDirectory, TASK_MD_FILE),
      mission_path: join(missionDirectory, MISSION_JSON_FILE),
    };
  }

  private async assertMissionSnapshot(
    missionDirectory: string,
    mission: ReadableMissionPackage,
    missionSource: string,
    taskSource: string,
  ): Promise<void> {
    const missionPath = join(missionDirectory, MISSION_JSON_FILE);
    const taskPath = join(missionDirectory, TASK_MD_FILE);
    const existingMissionSource = await this.readOptionalFile(missionPath);
    const existingTaskSource = await this.readOptionalFile(taskPath);
    if (existingMissionSource === null || existingTaskSource === null) {
      throw this.invalid(
        missionDirectory,
        "immutable mission snapshot must contain both mission.json and TASK.md",
      );
    }

    const existingMission = this.parseJson(
      existingMissionSource,
      missionPath,
      readableMissionPackageSchema,
    );
    if (
      JSON.stringify(existingMission) !== JSON.stringify(mission) ||
      existingMissionSource !== missionSource
    ) {
      throw this.invalid(
        missionDirectory,
        "immutable mission snapshot differs from the compiled package",
      );
    }
    await this.rederiveTaskMd(
      missionDirectory,
      taskPath,
      existingTaskSource,
      taskSource,
    );
  }

  /**
   * TASK.md is a pure rendering of mission.json, so a difference there is
   * staleness after a guidance-text change, never tampering: the governed
   * contract is mission.json, which is compared byte-for-byte above. Re-deriving
   * the stale file restores the invariant that the agent reads exactly what the
   * verified mission says. Failing instead would permanently strand every
   * mission compiled before the renderer changed.
   */
  private async rederiveTaskMd(
    missionDirectory: string,
    taskPath: string,
    existingTaskSource: string,
    taskSource: string,
  ): Promise<void> {
    if (existingTaskSource === taskSource) {
      return;
    }
    const temporaryTaskPath = join(
      missionDirectory,
      `.${TASK_MD_FILE}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporaryTaskPath, taskSource, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporaryTaskPath, taskPath);
    } catch (error) {
      try {
        await unlink(temporaryTaskPath);
      } catch (cleanupError) {
        if (!isNodeError(cleanupError) || cleanupError.code !== "ENOENT") {
          throw new AggregateError(
            [error, cleanupError],
            "Stale TASK.md re-derivation failed and cleanup was incomplete",
          );
        }
      }
      throw error;
    }
  }

  private async removeMissionStagingDirectory(
    stagingDirectory: string,
    originalError: unknown,
  ): Promise<void> {
    try {
      await rm(stagingDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [originalError, cleanupError],
        "Mission snapshot publication failed and staging cleanup was incomplete",
      );
    }
  }

  private missionNotReady(
    workItemId: string,
    reason: string,
  ): ControllerConflictError {
    return new ControllerConflictError(
      "mission_not_ready",
      workItemId,
      reason,
    );
  }

  private semanticEventPaths(workItemId: string): {
    root: string;
    item: string;
    stream: string;
    intents: string;
    events: string;
    intent: (intentId: string) => string;
    event: (sequence: number) => string;
  } {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const root = join(this.founderDirectory, SEMANTIC_EVENTS_DIRECTORY);
    const item = join(root, validatedWorkItemId);
    const intents = join(item, SEMANTIC_EVENT_INTENTS_DIRECTORY);
    const events = join(item, SEMANTIC_EVENT_FILES_DIRECTORY);
    return {
      root,
      item,
      stream: join(item, SEMANTIC_EVENT_STREAM_FILE),
      intents,
      events,
      intent: (intentId) =>
        join(intents, `${SHA256_SCHEMA.parse(intentId)}.json`),
      event: (sequence) => {
        const validatedSequence = z.number().int().positive().safe().parse(
          sequence,
        );
        return join(events, `${String(validatedSequence).padStart(16, "0")}.json`);
      },
    };
  }

  private async ensureSemanticEventStream(
    workItemId: string,
  ): Promise<SemanticEventStreamHeaderV1> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    await this.readManifest();
    if (
      !(await this.hasSafeWorkItemsDirectory()) ||
      (await this.readValidated(validatedWorkItemId)) === null
    ) {
      throw new ControllerConflictError(
        "work_item_not_found",
        validatedWorkItemId,
        `Work item ${validatedWorkItemId} was not found.`,
      );
    }

    const paths = this.semanticEventPaths(validatedWorkItemId);
    await this.ensureDirectory(paths.root);
    await this.ensureDirectory(paths.item);
    await this.ensureDirectory(paths.intents);
    await this.ensureDirectory(paths.events);

    const header = semanticEventStreamHeaderSchema.parse({
      schema_version: 1,
      work_item_id: validatedWorkItemId,
    });
    const source = `${JSON.stringify(header, null, 2)}\n`;
    try {
      await writeFile(paths.stream, source, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
      const existingSource = await this.readRequiredFile(paths.stream);
      const existing = this.parseJson(
        existingSource,
        paths.stream,
        semanticEventStreamHeaderSchema,
      );
      if (existingSource !== source || existing.work_item_id !== validatedWorkItemId) {
        throw this.invalid(
          paths.stream,
          "semantic event stream header differs from its immutable identity",
        );
      }
      return existing;
    }
    return header;
  }

  private async readSemanticEventStreamHeader(
    workItemId: string,
  ): Promise<SemanticEventStreamHeaderV1 | null> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const paths = this.semanticEventPaths(validatedWorkItemId);
    if (!(await this.hasSafeDirectory(paths.root))) {
      return null;
    }
    if (!(await this.hasSafeDirectory(paths.item))) {
      return null;
    }
    await this.assertDirectory(paths.intents);
    await this.assertDirectory(paths.events);
    const source = await this.readRequiredFile(paths.stream);
    const header = this.parseJson(
      source,
      paths.stream,
      semanticEventStreamHeaderSchema,
    );
    if (header.work_item_id !== validatedWorkItemId) {
      throw this.invalid(
        paths.stream,
        `work_item_id must equal containing directory name ${validatedWorkItemId}`,
      );
    }
    return header;
  }

  private async writeSemanticEventIntentFile(
    workItemId: string,
    input: SemanticEventIntentV1,
  ): Promise<SemanticEventIntentV1> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const intent = semanticEventIntentSchema.parse(input);
    if (intent.work_item_id !== validatedWorkItemId) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        validatedWorkItemId,
        "Semantic event intent work_item_id must match its stream.",
      );
    }
    await this.ensureSemanticEventStream(validatedWorkItemId);
    const paths = this.semanticEventPaths(validatedWorkItemId);
    const intentPath = paths.intent(intent.intent_id);
    const source = canonicalSerializeSemanticEventIntent(intent);
    try {
      await writeFile(intentPath, source, {
        encoding: "utf8",
        flag: "wx",
      });
      await this.afterSemanticIntentWritten();
      return intent;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
      const existingSource = await this.readRequiredFile(intentPath);
      const existing = this.parseJson(
        existingSource,
        intentPath,
        semanticEventIntentSchema,
      );
      if (existingSource === source) {
        return existing;
      }
      throw new ControllerConflictError(
        "idempotency_conflict",
        validatedWorkItemId,
        `Semantic event intent ${intent.intent_id} differs from the immutable record.`,
      );
    }
  }

  private async readSemanticEventIntentFile(
    workItemId: string,
    intentId: string,
  ): Promise<SemanticEventIntentV1 | null> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const validatedIntentId = SHA256_SCHEMA.parse(intentId);
    if ((await this.readSemanticEventStreamHeader(validatedWorkItemId)) === null) {
      return null;
    }
    const paths = this.semanticEventPaths(validatedWorkItemId);
    const intentPath = paths.intent(validatedIntentId);
    const source = await this.readOptionalFile(intentPath);
    if (source === null) {
      return null;
    }
    const intent = this.parseJson(
      source,
      intentPath,
      semanticEventIntentSchema,
    );
    if (
      intent.intent_id !== validatedIntentId ||
      intent.work_item_id !== validatedWorkItemId
    ) {
      throw this.invalid(
        intentPath,
        "semantic event intent identity does not match its containing path",
      );
    }
    if (source !== canonicalSerializeSemanticEventIntent(intent)) {
      throw this.invalid(intentPath, "semantic event intent bytes are not canonical");
    }
    return intent;
  }

  private async readSemanticEventFiles(
    workItemId: string,
  ): Promise<SemanticEventV1[]> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    if ((await this.readSemanticEventStreamHeader(validatedWorkItemId)) === null) {
      return [];
    }
    const paths = this.semanticEventPaths(validatedWorkItemId);
    const entries = await readdir(paths.events, { withFileTypes: true });
    const events: SemanticEventV1[] = [];
    const intentIds = new Set<string>();
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const match = SEMANTIC_EVENT_FILE_PATTERN.exec(entry.name);
      if (
        match === null ||
        !entry.isFile() ||
        entry.isSymbolicLink()
      ) {
        throw this.invalid(
          join(paths.events, entry.name),
          "semantic event entries must be fixed-width regular JSON files",
        );
      }
      const sequence = Number.parseInt(match[1]!, 10);
      if (!Number.isSafeInteger(sequence) || sequence < 1) {
        throw this.invalid(
          join(paths.events, entry.name),
          "semantic event filename must contain a positive safe sequence",
        );
      }
      const expectedSequence = events.length + 1;
      if (sequence !== expectedSequence) {
        throw this.invalid(
          join(paths.events, entry.name),
          `semantic event sequence must be contiguous at ${expectedSequence}`,
        );
      }
      const eventPath = paths.event(sequence);
      const source = await this.readRequiredFile(eventPath);
      const event = this.parseJson(source, eventPath, semanticEventSchema);
      if (
        event.stream_sequence !== sequence ||
        event.work_item_id !== validatedWorkItemId
      ) {
        throw this.invalid(
          eventPath,
          "semantic event identity does not match its containing path",
        );
      }
      if (intentIds.has(event.intent_id)) {
        throw this.invalid(
          eventPath,
          `semantic event intent ${event.intent_id} is published more than once`,
        );
      }
      if (source !== canonicalSerializeSemanticEvent(event)) {
        throw this.invalid(eventPath, "semantic event bytes are not canonical");
      }
      intentIds.add(event.intent_id);
      events.push(event);
    }
    return events;
  }

  private async readSemanticEventIntentFiles(
    workItemId: string,
  ): Promise<SemanticEventIntentV1[]> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    if ((await this.readSemanticEventStreamHeader(validatedWorkItemId)) === null) {
      return [];
    }
    const paths = this.semanticEventPaths(validatedWorkItemId);
    const entries = await readdir(paths.intents, { withFileTypes: true });
    const intents: SemanticEventIntentV1[] = [];
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const match = SEMANTIC_INTENT_FILE_PATTERN.exec(entry.name);
      if (match === null || !entry.isFile() || entry.isSymbolicLink()) {
        throw this.invalid(
          join(paths.intents, entry.name),
          "semantic intent entries must be SHA-256-named regular JSON files",
        );
      }
      const intent = await this.readSemanticEventIntentFile(
        validatedWorkItemId,
        match[1]!,
      );
      if (intent === null) {
        throw this.invalid(
          join(paths.intents, entry.name),
          "listed semantic intent is missing",
        );
      }
      intents.push(intent);
    }
    return intents;
  }

  private async withSemanticEventAppendLock<T>(
    workItemId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const paths = this.semanticEventPaths(validatedWorkItemId);
    const lockPath = join(paths.item, ".append.lock");
    const token = `${randomUUID()}\n`;
    let handle = null;
    for (let attempt = 0; attempt < 5_000; attempt += 1) {
      try {
        handle = await open(lockPath, "wx");
        break;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw error;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
      }
    }
    if (handle === null) {
      throw new ControllerConflictError(
        "repair_required",
        validatedWorkItemId,
        "Semantic event append lock remained unavailable.",
      );
    }

    let operationError: unknown = null;
    try {
      await handle.writeFile(token, { encoding: "utf8" });
      await handle.sync();
      return await operation();
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try {
        await handle.close();
        const storedToken = await this.readRequiredFile(lockPath);
        if (storedToken !== token) {
          throw this.invalid(lockPath, "semantic event append lock changed owner");
        }
        await unlink(lockPath);
      } catch (cleanupError) {
        if (operationError !== null) {
          throw new AggregateError(
            [operationError, cleanupError],
            "Semantic event publication failed and its append lock could not be released",
          );
        }
        throw cleanupError;
      }
    }
  }

  private async publishSemanticLaunchBeforeFinish(
    finishIntent: SemanticEventIntentV1,
  ): Promise<void> {
    if (finishIntent.run === null) {
      throw this.semanticSourceNotPublishable(finishIntent);
    }
    const launchIntent = (
      await this.readSemanticEventIntentFiles(finishIntent.work_item_id)
    ).find(
      (candidate) =>
        candidate.kind === "run_launched" &&
        candidate.run?.family === finishIntent.run?.family &&
        (candidate.run?.family === "connected"
          ? candidate.run.connected_run_id ===
            (finishIntent.run?.family === "connected"
              ? finishIntent.run.connected_run_id
              : null)
          : candidate.run?.family === "shaping" &&
            candidate.run.shaping_run_id ===
              (finishIntent.run?.family === "shaping"
                ? finishIntent.run.shaping_run_id
                : null)),
    );
    if (launchIntent === undefined) {
      throw new ControllerConflictError(
        "repair_required",
        finishIntent.work_item_id,
        `Semantic run finish ${finishIntent.intent_id} has no durable launch intent.`,
      );
    }
    await this.publishSemanticEventIntent(
      finishIntent.work_item_id,
      launchIntent.intent_id,
    );
  }

  private async verifySemanticAuthoritativeSource(
    intent: SemanticEventIntentV1,
  ): Promise<void> {
    const source = intent.source;
    switch (source.kind) {
      case "controller_run": {
        const manifest = await this.readControllerRunManifest(
          intent.work_item_id,
          source.controller_run_id,
        );
        if (
          manifest === null ||
          manifest.run_id !== source.controller_run_id ||
          manifest.work_item_id !== intent.work_item_id ||
          manifest.outcome !== source.expected_outcome
        ) {
          throw this.semanticSourceNotPublishable(intent);
        }
        return;
      }
      case "shaping_decision": {
        const manifest = await this.readShapingDecisionManifest(
          intent.work_item_id,
          source.decision_id,
        );
        if (
          manifest === null ||
          manifest.decision_id !== source.decision_id ||
          manifest.work_item_id !== intent.work_item_id ||
          manifest.outcome !== source.expected_outcome
        ) {
          throw this.semanticSourceNotPublishable(intent);
        }
        return;
      }
      case "plan_approval": {
        const manifest = await this.readPlanApprovalManifest(
          intent.work_item_id,
          source.approval_id,
        );
        if (
          manifest === null ||
          manifest.approval_id !== source.approval_id ||
          manifest.work_item_id !== intent.work_item_id ||
          manifest.outcome !== source.expected_outcome
        ) {
          throw this.semanticSourceNotPublishable(intent);
        }
        return;
      }
      case "connected_run": {
        const record = await this.readConnectedRun(
          intent.work_item_id,
          source.connected_run_id,
        );
        if (
          record === null ||
          record.connected_run_id !== source.connected_run_id ||
          record.mission.identity.work_item_id !== intent.work_item_id ||
          record.mission.content_sha256 !== source.mission_content_sha256 ||
          !this.semanticLifecycleReached(
            source.expected_lifecycle_status,
            record.lifecycle.status,
          )
        ) {
          throw this.semanticSourceNotPublishable(intent);
        }
        this.assertSemanticConnectedRunSource(intent, record);
        return;
      }
      case "shaping_run": {
        const record = await this.readShapingRun(
          intent.work_item_id,
          source.shaping_run_id,
        );
        if (
          record === null ||
          record.shaping_run_id !== source.shaping_run_id ||
          record.mission.work_item_id !== intent.work_item_id ||
          record.mission.content_sha256 !== source.mission_content_sha256 ||
          !this.semanticLifecycleReached(
            source.expected_lifecycle_status,
            record.lifecycle.status,
          )
        ) {
          throw this.semanticSourceNotPublishable(intent);
        }
        this.assertSemanticShapingRunSource(intent, record);
      }
    }
  }

  private assertSemanticConnectedRunSource(
    intent: SemanticEventIntentV1,
    record: ConnectedRunRecordV2,
  ): void {
    const runMatches =
      intent.run?.family === "connected" &&
      intent.run.connected_run_id === record.connected_run_id &&
      intent.run.phase === record.mission.identity.phase;
    const actorMatches =
      intent.actor.kind === "connected_run" &&
      intent.actor.connected_run_id === record.connected_run_id &&
      (intent.kind === "run_launched" ||
        isDeepStrictEqual(intent.actor.provenance, record.provenance));
    const detailsMatch =
      intent.source.kind === "connected_run" &&
      intent.details.kind === intent.kind &&
      (intent.details.kind === "run_launched" ||
      intent.details.kind === "run_finished"
        ? intent.details.run_family === "connected" &&
          intent.details.run_id === record.connected_run_id &&
          intent.details.phase === record.mission.identity.phase &&
          (intent.details.kind === "run_launched"
            ? intent.details.lifecycle_status ===
              intent.source.expected_lifecycle_status
            : record.lifecycle.status === "terminal" &&
              record.lifecycle.terminal !== null &&
              intent.details.terminal_outcome ===
                record.lifecycle.terminal.outcome &&
              intent.details.partial === record.lifecycle.terminal.partial)
        : true);
    if (!runMatches || !actorMatches || !detailsMatch) {
      throw this.semanticSourceNotPublishable(intent);
    }
  }

  private assertSemanticShapingRunSource(
    intent: SemanticEventIntentV1,
    record: ShapingRunRecordV1,
  ): void {
    const runMatches =
      intent.run?.family === "shaping" &&
      intent.run.shaping_run_id === record.shaping_run_id &&
      intent.run.phase === record.mission.phase;
    const actorMatches =
      intent.actor.kind === "shaping_run" &&
      intent.actor.shaping_run_id === record.shaping_run_id &&
      (intent.kind === "run_launched" ||
        isDeepStrictEqual(intent.actor.provenance, record.provenance));
    const detailsMatch =
      intent.source.kind === "shaping_run" &&
      intent.details.kind === intent.kind &&
      (intent.details.kind === "run_launched" ||
      intent.details.kind === "run_finished"
        ? intent.details.run_family === "shaping" &&
          intent.details.run_id === record.shaping_run_id &&
          intent.details.phase === record.mission.phase &&
          (intent.details.kind === "run_launched"
            ? intent.details.lifecycle_status ===
              intent.source.expected_lifecycle_status
            : record.lifecycle.status === "terminal" &&
              record.lifecycle.terminal !== null &&
              intent.details.terminal_outcome ===
                record.lifecycle.terminal.outcome &&
              intent.details.partial === record.lifecycle.terminal.partial)
        : true);
    if (!runMatches || !actorMatches || !detailsMatch) {
      throw this.semanticSourceNotPublishable(intent);
    }
  }

  private semanticLifecycleReached(
    expected: "starting" | "running" | "terminal",
    actual: "starting" | "running" | "terminal",
  ): boolean {
    const order = { starting: 0, running: 1, terminal: 2 } as const;
    return order[actual] >= order[expected];
  }

  private semanticSourceNotPublishable(
    intent: SemanticEventIntentV1,
  ): ControllerConflictError {
    return new ControllerConflictError(
      "repair_required",
      intent.work_item_id,
      `Semantic event intent ${intent.intent_id} does not have its exact applied or terminal authoritative source.`,
    );
  }

  private async resolveSemanticEvidence(
    intent: SemanticEventIntentV1,
  ): Promise<[SemanticEvidenceHandleV1, ...SemanticEvidenceHandleV1[]]> {
    const handles: SemanticEvidenceHandleV1[] = [];
    for (const selector of intent.evidence) {
      const relativePath = workspaceRelativePosixPathSchema.parse(
        selector.path,
      );
      await this.assertSafeWorkspaceDirectoryComponents(
        posix.dirname(relativePath),
      );
      const artifactPath = join(
        this.workspaceRoot,
        ...relativePath.split("/"),
      );
      const bytes = await this.readRequiredArtifactBytes(artifactPath);
      const contentSha256 = this.hashArtifactSource(bytes);
      if (contentSha256 !== selector.expected_content_sha256) {
        throw new ControllerConflictError(
          "repair_required",
          intent.work_item_id,
          `Semantic evidence ${relativePath} differs from intent ${intent.intent_id}.`,
        );
      }
      handles.push({
        kind: selector.kind,
        path: relativePath,
        content_sha256: contentSha256,
      });
    }
    return handles as [
      SemanticEvidenceHandleV1,
      ...SemanticEvidenceHandleV1[],
    ];
  }

  private async readRequiredArtifactBytes(filePath: string): Promise<Buffer> {
    let stats;
    try {
      stats = await lstat(filePath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw this.invalid(filePath, "required evidence file is missing");
      }
      throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw this.invalid(
        filePath,
        "evidence path must be a regular file, not a symlink",
      );
    }
    return readFile(filePath);
  }

  private assertSemanticEventMatchesIntent(
    intent: SemanticEventIntentV1,
    evidence: [SemanticEvidenceHandleV1, ...SemanticEvidenceHandleV1[]],
    existing: SemanticEventV1,
  ): SemanticEventV1 {
    const expected = semanticEventSchema.parse({
      schema_version: 1,
      event_id: existing.event_id,
      stream_sequence: existing.stream_sequence,
      kind: intent.kind,
      work_item_id: intent.work_item_id,
      binding: intent.binding,
      run: intent.run,
      actor: intent.actor,
      outcome: intent.outcome,
      occurred_at: intent.occurred_at,
      recorded_at: existing.recorded_at,
      evidence,
      action: intent.action,
      details: intent.details,
      intent_id: intent.intent_id,
    });
    if (!isDeepStrictEqual(existing, expected)) {
      throw this.invalid(
        this.semanticEventPaths(intent.work_item_id).event(
          existing.stream_sequence,
        ),
        `semantic event does not exactly match intent ${intent.intent_id}`,
      );
    }
    return existing;
  }

  private shapingDecisionPaths(
    workItemId: string,
    decisionId: string,
  ): { directory: string; intent: string; manifest: string } {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const validatedDecisionId = SHA256_SCHEMA.parse(decisionId);
    const directory = join(
      this.workItemsDirectory,
      validatedWorkItemId,
      SHAPING_DECISIONS_DIRECTORY,
    );
    return {
      directory,
      intent: join(directory, `${validatedDecisionId}.intent.json`),
      manifest: join(directory, `${validatedDecisionId}.json`),
    };
  }

  private planApprovalPaths(
    workItemId: string,
    approvalId: string,
  ): { directory: string; intent: string; manifest: string } {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const validatedApprovalId = SHA256_SCHEMA.parse(approvalId);
    const directory = join(
      this.workItemsDirectory,
      validatedWorkItemId,
      PLAN_APPROVALS_DIRECTORY,
    );
    return {
      directory,
      intent: join(directory, `${validatedApprovalId}.intent.json`),
      manifest: join(directory, `${validatedApprovalId}.json`),
    };
  }

  private parseCanonicalPlanApprovalReceipt(
    source: string,
    workItemId: string,
  ): PlanApprovalReceipt {
    let receipt: PlanApprovalReceipt;
    try {
      receipt = planApprovalReceiptSchema.parse(JSON.parse(source) as unknown);
    } catch (error) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        `Plan approval receipt bytes are invalid: ${errorMessage(error)}`,
      );
    }
    if (`${JSON.stringify(receipt, null, 2)}\n` !== source) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        "Plan approval receipt bytes are not canonical.",
      );
    }
    return receipt;
  }

  private planApprovalIntentReplayIdentity(
    intent: PlanApprovalIntentV1,
  ): object {
    return {
      schema_version: intent.schema_version,
      approval_id: intent.approval_id,
      work_item_id: intent.work_item_id,
      launch_mode: intent.launch_mode,
      requested_model: intent.requested_model,
      expected_mission_content_sha256:
        intent.expected_mission_content_sha256,
      expected_result_content_sha256:
        intent.expected_result_content_sha256,
      expected_shaping_state_sha256:
        intent.expected_shaping_state_sha256,
      goal_contract_sha256: intent.goal_contract_sha256,
      goal_version: intent.goal_version,
      next_goal_bytes: intent.next_goal_bytes,
      next_goal_sha256: intent.next_goal_sha256,
      next_state_bytes: intent.next_state_bytes,
      next_state_sha256: intent.next_state_sha256,
      receipt_bytes: intent.receipt_bytes,
      receipt_sha256: intent.receipt_sha256,
      execute_tuple: intent.execute_tuple,
    };
  }

  private validateStoredPlanApprovalIntent(
    intent: PlanApprovalIntentV1,
  ): void {
    let receipt: PlanApprovalReceipt;
    let nextItem: WorkItem;
    try {
      receipt = this.parseCanonicalPlanApprovalReceipt(
        intent.receipt_bytes,
        intent.work_item_id,
      );
      nextItem = this.parseWorkItemBytes(
        intent.next_goal_bytes,
        intent.next_state_bytes,
        intent.work_item_id,
      );
    } catch (error) {
      throw new ControllerConflictError(
        "repair_required",
        intent.work_item_id,
        `Stored Plan approval intent bytes need repair: ${errorMessage(error)}`,
      );
    }
    if (
      intent.approval_id !== derivePlanApprovalId(intent) ||
      intent.previous_goal_sha256 !==
        this.hashArtifactSource(intent.previous_goal_bytes) ||
      intent.previous_state_sha256 !==
        this.hashArtifactSource(intent.previous_state_bytes) ||
      intent.next_goal_sha256 !==
        this.hashArtifactSource(intent.next_goal_bytes) ||
      intent.next_state_sha256 !==
        this.hashArtifactSource(intent.next_state_bytes) ||
      intent.receipt_sha256 !==
        this.hashArtifactSource(intent.receipt_bytes) ||
      receipt.identity.work_item_id !== intent.work_item_id ||
      receipt.mission_content_sha256 !==
        intent.expected_mission_content_sha256 ||
      receipt.result_content_sha256 !==
        intent.expected_result_content_sha256 ||
      receipt.goal_contract_sha256 !== intent.goal_contract_sha256 ||
      receipt.goal_version !== intent.goal_version ||
      !isDeepStrictEqual(receipt.execute_tuple, intent.execute_tuple) ||
      nextItem.goal.goal_contract === undefined ||
      hashGoalContract(nextItem.goal.goal_contract) !==
        intent.goal_contract_sha256 ||
      nextItem.state.phase !== "execute" ||
      nextItem.state.status !== "active" ||
      nextItem.state.active_run !== undefined ||
      nextItem.state.goal_version !== intent.execute_tuple.goal_version ||
      nextItem.state.input_revision !==
        intent.execute_tuple.input_revision ||
      nextItem.state.attempt !== 0
    ) {
      throw new ControllerConflictError(
        "repair_required",
        intent.work_item_id,
        "Stored Plan approval intent hashes and governed bindings do not match its durable bytes.",
      );
    }
  }

  private async readMatchingPlanApprovalIntent(
    workItemId: string,
    approvalId: string,
    draft: PlanApprovalIntentCaptureInput["intent"],
    nextGoalBytes: string,
    nextStateBytes: string,
  ): Promise<PlanApprovalIntentWriteResult | null> {
    const paths = this.planApprovalPaths(workItemId, approvalId);
    const source = await this.readOptionalFile(paths.intent);
    if (source === null) {
      return null;
    }
    let intent: PlanApprovalIntentV1;
    try {
      intent = this.parseJson(
        source,
        paths.intent,
        planApprovalIntentSchema,
      );
      this.validateStoredPlanApprovalIntent(intent);
    } catch (error) {
      if (
        error instanceof ControllerConflictError &&
        error.kind === "repair_required"
      ) {
        throw error;
      }
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        `Stored Plan approval intent ${approvalId} needs repair: ${errorMessage(error)}`,
      );
    }
    const expectedIdentity = {
      approval_id: approvalId,
      ...draft,
      next_goal_bytes: nextGoalBytes,
      next_goal_sha256: this.hashArtifactSource(nextGoalBytes),
      next_state_bytes: nextStateBytes,
      next_state_sha256: this.hashArtifactSource(nextStateBytes),
    };
    if (
      !isDeepStrictEqual(
        this.planApprovalIntentReplayIdentity(intent),
        expectedIdentity,
      )
    ) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        `Stored Plan approval intent ${approvalId} differs from its replay.`,
      );
    }
    return {
      intent,
      intent_path: paths.intent,
      intent_source: source,
    };
  }

  private async readRequiredPlanApprovalIntent(
    workItemId: string,
    approvalId: string,
  ): Promise<PlanApprovalIntentV1> {
    const paths = this.planApprovalPaths(workItemId, approvalId);
    const source = await this.readOptionalFile(paths.intent);
    if (source === null) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        `Plan approval ${approvalId} has no durable intent.`,
      );
    }
    try {
      const intent = this.parseJson(
        source,
        paths.intent,
        planApprovalIntentSchema,
      );
      this.validateStoredPlanApprovalIntent(intent);
      return intent;
    } catch (error) {
      if (error instanceof ControllerConflictError) {
        throw error;
      }
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        `Stored Plan approval intent ${approvalId} needs repair: ${errorMessage(error)}`,
      );
    }
  }

  private async readPlanApprovalManifestFile(
    workItemId: string,
    approvalId: string,
  ): Promise<PlanApprovalManifestV1 | null> {
    const paths = this.planApprovalPaths(workItemId, approvalId);
    const source = await this.readOptionalFile(paths.manifest);
    return source === null
      ? null
      : this.parseJson(
          source,
          paths.manifest,
          planApprovalManifestSchema,
        );
  }

  private async readPlanApprovalManifests(
    workItemId: string,
  ): Promise<PlanApprovalManifestV1[]> {
    const directory = join(
      this.workItemsDirectory,
      workItemId,
      PLAN_APPROVALS_DIRECTORY,
    );
    if (!(await this.hasSafeDirectory(directory))) {
      return [];
    }
    const manifests: PlanApprovalManifestV1[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.endsWith(".intent.json")) {
        continue;
      }
      const match = /^([0-9a-f]{64})\.json$/.exec(entry.name);
      if (match === null) {
        throw this.invalid(
          join(directory, entry.name),
          "Plan approval entry must use <approval_id>.json",
        );
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw this.invalid(
          join(directory, entry.name),
          "Plan approval manifest must be a regular file",
        );
      }
      const manifest = await this.readPlanApprovalManifest(
        workItemId,
        match[1],
      );
      if (manifest === null) {
        throw new ControllerConflictError(
          "repair_required",
          workItemId,
          `Plan approval manifest ${match[1]} disappeared while it was being read.`,
        );
      }
      manifests.push(manifest);
    }
    return manifests.sort((left, right) =>
      left.approval_id.localeCompare(right.approval_id),
    );
  }

  private async findPendingPlanApprovalManifest(
    workItemId: string,
  ): Promise<PlanApprovalManifestV1 | null> {
    const directory = join(
      this.workItemsDirectory,
      workItemId,
      PLAN_APPROVALS_DIRECTORY,
    );
    if (!(await this.hasSafeDirectory(directory))) {
      return null;
    }
    const pending: PlanApprovalManifestV1[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.endsWith(".intent.json")) {
        continue;
      }
      const match = /^([0-9a-f]{64})\.json$/.exec(entry.name);
      if (match === null) {
        throw this.invalid(
          join(directory, entry.name),
          "Plan approval entry must use <approval_id>.json",
        );
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw this.invalid(
          join(directory, entry.name),
          "Plan approval manifest must be a regular file",
        );
      }
      const manifest = await this.readPlanApprovalManifestFile(
        workItemId,
        match[1],
      );
      if (manifest?.outcome === "pending") {
        pending.push(manifest);
      }
    }
    if (pending.length > 1) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        `Work item ${workItemId} has ${pending.length} pending Plan approvals.`,
      );
    }
    return pending[0] ?? null;
  }

  private async writeInitialPlanApprovalManifest(
    manifest: PlanApprovalManifestV1,
  ): Promise<void> {
    const validated = planApprovalManifestSchema.parse(manifest);
    const paths = this.planApprovalPaths(
      validated.work_item_id,
      validated.approval_id,
    );
    await this.ensureDirectory(paths.directory);
    await writeFile(
      paths.manifest,
      `${JSON.stringify(validated, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  }

  private async writePlanApprovalManifest(
    manifest: PlanApprovalManifestV1,
  ): Promise<void> {
    const validated = planApprovalManifestSchema.parse(manifest);
    const paths = this.planApprovalPaths(
      validated.work_item_id,
      validated.approval_id,
    );
    await this.writeJsonAtomically(paths.manifest, validated);
  }

  private validatePlanApprovalCommit(
    lease: ControllerLease,
    nextGoal: WorkItemGoal,
    nextState: WorkItemState,
    manifest: PlanApprovalManifestV1,
  ): void {
    const workItemId = lease.work_item.goal.work_item_id;
    if (
      !isDeepStrictEqual(nextGoal, lease.work_item.goal) ||
      nextGoal.work_item_id !== workItemId ||
      nextGoal.goal_contract === undefined ||
      nextState.work_item_id !== workItemId ||
      nextState.phase !== "execute" ||
      nextState.status !== "active" ||
      nextState.active_run !== undefined ||
      nextState.goal_version !== lease.work_item.state.goal_version ||
      nextState.input_revision !== lease.work_item.state.input_revision ||
      nextState.attempt !== 0 ||
      nextState.patch_cycle !== lease.work_item.state.patch_cycle ||
      manifest.outcome !== "pending" ||
      manifest.work_item_id !== workItemId ||
      manifest.goal_contract_sha256 !== hashGoalContract(nextGoal.goal_contract) ||
      manifest.goal_version !== nextState.goal_version ||
      manifest.execute_tuple.goal_version !== nextState.goal_version ||
      manifest.execute_tuple.input_revision !== nextState.input_revision ||
      manifest.execute_tuple.attempt !== nextState.attempt ||
      manifest.goal_sha256 !==
        this.hashArtifactSource(lease.acquired_goal_bytes) ||
      manifest.state_sha256 !==
        this.hashArtifactSource(`${JSON.stringify(nextState, null, 2)}\n`)
    ) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        "Plan approval manifest must match the lease, governed contract, and exact Execute bytes.",
      );
    }
  }

  private planApprovalManifestIdentityMatches(
    left: PlanApprovalManifestV1,
    right: PlanApprovalManifestV1,
  ): boolean {
    const identity = (manifest: PlanApprovalManifestV1) => ({
      schema_version: manifest.schema_version,
      approval_id: manifest.approval_id,
      work_item_id: manifest.work_item_id,
      launch_mode: manifest.launch_mode,
      requested_model: manifest.requested_model,
      expected_mission_content_sha256:
        manifest.expected_mission_content_sha256,
      expected_result_content_sha256:
        manifest.expected_result_content_sha256,
      expected_shaping_state_sha256:
        manifest.expected_shaping_state_sha256,
      goal_contract_sha256: manifest.goal_contract_sha256,
      goal_version: manifest.goal_version,
      receipt_sha256: manifest.receipt_sha256,
      execute_tuple: manifest.execute_tuple,
      goal_sha256: manifest.goal_sha256,
      state_sha256: manifest.state_sha256,
    });
    return isDeepStrictEqual(identity(left), identity(right));
  }

  private assertPlanApprovalManifestMatchesIntent(
    manifest: PlanApprovalManifestV1,
    intent: PlanApprovalIntentV1,
  ): void {
    if (
      manifest.approval_id !== intent.approval_id ||
      manifest.work_item_id !== intent.work_item_id ||
      manifest.launch_mode !== intent.launch_mode ||
      manifest.requested_model !== intent.requested_model ||
      manifest.expected_mission_content_sha256 !==
        intent.expected_mission_content_sha256 ||
      manifest.expected_result_content_sha256 !==
        intent.expected_result_content_sha256 ||
      manifest.expected_shaping_state_sha256 !==
        intent.expected_shaping_state_sha256 ||
      manifest.goal_contract_sha256 !== intent.goal_contract_sha256 ||
      manifest.goal_version !== intent.goal_version ||
      manifest.receipt_sha256 !== intent.receipt_sha256 ||
      !isDeepStrictEqual(manifest.execute_tuple, intent.execute_tuple) ||
      manifest.goal_sha256 !== intent.next_goal_sha256 ||
      manifest.state_sha256 !== intent.next_state_sha256
    ) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        intent.work_item_id,
        "Plan approval manifest does not match its durable intent.",
      );
    }
  }

  private async readDurablePlanApprovalReceipt(
    intent: PlanApprovalIntentV1,
  ): Promise<PlanApprovalReceipt | null> {
    const expected = this.parseCanonicalPlanApprovalReceipt(
      intent.receipt_bytes,
      intent.work_item_id,
    );
    const snapshot = await this.readShapingPackageSnapshot(expected.identity);
    const stored = await this.readStoredShapingArtifact(snapshot);
    if (stored.decision === null) {
      return null;
    }
    if (
      stored.decision.decision_content_sha256 !== intent.receipt_sha256 ||
      `${JSON.stringify(stored.decision.receipt, null, 2)}\n` !==
        intent.receipt_bytes
    ) {
      throw new ControllerConflictError(
        "repair_required",
        intent.work_item_id,
        "Durable Plan approval receipt differs from its intent.",
      );
    }
    return planApprovalReceiptSchema.parse(stored.decision.receipt);
  }

  private async requireDurablePlanApprovalReceipt(
    intent: PlanApprovalIntentV1,
  ): Promise<PlanApprovalReceipt> {
    const receipt = await this.readDurablePlanApprovalReceipt(intent);
    if (receipt === null) {
      throw new ControllerConflictError(
        "repair_required",
        intent.work_item_id,
        `Plan approval ${intent.approval_id} has no immutable receipt.`,
      );
    }
    return receipt;
  }

  private async writePlanApprovalArtifacts(
    intent: PlanApprovalIntentV1,
    injectFailure: boolean,
  ): Promise<void> {
    this.validateStoredPlanApprovalIntent(intent);
    this.parseWorkItemBytes(
      intent.next_goal_bytes,
      intent.next_state_bytes,
      intent.work_item_id,
    );
    const workItemDirectory = join(
      this.workItemsDirectory,
      intent.work_item_id,
    );
    const suffix = randomUUID();
    const temporaryGoalPath = join(
      workItemDirectory,
      `.${GOAL_FILE}.${suffix}.plan-approval.tmp`,
    );
    const temporaryStatePath = join(
      workItemDirectory,
      `.${STATE_FILE}.${suffix}.plan-approval.tmp`,
    );
    const goalPath = join(workItemDirectory, GOAL_FILE);
    const statePath = join(workItemDirectory, STATE_FILE);
    try {
      await writeFile(temporaryGoalPath, intent.next_goal_bytes, {
        encoding: "utf8",
        flag: "wx",
      });
      await writeFile(temporaryStatePath, intent.next_state_bytes, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporaryGoalPath, goalPath);
      await rename(temporaryStatePath, statePath);
      if (injectFailure) {
        await this.afterPlanApprovalStateReplaced();
      }
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      for (const path of [temporaryGoalPath, temporaryStatePath]) {
        try {
          await this.unlinkIfPresent(path);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Plan approval write failed and temporary cleanup was incomplete",
        );
      }
      throw error;
    }
  }

  private assertIntentMissionBytes(
    intent: ShapingDecisionIntentCaptureInput["intent"],
    workItemId: string,
  ): void {
    let mission: ShapingMissionPackage;
    try {
      mission = shapingMissionPackageSchema.parse(
        JSON.parse(intent.next_mission_package_bytes),
      );
    } catch (error) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        `Next shaping mission bytes are invalid: ${errorMessage(error)}`,
      );
    }
    if (
      serializeShapingPackage(mission) !==
        intent.next_mission_package_bytes ||
      mission.identity.work_item_id !== workItemId ||
      mission.identity.phase !== intent.phase_to ||
      mission.identity.input_sha256 !==
        intent.next_mission_input_sha256 ||
      mission.content_sha256 !== intent.next_mission_content_sha256
    ) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        "Next shaping mission bytes do not match the intent's fixed identity and hashes.",
      );
    }
  }

  private shapingIntentReplayIdentity(
    intent: ShapingDecisionIntentV1,
  ): object {
    return {
      schema_version: intent.schema_version,
      decision_id: intent.decision_id,
      work_item_id: intent.work_item_id,
      operation: intent.operation,
      launch_mode: intent.launch_mode,
      phase_from: intent.phase_from,
      phase_to: intent.phase_to,
      goal_input_sha256: intent.goal_input_sha256,
      mission_content_sha256: intent.mission_content_sha256,
      result_content_sha256: intent.result_content_sha256,
      feedback_sha256: intent.feedback_sha256,
      expected_shaping_state_sha256:
        intent.expected_shaping_state_sha256,
      next_requested_model: intent.next_requested_model,
      next_mission_content_sha256:
        intent.next_mission_content_sha256,
      next_mission_input_sha256: intent.next_mission_input_sha256,
      plan_repository_base_commit:
        intent.plan_repository_base_commit,
      plan_goal_contract_sha256:
        intent.plan_goal_contract_sha256,
      plan_goal_version: intent.plan_goal_version,
      launch_fingerprint: intent.launch_fingerprint,
      next_goal_bytes: intent.next_goal_bytes,
      next_goal_sha256: intent.next_goal_sha256,
      next_state_bytes: intent.next_state_bytes,
      next_state_sha256: intent.next_state_sha256,
      decision_receipt_bytes: intent.decision_receipt_bytes,
      next_mission_package_bytes: intent.next_mission_package_bytes,
    };
  }

  private validateStoredShapingDecisionIntent(
    intent: ShapingDecisionIntentV1,
  ): void {
    const expectedDecisionId = deriveShapingDecisionId({
      operation: intent.operation,
      work_item_id: intent.work_item_id,
      goal_input_sha256: intent.goal_input_sha256,
      mission_content_sha256: intent.mission_content_sha256,
      result_content_sha256: intent.result_content_sha256,
      feedback_sha256: intent.feedback_sha256,
      expected_shaping_state_sha256:
        intent.expected_shaping_state_sha256,
    });
    if (
      intent.decision_id !== expectedDecisionId ||
      intent.previous_goal_sha256 !==
        this.hashArtifactSource(intent.previous_goal_bytes) ||
      intent.previous_state_sha256 !==
        this.hashArtifactSource(intent.previous_state_bytes) ||
      intent.next_goal_sha256 !==
        this.hashArtifactSource(intent.next_goal_bytes) ||
      intent.next_state_sha256 !==
        this.hashArtifactSource(intent.next_state_bytes)
    ) {
      throw new ControllerConflictError(
        "repair_required",
        intent.work_item_id,
        "Stored shaping decision intent hashes do not match its durable bytes.",
      );
    }
    this.assertIntentMissionBytes(intent, intent.work_item_id);
  }

  private async readMatchingShapingDecisionIntent(
    workItemId: string,
    decisionId: string,
    draft: ShapingDecisionIntentCaptureInput["intent"],
    nextGoalBytes: string,
    nextStateBytes: string,
  ): Promise<ShapingDecisionIntentWriteResult | null> {
    const paths = this.shapingDecisionPaths(workItemId, decisionId);
    const source = await this.readOptionalFile(paths.intent);
    if (source === null) {
      return null;
    }
    let intent: ShapingDecisionIntentV1;
    try {
      intent = this.parseJson(
        source,
        paths.intent,
        shapingDecisionIntentSchema,
      );
      this.validateStoredShapingDecisionIntent(intent);
    } catch (error) {
      if (
        error instanceof ControllerConflictError &&
        error.kind === "repair_required"
      ) {
        throw error;
      }
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        `Stored shaping decision intent ${decisionId} needs repair: ${errorMessage(error)}`,
      );
    }
    const expectedIdentity = {
      decision_id: decisionId,
      ...draft,
      next_goal_bytes: nextGoalBytes,
      next_goal_sha256: this.hashArtifactSource(nextGoalBytes),
      next_state_bytes: nextStateBytes,
      next_state_sha256: this.hashArtifactSource(nextStateBytes),
    };
    if (
      !isDeepStrictEqual(
        this.shapingIntentReplayIdentity(intent),
        expectedIdentity,
      )
    ) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        `Stored shaping decision intent ${decisionId} differs from its replay.`,
      );
    }
    return {
      intent,
      intent_path: paths.intent,
      intent_source: source,
    };
  }

  private async readRequiredShapingDecisionIntent(
    workItemId: string,
    decisionId: string,
  ): Promise<ShapingDecisionIntentV1> {
    const paths = this.shapingDecisionPaths(workItemId, decisionId);
    const source = await this.readOptionalFile(paths.intent);
    if (source === null) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        `Shaping decision ${decisionId} has no durable intent.`,
      );
    }
    try {
      const intent = this.parseJson(
        source,
        paths.intent,
        shapingDecisionIntentSchema,
      );
      this.validateStoredShapingDecisionIntent(intent);
      return intent;
    } catch (error) {
      if (error instanceof ControllerConflictError) {
        throw error;
      }
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        `Stored shaping decision intent ${decisionId} needs repair: ${errorMessage(error)}`,
      );
    }
  }

  async readShapingDecisionManifest(
    workItemId: string,
    decisionId: string,
  ): Promise<ShapingDecisionManifestV1 | null> {
    const paths = this.shapingDecisionPaths(workItemId, decisionId);
    const source = await this.readOptionalFile(paths.manifest);
    return source === null
      ? null
      : this.parseJson(
          source,
          paths.manifest,
          shapingDecisionManifestSchema,
        );
  }

  async listShapingDecisionManifests(
    workItemId: string,
  ): Promise<ShapingDecisionManifestV1[]> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const directory = join(
      this.workItemsDirectory,
      validatedWorkItemId,
      SHAPING_DECISIONS_DIRECTORY,
    );
    if (!(await this.hasSafeDirectory(directory))) {
      return [];
    }
    const manifests: ShapingDecisionManifestV1[] = [];
    const intentIds = new Set<string>();
    const manifestIds = new Set<string>();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const intentMatch = /^([0-9a-f]{64})\.intent\.json$/.exec(entry.name);
      if (intentMatch !== null) {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          throw this.invalid(
            join(directory, entry.name),
            "shaping decision intent must be a regular file",
          );
        }
        intentIds.add(intentMatch[1]);
        continue;
      }
      const match = /^([0-9a-f]{64})\.json$/.exec(entry.name);
      if (match === null) {
        throw this.invalid(
          join(directory, entry.name),
          "shaping decision entry must use <decision_id>.json",
        );
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw this.invalid(
          join(directory, entry.name),
          "shaping decision manifest must be a regular file",
        );
      }
      manifestIds.add(match[1]);
      const manifest = await this.readShapingDecisionManifest(
        validatedWorkItemId,
        match[1],
      );
      if (
        manifest === null ||
        manifest.work_item_id !== validatedWorkItemId ||
        manifest.decision_id !== match[1]
      ) {
        throw this.invalid(
          join(directory, entry.name),
          "shaping decision manifest identity must match its durable path",
        );
      }
      manifests.push(manifest);
    }
    const incompleteIds = new Set(
      [...intentIds, ...manifestIds].filter(
        (decisionId) =>
          !intentIds.has(decisionId) || !manifestIds.has(decisionId),
      ),
    );
    if (incompleteIds.size > 0) {
      throw new ControllerConflictError(
        "repair_required",
        validatedWorkItemId,
        `Shaping decision ${[...incompleteIds].sort()[0]} has incomplete durable evidence.`,
      );
    }
    return manifests.sort((left, right) =>
      left.started_at === right.started_at
        ? left.decision_id.localeCompare(right.decision_id)
        : left.started_at.localeCompare(right.started_at),
    );
  }

  private async findPendingShapingDecisionManifest(
    workItemId: string,
  ): Promise<ShapingDecisionManifestV1 | null> {
    const directory = join(
      this.workItemsDirectory,
      workItemId,
      SHAPING_DECISIONS_DIRECTORY,
    );
    if (!(await this.hasSafeDirectory(directory))) {
      return null;
    }
    const pending: ShapingDecisionManifestV1[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.endsWith(".intent.json")) {
        continue;
      }
      const match = /^([0-9a-f]{64})\.json$/.exec(entry.name);
      if (match === null) {
        throw this.invalid(
          join(directory, entry.name),
          "shaping decision entry must use <decision_id>.json",
        );
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw this.invalid(
          join(directory, entry.name),
          "shaping decision manifest must be a regular file",
        );
      }
      const manifest = await this.readShapingDecisionManifest(
        workItemId,
        match[1],
      );
      if (manifest?.outcome === "pending") {
        pending.push(manifest);
      }
    }
    if (pending.length > 1) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        `Work item ${workItemId} has ${pending.length} pending shaping decisions.`,
      );
    }
    return pending[0] ?? null;
  }

  private async writeInitialShapingDecisionManifest(
    manifest: ShapingDecisionManifestV1,
  ): Promise<void> {
    const validated = shapingDecisionManifestSchema.parse(manifest);
    const paths = this.shapingDecisionPaths(
      validated.work_item_id,
      validated.decision_id,
    );
    await this.ensureDirectory(paths.directory);
    await writeFile(
      paths.manifest,
      `${JSON.stringify(validated, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  }

  private async writeShapingDecisionManifest(
    manifest: ShapingDecisionManifestV1,
  ): Promise<void> {
    const validated = shapingDecisionManifestSchema.parse(manifest);
    const paths = this.shapingDecisionPaths(
      validated.work_item_id,
      validated.decision_id,
    );
    await this.writeJsonAtomically(paths.manifest, validated);
  }

  private validateShapingDecisionCommit(
    lease: ControllerLease,
    nextGoal: WorkItemGoal,
    nextState: WorkItemState,
    goalWasSupplied: boolean,
    manifest: ShapingDecisionManifestV1,
  ): void {
    const workItemId = lease.work_item.goal.work_item_id;
    const nextGoalBytes = goalWasSupplied
      ? stringify(nextGoal)
      : lease.acquired_goal_bytes;
    if (
      nextGoal.work_item_id !== workItemId ||
      nextState.work_item_id !== workItemId ||
      JSON.stringify(nextGoal.capture) !==
        JSON.stringify(lease.work_item.goal.capture) ||
      nextState.active_run !== undefined ||
      manifest.outcome !== "pending" ||
      manifest.work_item_id !== workItemId ||
      manifest.phase_from !== lease.work_item.state.phase ||
      manifest.phase_to !== nextState.phase ||
      manifest.goal_sha256 !== this.hashArtifactSource(nextGoalBytes) ||
      manifest.state_sha256 !==
        this.hashArtifactSource(`${JSON.stringify(nextState, null, 2)}\n`)
    ) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        "Shaping decision manifest must match the lease and exact committed bytes.",
      );
    }
    if (goalWasSupplied) {
      if (
        manifest.operation !== "approve_spec" ||
        nextGoal.goal_contract === undefined ||
        manifest.goal_version !== nextGoal.goal_contract.goal_version ||
        manifest.goal_version !== nextState.goal_version ||
        manifest.input_revision !== nextState.input_revision
      ) {
        throw new ControllerConflictError(
          "idempotency_conflict",
          workItemId,
          "Approval commits require one real goal contract with matching manifest versions.",
        );
      }
    } else if (
      manifest.goal_version !== null ||
      manifest.input_revision !== null ||
      stringify(nextGoal) !== stringify(lease.work_item.goal)
    ) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        "State-only shaping commits require null manifest versions and unchanged goal bytes.",
      );
    }
  }

  private shapingDecisionManifestIdentityMatches(
    left: ShapingDecisionManifestV1,
    right: ShapingDecisionManifestV1,
  ): boolean {
    const identity = (manifest: ShapingDecisionManifestV1) => ({
      schema_version: manifest.schema_version,
      decision_id: manifest.decision_id,
      work_item_id: manifest.work_item_id,
      operation: manifest.operation,
      phase_from: manifest.phase_from,
      phase_to: manifest.phase_to,
      mission_content_sha256: manifest.mission_content_sha256,
      result_content_sha256: manifest.result_content_sha256,
      feedback_sha256: manifest.feedback_sha256,
      expected_shaping_state_sha256:
        manifest.expected_shaping_state_sha256,
      next_mission_content_sha256:
        manifest.next_mission_content_sha256,
      goal_sha256: manifest.goal_sha256,
      state_sha256: manifest.state_sha256,
      goal_version: manifest.goal_version,
      input_revision: manifest.input_revision,
    });
    return isDeepStrictEqual(identity(left), identity(right));
  }

  private assertShapingManifestMatchesIntent(
    manifest: ShapingDecisionManifestV1,
    intent: ShapingDecisionIntentV1,
  ): void {
    if (
      manifest.decision_id !== intent.decision_id ||
      manifest.work_item_id !== intent.work_item_id ||
      manifest.operation !== intent.operation ||
      manifest.phase_from !== intent.phase_from ||
      manifest.phase_to !== intent.phase_to ||
      manifest.mission_content_sha256 !== intent.mission_content_sha256 ||
      manifest.result_content_sha256 !== intent.result_content_sha256 ||
      manifest.feedback_sha256 !== intent.feedback_sha256 ||
      manifest.expected_shaping_state_sha256 !==
        intent.expected_shaping_state_sha256 ||
      manifest.next_mission_content_sha256 !==
        intent.next_mission_content_sha256 ||
      manifest.goal_sha256 !== intent.next_goal_sha256 ||
      manifest.state_sha256 !== intent.next_state_sha256
    ) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        intent.work_item_id,
        "Shaping decision manifest does not match its durable intent.",
      );
    }
  }

  private async writeShapingDecisionArtifacts(
    intent: ShapingDecisionIntentV1,
    injectFailure: boolean,
  ): Promise<void> {
    this.validateStoredShapingDecisionIntent(intent);
    this.parseWorkItemBytes(
      intent.next_goal_bytes,
      intent.next_state_bytes,
      intent.work_item_id,
    );
    const workItemDirectory = join(
      this.workItemsDirectory,
      intent.work_item_id,
    );
    const suffix = randomUUID();
    const temporaryGoalPath = join(
      workItemDirectory,
      `.${GOAL_FILE}.${suffix}.shaping-decision.tmp`,
    );
    const temporaryStatePath = join(
      workItemDirectory,
      `.${STATE_FILE}.${suffix}.shaping-decision.tmp`,
    );
    const goalPath = join(workItemDirectory, GOAL_FILE);
    const statePath = join(workItemDirectory, STATE_FILE);
    try {
      await writeFile(temporaryGoalPath, intent.next_goal_bytes, {
        encoding: "utf8",
        flag: "wx",
      });
      await writeFile(temporaryStatePath, intent.next_state_bytes, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporaryGoalPath, goalPath);
      if (injectFailure) {
        await this.afterControllerGoalReplaced();
      }
      await rename(temporaryStatePath, statePath);
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      for (const path of [temporaryGoalPath, temporaryStatePath]) {
        try {
          await this.unlinkIfPresent(path);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Shaping decision write failed and temporary cleanup was incomplete",
        );
      }
      throw error;
    }
  }

  private parseWorkItemBytes(
    goalBytes: string,
    stateBytes: string,
    workItemId: string,
  ): WorkItem {
    let stateValue: unknown;
    try {
      stateValue = JSON.parse(stateBytes);
    } catch (error) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        `Stored shaping state bytes are invalid JSON: ${errorMessage(error)}`,
      );
    }
    try {
      return workItemSchema.parse({
        goal: workItemGoalSchema.parse(parse(goalBytes)),
        state: workItemStateSchema.parse(stateValue),
      });
    } catch (error) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        `Stored shaping goal/state bytes are invalid: ${errorMessage(error)}`,
      );
    }
  }

  private parseReadableWorkItemBytes(
    goalBytes: string,
    stateBytes: string,
    workItemId: string,
  ): WorkItem {
    let stateValue: unknown;
    try {
      stateValue = JSON.parse(stateBytes);
    } catch (error) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        `Controller lease state bytes are invalid JSON: ${errorMessage(error)}`,
      );
    }
    try {
      return workItemSchema.parse({
        goal: workItemGoalSchema.parse(parse(goalBytes)),
        state: parseWorkItemStateForRead(stateValue),
      });
    } catch (error) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        `Controller lease goal/state bytes are invalid: ${errorMessage(error)}`,
      );
    }
  }

  private validateControllerLease(lease: ControllerLease): ControllerLease {
    return {
      work_item: workItemSchema.parse(lease.work_item),
      active_run: activeRunSchema.parse(lease.active_run),
      acquired_goal_bytes: z.string().min(1).parse(lease.acquired_goal_bytes),
      acquired_state_bytes: z.string().min(1).parse(lease.acquired_state_bytes),
    };
  }

  private validateControllerMutation(
    lease: ControllerLease,
    nextItem: WorkItem,
    manifest: ControllerRunManifest,
  ): void {
    const workItemId = lease.work_item.goal.work_item_id;

    if (nextItem.goal.work_item_id !== workItemId) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        "Controller mutation cannot change work_item_id.",
      );
    }
    if (
      JSON.stringify(nextItem.goal.capture) !==
      JSON.stringify(lease.work_item.goal.capture)
    ) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        "Controller mutation cannot change capture provenance.",
      );
    }
    if (nextItem.state.active_run !== undefined) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        "Committed controller state must not retain active_run.",
      );
    }
    if (
      manifest.outcome !== "pending" ||
      manifest.work_item_id !== workItemId ||
      manifest.run_id !== lease.active_run.run_id ||
      manifest.idempotency_key !== lease.active_run.idempotency_key ||
      manifest.phase !== nextItem.state.phase ||
      manifest.goal_version !==
        nextItem.goal.goal_contract?.goal_version ||
      manifest.input_revision !== nextItem.state.input_revision ||
      manifest.attempt !== nextItem.state.attempt
    ) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        "Controller manifest identity must match the lease and next durable state.",
      );
    }
  }

  private validateControllerSemanticEventIntents(
    lease: ControllerLease,
    nextItem: WorkItem,
    manifest: ControllerRunManifest,
    inputs: SemanticEventIntentV1[],
  ): SemanticEventIntentV1[] {
    const workItemId = lease.work_item.goal.work_item_id;
    const intents = z.array(semanticEventIntentSchema).parse(inputs);
    if (new Set(intents.map((intent) => intent.intent_id)).size !== intents.length) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        "Controller mutation semantic intents must have unique identities.",
      );
    }
    for (const intent of intents) {
      const bindingWorkItemIds = [intent.binding];
      if (intent.details.kind === "workflow_transitioned") {
        bindingWorkItemIds.push(
          intent.details.before,
          intent.details.after,
        );
      }
      if (
        intent.work_item_id !== workItemId ||
        intent.source.kind !== "controller_run" ||
        intent.source.controller_run_id !== manifest.run_id ||
        intent.source.expected_outcome !== "applied" ||
        bindingWorkItemIds.some(
          (binding) =>
            (binding.kind === "governed"
              ? workItemId
              : binding.identity.work_item_id) !== workItemId,
        ) ||
        (intent.binding.kind === "governed" &&
          !this.semanticGovernedBindingMatchesEitherItem(
            intent.binding,
            lease.work_item,
            nextItem,
          ))
      ) {
        throw new ControllerConflictError(
          "idempotency_conflict",
          workItemId,
          `Semantic intent ${intent.intent_id} must bind the exact controller source and before/after work item.`,
        );
      }
    }
    return intents;
  }

  private validateCommitSemanticEventIntents(
    lease: ControllerLease,
    nextItem: WorkItem,
    sourceKind: "shaping_decision" | "plan_approval",
    sourceId: string,
    inputs: SemanticEventIntentV1[],
  ): SemanticEventIntentV1[] {
    const workItemId = lease.work_item.goal.work_item_id;
    const intents = z.array(semanticEventIntentSchema).parse(inputs);
    if (new Set(intents.map((intent) => intent.intent_id)).size !== intents.length) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        "Commit semantic intents must have unique identities.",
      );
    }
    for (const intent of intents) {
      const sourceMatches =
        sourceKind === "shaping_decision"
          ? intent.source.kind === "shaping_decision" &&
            intent.source.decision_id === sourceId &&
            intent.source.expected_outcome === "applied"
          : intent.source.kind === "plan_approval" &&
            intent.source.approval_id === sourceId &&
            intent.source.expected_outcome === "applied";
      const transitionBindings =
        intent.details.kind === "workflow_transitioned"
          ? [intent.details.before, intent.details.after]
          : [];
      if (
        intent.work_item_id !== workItemId ||
        !sourceMatches ||
        !this.semanticBindingMatchesEitherItem(
          intent.binding,
          lease.work_item,
          nextItem,
        ) ||
        transitionBindings.some(
          (binding) =>
            !this.semanticBindingMatchesEitherItem(
              binding,
              lease.work_item,
              nextItem,
            ),
        )
      ) {
        throw new ControllerConflictError(
          "idempotency_conflict",
          workItemId,
          `Semantic intent ${intent.intent_id} must bind the exact ${sourceKind} source and before/after work item.`,
        );
      }
    }
    return intents;
  }

  private semanticBindingMatchesEitherItem(
    binding: SemanticEventIntentV1["binding"],
    before: WorkItem,
    after: WorkItem,
  ): boolean {
    if (binding.kind === "shaping") {
      return binding.identity.work_item_id === before.goal.work_item_id;
    }
    return this.semanticGovernedBindingMatchesEitherItem(
      binding,
      before,
      after,
    );
  }

  private async publishSemanticEventIntents(
    intents: SemanticEventIntentV1[],
  ): Promise<void> {
    for (const intent of intents) {
      await this.publishSemanticEventIntent(
        intent.work_item_id,
        intent.intent_id,
      );
    }
  }

  private async publishStoredSemanticEventIntentsForSource(
    workItemId: string,
    sourceKind: "shaping_decision" | "plan_approval",
    sourceId: string,
  ): Promise<void> {
    const intents = (await this.readSemanticEventIntentFiles(workItemId)).filter(
      (intent) =>
        sourceKind === "shaping_decision"
          ? intent.source.kind === "shaping_decision" &&
            intent.source.decision_id === sourceId
          : intent.source.kind === "plan_approval" &&
            intent.source.approval_id === sourceId,
    );
    await this.publishSemanticEventIntents(intents);
  }

  private semanticGovernedBindingMatchesEitherItem(
    binding: Extract<SemanticEventIntentV1["binding"], { kind: "governed" }>,
    before: WorkItem,
    after: WorkItem,
  ): boolean {
    return [before, after].some(
      (item) =>
        item.state.goal_version === binding.governed_tuple.goal_version &&
        item.state.input_revision === binding.governed_tuple.input_revision &&
        item.state.attempt === binding.governed_tuple.attempt &&
        item.state.patch_cycle === binding.governed_tuple.patch_cycle &&
        item.state.phase === binding.phase &&
        item.state.status === binding.status,
    );
  }

  private async assertControllerLeaseOwnership(
    lease: ControllerLease,
  ): Promise<void> {
    const workItemId = lease.work_item.goal.work_item_id;
    const lockPath = join(
      this.workItemsDirectory,
      workItemId,
      CONTROLLER_LOCK_FILE,
    );
    const lockSource = await this.readOptionalFile(lockPath);

    if (lockSource === null) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        "Controller lock disappeared before the mutation was committed.",
      );
    }

    const lockRun = this.parseJson(lockSource, lockPath, activeRunSchema);
    if (!this.activeRunsMatch(lockRun, lease.active_run)) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        "Controller lock ownership does not match the mutation lease.",
      );
    }
  }

  private matchesLeasedItem(current: WorkItem, lease: ControllerLease): boolean {
    return (
      JSON.stringify(this.withoutActiveRun(current)) ===
      JSON.stringify(lease.work_item)
    );
  }

  private withoutActiveRun(item: WorkItem): WorkItem {
    if (item.state.active_run === undefined) {
      return item;
    }
    const state = { ...item.state };
    delete state.active_run;
    return workItemSchema.parse({ goal: item.goal, state });
  }

  private activeRunsMatch(left: ActiveRun, right: ActiveRun): boolean {
    return (
      left.run_id === right.run_id &&
      left.idempotency_key === right.idempotency_key &&
      left.acquired_at === right.acquired_at
    );
  }

  private manifestIdentityMatches(
    left: ControllerRunManifest,
    right: ControllerRunManifest,
  ): boolean {
    return (
      left.run_id === right.run_id &&
      left.work_item_id === right.work_item_id &&
      left.idempotency_key === right.idempotency_key &&
      left.phase === right.phase &&
      left.goal_version === right.goal_version &&
      left.input_revision === right.input_revision &&
      left.attempt === right.attempt
    );
  }

  private validateIncomingControllerManifest(
    item: WorkItem,
    manifest: ControllerRunManifest | undefined,
    artifactPath: string,
  ): void {
    if (item.state.active_run !== undefined) {
      throw this.invalid(
        artifactPath,
        "staged work items must not carry an active controller lease",
      );
    }

    const contract = item.goal.goal_contract;
    if (contract === undefined) {
      if (manifest !== undefined) {
        throw this.invalid(
          artifactPath,
          "an uncontracted staged work item cannot carry a controller manifest",
        );
      }
      return;
    }

    if (manifest === undefined) {
      throw this.invalid(
        artifactPath,
        "a contracted staged work item requires an applied controller manifest",
      );
    }
    if (
      manifest.outcome !== "applied" ||
      manifest.completed_at === undefined ||
      manifest.work_item_id !== item.goal.work_item_id ||
      manifest.phase !== item.state.phase ||
      manifest.goal_version !== contract.goal_version ||
      manifest.input_revision !== item.state.input_revision ||
      manifest.attempt !== item.state.attempt
    ) {
      throw this.invalid(
        artifactPath,
        "staged controller manifest must be applied and match the durable work-item identity",
      );
    }
  }

  private async readStagedControllerManifest(
    workItemDirectory: string,
    workItemId: string,
  ): Promise<ControllerRunManifest | undefined> {
    if (
      (await this.readOptionalFile(
        join(workItemDirectory, CONTROLLER_LOCK_FILE),
      )) !== null
    ) {
      throw this.invalid(
        workItemDirectory,
        "staged work items must not contain a controller lock",
      );
    }

    const runsDirectory = join(workItemDirectory, RUNS_DIRECTORY);
    if (!(await this.hasSafeDirectory(runsDirectory))) {
      return undefined;
    }

    const entries = await readdir(runsDirectory, { withFileTypes: true });
    if (entries.length !== 1) {
      throw this.invalid(
        runsDirectory,
        "staged work items must contain exactly one controller manifest",
      );
    }

    const [entry] = entries;
    const manifestPath = join(runsDirectory, entry.name);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !entry.name.endsWith(".json")
    ) {
      throw this.invalid(
        manifestPath,
        "staged controller manifest must be a regular JSON file",
      );
    }

    const runIdResult = controllerRunIdSchema.safeParse(
      entry.name.slice(0, -".json".length),
    );
    if (!runIdResult.success) {
      throw this.invalid(manifestPath, validationReason(runIdResult));
    }
    const source = await this.readRequiredFile(manifestPath);
    return this.parseControllerRunManifest(
      source,
      manifestPath,
      workItemId,
      runIdResult.data,
    );
  }

  private async writeControllerRunManifest(
    manifest: ControllerRunManifest,
  ): Promise<void> {
    const validated = controllerRunManifestSchema.parse(manifest);
    await this.writeControllerRunManifestToDirectory(
      join(
        this.workItemsDirectory,
        validated.work_item_id,
      ),
      validated,
    );
  }

  private async writeControllerRunManifestToDirectory(
    workItemDirectory: string,
    manifest: ControllerRunManifest,
  ): Promise<void> {
    const runsDirectory = join(
      workItemDirectory,
      RUNS_DIRECTORY,
    );
    await this.ensureDirectory(runsDirectory);

    const manifestPath = join(runsDirectory, `${manifest.run_id}.json`);
    await this.writeJsonAtomically(manifestPath, manifest);
  }

  private async writeControllerArtifacts(
    workItemDirectory: string,
    goal: WorkItemGoal,
    state: WorkItemState,
    injectFailure: boolean,
  ): Promise<void> {
    const suffix = randomUUID();
    const goalPath = join(workItemDirectory, GOAL_FILE);
    const statePath = join(workItemDirectory, STATE_FILE);
    const temporaryGoalPath = join(
      workItemDirectory,
      `.${GOAL_FILE}.${suffix}.controller.tmp`,
    );
    const temporaryStatePath = join(
      workItemDirectory,
      `.${STATE_FILE}.${suffix}.controller.tmp`,
    );

    try {
      await writeFile(temporaryGoalPath, stringify(goal), {
        encoding: "utf8",
        flag: "wx",
      });
      await writeFile(
        temporaryStatePath,
        `${JSON.stringify(state, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await rename(temporaryGoalPath, goalPath);
      if (injectFailure) {
        await this.afterControllerGoalReplaced();
      }
      await rename(temporaryStatePath, statePath);
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      for (const temporaryPath of [temporaryGoalPath, temporaryStatePath]) {
        try {
          await this.unlinkIfPresent(temporaryPath);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Controller artifact write failed and temporary cleanup was incomplete",
        );
      }
      throw error;
    }
  }

  private async ensureShapingRunItemDirectory(
    workItemId: string,
  ): Promise<string> {
    const shapingRunsDirectory = join(
      this.founderDirectory,
      SHAPING_RUNS_DIRECTORY,
    );
    await this.ensureDirectory(shapingRunsDirectory);
    const itemDirectory = join(shapingRunsDirectory, workItemId);
    await this.ensureDirectory(itemDirectory);
    return itemDirectory;
  }

  private shapingRunPaths(workItemId: string, shapingRunId: string) {
    const directory = join(
      this.founderDirectory,
      SHAPING_RUNS_DIRECTORY,
      workItemId,
      shapingRunId,
    );
    return {
      directory,
      run: join(directory, SHAPING_RUN_FILE),
      events: join(directory, SHAPING_RUN_EVENTS_FILE),
      process: join(directory, SHAPING_RUN_PROCESS_FILE),
      instruction: join(directory, INSTRUCTION_JSON_FILE),
      ingress: join(directory, "ingress"),
    };
  }

  private async publishShapingRunDirectory(
    record: ShapingRunRecordV1,
    instruction: ShapingIngressInstructionV1,
  ): Promise<void> {
    const validated = shapingRunRecordV1Schema.parse(record);
    const validatedInstruction = shapingIngressInstructionSchema.parse(
      instruction,
    );
    const workItemId = validated.mission.work_item_id;
    const itemDirectory = join(
      this.founderDirectory,
      SHAPING_RUNS_DIRECTORY,
      workItemId,
    );
    await this.assertDirectory(itemDirectory);
    if (
      validatedInstruction.origin !== "connected_run" ||
      validatedInstruction.shaping_run_id !== validated.shaping_run_id ||
      validatedInstruction.work_item_id !== workItemId ||
      validatedInstruction.phase !== validated.mission.phase ||
      validatedInstruction.mission_input_sha256 !==
        validated.mission.input_sha256 ||
      validatedInstruction.mission_content_sha256 !==
        validated.mission.content_sha256 ||
      validatedInstruction.ingress_path !==
        validated.write_policy.ingress_path ||
      validatedInstruction.instruction_sha256 !==
        validated.write_policy.instruction_sha256
    ) {
      throw this.invalid(
        itemDirectory,
        "shaping run instruction must match its immutable record",
      );
    }

    const paths = this.shapingRunPaths(
      workItemId,
      validated.shaping_run_id,
    );
    const stagingName =
      `.${validated.shaping_run_id}.${randomUUID()}.shaping-run.staging`;
    if (!SHAPING_RUN_STAGING_DIRECTORY_PATTERN.test(stagingName)) {
      throw this.invalid(itemDirectory, "invalid shaping-run staging name");
    }
    const stagingDirectory = join(itemDirectory, stagingName);
    await mkdir(stagingDirectory);
    try {
      await writeFile(
        join(stagingDirectory, SHAPING_RUN_FILE),
        `${JSON.stringify(validated, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await writeFile(
        join(stagingDirectory, SHAPING_RUN_EVENTS_FILE),
        "",
        { encoding: "utf8", flag: "wx" },
      );
      await writeFile(
        join(stagingDirectory, SHAPING_RUN_PROCESS_FILE),
        `${JSON.stringify(validated.process, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      const stagingInstructionPath = join(
        stagingDirectory,
        INSTRUCTION_JSON_FILE,
      );
      await writeFile(
        stagingInstructionPath,
        `${JSON.stringify(validatedInstruction, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await mkdir(join(stagingDirectory, "ingress"));
      await this.afterShapingIngressInstructionWritten(
        stagingInstructionPath,
      );
      await rename(stagingDirectory, paths.directory);
    } catch (error) {
      try {
        await rm(stagingDirectory, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Shaping run publication failed and its staging directory could not be removed",
        );
      }
      throw error;
    }
  }

  private async resolveExistingShapingRunLaunch(
    candidate: ShapingRunRecordV1,
  ): Promise<ShapingRunCreateResult> {
    const workItemId = candidate.mission.work_item_id;
    const snapshot = await this.readShapingPackageSnapshot({
      phase: candidate.mission.phase,
      work_item_id: workItemId,
      input_sha256: candidate.mission.input_sha256,
    });
    if ((await this.readAppliedShapingBundle(snapshot)) !== null) {
      throw this.missionNotReady(
        workItemId,
        "This shaping mission revision already has an applied result.",
      );
    }
    const itemDirectory = join(
      this.founderDirectory,
      SHAPING_RUNS_DIRECTORY,
      workItemId,
    );
    const guard = await this.readShapingRunGuard(itemDirectory);
    if (guard === null) {
      const { write_policy: _writePolicy, ...record } = candidate;
      return this.createShapingRun({ record, mission: snapshot.mission });
    }

    const existing = await this.readShapingRunFromDirectory(
      workItemId,
      guard.shaping_run_id,
      itemDirectory,
    );
    if (existing?.lifecycle.status === "terminal") {
      await this.releaseShapingRunGuard(guard);
      const { write_policy: _writePolicy, ...record } = candidate;
      return this.createShapingRun({ record, mission: snapshot.mission });
    }
    if (
      guard.launch_fingerprint !== this.shapingRunFingerprint(candidate)
    ) {
      throw new ControllerConflictError(
        "lease_held",
        workItemId,
        "A different shaping run launch already holds the item guard.",
      );
    }
    return {
      record: existing ?? guard.record,
      instruction:
        existing === null
          ? guard.instruction
          : await this.readShapingRunInstructionForRecord(existing),
      created: false,
    };
  }

  private async readShapingRunGuard(
    itemDirectory: string,
  ): Promise<ShapingRunLaunchGuard | null> {
    const guardPath = join(
      itemDirectory,
      SHAPING_RUN_LAUNCH_GUARD_FILE,
    );
    const source = await this.readOptionalFile(guardPath);
    if (source === null) {
      return null;
    }
    return this.parseJson(
      source,
      guardPath,
      shapingRunLaunchGuardSchema,
    );
  }

  private async releaseShapingRunGuard(
    expected: ShapingRunLaunchGuard,
  ): Promise<void> {
    const itemDirectory = join(
      this.founderDirectory,
      SHAPING_RUNS_DIRECTORY,
      expected.work_item_id,
    );
    const current = await this.readShapingRunGuard(itemDirectory);
    if (
      current !== null &&
      current.shaping_run_id === expected.shaping_run_id &&
      current.launch_fingerprint === expected.launch_fingerprint
    ) {
      await this.unlinkIfPresent(
        join(itemDirectory, SHAPING_RUN_LAUNCH_GUARD_FILE),
      );
    }
  }

  private async releaseShapingRunGuardForRecord(
    record: ShapingRunRecordV1,
  ): Promise<void> {
    const itemDirectory = join(
      this.founderDirectory,
      SHAPING_RUNS_DIRECTORY,
      record.mission.work_item_id,
    );
    const guard = await this.readShapingRunGuard(itemDirectory);
    if (
      guard !== null &&
      guard.shaping_run_id === record.shaping_run_id &&
      guard.launch_fingerprint === this.shapingRunFingerprint(record)
    ) {
      await this.releaseShapingRunGuard(guard);
    }
  }

  private async readShapingRunFromDirectory(
    workItemId: string,
    shapingRunId: string,
    itemDirectory: string,
    validateInstruction = true,
  ): Promise<ShapingRunRecordV1 | null> {
    const paths = this.shapingRunPaths(workItemId, shapingRunId);
    if (!(await this.hasSafeDirectory(paths.directory))) {
      return null;
    }
    if (resolve(paths.directory) !== resolve(itemDirectory, shapingRunId)) {
      throw this.invalid(paths.directory, "shaping-run path escaped its item");
    }
    const runSource = await this.readRequiredFile(paths.run);
    const record = this.parseJson(
      runSource,
      paths.run,
      shapingRunRecordV1Schema,
    );
    if (record.shaping_run_id !== shapingRunId) {
      throw this.invalid(
        paths.run,
        `shaping_run_id must equal containing directory name ${shapingRunId}`,
      );
    }
    if (record.mission.work_item_id !== workItemId) {
      throw this.invalid(
        paths.run,
        `work_item_id must equal containing directory name ${workItemId}`,
      );
    }

    if (validateInstruction) {
      await this.readShapingRunInstructionForRecord(record);
    }
    const storedProcess = await this.readShapingRunProcess(paths.process);
    if (
      record.process !== null &&
      (storedProcess === null ||
        JSON.stringify(record.process) !== JSON.stringify(storedProcess))
    ) {
      throw this.invalid(
        paths.process,
        "process.json must match the shaping run process identity",
      );
    }
    const eventStats = await this.readShapingRunEventStats(paths.events);
    if (
      eventStats.event_count > record.limits.max_event_count ||
      eventStats.event_bytes > record.limits.max_event_bytes
    ) {
      throw this.invalid(
        paths.events,
        "stored events exceed the immutable shaping-run limits",
      );
    }
    return record;
  }

  private async readShapingRunsFromItemDirectory(
    workItemId: string,
    itemDirectory: string,
  ): Promise<ShapingRunRecordV1[]> {
    const records: ShapingRunRecordV1[] = [];
    const entries = await readdir(itemDirectory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.name === SHAPING_RUN_LAUNCH_GUARD_FILE) {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          throw this.invalid(
            join(itemDirectory, entry.name),
            "shaping launch guard must be a regular file",
          );
        }
        continue;
      }
      if (SHAPING_RUN_STAGING_DIRECTORY_PATTERN.test(entry.name)) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw this.invalid(
            join(itemDirectory, entry.name),
            "shaping-run staging entry must be a regular directory",
          );
        }
        continue;
      }
      const runIdResult = controllerRunIdSchema.safeParse(entry.name);
      if (
        !runIdResult.success ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      ) {
        throw this.invalid(
          join(itemDirectory, entry.name),
          "shaping-run entries must be UUID-named regular directories",
        );
      }
      const record = await this.readShapingRunFromDirectory(
        workItemId,
        runIdResult.data,
        itemDirectory,
      );
      if (record === null) {
        throw this.invalid(
          join(itemDirectory, entry.name),
          "shaping-run directory disappeared during read",
        );
      }
      records.push(record);
    }
    return records;
  }

  private async readShapingRunProcess(
    processPath: string,
  ): Promise<ConnectedRunProcessIdentity | null> {
    const source = await this.readRequiredFile(processPath);
    return this.parseJson(
      source,
      processPath,
      connectedRunProcessIdentitySchema.nullable(),
    );
  }

  private async readShapingRunEventStats(
    eventsPath: string,
  ): Promise<{ event_count: number; event_bytes: number }> {
    const source = await this.readRequiredFile(eventsPath);
    if (source.length > 0 && !source.endsWith("\n")) {
      throw this.invalid(eventsPath, "events.ndjson must end with a newline");
    }
    const lines = source.length === 0 ? [] : source.slice(0, -1).split("\n");
    for (const line of lines) {
      this.parseJsonValue(line, eventsPath);
    }
    return {
      event_count: lines.length,
      event_bytes: Buffer.byteLength(source, "utf8"),
    };
  }

  private async readShapingRunInstructionForRecord(
    record: ShapingRunRecordV1,
  ): Promise<ShapingIngressInstructionV1> {
    const paths = this.shapingRunPaths(
      record.mission.work_item_id,
      record.shaping_run_id,
    );
    await this.assertDirectory(paths.ingress);
    const source = await this.readRequiredFile(paths.instruction);
    const instruction = this.parseJson(
      source,
      paths.instruction,
      shapingIngressInstructionSchema,
    );
    const durable = await this.readDurableShapingInstruction(instruction);
    if (
      durable.origin !== "connected_run" ||
      durable.shaping_run_id !== record.shaping_run_id ||
      durable.work_item_id !== record.mission.work_item_id ||
      durable.phase !== record.mission.phase ||
      durable.mission_input_sha256 !== record.mission.input_sha256 ||
      durable.mission_content_sha256 !== record.mission.content_sha256 ||
      durable.ingress_path !== record.write_policy.ingress_path ||
      durable.instruction_sha256 !==
        record.write_policy.instruction_sha256
    ) {
      throw new ControllerConflictError(
        "repair_required",
        record.mission.work_item_id,
        "Shaping run instruction does not match its immutable run record.",
      );
    }
    const snapshot = await this.readShapingPackageSnapshot({
      phase: record.mission.phase,
      work_item_id: record.mission.work_item_id,
      input_sha256: record.mission.input_sha256,
    });
    this.assertShapingInstructionMatchesMission(durable, snapshot);
    return durable;
  }

  private async requireShapingRun(
    workItemId: string,
    shapingRunId: string,
  ): Promise<ShapingRunRecordV1> {
    const record = await this.readShapingRun(workItemId, shapingRunId);
    if (record === null) {
      throw new ControllerConflictError(
        "work_item_not_found",
        workItemId,
        `Shaping run ${shapingRunId} was not found.`,
      );
    }
    return record;
  }

  private async requireShapingRunForCompletion(
    workItemId: string,
    shapingRunId: string,
  ): Promise<ShapingRunRecordV1> {
    await this.readManifest();
    const itemDirectory = join(
      this.founderDirectory,
      SHAPING_RUNS_DIRECTORY,
      workItemId,
    );
    if (!(await this.hasSafeDirectory(itemDirectory))) {
      throw new ControllerConflictError(
        "work_item_not_found",
        workItemId,
        `Shaping run ${shapingRunId} was not found.`,
      );
    }
    const record = await this.readShapingRunFromDirectory(
      workItemId,
      shapingRunId,
      itemDirectory,
      false,
    );
    if (record === null) {
      throw new ControllerConflictError(
        "work_item_not_found",
        workItemId,
        `Shaping run ${shapingRunId} was not found.`,
      );
    }
    return record;
  }

  private shapingRunFingerprint(record: ShapingRunRecordV1): string {
    const requestedModel = record.provenance.requested_model.value;
    if (requestedModel === null) {
      throw new ControllerConflictError(
        "repair_required",
        record.mission.work_item_id,
        `Shaping run ${record.shaping_run_id} has no requested model.`,
      );
    }
    return shapingRunLaunchFingerprint(
      record.mission.content_sha256,
      requestedModel,
    );
  }

  private interruptedShapingRun(
    record: ShapingRunRecordV1,
    reason: string,
  ): ShapingRunRecordV1 {
    const completedAt = timestampAtOrAfter(record.lifecycle.updated_at);
    return shapingRunRecordV1Schema.parse({
      ...record,
      lifecycle: {
        status: "terminal",
        started_at: record.lifecycle.started_at,
        updated_at: completedAt,
        completed_at: completedAt,
        terminal: {
          outcome: "interrupted",
          partial: true,
          reason,
        },
      },
    });
  }

  private async terminalizeShapingRun(
    record: ShapingRunRecordV1,
    terminal: ConnectedRunTerminal,
  ): Promise<ShapingRunRecordV1> {
    const completedAt = timestampAtOrAfter(record.lifecycle.updated_at);
    const updated = shapingRunRecordV1Schema.parse({
      ...record,
      lifecycle: {
        status: "terminal",
        started_at: record.lifecycle.started_at,
        updated_at: completedAt,
        completed_at: completedAt,
        terminal,
      },
    });
    const paths = this.shapingRunPaths(
      record.mission.work_item_id,
      record.shaping_run_id,
    );
    await this.writeJsonAtomically(paths.run, updated);
    await this.releaseShapingRunGuardForRecord(updated);
    return updated;
  }

  private isShapingOutputRejection(error: unknown): boolean {
    return (
      error instanceof InvalidWorkspaceError ||
      (error instanceof ControllerConflictError &&
        ["mission_not_ready", "repair_required"].includes(error.kind))
    );
  }

  private async failShapingRunAfterRejectedOutput(
    record: ShapingRunRecordV1,
  ): Promise<ShapingRunRecordV1> {
    const observedAt = timestampAtOrAfter(record.lifecycle.updated_at);
    const message = "Artifact-only shaping output failed validation.";
    const entries = [...record.diagnostics.entries];
    let truncated = record.diagnostics.truncated;
    if (entries.length < 20) {
      entries.push({
        observed_at: observedAt,
        code: "invalid_shaping_output",
        message,
      });
    } else {
      truncated = true;
    }
    return this.terminalizeShapingRun(
      shapingRunRecordV1Schema.parse({
        ...record,
        diagnostics: { entries, truncated },
      }),
      {
        outcome: "failed",
        partial: true,
        reason: "Shaping output was rejected.",
      },
    );
  }

  private async reconcileShapingRunItem(
    workItemId: string,
    itemDirectory: string,
  ): Promise<ShapingRunRecordV1[]> {
    const guard = await this.readShapingRunGuard(itemDirectory);
    if (guard !== null) {
      const guardedRecord = await this.readShapingRunFromDirectory(
        workItemId,
        guard.shaping_run_id,
        itemDirectory,
      );
      if (guardedRecord === null) {
        const interrupted = this.interruptedShapingRun(
          guard.record,
          "The launch was interrupted before its shaping-run directory was published.",
        );
        await this.publishShapingRunDirectory(
          interrupted,
          guard.instruction,
        );
        await this.releaseShapingRunGuard(guard);
      }
    }

    const records = await this.readShapingRunsFromItemDirectory(
      workItemId,
      itemDirectory,
    );
    if (
      records.filter((record) => record.lifecycle.status !== "terminal")
        .length > 1
    ) {
      throw this.invalid(
        itemDirectory,
        "only one nonterminal shaping run may exist per work item",
      );
    }

    const reconciled: ShapingRunRecordV1[] = [];
    for (const storedRecord of records) {
      if (storedRecord.lifecycle.status === "terminal") {
        await this.releaseShapingRunGuardForRecord(storedRecord);
        reconciled.push(storedRecord);
        continue;
      }

      const snapshot = await this.readShapingPackageSnapshot({
        phase: storedRecord.mission.phase,
        work_item_id: storedRecord.mission.work_item_id,
        input_sha256: storedRecord.mission.input_sha256,
      });
      const applied = await this.readAppliedShapingBundle(snapshot);
      if (applied !== null) {
        if (
          applied.productionReceipt.origin !== "connected_run" ||
          applied.productionReceipt.shaping_run_id !==
            storedRecord.shaping_run_id
        ) {
          throw new ControllerConflictError(
            "repair_required",
            workItemId,
            "Applied shaping production does not name the active shaping run.",
          );
        }
        reconciled.push(
          await this.terminalizeShapingRun(storedRecord, {
            outcome: "completed",
            partial: false,
            reason: null,
          }),
        );
        continue;
      }

      const paths = this.shapingRunPaths(
        workItemId,
        storedRecord.shaping_run_id,
      );
      const storedProcess = await this.readShapingRunProcess(paths.process);
      let record = storedRecord;
      if (storedProcess !== null && record.process === null) {
        record = shapingRunRecordV1Schema.parse({
          ...record,
          lifecycle: {
            ...record.lifecycle,
            status: "running",
            updated_at: timestampAtOrAfter(
              record.lifecycle.updated_at,
              storedProcess.started_at,
            ),
          },
          process: storedProcess,
        });
        await this.writeJsonAtomically(paths.run, record);
      }

      const processIsAlive =
        storedProcess !== null &&
        (await this.connectedProcessProbe(storedProcess.pid, 0));
      if (processIsAlive) {
        reconciled.push(record);
        continue;
      }
      const interrupted = this.interruptedShapingRun(
        record,
        storedProcess === null
          ? "The shaping run had no recoverable process identity."
          : "The shaping agent process was not running during recovery.",
      );
      await this.writeJsonAtomically(paths.run, interrupted);
      await this.releaseShapingRunGuardForRecord(interrupted);
      reconciled.push(interrupted);
    }
    return reconciled;
  }

  private async ensureConnectedRunItemDirectory(
    workItemId: string,
  ): Promise<string> {
    const connectedRunsDirectory = join(
      this.founderDirectory,
      CONNECTED_RUNS_DIRECTORY,
    );
    await this.ensureDirectory(connectedRunsDirectory);
    const itemDirectory = join(connectedRunsDirectory, workItemId);
    await this.ensureDirectory(itemDirectory);
    return itemDirectory;
  }

  private connectedRunPaths(workItemId: string, connectedRunId: string) {
    const directory = join(
      this.founderDirectory,
      CONNECTED_RUNS_DIRECTORY,
      workItemId,
      connectedRunId,
    );
    return {
      directory,
      run: join(directory, CONNECTED_RUN_FILE),
      events: join(directory, CONNECTED_RUN_EVENTS_FILE),
      process: join(directory, CONNECTED_RUN_PROCESS_FILE),
    };
  }

  private async publishConnectedRunDirectory(
    record: ConnectedRunRecordV2,
  ): Promise<void> {
    const validated = connectedRunRecordV2Schema.parse(record);
    const workItemId = validated.mission.identity.work_item_id;
    const itemDirectory = join(
      this.founderDirectory,
      CONNECTED_RUNS_DIRECTORY,
      workItemId,
    );
    await this.assertDirectory(itemDirectory);
    const paths = this.connectedRunPaths(
      workItemId,
      validated.connected_run_id,
    );
    const stagingName = `.${validated.connected_run_id}.${randomUUID()}.staging`;
    if (!CONNECTED_RUN_STAGING_DIRECTORY_PATTERN.test(stagingName)) {
      throw this.invalid(itemDirectory, "invalid connected-run staging name");
    }
    const stagingDirectory = join(itemDirectory, stagingName);
    await mkdir(stagingDirectory);

    try {
      await writeFile(
        join(stagingDirectory, CONNECTED_RUN_FILE),
        `${JSON.stringify(validated, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await writeFile(join(stagingDirectory, CONNECTED_RUN_EVENTS_FILE), "", {
        encoding: "utf8",
        flag: "wx",
      });
      await writeFile(
        join(stagingDirectory, CONNECTED_RUN_PROCESS_FILE),
        `${JSON.stringify(validated.process, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await rename(stagingDirectory, paths.directory);
    } catch (error) {
      try {
        await rm(stagingDirectory, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Connected run publication failed and its staging directory could not be removed",
        );
      }
      throw error;
    }
  }

  private async resolveExistingConnectedRunLaunch(
    candidate: ConnectedRunRecordV2,
  ): Promise<ConnectedRunCreateResult> {
    const workItemId = candidate.mission.identity.work_item_id;
    const itemDirectory = join(
      this.founderDirectory,
      CONNECTED_RUNS_DIRECTORY,
      workItemId,
    );
    const guard = await this.readConnectedRunGuard(itemDirectory);
    if (guard === null) {
      return this.createConnectedRun(candidate);
    }

    const existing = await this.readConnectedRunFromDirectory(
      workItemId,
      guard.connected_run_id,
      itemDirectory,
    );
    if (existing?.lifecycle.status === "terminal") {
      await this.releaseConnectedRunGuard(guard);
      return this.createConnectedRun(candidate);
    }

    const candidateFingerprint = connectedRunLaunchFingerprint(candidate);
    if (guard.launch_fingerprint !== candidateFingerprint) {
      throw new ControllerConflictError(
        "lease_held",
        workItemId,
        "A different connected run launch already holds the item guard.",
      );
    }
    const record = existing ?? guard.record;
    await this.ensureConnectedRunLaunchEvent(guard.record);
    return { record, created: false };
  }

  private async readConnectedRunGuard(
    itemDirectory: string,
  ): Promise<ConnectedRunLaunchGuard | null> {
    const guardPath = join(
      itemDirectory,
      CONNECTED_RUN_LAUNCH_GUARD_FILE,
    );
    const source = await this.readOptionalFile(guardPath);
    if (source === null) {
      return null;
    }
    const guard = this.parseJson(
      source,
      guardPath,
      connectedRunLaunchGuardSchema,
    );
    if (
      guard.launch_fingerprint !== connectedRunLaunchFingerprint(guard.record)
    ) {
      throw this.invalid(
        guardPath,
        "launch_fingerprint must hash the guarded launch identity",
      );
    }
    return guard;
  }

  private async releaseConnectedRunGuard(
    expected: ConnectedRunLaunchGuard,
  ): Promise<void> {
    const itemDirectory = join(
      this.founderDirectory,
      CONNECTED_RUNS_DIRECTORY,
      expected.work_item_id,
    );
    const current = await this.readConnectedRunGuard(itemDirectory);
    if (
      current !== null &&
      current.connected_run_id === expected.connected_run_id &&
      current.launch_fingerprint === expected.launch_fingerprint
    ) {
      await this.unlinkIfPresent(
        join(itemDirectory, CONNECTED_RUN_LAUNCH_GUARD_FILE),
      );
    }
  }

  private async releaseConnectedRunGuardForRecord(
    record: ConnectedRunRecordV2,
  ): Promise<void> {
    const itemDirectory = join(
      this.founderDirectory,
      CONNECTED_RUNS_DIRECTORY,
      record.mission.identity.work_item_id,
    );
    const guard = await this.readConnectedRunGuard(itemDirectory);
    if (
      guard !== null &&
      guard.connected_run_id === record.connected_run_id &&
      guard.launch_fingerprint === connectedRunLaunchFingerprint(record)
    ) {
      await this.releaseConnectedRunGuard(guard);
    }
  }

  private async readConnectedRunFromDirectory(
    workItemId: string,
    connectedRunId: string,
    itemDirectory: string,
  ): Promise<ConnectedRunRecordV2 | null> {
    const paths = this.connectedRunPaths(workItemId, connectedRunId);
    if (!(await this.hasSafeDirectory(paths.directory))) {
      return null;
    }
    if (resolve(paths.directory) !== resolve(itemDirectory, connectedRunId)) {
      throw this.invalid(paths.directory, "connected-run path escaped its item");
    }

    const runSource = await this.readRequiredFile(paths.run);
    const record = this.parseJson(
      runSource,
      paths.run,
      connectedRunRecordV2Schema,
    );
    if (record.connected_run_id !== connectedRunId) {
      throw this.invalid(
        paths.run,
        `connected_run_id must equal containing directory name ${connectedRunId}`,
      );
    }
    if (record.mission.identity.work_item_id !== workItemId) {
      throw this.invalid(
        paths.run,
        `work_item_id must equal containing directory name ${workItemId}`,
      );
    }

    const storedProcess = await this.readConnectedRunProcess(paths.process);
    if (
      record.process !== null &&
      (storedProcess === null ||
        JSON.stringify(record.process) !== JSON.stringify(storedProcess))
    ) {
      throw this.invalid(
        paths.process,
        "process.json must match the connected run process identity",
      );
    }
    const eventStats = await this.readConnectedRunEventStats(paths.events);
    if (
      eventStats.event_count > record.limits.max_event_count ||
      eventStats.event_bytes > record.limits.max_event_bytes
    ) {
      throw this.invalid(
        paths.events,
        "stored events exceed the immutable connected-run limits",
      );
    }
    return record;
  }

  private async readConnectedRunsFromItemDirectory(
    workItemId: string,
    itemDirectory: string,
  ): Promise<ConnectedRunRecordV2[]> {
    const records: ConnectedRunRecordV2[] = [];
    const entries = await readdir(itemDirectory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.name === CONNECTED_RUN_LAUNCH_GUARD_FILE) {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          throw this.invalid(
            join(itemDirectory, entry.name),
            "launch guard must be a regular file",
          );
        }
        continue;
      }
      if (CONNECTED_RUN_STAGING_DIRECTORY_PATTERN.test(entry.name)) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw this.invalid(
            join(itemDirectory, entry.name),
            "connected-run staging entry must be a regular directory",
          );
        }
        continue;
      }
      const runIdResult = controllerRunIdSchema.safeParse(entry.name);
      if (
        !runIdResult.success ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      ) {
        throw this.invalid(
          join(itemDirectory, entry.name),
          "connected-run entries must be UUID-named regular directories",
        );
      }
      const record = await this.readConnectedRunFromDirectory(
        workItemId,
        runIdResult.data,
        itemDirectory,
      );
      if (record === null) {
        throw this.invalid(
          join(itemDirectory, entry.name),
          "connected-run directory disappeared during read",
        );
      }
      records.push(record);
    }
    return records;
  }

  private async readConnectedRunProcess(
    processPath: string,
  ): Promise<ConnectedRunProcessIdentity | null> {
    const source = await this.readRequiredFile(processPath);
    return this.parseJson(
      source,
      processPath,
      connectedRunProcessIdentitySchema.nullable(),
    );
  }

  private async readConnectedRunEventStats(
    eventsPath: string,
  ): Promise<{ event_count: number; event_bytes: number }> {
    const source = await this.readRequiredFile(eventsPath);
    if (source.length > 0 && !source.endsWith("\n")) {
      throw this.invalid(eventsPath, "events.ndjson must end with a newline");
    }
    const lines = source.length === 0 ? [] : source.slice(0, -1).split("\n");
    for (const line of lines) {
      this.parseJsonValue(line, eventsPath);
    }
    return {
      event_count: lines.length,
      event_bytes: Buffer.byteLength(source, "utf8"),
    };
  }

  private async requireConnectedRun(
    workItemId: string,
    connectedRunId: string,
  ): Promise<ConnectedRunRecordV2> {
    const record = await this.readConnectedRun(workItemId, connectedRunId);
    if (record === null) {
      throw new ControllerConflictError(
        "work_item_not_found",
        workItemId,
        `Connected run ${connectedRunId} was not found.`,
      );
    }
    return record;
  }

  private interruptedConnectedRun(
    record: ConnectedRunRecordV2,
    reason: string,
  ): ConnectedRunRecordV2 {
    const completedAt = timestampAtOrAfter(record.lifecycle.updated_at);
    return connectedRunRecordV2Schema.parse({
      ...record,
      lifecycle: {
        status: "terminal",
        started_at: record.lifecycle.started_at,
        updated_at: completedAt,
        completed_at: completedAt,
        terminal: {
          outcome: "interrupted",
          partial: true,
          reason,
        },
      },
    });
  }

  private async buildConnectedRunLaunchIntent(
    record: ConnectedRunRecordV2,
    currentInput?: WorkItem,
  ): Promise<SemanticEventIntentV1> {
    const workItemId = record.mission.identity.work_item_id;
    const current = currentInput ?? (await this.readValidated(workItemId));
    if (current === null) {
      throw new ControllerConflictError(
        "work_item_not_found",
        workItemId,
        `Work item ${workItemId} was not found for connected-run launch publication.`,
      );
    }
    const source = {
      kind: "connected_run" as const,
      connected_run_id: record.connected_run_id,
      expected_lifecycle_status: record.lifecycle.status,
      mission_content_sha256: record.mission.content_sha256,
    };
    const kind = "run_launched" as const;
    const slot = "run-launch";
    const missionPath = workspaceRelativePosixPathSchema.parse(
      record.mission.path,
    );
    await this.assertSafeWorkspaceDirectoryComponents(
      posix.dirname(missionPath),
    );
    const missionBytes = await this.readRequiredArtifactBytes(
      join(this.workspaceRoot, ...missionPath.split("/")),
    );
    return semanticEventIntentSchema.parse({
      schema_version: 1,
      intent_id: deriveSemanticIntentId({ source, kind, slot }),
      source,
      slot,
      kind,
      work_item_id: workItemId,
      binding: {
        kind: "governed",
        governed_tuple: record.governed_tuple,
        phase: record.mission.identity.phase,
        status: current.state.status,
      },
      run: {
        family: "connected",
        connected_run_id: record.connected_run_id,
        phase: record.mission.identity.phase,
      },
      actor: {
        kind: "connected_run",
        connected_run_id: record.connected_run_id,
        provenance: record.provenance,
      },
      outcome: `Created durable connected ${record.mission.identity.phase} run attempt.`,
      occurred_at: record.lifecycle.started_at,
      evidence: [
        {
          kind: "mission",
          path: missionPath,
          expected_content_sha256: this.hashArtifactSource(missionBytes),
        },
      ],
      action: null,
      details: {
        kind,
        run_family: "connected",
        phase: record.mission.identity.phase,
        run_id: record.connected_run_id,
        lifecycle_status: record.lifecycle.status,
      },
    });
  }

  private async buildConnectedRunFinishedIntent(
    record: ConnectedRunRecordV2,
  ): Promise<SemanticEventIntentV1> {
    const workItemId = record.mission.identity.work_item_id;
    if (
      record.lifecycle.status !== "terminal" ||
      record.lifecycle.completed_at === null ||
      record.lifecycle.terminal === null
    ) {
      throw new ControllerConflictError(
        "idempotency_conflict",
        workItemId,
        "Connected run finish publication requires an exact terminal record.",
      );
    }
    const current = await this.readValidated(workItemId);
    if (current === null) {
      throw new ControllerConflictError(
        "work_item_not_found",
        workItemId,
        `Work item ${workItemId} was not found for connected-run finish publication.`,
      );
    }
    const source = {
      kind: "connected_run" as const,
      connected_run_id: record.connected_run_id,
      expected_lifecycle_status: "terminal" as const,
      mission_content_sha256: record.mission.content_sha256,
    };
    const kind = "run_finished" as const;
    const slot = "run-finish";
    const runPath = `.founder/${CONNECTED_RUNS_DIRECTORY}/${workItemId}/${record.connected_run_id}/${CONNECTED_RUN_FILE}`;
    const runSource = `${JSON.stringify(record, null, 2)}\n`;
    return semanticEventIntentSchema.parse({
      schema_version: 1,
      intent_id: deriveSemanticIntentId({ source, kind, slot }),
      source,
      slot,
      kind,
      work_item_id: workItemId,
      binding: {
        kind: "governed",
        governed_tuple: record.governed_tuple,
        phase: record.mission.identity.phase,
        status: current.state.status,
      },
      run: {
        family: "connected",
        connected_run_id: record.connected_run_id,
        phase: record.mission.identity.phase,
      },
      actor: {
        kind: "connected_run",
        connected_run_id: record.connected_run_id,
        provenance: record.provenance,
      },
      outcome: `Connected ${record.mission.identity.phase} run finished with ${record.lifecycle.terminal.outcome}.`,
      occurred_at: record.lifecycle.completed_at,
      evidence: [
        {
          kind: "connected_run",
          path: runPath,
          expected_content_sha256: this.hashArtifactSource(runSource),
        },
      ],
      action: null,
      details: {
        kind,
        run_family: "connected",
        phase: record.mission.identity.phase,
        run_id: record.connected_run_id,
        terminal_outcome: record.lifecycle.terminal.outcome,
        partial: record.lifecycle.terminal.partial,
      },
    });
  }

  private async ensureConnectedRunLaunchEvent(
    record: ConnectedRunRecordV2,
  ): Promise<void> {
    const workItemId = record.mission.identity.work_item_id;
    const existing = (
      await this.readSemanticEventIntentFiles(workItemId)
    ).find(
      (intent) =>
        intent.kind === "run_launched" &&
        intent.source.kind === "connected_run" &&
        intent.source.connected_run_id === record.connected_run_id,
    );
    const intent = existing ?? (await this.buildConnectedRunLaunchIntent(record));
    if (existing === undefined) {
      await this.writeSemanticEventIntents(workItemId, [intent]);
    }
    if (
      (await this.readConnectedRun(workItemId, record.connected_run_id)) !==
      null
    ) {
      await this.publishSemanticEventIntent(workItemId, intent.intent_id);
    }
  }

  private async terminalizeConnectedRun(
    record: ConnectedRunRecordV2,
    terminal: ConnectedRunTerminal,
  ): Promise<ConnectedRunRecordV2> {
    const workItemId = record.mission.identity.work_item_id;
    let updated = record;
    if (record.lifecycle.status === "terminal") {
      if (!isDeepStrictEqual(record.lifecycle.terminal, terminal)) {
        throw new ControllerConflictError(
          "idempotency_conflict",
          workItemId,
          "A terminal connected run cannot be completed with a different outcome.",
        );
      }
    } else {
      const completedAt = timestampAtOrAfter(record.lifecycle.updated_at);
      updated = connectedRunRecordV2Schema.parse({
        ...record,
        lifecycle: {
          status: "terminal",
          started_at: record.lifecycle.started_at,
          updated_at: completedAt,
          completed_at: completedAt,
          terminal,
        },
      });
    }

    await this.ensureConnectedRunLaunchEvent(record);
    const finishIntent = await this.buildConnectedRunFinishedIntent(updated);
    await this.writeSemanticEventIntents(workItemId, [finishIntent]);
    if (record.lifecycle.status !== "terminal") {
      await this.writeJsonAtomically(
        this.connectedRunPaths(workItemId, record.connected_run_id).run,
        updated,
      );
    }
    await this.releaseConnectedRunGuardForRecord(updated);
    await this.publishSemanticEventIntent(workItemId, finishIntent.intent_id);
    return updated;
  }

  private async reconcileConnectedRunItem(
    workItemId: string,
    itemDirectory: string,
  ): Promise<ConnectedRunRecordV2[]> {
    const guard = await this.readConnectedRunGuard(itemDirectory);
    if (guard !== null) {
      const guardedRecord = await this.readConnectedRunFromDirectory(
        workItemId,
        guard.connected_run_id,
        itemDirectory,
      );
      if (guardedRecord === null) {
        const interrupted = this.interruptedConnectedRun(
          guard.record,
          "The launch was interrupted before its run directory was published.",
        );
        await this.publishConnectedRunDirectory(interrupted);
        await this.terminalizeConnectedRun(
          interrupted,
          interrupted.lifecycle.terminal!,
        );
      }
    }

    const records = await this.readConnectedRunsFromItemDirectory(
      workItemId,
      itemDirectory,
    );
    if (
      records.filter((record) => record.lifecycle.status !== "terminal")
        .length > 1
    ) {
      throw this.invalid(
        itemDirectory,
        "only one nonterminal connected run may exist per work item",
      );
    }

    const reconciled: ConnectedRunRecordV2[] = [];
    for (const storedRecord of records) {
      if (storedRecord.lifecycle.status === "terminal") {
        reconciled.push(
          await this.terminalizeConnectedRun(
            storedRecord,
            storedRecord.lifecycle.terminal!,
          ),
        );
        continue;
      }

      const paths = this.connectedRunPaths(
        workItemId,
        storedRecord.connected_run_id,
      );
      const storedProcess = await this.readConnectedRunProcess(paths.process);
      let record = storedRecord;
      if (storedProcess !== null && record.process === null) {
        record = connectedRunRecordV2Schema.parse({
          ...record,
          lifecycle: {
            ...record.lifecycle,
            status: "running",
            updated_at: timestampAtOrAfter(
              record.lifecycle.updated_at,
              storedProcess.started_at,
            ),
          },
          process: storedProcess,
        });
        await this.writeJsonAtomically(paths.run, record);
      }

      const processIsAlive =
        storedProcess !== null &&
        (await this.connectedProcessProbe(storedProcess.pid, 0));
      if (processIsAlive) {
        reconciled.push(record);
        continue;
      }

      const interrupted = this.interruptedConnectedRun(
        record,
        storedProcess === null
          ? "The connected run had no recoverable process identity."
          : "The connected agent process was not running during recovery.",
      );
      reconciled.push(
        await this.terminalizeConnectedRun(
          record,
          interrupted.lifecycle.terminal!,
        ),
      );
    }
    return reconciled;
  }

  private async writeJsonAtomically(
    targetPath: string,
    value: unknown,
  ): Promise<void> {
    const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporaryPath, targetPath);
    } catch (error) {
      try {
        await this.unlinkIfPresent(temporaryPath);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "JSON write failed and its temporary file could not be removed",
        );
      }
      throw error;
    }
  }

  private async writeJsonAtomicallyAbortable(
    targetPath: string,
    value: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
    try {
      if (abortWasRequested(signal)) {
        throw new Error("Atomic JSON write was interrupted.");
      }
      await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        signal,
      });
      if (abortWasRequested(signal)) {
        throw new Error("Atomic JSON write was interrupted.");
      }
      renameSync(temporaryPath, targetPath);
    } catch (error) {
      try {
        unlinkFileSyncIfPresent(temporaryPath);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Abortable JSON write failed and its temporary file could not be removed",
        );
      }
      throw error;
    }
  }

  private async ensureDirectory(directoryPath: string): Promise<void> {
    try {
      await mkdir(directoryPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
    }
    await this.assertDirectory(directoryPath);
  }

  private async hasSafeDirectory(directoryPath: string): Promise<boolean> {
    let stats;
    try {
      stats = await lstat(directoryPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }

    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw this.invalid(
        directoryPath,
        "path must be a directory, not a symlink",
      );
    }
    return true;
  }

  private async readOptionalFile(filePath: string): Promise<string | null> {
    let stats;
    try {
      stats = await lstat(filePath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }

    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw this.invalid(filePath, "path must be a regular file, not a symlink");
    }
    return readFile(filePath, "utf8");
  }

  private async unlinkIfPresent(filePath: string): Promise<void> {
    try {
      await unlink(filePath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async readValidated(workItemId: string): Promise<WorkItem | null> {
    const workItemDirectory = join(this.workItemsDirectory, workItemId);

    let directoryStats;
    try {
      directoryStats = await lstat(workItemDirectory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }

    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw this.invalid(workItemDirectory, "work-item path must be a directory");
    }

    return this.readValidatedDirectory(workItemDirectory, workItemId);
  }

  private async readValidatedDirectory(
    workItemDirectory: string,
    workItemId: string,
  ): Promise<WorkItem> {
    const goalPath = join(workItemDirectory, GOAL_FILE);
    const statePath = join(workItemDirectory, STATE_FILE);
    const goalSource = await this.readRequiredFile(goalPath);
    const stateSource = await this.readRequiredFile(statePath);
    const goal = this.parseYaml(goalSource, goalPath, workItemGoalSchema);
    let state: WorkItemState;
    try {
      state = parseWorkItemStateForRead(
        this.parseJsonValue(stateSource, statePath),
      );
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw this.invalid(
          statePath,
          validationReason({ error }),
        );
      }
      throw error;
    }
    const itemResult = workItemSchema.safeParse({ goal, state });

    if (!itemResult.success) {
      throw this.invalid(workItemDirectory, validationReason(itemResult));
    }
    if (itemResult.data.goal.work_item_id !== workItemId) {
      throw this.invalid(
        goalPath,
        `work_item_id must equal containing directory name ${workItemId}`,
      );
    }

    return itemResult.data;
  }

  private async assertWorkItemAbsent(workItemId: string): Promise<void> {
    const workItemDirectory = join(this.workItemsDirectory, workItemId);
    try {
      await lstat(workItemDirectory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      throw error;
    }

    throw this.invalid(workItemDirectory, "target work-item already exists");
  }

  private async validateStagingDirectory(
    workItemId: string,
    stagingPath: string,
  ): Promise<string> {
    const resolvedPath = resolve(stagingPath);
    const relativePath = relative(this.workItemsDirectory, resolvedPath);
    const stagingName = relativePath.split(sep).at(-1) ?? "";

    if (
      relativePath.startsWith(`..${sep}`) ||
      relativePath === ".." ||
      relativePath.includes(sep) ||
      !STAGING_DIRECTORY_PATTERN.test(stagingName) ||
      !stagingName.startsWith(`.${workItemId}.`)
    ) {
      throw this.invalid(stagingPath, "invalid work-item staging path");
    }

    await this.assertDirectory(resolvedPath);
    return resolvedPath;
  }

  private async assertDirectory(directoryPath: string): Promise<void> {
    let stats;
    try {
      stats = await lstat(directoryPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw this.invalid(directoryPath, "required directory is missing");
      }
      throw error;
    }

    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw this.invalid(directoryPath, "path must be a directory, not a symlink");
    }
  }

  private async ensureWorkItemsDirectory(): Promise<void> {
    try {
      await mkdir(this.workItemsDirectory);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
    }

    await this.assertDirectory(this.workItemsDirectory);
  }

  private async hasSafeWorkItemsDirectory(): Promise<boolean> {
    let stats;
    try {
      stats = await lstat(this.workItemsDirectory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }

    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw this.invalid(
        this.workItemsDirectory,
        "path must be a directory, not a symlink",
      );
    }

    return true;
  }

  private async allocateWorkItemDirectory(): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const workItemDirectory = join(
        this.workItemsDirectory,
        `wi_${randomUUID()}`,
      );

      try {
        await mkdir(workItemDirectory);
        return workItemDirectory;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw error;
        }
      }
    }

    throw new Error("Unable to allocate a unique work_item_id after 10 attempts");
  }

  private async writeAtomically(
    workItemDirectory: string,
    goal: WorkItemGoal,
    state: WorkItemState,
  ): Promise<void> {
    const suffix = randomUUID();
    const temporaryGoalPath = join(
      workItemDirectory,
      `.${GOAL_FILE}.${suffix}.tmp`,
    );
    const temporaryStatePath = join(
      workItemDirectory,
      `.${STATE_FILE}.${suffix}.tmp`,
    );
    const goalPath = join(workItemDirectory, GOAL_FILE);
    const statePath = join(workItemDirectory, STATE_FILE);

    await writeFile(temporaryGoalPath, stringify(goal), {
      encoding: "utf8",
      flag: "wx",
    });
    await writeFile(temporaryStatePath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryGoalPath, goalPath);
    await rename(temporaryStatePath, statePath);
  }

  private async replaceStateAtomically(
    workItemId: string,
    state: WorkItemState,
  ): Promise<void> {
    const workItemDirectory = join(this.workItemsDirectory, workItemId);
    const statePath = join(workItemDirectory, STATE_FILE);
    const temporaryStatePath = join(
      workItemDirectory,
      `.${STATE_FILE}.${randomUUID()}.tmp`,
    );

    await this.readRequiredFile(statePath);

    try {
      await writeFile(temporaryStatePath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporaryStatePath, statePath);
    } catch (error) {
      try {
        await unlink(temporaryStatePath);
      } catch (cleanupError) {
        if (!isNodeError(cleanupError) || cleanupError.code !== "ENOENT") {
          throw new AggregateError(
            [error, cleanupError],
            "State update failed and its temporary file could not be removed",
          );
        }
      }
      throw error;
    }
  }

  private async replaceGoalAtomically(
    workItemId: string,
    goal: WorkItemGoal,
  ): Promise<void> {
    const workItemDirectory = join(this.workItemsDirectory, workItemId);
    const goalPath = join(workItemDirectory, GOAL_FILE);
    const temporaryGoalPath = join(
      workItemDirectory,
      `.${GOAL_FILE}.${randomUUID()}.tmp`,
    );

    await this.readRequiredFile(goalPath);

    try {
      await writeFile(temporaryGoalPath, stringify(goal), {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporaryGoalPath, goalPath);
    } catch (error) {
      try {
        await unlink(temporaryGoalPath);
      } catch (cleanupError) {
        if (!isNodeError(cleanupError) || cleanupError.code !== "ENOENT") {
          throw new AggregateError(
            [error, cleanupError],
            "Goal update failed and its temporary file could not be removed",
          );
        }
      }
      throw error;
    }
  }

  private async readRequiredFile(filePath: string): Promise<string> {
    let stats;
    try {
      stats = await lstat(filePath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw this.invalid(filePath, "required file is missing");
      }
      throw error;
    }

    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw this.invalid(filePath, "path must be a regular file, not a symlink");
    }

    return readFile(filePath, "utf8");
  }

  private parseYaml<T>(source: string, filePath: string, schema: ZodType<T>): T {
    let value: unknown;
    try {
      value = parse(source);
    } catch (error) {
      throw this.invalid(filePath, `invalid YAML: ${errorMessage(error)}`);
    }

    return this.parseValue(value, filePath, schema);
  }

  private parseJson<T>(source: string, filePath: string, schema: ZodType<T>): T {
    return this.parseValue(this.parseJsonValue(source, filePath), filePath, schema);
  }

  private parseJsonValue(source: string, filePath: string): unknown {
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch (error) {
      throw this.invalid(filePath, `invalid JSON: ${errorMessage(error)}`);
    }

    return value;
  }

  private parseValue<T>(value: unknown, filePath: string, schema: ZodType<T>): T {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw this.invalid(filePath, validationReason(result));
    }
    return result.data;
  }

  private invalid(artifactPath: string, reason: string): InvalidWorkspaceError {
    const relativePath = relative(this.workspaceRoot, artifactPath)
      .split(sep)
      .join("/");
    return new InvalidWorkspaceError(relativePath || ".", reason);
  }
}
