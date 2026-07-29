import { compileSpecMissionInputSchema } from "../../../../../../../../../src/application/portfolio";
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
    const validatedInput = compileSpecMissionInputSchema.parse(input);
    const { sourceId, workItemId } = await context.params;
    const service = await getPortfolioService();
    const mission = await service.compileSpecMission(
      sourceId,
      workItemId,
      validatedInput,
    );

    return Response.json(mission);
  } catch (error) {
    return errorResponse(error);
  }
}
