import { z } from "zod";

const MAX_CONNECTED_REQUEST_BYTES = 4 * 1024;

export async function parseConnectedRequest<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  const source = await request.text();
  if (new TextEncoder().encode(source).byteLength > MAX_CONNECTED_REQUEST_BYTES) {
    throw new SyntaxError("Connected request body exceeds the supported size.");
  }
  return schema.parse(JSON.parse(source));
}
