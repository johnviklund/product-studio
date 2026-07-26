import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  PatchWorkflowSection,
  RunEvidenceSection,
} from "../components/kanban/detail-panel";
import { nextActionForCardState } from "../components/kanban/board-card";

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

const noop = () => undefined;

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
  });
});
