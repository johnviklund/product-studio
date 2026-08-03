import { z } from "zod";

import { createShapingPostRoute } from "../../route-factory";

export const runtime = "nodejs";

const retryLaunchRequestSchema = z.strictObject({
  decision_id: z.string().regex(/^[0-9a-f]{64}$/u),
  expected_shaping_state_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const POST = createShapingPostRoute(
  retryLaunchRequestSchema,
  (service, sourceId, workItemId, input) =>
    service.retryShapingLaunch(sourceId, workItemId, "plan", input),
);
