import { describe, expect, it } from "vitest";

import {
  brainstormMissionPackageSchema,
  brainstormResultSubmissionSchema,
  compileBrainstormMission,
  compileSpecMission,
  hashShapingInput,
  renderShapingTaskMd,
  serializeShapingPackage,
  shapingAcceptanceReceiptSchema,
  shapingImportReceiptSchema,
  specResultSubmissionSchema,
  type BrainstormResultSubmission,
  type ShapingAcceptanceReceipt,
  type ShapingPaths,
  type SpecShapingInput,
} from "../../src/domain/shaping";

const workItemId = "wi_550e8400-e29b-41d4-a716-446655440000";
const brainstormInput = {
  phase: "brainstorm" as const,
  title: "Shape portable missions",
  notes: "Keep shaping independent from execution.",
};

function paths(phase: "brainstorm" | "spec", inputSha256: string): ShapingPaths {
  const directory = `.founder/shaping/${workItemId}/${phase}-${inputSha256}`;
  return {
    task_path: `${directory}/TASK.md`,
    output_path: `${directory}/result.json`,
  };
}

const brainstormInputSha256 = hashShapingInput(brainstormInput);
const brainstormMission = compileBrainstormMission({
  work_item_id: workItemId,
  shaping_input: brainstormInput,
  paths: paths("brainstorm", brainstormInputSha256),
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

const brainstormResultSha256 = "c2f47a4215632219b8c706158a714606c3d26f3338a17f06991bc46268e5b8a1";

const acceptance: ShapingAcceptanceReceipt = {
  shaping_schema_version: 1,
  identity: brainstormMission.identity,
  brainstorm_mission_content_sha256: brainstormMission.content_sha256,
  brainstorm_result_content_sha256: brainstormResultSha256,
  accepted_at: "2026-07-29T00:00:00.000Z",
};

const specInput: SpecShapingInput = {
  phase: "spec",
  title: "Shape portable missions",
  notes: "Keep shaping independent from execution.",
  brainstorm_acceptance_sha256: "d".repeat(64),
  brainstorm_acceptance: acceptance,
  brainstorm_result: brainstormResult,
};

describe("shaping contract", () => {
  it("compiles and serializes a canonical Brainstorm package", () => {
    expect(brainstormMission.identity).toEqual({
      phase: "brainstorm",
      work_item_id: workItemId,
      input_sha256: brainstormInputSha256,
    });
    expect(serializeShapingPackage(brainstormMission)).toMatch(
      /"shaping_schema_version": 1/,
    );
    const task = renderShapingTaskMd(brainstormMission);
    expect(task).toContain(brainstormMission.content_sha256);
    expect(task).toContain(brainstormMission.result_contract.output_path);
  });

  it("canonicalizes shaping inputs independent of object key order", () => {
    const reordered = {
      notes: brainstormInput.notes,
      title: brainstormInput.title,
      phase: brainstormInput.phase,
    };
    expect(hashShapingInput(reordered)).toBe(brainstormInputSha256);
    expect(hashShapingInput({ ...brainstormInput, title: "Changed" })).not.toBe(
      brainstormInputSha256,
    );
    expect(hashShapingInput({ ...brainstormInput, notes: "Changed" })).not.toBe(
      brainstormInputSha256,
    );
  });

  it("pins the selected accepted Brainstorm result in Spec input", () => {
    const inputSha256 = hashShapingInput(specInput);
    const mission = compileSpecMission({
      work_item_id: workItemId,
      shaping_input: specInput,
      paths: paths("spec", inputSha256),
    });
    expect(mission.input.brainstorm_acceptance.identity).toEqual(
      brainstormMission.identity,
    );
    const alternateAcceptance = {
      ...acceptance,
      accepted_at: "2026-07-29T00:00:01.000Z",
    };
    expect(
      hashShapingInput({
        ...specInput,
        brainstorm_acceptance: alternateAcceptance,
        brainstorm_acceptance_sha256: "e".repeat(64),
      }),
    ).not.toBe(inputSha256);
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
      label: "wrong phase",
      value: {
        ...brainstormResult,
        identity: { ...brainstormResult.identity, phase: "spec" },
      },
    },
    {
      label: "bad SHA",
      value: {
        ...brainstormResult,
        brainstorm_mission_content_sha256: "bad",
      },
    },
    {
      label: "unknown fields",
      value: { ...brainstormResult, summary: "not allowed" },
    },
  ])("rejects Brainstorm result $label", ({ value }) => {
    expect(() => brainstormResultSubmissionSchema.parse(value)).toThrow();
  });

  it.each(["/absolute", "../escape", "src/../escape", "src\\windows"])(
    "rejects unsafe allowed scope %s",
    (unsafePath) => {
      expect(() =>
        specResultSubmissionSchema.parse({
          result_schema_version: 1,
          spec_mission_content_sha256: "a".repeat(64),
          identity: {
            phase: "spec",
            work_item_id: workItemId,
            input_sha256: "b".repeat(64),
          },
          proposal: {
            purpose: "Define the bounded contract.",
            acceptance_criteria: ["The contract is strict."],
            non_goals: ["Do not change Execute."],
            allowed_scope: [unsafePath],
            review_ready: ["Checks pass."],
          },
        }),
      ).toThrow();
    },
  );

  it("rejects duplicate Spec proposal entries and unknown proposal fields", () => {
    const submission = {
      result_schema_version: 1,
      spec_mission_content_sha256: "a".repeat(64),
      identity: {
        phase: "spec",
        work_item_id: workItemId,
        input_sha256: "b".repeat(64),
      },
      proposal: {
        purpose: "Define the bounded contract.",
        acceptance_criteria: ["Criterion", "criterion"],
        non_goals: ["Do not change Execute."],
        allowed_scope: ["src/domain"],
        review_ready: ["Checks pass."],
        title: "not agent-authored",
      },
    };
    expect(() => specResultSubmissionSchema.parse(submission)).toThrow();
  });

  it("rejects package identity/hash/path mismatches and unknown fields", () => {
    expect(() =>
      brainstormMissionPackageSchema.parse({
        ...brainstormMission,
        identity: { ...brainstormMission.identity, input_sha256: "0".repeat(64) },
      }),
    ).toThrow("input_sha256 must hash");
    expect(() =>
      brainstormMissionPackageSchema.parse({
        ...brainstormMission,
        task_path: "TASK.md",
      }),
    ).toThrow("task_path must match");
    expect(() =>
      brainstormMissionPackageSchema.parse({
        ...brainstormMission,
        unexpected: true,
      }),
    ).toThrow();
  });

  it("validates bounded immutable import and acceptance receipts", () => {
    expect(
      shapingImportReceiptSchema.parse({
        shaping_schema_version: 1,
        identity: brainstormMission.identity,
        shaping_mission_content_sha256: brainstormMission.content_sha256,
        result_content_sha256: "d".repeat(64),
        outcome: "applied",
        imported_at: "2026-07-29T00:00:00.000Z",
        reasons: [],
      }),
    ).toMatchObject({ outcome: "applied" });
    expect(() =>
      shapingImportReceiptSchema.parse({
        shaping_schema_version: 1,
        identity: brainstormMission.identity,
        shaping_mission_content_sha256: brainstormMission.content_sha256,
        result_content_sha256: "d".repeat(64),
        outcome: "rejected",
        imported_at: "2026-07-29T00:00:00.000Z",
        reasons: Array.from({ length: 21 }, (_, index) => `Reason ${index}`),
      }),
    ).toThrow();
    expect(() =>
      shapingAcceptanceReceiptSchema.parse({ ...acceptance, extra: true }),
    ).toThrow();
  });
});
