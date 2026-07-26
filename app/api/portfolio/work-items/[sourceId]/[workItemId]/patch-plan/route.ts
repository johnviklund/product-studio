import { getPortfolioService } from "../../../../../../../src/application/portfolio-service";
import { errorResponse } from "../../../../../responses";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    sourceId: string;
    workItemId: string;
  }>;
}

export async function POST(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { sourceId, workItemId } = await context.params;
    const service = await getPortfolioService();
    const accepted = await service.acceptPatchPlan(sourceId, workItemId);

    return Response.json(accepted);
  } catch (error) {
    return errorResponse(error);
  }
}
