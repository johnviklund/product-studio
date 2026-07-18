import { getSampleWorkItemsService } from "../../../../src/application/sample-workspace";
import { errorResponse } from "../responses";

export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  try {
    const service = await getSampleWorkItemsService();
    return Response.json({ items: await service.rebuild() });
  } catch (error) {
    return errorResponse(error);
  }
}
