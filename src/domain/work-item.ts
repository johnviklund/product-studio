import { z } from "zod";

import { portfolioSourceIdSchema } from "./portfolio-source";

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
  "brainstorm",
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

export const CAPTURE_KINDS = ["idea", "todo"] as const;

export const WORK_ITEM_PRIORITIES = ["low", "normal", "high"] as const;

export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];
export type WorkItemPhase = (typeof WORK_ITEM_PHASES)[number];
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];
export type CaptureKind = (typeof CAPTURE_KINDS)[number];
export type WorkItemPriority = (typeof WORK_ITEM_PRIORITIES)[number];

export interface ProductManifest {
  schema_version: 1;
  product_name: string;
}

export interface WorkItemGoal {
  schema_version: 1;
  work_item_id: string;
  title: string;
  type?: WorkItemType;
  capture?: WorkItemCapture;
  priority?: WorkItemPriority;
  tags?: string[];
  notes?: string;
}

export interface WorkItemCapture {
  kind: CaptureKind;
  original_title: string;
  captured_at: string;
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

export interface CreateCaptureInput {
  title: string;
  capture_kind: CaptureKind;
  source_id?: string;
  priority?: WorkItemPriority;
  tags?: string[];
  notes?: string;
}

export interface UpdateWorkItemDetailsInput {
  title?: string;
  type?: WorkItemType | null;
  priority?: WorkItemPriority | null;
  tags?: string[];
  notes?: string | null;
}

export interface AssignWorkItemInput {
  target_source_id: string;
}

export interface UpdateWorkItemPhaseInput {
  target_phase: WorkItemPhase;
}

export interface WorkItemRepository {
  create(input: CreateWorkItemInput): Promise<WorkItem>;
  read(workItemId: string): Promise<WorkItem | null>;
  list(): Promise<WorkItem[]>;
  updatePhase(
    workItemId: string,
    input: UpdateWorkItemPhaseInput,
  ): Promise<WorkItem | null>;
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

const tagSchema = z.string().trim().min(1, "tags must not be empty");

const tagsSchema: z.ZodType<string[]> = z
  .array(tagSchema)
  .refine(
    (tags) => new Set(tags.map((tag) => tag.toLocaleLowerCase())).size === tags.length,
    "tags must not contain case-insensitive duplicates",
  );

const notesSchema = z
  .string()
  .refine((notes) => notes.trim().length > 0, "notes must not be empty");

export const productManifestSchema: z.ZodType<ProductManifest> = z.strictObject({
  schema_version: z.literal(1),
  product_name: z.string(),
});

export const workItemCaptureSchema: z.ZodType<WorkItemCapture> = z.strictObject({
  kind: z.enum(CAPTURE_KINDS),
  original_title: titleSchema,
  captured_at: z.iso.datetime(),
});

export const workItemGoalSchema: z.ZodType<WorkItemGoal> = z.strictObject({
  schema_version: z.literal(1),
  work_item_id: workItemIdSchema,
  title: titleSchema,
  type: z.enum(WORK_ITEM_TYPES).optional(),
  capture: workItemCaptureSchema.optional(),
  priority: z.enum(WORK_ITEM_PRIORITIES).optional(),
  tags: tagsSchema.optional(),
  notes: notesSchema.optional(),
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

export const createCaptureInputSchema: z.ZodType<CreateCaptureInput> =
  z.strictObject({
    title: titleSchema,
    capture_kind: z.enum(CAPTURE_KINDS),
    source_id: portfolioSourceIdSchema.optional(),
    priority: z.enum(WORK_ITEM_PRIORITIES).optional(),
    tags: tagsSchema.optional(),
    notes: notesSchema.optional(),
  });

export const updateWorkItemDetailsInputSchema: z.ZodType<UpdateWorkItemDetailsInput> =
  z
    .strictObject({
      title: titleSchema.optional(),
      type: z.enum(WORK_ITEM_TYPES).nullable().optional(),
      priority: z.enum(WORK_ITEM_PRIORITIES).nullable().optional(),
      tags: tagsSchema.optional(),
      notes: notesSchema.nullable().optional(),
    })
    .refine(
      (input) => Object.values(input).some((value) => value !== undefined),
      "details update must contain at least one field",
    );

export const assignWorkItemInputSchema: z.ZodType<AssignWorkItemInput> =
  z.strictObject({
    target_source_id: portfolioSourceIdSchema,
  });

export const updateWorkItemPhaseInputSchema: z.ZodType<UpdateWorkItemPhaseInput> =
  z.strictObject({
    target_phase: z.enum(WORK_ITEM_PHASES),
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

export class WorkItemTargetCollisionError extends Error {
  readonly kind = "target_collision" as const;

  constructor(
    readonly sourceId: string,
    readonly workItemId: string,
    readonly targetSourceId: string,
  ) {
    super(
      `Work item ${workItemId} from source ${sourceId} already exists in target ${targetSourceId}`,
    );
    this.name = "WorkItemTargetCollisionError";
  }
}

export class WorkItemTransferFailedError extends Error {
  readonly kind = "transfer_failed" as const;

  constructor(
    readonly sourceId: string,
    readonly workItemId: string,
    readonly targetSourceId: string,
    readonly reason: string,
  ) {
    super(
      `Failed to transfer work item ${workItemId} from ${sourceId} to ${targetSourceId}: ${reason}`,
    );
    this.name = "WorkItemTransferFailedError";
  }
}
