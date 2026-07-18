import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import {
  workItemSchema,
  type WorkItem,
  type WorkItemIndex,
} from "../domain/work-item";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS work_items (
    work_item_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    phase TEXT NOT NULL,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

interface WorkItemRow {
  work_item_id: string;
  title: string;
  type: string;
  phase: string;
  status: string;
  updated_at: string;
}

export class SQLiteWorkItemIndex implements WorkItemIndex {
  private readonly database: Database.Database;
  private readonly replaceAll: (items: WorkItem[]) => void;

  constructor(databasePath: string) {
    const resolvedPath =
      databasePath === ":memory:" ? databasePath : resolve(databasePath);

    if (resolvedPath !== ":memory:") {
      mkdirSync(dirname(resolvedPath), { recursive: true });
    }

    this.database = new Database(resolvedPath);
    this.database.exec(SCHEMA);

    const clearStatement = this.database.prepare("DELETE FROM work_items");
    const insertStatement = this.database.prepare(`
      INSERT INTO work_items (
        work_item_id,
        title,
        type,
        phase,
        status,
        updated_at
      ) VALUES (
        @work_item_id,
        @title,
        @type,
        @phase,
        @status,
        @updated_at
      )
    `);

    this.replaceAll = this.database.transaction((items: WorkItem[]) => {
      clearStatement.run();
      for (const item of items) {
        insertStatement.run({
          work_item_id: item.goal.work_item_id,
          title: item.goal.title,
          type: item.goal.type,
          phase: item.state.phase,
          status: item.state.status,
          updated_at: item.state.updated_at,
        });
      }
    });
  }

  rebuild(items: WorkItem[]): void {
    const validatedItems = items.map((item) => workItemSchema.parse(item));
    this.replaceAll(validatedItems);
  }

  list(): WorkItem[] {
    const rows = this.database
      .prepare(
        `
          SELECT work_item_id, title, type, phase, status, updated_at
          FROM work_items
          ORDER BY updated_at DESC, work_item_id ASC
        `,
      )
      .all() as WorkItemRow[];

    return rows.map((row) =>
      workItemSchema.parse({
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
      }),
    );
  }

  clear(): void {
    this.database.prepare("DELETE FROM work_items").run();
  }

  close(): void {
    this.database.close();
  }
}
