import { getPortfolioService } from "../../../../../../../../src/application/portfolio-service";
import { createTrustedMutationRoute } from "../../route-factory";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    sourceId: string;
    workItemId: string;
  }>;
}

export const POST = createTrustedMutationRoute(
  { body: null },
  async (_input, _request, context: RouteContext) => {
    const { sourceId, workItemId } = await context.params;
    const service = await getPortfolioService();
    const imported = await service.importResult(sourceId, workItemId);

    return Response.json(imported);
  },
);
