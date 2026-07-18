import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import { PortfolioService } from "../../src/application/portfolio";
import { SQLitePortfolioIndex } from "../../src/index/work-item-index";
import { ProductWorkspace } from "../../src/workspace/product-workspace";
import { PortfolioRegistry } from "../../src/workspace/portfolio-registry";

const getService = vi.hoisted(() => vi.fn());

vi.mock("../../src/application/portfolio-service", () => ({
  getPortfolioService: getService,
}));

import { GET as getWorkItems } from "../../app/api/work-items/route";
import { POST as rebuildWorkItems } from "../../app/api/work-items/rebuild/route";
import {
  GET as getWorkspaces,
  POST as registerWorkspace,
} from "../../app/api/workspaces/route";

const createdRoots: string[] = [];
const openIndexes: SQLitePortfolioIndex[] = [];

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  createdRoots.push(root);
  return root;
}

async function createWorkspace(): Promise<string> {
  const root = await createRoot("product-studio-api-workspace-");
  const founderDirectory = join(root, ".founder");
  await mkdir(founderDirectory, { recursive: true });
  await writeFile(
    join(founderDirectory, "product.yaml"),
    stringify({ schema_version: 1, product_name: "API Workspace" }),
    "utf8",
  );
  await new ProductWorkspace(root).create({
    title: "Expose through HTTP",
    type: "Feature",
  });
  return root;
}

async function createService(): Promise<PortfolioService> {
  const applicationRoot = await createRoot("product-studio-api-app-");
  const registry = new PortfolioRegistry(
    join(applicationRoot, ".local-data", "registry.json"),
  );
  const index = new SQLitePortfolioIndex(":memory:");
  const service = new PortfolioService(registry, index);
  openIndexes.push(index);
  getService.mockResolvedValue(service);
  return service;
}

function registrationRequest(workspacePath: string): Request {
  return new Request("http://localhost/api/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace_path: workspacePath }),
  });
}

beforeEach(() => {
  getService.mockReset();
});

afterEach(async () => {
  for (const index of openIndexes.splice(0)) {
    index.close();
  }
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("portfolio API routes", () => {
  it("registers and lists workspaces and their projected work items", async () => {
    await createService();
    const workspacePath = await createWorkspace();

    const registrationResponse = await registerWorkspace(
      registrationRequest(workspacePath),
    );
    const registration = await registrationResponse.json();

    expect(registrationResponse.status).toBe(201);
    expect(registration).toMatchObject({
      workspace: {
        workspace_path: workspacePath,
        product_name: "API Workspace",
      },
      rebuild: { items: [expect.any(Object)], failures: [] },
    });

    const workspacesResponse = await getWorkspaces();
    expect(workspacesResponse.status).toBe(200);
    expect(await workspacesResponse.json()).toEqual({
      workspaces: [registration.workspace],
    });

    const workItemsResponse = await getWorkItems();
    expect(workItemsResponse.status).toBe(200);
    expect(await workItemsResponse.json()).toEqual({
      items: registration.rebuild.items,
    });
  });

  it("returns the full rebuild result envelope", async () => {
    await createService();
    const workspacePath = await createWorkspace();
    await registerWorkspace(registrationRequest(workspacePath));

    const response = await rebuildWorkItems();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.failures).toEqual([]);
  });
});
