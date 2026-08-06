import { commandAuthorizationDecisionInputSchema } from "@/src/domain/work-item";
import { createConnectedPostRoute } from "../../../../route-factory";

export const runtime = "nodejs";

export const POST = createConnectedPostRoute(
  commandAuthorizationDecisionInputSchema,
  (service, sourceId, workItemId, input) =>
    service.decideCommandAuthorization(sourceId, workItemId, input),
);
