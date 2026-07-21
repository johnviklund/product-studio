import { getPortfolioService } from "../../../../../../../src/application/portfolio-service";
import { updateWorkItemDetailsInputSchema } from "../../../../../../../src/domain/work-item";
import { errorResponse } from "../../../../../responses";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    sourceId: string;
    workItemId: string;
  }>;
}

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const input: unknown = await request.json();
    const validatedInput = updateWorkItemDetailsInputSchema.parse(input);
    const { sourceId, workItemId } = await context.params;
    const service = await getPortfolioService();
    const updated = await service.updateWorkItemDetails(
      sourceId,
      workItemId,
      validatedInput,
    );

    return Response.json(updated);
  } catch (error) {
    return errorResponse(error);
  }
}
