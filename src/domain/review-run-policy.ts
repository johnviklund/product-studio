import { createHash } from "node:crypto";

import { z } from "zod";

import {
  canonicalizeCapabilityRequest,
  type CanonicalCapabilityRequest,
} from "./capability-envelope";
import { workspaceRelativePosixPathSchema } from "./workspace-path";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export interface ReviewRunPolicy {
  kind: "single_result_file";
  result_path: string;
  mission_result_binding_sha256: string;
  commands: "forbidden";
  urls: "forbidden";
  mcp: "forbidden";
  credentials: "forbidden";
  outside_workspace_writes: "forbidden";
  reads: "workspace_and_repository_unrestricted";
  execution_mode: "permission_mediated_local";
  result_assurance: "result_scope_validation";
  containment_assurance: "not_independently_enforced";
  machine_authority: "launching_user";
}

export interface ReviewPermissionEvaluation {
  decision: "allow_once" | "reject_once";
  reason: "review_run_read_only" | null;
}

export const reviewRunPolicySchema: z.ZodType<ReviewRunPolicy> =
  z.strictObject({
    kind: z.literal("single_result_file"),
    result_path: workspaceRelativePosixPathSchema,
    mission_result_binding_sha256: sha256Schema,
    commands: z.literal("forbidden"),
    urls: z.literal("forbidden"),
    mcp: z.literal("forbidden"),
    credentials: z.literal("forbidden"),
    outside_workspace_writes: z.literal("forbidden"),
    reads: z.literal("workspace_and_repository_unrestricted"),
    execution_mode: z.literal("permission_mediated_local"),
    result_assurance: z.literal("result_scope_validation"),
    containment_assurance: z.literal("not_independently_enforced"),
    machine_authority: z.literal("launching_user"),
  });

export function deriveReviewMissionResultBindingSha256(
  missionContentSha256: string,
  resultPath: string,
): string {
  const mission = sha256Schema.parse(missionContentSha256);
  const path = workspaceRelativePosixPathSchema.parse(resultPath);
  return createHash("sha256")
    .update(
      `${JSON.stringify(
        {
          mission_content_sha256: mission,
          result_path: path,
        },
        null,
        2,
      )}\n`,
    )
    .digest("hex");
}

export function hashReviewRunPolicy(policy: ReviewRunPolicy): string {
  const validated = reviewRunPolicySchema.parse(policy);
  return createHash("sha256")
    .update(`${JSON.stringify(validated, null, 2)}\n`)
    .digest("hex");
}

export function evaluateReviewPermissionRequest(
  policy: ReviewRunPolicy,
  normalizedRequest: CanonicalCapabilityRequest,
): ReviewPermissionEvaluation {
  const validatedPolicy = reviewRunPolicySchema.parse(policy);
  try {
    const request = canonicalizeCapabilityRequest(normalizedRequest);
    if (
      request.kind === "workspace_write" &&
      request.path === validatedPolicy.result_path
    ) {
      return { decision: "allow_once", reason: null };
    }
  } catch {
    // Malformed or non-canonical requests fail closed under the same read-only reason.
  }
  return { decision: "reject_once", reason: "review_run_read_only" };
}
