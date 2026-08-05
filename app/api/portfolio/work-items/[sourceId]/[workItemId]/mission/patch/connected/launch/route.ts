import { z } from "zod";

import { createConnectedPostRoute } from "../../../../route-factory";

export const runtime = "nodejs";

const launchRequestSchema = z.strictObject({
  model_override: z.string().trim().min(1).max(200).optional(),
});

export const POST = createConnectedPostRoute(
  launchRequestSchema,
  async (service, sourceId, workItemId, input) =>
    (await service.launchConnectedPatch(sourceId, workItemId, input))
      .connected_run,
);
