import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ConnectedExecuteSection,
  PatchWorkflowSection,
  RunEvidenceSection,
} from "../components/kanban/detail-panel";
import { nextActionForCardState } from "../components/kanban/board-card";
import type { ConnectedRunSummary } from "../src/domain/connected-run";

const workItemId = "wi_550e8400-e29b-41d4-a716-446655440000";
const missionContentSha256 = "a".repeat(64);
const resultContentSha256 = "b".repeat(64);
const gitCommit = "c".repeat(40);
const evidencePath = `.founder/run-evidence/${workItemId}/review-1-1-0/${"d".repeat(64)}`;

const attention = {
  kind: "patch_plan_approval" as const,
  question: "Approve one patch that addresses these exact findings?",
  recommendation: "Approve the bounded patch plan.",
  created_at: "2026-07-25T12:00:00.000Z",
  governed_tuple: {
    goal_version: 1,
    input_revision: 1,
    attempt: 0,
    patch_cycle: 0,
  },
  pins: {
    artifact_paths: [
      `.founder/missions/${workItemId}/review-1-1-0/mission.json`,
      `.founder/missions/${workItemId}/review-1-1-0/result.json`,
    ] as [string, ...string[]],
    evidence_paths: [evidencePath],
    git_commit: gitCommit,
    mission_content_sha256: missionContentSha256,
    result_content_sha256: resultContentSha256,
  },
};

const missingPermissionAttention = {
  ...attention,
  kind: "missing_permission" as const,
  operation: {
    normalized_operation: {
      schema_version: 1 as const,
      kind: "command" as const,
      executable: "git",
      args: ["status"],
    },
    canonical_args_sha256: "e".repeat(64),
    operation_sha256: "f".repeat(64),
    reason: "The command is outside the compiled capability envelope.",
    resolved_envelope_sha256: "a".repeat(64),
    connected_run_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1",
  },
};

const noop = () => undefined;
const connectedRun: ConnectedRunSummary = {
  schema_version: 1,
  connected_run_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1",
  mission: {
    identity: {
      phase: "execute",
      work_item_id: workItemId,
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
    },
    content_sha256: missionContentSha256,
    source_commit: gitCommit,
  },
  governed_tuple: {
    goal_version: 1,
    input_revision: 1,
    attempt: 0,
    patch_cycle: 0,
  },
  provenance: {
    role: { value: "writer", assurance: "controller_observed" },
    seat: { value: "execute", assurance: "controller_observed" },
    requested_model: { value: "one-run-model", assurance: "user_declared" },
    effective_model: {
      assurance: "adapter_attested",
      model_id: "observed-model",
      deployment_id: null,
      observed_event_sha256: "d".repeat(64),
    },
    effort: { value: "high", assurance: "user_declared" },
    harness: {
      value: { id: "copilot-cli", version: "1.0.75" },
      assurance: "controller_observed",
    },
    adapter_profile: {
      value: {
        adapter_id: "copilot-acp",
        adapter_version: "1",
        profile_id: "execute-v1",
      },
      assurance: "controller_observed",
    },
  },
  capability_envelope_sha256: "e".repeat(64),
  acp_protocol_version: { value: 1, assurance: "adapter_attested" },
  lifecycle: {
    status: "running",
    started_at: "2026-07-26T12:00:00.000Z",
    updated_at: "2026-07-26T12:01:00.000Z",
    completed_at: null,
    terminal_outcome: null,
    partial: false,
  },
  diagnostics: { count: 1, truncated: false },
};

describe("detail panel patch workflow", () => {
  it("renders one evidence-bound patch-plan action with governed unknown cost", () => {
    const html = renderToStaticMarkup(
      <PatchWorkflowSection
        fieldId="detail"
        projection={{
          mode: "patch_plan",
          action: "accept_patch_plan",
          attention,
          patch_cycle: 0,
        }}
        patchCycle={0}
        mutation={null}
        compilation={null}
        importedEvidence={null}
        copied={false}
        onAcceptPatchPlan={noop}
        onCompilePatch={noop}
        onImportPatch={noop}
        onCopyLaunchInstruction={noop}
      />,
    );

    expect(html).toContain(attention.question);
    expect(html).toContain(attention.recommendation);
    expect(html).toContain("0 of 3");
    expect(html).toContain("Cost/capacity");
    expect(html).toContain("unknown");
    expect(html).toContain("Approve patch plan");
    expect(html).not.toContain("Compile patch mission");
    expect(html).not.toContain("Import patch result");
  });

  it("keeps immutable command evidence collapsed until explicitly opened", () => {
    const importRunId = "e".repeat(64);
    const evidence = [
      {
        evidence: {
          schema_version: 2 as const,
          phase: "execute" as const,
          import_run_id: importRunId,
          result_content_sha256: resultContentSha256,
          mission_content_sha256: missionContentSha256,
          identity: {
            phase: "execute" as const,
            work_item_id: workItemId,
            goal_version: 1,
            input_revision: 1,
            attempt: 0,
          },
          git_base_commit: gitCommit,
          controller_run_id: "run-1",
          started_at: "2026-07-25T12:00:00.000Z",
          completed_at: "2026-07-25T12:00:01.000Z",
          outcome: "applied" as const,
          reasons: [],
          result_commit: gitCommit,
        },
        summary: {
          phase: "execute" as const,
          import_run_id: importRunId,
          outcome: "applied" as const,
          evidence_path: evidencePath,
          reasons: [],
        },
        verification: [
          {
            name: "tests",
            argv: ["npm", "run", "test"] as [string, ...string[]],
            started_at: "2026-07-25T12:00:00.000Z",
            completed_at: "2026-07-25T12:00:01.000Z",
            duration_ms: 1_000,
            status: "passed" as const,
            exit_code: 0,
            signal: null,
            stdout: "private command output",
            stderr: "",
            output_truncated: false,
          },
        ],
      },
    ];
    const collapsed = renderToStaticMarkup(
      <RunEvidenceSection
        fieldId="detail"
        evidence={evidence}
        loading={false}
        error={null}
        expandedRunIds={new Set()}
        onToggle={noop}
      />,
    );
    const expanded = renderToStaticMarkup(
      <RunEvidenceSection
        fieldId="detail"
        evidence={evidence}
        loading={false}
        error={null}
        expandedRunIds={new Set([`execute:${importRunId}`])}
        onToggle={noop}
      />,
    );

    expect(collapsed).toContain("View details");
    expect(collapsed).not.toContain("private command output");
    expect(expanded).toContain("Hide details");
    expect(expanded).toContain("private command output");
  });
});

describe("detail panel connected execution", () => {
  it("keeps the connected surface compact and sanitized", () => {
    const html = renderToStaticMarkup(
      <ConnectedExecuteSection
        fieldId="detail"
        projection={{ mode: "launch", can_launch: true, permission: null }}
        runs={[connectedRun]}
        loading={false}
        error={null}
        modelOverride="one-run-model"
        mutation={null}
        onModelOverrideChange={noop}
        onLaunch={noop}
        onAllowOnce={noop}
        onKeepDenied={noop}
      />,
    );

    expect(html).toContain("Connected execution");
    expect(html).toContain("this run only");
    expect(html).toContain("Launch connected run");
    expect(html).toContain("copilot-cli 1.0.75");
    expect(html).toContain("observed-model");
    expect(html).toContain("manual mission handoff below");
    expect(html).not.toContain("stdout");
    expect(html).not.toContain("terminal output");
    expect(html).not.toContain("token stream");
  });

  it("renders both recovery actions against the exact permission hash", () => {
    const operationSha256 = "f".repeat(64);
    const html = renderToStaticMarkup(
      <ConnectedExecuteSection
        fieldId="detail"
        projection={{
          mode: "permission",
          can_launch: false,
          permission: {
            kind: "missing_permission",
            question: "Allow this exact operation once and retry?",
            recommendation: "Keep it denied unless it is required.",
            created_at: "2026-07-26T12:00:00.000Z",
            governed_tuple: connectedRun.governed_tuple,
            pins: {
              artifact_paths: [".founder/missions/mission.json"],
              evidence_paths: [],
              mission_content_sha256: missionContentSha256,
            },
            operation: {
              normalized_operation: {
                schema_version: 1,
                kind: "command",
                executable: "git",
                args: ["status"],
              },
              canonical_args_sha256: "a".repeat(64),
              operation_sha256: operationSha256,
              reason: "Outside the governed envelope.",
              resolved_envelope_sha256: "b".repeat(64),
              connected_run_id: connectedRun.connected_run_id,
            },
          },
        }}
        runs={[]}
        loading={false}
        error={null}
        modelOverride=""
        mutation={null}
        onModelOverrideChange={noop}
        onLaunch={noop}
        onAllowOnce={noop}
        onKeepDenied={noop}
      />,
    );

    expect(html).toContain(operationSha256);
    expect(html).toContain("Allow once and retry");
    expect(html).toContain("Keep denied");
    expect(html).not.toContain("Launch connected run");
  });
});

describe("board card patch attention", () => {
  it("shows only the current patch or attention action", () => {
    expect(
      nextActionForCardState({
        phase: "review",
        status: "active",
        attention,
      }),
    ).toBe("Approve the patch plan");
    expect(
      nextActionForCardState({
        phase: "patch",
        status: "active",
      }),
    ).toBe("Compile or import the patch");
    expect(
      nextActionForCardState({
        phase: "review",
        status: "active",
        attention: { ...attention, kind: "review_ready" },
      }),
    ).toBe("Review the result");
    expect(
      nextActionForCardState({
        phase: "review",
        status: "blocked",
        attention,
      }),
    ).toBe("Test the result");
    expect(
      nextActionForCardState({
        phase: "execute",
        status: "active",
        attention: missingPermissionAttention,
      }),
    ).toBe("Review the result");
  });
});
