import { importSpecResultInputSchema } from "../../../../../../../../../src/application/portfolio";
import { getPortfolioService } from "../../../../../../../../../src/application/portfolio-service";
import { errorResponse } from "../../../../../../../responses";

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
    const validatedInput = importSpecResultInputSchema.parse(input);
    const { sourceId, workItemId } = await context.params;
    const service = await getPortfolioService();
    const result = await service.importSpecResult(
      sourceId,
      workItemId,
      validatedInput,
    );

    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
