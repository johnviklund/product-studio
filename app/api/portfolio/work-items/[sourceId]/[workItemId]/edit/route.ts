import { getPortfolioService } from "../../../../../../../src/application/portfolio-service";
import { saveWorkItemInputSchema } from "../../../../../../../src/domain/work-item";
import { MUTATING_REQUEST_MAX_BYTES } from "../../../../../request-body";
import { createTrustedMutationRoute } from "../route-factory";

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
      schema: saveWorkItemInputSchema,
      maxBytes: MUTATING_REQUEST_MAX_BYTES,
    },
  },
  async (validatedInput, _request, context: RouteContext) => {
    const { sourceId, workItemId } = await context.params;
    const service = await getPortfolioService();
    const updated = await service.saveWorkItem(
      sourceId,
      workItemId,
      validatedInput,
    );

    return Response.json(updated);
  },
);
