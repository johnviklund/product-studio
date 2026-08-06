import { describe, expect, it } from "vitest";

import {
  approvedCommandFormSchema,
  approvedUrlOperationSchema,
  canonicalCapabilityRequestSchema,
  capabilityEnvelopeV1Schema,
  capabilityRequestMatchesEnvelope,
  deriveAllowedScopeDigest,
  executionDefaultsFromCapabilityEnvelope,
  executionDefaultsV1Schema,
  extendExecutionDefaultsWithRequest,
  hashCanonicalCapabilityRequest,
  isCapabilityEnvelopeNarrowing,
  normalizeApprovedCommandForm,
  normalizeApprovedUrlOperation,
  resolveCapabilityEnvelope,
  type CanonicalCapabilityRequest,
  type ExecutionDefaultsV1,
} from "../../src/domain/capability-envelope";

const testCommand = normalizeApprovedCommandForm("npm", ["run", "test"]);
const lintCommand = normalizeApprovedCommandForm("npm", ["run", "lint"]);
const testUrl = normalizeApprovedUrlOperation(
  "get",
  "HTTPS://REGISTRY.NPMJS.ORG/@scope/package?format=json",
);
const defaults: ExecutionDefaultsV1 = {
  schema_version: 1,
  approved_command_forms: [testCommand, lintCommand],
  approved_url_operations: [testUrl],
  mcp: "forbidden",
  credentials: "forbidden",
};
const envelope = resolveCapabilityEnvelope(
  ["tests/domain", "src/domain"],
  defaults,
);

describe("capability envelope domain", () => {
  it("strictly round-trips every durable schema and rejects unknown keys", () => {
    const commandRequest: CanonicalCapabilityRequest = {
      schema_version: 1,
      kind: "command",
      ...testCommand,
    };

    expect(approvedCommandFormSchema.parse(testCommand)).toEqual(testCommand);
    expect(approvedUrlOperationSchema.parse(testUrl)).toEqual(testUrl);
    expect(executionDefaultsV1Schema.parse(defaults)).toEqual(defaults);
    expect(capabilityEnvelopeV1Schema.parse(envelope)).toEqual(envelope);
    expect(canonicalCapabilityRequestSchema.parse(commandRequest)).toEqual(
      commandRequest,
    );

    expect(() =>
      approvedCommandFormSchema.parse({ ...testCommand, shell: true }),
    ).toThrow();
    expect(() =>
      approvedUrlOperationSchema.parse({ ...testUrl, wildcard: true }),
    ).toThrow();
    expect(() =>
      executionDefaultsV1Schema.parse({ ...defaults, provider: "example" }),
    ).toThrow();
    expect(() =>
      capabilityEnvelopeV1Schema.parse({ ...envelope, sandbox: true }),
    ).toThrow();
    expect(() =>
      canonicalCapabilityRequestSchema.parse({
        ...commandRequest,
        description: "run tests",
      }),
    ).toThrow();
  });

  it("normalizes complete command and URL operations without broad permissions", () => {
    expect(testCommand).toEqual({
      executable: "npm",
      args: ["run", "test"],
    });
    expect(testUrl).toEqual({
      method: "GET",
      protocol: "https",
      host: "registry.npmjs.org",
      path: "/@scope/package?format=json",
    });
    expect(() =>
      normalizeApprovedUrlOperation(
        "GET",
        "https://token@registry.npmjs.org/package",
      ),
    ).toThrow();
    expect(() =>
      normalizeApprovedUrlOperation(
        "GET",
        "https://registry.npmjs.org/package#section",
      ),
    ).toThrow();
  });

  it("extends exact execution defaults without widening forbidden capabilities", () => {
    const base = executionDefaultsFromCapabilityEnvelope(
      resolveCapabilityEnvelope(["src"], {
        ...defaults,
        approved_command_forms: [testCommand],
        approved_url_operations: [],
      }),
    );
    const withCommand = extendExecutionDefaultsWithRequest(base, {
      schema_version: 1,
      kind: "command",
      executable: "git",
      args: ["status"],
    });
    const withUrl = extendExecutionDefaultsWithRequest(withCommand, {
      schema_version: 1,
      kind: "url",
      ...testUrl,
    });

    expect(withUrl).toEqual({
      schema_version: 1,
      approved_command_forms: [
        { executable: "git", args: ["status"] },
        testCommand,
      ],
      approved_url_operations: [testUrl],
      mcp: "forbidden",
      credentials: "forbidden",
    });
    expect(
      extendExecutionDefaultsWithRequest(withUrl, {
        schema_version: 1,
        kind: "command",
        executable: "git",
        args: ["status"],
      }),
    ).toEqual(withUrl);
    expect(() =>
      extendExecutionDefaultsWithRequest(base, {
        schema_version: 1,
        kind: "credential",
        source: "environment",
      }),
    ).toThrow("Only exact command and URL operations");
  });

  it("matches only exact in-envelope operations", () => {
    expect(
      capabilityRequestMatchesEnvelope(
        {
          schema_version: 1,
          kind: "workspace_write",
          path: "src/domain/capability-envelope.ts",
        },
        envelope,
      ),
    ).toBe(true);
    expect(
      capabilityRequestMatchesEnvelope(
        { schema_version: 1, kind: "command", ...testCommand },
        envelope,
      ),
    ).toBe(true);
    expect(
      capabilityRequestMatchesEnvelope(
        { schema_version: 1, kind: "url", ...testUrl },
        envelope,
      ),
    ).toBe(true);

    expect(
      capabilityRequestMatchesEnvelope(
        {
          schema_version: 1,
          kind: "command",
          executable: "npm",
          args: ["run", "build"],
        },
        envelope,
      ),
    ).toBe(false);
    expect(
      capabilityRequestMatchesEnvelope(
        {
          schema_version: 1,
          kind: "url",
          ...testUrl,
          path: "/different-package?format=json",
        },
        envelope,
      ),
    ).toBe(false);
    expect(
      capabilityRequestMatchesEnvelope(
        {
          schema_version: 1,
          kind: "outside_workspace_write",
          path: "/tmp/outside.txt",
        },
        envelope,
      ),
    ).toBe(false);
    expect(
      capabilityRequestMatchesEnvelope(
        { schema_version: 1, kind: "mcp", server: "filesystem" },
        envelope,
      ),
    ).toBe(false);
    expect(
      capabilityRequestMatchesEnvelope(
        { schema_version: 1, kind: "credential", source: "git" },
        envelope,
      ),
    ).toBe(false);
  });

  it("accepts reordered subsets as narrowing and rejects broadening", () => {
    const narrowed = {
      ...envelope,
      runtime: {
        ...envelope.runtime,
        approved_command_forms: [testCommand],
        approved_url_operations: [],
      },
    };
    const reordered = {
      ...envelope,
      runtime: {
        ...envelope.runtime,
        approved_command_forms: [testCommand, lintCommand],
      },
    };
    const broadenedCommand = {
      ...narrowed,
      runtime: {
        ...narrowed.runtime,
        approved_command_forms: [
          testCommand,
          normalizeApprovedCommandForm("npm", ["install"]),
        ],
      },
    };
    const changedScope = {
      ...narrowed,
      workspace: {
        ...narrowed.workspace,
        allowed_scope_digest: "f".repeat(64),
      },
    };

    expect(isCapabilityEnvelopeNarrowing(narrowed, envelope)).toBe(true);
    expect(isCapabilityEnvelopeNarrowing(reordered, envelope)).toBe(true);
    expect(isCapabilityEnvelopeNarrowing(broadenedCommand, envelope)).toBe(
      false,
    );
    expect(isCapabilityEnvelopeNarrowing(changedScope, envelope)).toBe(false);
  });

  it("derives an order-insensitive allowed-scope digest", () => {
    const first = deriveAllowedScopeDigest(["src/domain", "tests/domain"]);
    const second = deriveAllowedScopeDigest(["tests/domain", "src/domain"]);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(deriveAllowedScopeDigest(["src/domain"])).not.toBe(first);
    expect(() =>
      deriveAllowedScopeDigest(["src/domain", "SRC/DOMAIN"]),
    ).toThrow();
  });

  it("hashes canonical operations deterministically and binds every argument", () => {
    const request: CanonicalCapabilityRequest = {
      schema_version: 1,
      kind: "command",
      ...testCommand,
    };
    const sameRequest: CanonicalCapabilityRequest = {
      kind: "command",
      args: ["run", "test"],
      executable: "npm",
      schema_version: 1,
    };
    const changedRequest: CanonicalCapabilityRequest = {
      ...request,
      args: ["run", "test", "--watch"],
    };

    expect(hashCanonicalCapabilityRequest(sameRequest)).toBe(
      hashCanonicalCapabilityRequest(request),
    );
    expect(hashCanonicalCapabilityRequest(changedRequest)).not.toBe(
      hashCanonicalCapabilityRequest(request),
    );
  });
});
