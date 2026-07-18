import { getPortfolioService } from "../../../src/application/portfolio-service";
import { errorResponse } from "../responses";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const service = await getPortfolioService();
    return Response.json({ workspaces: await service.listWorkspaces() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const input: unknown = await request.json();
    const service = await getPortfolioService();
    const result = await service.register(input);

    return Response.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
