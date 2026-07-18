import {
  mkdtemp,
  mkdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { PortfolioService } from "../../src/application/portfolio";
import {
  DuplicateWorkspaceError,
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
  return {
    registry,
    index,
    service: new PortfolioService(registry, index),
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
    await new ProductWorkspace(validRoot).create({
      title: "Surviving item",
      type: "MVP",
    });
    const { index, service } = await createService();
    await service.register({ workspace_path: invalidRoot });
    await service.register({ workspace_path: validRoot });
    await unlink(join(invalidRoot, ".founder", "product.yaml"));

    const rebuild = await service.rebuild();

    expect(rebuild.items).toHaveLength(1);
    expect(rebuild.items[0]?.workspace.workspace_path).toBe(validRoot);
    expect(rebuild.failures).toMatchObject([
      { workspace: { workspace_path: invalidRoot }, reason: expect.any(String) },
    ]);
    await expect(service.listWorkspaces()).resolves.toHaveLength(2);
    index.close();
  });

  it("rebuilds an empty registry to zero rows", async () => {
    const { index, service } = await createService();

    await expect(service.rebuild()).resolves.toEqual({ items: [], failures: [] });
    await expect(service.list()).resolves.toEqual([]);
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
});
