import { approveReviewResultInputSchema } from "@/src/domain/work-item";

import { createConnectedPostRoute } from "../../../route-factory";

export const runtime = "nodejs";

export const POST = createConnectedPostRoute(
  approveReviewResultInputSchema,
  (service, sourceId, workItemId, input) =>
    service.approveReviewResult(sourceId, workItemId, input),
);
