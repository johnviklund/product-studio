import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { VerificationCommand } from "../src/domain/work-item";
import {
  NodeGitVerificationAdapter,
  NodeVerificationRunner,
} from "../src/workspace/product-workspace";

const execFileAsync = promisify(execFile);
const createdRoots: string[] = [];

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  createdRoots.push(root);
  return root;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
  });
  return stdout.trim();
}

afterEach(async () => {
  await Promise.all(
    createdRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("Node Git verification adapter", () => {
  it("proves commit resolution, ancestry, HEAD, .founder exemption, and NUL diff paths in one real repository", async () => {
    const root = await createRoot("product-studio-git-adapter-");
    await git(root, ["init"]);
    await git(root, ["config", "user.name", "Product Studio Test"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await writeFile(join(root, "README.md"), "base\n", "utf8");
    await git(root, ["add", "README.md"]);
    await git(root, ["commit", "-m", "base"]);
    const baseCommit = await git(root, ["rev-parse", "HEAD"]);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "example.ts"), "export {};\n", "utf8");
    await git(root, ["add", "src/example.ts"]);
    await git(root, ["commit", "-m", "result"]);
    const resultCommit = await git(root, ["rev-parse", "HEAD"]);
    const adapter = new NodeGitVerificationAdapter(root);

    expect(await adapter.resolveCommit(resultCommit)).toBe(resultCommit);
    expect(await adapter.resolveCommit("f".repeat(40))).toBeNull();
    expect(await adapter.isAncestor(baseCommit, resultCommit)).toBe(true);
    expect(await adapter.isAncestor(resultCommit, baseCommit)).toBe(false);
    expect(await adapter.readHeadCommit()).toBe(resultCommit);
    expect(await adapter.listChangedFiles(baseCommit, resultCommit)).toEqual([
      "src/example.ts",
    ]);
    expect(await adapter.isWorktreeCleanExcludingFounder()).toBe(true);

    await mkdir(join(root, ".founder"));
    await writeFile(join(root, ".founder", "state.json"), "{}\n", "utf8");
    expect(await adapter.isWorktreeCleanExcludingFounder()).toBe(true);
    await writeFile(join(root, "src", "dirty.ts"), "export {};\n", "utf8");
    expect(await adapter.isWorktreeCleanExcludingFounder()).toBe(false);
  });
});

describe("Node verification runner", () => {
  it("records pass, fail, timeout, spawn error, and bounded output", async () => {
    const root = await createRoot("product-studio-command-runner-");
    const environment = Object.assign(Object.create(null), process.env, {
      PRODUCT_STUDIO_SECRET: "must-not-leak",
    }) as NodeJS.ProcessEnv;
    const runner = new NodeVerificationRunner(root, {
      environment,
      killGraceMs: 10,
    });
    const run = (name: string, source: string, timeoutSeconds = 2) =>
      runner.run({
        name,
        argv: [process.execPath, "-e", source],
        timeout_seconds: timeoutSeconds,
      });

    await expect(
      run(
        "Pass",
        "console.log(process.env.CI, process.env.PRODUCT_STUDIO_SECRET)",
      ),
    ).resolves.toMatchObject({
      status: "passed",
      exit_code: 0,
      stdout: "1 undefined\n",
    });
    await expect(run("Fail", "process.exit(3)")).resolves.toMatchObject({
      status: "failed",
      exit_code: 3,
    });
    await expect(
      run(
        "Timeout",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
        1,
      ),
    ).resolves.toMatchObject({ status: "timed_out" });
    await expect(
      runner.run({
        name: "Spawn error",
        argv: ["product-studio-command-that-does-not-exist"],
        timeout_seconds: 1,
      }),
    ).resolves.toMatchObject({ status: "spawn_error", exit_code: null });
    const bounded = await run("Bounded", "process.stdout.write('x'.repeat(70000))");
    expect(bounded).toMatchObject({
      status: "passed",
      output_truncated: true,
    });
    expect(Buffer.byteLength(bounded.stdout)).toBe(64 * 1024);
  });

  it("bounds timed-out runs when a descendant holds the output pipes", async () => {
    const root = await createRoot("product-studio-command-descendant-");
    const killGraceMs = 25;
    const drainGraceMs = 50;
    const runner = new NodeVerificationRunner(root, {
      killGraceMs,
      drainGraceMs,
    });
    const descendantSource = "setTimeout(() => process.exit(0), 3000)";
    const command: VerificationCommand = {
      name: "Pipe-holding descendant",
      argv: [
        process.execPath,
        "-e",
        [
          'const { spawn } = require("node:child_process")',
          `spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { stdio: "inherit" })`,
          'process.on("SIGTERM", () => {})',
          "setInterval(() => {}, 1000)",
        ].join(";"),
      ],
      timeout_seconds: 1,
    };
    const maximumDurationMs =
      command.timeout_seconds * 1_000 + killGraceMs + drainGraceMs + 500;

    for (let runNumber = 0; runNumber < 2; runNumber += 1) {
      const startedMs = Date.now();
      const result = await runner.run(command);

      expect(result.status).toBe("timed_out");
      expect(Date.now() - startedMs).toBeLessThan(maximumDurationMs);
    }
  });

  it("serialises concurrent authoritative verification in one workspace and refuses when the wait expires", async () => {
    const root = await createRoot("product-studio-command-exclusive-");
    const tracePath = join(root, "trace.log");
    const runner = new NodeVerificationRunner(root, { exclusivePollMs: 5 });
    const command = (name: string): VerificationCommand => ({
      name,
      argv: [
        process.execPath,
        "-e",
        [
          'const { appendFileSync } = require("node:fs")',
          `appendFileSync(${JSON.stringify(tracePath)}, "${name}-start\\n")`,
          `setTimeout(() => appendFileSync(${JSON.stringify(tracePath)}, "${name}-end\\n"), 150)`,
        ].join(";"),
      ],
      timeout_seconds: 5,
    });

    const [first, second] = await Promise.all([
      runner.run(command("A")),
      runner.run(command("B")),
    ]);

    expect(first.status).toBe("passed");
    expect(second.status).toBe("passed");
    const trace = (await readFile(tracePath, "utf8")).trim().split("\n");
    expect(trace).toHaveLength(4);
    expect(trace[0].slice(0, 1)).toBe(trace[1].slice(0, 1));
    expect(trace[2].slice(0, 1)).toBe(trace[3].slice(0, 1));
    expect(trace[0].slice(0, 1)).not.toBe(trace[2].slice(0, 1));

    await mkdir(join(root, ".founder"), { recursive: true });
    await writeFile(join(root, ".founder", ".verification.lock"), "{}\n", "utf8");
    const blocked = new NodeVerificationRunner(root, { exclusiveWaitMs: 0 });
    const refused = await blocked.run({
      name: "Blocked",
      argv: [process.execPath, "-e", "process.exit(0)"],
      timeout_seconds: 5,
    });

    expect(refused).toMatchObject({ status: "spawn_error", exit_code: null });
    expect(refused.stderr).toContain("Another authoritative verification");
  });
});
