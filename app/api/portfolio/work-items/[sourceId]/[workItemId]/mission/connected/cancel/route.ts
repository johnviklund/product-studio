import { z } from "zod";

import { controllerRunIdSchema } from "../../../../../../../../../src/domain/work-item";
import { createConnectedPostRoute } from "../../../route-factory";

export const runtime = "nodejs";

const cancelRequestSchema = z.strictObject({
  connected_run_id: controllerRunIdSchema,
});

export const POST = createConnectedPostRoute(
  cancelRequestSchema,
  async (service, sourceId, workItemId, input) =>
    (
      await service.cancelConnectedRun(
        sourceId,
        workItemId,
        input.connected_run_id,
      )
    ).connected_run,
);
