import { describe, expect, it } from "vitest";

import {
  InvalidWorkspaceError,
  createWorkItemInputSchema,
  productManifestSchema,
  updateWorkItemPhaseInputSchema,
  workItemGoalSchema,
  workItemSchema,
  workItemStateSchema,
} from "../../src/domain/work-item";

const workItemId = "wi_550e8400-e29b-41d4-a716-446655440000";

const goal = {
  schema_version: 1 as const,
  work_item_id: workItemId,
  title: "Prove the durable contract",
  type: "Explore" as const,
};

const state = {
  schema_version: 1 as const,
  work_item_id: workItemId,
  phase: "idea" as const,
  status: "active" as const,
  updated_at: "2026-07-17T12:00:00.000Z",
};

describe("durable work-item schemas", () => {
  it("accepts the complete version 1 contract", () => {
    expect(
      productManifestSchema.parse({
        schema_version: 1,
        product_name: "Sample Workspace",
      }),
    ).toEqual({ schema_version: 1, product_name: "Sample Workspace" });
    expect(workItemSchema.parse({ goal, state })).toEqual({ goal, state });
  });

  it("accepts brainstorm and rejects the retired explore phase", () => {
    expect(
      workItemStateSchema.parse({ ...state, phase: "brainstorm" }),
    ).toMatchObject({ phase: "brainstorm" });
    expect(() =>
      workItemStateSchema.parse({ ...state, phase: "explore" }),
    ).toThrow();
    expect(
      updateWorkItemPhaseInputSchema.parse({ target_phase: "brainstorm" }),
    ).toEqual({ target_phase: "brainstorm" });
  });

  it("rejects unknown fields instead of silently stripping them", () => {
    expect(() =>
      workItemGoalSchema.parse({ ...goal, provider: "not-in-1.1" }),
    ).toThrow();
    expect(() =>
      workItemStateSchema.parse({ ...state, completed: true }),
    ).toThrow();
  });

  it("rejects malformed IDs, non-trimmed titles, and non-UTC timestamps", () => {
    expect(() =>
      createWorkItemInputSchema.parse({
        title: "  Prove the contract  ",
        type: "Explore",
      }),
    ).toThrow();
    expect(() =>
      workItemGoalSchema.parse({ ...goal, work_item_id: "unsafe/path" }),
    ).toThrow();
    expect(() =>
      workItemStateSchema.parse({
        ...state,
        updated_at: "2026-07-17T06:00:00-06:00",
      }),
    ).toThrow();
  });

  it("requires goal and state IDs to agree", () => {
    expect(() =>
      workItemSchema.parse({
        goal,
        state: {
          ...state,
          work_item_id: "wi_123e4567-e89b-12d3-a456-426614174000",
        },
      }),
    ).toThrow("goal.yaml and state.json work_item_id values must agree");
  });
});

describe("InvalidWorkspaceError", () => {
  it("carries a stable discriminator, artifact path, and reason", () => {
    const error = new InvalidWorkspaceError(
      ".founder/work-items/example/state.json",
      "invalid JSON",
    );

    expect(error).toMatchObject({
      name: "InvalidWorkspaceError",
      kind: "invalid_workspace",
      artifactPath: ".founder/work-items/example/state.json",
      reason: "invalid JSON",
    });
  });
});
