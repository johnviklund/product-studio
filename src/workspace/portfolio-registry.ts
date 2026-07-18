import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import {
  InvalidRegistryError,
  portfolioRegistrySchema,
  registeredWorkspaceSchema,
  type RegisteredWorkspace,
} from "../domain/portfolio";

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

export class PortfolioRegistry {
  constructor(readonly registryPath: string) {
    if (!isAbsolute(registryPath)) {
      throw new Error("registryPath must be absolute");
    }
  }

  async read(): Promise<RegisteredWorkspace[]> {
    let stats;
    try {
      stats = await lstat(this.registryPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw this.invalid(`unable to inspect registry: ${errorMessage(error)}`);
    }

    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw this.invalid("path must be a regular file, not a symlink");
    }

    let source: string;
    try {
      source = await readFile(this.registryPath, "utf8");
    } catch (error) {
      throw this.invalid(`unable to read registry: ${errorMessage(error)}`);
    }

    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch (error) {
      throw this.invalid(`invalid JSON: ${errorMessage(error)}`);
    }

    const result = portfolioRegistrySchema.safeParse(value);
    if (!result.success) {
      throw this.invalid(validationReason(result));
    }

    return result.data.workspaces;
  }

  async append(entry: RegisteredWorkspace): Promise<void> {
    const validatedEntry = registeredWorkspaceSchema.parse(entry);
    const workspaces = await this.read();
    const registry = portfolioRegistrySchema.parse({
      schema_version: 1,
      workspaces: [...workspaces, validatedEntry],
    });
    const registryDirectory = dirname(this.registryPath);
    const temporaryPath = `${this.registryPath}.${randomUUID()}.tmp`;

    await mkdir(registryDirectory, { recursive: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporaryPath, this.registryPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private invalid(reason: string): InvalidRegistryError {
    return new InvalidRegistryError(this.registryPath, reason);
  }
}
