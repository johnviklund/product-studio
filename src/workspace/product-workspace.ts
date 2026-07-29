import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

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
  parseWorkItemStateForRead,
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
  type ProductManifest,
  type WorkItem,
  type WorkItemGoal,
  type ReviewWorkItemRepository,
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
  createImportRunId,
  executeExternalResultSubmissionSchema,
  externalResultSubmissionSchema,
  hashResultContent,
  importEvidenceEnvelopeSchema,
  importEvidenceSummarySchema,
  importRunIdSchema,
  type AppliedExecuteReviewSubject,
  type AppliedPatchReviewSubject,
  type CommandEvidenceRecord,
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
import {
  connectedRunProcessIdentitySchema,
  connectedRunRecordV1Schema,
  type ConnectedRunProtocolIdentity,
  type ConnectedRunTerminal,
  type ConnectedRunProcessIdentity,
  type ConnectedRunRecordV1,
} from "../domain/connected-run";
import {
  brainstormResultSubmissionSchema,
  hashShapingInput,
  renderShapingTaskMd,
  serializeShapingPackage,
  shapingAcceptanceReceiptSchema,
  shapingIdentitySchema,
  shapingImportReceiptSchema,
  shapingMissionPackageSchema,
  specMissionPackageSchema,
  specResultSubmissionSchema,
  type ShapingAcceptanceReceipt,
  type ShapingArtifactReadResult,
  type ShapingArtifactWriteResult,
  type ShapingIdentity,
  type ShapingImportReceipt,
  type ShapingImportReceiptWriteInput,
  type ShapingMissionPackage,
  type ShapingMissionPackageBuilder,
  type ShapingPaths,
  type ShapingReceiptWriteResult,
  type ShapingResultSnapshot,
  type ShapingResultSubmission,
  type SpecMissionPackage,
  type StoredShapingArtifact,
} from "../domain/shaping";

const FOUNDER_DIRECTORY = ".founder";
const WORK_ITEMS_DIRECTORY = "work-items";
const GOAL_FILE = "goal.yaml";
const STATE_FILE = "state.json";
const RUNS_DIRECTORY = "runs";
const MISSIONS_DIRECTORY = "missions";
const SHAPING_DIRECTORY = "shaping";
const RUN_EVIDENCE_DIRECTORY = "run-evidence";
const EXECUTION_DIRECTORY = "execution";
const EXECUTION_DEFAULTS_FILE = "defaults.json";
const CONNECTED_RUNS_DIRECTORY = "connected-runs";
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
const ACCEPTANCE_JSON_FILE = "acceptance.json";
const VERIFICATION_JSON_FILE = "verification.json";
const CONTROLLER_LOCK_FILE = ".controller.lock";
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
const SHAPING_STAGING_DIRECTORY_PATTERN = new RegExp(
  `^\\.(brainstorm|spec)-[0-9a-f]{64}\\.${UUID_PATTERN}\\.shaping\\.tmp$`,
  "i",
);
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
    record: connectedRunRecordV1Schema,
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function connectedRunLaunchFingerprint(record: ConnectedRunRecordV1): string {
  const launchIdentity = {
    schema_version: record.schema_version,
    mission: record.mission,
    governed_tuple: record.governed_tuple,
    provenance: {
      role: record.provenance.role,
      seat: record.provenance.seat,
      requested_model: record.provenance.requested_model,
      effort: record.provenance.effort,
      harness: record.provenance.harness,
      adapter_profile: record.provenance.adapter_profile,
      resolved_profile_sha256: record.provenance.resolved_profile_sha256,
      resolved_skill_set_sha256:
        record.provenance.resolved_skill_set_sha256,
      capability_envelope_sha256:
        record.provenance.capability_envelope_sha256,
      authorization_sha256: record.provenance.authorization_sha256,
    },
    resolved_capability_envelope_sha256:
      record.resolved_capability_envelope.envelope_sha256,
    acp_protocol_version: record.acp.protocol_version,
    limits: record.limits,
  };
  return createHash("sha256")
    .update(`${JSON.stringify(launchIdentity, null, 2)}\n`)
    .digest("hex");
}

function timestampAtOrAfter(...timestamps: string[]): string {
  const now = new Date().toISOString();
  return [now, ...timestamps].sort().at(-1) ?? now;
}

async function defaultConnectedProcessProbe(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
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
}

export class NodeVerificationRunner implements VerificationRunner {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly killGraceMs: number;
  private readonly drainGraceMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly workspaceRoot: string,
    options: NodeVerificationRunnerOptions = {},
  ) {
    this.environment = options.environment ?? process.env;
    this.killGraceMs = options.killGraceMs ?? 5_000;
    this.drainGraceMs = options.drainGraceMs ?? 1_000;
    this.now = options.now ?? (() => new Date());
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

export type ConnectedProcessProbe = (pid: number) => Promise<boolean>;

export interface ConnectedRunCreateResult {
  record: ConnectedRunRecordV1;
  created: boolean;
}

export interface ConnectedRunEventAppendResult {
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
    record: ConnectedRunRecordV1,
  ): Promise<ConnectedRunCreateResult> {
    const validated = connectedRunRecordV1Schema.parse(record);
    const workItemId = validated.mission.identity.work_item_id;
    if (validated.lifecycle.status === "terminal") {
      throw new ControllerConflictError(
        "invalid_transition",
        workItemId,
        "A new connected run must be nonterminal.",
      );
    }

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
  ): Promise<ConnectedRunRecordV1 | null> {
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
  ): Promise<ConnectedRunRecordV1[]> {
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
  ): Promise<ConnectedRunRecordV1> {
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
    const updated = connectedRunRecordV1Schema.parse({
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
  ): Promise<ConnectedRunRecordV1> {
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
    const updated = connectedRunRecordV1Schema.parse({
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

  async completeConnectedRun(
    workItemId: string,
    connectedRunId: string,
    terminal: ConnectedRunTerminal,
  ): Promise<ConnectedRunRecordV1> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const validatedRunId = controllerRunIdSchema.parse(connectedRunId);
    const record = await this.requireConnectedRun(
      validatedWorkItemId,
      validatedRunId,
    );
    const completedAt = timestampAtOrAfter(record.lifecycle.updated_at);
    const updated = connectedRunRecordV1Schema.parse({
      ...record,
      lifecycle: {
        status: "terminal",
        started_at: record.lifecycle.started_at,
        updated_at: completedAt,
        completed_at: completedAt,
        terminal,
      },
    });

    if (record.lifecycle.status === "terminal") {
      if (JSON.stringify(record.lifecycle.terminal) !== JSON.stringify(terminal)) {
        throw new ControllerConflictError(
          "idempotency_conflict",
          validatedWorkItemId,
          "A terminal connected run cannot be completed with a different outcome.",
        );
      }
      return record;
    }

    const paths = this.connectedRunPaths(validatedWorkItemId, validatedRunId);
    await this.writeJsonAtomically(paths.run, updated);
    await this.releaseConnectedRunGuardForRecord(updated);
    return updated;
  }

  async appendConnectedRunEvent(
    workItemId: string,
    connectedRunId: string,
    event: unknown,
  ): Promise<ConnectedRunEventAppendResult> {
    const validatedWorkItemId = workItemIdSchema.parse(workItemId);
    const validatedRunId = controllerRunIdSchema.parse(connectedRunId);
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

      await appendFile(paths.events, line, "utf8");
      return {
        appended: true,
        limit_reached: false,
        event_count: stats.event_count + 1,
        event_bytes: stats.event_bytes + lineBytes,
      };
    } finally {
      await this.unlinkIfPresent(eventLockPath);
    }
  }

  async reconcileConnectedRuns(): Promise<ConnectedRunRecordV1[]> {
    await this.readManifest();
    const connectedRunsDirectory = join(
      this.founderDirectory,
      CONNECTED_RUNS_DIRECTORY,
    );
    if (!(await this.hasSafeDirectory(connectedRunsDirectory))) {
      return [];
    }

    const reconciled: ConnectedRunRecordV1[] = [];
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
        throw new ControllerConflictError(
          "repair_required",
          validatedId,
          "A controller lock already exists; retained locks require manual repair.",
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
        throw new ControllerConflictError(
          "repair_required",
          validatedId,
          "Controller state already contains active_run without an available lock.",
        );
      }

      if (current.goal.goal_contract !== undefined) {
        const leasedState = workItemStateSchema.parse({
          ...current.state,
          active_run: validatedRun,
        });
        await this.replaceStateAtomically(validatedId, leasedState);
      }

      return { work_item: current, active_run: validatedRun };
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

    const matches = (
      await this.readControllerRunManifests(validatedIdentity.work_item_id)
    ).filter(
      (manifest) =>
        manifest.phase === "execute" &&
        manifest.outcome === "applied" &&
        manifest.goal_version === validatedIdentity.goal_version &&
        manifest.input_revision === validatedIdentity.input_revision &&
        manifest.attempt === validatedIdentity.attempt,
    );

    if (matches.length > 1) {
      throw new ControllerConflictError(
        "mission_not_ready",
        validatedIdentity.work_item_id,
        "More than one applied execute manifest matches the governed tuple.",
      );
    }
    return matches[0] ?? null;
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

    const idempotencyPrefix = [
      validatedIdentity.work_item_id,
      "patch",
      validatedIdentity.goal_version,
      validatedIdentity.input_revision,
      validatedIdentity.attempt,
      `cycle-${validatedIdentity.patch_cycle}`,
      "accept-plan",
      "",
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
        manifest.idempotency_key.startsWith(idempotencyPrefix),
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

  async writeMissionPackage(
    identity: MissionIdentity,
    buildPackage: MissionPackageBuilder,
  ): Promise<MissionArtifactWriteResult> {
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
      await this.resolveGitBaseCommit(),
    );
    const mission = missionPackageSchema.parse(buildPackage(paths));
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
      JSON.stringify(mission.identity) !== JSON.stringify(validatedIdentity) ||
      mission.task_path !== paths.task_path ||
      mission.result_contract.output_path !== paths.output_path
    ) {
      throw this.invalid(
        this.founderDirectory,
        "compiled shaping identity and paths must match the workspace-derived snapshot",
      );
    }
    if (
      mission.input.title !== current.goal.title ||
      mission.input.notes !== current.goal.notes ||
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
    const validatedIdentity = shapingIdentitySchema.parse(identity);
    const snapshot = await this.readShapingPackageSnapshot(validatedIdentity);
    const stored = await this.readStoredShapingArtifact(snapshot);
    if (stored.result === null) {
      throw this.invalid(
        join(snapshot.missionDirectory, RESULT_JSON_FILE),
        "required file is missing",
      );
    }
    return {
      mission: snapshot.mission,
      mission_path: snapshot.relativeMissionPath,
      result_path: stored.result.result_path,
      result_source: stored.result.result_source,
    };
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

  async writeShapingAcceptance(
    input: ShapingAcceptanceReceipt,
  ): Promise<ShapingReceiptWriteResult<ShapingAcceptanceReceipt>> {
    const receipt = shapingAcceptanceReceiptSchema.parse(input);
    const snapshot = await this.readShapingPackageSnapshot(receipt.identity);
    if (snapshot.mission.identity.phase !== "brainstorm") {
      throw this.invalid(
        snapshot.missionDirectory,
        "only a Brainstorm result can have a shaping acceptance",
      );
    }
    const resultPath = join(snapshot.missionDirectory, RESULT_JSON_FILE);
    const resultSource = await this.readRequiredFile(resultPath);
    const resultContentSha256 = this.hashArtifactSource(resultSource);
    const importPath = join(snapshot.missionDirectory, IMPORT_JSON_FILE);
    const importSource = await this.readRequiredFile(importPath);
    const importReceipt = this.parseJson(
      importSource,
      importPath,
      shapingImportReceiptSchema,
    );
    if (
      importReceipt.outcome !== "applied" ||
      JSON.stringify(importReceipt.identity) !== JSON.stringify(receipt.identity) ||
      importReceipt.shaping_mission_content_sha256 !==
        receipt.brainstorm_mission_content_sha256 ||
      importReceipt.result_content_sha256 !==
        receipt.brainstorm_result_content_sha256 ||
      resultContentSha256 !== receipt.brainstorm_result_content_sha256 ||
      snapshot.mission.content_sha256 !==
        receipt.brainstorm_mission_content_sha256
    ) {
      throw this.invalid(
        snapshot.missionDirectory,
        "Brainstorm acceptance must match one applied immutable result",
      );
    }
    this.parseShapingResultForMission(
      resultSource,
      resultPath,
      snapshot.mission,
    );

    const acceptancePath = join(
      snapshot.missionDirectory,
      ACCEPTANCE_JSON_FILE,
    );
    const acceptanceSource = await this.writeImmutableShapingJson(
      acceptancePath,
      receipt,
      "shaping acceptance receipt",
    );
    return {
      receipt,
      receipt_path: acceptancePath,
      receipt_content_sha256: this.hashArtifactSource(acceptanceSource),
    };
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
      const match = /^(brainstorm|spec)-([0-9a-f]{64})$/.exec(entry.name);
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
      if (/^\.?(brainstorm|spec)-/.test(entry.name)) {
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
      missionSnapshot.mission.source_revision.git_base_commit !==
        evidence.git_base_commit ||
      submission.mission_content_sha256 !== evidence.mission_content_sha256 ||
      JSON.stringify(submission.identity) !==
        JSON.stringify(validatedIdentity) ||
      submission.commit !== evidence.result_commit
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
      missionSnapshot.mission.source_revision.git_base_commit !==
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
      createImportRunId(
        evidence.mission_content_sha256,
        evidence.result_content_sha256,
      ) !== evidence.import_run_id
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
        return {
          work_item: this.withoutActiveRun(current),
          manifest: existing,
        };
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

      return { work_item: nextItem, manifest: appliedManifest };
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
      createImportRunId(
        evidence.mission_content_sha256,
        evidence.result_content_sha256,
      ) !== evidence.import_run_id
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
    const existingMission = this.parseJson(
      existingMissionSource,
      missionPath,
      shapingMissionPackageSchema,
    );
    if (
      JSON.stringify(existingMission) !== JSON.stringify(mission) ||
      existingMissionSource !== missionSource ||
      existingTaskSource !== taskSource
    ) {
      throw this.invalid(
        missionDirectory,
        "immutable shaping snapshot differs from the compiled package",
      );
    }
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
    const mission = this.parseJson(
      missionSource,
      missionPath,
      shapingMissionPackageSchema,
    );
    if (
      JSON.stringify(mission.identity) !== JSON.stringify(identity) ||
      mission.task_path !== paths.task_path ||
      mission.result_contract.output_path !== paths.output_path
    ) {
      throw this.invalid(
        missionDirectory,
        "shaping snapshot identity and paths do not match its containing directory",
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
        : this.parseJson(resultSource, resultPath, specResultSubmissionSchema);
    const missionContentSha256 =
      "brainstorm_mission_content_sha256" in result
        ? result.brainstorm_mission_content_sha256
        : result.spec_mission_content_sha256;
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

  private hashArtifactSource(source: string): string {
    return createHash("sha256").update(source).digest("hex");
  }

  private async readStoredShapingArtifact(snapshot: {
    mission: ShapingMissionPackage;
    missionDirectory: string;
    relativeDirectory: string;
    relativeMissionPath: string;
  }): Promise<StoredShapingArtifact> {
    const resultPath = join(snapshot.missionDirectory, RESULT_JSON_FILE);
    const resultSource = await this.readOptionalFile(resultPath);
    const resultContentSha256 =
      resultSource === null ? null : this.hashArtifactSource(resultSource);
    const importPath = join(snapshot.missionDirectory, IMPORT_JSON_FILE);
    const importSource = await this.readOptionalFile(importPath);
    const importReceipt =
      importSource === null
        ? null
        : this.parseJson(importSource, importPath, shapingImportReceiptSchema);
    if (
      importReceipt !== null &&
      (resultSource === null ||
        importReceipt.result_content_sha256 !== resultContentSha256 ||
        importReceipt.shaping_mission_content_sha256 !==
          snapshot.mission.content_sha256 ||
        JSON.stringify(importReceipt.identity) !==
          JSON.stringify(snapshot.mission.identity))
    ) {
      throw this.invalid(
        importPath,
        "shaping import receipt does not match its stored mission and result",
      );
    }
    if (importReceipt?.outcome === "applied" && resultSource !== null) {
      this.parseShapingResultForMission(
        resultSource,
        resultPath,
        snapshot.mission,
      );
    }

    const acceptancePath = join(
      snapshot.missionDirectory,
      ACCEPTANCE_JSON_FILE,
    );
    const acceptanceSource = await this.readOptionalFile(acceptancePath);
    const acceptanceReceipt =
      acceptanceSource === null
        ? null
        : this.parseJson(
            acceptanceSource,
            acceptancePath,
            shapingAcceptanceReceiptSchema,
          );
    if (
      acceptanceReceipt !== null &&
      (snapshot.mission.identity.phase !== "brainstorm" ||
        resultContentSha256 === null ||
        importReceipt?.outcome !== "applied" ||
        JSON.stringify(acceptanceReceipt.identity) !==
          JSON.stringify(snapshot.mission.identity) ||
        acceptanceReceipt.brainstorm_mission_content_sha256 !==
          snapshot.mission.content_sha256 ||
        acceptanceReceipt.brainstorm_result_content_sha256 !==
          resultContentSha256)
    ) {
      throw this.invalid(
        acceptancePath,
        "shaping acceptance does not match one applied Brainstorm result",
      );
    }

    return {
      mission: snapshot.mission,
      mission_path: snapshot.relativeMissionPath,
      task_path: snapshot.mission.task_path,
      result:
        resultSource === null || resultContentSha256 === null
          ? null
          : {
              result_path: posix.join(
                snapshot.relativeDirectory,
                RESULT_JSON_FILE,
              ),
              result_source: resultSource,
              result_content_sha256: resultContentSha256,
            },
      import_receipt: importReceipt,
      import_path:
        importReceipt === null
          ? null
          : posix.join(snapshot.relativeDirectory, IMPORT_JSON_FILE),
      acceptance:
        acceptanceReceipt === null || acceptanceSource === null
          ? null
          : {
              receipt: acceptanceReceipt,
              acceptance_path: posix.join(
                snapshot.relativeDirectory,
                ACCEPTANCE_JSON_FILE,
              ),
              acceptance_content_sha256:
                this.hashArtifactSource(acceptanceSource),
            },
    };
  }

  private async assertSpecShapingSelection(
    mission: SpecMissionPackage,
  ): Promise<void> {
    const matches = (await this.listShapingArtifacts(mission.identity.work_item_id))
      .filter(
        (artifact) =>
          artifact.acceptance?.acceptance_content_sha256 ===
          mission.input.brainstorm_acceptance_sha256,
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
      selected.acceptance === null ||
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
    if (
      result.identity.phase !== "brainstorm" ||
      JSON.stringify(mission.input.brainstorm_acceptance) !==
        JSON.stringify(selected.acceptance.receipt) ||
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
      existingMissionSource !== missionSource ||
      existingTaskSource !== taskSource
    ) {
      throw this.invalid(
        missionDirectory,
        "immutable mission snapshot differs from the compiled package",
      );
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

  private validateControllerLease(lease: ControllerLease): ControllerLease {
    return {
      work_item: workItemSchema.parse(lease.work_item),
      active_run: activeRunSchema.parse(lease.active_run),
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
    record: ConnectedRunRecordV1,
  ): Promise<void> {
    const validated = connectedRunRecordV1Schema.parse(record);
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
    candidate: ConnectedRunRecordV1,
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
    return { record: existing ?? guard.record, created: false };
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
    record: ConnectedRunRecordV1,
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
  ): Promise<ConnectedRunRecordV1 | null> {
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
      connectedRunRecordV1Schema,
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
  ): Promise<ConnectedRunRecordV1[]> {
    const records: ConnectedRunRecordV1[] = [];
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
  ): Promise<ConnectedRunRecordV1> {
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
    record: ConnectedRunRecordV1,
    reason: string,
  ): ConnectedRunRecordV1 {
    const completedAt = timestampAtOrAfter(record.lifecycle.updated_at);
    return connectedRunRecordV1Schema.parse({
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

  private async reconcileConnectedRunItem(
    workItemId: string,
    itemDirectory: string,
  ): Promise<ConnectedRunRecordV1[]> {
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
        await this.releaseConnectedRunGuard(guard);
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

    const reconciled: ConnectedRunRecordV1[] = [];
    for (const storedRecord of records) {
      if (storedRecord.lifecycle.status === "terminal") {
        await this.releaseConnectedRunGuardForRecord(storedRecord);
        reconciled.push(storedRecord);
        continue;
      }

      const paths = this.connectedRunPaths(
        workItemId,
        storedRecord.connected_run_id,
      );
      const storedProcess = await this.readConnectedRunProcess(paths.process);
      let record = storedRecord;
      if (storedProcess !== null && record.process === null) {
        record = connectedRunRecordV1Schema.parse({
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
        (await this.connectedProcessProbe(storedProcess.pid));
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
      await this.writeJsonAtomically(paths.run, interrupted);
      await this.releaseConnectedRunGuardForRecord(interrupted);
      reconciled.push(interrupted);
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
