import { z } from "zod";

import { createShapingPostRoute } from "../../../route-factory";

export const runtime = "nodejs";

const manualIngressRequestSchema = z.strictObject({
  expected_mission_content_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  expected_shaping_state_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const POST = createShapingPostRoute(
  manualIngressRequestSchema,
  (service, sourceId, workItemId, input) =>
    service.openManualIngress(sourceId, workItemId, "spec", input),
);
