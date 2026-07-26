import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PortfolioAttentionItem } from "../src/application/portfolio";
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
      <AttentionDecisionList items={[attentionItem]} totalCount={1} />,
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
