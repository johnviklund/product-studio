import { randomUUID } from "node:crypto";
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
import { join, relative, resolve, sep } from "node:path";

import { parse, stringify } from "yaml";
import type { ZodType } from "zod";

import {
  InvalidWorkspaceError,
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
  type ProductManifest,
  type WorkItem,
  type WorkItemGoal,
  type WorkItemRepository,
  type WorkItemState,
  type UpdateWorkItemPhaseInput,
} from "../domain/work-item";

const FOUNDER_DIRECTORY = ".founder";
const WORK_ITEMS_DIRECTORY = "work-items";
const GOAL_FILE = "goal.yaml";
const STATE_FILE = "state.json";
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
