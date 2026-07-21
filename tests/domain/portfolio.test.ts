import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  INBOX_SOURCE_ID,
  InvalidRegistryError,
  portfolioWorkItemSchema,
  portfolioRegistrySchema,
  registeredWorkspaceSchema,
  workspaceRebuildFailureSchema,
} from "../../src/domain/portfolio";

const workspace = {
  workspace_id: "ws_550e8400-e29b-41d4-a716-446655440000",
  workspace_path: resolve("fixtures/sample-workspace"),
  product_name: "Sample Workspace",
  registered_at: "2026-07-17T12:00:00.000Z",
};

const workItem = {
  goal: {
    schema_version: 1 as const,
    work_item_id: "wi_550e8400-e29b-41d4-a716-446655440000",
    title: "Project the portfolio",
    type: "Feature" as const,
  },
  state: {
    schema_version: 1 as const,
    work_item_id: "wi_550e8400-e29b-41d4-a716-446655440000",
    phase: "brainstorm" as const,
    status: "active" as const,
    updated_at: "2026-07-20T12:00:00.000Z",
  },
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

  it("accepts registered-project and unassigned portfolio items", () => {
    const projectItem = {
      source_id: workspace.workspace_id,
      project: workspace,
      work_item: workItem,
    };
    const inboxItem = {
      source_id: INBOX_SOURCE_ID,
      project: null,
      work_item: workItem,
    };

    expect(portfolioWorkItemSchema.parse(projectItem)).toEqual(projectItem);
    expect(portfolioWorkItemSchema.parse(inboxItem)).toEqual(inboxItem);
  });

  it("keeps source and nullable-project identity consistent", () => {
    expect(() =>
      portfolioWorkItemSchema.parse({
        source_id: INBOX_SOURCE_ID,
        project: workspace,
        work_item: workItem,
      }),
    ).toThrow("source_id must match project.workspace_id");
    expect(() =>
      portfolioWorkItemSchema.parse({
        source_id: workspace.workspace_id,
        project: null,
        work_item: workItem,
      }),
    ).toThrow(`a null project must use source_id ${INBOX_SOURCE_ID}`);
  });

  it("parses rebuild failures for project and inbox sources", () => {
    const projectFailure = {
      source_id: workspace.workspace_id,
      project: workspace,
      reason: "missing state",
    };
    const inboxFailure = {
      source_id: INBOX_SOURCE_ID,
      project: null,
      reason: "invalid manifest",
    };

    expect(workspaceRebuildFailureSchema.parse(projectFailure)).toEqual(
      projectFailure,
    );
    expect(workspaceRebuildFailureSchema.parse(inboxFailure)).toEqual(
      inboxFailure,
    );
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
