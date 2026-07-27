import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  INBOX_SOURCE_ID,
  type PortfolioConnectedRunSummary,
  type PortfolioWorkItem,
  type RegisteredWorkspace,
} from "../src/domain/portfolio";
import type { ConnectedRunSummary } from "../src/domain/connected-run";
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
      schema_version: 2,
      work_item_id: workItemId,
      title,
      type: "Explore",
    },
    state: {
      schema_version: 2,
      work_item_id: workItemId,
      phase: "idea",
      status: "active",
      updated_at: "2026-07-17T12:00:00.000Z",
    },
  };
}

function portfolioItem(
  project: RegisteredWorkspace | null,
  work_item: WorkItem,
): PortfolioWorkItem {
  return {
    source_id: project?.workspace_id ?? INBOX_SOURCE_ID,
    project,
    work_item,
  };
}

function connectedRunSummary(workItemId: string): ConnectedRunSummary {
  return {
    schema_version: 1,
    connected_run_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1",
    mission: {
      identity: {
        phase: "execute",
        work_item_id: workItemId,
        goal_version: 1,
        input_revision: 1,
        attempt: 0,
      },
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
      seat: { value: "execute", assurance: "controller_observed" },
      requested_model: { value: "one-run-model", assurance: "user_declared" },
      effective_model: {
        assurance: "adapter_attested",
        model_id: "observed-model",
        deployment_id: null,
        observed_event_sha256: "c".repeat(64),
      },
      effort: { value: "high", assurance: "user_declared" },
      harness: {
        value: { id: "copilot-cli", version: "1.0.75" },
        assurance: "controller_observed",
      },
      adapter_profile: {
        value: {
          adapter_id: "copilot-acp",
          adapter_version: "1",
          profile_id: "execute-v1",
        },
        assurance: "controller_observed",
      },
    },
    capability_envelope_sha256: "d".repeat(64),
    acp_protocol_version: { value: 1, assurance: "adapter_attested" },
    lifecycle: {
      status: "running",
      started_at: "2026-07-26T12:00:00.000Z",
      updated_at: "2026-07-26T12:01:00.000Z",
      completed_at: null,
      terminal_outcome: null,
      partial: false,
    },
    diagnostics: { count: 1, truncated: false },
  };
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
      portfolioItem(null, workItem(sharedId, "Unassigned item")),
    ];
    const expected = [items[2], items[1], items[0]];
    const summaries: PortfolioConnectedRunSummary[] = [
      {
        source_id: firstWorkspace.workspace_id,
        work_item_id: sharedId,
        connected_run: connectedRunSummary(sharedId),
      },
    ];
    const index = new SQLitePortfolioIndex(databasePath);
    index.rebuild(items, summaries);

    expect(index.list()).toEqual(expected);
    expect(index.listConnectedRunSummaries()).toEqual(summaries);
    index.close();
    await rm(databasePath);

    const rebuiltIndex = new SQLitePortfolioIndex(databasePath);
    rebuiltIndex.rebuild(items, summaries);
    expect(rebuiltIndex.list()).toEqual(expected);
    expect(rebuiltIndex.listConnectedRunSummaries()).toEqual(summaries);
    rebuiltIndex.close();
  });

  it("round-trips an untyped capture and its optional metadata after cache deletion", async () => {
    const databasePath = await createDatabasePath();
    const capture = portfolioItem(null, {
      goal: {
        schema_version: 2,
        work_item_id: "wi_550e8400-e29b-41d4-a716-446655440000",
        title: "Capture a calmer idea",
        capture: {
          kind: "idea",
          original_title: "Capture a calmer idea",
          captured_at: "2026-07-21T14:00:00.000Z",
        },
        priority: "normal",
        tags: ["Front-end", "Question"],
        notes: "Preserve this context in the disposable projection.",
      },
      state: {
        schema_version: 2,
        work_item_id: "wi_550e8400-e29b-41d4-a716-446655440000",
        phase: "idea",
        status: "active",
        updated_at: "2026-07-21T14:00:00.000Z",
      },
    });

    const index = new SQLitePortfolioIndex(databasePath);
    index.rebuild([capture]);
    expect(index.list()).toEqual([capture]);
    index.close();

    await rm(databasePath);
    const rebuiltIndex = new SQLitePortfolioIndex(databasePath);
    rebuiltIndex.rebuild([capture]);
    expect(rebuiltIndex.list()).toEqual([capture]);
    rebuiltIndex.close();
  });

  it("round-trips contracted controller state without synthesizing optional nulls", async () => {
    const databasePath = await createDatabasePath();
    const contracted = portfolioItem(firstWorkspace, {
      goal: {
        schema_version: 2,
        work_item_id: "wi_ffffffff-ffff-4fff-afff-ffffffffffff",
        title: "Persist controller state",
        type: "Feature",
        goal_contract: {
          schema_version: 1,
          goal_version: 2,
          purpose: "Keep cache projections complete.",
          acceptance_criteria: ["Reject stale transitions"],
          non_goals: ["Do not invent optional values."],
          allowed_scope: ["src/domain", "src/application"],
          review_ready: ["Checks pass"],
        },
      },
      state: {
        schema_version: 2,
        work_item_id: "wi_ffffffff-ffff-4fff-afff-ffffffffffff",
        phase: "plan",
        status: "active",
        updated_at: "2026-07-21T21:00:00.000Z",
        goal_version: 2,
        input_revision: 3,
        attempt: 1,
        patch_cycle: 0,
        attention: {
          kind: "plan_approval",
          question:
            "Does the current goal contract and allowed scope authorize execution?",
          recommendation:
            "Open the item and approve its existing transition to Execute.",
          created_at: "2026-07-21T21:00:00.000Z",
          governed_tuple: {
            goal_version: 2,
            input_revision: 3,
            attempt: 1,
            patch_cycle: 0,
          },
          pins: {
            artifact_paths: [
              ".founder/work-items/wi_ffffffff-ffff-4fff-afff-ffffffffffff/goal.yaml",
              ".founder/work-items/wi_ffffffff-ffff-4fff-afff-ffffffffffff/state.json",
            ],
            evidence_paths: [],
          },
        },
        active_run: {
          run_id: "550e8400-e29b-41d4-a716-446655440000",
          idempotency_key:
            "wi_ffffffff-ffff-4fff-afff-ffffffffffff:plan:2:3:1",
          acquired_at: "2026-07-21T21:01:00.000Z",
        },
      },
    });
    const uncontracted = portfolioItem(
      null,
      workItem(
        "wi_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "Remain uncontracted",
      ),
    );
    const index = new SQLitePortfolioIndex(databasePath);

    index.rebuild([contracted, uncontracted]);

    expect(index.list()).toEqual([contracted, uncontracted]);
    expect(index.list()[1]?.work_item.goal).not.toHaveProperty("goal_version");
    expect(index.list()[1]?.work_item.state).not.toHaveProperty(
      "input_revision",
    );
    expect(index.list()[1]?.work_item.state).not.toHaveProperty("active_run");
    index.close();
  });

  it("drops and recreates a stale v5 cache instead of migrating its rows", async () => {
    const databasePath = await createDatabasePath();
    const oldDatabase = new Database(databasePath);
    oldDatabase.exec(`
      CREATE TABLE portfolio_work_items (
        source_id TEXT NOT NULL,
        project_workspace_id TEXT,
        project_workspace_path TEXT,
        project_name TEXT,
        project_registered_at TEXT,
        work_item_id TEXT NOT NULL,
        title TEXT NOT NULL,
        type TEXT,
        capture_kind TEXT,
        capture_original_title TEXT,
        capture_captured_at TEXT,
        priority TEXT,
        tags TEXT,
        notes TEXT,
        phase TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source_id, work_item_id)
      );
      PRAGMA user_version = 5;
    `);
    oldDatabase.close();

    const index = new SQLitePortfolioIndex(databasePath);
    expect(index.list()).toEqual([]);
    index.close();

    const inspected = new Database(databasePath, { readonly: true });
    expect(inspected.pragma("user_version", { simple: true })).toBe(7);
    expect(
      inspected
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: "portfolio_work_items" }]);
    expect(
      inspected
        .prepare("PRAGMA table_info(portfolio_work_items)")
        .all()
        .map((column) => (column as { name: string }).name),
    ).toContain("source_id");
    expect(
      inspected
        .prepare("PRAGMA table_info(portfolio_work_items)")
        .all()
        .map((column) => (column as { name: string }).name),
    ).not.toContain("workspace_id");
    expect(
      inspected
        .prepare("PRAGMA table_info(portfolio_work_items)")
        .all()
        .map((column) => (column as { name: string }).name),
    ).toEqual(
      expect.arrayContaining([
        "capture_kind",
        "capture_original_title",
        "capture_captured_at",
        "priority",
        "tags",
        "notes",
        "goal_version",
        "acceptance_criteria",
        "allowed_scope",
        "review_ready",
        "state_goal_version",
        "input_revision",
        "attempt",
        "patch_cycle",
        "attention",
        "active_run",
        "connected_run_summary",
      ]),
    );
    expect(
      inspected
        .prepare("PRAGMA table_info(portfolio_work_items)")
        .all()
        .find((column) => (column as { name: string }).name === "type"),
    ).toMatchObject({ notnull: 0 });
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
