import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { WorkItemsService } from "../../src/application/work-items";
import type { WorkItemIndex } from "../../src/domain/work-item";
import { SQLiteWorkItemIndex } from "../../src/index/work-item-index";
import { ProductWorkspace } from "../../src/workspace/product-workspace";

const createdRoots: string[] = [];

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "product-studio-service-"));
  createdRoots.push(root);

  const founderDirectory = join(root, ".founder");
  await mkdir(founderDirectory, { recursive: true });
  await writeFile(
    join(founderDirectory, "product.yaml"),
    stringify({ schema_version: 1, product_name: "Service Workspace" }),
    "utf8",
  );

  return root;
}

afterEach(async () => {
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("WorkItemsService", () => {
  it("coordinates create, durable read, indexed list, and rebuild", async () => {
    const root = await createWorkspace();
    const workspace = new ProductWorkspace(root);
    const index = new SQLiteWorkItemIndex(":memory:");
    const service = new WorkItemsService(workspace, index);

    const created = await service.create({
      title: "Coordinate the repositories",
      type: "Feature",
    });

    expect(await service.read(created.goal.work_item_id)).toEqual(created);
    expect(await service.list()).toEqual([created]);

    index.clear();
    expect(await service.list()).toEqual([]);
    expect(await service.rebuild()).toEqual([created]);
    expect(await service.list()).toEqual([created]);
    index.close();
  });

  it("does not report create success when the index update fails", async () => {
    const root = await createWorkspace();
    const workspace = new ProductWorkspace(root);
    const indexFailure = new Error("index unavailable");
    const failingIndex: WorkItemIndex = {
      rebuild() {
        throw indexFailure;
      },
      list() {
        return [];
      },
      clear() {},
    };
    const service = new WorkItemsService(workspace, failingIndex);

    await expect(
      service.create({ title: "Durable despite cache failure", type: "Fix" }),
    ).rejects.toBe(indexFailure);

    const durableItems = await workspace.list();
    expect(durableItems).toHaveLength(1);
    expect(durableItems[0]?.goal.title).toBe("Durable despite cache failure");
  });
});
