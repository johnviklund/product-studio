import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { PortfolioService } from "../../src/application/portfolio";
import {
  DuplicateWorkspaceError,
  INBOX_SOURCE_ID,
  INBOX_SOURCE_LABEL,
  PortfolioWorkItemNotFoundError,
  UnknownPortfolioSourceError,
  type PortfolioWorkItemIndex,
} from "../../src/domain/portfolio";
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
) {
  const applicationRoot = await createRoot("product-studio-service-app-");
  const registry = new PortfolioRegistry(
    join(applicationRoot, ".local-data", "registry.json"),
  );
  const inboxRoot = join(applicationRoot, ".portfolio", "inbox");
  return {
    registry,
    index,
    inboxRoot,
    service: new PortfolioService(registry, index, inboxRoot),
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
      reason: "Move from Todo to Plan is not allowed; move one column at a time.",
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
