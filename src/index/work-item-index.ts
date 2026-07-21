import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import {
  portfolioWorkItemSchema,
  type PortfolioWorkItem,
  type PortfolioWorkItemIndex,
} from "../domain/portfolio";

const PORTFOLIO_CACHE_SCHEMA_VERSION = 3;

const PORTFOLIO_SCHEMA = `
  CREATE TABLE IF NOT EXISTS portfolio_work_items (
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
  )
`;

interface PortfolioWorkItemRow {
  source_id: string;
  project_workspace_id: string | null;
  project_workspace_path: string | null;
  project_name: string | null;
  project_registered_at: string | null;
  work_item_id: string;
  title: string;
  type: string | null;
  capture_kind: string | null;
  capture_original_title: string | null;
  capture_captured_at: string | null;
  priority: string | null;
  tags: string | null;
  notes: string | null;
  phase: string;
  status: string;
  updated_at: string;
}

export class SQLitePortfolioIndex implements PortfolioWorkItemIndex {
  private readonly database: Database.Database;
  private readonly replaceAll: (items: PortfolioWorkItem[]) => void;

  constructor(databasePath: string) {
    const resolvedPath =
      databasePath === ":memory:" ? databasePath : resolve(databasePath);

    if (resolvedPath !== ":memory:") {
      mkdirSync(dirname(resolvedPath), { recursive: true });
    }

    this.database = new Database(resolvedPath);
    try {
      this.initializeSchema();
    } catch (error) {
      this.database.close();
      throw error;
    }

    const clearStatement = this.database.prepare(
      "DELETE FROM portfolio_work_items",
    );
    const insertStatement = this.database.prepare(`
      INSERT INTO portfolio_work_items (
        source_id,
        project_workspace_id,
        project_workspace_path,
        project_name,
        project_registered_at,
        work_item_id,
        title,
        type,
        capture_kind,
        capture_original_title,
        capture_captured_at,
        priority,
        tags,
        notes,
        phase,
        status,
        updated_at
      ) VALUES (
        @source_id,
        @project_workspace_id,
        @project_workspace_path,
        @project_name,
        @project_registered_at,
        @work_item_id,
        @title,
        @type,
        @capture_kind,
        @capture_original_title,
        @capture_captured_at,
        @priority,
        @tags,
        @notes,
        @phase,
        @status,
        @updated_at
      )
    `);

    this.replaceAll = this.database.transaction(
      (items: PortfolioWorkItem[]) => {
        clearStatement.run();
        for (const item of items) {
          insertStatement.run({
            source_id: item.source_id,
            project_workspace_id: item.project?.workspace_id ?? null,
            project_workspace_path: item.project?.workspace_path ?? null,
            project_name: item.project?.product_name ?? null,
            project_registered_at: item.project?.registered_at ?? null,
            work_item_id: item.work_item.goal.work_item_id,
            title: item.work_item.goal.title,
            type: item.work_item.goal.type ?? null,
            capture_kind: item.work_item.goal.capture?.kind ?? null,
            capture_original_title:
              item.work_item.goal.capture?.original_title ?? null,
            capture_captured_at:
              item.work_item.goal.capture?.captured_at ?? null,
            priority: item.work_item.goal.priority ?? null,
            tags:
              item.work_item.goal.tags === undefined
                ? null
                : JSON.stringify(item.work_item.goal.tags),
            notes: item.work_item.goal.notes ?? null,
            phase: item.work_item.state.phase,
            status: item.work_item.state.status,
            updated_at: item.work_item.state.updated_at,
          });
        }
      },
    );
  }

  rebuild(items: PortfolioWorkItem[]): void {
    const validatedItems = items.map((item) =>
      portfolioWorkItemSchema.parse(item),
    );
    this.replaceAll(validatedItems);
  }

  list(): PortfolioWorkItem[] {
    const rows = this.database
      .prepare(
        `
          SELECT
            source_id,
            project_workspace_id,
            project_workspace_path,
            project_name,
            project_registered_at,
            work_item_id,
            title,
            type,
            capture_kind,
            capture_original_title,
            capture_captured_at,
            priority,
            tags,
            notes,
            phase,
            status,
            updated_at
          FROM portfolio_work_items
          ORDER BY updated_at DESC, source_id ASC, work_item_id ASC
        `,
      )
      .all() as PortfolioWorkItemRow[];

    return rows.map((row) => {
      const hasCapture =
        row.capture_kind !== null ||
        row.capture_original_title !== null ||
        row.capture_captured_at !== null;

      return portfolioWorkItemSchema.parse({
        source_id: row.source_id,
        project:
          row.project_workspace_id === null
            ? null
            : {
                workspace_id: row.project_workspace_id,
                workspace_path: row.project_workspace_path,
                product_name: row.project_name,
                registered_at: row.project_registered_at,
              },
        work_item: {
          goal: {
            schema_version: 1,
            work_item_id: row.work_item_id,
            title: row.title,
            ...(row.type === null ? {} : { type: row.type }),
            ...(hasCapture
              ? {
                  capture: {
                    kind: row.capture_kind,
                    original_title: row.capture_original_title,
                    captured_at: row.capture_captured_at,
                  },
                }
              : {}),
            ...(row.priority === null ? {} : { priority: row.priority }),
            ...(row.tags === null ? {} : { tags: JSON.parse(row.tags) }),
            ...(row.notes === null ? {} : { notes: row.notes }),
          },
          state: {
            schema_version: 1,
            work_item_id: row.work_item_id,
            phase: row.phase,
            status: row.status,
            updated_at: row.updated_at,
          },
        },
      });
    });
  }

  clear(): void {
    this.database.prepare("DELETE FROM portfolio_work_items").run();
  }

  close(): void {
    this.database.close();
  }

  private initializeSchema(): void {
    const storedVersion = this.database.pragma("user_version", {
      simple: true,
    }) as number;

    if (storedVersion > PORTFOLIO_CACHE_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported portfolio cache schema version ${storedVersion}`,
      );
    }

    if (storedVersion < PORTFOLIO_CACHE_SCHEMA_VERSION) {
      this.database.transaction(() => {
        this.database.exec("DROP TABLE IF EXISTS work_items");
        this.database.exec("DROP TABLE IF EXISTS portfolio_work_items");
        this.database.exec(PORTFOLIO_SCHEMA);
        this.database.pragma(
          `user_version = ${PORTFOLIO_CACHE_SCHEMA_VERSION}`,
        );
      })();
      return;
    }

    this.database.exec(PORTFOLIO_SCHEMA);
  }
}
