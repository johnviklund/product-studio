import { z } from "zod";

import { createConnectedPostRoute } from "../../../../route-factory";

export const runtime = "nodejs";

export const POST = createConnectedPostRoute(
  z.strictObject({}),
  (service, sourceId, workItemId) =>
    service.prepareCommandAuthorization(sourceId, workItemId, "execute"),
);
