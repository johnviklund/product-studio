import { z } from "zod";

import { createShapingPostRoute } from "../shaping/route-factory";

export const runtime = "nodejs";

const repairControllerLeaseRequestSchema = z.strictObject({
  acknowledged_run_id: z.uuid(),
});

export const POST = createShapingPostRoute(
  repairControllerLeaseRequestSchema,
  (service, sourceId, workItemId, input) =>
    service.repairRetainedControllerLease(sourceId, workItemId, input),
);
