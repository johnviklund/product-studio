import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import type { WorkItem } from "../src/domain/work-item";
import { SQLiteWorkItemIndex } from "../src/index/work-item-index";
import { ProductWorkspace } from "../src/workspace/product-workspace";

const createdRoots: string[] = [];

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "product-studio-index-"));
  createdRoots.push(root);

  const founderDirectory = join(root, ".founder");
  await mkdir(founderDirectory, { recursive: true });
  await writeFile(
    join(founderDirectory, "product.yaml"),
    stringify({ schema_version: 1, product_name: "Indexed Workspace" }),
    "utf8",
  );

  return root;
}

function workItem(workItemId: string, title: string): WorkItem {
  return {
    goal: {
      schema_version: 1,
      work_item_id: workItemId,
      title,
      type: "Explore",
    },
    state: {
      schema_version: 1,
      work_item_id: workItemId,
      phase: "idea",
      status: "active",
      updated_at: "2026-07-17T12:00:00.000Z",
    },
  };
}

afterEach(async () => {
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("SQLiteWorkItemIndex", () => {
  it("rebuilds an equal ordered index after deleting the database", async () => {
    const root = await createWorkspace();
    const workspace = new ProductWorkspace(root);
    await workspace.create({ title: "First durable item", type: "MVP" });
    await workspace.create({ title: "Second durable item", type: "Feature" });
    const durableItems = await workspace.list();
    const databasePath = join(root, ".product-studio", "index.sqlite");

    const disposableIndex = new SQLiteWorkItemIndex(databasePath);
    disposableIndex.rebuild([]);
    disposableIndex.close();
    await rm(databasePath);

    const rebuiltIndex = new SQLiteWorkItemIndex(databasePath);
    rebuiltIndex.rebuild(durableItems);

    expect(rebuiltIndex.list()).toEqual(durableItems);
    rebuiltIndex.close();
  });

  it("rolls back the entire rebuild when an insert fails", () => {
    const index = new SQLiteWorkItemIndex(":memory:");
    const original = workItem(
      "wi_123e4567-e89b-12d3-a456-426614174000",
      "Original item",
    );
    const duplicate = workItem(
      "wi_550e8400-e29b-41d4-a716-446655440000",
      "Duplicate item",
    );
    duplicate.goal.work_item_id = original.goal.work_item_id;
    duplicate.state.work_item_id = original.state.work_item_id;
    index.rebuild([original]);

    expect(() => index.rebuild([duplicate, duplicate])).toThrow();
    expect(index.list()).toEqual([original]);
    index.close();
  });

  it("clears only the disposable index", () => {
    const index = new SQLiteWorkItemIndex(":memory:");
    index.rebuild([
      workItem(
        "wi_123e4567-e89b-12d3-a456-426614174000",
        "Disposable projection",
      ),
    ]);

    index.clear();

    expect(index.list()).toEqual([]);
    index.close();
  });
});
