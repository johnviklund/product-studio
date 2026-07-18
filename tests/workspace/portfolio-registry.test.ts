import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { InvalidRegistryError } from "../../src/domain/portfolio";
import { PortfolioRegistry } from "../../src/workspace/portfolio-registry";

const createdRoots: string[] = [];

const workspace = {
  workspace_id: "ws_550e8400-e29b-41d4-a716-446655440000",
  workspace_path: "/products/sample",
  product_name: "Sample Workspace",
  registered_at: "2026-07-17T12:00:00.000Z",
};

async function createRegistry(): Promise<{
  root: string;
  registryPath: string;
  registry: PortfolioRegistry;
}> {
  const root = await mkdtemp(join(tmpdir(), "product-studio-registry-"));
  createdRoots.push(root);
  const registryPath = join(root, ".local-data", "registry.json");
  return {
    root,
    registryPath,
    registry: new PortfolioRegistry(registryPath),
  };
}

afterEach(async () => {
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("PortfolioRegistry", () => {
  it("treats a missing registry as empty", async () => {
    const { registry } = await createRegistry();

    await expect(registry.read()).resolves.toEqual([]);
  });

  it("fails closed for malformed and incompatible registries", async () => {
    const { registryPath, registry } = await createRegistry();
    await mkdir(dirname(registryPath), { recursive: true });
    await writeFile(registryPath, "{invalid", "utf8");

    await expect(registry.read()).rejects.toBeInstanceOf(InvalidRegistryError);

    await writeFile(
      registryPath,
      `${JSON.stringify({ schema_version: 2, workspaces: [] })}\n`,
      "utf8",
    );
    await expect(registry.read()).rejects.toMatchObject({
      kind: "invalid_registry",
      artifactPath: registryPath,
    });
  });

  it("never overwrites a corrupt durable registry", async () => {
    const { registryPath, registry } = await createRegistry();
    await mkdir(dirname(registryPath), { recursive: true });
    await writeFile(registryPath, "{invalid", "utf8");

    await expect(registry.append(workspace)).rejects.toBeInstanceOf(
      InvalidRegistryError,
    );
    await expect(readFile(registryPath, "utf8")).resolves.toBe("{invalid");
  });

  it("rejects a registry symlink", async () => {
    const { root, registryPath, registry } = await createRegistry();
    const targetPath = join(root, "target.json");
    await mkdir(dirname(registryPath), { recursive: true });
    await writeFile(targetPath, '{"schema_version":1,"workspaces":[]}\n', "utf8");
    await symlink(targetPath, registryPath);

    await expect(registry.read()).rejects.toMatchObject({
      kind: "invalid_registry",
      artifactPath: registryPath,
    });
  });

  it("atomically appends an exact version 1 entry without leaving temp files", async () => {
    const { registryPath, registry } = await createRegistry();

    await registry.append(workspace);

    expect(JSON.parse(await readFile(registryPath, "utf8"))).toEqual({
      schema_version: 1,
      workspaces: [workspace],
    });
    await expect(registry.read()).resolves.toEqual([workspace]);
    expect(await readdir(dirname(registryPath))).toEqual(["registry.json"]);
  });
});
