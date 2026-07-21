import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

import * as workItemsRoute from "../../app/api/work-items/route";
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

async function createService(): Promise<{
  registry: PortfolioRegistry;
  service: PortfolioService;
}> {
  const applicationRoot = await createRoot("product-studio-api-app-");
  const registry = new PortfolioRegistry(
    join(applicationRoot, ".local-data", "registry.json"),
  );
  const index = new SQLitePortfolioIndex(":memory:");
  const service = new PortfolioService(
    registry,
    index,
    join(applicationRoot, ".portfolio", "inbox"),
  );
  openIndexes.push(index);
  getService.mockResolvedValue(service);
  return { registry, service };
}

function registrationRequest(workspacePath: string): Request {
  return new Request("http://localhost/api/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace_path: workspacePath }),
  });
}

function registrationRequestBody(body: unknown): Request {
  return new Request("http://localhost/api/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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

    const workItemsResponse = await workItemsRoute.GET();
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

  it("keeps a missing registration visible while rebuild reports its failure", async () => {
    await createService();
    const workspacePath = await createWorkspace();
    const registrationResponse = await registerWorkspace(
      registrationRequest(workspacePath),
    );
    const registration = await registrationResponse.json();
    await rm(workspacePath, { recursive: true, force: true });

    const rebuildResponse = await rebuildWorkItems();
    const rebuild = await rebuildResponse.json();
    const workspacesResponse = await getWorkspaces();

    expect(rebuild.items).toEqual([]);
    expect(rebuild.failures).toMatchObject([
      {
        source_id: expect.stringMatching(/^ws_/),
        project: { workspace_path: workspacePath },
        reason: expect.any(String),
      },
    ]);
    expect(await workspacesResponse.json()).toEqual({
      workspaces: [registration.workspace],
    });
  });

  it("does not expose ambiguous single-workspace route handlers", () => {
    expect("POST" in workItemsRoute).toBe(false);
    expect(
      existsSync(
        join(
          process.cwd(),
          "app",
          "api",
          "work-items",
          "[workItemId]",
          "route.ts",
        ),
      ),
    ).toBe(false);
  });

  it("returns 400 invalid_request for malformed registration input", async () => {
    await createService();

    const response = await registerWorkspace(
      registrationRequestBody({ workspace_path: "relative/workspace" }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid request" },
    });
  });

  it("returns 422 invalid_workspace before writing a registration", async () => {
    const { registry } = await createService();
    const workspacePath = await createRoot("product-studio-api-invalid-");
    await mkdir(join(workspacePath, ".founder"));

    const response = await registerWorkspace(
      registrationRequest(workspacePath),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_workspace",
        message: "required file is missing",
        artifact_path: ".founder/product.yaml",
      },
    });
    await expect(registry.read()).resolves.toEqual([]);
  });

  it("returns 422 invalid_registry with the durable artifact path", async () => {
    const { registry } = await createService();
    await mkdir(dirname(registry.registryPath), { recursive: true });
    await writeFile(registry.registryPath, "{invalid", "utf8");

    const response = await getWorkspaces();

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        code: "invalid_registry",
        artifact_path: registry.registryPath,
      },
    });
    expect(body.error.message).toContain("invalid JSON");
  });

  it("returns 409 duplicate_workspace and preserves one registration", async () => {
    const { registry } = await createService();
    const workspacePath = await createWorkspace();
    await registerWorkspace(registrationRequest(workspacePath));

    const response = await registerWorkspace(
      registrationRequest(workspacePath),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "duplicate_workspace",
        message: `Workspace is already registered: ${workspacePath}`,
      },
    });
    await expect(registry.read()).resolves.toHaveLength(1);
  });
});
