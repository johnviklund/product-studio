import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  PortfolioAttentionItem,
  PortfolioNeedsYouEntry,
} from "../src/application/portfolio";
import { AttentionDecisionList } from "../components/inbox/attention-inbox";
import { WorkspaceRail } from "../components/workspace-rail";

const sourceId = "ws_550e8400-e29b-41d4-a716-446655440000";
const workItemId = "wi_550e8400-e29b-41d4-a716-446655440001";
const artifactPath = `.founder/missions/${workItemId}/review-1-1-0/mission.json`;
const evidencePath = `.founder/run-evidence/${workItemId}/review-1-1-0/${"d".repeat(64)}`;
const gitCommit = "c".repeat(40);

const attentionItem = {
  item: {
    source_id: sourceId,
    project: {
      workspace_id: sourceId,
      workspace_path: "/tmp/product-studio-inbox-test",
      product_name: "Inbox Test Product",
      registered_at: "2026-07-25T12:00:00.000Z",
    },
    work_item: {
      goal: {
        schema_version: 2 as const,
        work_item_id: workItemId,
        title: "Approve the bounded patch",
        type: "Feature" as const,
        goal_contract: {
          schema_version: 1 as const,
          goal_version: 1,
          purpose: "Prove the attention inbox",
          acceptance_criteria: ["The decision is source-qualified"],
          non_goals: ["No direct durable-file writes"],
          allowed_scope: ["components/inbox/**"],
          review_ready: ["Inbox tests pass"],
        },
      },
      state: {
        schema_version: 2 as const,
        work_item_id: workItemId,
        phase: "review" as const,
        status: "active" as const,
        updated_at: "2026-07-25T12:01:05.000Z",
        goal_version: 1,
        input_revision: 1,
        attempt: 0,
        patch_cycle: 0,
      },
    },
  },
  attention: {
    kind: "patch_plan_approval" as const,
    question: "Approve one patch that addresses these exact findings?",
    recommendation: "Approve the bounded patch plan.",
    created_at: "2026-07-25T12:01:05.000Z",
    governed_tuple: {
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
      patch_cycle: 0,
    },
    pins: {
      artifact_paths: [artifactPath] as [string, ...string[]],
      evidence_paths: [evidencePath],
      git_commit: gitCommit,
      mission_content_sha256: "a".repeat(64),
      result_content_sha256: "b".repeat(64),
    },
  },
  acceptance_criteria: [
    {
      criterion: "The decision is source-qualified",
      status: "needs_attention" as const,
    },
  ],
  verification: {
    status: "passed" as const,
    commands: [{ name: "Tests", status: "passed" as const }],
  },
  findings: [
    {
      finding_id: "F-inbox-1",
      severity: "P2" as const,
      title: "Decision needs confirmation",
      evidence: { summary: "The current review has a bounded finding." },
      required_action: "Approve one patch attempt.",
      link: {
        type: "acceptance_criteria" as const,
        criterion: "The decision is source-qualified",
      },
    },
  ],
  patch_cycle_limit: 3 as const,
  elapsed_ms: 65_000,
  cost_capacity: "unknown" as const,
} satisfies PortfolioAttentionItem;

const missingPermissionAttention = {
  kind: "missing_permission" as const,
  question: "Allow this exact command once and retry the fresh Execute attempt?",
  recommendation: "Keep it denied unless the command is required.",
  created_at: "2026-07-26T12:01:05.000Z",
  governed_tuple: {
    goal_version: 1,
    input_revision: 1,
    attempt: 0,
    patch_cycle: 0,
  },
  pins: {
    artifact_paths: [`.founder/missions/${workItemId}/execute-1-1-0/mission.json`] as [
      string,
      ...string[],
    ],
    evidence_paths: [],
    mission_content_sha256: "e".repeat(64),
  },
  operation: {
    normalized_operation: {
      schema_version: 1 as const,
      kind: "command" as const,
      executable: "git",
      args: ["status"],
    },
    canonical_args_sha256: "f".repeat(64),
    operation_sha256: "1".repeat(64),
    reason: "This command is outside the compiled capability envelope.",
    resolved_envelope_sha256: "2".repeat(64),
    connected_run_id: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1",
  },
} satisfies Extract<
  PortfolioAttentionItem["attention"],
  { kind: "missing_permission" }
>;

const connectedAttentionItem = {
  ...attentionItem,
  item: {
    ...attentionItem.item,
    work_item: {
      ...attentionItem.item.work_item,
      goal: {
        ...attentionItem.item.work_item.goal,
        title: "Recover the connected Execute run",
      },
      state: {
        ...attentionItem.item.work_item.state,
        phase: "execute" as const,
        attention: missingPermissionAttention,
      },
    },
  },
  attention: missingPermissionAttention,
  verification: { status: "unknown" as const, commands: [] },
  findings: [],
} satisfies PortfolioAttentionItem;

const governedAttentionEntry = {
  kind: "governed",
  entry: attentionItem,
} satisfies PortfolioNeedsYouEntry;

const connectedAttentionEntry = {
  kind: "governed",
  entry: connectedAttentionItem,
} satisfies PortfolioNeedsYouEntry;

const shapingAttentionEntry = {
  kind: "shaping",
  item: {
    ...attentionItem.item,
    work_item: {
      ...attentionItem.item.work_item,
      goal: {
        ...attentionItem.item.work_item.goal,
        title: "Approve the ready Spec result",
        goal_contract: undefined,
      },
      state: {
        ...attentionItem.item.work_item.state,
        phase: "spec" as const,
        goal_version: undefined,
        input_revision: undefined,
        attempt: undefined,
        patch_cycle: undefined,
      },
    },
  },
  shaping_attention: {
    schema_version: 1 as const,
    kind: "spec_approval_shaping" as const,
    work_item_id: workItemId,
    source_id: sourceId,
    phase: "spec" as const,
    question: "A Spec result is ready for your approval." as const,
    recommendation: "Open the item and use Approve & run Plan." as const,
    binding: {
      mission_content_sha256: "1".repeat(64),
      applied_result_content_sha256: "2".repeat(64),
      shaping_state_sha256: "3".repeat(64),
    },
    pins: {
      artifact_paths: [
        `.founder/shaping/${workItemId}/spec-a`,
        `.founder/shaping/${workItemId}/spec-a/applied`,
      ],
    },
    created_at: "2026-07-27T12:01:05.000Z",
  },
} satisfies PortfolioNeedsYouEntry;

describe("attention inbox", () => {
  it("renders an explicit empty state", () => {
    const html = renderToStaticMarkup(
      <AttentionDecisionList items={[]} totalCount={0} />,
    );

    expect(html).toContain("You’re all caught up");
    expect(html).toContain("No work item currently needs a human decision.");
  });

  it("distinguishes an empty board scope from an empty portfolio", () => {
    const html = renderToStaticMarkup(
      <AttentionDecisionList items={[]} totalCount={2} />,
    );

    expect(html).toContain("No decisions in this scope");
    expect(html).toContain("current board project filter hides 2 pending decisions");
  });

  it("renders the complete source-qualified decision projection", () => {
    const html = renderToStaticMarkup(
      <AttentionDecisionList items={[governedAttentionEntry]} totalCount={1} />,
    );

    expect(html).toContain(attentionItem.attention.question);
    expect(html).toContain(attentionItem.attention.recommendation);
    expect(html).toContain("Inbox Test Product");
    expect(html).toContain(sourceId);
    expect(html).toContain(workItemId);
    expect(html).toContain("v1 / r1");
    expect(html).toContain("0 of 3");
    expect(html).toContain("1 min 5 sec");
    expect(html).toContain("Cost/capacity");
    expect(html).toContain("unknown");
    expect(html).toContain("needs attention");
    expect(html).toContain("Tests · passed");
    expect(html).toContain(">P2</span>");
    expect(html).toContain("Decision needs confirmation");
    expect(html).toContain(artifactPath);
    expect(html).toContain(evidencePath);
    expect(html).toContain(gitCommit);
    expect(html).toContain("Open on board");
    expect(html).toContain(`source=${sourceId}&amp;item=${workItemId}`);
  });

  it("renders one read-only connected permission recovery row", () => {
    const html = renderToStaticMarkup(
      <AttentionDecisionList items={[connectedAttentionEntry]} totalCount={1} />,
    );

    expect(html.match(/aria-label="Connected permission recovery"/g)).toHaveLength(1);
    expect(html).toContain("Command · git status");
    expect(html).toContain(missingPermissionAttention.operation.reason);
    expect(html).toContain(missingPermissionAttention.operation.operation_sha256);
    expect(html).toContain("Allow once and retry");
    expect(html).toContain("Keep denied");
    expect(html).toContain("Open recovery");
    expect(html).toContain(`source=${sourceId}&amp;item=${workItemId}`);
    expect(html).not.toMatch(/<button[^>]*>Allow once and retry<\/button>/);
    expect(html).not.toMatch(/<button[^>]*>Keep denied<\/button>/);
  });

  it("renders a pre-contract shaping decision without governed fields", () => {
    const html = renderToStaticMarkup(
      <AttentionDecisionList items={[shapingAttentionEntry]} totalCount={1} />,
    );

    expect(html).toContain(shapingAttentionEntry.shaping_attention.question);
    expect(html).toContain("Open the item and use Approve &amp; run Plan.");
    expect(html).toContain("Approve the ready Spec result");
    expect(html).toContain(
      shapingAttentionEntry.shaping_attention.binding
        .applied_result_content_sha256,
    );
    expect(html).toContain(
      shapingAttentionEntry.shaping_attention.pins.artifact_paths[1],
    );
    expect(html).toContain(`source=${sourceId}&amp;item=${workItemId}`);
    expect(html).not.toContain("Goal / input");
    expect(html).not.toContain("Cost/capacity");
    expect(html).not.toContain("Current findings");
  });

  it("marks only the current keyboard-accessible rail link", () => {
    const inboxHtml = renderToStaticMarkup(<WorkspaceRail current="inbox" />);
    const boardHtml = renderToStaticMarkup(<WorkspaceRail current="board" />);

    expect(inboxHtml.match(/aria-current="page"/g)).toHaveLength(1);
    expect(inboxHtml).toMatch(
      /<a(?=[^>]*href="\/inbox")(?=[^>]*aria-label="Needs you")(?=[^>]*aria-current="page")[^>]*>/,
    );
    expect(boardHtml.match(/aria-current="page"/g)).toHaveLength(1);
    expect(boardHtml).toMatch(
      /<a(?=[^>]*href="\/")(?=[^>]*aria-label="All work")(?=[^>]*aria-current="page")[^>]*>/,
    );
  });
});
