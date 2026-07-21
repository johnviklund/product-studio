import { getPortfolioService } from "../../../../../../../src/application/portfolio-service";
import { assignWorkItemInputSchema } from "../../../../../../../src/domain/work-item";
import { errorResponse } from "../../../../../responses";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    sourceId: string;
    workItemId: string;
  }>;
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const input: unknown = await request.json();
    const validatedInput = assignWorkItemInputSchema.parse(input);
    const { sourceId, workItemId } = await context.params;
    const service = await getPortfolioService();
    const assigned = await service.assignWorkItem(
      sourceId,
      workItemId,
      validatedInput,
    );

    return Response.json(assigned);
  } catch (error) {
    return errorResponse(error);
  }
}
