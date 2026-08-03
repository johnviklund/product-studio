import type { z } from "zod";

export const CONNECTED_REQUEST_MAX_BYTES = 4 * 1024;
export const SHAPING_REQUEST_MAX_BYTES = 8 * 1024;

export async function readCappedJsonRequest<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes: number,
): Promise<T> {
  if (request.body === null) {
    throw new SyntaxError("Request body is required.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        throw new SyntaxError("Request body exceeds the supported size.");
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return schema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
