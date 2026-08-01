export interface TrustedOriginConfig {
  origin: string;
  host: string;
}

type TrustedOriginEnvironment = Readonly<Record<string, string | undefined>>;

export class UntrustedRequestOriginError extends Error {
  readonly kind = "untrusted_request_origin" as const;
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "UntrustedRequestOriginError";
    this.reason = reason;
  }
}

function configurationError(): UntrustedRequestOriginError {
  return new UntrustedRequestOriginError(
    "PRODUCT_STUDIO_APP_ORIGIN must be configured as exactly one loopback origin.",
  );
}

function isLoopbackLiteral(hostname: string): boolean {
  if (hostname === "[::1]") {
    return true;
  }

  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet)) &&
    octets.every((octet) => Number(octet) <= 255) &&
    octets[0] === "127"
  );
}

export function readTrustedOriginConfig(
  env: TrustedOriginEnvironment,
): TrustedOriginConfig {
  const configuredOrigin = env.PRODUCT_STUDIO_APP_ORIGIN;

  if (
    configuredOrigin === undefined ||
    configuredOrigin.length === 0 ||
    configuredOrigin !== configuredOrigin.trim() ||
    configuredOrigin.endsWith("/")
  ) {
    throw configurationError();
  }

  let parsed: URL;
  try {
    parsed = new URL(configuredOrigin);
  } catch {
    throw configurationError();
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    !isLoopbackLiteral(parsed.hostname)
  ) {
    throw configurationError();
  }

  return {
    origin: parsed.origin,
    host: parsed.host,
  };
}

export function assertTrustedRequestOrigin(
  request: Request,
  config: TrustedOriginConfig,
): void {
  if (
    request.headers.get("origin") !== config.origin ||
    request.headers.get("host") !== config.host
  ) {
    throw new UntrustedRequestOriginError(
      "Request Origin and Host must exactly match PRODUCT_STUDIO_APP_ORIGIN.",
    );
  }
}
