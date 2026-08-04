import { createShapingGetRoute } from "../../../../route-factory";

export const runtime = "nodejs";

export const GET = createShapingGetRoute(
  (service, sourceId, workItemId) =>
    service.listShapingRuns(sourceId, workItemId, "brainstorm"),
);
