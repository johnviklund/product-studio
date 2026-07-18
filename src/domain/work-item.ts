import { z } from "zod";

export const WORK_ITEM_TYPES = [
  "Explore",
  "Prototype",
  "MVP",
  "Feature",
  "Fix",
  "Maintenance",
  "Incident",
] as const;

export const WORK_ITEM_PHASES = [
  "idea",
  "explore",
  "spec",
  "plan",
  "execute",
  "review",
  "test",
  "ship",
  "learn",
] as const;

export const WORK_ITEM_STATUSES = [
  "active",
  "paused",
  "blocked",
  "cancelled",
] as const;

export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];
export type WorkItemPhase = (typeof WORK_ITEM_PHASES)[number];
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export interface ProductManifest {
  schema_version: 1;
  product_name: string;
}

export interface WorkItemGoal {
  schema_version: 1;
  work_item_id: string;
  title: string;
  type: WorkItemType;
}

export interface WorkItemState {
  schema_version: 1;
  work_item_id: string;
  phase: WorkItemPhase;
  status: WorkItemStatus;
  updated_at: string;
}

export interface WorkItem {
  goal: WorkItemGoal;
  state: WorkItemState;
}

export interface CreateWorkItemInput {
  title: string;
  type: WorkItemType;
}

export interface WorkItemRepository {
  create(input: CreateWorkItemInput): Promise<WorkItem>;
  read(workItemId: string): Promise<WorkItem | null>;
  list(): Promise<WorkItem[]>;
}

export interface WorkItemIndex {
  rebuild(items: WorkItem[]): void;
  list(): WorkItem[];
  clear(): void;
}

export const workItemIdSchema = z
  .string()
  .regex(
    /^wi_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "work_item_id must use the wi_<uuid> format",
  );

const titleSchema = z
  .string()
  .refine((title) => title.trim().length > 0, "title must not be empty")
  .refine(
    (title) => title === title.trim(),
    "title must not have leading or trailing whitespace",
  );

export const productManifestSchema: z.ZodType<ProductManifest> = z.strictObject({
  schema_version: z.literal(1),
  product_name: z.string(),
});

export const workItemGoalSchema: z.ZodType<WorkItemGoal> = z.strictObject({
  schema_version: z.literal(1),
  work_item_id: workItemIdSchema,
  title: titleSchema,
  type: z.enum(WORK_ITEM_TYPES),
});

export const workItemStateSchema: z.ZodType<WorkItemState> = z.strictObject({
  schema_version: z.literal(1),
  work_item_id: workItemIdSchema,
  phase: z.enum(WORK_ITEM_PHASES),
  status: z.enum(WORK_ITEM_STATUSES),
  updated_at: z.iso.datetime(),
});

export const workItemSchema: z.ZodType<WorkItem> = z
  .strictObject({
    goal: workItemGoalSchema,
    state: workItemStateSchema,
  })
  .refine(
    ({ goal, state }) => goal.work_item_id === state.work_item_id,
    "goal.yaml and state.json work_item_id values must agree",
  );

export const createWorkItemInputSchema: z.ZodType<CreateWorkItemInput> =
  z.strictObject({
    title: titleSchema,
    type: z.enum(WORK_ITEM_TYPES),
  });

export class InvalidWorkspaceError extends Error {
  readonly kind = "invalid_workspace" as const;

  constructor(
    readonly artifactPath: string,
    readonly reason: string,
  ) {
    super(`${artifactPath}: ${reason}`);
    this.name = "InvalidWorkspaceError";
  }
}
