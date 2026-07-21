import { getPortfolioService } from "../../../../src/application/portfolio-service";
import { createCaptureInputSchema } from "../../../../src/domain/work-item";
import { errorResponse } from "../../responses";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    const input: unknown = await request.json();
    const validatedInput = createCaptureInputSchema.parse(input);
    const service = await getPortfolioService();
    const created = await service.createCapture(validatedInput);

    return Response.json(created, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
