import { z } from "zod";

import { createConnectedPostRoute } from "../../../../route-factory";

export const runtime = "nodejs";

const permissionRequestSchema = z.strictObject({
  connected_run_id: z.uuid(),
  operation_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  decision: z.enum(["allow_once", "keep_denied"]),
});

export const POST = createConnectedPostRoute(
  permissionRequestSchema,
  (service, sourceId, workItemId, input) =>
    service.decideConnectedPermission(sourceId, workItemId, input),
);
