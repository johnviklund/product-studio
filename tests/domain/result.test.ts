import { describe, expect, it } from "vitest";

import {
  commandEvidenceRecordSchema,
  createImportRunId,
  externalResultSubmissionSchema,
  hashExternalResult,
  hashResultContent,
  importEvidenceEnvelopeSchema,
  serializeExternalResult,
  type ExternalResultSubmission,
} from "../../src/domain/result";

const submission: ExternalResultSubmission = {
  result_schema_version: 1,
  mission_content_sha256: "a".repeat(64),
  identity: {
    phase: "execute",
    work_item_id: "wi_550e8400-e29b-41d4-a716-446655440000",
    goal_version: 2,
    input_revision: 3,
    attempt: 1,
  },
  commit: "b".repeat(40),
  summary: "Implemented deterministic result import",
  changed_files: ["src/domain/result.ts", "tests/domain/result.test.ts"],
  verification: [{ name: "Tests", status: "passed" }],
};

describe("external result domain", () => {
  it("strictly round-trips canonical result content", () => {
    const serialized = serializeExternalResult(submission);

    expect(
      externalResultSubmissionSchema.parse(JSON.parse(serialized)),
    ).toEqual(submission);
    expect(serialized.endsWith("\n")).toBe(true);
  });

  it.each([
    { name: "extra field", value: { ...submission, provider: "external" } },
    {
      name: "missing field",
      value: { ...submission, summary: undefined },
    },
    { name: "short commit", value: { ...submission, commit: "b".repeat(39) } },
    {
      name: "invalid reported status",
      value: {
        ...submission,
        verification: [{ name: "Tests", status: "timed_out" }],
      },
    },
    {
      name: "unsafe changed file",
      value: { ...submission, changed_files: ["../outside.ts"] },
    },
    {
      name: "duplicate changed file",
      value: {
        ...submission,
        changed_files: ["src/domain/result.ts", "src/domain/result.ts"],
      },
    },
  ])("rejects $name", ({ value }) => {
    expect(() => externalResultSubmissionSchema.parse(value)).toThrow();
  });

  it("derives stable content hashes and import run IDs", () => {
    const content = serializeExternalResult(submission);
    const resultHash = hashResultContent(content);
    const first = createImportRunId(submission.mission_content_sha256, resultHash);
    const second = createImportRunId(submission.mission_content_sha256, resultHash);

    expect(resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashExternalResult(submission)).toBe(resultHash);
    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(
      createImportRunId(
        submission.mission_content_sha256,
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

  it("requires reasons for non-applied evidence", () => {
    const base = {
      schema_version: 1,
      import_run_id: "c".repeat(64),
      result_content_sha256: "d".repeat(64),
      mission_content_sha256: submission.mission_content_sha256,
      identity: submission.identity,
      git_base_commit: "e".repeat(40),
      result_commit: submission.commit,
      controller_run_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1",
      started_at: "2026-07-22T12:00:00.000Z",
      completed_at: "2026-07-22T12:00:01.000Z",
    };

    expect(
      importEvidenceEnvelopeSchema.parse({
        ...base,
        outcome: "rejected",
        reasons: ["Changed file is outside allowed scope"],
      }),
    ).toMatchObject({ outcome: "rejected" });
    expect(() =>
      importEvidenceEnvelopeSchema.parse({
        ...base,
        outcome: "failed",
        reasons: [],
      }),
    ).toThrow();
  });
});
