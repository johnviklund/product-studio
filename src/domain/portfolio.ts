import { isAbsolute } from "node:path";

import { z } from "zod";

import { workItemSchema, type WorkItem } from "./work-item";

export interface RegisteredWorkspace {
  workspace_id: string;
  workspace_path: string;
  product_name: string;
  registered_at: string;
}

export interface PortfolioRegistry {
  schema_version: 1;
  workspaces: RegisteredWorkspace[];
}

export const INBOX_SOURCE_ID = "inbox";

export interface PortfolioSource {
  source_id: string;
  project: RegisteredWorkspace | null;
}

export interface PortfolioWorkItem extends PortfolioSource {
  work_item: WorkItem;
}

export interface WorkspaceRebuildFailure extends PortfolioSource {
  reason: string;
}

export interface PortfolioRebuildResult {
  items: PortfolioWorkItem[];
  failures: WorkspaceRebuildFailure[];
}

export interface RegisterWorkspaceInput {
  workspace_path: string;
}

export interface PortfolioWorkItemIndex {
  rebuild(items: PortfolioWorkItem[]): void;
  list(): PortfolioWorkItem[];
  clear(): void;
  close(): void;
}

export const workspaceIdSchema = z
  .string()
  .regex(
    /^ws_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "workspace_id must use the ws_<uuid> format",
  );

export const registeredWorkspaceSchema: z.ZodType<RegisteredWorkspace> =
  z.strictObject({
    workspace_id: workspaceIdSchema,
    workspace_path: z
      .string()
      .min(1, "workspace_path must not be empty")
      .refine(isAbsolute, "workspace_path must be absolute"),
    product_name: z.string(),
    registered_at: z.iso.datetime(),
  });

export const portfolioSourceIdSchema = z.union([
  z.literal(INBOX_SOURCE_ID),
  workspaceIdSchema,
]);

function validatePortfolioSource(
  source: PortfolioSource,
  context: z.core.$RefinementCtx<PortfolioSource>,
): void {
  if (source.project === null && source.source_id !== INBOX_SOURCE_ID) {
    context.addIssue({
      code: "custom",
      message: `a null project must use source_id ${INBOX_SOURCE_ID}`,
      path: ["source_id"],
      input: source.source_id,
    });
  }

  if (
    source.project !== null &&
    source.source_id !== source.project.workspace_id
  ) {
    context.addIssue({
      code: "custom",
      message: "source_id must match project.workspace_id",
      path: ["source_id"],
      input: source.source_id,
    });
  }
}

export const portfolioSourceSchema: z.ZodType<PortfolioSource> = z
  .strictObject({
    source_id: portfolioSourceIdSchema,
    project: registeredWorkspaceSchema.nullable(),
  })
  .superRefine(validatePortfolioSource);

export const portfolioRegistrySchema: z.ZodType<PortfolioRegistry> =
  z.strictObject({
    schema_version: z.literal(1),
    workspaces: z.array(registeredWorkspaceSchema),
  });

export const portfolioWorkItemSchema: z.ZodType<PortfolioWorkItem> =
  z
    .strictObject({
      source_id: portfolioSourceIdSchema,
      project: registeredWorkspaceSchema.nullable(),
      work_item: workItemSchema,
    })
    .superRefine(validatePortfolioSource);

export const workspaceRebuildFailureSchema: z.ZodType<WorkspaceRebuildFailure> =
  z
    .strictObject({
      source_id: portfolioSourceIdSchema,
      project: registeredWorkspaceSchema.nullable(),
      reason: z.string(),
    })
    .superRefine(validatePortfolioSource);

export const portfolioRebuildResultSchema: z.ZodType<PortfolioRebuildResult> =
  z.strictObject({
    items: z.array(portfolioWorkItemSchema),
    failures: z.array(workspaceRebuildFailureSchema),
  });

export const registerWorkspaceInputSchema: z.ZodType<RegisterWorkspaceInput> =
  z.strictObject({
    workspace_path: z
      .string()
      .min(1, "workspace_path must not be empty")
      .refine(isAbsolute, "workspace_path must be absolute"),
  });

export class InvalidRegistryError extends Error {
  readonly kind = "invalid_registry" as const;

  constructor(
    readonly artifactPath: string,
    readonly reason: string,
  ) {
    super(`${artifactPath}: ${reason}`);
    this.name = "InvalidRegistryError";
  }
}

export class DuplicateWorkspaceError extends Error {
  readonly kind = "duplicate_workspace" as const;

  constructor(readonly workspacePath: string) {
    super(`Workspace is already registered: ${workspacePath}`);
    this.name = "DuplicateWorkspaceError";
  }
}
