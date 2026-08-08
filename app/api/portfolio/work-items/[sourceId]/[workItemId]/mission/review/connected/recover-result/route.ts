import { z } from "zod";

import { createConnectedPostRoute } from "../../../../route-factory";

export const runtime = "nodejs";

const recoverResultRequestSchema = z.strictObject({
  review_mission_content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  result_content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  recovery_trigger_connected_run_id: z.uuid(),
});

export const POST = createConnectedPostRoute(
  recoverResultRequestSchema,
  async (service, sourceId, workItemId, input) =>
    service.recoverConnectedReviewResult(sourceId, workItemId, input),
);
