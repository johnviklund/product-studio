import { z } from "zod";

import { createConnectedPostRoute } from "../../../../route-factory";

export const runtime = "nodejs";

const cancelRequestSchema = z.strictObject({
  connected_run_id: z.uuid(),
});

export const POST = createConnectedPostRoute(
  cancelRequestSchema,
  async (service, sourceId, workItemId, input) =>
    (
      await service.cancelConnectedPatchRun(
        sourceId,
        workItemId,
        input.connected_run_id,
      )
    ).connected_run,
);
