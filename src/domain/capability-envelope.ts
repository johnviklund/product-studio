import { createHash } from "node:crypto";
import { posix } from "node:path";

import { z } from "zod";

import { workspaceRelativePosixPathSchema } from "./workspace-path";

const CAPABILITY_SCHEMA_VERSION = 1 as const;
const HTTP_METHODS = [
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
] as const;

const exactNonEmptyStringSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value === value.trim(),
    "must not have leading or trailing whitespace",
  )
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "must not contain control characters",
  );
const commandArgumentSchema = z
  .string()
  .refine(
    (value) => !value.includes("\u0000"),
    "must not contain null characters",
  );
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export interface ApprovedCommandForm {
  executable: string;
  args: string[];
}

export interface ApprovedUrlOperation {
  method: (typeof HTTP_METHODS)[number];
  protocol: "http" | "https";
  host: string;
  path: string;
}

export interface ExecutionDefaultsV1 {
  schema_version: 1;
  approved_command_forms: ApprovedCommandForm[];
  approved_url_operations: ApprovedUrlOperation[];
  mcp: "forbidden";
  credentials: "forbidden";
}

export interface CapabilityEnvelopeV1 {
  schema_version: 1;
  workspace: {
    allowed_scope_digest: string;
    execution_mode: "permission_mediated_local";
    scope_assurance: "result_scope_validation";
  };
  runtime: {
    containment_assurance: "not_independently_enforced";
    machine_authority: "launching_user";
    approved_command_forms: ApprovedCommandForm[];
    approved_url_operations: ApprovedUrlOperation[];
    mcp: "forbidden";
    credentials: "forbidden";
  };
}

export type CanonicalCapabilityRequest =
  | {
      schema_version: 1;
      kind: "workspace_write";
      path: string;
    }
  | {
      schema_version: 1;
      kind: "outside_workspace_write";
      path: string;
    }
  | ({ schema_version: 1; kind: "command" } & ApprovedCommandForm)
  | ({ schema_version: 1; kind: "url" } & ApprovedUrlOperation)
  | {
      schema_version: 1;
      kind: "mcp";
      server: string;
    }
  | {
      schema_version: 1;
      kind: "credential";
      source: string;
    };

export const PERMISSION_REJECTION_REASONS = [
  "command_detail_missing",
  "command_batch_unsupported",
  "command_shell_syntax_unsupported",
  "command_form_not_approvable",
  "path_not_uniquely_identified",
  "path_is_workspace_root",
  "url_detail_missing",
  "url_not_approvable",
  "tool_kind_unsupported",
] as const;

export type PermissionRejectionReason =
  (typeof PERMISSION_REJECTION_REASONS)[number];

/**
 * Why a request could not be interpreted, phrased so it reads correctly both to
 * a founder reviewing evidence and to the agent that made the request.
 */
export const PERMISSION_REJECTION_EXPLANATIONS: Record<
  PermissionRejectionReason,
  string
> = {
  command_detail_missing:
    "the command request carried no command text the runtime could read.",
  command_batch_unsupported:
    "the request bundled more than one command; each command must be requested on its own.",
  command_shell_syntax_unsupported:
    "the command used shell syntax the runtime will not interpret, such as an operator like && or |, a redirect, a glob, a variable or command substitution, or a line break. Request one plain command with literal arguments instead.",
  command_form_not_approvable:
    "the command could not be reduced to an approvable executable and argument list.",
  path_not_uniquely_identified:
    "the file request did not name exactly one path.",
  path_is_workspace_root:
    "the file request targeted the workspace root rather than a file.",
  url_detail_missing: "the fetch request carried no URL the runtime could read.",
  url_not_approvable: "the requested URL could not be normalized for approval.",
  tool_kind_unsupported:
    "the tool kind is not one this runtime mediates permission for.",
};

export interface PermissionRejection {
  readonly rejected: PermissionRejectionReason;
}

export function isPermissionRejection(
  value: CanonicalCapabilityRequest | PermissionRejection,
): value is PermissionRejection {
  return "rejected" in value;
}

export const approvedCommandFormSchema: z.ZodType<ApprovedCommandForm> =
  z.strictObject({
    executable: exactNonEmptyStringSchema,
    args: z.array(commandArgumentSchema),
  });

function isCanonicalUrlOperation(operation: ApprovedUrlOperation): boolean {
  try {
    const url = new URL(
      `${operation.protocol}://${operation.host}${operation.path}`,
    );
    return (
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      url.protocol === `${operation.protocol}:` &&
      url.host === operation.host &&
      `${url.pathname}${url.search}` === operation.path
    );
  } catch {
    return false;
  }
}

export const approvedUrlOperationSchema: z.ZodType<ApprovedUrlOperation> =
  z
    .strictObject({
      method: z.enum(HTTP_METHODS),
      protocol: z.enum(["http", "https"]),
      host: exactNonEmptyStringSchema.refine(
        (host) => host === host.toLowerCase(),
        "host must be lowercase",
      ),
      path: z.string().startsWith("/").refine(
        (path) => !path.includes("#"),
        "path must not contain a fragment",
      ),
    })
    .refine(isCanonicalUrlOperation, "URL operation must be canonical");

function uniqueByCanonicalValue<T>(
  values: T[],
  canonicalValue: (value: T) => string,
): boolean {
  return new Set(values.map(canonicalValue)).size === values.length;
}

function canonicalCommandForm(form: ApprovedCommandForm): string {
  return JSON.stringify([form.executable, form.args]);
}

function canonicalUrlOperation(operation: ApprovedUrlOperation): string {
  return JSON.stringify([
    operation.method,
    operation.protocol,
    operation.host,
    operation.path,
  ]);
}

const approvedCommandFormsSchema = z
  .array(approvedCommandFormSchema)
  .refine(
    (forms) => uniqueByCanonicalValue(forms, canonicalCommandForm),
    "approved_command_forms must not contain duplicates",
  );
const approvedUrlOperationsSchema = z
  .array(approvedUrlOperationSchema)
  .refine(
    (operations) => uniqueByCanonicalValue(operations, canonicalUrlOperation),
    "approved_url_operations must not contain duplicates",
  );

export const executionDefaultsV1Schema: z.ZodType<ExecutionDefaultsV1> =
  z.strictObject({
    schema_version: z.literal(CAPABILITY_SCHEMA_VERSION),
    approved_command_forms: approvedCommandFormsSchema,
    approved_url_operations: approvedUrlOperationsSchema,
    mcp: z.literal("forbidden"),
    credentials: z.literal("forbidden"),
  });

export const capabilityEnvelopeV1Schema: z.ZodType<CapabilityEnvelopeV1> =
  z.strictObject({
    schema_version: z.literal(CAPABILITY_SCHEMA_VERSION),
    workspace: z.strictObject({
      allowed_scope_digest: sha256Schema,
      execution_mode: z.literal("permission_mediated_local"),
      scope_assurance: z.literal("result_scope_validation"),
    }),
    runtime: z.strictObject({
      containment_assurance: z.literal("not_independently_enforced"),
      machine_authority: z.literal("launching_user"),
      approved_command_forms: approvedCommandFormsSchema,
      approved_url_operations: approvedUrlOperationsSchema,
      mcp: z.literal("forbidden"),
      credentials: z.literal("forbidden"),
    }),
  });

const absolutePosixPathSchema = z
  .string()
  .refine(posix.isAbsolute, "must be an absolute POSIX path")
  .refine(
    (path) => posix.normalize(path) === path,
    "must be a normalized absolute POSIX path",
  );
const workspaceWriteRequestSchema = z.strictObject({
  schema_version: z.literal(CAPABILITY_SCHEMA_VERSION),
  kind: z.literal("workspace_write"),
  path: workspaceRelativePosixPathSchema,
});
const outsideWorkspaceWriteRequestSchema = z.strictObject({
  schema_version: z.literal(CAPABILITY_SCHEMA_VERSION),
  kind: z.literal("outside_workspace_write"),
  path: absolutePosixPathSchema,
});
const commandRequestSchema = z.strictObject({
  schema_version: z.literal(CAPABILITY_SCHEMA_VERSION),
  kind: z.literal("command"),
  executable: exactNonEmptyStringSchema,
  args: z.array(commandArgumentSchema),
});
const urlRequestSchema = z
  .strictObject({
    schema_version: z.literal(CAPABILITY_SCHEMA_VERSION),
    kind: z.literal("url"),
    method: z.enum(HTTP_METHODS),
    protocol: z.enum(["http", "https"]),
    host: exactNonEmptyStringSchema.refine(
      (host) => host === host.toLowerCase(),
      "host must be lowercase",
    ),
    path: z.string().startsWith("/").refine(
      (path) => !path.includes("#"),
      "path must not contain a fragment",
    ),
  })
  .refine(isCanonicalUrlOperation, "URL operation must be canonical");
const mcpRequestSchema = z.strictObject({
  schema_version: z.literal(CAPABILITY_SCHEMA_VERSION),
  kind: z.literal("mcp"),
  server: exactNonEmptyStringSchema,
});
const credentialRequestSchema = z.strictObject({
  schema_version: z.literal(CAPABILITY_SCHEMA_VERSION),
  kind: z.literal("credential"),
  source: exactNonEmptyStringSchema,
});

export const canonicalCapabilityRequestSchema: z.ZodType<CanonicalCapabilityRequest> =
  z.union([
    workspaceWriteRequestSchema,
    outsideWorkspaceWriteRequestSchema,
    commandRequestSchema,
    urlRequestSchema,
    mcpRequestSchema,
    credentialRequestSchema,
  ]);

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortCommandForms(forms: ApprovedCommandForm[]): ApprovedCommandForm[] {
  return [...forms].sort((left, right) =>
    compareCanonical(canonicalCommandForm(left), canonicalCommandForm(right)),
  );
}

function sortUrlOperations(
  operations: ApprovedUrlOperation[],
): ApprovedUrlOperation[] {
  return [...operations].sort((left, right) =>
    compareCanonical(
      canonicalUrlOperation(left),
      canonicalUrlOperation(right),
    ),
  );
}

export function normalizeApprovedCommandForm(
  executable: string,
  args: readonly string[],
): ApprovedCommandForm {
  return approvedCommandFormSchema.parse({ executable, args: [...args] });
}

export function normalizeApprovedUrlOperation(
  method: string,
  urlValue: string,
): ApprovedUrlOperation {
  const url = new URL(urlValue);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "URL operation must use HTTP(S) without credentials or a fragment",
    );
  }
  return approvedUrlOperationSchema.parse({
    method: method.toUpperCase(),
    protocol: url.protocol.slice(0, -1),
    host: url.host.toLowerCase(),
    path: `${url.pathname}${url.search}`,
  });
}

export function canonicalizeCapabilityRequest(
  request: CanonicalCapabilityRequest,
): CanonicalCapabilityRequest {
  const validated = canonicalCapabilityRequestSchema.parse(request);
  switch (validated.kind) {
    case "workspace_write":
    case "outside_workspace_write":
      return {
        schema_version: CAPABILITY_SCHEMA_VERSION,
        kind: validated.kind,
        path: validated.path,
      };
    case "command":
      return {
        schema_version: CAPABILITY_SCHEMA_VERSION,
        kind: "command",
        executable: validated.executable,
        args: [...validated.args],
      };
    case "url":
      return {
        schema_version: CAPABILITY_SCHEMA_VERSION,
        kind: "url",
        method: validated.method,
        protocol: validated.protocol,
        host: validated.host,
        path: validated.path,
      };
    case "mcp":
      return {
        schema_version: CAPABILITY_SCHEMA_VERSION,
        kind: "mcp",
        server: validated.server,
      };
    case "credential":
      return {
        schema_version: CAPABILITY_SCHEMA_VERSION,
        kind: "credential",
        source: validated.source,
      };
  }
}

export function serializeCanonicalCapabilityRequest(
  request: CanonicalCapabilityRequest,
): string {
  return `${JSON.stringify(canonicalizeCapabilityRequest(request), null, 2)}\n`;
}

export function hashCanonicalCapabilityRequest(
  request: CanonicalCapabilityRequest,
): string {
  return createHash("sha256")
    .update(serializeCanonicalCapabilityRequest(request))
    .digest("hex");
}

export function deriveAllowedScopeDigest(
  allowedScope: readonly string[],
): string {
  const parsed = z
    .array(workspaceRelativePosixPathSchema)
    .min(1)
    .refine(
      (entries) =>
        new Set(entries.map((entry) => entry.toLocaleLowerCase())).size ===
        entries.length,
      "allowed_scope must not contain case-insensitive duplicates",
    )
    .parse([...allowedScope]);
  const canonical = [...parsed].sort(compareCanonical);
  const content = `${JSON.stringify(
    {
      schema_version: CAPABILITY_SCHEMA_VERSION,
      allowed_scope: canonical,
    },
    null,
    2,
  )}\n`;
  return createHash("sha256").update(content).digest("hex");
}

export function resolveCapabilityEnvelope(
  allowedScope: readonly string[],
  defaults: ExecutionDefaultsV1,
): CapabilityEnvelopeV1 {
  const validatedDefaults = executionDefaultsV1Schema.parse(defaults);
  return capabilityEnvelopeV1Schema.parse({
    schema_version: CAPABILITY_SCHEMA_VERSION,
    workspace: {
      allowed_scope_digest: deriveAllowedScopeDigest(allowedScope),
      execution_mode: "permission_mediated_local",
      scope_assurance: "result_scope_validation",
    },
    runtime: {
      containment_assurance: "not_independently_enforced",
      machine_authority: "launching_user",
      approved_command_forms: sortCommandForms(
        validatedDefaults.approved_command_forms,
      ),
      approved_url_operations: sortUrlOperations(
        validatedDefaults.approved_url_operations,
      ),
      mcp: validatedDefaults.mcp,
      credentials: validatedDefaults.credentials,
    },
  });
}

export function executionDefaultsFromCapabilityEnvelope(
  envelope: CapabilityEnvelopeV1,
): ExecutionDefaultsV1 {
  const validated = capabilityEnvelopeV1Schema.parse(envelope);
  return executionDefaultsV1Schema.parse({
    schema_version: CAPABILITY_SCHEMA_VERSION,
    approved_command_forms: validated.runtime.approved_command_forms,
    approved_url_operations: validated.runtime.approved_url_operations,
    mcp: validated.runtime.mcp,
    credentials: validated.runtime.credentials,
  });
}

export function extendExecutionDefaultsWithRequest(
  defaults: ExecutionDefaultsV1,
  request: CanonicalCapabilityRequest,
): ExecutionDefaultsV1 {
  const validatedDefaults = executionDefaultsV1Schema.parse(defaults);
  const canonicalRequest = canonicalizeCapabilityRequest(request);
  if (canonicalRequest.kind !== "command" && canonicalRequest.kind !== "url") {
    throw new Error(
      "Only exact command and URL operations can extend execution defaults.",
    );
  }

  const commandForms = [...validatedDefaults.approved_command_forms];
  const urlOperations = [...validatedDefaults.approved_url_operations];
  if (canonicalRequest.kind === "command") {
    const next = normalizeApprovedCommandForm(
      canonicalRequest.executable,
      canonicalRequest.args,
    );
    if (!commandForms.some((form) => canonicalCommandForm(form) === canonicalCommandForm(next))) {
      commandForms.push(next);
    }
  } else {
    const next = approvedUrlOperationSchema.parse({
      method: canonicalRequest.method,
      protocol: canonicalRequest.protocol,
      host: canonicalRequest.host,
      path: canonicalRequest.path,
    });
    if (!urlOperations.some((operation) => canonicalUrlOperation(operation) === canonicalUrlOperation(next))) {
      urlOperations.push(next);
    }
  }

  return executionDefaultsV1Schema.parse({
    ...validatedDefaults,
    approved_command_forms: sortCommandForms(commandForms),
    approved_url_operations: sortUrlOperations(urlOperations),
  });
}

export function capabilityRequestMatchesEnvelope(
  request: CanonicalCapabilityRequest,
  envelope: CapabilityEnvelopeV1,
): boolean {
  const canonicalRequest = canonicalizeCapabilityRequest(request);
  const validatedEnvelope = capabilityEnvelopeV1Schema.parse(envelope);
  switch (canonicalRequest.kind) {
    case "workspace_write":
      return true;
    case "outside_workspace_write":
    case "mcp":
    case "credential":
      return false;
    case "command":
      return validatedEnvelope.runtime.approved_command_forms.some(
        (form) =>
          canonicalCommandForm(form) ===
          canonicalCommandForm(canonicalRequest),
      );
    case "url":
      return validatedEnvelope.runtime.approved_url_operations.some(
        (operation) =>
          canonicalUrlOperation(operation) ===
          canonicalUrlOperation(canonicalRequest),
      );
  }
}

export function isCapabilityEnvelopeNarrowing(
  candidate: CapabilityEnvelopeV1,
  compiled: CapabilityEnvelopeV1,
): boolean {
  const validatedCandidate = capabilityEnvelopeV1Schema.parse(candidate);
  const validatedCompiled = capabilityEnvelopeV1Schema.parse(compiled);
  if (
    validatedCandidate.schema_version !== validatedCompiled.schema_version ||
    validatedCandidate.workspace.allowed_scope_digest !==
      validatedCompiled.workspace.allowed_scope_digest ||
    validatedCandidate.workspace.execution_mode !==
      validatedCompiled.workspace.execution_mode ||
    validatedCandidate.workspace.scope_assurance !==
      validatedCompiled.workspace.scope_assurance ||
    validatedCandidate.runtime.containment_assurance !==
      validatedCompiled.runtime.containment_assurance ||
    validatedCandidate.runtime.machine_authority !==
      validatedCompiled.runtime.machine_authority ||
    validatedCandidate.runtime.mcp !== validatedCompiled.runtime.mcp ||
    validatedCandidate.runtime.credentials !==
      validatedCompiled.runtime.credentials
  ) {
    return false;
  }

  const compiledCommands = new Set(
    validatedCompiled.runtime.approved_command_forms.map(canonicalCommandForm),
  );
  const compiledUrls = new Set(
    validatedCompiled.runtime.approved_url_operations.map(
      canonicalUrlOperation,
    ),
  );
  return (
    validatedCandidate.runtime.approved_command_forms.every((form) =>
      compiledCommands.has(canonicalCommandForm(form)),
    ) &&
    validatedCandidate.runtime.approved_url_operations.every((operation) =>
      compiledUrls.has(canonicalUrlOperation(operation)),
    )
  );
}
