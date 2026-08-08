import { applyReviewImportDriftRecoveryInputSchema } from "@/src/domain/work-item";

import {
  createConnectedPostRoute,
  createShapingGetRoute,
} from "../../../route-factory";

export const runtime = "nodejs";

export const GET = createShapingGetRoute(
  (service, sourceId, workItemId) =>
    service.getReviewImportDriftRecoveryProposal(sourceId, workItemId),
);

export const POST = createConnectedPostRoute(
  applyReviewImportDriftRecoveryInputSchema,
  (service, sourceId, workItemId, input) =>
    service.applyReviewImportDriftRecovery(sourceId, workItemId, input),
);
