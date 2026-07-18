import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type {
  PortfolioWorkItem,
  RegisteredWorkspace,
} from "../src/domain/portfolio";
import type { WorkItem } from "../src/domain/work-item";
import { SQLitePortfolioIndex } from "../src/index/work-item-index";

const createdRoots: string[] = [];

const firstWorkspace: RegisteredWorkspace = {
  workspace_id: "ws_123e4567-e89b-12d3-a456-426614174000",
  workspace_path: "/products/first",
  product_name: "First product",
  registered_at: "2026-07-17T11:00:00.000Z",
};

const secondWorkspace: RegisteredWorkspace = {
  workspace_id: "ws_550e8400-e29b-41d4-a716-446655440000",
  workspace_path: "/products/second",
  product_name: "Second product",
  registered_at: "2026-07-17T12:00:00.000Z",
};

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

function portfolioItem(
  workspace: RegisteredWorkspace,
  work_item: WorkItem,
): PortfolioWorkItem {
  return { workspace, work_item };
}

async function createDatabasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "product-studio-index-"));
  createdRoots.push(root);
  return join(root, "index.sqlite");
}

afterEach(async () => {
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("SQLitePortfolioIndex", () => {
  it("keeps equal work-item IDs distinct and rebuilds deterministically", async () => {
    const databasePath = await createDatabasePath();
    const sharedId = "wi_123e4567-e89b-12d3-a456-426614174000";
    const items = [
      portfolioItem(secondWorkspace, workItem(sharedId, "Second product item")),
      portfolioItem(firstWorkspace, workItem(sharedId, "First product item")),
    ];
    const expected = [items[1], items[0]];
    const index = new SQLitePortfolioIndex(databasePath);
    index.rebuild(items);

    expect(index.list()).toEqual(expected);
    index.close();
    await rm(databasePath);

    const rebuiltIndex = new SQLitePortfolioIndex(databasePath);
    rebuiltIndex.rebuild(items);
    expect(rebuiltIndex.list()).toEqual(expected);
    rebuiltIndex.close();
  });

  it("recreates an older cache schema instead of migrating its rows", async () => {
    const databasePath = await createDatabasePath();
    const oldDatabase = new Database(databasePath);
    oldDatabase.exec(
      "CREATE TABLE work_items (work_item_id TEXT PRIMARY KEY, title TEXT NOT NULL)",
    );
    oldDatabase.prepare(
      "INSERT INTO work_items (work_item_id, title) VALUES (?, ?)",
    ).run("wi_old", "Disposable row");
    oldDatabase.close();

    const index = new SQLitePortfolioIndex(databasePath);
    expect(index.list()).toEqual([]);
    index.close();

    const inspected = new Database(databasePath, { readonly: true });
    expect(inspected.pragma("user_version", { simple: true })).toBe(1);
    expect(
      inspected
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: "portfolio_work_items" }]);
    inspected.close();
  });

  it("rolls back the entire rebuild when an insert fails", () => {
    const index = new SQLitePortfolioIndex(":memory:");
    const original = portfolioItem(
      firstWorkspace,
      workItem(
        "wi_123e4567-e89b-12d3-a456-426614174000",
        "Original item",
      ),
    );
    const duplicate = portfolioItem(
      secondWorkspace,
      workItem(
        "wi_550e8400-e29b-41d4-a716-446655440000",
        "Duplicate item",
      ),
    );
    index.rebuild([original]);

    expect(() => index.rebuild([duplicate, duplicate])).toThrow();
    expect(index.list()).toEqual([original]);
    index.close();
  });

  it("clears only the disposable index", () => {
    const index = new SQLitePortfolioIndex(":memory:");
    index.rebuild([
      portfolioItem(
        firstWorkspace,
        workItem(
          "wi_123e4567-e89b-12d3-a456-426614174000",
          "Disposable projection",
        ),
      ),
    ]);

    index.clear();

    expect(index.list()).toEqual([]);
    index.close();
  });
});
