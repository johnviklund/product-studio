import { describe, expect, it } from "vitest";

import { hashCanonicalCapabilityRequest } from "../../src/domain/capability-envelope";
import {
  ControllerConflictError,
  InvalidWorkspaceError,
  WORK_ITEM_ATTENTION_KINDS,
  WorkItemTargetCollisionError,
  WorkItemTransferFailedError,
  acceptPatchPlanInputSchema,
  connectedPermissionResolutionInputSchema,
  controllerRunManifestSchema,
  controllerTransitionInputSchema,
  createCaptureInputSchema,
  createWorkItemInputSchema,
  saveWorkItemInputSchema,
  importExternalResultInputSchema,
  importPatchResultInputSchema,
  importReviewResultInputSchema,
  parseWorkItemStateForRead,
  productManifestSchema,
  retryExecuteAttemptInputSchema,
  updateWorkItemPhaseInputSchema,
  workItemGoalSchema,
  workItemAttentionSchema,
  workItemSchema,
  workItemStateSchema,
} from "../../src/domain/work-item";

const workItemId = "wi_550e8400-e29b-41d4-a716-446655440000";
const runId = "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1";
const normalizedPermissionOperation = {
  schema_version: 1 as const,
  kind: "command" as const,
  executable: "/usr/bin/npm",
  args: ["run", "test"],
};
const missingPermissionOperation = {
  normalized_operation: normalizedPermissionOperation,
  canonical_args_sha256: "d".repeat(64),
  operation_sha256: hashCanonicalCapabilityRequest(
    normalizedPermissionOperation,
  ),
  reason: "The command form is not present in the resolved envelope.",
  resolved_envelope_sha256: "e".repeat(64),
  connected_run_id: runId,
};

const goal = {
  schema_version: 2 as const,
  work_item_id: workItemId,
  title: "Prove the durable contract",
  type: "Explore" as const,
};

const state = {
  schema_version: 2 as const,
  work_item_id: workItemId,
  phase: "idea" as const,
  status: "active" as const,
  updated_at: "2026-07-17T12:00:00.000Z",
};

const productManifest = {
  schema_version: 2 as const,
  product_name: "Sample Workspace",
  verification: {
    required_commands: [
      {
        name: "Test",
        argv: ["npm", "test"] as [string, ...string[]],
        timeout_seconds: 120,
      },
      {
        name: "Typecheck",
        argv: ["npm", "run", "typecheck"] as [string, ...string[]],
        timeout_seconds: 120,
      },
    ] as const,
  },
};

describe("durable work-item schemas", () => {
  it("accepts the work-item v2 and product-manifest v2 contracts", () => {
    expect(productManifestSchema.parse(productManifest)).toEqual(
      productManifest,
    );
    expect(workItemSchema.parse({ goal, state })).toEqual({ goal, state });
  });

  it.each([
    {
      name: "a version 1 manifest",
      manifest: { schema_version: 1, product_name: "Sample Workspace" },
    },
    {
      name: "absent verification policy",
      manifest: { schema_version: 2, product_name: "Sample Workspace" },
    },
    {
      name: "no required commands",
      manifest: {
        ...productManifest,
        verification: { required_commands: [] },
      },
    },
    {
      name: "duplicate command names",
      manifest: {
        ...productManifest,
        verification: {
          required_commands: [
            productManifest.verification.required_commands[0],
            {
              ...productManifest.verification.required_commands[0],
              name: "test",
            },
          ],
        },
      },
    },
    {
      name: "a shell command string",
      manifest: {
        ...productManifest,
        verification: {
          required_commands: [
            {
              ...productManifest.verification.required_commands[0],
              argv: "npm test",
            },
          ],
        },
      },
    },
    {
      name: "an empty command name",
      manifest: {
        ...productManifest,
        verification: {
          required_commands: [
            {
              ...productManifest.verification.required_commands[0],
              name: "",
            },
          ],
        },
      },
    },
    ...[0, 901, 1.5].map((timeoutSeconds) => ({
      name: `timeout ${timeoutSeconds}`,
      manifest: {
        ...productManifest,
        verification: {
          required_commands: [
            {
              ...productManifest.verification.required_commands[0],
              timeout_seconds: timeoutSeconds,
            },
          ],
        },
      },
    })),
  ])("rejects $name", ({ manifest }) => {
    expect(() => productManifestSchema.parse(manifest)).toThrow();
  });

  it("accepts an untyped capture goal with optional metadata", () => {
    const captureGoal = {
      schema_version: 2 as const,
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

  it("accepts a complete contracted item with matching controller state", () => {
    const contractedGoal = {
      ...goal,
      goal_contract: {
        schema_version: 1 as const,
        goal_version: 1,
        purpose: "Keep controller revisions safe.",
        acceptance_criteria: ["The controller rejects stale revisions"],
        non_goals: ["Do not bypass revision checks."],
        allowed_scope: ["src/domain"],
        review_ready: ["All deterministic checks pass"],
      },
    };
    const contractedState = {
      ...state,
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
      patch_cycle: 0,
      active_run: {
        run_id: runId,
        idempotency_key: `${workItemId}:spec:1:1:0`,
        acquired_at: "2026-07-21T20:00:00.000Z",
      },
    };

    expect(
      workItemSchema.parse({ goal: contractedGoal, state: contractedState }),
    ).toEqual({ goal: contractedGoal, state: contractedState });
  });

  it("requires patch_cycle for governed state and forbids it on captures", () => {
    expect(() =>
      workItemStateSchema.parse({
        ...state,
        goal_version: 1,
        input_revision: 1,
        attempt: 0,
      }),
    ).toThrow("patch_cycle is required when controller state is present");
    expect(() =>
      workItemStateSchema.parse({ ...state, patch_cycle: 0 }),
    ).toThrow("patch_cycle requires controller state");
  });

  it.each(WORK_ITEM_ATTENTION_KINDS)(
    "round-trips %s attention with exact governed pins",
    (kind) => {
      const attention = {
        kind,
        question: "What decision is required?",
        recommendation: "Open the pinned evidence and decide.",
        created_at: "2026-07-25T15:00:00.000Z",
        governed_tuple: {
          goal_version: 1,
          input_revision: 1,
          attempt: 0,
          patch_cycle: 0,
        },
        pins: {
          artifact_paths: [
            `.founder/work-items/${workItemId}/goal.yaml`,
          ] as [string, ...string[]],
          evidence_paths: [
            `.founder/run-evidence/${workItemId}/execute-1-1-0/result/evidence.json`,
          ],
          git_commit: "a".repeat(40),
          mission_content_sha256: "b".repeat(64),
          result_content_sha256: "c".repeat(64),
        },
        ...(kind === "missing_permission"
          ? { operation: missingPermissionOperation }
          : {}),
      };

      expect(workItemAttentionSchema.parse(attention)).toEqual(attention);
      expect(
        workItemStateSchema.parse({
          ...state,
          goal_version: 1,
          input_revision: 1,
          attempt: 0,
          patch_cycle: 0,
          attention,
        }),
      ).toMatchObject({ attention: { kind } });
    },
  );

  it("requires an exact normalized operation for missing-permission attention only", () => {
    const attention = {
      kind: "missing_permission" as const,
      question: "Should this exact command be allowed once?",
      recommendation: "Keep the command denied unless it is required.",
      created_at: "2026-07-26T18:00:00.000Z",
      governed_tuple: {
        goal_version: 1,
        input_revision: 1,
        attempt: 0,
        patch_cycle: 0,
      },
      pins: {
        artifact_paths: [`.founder/work-items/${workItemId}/goal.yaml`],
        evidence_paths: [],
        mission_content_sha256: "b".repeat(64),
      },
    };

    expect(() => workItemAttentionSchema.parse(attention)).toThrow();
    expect(() =>
      workItemAttentionSchema.parse({
        ...attention,
        operation: {
          ...missingPermissionOperation,
          operation_sha256: "f".repeat(64),
        },
      }),
    ).toThrow("operation_sha256 must hash normalized_operation");
    expect(() =>
      workItemAttentionSchema.parse({
        ...attention,
        kind: "review_ready",
        operation: missingPermissionOperation,
      }),
    ).toThrow();
  });

  it.each(["allow_once", "keep_denied"] as const)(
    "round-trips the %s connected permission resolution identity",
    (decision) => {
      const resolution = {
        decision,
        governed_tuple: {
          goal_version: 1,
          input_revision: 1,
          attempt: 0,
          patch_cycle: 0,
        },
        operation_sha256: missingPermissionOperation.operation_sha256,
        connected_run_id: runId,
        mission_content_sha256: "b".repeat(64),
      };

      expect(
        connectedPermissionResolutionInputSchema.parse(resolution),
      ).toEqual(resolution);
      expect(() =>
        connectedPermissionResolutionInputSchema.parse({
          ...resolution,
          operation_sha256: "not-a-digest",
        }),
      ).toThrow();
      expect(() =>
        connectedPermissionResolutionInputSchema.parse({
          ...resolution,
          extra: true,
        }),
      ).toThrow();
    },
  );

  it("rejects agent-reported cost and model fields in attention", () => {
    const attention = {
      kind: "review_ready",
      question: "What human decision should happen next?",
      recommendation: "Open the pinned review evidence.",
      created_at: "2026-07-25T15:00:00.000Z",
      governed_tuple: {
        goal_version: 1,
        input_revision: 1,
        attempt: 0,
        patch_cycle: 0,
      },
      pins: {
        artifact_paths: [`.founder/work-items/${workItemId}/goal.yaml`],
        evidence_paths: [],
      },
    };

    expect(() =>
      workItemAttentionSchema.parse({ ...attention, model: "agent-reported" }),
    ).toThrow();
    expect(() =>
      workItemAttentionSchema.parse({
        ...attention,
        pins: { ...attention.pins, cost_usd: 1 },
      }),
    ).toThrow();
  });

  it("upgrades v1 state on read without accepting v1 as the active contract", () => {
    const legacyGovernedState = {
      ...state,
      schema_version: 1,
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
    };
    const legacyCaptureState = { ...state, schema_version: 1 };

    expect(parseWorkItemStateForRead(legacyGovernedState)).toEqual({
      ...legacyGovernedState,
      schema_version: 2,
      patch_cycle: 0,
    });
    expect(parseWorkItemStateForRead(legacyCaptureState)).toEqual({
      ...legacyCaptureState,
      schema_version: 2,
    });
    expect(() => workItemStateSchema.parse(legacyGovernedState)).toThrow();
  });

  it.each(["../src/domain", "/src/domain", "src\\domain"])(
    "rejects unsafe allowed_scope path %s",
    (allowedScope) => {
      expect(() =>
        workItemGoalSchema.parse({
          ...goal,
          goal_version: 1,
          acceptance_criteria: ["Reject unsafe scope"],
          allowed_scope: [allowedScope],
          review_ready: ["Checks pass"],
        }),
      ).toThrow();
    },
  );

  it.each([
    {
      name: "partial goal contract",
      item: {
        goal: { ...goal, goal_version: 1 },
        state,
      },
    },
    {
      name: "empty contract list",
      item: {
        goal: {
          ...goal,
          goal_version: 1,
          acceptance_criteria: [],
          allowed_scope: ["src/domain"],
          review_ready: ["Checks pass"],
        },
        state: { ...state, goal_version: 1, input_revision: 1, attempt: 0 },
      },
    },
    {
      name: "case-insensitive duplicate contract entries",
      item: {
        goal: {
          ...goal,
          goal_version: 1,
          acceptance_criteria: ["Reject stale state", "reject stale state"],
          allowed_scope: ["src/domain"],
          review_ready: ["Checks pass"],
        },
        state: { ...state, goal_version: 1, input_revision: 1, attempt: 0 },
      },
    },
    {
      name: "malformed controller version",
      item: {
        goal: {
          ...goal,
          goal_version: 1,
          acceptance_criteria: ["Reject stale state"],
          allowed_scope: ["src/domain"],
          review_ready: ["Checks pass"],
        },
        state: { ...state, goal_version: 1, input_revision: 0, attempt: 0 },
      },
    },
    {
      name: "cross-file version mismatch",
      item: {
        goal: {
          ...goal,
          goal_version: 2,
          acceptance_criteria: ["Reject stale state"],
          allowed_scope: ["src/domain"],
          review_ready: ["Checks pass"],
        },
        state: { ...state, goal_version: 1, input_revision: 2, attempt: 0 },
      },
    },
    {
      name: "controller state without a contract",
      item: {
        goal,
        state: { ...state, goal_version: 1, input_revision: 1, attempt: 0 },
      },
    },
  ])("rejects $name", ({ item }) => {
    expect(() => workItemSchema.parse(item)).toThrow();
  });

  it("validates strict controller inputs and run manifests", () => {
    expect(
      saveWorkItemInputSchema.parse({
        target_source_id: "inbox",
        title: "Reject stale state",
        type: null,
        priority: null,
        tags: [],
        notes: null,
        goal_contract: {
          purpose: "Keep stale state rejected.",
          acceptance_criteria: [" Reject stale state "],
          non_goals: ["Do not accept stale revisions."],
          allowed_scope: ["src/domain"],
          review_ready: ["Checks pass"],
        },
      }),
    ).toMatchObject({
      target_source_id: "inbox",
      title: "Reject stale state",
      goal_contract: {
        purpose: "Keep stale state rejected.",
        acceptance_criteria: ["Reject stale state"],
        non_goals: ["Do not accept stale revisions."],
        allowed_scope: ["src/domain"],
        review_ready: ["Checks pass"],
      },
    });

    expect(() =>
      saveWorkItemInputSchema.parse({
        target_source_id: "inbox",
        title: "Reject stale state",
        type: null,
        priority: null,
        tags: [],
        notes: null,
        goal_contract: {
          purpose: "Keep stale state rejected.",
          acceptance_criteria: ["Reject stale state"],
          non_goals: ["Do not accept stale revisions."],
          allowed_scope: ["src/domain"],
          review_ready: ["Checks pass"],
        },
        expected_goal_version: 1,
      }),
    ).toThrow(
      "expected_goal_version and expected_input_revision must be provided together",
    );

    expect(
      controllerTransitionInputSchema.parse({
        target_phase: "plan",
        target_status: "active",
        expected_phase: "spec",
        expected_status: "active",
        expected_schema_version: 2,
        expected_goal_version: 1,
        expected_input_revision: 1,
        attempt: 0,
      }),
    ).toMatchObject({ target_phase: "plan", expected_schema_version: 2 });

    expect(
      controllerRunManifestSchema.parse({
        schema_version: 1,
        run_id: runId,
        work_item_id: workItemId,
        idempotency_key: `${workItemId}:plan:1:1:0`,
        phase: "plan",
        goal_version: 1,
        input_revision: 1,
        attempt: 0,
        started_at: "2026-07-21T20:00:00.000Z",
        outcome: "pending",
      }),
    ).toMatchObject({ outcome: "pending" });

    const executeExpectation = {
      expected_phase: "execute",
      expected_schema_version: 2,
      expected_goal_version: 1,
      expected_input_revision: 1,
      attempt: 0,
    };
    expect(
      importExternalResultInputSchema.parse({
        ...executeExpectation,
        expected_status: "active",
      }),
    ).toMatchObject({ expected_status: "active" });
    expect(
      retryExecuteAttemptInputSchema.parse({
        ...executeExpectation,
        expected_status: "blocked",
      }),
    ).toMatchObject({ expected_status: "blocked" });
    expect(() =>
      importExternalResultInputSchema.parse({
        ...executeExpectation,
        expected_status: "blocked",
      }),
    ).toThrow();
    expect(
      importReviewResultInputSchema.parse({
        expected_phase: "review",
        expected_status: "active",
        expected_schema_version: 2,
        expected_goal_version: 1,
        expected_input_revision: 1,
        attempt: 0,
        expected_patch_cycle: 0,
      }),
    ).toMatchObject({
      expected_phase: "review",
      expected_status: "active",
      expected_patch_cycle: 0,
    });
    expect(() =>
      importReviewResultInputSchema.parse({
        expected_phase: "execute",
        expected_status: "active",
        expected_schema_version: 2,
        expected_goal_version: 1,
        expected_input_revision: 1,
        attempt: 0,
        expected_patch_cycle: 0,
      }),
    ).toThrow();
    expect(
      acceptPatchPlanInputSchema.parse({
        expected_phase: "review",
        expected_status: "active",
        expected_schema_version: 2,
        expected_goal_version: 1,
        expected_input_revision: 1,
        attempt: 0,
        expected_patch_cycle: 0,
      }),
    ).toMatchObject({ expected_patch_cycle: 0 });
    expect(
      importPatchResultInputSchema.parse({
        expected_phase: "patch",
        expected_status: "active",
        expected_schema_version: 2,
        expected_goal_version: 1,
        expected_input_revision: 1,
        attempt: 0,
        expected_patch_cycle: 1,
      }),
    ).toMatchObject({ expected_phase: "patch", expected_patch_cycle: 1 });
    expect(() =>
      importPatchResultInputSchema.parse({
        expected_phase: "patch",
        expected_status: "active",
        expected_schema_version: 2,
        expected_goal_version: 1,
        expected_input_revision: 1,
        attempt: 0,
        expected_patch_cycle: 0,
      }),
    ).toThrow();
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

describe("ControllerConflictError", () => {
  it("carries a typed conflict kind and work-item context", () => {
    const error = new ControllerConflictError(
      "stale_expectation",
      workItemId,
      "Expected goal version 1 but found 2",
    );

    expect(error).toMatchObject({
      name: "ControllerConflictError",
      kind: "stale_expectation",
      workItemId,
      reason: "Expected goal version 1 but found 2",
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
