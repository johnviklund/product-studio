import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { BoardCardPreview } from "../components/kanban/board-card";
import { requestBoardTransition } from "../components/kanban/kanban-board";
import type {
  PortfolioItemShapingRunStatus,
  PortfolioItemShapingSummary,
} from "../src/application/portfolio";
import type { PortfolioWorkItem } from "../src/domain/portfolio";
import type { WorkItemPhase, WorkItemStatus } from "../src/domain/work-item";

const sourceId = "ws_550e8400-e29b-41d4-a716-446655440000";
const workItemId = "wi_550e8400-e29b-41d4-a716-446655440001";

type CardItem = PortfolioWorkItem & {
  shaping_summary?: PortfolioItemShapingSummary;
};

function summary(
  phase: PortfolioItemShapingSummary["phase"],
  latestRunStatus: PortfolioItemShapingRunStatus | null,
  overrides: Partial<PortfolioItemShapingSummary> = {},
): PortfolioItemShapingSummary {
  return {
    phase,
    tip_mission_content_sha256: "a".repeat(64),
    has_applied_result: latestRunStatus === "ready",
    decision_kind: null,
    latest_run_status: latestRunStatus,
    ...overrides,
  };
}

function cardItem(
  phase: WorkItemPhase,
  status: WorkItemStatus = "active",
  shapingSummary?: PortfolioItemShapingSummary,
  source: string = sourceId,
): CardItem {
  return {
    source_id: source,
    project:
      source === "inbox"
        ? null
        : {
            workspace_id: sourceId,
            workspace_path: "/tmp/product-studio-board-card-test",
            product_name: "Board Card Product",
            registered_at: "2026-08-03T12:00:00.000Z",
          },
    work_item: {
      goal: {
        schema_version: 2,
        work_item_id: workItemId,
        title: "Project one truthful card state",
      },
      state: {
        schema_version: 2,
        work_item_id: workItemId,
        phase,
        status,
        updated_at: "2026-08-03T12:01:00.000Z",
      },
    },
    ...(shapingSummary === undefined
      ? {}
      : { shaping_summary: shapingSummary }),
  };
}

function renderCard(item: CardItem): string {
  return renderToStaticMarkup(<BoardCardPreview item={item} />);
}

describe("closed board card shaping projection", () => {
  it.each([
    {
      name: "Idea",
      item: cardItem("idea"),
      badge: "Idea",
      action: "Start Brainstorm",
    },
    {
      name: "Brainstorm ready",
      item: cardItem("brainstorm", "active", summary("brainstorm", "ready")),
      badge: "Brainstorm · Ready",
      action: "Use result &amp; run Spec",
    },
    {
      name: "Spec ready",
      item: cardItem("spec", "active", summary("spec", "ready")),
      badge: "Spec · Ready",
      action: "Approve &amp; run Plan",
    },
    {
      name: "Plan ready",
      item: cardItem("plan", "active", summary("plan", "ready")),
      badge: "Plan · Ready",
      action: "Approve &amp; run Execute",
    },
    {
      name: "failed run",
      item: cardItem("spec", "active", summary("spec", "failed")),
      badge: "Spec · Failed",
      action: "Retry Spec",
    },
    {
      name: "not started",
      item: cardItem("plan", "active", summary("plan", null)),
      badge: "Plan",
      action: "Start Plan",
    },
  ])("renders the D23 $name row without the detail panel", ({ item, badge, action }) => {
    const html = renderCard(item);

    expect(html).toContain(badge);
    expect(html).toContain(action);
    expect(html).not.toContain("Execute the plan");
  });

  it.each([
    ["starting", "Brainstorm · Active", "Brainstorm running"],
    ["running", "Brainstorm · Active", "Brainstorm running"],
    ["finishing", "Brainstorm · Active", "Brainstorm running"],
    ["blocked", "Brainstorm · Blocked", "Retry Brainstorm"],
    ["failed", "Brainstorm · Failed", "Retry Brainstorm"],
    ["timed_out", "Brainstorm · Failed", "Retry Brainstorm"],
    ["cancelled", "Brainstorm · Failed", "Retry Brainstorm"],
    ["interrupted", "Brainstorm · Failed", "Retry Brainstorm"],
    ["missing_result", "Brainstorm · Failed", "Retry Brainstorm"],
    ["needs_repair", "Brainstorm · Needs repair", "Open advanced recovery"],
  ] as const)(
    "renders the D11 %s lifecycle label",
    (runStatus, badge, action) => {
      const html = renderCard(
        cardItem("brainstorm", "active", summary("brainstorm", runStatus)),
      );

      expect(html).toContain(badge);
      expect(html).toContain(action);
      expect(html).not.toContain("Execute the plan");
    },
  );

  it("keeps an Inbox item outside shaping cards and actions", () => {
    const html = renderCard(
      cardItem("idea", "active", undefined, "inbox"),
    );

    expect(html).toContain("idea");
    expect(html).toContain("active");
    expect(html).toContain("Brainstorm the idea");
    expect(html).not.toContain("Start Brainstorm");
    expect(html).not.toContain("Valid workflow transitions");
  });

  it("keeps a non-active card on its phase fallback without a ready badge", () => {
    const html = renderCard(
      cardItem("plan", "blocked", summary("plan", "ready")),
    );

    expect(html).toContain("plan");
    expect(html).toContain("blocked");
    expect(html).toContain("Approve &amp; run Execute");
    expect(html).not.toContain("Plan · Ready");
    expect(html).not.toContain("Execute the plan");
  });

  it("refuses a dedicated drop before PATCH and preserves the card", async () => {
    const item = cardItem(
      "brainstorm",
      "active",
      summary("brainstorm", "ready"),
    );
    const request = vi.fn<typeof fetch>();
    const onRequestStart = vi.fn();

    const result = await requestBoardTransition(
      item,
      "spec",
      request,
      onRequestStart,
    );

    expect(result).toMatchObject({
      kind: "refused",
      reason:
        "Open the item and use Use result & run Spec. The Spec input must be a real Brainstorm selection.",
    });
    expect(result.item).toBe(item);
    expect(request).not.toHaveBeenCalled();
    expect(onRequestStart).not.toHaveBeenCalled();
  });
});
