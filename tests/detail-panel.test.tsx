import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  canEditGoalContractFromFullWorkItem,
  ConnectedExecuteSection,
  PatchWorkflowSection,
  RunEvidenceSection,
  selectedModelForShapingPicker,
  ShapingDecisionView,
  ShapingSection,
  specProposalToGoalContractDraft,
} from "../components/kanban/detail-panel";
import { nextActionForCardState } from "../components/kanban/board-card";
import type {
  BrainstormMissionCompilation,
  ShapingImportResult,
  SpecMissionCompilation,
} from "../src/application/portfolio";
import type { ConnectedRunSummary } from "../src/domain/connected-run";
import type {
  BrainstormMissionPackage,
  BrainstormResultSubmission,
  PlanResultSubmission,
  ShapingPhase,
  ShapingResultSubmission,
  SpecMissionPackage,
  SpecResultSubmission,
  StoredShapingArtifact,
} from "../src/domain/shaping";
import type { ShapingModelPickerOption } from "../src/domain/portfolio-preferences";
import type { GoalContract, WorkItemPhase } from "../src/domain/work-item";
import {
  shapingHandoffForItem,
  type DecisionFirstShapingHandoffProjection,
  type ShapingHandoffItemProjectionInput,
  type ShapingRunProjectionInput,
  type ShapingSurfaceContext,
} from "../src/presentation/board";
import { shapingActionRequest } from "../src/presentation/shaping-interaction";

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
const brainstormDirectory = `.founder/shaping/${workItemId}/brainstorm-${"1".repeat(64)}`;
const brainstormTaskPath = `${brainstormDirectory}/TASK.md`;
const brainstormResultPath = `${brainstormDirectory}/result.json`;
const brainstormMission: BrainstormMissionPackage = {
  shaping_schema_version: 2,
  identity: brainstormIdentity,
  input: {
    phase: "brainstorm",
    title: "Make shaping evidence explicit",
  },
  result_contract: {
    schema_version: 1,
    result_file: "result.json",
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
  task_path: brainstormTaskPath,
  mission_path: `.founder/shaping/${workItemId}/brainstorm-${"1".repeat(64)}/mission.json`,
};
const brainstormImport: ShapingImportResult = {
  source_id: "source-1",
  work_item_id: workItemId,
  outcome: "applied",
  receipt: {
    shaping_schema_version: 2,
    identity: brainstormIdentity,
    shaping_mission_content_sha256: missionContentSha256,
    result_content_sha256: resultContentSha256,
    outcome: "applied",
    first_published_at: "2026-07-29T10:00:00.000Z",
    reasons: [],
  },
  result: brainstormResult,
};
const acceptanceContentSha256 = "3".repeat(64);
const brainstormSelection = {
  shaping_schema_version: 2 as const,
  identity: brainstormIdentity,
  mission_content_sha256: missionContentSha256,
  result_content_sha256: resultContentSha256,
  selected_at: "2026-07-29T10:01:00.000Z",
};
const acceptedBrainstormArtifact: StoredShapingArtifact = {
  mission: brainstormMission,
  mission_path: brainstormCompilation.mission_path,
  task_path: brainstormCompilation.task_path,
  result: {
    result_path: brainstormResultPath,
    result_source: `${JSON.stringify(brainstormResult, null, 2)}\n`,
    result_content_sha256: resultContentSha256,
  },
  import_receipt: brainstormImport.receipt,
  import_path: `.founder/shaping/${workItemId}/brainstorm-${"1".repeat(64)}/import.json`,
  production_receipt: null,
  production_path: null,
  applied_marker: null,
  applied_marker_path: null,
  decision: {
    receipt: brainstormSelection,
    decision_path: `.founder/shaping/${workItemId}/brainstorm-${"1".repeat(64)}/decision.json`,
    decision_content_sha256: acceptanceContentSha256,
  },
};
const specIdentity = {
  phase: "spec" as const,
  work_item_id: workItemId,
  input_sha256: "4".repeat(64),
};
const specDirectory = `.founder/shaping/${workItemId}/spec-${"4".repeat(64)}`;
const specTaskPath = `${specDirectory}/TASK.md`;
const specMission: SpecMissionPackage = {
  shaping_schema_version: 2,
  identity: specIdentity,
  input: {
    phase: "spec",
    title: brainstormMission.input.title,
    brainstorm_selection_sha256: acceptanceContentSha256,
    brainstorm_selection: brainstormSelection,
    brainstorm_result: brainstormResult,
  },
  result_contract: {
    schema_version: 1,
    result_file: "result.json",
    result_schema_version: 1,
    required_fields: [
      "result_schema_version",
      "spec_mission_content_sha256",
      "identity",
      "proposal",
    ],
  },
  content_sha256: "5".repeat(64),
};
const specCompilation: SpecMissionCompilation = {
  mission: specMission,
  workspace_path: "/workspace/product-studio",
  task_path: specTaskPath,
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
  outcome: "applied",
  receipt: {
    shaping_schema_version: 2,
    identity: specIdentity,
    shaping_mission_content_sha256: specMission.content_sha256,
    result_content_sha256: "6".repeat(64),
    outcome: "applied",
    first_published_at: "2026-07-29T10:02:00.000Z",
    reasons: [],
  },
  result: specResult,
};

const shapingStateSha256 = "8".repeat(64);
const goalContractSha256 = "9".repeat(64);
const planResult: PlanResultSubmission = {
  result_schema_version: 1,
  plan_mission_content_sha256: missionContentSha256,
  identity: {
    phase: "plan",
    work_item_id: workItemId,
    input_sha256: "7".repeat(64),
  },
  summary: "Implement the guided decision surfaces in bounded steps.",
  checklist: Array.from({ length: 7 }, (_, index) => ({
    id: `P${index + 1}`,
    step: `Plan checklist step ${index + 1}`,
    verification_check: `Verify plan checklist step ${index + 1}`,
  })),
  relevant_skills: ["frontend-design"],
  product_doc_impacts: ["PRODUCT.md"],
  todo_impacts: [],
  open_questions: ["When should Execute be opened?"],
};
const decisionGoalContract: GoalContract = {
  schema_version: 1,
  goal_version: 1,
  purpose: specResult.proposal.purpose,
  acceptance_criteria: [...specResult.proposal.acceptance_criteria],
  non_goals: [...specResult.proposal.non_goals],
  allowed_scope: [...specResult.proposal.allowed_scope],
  review_ready: [...specResult.proposal.review_ready],
};

function decisionModelOption(
  modelId: string,
  overrides: Partial<ShapingModelPickerOption> = {},
): ShapingModelPickerOption {
  return {
    model_id: modelId,
    used_by_seats: [],
    saved_preference: false,
    recommended: false,
    preselected: false,
    reuse_warning: null,
    ...overrides,
  };
}

type DecisionSurfaceContextOverrides = Omit<
  Partial<ShapingSurfaceContext>,
  "models"
> & {
  models?: Partial<ShapingSurfaceContext["models"]>;
};

function decisionSurfaceContext(
  overrides: DecisionSurfaceContextOverrides = {},
): ShapingSurfaceContext {
  const { models: modelOverrides, ...contextOverrides } = overrides;
  const models: ShapingSurfaceContext["models"] = {
    status: "available",
    reason: null,
    available_model_ids: ["model-a", "model-b", "model-c"],
    model_use: [
      {
        seat: "brainstorm",
        production_id: "prod-brainstorm",
        shaping_run_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1",
        requested_model: "model-a",
        effective_model: null,
      },
    ],
    model_picker_options: {
      brainstorm: [
        decisionModelOption("model-a", {
          recommended: true,
          preselected: true,
        }),
        decisionModelOption("model-b"),
        decisionModelOption("model-c"),
      ],
      spec: [
        decisionModelOption("model-b", {
          recommended: true,
          preselected: true,
        }),
        decisionModelOption("model-c"),
        decisionModelOption("model-a", {
          used_by_seats: ["brainstorm"],
          reuse_warning: "model-a was already used by brainstorm.",
        }),
      ],
      plan: [
        decisionModelOption("model-c", {
          recommended: true,
          preselected: true,
        }),
        decisionModelOption("model-b"),
        decisionModelOption("model-a", {
          used_by_seats: ["brainstorm"],
          reuse_warning: "model-a was already used by brainstorm.",
        }),
      ],
    },
  };
  return {
    expected_shaping_state_sha256: shapingStateSha256,
    revision: {
      mission_content_sha256: missionContentSha256,
      result: { status: "none" },
    },
    run: null,
    models: { ...models, ...modelOverrides },
    refresh: {
      last_checked_at: "2026-08-03T12:00:00.000Z",
      refreshing: false,
      stale: false,
      refresh_failure: null,
    },
    derived_goal_contract_sha256: goalContractSha256,
    current_goal_contract_sha256: goalContractSha256,
    post_commit_launch_failure: null,
    manual_recovery: null,
    ...contextOverrides,
  };
}

function decisionItem(
  phase: WorkItemPhase,
  contract?: GoalContract,
): ShapingHandoffItemProjectionInput {
  return {
    source_id: "source-1",
    work_item: {
      goal: contract === undefined ? {} : { goal_contract: contract },
      state: { phase, status: "active" },
    },
  };
}

function decisionRun(
  status: ShapingRunProjectionInput["status"],
  terminalOutcome: ShapingRunProjectionInput["terminal_outcome"] = null,
  overrides: Partial<ShapingRunProjectionInput> = {},
): ShapingRunProjectionInput {
  return {
    shaping_run_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1",
    status,
    terminal_outcome: terminalOutcome,
    latest_update: "Inspecting the bounded mission.",
    sanitized_reason: "The result failed validation.",
    denied_operation_kind: "url",
    timeout_limit: "The 900 second wall-clock limit",
    ...overrides,
  };
}

function appliedDecisionContext(
  phase: ShapingPhase,
  result: ShapingResultSubmission,
  overrides: DecisionSurfaceContextOverrides = {},
): ShapingSurfaceContext {
  return decisionSurfaceContext({
    revision: {
      mission_content_sha256: missionContentSha256,
      result: {
        status: "applied",
        result_content_sha256: resultContentSha256,
        result,
      },
      ...(phase === "plan"
        ? {
            plan_goal_contract_sha256: goalContractSha256,
            plan_goal_version: 1,
          }
        : {}),
    },
    ...overrides,
  });
}

function renderDecision(
  projection: DecisionFirstShapingHandoffProjection,
  selectedModel: string | null = null,
): string {
  return renderToStaticMarkup(
    <ShapingDecisionView
      fieldId="decision"
      projection={projection}
      selectedModel={selectedModel}
      onSelectModel={noop}
      onAction={noop}
      onShowFullWorkItem={noop}
    />,
  );
}

function visibleMarkup(html: string): string {
  return html
    .replaceAll("&amp;", "&")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"');
}

function regionNames(html: string): string[] {
  return Array.from(
    html.matchAll(/data-region="([^"]+)"/gu),
    (match) => match[1]!,
  );
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function exactButtonCount(html: string, label: string): number {
  const encodedLabel = label.replaceAll("&", "&amp;").replaceAll("'", "&#x27;");
  return countOccurrences(html, `>${encodedLabel}</button>`);
}

function buttonAttributes(
  html: string,
  label: string,
  occurrence: "first" | "last" = "first",
): string {
  const encodedLabel = label.replaceAll("&", "&amp;").replaceAll("'", "&#x27;");
  const target = `>${encodedLabel}</button>`;
  const labelIndex =
    occurrence === "first" ? html.indexOf(target) : html.lastIndexOf(target);
  if (labelIndex < 0) {
    throw new Error(`button not found: ${label}`);
  }
  const buttonIndex = html.lastIndexOf("<button", labelIndex);
  return html.slice(buttonIndex, labelIndex);
}

function advancedRecoveryMarkup(html: string): string {
  const start = html.indexOf('data-region="advanced-recovery"');
  const end = html.indexOf("</details>", start);
  if (start < 0 || end < 0) {
    throw new Error("advanced recovery disclosure not found");
  }
  return visibleMarkup(html.slice(start, end));
}

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
    copiedTarget: null,
    onSelectAcceptance: noop,
    onCompile: noop,
    onImport: noop,
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
    expect(html).not.toContain("Use Brainstorm as Spec input");
    expect(html).toContain("Copied");
  });

  it("exposes a durable Brainstorm selection to the Spec surface", () => {
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
    });

    expect(html).toContain("Accepted Brainstorm input");
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
        source_id: "source-1",
        work_item_id: workItemId,
        outcome: "rejected",
        rejection: {
          raw_result_sha256: "7".repeat(64),
          byte_length: 128,
          reasons: [
            {
              code: "schema_violation",
              field_path: "identity.input_sha256",
            },
          ],
        },
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
    expect(rejected).toContain("identity.input_sha256: schema_violation");
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

describe("detail panel decision-first shaping", () => {
  it("submits the model visibly selected when every picker option was used", () => {
    const usedOption = decisionModelOption("model-used", {
      used_by_seats: ["brainstorm"],
      reuse_warning: "model-used was already used by brainstorm.",
    });
    const projection = shapingHandoffForItem(
      decisionItem("idea"),
      decisionSurfaceContext({
        revision: null,
        models: {
          available_model_ids: ["model-used"],
          model_picker_options: {
            brainstorm: [usedOption],
            spec: [usedOption],
            plan: [usedOption],
          },
        },
      }),
    );
    if (projection.mode !== "idea" || projection.model_picker == null) {
      throw new Error("expected an Idea picker");
    }
    expect(projection.model_picker.selected_model).toBeNull();

    const selectedModel = selectedModelForShapingPicker(
      projection.model_picker,
      null,
    );
    expect(selectedModel).toBe("model-used");
    expect(renderDecision(projection)).toContain(
      '<option value="model-used" selected="">',
    );

    const primaryAction = projection.actions.find((action) => action.primary);
    if (primaryAction === undefined) {
      throw new Error("expected the primary Start Brainstorm action");
    }
    const request = shapingActionRequest({
      source_id: "source-1",
      work_item_id: workItemId,
      projection,
      action: primaryAction,
      selected_model: selectedModel,
    });
    expect(request.status).toBe("ready");
    if (request.status === "ready") {
      expect(request.body.requested_model).toBe("model-used");
    }
  });

  it("keeps an ungoverned Idea's full editor from activating a goal contract", () => {
    expect(canEditGoalContractFromFullWorkItem("idea", false)).toBe(false);
    expect(canEditGoalContractFromFullWorkItem("idea", true)).toBe(true);
    expect(canEditGoalContractFromFullWorkItem("brainstorm", false)).toBe(true);
    expect(canEditGoalContractFromFullWorkItem("spec", false)).toBe(true);
    expect(canEditGoalContractFromFullWorkItem("plan", true)).toBe(true);
  });

  it("renders the Brainstorm regions in phase-exact order without foreign fields", () => {
    const projection = shapingHandoffForItem(
      decisionItem("brainstorm"),
      appliedDecisionContext("brainstorm", brainstormResult),
    );
    if (projection.mode !== "ready" || projection.phase !== "brainstorm") {
      throw new Error("expected a ready Brainstorm projection");
    }

    const html = renderDecision(projection);
    const visible = visibleMarkup(html);

    expect(regionNames(html)).toEqual([
      "status",
      "summary",
      "non-goals",
      "unresolved-questions",
      "provenance",
      "next-step",
      "advanced-recovery",
      "footer",
    ]);
    expect(visible).toContain("Brainstorm result ready");
    expect(visible).toContain("Problem statement");
    expect(visible).toContain("Approach");
    expect(visible).toContain("Non-goals");
    expect(visible).toContain("Unresolved questions");
    expect(visible).not.toContain("Acceptance criteria (observable)");
    expect(visible).not.toContain("Governed fields");
    expect(visible).toContain("View full work item");
    expect(html).not.toContain('role="tab"');
  });

  it("renders Spec governed fields once and keeps the persistent footer outside scrolling", () => {
    const uniqueSpecResult: SpecResultSubmission = {
      ...specResult,
      proposal: {
        purpose: "Unique purpose decision text",
        acceptance_criteria: ["Unique acceptance criterion text"],
        non_goals: ["Unique non-goal text"],
        allowed_scope: ["Unique allowed-scope text"],
        review_ready: ["Unique review-ready text"],
      },
    };
    const projection = shapingHandoffForItem(
      decisionItem("spec"),
      appliedDecisionContext("spec", uniqueSpecResult),
    );
    if (projection.mode !== "ready" || projection.phase !== "spec") {
      throw new Error("expected a ready Spec projection");
    }

    const html = renderDecision(projection);
    const visible = visibleMarkup(html);

    expect(regionNames(html)).toEqual([
      "status",
      "summary",
      "criteria",
      "governed-fields",
      "provenance",
      "next-step",
      "advanced-recovery",
      "footer",
    ]);
    expect(visible).toContain("Spec ready for approval");
    expect(visible).toContain("Acceptance criteria (observable)");
    expect(visible).toContain("Governed fields");
    expect(visible).not.toContain("Unresolved questions");
    for (const fieldValue of [
      uniqueSpecResult.proposal.purpose,
      ...uniqueSpecResult.proposal.acceptance_criteria,
      ...uniqueSpecResult.proposal.non_goals,
      ...uniqueSpecResult.proposal.allowed_scope,
      ...uniqueSpecResult.proposal.review_ready,
    ]) {
      expect(countOccurrences(visible, fieldValue), fieldValue).toBe(1);
    }
    expect(html).toMatch(
      /data-shaping-scroll-region="true" class="[^"]*overflow-y-auto[^"]*"/u,
    );
    expect(html).toMatch(
      /<footer data-region="footer" data-shaping-footer="persistent" class="[^"]*shrink-0[^"]*"/u,
    );
    expect(html).toContain(
      '</details></div><footer data-region="footer" data-shaping-footer="persistent"',
    );
    expect(
      html.slice(html.indexOf('<footer data-region="footer"'), html.indexOf("</footer>")),
    ).not.toContain("sticky");
    expect(buttonAttributes(html, "Approve & run Plan")).not.toContain(
      ' disabled=""',
    );
  });

  it("renders exact prose and list preview boundaries with deterministic labels", () => {
    const previewResult: BrainstormResultSubmission = {
      ...brainstormResult,
      problem_statement: "p".repeat(320),
      approach: "q".repeat(321),
      non_goals: [
        "Non-goal one",
        "Non-goal two",
        "Non-goal three",
        "Non-goal four",
        "Non-goal five must stay outside the bounded preview",
      ],
      open_questions: [`Question ${"z".repeat(161)}`],
    };
    const projection = shapingHandoffForItem(
      decisionItem("brainstorm"),
      appliedDecisionContext("brainstorm", previewResult),
    );
    if (projection.mode !== "ready" || projection.phase !== "brainstorm") {
      throw new Error("expected a ready Brainstorm projection");
    }

    const visible = visibleMarkup(renderDecision(projection));

    expect(visible).toContain("p".repeat(320));
    expect(visible).not.toContain("p".repeat(320) + "…");
    expect(visible).toContain(`${"q".repeat(320)}…`);
    expect(visible).not.toContain("q".repeat(321));
    expect(countOccurrences(visible, "Show full text")).toBe(1);
    expect(visible).toContain("Show all 5");
    expect(visible).toContain("Show all 1");
    expect(visible).not.toContain("Non-goal five must stay outside");
    expect(visible).not.toContain("z".repeat(161));
  });

  it("promotes the Idea manual counterpart only when connected launch is unavailable", () => {
    const available = shapingHandoffForItem(
      decisionItem("idea"),
      decisionSurfaceContext({ revision: null }),
    );
    const unavailable = shapingHandoffForItem(
      decisionItem("idea"),
      decisionSurfaceContext({
        revision: null,
        models: {
          status: "unavailable",
          reason: "The connected runtime is unavailable.",
          available_model_ids: [],
          model_picker_options: { brainstorm: [], spec: [], plan: [] },
        },
      }),
    );
    if (available.mode !== "idea" || unavailable.mode !== "idea") {
      throw new Error("expected Idea projections");
    }

    const availableHtml = renderDecision(available);
    const unavailableHtml = renderDecision(unavailable);

    expect(regionNames(availableHtml)).toEqual([
      "status",
      "next-step",
      "advanced-recovery",
      "footer",
    ]);
    expect(exactButtonCount(availableHtml, "Start Brainstorm")).toBe(1);
    expect(
      advancedRecoveryMarkup(availableHtml),
    ).toContain("Start Brainstorm without a model");
    expect(buttonAttributes(availableHtml, "Start Brainstorm")).toContain(
      'data-action-priority="primary"',
    );
    expect(availableHtml).toContain('<select aria-label="Brainstorm model"');

    expect(regionNames(unavailableHtml)).toEqual([
      "status",
      "runtime",
      "advanced-recovery",
      "footer",
    ]);
    expect(visibleMarkup(unavailableHtml)).toContain(
      "The connected runtime is unavailable.",
    );
    expect(exactButtonCount(unavailableHtml, "Start Brainstorm")).toBe(0);
    expect(
      exactButtonCount(unavailableHtml, "Start Brainstorm without a model"),
    ).toBe(2);
    expect(advancedRecoveryMarkup(unavailableHtml)).toContain(
      "Start Brainstorm without a model",
    );
    expect(
      buttonAttributes(
        unavailableHtml,
        "Start Brainstorm without a model",
        "last",
      ),
    ).toContain('data-action-priority="primary"');
    expect(unavailableHtml).not.toContain("<select");
  });

  it("keeps ready manual counterparts in recovery and promotes them without a runtime", () => {
    const cases = [
      {
        phase: "brainstorm" as const,
        result: brainstormResult,
        connected: "Use result & run Spec",
        manual: "Use result & prepare Spec",
      },
      {
        phase: "spec" as const,
        result: specResult,
        connected: "Approve & run Plan",
        manual: "Approve & prepare Plan",
      },
    ];

    for (const testCase of cases) {
      const available = shapingHandoffForItem(
        decisionItem(testCase.phase),
        appliedDecisionContext(testCase.phase, testCase.result),
      );
      const unavailable = shapingHandoffForItem(
        decisionItem(testCase.phase),
        appliedDecisionContext(testCase.phase, testCase.result, {
          models: {
            status: "unavailable",
            reason: "The connected runtime is unavailable.",
            available_model_ids: [],
            model_picker_options: { brainstorm: [], spec: [], plan: [] },
          },
        }),
      );
      if (
        available.mode !== "ready" ||
        available.phase !== testCase.phase ||
        unavailable.mode !== "ready" ||
        unavailable.phase !== testCase.phase
      ) {
        throw new Error(`expected ready ${testCase.phase} projections`);
      }

      const availableHtml = renderDecision(available);
      const unavailableHtml = renderDecision(unavailable);
      const recovery = advancedRecoveryMarkup(availableHtml);

      expect(recovery, `${testCase.phase}: manual counterpart`).toContain(
        testCase.manual,
      );
      expect(recovery, `${testCase.phase}: manual request changes`).toContain(
        "Request changes & prepare rerun",
      );
      expect(buttonAttributes(availableHtml, testCase.connected)).toContain(
        'data-action-priority="primary"',
      );
      expect(exactButtonCount(unavailableHtml, testCase.connected)).toBe(0);
      expect(exactButtonCount(unavailableHtml, testCase.manual)).toBe(1);
      expect(buttonAttributes(unavailableHtml, testCase.manual)).toContain(
        'data-action-priority="primary"',
      );
      expect(advancedRecoveryMarkup(unavailableHtml)).toContain(
        "Request changes & prepare rerun",
      );
      expect(unavailableHtml).not.toContain("<select");
    }
  });

  it("ends Plan at an explicit Execute boundary with no primary or next-seat control", () => {
    const projection = shapingHandoffForItem(
      decisionItem("plan", decisionGoalContract),
      appliedDecisionContext("plan", planResult),
    );
    if (projection.mode !== "ready" || projection.phase !== "plan") {
      throw new Error("expected a ready Plan projection");
    }

    const html = renderDecision(projection);
    const visible = visibleMarkup(html);

    expect(regionNames(html)).toEqual([
      "status",
      "summary",
      "criteria",
      "unresolved-questions",
      "provenance",
      "advanced-recovery",
      "footer",
    ]);
    expect(visible).toContain("Plan result ready");
    expect(visible).toContain("Plan checklist");
    expect(visible).toContain("Show all 7");
    expect(visible).not.toContain("Plan checklist step 7");
    expect(visible).not.toContain("Governed fields");
    expect(visible).not.toContain("Next step");
    expect(html).not.toContain("<select");
    expect(html).not.toContain('data-action-priority="primary"');
    expect(visible).toContain("Execute approval is not part of this slice.");
    expect(visible).not.toContain("Execute the plan");
    expect(advancedRecoveryMarkup(html)).toContain(
      "Request changes & prepare rerun",
    );

    const shortProjection = shapingHandoffForItem(
      decisionItem("plan", decisionGoalContract),
      appliedDecisionContext("plan", {
        ...planResult,
        checklist: [
          {
            id: "P1",
            step: "Render one short checklist entry",
            verification_check: "The short verification stays visible",
          },
        ],
      }),
    );
    if (shortProjection.mode !== "ready" || shortProjection.phase !== "plan") {
      throw new Error("expected a short ready Plan projection");
    }
    const shortVisible = visibleMarkup(renderDecision(shortProjection));
    expect(shortVisible).toContain(
      "Verification · The short verification stays visible",
    );
    expect(shortVisible).not.toContain("Show all");
  });

  it("renders superseded Plan as a replan decision and never offers Start Plan", () => {
    const projection = shapingHandoffForItem(
      decisionItem("plan", decisionGoalContract),
      appliedDecisionContext("plan", planResult, {
        current_goal_contract_sha256: "e".repeat(64),
      }),
    );
    if (projection.mode !== "plan_result_superseded") {
      throw new Error("expected a superseded Plan projection");
    }

    const html = renderDecision(projection);
    const visible = visibleMarkup(html);

    expect(visible).toContain("Plan result superseded");
    expect(visible).toContain(
      "The governed contract changed after this plan was produced.",
    );
    expect(exactButtonCount(html, "Replan with updated contract")).toBe(1);
    expect(
      buttonAttributes(html, "Replan with updated contract"),
    ).toContain('data-action-priority="primary"');
    expect(advancedRecoveryMarkup(html)).toContain("Replan & prepare Plan");
    expect(advancedRecoveryMarkup(html)).toContain(
      "Request changes & prepare rerun",
    );
    expect(visible).not.toContain("Start Plan");
  });

  it("keeps launch failure, terminal failure, and manual recovery visibly distinct", () => {
    const postCommit = shapingHandoffForItem(
      decisionItem("brainstorm"),
      decisionSurfaceContext({
        post_commit_launch_failure: {
          manifest_outcome: "applied",
          decision_id: "d".repeat(64),
          locked_model: "model-a",
          reason: "The adapter did not start.",
        },
      }),
    );
    const lockedUnavailable = shapingHandoffForItem(
      decisionItem("brainstorm"),
      decisionSurfaceContext({
        post_commit_launch_failure: {
          manifest_outcome: "applied",
          decision_id: "e".repeat(64),
          locked_model: "retired-model",
          reason: "The recorded model is unavailable.",
        },
      }),
    );
    const terminal = shapingHandoffForItem(
      decisionItem("brainstorm"),
      decisionSurfaceContext({
        run: decisionRun("terminal", "failed"),
      }),
    );
    const manual = shapingHandoffForItem(
      decisionItem("brainstorm"),
      decisionSurfaceContext({
        manual_recovery: {
          state: "ready",
          task: "Run this bounded task",
          instruction_path: ".founder/instruction.json",
          ingress_path: ".founder/result.json",
        },
      }),
    );
    if (
      postCommit.mode !== "post_commit_launch_failure" ||
      lockedUnavailable.mode !== "post_commit_launch_failure" ||
      terminal.mode !== "terminal_run_failure" ||
      manual.mode !== "manual_recovery"
    ) {
      throw new Error("expected distinct recovery projections");
    }

    const postCommitHtml = renderDecision(postCommit);
    const lockedUnavailableHtml = renderDecision(lockedUnavailable);
    const terminalHtml = renderDecision(terminal);
    const manualHtml = renderDecision(manual);

    expect(visibleMarkup(postCommitHtml)).toContain("Brainstorm launch failed");
    expect(visibleMarkup(postCommitHtml)).toContain("Locked model");
    expect(visibleMarkup(postCommitHtml)).toContain("model-a");
    expect(exactButtonCount(postCommitHtml, "Retry launch")).toBe(1);
    expect(postCommitHtml).not.toContain("<select");

    expect(visibleMarkup(lockedUnavailableHtml)).toContain(
      "The locked model is no longer available. Start a new attempt with another model.",
    );
    expect(visibleMarkup(lockedUnavailableHtml)).toContain("retired-model");
    expect(exactButtonCount(lockedUnavailableHtml, "Start Brainstorm")).toBe(1);
    expect(buttonAttributes(lockedUnavailableHtml, "Start Brainstorm")).toContain(
      'data-action-priority="primary"',
    );
    expect(exactButtonCount(lockedUnavailableHtml, "Retry launch")).toBe(0);
    expect(lockedUnavailableHtml).not.toContain("<select");

    expect(visibleMarkup(terminalHtml)).toContain("Brainstorm failed");
    expect(visibleMarkup(terminalHtml)).toContain("The result failed validation.");
    expect(exactButtonCount(terminalHtml, "Retry Brainstorm")).toBe(1);
    expect(terminalHtml).toContain('<select aria-label="Brainstorm model"');
    expect(advancedRecoveryMarkup(terminalHtml)).toContain(
      "Prepare manual recovery",
    );

    expect(visibleMarkup(manualHtml)).toContain("Brainstorm manual recovery");
    expect(visibleMarkup(manualHtml)).toContain(
      "Prepare or import the current revision through the bounded manual path.",
    );
    expect(exactButtonCount(manualHtml, "Copy manual task")).toBe(1);
    expect(visibleMarkup(manualHtml)).not.toContain("Brainstorm failed");
    expect(visibleMarkup(manualHtml)).not.toContain("launch failed");
  });

  it("renders unknown provenance, unused selection, and a non-blocking reuse warning", () => {
    const projection = shapingHandoffForItem(
      decisionItem("spec"),
      appliedDecisionContext("spec", specResult, {
        models: {
          model_use: [
            {
              seat: "brainstorm",
              production_id: "prod-brainstorm",
              shaping_run_id: null,
              requested_model: "model-a",
              effective_model: null,
            },
            {
              seat: "spec",
              production_id: "prod-spec",
              shaping_run_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b2",
              requested_model: "model-b",
              effective_model: "model-b-effective",
            },
          ],
          model_picker_options: {
            brainstorm: [decisionModelOption("model-a")],
            spec: [decisionModelOption("model-b")],
            plan: [
              decisionModelOption("model-a", {
                used_by_seats: ["brainstorm"],
                saved_preference: true,
                preselected: true,
                reuse_warning: "model-a was already used by brainstorm.",
              }),
              decisionModelOption("model-c", { recommended: true }),
              decisionModelOption("model-b"),
            ],
          },
        },
      }),
    );
    if (projection.mode !== "ready" || projection.phase !== "spec") {
      throw new Error("expected a ready Spec projection");
    }

    const defaultHtml = renderDecision(projection);
    const reuseHtml = renderDecision(projection, "model-a");
    const visible = visibleMarkup(defaultHtml);

    expect(visible).toContain(
      "Brainstorm · requested model-a · effective unknown",
    );
    expect(visible).toContain(
      "Spec · requested model-b · effective model-b-effective",
    );
    expect(visible.indexOf("model-c · unused")).toBeLessThan(
      visible.indexOf("model-a · used by brainstorm"),
    );
    expect(visible.indexOf("model-b · unused")).toBeLessThan(
      visible.indexOf("model-a · used by brainstorm"),
    );
    expect(defaultHtml).toMatch(
      /<option value="model-c" selected="">model-c · unused<\/option>/u,
    );
    expect(defaultHtml).not.toMatch(
      /<option value="model-a" selected="">/u,
    );
    expect(visibleMarkup(reuseHtml)).toContain(
      "model-a was already used by brainstorm.",
    );
    expect(buttonAttributes(reuseHtml, "Approve & run Plan")).not.toContain(
      ' disabled=""',
    );
  });

  it("keeps retired comparison and review-gate literals out of every ready surface", () => {
    const readyHtml = [
      renderDecision(
        shapingHandoffForItem(
          decisionItem("brainstorm"),
          appliedDecisionContext("brainstorm", brainstormResult),
        ),
      ),
      renderDecision(
        shapingHandoffForItem(
          decisionItem("spec"),
          appliedDecisionContext("spec", specResult),
        ),
      ),
      renderDecision(
        shapingHandoffForItem(
          decisionItem("plan", decisionGoalContract),
          appliedDecisionContext("plan", planResult),
        ),
      ),
    ].map(visibleMarkup).join("\n");

    expect(readyHtml).not.toContain("Run another model");
    expect(readyHtml).not.toContain("candidate");
    expect(readyHtml).not.toContain("Review the complete contract");
    expect(readyHtml).not.toContain("I've reviewed this contract");
    expect(readyHtml).not.toContain("Execute the plan");
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
