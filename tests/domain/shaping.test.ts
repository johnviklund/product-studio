import { describe, expect, it } from "vitest";

import {
  PLAN_RESULT_REQUIRED_FIELDS,
  SHAPING_DECISION_OPERATIONS,
  SHAPING_INGRESS_MAX_BYTES,
  SHAPING_SCHEMA_VERSION,
  brainstormMissionPackageSchema,
  brainstormResultSubmissionSchema,
  compileBrainstormMission,
  compilePlanMission,
  compileSpecMission,
  goalContractFromSpecProposal,
  hashGoalContract,
  hashGoalInput,
  hashShapingDecisionReceipt,
  hashShapingDecisionState,
  hashShapingIngressInstruction,
  hashShapingInput,
  planIdentitySchema,
  planResultSubmissionSchema,
  planShapingInputSchema,
  renderShapingTaskMd,
  serializeShapingPackage,
  shapingAppliedMarkerSchema,
  shapingDecisionIntentSchema,
  shapingDecisionReceiptSchema,
  shapingIngressInstructionSchema,
  shapingSelectionReceiptSchema,
  specApprovalReceiptSchema,
  specResultSubmissionSchema,
  type BrainstormResultSubmission,
  type PlanResultSubmission,
  type PlanShapingInput,
  type ShapingAppliedMarkerV1,
  type ShapingDecisionIntentV1,
  type ShapingDecisionState,
  type ShapingIngressInstructionV1,
  type ShapingSelectionReceipt,
  type SpecApprovalReceipt,
  type SpecResultSubmission,
  type SpecShapingInput,
} from "../../src/domain/shaping";
import {
  goalContractSchema,
  saveWorkItemInputSchema,
  type GoalContract,
} from "../../src/domain/work-item";

const workItemId = "wi_550e8400-e29b-41d4-a716-446655440000";
const alternateWorkItemId = "wi_123e4567-e89b-12d3-a456-426614174000";
const brainstormInput = {
  phase: "brainstorm" as const,
  title: "Shape portable missions",
  notes: "Keep shaping independent from execution.",
};

const brainstormMission = compileBrainstormMission({
  work_item_id: workItemId,
  shaping_input: brainstormInput,
});

const brainstormResult: BrainstormResultSubmission = {
  result_schema_version: 1,
  brainstorm_mission_content_sha256: brainstormMission.content_sha256,
  identity: brainstormMission.identity,
  problem_statement: "Shaping has no durable mission loop.",
  approach: "Add a separate content-addressed shaping contract.",
  non_goals: ["Do not widen Execute missions."],
  open_questions: ["How should Plan adoption work later?"],
};

const selection: ShapingSelectionReceipt = {
  shaping_schema_version: SHAPING_SCHEMA_VERSION,
  identity: brainstormMission.identity,
  mission_content_sha256: brainstormMission.content_sha256,
  result_content_sha256: "c".repeat(64),
  selected_at: "2026-08-01T12:00:00.000Z",
};

const specInput: SpecShapingInput = {
  phase: "spec",
  title: brainstormInput.title,
  notes: brainstormInput.notes,
  brainstorm_selection_sha256: hashShapingDecisionReceipt(selection),
  brainstorm_selection: selection,
  brainstorm_result: brainstormResult,
};

const specMission = compileSpecMission({
  work_item_id: workItemId,
  shaping_input: specInput,
});

const specResult: SpecResultSubmission = {
  result_schema_version: 1,
  spec_mission_content_sha256: specMission.content_sha256,
  identity: specMission.identity,
  proposal: {
    purpose: "Define the bounded shaping contract.",
    acceptance_criteria: ["The contract is strict."],
    non_goals: ["Do not authorize Execute."],
    allowed_scope: ["components/kanban"],
    review_ready: ["Focused checks pass."],
  },
};

const approvedGoalContract = goalContractFromSpecProposal(
  specResult.proposal,
  1,
);

const approval: SpecApprovalReceipt = {
  shaping_schema_version: SHAPING_SCHEMA_VERSION,
  identity: specMission.identity,
  mission_content_sha256: specMission.content_sha256,
  result_content_sha256: "d".repeat(64),
  goal_contract_sha256: hashGoalContract(approvedGoalContract),
  approved_at: "2026-08-01T12:01:00.000Z",
};

const planInput: PlanShapingInput = {
  phase: "plan",
  title: brainstormInput.title,
  notes: brainstormInput.notes,
  spec_approval_sha256: hashShapingDecisionReceipt(approval),
  spec_approval: approval,
  spec_result: specResult,
  repository_base_commit: "a".repeat(40),
  goal_contract_sha256: approval.goal_contract_sha256,
  goal_version: 1,
};

const planMission = compilePlanMission({
  work_item_id: workItemId,
  shaping_input: planInput,
});

const planResult: PlanResultSubmission = {
  result_schema_version: 1,
  plan_mission_content_sha256: planMission.content_sha256,
  identity: planMission.identity,
  summary: "Implement the approved shaping contract in bounded steps.",
  checklist: [
    {
      id: "domain-contract",
      step: "Update src/domain/shaping.ts with the v2 contract.",
      verification_check: "Run the focused shaping domain suite.",
    },
  ],
  relevant_skills: [],
  product_doc_impacts: ["Update PRODUCT.md after implementation."],
  todo_impacts: [],
  open_questions: [],
};

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectKeys(entry, keys);
    }
    return keys;
  }
  if (value === null || typeof value !== "object") {
    return keys;
  }
  for (const [key, entry] of Object.entries(value)) {
    keys.add(key);
    collectKeys(entry, keys);
  }
  return keys;
}

describe("shaping v2 contract", () => {
  it("compiles canonical path-independent packages for all three phases", () => {
    expect(SHAPING_SCHEMA_VERSION).toBe(2);
    expect([
      brainstormMission.identity.phase,
      specMission.identity.phase,
      planMission.identity.phase,
    ]).toEqual(["brainstorm", "spec", "plan"]);
    expect(planMission.result_contract.required_fields).toEqual(
      PLAN_RESULT_REQUIRED_FIELDS,
    );

    for (const mission of [brainstormMission, specMission, planMission]) {
      expect(mission.result_contract.result_file).toBe("result.json");
      expect(serializeShapingPackage(mission)).toContain(
        '"shaping_schema_version": 2',
      );
      expect(renderShapingTaskMd(mission)).toContain(
        `# ${mission.identity.phase[0]?.toUpperCase()}${mission.identity.phase.slice(1)} shaping task`,
      );
    }
  });

  it("canonicalizes input order and rejects noncanonical package hashes", () => {
    const reordered = {
      notes: brainstormInput.notes,
      title: brainstormInput.title,
      phase: brainstormInput.phase,
    };
    expect(hashShapingInput(reordered)).toBe(
      hashShapingInput(brainstormInput),
    );
    expect(hashShapingInput({ ...brainstormInput, title: "Changed" })).not.toBe(
      brainstormMission.identity.input_sha256,
    );
    expect(() =>
      brainstormMissionPackageSchema.parse({
        ...brainstormMission,
        identity: {
          ...brainstormMission.identity,
          input_sha256: "0".repeat(64),
        },
      }),
    ).toThrow("input_sha256 must hash");
    expect(() =>
      planIdentitySchema.parse({
        ...planMission.identity,
        input_sha256: "A".repeat(64),
      }),
    ).toThrow();
  });

  it.each([
    { label: "empty strings", value: { ...brainstormResult, approach: "" } },
    {
      label: "whitespace strings",
      value: { ...brainstormResult, problem_statement: " padded " },
    },
    { label: "empty lists", value: { ...brainstormResult, non_goals: [] } },
    {
      label: "case-insensitive duplicates",
      value: {
        ...brainstormResult,
        open_questions: ["Question", "question"],
      },
    },
    {
      label: "cross-phase identity",
      value: {
        ...brainstormResult,
        identity: { ...brainstormResult.identity, phase: "spec" },
      },
    },
    {
      label: "unknown fields",
      value: { ...brainstormResult, summary: "not allowed" },
    },
  ])("rejects Brainstorm result $label", ({ value }) => {
    expect(() => brainstormResultSubmissionSchema.parse(value)).toThrow();
  });

  it("rejects duplicate Plan checklist ids and unknown result keys", () => {
    expect(() =>
      planResultSubmissionSchema.parse({
        ...planResult,
        checklist: [
          ...planResult.checklist,
          { ...planResult.checklist[0], id: "DOMAIN-CONTRACT" },
        ],
      }),
    ).toThrow("checklist ids must be unique");
    expect(() =>
      planResultSubmissionSchema.parse({
        ...planResult,
        goal_contract_sha256: "f".repeat(64),
      }),
    ).toThrow();
    expect(() =>
      specResultSubmissionSchema.parse({
        ...specResult,
        capability_envelope: {},
      }),
    ).toThrow();
  });

  it("rejects receipt and embedded-result disagreements", () => {
    expect(() =>
      planShapingInputSchema.parse({
        ...planInput,
        spec_result: {
          ...specResult,
          spec_mission_content_sha256: "f".repeat(64),
        },
      }),
    ).toThrow("approved mission SHA must match");
    expect(() =>
      planShapingInputSchema.parse({
        ...planInput,
        spec_result: {
          ...specResult,
          identity: {
            ...specResult.identity,
            input_sha256: "f".repeat(64),
          },
        },
      }),
    ).toThrow("approved identity must match");
    expect(() =>
      planShapingInputSchema.parse({
        ...planInput,
        goal_contract_sha256: "f".repeat(64),
      }),
    ).toThrow("approved goal-contract SHA must match");
  });

  it("keeps selection and approval receipts phase-specific", () => {
    expect(shapingDecisionReceiptSchema.parse(selection)).toEqual(selection);
    expect(shapingDecisionReceiptSchema.parse(approval)).toEqual(approval);
    expect(() =>
      shapingSelectionReceiptSchema.parse({
        ...selection,
        identity: specMission.identity,
      }),
    ).toThrow();
    expect(() =>
      specApprovalReceiptSchema.parse({
        ...approval,
        identity: brainstormMission.identity,
      }),
    ).toThrow();
  });

  it("makes revisions part of input identity and renders feedback into TASK.md", () => {
    const revisedInput = {
      ...brainstormInput,
      revision: {
        ordinal: 1,
        supersedes_input_sha256: brainstormMission.identity.input_sha256,
        superseded_result_sha256: selection.result_content_sha256,
        feedback: "Make the recovery boundary explicit.",
      },
    };
    const revisedMission = compileBrainstormMission({
      work_item_id: workItemId,
      shaping_input: revisedInput,
    });

    expect(revisedMission.identity.input_sha256).not.toBe(
      brainstormMission.identity.input_sha256,
    );
    expect(renderShapingTaskMd(revisedMission)).toContain(
      "Make the recovery boundary explicit.",
    );
  });

  it("keeps mission content model- and path-independent without banning slashes", () => {
    const first = compileSpecMission({
      work_item_id: workItemId,
      shaping_input: specInput,
      paths: {
        task_path: ".founder/one/TASK.md",
        output_path: ".founder/one/result.json",
      },
    });
    const second = compileSpecMission({
      work_item_id: workItemId,
      shaping_input: specInput,
      paths: {
        task_path: ".founder/two/TASK.md",
        output_path: ".founder/two/result.json",
      },
    });
    expect(first.content_sha256).toBe(second.content_sha256);
    expect(specResultSubmissionSchema.parse(specResult)).toEqual(specResult);
    expect(planResultSubmissionSchema.parse(planResult)).toEqual(planResult);

    const forbiddenKeys = new Set([
      "output_path",
      "task_path",
      "mission_path",
      "ingress_path",
      "result_path",
      "artifact_path",
      "workspace_path",
      "shaping_run_id",
      "run_id",
      "production_id",
      "connected_run_id",
    ]);
    for (const mission of [brainstormMission, specMission, planMission]) {
      const keys = collectKeys(mission);
      for (const forbidden of forbiddenKeys) {
        expect(keys.has(forbidden)).toBe(false);
      }
      expect([...keys].some((key) => key.toLocaleLowerCase().includes("model"))).toBe(
        false,
      );
    }
  });
});

describe("shaping decision hashes", () => {
  const decisionState: ShapingDecisionState = {
    work_item_id: workItemId,
    phase: "spec",
    status: "active",
    goal_input_sha256: "1".repeat(64),
    goal_version: null,
    input_revision: null,
    goal_contract_sha256: null,
    current_mission_input_sha256: null,
    current_mission_content_sha256: null,
    applied_result_content_sha256: null,
    decision_receipt_sha256: null,
    active_shaping_run_id: null,
  };

  it("changes for every state input and preserves explicit nulls", () => {
    const original = hashShapingDecisionState(decisionState);
    const variants: ShapingDecisionState[] = [
      { ...decisionState, work_item_id: alternateWorkItemId },
      { ...decisionState, phase: "plan" },
      { ...decisionState, status: "paused" },
      { ...decisionState, goal_input_sha256: "2".repeat(64) },
      { ...decisionState, goal_version: 1 },
      { ...decisionState, input_revision: 1 },
      { ...decisionState, goal_contract_sha256: "" },
      { ...decisionState, current_mission_input_sha256: "" },
      { ...decisionState, current_mission_content_sha256: "" },
      { ...decisionState, applied_result_content_sha256: "" },
      { ...decisionState, decision_receipt_sha256: "" },
      { ...decisionState, active_shaping_run_id: "" },
    ];

    for (const variant of variants) {
      expect(hashShapingDecisionState(variant)).not.toBe(original);
    }
  });

  it("rejects unknown decision-state keys", () => {
    expect(() =>
      hashShapingDecisionState({
        ...decisionState,
        requested_model: "must-not-participate",
      } as ShapingDecisionState),
    ).toThrow();
  });

  it("normalizes goal text without erasing title or notes changes", () => {
    const canonical = hashGoalInput({
      title: "Cafe\r\nplan  \r\n",
      notes: "First  \r\nSecond\r\n\r\n",
    });
    expect(
      hashGoalInput({
        title: "Cafe\nplan",
        notes: "First\nSecond",
      }),
    ).toBe(canonical);
    expect(hashGoalInput({ title: "Other\nplan", notes: "First\nSecond" })).not.toBe(
      canonical,
    );
    expect(hashGoalInput({ title: "Cafe\nplan", notes: "Changed" })).not.toBe(
      canonical,
    );
  });

  it("maps a Spec proposal to the exact canonical goal contract", () => {
    const contract = goalContractFromSpecProposal(specResult.proposal, 1);
    const replay = goalContractFromSpecProposal(specResult.proposal, 1);
    expect(JSON.stringify(replay)).toBe(JSON.stringify(contract));
    expect(goalContractSchema.parse(contract)).toEqual(contract);
    expect(contract).toEqual({
      schema_version: 1,
      goal_version: 1,
      purpose: specResult.proposal.purpose,
      acceptance_criteria: specResult.proposal.acceptance_criteria,
      non_goals: specResult.proposal.non_goals,
      allowed_scope: specResult.proposal.allowed_scope,
      review_ready: specResult.proposal.review_ready,
    });

    const reordered: GoalContract = {
      review_ready: contract.review_ready,
      allowed_scope: contract.allowed_scope,
      non_goals: contract.non_goals,
      acceptance_criteria: contract.acceptance_criteria,
      purpose: contract.purpose,
      goal_version: contract.goal_version,
      schema_version: contract.schema_version,
    };
    expect(hashGoalContract(reordered)).toBe(hashGoalContract(contract));

    const saveInput = saveWorkItemInputSchema.parse({
      target_source_id: "ws_00000000-0000-4000-8000-000000000000",
      title: brainstormInput.title,
      type: "Feature",
      priority: "normal",
      tags: [],
      notes: brainstormInput.notes,
      goal_contract: specResult.proposal,
    });
    expect(
      goalContractFromSpecProposal(saveInput.goal_contract!, 1),
    ).toEqual(contract);
    expect(contract.goal_version).toBe(1);
  });
});

describe("shaping instructions, intents, and applied markers", () => {
  const instructionDraft: Omit<
    ShapingIngressInstructionV1,
    "instruction_sha256"
  > = {
    schema_version: 1,
    origin: "connected_run",
    shaping_run_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1",
    work_item_id: workItemId,
    phase: "plan",
    mission_input_sha256: planMission.identity.input_sha256,
    mission_content_sha256: planMission.content_sha256,
    task_path: `.founder/shaping/${workItemId}/plan-${planMission.identity.input_sha256}/TASK.md`,
    mission_path: `.founder/shaping/${workItemId}/plan-${planMission.identity.input_sha256}/mission.json`,
    ingress_path: `.founder/shaping-runs/${workItemId}/018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1/ingress/result.json`,
    result_schema_version: 1,
    required_fields: [...PLAN_RESULT_REQUIRED_FIELDS],
    max_result_bytes: SHAPING_INGRESS_MAX_BYTES,
    created_at: "2026-08-01T12:02:00.000Z",
  };
  const instruction: ShapingIngressInstructionV1 = {
    ...instructionDraft,
    instruction_sha256: hashShapingIngressInstruction(instructionDraft),
  };

  it("hashes every instruction field except created_at", () => {
    expect(shapingIngressInstructionSchema.parse(instruction)).toEqual(
      instruction,
    );
    expect(
      hashShapingIngressInstruction({
        ...instructionDraft,
        created_at: "2026-08-01T12:03:00.000Z",
      }),
    ).toBe(instruction.instruction_sha256);

    const coveredChanges: Record<string, unknown>[] = [
      { schema_version: 2 },
      { origin: "manual_import" },
      { shaping_run_id: null },
      { work_item_id: alternateWorkItemId },
      { phase: "spec" },
      { mission_input_sha256: "1".repeat(64) },
      { mission_content_sha256: "2".repeat(64) },
      { task_path: ".founder/alternate/TASK.md" },
      { mission_path: ".founder/alternate/mission.json" },
      { ingress_path: ".founder/alternate/result.json" },
      { result_schema_version: 2 },
      { required_fields: ["identity"] },
      { max_result_bytes: SHAPING_INGRESS_MAX_BYTES - 1 },
    ];
    for (const change of coveredChanges) {
      expect(
        hashShapingIngressInstruction({
          ...instructionDraft,
          ...change,
        } as Omit<ShapingIngressInstructionV1, "instruction_sha256">),
      ).not.toBe(instruction.instruction_sha256);
    }

    expect(() =>
      shapingIngressInstructionSchema.parse({
        ...instruction,
        task_path: ".founder/alternate/TASK.md",
      }),
    ).toThrow("instruction_sha256 must hash");
    expect(
      shapingIngressInstructionSchema.parse({
        ...instruction,
        created_at: "2026-08-01T12:03:00.000Z",
      }).instruction_sha256,
    ).toBe(instruction.instruction_sha256);
  });

  const intent: ShapingDecisionIntentV1 = {
    schema_version: 1,
    decision_id: "1".repeat(64),
    work_item_id: workItemId,
    operation: "start_brainstorm",
    launch_mode: "connected",
    phase_from: "idea",
    phase_to: "brainstorm",
    goal_input_sha256: "2".repeat(64),
    mission_content_sha256: null,
    result_content_sha256: null,
    feedback_sha256: null,
    expected_shaping_state_sha256: "3".repeat(64),
    next_requested_model: "model-a",
    next_mission_content_sha256: brainstormMission.content_sha256,
    next_mission_input_sha256: brainstormMission.identity.input_sha256,
    plan_repository_base_commit: null,
    plan_goal_contract_sha256: null,
    plan_goal_version: null,
    launch_fingerprint: "4".repeat(64),
    previous_goal_bytes: "goal-before\n",
    previous_goal_sha256: "5".repeat(64),
    previous_state_bytes: "state-before\n",
    previous_state_sha256: "6".repeat(64),
    next_goal_bytes: "goal-before\n",
    next_goal_sha256: "5".repeat(64),
    next_state_bytes: "state-after\n",
    next_state_sha256: "7".repeat(64),
    decision_receipt_bytes: null,
    next_mission_package_bytes: serializeShapingPackage(brainstormMission),
    created_at: "2026-08-01T12:04:00.000Z",
  };

  it("requires every next-mission field and accepts all five operations", () => {
    for (const operation of SHAPING_DECISION_OPERATIONS) {
      expect(
        shapingDecisionIntentSchema.parse({ ...intent, operation }).operation,
      ).toBe(operation);
    }
    for (const field of [
      "next_mission_content_sha256",
      "next_mission_input_sha256",
      "next_mission_package_bytes",
    ] as const) {
      expect(() =>
        shapingDecisionIntentSchema.parse({ ...intent, [field]: null }),
      ).toThrow();
    }
  });

  it("binds applied-marker result identity to its component set", () => {
    const marker: ShapingAppliedMarkerV1 = {
      schema_version: 1,
      mission_content_sha256: planMission.content_sha256,
      result_content_sha256: "8".repeat(64),
      component_sha256: {
        result: "8".repeat(64),
        import: "9".repeat(64),
        production: "a".repeat(64),
      },
      component_bytes: { result: 100, import: 200, production: 300 },
      committed_at: "2026-08-01T12:05:00.000Z",
    };
    expect(shapingAppliedMarkerSchema.parse(marker)).toEqual(marker);
    expect(() =>
      shapingAppliedMarkerSchema.parse({
        ...marker,
        component_sha256: {
          ...marker.component_sha256,
          result: "b".repeat(64),
        },
      }),
    ).toThrow("result component hash must equal");
    expect(() =>
      shapingAppliedMarkerSchema.parse({
        ...marker,
        component_bytes: { result: 100, import: 200 },
      }),
    ).toThrow();
  });
});
