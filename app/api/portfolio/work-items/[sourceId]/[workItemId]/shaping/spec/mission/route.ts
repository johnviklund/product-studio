import { z } from "zod";

import { createShapingPostRoute } from "../../route-factory";

export const runtime = "nodejs";

const missionRequestSchema = z.strictObject({});

export const POST = createShapingPostRoute(
  missionRequestSchema,
  (service, sourceId, workItemId) =>
    service.compileSpecMission(sourceId, workItemId),
);
