import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readCappedJsonRequest } from "../../app/api/request-body";

const requestSchema = z.strictObject({ message: z.string() });

describe("capped JSON request reader", () => {
  it("parses and validates a body under the byte budget", async () => {
    const source = JSON.stringify({ message: "hello" });
    const request = new Request("http://127.0.0.1:3000/api/shaping", {
      method: "POST",
      body: source,
    });

    await expect(
      readCappedJsonRequest(
        request,
        requestSchema,
        new TextEncoder().encode(source).byteLength,
      ),
    ).resolves.toEqual({ message: "hello" });
  });

  it("throws one byte over budget, cancels, and never waits for the remainder", async () => {
    const maxBytes = 8;
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new Uint8Array(maxBytes + 1));
          return;
        }
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = { body } as Request;

    await expect(
      readCappedJsonRequest(request, requestSchema, maxBytes),
    ).rejects.toThrow(SyntaxError);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(2);
  });
});
