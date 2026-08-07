import { getPortfolioService } from "../../../src/application/portfolio-service";
import { registerWorkspaceInputSchema } from "../../../src/domain/portfolio";
import { MUTATING_REQUEST_MAX_BYTES } from "../request-body";
import { errorResponse } from "../responses";
import { createTrustedMutationRoute } from "../portfolio/work-items/[sourceId]/[workItemId]/route-factory";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const service = await getPortfolioService();
    return Response.json({ workspaces: await service.listWorkspaces() });
  } catch (error) {
    return errorResponse(error);
  }
}

const registerWorkspace = createTrustedMutationRoute(
  {
    body: {
      schema: registerWorkspaceInputSchema,
      maxBytes: MUTATING_REQUEST_MAX_BYTES,
    },
  },
  async (input) => {
    const service = await getPortfolioService();
    const result = await service.register(input);

    return Response.json(result, { status: 201 });
  },
);

export function POST(request: Request): Promise<Response> {
  return registerWorkspace(request, undefined);
}
