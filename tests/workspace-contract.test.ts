import {
  createHash,
} from "node:crypto";
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
import { parse, stringify } from "yaml";

import {
  compileMission,
  compilePatchMission,
  compileReviewMission,
  hashHistoricalMissionContentV3,
  renderReadableTaskMd,
  renderTaskMd,
  serializeReadableMissionPackage,
  serializeMissionPackage,
  type HistoricalExecuteMissionPackageV3,
  type HistoricalReviewMissionPackageV3,
  type MissionIdentity,
  type PatchSubject,
  type ReviewMissionControllerRun,
} from "../src/domain/mission";
import {
  createImportRunId,
  hashResultContent,
  serializeExternalResult,
  type ImportEvidenceEnvelope,
} from "../src/domain/result";
import {
  compileBrainstormMission,
  compileSpecMission,
  hashShapingInput,
  type BrainstormResultSubmission,
  type ShapingAcceptanceReceipt,
  type ShapingIdentity,
} from "../src/domain/shaping";
import {
  InvalidWorkspaceError,
  type ActiveRun,
  type ControllerMutationInput,
  type ControllerRunManifest,
  type WorkItem,
} from "../src/domain/work-item";
import type { GitVerificationAdapter } from "../src/domain/verification";
import { ProductWorkspace } from "../src/workspace/product-workspace";

const createdRoots: string[] = [];
const firstId = "wi_123e4567-e89b-12d3-a456-426614174000";
const secondId = "wi_550e8400-e29b-41d4-a716-446655440000";
const firstRunId = "550e8400-e29b-41d4-a716-446655440000";
const secondRunId = "123e4567-e89b-42d3-a456-426614174000";
const thirdRunId = "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1";
const testGit: GitVerificationAdapter = {
  async resolveCommit() {
    return "a".repeat(40);
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
    return ["src/domain/result.ts"];
  },
};

function missionWorkspace(root: string) {
  return new ProductWorkspace(root, { git: testGit });
}

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "product-studio-workspace-"));
  createdRoots.push(root);

  const founderDirectory = join(root, ".founder");
  await mkdir(founderDirectory, { recursive: true });
  await writeFile(
    join(founderDirectory, "product.yaml"),
    stringify({
      schema_version: 2,
      product_name: "Test Workspace",
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

  return root;
}

async function writeWorkItem(
  root: string,
  workItemId: string,
  updatedAt: string,
): Promise<void> {
  const directory = join(root, ".founder", "work-items", workItemId);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "goal.yaml"),
    stringify({
      schema_version: 2,
      work_item_id: workItemId,
      title: `Item ${workItemId}`,
      type: "Explore",
    }),
    "utf8",
  );
  await writeFile(
    join(directory, "state.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        work_item_id: workItemId,
        phase: "idea",
        status: "active",
        updated_at: updatedAt,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function writeContractedWorkItem(
  root: string,
  workItemId: string,
): Promise<void> {
  const directory = join(root, ".founder", "work-items", workItemId);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "goal.yaml"),
    stringify({
      schema_version: 2,
      work_item_id: workItemId,
      title: `Item ${workItemId}`,
      type: "Explore",
      goal_contract: {
        schema_version: 1,
        goal_version: 1,
        purpose: "Keep workspace contracts strict.",
        acceptance_criteria: ["Reject stale state"],
        non_goals: ["Do not infer missing state."],
        allowed_scope: ["src/domain"],
        review_ready: ["Checks pass"],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(directory, "state.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        work_item_id: workItemId,
        phase: "idea",
        status: "active",
        updated_at: "2026-07-21T20:00:00.000Z",
        goal_version: 1,
        input_revision: 1,
        attempt: 0,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function writeShapingReadyWorkItem(
  root: string,
  workItemId: string,
  phase: "brainstorm" | "spec" = "brainstorm",
): Promise<WorkItem> {
  const directory = join(root, ".founder", "work-items", workItemId);
  const goal = {
    schema_version: 2 as const,
    work_item_id: workItemId,
    title: `Shape item ${workItemId}`,
    type: "Feature" as const,
    notes: "Keep shaping artifacts immutable.",
  };
  const state = {
    schema_version: 2 as const,
    work_item_id: workItemId,
    phase,
    status: "active" as const,
    updated_at: "2026-07-29T00:00:00.000Z",
  };
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "goal.yaml"), stringify(goal), "utf8");
  await writeFile(
    join(directory, "state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
  return { goal, state };
}

function hashSource(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

async function writeMissionReadyWorkItem(
  root: string,
  workItemId: string,
  phase: "execute" | "review" | "patch" = "execute",
  patchCycle = phase === "patch" ? 1 : 0,
): Promise<WorkItem> {
  const directory = join(root, ".founder", "work-items", workItemId);
  const goal = {
    schema_version: 2 as const,
    work_item_id: workItemId,
    title: `Mission item ${workItemId}`,
    type: "Feature" as const,
    goal_contract: {
      schema_version: 1 as const,
      goal_version: 1,
      purpose: "Keep the mission reproducible.",
      acceptance_criteria: ["The mission is reproducible"],
      non_goals: ["Do not mutate unrelated state."],
      allowed_scope: ["src/domain"],
      review_ready: ["Checks pass"],
    },
  };
  const state = {
    schema_version: 2 as const,
    work_item_id: workItemId,
    phase,
    status: "active" as const,
    updated_at: "2026-07-22T12:00:01.000Z",
    goal_version: 1,
    input_revision: 1,
    attempt: 0,
    patch_cycle: patchCycle,
  };
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "goal.yaml"), stringify(goal), "utf8");
  await writeFile(
    join(directory, "state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
  return { goal, state };
}

function missionIdentity(
  workItemId = firstId,
  overrides: Partial<
    Omit<MissionIdentity<"execute">, "phase" | "work_item_id">
  > = {},
): MissionIdentity<"execute"> {
  return {
    phase: "execute",
    work_item_id: workItemId,
    goal_version: overrides.goal_version ?? 1,
    input_revision: overrides.input_revision ?? 1,
    attempt: overrides.attempt ?? 0,
  };
}

async function writeRejectedEvidence(
  workspace: ProductWorkspace,
  identity: MissionIdentity<"execute">,
  submissionSource: string,
  completedAt: string,
): Promise<ImportEvidenceEnvelope> {
  const missionContentSha256 = "b".repeat(64);
  const resultContentSha256 = hashResultContent(submissionSource);
  const evidence: ImportEvidenceEnvelope = {
    schema_version: 2,
    phase: identity.phase,
    import_run_id: createImportRunId(
      missionContentSha256,
      resultContentSha256,
    ),
    result_content_sha256: resultContentSha256,
    mission_content_sha256: missionContentSha256,
    identity,
    git_base_commit: "a".repeat(40),
    result_commit: null,
    controller_run_id: thirdRunId,
    started_at: "2026-07-22T12:00:00.000Z",
    completed_at: completedAt,
    outcome: "rejected",
    reasons: ["The result did not satisfy its governed contract."],
  };
  await workspace.writeImportEvidence({
    submission_source: submissionSource,
    evidence,
    verification: [],
  });
  return evidence;
}

function appliedExecuteManifest(
  runId = firstRunId,
  overrides: Partial<ControllerRunManifest> = {},
): ControllerRunManifest {
  return {
    schema_version: 1,
    run_id: runId,
    work_item_id: firstId,
    idempotency_key: `${firstId}:execute:1:1:0:${runId}`,
    phase: "execute",
    goal_version: 1,
    input_revision: 1,
    attempt: 0,
    started_at: "2026-07-22T12:00:00.000Z",
    completed_at: "2026-07-22T12:00:01.000Z",
    outcome: "applied",
    ...overrides,
  };
}

async function writeRunManifest(
  root: string,
  manifest: ControllerRunManifest,
): Promise<void> {
  const runsDirectory = join(
    root,
    ".founder",
    "work-items",
    manifest.work_item_id,
    "runs",
  );
  await mkdir(runsDirectory, { recursive: true });
  await writeFile(
    join(runsDirectory, `${manifest.run_id}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

function activeRun(
  runId = firstRunId,
  idempotencyKey = `${firstId}:spec:1:1:0`,
): ActiveRun {
  return {
    run_id: runId,
    idempotency_key: idempotencyKey,
    acquired_at: "2026-07-21T20:01:00.000Z",
  };
}

function controllerMutation(
  current: WorkItem,
  run: ActiveRun,
  overrides: {
    goalVersion?: number;
    inputRevision?: number;
    phase?: "idea" | "spec";
  } = {},
): ControllerMutationInput {
  const goalVersion = overrides.goalVersion ?? 1;
  const inputRevision = overrides.inputRevision ?? 1;
  const phase = overrides.phase ?? "spec";

  return {
    goal: {
      ...current.goal,
      goal_contract: {
        schema_version: 1,
        goal_version: goalVersion,
        purpose: "Keep controller mutations safe.",
        acceptance_criteria: ["Reject stale state"],
        non_goals: ["Do not bypass controller checks."],
        allowed_scope: ["src/domain"],
        review_ready: ["Checks pass"],
      },
    },
    state: {
      ...current.state,
      phase,
      updated_at: "2026-07-21T20:02:00.000Z",
      goal_version: goalVersion,
      input_revision: inputRevision,
      attempt: 0,
      patch_cycle: 0,
    },
    manifest: {
      schema_version: 1,
      run_id: run.run_id,
      work_item_id: current.goal.work_item_id,
      idempotency_key: run.idempotency_key,
      phase,
      goal_version: goalVersion,
      input_revision: inputRevision,
      attempt: 0,
      started_at: "2026-07-21T20:01:00.000Z",
      outcome: "pending",
    },
  };
}

class FailingControllerWorkspace extends ProductWorkspace {
  protected override async afterControllerGoalReplaced(): Promise<void> {
    throw new Error("injected controller state write failure");
  }
}

afterEach(async () => {
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ProductWorkspace", () => {
  it("creates, reads, and lists a durable work item", async () => {
    const root = await createWorkspace();
    const workspace = missionWorkspace(root);

    const created = await workspace.create({
      title: "Prove durable files",
      type: "MVP",
    });

    const itemDirectory = join(
      root,
      ".founder",
      "work-items",
      created.goal.work_item_id,
    );
    expect((await readdir(itemDirectory)).sort()).toEqual([
      "goal.yaml",
      "state.json",
    ]);
    expect(parse(await readFile(join(itemDirectory, "goal.yaml"), "utf8"))).toEqual(
      created.goal,
    );
    expect(
      JSON.parse(await readFile(join(itemDirectory, "state.json"), "utf8")),
    ).toEqual(created.state);
    expect(created.state).toMatchObject({ phase: "idea", status: "active" });
    expect(await workspace.read(created.goal.work_item_id)).toEqual(created);
    expect(await workspace.list()).toEqual([created]);
    expect(await workspace.read(secondId)).toBeNull();
  });

  it("creates an untyped capture with immutable provenance", async () => {
    const root = await createWorkspace();
    const workspace = new ProductWorkspace(root);

    const created = await workspace.createCapture({
      title: "Capture this exact sentence",
      capture_kind: "todo",
      priority: "high",
      tags: ["Question"],
      notes: "Keep the context durable.",
    });

    expect(created.goal).toMatchObject({
      schema_version: 2,
      title: "Capture this exact sentence",
      capture: {
        kind: "todo",
        original_title: "Capture this exact sentence",
      },
      priority: "high",
      tags: ["Question"],
      notes: "Keep the context durable.",
    });
    expect(created.goal).not.toHaveProperty("type");
    expect(created.goal.capture?.captured_at).toMatch(/Z$/);
    expect(created.state).toMatchObject({ phase: "idea", status: "active" });
    expect(await workspace.read(created.goal.work_item_id)).toEqual(created);
  });

  it("upgrades a v1 governed state on read without rewriting its durable bytes", async () => {
    const root = await createWorkspace();
    await writeContractedWorkItem(root, firstId);
    const workspace = new ProductWorkspace(root);
    const statePath = join(
      root,
      ".founder",
      "work-items",
      firstId,
      "state.json",
    );
    const originalStateSource = await readFile(statePath, "utf8");

    const item = await workspace.read(firstId);

    expect(item?.state).toMatchObject({
      schema_version: 2,
      patch_cycle: 0,
    });
    expect(await readFile(statePath, "utf8")).toBe(originalStateSource);
  });

  it("orders newest items first and uses work_item_id as the tie-breaker", async () => {
    const root = await createWorkspace();
    await writeWorkItem(root, secondId, "2026-07-17T12:00:00.000Z");
    await writeWorkItem(root, firstId, "2026-07-17T12:00:00.000Z");
    const newestId = "wi_ffffffff-ffff-4fff-afff-ffffffffffff";
    await writeWorkItem(root, newestId, "2026-07-17T12:00:01.000Z");

    const items = await new ProductWorkspace(root).list();

    expect(items.map(({ goal }) => goal.work_item_id)).toEqual([
      newestId,
      firstId,
      secondId,
    ]);
  });

  it("atomically updates only the validated state phase", async () => {
    const root = await createWorkspace();
    await writeWorkItem(root, firstId, "2026-07-17T12:00:00.000Z");
    const workspace = new ProductWorkspace(root);
    const itemDirectory = join(root, ".founder", "work-items", firstId);
    const goalPath = join(itemDirectory, "goal.yaml");
    const statePath = join(itemDirectory, "state.json");
    const goalBefore = await readFile(goalPath, "utf8");

    const updated = await workspace.updatePhase(firstId, {
      target_phase: "spec",
    });

    expect(updated).not.toBeNull();
    if (updated === null) {
      throw new Error("Expected the existing item to be updated");
    }
    expect(updated.state).toMatchObject({ phase: "spec", status: "active" });
    expect(Date.parse(updated.state.updated_at)).toBeGreaterThan(
      Date.parse("2026-07-17T12:00:00.000Z"),
    );
    expect(await workspace.read(firstId)).toEqual(updated);
    expect(await readFile(goalPath, "utf8")).toBe(goalBefore);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual(updated.state);
    expect((await readdir(itemDirectory)).sort()).toEqual([
      "goal.yaml",
      "state.json",
    ]);
  });

  it("atomically updates only goal metadata and preserves capture provenance", async () => {
    const root = await createWorkspace();
    const workspace = new ProductWorkspace(root);
    const created = await workspace.createCapture({
      title: "Original capture",
      capture_kind: "idea",
      priority: "normal",
      tags: ["Idea"],
      notes: "Original notes",
    });
    const itemDirectory = join(
      root,
      ".founder",
      "work-items",
      created.goal.work_item_id,
    );
    const statePath = join(itemDirectory, "state.json");
    const stateBefore = await readFile(statePath, "utf8");

    const updated = await workspace.updateGoal(created.goal.work_item_id, {
      ...created.goal,
      title: "Refined capture",
      type: "Feature",
      priority: "high",
      tags: ["Front-end"],
      notes: "Refined notes",
    });

    expect(updated?.goal).toMatchObject({
      title: "Refined capture",
      type: "Feature",
      priority: "high",
      tags: ["Front-end"],
      notes: "Refined notes",
      capture: created.goal.capture,
    });
    expect(await readFile(statePath, "utf8")).toBe(stateBefore);
    expect((await readdir(itemDirectory)).sort()).toEqual([
      "goal.yaml",
      "state.json",
    ]);

    const cleared = await workspace.updateGoal(created.goal.work_item_id, {
      schema_version: 2,
      work_item_id: created.goal.work_item_id,
      title: "Refined capture",
      capture: created.goal.capture,
    });
    expect(cleared?.goal).toEqual({
      schema_version: 2,
      work_item_id: created.goal.work_item_id,
      title: "Refined capture",
      capture: created.goal.capture,
    });

    await expect(
      workspace.updateGoal(created.goal.work_item_id, {
        ...cleared!.goal,
        capture: {
          ...created.goal.capture!,
          original_title: "Rewritten provenance",
        },
      }),
    ).rejects.toMatchObject({
      kind: "invalid_workspace",
      reason: "capture provenance must not change",
    });
    await expect(
      workspace.updateGoal(created.goal.work_item_id, {
        ...cleared!.goal,
        work_item_id: secondId,
      }),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
    expect((await workspace.read(created.goal.work_item_id))?.goal).toEqual(
      cleared?.goal,
    );
  });

  it("stages, publishes, and removes a work item without exposing partial state", async () => {
    const sourceRoot = await createWorkspace();
    const targetRoot = await createWorkspace();
    const source = new ProductWorkspace(sourceRoot);
    const target = new ProductWorkspace(targetRoot);
    const item = await source.createCapture({
      title: "Move this capture",
      capture_kind: "idea",
      tags: ["Portable"],
    });

    const stagingPath = await target.stageIncomingWorkItem(item);
    expect(await target.list()).toEqual([]);
    expect(await target.hasWorkItem(item.goal.work_item_id)).toBe(false);

    await target.publishStagedWorkItem(item.goal.work_item_id, stagingPath);
    expect(await target.read(item.goal.work_item_id)).toEqual(item);
    expect(await source.read(item.goal.work_item_id)).toEqual(item);

    await source.removeWorkItem(item.goal.work_item_id);
    expect(await source.read(item.goal.work_item_id)).toBeNull();
    expect(await target.read(item.goal.work_item_id)).toEqual(item);
    await source.removeWorkItem(item.goal.work_item_id);
  });

  it("rejects a concurrent controller lease and releases durable active state", async () => {
    const root = await createWorkspace();
    await writeContractedWorkItem(root, firstId);
    const workspace = new ProductWorkspace(root);
    const firstLease = await workspace.acquireControllerLease(
      firstId,
      activeRun(),
    );

    expect(firstLease).not.toBeNull();
    expect((await workspace.read(firstId))?.state.active_run).toEqual(
      activeRun(),
    );
    await expect(
      workspace.acquireControllerLease(
        firstId,
        activeRun(secondRunId, `${firstId}:plan:1:1:0`),
      ),
    ).rejects.toMatchObject({ kind: "repair_required", workItemId: firstId });

    await workspace.releaseControllerLease(firstLease!);
    expect((await workspace.read(firstId))?.state).not.toHaveProperty(
      "active_run",
    );
    expect(
      await readdir(join(root, ".founder", "work-items", firstId)),
    ).not.toContain(".controller.lock");
  });

  it("persists an applied manifest and returns it on idempotent replay", async () => {
    const root = await createWorkspace();
    await writeWorkItem(root, firstId, "2026-07-21T20:00:00.000Z");
    const workspace = new ProductWorkspace(root);
    const run = activeRun();
    const firstLease = await workspace.acquireControllerLease(firstId, run);
    if (firstLease === null) {
      throw new Error("Expected first controller lease");
    }
    const mutation = controllerMutation(firstLease.work_item, run);

    const firstResult = await workspace.commitControllerMutation(
      firstLease,
      mutation,
    );
    await workspace.releaseControllerLease(firstLease);

    expect(firstResult.manifest).toMatchObject({ outcome: "applied" });
    expect(firstResult.manifest.completed_at).toMatch(/Z$/);
    expect(await workspace.readControllerRunManifest(firstId, run.run_id)).toEqual(
      firstResult.manifest,
    );
    expect(await workspace.read(firstId)).toEqual(firstResult.work_item);

    const replayLease = await workspace.acquireControllerLease(firstId, run);
    if (replayLease === null) {
      throw new Error("Expected replay controller lease");
    }
    const replay = await workspace.commitControllerMutation(
      replayLease,
      mutation,
    );
    await workspace.releaseControllerLease(replayLease);

    expect(replay).toEqual(firstResult);
    expect(await workspace.read(firstId)).toEqual(firstResult.work_item);
    expect(
      await readdir(
        join(root, ".founder", "work-items", firstId, "runs"),
      ),
    ).toEqual([`${run.run_id}.json`]);
  });

  it("selects the one applied execute manifest matching durable controller state", async () => {
    const root = await createWorkspace();
    const item = await writeMissionReadyWorkItem(root, firstId);
    const selected = appliedExecuteManifest();
    await writeRunManifest(root, selected);
    await writeRunManifest(
      root,
      appliedExecuteManifest(secondRunId, { outcome: "failed" }),
    );
    await writeRunManifest(
      root,
      appliedExecuteManifest(thirdRunId, {
        input_revision: 2,
        idempotency_key: `${firstId}:execute:1:2:0`,
      }),
    );

    const result = await new ProductWorkspace(root).findAppliedExecuteManifest(
      missionIdentity(),
    );

    expect(result).toEqual(selected);
    expect({
      goal_version: item.state.goal_version,
      input_revision: item.state.input_revision,
      attempt: item.state.attempt,
    }).toEqual({
      goal_version: result?.goal_version,
      input_revision: result?.input_revision,
      attempt: result?.attempt,
    });
  });

  it("distinguishes missing and duplicate applied execute manifests", async () => {
    const missingRoot = await createWorkspace();
    await writeMissionReadyWorkItem(missingRoot, firstId);
    const missingWorkspace = new ProductWorkspace(missingRoot);
    expect(
      await missingWorkspace.findAppliedExecuteManifest(missionIdentity()),
    ).toBeNull();

    const duplicateRoot = await createWorkspace();
    await writeMissionReadyWorkItem(duplicateRoot, firstId);
    await writeRunManifest(duplicateRoot, appliedExecuteManifest());
    await writeRunManifest(
      duplicateRoot,
      appliedExecuteManifest(secondRunId),
    );
    await expect(
      new ProductWorkspace(duplicateRoot).findAppliedExecuteManifest(
        missionIdentity(),
      ),
    ).rejects.toMatchObject({
      kind: "mission_not_ready",
      workItemId: firstId,
    });
  });

  it("validates every run manifest candidate and rejects unsafe entries", async () => {
    const malformedRoot = await createWorkspace();
    await writeMissionReadyWorkItem(malformedRoot, firstId);
    const malformedRunsDirectory = join(
      malformedRoot,
      ".founder",
      "work-items",
      firstId,
      "runs",
    );
    await mkdir(malformedRunsDirectory, { recursive: true });
    await writeFile(
      join(malformedRunsDirectory, `${firstRunId}.json`),
      "{invalid",
      "utf8",
    );
    await expect(
      new ProductWorkspace(malformedRoot).findAppliedExecuteManifest(
        missionIdentity(),
      ),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });

    const symlinkRoot = await createWorkspace();
    const outsideRoot = await createWorkspace();
    await writeMissionReadyWorkItem(symlinkRoot, firstId);
    const symlinkRunsDirectory = join(
      symlinkRoot,
      ".founder",
      "work-items",
      firstId,
      "runs",
    );
    await mkdir(symlinkRunsDirectory, { recursive: true });
    const outsideManifestPath = join(outsideRoot, "manifest.json");
    await writeFile(
      outsideManifestPath,
      `${JSON.stringify(appliedExecuteManifest(), null, 2)}\n`,
      "utf8",
    );
    await symlink(
      outsideManifestPath,
      join(symlinkRunsDirectory, `${firstRunId}.json`),
      "file",
    );
    await expect(
      new ProductWorkspace(symlinkRoot).findAppliedExecuteManifest(
        missionIdentity(),
      ),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
  });

  it("publishes an immutable mission snapshot and replays identical bytes", async () => {
    const root = await createWorkspace();
    const item = await writeMissionReadyWorkItem(root, firstId);
    const manifest = appliedExecuteManifest();
    const workspace = missionWorkspace(root);
    const buildPackage = (paths: Parameters<typeof compileMission>[2]) =>
      compileMission(item, manifest, paths);

    const first = await workspace.writeMissionPackage(
      missionIdentity(),
      buildPackage,
    );
    const missionSource = await readFile(first.mission_path, "utf8");
    const taskSource = await readFile(first.task_path, "utf8");
    const second = await workspace.writeMissionPackage(
      missionIdentity(),
      buildPackage,
    );

    expect(second).toEqual(first);
    expect(first.workspace_path).toBe(root);
    expect(first.mission.task_path).toBe(
      `.founder/missions/${firstId}/execute-1-1-0/TASK.md`,
    );
    expect(first.mission.result_contract.output_path).toBe(
      `.founder/missions/${firstId}/execute-1-1-0/result.json`,
    );
    expect(missionSource).toBe(serializeMissionPackage(first.mission));
    expect(taskSource).toBe(renderTaskMd(first.mission));
    expect(await readFile(second.mission_path, "utf8")).toBe(missionSource);
    expect(await readFile(second.task_path, "utf8")).toBe(taskSource);
    expect(
      await readdir(join(root, ".founder", "missions", firstId)),
    ).toEqual(["execute-1-1-0"]);
    expect(
      (
        await readdir(
          join(root, ".founder", "missions", firstId, "execute-1-1-0"),
        )
      ).sort(),
    ).toEqual(["TASK.md", "mission.json"]);
  });

  it("publishes, imports, accepts, and selects immutable shaping artifacts without Git", async () => {
    const root = await createWorkspace();
    const item = await writeShapingReadyWorkItem(root, firstId);
    let gitHeadReads = 0;
    const workspace = new ProductWorkspace(root, {
      git: {
        ...testGit,
        async readHeadCommit() {
          gitHeadReads += 1;
          throw new Error("Git HEAD is unavailable");
        },
      },
    });
    const brainstormInput = {
      phase: "brainstorm" as const,
      title: item.goal.title,
      notes: item.goal.notes,
    };
    const brainstormIdentity: ShapingIdentity<"brainstorm"> = {
      phase: "brainstorm",
      work_item_id: firstId,
      input_sha256: hashShapingInput(brainstormInput),
    };
    const buildBrainstorm = (paths: Parameters<typeof compileBrainstormMission>[0]["paths"]) =>
      compileBrainstormMission({
        work_item_id: firstId,
        shaping_input: brainstormInput,
        paths,
      });

    const first = await workspace.writeShapingMissionPackage(
      brainstormIdentity,
      buildBrainstorm,
    );
    const missionSource = await readFile(first.mission_path, "utf8");
    const taskSource = await readFile(first.task_path, "utf8");
    const replay = await workspace.writeShapingMissionPackage(
      brainstormIdentity,
      buildBrainstorm,
    );
    expect(replay).toEqual(first);
    expect(await readFile(replay.mission_path, "utf8")).toBe(missionSource);
    expect(await readFile(replay.task_path, "utf8")).toBe(taskSource);

    const brainstormResult: BrainstormResultSubmission = {
      result_schema_version: 1,
      brainstorm_mission_content_sha256: first.mission.content_sha256,
      identity: brainstormIdentity,
      problem_statement: "Shaping lacks a durable artifact loop.",
      approach: "Publish a content-addressed shaping snapshot.",
      non_goals: ["Do not widen Execute missions."],
      open_questions: ["How should Plan shaping work later?"],
    };
    const resultSource = `${JSON.stringify(brainstormResult, null, 2)}\n`;
    await writeFile(
      join(dirname(first.task_path), "result.json"),
      resultSource,
      "utf8",
    );
    const importReceipt = {
      shaping_schema_version: 1 as const,
      identity: brainstormIdentity,
      shaping_mission_content_sha256: first.mission.content_sha256,
      result_content_sha256: hashSource(resultSource),
      outcome: "applied" as const,
      imported_at: "2026-07-29T00:01:00.000Z",
      reasons: [],
    };
    const imported = await workspace.writeShapingImportReceipt({
      result_source: resultSource,
      receipt: importReceipt,
    });
    expect(
      await workspace.writeShapingImportReceipt({
        result_source: resultSource,
        receipt: importReceipt,
      }),
    ).toEqual(imported);

    const acceptance: ShapingAcceptanceReceipt = {
      shaping_schema_version: 1,
      identity: brainstormIdentity,
      brainstorm_mission_content_sha256: first.mission.content_sha256,
      brainstorm_result_content_sha256: hashSource(resultSource),
      accepted_at: "2026-07-29T00:02:00.000Z",
    };
    const accepted = await workspace.writeShapingAcceptance(acceptance);

    const specItem = {
      ...item,
      state: {
        ...item.state,
        phase: "spec" as const,
        updated_at: "2026-07-29T00:03:00.000Z",
      },
    };
    await writeFile(
      join(root, ".founder", "work-items", firstId, "state.json"),
      `${JSON.stringify(specItem.state, null, 2)}\n`,
      "utf8",
    );
    const specInput = {
      phase: "spec" as const,
      title: specItem.goal.title,
      notes: specItem.goal.notes,
      brainstorm_acceptance_sha256: accepted.receipt_content_sha256,
      brainstorm_acceptance: acceptance,
      brainstorm_result: brainstormResult,
    };
    const specIdentity: ShapingIdentity<"spec"> = {
      phase: "spec",
      work_item_id: firstId,
      input_sha256: hashShapingInput(specInput),
    };
    const spec = await workspace.writeShapingMissionPackage(
      specIdentity,
      (paths) =>
        compileSpecMission({
          work_item_id: firstId,
          shaping_input: specInput,
          paths,
        }),
    );

    expect(spec.mission.input).toMatchObject({
      brainstorm_acceptance_sha256: accepted.receipt_content_sha256,
    });
    expect(await workspace.listShapingArtifacts(firstId)).toHaveLength(2);
    expect(await workspace.readShapingMissionPackage(specIdentity)).toEqual({
      mission: spec.mission,
      mission_path: spec.mission_path.slice(root.length + 1),
    });
    expect(gitHeadReads).toBe(0);
  });

  it("fails closed on stale, divergent, unsafe, and symlinked shaping state", async () => {
    const staleRoot = await createWorkspace();
    const staleItem = await writeShapingReadyWorkItem(staleRoot, firstId);
    const staleInput = {
      phase: "brainstorm" as const,
      title: staleItem.goal.title,
      notes: staleItem.goal.notes,
    };
    const staleIdentity: ShapingIdentity<"brainstorm"> = {
      phase: "brainstorm",
      work_item_id: firstId,
      input_sha256: hashShapingInput(staleInput),
    };
    await writeFile(
      join(staleRoot, ".founder", "work-items", firstId, "goal.yaml"),
      stringify({ ...staleItem.goal, title: "Changed after compile" }),
      "utf8",
    );
    await expect(
      new ProductWorkspace(staleRoot).writeShapingMissionPackage(
        staleIdentity,
        (paths) =>
          compileBrainstormMission({
            work_item_id: firstId,
            shaping_input: staleInput,
            paths,
          }),
      ),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });
    await expect(
      new ProductWorkspace(staleRoot).writeShapingMissionPackage(
        { ...staleIdentity, work_item_id: "../escape" },
        () => {
          throw new Error("builder must not run");
        },
      ),
    ).rejects.toBeInstanceOf(Error);

    const divergentRoot = await createWorkspace();
    const divergentItem = await writeShapingReadyWorkItem(divergentRoot, firstId);
    const divergentInput = {
      phase: "brainstorm" as const,
      title: divergentItem.goal.title,
      notes: divergentItem.goal.notes,
    };
    const divergentIdentity: ShapingIdentity<"brainstorm"> = {
      phase: "brainstorm",
      work_item_id: firstId,
      input_sha256: hashShapingInput(divergentInput),
    };
    const divergentWorkspace = new ProductWorkspace(divergentRoot);
    const artifact = await divergentWorkspace.writeShapingMissionPackage(
      divergentIdentity,
      (paths) =>
        compileBrainstormMission({
          work_item_id: firstId,
          shaping_input: divergentInput,
          paths,
        }),
    );
    const result: BrainstormResultSubmission = {
      result_schema_version: 1,
      brainstorm_mission_content_sha256: artifact.mission.content_sha256,
      identity: divergentIdentity,
      problem_statement: "A problem.",
      approach: "An approach.",
      non_goals: ["A non-goal."],
      open_questions: ["A question?"],
    };
    const resultSource = `${JSON.stringify(result, null, 2)}\n`;
    await writeFile(
      join(dirname(artifact.task_path), "result.json"),
      resultSource,
      "utf8",
    );
    const receipt = {
      shaping_schema_version: 1 as const,
      identity: divergentIdentity,
      shaping_mission_content_sha256: artifact.mission.content_sha256,
      result_content_sha256: hashSource(resultSource),
      outcome: "applied" as const,
      imported_at: "2026-07-29T00:01:00.000Z",
      reasons: [],
    };
    await divergentWorkspace.writeShapingImportReceipt({
      result_source: resultSource,
      receipt,
    });
    await writeFile(
      join(dirname(artifact.task_path), "result.json"),
      `${resultSource} `,
      "utf8",
    );
    await expect(
      divergentWorkspace.readShapingResult(divergentIdentity),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
    await expect(
      divergentWorkspace.writeShapingImportReceipt({
        result_source: resultSource,
        receipt,
      }),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
    await writeFile(
      join(dirname(artifact.task_path), "result.json"),
      resultSource,
      "utf8",
    );
    await writeFile(
      join(dirname(artifact.task_path), "import.json"),
      `${JSON.stringify({ ...receipt, imported_at: "2026-07-29T00:02:00.000Z" }, null, 2)}\n`,
      "utf8",
    );
    await expect(
      divergentWorkspace.writeShapingImportReceipt({
        result_source: resultSource,
        receipt,
      }),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
    await writeFile(artifact.mission_path, "{}\n", "utf8");
    await expect(
      divergentWorkspace.writeShapingMissionPackage(
        divergentIdentity,
        (paths) =>
          compileBrainstormMission({
            work_item_id: firstId,
            shaping_input: divergentInput,
            paths,
          }),
      ),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });

    const symlinkRoot = await createWorkspace();
    const outsideRoot = await createWorkspace();
    const symlinkItem = await writeShapingReadyWorkItem(symlinkRoot, firstId);
    await symlink(
      outsideRoot,
      join(symlinkRoot, ".founder", "shaping"),
      "dir",
    );
    const symlinkInput = {
      phase: "brainstorm" as const,
      title: symlinkItem.goal.title,
      notes: symlinkItem.goal.notes,
    };
    const symlinkIdentity: ShapingIdentity<"brainstorm"> = {
      phase: "brainstorm",
      work_item_id: firstId,
      input_sha256: hashShapingInput(symlinkInput),
    };
    await expect(
      new ProductWorkspace(symlinkRoot).writeShapingMissionPackage(
        symlinkIdentity,
        (paths) =>
          compileBrainstormMission({
            work_item_id: firstId,
            shaping_input: symlinkInput,
            paths,
          }),
      ),
    ).rejects.toMatchObject({
      kind: "invalid_workspace",
      artifactPath: ".founder/shaping",
    });
    expect(await readdir(outsideRoot)).toEqual([".founder"]);
  });

  it("reads the mission result and publishes immutable regular-file evidence", async () => {
    const root = await createWorkspace();
    const item = await writeMissionReadyWorkItem(root, firstId);
    const manifest = appliedExecuteManifest();
    const workspace = missionWorkspace(root);
    const artifact = await workspace.writeMissionPackage(
      missionIdentity(),
      (paths) => compileMission(item, manifest, paths),
    );
    const resultPath = join(dirname(artifact.task_path), "result.json");
    const submissionSource = "{invalid";
    await writeFile(resultPath, submissionSource, "utf8");

    const snapshot = await workspace.readMissionResult(missionIdentity());
    expect(snapshot.mission).toEqual(artifact.mission);
    expect(snapshot.result_source).toBe(submissionSource);
    expect(snapshot.result_path).toBe(
      `.founder/missions/${firstId}/execute-1-1-0/result.json`,
    );

    const resultContentSha256 = hashResultContent(submissionSource);
    const importRunId = createImportRunId(
      artifact.mission.content_sha256,
      resultContentSha256,
    );
    const evidence = {
      schema_version: 2 as const,
      phase: "execute" as const,
      import_run_id: importRunId,
      result_content_sha256: resultContentSha256,
      mission_content_sha256: artifact.mission.content_sha256,
      identity: missionIdentity(),
      git_base_commit: artifact.mission.source_revision.git_base_commit,
      result_commit: null,
      controller_run_id: thirdRunId,
      started_at: "2026-07-22T12:00:00.000Z",
      completed_at: "2026-07-22T12:00:01.000Z",
      outcome: "rejected" as const,
      reasons: ["result.json is not valid JSON."],
    };
    const first = await workspace.writeImportEvidence({
      submission_source: submissionSource,
      evidence,
      verification: [],
    });
    const second = await workspace.writeImportEvidence({
      submission_source: submissionSource,
      evidence,
      verification: [],
    });
    expect(second).toEqual(first);
    expect(await workspace.readImportEvidence(missionIdentity(), importRunId))
      .toMatchObject({ evidence, summary: first, verification: [] });

    const evidenceDirectory = join(root, first.evidence_path);
    expect((await readdir(evidenceDirectory)).sort()).toEqual([
      "import.json",
      "submission.json",
      "verification.json",
    ]);
    await expect(
      workspace.writeImportEvidence({
        submission_source: submissionSource,
        evidence: { ...evidence, reasons: ["Divergent reason"] },
        verification: [],
      }),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
    expect(
      JSON.parse(await readFile(join(evidenceDirectory, "import.json"), "utf8")),
    ).toEqual(evidence);

    const outside = join(root, "outside-verification.json");
    await writeFile(outside, "[]\n", "utf8");
    await rm(join(evidenceDirectory, "verification.json"));
    await symlink(outside, join(evidenceDirectory, "verification.json"), "file");
    await expect(
      workspace.readImportEvidence(missionIdentity(), importRunId),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
  });

  it("reads historical v3 execute/review artifacts without rewriting their bytes", async () => {
    const root = await createWorkspace();
    const executeItem = await writeMissionReadyWorkItem(root, firstId);
    const workspace = missionWorkspace(root);
    const commandEvidence = [
      {
        name: "Tests",
        argv: ["npm", "test"] as [string, ...string[]],
        started_at: "2026-07-20T12:00:00.000Z",
        completed_at: "2026-07-20T12:00:01.000Z",
        duration_ms: 1_000,
        status: "passed" as const,
        exit_code: 0 as const,
        signal: null,
        stdout: "green",
        stderr: "",
        output_truncated: false,
      },
    ];
    const historicalExecuteDraft: HistoricalExecuteMissionPackageV3 = {
      mission_schema_version: 3,
      identity: missionIdentity(),
      controller_run: {
        run_id: firstRunId,
        idempotency_key: `${firstId}:execute:1:1:0:historical`,
        phase: "execute",
        started_at: "2026-07-20T12:00:00.000Z",
        completed_at: "2026-07-20T12:00:01.000Z",
      },
      goal: {
        title: executeItem.goal.title,
        type: executeItem.goal.type,
        purpose: executeItem.goal.goal_contract!.purpose,
        acceptance_criteria:
          executeItem.goal.goal_contract!.acceptance_criteria,
        non_goals: executeItem.goal.goal_contract!.non_goals,
        allowed_scope: executeItem.goal.goal_contract!.allowed_scope,
        review_ready: executeItem.goal.goal_contract!.review_ready,
      },
      source_revision: { git_base_commit: "a".repeat(40) },
      result_contract: {
        schema_version: 3,
        output_path: `.founder/missions/${firstId}/execute-1-1-0/result.json`,
        result_schema_version: 2,
        required_fields: [
          "result_schema_version",
          "mission_content_sha256",
          "identity",
          "commit",
          "summary",
          "changed_files",
          "verification",
        ],
      },
      task_path: `.founder/missions/${firstId}/execute-1-1-0/TASK.md`,
      content_sha256: "0".repeat(64),
    };
    const historicalExecute = {
      ...historicalExecuteDraft,
      content_sha256: hashHistoricalMissionContentV3(
        historicalExecuteDraft,
      ),
    };
    const historicalReviewDraft: HistoricalReviewMissionPackageV3 = {
      mission_schema_version: 3,
      identity: { ...missionIdentity(), phase: "review" },
      controller_run: {
        run_id: secondRunId,
        idempotency_key: `${firstId}:review:1:1:0:historical`,
        phase: "review",
        started_at: "2026-07-20T12:00:01.000Z",
        completed_at: "2026-07-20T12:00:02.000Z",
      },
      goal: historicalExecute.goal,
      source_revision: historicalExecute.source_revision,
      review_subject: {
        execute_mission_content_sha256:
          historicalExecute.content_sha256,
        execute_result_content_sha256: "7".repeat(64),
        git_base_commit: "a".repeat(40),
        accepted_result_commit: "a".repeat(40),
        changed_files: ["src/domain/result.ts"],
        execute_mission_path: `.founder/missions/${firstId}/execute-1-1-0/mission.json`,
        execute_evidence_path: `.founder/run-evidence/${firstId}/execute-1-1-0/${"8".repeat(64)}`,
        command_evidence: commandEvidence,
      },
      independence_attested: true,
      result_contract: {
        schema_version: 3,
        output_path: `.founder/missions/${firstId}/review-1-1-0/result.json`,
        result_schema_version: 2,
        required_fields: [
          "result_schema_version",
          "review_mission_content_sha256",
          "identity",
          "execute_mission_content_sha256",
          "execute_result_content_sha256",
          "git_base_commit",
          "accepted_result_commit",
          "summary",
          "verdict",
          "findings",
        ],
      },
      task_path: `.founder/missions/${firstId}/review-1-1-0/TASK.md`,
      content_sha256: "0".repeat(64),
    };
    const historicalReview = {
      ...historicalReviewDraft,
      content_sha256: hashHistoricalMissionContentV3(
        historicalReviewDraft,
      ),
    };
    const historicalSources = new Map<string, string>();
    for (const mission of [historicalExecute, historicalReview]) {
      const directory = join(root, dirname(mission.task_path));
      await mkdir(directory, { recursive: true });
      const missionSource = serializeReadableMissionPackage(mission);
      const taskSource = renderReadableTaskMd(mission);
      await writeFile(join(directory, "mission.json"), missionSource);
      await writeFile(join(directory, "TASK.md"), taskSource);
      await writeFile(join(directory, "result.json"), "{}\n");
      historicalSources.set(join(directory, "mission.json"), missionSource);
      historicalSources.set(join(directory, "TASK.md"), taskSource);
    }

    const evidenceSubmission = '{"historical":true}\n';
    const evidenceResultHash = hashResultContent(evidenceSubmission);
    const evidenceSummary = await workspace.writeImportEvidence({
      submission_source: evidenceSubmission,
      evidence: {
        schema_version: 2,
        phase: "execute",
        import_run_id: createImportRunId(
          historicalExecute.content_sha256,
          evidenceResultHash,
        ),
        result_content_sha256: evidenceResultHash,
        mission_content_sha256: historicalExecute.content_sha256,
        identity: missionIdentity(),
        git_base_commit: "a".repeat(40),
        result_commit: null,
        controller_run_id: thirdRunId,
        started_at: "2026-07-20T12:00:01.000Z",
        completed_at: "2026-07-20T12:00:02.000Z",
        outcome: "rejected",
        reasons: ["Historical rejection remains inspectable."],
      },
      verification: [],
    });
    const evidenceDirectory = join(root, evidenceSummary.evidence_path);
    for (const name of [
      "submission.json",
      "import.json",
      "verification.json",
    ]) {
      const path = join(evidenceDirectory, name);
      historicalSources.set(path, await readFile(path, "utf8"));
    }

    expect(
      (await workspace.readMissionResult(missionIdentity())).mission
        .mission_schema_version,
    ).toBe(3);
    expect(
      (
        await workspace.readMissionResult({
          ...missionIdentity(),
          phase: "review",
        })
      ).mission.mission_schema_version,
    ).toBe(3);
    expect(await workspace.listImportEvidence(firstId)).toHaveLength(1);
    await expect(
      workspace.writeMissionPackage(
        missionIdentity(),
        (paths) =>
          compileMission(executeItem, appliedExecuteManifest(), paths),
      ),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });

    for (const [path, source] of historicalSources) {
      expect(await readFile(path, "utf8")).toBe(source);
    }
  });

  it("builds one immutable execute subject and writes a phase-distinct review mission", async () => {
    const root = await createWorkspace();
    const executeItem = await writeMissionReadyWorkItem(root, firstId);
    const workspace = missionWorkspace(root);
    const executeArtifact = await workspace.writeMissionPackage(
      missionIdentity(),
      (paths) =>
        compileMission(executeItem, appliedExecuteManifest(), paths),
    );
    const submissionSource = serializeExternalResult({
      result_schema_version: 2,
      mission_content_sha256: executeArtifact.mission.content_sha256,
      identity: missionIdentity(),
      commit: "a".repeat(40),
      summary: "Implement the accepted execute result.",
      changed_files: ["src/domain/result.ts"],
      verification: [{ name: "Tests", status: "passed" }],
    });
    const resultContentSha256 = hashResultContent(submissionSource);
    const importRunId = createImportRunId(
      executeArtifact.mission.content_sha256,
      resultContentSha256,
    );
    const evidence = {
      schema_version: 2 as const,
      phase: "execute" as const,
      import_run_id: importRunId,
      result_content_sha256: resultContentSha256,
      mission_content_sha256: executeArtifact.mission.content_sha256,
      identity: missionIdentity(),
      git_base_commit:
        executeArtifact.mission.source_revision.git_base_commit,
      result_commit: "a".repeat(40),
      controller_run_id: thirdRunId,
      started_at: "2026-07-22T12:00:00.000Z",
      completed_at: "2026-07-22T12:00:01.000Z",
      outcome: "applied" as const,
      reasons: [],
    };
    const verification = [
      {
        name: "Tests",
        argv: ["npm", "test"] as [string, ...string[]],
        started_at: "2026-07-22T12:00:00.000Z",
        completed_at: "2026-07-22T12:00:01.000Z",
        duration_ms: 1_000,
        status: "passed" as const,
        exit_code: 0,
        signal: null,
        stdout: "green",
        stderr: "",
        output_truncated: false,
      },
    ];
    await workspace.writeImportEvidence({
      submission_source: submissionSource,
      evidence,
      verification,
    });
    await writeRunManifest(root, {
      schema_version: 1,
      run_id: thirdRunId,
      work_item_id: firstId,
      idempotency_key: `${firstId}:execute:1:1:0:import`,
      phase: "review",
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
      started_at: evidence.started_at,
      completed_at: evidence.completed_at,
      outcome: "applied",
    });
    await writeMissionReadyWorkItem(root, firstId, "review");

    const subject = await workspace.readAppliedExecuteReviewSubject(
      missionIdentity(),
    );
    expect(subject.submission_source).toBe(submissionSource);
    expect(subject.evidence).toEqual(evidence);
    expect(subject.review_subject).toMatchObject({
      execute_mission_content_sha256: executeArtifact.mission.content_sha256,
      execute_result_content_sha256: resultContentSha256,
      accepted_result_commit: "a".repeat(40),
      changed_files: ["src/domain/result.ts"],
      execute_mission_path: `.founder/missions/${firstId}/execute-1-1-0/mission.json`,
      execute_evidence_path: `.founder/run-evidence/${firstId}/execute-1-1-0/${importRunId}`,
    });

    const reviewItem = await workspace.read(firstId);
    if (reviewItem === null) {
      throw new Error("Expected review work item");
    }
    const reviewIdentity = {
      ...missionIdentity(),
      phase: "review" as const,
    };
    const reviewRun: ReviewMissionControllerRun = {
      schema_version: 1,
      run_id: thirdRunId,
      work_item_id: firstId,
      idempotency_key: `${firstId}:review:1:1:0`,
      phase: "review",
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
      started_at: evidence.started_at,
      completed_at: evidence.completed_at,
      outcome: "applied",
    };
    const buildReview = (paths: Parameters<typeof compileMission>[2]) =>
      compileReviewMission({
        work_item: reviewItem,
        controller_run: reviewRun,
        review_subject: subject.review_subject,
        paths,
        independence_attested: true,
      });
    const first = await workspace.writeReviewMissionPackage(
      reviewIdentity,
      subject.review_subject,
      buildReview,
    );
    const second = await workspace.writeReviewMissionPackage(
      reviewIdentity,
      subject.review_subject,
      buildReview,
    );

    expect(second).toEqual(first);
    expect(first.mission.identity.phase).toBe("review");
    expect(first.mission.review_subject).toEqual(subject.review_subject);
    expect(
      (await readdir(join(root, ".founder", "missions", firstId))).sort(),
    ).toEqual(["execute-1-1-0", "review-1-1-0"]);

    const reviewMissionSource = await readFile(first.mission_path, "utf8");
    const reviewTaskSource = await readFile(first.task_path, "utf8");
    await expect(
      workspace.writeReviewMissionPackage(
        reviewIdentity,
        subject.review_subject,
        (paths) =>
          compileReviewMission({
            work_item: reviewItem,
            controller_run: {
              ...reviewRun,
              run_id: secondRunId,
              idempotency_key: `${firstId}:review:1:1:0:divergent`,
            },
            review_subject: subject.review_subject,
            paths,
            independence_attested: true,
          }),
      ),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
    expect(await readFile(first.mission_path, "utf8")).toBe(
      reviewMissionSource,
    );
    expect(await readFile(first.task_path, "utf8")).toBe(reviewTaskSource);

    await writeFile(
      join(
        root,
        subject.review_subject.execute_evidence_path,
        "submission.json",
      ),
      `${submissionSource} `,
      "utf8",
    );
    await expect(
      workspace.readAppliedExecuteReviewSubject(missionIdentity()),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
  });

  it("fails closed when applied execute evidence is absent or duplicated", async () => {
    const root = await createWorkspace();
    await writeMissionReadyWorkItem(root, firstId, "review");
    const workspace = missionWorkspace(root);
    await expect(
      workspace.readAppliedExecuteReviewSubject(missionIdentity()),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });

    const executeItem = await writeMissionReadyWorkItem(
      root,
      firstId,
      "execute",
    );
    const artifact = await workspace.writeMissionPackage(
      missionIdentity(),
      (paths) =>
        compileMission(executeItem, appliedExecuteManifest(), paths),
    );
    await writeRunManifest(root, {
      ...appliedExecuteManifest(thirdRunId),
      phase: "review",
    });
    const verification = [
      {
        name: "Tests",
        argv: ["npm", "test"] as [string, ...string[]],
        started_at: "2026-07-22T12:00:00.000Z",
        completed_at: "2026-07-22T12:00:01.000Z",
        duration_ms: 1_000,
        status: "passed" as const,
        exit_code: 0,
        signal: null,
        stdout: "green",
        stderr: "",
        output_truncated: false,
      },
    ];
    for (const summary of ["First accepted result", "Second accepted result"]) {
      const submissionSource = serializeExternalResult({
        result_schema_version: 2,
        mission_content_sha256: artifact.mission.content_sha256,
        identity: missionIdentity(),
        commit: "a".repeat(40),
        summary,
        changed_files: ["src/domain/result.ts"],
        verification: [{ name: "Tests", status: "passed" }],
      });
      const resultHash = hashResultContent(submissionSource);
      await workspace.writeImportEvidence({
        submission_source: submissionSource,
        evidence: {
          schema_version: 2,
          phase: "execute",
          import_run_id: createImportRunId(
            artifact.mission.content_sha256,
            resultHash,
          ),
          result_content_sha256: resultHash,
          mission_content_sha256: artifact.mission.content_sha256,
          identity: missionIdentity(),
          git_base_commit: artifact.mission.source_revision.git_base_commit,
          result_commit: "a".repeat(40),
          controller_run_id: thirdRunId,
          started_at: "2026-07-22T12:00:00.000Z",
          completed_at: "2026-07-22T12:00:01.000Z",
          outcome: "applied",
          reasons: [],
        },
        verification,
      });
    }
    await expect(
      workspace.readAppliedExecuteReviewSubject(missionIdentity()),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });
  });

  it("publishes cycle-qualified patch artifacts and derives one applied patch review subject", async () => {
    const root = await createWorkspace();
    const patchItem = await writeMissionReadyWorkItem(
      root,
      firstId,
      "patch",
      1,
    );
    const workspace = missionWorkspace(root);
    const commandEvidence = [
      {
        name: "Tests",
        argv: ["npm", "test"] as [string, ...string[]],
        started_at: "2026-07-22T12:00:00.000Z",
        completed_at: "2026-07-22T12:00:01.000Z",
        duration_ms: 1_000,
        status: "passed" as const,
        exit_code: 0 as const,
        signal: null,
        stdout: "green",
        stderr: "",
        output_truncated: false,
      },
    ];
    const priorReviewSubject = {
      source: "execute" as const,
      execute_mission_content_sha256: "1".repeat(64),
      execute_result_content_sha256: "2".repeat(64),
      git_base_commit: "a".repeat(40),
      accepted_result_commit: "a".repeat(40),
      changed_files: ["src/domain/result.ts"],
      execute_mission_path: `.founder/missions/${firstId}/execute-1-1-0/mission.json`,
      execute_evidence_path: `.founder/run-evidence/${firstId}/execute-1-1-0/${"3".repeat(64)}`,
      command_evidence: commandEvidence,
    };
    const patchSubject: PatchSubject = {
      review_mission_content_sha256: "4".repeat(64),
      review_result_content_sha256: "5".repeat(64),
      review_mission_path: `.founder/missions/${firstId}/review-1-1-0/mission.json`,
      review_result_path: `.founder/missions/${firstId}/review-1-1-0/result.json`,
      review_evidence_path: `.founder/run-evidence/${firstId}/review-1-1-0/${"6".repeat(64)}`,
      reviewed_commit: "a".repeat(40),
      findings: [
        {
          finding_id: "F-1",
          severity: "P1",
          title: "Preserve immutable evidence",
          evidence: { summary: "The patch requires durable proof." },
          required_action: "Keep evidence immutable before state mutation.",
          link: {
            type: "defect",
            evidence_summary: "The controller owns durable mutation.",
          },
        },
      ],
      prior_review_subject: priorReviewSubject,
    };
    const patchIdentity = {
      phase: "patch" as const,
      work_item_id: firstId,
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
      patch_cycle: 1,
    };
    const patchArtifact = await workspace.writePatchMissionPackage(
      patchIdentity,
      patchSubject,
      (paths) =>
        compilePatchMission({
          work_item: patchItem,
          controller_run: {
            schema_version: 1,
            run_id: secondRunId,
            work_item_id: firstId,
            idempotency_key: `${firstId}:patch:1:1:0:1:mission`,
            phase: "patch",
            goal_version: 1,
            input_revision: 1,
            attempt: 0,
            started_at: "2026-07-22T12:00:00.000Z",
            completed_at: "2026-07-22T12:00:01.000Z",
            outcome: "applied",
          },
          patch_subject: patchSubject,
          paths,
        }),
    );
    expect(patchArtifact.mission_path).toContain("patch-1-1-0-1");

    const submissionSource = serializeExternalResult({
      result_schema_version: 2,
      patch_mission_content_sha256: patchArtifact.mission.content_sha256,
      identity: patchIdentity,
      commit: "a".repeat(40),
      summary: "Applied the bounded patch.",
      changed_files: ["src/domain/result.ts"],
      verification: [{ name: "Tests", status: "passed" }],
    });
    await writeFile(
      join(root, patchArtifact.mission.result_contract.output_path),
      submissionSource,
    );
    const resultContentSha256 = hashResultContent(submissionSource);
    const importRunId = createImportRunId(
      patchArtifact.mission.content_sha256,
      resultContentSha256,
    );
    const evidence = {
      schema_version: 2 as const,
      phase: "patch" as const,
      import_run_id: importRunId,
      result_content_sha256: resultContentSha256,
      mission_content_sha256: patchArtifact.mission.content_sha256,
      identity: patchIdentity,
      git_base_commit: "a".repeat(40),
      result_commit: "a".repeat(40),
      controller_run_id: thirdRunId,
      started_at: "2026-07-22T12:00:01.000Z",
      completed_at: "2026-07-22T12:00:02.000Z",
      outcome: "applied" as const,
      reasons: [],
    };
    const evidenceSummary = await workspace.writeImportEvidence({
      submission_source: submissionSource,
      evidence,
      verification: commandEvidence,
    });
    expect(evidenceSummary.evidence_path).toContain("patch-1-1-0-1");
    await writeRunManifest(root, {
      schema_version: 1,
      run_id: thirdRunId,
      work_item_id: firstId,
      idempotency_key: `${firstId}:patch:1:1:0:1:import`,
      phase: "review",
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
      started_at: evidence.started_at,
      completed_at: evidence.completed_at,
      outcome: "applied",
    });
    await writeMissionReadyWorkItem(root, firstId, "review", 1);

    const appliedSubject = await workspace.readAppliedPatchReviewSubject(
      patchIdentity,
    );
    expect(appliedSubject.review_subject).toMatchObject({
      source: "patch",
      patch_cycle: 1,
      patch_mission_path: `.founder/missions/${firstId}/patch-1-1-0-1/mission.json`,
      patch_evidence_path: evidenceSummary.evidence_path,
      resolved_from: { finding_ids: ["F-1"] },
    });
    expect(appliedSubject.submission_source).toBe(submissionSource);

    const reviewItem = await workspace.read(firstId);
    if (reviewItem === null) {
      throw new Error("Expected patch review work item");
    }
    const reviewIdentity = { ...missionIdentity(), phase: "review" as const };
    const reviewArtifact = await workspace.writeReviewMissionPackage(
      reviewIdentity,
      appliedSubject.review_subject,
      (paths) =>
        compileReviewMission({
          work_item: reviewItem,
          controller_run: {
            schema_version: 1,
            run_id: firstRunId,
            work_item_id: firstId,
            idempotency_key: `${firstId}:review:1:1:0:patch:1`,
            phase: "review",
            goal_version: 1,
            input_revision: 1,
            attempt: 0,
            started_at: "2026-07-22T12:00:02.000Z",
            completed_at: "2026-07-22T12:00:03.000Z",
            outcome: "applied",
          },
          review_subject: appliedSubject.review_subject,
          paths,
          independence_attested: true,
        }),
    );
    expect(reviewArtifact.mission_path).toContain("review-1-1-0-patch-1");
    await writeFile(
      join(root, reviewArtifact.mission.result_contract.output_path),
      "{}\n",
    );
    expect((await workspace.readMissionResult(reviewIdentity, 1)).mission).toEqual(
      reviewArtifact.mission,
    );
    expect(
      (await workspace.listImportEvidence(firstId)).map(
        (stored) => stored.evidence.identity,
      ),
    ).toContainEqual(patchIdentity);
  });

  it("rejects an applied execute subject whose evidence names a different command", async () => {
    const root = await createWorkspace();
    const executeItem = await writeMissionReadyWorkItem(root, firstId);
    const workspace = missionWorkspace(root);
    const artifact = await workspace.writeMissionPackage(
      missionIdentity(),
      (paths) =>
        compileMission(executeItem, appliedExecuteManifest(), paths),
    );
    const submissionSource = serializeExternalResult({
      result_schema_version: 2,
      mission_content_sha256: artifact.mission.content_sha256,
      identity: missionIdentity(),
      commit: "a".repeat(40),
      summary: "Accepted result with divergent command evidence.",
      changed_files: ["src/domain/result.ts"],
      verification: [{ name: "Tests", status: "passed" }],
    });
    const resultHash = hashResultContent(submissionSource);
    await workspace.writeImportEvidence({
      submission_source: submissionSource,
      evidence: {
        schema_version: 2,
        phase: "execute",
        import_run_id: createImportRunId(
          artifact.mission.content_sha256,
          resultHash,
        ),
        result_content_sha256: resultHash,
        mission_content_sha256: artifact.mission.content_sha256,
        identity: missionIdentity(),
        git_base_commit: artifact.mission.source_revision.git_base_commit,
        result_commit: "a".repeat(40),
        controller_run_id: thirdRunId,
        started_at: "2026-07-22T12:00:00.000Z",
        completed_at: "2026-07-22T12:00:01.000Z",
        outcome: "applied",
        reasons: [],
      },
      verification: [
        {
          name: "Different command",
          argv: ["npm", "run", "different"],
          started_at: "2026-07-22T12:00:00.000Z",
          completed_at: "2026-07-22T12:00:01.000Z",
          duration_ms: 1_000,
          status: "passed",
          exit_code: 0,
          signal: null,
          stdout: "green",
          stderr: "",
          output_truncated: false,
        },
      ],
    });
    await writeRunManifest(root, {
      ...appliedExecuteManifest(thirdRunId),
      phase: "review",
    });

    await expect(
      workspace.readAppliedExecuteReviewSubject(missionIdentity()),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
  });

  it("stores applied review evidence without command results", async () => {
    const root = await createWorkspace();
    const workspace = missionWorkspace(root);
    const identity = { ...missionIdentity(), phase: "review" as const };
    const submissionSource = '{"verdict":"clean"}\n';
    const resultHash = hashResultContent(submissionSource);
    const evidence = {
      schema_version: 2 as const,
      phase: "review" as const,
      import_run_id: createImportRunId("f".repeat(64), resultHash),
      result_content_sha256: resultHash,
      mission_content_sha256: "f".repeat(64),
      identity,
      git_base_commit: "a".repeat(40),
      result_commit: "a".repeat(40),
      controller_run_id: thirdRunId,
      started_at: "2026-07-22T12:00:00.000Z",
      completed_at: "2026-07-22T12:00:01.000Z",
      outcome: "applied" as const,
      reasons: [],
    };

    const input = {
      submission_source: submissionSource,
      evidence,
      verification: [],
    };
    const summary = await workspace.writeImportEvidence(input);
    expect(await workspace.writeImportEvidence(input)).toEqual(summary);
    expect(summary.phase).toBe("review");
    expect(await workspace.readImportEvidence(identity, evidence.import_run_id))
      .toMatchObject({ evidence, verification: [] });
    await expect(
      workspace.writeImportEvidence({
        submission_source: submissionSource,
        evidence,
        verification: [
          {
            name: "Tests",
            argv: ["npm", "test"],
            started_at: "2026-07-22T12:00:00.000Z",
            completed_at: "2026-07-22T12:00:01.000Z",
            duration_ms: 1_000,
            status: "passed",
            exit_code: 0,
            signal: null,
            stdout: "green",
            stderr: "",
            output_truncated: false,
          },
        ],
      }),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });

    const evidenceDirectory = join(root, summary.evidence_path);
    await writeFile(
      join(evidenceDirectory, "import.json"),
      `${JSON.stringify({ ...evidence, phase: "execute" }, null, 2)}\n`,
      "utf8",
    );
    await expect(
      workspace.readImportEvidence(identity, evidence.import_run_id),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });

    await writeFile(
      join(evidenceDirectory, "import.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      "utf8",
    );
    const outsideSubmission = join(root, "outside-review-submission.json");
    await writeFile(outsideSubmission, submissionSource, "utf8");
    await rm(join(evidenceDirectory, "submission.json"));
    await symlink(
      outsideSubmission,
      join(evidenceDirectory, "submission.json"),
      "file",
    );
    await expect(
      workspace.readImportEvidence(identity, evidence.import_run_id),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
  });

  it("lists immutable import evidence newest-first across governed identities", async () => {
    const root = await createWorkspace();
    const workspace = missionWorkspace(root);
    const oldest = await writeRejectedEvidence(
      workspace,
      missionIdentity(),
      '{"result":"oldest"}\n',
      "2026-07-22T13:00:00.000Z",
    );
    const tiedFirst = await writeRejectedEvidence(
      workspace,
      missionIdentity(firstId, { input_revision: 2, attempt: 1 }),
      '{"result":"tied-first"}\n',
      "2026-07-22T14:00:00.000Z",
    );
    const tiedSecond = await writeRejectedEvidence(
      workspace,
      missionIdentity(),
      '{"result":"tied-second"}\n',
      "2026-07-22T14:00:00.000Z",
    );

    const tiedRunIds = [tiedFirst.import_run_id, tiedSecond.import_run_id].sort(
      (left, right) => right.localeCompare(left),
    );
    const listed = await workspace.listImportEvidence(firstId);

    expect(listed.map(({ evidence }) => evidence.import_run_id)).toEqual([
      ...tiedRunIds,
      oldest.import_run_id,
    ]);
    expect(listed.map(({ evidence }) => evidence.identity)).toContainEqual(
      missionIdentity(firstId, { input_revision: 2, attempt: 1 }),
    );
    expect(await workspace.listImportEvidence(secondId)).toEqual([]);
  });

  it("fails closed when listed import evidence is unsafe or divergent", async () => {
    const symlinkRoot = await createWorkspace();
    const outsideRoot = await createWorkspace();
    const symlinkTuple = join(
      symlinkRoot,
      ".founder",
      "run-evidence",
      firstId,
      "execute-1-1-0",
    );
    await mkdir(symlinkTuple, { recursive: true });
    await symlink(outsideRoot, join(symlinkTuple, "c".repeat(64)), "dir");
    await expect(
      missionWorkspace(symlinkRoot).listImportEvidence(firstId),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });

    const malformedTupleRoot = await createWorkspace();
    await mkdir(
      join(
        malformedTupleRoot,
        ".founder",
        "run-evidence",
        firstId,
        "bad-tuple",
      ),
      { recursive: true },
    );
    await expect(
      missionWorkspace(malformedTupleRoot).listImportEvidence(firstId),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });

    const malformedRunRoot = await createWorkspace();
    await mkdir(
      join(
        malformedRunRoot,
        ".founder",
        "run-evidence",
        firstId,
        "execute-1-1-0",
        "bad-run-id",
      ),
      { recursive: true },
    );
    await expect(
      missionWorkspace(malformedRunRoot).listImportEvidence(firstId),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });

    const partialRoot = await createWorkspace();
    const partialWorkspace = missionWorkspace(partialRoot);
    const partial = await writeRejectedEvidence(
      partialWorkspace,
      missionIdentity(),
      '{"result":"partial"}\n',
      "2026-07-22T15:00:00.000Z",
    );
    const partialDirectory = join(
      partialRoot,
      ".founder",
      "run-evidence",
      firstId,
      "execute-1-1-0",
      partial.import_run_id,
    );
    await rm(join(partialDirectory, "verification.json"));
    await expect(
      partialWorkspace.listImportEvidence(firstId),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });

    const divergentRoot = await createWorkspace();
    const divergentWorkspace = missionWorkspace(divergentRoot);
    const divergent = await writeRejectedEvidence(
      divergentWorkspace,
      missionIdentity(),
      '{"result":"divergent"}\n',
      "2026-07-22T16:00:00.000Z",
    );
    const divergentDirectory = join(
      divergentRoot,
      ".founder",
      "run-evidence",
      firstId,
      "execute-1-1-0",
      divergent.import_run_id,
    );
    await writeFile(
      join(divergentDirectory, "import.json"),
      `${JSON.stringify(
        {
          ...divergent,
          identity: missionIdentity(firstId, { attempt: 1 }),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await expect(
      divergentWorkspace.listImportEvidence(firstId),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
  });

  it("fails closed for partial, malformed, or divergent mission snapshots", async () => {
    const partialRoot = await createWorkspace();
    const partialItem = await writeMissionReadyWorkItem(partialRoot, firstId);
    const partialDirectory = join(
      partialRoot,
      ".founder",
      "missions",
      firstId,
      "execute-1-1-0",
    );
    await mkdir(partialDirectory, { recursive: true });
    await writeFile(join(partialDirectory, "mission.json"), "{}\n", "utf8");
    await expect(
      missionWorkspace(partialRoot).writeMissionPackage(
        missionIdentity(),
        (paths) => compileMission(partialItem, appliedExecuteManifest(), paths),
      ),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
    expect(await readdir(partialDirectory)).toEqual(["mission.json"]);

    const malformedRoot = await createWorkspace();
    const malformedItem = await writeMissionReadyWorkItem(malformedRoot, firstId);
    const malformedDirectory = join(
      malformedRoot,
      ".founder",
      "missions",
      firstId,
      "execute-1-1-0",
    );
    await mkdir(malformedDirectory, { recursive: true });
    await writeFile(
      join(malformedDirectory, "mission.json"),
      "{invalid",
      "utf8",
    );
    await writeFile(join(malformedDirectory, "TASK.md"), "Invalid\n", "utf8");
    await expect(
      missionWorkspace(malformedRoot).writeMissionPackage(
        missionIdentity(),
        (paths) =>
          compileMission(malformedItem, appliedExecuteManifest(), paths),
      ),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });

    const divergentRoot = await createWorkspace();
    const divergentItem = await writeMissionReadyWorkItem(divergentRoot, firstId);
    const divergentWorkspace = missionWorkspace(divergentRoot);
    const first = await divergentWorkspace.writeMissionPackage(
      missionIdentity(),
      (paths) =>
        compileMission(divergentItem, appliedExecuteManifest(), paths),
    );
    await writeFile(first.task_path, "Divergent task\n", "utf8");
    await expect(
      divergentWorkspace.writeMissionPackage(missionIdentity(), (paths) =>
        compileMission(divergentItem, appliedExecuteManifest(), paths),
      ),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
    expect(await readFile(first.task_path, "utf8")).toBe("Divergent task\n");
  });

  it("rejects a symlinked missions directory without writing outside", async () => {
    const root = await createWorkspace();
    const outsideRoot = await createWorkspace();
    const item = await writeMissionReadyWorkItem(root, firstId);
    await symlink(
      outsideRoot,
      join(root, ".founder", "missions"),
      "dir",
    );

    await expect(
      missionWorkspace(root).writeMissionPackage(
        missionIdentity(),
        (paths) => compileMission(item, appliedExecuteManifest(), paths),
      ),
    ).rejects.toMatchObject({
      kind: "invalid_workspace",
      artifactPath: ".founder/missions",
    });
    expect(await readdir(outsideRoot)).toEqual([".founder"]);
  });

  it("compensates a mid-write failure and leaves an inspectable failed manifest", async () => {
    const root = await createWorkspace();
    await writeContractedWorkItem(root, firstId);
    const workspace = new FailingControllerWorkspace(root);
    const before = await workspace.read(firstId);
    if (before === null) {
      throw new Error("Expected contracted work item");
    }
    const run = activeRun(
      firstRunId,
      `${firstId}:spec:2:2:0`,
    );
    const lease = await workspace.acquireControllerLease(firstId, run);
    if (lease === null) {
      throw new Error("Expected controller lease");
    }

    await expect(
      workspace.commitControllerMutation(
        lease,
        controllerMutation(lease.work_item, run, {
          goalVersion: 2,
          inputRevision: 2,
        }),
      ),
    ).rejects.toThrow("injected controller state write failure");

    expect(await workspace.read(firstId)).toEqual(before);
    expect(await workspace.readControllerRunManifest(firstId, run.run_id)).toMatchObject({
      run_id: run.run_id,
      outcome: "failed",
    });
    const entries = await readdir(
      join(root, ".founder", "work-items", firstId),
    );
    expect(entries).not.toContain(".controller.lock");
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("refuses a publish collision without overwriting either artifact", async () => {
    const sourceRoot = await createWorkspace();
    const targetRoot = await createWorkspace();
    await writeWorkItem(sourceRoot, firstId, "2026-07-17T12:00:00.000Z");
    const source = new ProductWorkspace(sourceRoot);
    const target = new ProductWorkspace(targetRoot);
    const item = await source.read(firstId);
    if (item === null) {
      throw new Error("Expected source fixture item");
    }

    const stagingPath = await target.stageIncomingWorkItem(item);
    await writeWorkItem(targetRoot, firstId, "2026-07-21T12:00:00.000Z");
    const targetBefore = await target.read(firstId);

    await expect(
      target.publishStagedWorkItem(firstId, stagingPath),
    ).rejects.toMatchObject({
      kind: "invalid_workspace",
      reason: "target work-item already exists",
    });
    expect(await target.read(firstId)).toEqual(targetBefore);
    expect(await source.read(firstId)).toEqual(item);

    await target.discardStagedWorkItem(firstId, stagingPath);
    await target.discardStagedWorkItem(firstId, stagingPath);
    expect(await target.list()).toEqual([targetBefore]);
  });

  it("rejects an invalid existing item without changing state", async () => {
    const root = await createWorkspace();
    await writeWorkItem(root, firstId, "2026-07-17T12:00:00.000Z");
    const workspace = new ProductWorkspace(root);
    const itemDirectory = join(root, ".founder", "work-items", firstId);
    const goalPath = join(itemDirectory, "goal.yaml");
    const statePath = join(itemDirectory, "state.json");
    const goal = parse(await readFile(goalPath, "utf8"));
    const stateBefore = await readFile(statePath, "utf8");
    await writeFile(
      goalPath,
      stringify({ ...goal, work_item_id: secondId }),
      "utf8",
    );

    await expect(
      workspace.updatePhase(firstId, { target_phase: "spec" }),
    ).rejects.toBeInstanceOf(InvalidWorkspaceError);
    expect(await readFile(statePath, "utf8")).toBe(stateBefore);
  });

  it("surfaces malformed YAML and JSON as artifact-relative errors", async () => {
    const root = await createWorkspace();
    await writeWorkItem(root, firstId, "2026-07-17T12:00:00.000Z");
    const workspace = new ProductWorkspace(root);
    const directory = join(root, ".founder", "work-items", firstId);

    await writeFile(join(directory, "goal.yaml"), "title: [unterminated\n", "utf8");
    await expect(workspace.read(firstId)).rejects.toMatchObject({
      kind: "invalid_workspace",
      artifactPath: `.founder/work-items/${firstId}/goal.yaml`,
    });

    await writeWorkItem(root, firstId, "2026-07-17T12:00:00.000Z");
    await writeFile(join(directory, "state.json"), "{invalid", "utf8");
    await expect(workspace.read(firstId)).rejects.toMatchObject({
      kind: "invalid_workspace",
      artifactPath: `.founder/work-items/${firstId}/state.json`,
    });
  });

  it("fails closed with durable paths for partial and cross-file-mismatched contracts", async () => {
    const root = await createWorkspace();
    await writeWorkItem(root, firstId, "2026-07-17T12:00:00.000Z");
    const workspace = new ProductWorkspace(root);
    const itemDirectory = join(root, ".founder", "work-items", firstId);
    const goalPath = join(itemDirectory, "goal.yaml");
    const originalGoal = parse(await readFile(goalPath, "utf8"));

    await writeFile(
      goalPath,
      stringify({
        ...originalGoal,
        goal_contract: {
          schema_version: 1,
          goal_version: 1,
          purpose: "Keep workspace contracts strict.",
          non_goals: ["Do not infer missing state."],
          allowed_scope: ["src/domain"],
          review_ready: ["Checks pass"],
        },
      }),
      "utf8",
    );
    await expect(workspace.read(firstId)).rejects.toMatchObject({
      kind: "invalid_workspace",
      artifactPath: `.founder/work-items/${firstId}/goal.yaml`,
      reason: expect.stringContaining(
        "goal_contract.acceptance_criteria",
      ),
    });

    await writeFile(
      goalPath,
      stringify({
        ...originalGoal,
        goal_contract: {
          schema_version: 1,
          goal_version: 1,
          purpose: "Keep workspace contracts strict.",
          acceptance_criteria: ["Reject stale state"],
          non_goals: ["Do not infer missing state."],
          allowed_scope: ["src/domain"],
          review_ready: ["Checks pass"],
        },
      }),
      "utf8",
    );
    await expect(workspace.read(firstId)).rejects.toMatchObject({
      kind: "invalid_workspace",
      artifactPath: `.founder/work-items/${firstId}`,
      reason: expect.stringContaining(
        "state.goal_version: state goal_version must match goal contract goal_version",
      ),
    });
  });

  it("fails closed on mismatched IDs and partial directories", async () => {
    const root = await createWorkspace();
    await writeWorkItem(root, firstId, "2026-07-17T12:00:00.000Z");
    const workspace = new ProductWorkspace(root);
    const statePath = join(
      root,
      ".founder",
      "work-items",
      firstId,
      "state.json",
    );
    const state = JSON.parse(await readFile(statePath, "utf8"));
    await writeFile(
      statePath,
      `${JSON.stringify({ ...state, work_item_id: secondId }, null, 2)}\n`,
      "utf8",
    );

    await expect(workspace.read(firstId)).rejects.toBeInstanceOf(
      InvalidWorkspaceError,
    );

    const partialRoot = await createWorkspace();
    const partialDirectory = join(
      partialRoot,
      ".founder",
      "work-items",
      firstId,
    );
    await mkdir(partialDirectory, { recursive: true });
    await writeFile(
      join(partialDirectory, "goal.yaml"),
      stringify({
        schema_version: 1,
        work_item_id: firstId,
        title: "Partial item",
        type: "Fix",
      }),
      "utf8",
    );

    await expect(new ProductWorkspace(partialRoot).list()).rejects.toMatchObject({
      kind: "invalid_workspace",
      artifactPath: `.founder/work-items/${firstId}/state.json`,
    });
  });

  it("rejects unsafe IDs before reading outside the workspace", async () => {
    const root = await createWorkspace();
    const workspace = new ProductWorkspace(root);

    await expect(workspace.read("../../outside")).rejects.toThrow(
      "work_item_id must use the wi_<uuid> format",
    );
  });

  it("rejects a work-items symlink that escapes the workspace root", async () => {
    const root = await createWorkspace();
    const outsideRoot = await createWorkspace();
    await symlink(
      join(outsideRoot, ".founder", "work-items"),
      join(root, ".founder", "work-items"),
      "dir",
    );

    await expect(new ProductWorkspace(root).list()).rejects.toMatchObject({
      kind: "invalid_workspace",
      artifactPath: ".founder/work-items",
    });
  });

  it("validates the product manifest before workspace operations", async () => {
    const root = await createWorkspace();
    await writeFile(
      join(root, ".founder", "product.yaml"),
      "schema_version: 1\nproduct_name: Legacy Workspace\n",
      "utf8",
    );

    await expect(new ProductWorkspace(root).list()).rejects.toMatchObject({
      kind: "invalid_workspace",
      artifactPath: ".founder/product.yaml",
    });
  });
});
