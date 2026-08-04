import { z } from "zod";

import { createShapingPostRoute } from "../../../../route-factory";

export const runtime = "nodejs";

const launchRequestSchema = z.strictObject({
  requested_model: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => value === value.trim())
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)),
});

export const POST = createShapingPostRoute(
  launchRequestSchema,
  (service, sourceId, workItemId, input) =>
    service.launchShapingRun(sourceId, workItemId, "spec", input),
);
