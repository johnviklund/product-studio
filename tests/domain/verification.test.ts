import { describe, expect, it } from "vitest";

import type {
  GitVerificationAdapter,
  VerificationRunner,
} from "../../src/domain/verification";

describe("verification dependency contracts", () => {
  it("are implementable by deterministic fakes without Node process imports", async () => {
    const git = {
      async resolveCommit(revision: string) {
        return revision === "missing" ? null : "a".repeat(40);
      },
      async isAncestor() {
        return true;
      },
      async readHeadCommit() {
        return "a".repeat(40);
      },
      async isWorktreeCleanExcludingFounder() {
        return true;
      },
      async listChangedFiles() {
        return ["src/domain/verification.ts"];
      },
    } satisfies GitVerificationAdapter;
    const runner: VerificationRunner = {
      async run(command: { name: string; argv: [string, ...string[]] }) {
        return {
          name: command.name,
          argv: command.argv,
          started_at: "2026-07-22T12:00:00.000Z",
          completed_at: "2026-07-22T12:00:01.000Z",
          duration_ms: 1000,
          status: "passed" as const,
          exit_code: 0,
          signal: null,
          stdout: "",
          stderr: "",
          output_truncated: false,
        };
      },
    };

    expect(await git.resolveCommit("HEAD")).toBe("a".repeat(40));
    expect(
      (await runner.run({
        name: "Tests",
        argv: ["npm", "test"],
        timeout_seconds: 120,
      })).status,
    ).toBe("passed");
  });
});
