import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { PortfolioService } from "../../src/application/portfolio";
import { WorkItemController } from "../../src/application/work-item-controller";
import {
  DuplicateWorkspaceError,
  INBOX_SOURCE_ID,
  INBOX_SOURCE_LABEL,
  PortfolioWorkItemNotFoundError,
  UnknownPortfolioSourceError,
  type PortfolioWorkItemIndex,
} from "../../src/domain/portfolio";
import {
  WorkItemTargetCollisionError,
  WorkItemTransferFailedError,
} from "../../src/domain/work-item";
import { SQLitePortfolioIndex } from "../../src/index/work-item-index";
import { ProductWorkspace } from "../../src/workspace/product-workspace";
import { PortfolioRegistry } from "../../src/workspace/portfolio-registry";

const createdRoots: string[] = [];

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  createdRoots.push(root);
  return root;
}

async function createWorkspace(productName: string): Promise<string> {
  const root = await createRoot("product-studio-service-workspace-");
  const founderDirectory = join(root, ".founder");
  await mkdir(founderDirectory, { recursive: true });
  await writeFile(
    join(founderDirectory, "product.yaml"),
    stringify({ schema_version: 1, product_name: productName }),
    "utf8",
  );
  return root;
}

async function createService(
  index: PortfolioWorkItemIndex = new SQLitePortfolioIndex(":memory:"),
  makeWorkspace?: (workspacePath: string) => ProductWorkspace,
) {
  const applicationRoot = await createRoot("product-studio-service-app-");
  const registry = new PortfolioRegistry(
    join(applicationRoot, ".local-data", "registry.json"),
  );
  const inboxRoot = join(applicationRoot, ".portfolio", "inbox");
  const service = new PortfolioService(
    registry,
    index,
    inboxRoot,
    makeWorkspace,
  );
  return {
    registry,
    index,
    inboxRoot,
    transfersRoot: service.transfersRoot,
    service,
  };
}

async function writeTransferJournal(
  transfersRoot: string,
  record: {
    transfer_id: string;
    work_item_id: string;
    from_source_id: string;
    from_path: string;
    to_source_id: string;
    to_path: string;
    stage: "staged" | "published" | "source_removed";
  },
): Promise<void> {
  await mkdir(transfersRoot, { recursive: true });
  await writeFile(
    join(transfersRoot, `${record.transfer_id}.json`),
    `${JSON.stringify({ schema_version: 1, ...record }, null, 2)}\n`,
    "utf8",
  );
}

async function preparePendingTransfer(
  actualStage: "staged" | "published" | "source_removed",
  recordedStage: "staged" | "published" | "source_removed" = actualStage,
) {
  const sourceRoot = await createWorkspace(`Recovery source ${actualStage}`);
  const targetRoot = await createWorkspace(`Recovery target ${actualStage}`);
  const createdService = await createService();
  const sourceRegistration = await createdService.service.register({
    workspace_path: sourceRoot,
  });
  const targetRegistration = await createdService.service.register({
    workspace_path: targetRoot,
  });
  const created = await createdService.service.createCapture({
    title: `Recover ${recordedStage} transfer`,
    capture_kind: "idea",
    source_id: sourceRegistration.workspace.workspace_id,
  });
  const source = new ProductWorkspace(sourceRoot);
  const target = new ProductWorkspace(targetRoot);
  const stagingPath = await target.stageIncomingWorkItem(created.work_item);

  if (actualStage !== "staged") {
    await target.publishStagedWorkItem(
      created.work_item.goal.work_item_id,
      stagingPath,
    );
  }
  if (actualStage === "source_removed") {
    await source.removeWorkItem(created.work_item.goal.work_item_id);
  }

  await writeTransferJournal(createdService.transfersRoot, {
    transfer_id: "tr_123e4567-e89b-42d3-a456-426614174000",
    work_item_id: created.work_item.goal.work_item_id,
    from_source_id: sourceRegistration.workspace.workspace_id,
    from_path: sourceRoot,
    to_source_id: targetRegistration.workspace.workspace_id,
    to_path: stagingPath,
    stage: recordedStage,
  });

  return {
    ...createdService,
    source,
    target,
    sourceRegistration,
    targetRegistration,
    created,
  };
}

afterEach(async () => {
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("PortfolioService", () => {
  it("registers a validated workspace and rebuilds its durable items", async () => {
    const root = await createWorkspace("Service Workspace");
    await new ProductWorkspace(root).create({
      title: "Coordinate the portfolio",
      type: "Feature",
    });
    const { registry, index, service } = await createService();

    const result = await service.register({ workspace_path: root });

    expect(result.workspace).toMatchObject({
      workspace_id: expect.stringMatching(/^ws_[0-9a-f-]{36}$/i),
      workspace_path: root,
      product_name: "Service Workspace",
      registered_at: expect.any(String),
    });
    expect(await registry.read()).toEqual([result.workspace]);
    expect(result.rebuild.failures).toEqual([]);
    expect(result.rebuild.items).toHaveLength(1);
    expect(await service.list()).toEqual(result.rebuild.items);
    index.close();
  });

  it("rejects a duplicate normalized path and preserves one entry", async () => {
    const root = await createWorkspace("Duplicate Workspace");
    const { registry, index, service } = await createService();
    await service.register({ workspace_path: root });
    const equivalentPath = join(
      dirname(root),
      basename(root),
      "..",
      basename(root),
    );

    await expect(
      service.register({ workspace_path: equivalentPath }),
    ).rejects.toBeInstanceOf(DuplicateWorkspaceError);
    await expect(registry.read()).resolves.toHaveLength(1);
    index.close();
  });

  it("reports one invalid workspace without blocking valid indexed items", async () => {
    const invalidRoot = await createWorkspace("Invalid Later");
    const validRoot = await createWorkspace("Still Valid");
    await new ProductWorkspace(invalidRoot).create({
      title: "Removed after indexing",
      type: "Fix",
    });
    await new ProductWorkspace(validRoot).create({
      title: "Surviving item",
      type: "MVP",
    });
    const { index, service } = await createService();
    await service.register({ workspace_path: invalidRoot });
    await service.register({ workspace_path: validRoot });
    await expect(service.list()).resolves.toHaveLength(2);
    await rm(invalidRoot, { recursive: true, force: true });

    const rebuild = await service.rebuild();

    expect(rebuild.items).toHaveLength(1);
    expect(rebuild.items[0]?.project?.workspace_path).toBe(validRoot);
    expect(rebuild.failures).toMatchObject([
      {
        source_id: expect.stringMatching(/^ws_/),
        project: { workspace_path: invalidRoot },
        reason: expect.any(String),
      },
    ]);
    await expect(service.list()).resolves.toEqual(rebuild.items);
    await expect(service.listWorkspaces()).resolves.toHaveLength(2);
    index.close();
  });

  it("rebuilds an empty registry to zero rows", async () => {
    const { index, service } = await createService();

    await expect(service.rebuild()).resolves.toEqual({ items: [], failures: [] });
    await expect(service.list()).resolves.toEqual([]);
    index.close();
  });

  it("creates and projects the durable unassigned inbox", async () => {
    const { inboxRoot, index, service } = await createService();

    await service.rebuild();
    const inbox = new ProductWorkspace(inboxRoot);
    await expect(inbox.readManifest()).resolves.toEqual({
      schema_version: 1,
      product_name: INBOX_SOURCE_LABEL,
    });
    const created = await inbox.create({
      title: "Unassigned product idea",
      type: "Explore",
    });

    const rebuilt = await service.rebuild();

    expect(rebuilt.failures).toEqual([]);
    expect(rebuilt.items).toEqual([
      {
        source_id: INBOX_SOURCE_ID,
        project: null,
        work_item: created,
      },
    ]);

    const updated = await service.updateWorkItemPhase(
      INBOX_SOURCE_ID,
      created.goal.work_item_id,
      { target_phase: "spec" },
    );
    expect(updated).toMatchObject({
      source_id: INBOX_SOURCE_ID,
      project: null,
      work_item: { state: { phase: "spec" } },
    });
    await expect(service.list()).resolves.toEqual([updated]);
    index.close();
  });

  it("creates minimal captures in Inbox or directly in a selected project", async () => {
    const projectRoot = await createWorkspace("Capture Project");
    const { inboxRoot, index, service } = await createService();
    const registration = await service.register({ workspace_path: projectRoot });

    const inboxCapture = await service.createCapture({
      title: "Unassigned capture",
      capture_kind: "idea",
    });
    expect(inboxCapture).toMatchObject({
      source_id: INBOX_SOURCE_ID,
      project: null,
      work_item: {
        goal: {
          title: "Unassigned capture",
          capture: {
            kind: "idea",
            original_title: "Unassigned capture",
          },
        },
        state: { phase: "idea", status: "active" },
      },
    });
    expect(inboxCapture.work_item.goal).not.toHaveProperty("type");
    expect(inboxCapture.work_item.goal).not.toHaveProperty("priority");

    const projectCapture = await service.createCapture({
      title: "Project capture",
      capture_kind: "todo",
      source_id: registration.workspace.workspace_id,
    });
    expect(projectCapture).toMatchObject({
      source_id: registration.workspace.workspace_id,
      project: { workspace_path: projectRoot },
      work_item: { goal: { title: "Project capture" } },
    });

    const inbox = new ProductWorkspace(inboxRoot);
    const project = new ProductWorkspace(projectRoot);
    expect(await inbox.read(projectCapture.work_item.goal.work_item_id)).toBeNull();
    expect(await project.read(projectCapture.work_item.goal.work_item_id)).toEqual(
      projectCapture.work_item,
    );
    await expect(service.list()).resolves.toHaveLength(2);
    index.close();
  });

  it("updates and clears capture details without rewriting provenance", async () => {
    const { index, service } = await createService();
    const created = await service.createCapture({
      title: "Original capture",
      capture_kind: "idea",
      priority: "normal",
      tags: ["Question"],
      notes: "Original context",
    });
    const provenance = created.work_item.goal.capture;

    const updated = await service.updateWorkItemDetails(
      INBOX_SOURCE_ID,
      created.work_item.goal.work_item_id,
      { title: "Refined capture", type: "Feature" },
    );
    expect(updated.work_item.goal).toMatchObject({
      title: "Refined capture",
      type: "Feature",
      priority: "normal",
      tags: ["Question"],
      notes: "Original context",
      capture: provenance,
    });

    const cleared = await service.updateWorkItemDetails(
      INBOX_SOURCE_ID,
      created.work_item.goal.work_item_id,
      { type: null, priority: null, tags: [], notes: null },
    );
    expect(cleared.work_item.goal).toEqual({
      schema_version: 1,
      work_item_id: created.work_item.goal.work_item_id,
      title: "Refined capture",
      capture: provenance,
    });
    await expect(service.list()).resolves.toEqual([cleared]);
    index.close();
  });

  it("rejects unversioned details updates after a goal contract exists", async () => {
    const { inboxRoot, index, service } = await createService();
    const created = await service.createCapture({
      title: "Govern this capture",
      capture_kind: "idea",
    });
    const repository = new ProductWorkspace(inboxRoot);
    const controller = new WorkItemController(
      repository,
      () => new Date("2026-07-21T21:30:00.000Z"),
    );
    await controller.updateGoalContract(created.work_item.goal.work_item_id, {
      acceptance_criteria: ["Keep contract changes version-bound"],
      allowed_scope: ["src/application"],
      review_ready: ["Tests pass"],
    });
    await service.rebuild();
    const before = await repository.read(created.work_item.goal.work_item_id);
    const beforeIndex = await service.list();

    await expect(
      service.updateWorkItemDetails(
        INBOX_SOURCE_ID,
        created.work_item.goal.work_item_id,
        { title: "Unversioned rewrite" },
      ),
    ).rejects.toMatchObject({
      name: "ControllerConflictError",
      kind: "contracted_details",
    });
    expect(await repository.read(created.work_item.goal.work_item_id)).toEqual(
      before,
    );
    expect(await service.list()).toEqual(beforeIndex);
    index.close();
  });

  it("assigns a capture across workspace roots and treats same-source assignment as idempotent", async () => {
    const sourceRoot = await createWorkspace("Transfer Source");
    const targetRoot = await createWorkspace("Transfer Target");
    const { index, service, transfersRoot } = await createService();
    const sourceRegistration = await service.register({
      workspace_path: sourceRoot,
    });
    const targetRegistration = await service.register({
      workspace_path: targetRoot,
    });
    const created = await service.createCapture({
      title: "Portable capture",
      capture_kind: "todo",
      source_id: sourceRegistration.workspace.workspace_id,
      tags: ["Portable"],
    });

    const unchanged = await service.assignWorkItem(
      sourceRegistration.workspace.workspace_id,
      created.work_item.goal.work_item_id,
      { target_source_id: sourceRegistration.workspace.workspace_id },
    );
    expect(unchanged).toEqual(created);

    const assigned = await service.assignWorkItem(
      sourceRegistration.workspace.workspace_id,
      created.work_item.goal.work_item_id,
      { target_source_id: targetRegistration.workspace.workspace_id },
    );
    expect(assigned).toEqual({
      source_id: targetRegistration.workspace.workspace_id,
      project: targetRegistration.workspace,
      work_item: created.work_item,
    });
    expect(
      await new ProductWorkspace(sourceRoot).read(
        created.work_item.goal.work_item_id,
      ),
    ).toBeNull();
    expect(
      await new ProductWorkspace(targetRoot).read(
        created.work_item.goal.work_item_id,
      ),
    ).toEqual(created.work_item);
    await expect(service.list()).resolves.toEqual([assigned]);
    expect(await readdir(transfersRoot)).toEqual([]);
    index.close();
  });

  it("rejects unknown, missing, and colliding assignment targets without overwriting", async () => {
    const sourceRoot = await createWorkspace("Collision Source");
    const targetRoot = await createWorkspace("Collision Target");
    const { index, service } = await createService();
    const sourceRegistration = await service.register({
      workspace_path: sourceRoot,
    });
    const targetRegistration = await service.register({
      workspace_path: targetRoot,
    });
    const created = await service.createCapture({
      title: "Collision candidate",
      capture_kind: "idea",
      source_id: sourceRegistration.workspace.workspace_id,
    });

    await expect(
      service.assignWorkItem(
        sourceRegistration.workspace.workspace_id,
        created.work_item.goal.work_item_id,
        { target_source_id: "ws_00000000-0000-4000-8000-000000000000" },
      ),
    ).rejects.toBeInstanceOf(UnknownPortfolioSourceError);
    await expect(
      service.assignWorkItem(
        sourceRegistration.workspace.workspace_id,
        "wi_123e4567-e89b-12d3-a456-426614174000",
        { target_source_id: targetRegistration.workspace.workspace_id },
      ),
    ).rejects.toBeInstanceOf(PortfolioWorkItemNotFoundError);

    const target = new ProductWorkspace(targetRoot);
    const stagingPath = await target.stageIncomingWorkItem(created.work_item);
    await target.publishStagedWorkItem(
      created.work_item.goal.work_item_id,
      stagingPath,
    );
    await expect(
      service.assignWorkItem(
        sourceRegistration.workspace.workspace_id,
        created.work_item.goal.work_item_id,
        { target_source_id: targetRegistration.workspace.workspace_id },
      ),
    ).rejects.toBeInstanceOf(WorkItemTargetCollisionError);
    expect(
      await new ProductWorkspace(sourceRoot).read(
        created.work_item.goal.work_item_id,
      ),
    ).toEqual(created.work_item);
    expect(await target.read(created.work_item.goal.work_item_id)).toEqual(
      created.work_item,
    );
    index.close();
  });

  it("rolls back a staged transfer during rebuild", async () => {
    const fixture = await preparePendingTransfer("staged");
    const workItemId = fixture.created.work_item.goal.work_item_id;

    const rebuilt = await fixture.service.rebuild();

    expect(await fixture.source.read(workItemId)).toEqual(
      fixture.created.work_item,
    );
    expect(await fixture.target.read(workItemId)).toBeNull();
    expect(rebuilt.items).toEqual([fixture.created]);
    expect(await readdir(fixture.transfersRoot)).toEqual([]);
    fixture.index.close();
  });

  it("detects crash-after-publish from a stale staged journal and completes the transfer", async () => {
    const fixture = await preparePendingTransfer("published", "staged");
    const workItemId = fixture.created.work_item.goal.work_item_id;

    const rebuilt = await fixture.service.rebuild();

    expect(await fixture.source.read(workItemId)).toBeNull();
    expect(await fixture.target.read(workItemId)).toEqual(
      fixture.created.work_item,
    );
    expect(rebuilt.items).toEqual([
      {
        source_id: fixture.targetRegistration.workspace.workspace_id,
        project: fixture.targetRegistration.workspace,
        work_item: fixture.created.work_item,
      },
    ]);
    expect(await readdir(fixture.transfersRoot)).toEqual([]);
    fixture.index.close();
  });

  it("completes a published transfer during rebuild", async () => {
    const fixture = await preparePendingTransfer("published");
    const workItemId = fixture.created.work_item.goal.work_item_id;

    await fixture.service.rebuild();

    expect(await fixture.source.read(workItemId)).toBeNull();
    expect(await fixture.target.read(workItemId)).toEqual(
      fixture.created.work_item,
    );
    expect(await readdir(fixture.transfersRoot)).toEqual([]);
    fixture.index.close();
  });

  it("finalizes a source-removed transfer during rebuild", async () => {
    const fixture = await preparePendingTransfer("source_removed");
    const workItemId = fixture.created.work_item.goal.work_item_id;

    await fixture.service.rebuild();

    expect(await fixture.source.read(workItemId)).toBeNull();
    expect(await fixture.target.read(workItemId)).toEqual(
      fixture.created.work_item,
    );
    expect(await readdir(fixture.transfersRoot)).toEqual([]);
    fixture.index.close();
  });

  it("surfaces an interrupted published transfer and recovers it idempotently", async () => {
    const sourceRoot = await createWorkspace("Interrupted Source");
    const targetRoot = await createWorkspace("Interrupted Target");
    const workspaces = new Map<string, ProductWorkspace>();
    const makeWorkspace = (workspacePath: string) => {
      let workspace = workspaces.get(workspacePath);
      if (workspace === undefined) {
        workspace = new ProductWorkspace(workspacePath);
        workspaces.set(workspacePath, workspace);
      }
      return workspace;
    };
    const { index, service, transfersRoot } = await createService(
      new SQLitePortfolioIndex(":memory:"),
      makeWorkspace,
    );
    const sourceRegistration = await service.register({
      workspace_path: sourceRoot,
    });
    const targetRegistration = await service.register({
      workspace_path: targetRoot,
    });
    const created = await service.createCapture({
      title: "Recover after denied source removal",
      capture_kind: "todo",
      source_id: sourceRegistration.workspace.workspace_id,
    });
    const source = makeWorkspace(sourceRoot);
    const target = makeWorkspace(targetRoot);
    const removeWorkItem = source.removeWorkItem.bind(source);
    source.removeWorkItem = async () => {
      throw Object.assign(new Error("source removal denied"), {
        code: "EACCES",
      });
    };

    await expect(
      service.assignWorkItem(
        sourceRegistration.workspace.workspace_id,
        created.work_item.goal.work_item_id,
        { target_source_id: targetRegistration.workspace.workspace_id },
      ),
    ).rejects.toBeInstanceOf(WorkItemTransferFailedError);
    expect(await source.read(created.work_item.goal.work_item_id)).toEqual(
      created.work_item,
    );
    expect(await target.read(created.work_item.goal.work_item_id)).toEqual(
      created.work_item,
    );
    expect(await readdir(transfersRoot)).toHaveLength(1);

    source.removeWorkItem = removeWorkItem;
    await service.rebuild();
    await service.rebuild();
    expect(await source.read(created.work_item.goal.work_item_id)).toBeNull();
    expect(await target.read(created.work_item.goal.work_item_id)).toEqual(
      created.work_item,
    );
    expect(await readdir(transfersRoot)).toEqual([]);
    index.close();
  });

  it("enforces transitions and refreshes the index after an accepted move", async () => {
    const root = await createWorkspace("Transition Workspace");
    const created = await new ProductWorkspace(root).create({
      title: "Move through the board",
      type: "Feature",
    });
    const statePath = join(
      root,
      ".founder",
      "work-items",
      created.goal.work_item_id,
      "state.json",
    );
    const { index, service } = await createService();
    const registration = await service.register({ workspace_path: root });
    const sourceId = registration.workspace.workspace_id;

    const updated = await service.updateWorkItemPhase(
      sourceId,
      created.goal.work_item_id,
      { target_phase: "spec" },
    );

    expect(updated).toMatchObject({
      source_id: sourceId,
      project: { workspace_path: root },
      work_item: { state: { phase: "spec", status: "active" } },
    });
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      phase: "spec",
      status: "active",
    });
    await expect(service.list()).resolves.toEqual([updated]);
    index.close();
  });

  it("rejects invalid moves without changing durable state or the index", async () => {
    const root = await createWorkspace("Rejected Transition");
    const created = await new ProductWorkspace(root).create({
      title: "Do not skip gates",
      type: "Fix",
    });
    const statePath = join(
      root,
      ".founder",
      "work-items",
      created.goal.work_item_id,
      "state.json",
    );
    const { index, service } = await createService();
    const registration = await service.register({ workspace_path: root });
    const beforeState = await readFile(statePath, "utf8");
    const beforeIndex = await service.list();

    await expect(
      service.updateWorkItemPhase(
        registration.workspace.workspace_id,
        created.goal.work_item_id,
        { target_phase: "plan" },
      ),
    ).rejects.toMatchObject({
      kind: "invalid_transition",
      reason: "Phase transition from idea to plan is not allowed.",
    });
    expect(await readFile(statePath, "utf8")).toBe(beforeState);
    await expect(service.list()).resolves.toEqual(beforeIndex);
    index.close();
  });

  it("reports missing sources and work items with stable errors", async () => {
    const root = await createWorkspace("Missing Work");
    const { index, service } = await createService();
    const registration = await service.register({ workspace_path: root });

    await expect(
      service.updateWorkItemPhase(
        "ws_00000000-0000-4000-8000-000000000000",
        "wi_123e4567-e89b-12d3-a456-426614174000",
        { target_phase: "spec" },
      ),
    ).rejects.toBeInstanceOf(UnknownPortfolioSourceError);
    await expect(
      service.updateWorkItemPhase(
        registration.workspace.workspace_id,
        "wi_123e4567-e89b-12d3-a456-426614174000",
        { target_phase: "spec" },
      ),
    ).rejects.toBeInstanceOf(PortfolioWorkItemNotFoundError);
    index.close();
  });

  it("keeps project items visible when an existing inbox is malformed", async () => {
    const root = await createWorkspace("Project Survives Inbox Failure");
    await new ProductWorkspace(root).create({
      title: "Still visible",
      type: "MVP",
    });
    const { inboxRoot, index, service } = await createService();
    await service.register({ workspace_path: root });
    const manifestPath = join(inboxRoot, ".founder", "product.yaml");
    await writeFile(
      manifestPath,
      "schema_version: 2\nproduct_name: Corrupt Inbox\n",
      "utf8",
    );
    const malformedSource = await readFile(manifestPath, "utf8");

    const rebuild = await service.rebuild();

    expect(rebuild.items).toHaveLength(1);
    expect(rebuild.items[0]?.project?.workspace_path).toBe(root);
    expect(rebuild.failures).toMatchObject([
      {
        source_id: INBOX_SOURCE_ID,
        project: null,
        reason: expect.stringContaining("schema_version"),
      },
    ]);
    expect(await readFile(manifestPath, "utf8")).toBe(malformedSource);
    index.close();
  });

  it("preserves registration and explains recovery when the index fails", async () => {
    const root = await createWorkspace("Durable Registration");
    const indexFailure = new Error("index unavailable");
    const failingIndex: PortfolioWorkItemIndex = {
      rebuild() {
        throw indexFailure;
      },
      list() {
        return [];
      },
      clear() {},
      close() {},
    };
    const { registry, service } = await createService(failingIndex);

    await expect(
      service.register({ workspace_path: root }),
    ).rejects.toThrow(
      "Workspace was registered, but the portfolio index rebuild failed and may be stale",
    );
    await expect(registry.read()).resolves.toHaveLength(1);
  });

  it("rejects invalid input before changing the registry", async () => {
    const { registry, index, service } = await createService();

    await expect(
      service.register({ workspace_path: "relative/workspace" }),
    ).rejects.toThrow("workspace_path must be absolute");
    await expect(
      service.register({ workspace_path: join(tmpdir(), "missing-workspace") }),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
    await expect(registry.read()).resolves.toEqual([]);
    index.close();
  });

  it("does not overwrite existing registrations for a malformed manifest", async () => {
    const validRoot = await createWorkspace("Preserved Workspace");
    const malformedRoot = await createWorkspace("Malformed Workspace");
    const { registry, index, service } = await createService();
    const registered = await service.register({ workspace_path: validRoot });
    await writeFile(
      join(malformedRoot, ".founder", "product.yaml"),
      "schema_version: 2\nproduct_name: Future Workspace\n",
      "utf8",
    );

    await expect(
      service.register({ workspace_path: malformedRoot }),
    ).rejects.toMatchObject({ kind: "invalid_workspace" });
    await expect(registry.read()).resolves.toEqual([registered.workspace]);
    index.close();
  });
});
