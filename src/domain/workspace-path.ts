import { z } from "zod";

export function isSafeWorkspaceRelativePosixPath(value: string): boolean {
  return (
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value
      .split("/")
      .every(
        (segment) => segment !== "" && segment !== "." && segment !== "..",
      )
  );
}

export const workspaceRelativePosixPathSchema = z
  .string()
  .refine(
    isSafeWorkspaceRelativePosixPath,
    "must be a safe workspace-relative POSIX path",
  );

export function scopeMatchesPath(scopeEntry: string, path: string): boolean {
  return path === scopeEntry || path.startsWith(`${scopeEntry}/`);
}
