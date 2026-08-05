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
  COPILOT_REVIEW_PROFILE_ID,
  createCopilotReviewRuntimeProfile,
  createCopilotRuntimeProfile,
  extractEffectiveModel,
  normalizeCopilotPermission,
  preflightCopilotExecutable,
  startCopilotReviewRuntime,
  startCopilotRuntime,
  type CopilotReviewRuntimeProfileInput,
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

function reviewInput(
  overrides: Partial<CopilotReviewRuntimeProfileInput> = {},
): CopilotReviewRuntimeProfileInput {
  const { evaluate_permission: _evaluatePermission, ...base } = input({
    available_tools: ["view", "apply_patch", "execute", "fetch"],
  });
  void _evaluatePermission;
  return {
    ...base,
    write_text_file: vi.fn(async () => undefined),
    review_policy: {
      kind: "single_result_file",
      result_path: ".founder/review/result.json",
      mission_result_binding_sha256: "b".repeat(64),
      commands: "forbidden",
      urls: "forbidden",
      mcp: "forbidden",
      credentials: "forbidden",
      outside_workspace_writes: "forbidden",
      reads: "workspace_and_repository_unrestricted",
      execution_mode: "permission_mediated_local",
      result_assurance: "result_scope_validation",
      containment_assurance: "not_independently_enforced",
      machine_authority: "launching_user",
    },
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
    const calls: string[] = [];
    const modelConfig = {
      type: "select" as const,
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "claude-opus-5",
      options: [
        { value: "gpt-5.4", name: "GPT-5.4" },
        { value: "gpt-5.5", name: "GPT-5.5" },
        { value: "claude-opus-5", name: "Claude Opus 5" },
      ],
    };
    const prompt = vi.fn(async () => {
      calls.push("sandbox");
      return { stopReason: "end_turn" as const };
    });
    const setConfigOption = vi.fn(async () => {
      calls.push("model");
      return {
        configOptions: [{ ...modelConfig, currentValue: "gpt-5.4" }],
      };
    });
    await expect(
      profile.runtime_profile.initialize_session?.({
        config_options: [modelConfig],
        prompt,
        set_config_option: setConfigOption,
      }),
    ).resolves.toBeUndefined();
    expect(prompt).toHaveBeenCalledWith("/sandbox enable");
    expect(setConfigOption).toHaveBeenCalledWith("model", "gpt-5.4");
    expect(calls).toEqual(["sandbox", "model"]);
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

  it("fails closed before mission work when Copilot cannot confirm the requested model", async () => {
    const profile = createCopilotRuntimeProfile(input());
    const prompt = vi.fn(async () => ({ stopReason: "end_turn" as const }));
    const baseModelConfig = {
      type: "select" as const,
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "gpt-5.5",
      options: [
        { value: "gpt-5.4", name: "GPT-5.4" },
        { value: "gpt-5.5", name: "GPT-5.5" },
      ],
    };

    await expect(
      profile.runtime_profile.initialize_session?.({
        config_options: [],
        prompt,
        set_config_option: vi.fn(),
      }),
    ).rejects.toThrow("Copilot did not expose exactly one model configuration option.");

    await expect(
      profile.runtime_profile.initialize_session?.({
        config_options: [
          {
            ...baseModelConfig,
            options: [{ value: "gpt-5.5", name: "GPT-5.5" }],
          },
        ],
        prompt,
        set_config_option: vi.fn(),
      }),
    ).rejects.toThrow("Requested Copilot model is unavailable in the ACP session.");

    await expect(
      profile.runtime_profile.initialize_session?.({
        config_options: [baseModelConfig],
        prompt,
        set_config_option: vi.fn(async () => ({
          configOptions: [baseModelConfig],
        })),
      }),
    ).rejects.toThrow("Copilot did not confirm the requested model.");
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

  it("fails before spawn when a caller-required Copilot tool is not exposed", () => {
    expect(() =>
      createCopilotRuntimeProfile(
        input({
          required_available_tools: ["view", "apply_patch"],
        }),
      ),
    ).toThrow("Required Copilot tools are unavailable: apply_patch, view.");

    const prepared = createCopilotRuntimeProfile(
      input({
        available_tools: ["view", "apply_patch"],
        required_available_tools: ["view", "apply_patch"],
      }),
    );
    expect(prepared.runtime_profile.args).toContain("apply_patch,view");
  });

  it("records whether a write-only ACP client filesystem channel is enabled", () => {
    const writeTextFile = vi.fn(async () => undefined);
    const enabled = createCopilotRuntimeProfile(
      input({ write_text_file: writeTextFile }),
    );
    const disabled = createCopilotRuntimeProfile(input());

    expect(enabled.runtime_profile.write_text_file).toBe(writeTextFile);
    expect(enabled.sanitized_profile_evidence.client_fs_write_text_file).toBe(
      true,
    );
    expect(disabled.runtime_profile.write_text_file).toBeUndefined();
    expect(disabled.sanitized_profile_evidence.client_fs_write_text_file).toBe(
      false,
    );
  });

  it("builds a distinct read-only Review profile with one mediated result writer", () => {
    const writeTextFile = vi.fn(async () => undefined);
    const profile = createCopilotReviewRuntimeProfile(
      reviewInput({ write_text_file: writeTextFile }),
    );

    expect(profile.sanitized_profile_evidence).toMatchObject({
      profile_id: COPILOT_REVIEW_PROFILE_ID,
      available_tools: ["view"],
      excluded_tools: [
        "apply_patch",
        "ask_user",
        "execute",
        "fetch",
        "mcp",
      ],
      client_fs_write_text_file: true,
    });
    expect(profile.runtime_profile.write_text_file).toBe(writeTextFile);
    expect(
      profile.runtime_profile.evaluate_permission({
        schema_version: 1,
        kind: "workspace_write",
        path: ".founder/review/result.json",
      }),
    ).toEqual({ decision: "allow_once", reason: null });
    expect(
      profile.runtime_profile.evaluate_permission({
        schema_version: 1,
        kind: "workspace_write",
        path: ".founder/review/sibling.json",
      }),
    ).toEqual({
      decision: "reject_once",
      reason: "review_run_read_only",
    });
    expect(
      profile.runtime_profile.evaluate_permission({
        schema_version: 1,
        kind: "command",
        executable: "npm",
        args: ["test"],
      }),
    ).toEqual({
      decision: "reject_once",
      reason: "review_run_read_only",
    });
    expect(profile.runtime_profile).not.toHaveProperty(
      "capability_envelope",
    );
    const evidence = JSON.stringify(profile.sanitized_profile_evidence);
    expect(evidence).not.toContain("capability_envelope");
    expect(evidence).not.toContain(workspaceCwd);
    expect(evidence).not.toContain(".founder/review");
  });

  it("fails Review model and required-read preflight before adapter spawn", async () => {
    const adapter = { start: vi.fn() };
    const sink: AcpEventSink = {
      append: async () => ({ limit_reached: false }),
    };

    await expect(
      startCopilotReviewRuntime(
        adapter,
        reviewInput({ requested_model: "gpt-unknown" }),
        sink,
      ),
    ).rejects.toThrow("Requested Copilot model is unavailable.");
    await expect(
      startCopilotReviewRuntime(
        adapter,
        reviewInput({
          available_tools: ["read", "apply_patch"],
        }),
        sink,
      ),
    ).rejects.toThrow("Required Copilot tools are unavailable: view.");
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

  it("recognizes only exact Copilot read requests as unrestricted reads", () => {
    const profile = createCopilotRuntimeProfile(input()).runtime_profile;

    expect(
      profile.allow_unrestricted_read?.(
        permission({
          kind: "read",
          rawInput: { path: "TASK.md" },
          locations: [{ path: "TASK.md" }],
        }),
      ),
    ).toBe(true);
    expect(
      profile.allow_unrestricted_read?.(
        permission({
          kind: "read",
          rawInput: { path: "TASK.md" },
          locations: [{ path: "different.md" }],
        }),
      ),
    ).toBe(false);
    expect(
      profile.allow_unrestricted_read?.(
        permission({ kind: "read", rawInput: {} }),
      ),
    ).toBe(false);
    expect(
      profile.allow_unrestricted_read?.(
        permission({ kind: "edit", rawInput: { path: "TASK.md" } }),
      ),
    ).toBe(false);
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
