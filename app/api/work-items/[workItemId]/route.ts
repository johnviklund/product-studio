import { getSampleWorkItemsService } from "../../../../src/application/sample-workspace";
import { errorResponse, notFoundResponse } from "../responses";

export const runtime = "nodejs";

interface WorkItemRouteContext {
  params: Promise<{ workItemId: string }>;
}

export async function GET(
  _request: Request,
  { params }: WorkItemRouteContext,
): Promise<Response> {
  try {
    const { workItemId } = await params;
    const service = await getSampleWorkItemsService();
    const item = await service.read(workItemId);

    return item === null ? notFoundResponse() : Response.json(item);
  } catch (error) {
    return errorResponse(error);
  }
}
