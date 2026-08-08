import { beforeEach, describe, expect, it, vi } from "vitest";

const getReviewImportDriftRecoveryProposal = vi.fn();
const applyReviewImportDriftRecovery = vi.fn();

vi.mock("../../src/application/portfolio-service", () => ({
  getPortfolioService: async () => ({
    getReviewImportDriftRecoveryProposal,
    applyReviewImportDriftRecovery,
  }),
  getPortfolioTrustedOriginConfig: () => ({
    origin: "http://127.0.0.1:3000",
    host: "127.0.0.1:3000",
  }),
}));

import {
  GET,
  POST,
} from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/review/import-drift-recovery/route";

const context = {
  params: Promise.resolve({ sourceId: "ws_source", workItemId: "wi_item" }),
};

const input = {
  decision: "accept_exact_drift",
  governed_tuple: {
    goal_version: 2,
    input_revision: 2,
    attempt: 17,
    patch_cycle: 0,
  },
  review_mission_content_sha256: "a".repeat(64),
  result_content_sha256: "b".repeat(64),
  rejected_import_run_id: "c".repeat(64),
  accepted_result_commit: "d".repeat(40),
  current_head_commit: "e".repeat(40),
  proposal_sha256: "f".repeat(64),
};

describe("Review import drift recovery route", () => {
  beforeEach(() => {
    getReviewImportDriftRecoveryProposal.mockReset();
    applyReviewImportDriftRecovery.mockReset();
  });

  it("loads the exact drift proposal without mutating state", async () => {
    getReviewImportDriftRecoveryProposal.mockResolvedValue({ proposal: null });
    const response = await GET(new Request("http://localhost"), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ proposal: null });
    expect(getReviewImportDriftRecoveryProposal).toHaveBeenCalledWith(
      "ws_source",
      "wi_item",
    );
  });

  it("rejects untrusted or widened decisions before service access", async () => {
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
    expect(applyReviewImportDriftRecovery).not.toHaveBeenCalled();
  });

  it("accepts one strict, trusted, hash-bound founder decision", async () => {
    applyReviewImportDriftRecovery.mockResolvedValue({ applied: true });
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
    expect(await response.json()).toEqual({ applied: true });
    expect(applyReviewImportDriftRecovery).toHaveBeenCalledWith(
      "ws_source",
      "wi_item",
      input,
    );
  });
});
