import { describe, expect, it } from "vitest";

import type { CanonicalCapabilityRequest } from "../../src/domain/capability-envelope";
import {
  deriveReviewMissionResultBindingSha256,
  evaluateReviewPermissionRequest,
  hashReviewRunPolicy,
  reviewRunPolicySchema,
  type ReviewRunPolicy,
} from "../../src/domain/review-run-policy";

const missionContentSha256 = "a".repeat(64);
const resultPath =
  ".founder/missions/wi_550e8400-e29b-41d4-a716-446655440000/review-2-3-1/result.json";
const policy: ReviewRunPolicy = {
  kind: "single_result_file",
  result_path: resultPath,
  mission_result_binding_sha256: deriveReviewMissionResultBindingSha256(
    missionContentSha256,
    resultPath,
  ),
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
};

describe("review-run policy", () => {
  it("defines strict, hashable single-result-file policy bytes", () => {
    expect(reviewRunPolicySchema.parse(policy)).toEqual(policy);
    expect(hashReviewRunPolicy(policy)).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      reviewRunPolicySchema.parse({ ...policy, commands: "allowed" }),
    ).toThrow();
    expect(() => reviewRunPolicySchema.parse({ ...policy, token: "secret" })).toThrow();
  });

  it("allows only the exact result path and rejects every other request read-only", () => {
    expect(
      evaluateReviewPermissionRequest(policy, {
        schema_version: 1,
        kind: "workspace_write",
        path: resultPath,
      }),
    ).toEqual({ decision: "allow_once", reason: null });

    const deniedRequests: CanonicalCapabilityRequest[] = [
      {
        schema_version: 1,
        kind: "workspace_write",
        path: resultPath.replace("result.json", "sibling.json"),
      },
      {
        schema_version: 1,
        kind: "workspace_write",
        path: ".founder/missions/wi_550e8400-e29b-41d4-a716-446655440000/review-2-3-1",
      },
      {
        schema_version: 1,
        kind: "workspace_write",
        path: `${resultPath}/../result.json`,
      },
      {
        schema_version: 1,
        kind: "command",
        executable: "npm",
        args: ["test"],
      },
      {
        schema_version: 1,
        kind: "url",
        method: "GET",
        protocol: "https",
        host: "example.com",
        path: "/",
      },
      { schema_version: 1, kind: "mcp", server: "filesystem" },
      { schema_version: 1, kind: "credential", source: "environment" },
    ];

    for (const request of deniedRequests) {
      expect(evaluateReviewPermissionRequest(policy, request)).toEqual({
        decision: "reject_once",
        reason: "review_run_read_only",
      });
    }
  });
});
