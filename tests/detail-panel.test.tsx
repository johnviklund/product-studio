import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  canEditGoalContractFromFullWorkItem,
  clearShapingStateForExecuteHandoff,
  completeReviewImportDriftRecoverySuccess,
  CommandAuthorizationSection,
  commandAuthorizationPreflightEligible,
  ConnectedExecuteSection,
  ConnectedPhaseSection,
  dispatchShapingManualRecoveryAction,
  FullWorkItemBackButton,
  PatchWorkflowSection,
  ReviewImportDriftRecoverySection,
  retainedControllerLeaseRepairForConflict,
  retainedControllerLeaseRepairRequest,
  RunEvidenceSection,
  selectedModelForShapingPicker,
  type ShapingAdvancedRecoveryViewState,
  ShapingDecisionView,
  ShapingSection,
  specProposalToGoalContractDraft,
  updateShapingManualRecovery,
  updateShapingRequestChangesComposer,
} from "../components/kanban/detail-panel";
import { nextActionForCardState } from "../components/kanban/board-card";
import type {
  BrainstormMissionCompilation,
  ManualShapingIngressResult,
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
import type { ShapingRunSummary } from "../src/domain/shaping-run";
import type {
  GoalContract,
  ReviewImportDriftRecoveryProposalV1,
  WorkItemAttention,
  WorkItemPhase,
} from "../src/domain/work-item";
import {
  shapingHandoffForItem,
  type ConnectedPhaseProjection,
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

describe("Full work item navigation", () => {
  it("returns from the full work item view through its visible back control", () => {
    const onBack = vi.fn();
    const button = FullWorkItemBackButton({ onBack });

    expect(button.props["aria-label"]).toBe("Back to workflow details");
    expect(button.props.children).toBeDefined();
    button.props.onClick();

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

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
const manualIngressDirectory = `.founder/shaping-ingress/${workItemId}/brainstorm-${brainstormIdentity.input_sha256}`;
const manualIngressPath = `${manualIngressDirectory}/result.json`;
const manualInstructionPath = `${manualIngressDirectory}/instruction.json`;
const manualRequiredFields = [
  ...brainstormMission.result_contract.required_fields,
];
const manualRecoveryTask = [
  `Published TASK.md: ${brainstormTaskPath}`,
  `Exact result ingress: ${manualIngressPath}`,
  "Result schema version: 1",
  "Maximum result bytes: 262144",
  `Mission content SHA-256: ${missionContentSha256}`,
  "Required result fields:",
  ...manualRequiredFields.map((field) => `- ${field}`),
].join("\n");
const manualIngressResult: ManualShapingIngressResult = {
  source_id: "source-1",
  work_item_id: workItemId,
  task: manualRecoveryTask,
  instruction: {
    schema_version: 1,
    origin: "manual_import",
    shaping_run_id: null,
    work_item_id: workItemId,
    phase: "brainstorm",
    mission_input_sha256: brainstormIdentity.input_sha256,
    mission_content_sha256: missionContentSha256,
    task_path: brainstormTaskPath,
    mission_path: brainstormCompilation.mission_path,
    ingress_path: manualIngressPath,
    result_schema_version: 1,
    required_fields: manualRequiredFields,
    max_result_bytes: 262_144,
    created_at: "2026-08-04T08:00:00.000Z",
    instruction_sha256: "e".repeat(64),
  },
  instruction_path: manualInstructionPath,
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
      execute: [
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
    },
    execute: {
      status: "available",
      reason: null,
      available_model_ids: ["model-a", "model-b", "model-c"],
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

const failedShapingRun: ShapingRunSummary = {
  schema_version: 1,
  shaping_run_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b9",
  mission: {
    phase: "brainstorm",
    work_item_id: workItemId,
    input_sha256: brainstormIdentity.input_sha256,
    content_sha256: missionContentSha256,
  },
  provenance: {
    role: { value: "writer", assurance: "controller_observed" },
    seat: { value: "brainstorm", assurance: "controller_observed" },
    requested_model: { value: "requested-model", assurance: "user_declared" },
    effective_model: {
      assurance: "adapter_attested",
      model_id: "effective-model",
      deployment_id: null,
      observed_event_sha256: "f".repeat(64),
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
        profile_id: "brainstorm-v1",
      },
      assurance: "controller_observed",
    },
  },
  write_policy: {
    kind: "single_ingress_file",
    ingress_path: `${manualIngressDirectory}/connected-result.json`,
    instruction_sha256: "0".repeat(64),
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
  lifecycle: {
    status: "terminal",
    started_at: "2026-08-04T08:01:00.000Z",
    updated_at: "2026-08-04T08:02:00.000Z",
    completed_at: "2026-08-04T08:02:00.000Z",
    terminal_outcome: "failed",
    partial: false,
  },
  diagnostics: { count: 2, truncated: false },
};

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
  requestChangesComposer: {
    launchMode: "connected" | "manual";
    feedback: string;
    selectedModel: string | null;
    error: string | null;
  } | null = null,
  busy = false,
  advancedRecovery?: ShapingAdvancedRecoveryViewState,
  retainedControllerLeaseRepair: ComponentProps<
    typeof ShapingDecisionView
  >["retainedControllerLeaseRepair"] = null,
): string {
  return renderToStaticMarkup(
    <ShapingDecisionView
      fieldId="decision"
      projection={projection}
      selectedModel={selectedModel}
      advancedRecovery={advancedRecovery}
      requestChangesComposer={requestChangesComposer}
      retainedControllerLeaseRepair={retainedControllerLeaseRepair}
      busy={busy}
      onSelectModel={noop}
      onAction={noop}
      onOpenRequestChanges={noop}
      onCloseRequestChanges={noop}
      onChangeRequestChangesFeedback={noop}
      onSelectRequestChangesModel={noop}
      onSubmitRequestChanges={noop}
      onAcknowledgeRetainedControllerLease={noop}
      onRepairRetainedControllerLease={noop}
      onCompileManualMission={noop}
      onPrepareManualRecovery={noop}
      onRetryManualRecovery={noop}
      onCopyManualRecovery={noop}
      onImportManualResult={noop}
      onCopyManualCompilation={noop}
      onRefreshStatus={noop}
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

function outsideAdvancedRecoveryMarkup(html: string): string {
  const detailsStart = html.lastIndexOf(
    "<details",
    html.indexOf('data-region="advanced-recovery"'),
  );
  const detailsEnd = html.indexOf("</details>", detailsStart);
  if (detailsStart < 0 || detailsEnd < 0) {
    throw new Error("advanced recovery disclosure not found");
  }
  return visibleMarkup(
    `${html.slice(0, detailsStart)}${html.slice(detailsEnd + "</details>".length)}`,
  );
}

function advancedRecoveryView(
  overrides: Partial<ShapingAdvancedRecoveryViewState> = {},
): ShapingAdvancedRecoveryViewState {
  return {
    identity: "advanced-recovery-v1",
    phase: "brainstorm",
    preparationEnabled: true,
    currentTaskPath: brainstormTaskPath,
    compilation: brainstormCompilation,
    copiedCompilationTarget: null,
    manualRecovery: null,
    run: null,
    compiling: false,
    ...overrides,
  };
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
  schema_version: 2,
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
  authorization: {
    kind: "capability_envelope",
    envelope_sha256: "e".repeat(64),
  },
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

const connectedReviewRun: ConnectedRunSummary = {
  ...connectedRun,
  mission: {
    ...connectedRun.mission,
    identity: { ...connectedRun.mission.identity, phase: "review" },
  },
  provenance: {
    ...connectedRun.provenance,
    role: { value: "reviewer", assurance: "controller_observed" },
    seat: { value: "reviewer", assurance: "controller_observed" },
    adapter_profile: {
      value: {
        adapter_id: "copilot-acp",
        adapter_version: "1",
        profile_id: "review-v1",
      },
      assurance: "controller_observed",
    },
  },
  authorization: {
    kind: "review_result_ingress",
    policy_sha256: "f".repeat(64),
  },
};

const connectedPatchRun: ConnectedRunSummary = {
  ...connectedRun,
  mission: {
    ...connectedRun.mission,
    identity: {
      ...connectedRun.mission.identity,
      phase: "patch",
      patch_cycle: 1,
    },
  },
  governed_tuple: { ...connectedRun.governed_tuple, patch_cycle: 1 },
};

const reviewModelPicker = {
  seat: "review" as const,
  options: [
    {
      ...decisionModelOption("review-model", {
        recommended: true,
        preselected: true,
      }),
      current_revision: false,
    },
  ],
  selected_model: "review-model",
  recommendation_note: null,
  reuse_warning: null,
};

const patchModelPicker = {
  ...reviewModelPicker,
  seat: "patch" as const,
  options: [
    {
      ...decisionModelOption("patch-model", {
        recommended: true,
        preselected: true,
      }),
      current_revision: false,
    },
  ],
  selected_model: "patch-model",
};

function renderConnectedPhase(
  projection: ConnectedPhaseProjection,
  overrides: Partial<ComponentProps<typeof ConnectedPhaseSection>> = {},
): string {
  return renderToStaticMarkup(
    <ConnectedPhaseSection
      fieldId="detail"
      projection={projection}
      reviewAttested={false}
      selectedModel={projection.model_picker?.selected_model ?? null}
      loading={false}
      modelsLoading={false}
      error={null}
      mutation={null}
      onReviewAttestedChange={noop}
      onSelectModel={noop}
      onLaunch={noop}
      onCancel={noop}
      onAllowOnce={noop}
      onRetryWithoutAllowing={noop}
      onKeepDenied={noop}
      {...overrides}
    />,
  );
}

function primaryActionCount(html: string): number {
  return html.match(/data-primary-action="true"/g)?.length ?? 0;
}

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

  it("keeps manual recovery inert until preparation and preserves all five explicit states", () => {
    const identity = JSON.stringify([
      "source-1",
      workItemId,
      "brainstorm",
      missionContentSha256,
      shapingStateSha256,
    ]);

    expect(
      updateShapingManualRecovery(null, {
        type: "prepare_succeeded",
        identity,
        result: manualIngressResult,
      }),
    ).toBeNull();
    expect(
      updateShapingManualRecovery(null, {
        type: "copied",
        identity,
        target: "task",
      }),
    ).toBeNull();
    expect(
      updateShapingManualRecovery(null, {
        type: "import_started",
        identity,
      }),
    ).toBeNull();

    const loading = updateShapingManualRecovery(null, {
      type: "prepare_started",
      identity,
    });
    if (loading === null) {
      throw new Error("expected a loading manual-recovery state");
    }
    const ready = updateShapingManualRecovery(loading, {
      type: "prepare_succeeded",
      identity,
      result: manualIngressResult,
    });
    if (ready === null) {
      throw new Error("expected a ready manual-recovery state");
    }
    const copied = updateShapingManualRecovery(ready, {
      type: "copied",
      identity,
      target: "task",
    });
    if (copied === null) {
      throw new Error("expected a copied manual-recovery state");
    }
    const failed = updateShapingManualRecovery(loading, {
      type: "prepare_failed",
      identity,
      reason: "The instruction write failed.",
      retried: false,
    });
    if (failed === null) {
      throw new Error("expected a failed manual-recovery state");
    }
    const retryLoading = updateShapingManualRecovery(failed, {
      type: "prepare_started",
      identity,
    });
    const retried = updateShapingManualRecovery(retryLoading, {
      type: "prepare_failed",
      identity,
      reason: "The retry also failed.",
      retried: true,
    });
    if (retried === null) {
      throw new Error("expected a retry manual-recovery state");
    }

    expect([
      loading.recovery.state,
      ready.recovery.state,
      failed.recovery.state,
      retried.recovery.state,
      copied.recovery.state,
    ]).toEqual(["loading", "ready", "failure", "retry", "copy"]);
    expect(ready.prepared).toEqual(manualIngressResult);

    const importing = updateShapingManualRecovery(ready, {
      type: "import_started",
      identity,
    });
    expect(importing).toMatchObject({
      recovery: { state: "ready" },
      importing: true,
      error: null,
    });
    expect(
      updateShapingManualRecovery(importing, {
        type: "copy_failed",
        identity,
        reason: "Clipboard access failed.",
      }),
    ).toMatchObject({
      recovery: { state: "ready" },
      importing: true,
      error: "Clipboard access failed.",
    });
    const imported = updateShapingManualRecovery(importing, {
      type: "import_succeeded",
      identity,
      result: brainstormImport,
    });
    expect(imported).toMatchObject({
      recovery: { state: "ready" },
      imported: brainstormImport,
      importing: false,
    });

    const projection = shapingHandoffForItem(
      decisionItem("brainstorm"),
      decisionSurfaceContext({
        run: decisionRun("terminal", "failed"),
      }),
    );
    const renderedStates = [loading, ready, failed, retried, copied].map(
      (manualRecovery) =>
        visibleMarkup(
          renderDecision(
            projection,
            null,
            null,
            false,
            advancedRecoveryView({ manualRecovery }),
          ),
        ),
    );
    for (const [index, state] of [
      "loading",
      "ready",
      "failure",
      "retry",
      "copy",
    ].entries()) {
      expect(renderedStates[index]).toContain(
        `data-manual-recovery-state="${state}"`,
      );
    }
    expect(renderedStates[0]).toContain(
      "Publishing the manual recovery instruction…",
    );
    expect(renderedStates[1]).toContain("Manual recovery ready");
    expect(renderedStates[2]).toContain("Manual recovery preparation failed");
    expect(renderedStates[3]).toContain("Manual recovery retry failed");
    expect(renderedStates[4]).toContain("Copied task.");
    if (importing === null) {
      throw new Error("expected an importing manual-recovery state");
    }
    expect(
      visibleMarkup(
        renderDecision(
          projection,
          null,
          null,
          false,
          advancedRecoveryView({ manualRecovery: importing }),
        ),
      ),
    ).toContain("Importing…");
  });

  it("uses one collapsed truthful recovery disclosure for Idea, Brainstorm, Spec, and Plan", () => {
    const surfaces = [
      {
        name: "Idea",
        projection: shapingHandoffForItem(
          decisionItem("idea"),
          decisionSurfaceContext({ revision: null }),
        ),
        recovery: advancedRecoveryView({
          phase: null,
          currentTaskPath: null,
          compilation: null,
        }),
      },
      {
        name: "Brainstorm",
        projection: shapingHandoffForItem(
          decisionItem("brainstorm"),
          appliedDecisionContext("brainstorm", brainstormResult),
        ),
        recovery: advancedRecoveryView(),
      },
      {
        name: "Spec",
        projection: shapingHandoffForItem(
          decisionItem("spec"),
          appliedDecisionContext("spec", specResult),
        ),
        recovery: advancedRecoveryView({
          phase: "spec",
          currentTaskPath: specTaskPath,
          compilation: specCompilation,
        }),
      },
      {
        name: "Plan",
        projection: shapingHandoffForItem(
          decisionItem("plan", decisionGoalContract),
          appliedDecisionContext("plan", planResult),
        ),
        recovery: advancedRecoveryView({
          phase: "plan",
          currentTaskPath: null,
          compilation: null,
        }),
      },
    ];

    for (const surface of surfaces) {
      const html = renderDecision(
        surface.projection,
        null,
        null,
        false,
        surface.recovery,
      );
      const disclosure = advancedRecoveryMarkup(html);
      const detailsStart = html.lastIndexOf(
        "<details",
        html.indexOf('data-region="advanced-recovery"'),
      );
      const openingTag = html.slice(detailsStart, html.indexOf(">", detailsStart) + 1);

      expect(openingTag, surface.name).not.toMatch(/\sopen(?:=|\s|>)/u);
      expect(openingTag, surface.name).toContain(
        'data-recovery-identity="advanced-recovery-v1"',
      );
      expect(disclosure, surface.name).toContain(
        "Permission requests are mediated locally.",
      );
      expect(disclosure, surface.name).toContain(
        "only the exact result-ingress path and validates that result scope",
      );
      expect(disclosure, surface.name).toContain(
        "the founder's own user authority",
      );
      expect(disclosure, surface.name).toContain(
        "can read the workspace and repository",
      );
      expect(disclosure, surface.name).toContain(
        "Operating-system separation is not independently enforced.",
      );
      expect(disclosure.toLowerCase(), surface.name).not.toMatch(
        /sandbox|contained|isolated|cannot reach|prevented|technically unable/u,
      );
    }

    const ideaRecovery = advancedRecoveryMarkup(
      renderDecision(
        surfaces[0]!.projection,
        null,
        null,
        false,
        surfaces[0]!.recovery,
      ),
    );
    expect(ideaRecovery).toContain("Start Brainstorm without a model");
    expect(ideaRecovery).toContain('data-manual-recovery-state="idle"');
    expect(ideaRecovery).not.toContain(
      "Publishing the manual recovery instruction…",
    );

    const unavailablePreparation = shapingHandoffForItem(
      decisionItem("brainstorm"),
      decisionSurfaceContext({ revision: null }),
    );
    const unavailableHtml = renderDecision(
      unavailablePreparation,
      null,
      null,
      false,
      advancedRecoveryView({
        identity: "no-current-revision",
        preparationEnabled: false,
        currentTaskPath: null,
        compilation: null,
      }),
    );
    expect(buttonAttributes(unavailableHtml, "Prepare manual recovery")).toContain(
      "disabled",
    );

    const runtimeUnavailable = shapingHandoffForItem(
      decisionItem("brainstorm"),
      decisionSurfaceContext({
        models: {
          status: "unavailable",
          reason: "The connected runtime is unavailable.",
          available_model_ids: [],
          model_picker_options: { brainstorm: [], spec: [], plan: [] },
        },
      }),
    );
    const runtimeUnavailableHtml = renderDecision(
      runtimeUnavailable,
      null,
      null,
      false,
      advancedRecoveryView(),
    );
    expect(
      exactButtonCount(runtimeUnavailableHtml, "Prepare manual recovery"),
    ).toBe(1);
    expect(
      buttonAttributes(runtimeUnavailableHtml, "Prepare manual recovery"),
    ).toContain('data-action-priority="primary"');
  });

  it("dispatches every UI-only recovery action without falling through to the decision builder", () => {
    const prepare = vi.fn();
    const retry = vi.fn();
    const copyTask = vi.fn();
    const importResult = vi.fn();
    const callbacks = { prepare, retry, copyTask, importResult };
    const action = (
      kind:
        | "prepare_manual_recovery"
        | "retry_manual_recovery"
        | "copy_manual_task"
        | "import_manual_result"
        | "launch_phase",
    ) => ({
      kind,
      label: kind,
      launch_mode: null,
      primary: false,
      enabled: true,
    } as const);

    expect(
      dispatchShapingManualRecoveryAction(
        action("prepare_manual_recovery"),
        null,
        callbacks,
      ),
    ).toBe(true);
    expect(
      dispatchShapingManualRecoveryAction(
        action("retry_manual_recovery"),
        null,
        callbacks,
      ),
    ).toBe(true);
    expect(
      dispatchShapingManualRecoveryAction(
        action("copy_manual_task"),
        manualRecoveryTask,
        callbacks,
      ),
    ).toBe(true);
    expect(
      dispatchShapingManualRecoveryAction(
        action("import_manual_result"),
        null,
        callbacks,
      ),
    ).toBe(true);
    expect(
      dispatchShapingManualRecoveryAction(
        action("launch_phase"),
        null,
        callbacks,
      ),
    ).toBe(false);
    expect(prepare).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
    expect(copyTask).toHaveBeenCalledWith(manualRecoveryTask);
    expect(importResult).toHaveBeenCalledOnce();
  });

  it("renders the exact prepared ingress contract, copy controls, and Base recovery controls", () => {
    const identity = "prepared-recovery";
    const loading = updateShapingManualRecovery(null, {
      type: "prepare_started",
      identity,
    });
    const ready = updateShapingManualRecovery(loading, {
      type: "prepare_succeeded",
      identity,
      result: manualIngressResult,
    });
    if (ready === null) {
      throw new Error("expected prepared manual recovery");
    }
    const projection = shapingHandoffForItem(
      decisionItem("brainstorm"),
      decisionSurfaceContext({
        run: decisionRun("terminal", "failed"),
      }),
    );
    const html = renderDecision(
      projection,
      null,
      null,
      false,
      advancedRecoveryView({ manualRecovery: ready }),
    );
    const disclosure = advancedRecoveryMarkup(html);

    expect(disclosure).toContain(brainstormTaskPath);
    expect(disclosure).toContain(manualInstructionPath);
    expect(disclosure).toContain(manualIngressPath);
    expect(disclosure).toContain(manualRecoveryTask);
    expect(disclosure).toContain("Result schema version");
    expect(disclosure).toContain(">1</dd>");
    expect(disclosure).toContain("Maximum result bytes");
    expect(disclosure).toContain(">262144</dd>");
    expect(disclosure).toContain("Mission content SHA-256");
    expect(disclosure).toContain(missionContentSha256);
    for (const field of manualRequiredFields) {
      expect(disclosure).toContain(field);
    }
    for (const label of [
      "Copy TASK.md",
      "Copy Mission JSON",
      "Copy Workspace",
      "Copy Content SHA",
      "Copy Instruction path",
      "Copy Exact ingress path",
      "Copy manual task",
    ]) {
      expect(disclosure, label).toContain(label);
    }
    expect(exactButtonCount(html, "Compile Brainstorm mission")).toBe(1);
    expect(exactButtonCount(html, "Import result")).toBe(1);

    const fullSpec = renderShaping({
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
    expect(visibleMarkup(fullSpec)).toContain("Use proposal as draft");
  });

  it("shows only sanitized rejection evidence and bounded failed-run diagnostics", () => {
    const rawContentCanary = "RAW_RESULT_CONTENT_MUST_NEVER_RENDER";
    const rejectedResult = {
      source_id: "source-1",
      work_item_id: workItemId,
      outcome: "rejected" as const,
      rejection: {
        raw_result_sha256: "7".repeat(64),
        byte_length: 4_096,
        reasons: [
          {
            code: "schema_violation" as const,
            field_path: "identity.input_sha256",
          },
          {
            code: "mission_hash_mismatch" as const,
            field_path: "brainstorm_mission_content_sha256",
          },
        ],
      },
      raw_result_source: rawContentCanary,
    } satisfies ShapingImportResult & { raw_result_source: string };
    const identity = "rejected-recovery";
    const loading = updateShapingManualRecovery(null, {
      type: "prepare_started",
      identity,
    });
    const ready = updateShapingManualRecovery(loading, {
      type: "prepare_succeeded",
      identity,
      result: manualIngressResult,
    });
    const rejected = updateShapingManualRecovery(ready, {
      type: "import_succeeded",
      identity,
      result: rejectedResult,
    });
    if (rejected === null) {
      throw new Error("expected rejected manual import evidence");
    }
    const projection = shapingHandoffForItem(
      decisionItem("brainstorm"),
      decisionSurfaceContext({
        run: decisionRun("terminal", "failed"),
      }),
    );
    const html = renderDecision(
      projection,
      null,
      null,
      false,
      advancedRecoveryView({
        manualRecovery: rejected,
        run: failedShapingRun,
      }),
    );
    const disclosure = advancedRecoveryMarkup(html);

    expect(disclosure).toContain('data-recovery-rejection="sanitized"');
    expect(disclosure).toContain("identity.input_sha256: schema_violation");
    expect(disclosure).toContain(
      "brainstorm_mission_content_sha256: mission_hash_mismatch",
    );
    expect(disclosure).toContain("7".repeat(64));
    expect(disclosure).toContain(">4096</dd>");
    expect(html).not.toContain(rawContentCanary);

    expect(disclosure).toContain("Connected run diagnostics");
    expect(disclosure).toContain(failedShapingRun.shaping_run_id);
    expect(disclosure).toContain("failed");
    expect(disclosure).toContain("requested-model");
    expect(disclosure).toContain("effective-model");
    expect(disclosure).toContain(failedShapingRun.write_policy.ingress_path);
    expect(disclosure).toContain("2 recorded · complete");
  });

  it("keeps Plan auxiliary implementation context inside Advanced recovery only", () => {
    const auxiliaryPlan: PlanResultSubmission = {
      ...planResult,
      relevant_skills: ["unique-step-23-skill"],
      product_doc_impacts: ["UNIQUE_STEP_23_PRODUCT_IMPACT"],
      todo_impacts: ["UNIQUE_STEP_23_TODO_IMPACT"],
    };
    const projection = shapingHandoffForItem(
      decisionItem("plan", decisionGoalContract),
      appliedDecisionContext("plan", auxiliaryPlan),
    );
    const html = renderDecision(
      projection,
      null,
      null,
      false,
      advancedRecoveryView({
        phase: "plan",
        currentTaskPath: null,
        compilation: null,
      }),
    );
    const disclosure = advancedRecoveryMarkup(html);
    const outside = outsideAdvancedRecoveryMarkup(html);

    expect(disclosure).toContain("Plan implementation context");
    expect(disclosure).toContain("Relevant skills");
    expect(disclosure).toContain("Product doc impacts");
    expect(disclosure).toContain("Todo impacts");
    for (const value of [
      "unique-step-23-skill",
      "UNIQUE_STEP_23_PRODUCT_IMPACT",
      "UNIQUE_STEP_23_TODO_IMPACT",
    ]) {
      expect(disclosure).toContain(value);
      expect(outside).not.toContain(value);
    }
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

    expect(html).toContain('data-shaping-density="compact-spec"');
    expect(html).toContain('data-spec-governed-layout="compact"');
    expect(html).toContain('data-spec-decision-controls="compact"');
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

  it("renders ready Plan approval with an Execute picker and persistent primary action", () => {
    const projection = shapingHandoffForItem(
      decisionItem("plan", decisionGoalContract),
      appliedDecisionContext("plan", planResult),
    );
    if (projection.mode !== "ready" || projection.phase !== "plan") {
      throw new Error("expected a ready Plan projection");
    }

    const html = renderDecision(projection, "model-a");
    const visible = visibleMarkup(html);

    expect(regionNames(html)).toEqual([
      "status",
      "summary",
      "criteria",
      "unresolved-questions",
      "provenance",
      "next-step",
      "advanced-recovery",
      "footer",
    ]);
    expect(visible).toContain("Plan result ready");
    expect(visible).toContain("Plan checklist");
    expect(visible).toContain("Show all 7");
    expect(visible).not.toContain("Plan checklist step 7");
    expect(visible).not.toContain("Governed fields");
    expect(visible).toContain("Next step");
    expect(html).toContain('<select aria-label="Execute model"');
    expect(visible).toContain("model-a was already used by brainstorm.");
    expect(buttonAttributes(html, "Approve & run Execute")).toContain(
      'data-action-priority="primary"',
    );
    expect(html).toMatch(
      /<footer data-region="footer" data-shaping-footer="persistent" class="[^"]*shrink-0[^"]*"/u,
    );
    expect(visible).not.toContain("Execute approval is not part of this slice.");
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

  it("promotes manual Execute preparation when the connected runtime is unavailable", () => {
    const projection = shapingHandoffForItem(
      decisionItem("plan", decisionGoalContract),
      appliedDecisionContext("plan", planResult, {
        models: {
          execute: {
            status: "unavailable",
            reason: "The Execute runtime is unavailable.",
            available_model_ids: [],
          },
        },
      }),
    );
    if (projection.mode !== "ready" || projection.phase !== "plan") {
      throw new Error("expected a ready Plan projection");
    }

    const html = renderDecision(projection);
    const visible = visibleMarkup(html);

    expect(visible).toContain("The Execute runtime is unavailable.");
    expect(html).not.toContain('<select aria-label="Execute model"');
    expect(exactButtonCount(html, "Approve & run Execute")).toBe(0);
    expect(buttonAttributes(html, "Approve & prepare Execute")).toContain(
      'data-action-priority="primary"',
    );
  });

  it("clears shaping-only state before handing Plan approval to Execute", () => {
    const stopShapingRefresh = vi.fn();
    const clearShapingRefreshIdentity = vi.fn();
    const clearShapingRefreshBinding = vi.fn();
    const setShapingLaunchFailureState = vi.fn();
    const setShapingNewAttemptState = vi.fn();
    const setShowFullWorkItem = vi.fn();

    clearShapingStateForExecuteHandoff({
      stopShapingRefresh,
      clearShapingRefreshIdentity,
      clearShapingRefreshBinding,
      setShapingLaunchFailureState,
      setShapingNewAttemptState,
      setShowFullWorkItem,
    });

    expect(stopShapingRefresh).toHaveBeenCalledOnce();
    expect(clearShapingRefreshIdentity).toHaveBeenCalledOnce();
    expect(clearShapingRefreshBinding).toHaveBeenCalledOnce();
    expect(setShapingLaunchFailureState).toHaveBeenCalledWith(null);
    expect(setShapingNewAttemptState).toHaveBeenCalledWith(null);
    expect(setShowFullWorkItem).toHaveBeenCalledWith(false);
  });

  it.each([
    {
      phase: "brainstorm" as const,
      result: brainstormResult,
      contract: undefined,
      currentModel: "model-a",
      currentAction: "Use result & run Spec",
    },
    {
      phase: "spec" as const,
      result: specResult,
      contract: undefined,
      currentModel: "model-b",
      currentAction: "Approve & run Plan",
    },
    {
      phase: "plan" as const,
      result: planResult,
      contract: decisionGoalContract,
      currentModel: "model-c",
      currentAction: null,
    },
  ])(
    "renders the required current-seat request-changes composer on ready $phase",
    ({ phase, result, contract, currentModel, currentAction }) => {
      const projection = shapingHandoffForItem(
        decisionItem(phase, contract),
        appliedDecisionContext(phase, result, {
          models: {
            model_use: [
              {
                seat: "brainstorm",
                production_id: "prod-brainstorm",
                shaping_run_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1",
                requested_model: "model-a",
                effective_model: "model-a",
              },
              ...(phase === "brainstorm"
                ? []
                : [
                    {
                      seat: "spec" as const,
                      production_id: "prod-spec",
                      shaping_run_id:
                        "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b2",
                      requested_model: "model-b",
                      effective_model: "model-b",
                    },
                  ]),
              ...(phase === "plan"
                ? [
                    {
                      seat: "plan" as const,
                      production_id: "prod-plan",
                      shaping_run_id:
                        "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b3",
                      requested_model: "model-c",
                      effective_model: "model-c",
                    },
                  ]
                : []),
            ],
          },
        }),
      );
      if (projection.mode !== "ready" || projection.phase !== phase) {
        throw new Error(`expected a ready ${phase} projection`);
      }

      const html = renderDecision(projection, null, {
        launchMode: "connected",
        feedback: "",
        selectedModel: null,
        error: null,
      });
      const visible = visibleMarkup(html);

      expect(html).toContain('data-region="request-changes"');
      expect(html).toContain('<textarea aria-label="Required feedback"');
      expect(html).toContain('required=""');
      expect(html).toContain(
        `<select aria-label="${phase[0]!.toUpperCase()}${phase.slice(1)} model"`,
      );
      expect(visible).toContain(`${currentModel} · current revision`);
      expect(html).toContain(
        `<option value="${currentModel}" selected="">${currentModel} · current revision`,
      );
      expect(buttonAttributes(html, "Request changes & rerun")).toContain(
        ' disabled=""',
      );
      expect(countOccurrences(html, 'data-action-priority="primary"')).toBe(1);
      if (currentAction !== null) {
        expect(exactButtonCount(html, currentAction)).toBe(0);
      }
      if (phase === "plan") {
        expect(visible).not.toContain("Execute the plan");
      }
    },
  );

  it("keeps request changes disabled for whitespace-only feedback and builds no request", () => {
    const projection = shapingHandoffForItem(
      decisionItem("brainstorm"),
      appliedDecisionContext("brainstorm", brainstormResult),
    );
    if (projection.mode !== "ready" || projection.phase !== "brainstorm") {
      throw new Error("expected a ready Brainstorm projection");
    }
    const action = projection.request_changes.actions.find(
      (candidate) =>
        candidate.kind === "request_changes" &&
        candidate.launch_mode === "connected",
    );
    if (action === undefined) {
      throw new Error("expected a connected request-changes action");
    }

    const html = renderDecision(projection, null, {
      launchMode: "connected",
      feedback: "   \n\t",
      selectedModel: "model-a",
      error: null,
    });
    expect(buttonAttributes(html, "Request changes & rerun")).toContain(
      ' disabled=""',
    );
    expect(
      shapingActionRequest({
        source_id: "source-1",
        work_item_id: workItemId,
        projection,
        action,
        selected_model: "model-a",
        feedback: "   \n\t",
      }),
    ).toEqual({ status: "blocked", reason: "feedback_required" });
  });

  it("uses one feedback-bound manual request path when connected models are unavailable", () => {
    const projection = shapingHandoffForItem(
      decisionItem("brainstorm"),
      appliedDecisionContext("brainstorm", brainstormResult, {
        models: {
          status: "unavailable",
          reason: "The connected shaping runtime is unavailable.",
          available_model_ids: [],
          model_picker_options: { brainstorm: [], spec: [], plan: [] },
        },
      }),
    );
    if (projection.mode !== "ready" || projection.phase !== "brainstorm") {
      throw new Error("expected a ready Brainstorm projection");
    }
    const action = projection.request_changes.actions.find(
      (candidate) =>
        candidate.kind === "request_changes" &&
        candidate.launch_mode === "manual",
    );
    if (action === undefined) {
      throw new Error("expected a manual request-changes action");
    }

    const html = renderDecision(projection, null, {
      launchMode: "manual",
      feedback: "Prepare the corrected Brainstorm revision.",
      selectedModel: null,
      error: null,
    });
    expect(visibleMarkup(html)).toContain(
      "The connected shaping runtime is unavailable.",
    );
    expect(html).not.toContain("<select");
    expect(exactButtonCount(html, "Request changes & prepare rerun")).toBe(1);
    expect(
      buttonAttributes(html, "Request changes & prepare rerun"),
    ).not.toContain(' disabled=""');
    expect(advancedRecoveryMarkup(html)).not.toContain(
      "Request changes & prepare rerun",
    );
    const request = shapingActionRequest({
      source_id: "source-1",
      work_item_id: workItemId,
      projection,
      action,
      selected_model: "must-not-leak",
      feedback: "Prepare the corrected Brainstorm revision.",
    });
    expect(request).toMatchObject({
      status: "ready",
      body: {
        launch_mode: "manual",
        feedback: "Prepare the corrected Brainstorm revision.",
      },
    });
    if (request.status === "ready") {
      expect(request.body).not.toHaveProperty("requested_model");
    }
  });

  it("retains request-changes feedback, model and inline failure while re-enabling submission", () => {
    const projection = shapingHandoffForItem(
      decisionItem("brainstorm"),
      appliedDecisionContext("brainstorm", brainstormResult),
    );
    if (projection.mode !== "ready" || projection.phase !== "brainstorm") {
      throw new Error("expected a ready Brainstorm projection");
    }

    const html = renderDecision(projection, null, {
      launchMode: "connected",
      feedback: "Keep the evidence local and narrow the proposal.",
      selectedModel: "model-b",
      error: "The shaping action returned a bounded conflict.",
    });

    expect(visibleMarkup(html)).toContain(
      "Keep the evidence local and narrow the proposal.",
    );
    expect(html).toContain('<option value="model-b" selected="">');
    expect(visibleMarkup(html)).toContain(
      "The shaping action returned a bounded conflict.",
    );
    expect(html).toContain('data-request-changes-error="true"');
    expect(buttonAttributes(html, "Request changes & rerun")).not.toContain(
      ' disabled=""',
    );
  });

  it("keeps composer input across failure and clears it only for the matching success", () => {
    const identity = JSON.stringify([
      "source-1",
      workItemId,
      "brainstorm",
      missionContentSha256,
      resultContentSha256,
      shapingStateSha256,
    ]);
    let state = updateShapingRequestChangesComposer(null, {
      type: "open",
      identity,
      launchMode: "connected",
      selectedModel: "model-a",
    });
    state = updateShapingRequestChangesComposer(state, {
      type: "feedback_changed",
      identity,
      feedback: "Keep the bounded evidence and retry.",
    });
    state = updateShapingRequestChangesComposer(state, {
      type: "model_selected",
      identity,
      model: "model-b",
    });
    state = updateShapingRequestChangesComposer(state, {
      type: "request_started",
      identity,
    });
    state = updateShapingRequestChangesComposer(state, {
      type: "request_failed",
      identity,
      reason: "The request returned 409.",
    });

    expect(state).toEqual({
      identity,
      open: true,
      launchMode: "connected",
      feedback: "Keep the bounded evidence and retry.",
      selectedModel: "model-b",
      error: "The request returned 409.",
    });
    expect(
      updateShapingRequestChangesComposer(state, {
        type: "request_succeeded",
        identity: `${identity}:stale`,
      }),
    ).toEqual(state);

    state = updateShapingRequestChangesComposer(state, {
      type: "request_started",
      identity,
    });
    expect(state).toMatchObject({
      feedback: "Keep the bounded evidence and retry.",
      selectedModel: "model-b",
      error: null,
    });
    expect(
      updateShapingRequestChangesComposer(state, {
        type: "request_succeeded",
        identity,
      }),
    ).toBeNull();
  });

  it("binds retained-lock acknowledgement and repair to the exact durable run", () => {
    const activeRun = {
      run_id: "fadecefa-01cb-5540-a0a8-4c14a145a962",
      idempotency_key: "request-changes:plan:retained",
      acquired_at: "2026-08-04T17:22:14.615Z",
    };
    const repair = retainedControllerLeaseRepairForConflict({
      itemKey: "source-1:item-1:plan",
      phase: "plan",
      errorCode: "repair_required",
      errorMessage:
        "The controller retains a run; use repairRetainedControllerLease after confirming it is no longer executing.",
      activeRun,
    });

    expect(repair).toEqual({
      identity: JSON.stringify([
        "source-1:item-1:plan",
        activeRun.run_id,
        activeRun.acquired_at,
      ]),
      itemKey: "source-1:item-1:plan",
      phase: "plan",
      retainedRun: activeRun,
      acknowledged: false,
      status: "awaiting_acknowledgement",
      error: null,
    });
    expect(
      retainedControllerLeaseRepairForConflict({
        itemKey: "source-1:item-1:plan",
        phase: "plan",
        errorCode: "stale_expectation",
        errorMessage:
          "The controller retains a run; use repairRetainedControllerLease after confirming it is no longer executing.",
        activeRun,
      }),
    ).toBeNull();
    expect(
      retainedControllerLeaseRepairForConflict({
        itemKey: "source-1:item-1:plan",
        phase: "plan",
        errorCode: "repair_required",
        errorMessage:
          "The controller retains a run; use repairRetainedControllerLease after confirming it is no longer executing.",
        activeRun: undefined,
      }),
    ).toBeNull();
    expect(
      retainedControllerLeaseRepairForConflict({
        itemKey: "source-1:item-1:plan",
        phase: "plan",
        errorCode: "repair_required",
        errorMessage: "A pending manifest needs deterministic reconciliation.",
        activeRun,
      }),
    ).toBeNull();

    expect(
      retainedControllerLeaseRepairRequest("source-1", workItemId, repair!),
    ).toEqual({ status: "blocked", reason: "acknowledgement_required" });
    expect(
      retainedControllerLeaseRepairRequest("source-1", workItemId, {
        ...repair!,
        acknowledged: true,
      }),
    ).toEqual({
      status: "ready",
      method: "POST",
      route: `/api/portfolio/work-items/source-1/${workItemId}/repair-controller-lease`,
      body: { acknowledged_run_id: activeRun.run_id },
    });
  });

  it("renders the retained-lock acknowledgement before repair and preserves explicit replay", () => {
    const projection = shapingHandoffForItem(
      decisionItem("plan", decisionGoalContract),
      appliedDecisionContext("plan", planResult),
    );
    if (projection.mode !== "ready" || projection.phase !== "plan") {
      throw new Error("expected a ready Plan projection");
    }
    const retainedRun = {
      run_id: "fadecefa-01cb-5540-a0a8-4c14a145a962",
      idempotency_key: "request-changes:plan:retained",
      acquired_at: "2026-08-04T17:22:14.615Z",
    };
    const baseRepair = {
      identity: "retained-repair",
      itemKey: "source-1:item-1:plan",
      phase: "plan" as const,
      retainedRun,
      acknowledged: false,
      status: "awaiting_acknowledgement" as const,
      error: null,
    };

    const blocked = visibleMarkup(
      renderDecision(projection, null, null, false, undefined, baseRepair),
    );
    expect(blocked).toContain("Retained controller run");
    expect(blocked).toContain(retainedRun.run_id);
    expect(blocked).toContain(retainedRun.acquired_at);
    expect(blocked).toContain("Plan");
    expect(blocked).toContain(retainedRun.idempotency_key);
    expect(blocked).toContain(
      `I have confirmed no operation for run ${retainedRun.run_id} is still executing.`,
    );
    expect(buttonAttributes(blocked, "Repair retained lock")).toContain(
      ' disabled=""',
    );

    const acknowledged = renderDecision(
      projection,
      null,
      null,
      false,
      undefined,
      { ...baseRepair, acknowledged: true },
    );
    expect(buttonAttributes(acknowledged, "Repair retained lock")).not.toContain(
      ' disabled=""',
    );

    const repaired = visibleMarkup(
      renderDecision(projection, null, null, false, undefined, {
        ...baseRepair,
        status: "repaired",
      }),
    );
    expect(repaired).toContain(
      "Retained lock repaired. Submit the preserved decision again to replay it.",
    );
    expect(repaired).not.toContain("Repair retained lock");
  });

  it("keeps the preserved ready projection inert while its replacement artifacts load", () => {
    const projection = shapingHandoffForItem(
      decisionItem("brainstorm"),
      appliedDecisionContext("brainstorm", brainstormResult),
    );
    if (projection.mode !== "ready" || projection.phase !== "brainstorm") {
      throw new Error("expected a ready Brainstorm projection");
    }

    const closedHtml = renderDecision(projection, null, null, true);
    expect(buttonAttributes(closedHtml, "Request changes")).toContain(
      ' disabled=""',
    );
    expect(buttonAttributes(closedHtml, "Use result & run Spec")).toContain(
      ' disabled=""',
    );

    const openHtml = renderDecision(
      projection,
      null,
      {
        launchMode: "connected",
        feedback: "Retry with the bounded correction.",
        selectedModel: "model-a",
        error: null,
      },
      true,
    );
    expect(openHtml).toMatch(
      /<textarea aria-label="Required feedback"[^>]* disabled=""/u,
    );
    expect(openHtml).toContain(
      '<select aria-label="Brainstorm model" disabled=""',
    );
    expect(buttonAttributes(openHtml, "Request changes & rerun")).toContain(
      ' disabled=""',
    );
  });

  it("submits request changes through the builder with feedback, model and exact bindings", () => {
    const projection = shapingHandoffForItem(
      decisionItem("brainstorm"),
      appliedDecisionContext("brainstorm", brainstormResult),
    );
    if (projection.mode !== "ready" || projection.phase !== "brainstorm") {
      throw new Error("expected a ready Brainstorm projection");
    }
    const action = projection.request_changes.actions.find(
      (candidate) =>
        candidate.kind === "request_changes" &&
        candidate.launch_mode === "connected",
    );
    if (action === undefined) {
      throw new Error("expected a connected request-changes action");
    }

    expect(
      shapingActionRequest({
        source_id: "source-1",
        work_item_id: workItemId,
        projection,
        action,
        selected_model: "model-b",
        feedback: "  Tighten the acceptance boundary.  ",
      }),
    ).toEqual({
      status: "ready",
      method: "POST",
      route: `/api/portfolio/work-items/source-1/${workItemId}/shaping/brainstorm/request-changes`,
      body: {
        launch_mode: "connected",
        requested_model: "model-b",
        expected_mission_content_sha256: missionContentSha256,
        expected_result_content_sha256: resultContentSha256,
        expected_shaping_state_sha256: shapingStateSha256,
        feedback: "Tighten the acceptance boundary.",
      },
    });
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

  it("renders all four bounded-refresh indicators and only offers an explicit refresh when needed", () => {
    const renderRefresh = (
      refresh: ShapingSurfaceContext["refresh"],
    ): string => {
      const projection = shapingHandoffForItem(
        decisionItem("brainstorm"),
        decisionSurfaceContext({
          run: decisionRun("running"),
          refresh,
        }),
      );
      if (projection.mode !== "run_state") {
        throw new Error("expected a running projection");
      }
      return visibleMarkup(renderDecision(projection));
    };

    const lastChecked = renderRefresh({
      last_checked_at: "2026-08-03T12:00:00.000Z",
      refreshing: false,
      stale: false,
      refresh_failure: null,
    });
    const refreshing = renderRefresh({
      last_checked_at: null,
      refreshing: true,
      stale: false,
      refresh_failure: null,
    });
    const stale = renderRefresh({
      last_checked_at: null,
      refreshing: false,
      stale: true,
      refresh_failure: null,
    });
    const failed = renderRefresh({
      last_checked_at: null,
      refreshing: false,
      stale: false,
      refresh_failure: { reason: "The local status endpoint did not respond." },
    });

    expect(lastChecked).toContain("Last checked");
    expect(lastChecked).not.toContain("Refresh status");
    expect(refreshing).toContain("Refreshing status");
    expect(refreshing).not.toContain("Refresh status");
    expect(stale).toContain("Status may be stale");
    expect(exactButtonCount(stale, "Refresh status")).toBe(1);
    expect(failed).toContain("Refresh failed");
    expect(failed).toContain("The local status endpoint did not respond.");
    expect(exactButtonCount(failed, "Refresh status")).toBe(1);
  });

  it("keeps the final successful check visible after the run becomes terminal", () => {
    const projection = shapingHandoffForItem(
      decisionItem("brainstorm"),
      decisionSurfaceContext({
        run: decisionRun("terminal", "cancelled"),
        refresh: {
          last_checked_at: "2026-08-03T12:00:00.000Z",
          refreshing: true,
          stale: true,
          refresh_failure: { reason: "A prior refresh failed." },
        },
      }),
    );
    const html = renderDecision(projection);

    expect(visibleMarkup(html)).toContain("Last checked");
    expect(html).toContain('data-refresh-running="false"');
    expect(visibleMarkup(html)).not.toContain("Refreshing status");
    expect(visibleMarkup(html)).not.toContain("Status may be stale");
    expect(visibleMarkup(html)).not.toContain("Refresh failed");
    expect(exactButtonCount(html, "Refresh status")).toBe(0);
  });

  it("renders every lifecycle row with its exact copy, refresh behavior, and action set", () => {
    const rows = [
      {
        name: "starting",
        context: decisionSurfaceContext({ run: decisionRun("starting") }),
        headline: "Brainstorm starting",
        copy: "The agent is being launched.",
        refreshRunning: true,
        actions: ["Cancel"],
        absent: ["Retry Brainstorm", "Prepare manual recovery"],
      },
      {
        name: "running",
        context: decisionSurfaceContext({ run: decisionRun("running") }),
        headline: "Brainstorm running",
        copy: "Inspecting the bounded mission.",
        refreshRunning: true,
        actions: ["Cancel"],
        absent: ["Retry Brainstorm", "Prepare manual recovery"],
      },
      {
        name: "blocked",
        context: decisionSurfaceContext({
          run: decisionRun("terminal", "missing_permission"),
        }),
        headline: "Brainstorm blocked",
        copy:
          "The agent requested an operation outside this run's write policy. Operation: url.",
        refreshRunning: false,
        actions: ["Retry Brainstorm"],
        absent: ["Cancel", "Prepare manual recovery"],
      },
      {
        name: "failed",
        context: decisionSurfaceContext({
          run: decisionRun("terminal", "failed"),
        }),
        headline: "Brainstorm failed",
        copy: "The result failed validation.",
        refreshRunning: false,
        actions: ["Retry Brainstorm", "Prepare manual recovery"],
        absent: ["Cancel"],
      },
      {
        name: "timed out",
        context: decisionSurfaceContext({
          run: decisionRun("terminal", "timed_out"),
        }),
        headline: "Brainstorm timed out",
        copy: "The 900 second wall-clock limit was reached.",
        refreshRunning: false,
        actions: ["Retry Brainstorm"],
        absent: ["Cancel", "Prepare manual recovery"],
      },
      {
        name: "cancelled",
        context: decisionSurfaceContext({
          run: decisionRun("terminal", "cancelled"),
        }),
        headline: "Brainstorm cancelled",
        copy: "You cancelled this run.",
        refreshRunning: false,
        actions: ["Retry Brainstorm"],
        absent: ["Cancel", "Prepare manual recovery"],
      },
      {
        name: "interrupted",
        context: decisionSurfaceContext({
          run: decisionRun("terminal", "interrupted"),
        }),
        headline: "Brainstorm interrupted",
        copy:
          "The agent process was no longer running when Product Studio recovered this run.",
        refreshRunning: false,
        actions: ["Retry Brainstorm"],
        absent: ["Cancel", "Prepare manual recovery"],
      },
      {
        name: "ready",
        context: appliedDecisionContext("brainstorm", brainstormResult),
        headline: "Brainstorm result ready",
        copy: "Choose the exact result to carry into Spec.",
        refreshRunning: false,
        actions: [
          "Request changes",
          "Use result & run Spec",
          "Use result & prepare Spec",
        ],
        absent: ["Cancel", "Retry Brainstorm"],
      },
      {
        name: "missing result",
        context: decisionSurfaceContext({
          run: decisionRun("terminal", "completed"),
        }),
        headline: "Brainstorm finished without a usable result",
        copy: "The run reported success but published no valid result bundle.",
        refreshRunning: false,
        actions: ["Retry Brainstorm"],
        absent: ["Cancel", "Prepare manual recovery"],
      },
      {
        name: "finishing",
        context: appliedDecisionContext("brainstorm", brainstormResult, {
          run: decisionRun("running"),
        }),
        headline: "Brainstorm finishing",
        copy: "Recovering this run's result.",
        refreshRunning: true,
        actions: [],
        absent: [
          "Cancel",
          "Retry Brainstorm",
          "Use result & run Spec",
          "Request changes",
        ],
      },
      {
        name: "needs repair",
        context: decisionSurfaceContext({
          revision: {
            mission_content_sha256: missionContentSha256,
            result: {
              status: "repair",
              failing_component: "production receipt",
            },
          },
        }),
        headline: "Brainstorm result needs repair",
        copy: "The applied marker disagrees with production receipt.",
        refreshRunning: false,
        actions: [],
        absent: [
          "Cancel",
          "Retry Brainstorm",
          "Use result & run Spec",
          "Request changes",
        ],
      },
    ] as const;

    for (const row of rows) {
      const projection = shapingHandoffForItem(
        decisionItem("brainstorm"),
        row.context,
      );
      const html = renderDecision(projection);
      const visible = visibleMarkup(html);

      expect(visible, row.name).toContain(row.headline);
      expect(visible, row.name).toContain(row.copy);
      expect(html, row.name).toContain(
        `data-refresh-running="${String(row.refreshRunning)}"`,
      );
      for (const label of row.actions) {
        expect(exactButtonCount(html, label), `${row.name}: ${label}`).toBe(1);
      }
      for (const label of row.absent) {
        expect(exactButtonCount(html, label), `${row.name}: ${label}`).toBe(0);
      }
      expect(visible.toLowerCase(), row.name).not.toContain("transcript");
      expect(visible, row.name).not.toMatch(/\bETA\b/iu);
      expect(visible, row.name).not.toMatch(/\b\d+(?:\.\d+)?%\b/u);
    }
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
  it("ends preflight after approval until the fresh tuple completes", () => {
    const completedPriorRun: ConnectedRunSummary = {
      ...connectedRun,
      lifecycle: {
        ...connectedRun.lifecycle,
        status: "terminal",
        completed_at: "2026-08-06T12:00:00.000Z",
        terminal_outcome: "completed",
        partial: false,
      },
    };
    const correctedState = {
      phase: "execute" as const,
      status: "active" as const,
      goal_version: 2,
      input_revision: 2,
      attempt: 0,
      patch_cycle: 0,
    };

    expect(
      commandAuthorizationPreflightEligible(correctedState, [
        completedPriorRun,
      ]),
    ).toBe(true);
    expect(
      commandAuthorizationPreflightEligible(
        { ...correctedState, attempt: 1 },
        [completedPriorRun],
      ),
    ).toBe(false);

    const completedFreshRun: ConnectedRunSummary = {
      ...completedPriorRun,
      mission: {
        ...completedPriorRun.mission,
        identity: {
          ...completedPriorRun.mission.identity,
          goal_version: 2,
          input_revision: 2,
          attempt: 1,
        },
      },
      governed_tuple: {
        goal_version: 2,
        input_revision: 2,
        attempt: 1,
        patch_cycle: 0,
      },
      lifecycle: {
        ...completedPriorRun.lifecycle,
        updated_at: "2026-08-06T12:05:00.000Z",
        completed_at: "2026-08-06T12:05:00.000Z",
      },
    };
    expect(
      commandAuthorizationPreflightEligible(
        { ...correctedState, attempt: 1 },
        [completedPriorRun, completedFreshRun],
      ),
    ).toBe(true);
    expect(
      commandAuthorizationPreflightEligible(
        {
          ...correctedState,
          phase: "review",
          attempt: 1,
        },
        [completedFreshRun],
      ),
    ).toBe(false);
  });

  it("shows every exact preflight command at the visible founder gate", () => {
    const commandAttention: Extract<
      WorkItemAttention,
      { kind: "command_authorization" }
    > = {
      kind: "command_authorization",
      question: "Allow these exact commands once in a fresh writable attempt?",
      recommendation: "Review every command.",
      created_at: "2026-08-06T12:00:00.000Z",
      governed_tuple: {
        goal_version: 2,
        input_revision: 2,
        attempt: 0,
        patch_cycle: 0,
      },
      pins: {
        artifact_paths: [
          `.founder/missions/${workItemId}/execute-2-2-0/mission.json`,
        ],
        evidence_paths: [],
        mission_content_sha256: missionContentSha256,
      },
      proposal: {
        schema_version: 1,
        phase: "execute",
        work_item_id: workItemId,
        governed_tuple: {
          goal_version: 2,
          input_revision: 2,
          attempt: 0,
          patch_cycle: 0,
        },
        source_mission_content_sha256: missionContentSha256,
        terminal_connected_run_id:
          "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1",
        changed_files: ["src/domain/work-item.ts"],
        commands: [
          {
            schema_version: 1,
            kind: "command",
            executable: "npm",
            args: ["test"],
          },
          {
            schema_version: 1,
            kind: "command",
            executable: "git",
            args: ["add", "--", "src/domain/work-item.ts"],
          },
          {
            schema_version: 1,
            kind: "command",
            executable: "git",
            args: ["commit", "-m", "Add model configuration"],
          },
        ],
        proposal_sha256: "f".repeat(64),
      },
    };
    const html = renderToStaticMarkup(
      <CommandAuthorizationSection
        fieldId="detail"
        attention={commandAttention}
        canPrepare={false}
        mutation={null}
        onPrepare={noop}
        onAllowOnce={noop}
        onKeepDenied={noop}
      />,
    );

    expect(html).toContain("Required command preflight");
    expect(html).toContain("npm test");
    expect(html).toContain("git add -- src/domain/work-item.ts");
    expect(html).toContain("git commit -m Add model configuration");
    expect(html).toContain(commandAttention.proposal.proposal_sha256);
    expect(html).toContain("Allow once and retry");
    expect(html).toContain("Keep denied");
    expect(primaryActionCount(html)).toBe(1);
  });

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
        onRetryWithoutAllowing={noop}
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

  it("presents the exact Review drift and preserves founder control", () => {
    const proposal: ReviewImportDriftRecoveryProposalV1 = {
      schema_version: 1,
      work_item_id: workItemId,
      identity: {
        phase: "review",
        work_item_id: workItemId,
        goal_version: 2,
        input_revision: 2,
        attempt: 17,
      },
      patch_cycle: 0,
      review_mission_content_sha256: missionContentSha256,
      result_content_sha256: resultContentSha256,
      rejected_import_run_id: "d".repeat(64),
      rejected_import_controller_run_id:
        "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1",
      rejected_import_evidence_path: evidencePath,
      accepted_result_commit: "1".repeat(40),
      current_head_commit: "2".repeat(40),
      changed_files: [
        "src/application/work-item-controller.ts",
        "tests/api/portfolio-routes.test.ts",
      ],
      subject_changed_files: ["tests/api/portfolio-routes.test.ts"],
      proposal_sha256: "f".repeat(64),
    };
    const html = renderToStaticMarkup(
      <ReviewImportDriftRecoverySection
        fieldId="detail"
        proposal={proposal}
        applying={false}
        onApply={noop}
      />,
    );

    expect(html).toContain("Review import drift requires approval");
    expect(html).toContain(proposal.accepted_result_commit);
    expect(html).toContain(proposal.current_head_commit);
    expect(html).toContain(proposal.result_content_sha256);
    expect(html).toContain(proposal.rejected_import_evidence_path);
    expect(html).toContain("src/application/work-item-controller.ts");
    expect(html).toContain("tests/api/portfolio-routes.test.ts");
    expect(html).toContain("Touches the reviewed subject");
    expect(html).toContain("Accept exact drift &amp; reassess Review");
    expect(primaryActionCount(html)).toBe(1);
  });

  it("clears Review drift approval and refreshes applied evidence before updating the board", async () => {
    const events: string[] = [];
    let recoveryProjection: unknown = "approval-card";
    let reviewImportProjection: unknown = "rejected-import";
    let evidenceProjection = "stale";
    const updatedItem = { state: "review-ready" };
    const onUpdated = vi.fn((item: typeof updatedItem, message: string) => {
      events.push("board-updated");
      expect(item).toBe(updatedItem);
      expect(message).toBe(
        "Exact drift accepted; the clean Review result is ready for approval.",
      );
      expect(evidenceProjection).toBe("applied-review-evidence");
    });

    await completeReviewImportDriftRecoverySuccess({
      itemKey: "source-1:work-item-1:review",
      sourceId: "source-1",
      workItemId,
      updatedItem,
      setRecoveryState(value) {
        events.push("approval-cleared");
        recoveryProjection = value;
      },
      clearReviewMissionImportState(value) {
        events.push("review-import-cleared");
        reviewImportProjection = value;
      },
      markRunEvidenceLoading() {
        events.push("evidence-loading");
        evidenceProjection = "loading";
      },
      async loadRunEvidence() {
        events.push("evidence-loaded");
        evidenceProjection = "applied-review-evidence";
      },
      onUpdated,
    });

    expect(recoveryProjection).toEqual({
      itemKey: "source-1:work-item-1:review",
      listing: {
        source_id: "source-1",
        work_item_id: workItemId,
        proposal: null,
      },
      loading: false,
      error: null,
    });
    expect(reviewImportProjection).toBeNull();
    expect(evidenceProjection).toBe("applied-review-evidence");
    expect(events).toEqual([
      "approval-cleared",
      "review-import-cleared",
      "evidence-loading",
      "evidence-loaded",
      "board-updated",
    ]);
    expect(onUpdated).toHaveBeenCalledOnce();
  });

  it("renders all recovery actions against the exact permission hash", () => {
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
        onRetryWithoutAllowing={noop}
        onKeepDenied={noop}
      />,
    );

    expect(html).toContain(operationSha256);
    expect(html).toContain("Allow once and retry");
    expect(html).toContain("Retry without allowing");
    expect(html).toContain("Keep denied");
    expect(html).not.toContain("Launch connected run");
  });
});

describe("detail panel connected Review and Patch", () => {
  const reviewReady: ConnectedPhaseProjection = {
    phase: "review",
    mode: "launch",
    can_launch: true,
    read_only: true,
    permission: null,
    run: null,
    authorization: null,
    model_picker: reviewModelPicker,
    actions: [
      {
        kind: "launch_phase",
        phase: "review",
        label: "Launch connected review",
        primary: true,
        enabled: true,
        connected_run_id: null,
      },
    ],
  };
  const patchReady: ConnectedPhaseProjection = {
    ...reviewReady,
    phase: "patch",
    read_only: false,
    model_picker: patchModelPicker,
    actions: [
      {
        kind: "launch_phase",
        phase: "patch",
        label: "Launch connected patch",
        primary: true,
        enabled: true,
        connected_run_id: null,
      },
    ],
  };

  it("leads Review with the pinned subject, read-only attestation, and one model-backed launch", () => {
    const subject = {
      phase: "execute" as const,
      commit: gitCommit,
      mission_path: `.founder/missions/${workItemId}/execute-1-1-0/mission.json`,
      evidence_path: evidencePath,
    };
    const unattested = renderConnectedPhase(reviewReady, {
      subject,
      manualRecovery: <p>Compile review mission manually</p>,
    });
    const attested = renderConnectedPhase(reviewReady, {
      subject,
      reviewAttested: true,
      manualRecovery: <p>Compile review mission manually</p>,
    });

    expect(unattested).toContain("Connected Review");
    expect(unattested).toContain("Read only");
    expect(unattested).toContain("Pinned subject");
    expect(unattested).toContain(subject.mission_path);
    expect(unattested).toContain(subject.evidence_path);
    expect(unattested).toContain("review-model · unused");
    expect(buttonAttributes(unattested, "Launch connected review")).toContain(
      'disabled=""',
    );
    expect(buttonAttributes(attested, "Launch connected review")).not.toContain(
      'disabled=""',
    );
    expect(primaryActionCount(attested)).toBe(1);
    expect(attested).toContain("Advanced recovery");
    expect(attested).toContain("Compile review mission manually");
    expect(attested).not.toContain("Allow once and retry");
    expect(attested).not.toContain("Capability envelope");
    expect(attested).not.toContain("raw ACP");
    expect(attested).not.toContain("terminal output");
  });

  it("keeps available Review models selectable when none is preselected", () => {
    const selectionRequired = renderConnectedPhase(
      {
        ...reviewReady,
        model_picker: {
          ...reviewModelPicker,
          options: [
            {
              ...decisionModelOption("claude-opus-4.5", {
                used_by_seats: ["plan"],
              }),
              current_revision: false,
            },
            {
              ...decisionModelOption("gpt-5.4", {
                used_by_seats: ["spec", "execute"],
              }),
              current_revision: false,
            },
          ],
          selected_model: null,
        },
      },
      { reviewAttested: true },
    );

    expect(selectionRequired).toContain(
      "A separate connected reviewer assesses the pinned code and evidence; you only confirm independence, choose its model, and launch it.",
    );
    expect(selectionRequired).toContain('aria-label="Review model"');
    expect(selectionRequired).toContain("Choose a model");
    expect(selectionRequired).toContain("claude-opus-4.5 · used by plan");
    expect(selectionRequired).toContain("gpt-5.4 · used by spec, execute");
    expect(selectionRequired).not.toContain(
      "No connected model is currently available.",
    );
    expect(
      buttonAttributes(selectionRequired, "Launch connected review"),
    ).toContain('disabled=""');
  });

  it("shows bounded running and failed states with phase-safe cancellation or retry", () => {
    const reviewRunning = renderConnectedPhase({
      ...reviewReady,
      mode: "running",
      can_launch: false,
      run: connectedReviewRun,
      authorization: connectedReviewRun.authorization,
      model_picker: undefined,
      actions: [
        {
          kind: "cancel_run",
          phase: "review",
          label: "Cancel connected review",
          primary: true,
          enabled: true,
          connected_run_id: connectedReviewRun.connected_run_id,
        },
      ],
    });
    const failedPatchRun: ConnectedRunSummary = {
      ...connectedPatchRun,
      lifecycle: {
        ...connectedPatchRun.lifecycle,
        status: "terminal",
        completed_at: "2026-07-26T12:02:00.000Z",
        terminal_outcome: "failed",
        partial: true,
      },
    };
    const patchFailed = renderConnectedPhase({
      ...patchReady,
      run: failedPatchRun,
      authorization: failedPatchRun.authorization,
    });

    expect(reviewRunning).toContain("Cancel connected review");
    expect(primaryActionCount(reviewRunning)).toBe(1);
    expect(reviewRunning).toContain("Result-only ingress");
    expect(reviewRunning).toContain("Latest sanitized run");
    expect(reviewRunning).not.toContain("Allow once and retry");
    expect(patchFailed).toContain("failed");
    expect(patchFailed).toContain("Launch connected patch");
    expect(patchFailed).toContain("Capability envelope");
    expect(primaryActionCount(patchFailed)).toBe(1);
    expect(patchFailed).not.toContain("Cancel connected review");
  });

  it("keeps clean and findings recovery inside the collapsed manual handoff", () => {
    const clean = renderConnectedPhase(reviewReady, {
      reviewAttested: true,
      manualRecovery: <p>Clean review imported</p>,
    });
    const findings = renderConnectedPhase(reviewReady, {
      reviewAttested: true,
      manualRecovery: <p>2 review findings imported</p>,
    });

    expect(clean).toContain("Advanced recovery");
    expect(clean).toContain("Clean review imported");
    expect(findings).toContain("Advanced recovery");
    expect(findings).toContain("2 review findings imported");
    expect(clean).toContain("Launch connected review");
    expect(findings).toContain("Launch connected review");
  });

  it("renders exact permission recovery for Patch only", () => {
    const patchPermission: ConnectedPhaseProjection = {
      phase: "patch",
      mode: "permission",
      can_launch: false,
      read_only: false,
      permission: {
        ...missingPermissionAttention,
        governed_tuple: connectedPatchRun.governed_tuple,
      },
      run: {
        ...connectedPatchRun,
        lifecycle: {
          ...connectedPatchRun.lifecycle,
          status: "terminal",
          completed_at: "2026-07-26T12:02:00.000Z",
          terminal_outcome: "missing_permission",
          partial: true,
        },
      },
      authorization: connectedPatchRun.authorization,
      actions: [
        {
          kind: "allow_once",
          phase: "patch",
          label: "Allow once and retry",
          primary: true,
          enabled: true,
          connected_run_id: connectedPatchRun.connected_run_id,
        },
        {
          kind: "keep_denied",
          phase: "patch",
          label: "Keep denied",
          primary: false,
          enabled: true,
          connected_run_id: connectedPatchRun.connected_run_id,
        },
        {
          kind: "retry_without_allowing",
          phase: "patch",
          label: "Retry without allowing",
          primary: false,
          enabled: true,
          connected_run_id: connectedPatchRun.connected_run_id,
        },
      ],
    };
    const patch = renderConnectedPhase(patchPermission);
    const impossibleReview = renderConnectedPhase({
      ...patchPermission,
      phase: "review",
      read_only: true,
      run: connectedReviewRun,
      authorization: connectedReviewRun.authorization,
      actions: [],
    });

    expect(patch).toContain(missingPermissionAttention.operation.operation_sha256);
    expect(patch).toContain("Allow once and retry");
    expect(patch).toContain("Retry without allowing");
    expect(patch).toContain("Keep denied");
    expect(primaryActionCount(patch)).toBe(1);
    expect(impossibleReview).not.toContain("Allow once and retry");
    expect(impossibleReview).not.toContain("Retry without allowing");
    expect(impossibleReview).not.toContain("Keep denied");
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
