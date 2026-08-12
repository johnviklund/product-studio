import { createHash } from "node:crypto";
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
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import {
  resolveCapabilityEnvelope,
  type ExecutionDefaultsV1,
} from "../../src/domain/capability-envelope";
import {
  hashResolvedCapabilityEnvelope,
  type ConnectedRunProcessIdentity,
  type ConnectedRunRecordV2,
} from "../../src/domain/connected-run";
import { hashResultContent } from "../../src/domain/result";
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
const missionSources = {
  execute: `${JSON.stringify({ phase: "execute", fixture: true }, null, 2)}\n`,
  review: `${JSON.stringify({ phase: "review", fixture: true }, null, 2)}\n`,
} as const;

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
  for (const phase of ["execute", "review"] as const) {
    const missionDirectory = join(
      founderDirectory,
      "missions",
      workItemId,
      `${phase}-1-1-0`,
    );
    await mkdir(missionDirectory, { recursive: true });
    await writeFile(
      join(missionDirectory, "mission.json"),
      missionSources[phase],
      "utf8",
    );
  }
  return root;
}

async function setActiveReviewState(root: string): Promise<void> {
  await writeFile(
    join(root, ".founder", "work-items", workItemId, "state.json"),
    `${JSON.stringify(
      {
        schema_version: 2,
        work_item_id: workItemId,
        phase: "review",
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
}

function connectedRun(
  connectedRunId = firstRunId,
  overrides: {
    phase?: "execute" | "review";
    requestedModel?: string;
    maxEventCount?: number;
    maxEventBytes?: number;
    maxOutputBytes?: number;
  } = {},
): ConnectedRunRecordV2 {
  const envelope = resolveCapabilityEnvelope(["src", "tests"], defaults);
  const envelopeSha256 = hashResolvedCapabilityEnvelope(envelope);
  const phase = overrides.phase ?? "execute";
  return {
    schema_version: 2,
    connected_run_id: connectedRunId,
    mission: {
      identity: {
        phase,
        work_item_id: workItemId,
        goal_version: 1,
        input_revision: 1,
        attempt: 0,
      },
      path: `.founder/missions/${workItemId}/${phase}-1-1-0/mission.json`,
      content_sha256: createHash("sha256")
        .update(missionSources[phase])
        .digest("hex"),
      source_commit: "b".repeat(40),
    },
    governed_tuple: {
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
      patch_cycle: 0,
    },
    provenance: {
      role: {
        value: phase === "review" ? "reviewer" : "writer",
        assurance: "controller_observed",
      },
      seat: {
        value: phase === "review" ? "reviewer" : "executor",
        assurance: "controller_observed",
      },
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
          profile_id: `${phase}-v1`,
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
      authorization_sha256: {
        value: "e".repeat(64),
        assurance: "controller_observed",
      },
    },
    authorization:
      phase === "review"
        ? {
            kind: "review_result_ingress",
            result_path: `.founder/missions/${workItemId}/review-1-1-0/result.json`,
            policy_sha256: "f".repeat(64),
          }
        : {
            kind: "capability_envelope",
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

async function semanticEvents(root: string): Promise<unknown[]> {
  const directory = join(
    root,
    ".founder",
    "semantic-events",
    workItemId,
    "events",
  );
  return Promise.all(
    (await readdir(directory)).map(async (entry) =>
      JSON.parse(await readFile(join(directory, entry), "utf8")),
    ),
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
    await expect(
      workspace.createConnectedRun(
        connectedRun(secondRunId, { phase: "review" }),
      ),
    ).rejects.toMatchObject({ kind: "lease_held", workItemId });
  });

  it("rejects a launch guard whose legacy fingerprint does not bind v2 phase authorization", async () => {
    const root = await createWorkspace();
    const workspace = new ProductWorkspace(root);
    await workspace.createConnectedRun(connectedRun());
    const guardPath = join(
      root,
      ".founder",
      "connected-runs",
      workItemId,
      ".launch-guard.json",
    );
    const guard = JSON.parse(await readFile(guardPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      guardPath,
      `${JSON.stringify(
        { ...guard, launch_fingerprint: "0".repeat(64) },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(workspace.reconcileConnectedRuns()).rejects.toThrow(
      "launch_fingerprint must hash the guarded launch identity",
    );
  });

  it("rejects a durable v1 run during direct read and reconciliation", async () => {
    const root = await createWorkspace();
    const workspace = new ProductWorkspace(root);
    const current = connectedRun();
    await workspace.createConnectedRun(current);
    if (current.authorization.kind !== "capability_envelope") {
      throw new Error("Expected an Execute capability authorization fixture.");
    }
    const legacyRecord = {
      ...current,
      schema_version: 1,
      provenance: {
        ...current.provenance,
        capability_envelope_sha256: {
          value: current.authorization.envelope_sha256,
          assurance: "controller_observed",
        },
      },
      resolved_capability_envelope: {
        envelope: current.authorization.envelope,
        envelope_sha256: current.authorization.envelope_sha256,
      },
    };
    delete (legacyRecord as Partial<typeof legacyRecord>).authorization;
    await writeFile(
      join(runDirectory(root), "run.json"),
      `${JSON.stringify(legacyRecord, null, 2)}\n`,
      "utf8",
    );

    await expect(
      workspace.readConnectedRun(workItemId, firstRunId),
    ).rejects.toBeInstanceOf(InvalidWorkspaceError);
    await expect(workspace.reconcileConnectedRuns()).rejects.toBeInstanceOf(
      InvalidWorkspaceError,
    );
    await expect(readFile(join(runDirectory(root), "run.json"), "utf8"))
      .resolves.toContain('"schema_version": 1');
  });

  it("records an adapter-observed model for a running Review phase", async () => {
    const root = await createWorkspace();
    const workspace = new ProductWorkspace(root);
    await workspace.createConnectedRun(
      connectedRun(firstRunId, { phase: "review" }),
    );
    await workspace.startConnectedRun(
      workItemId,
      firstRunId,
      {
        protocol_version: { value: 1, assurance: "adapter_attested" },
        session_id: { value: "review-session", assurance: "adapter_attested" },
      },
      {
        pid: 3333,
        process_group_id: 3333,
        started_at: "2026-07-26T18:00:01.000Z",
      },
    );

    await expect(
      workspace.updateConnectedRunEffectiveModel(workItemId, firstRunId, {
        assurance: "adapter_attested",
        model_id: "review-model",
        deployment_id: null,
        observed_event_sha256: "9".repeat(64),
      }),
    ).resolves.toMatchObject({
      mission: { identity: { phase: "review" } },
      provenance: {
        effective_model: {
          assurance: "adapter_attested",
          model_id: "review-model",
        },
      },
    });
  });

  it("publishes only the bounded exact Review result with immutable replay", async () => {
    const root = await createWorkspace();
    const workspace = new ProductWorkspace(root);
    const review = connectedRun(firstRunId, {
      phase: "review",
      maxOutputBytes: 64,
    });
    if (
      review.authorization.kind !== "review_result_ingress" ||
      review.mission.identity.phase !== "review"
    ) {
      throw new Error("Expected a Review result-ingress fixture.");
    }
    const resultPath = join(
      root,
      ...review.authorization.result_path.split("/"),
    );
    await mkdir(dirname(resultPath), { recursive: true });
    await workspace.createConnectedRun(review);
    await expect(
      workspace.writeConnectedReviewResult(
        workItemId,
        firstRunId,
        resultPath,
        '{"verdict":"clean"}\n',
      ),
    ).rejects.toMatchObject({ kind: "invalid_transition" });
    await workspace.startConnectedRun(
      workItemId,
      firstRunId,
      {
        protocol_version: { value: 1, assurance: "adapter_attested" },
        session_id: { value: "review-write-session", assurance: "adapter_attested" },
      },
      {
        pid: 4444,
        process_group_id: 4444,
        started_at: "2026-07-26T18:00:01.000Z",
      },
    );
    const source = '{"verdict":"clean"}\n';

    await expect(
      workspace.writeConnectedReviewResult(
        workItemId,
        firstRunId,
        resultPath,
        source,
      ),
    ).resolves.toEqual({ written: true });
    await expect(
      workspace.writeConnectedReviewResult(
        workItemId,
        firstRunId,
        resultPath,
        source,
      ),
    ).resolves.toEqual({ written: false });
    await expect(
      workspace.writeConnectedReviewResult(
        workItemId,
        firstRunId,
        resultPath,
        '{"verdict":"findings"}\n',
      ),
    ).rejects.toMatchObject({ kind: "idempotency_conflict" });
    await expect(
      workspace.writeConnectedReviewResult(
        workItemId,
        firstRunId,
        join(dirname(resultPath), "sibling.json"),
        source,
      ),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });
    await expect(
      workspace.writeConnectedReviewResult(
        workItemId,
        firstRunId,
        resultPath,
        "",
      ),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });
    await expect(
      workspace.writeConnectedReviewResult(
        workItemId,
        firstRunId,
        resultPath,
        "x".repeat(65),
      ),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });
    await expect(readFile(resultPath, "utf8")).resolves.toBe(source);
  });

  it("archives an exact stale Review result before clearing it and replays idempotently", async () => {
    const root = await createWorkspace();
    const workspace = new ProductWorkspace(root);
    const review = connectedRun(firstRunId, { phase: "review" });
    if (
      review.authorization.kind !== "review_result_ingress" ||
      review.mission.identity.phase !== "review"
    ) {
      throw new Error("Expected a Review result-ingress fixture.");
    }
    await setActiveReviewState(root);
    const resultPath = join(
      root,
      ...review.authorization.result_path.split("/"),
    );
    await mkdir(dirname(resultPath), { recursive: true });
    const staleSource = '{"verdict":"clean","summary":"stale"}\n';
    await writeFile(resultPath, staleSource, "utf8");
    await workspace.createConnectedRun(review);
    await workspace.startConnectedRun(
      workItemId,
      firstRunId,
      {
        protocol_version: { value: 1, assurance: "adapter_attested" },
        session_id: { value: "review-recovery-session", assurance: "adapter_attested" },
      },
      {
        pid: 6666,
        process_group_id: 6666,
        started_at: "2026-07-26T18:00:01.000Z",
      },
    );
    await workspace.completeConnectedRun(workItemId, firstRunId, {
      outcome: "failed",
      partial: true,
      reason: "Review result ingress was not observed.",
    });
    const resultContentSha256 = hashResultContent(staleSource);
    const input = {
      identity: review.mission.identity,
      patch_cycle: 0,
      review_mission_content_sha256: review.mission.content_sha256,
      result_path: review.authorization.result_path,
      expected_result_content_sha256: resultContentSha256,
      recovery_trigger_connected_run_id: firstRunId,
    };

    await expect(
      workspace.recoverConnectedReviewResult({
        ...input,
        expected_result_content_sha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ kind: "stale_expectation" });
    await expect(readFile(resultPath, "utf8")).resolves.toBe(staleSource);

    const recovered = await workspace.recoverConnectedReviewResult(input);
    expect(recovered).toMatchObject({
      schema_version: 1,
      work_item_id: workItemId,
      identity: review.mission.identity,
      patch_cycle: 0,
      review_mission_content_sha256: review.mission.content_sha256,
      result_content_sha256: resultContentSha256,
      original_result_path: review.authorization.result_path,
      recovery_trigger_connected_run_id: firstRunId,
    });
    await expect(readFile(resultPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(root, ...recovered.archived_result_path.split("/")), "utf8"),
    ).resolves.toBe(staleSource);
    await expect(
      readFile(join(root, ...recovered.recovery_path.split("/")), "utf8"),
    ).resolves.toBe(`${JSON.stringify(recovered, null, 2)}\n`);
    await expect(
      workspace.recoverConnectedReviewResult(input),
    ).resolves.toEqual(recovered);
  });

  it("refuses stale Review recovery while a connected run is active", async () => {
    const root = await createWorkspace();
    const workspace = new ProductWorkspace(root);
    const review = connectedRun(firstRunId, { phase: "review" });
    if (
      review.authorization.kind !== "review_result_ingress" ||
      review.mission.identity.phase !== "review"
    ) {
      throw new Error("Expected a Review result-ingress fixture.");
    }
    await setActiveReviewState(root);
    const resultPath = join(
      root,
      ...review.authorization.result_path.split("/"),
    );
    await mkdir(dirname(resultPath), { recursive: true });
    const staleSource = '{"verdict":"clean","summary":"stale"}\n';
    await writeFile(resultPath, staleSource, "utf8");
    await workspace.createConnectedRun(review);

    await expect(
      workspace.recoverConnectedReviewResult({
        identity: review.mission.identity,
        patch_cycle: 0,
        review_mission_content_sha256: review.mission.content_sha256,
        result_path: review.authorization.result_path,
        expected_result_content_sha256: hashResultContent(staleSource),
        recovery_trigger_connected_run_id: firstRunId,
      }),
    ).rejects.toMatchObject({ kind: "lease_held" });
    await expect(readFile(resultPath, "utf8")).resolves.toBe(staleSource);
  });

  it("rejects a symlinked Review result parent", async () => {
    const root = await createWorkspace();
    const workspace = new ProductWorkspace(root);
    const review = connectedRun(firstRunId, { phase: "review" });
    if (review.authorization.kind !== "review_result_ingress") {
      throw new Error("Expected a Review result-ingress fixture.");
    }
    const missionsRoot = join(root, ".founder", "missions");
    const outside = join(root, "outside-review-parent");
    await workspace.createConnectedRun(review);
    await rm(join(missionsRoot, workItemId), { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(missionsRoot, workItemId), "dir");
    await workspace.startConnectedRun(
      workItemId,
      firstRunId,
      {
        protocol_version: { value: 1, assurance: "adapter_attested" },
        session_id: { value: "review-symlink-session", assurance: "adapter_attested" },
      },
      {
        pid: 5555,
        process_group_id: 5555,
        started_at: "2026-07-26T18:00:01.000Z",
      },
    );

    await expect(
      workspace.writeConnectedReviewResult(
        workItemId,
        firstRunId,
        join(root, ...review.authorization.result_path.split("/")),
        '{"verdict":"clean"}\n',
      ),
    ).rejects.toBeInstanceOf(InvalidWorkspaceError);
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

  it("terminalizes a run exactly once and releases its launch guard", async () => {
    const root = await createWorkspace();
    const workspace = new ProductWorkspace(root);
    await workspace.createConnectedRun(connectedRun(firstRunId));
    await workspace.startConnectedRun(
      workItemId,
      firstRunId,
      {
        protocol_version: { value: 1, assurance: "adapter_attested" },
        session_id: {
          value: "connected-model-session",
          assurance: "adapter_attested",
        },
      },
      {
        pid: 4321,
        process_group_id: 4321,
        started_at: "2026-07-26T18:00:01.000Z",
      },
    );
    const modelA = {
      assurance: "adapter_attested" as const,
      model_id: "model-a",
      deployment_id: "deployment-a",
      observed_event_sha256: "1".repeat(64),
    };
    const modelB = {
      assurance: "adapter_attested" as const,
      model_id: "model-b",
      deployment_id: "deployment-b",
      observed_event_sha256: "2".repeat(64),
    };
    await workspace.updateConnectedRunEffectiveModel(
      workItemId,
      firstRunId,
      modelA,
    );
    const modelASource = await readFile(
      join(runDirectory(root), "run.json"),
      "utf8",
    );
    await workspace.updateConnectedRunEffectiveModel(
      workItemId,
      firstRunId,
      modelA,
    );
    expect(await readFile(join(runDirectory(root), "run.json"), "utf8")).toBe(
      modelASource,
    );
    await workspace.updateConnectedRunEffectiveModel(
      workItemId,
      firstRunId,
      modelB,
    );
    const terminal = {
      outcome: "failed" as const,
      partial: true,
      reason: "The connected runtime failed before completion.",
    };

    const completed = await workspace.completeConnectedRun(
      workItemId,
      firstRunId,
      terminal,
    );
    expect(completed.lifecycle).toMatchObject({
      status: "terminal",
      terminal,
    });
    expect(completed.provenance.effective_model).toEqual(modelB);
    await expect(
      workspace.completeConnectedRun(workItemId, firstRunId, terminal),
    ).resolves.toEqual(completed);
    expect(await semanticEvents(root)).toMatchObject([
      {
        stream_sequence: 1,
        kind: "run_launched",
        details: {
          lifecycle_status: "starting",
          run_id: firstRunId,
        },
        evidence: [
          {
            kind: "mission",
            path: `.founder/missions/${workItemId}/execute-1-1-0/mission.json`,
          },
        ],
      },
      {
        stream_sequence: 2,
        kind: "run_finished",
        details: {
          terminal_outcome: "failed",
          partial: true,
          run_id: firstRunId,
        },
        actor: {
          provenance: { effective_model: modelB },
        },
      },
    ]);
    await expect(
      workspace.completeConnectedRun(workItemId, firstRunId, {
        outcome: "cancelled",
        partial: true,
        reason: "A different terminal outcome.",
      }),
    ).rejects.toMatchObject({ kind: "idempotency_conflict", workItemId });
    await expect(
      workspace.updateConnectedRunEffectiveModel(workItemId, firstRunId, {
        ...modelB,
        model_id: "model-c",
      }),
    ).rejects.toMatchObject({ kind: "idempotency_conflict", workItemId });

    await expect(
      workspace.createConnectedRun(connectedRun(secondRunId)),
    ).resolves.toMatchObject({ created: true });
  });

  it("marks an unpublished partial launch interrupted and never completed", async () => {
    const root = await createWorkspace();
    const workspace = new ProductWorkspace(root, {
      connectedProcessProbe: async () => false,
    });
    await workspace.createConnectedRun(connectedRun());
    await rm(runDirectory(root), { recursive: true });
    await rm(
      join(
        root,
        ".founder",
        "semantic-events",
        workItemId,
        "events",
        "0000000000000001.json",
      ),
    );

    const [recovered] = await workspace.reconcileConnectedRuns();
    expect(recovered.lifecycle).toMatchObject({
      status: "terminal",
      terminal: { outcome: "interrupted", partial: true },
    });
    expect(recovered.lifecycle.terminal?.outcome).not.toBe("completed");
    expect(await semanticEvents(root)).toMatchObject([
      { stream_sequence: 1, kind: "run_launched" },
      {
        stream_sequence: 2,
        kind: "run_finished",
        details: { terminal_outcome: "interrupted", partial: true },
      },
    ]);
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
    expect(await semanticEvents(liveRoot)).toMatchObject([
      { stream_sequence: 1, kind: "run_launched" },
    ]);

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
    expect(await semanticEvents(goneRoot)).toMatchObject([
      { stream_sequence: 1, kind: "run_launched" },
      {
        stream_sequence: 2,
        kind: "run_finished",
        details: { terminal_outcome: "interrupted", partial: true },
      },
    ]);
  });
});
