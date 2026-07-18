import { getPortfolioService } from "../../../src/application/portfolio-service";
import { errorResponse } from "../responses";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const service = await getPortfolioService();
    return Response.json({ items: await service.list() });
  } catch (error) {
    return errorResponse(error);
  }
}
