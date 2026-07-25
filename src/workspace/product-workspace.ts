import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
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
  missionIdentitySchema,
  missionPackageSchema,
  renderTaskMd,
  reviewSubjectSchema,
  serializeMissionPackage,
  type MissionArtifactWriteResult,
  type MissionIdentity,
  type MissionPackage,
  type MissionPackageBuilder,
  type MissionPaths,
  type ReviewMissionPackage,
  type ReviewSubject,
} from "../domain/mission";
import {
  commandEvidenceRecordSchema,
  createImportRunId,
  executeExternalResultSubmissionSchema,
  hashResultContent,
  importEvidenceEnvelopeSchema,
  importEvidenceSummarySchema,
  importRunIdSchema,
  type AppliedExecuteReviewSubject,
  type CommandEvidenceRecord,
  type ExecuteImportEvidenceEnvelope,
  type ImportEvidenceSummary,
  type ImportEvidenceWriteInput,
  type MissionResultSnapshot,
  type StoredImportEvidence,
} from "../domain/result";
import type {
  GitVerificationAdapter,
  VerificationRunner,
} from "../domain/verification";

const FOUNDER_DIRECTORY = ".founder";
const WORK_ITEMS_DIRECTORY = "work-items";
const GOAL_FILE = "goal.yaml";
const STATE_FILE = "state.json";
const RUNS_DIRECTORY = "runs";
const MISSIONS_DIRECTORY = "missions";
const RUN_EVIDENCE_DIRECTORY = "run-evidence";
const MISSION_JSON_FILE = "mission.json";
const TASK_MD_FILE = "TASK.md";
const RESULT_JSON_FILE = "result.json";
const SUBMISSION_JSON_FILE = "submission.json";
const IMPORT_JSON_FILE = "import.json";
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
}

export class ProductWorkspace implements ReviewWorkItemRepository {
  readonly workspaceRoot: string;

  private readonly founderDirectory: string;
  private readonly workItemsDirectory: string;
  private readonly gitAdapter: GitVerificationAdapter;
  private readonly commandRunner: VerificationRunner;

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
  }

  gitVerificationAdapter(): GitVerificationAdapter {
    return this.gitAdapter;
  }

  verificationRunner(): VerificationRunner {
    return this.commandRunner;
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
        schema_version: 1,
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

    const runsDirectory = join(
      this.workItemsDirectory,
      validatedIdentity.work_item_id,
      RUNS_DIRECTORY,
    );
    if (!(await this.hasSafeDirectory(runsDirectory))) {
      return null;
    }

    const entries = await readdir(runsDirectory, { withFileTypes: true });
    const matches: ControllerRunManifest[] = [];
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
      const manifest = this.parseControllerRunManifest(
        source,
        manifestPath,
        validatedIdentity.work_item_id,
        runIdResult.data,
      );
      if (
        manifest.phase === "execute" &&
        manifest.outcome === "applied" &&
        manifest.goal_version === validatedIdentity.goal_version &&
        manifest.input_revision === validatedIdentity.input_revision &&
        manifest.attempt === validatedIdentity.attempt
      ) {
        matches.push(manifest);
      }
    }

    if (matches.length > 1) {
      throw new ControllerConflictError(
        "mission_not_ready",
        validatedIdentity.work_item_id,
        "More than one applied execute manifest matches the governed tuple.",
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

    const reviewSubject = reviewSubjectSchema.parse({
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

    const freshSubject = await this.readAppliedExecuteReviewSubject({
      ...validatedIdentity,
      phase: "execute",
    });
    const validatedSubject = reviewSubjectSchema.parse(reviewSubject);
    if (
      JSON.stringify(validatedSubject) !==
      JSON.stringify(freshSubject.review_subject)
    ) {
      throw this.missionNotReady(
        validatedIdentity.work_item_id,
        "Review subject does not match the current applied execute evidence.",
      );
    }

    const paths = this.missionPaths(
      validatedIdentity,
      validatedSubject.git_base_commit,
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
  ): Promise<MissionResultSnapshot> {
    const validatedIdentity = missionIdentitySchema.parse(identity);
    const snapshot = await this.readMissionPackageSnapshot(validatedIdentity);
    const resultPath = join(snapshot.missionDirectory, RESULT_JSON_FILE);

    return {
      mission: snapshot.mission,
      mission_path: snapshot.relativeMissionPath,
      result_path: posix.join(snapshot.relativeDirectory, RESULT_JSON_FILE),
      result_source: await this.readRequiredFile(resultPath),
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

      const identityMatch = /^(execute|review)-(\d+)-(\d+)-(\d+)$/.exec(
        identityEntry.name,
      );
      if (identityMatch === null) {
        throw this.invalid(
          identityDirectory,
          "evidence identity directory must use the <phase>-<goal_version>-<input_revision>-<attempt> format",
        );
      }
      const identityResult = missionIdentitySchema.safeParse({
        phase: identityMatch[1],
        work_item_id: validatedWorkItemId,
        goal_version: Number(identityMatch[2]),
        input_revision: Number(identityMatch[3]),
        attempt: Number(identityMatch[4]),
      });
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
    return {
      evidence,
      summary: this.evidenceSummary(evidence),
      verification,
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
    if (outcome === "rejected" && verification.length > 0) {
      throw this.invalid(
        this.founderDirectory,
        "rejected import evidence cannot contain command results",
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
      !verification.some((record) =>
        ["failed", "timed_out", "spawn_error"].includes(record.status),
      )
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
    const missionDirectory = join(
      workItemMissionsDirectory,
      this.missionDirectoryName(identity),
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
      `.${this.missionDirectoryName(identity)}.${randomUUID()}.mission.tmp`,
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

  private async readMissionPackageSnapshot(identity: MissionIdentity): Promise<{
    mission: MissionPackage;
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
      this.missionDirectoryName(identity),
    );
    const missionsDirectory = join(this.founderDirectory, MISSIONS_DIRECTORY);
    const workItemMissionsDirectory = join(
      missionsDirectory,
      identity.work_item_id,
    );
    const missionDirectory = join(
      workItemMissionsDirectory,
      this.missionDirectoryName(identity),
    );
    await this.assertDirectory(missionsDirectory);
    await this.assertDirectory(workItemMissionsDirectory);
    await this.assertDirectory(missionDirectory);

    const missionPath = join(missionDirectory, MISSION_JSON_FILE);
    const missionSource = await this.readRequiredFile(missionPath);
    const mission = this.parseJson(
      missionSource,
      missionPath,
      missionPackageSchema,
    );
    const expectedPaths = this.missionPaths(
      identity,
      mission.source_revision.git_base_commit,
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
      serializeMissionPackage(mission),
      renderTaskMd(mission),
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
  ): MissionPaths {
    const relativeDirectory = posix.join(
      FOUNDER_DIRECTORY,
      MISSIONS_DIRECTORY,
      identity.work_item_id,
      this.missionDirectoryName(identity),
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

  private missionDirectoryName(identity: MissionIdentity): string {
    return [
      identity.phase,
      identity.goal_version,
      identity.input_revision,
      identity.attempt,
    ].join("-");
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
    mission: MissionPackage,
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
      missionPackageSchema,
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
    const state = this.parseJson(stateSource, statePath, workItemStateSchema);
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
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch (error) {
      throw this.invalid(filePath, `invalid JSON: ${errorMessage(error)}`);
    }

    return this.parseValue(value, filePath, schema);
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
