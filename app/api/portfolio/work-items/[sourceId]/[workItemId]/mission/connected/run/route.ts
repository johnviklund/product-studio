import { getPortfolioService } from "../../../../../../../../../src/application/portfolio-service";
import { errorResponse } from "../../../../../../../responses";

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

    return Response.json(
      await service.listConnectedRunsForPhase(
        sourceId,
        workItemId,
        "execute",
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
