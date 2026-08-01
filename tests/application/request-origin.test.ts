import { describe, expect, it } from "vitest";

import {
  assertTrustedRequestOrigin,
  readTrustedOriginConfig,
  UntrustedRequestOriginError,
} from "../../src/application/request-origin";

const configuredOrigin = "http://127.0.0.1:3000";

function trustedRequest(
  origin: string | null = configuredOrigin,
  host: string | null = "127.0.0.1:3000",
  additionalHeaders: Record<string, string> = {},
): Request {
  const headers = new Headers(additionalHeaders);
  if (origin !== null) {
    headers.set("origin", origin);
  }
  if (host !== null) {
    headers.set("host", host);
  }

  return new Request(`${configuredOrigin}/api/shaping`, {
    method: "POST",
    headers,
  });
}

describe("trusted application origin", () => {
  it("reads and normalizes one exact loopback origin", () => {
    expect(
      readTrustedOriginConfig({
        PRODUCT_STUDIO_APP_ORIGIN: configuredOrigin,
      }),
    ).toEqual({
      origin: configuredOrigin,
      host: "127.0.0.1:3000",
    });
    expect(
      readTrustedOriginConfig({
        PRODUCT_STUDIO_APP_ORIGIN: "http://[::1]:3000",
      }),
    ).toEqual({
      origin: "http://[::1]:3000",
      host: "[::1]:3000",
    });
  });

  it.each([
    ["missing", {}],
    ["unset", { PRODUCT_STUDIO_APP_ORIGIN: undefined }],
    ["empty", { PRODUCT_STUDIO_APP_ORIGIN: "" }],
    ["wildcard", { PRODUCT_STUDIO_APP_ORIGIN: "*" }],
    [
      "configured list",
      {
        PRODUCT_STUDIO_APP_ORIGIN:
          "http://127.0.0.1:3000,http://127.0.0.1:4000",
      },
    ],
    [
      "trailing slash",
      { PRODUCT_STUDIO_APP_ORIGIN: "http://127.0.0.1:3000/" },
    ],
    [
      "path",
      { PRODUCT_STUDIO_APP_ORIGIN: "http://127.0.0.1:3000/app" },
    ],
    [
      "non-loopback hostname",
      { PRODUCT_STUDIO_APP_ORIGIN: "http://product-studio.example:3000" },
    ],
    [
      "localhost hostname",
      { PRODUCT_STUDIO_APP_ORIGIN: "http://localhost:3000" },
    ],
  ])("rejects %s configuration", (_label, env) => {
    expect(() => readTrustedOriginConfig(env)).toThrow(
      UntrustedRequestOriginError,
    );
  });

  it("accepts only the exact configured Origin and Host", () => {
    const config = readTrustedOriginConfig({
      PRODUCT_STUDIO_APP_ORIGIN: configuredOrigin,
    });

    expect(() => assertTrustedRequestOrigin(trustedRequest(), config)).not.toThrow();

    for (const request of [
      trustedRequest(null),
      trustedRequest("null"),
      trustedRequest("*"),
      trustedRequest("https://127.0.0.1:3000"),
      trustedRequest("http://127.0.0.2:3000"),
      trustedRequest("http://127.0.0.1:4000"),
      trustedRequest(configuredOrigin, null),
      trustedRequest(configuredOrigin, "127.0.0.1:4000"),
    ]) {
      expect(() => assertTrustedRequestOrigin(request, config)).toThrow(
        UntrustedRequestOriginError,
      );
    }
  });

  it("ignores forwarded headers when Origin or Host mismatches", () => {
    const config = readTrustedOriginConfig({
      PRODUCT_STUDIO_APP_ORIGIN: configuredOrigin,
    });
    const forwardedHeaders = {
      forwarded: "host=127.0.0.1:3000;proto=http",
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-host": "127.0.0.1:3000",
      "x-forwarded-proto": "http",
    };

    expect(() =>
      assertTrustedRequestOrigin(
        trustedRequest(
          "https://attacker.example",
          "attacker.example",
          forwardedHeaders,
        ),
        config,
      ),
    ).toThrow(UntrustedRequestOriginError);
  });
});
