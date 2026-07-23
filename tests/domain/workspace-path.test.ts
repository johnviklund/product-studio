import { describe, expect, it } from "vitest";

import {
  scopeMatchesPath,
  workspaceRelativePosixPathSchema,
} from "../../src/domain/workspace-path";

describe("workspace path value object", () => {
  it.each(["src/app", "src/app/page.tsx"])(
    "accepts safe workspace-relative POSIX path %s",
    (path) => {
      expect(workspaceRelativePosixPathSchema.parse(path)).toBe(path);
    },
  );

  it.each(["/src/app", "../src/app", "src\\app", "src//app"])(
    "rejects unsafe path %s",
    (path) => {
      expect(() => workspaceRelativePosixPathSchema.parse(path)).toThrow();
    },
  );

  it("matches an exact file or descendants below a directory boundary", () => {
    expect(scopeMatchesPath("src/app/page.tsx", "src/app/page.tsx")).toBe(
      true,
    );
    expect(scopeMatchesPath("src/app", "src/app/page.tsx")).toBe(true);
    expect(scopeMatchesPath("src/app", "src/app/admin/page.tsx")).toBe(true);
    expect(scopeMatchesPath("src/app", "src/application/page.tsx")).toBe(
      false,
    );
    expect(scopeMatchesPath("src/app/page.tsx", "src/app/page.tsx/child")).toBe(
      true,
    );
  });
});
