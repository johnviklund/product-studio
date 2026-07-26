import { z } from "zod";

import { getPortfolioService } from "../../../../../../../../../src/application/portfolio-service";
import { controllerRunIdSchema } from "../../../../../../../../../src/domain/work-item";
import { errorResponse } from "../../../../../../../responses";
import { parseConnectedRequest } from "../request";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    sourceId: string;
    workItemId: string;
  }>;
}

const cancelRequestSchema = z.strictObject({
  connected_run_id: controllerRunIdSchema,
});

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const input = await parseConnectedRequest(request, cancelRequestSchema);
    const { sourceId, workItemId } = await context.params;
    const service = await getPortfolioService();
    const cancelled = await service.cancelConnectedRun(
      sourceId,
      workItemId,
      input.connected_run_id,
    );

    return Response.json(cancelled.connected_run);
  } catch (error) {
    return errorResponse(error);
  }
}
