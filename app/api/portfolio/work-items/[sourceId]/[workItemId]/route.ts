import { getPortfolioService } from "../../../../../../src/application/portfolio-service";
import { updateWorkItemPhaseInputSchema } from "../../../../../../src/domain/work-item";
import { MUTATING_REQUEST_MAX_BYTES } from "../../../../request-body";
import { createTrustedMutationRoute } from "./route-factory";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    sourceId: string;
    workItemId: string;
  }>;
}

export const PATCH = createTrustedMutationRoute(
  {
    body: {
      schema: updateWorkItemPhaseInputSchema,
      maxBytes: MUTATING_REQUEST_MAX_BYTES,
    },
  },
  async (validatedInput, _request, context: RouteContext) => {
    const { sourceId, workItemId } = await context.params;
    const service = await getPortfolioService();
    const updated = await service.updateWorkItemPhase(
      sourceId,
      workItemId,
      validatedInput,
    );

    return Response.json(updated);
  },
);
