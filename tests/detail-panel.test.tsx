import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  ConnectedExecuteSection,
  PatchWorkflowSection,
  RunEvidenceSection,
  ShapingSection,
  specProposalToGoalContractDraft,
} from "../components/kanban/detail-panel";
import { nextActionForCardState } from "../components/kanban/board-card";
import type {
  BrainstormMissionCompilation,
  ShapingAcceptanceResult,
  ShapingImportResult,
  SpecMissionCompilation,
} from "../src/application/portfolio";
import type { ConnectedRunSummary } from "../src/domain/connected-run";
import type {
  BrainstormMissionPackage,
  BrainstormResultSubmission,
  SpecMissionPackage,
  SpecResultSubmission,
  StoredShapingArtifact,
} from "../src/domain/shaping";

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

const brainstormIdentity = {
  phase: "brainstorm" as const,
  work_item_id: workItemId,
  input_sha256: "1".repeat(64),
};
const brainstormMission: BrainstormMissionPackage = {
  shaping_schema_version: 1,
  identity: brainstormIdentity,
  input: {
    phase: "brainstorm",
    title: "Make shaping evidence explicit",
  },
  result_contract: {
    schema_version: 1,
    output_path: `.founder/shaping/${workItemId}/brainstorm-${"1".repeat(64)}/result.json`,
    result_schema_version: 1,
    required_fields: [
      "result_schema_version",
      "brainstorm_mission_content_sha256",
      "identity",
      "problem_statement",
      "approach",
      "non_goals",
      "open_questions",
    ],
  },
  task_path: `.founder/shaping/${workItemId}/brainstorm-${"1".repeat(64)}/TASK.md`,
  content_sha256: missionContentSha256,
};
const brainstormResult: BrainstormResultSubmission = {
  result_schema_version: 1,
  brainstorm_mission_content_sha256: missionContentSha256,
  identity: brainstormIdentity,
  problem_statement: "Founders need evidence before adopting a goal contract.",
  approach: "Shape externally, inspect locally, then accept one exact result.",
  non_goals: ["No automatic goal-contract save"],
  open_questions: ["Which acceptance should feed Spec?"],
};
const brainstormCompilation: BrainstormMissionCompilation = {
  mission: brainstormMission,
  workspace_path: "/workspace/product-studio",
  task_path: brainstormMission.task_path,
  mission_path: `.founder/shaping/${workItemId}/brainstorm-${"1".repeat(64)}/mission.json`,
};
const brainstormImport: ShapingImportResult = {
  source_id: "source-1",
  work_item_id: workItemId,
  receipt: {
    shaping_schema_version: 1,
    identity: brainstormIdentity,
    shaping_mission_content_sha256: missionContentSha256,
    result_content_sha256: resultContentSha256,
    outcome: "applied",
    imported_at: "2026-07-29T10:00:00.000Z",
    reasons: [],
  },
  result: brainstormResult,
};
const acceptanceContentSha256 = "3".repeat(64);
const brainstormAcceptance: ShapingAcceptanceResult = {
  source_id: "source-1",
  work_item_id: workItemId,
  acceptance: {
    shaping_schema_version: 1,
    identity: brainstormIdentity,
    brainstorm_mission_content_sha256: missionContentSha256,
    brainstorm_result_content_sha256: resultContentSha256,
    accepted_at: "2026-07-29T10:01:00.000Z",
  },
  acceptance_path: `.founder/shaping/${workItemId}/brainstorm-${"1".repeat(64)}/acceptance.json`,
  acceptance_content_sha256: acceptanceContentSha256,
};
const acceptedBrainstormArtifact: StoredShapingArtifact = {
  mission: brainstormMission,
  mission_path: brainstormCompilation.mission_path,
  task_path: brainstormCompilation.task_path,
  result: {
    result_path: brainstormMission.result_contract.output_path,
    result_source: `${JSON.stringify(brainstormResult, null, 2)}\n`,
    result_content_sha256: resultContentSha256,
  },
  import_receipt: brainstormImport.receipt,
  import_path: `.founder/shaping/${workItemId}/brainstorm-${"1".repeat(64)}/import.json`,
  acceptance: {
    receipt: brainstormAcceptance.acceptance,
    acceptance_path: brainstormAcceptance.acceptance_path,
    acceptance_content_sha256: acceptanceContentSha256,
  },
};
const specIdentity = {
  phase: "spec" as const,
  work_item_id: workItemId,
  input_sha256: "4".repeat(64),
};
const specMission: SpecMissionPackage = {
  shaping_schema_version: 1,
  identity: specIdentity,
  input: {
    phase: "spec",
    title: brainstormMission.input.title,
    brainstorm_acceptance_sha256: acceptanceContentSha256,
    brainstorm_acceptance: brainstormAcceptance.acceptance,
    brainstorm_result: brainstormResult,
  },
  result_contract: {
    schema_version: 1,
    output_path: `.founder/shaping/${workItemId}/spec-${"4".repeat(64)}/result.json`,
    result_schema_version: 1,
    required_fields: [
      "result_schema_version",
      "spec_mission_content_sha256",
      "identity",
      "proposal",
    ],
  },
  task_path: `.founder/shaping/${workItemId}/spec-${"4".repeat(64)}/TASK.md`,
  content_sha256: "5".repeat(64),
};
const specCompilation: SpecMissionCompilation = {
  mission: specMission,
  workspace_path: "/workspace/product-studio",
  task_path: specMission.task_path,
  mission_path: `.founder/shaping/${workItemId}/spec-${"4".repeat(64)}/mission.json`,
};
const specResult: SpecResultSubmission = {
  result_schema_version: 1,
  spec_mission_content_sha256: specMission.content_sha256,
  identity: specIdentity,
  proposal: {
    purpose: "Let founders adopt one reviewed shaping proposal.",
    acceptance_criteria: ["Proposal fields remain local until Save"],
    non_goals: ["No automatic persistence"],
    allowed_scope: ["components/kanban/detail-panel.tsx"],
    review_ready: ["Focused UI tests pass"],
  },
};
const specImport: ShapingImportResult = {
  source_id: "source-1",
  work_item_id: workItemId,
  receipt: {
    shaping_schema_version: 1,
    identity: specIdentity,
    shaping_mission_content_sha256: specMission.content_sha256,
    result_content_sha256: "6".repeat(64),
    outcome: "applied",
    imported_at: "2026-07-29T10:02:00.000Z",
    reasons: [],
  },
  result: specResult,
};

type ShapingProps = ComponentProps<typeof ShapingSection>;

function renderShaping(overrides: Partial<ShapingProps> = {}): string {
  const props: ShapingProps = {
    fieldId: "detail",
    projection: {
      mode: "active",
      phase: "brainstorm",
      required_input: "none",
      can_compile: true,
      can_import: true,
    },
    artifacts: [],
    loading: false,
    error: null,
    selectedAcceptanceSha256: "",
    mutation: null,
    compilation: null,
    imported: null,
    acceptance: null,
    copiedTarget: null,
    onSelectAcceptance: noop,
    onCompile: noop,
    onImport: noop,
    onAccept: noop,
    onCopy: noop,
    onUseProposal: noop,
    ...overrides,
  };
  return renderToStaticMarkup(<ShapingSection {...props} />);
}
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

describe("detail panel shaping workflow", () => {
  it("renders the eligible Brainstorm controls and an explicit empty state", () => {
    const html = renderShaping();

    expect(html).toContain("Brainstorm shaping");
    expect(html).toContain("No shaping artifacts yet");
    expect(html).toContain("Compile Brainstorm mission");
    expect(html).toContain("Import result");
    expect(html).not.toContain("Use Brainstorm as Spec input");
  });

  it("shows all imported Brainstorm evidence and immutable handoff values", () => {
    const html = renderShaping({
      compilation: brainstormCompilation,
      imported: brainstormImport,
      copiedTarget: "content_sha256",
    });

    expect(html).toContain("Imported Brainstorm evidence");
    expect(html).toContain("Evidence · Problem statement");
    expect(html).toContain(brainstormResult.problem_statement);
    expect(html).toContain("Evidence · Approach");
    expect(html).toContain("Evidence · Non-goals");
    expect(html).toContain("Evidence · Open questions");
    expect(html).toContain("Immutable mission handoff");
    expect(html).toContain("TASK.md");
    expect(html).toContain("Mission JSON");
    expect(html).toContain("Workspace");
    expect(html).toContain("Content SHA");
    expect(html).toContain("Use Brainstorm as Spec input");
    expect(html).toContain("Copied");
  });

  it("labels an accepted Brainstorm result as the selected Spec input", () => {
    const html = renderShaping({
      artifacts: [acceptedBrainstormArtifact],
      imported: brainstormImport,
      acceptance: brainstormAcceptance,
    });

    expect(html).toContain("Selected as Spec input");
    expect(html).toContain(acceptanceContentSha256);
    expect(html).not.toContain("Use Brainstorm as Spec input");
  });

  it("blocks Spec compilation while no accepted Brainstorm input exists", () => {
    const html = renderShaping({
      projection: {
        mode: "active",
        phase: "spec",
        required_input: "brainstorm_acceptance_sha256",
        can_compile: true,
        can_import: true,
      },
    });

    expect(html).toContain("Spec shaping");
    expect(html).toContain("No accepted Brainstorm results are available");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Compile Spec mission<\/button>/);
  });

  it("shows accepted Brainstorm evidence before compiling a Spec mission", () => {
    const html = renderShaping({
      projection: {
        mode: "active",
        phase: "spec",
        required_input: "brainstorm_acceptance_sha256",
        can_compile: true,
        can_import: true,
      },
      artifacts: [acceptedBrainstormArtifact],
      selectedAcceptanceSha256: acceptanceContentSha256,
      compilation: specCompilation,
    });

    expect(html).toContain("Accepted Brainstorm input");
    expect(html).toContain(brainstormResult.problem_statement);
    expect(html).toContain(`Evidence · ${brainstormResult.approach}`);
    expect(html).toContain(acceptanceContentSha256);
    expect(html).not.toContain("stale or unavailable");
  });

  it("keeps an imported Spec visibly provisional until Save", () => {
    const html = renderShaping({
      projection: {
        mode: "active",
        phase: "spec",
        required_input: "brainstorm_acceptance_sha256",
        can_compile: true,
        can_import: true,
      },
      artifacts: [acceptedBrainstormArtifact],
      selectedAcceptanceSha256: acceptanceContentSha256,
      imported: specImport,
    });

    expect(html).toContain("Imported Spec proposal");
    expect(html).toContain("Proposal · Purpose");
    expect(html).toContain("Proposal · Acceptance criteria");
    expect(html).toContain("Proposal · Non-goals");
    expect(html).toContain("Proposal · Allowed scope");
    expect(html).toContain("Proposal · Review ready");
    expect(html).toContain("Use proposal as draft");
    expect(html).toContain("Save remains the single durable action");
  });

  it("renders load failure, rejected import, and stale selection states", () => {
    const failure = renderShaping({ error: "Shaping history could not be loaded." });
    const rejected = renderShaping({
      imported: {
        ...brainstormImport,
        receipt: {
          ...brainstormImport.receipt,
          outcome: "rejected",
          reasons: ["identity.input_sha256 does not match the mission"],
        },
        result: undefined,
      },
    });
    const stale = renderShaping({
      projection: {
        mode: "active",
        phase: "spec",
        required_input: "brainstorm_acceptance_sha256",
        can_compile: true,
        can_import: true,
      },
      artifacts: [acceptedBrainstormArtifact],
      selectedAcceptanceSha256: "9".repeat(64),
    });

    expect(failure).toContain("Shaping history could not be loaded.");
    expect(rejected).toContain("Imported result rejected");
    expect(rejected).toContain("identity.input_sha256 does not match the mission");
    expect(stale).toContain("stale or unavailable");
  });

  it("maps the same proposal to the same local draft without browser effects", () => {
    const fetchSpy = vi.fn();
    const writeTextSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("navigator", { clipboard: { writeText: writeTextSpy } });

    try {
      const first = specProposalToGoalContractDraft(specResult.proposal);
      const second = specProposalToGoalContractDraft(specResult.proposal);

      expect(first).toEqual(second);
      expect(first).toEqual({
        purpose: specResult.proposal.purpose,
        acceptanceCriteria: "Proposal fields remain local until Save",
        nonGoals: "No automatic persistence",
        allowedScope: "components/kanban/detail-panel.tsx",
        reviewReady: "Focused UI tests pass",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(writeTextSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

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
