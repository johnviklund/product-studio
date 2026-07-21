import { describe, expect, it } from "vitest";

import {
  InvalidWorkspaceError,
  WorkItemTargetCollisionError,
  WorkItemTransferFailedError,
  assignWorkItemInputSchema,
  createCaptureInputSchema,
  createWorkItemInputSchema,
  productManifestSchema,
  updateWorkItemDetailsInputSchema,
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

  it("accepts an untyped capture goal with optional metadata", () => {
    const captureGoal = {
      schema_version: 1 as const,
      work_item_id: workItemId,
      title: "Explore a calmer capture flow",
      capture: {
        kind: "idea" as const,
        original_title: "Explore a calmer capture flow",
        captured_at: "2026-07-21T14:00:00.000Z",
      },
      priority: "high" as const,
      tags: ["Front-end", "Question"],
      notes: "Keep the first interaction minimal.",
    };

    expect(workItemGoalSchema.parse(captureGoal)).toEqual(captureGoal);
    expect(workItemSchema.parse({ goal: captureGoal, state })).toEqual({
      goal: captureGoal,
      state,
    });
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

describe("capture and details inputs", () => {
  it("accepts a minimal capture and trims case-preserving tags", () => {
    expect(
      createCaptureInputSchema.parse({
        title: "Capture this idea",
        capture_kind: "idea",
        tags: [" Front-end ", "Question"],
      }),
    ).toEqual({
      title: "Capture this idea",
      capture_kind: "idea",
      tags: ["Front-end", "Question"],
    });

    expect(
      createCaptureInputSchema.parse({
        title: "Project todo",
        capture_kind: "todo",
        source_id: "ws_550e8400-e29b-41d4-a716-446655440000",
      }),
    ).toMatchObject({ capture_kind: "todo" });
  });

  it("rejects empty and case-insensitive duplicate tags", () => {
    expect(() =>
      createCaptureInputSchema.parse({
        title: "Capture this idea",
        capture_kind: "idea",
        tags: ["   "],
      }),
    ).toThrow("tags must not be empty");

    expect(() =>
      createCaptureInputSchema.parse({
        title: "Capture this idea",
        capture_kind: "idea",
        tags: ["Question", "question"],
      }),
    ).toThrow("tags must not contain case-insensitive duplicates");
  });

  it("distinguishes omitted details from explicit clearing", () => {
    expect(updateWorkItemDetailsInputSchema.parse({ title: "Retitled" })).toEqual({
      title: "Retitled",
    });
    expect(
      updateWorkItemDetailsInputSchema.parse({
        type: null,
        priority: null,
        tags: [],
        notes: null,
      }),
    ).toEqual({ type: null, priority: null, tags: [], notes: null });
  });

  it("rejects empty details, provenance edits, and invalid sources", () => {
    expect(() => updateWorkItemDetailsInputSchema.parse({})).toThrow(
      "details update must contain at least one field",
    );
    expect(() =>
      updateWorkItemDetailsInputSchema.parse({ capture_kind: "todo" }),
    ).toThrow();
    expect(() =>
      assignWorkItemInputSchema.parse({ target_source_id: "unknown" }),
    ).toThrow();
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

describe("transfer errors", () => {
  it("carry stable conflict discriminators and transfer context", () => {
    const collision = new WorkItemTargetCollisionError(
      "inbox",
      workItemId,
      "ws_550e8400-e29b-41d4-a716-446655440000",
    );
    const failure = new WorkItemTransferFailedError(
      "inbox",
      workItemId,
      "ws_550e8400-e29b-41d4-a716-446655440000",
      "source removal was denied",
    );

    expect(collision).toMatchObject({
      name: "WorkItemTargetCollisionError",
      kind: "target_collision",
      sourceId: "inbox",
      workItemId,
    });
    expect(failure).toMatchObject({
      name: "WorkItemTransferFailedError",
      kind: "transfer_failed",
      reason: "source removal was denied",
      workItemId,
    });
  });
});
