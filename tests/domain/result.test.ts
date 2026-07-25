import { describe, expect, it } from "vitest";

import type { PatchReviewSubject } from "../../src/domain/mission";
import {
  commandEvidenceRecordSchema,
  createImportRunId,
  externalResultSubmissionSchema,
  hashExternalResult,
  hashResultContent,
  importEvidenceEnvelopeSchema,
  importEvidenceSummarySchema,
  patchExternalResultSubmissionSchema,
  patchReviewExternalResultSubmissionSchema,
  reviewExternalResultSubmissionSchema,
  reviewExternalResultSubmissionForSubjectSchema,
  reviewFindingLinkSchema,
  serializeExternalResult,
  type ExecuteExternalResultSubmission,
  type ExecuteReviewExternalResultSubmission,
  type PatchExternalResultSubmission,
  type PatchReviewExternalResultSubmission,
  type ReviewFindingLink,
} from "../../src/domain/result";

const workItemId = "wi_550e8400-e29b-41d4-a716-446655440000";

const executeSubmission: ExecuteExternalResultSubmission = {
  result_schema_version: 2,
  mission_content_sha256: "a".repeat(64),
  identity: {
    phase: "execute",
    work_item_id: workItemId,
    goal_version: 2,
    input_revision: 3,
    attempt: 1,
  },
  commit: "b".repeat(40),
  summary: "Implemented deterministic result import",
  changed_files: ["src/domain/result.ts", "tests/domain/result.test.ts"],
  verification: [{ name: "Tests", status: "passed" }],
};

const reviewSubmission: ExecuteReviewExternalResultSubmission = {
  result_schema_version: 2,
  review_mission_content_sha256: "c".repeat(64),
  identity: {
    phase: "review",
    work_item_id: workItemId,
    goal_version: 2,
    input_revision: 3,
    attempt: 1,
  },
  execute_mission_content_sha256: executeSubmission.mission_content_sha256,
  execute_result_content_sha256: "d".repeat(64),
  git_base_commit: "e".repeat(40),
  accepted_result_commit: executeSubmission.commit,
  summary: "One acceptance criterion is not satisfied.",
  verdict: "findings",
  findings: [
    {
      finding_id: "finding-1",
      severity: "P1",
      title: "Missing strict review rejection",
      evidence: {
        path: "src/domain/result.ts",
        summary: "The review branch accepts changed_files.",
      },
      required_action: "Reject every execute-only result field.",
      link: {
        type: "acceptance_criteria",
        criterion: "Strict review outputs reject changed files.",
      },
    },
  ],
};

const patchSubmission: PatchExternalResultSubmission = {
  result_schema_version: 2,
  patch_mission_content_sha256: "1".repeat(64),
  identity: {
    phase: "patch",
    work_item_id: workItemId,
    goal_version: 2,
    input_revision: 3,
    attempt: 1,
    patch_cycle: 1,
  },
  commit: "2".repeat(40),
  summary: "Applied the bounded repair.",
  changed_files: ["src/domain/result.ts", "tests/domain/result.test.ts"],
  verification: [{ name: "Tests", status: "passed" }],
};

const patchReviewSubject: PatchReviewSubject = {
  source: "patch",
  patch_cycle: 1,
  patch_mission_content_sha256: patchSubmission.patch_mission_content_sha256,
  patch_result_content_sha256: "3".repeat(64),
  patch_mission_path: `.founder/missions/${workItemId}/patch-2-3-1-1/mission.json`,
  patch_evidence_path: `.founder/run-evidence/${workItemId}/patch-2-3-1-1/${"4".repeat(64)}`,
  git_base_commit: "5".repeat(40),
  accepted_result_commit: patchSubmission.commit,
  changed_files: patchSubmission.changed_files,
  command_evidence: [
    {
      name: "Tests",
      argv: ["npm", "test"],
      started_at: "2026-07-22T12:00:00.000Z",
      completed_at: "2026-07-22T12:00:01.000Z",
      duration_ms: 1000,
      status: "passed",
      exit_code: 0,
      signal: null,
      stdout: "green",
      stderr: "",
      output_truncated: false,
    },
  ],
  resolved_from: {
    review_mission_content_sha256: "6".repeat(64),
    review_result_content_sha256: "7".repeat(64),
    finding_ids: ["finding-1", "finding-2"],
  },
};

const patchReviewSubmission: PatchReviewExternalResultSubmission = {
  result_schema_version: 2,
  review_mission_content_sha256: "8".repeat(64),
  identity: reviewSubmission.identity,
  patch_mission_content_sha256:
    patchReviewSubject.patch_mission_content_sha256,
  patch_result_content_sha256: patchReviewSubject.patch_result_content_sha256,
  git_base_commit: patchReviewSubject.git_base_commit,
  accepted_result_commit: patchReviewSubject.accepted_result_commit,
  summary: "Both assigned findings are resolved.",
  verdict: "clean",
  findings: [],
  resolutions: [
    { finding_id: "finding-1", status: "resolved" },
    { finding_id: "finding-2", status: "resolved" },
  ],
};

describe("external result domain", () => {
  it("strictly round-trips canonical execute result content", () => {
    const serialized = serializeExternalResult(executeSubmission);

    expect(
      externalResultSubmissionSchema.parse(JSON.parse(serialized)),
    ).toEqual(executeSubmission);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(hashExternalResult(executeSubmission)).toBe(
      "f0bd6e16c6ec77abe0f8bf124e6d5ec2eecc9ebb9d6be8dfa084944f2d8bd62f",
    );
  });

  it.each([
    {
      name: "extra field",
      value: { ...executeSubmission, provider: "external" },
    },
    {
      name: "missing field",
      value: { ...executeSubmission, summary: undefined },
    },
    {
      name: "legacy result version",
      value: { ...executeSubmission, result_schema_version: 1 },
    },
    {
      name: "tuple-only identity",
      value: {
        ...executeSubmission,
        identity: { ...executeSubmission.identity, phase: undefined },
      },
    },
    {
      name: "short commit",
      value: { ...executeSubmission, commit: "b".repeat(39) },
    },
    {
      name: "invalid reported status",
      value: {
        ...executeSubmission,
        verification: [{ name: "Tests", status: "timed_out" }],
      },
    },
    {
      name: "unsafe changed file",
      value: { ...executeSubmission, changed_files: ["../outside.ts"] },
    },
    {
      name: "duplicate changed file",
      value: {
        ...executeSubmission,
        changed_files: ["src/domain/result.ts", "src/domain/result.ts"],
      },
    },
  ])("rejects execute result with $name", ({ value }) => {
    expect(() => externalResultSubmissionSchema.parse(value)).toThrow();
  });

  it("round-trips and stably hashes a strict patch result", () => {
    const serialized = serializeExternalResult(patchSubmission);
    const reordered: PatchExternalResultSubmission = {
      verification: patchSubmission.verification,
      changed_files: patchSubmission.changed_files,
      summary: patchSubmission.summary,
      commit: patchSubmission.commit,
      identity: patchSubmission.identity,
      patch_mission_content_sha256:
        patchSubmission.patch_mission_content_sha256,
      result_schema_version: patchSubmission.result_schema_version,
    };

    expect(
      patchExternalResultSubmissionSchema.parse(JSON.parse(serialized)),
    ).toEqual(patchSubmission);
    expect(externalResultSubmissionSchema.parse(JSON.parse(serialized))).toEqual(
      patchSubmission,
    );
    expect(hashExternalResult(reordered)).toBe(
      hashExternalResult(patchSubmission),
    );
    expect(serializeExternalResult(patchSubmission)).toContain(
      '"patch_cycle": 1',
    );
    const resultHash = hashResultContent(serialized);
    expect(
      createImportRunId(
        patchSubmission.patch_mission_content_sha256,
        resultHash,
      ),
    ).toBe(
      createImportRunId(
        patchSubmission.patch_mission_content_sha256,
        resultHash,
      ),
    );
  });

  it.each([
    { name: "budget", extra: { budget: 100 } },
    { name: "model", extra: { model: "provider-model" } },
  ])("rejects agent-reported $name metadata on patch results", ({ extra }) => {
    expect(() =>
      patchExternalResultSubmissionSchema.parse({
        ...patchSubmission,
        ...extra,
      }),
    ).toThrow();
  });

  it("strictly round-trips and hashes canonical review result content", () => {
    const serialized = serializeExternalResult(reviewSubmission);

    expect(
      reviewExternalResultSubmissionSchema.parse(JSON.parse(serialized)),
    ).toEqual(reviewSubmission);
    expect(externalResultSubmissionSchema.parse(JSON.parse(serialized))).toEqual(
      reviewSubmission,
    );
    expect(hashExternalResult(reviewSubmission)).toBe(
      "a215c3e52af91389c5abd40fac2535a1fa6147a807dca6bced6eda95be6c0f86",
    );
    expect(
      createImportRunId(
        reviewSubmission.review_mission_content_sha256,
        hashResultContent(serialized),
      ),
    ).toBe(
      createImportRunId(
        reviewSubmission.review_mission_content_sha256,
        hashResultContent(serialized),
      ),
    );
  });

  it("binds canonical review hashes to the exact immutable subject", () => {
    const reordered: ExecuteReviewExternalResultSubmission = {
      findings: reviewSubmission.findings,
      verdict: reviewSubmission.verdict,
      summary: reviewSubmission.summary,
      accepted_result_commit: reviewSubmission.accepted_result_commit,
      git_base_commit: reviewSubmission.git_base_commit,
      execute_result_content_sha256:
        reviewSubmission.execute_result_content_sha256,
      execute_mission_content_sha256:
        reviewSubmission.execute_mission_content_sha256,
      identity: reviewSubmission.identity,
      review_mission_content_sha256:
        reviewSubmission.review_mission_content_sha256,
      result_schema_version: reviewSubmission.result_schema_version,
    };
    const originalHash = hashExternalResult(reviewSubmission);
    const reboundSubjects: ExecuteReviewExternalResultSubmission[] = [
      {
        ...reviewSubmission,
        execute_mission_content_sha256: "1".repeat(64),
      },
      {
        ...reviewSubmission,
        execute_result_content_sha256: "2".repeat(64),
      },
      { ...reviewSubmission, git_base_commit: "3".repeat(40) },
      { ...reviewSubmission, accepted_result_commit: "4".repeat(40) },
    ];

    expect(hashExternalResult(reordered)).toBe(originalHash);
    for (const rebound of reboundSubjects) {
      expect(hashExternalResult(rebound)).not.toBe(originalHash);
    }
  });

  it("round-trips and stably hashes a patch-subject review result", () => {
    const serialized = serializeExternalResult(patchReviewSubmission);
    const reordered: PatchReviewExternalResultSubmission = {
      resolutions: patchReviewSubmission.resolutions,
      findings: patchReviewSubmission.findings,
      verdict: patchReviewSubmission.verdict,
      summary: patchReviewSubmission.summary,
      accepted_result_commit: patchReviewSubmission.accepted_result_commit,
      git_base_commit: patchReviewSubmission.git_base_commit,
      patch_result_content_sha256:
        patchReviewSubmission.patch_result_content_sha256,
      patch_mission_content_sha256:
        patchReviewSubmission.patch_mission_content_sha256,
      identity: patchReviewSubmission.identity,
      review_mission_content_sha256:
        patchReviewSubmission.review_mission_content_sha256,
      result_schema_version: patchReviewSubmission.result_schema_version,
    };

    expect(
      patchReviewExternalResultSubmissionSchema.parse(JSON.parse(serialized)),
    ).toEqual(patchReviewSubmission);
    expect(
      reviewExternalResultSubmissionForSubjectSchema(
        patchReviewSubject,
      ).parse(JSON.parse(serialized)),
    ).toEqual(patchReviewSubmission);
    expect(hashExternalResult(reordered)).toBe(
      hashExternalResult(patchReviewSubmission),
    );
    expect(() =>
      reviewExternalResultSubmissionForSubjectSchema(
        patchReviewSubject,
      ).parse({
        ...patchReviewSubmission,
        patch_result_content_sha256: "9".repeat(64),
      }),
    ).toThrow("must match the patch review subject");
  });

  it.each([
    {
      name: "unknown IDs",
      resolutions: [
        { finding_id: "finding-1", status: "resolved" },
        { finding_id: "finding-3", status: "resolved" },
      ],
    },
    {
      name: "missing IDs",
      resolutions: [{ finding_id: "finding-1", status: "resolved" }],
    },
    {
      name: "duplicate IDs",
      resolutions: [
        { finding_id: "finding-1", status: "resolved" },
        { finding_id: "finding-1", status: "resolved" },
      ],
    },
    {
      name: "reordered IDs",
      resolutions: [
        { finding_id: "finding-2", status: "resolved" },
        { finding_id: "finding-1", status: "resolved" },
      ],
    },
  ])("rejects patch-review resolution coverage with $name", ({ resolutions }) => {
    expect(() =>
      reviewExternalResultSubmissionForSubjectSchema(
        patchReviewSubject,
      ).parse({
        ...patchReviewSubmission,
        resolutions,
      }),
    ).toThrow();
  });

  it("requires every unresolved assigned finding to remain structured", () => {
    expect(() =>
      reviewExternalResultSubmissionForSubjectSchema(
        patchReviewSubject,
      ).parse({
        ...patchReviewSubmission,
        resolutions: [
          { finding_id: "finding-1", status: "unresolved" },
          { finding_id: "finding-2", status: "resolved" },
        ],
      }),
    ).toThrow("unresolved resolution requires a matching current finding");
  });

  it.each([
    {
      name: "changed_files",
      value: { ...reviewSubmission, changed_files: [] },
    },
    { name: "commit", value: { ...reviewSubmission, commit: "f".repeat(40) } },
    {
      name: "verification",
      value: { ...reviewSubmission, verification: [] },
    },
    { name: "extension", value: { ...reviewSubmission, provider: "external" } },
    {
      name: "legacy result version",
      value: { ...reviewSubmission, result_schema_version: 1 },
    },
    {
      name: "tuple-only identity",
      value: {
        ...reviewSubmission,
        identity: { ...reviewSubmission.identity, phase: undefined },
      },
    },
  ])("rejects review result with $name", ({ value }) => {
    expect(() => reviewExternalResultSubmissionSchema.parse(value)).toThrow();
  });

  it("enforces explicit clean and findings verdict invariants", () => {
    expect(() =>
      reviewExternalResultSubmissionSchema.parse({
        ...reviewSubmission,
        verdict: "clean",
      }),
    ).toThrow("clean review results must not contain findings");
    expect(() =>
      reviewExternalResultSubmissionSchema.parse({
        ...reviewSubmission,
        findings: [],
      }),
    ).toThrow("findings review results require at least one finding");
    expect(() =>
      reviewExternalResultSubmissionSchema.parse({
        ...reviewSubmission,
        findings: [reviewSubmission.findings[0], reviewSubmission.findings[0]],
      }),
    ).toThrow("finding_id values must be unique");
    expect(
      reviewExternalResultSubmissionSchema.parse({
        ...reviewSubmission,
        verdict: "clean",
        findings: [],
      }),
    ).toMatchObject({ verdict: "clean", findings: [] });
  });

  it.each<ReviewFindingLink>([
    {
      type: "acceptance_criteria",
      criterion: "The result is deterministic.",
    },
    { type: "non_goals", non_goal: "Do not add a provider adapter." },
    { type: "defect", evidence_summary: "A strict field is accepted." },
    { type: "security", evidence_summary: "A path escapes the workspace." },
    { type: "deterministic_checks", command: "npm test" },
  ])("accepts exact $type finding links", (link) => {
    expect(reviewFindingLinkSchema.parse(link)).toEqual(link);
  });

  it.each([
    {
      name: "cross-variant field",
      value: {
        type: "acceptance_criteria",
        criterion: "The result is deterministic.",
        non_goal: "Do not add a provider adapter.",
      },
    },
    {
      name: "missing discriminator field",
      value: { type: "non_goals", criterion: "Not the non-goal field." },
    },
    {
      name: "non-canonical command target",
      value: { type: "deterministic_checks", command: " npm test" },
    },
  ])("rejects inexact finding link with $name", ({ value }) => {
    expect(() => reviewFindingLinkSchema.parse(value)).toThrow();
  });

  it("derives stable content hashes and import run IDs", () => {
    const content = serializeExternalResult(executeSubmission);
    const resultHash = hashResultContent(content);
    const first = createImportRunId(
      executeSubmission.mission_content_sha256,
      resultHash,
    );
    const second = createImportRunId(
      executeSubmission.mission_content_sha256,
      resultHash,
    );

    expect(resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashExternalResult(executeSubmission)).toBe(resultHash);
    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(
      createImportRunId(
        executeSubmission.mission_content_sha256,
        hashResultContent(`${content} `),
      ),
    ).not.toBe(first);
  });

  it("validates executed and explicit not-run command evidence", () => {
    expect(
      commandEvidenceRecordSchema.parse({
        name: "Tests",
        argv: ["npm", "test"],
        started_at: "2026-07-22T12:00:00.000Z",
        completed_at: "2026-07-22T12:00:01.000Z",
        duration_ms: 1000,
        status: "passed",
        exit_code: 0,
        signal: null,
        stdout: "green",
        stderr: "",
        output_truncated: false,
      }),
    ).toMatchObject({ status: "passed" });
    expect(
      commandEvidenceRecordSchema.parse({
        name: "Build",
        argv: ["npm", "run", "build"],
        started_at: null,
        completed_at: null,
        duration_ms: 0,
        status: "not_run",
        exit_code: null,
        signal: null,
        stdout: "",
        stderr: "",
        output_truncated: false,
      }),
    ).toMatchObject({ status: "not_run" });
  });

  it("requires phase-bound v2 evidence and reasons for non-applied outcomes", () => {
    const executeEvidence = {
      schema_version: 2,
      phase: "execute",
      import_run_id: "c".repeat(64),
      result_content_sha256: "d".repeat(64),
      mission_content_sha256: executeSubmission.mission_content_sha256,
      identity: executeSubmission.identity,
      git_base_commit: "e".repeat(40),
      result_commit: executeSubmission.commit,
      controller_run_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1",
      started_at: "2026-07-22T12:00:00.000Z",
      completed_at: "2026-07-22T12:00:01.000Z",
      outcome: "rejected",
      reasons: ["Changed file is outside allowed scope"],
    } as const;

    expect(importEvidenceEnvelopeSchema.parse(executeEvidence)).toEqual(
      executeEvidence,
    );
    expect(() =>
      importEvidenceEnvelopeSchema.parse({
        ...executeEvidence,
        outcome: "failed",
        reasons: [],
      }),
    ).toThrow();
    expect(() =>
      importEvidenceEnvelopeSchema.parse({
        ...executeEvidence,
        schema_version: 1,
      }),
    ).toThrow();
    expect(() =>
      importEvidenceEnvelopeSchema.parse({
        ...executeEvidence,
        identity: { ...executeEvidence.identity, phase: "review" },
      }),
    ).toThrow();

    expect(
      importEvidenceEnvelopeSchema.parse({
        ...executeEvidence,
        phase: "review",
        identity: reviewSubmission.identity,
        mission_content_sha256:
          reviewSubmission.review_mission_content_sha256,
        result_commit: reviewSubmission.accepted_result_commit,
        outcome: "applied",
        reasons: [],
      }),
    ).toMatchObject({ phase: "review", outcome: "applied" });

    const patchEvidence = {
      ...executeEvidence,
      phase: "patch",
      identity: patchSubmission.identity,
      mission_content_sha256: patchSubmission.patch_mission_content_sha256,
      result_commit: patchSubmission.commit,
      outcome: "applied",
      reasons: [],
    } as const;
    expect(importEvidenceEnvelopeSchema.parse(patchEvidence)).toEqual(
      patchEvidence,
    );
    expect(
      importEvidenceSummarySchema.parse({
        phase: "patch",
        import_run_id: patchEvidence.import_run_id,
        outcome: patchEvidence.outcome,
        evidence_path: `.founder/run-evidence/${workItemId}/patch-2-3-1-1/${patchEvidence.import_run_id}/evidence.json`,
        reasons: [],
      }),
    ).toMatchObject({ phase: "patch", outcome: "applied" });
  });
});
