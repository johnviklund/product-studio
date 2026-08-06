import { beforeEach, describe, expect, it, vi } from "vitest";

const getScopeCorrectionProposal = vi.fn();
const applyScopeCorrection = vi.fn();

vi.mock("../../src/application/portfolio-service", () => ({
  getPortfolioService: async () => ({
    getScopeCorrectionProposal,
    applyScopeCorrection,
  }),
  getPortfolioTrustedOriginConfig: () => ({
    origin: "http://127.0.0.1:3000",
    host: "127.0.0.1:3000",
  }),
}));

import {
  GET,
  POST,
} from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/scope-correction/route";

const context = {
  params: Promise.resolve({ sourceId: "ws_source", workItemId: "wi_item" }),
};

const input = {
  source_goal_contract_sha256: "a".repeat(64),
  governed_tuple: {
    goal_version: 1,
    input_revision: 1,
    attempt: 4,
    patch_cycle: 0,
  },
  proposal_sha256: "b".repeat(64),
};

describe("scope-correction route", () => {
  beforeEach(() => {
    getScopeCorrectionProposal.mockReset();
    applyScopeCorrection.mockReset();
  });

  it("loads the founder proposal without mutating state", async () => {
    getScopeCorrectionProposal.mockResolvedValue({ proposal: null });
    const response = await GET(new Request("http://localhost"), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ proposal: null });
    expect(getScopeCorrectionProposal).toHaveBeenCalledWith(
      "ws_source",
      "wi_item",
    );
  });

  it("rejects an untrusted decision before service access", async () => {
    const response = await POST(
      new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
      context,
    );
    expect(response.status).toBe(403);
    expect(applyScopeCorrection).not.toHaveBeenCalled();
  });

  it("accepts one capped, strict, trusted decision", async () => {
    applyScopeCorrection.mockResolvedValue({ applied: true });
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
    expect(applyScopeCorrection).toHaveBeenCalledWith(
      "ws_source",
      "wi_item",
      input,
    );
  });
});
