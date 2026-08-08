import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import * as acp from "@agentclientprotocol/sdk";

import {
  normalizeApprovedCommandForm,
  normalizeApprovedUrlOperation,
  type CanonicalCapabilityRequest,
} from "../../domain/capability-envelope";
import type { ConnectedRunLimits } from "../../domain/connected-run";
import {
  evaluateReviewPermissionRequest,
  reviewRunPolicySchema,
  type ReviewRunPolicy,
} from "../../domain/review-run-policy";
import type {
  AcpClientAdapter,
  AcpEventSink,
  AcpRuntimeProfile,
  AcpSession,
  AcpSessionCallbacks,
  AcpWriteTextFileHandler,
  NormalizedPermissionEvaluator,
} from "./acp-client";

const execFileAsync = promisify(execFile);

export const COPILOT_ADAPTER_ID = "copilot-acp";
export const COPILOT_PROFILE_ID = "noninteractive-execute-v1";
export const COPILOT_REVIEW_PROFILE_ID = "noninteractive-review-v1";
export const COPILOT_REVIEW_READ_TOOL = "view";
export const COPILOT_REVIEW_RESULT_WRITE_TOOL = "apply_patch";
export const COPILOT_WRITABLE_COMMAND_TOOL = "bash";
const COPILOT_REVIEW_TOOLS = new Set([
  COPILOT_REVIEW_READ_TOOL,
  COPILOT_REVIEW_RESULT_WRITE_TOOL,
  "read",
]);
const VERSION_OUTPUT = /^GitHub Copilot CLI (\d+\.\d+\.\d+)\.?\s*$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const SAFE_TOOL = /^[A-Za-z][A-Za-z0-9_-]*$/u;
const SAFE_ENVIRONMENT_KEYS = new Set([
  "COPILOT_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "TMPDIR",
]);
const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const FORBIDDEN_ARGUMENTS = [
  /^-p$/u,
  /^--prompt(?:=|$)/u,
  /^--allow-all/u,
  /^--yolo$/u,
  /^--additional-mcp-config(?:=|$)/u,
  /^--add-github-mcp-tool(?:=|$)/u,
  /^--add-github-mcp-toolset(?:=|$)/u,
  /^--enable-all-github-mcp-tools$/u,
  /^--allow-tool(?:=|$)/u,
  /^--allow-url(?:=|$)/u,
  /^--deny-tool(?:=|$)/u,
  /^--deny-url(?:=|$)/u,
  /^--remote(?:=|$)/u,
  /^--remote-export(?:=|$)/u,
  /^--plugin-dir(?:=|$)/u,
];

export type CopilotReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface CopilotExecutablePreflight {
  readonly executable: string;
  readonly version: string;
}

export interface CopilotRuntimePreflight extends CopilotExecutablePreflight {
  readonly authentication: "noninteractive_authenticated";
  readonly available_model_ids: readonly string[];
}

export interface CopilotRuntimeProfileInput {
  readonly preflight: CopilotRuntimePreflight;
  readonly requested_model: string;
  readonly reasoning_effort: CopilotReasoningEffort;
  readonly available_tools: readonly string[];
  readonly required_available_tools?: readonly string[];
  readonly excluded_tools: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly workspace_cwd: string;
  readonly evaluate_permission: NormalizedPermissionEvaluator;
  readonly write_text_file?: AcpWriteTextFileHandler;
  readonly limits: ConnectedRunLimits;
}

export interface CopilotSanitizedProfileEvidence {
  readonly adapter_id: typeof COPILOT_ADAPTER_ID;
  readonly adapter_version: string;
  readonly profile_id:
    | typeof COPILOT_PROFILE_ID
    | typeof COPILOT_REVIEW_PROFILE_ID;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly requested_model: string;
  readonly reasoning_effort: CopilotReasoningEffort;
  readonly available_tools: readonly string[];
  readonly excluded_tools: readonly string[];
  readonly authentication: "noninteractive_authenticated";
  readonly execution_mode: "permission_mediated_local";
  readonly containment_assurance: "not_independently_enforced";
  readonly machine_authority: "launching_user";
  readonly requested_mcp_server_count: 0;
  readonly client_fs_write_text_file: boolean;
  readonly credential_environment: "explicit_allowlist_without_credential_values";
}

export interface CopilotRuntimeProfile {
  readonly runtime_profile: AcpRuntimeProfile;
  readonly sanitized_profile_evidence: CopilotSanitizedProfileEvidence;
}

export interface CopilotReviewRuntimeProfileInput
  extends Omit<
    CopilotRuntimeProfileInput,
    "required_available_tools" | "evaluate_permission"
  > {
  readonly review_policy: ReviewRunPolicy;
}

export interface CopilotAcpModelEvent {
  readonly source: "session_new" | "config_option_update";
  readonly verification: "acp_observed";
  readonly observed_event_sha256: string;
  readonly config_options: readonly acp.SessionConfigOption[];
}

export interface CopilotEffectiveModelIdentity {
  readonly model_id: string;
  readonly deployment_id: string | null;
  readonly observed_event_sha256: string;
}

export type CopilotVersionRunner = (
  executable: string,
  args: readonly ["--version"],
) => Promise<{ readonly exit_code: number; readonly stdout: string }>;

class CopilotRuntimeProfileError extends Error {}

function requireSafeIdentifier(value: string, label: string): string {
  if (!SAFE_IDENTIFIER.test(value) || value === "auto") {
    throw new CopilotRuntimeProfileError(`Invalid ${label}.`);
  }
  return value;
}

function requireCopilotExecutable(executable: string): string {
  if (
    executable.trim() === "" ||
    executable.includes("\u0000") ||
    basename(executable) !== "copilot"
  ) {
    throw new CopilotRuntimeProfileError("Invalid Copilot executable.");
  }
  return executable;
}

function requireAbsoluteWorkspace(workspaceCwd: string): string {
  const normalized = resolve(workspaceCwd);
  if (workspaceCwd !== normalized) {
    throw new CopilotRuntimeProfileError("Workspace must be an absolute path.");
  }
  return normalized;
}

function normalizeTools(
  values: readonly string[],
  label: "available" | "excluded",
): string[] {
  if (values.length === 0) {
    throw new CopilotRuntimeProfileError(`${label} tools must not be empty.`);
  }
  const normalized = [...new Set(values)].sort((left, right) =>
    left.localeCompare(right),
  );
  if (normalized.length !== values.length || normalized.some((tool) => !SAFE_TOOL.test(tool))) {
    throw new CopilotRuntimeProfileError(`Invalid ${label} tools.`);
  }
  return normalized;
}

function resolveEnvironment(
  environment: Readonly<Record<string, string>>,
): Record<string, string> {
  const resolved: Record<string, string> = { NO_COLOR: "1" };
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value !== undefined) {
      if (value.includes("\u0000")) {
        throw new CopilotRuntimeProfileError("Invalid runtime environment.");
      }
      resolved[key] = value;
    }
  }
  if (resolved.PATH === undefined || resolved.PATH === "") {
    throw new CopilotRuntimeProfileError("Runtime PATH is required.");
  }
  return resolved;
}

function assertSafeArguments(args: readonly string[]): void {
  if (args.some((arg) => FORBIDDEN_ARGUMENTS.some((pattern) => pattern.test(arg)))) {
    throw new CopilotRuntimeProfileError("Copilot runtime profile contains a forbidden argument.");
  }
}

function containsOnlyShellLiteralBracketTokens(command: string): boolean {
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === "[") {
      const token = command.slice(index, index + 3);
      if (token !== "[[]" && token !== "[]]") {
        return false;
      }
      index += 2;
    } else if (character === "]") {
      return false;
    }
  }
  return true;
}

const FORBIDDEN_SHELL_WORD_CHARACTERS =
  /[\u0000-\u001f\u007f|&;<>()`$\\"*?{}!~#]/u;
const FORBIDDEN_DOUBLE_QUOTED_SHELL_WORD_CHARACTERS = /[`$]/u;
const DOUBLE_QUOTED_BACKSLASH_ESCAPED_CHARACTERS = new Set([
  "$",
  "`",
  '"',
  "\\",
]);

function containsOnlyShellInertDoubleQuotedBackslashes(word: string): boolean {
  for (let index = 0; index < word.length; index += 1) {
    if (word[index] !== "\\") {
      continue;
    }

    const nextCharacter = word[index + 1];
    if (
      nextCharacter === undefined ||
      DOUBLE_QUOTED_BACKSLASH_ESCAPED_CHARACTERS.has(nextCharacter)
    ) {
      return false;
    }

    index += 1;
  }

  return true;
}

function parseRestrictedShellWords(command: string): string[] | null {
  if (/[\u0000-\u001f\u007f]/u.test(command)) {
    return null;
  }
  const input = command.trim();
  if (input === "") {
    return null;
  }

  const words: string[] = [];
  let index = 0;
  while (index < input.length) {
    if (input[index] === " ") {
      index += 1;
      continue;
    }

    if (input[index] === "'") {
      const closingQuote = input.indexOf("'", index + 1);
      if (closingQuote === -1) {
        return null;
      }
      const word = input.slice(index + 1, closingQuote);
      if (
        FORBIDDEN_SHELL_WORD_CHARACTERS.test(word) ||
        (closingQuote + 1 < input.length && input[closingQuote + 1] !== " ")
      ) {
        return null;
      }
      words.push(word);
      index = closingQuote + 1;
      continue;
    }

    if (input[index] === '"') {
      const closingQuote = input.indexOf('"', index + 1);
      if (closingQuote === -1) {
        return null;
      }
      const word = input.slice(index + 1, closingQuote);
      if (
        FORBIDDEN_DOUBLE_QUOTED_SHELL_WORD_CHARACTERS.test(word) ||
        !containsOnlyShellInertDoubleQuotedBackslashes(word) ||
        (closingQuote + 1 < input.length && input[closingQuote + 1] !== " ")
      ) {
        return null;
      }
      words.push(word);
      index = closingQuote + 1;
      continue;
    }

    const nextSpace = input.indexOf(" ", index);
    const end = nextSpace === -1 ? input.length : nextSpace;
    const word = input.slice(index, end);
    if (
      word.includes("'") ||
      FORBIDDEN_SHELL_WORD_CHARACTERS.test(word) ||
      !containsOnlyShellLiteralBracketTokens(word)
    ) {
      return null;
    }
    words.push(word);
    index = end;
  }
  return words;
}

function commandFromRawInput(rawInput: unknown): CanonicalCapabilityRequest | null {
  if (!isRecord(rawInput) || typeof rawInput.command !== "string") {
    return null;
  }
  if (
    !Array.isArray(rawInput.commands) ||
    rawInput.commands.length !== 1 ||
    rawInput.commands[0] !== rawInput.command
  ) {
    return null;
  }
  const words = parseRestrictedShellWords(rawInput.command);
  if (words === null) {
    return null;
  }
  const [executable, ...args] = words;
  try {
    return {
      schema_version: 1,
      kind: "command",
      ...normalizeApprovedCommandForm(executable, args),
    };
  } catch {
    return null;
  }
}

function pathFromRawInput(
  toolCall: acp.RequestPermissionRequest["toolCall"],
  workspaceCwd: string,
): CanonicalCapabilityRequest | null {
  const rawInput = isRecord(toolCall.rawInput) ? toolCall.rawInput : null;
  const candidates = [
    rawInput?.fileName,
    rawInput?.path,
    ...(toolCall.locations ?? []).map((location) => location.path),
  ].filter((value): value is string => typeof value === "string");
  const unique = [...new Set(candidates)];
  if (unique.length !== 1 || unique[0]!.includes("\u0000")) {
    return null;
  }
  const path = resolve(workspaceCwd, unique[0]!);
  const pathRelativeToWorkspace = relative(workspaceCwd, path);
  const isWithinWorkspace =
    pathRelativeToWorkspace === "" ||
    (!isAbsolute(pathRelativeToWorkspace) &&
      pathRelativeToWorkspace !== ".." &&
      !pathRelativeToWorkspace.startsWith(`..${sep}`));
  if (isWithinWorkspace) {
    if (pathRelativeToWorkspace === "") {
      return null;
    }
    return {
      schema_version: 1,
      kind: "workspace_write",
      path: pathRelativeToWorkspace.split(sep).join("/"),
    };
  }
  return {
    schema_version: 1,
    kind: "outside_workspace_write",
    path,
  };
}

function isCopilotUnrestrictedReadPermission(
  request: acp.RequestPermissionRequest,
): boolean {
  if (request.toolCall.kind !== "read") {
    return false;
  }
  const rawInput = isRecord(request.toolCall.rawInput)
    ? request.toolCall.rawInput
    : null;
  const candidates = [
    rawInput?.fileName,
    rawInput?.path,
    ...(request.toolCall.locations ?? []).map((location) => location.path),
  ].filter((value): value is string => typeof value === "string");
  const unique = [...new Set(candidates)];
  return (
    unique.length === 1 &&
    unique[0]!.trim() !== "" &&
    !unique[0]!.includes("\u0000")
  );
}

function urlFromRawInput(rawInput: unknown): CanonicalCapabilityRequest | null {
  if (!isRecord(rawInput) || typeof rawInput.url !== "string") {
    return null;
  }
  try {
    return {
      schema_version: 1,
      kind: "url",
      ...normalizeApprovedUrlOperation(
        typeof rawInput.method === "string" ? rawInput.method : "GET",
        rawInput.url,
      ),
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionValues(
  options: acp.SessionConfigSelectOptions,
): readonly acp.SessionConfigSelectOption[] {
  return options.flatMap((option) =>
    "group" in option ? option.options : [option],
  );
}

function requestedModelOption(
  options: readonly acp.SessionConfigOption[],
  requestedModel: string,
): (acp.SessionConfigOption & { readonly type: "select" }) | null {
  const modelOptions = options.filter(
    (
      option,
    ): option is acp.SessionConfigOption & { readonly type: "select" } =>
      option.type === "select" && option.category === "model",
  );
  if (modelOptions.length !== 1) {
    return null;
  }
  const modelOption = modelOptions[0]!;
  return optionValues(modelOption.options).some(
    (option) => option.value === requestedModel,
  )
    ? modelOption
    : null;
}

function deploymentId(option: acp.SessionConfigOption): string | null {
  const value = option._meta?.deployment_id;
  return typeof value === "string" && SAFE_IDENTIFIER.test(value) ? value : null;
}

async function defaultVersionRunner(
  executable: string,
  args: readonly ["--version"],
): Promise<{ readonly exit_code: number; readonly stdout: string }> {
  try {
    const { stdout } = await execFileAsync(executable, args, {
      encoding: "utf8",
      shell: false,
      timeout: 5_000,
    });
    return { exit_code: 0, stdout };
  } catch {
    return { exit_code: 1, stdout: "" };
  }
}

export async function preflightCopilotExecutable(
  executable: string,
  runner: CopilotVersionRunner = defaultVersionRunner,
): Promise<CopilotExecutablePreflight> {
  const resolvedExecutable = requireCopilotExecutable(executable);
  const result = await runner(resolvedExecutable, ["--version"]);
  const version = result.exit_code === 0 ? VERSION_OUTPUT.exec(result.stdout)?.[1] : undefined;
  if (version === undefined) {
    throw new CopilotRuntimeProfileError("Copilot executable preflight failed.");
  }
  return { executable: resolvedExecutable, version };
}

export function createCopilotRuntimeProfile(
  input: CopilotRuntimeProfileInput,
): CopilotRuntimeProfile {
  const workspaceCwd = requireAbsoluteWorkspace(input.workspace_cwd);
  const executable = requireCopilotExecutable(input.preflight.executable);
  const version = requireSafeIdentifier(input.preflight.version, "Copilot version");
  if (input.preflight.authentication !== "noninteractive_authenticated") {
    throw new CopilotRuntimeProfileError("Copilot authentication preflight is incomplete.");
  }

  const requestedModel = requireSafeIdentifier(input.requested_model, "requested model");
  const availableModels = new Set(
    input.preflight.available_model_ids.map((model) =>
      requireSafeIdentifier(model, "available model"),
    ),
  );
  if (!availableModels.has(requestedModel)) {
    throw new CopilotRuntimeProfileError("Requested Copilot model is unavailable.");
  }
  if (!REASONING_EFFORTS.includes(input.reasoning_effort)) {
    throw new CopilotRuntimeProfileError("Invalid Copilot reasoning effort.");
  }

  const availableTools = normalizeTools(input.available_tools, "available");
  const requiredAvailableTools =
    input.required_available_tools === undefined
      ? []
      : normalizeTools(input.required_available_tools, "available");
  const missingRequiredTools = requiredAvailableTools.filter(
    (tool) => !availableTools.includes(tool),
  );
  if (missingRequiredTools.length > 0) {
    throw new CopilotRuntimeProfileError(
      `Required Copilot tools are unavailable: ${missingRequiredTools.join(", ")}.`,
    );
  }
  const excludedTools = normalizeTools(input.excluded_tools, "excluded");
  if (excludedTools.some((tool) => availableTools.includes(tool))) {
    throw new CopilotRuntimeProfileError("Available and excluded tools must not overlap.");
  }
  const args = [
    "--acp",
    "--stdio",
    "--sandbox",
    "--model",
    requestedModel,
    "--reasoning-effort",
    input.reasoning_effort,
    "--available-tools",
    availableTools.join(","),
    "--excluded-tools",
    excludedTools.join(","),
    "--disable-builtin-mcps",
    "--disallow-temp-dir",
    "--no-ask-user",
    "--no-custom-instructions",
    "--no-remote",
    "--no-remote-export",
    "--no-auto-update",
    "--log-level",
    "none",
  ] as const;
  assertSafeArguments(args);

  const sanitizedProfileEvidence: CopilotSanitizedProfileEvidence = {
    adapter_id: COPILOT_ADAPTER_ID,
    adapter_version: version,
    profile_id: COPILOT_PROFILE_ID,
    executable: "copilot",
    argv: [...args],
    requested_model: requestedModel,
    reasoning_effort: input.reasoning_effort,
    available_tools: availableTools,
    excluded_tools: excludedTools,
    authentication: input.preflight.authentication,
    execution_mode: "permission_mediated_local",
    containment_assurance: "not_independently_enforced",
    machine_authority: "launching_user",
    requested_mcp_server_count: 0,
    client_fs_write_text_file: input.write_text_file !== undefined,
    credential_environment: "explicit_allowlist_without_credential_values",
  };

  return {
    runtime_profile: {
      adapter_id: COPILOT_ADAPTER_ID,
      executable,
      args,
      environment: resolveEnvironment(input.environment),
      workspace_cwd: workspaceCwd,
      evaluate_permission: input.evaluate_permission,
      write_text_file: input.write_text_file,
      limits: input.limits,
      normalize_permission: (request) =>
        normalizeCopilotPermission(request, workspaceCwd),
      allow_unrestricted_read: isCopilotUnrestrictedReadPermission,
      initialize_session: async (session) => {
        const initialModelOptions = session.config_options.filter(
          (option) => option.type === "select" && option.category === "model",
        );
        if (initialModelOptions.length !== 1) {
          throw new CopilotRuntimeProfileError(
            "Copilot did not expose exactly one model configuration option.",
          );
        }
        const modelOption = requestedModelOption(
          session.config_options,
          requestedModel,
        );
        if (modelOption === null) {
          throw new CopilotRuntimeProfileError(
            "Requested Copilot model is unavailable in the ACP session.",
          );
        }
        const response = await session.prompt("/sandbox enable");
        if (response.stopReason !== "end_turn") {
          throw new CopilotRuntimeProfileError("Copilot sandbox enablement was not confirmed.");
        }
        const configured = await session.set_config_option(
          modelOption.id,
          requestedModel,
        );
        const confirmedModel = requestedModelOption(
          configured.configOptions,
          requestedModel,
        );
        if (confirmedModel?.currentValue !== requestedModel) {
          throw new CopilotRuntimeProfileError(
            "Copilot did not confirm the requested model.",
          );
        }
      },
    },
    sanitized_profile_evidence: sanitizedProfileEvidence,
  };
}

export function createCopilotReviewRuntimeProfile(
  input: CopilotReviewRuntimeProfileInput,
): CopilotRuntimeProfile {
  const { review_policy: reviewPolicyInput, ...profileInput } = input;
  const reviewPolicy = reviewRunPolicySchema.parse(reviewPolicyInput);
  const removedTools = profileInput.available_tools.filter((tool) =>
    !COPILOT_REVIEW_TOOLS.has(tool),
  );
  const availableTools = profileInput.available_tools.filter(
    (tool) => COPILOT_REVIEW_TOOLS.has(tool),
  );
  const excludedTools = [
    ...new Set([...profileInput.excluded_tools, ...removedTools]),
  ];
  const prepared = createCopilotRuntimeProfile({
    ...profileInput,
    available_tools: availableTools,
    required_available_tools: [
      COPILOT_REVIEW_READ_TOOL,
      COPILOT_REVIEW_RESULT_WRITE_TOOL,
    ],
    excluded_tools: excludedTools,
    evaluate_permission: (request) =>
      evaluateReviewPermissionRequest(reviewPolicy, request),
  });
  return {
    ...prepared,
    sanitized_profile_evidence: {
      ...prepared.sanitized_profile_evidence,
      profile_id: COPILOT_REVIEW_PROFILE_ID,
    },
  };
}

export function normalizeCopilotPermission(
  request: acp.RequestPermissionRequest,
  workspaceCwd: string,
): CanonicalCapabilityRequest | null {
  const normalizedWorkspace = requireAbsoluteWorkspace(workspaceCwd);
  const toolCall = request.toolCall;
  switch (toolCall.kind) {
    case "edit":
    case "delete":
      return pathFromRawInput(toolCall, normalizedWorkspace);
    case "execute":
      return commandFromRawInput(toolCall.rawInput);
    case "fetch":
      return urlFromRawInput(toolCall.rawInput);
    default:
      return null;
  }
}

export function extractEffectiveModel(
  event: CopilotAcpModelEvent,
): CopilotEffectiveModelIdentity | null {
  if (
    (event.source !== "session_new" && event.source !== "config_option_update") ||
    event.verification !== "acp_observed" ||
    !SHA256.test(event.observed_event_sha256)
  ) {
    return null;
  }
  const modelOptions = event.config_options.filter(
    (option): option is acp.SessionConfigOption & { type: "select" } =>
      option.type === "select" && option.category === "model",
  );
  if (modelOptions.length !== 1) {
    return null;
  }
  const option = modelOptions[0]!;
  if (
    option.currentValue === "auto" ||
    !SAFE_IDENTIFIER.test(option.currentValue) ||
    !optionValues(option.options).some(
      (choice) => choice.value === option.currentValue,
    )
  ) {
    return null;
  }
  return {
    model_id: option.currentValue,
    deployment_id: deploymentId(option),
    observed_event_sha256: event.observed_event_sha256,
  };
}

export async function startCopilotRuntime(
  adapter: AcpClientAdapter,
  input: CopilotRuntimeProfileInput,
  eventSink: AcpEventSink,
  callbacks?: AcpSessionCallbacks,
): Promise<AcpSession> {
  const { runtime_profile } = createCopilotRuntimeProfile(input);
  return adapter.start(runtime_profile, eventSink, callbacks);
}

export async function startCopilotReviewRuntime(
  adapter: AcpClientAdapter,
  input: CopilotReviewRuntimeProfileInput,
  eventSink: AcpEventSink,
  callbacks?: AcpSessionCallbacks,
): Promise<AcpSession> {
  const { runtime_profile } = createCopilotReviewRuntimeProfile(input);
  return adapter.start(runtime_profile, eventSink, callbacks);
}
