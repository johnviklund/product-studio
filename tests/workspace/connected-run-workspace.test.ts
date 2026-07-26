import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import {
  resolveCapabilityEnvelope,
  type ExecutionDefaultsV1,
} from "../../src/domain/capability-envelope";
import {
  hashResolvedCapabilityEnvelope,
  type ConnectedRunProcessIdentity,
  type ConnectedRunRecordV1,
} from "../../src/domain/connected-run";
import { InvalidWorkspaceError } from "../../src/domain/work-item";
import { ProductWorkspace } from "../../src/workspace/product-workspace";

const createdRoots: string[] = [];
const workItemId = "wi_550e8400-e29b-41d4-a716-446655440000";
const firstRunId = "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1";
const secondRunId = "123e4567-e89b-42d3-a456-426614174000";
const defaults: ExecutionDefaultsV1 = {
  schema_version: 1,
  approved_command_forms: [
    { executable: "npm", args: ["run", "test"] },
  ],
  approved_url_operations: [],
  mcp: "forbidden",
  credentials: "forbidden",
};

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "product-studio-connected-run-"));
  createdRoots.push(root);
  const founderDirectory = join(root, ".founder");
  const workItemDirectory = join(
    founderDirectory,
    "work-items",
    workItemId,
  );
  await mkdir(workItemDirectory, { recursive: true });
  await writeFile(
    join(founderDirectory, "product.yaml"),
    stringify({
      schema_version: 2,
      product_name: "Connected Run Test",
      verification: {
        required_commands: [
          {
            name: "Tests",
            argv: ["npm", "test"],
            timeout_seconds: 120,
          },
        ],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(workItemDirectory, "goal.yaml"),
    stringify({
      schema_version: 2,
      work_item_id: workItemId,
      title: "Connected execution",
      type: "Feature",
      goal_contract: {
        schema_version: 1,
        goal_version: 1,
        purpose: "Run a governed mission through ACP.",
        acceptance_criteria: ["The connected run is recoverable."],
        non_goals: ["Do not infer completion."],
        allowed_scope: ["src", "tests"],
        review_ready: ["Required checks pass."],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(workItemDirectory, "state.json"),
    `${JSON.stringify(
      {
        schema_version: 2,
        work_item_id: workItemId,
        phase: "execute",
        status: "active",
        updated_at: "2026-07-26T18:00:00.000Z",
        goal_version: 1,
        input_revision: 1,
        attempt: 0,
        patch_cycle: 0,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return root;
}

function connectedRun(
  connectedRunId = firstRunId,
  overrides: {
    requestedModel?: string;
    maxEventCount?: number;
    maxEventBytes?: number;
    maxOutputBytes?: number;
  } = {},
): ConnectedRunRecordV1 {
  const envelope = resolveCapabilityEnvelope(["src", "tests"], defaults);
  const envelopeSha256 = hashResolvedCapabilityEnvelope(envelope);
  return {
    schema_version: 1,
    connected_run_id: connectedRunId,
    mission: {
      identity: {
        phase: "execute",
        work_item_id: workItemId,
        goal_version: 1,
        input_revision: 1,
        attempt: 0,
      },
      path: `.founder/missions/${workItemId}/execute-1-1-0/mission.json`,
      content_sha256: "a".repeat(64),
      source_commit: "b".repeat(40),
    },
    governed_tuple: {
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
      patch_cycle: 0,
    },
    provenance: {
      role: { value: "writer", assurance: "controller_observed" },
      seat: { value: "executor", assurance: "controller_observed" },
      requested_model: {
        value: overrides.requestedModel ?? "copilot-default",
        assurance: "user_declared",
      },
      effective_model: {
        assurance: "unknown",
        model_id: null,
        deployment_id: null,
        observed_event_sha256: null,
      },
      effort: { value: "high", assurance: "user_declared" },
      harness: {
        value: { id: "copilot-cli", version: "1.0.0" },
        assurance: "controller_observed",
      },
      adapter_profile: {
        value: {
          adapter_id: "copilot-acp",
          adapter_version: "1.0.0",
          profile_id: "execute-v1",
        },
        assurance: "controller_observed",
      },
      resolved_profile_sha256: {
        value: "c".repeat(64),
        assurance: "controller_observed",
      },
      resolved_skill_set_sha256: {
        value: "d".repeat(64),
        assurance: "controller_observed",
      },
      capability_envelope_sha256: {
        value: envelopeSha256,
        assurance: "controller_observed",
      },
      authorization_sha256: {
        value: "e".repeat(64),
        assurance: "controller_observed",
      },
    },
    resolved_capability_envelope: {
      envelope,
      envelope_sha256: envelopeSha256,
    },
    acp: {
      protocol_version: { value: null, assurance: "unknown" },
      session_id: { value: null, assurance: "unknown" },
    },
    lifecycle: {
      status: "starting",
      started_at: "2026-07-26T18:00:00.000Z",
      updated_at: "2026-07-26T18:00:00.000Z",
      completed_at: null,
      terminal: null,
    },
    limits: {
      wall_clock_timeout_ms: 900_000,
      max_event_count: overrides.maxEventCount ?? 100,
      max_event_bytes: overrides.maxEventBytes ?? 100_000,
      max_output_bytes: overrides.maxOutputBytes ?? 10_000,
      termination_grace_ms: 5_000,
      drain_grace_ms: 1_000,
    },
    process: null,
    diagnostics: { entries: [], truncated: false },
  };
}

function runDirectory(root: string, connectedRunId = firstRunId): string {
  return join(
    root,
    ".founder",
    "connected-runs",
    workItemId,
    connectedRunId,
  );
}

afterEach(async () => {
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("connected-run workspace storage", () => {
  it("uses fail-closed defaults and rejects malformed or linked defaults", async () => {
    const root = await createWorkspace();
    const workspace = new ProductWorkspace(root);
    const failClosed: ExecutionDefaultsV1 = {
      schema_version: 1,
      approved_command_forms: [],
      approved_url_operations: [],
      mcp: "forbidden",
      credentials: "forbidden",
    };
    expect(await workspace.readExecutionDefaults()).toEqual(failClosed);

    const executionDirectory = join(root, ".founder", "execution");
    const defaultsPath = join(executionDirectory, "defaults.json");
    await mkdir(executionDirectory);
    expect(await workspace.readExecutionDefaults()).toEqual(failClosed);

    await writeFile(defaultsPath, `${JSON.stringify(defaults)}\n`, "utf8");
    expect(await workspace.readExecutionDefaults()).toEqual(defaults);

    await writeFile(defaultsPath, '{"schema_version":2}\n', "utf8");
    await expect(workspace.readExecutionDefaults()).rejects.toBeInstanceOf(
      InvalidWorkspaceError,
    );

    await rm(defaultsPath);
    const targetPath = join(root, "linked-defaults.json");
    await writeFile(targetPath, `${JSON.stringify(defaults)}\n`, "utf8");
    await symlink(targetPath, defaultsPath);
    await expect(workspace.readExecutionDefaults()).rejects.toBeInstanceOf(
      InvalidWorkspaceError,
    );
  });

  it("atomically deduplicates an identical launch and refuses a different one", async () => {
    const root = await createWorkspace();
    const workspace = new ProductWorkspace(root);
    const [first, replay] = await Promise.all([
      workspace.createConnectedRun(connectedRun(firstRunId)),
      workspace.createConnectedRun(connectedRun(secondRunId)),
    ]);

    const winner = first.created ? first : replay;
    const duplicate = first.created ? replay : first;
    expect(winner.created).toBe(true);
    expect(duplicate).toEqual({ record: winner.record, created: false });
    expect(await readdir(runDirectory(root, winner.record.connected_run_id))).toEqual(
      ["events.ndjson", "process.json", "run.json"],
    );
    expect(await workspace.listConnectedRuns(workItemId)).toEqual([
      winner.record,
    ]);

    await expect(
      workspace.createConnectedRun(
        connectedRun(secondRunId, { requestedModel: "different-model" }),
      ),
    ).rejects.toMatchObject({
      kind: "lease_held",
      workItemId,
    });
  });

  it("redacts retained events, enforces immutable limits, and stores strict process identity", async () => {
    const root = await createWorkspace();
    const workspace = new ProductWorkspace(root);
    const record = connectedRun(firstRunId, { maxEventCount: 1 });
    await workspace.createConnectedRun(record);

    expect(
      await workspace.appendConnectedRunEvent(workItemId, firstRunId, {
        type: "tool_call",
        authorization: "Bearer secret-value",
        nested: { apiKey: "secret-value", safe: "retained" },
        stdout: "raw output",
      }),
    ).toMatchObject({ appended: true, limit_reached: false, event_count: 1 });
    const eventsSource = await readFile(
      join(runDirectory(root), "events.ndjson"),
      "utf8",
    );
    expect(eventsSource).toContain("[REDACTED]");
    expect(eventsSource).toContain("retained");
    expect(eventsSource).not.toContain("secret-value");
    expect(eventsSource).not.toContain("raw output");
    expect(
      await workspace.appendConnectedRunEvent(workItemId, firstRunId, {
        type: "second",
      }),
    ).toEqual({
      appended: false,
      limit_reached: true,
      event_count: 1,
      event_bytes: Buffer.byteLength(eventsSource, "utf8"),
    });

    const processIdentity: ConnectedRunProcessIdentity = {
      pid: 4321,
      process_group_id: 4321,
      started_at: "2026-07-26T18:00:01.000Z",
    };
    await expect(
      workspace.writeConnectedRunProcessIdentity(
        workItemId,
        firstRunId,
        { ...processIdentity, token: "secret" } as ConnectedRunProcessIdentity,
      ),
    ).rejects.toThrow();
    const running = await workspace.writeConnectedRunProcessIdentity(
      workItemId,
      firstRunId,
      processIdentity,
    );
    expect(running).toMatchObject({
      lifecycle: { status: "running" },
      process: processIdentity,
    });
    expect(
      JSON.parse(
        await readFile(join(runDirectory(root), "process.json"), "utf8"),
      ),
    ).toEqual(processIdentity);

    const sizeRoot = await createWorkspace();
    const sizeWorkspace = new ProductWorkspace(sizeRoot);
    await sizeWorkspace.createConnectedRun(
      connectedRun(firstRunId, { maxEventBytes: 30 }),
    );
    expect(
      await sizeWorkspace.appendConnectedRunEvent(
        workItemId,
        firstRunId,
        { message: "x".repeat(1_000) },
      ),
    ).toEqual({
      appended: false,
      limit_reached: true,
      event_count: 0,
      event_bytes: 0,
    });
    expect(
      await readFile(join(runDirectory(sizeRoot), "events.ndjson"), "utf8"),
    ).toBe("");
  });

  it("marks an unpublished partial launch interrupted and never completed", async () => {
    const root = await createWorkspace();
    const workspace = new ProductWorkspace(root, {
      connectedProcessProbe: async () => false,
    });
    await workspace.createConnectedRun(connectedRun());
    await rm(runDirectory(root), { recursive: true });

    const [recovered] = await workspace.reconcileConnectedRuns();
    expect(recovered.lifecycle).toMatchObject({
      status: "terminal",
      terminal: { outcome: "interrupted", partial: true },
    });
    expect(recovered.lifecycle.terminal?.outcome).not.toBe("completed");
    await expect(
      readFile(
        join(
          root,
          ".founder",
          "connected-runs",
          workItemId,
          ".launch-guard.json",
        ),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a live process nonterminal and interrupts a gone process", async () => {
    const liveRoot = await createWorkspace();
    const liveWorkspace = new ProductWorkspace(liveRoot, {
      connectedProcessProbe: async () => true,
    });
    await liveWorkspace.createConnectedRun(connectedRun());
    await liveWorkspace.writeConnectedRunProcessIdentity(
      workItemId,
      firstRunId,
      {
        pid: 1111,
        process_group_id: 1111,
        started_at: "2026-07-26T18:00:01.000Z",
      },
    );
    const [live] = await liveWorkspace.reconcileConnectedRuns();
    expect(live.lifecycle.status).toBe("running");

    const goneRoot = await createWorkspace();
    const goneWorkspace = new ProductWorkspace(goneRoot, {
      connectedProcessProbe: async () => false,
    });
    await goneWorkspace.createConnectedRun(connectedRun());
    await goneWorkspace.writeConnectedRunProcessIdentity(
      workItemId,
      firstRunId,
      {
        pid: 2222,
        process_group_id: 2222,
        started_at: "2026-07-26T18:00:01.000Z",
      },
    );
    const [gone] = await goneWorkspace.reconcileConnectedRuns();
    expect(gone.lifecycle).toMatchObject({
      status: "terminal",
      terminal: { outcome: "interrupted", partial: true },
    });
    expect(gone.lifecycle.terminal?.outcome).not.toBe("completed");
  });
});
