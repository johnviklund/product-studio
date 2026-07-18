import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import {
  portfolioWorkItemSchema,
  type PortfolioWorkItem,
  type PortfolioWorkItemIndex,
} from "../domain/portfolio";

const PORTFOLIO_CACHE_SCHEMA_VERSION = 1;

const PORTFOLIO_SCHEMA = `
  CREATE TABLE IF NOT EXISTS portfolio_work_items (
    workspace_id TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    product_name TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    work_item_id TEXT NOT NULL,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    phase TEXT NOT NULL,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, work_item_id)
  )
`;

interface PortfolioWorkItemRow {
  workspace_id: string;
  workspace_path: string;
  product_name: string;
  registered_at: string;
  work_item_id: string;
  title: string;
  type: string;
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
        workspace_id,
        workspace_path,
        product_name,
        registered_at,
        work_item_id,
        title,
        type,
        phase,
        status,
        updated_at
      ) VALUES (
        @workspace_id,
        @workspace_path,
        @product_name,
        @registered_at,
        @work_item_id,
        @title,
        @type,
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
            workspace_id: item.workspace.workspace_id,
            workspace_path: item.workspace.workspace_path,
            product_name: item.workspace.product_name,
            registered_at: item.workspace.registered_at,
            work_item_id: item.work_item.goal.work_item_id,
            title: item.work_item.goal.title,
            type: item.work_item.goal.type,
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
            workspace_id,
            workspace_path,
            product_name,
            registered_at,
            work_item_id,
            title,
            type,
            phase,
            status,
            updated_at
          FROM portfolio_work_items
          ORDER BY updated_at DESC, workspace_id ASC, work_item_id ASC
        `,
      )
      .all() as PortfolioWorkItemRow[];

    return rows.map((row) =>
      portfolioWorkItemSchema.parse({
        workspace: {
          workspace_id: row.workspace_id,
          workspace_path: row.workspace_path,
          product_name: row.product_name,
          registered_at: row.registered_at,
        },
        work_item: {
          goal: {
            schema_version: 1,
            work_item_id: row.work_item_id,
            title: row.title,
            type: row.type,
          },
          state: {
            schema_version: 1,
            work_item_id: row.work_item_id,
            phase: row.phase,
            status: row.status,
            updated_at: row.updated_at,
          },
        },
      }),
    );
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
