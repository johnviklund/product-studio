import { cp, mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProductWorkspace } from "../src/workspace/product-workspace";

const repositoryRoot = process.cwd();
const fixtureRoot = join(repositoryRoot, "fixtures", "sample-workspace");
const createdRoots: string[] = [];

function registrationRequest(workspacePath: string): Request {
  return new Request("http://localhost/api/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace_path: workspacePath }),
  });
}

afterEach(async () => {
  process.chdir(repositoryRoot);
  vi.resetModules();
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("portfolio rebuild completion signal", () => {
  it("reconstructs project and inbox sources after deleting SQLite", async () => {
    const root = await mkdtemp(join(tmpdir(), "product-studio-completion-"));
    createdRoots.push(root);
    const firstWorkspace = join(root, "first-workspace");
    const secondWorkspace = join(root, "second-workspace");
    await cp(fixtureRoot, firstWorkspace, { recursive: true });
    await cp(fixtureRoot, secondWorkspace, { recursive: true });
    process.chdir(root);
    vi.resetModules();

    const workspaceRoutes = await import("../app/api/workspaces/route");
    const workItemRoutes = await import("../app/api/work-items/route");
    await workspaceRoutes.POST(registrationRequest(firstWorkspace));
    await workspaceRoutes.POST(registrationRequest(secondWorkspace));
    const inbox = new ProductWorkspace(join(root, ".portfolio", "inbox"));
    await inbox.create({
      title: "Durable unassigned item",
      type: "Explore",
    });
    const initialRebuildRoutes = await import(
      "../app/api/work-items/rebuild/route"
    );
    await initialRebuildRoutes.POST();
    const before = await (await workItemRoutes.GET()).json();

    expect(before.items).toHaveLength(3);
    const identities = before.items.map(
      (item: {
        source_id: string;
        work_item: { goal: { work_item_id: string } };
      }) => `${item.source_id}:${item.work_item.goal.work_item_id}`,
    );
    expect(new Set(identities).size).toBe(3);
    expect(
      identities.filter((identity: string) => identity.startsWith("inbox:")),
    ).toHaveLength(1);
    expect(
      identities.filter(
        (identity: string) =>
          identity.startsWith("ws_") &&
          identity.endsWith(":wi_550e8400-e29b-41d4-a716-446655440000"),
      ),
    ).toHaveLength(2);

    await unlink(join(root, ".local-data", "index.sqlite"));
    vi.resetModules();

    const rebuildRoutes = await import("../app/api/work-items/rebuild/route");
    const rebuiltWorkItemRoutes = await import("../app/api/work-items/route");
    const rebuildResponse = await rebuildRoutes.POST();
    const rebuild = await rebuildResponse.json();
    const after = await (await rebuiltWorkItemRoutes.GET()).json();

    expect(rebuildResponse.status).toBe(200);
    expect(rebuild.failures).toEqual([]);
    expect(after).toEqual(before);
  });
});
