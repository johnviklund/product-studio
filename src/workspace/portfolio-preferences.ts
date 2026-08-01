import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import {
  InvalidPortfolioPreferencesError,
  PORTFOLIO_PREFERENCES_SCHEMA_VERSION,
  canonicalPortfolioPreferences,
  portfolioPreferencesV1Schema,
  setSeatModelPreferenceInputSchema,
  type PortfolioPreferencesV1,
  type SetSeatModelPreferenceInput,
  type ShapingModelSeat,
} from "../domain/portfolio-preferences";

export const PORTFOLIO_PREFERENCES_RELATIVE_PATH =
  ".portfolio/model-preferences.json" as const;

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

function emptyPreferences(): PortfolioPreferencesV1 {
  return {
    schema_version: PORTFOLIO_PREFERENCES_SCHEMA_VERSION,
    preferences: {},
  };
}

export class PortfolioPreferencesStore {
  readonly preferencesPath: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(readonly applicationRoot: string) {
    if (!isAbsolute(applicationRoot)) {
      throw new Error("applicationRoot must be absolute");
    }
    this.preferencesPath = join(
      applicationRoot,
      PORTFOLIO_PREFERENCES_RELATIVE_PATH,
    );
  }

  async read(): Promise<PortfolioPreferencesV1> {
    let stats;
    try {
      stats = await lstat(this.preferencesPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return emptyPreferences();
      }
      throw this.invalid(
        `unable to inspect preferences: ${errorMessage(error)}`,
      );
    }

    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw this.invalid("path must be a regular file, not a symlink");
    }

    let source: string;
    try {
      source = await readFile(this.preferencesPath, "utf8");
    } catch (error) {
      throw this.invalid(`unable to read preferences: ${errorMessage(error)}`);
    }

    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch (error) {
      throw this.invalid(`invalid JSON: ${errorMessage(error)}`);
    }

    const result = portfolioPreferencesV1Schema.safeParse(value);
    if (!result.success) {
      throw this.invalid(validationReason(result));
    }

    return result.data;
  }

  async getPreference(
    adapterId: string,
    seat: ShapingModelSeat,
  ): Promise<string | null> {
    const key = setSeatModelPreferenceInputSchema.parse({
      adapter_id: adapterId,
      seat,
      requested_model: "validation-placeholder",
    });
    const document = await this.read();
    return document.preferences[key.adapter_id]?.[key.seat] ?? null;
  }

  setPreference(
    input: SetSeatModelPreferenceInput,
  ): Promise<PortfolioPreferencesV1> {
    const validatedInput = setSeatModelPreferenceInputSchema.parse(input);
    return this.enqueueMutation(async () => {
      const current = await this.read();
      const next = canonicalPortfolioPreferences({
        schema_version: PORTFOLIO_PREFERENCES_SCHEMA_VERSION,
        preferences: {
          ...current.preferences,
          [validatedInput.adapter_id]: {
            ...current.preferences[validatedInput.adapter_id],
            [validatedInput.seat]: validatedInput.requested_model,
          },
        },
      });
      await this.write(next);
      return next;
    });
  }

  private async write(document: PortfolioPreferencesV1): Promise<void> {
    const validated = canonicalPortfolioPreferences(document);
    const preferencesDirectory = dirname(this.preferencesPath);
    const temporaryPath = `${this.preferencesPath}.${randomUUID()}.tmp`;

    await mkdir(preferencesDirectory, { recursive: true });
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(validated, null, 2)}\n`,
        {
          encoding: "utf8",
          flag: "wx",
        },
      );
      await rename(temporaryPath, this.preferencesPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private enqueueMutation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const queued = this.mutationQueue.then(operation);
    this.mutationQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private invalid(reason: string): InvalidPortfolioPreferencesError {
    return new InvalidPortfolioPreferencesError(
      this.preferencesPath,
      reason,
    );
  }
}
