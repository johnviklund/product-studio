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

export interface PortfolioWorkItem {
  workspace: RegisteredWorkspace;
  work_item: WorkItem;
}

export interface WorkspaceRebuildFailure {
  workspace: RegisteredWorkspace;
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

export const portfolioRegistrySchema: z.ZodType<PortfolioRegistry> =
  z.strictObject({
    schema_version: z.literal(1),
    workspaces: z.array(registeredWorkspaceSchema),
  });

export const portfolioWorkItemSchema: z.ZodType<PortfolioWorkItem> =
  z.strictObject({
    workspace: registeredWorkspaceSchema,
    work_item: workItemSchema,
  });

export const workspaceRebuildFailureSchema: z.ZodType<WorkspaceRebuildFailure> =
  z.strictObject({
    workspace: registeredWorkspaceSchema,
    reason: z.string(),
  });

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
