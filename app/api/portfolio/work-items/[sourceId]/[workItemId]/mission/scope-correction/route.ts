import { applyScopeCorrectionInputSchema } from "../../../../../../../../src/domain/work-item";
import {
  createConnectedPostRoute,
  createShapingGetRoute,
} from "../../route-factory";

export const runtime = "nodejs";

export const GET = createShapingGetRoute(
  (service, sourceId, workItemId) =>
    service.getScopeCorrectionProposal(sourceId, workItemId),
);

export const POST = createConnectedPostRoute(
  applyScopeCorrectionInputSchema,
  (service, sourceId, workItemId, input) =>
    service.applyScopeCorrection(sourceId, workItemId, input),
);
