import { beforeEach, describe, expect, it, vi } from "vitest";

const approveReviewResult = vi.fn();

vi.mock("../../src/application/portfolio-service", () => ({
  getPortfolioService: async () => ({ approveReviewResult }),
  getPortfolioTrustedOriginConfig: () => ({
    origin: "http://127.0.0.1:3000",
    host: "127.0.0.1:3000",
  }),
}));

import { POST } from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/review/approve/route";

const context = {
  params: Promise.resolve({ sourceId: "ws_source", workItemId: "wi_item" }),
};

const input = {
  expected_phase: "review",
  expected_status: "active",
  expected_schema_version: 2,
  expected_goal_version: 2,
  expected_input_revision: 2,
  attempt: 12,
  expected_patch_cycle: 0,
  expected_review_mission_content_sha256: "a".repeat(64),
  expected_result_content_sha256: "b".repeat(64),
  expected_evidence_path: `.founder/run-evidence/wi_item/review-2-2-12/${"c".repeat(64)}`,
  expected_result_commit: "d".repeat(40),
};

describe("Review approval route", () => {
  beforeEach(() => {
    approveReviewResult.mockReset();
  });

  it("rejects untrusted or widened approval before service access", async () => {
    const untrusted = await POST(
      new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
      context,
    );
    expect(untrusted.status).toBe(403);

    const widened = await POST(
      new Request("http://localhost", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://127.0.0.1:3000",
          host: "127.0.0.1:3000",
        },
        body: JSON.stringify({ ...input, force: true }),
      }),
      context,
    );
    expect(widened.status).toBe(400);
    expect(approveReviewResult).not.toHaveBeenCalled();
  });

  it("accepts one strict trusted approval bound to the displayed result", async () => {
    approveReviewResult.mockResolvedValue({ approved: true });
    const response = await POST(
      new Request("http://localhost", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://127.0.0.1:3000",
          host: "127.0.0.1:3000",
        },
        body: JSON.stringify(input),
      }),
      context,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ approved: true });
    expect(approveReviewResult).toHaveBeenCalledWith(
      "ws_source",
      "wi_item",
      input,
    );
  });
});
