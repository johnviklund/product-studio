import { z } from "zod";

import { getPortfolioService } from "../../../../../../../../../src/application/portfolio-service";
import { errorResponse } from "../../../../../../../responses";
import { parseConnectedRequest } from "../request";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    sourceId: string;
    workItemId: string;
  }>;
}

const launchRequestSchema = z.strictObject({
  model_override: z.string().trim().min(1).max(200).optional(),
});

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const input = await parseConnectedRequest(request, launchRequestSchema);
    const { sourceId, workItemId } = await context.params;
    const service = await getPortfolioService();
    const launched = await service.launchConnectedExecute(
      sourceId,
      workItemId,
      input,
    );

    return Response.json(launched.connected_run);
  } catch (error) {
    return errorResponse(error);
  }
}
