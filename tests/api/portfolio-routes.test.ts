import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import { PortfolioService } from "../../src/application/portfolio";
import {
  WorkItemTargetCollisionError,
  WorkItemTransferFailedError,
} from "../../src/domain/work-item";
import { SQLitePortfolioIndex } from "../../src/index/work-item-index";
import { ProductWorkspace } from "../../src/workspace/product-workspace";
import { PortfolioRegistry } from "../../src/workspace/portfolio-registry";

const getService = vi.hoisted(() => vi.fn());

vi.mock("../../src/application/portfolio-service", () => ({
  getPortfolioService: getService,
}));

import * as workItemsRoute from "../../app/api/work-items/route";
import { POST as createPortfolioWorkItem } from "../../app/api/portfolio/work-items/route";
import { POST as assignPortfolioWorkItem } from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/assignment/route";
import { PATCH as updatePortfolioWorkItemDetails } from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/details/route";
import {
  PATCH as updatePortfolioWorkItem,
} from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/route";
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

function phaseUpdateRequest(body: unknown): Request {
  return new Request("http://localhost/api/portfolio/work-items/source/item", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function captureRequest(body: unknown): Request {
  return new Request("http://localhost/api/portfolio/work-items", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function detailsUpdateRequest(body: unknown): Request {
  return new Request(
    "http://localhost/api/portfolio/work-items/source/item/details",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function assignmentRequest(body: unknown): Request {
  return new Request(
    "http://localhost/api/portfolio/work-items/source/item/assignment",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function phaseUpdateContext(sourceId: string, workItemId: string) {
  return { params: Promise.resolve({ sourceId, workItemId }) };
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

  it("updates a source-qualified work item phase", async () => {
    await createService();
    const workspacePath = await createWorkspace();
    const registrationResponse = await registerWorkspace(
      registrationRequest(workspacePath),
    );
    const registration = await registrationResponse.json();
    const sourceId = registration.workspace.workspace_id as string;
    const workItemId = registration.rebuild.items[0].work_item.goal
      .work_item_id as string;

    const response = await updatePortfolioWorkItem(
      phaseUpdateRequest({ target_phase: "spec" }),
      phaseUpdateContext(sourceId, workItemId),
    );
    const updated = await response.json();

    expect(response.status).toBe(200);
    expect(updated).toMatchObject({
      source_id: sourceId,
      project: { workspace_path: workspacePath },
      work_item: {
        goal: { work_item_id: workItemId },
        state: { phase: "spec", status: "active" },
      },
    });
    expect(await (await workItemsRoute.GET()).json()).toEqual({
      items: [updated],
    });
  });

  it("creates, refines, and assigns a source-qualified capture", async () => {
    await createService();
    const workspacePath = await createWorkspace();
    const registrationResponse = await registerWorkspace(
      registrationRequest(workspacePath),
    );
    const registration = await registrationResponse.json();
    const targetSourceId = registration.workspace.workspace_id as string;

    const createResponse = await createPortfolioWorkItem(
      captureRequest({
        title: "Capture through HTTP",
        capture_kind: "idea",
      }),
    );
    const created = await createResponse.json();
    const workItemId = created.work_item.goal.work_item_id as string;
    expect(createResponse.status).toBe(201);
    expect(created).toMatchObject({
      source_id: "inbox",
      project: null,
      work_item: {
        goal: {
          title: "Capture through HTTP",
          capture: { kind: "idea", original_title: "Capture through HTTP" },
        },
        state: { phase: "idea", status: "active" },
      },
    });
    expect(created.work_item.goal).not.toHaveProperty("type");

    const detailsResponse = await updatePortfolioWorkItemDetails(
      detailsUpdateRequest({ type: "Feature", priority: "high" }),
      phaseUpdateContext("inbox", workItemId),
    );
    const updated = await detailsResponse.json();
    expect(detailsResponse.status).toBe(200);
    expect(updated).toMatchObject({
      source_id: "inbox",
      work_item: {
        goal: {
          work_item_id: workItemId,
          type: "Feature",
          priority: "high",
          capture: { original_title: "Capture through HTTP" },
        },
      },
    });

    const assignmentResponse = await assignPortfolioWorkItem(
      assignmentRequest({ target_source_id: targetSourceId }),
      phaseUpdateContext("inbox", workItemId),
    );
    const assigned = await assignmentResponse.json();
    expect(assignmentResponse.status).toBe(200);
    expect(assigned).toMatchObject({
      source_id: targetSourceId,
      project: { workspace_path: workspacePath },
      work_item: { goal: { work_item_id: workItemId } },
    });
  });

  it("returns 400 for invalid capture and detail bodies", async () => {
    await createService();

    const captureResponse = await createPortfolioWorkItem(
      captureRequest({ title: "Missing kind" }),
    );
    const detailsResponse = await updatePortfolioWorkItemDetails(
      detailsUpdateRequest({}),
      phaseUpdateContext(
        "inbox",
        "wi_123e4567-e89b-12d3-a456-426614174000",
      ),
    );

    expect(captureResponse.status).toBe(400);
    expect(await captureResponse.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid request" },
    });
    expect(detailsResponse.status).toBe(400);
    expect(await detailsResponse.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid request" },
    });
  });

  it("returns 404 for unknown sources and missing items on new routes", async () => {
    await createService();
    const workItemId = "wi_123e4567-e89b-12d3-a456-426614174000";

    const unknownResponse = await assignPortfolioWorkItem(
      assignmentRequest({ target_source_id: "inbox" }),
      phaseUpdateContext(
        "ws_00000000-0000-4000-8000-000000000000",
        workItemId,
      ),
    );
    const missingResponse = await updatePortfolioWorkItemDetails(
      detailsUpdateRequest({ title: "Still missing" }),
      phaseUpdateContext("inbox", workItemId),
    );

    expect(unknownResponse.status).toBe(404);
    expect(await unknownResponse.json()).toMatchObject({
      error: { code: "unknown_source" },
    });
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toMatchObject({
      error: { code: "work_item_not_found" },
    });
  });

  it("maps transfer collisions and incomplete transfers to 409, never 500", async () => {
    const workItemId = "wi_123e4567-e89b-12d3-a456-426614174000";
    const targetSourceId = "ws_550e8400-e29b-41d4-a716-446655440000";
    const assignWorkItem = vi
      .fn()
      .mockRejectedValueOnce(
        new WorkItemTargetCollisionError(
          "inbox",
          workItemId,
          targetSourceId,
        ),
      )
      .mockRejectedValueOnce(
        new WorkItemTransferFailedError(
          "inbox",
          workItemId,
          targetSourceId,
          "source removal denied",
        ),
      );
    getService.mockResolvedValue({ assignWorkItem });

    const collisionResponse = await assignPortfolioWorkItem(
      assignmentRequest({ target_source_id: targetSourceId }),
      phaseUpdateContext("inbox", workItemId),
    );
    const failedResponse = await assignPortfolioWorkItem(
      assignmentRequest({ target_source_id: targetSourceId }),
      phaseUpdateContext("inbox", workItemId),
    );

    expect(collisionResponse.status).toBe(409);
    expect(await collisionResponse.json()).toMatchObject({
      error: { code: "target_collision" },
    });
    expect(failedResponse.status).toBe(409);
    expect(await failedResponse.json()).toMatchObject({
      error: { code: "transfer_failed" },
    });
  });

  it("returns 400 for a malformed phase-update body", async () => {
    await createService();

    const response = await updatePortfolioWorkItem(
      phaseUpdateRequest({ target_phase: "operate" }),
      phaseUpdateContext(
        "inbox",
        "wi_123e4567-e89b-12d3-a456-426614174000",
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid request" },
    });
  });

  it("returns 404 for an unknown portfolio source", async () => {
    await createService();

    const response = await updatePortfolioWorkItem(
      phaseUpdateRequest({ target_phase: "spec" }),
      phaseUpdateContext(
        "ws_00000000-0000-4000-8000-000000000000",
        "wi_123e4567-e89b-12d3-a456-426614174000",
      ),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "unknown_source",
        message: "Portfolio source not found",
      },
    });
  });

  it("returns 404 for a missing source-qualified work item", async () => {
    await createService();
    const workspacePath = await createWorkspace();
    const registrationResponse = await registerWorkspace(
      registrationRequest(workspacePath),
    );
    const registration = await registrationResponse.json();

    const response = await updatePortfolioWorkItem(
      phaseUpdateRequest({ target_phase: "spec" }),
      phaseUpdateContext(
        registration.workspace.workspace_id,
        "wi_123e4567-e89b-12d3-a456-426614174000",
      ),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "work_item_not_found",
        message: "Work item not found",
      },
    });
  });

  it("returns 409 with a reason for an invalid move", async () => {
    await createService();
    const workspacePath = await createWorkspace();
    const registrationResponse = await registerWorkspace(
      registrationRequest(workspacePath),
    );
    const registration = await registrationResponse.json();
    const sourceId = registration.workspace.workspace_id as string;
    const workItemId = registration.rebuild.items[0].work_item.goal
      .work_item_id as string;

    const response = await updatePortfolioWorkItem(
      phaseUpdateRequest({ target_phase: "plan" }),
      phaseUpdateContext(sourceId, workItemId),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_transition",
        message:
          "Move from Todo to Plan is not allowed; move one column at a time.",
      },
    });
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
