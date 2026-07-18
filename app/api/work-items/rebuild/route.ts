import { getPortfolioService } from "../../../../src/application/portfolio-service";
import { errorResponse } from "../../responses";

export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  try {
    const service = await getPortfolioService();
    return Response.json(await service.rebuild());
  } catch (error) {
    return errorResponse(error);
  }
}
