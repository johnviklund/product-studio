import { z } from "zod";

import { createShapingPostRoute } from "../../../route-factory";

export const runtime = "nodejs";

const cancelRequestSchema = z.strictObject({
  shaping_run_id: z.uuid(),
});

export const POST = createShapingPostRoute(
  cancelRequestSchema,
  (service, sourceId, workItemId, input) =>
    service.cancelShapingRun(
      sourceId,
      workItemId,
      input.shaping_run_id,
      "brainstorm",
    ),
);
