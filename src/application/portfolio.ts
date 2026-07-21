import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  DuplicateWorkspaceError,
  registerWorkspaceInputSchema,
  registeredWorkspaceSchema,
  type PortfolioRebuildResult,
  type PortfolioWorkItem,
  type PortfolioWorkItemIndex,
  type RegisteredWorkspace,
} from "../domain/portfolio";
import { InvalidWorkspaceError } from "../domain/work-item";
import { ProductWorkspace } from "../workspace/product-workspace";
import { PortfolioRegistry } from "../workspace/portfolio-registry";

type WorkspaceReader = Pick<ProductWorkspace, "readManifest" | "list">;
type WorkspaceFactory = (workspacePath: string) => WorkspaceReader;

export interface RegisterWorkspaceResult {
  workspace: RegisteredWorkspace;
  rebuild: PortfolioRebuildResult;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isExpectedWorkspaceFailure(error: unknown): boolean {
  if (error instanceof InvalidWorkspaceError) {
    return true;
  }

  if (!isNodeError(error)) {
    return false;
  }

  return ["EACCES", "ENOENT", "ENOTDIR", "EPERM"].includes(error.code ?? "");
}

export class PortfolioService {
  constructor(
    private readonly registry: PortfolioRegistry,
    private readonly index: PortfolioWorkItemIndex,
    private readonly makeWorkspace: WorkspaceFactory = (workspacePath) =>
      new ProductWorkspace(workspacePath),
  ) {}

  listWorkspaces(): Promise<RegisteredWorkspace[]> {
    return this.registry.read();
  }

  async register(input: unknown): Promise<RegisterWorkspaceResult> {
    const validatedInput = registerWorkspaceInputSchema.parse(input);
    const workspacePath = resolve(validatedInput.workspace_path);
    const registered = await this.registry.read();

    if (
      registered.some(
        (workspace) => workspace.workspace_path === workspacePath,
      )
    ) {
      throw new DuplicateWorkspaceError(workspacePath);
    }

    const manifest = await this.makeWorkspace(workspacePath).readManifest();
    const workspace = registeredWorkspaceSchema.parse({
      workspace_id: `ws_${randomUUID()}`,
      workspace_path: workspacePath,
      product_name: manifest.product_name,
      registered_at: new Date().toISOString(),
    });

    await this.registry.append(workspace);

    try {
      return { workspace, rebuild: await this.rebuild() };
    } catch (error) {
      throw new Error(
        "Workspace was registered, but the portfolio index rebuild failed and may be stale. Run a rebuild to recover.",
        { cause: error },
      );
    }
  }

  async list(): Promise<PortfolioWorkItem[]> {
    return this.index.list();
  }

  async rebuild(): Promise<PortfolioRebuildResult> {
    const workspaces = await this.registry.read();
    const items: PortfolioWorkItem[] = [];
    const failures: PortfolioRebuildResult["failures"] = [];

    for (const workspace of workspaces) {
      try {
        const reader = this.makeWorkspace(workspace.workspace_path);
        await reader.readManifest();
        const workspaceItems = await reader.list();
        items.push(
          ...workspaceItems.map((work_item) => ({
            source_id: workspace.workspace_id,
            project: workspace,
            work_item,
          })),
        );
      } catch (error) {
        if (!isExpectedWorkspaceFailure(error)) {
          throw error;
        }
        failures.push({
          source_id: workspace.workspace_id,
          project: workspace,
          reason: errorMessage(error),
        });
      }
    }

    this.index.rebuild(items);

    return { items: this.index.list(), failures };
  }
}
