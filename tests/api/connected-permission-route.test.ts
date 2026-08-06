import { beforeEach, describe, expect, it, vi } from "vitest";

const decideConnectedPermission = vi.fn();

vi.mock("../../src/application/portfolio-service", () => ({
  getPortfolioService: async () => ({ decideConnectedPermission }),
  getPortfolioTrustedOriginConfig: () => ({
    origin: "http://127.0.0.1:3000",
    host: "127.0.0.1:3000",
  }),
}));

import { POST as decideExecute } from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/connected/permission/route";
import { POST as decidePatch } from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/patch/connected/permission/route";

const context = {
  params: Promise.resolve({ sourceId: "ws_source", workItemId: "wi_item" }),
};
const trustedHeaders = {
  "content-type": "application/json",
  origin: "http://127.0.0.1:3000",
  host: "127.0.0.1:3000",
};
const input = {
  connected_run_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1",
  operation_sha256: "a".repeat(64),
  decision: "retry_without_allowing" as const,
};

function request(body: unknown): Request {
  return new Request("http://localhost", {
    method: "POST",
    headers: trustedHeaders,
    body: JSON.stringify(body),
  });
}

describe("connected-permission routes", () => {
  beforeEach(() => {
    decideConnectedPermission.mockReset();
    decideConnectedPermission.mockResolvedValue({ applied: true });
  });

  it("accepts retry without allowing for Execute and Patch", async () => {
    const executeResponse = await decideExecute(request(input), context);
    const patchResponse = await decidePatch(request(input), context);

    expect(executeResponse.status).toBe(200);
    expect(patchResponse.status).toBe(200);
    expect(decideConnectedPermission.mock.calls).toEqual([
      ["ws_source", "wi_item", input],
      ["ws_source", "wi_item", input],
    ]);
  });
});
