import { createShapingGetRoute } from "../../../route-factory";

export const runtime = "nodejs";

export const GET = createShapingGetRoute(
  (service, sourceId, workItemId) =>
    service.getConnectedModelOptions(sourceId, workItemId),
);
