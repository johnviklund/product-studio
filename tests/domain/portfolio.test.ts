import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  InvalidRegistryError,
  portfolioRegistrySchema,
  registeredWorkspaceSchema,
} from "../../src/domain/portfolio";

const workspace = {
  workspace_id: "ws_550e8400-e29b-41d4-a716-446655440000",
  workspace_path: resolve("fixtures/sample-workspace"),
  product_name: "Sample Workspace",
  registered_at: "2026-07-17T12:00:00.000Z",
};

describe("portfolio schemas", () => {
  it("accepts the complete version 1 registry contract", () => {
    expect(
      portfolioRegistrySchema.parse({
        schema_version: 1,
        workspaces: [workspace],
      }),
    ).toEqual({ schema_version: 1, workspaces: [workspace] });
  });

  it("rejects relative paths and malformed workspace IDs", () => {
    expect(() =>
      registeredWorkspaceSchema.parse({
        ...workspace,
        workspace_path: "fixtures/sample-workspace",
      }),
    ).toThrow("workspace_path must be absolute");
    expect(() =>
      registeredWorkspaceSchema.parse({
        ...workspace,
        workspace_id: "workspace-1",
      }),
    ).toThrow("workspace_id must use the ws_<uuid> format");
  });

  it("rejects wrong registry versions and unknown fields", () => {
    expect(() =>
      portfolioRegistrySchema.parse({
        schema_version: 2,
        workspaces: [workspace],
      }),
    ).toThrow();
    expect(() =>
      registeredWorkspaceSchema.parse({ ...workspace, provider: "local" }),
    ).toThrow();
  });
});

describe("InvalidRegistryError", () => {
  it("carries a stable discriminator, artifact path, and reason", () => {
    const error = new InvalidRegistryError(
      ".local-data/registry.json",
      "invalid JSON",
    );

    expect(error).toMatchObject({
      name: "InvalidRegistryError",
      kind: "invalid_registry",
      artifactPath: ".local-data/registry.json",
      reason: "invalid JSON",
    });
  });
});
