import { getPortfolioService } from "../../../../../../../src/application/portfolio-service";
import { errorResponse } from "../../../../../responses";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    sourceId: string;
    workItemId: string;
  }>;
}

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { sourceId, workItemId } = await context.params;
    const service = await getPortfolioService();
    const artifacts = await service.listShapingArtifacts(sourceId, workItemId);

    return Response.json(artifacts);
  } catch (error) {
    return errorResponse(error);
  }
}
