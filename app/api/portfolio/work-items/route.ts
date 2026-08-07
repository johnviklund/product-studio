import { getPortfolioService } from "../../../../src/application/portfolio-service";
import { createCaptureInputSchema } from "../../../../src/domain/work-item";
import { MUTATING_REQUEST_MAX_BYTES } from "../../request-body";
import { createTrustedMutationRoute } from "./[sourceId]/[workItemId]/route-factory";

export const runtime = "nodejs";

const createPortfolioWorkItem = createTrustedMutationRoute(
  {
    body: {
      schema: createCaptureInputSchema,
      maxBytes: MUTATING_REQUEST_MAX_BYTES,
    },
  },
  async (validatedInput) => {
    const service = await getPortfolioService();
    const created = await service.createCapture(validatedInput);

    return Response.json(created, { status: 201 });
  },
);

export function POST(request: Request): Promise<Response> {
  return createPortfolioWorkItem(request, undefined);
}
