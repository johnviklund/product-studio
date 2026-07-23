import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
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
import type { ZodType } from "zod";

import {
  ControllerConflictError,
  InvalidWorkspaceError,
  activeRunSchema,
  controllerRunIdSchema,
  controllerRunManifestSchema,
  createCaptureInputSchema,
  createWorkItemInputSchema,
  productManifestSchema,
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
  type WorkItemRepository,
  type WorkItemState,
  type UpdateWorkItemPhaseInput,
} from "../domain/work-item";
import {
  missionIdentitySchema,
  missionPackageSchema,
  renderTaskMd,
  serializeMissionPackage,
  type MissionArtifactWriteResult,
  type MissionIdentity,
  type MissionPackage,
  type MissionPackageBuilder,
  type MissionPaths,
} from "../domain/mission";

const FOUNDER_DIRECTORY = ".founder";
const WORK_ITEMS_DIRECTORY = "work-items";
const GOAL_FILE = "goal.yaml";
const STATE_FILE = "state.json";
const RUNS_DIRECTORY = "runs";
const MISSIONS_DIRECTORY = "missions";
const MISSION_JSON_FILE = "mission.json";
const TASK_MD_FILE = "TASK.md";
const RESULT_JSON_FILE = "result.json";
const CONTROLLER_LOCK_FILE = ".controller.lock";
const execFileAsync = promisify(execFile);
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

export class ProductWorkspace implements WorkItemRepository {
  readonly workspaceRoot: string;

  private readonly founderDirectory: string;
  private readonly workItemsDirectory: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.founderDirectory = join(this.workspaceRoot, FOUNDER_DIRECTORY);
    this.workItemsDirectory = join(
      this.founderDirectory,
      WORK_ITEMS_DIRECTORY,
    );
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
        schema_version: 1,
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

  async stageIncomingWorkItem(item: WorkItem): Promise<string> {
    const validatedItem = workItemSchema.parse(item);
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
    await this.readValidatedDirectory(validatedStagingPath, validatedId);
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

      if (current.goal.goal_version !== undefined) {
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
    identity: MissionIdentity,
  ): Promise<ControllerRunManifest | null> {
    const validatedIdentity = missionIdentitySchema.parse(identity);
    await this.readManifest();
    if (!(await this.hasSafeWorkItemsDirectory())) {
      return null;
    }
    if ((await this.readValidated(validatedIdentity.work_item_id)) === null) {
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
      current.state.phase !== "execute" ||
      current.state.status !== "active" ||
      current.goal.goal_version !== validatedIdentity.goal_version ||
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

    const missionSource = serializeMissionPackage(mission);
    const taskSource = renderTaskMd(mission);
    const missionsDirectory = join(this.founderDirectory, MISSIONS_DIRECTORY);
    const workItemMissionsDirectory = join(
      missionsDirectory,
      validatedIdentity.work_item_id,
    );
    const missionDirectory = join(
      workItemMissionsDirectory,
      this.missionDirectoryName(validatedIdentity),
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
      `.${this.missionDirectoryName(validatedIdentity)}.${randomUUID()}.mission.tmp`,
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
      const { stdout } = await execFileAsync(
        "git",
        ["rev-parse", "--verify", "HEAD^{commit}"],
        { cwd: this.workspaceRoot, encoding: "utf8" },
      );
      const commit = stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(commit)) {
        throw new Error("Git returned a non-canonical commit SHA");
      }
      return commit;
    } catch (error) {
      throw this.invalid(
        ".git",
        `cannot resolve the mission Git base commit: ${errorMessage(error)}`,
      );
    }
  }

  private missionDirectoryName(identity: MissionIdentity): string {
    return [
      identity.goal_version,
      identity.input_revision,
      identity.attempt,
    ].join("-");
  }

  private missionWriteResult(
    mission: MissionPackage,
    missionDirectory: string,
  ): MissionArtifactWriteResult {
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
      manifest.goal_version !== nextItem.goal.goal_version ||
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

  private async writeControllerRunManifest(
    manifest: ControllerRunManifest,
  ): Promise<void> {
    const validated = controllerRunManifestSchema.parse(manifest);
    const runsDirectory = join(
      this.workItemsDirectory,
      validated.work_item_id,
      RUNS_DIRECTORY,
    );
    await this.ensureDirectory(runsDirectory);

    const manifestPath = join(runsDirectory, `${validated.run_id}.json`);
    await this.writeJsonAtomically(manifestPath, validated);
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
