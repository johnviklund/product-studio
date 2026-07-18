import { getSampleWorkItemsService } from "../../../src/application/sample-workspace";
import { errorResponse } from "./responses";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const service = await getSampleWorkItemsService();
    return Response.json({ items: await service.list() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const input: unknown = await request.json();
    const service = await getSampleWorkItemsService();
    const created = await service.create(input);

    return Response.json(created, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
