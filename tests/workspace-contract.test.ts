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
import { parse, stringify } from "yaml";

import {
  InvalidWorkspaceError,
  type ActiveRun,
  type ControllerMutationInput,
  type WorkItem,
} from "../src/domain/work-item";
import { ProductWorkspace } from "../src/workspace/product-workspace";

const createdRoots: string[] = [];
const firstId = "wi_123e4567-e89b-12d3-a456-426614174000";
const secondId = "wi_550e8400-e29b-41d4-a716-446655440000";
const firstRunId = "550e8400-e29b-41d4-a716-446655440000";
const secondRunId = "123e4567-e89b-42d3-a456-426614174000";

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "product-studio-workspace-"));
  createdRoots.push(root);

  const founderDirectory = join(root, ".founder");
  await mkdir(founderDirectory, { recursive: true });
  await writeFile(
    join(founderDirectory, "product.yaml"),
    stringify({ schema_version: 1, product_name: "Test Workspace" }),
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
      schema_version: 1,
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
      schema_version: 1,
      work_item_id: workItemId,
      title: `Item ${workItemId}`,
      type: "Explore",
      goal_version: 1,
      acceptance_criteria: ["Reject stale state"],
      allowed_scope: ["src/domain"],
      review_ready: ["Checks pass"],
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
      goal_version: goalVersion,
      acceptance_criteria: ["Reject stale state"],
      allowed_scope: ["src/domain"],
      review_ready: ["Checks pass"],
    },
    state: {
      ...current.state,
      phase,
      updated_at: "2026-07-21T20:02:00.000Z",
      goal_version: goalVersion,
      input_revision: inputRevision,
      attempt: 0,
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
    const workspace = new ProductWorkspace(root);

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
      schema_version: 1,
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
      schema_version: 1,
      work_item_id: created.goal.work_item_id,
      title: "Refined capture",
      capture: created.goal.capture,
    });
    expect(cleared?.goal).toEqual({
      schema_version: 1,
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
      stringify({ ...originalGoal, goal_version: 1 }),
      "utf8",
    );
    await expect(workspace.read(firstId)).rejects.toMatchObject({
      kind: "invalid_workspace",
      artifactPath: `.founder/work-items/${firstId}/goal.yaml`,
      reason: expect.stringContaining(
        "acceptance_criteria is required when a goal contract is present",
      ),
    });

    await writeFile(
      goalPath,
      stringify({
        ...originalGoal,
        goal_version: 1,
        acceptance_criteria: ["Reject stale state"],
        allowed_scope: ["src/domain"],
        review_ready: ["Checks pass"],
      }),
      "utf8",
    );
    await expect(workspace.read(firstId)).rejects.toMatchObject({
      kind: "invalid_workspace",
      artifactPath: `.founder/work-items/${firstId}`,
      reason: expect.stringContaining(
        "state.goal_version: state goal_version must match goal goal_version",
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
      "schema_version: 2\nproduct_name: Future Workspace\n",
      "utf8",
    );

    await expect(new ProductWorkspace(root).list()).rejects.toMatchObject({
      kind: "invalid_workspace",
      artifactPath: ".founder/product.yaml",
    });
  });
});
