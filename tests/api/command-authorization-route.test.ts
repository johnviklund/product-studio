import { beforeEach, describe, expect, it, vi } from "vitest";

const prepareCommandAuthorization = vi.fn();
const decideCommandAuthorization = vi.fn();

vi.mock("../../src/application/portfolio-service", () => ({
  getPortfolioService: async () => ({
    prepareCommandAuthorization,
    decideCommandAuthorization,
  }),
  getPortfolioTrustedOriginConfig: () => ({
    origin: "http://127.0.0.1:3000",
    host: "127.0.0.1:3000",
  }),
}));

import { POST as decideExecute } from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/connected/command-authorization/decision/route";
import { POST as prepareExecute } from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/connected/command-authorization/prepare/route";
import { POST as decidePatch } from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/patch/connected/command-authorization/decision/route";
import { POST as preparePatch } from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/patch/connected/command-authorization/prepare/route";

const context = {
  params: Promise.resolve({ sourceId: "ws_source", workItemId: "wi_item" }),
};
const trustedHeaders = {
  "content-type": "application/json",
  origin: "http://127.0.0.1:3000",
  host: "127.0.0.1:3000",
};
const decisionInput = {
  decision: "allow_once" as const,
  expected_phase: "execute" as const,
  governed_tuple: {
    goal_version: 2,
    input_revision: 2,
    attempt: 0,
    patch_cycle: 0,
  },
  source_mission_content_sha256: "a".repeat(64),
  terminal_connected_run_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1",
  proposal_sha256: "b".repeat(64),
};

function request(body: unknown, trusted = true): Request {
  return new Request("http://localhost", {
    method: "POST",
    headers: trusted ? trustedHeaders : { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("command-authorization routes", () => {
  beforeEach(() => {
    prepareCommandAuthorization.mockReset();
    decideCommandAuthorization.mockReset();
  });

  it("prepares only Execute and Patch proposals through trusted capped requests", async () => {
    prepareCommandAuthorization.mockResolvedValue({ proposal: "exact" });

    const executeResponse = await prepareExecute(request({}), context);
    const patchResponse = await preparePatch(request({}), context);

    expect(executeResponse.status).toBe(200);
    expect(patchResponse.status).toBe(200);
    expect(prepareCommandAuthorization.mock.calls).toEqual([
      ["ws_source", "wi_item", "execute"],
      ["ws_source", "wi_item", "patch"],
    ]);
  });

  it("rejects an untrusted preparation before service access", async () => {
    const response = await prepareExecute(request({}, false), context);

    expect(response.status).toBe(403);
    expect(prepareCommandAuthorization).not.toHaveBeenCalled();
  });

  it("accepts exact decisions and rejects unknown fields", async () => {
    decideCommandAuthorization.mockResolvedValue({ applied: true });
    const executeResponse = await decideExecute(
      request(decisionInput),
      context,
    );
    const patchInput = {
      ...decisionInput,
      decision: "keep_denied" as const,
      expected_phase: "patch" as const,
    };
    const patchResponse = await decidePatch(request(patchInput), context);
    const invalidResponse = await decideExecute(
      request({ ...decisionInput, unexpected: true }),
      context,
    );

    expect(executeResponse.status).toBe(200);
    expect(patchResponse.status).toBe(200);
    expect(invalidResponse.status).toBe(400);
    expect(decideCommandAuthorization.mock.calls).toEqual([
      ["ws_source", "wi_item", decisionInput],
      ["ws_source", "wi_item", patchInput],
    ]);
  });
});
