import { z } from "zod";

import { getPortfolioService } from "../../../../../../../../../src/application/portfolio-service";
import { controllerRunIdSchema } from "../../../../../../../../../src/domain/work-item";
import {
  CONNECTED_REQUEST_MAX_BYTES,
  readCappedJsonRequest,
} from "../../../../../../../request-body";
import { errorResponse } from "../../../../../../../responses";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    sourceId: string;
    workItemId: string;
  }>;
}

const permissionRequestSchema = z.strictObject({
  connected_run_id: controllerRunIdSchema,
  operation_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  decision: z.enum(["allow_once", "keep_denied"]),
});

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const input = await readCappedJsonRequest(
      request,
      permissionRequestSchema,
      CONNECTED_REQUEST_MAX_BYTES,
    );
    const { sourceId, workItemId } = await context.params;
    const service = await getPortfolioService();
    const decided = await service.decideConnectedPermission(
      sourceId,
      workItemId,
      input,
    );

    return Response.json(decided);
  } catch (error) {
    return errorResponse(error);
  }
}
