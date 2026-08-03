import { describe, expect, it, vi } from "vitest";

import {
  resolveCapabilityEnvelope,
  canonicalizeCapabilityRequest,
  capabilityRequestMatchesEnvelope,
  type ExecutionDefaultsV1,
} from "../../../src/domain/capability-envelope";
import type { ConnectedRunLimits } from "../../../src/domain/connected-run";
import type { AcpEventSink } from "../../../src/infrastructure/acp/acp-client";
import {
  createCopilotRuntimeProfile,
  extractEffectiveModel,
  normalizeCopilotPermission,
  preflightCopilotExecutable,
  startCopilotRuntime,
  type CopilotRuntimeProfileInput,
} from "../../../src/infrastructure/acp/copilot-runtime-profile";

const defaults: ExecutionDefaultsV1 = {
  schema_version: 1,
  approved_command_forms: [{ executable: "npm", args: ["run", "test"] }],
  approved_url_operations: [],
  mcp: "forbidden",
  credentials: "forbidden",
};
const limits: ConnectedRunLimits = {
  wall_clock_timeout_ms: 2_000,
  max_event_count: 100,
  max_event_bytes: 100_000,
  max_output_bytes: 100_000,
  termination_grace_ms: 100,
  drain_grace_ms: 100,
};
const workspaceCwd = "/workspace/product-studio";
const eventSha256 = "a".repeat(64);

function input(
  overrides: Partial<CopilotRuntimeProfileInput> = {},
): CopilotRuntimeProfileInput {
  return {
    preflight: {
      executable: "copilot",
      version: "1.0.75",
      authentication: "noninteractive_authenticated",
      available_model_ids: ["gpt-5.4", "gpt-5.5"],
    },
    requested_model: "gpt-5.4",
    reasoning_effort: "high",
    available_tools: ["edit", "execute", "fetch", "read"],
    excluded_tools: ["ask_user", "mcp"],
    environment: {
      PATH: "/usr/bin:/bin",
      COPILOT_TOKEN: "credential-value-must-not-survive",
      PRODUCT_STUDIO_APP_ORIGIN: "http://127.0.0.1:3000",
    },
    workspace_cwd: workspaceCwd,
    evaluate_permission: (request) =>
      capabilityRequestMatchesEnvelope(
        request,
        resolveCapabilityEnvelope(["src"], defaults),
      )
        ? { decision: "allow_once", reason: null }
        : {
            decision: "reject_once",
            reason: "outside_capability_envelope",
          },
    limits,
    ...overrides,
  };
}

function permission(toolCall: unknown) {
  return {
    sessionId: "session-1",
    toolCall,
    options: [],
  } as never;
}

describe("Copilot ACP runtime profile", () => {
  it("preflights the executable by argv and builds a noninteractive, credential-free profile", async () => {
    const runner = vi.fn(async () => ({
      exit_code: 0,
      stdout: "GitHub Copilot CLI 1.0.75.\n",
    }));

    await expect(preflightCopilotExecutable("copilot", runner)).resolves.toEqual({
      executable: "copilot",
      version: "1.0.75",
    });
    expect(runner).toHaveBeenCalledWith("copilot", ["--version"]);

    const evaluator = vi.fn(() => ({
      decision: "reject_once" as const,
      reason: "test_evaluator",
    }));
    const profile = createCopilotRuntimeProfile(
      input({ evaluate_permission: evaluator }),
    );
    expect(profile.runtime_profile.args).toEqual([
      "--acp",
      "--stdio",
      "--sandbox",
      "--model",
      "gpt-5.4",
      "--reasoning-effort",
      "high",
      "--available-tools",
      "edit,execute,fetch,read",
      "--excluded-tools",
      "ask_user,mcp",
      "--disable-builtin-mcps",
      "--disallow-temp-dir",
      "--no-ask-user",
      "--no-custom-instructions",
      "--no-remote",
      "--no-remote-export",
      "--no-auto-update",
      "--log-level",
      "none",
    ]);
    expect(profile.runtime_profile.environment).toEqual({
      NO_COLOR: "1",
      PATH: "/usr/bin:/bin",
    });
    expect(profile.runtime_profile.evaluate_permission).toBe(evaluator);
    expect(profile.runtime_profile).not.toHaveProperty("capability_envelope");
    const prompt = vi.fn(async () => ({ stopReason: "end_turn" as const }));
    await expect(
      profile.runtime_profile.initialize_session?.({ prompt }),
    ).resolves.toBeUndefined();
    expect(prompt).toHaveBeenCalledWith("/sandbox enable");
    expect(profile.sanitized_profile_evidence).toMatchObject({
      executable: "copilot",
      execution_mode: "permission_mediated_local",
      containment_assurance: "not_independently_enforced",
      machine_authority: "launching_user",
      requested_mcp_server_count: 0,
    });
    expect(JSON.stringify(profile)).not.toContain("credential-value-must-not-survive");
    expect(JSON.stringify(profile)).not.toContain("PRODUCT_STUDIO_APP_ORIGIN");
    expect(JSON.stringify(profile)).not.toContain("http://127.0.0.1:3000");
    expect(
      profile.runtime_profile.args.some((argument) =>
        /^(?:-p|--prompt|--allow-all|--yolo|--additional-mcp-config|--add-github-mcp-tool|--allow-tool|--allow-url)/u.test(
          argument,
        ),
      ),
    ).toBe(false);
  });

  it("fails an unknown model before invoking the ACP adapter and never falls back", async () => {
    const adapter = {
      start: vi.fn(),
    };
    const sink: AcpEventSink = {
      append: async () => ({ limit_reached: false }),
    };

    await expect(
      startCopilotRuntime(adapter, input({ requested_model: "gpt-unknown" }), sink),
    ).rejects.toThrow("Requested Copilot model is unavailable.");
    expect(adapter.start).not.toHaveBeenCalled();
  });

  it("normalizes only exact, non-shell Copilot permission requests", () => {
    expect(
      normalizeCopilotPermission(
        permission({
          kind: "edit",
          rawInput: { fileName: "src/example.ts" },
          locations: [{ path: "src/example.ts" }],
        }),
        workspaceCwd,
      ),
    ).toEqual({
      schema_version: 1,
      kind: "workspace_write",
      path: "src/example.ts",
    });
    expect(
      normalizeCopilotPermission(
        permission({
          kind: "edit",
          rawInput: { fileName: "../outside.ts" },
          locations: [{ path: "../outside.ts" }],
        }),
        workspaceCwd,
      ),
    ).toEqual({
      schema_version: 1,
      kind: "outside_workspace_write",
      path: "/workspace/outside.ts",
    });
    expect(
      normalizeCopilotPermission(
        permission({
          kind: "delete",
          rawInput: { path: "..draft.ts" },
          locations: [{ path: "..draft.ts" }],
        }),
        workspaceCwd,
      ),
    ).toEqual({
      schema_version: 1,
      kind: "workspace_write",
      path: "..draft.ts",
    });
    expect(
      normalizeCopilotPermission(
        permission({
          kind: "execute",
          rawInput: {
            command: "npm run test",
            commands: ["npm run test"],
          },
        }),
        workspaceCwd,
      ),
    ).toEqual({
      schema_version: 1,
      kind: "command",
      executable: "npm",
      args: ["run", "test"],
    });
    expect(
      normalizeCopilotPermission(
        permission({
          kind: "execute",
          rawInput: {
            command: "npm run test && git push",
            commands: ["npm run test && git push"],
          },
        }),
        workspaceCwd,
      ),
    ).toBeNull();
    expect(
      normalizeCopilotPermission(
        permission({
          kind: "fetch",
          rawInput: { url: "https://example.com/status" },
        }),
        workspaceCwd,
      ),
    ).toEqual({
      schema_version: 1,
      kind: "url",
      method: "GET",
      protocol: "https",
      host: "example.com",
      path: "/status",
    });
  });

  it("auto-allows a real in-workspace write and denies an escape through the real envelope seam", () => {
    const envelope = resolveCapabilityEnvelope(["src"], defaults);

    const inside = normalizeCopilotPermission(
      permission({
        kind: "edit",
        rawInput: { path: "src/example.ts" },
        locations: [{ path: "src/example.ts" }],
      }),
      workspaceCwd,
    );
    expect(inside).not.toBeNull();
    const canonicalInside = canonicalizeCapabilityRequest(inside!);
    expect(canonicalInside).toEqual({
      schema_version: 1,
      kind: "workspace_write",
      path: "src/example.ts",
    });
    expect(capabilityRequestMatchesEnvelope(canonicalInside, envelope)).toBe(true);

    const escape = normalizeCopilotPermission(
      permission({
        kind: "edit",
        rawInput: { path: "../outside.ts" },
        locations: [{ path: "../outside.ts" }],
      }),
      workspaceCwd,
    );
    expect(escape).not.toBeNull();
    const canonicalEscape = canonicalizeCapabilityRequest(escape!);
    expect(canonicalEscape).toEqual({
      schema_version: 1,
      kind: "outside_workspace_write",
      path: "/workspace/outside.ts",
    });
    expect(capabilityRequestMatchesEnvelope(canonicalEscape, envelope)).toBe(false);
  });

  it("attests a distinct effective model only from one verified ACP model option", () => {
    const options = [
      {
        type: "select" as const,
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "gpt-5.5",
        options: [{ value: "gpt-5.4", name: "GPT-5.4" }, { value: "gpt-5.5", name: "GPT-5.5" }],
        _meta: { deployment_id: "regional-gpt-5.5" },
      },
    ];
    expect(
      extractEffectiveModel({
        source: "session_new",
        verification: "acp_observed",
        observed_event_sha256: eventSha256,
        config_options: options,
      }),
    ).toEqual({
      model_id: "gpt-5.5",
      deployment_id: "regional-gpt-5.5",
      observed_event_sha256: eventSha256,
    });
    expect(
      extractEffectiveModel({
        source: "session_new",
        verification: "acp_observed",
        observed_event_sha256: eventSha256,
        config_options: [{ ...options[0], currentValue: "auto" }],
      }),
    ).toBeNull();
    expect(
      extractEffectiveModel({
        source: "config_option_update",
        verification: "acp_observed",
        observed_event_sha256: "not-a-hash",
        config_options: options,
      }),
    ).toBeNull();
    expect(
      extractEffectiveModel({
        source: "session_new",
        verification: "acp_observed",
        observed_event_sha256: eventSha256,
        config_options: [],
      }),
    ).toBeNull();
    expect(
      extractEffectiveModel({
        source: "session_new",
        verification: "acp_observed",
        observed_event_sha256: eventSha256,
        config_options: [options[0]!, { ...options[0]!, id: "model-secondary" }],
      }),
    ).toBeNull();
    expect(
      extractEffectiveModel({
        source: "session_new",
        verification: "acp_observed",
        observed_event_sha256: eventSha256,
        config_options: [{ ...options[0]!, currentValue: "gpt-unknown" }],
      }),
    ).toBeNull();
    expect(
      extractEffectiveModel({
        source: "config_option_update",
        verification: "acp_observed",
        observed_event_sha256: eventSha256,
        config_options: [
          {
            ...options[0]!,
            _meta: { deployment_id: "unsafe deployment secret" },
          },
        ],
      }),
    ).toEqual({
      model_id: "gpt-5.5",
      deployment_id: null,
      observed_event_sha256: eventSha256,
    });
  });

  it("fails malformed executable and authentication preflight data closed", async () => {
    await expect(
      preflightCopilotExecutable("copilot", async () => ({
        exit_code: 0,
        stdout: "unexpected output",
      })),
    ).rejects.toThrow("Copilot executable preflight failed.");
    expect(() =>
      createCopilotRuntimeProfile(
        input({
          preflight: {
            ...input().preflight,
            authentication: "not_verified" as "noninteractive_authenticated",
          },
        }),
      ),
    ).toThrow("Copilot authentication preflight is incomplete.");
  });
});
