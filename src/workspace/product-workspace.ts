import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { parse, stringify } from "yaml";
import type { ZodType } from "zod";

import {
  InvalidWorkspaceError,
  createWorkItemInputSchema,
  productManifestSchema,
  workItemGoalSchema,
  workItemIdSchema,
  workItemSchema,
  workItemStateSchema,
  type CreateWorkItemInput,
  type ProductManifest,
  type WorkItem,
  type WorkItemGoal,
  type WorkItemRepository,
  type WorkItemState,
} from "../domain/work-item";

const FOUNDER_DIRECTORY = ".founder";
const WORK_ITEMS_DIRECTORY = "work-items";
const GOAL_FILE = "goal.yaml";
const STATE_FILE = "state.json";

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
        title: validatedInput.title,
        type: validatedInput.type,
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
