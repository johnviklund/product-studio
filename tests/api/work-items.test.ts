import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import { WorkItemsService } from "../../src/application/work-items";
import { SQLiteWorkItemIndex } from "../../src/index/work-item-index";
import { ProductWorkspace } from "../../src/workspace/product-workspace";

const getSampleService = vi.hoisted(() => vi.fn());

vi.mock("../../src/application/sample-workspace", () => ({
  getSampleWorkItemsService: getSampleService,
}));

import {
  GET as getWorkItems,
  POST as createWorkItem,
} from "../../app/api/work-items/route";
import { GET as getWorkItem } from "../../app/api/work-items/[workItemId]/route";
import { POST as rebuildWorkItems } from "../../app/api/work-items/rebuild/route";

const createdRoots: string[] = [];
const openIndexes: SQLiteWorkItemIndex[] = [];
const missingId = "wi_123e4567-e89b-12d3-a456-426614174000";

async function createService(): Promise<{
  root: string;
  service: WorkItemsService;
  workspace: ProductWorkspace;
}> {
  const root = await mkdtemp(join(tmpdir(), "product-studio-api-"));
  createdRoots.push(root);

  const founderDirectory = join(root, ".founder");
  await mkdir(founderDirectory, { recursive: true });
  await writeFile(
    join(founderDirectory, "product.yaml"),
    stringify({ schema_version: 1, product_name: "API Workspace" }),
    "utf8",
  );

  const workspace = new ProductWorkspace(root);
  const index = new SQLiteWorkItemIndex(":memory:");
  const service = new WorkItemsService(workspace, index);
  openIndexes.push(index);
  getSampleService.mockResolvedValue(service);

  return { root, service, workspace };
}

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/work-items", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  getSampleService.mockReset();
});

afterEach(async () => {
  for (const index of openIndexes.splice(0)) {
    index.close();
  }
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("work-item API routes", () => {
  it("creates a durable item and returns it through collection and item routes", async () => {
    await createService();

    const createResponse = await createWorkItem(
      postRequest({ title: "Create through HTTP", type: "Feature" }),
    );
    const created = await createResponse.json();

    expect(createResponse.status).toBe(201);
    expect(created).toMatchObject({
      goal: { title: "Create through HTTP", type: "Feature" },
      state: { phase: "idea", status: "active" },
    });

    const collectionResponse = await getWorkItems();
    expect(collectionResponse.status).toBe(200);
    expect(await collectionResponse.json()).toEqual({ items: [created] });

    const itemResponse = await getWorkItem(
      new Request(`http://localhost/api/work-items/${created.goal.work_item_id}`),
      { params: Promise.resolve({ workItemId: created.goal.work_item_id }) },
    );
    expect(itemResponse.status).toBe(200);
    expect(await itemResponse.json()).toEqual(created);
  });

  it.each([
    [{ title: "", type: "Feature" }, "empty title"],
    [{ title: "Unknown type", type: "Unknown" }, "unknown type"],
  ])("returns 400 for %s (%s)", async (body) => {
    await createService();

    const response = await createWorkItem(postRequest(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "Invalid work-item request",
      },
    });
  });

  it("returns 404 when a durable work item is absent", async () => {
    await createService();

    const response = await getWorkItem(
      new Request(`http://localhost/api/work-items/${missingId}`),
      { params: Promise.resolve({ workItemId: missingId }) },
    );

    expect(response.status).toBe(404);
  });

  it("returns 422 with path and reason for invalid durable data", async () => {
    const { root } = await createService();
    const itemDirectory = join(root, ".founder", "work-items", missingId);
    await mkdir(itemDirectory, { recursive: true });
    await writeFile(
      join(itemDirectory, "goal.yaml"),
      stringify({
        schema_version: 1,
        work_item_id: missingId,
        title: "Partial item",
        type: "Fix",
      }),
      "utf8",
    );

    const response = await getWorkItem(
      new Request(`http://localhost/api/work-items/${missingId}`),
      { params: Promise.resolve({ workItemId: missingId }) },
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body).toMatchObject({
      error: {
        code: "invalid_workspace",
        artifact_path: `.founder/work-items/${missingId}/state.json`,
      },
    });
    expect(body.error.message).toContain("required file is missing");
  });

  it("rebuilds the disposable index from durable files", async () => {
    const { workspace } = await createService();
    const durable = await workspace.create({
      title: "Rebuild through HTTP",
      type: "Maintenance",
    });

    const response = await rebuildWorkItems();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [durable] });
  });
});
