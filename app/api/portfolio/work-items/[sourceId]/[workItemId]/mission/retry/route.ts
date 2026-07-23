import { getPortfolioService } from "../../../../../../../../src/application/portfolio-service";
import { errorResponse } from "../../../../../../responses";

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
    const retried = await service.retryExecuteAttempt(sourceId, workItemId);

    return Response.json(retried);
  } catch (error) {
    return errorResponse(error);
  }
}
