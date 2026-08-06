"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpRight, RefreshCw } from "lucide-react";

import type {
  PortfolioAttentionItem,
  PortfolioNeedsYouEntry,
} from "@/src/application/portfolio";
import type { PortfolioWorkItem } from "@/src/domain/portfolio";
import type {
  WorkItemAttention,
  WorkItemAttentionKind,
} from "@/src/domain/work-item";
import {
  BOARD_VIEW_STORAGE_KEY,
  connectedPermissionInboxForItem,
  createDefaultBoardView,
  isBoardSourceVisible,
  parseBoardView,
  type BoardView,
} from "@/src/presentation/board";

import { WorkspaceRail } from "../workspace-rail";

interface AttentionResponse {
  items: PortfolioNeedsYouEntry[];
  error?: {
    message?: string;
  };
}

interface AttentionDecisionListProps {
  items: PortfolioNeedsYouEntry[];
  totalCount: number;
}

const ATTENTION_LABELS: Record<WorkItemAttentionKind, string> = {
  spec_approval: "Spec approval",
  plan_approval: "Plan approval",
  patch_plan_approval: "Patch approval",
  unresolved_finding: "Unresolved finding",
  ambiguous_goal: "Goal clarification",
  cycle_limit: "Cycle limit",
  missing_permission: "Permission required",
  command_authorization: "Command approval",
  review_ready: "Review ready",
};

function formatElapsed(elapsedMs: number | undefined): string {
  if (elapsedMs === undefined) {
    return "Not available";
  }
  if (elapsedMs < 1_000) {
    return `${elapsedMs} ms`;
  }
  if (elapsedMs < 60_000) {
    return `${Math.round(elapsedMs / 1_000)} sec`;
  }
  const minutes = Math.floor(elapsedMs / 60_000);
  const seconds = Math.round((elapsedMs % 60_000) / 1_000);
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} sec`;
}

function boardHref(item: PortfolioWorkItem): string {
  const search = new URLSearchParams({
    source: item.source_id,
    item: item.work_item.goal.work_item_id,
  });
  return `/?${search.toString()}`;
}

function workItemForEntry(entry: PortfolioNeedsYouEntry): PortfolioWorkItem {
  return entry.kind === "governed" ? entry.entry.item : entry.item;
}

function statusLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function connectedCapabilityLabel(
  permission: Extract<WorkItemAttention, { kind: "missing_permission" }>,
): string {
  const operation = permission.operation.normalized_operation;
  switch (operation.kind) {
    case "command":
      return `Command · ${[operation.executable, ...operation.args].join(" ")}`;
    case "url":
      return `URL · ${operation.method} ${operation.protocol}://${operation.host}${operation.path}`;
    case "workspace_write":
      return `Workspace write · ${operation.path}`;
    case "outside_workspace_write":
      return `Outside-workspace write · ${operation.path}`;
    case "mcp":
      return `MCP change · ${operation.server}`;
    case "credential":
      return `Credential access · ${operation.source}`;
  }
}

function ConnectedPermissionRecovery({
  permission,
}: {
  permission: Extract<WorkItemAttention, { kind: "missing_permission" }>;
}) {
  return (
    <section
      aria-label="Connected permission recovery"
      className="mt-4 border-l-2 border-warning bg-background px-4 py-3"
    >
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div>
          <h3 className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
            Requested capability
          </h3>
          <p className="mt-1 break-words text-sm leading-6">
            {connectedCapabilityLabel(permission)}
          </p>
        </div>
        <div>
          <h3 className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
            Reason
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {permission.operation.reason}
          </p>
        </div>
      </div>

      <p className="mt-3 break-all border-t pt-3 text-[11px] text-muted-foreground">
        Exact operation hash · {permission.operation.operation_sha256}
      </p>

      <div className="mt-3 border-t pt-3">
        <h3 className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
          Recovery actions
        </h3>
        <ul className="mt-2 space-y-1.5 text-xs leading-5">
          <li>Allow once and retry</li>
          <li>Keep denied</li>
        </ul>
        <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
          Choose the exact action from the work item details; this Inbox does not authorize operations.
        </p>
      </div>
    </section>
  );
}

function EvidencePaths({ item }: { item: PortfolioAttentionItem }) {
  const { pins } = item.attention;

  return (
    <div className="grid gap-3 border-t pt-4 text-xs lg:grid-cols-2">
      <div>
        <h3 className="font-medium">Exact artifacts</h3>
        <ul className="mt-2 space-y-1.5 text-muted-foreground">
          {pins.artifact_paths.map((path) => (
            <li key={path} className="break-all leading-5" title={path}>
              {path}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="font-medium">Evidence</h3>
        {pins.evidence_paths.length > 0 ? (
          <ul className="mt-2 space-y-1.5 text-muted-foreground">
            {pins.evidence_paths.map((path) => (
              <li key={path} className="break-all leading-5" title={path}>
                {path}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-muted-foreground">No evidence path yet</p>
        )}
      </div>
      <dl className="grid gap-2 text-[11px] text-muted-foreground lg:col-span-2 lg:grid-cols-3">
        <div>
          <dt>Commit</dt>
          <dd className="mt-0.5 break-all text-foreground">
            {pins.git_commit ?? "Not applicable"}
          </dd>
        </div>
        <div>
          <dt>Mission hash</dt>
          <dd className="mt-0.5 break-all text-foreground">
            {pins.mission_content_sha256 ?? "Not applicable"}
          </dd>
        </div>
        <div>
          <dt>Result hash</dt>
          <dd className="mt-0.5 break-all text-foreground">
            {pins.result_content_sha256 ?? "Not applicable"}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function AttentionDecision({ item }: { item: PortfolioAttentionItem }) {
  const { goal, state } = item.item.work_item;
  const { attention } = item;
  const connectedPermission = connectedPermissionInboxForItem(item.item);
  const recoveryLink = connectedPermission.mode === "active";

  return (
    <article className="py-6 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-5">
        <div className="min-w-0">
          <p className="text-[11px] font-medium tracking-[0.06em] text-warning uppercase">
            {ATTENTION_LABELS[attention.kind]}
          </p>
          <h2 className="mt-1 text-base font-semibold tracking-[-0.005em]">
            {goal.title}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {item.item.project?.product_name ?? "Unassigned"} · {item.item.source_id}
          </p>
        </div>
        <Link
          href={boardHref(item.item)}
          className="flex h-9 shrink-0 items-center gap-2 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {recoveryLink ? "Open recovery" : "Open on board"}
          <ArrowUpRight className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
        </Link>
      </div>

      <div className="mt-4 grid gap-3 border-l-2 border-warning bg-background px-4 py-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div>
          <h3 className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
            Decision
          </h3>
          <p className="mt-1 text-sm leading-6">{attention.question}</p>
        </div>
        <div>
          <h3 className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
            Why now
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {attention.recommendation}
          </p>
        </div>
      </div>

      {connectedPermission.mode === "active" ? (
        <ConnectedPermissionRecovery
          permission={connectedPermission.permission}
        />
      ) : null}

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-y py-4 text-xs sm:grid-cols-3 lg:grid-cols-6">
        <div>
          <dt className="text-muted-foreground">Work item</dt>
          <dd className="mt-0.5 break-all">{goal.work_item_id}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Goal / input</dt>
          <dd className="mt-0.5">
            v{attention.governed_tuple.goal_version} / r
            {attention.governed_tuple.input_revision}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Attempt</dt>
          <dd className="mt-0.5">{attention.governed_tuple.attempt}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Patch cycle</dt>
          <dd className="mt-0.5">
            {attention.governed_tuple.patch_cycle} of {item.patch_cycle_limit}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Elapsed</dt>
          <dd className="mt-0.5">{formatElapsed(item.elapsed_ms)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Cost/capacity</dt>
          <dd className="mt-0.5">{item.cost_capacity}</dd>
        </div>
      </dl>

      <div className="mt-4 grid gap-5 lg:grid-cols-3">
        <section aria-label="Acceptance criteria">
          <h3 className="text-xs font-medium">Acceptance criteria</h3>
          <ul className="mt-2 space-y-2 text-xs">
            {item.acceptance_criteria.map((criterion) => (
              <li key={criterion.criterion} className="leading-5">
                <span className="text-muted-foreground capitalize">
                  {statusLabel(criterion.status)} ·
                </span>{" "}
                {criterion.criterion}
              </li>
            ))}
          </ul>
        </section>

        <section aria-label="Verification summary">
          <h3 className="text-xs font-medium">Verification</h3>
          <p className="mt-2 text-xs capitalize">
            {item.verification.status}
          </p>
          {item.verification.commands.length > 0 ? (
            <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
              {item.verification.commands.map((command) => (
                <li key={command.name}>
                  {command.name} · {command.status}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              No authoritative command evidence yet
            </p>
          )}
        </section>

        <section aria-label="Current findings">
          <h3 className="text-xs font-medium">Current findings</h3>
          {item.findings.length > 0 ? (
            <ul className="mt-2 space-y-2 text-xs">
              {item.findings.map((finding) => (
                <li key={finding.finding_id} className="leading-5">
                  <span className="font-medium">{finding.severity}</span> · {finding.title}
                  <span className="block text-muted-foreground">
                    {finding.required_action}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              No current or residual findings
            </p>
          )}
        </section>
      </div>

      <EvidencePaths item={item} />
      <p className="mt-3 text-[11px] text-muted-foreground">
        State · {state.phase}/{state.status} · requested {attention.created_at}
      </p>
    </article>
  );
}

function ShapingAttentionDecision({
  entry,
}: {
  entry: Extract<PortfolioNeedsYouEntry, { kind: "shaping" }>;
}) {
  const { goal, state } = entry.item.work_item;
  const attention = entry.shaping_attention;

  return (
    <article className="py-6 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-5">
        <div className="min-w-0">
          <p className="text-[11px] font-medium tracking-[0.06em] text-warning uppercase">
            Spec approval
          </p>
          <h2 className="mt-1 text-base font-semibold tracking-[-0.005em]">
            {goal.title}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {entry.item.project?.product_name ?? "Unassigned"} · {entry.item.source_id}
          </p>
        </div>
        <Link
          href={boardHref(entry.item)}
          className="flex h-9 shrink-0 items-center gap-2 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          Open on board
          <ArrowUpRight className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
        </Link>
      </div>

      <div className="mt-4 grid gap-3 border-l-2 border-warning bg-background px-4 py-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div>
          <h3 className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
            Decision
          </h3>
          <p className="mt-1 text-sm leading-6">{attention.question}</p>
        </div>
        <div>
          <h3 className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
            Why now
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {attention.recommendation}
          </p>
        </div>
      </div>

      <dl className="mt-4 grid gap-3 border-y py-4 text-xs lg:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Mission hash</dt>
          <dd className="mt-0.5 break-all">
            {attention.binding.mission_content_sha256}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Applied result hash</dt>
          <dd className="mt-0.5 break-all">
            {attention.binding.applied_result_content_sha256}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Shaping state hash</dt>
          <dd className="mt-0.5 break-all">
            {attention.binding.shaping_state_sha256}
          </dd>
        </div>
      </dl>

      <div className="mt-4 border-t pt-4 text-xs">
        <h3 className="font-medium">Exact artifacts</h3>
        <ul className="mt-2 space-y-1.5 text-muted-foreground">
          {attention.pins.artifact_paths.map((path) => (
            <li key={path} className="break-all leading-5" title={path}>
              {path}
            </li>
          ))}
        </ul>
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">
        State · {state.phase}/{state.status} · result committed {attention.created_at}
      </p>
    </article>
  );
}

export function AttentionDecisionList({
  items,
  totalCount,
}: AttentionDecisionListProps) {
  if (totalCount === 0) {
    return (
      <section className="border-y py-16 text-center">
        <h2 className="text-base font-semibold">You’re all caught up</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          No work item currently needs a human decision.
        </p>
      </section>
    );
  }

  if (items.length === 0) {
    return (
      <section className="border-y py-16 text-center">
        <h2 className="text-base font-semibold">No decisions in this scope</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The current board project filter hides {totalCount} pending decision
          {totalCount === 1 ? "" : "s"}.
        </p>
      </section>
    );
  }

  return (
    <section className="divide-y" aria-label="Current attention decisions">
      {items.map((entry) => {
        const item = workItemForEntry(entry);
        const key = `${item.source_id}:${item.work_item.goal.work_item_id}`;
        return entry.kind === "governed" ? (
          <AttentionDecision key={key} item={entry.entry} />
        ) : (
          <ShapingAttentionDecision key={key} entry={entry} />
        );
      })}
    </section>
  );
}

export function AttentionInbox() {
  const [items, setItems] = useState<PortfolioNeedsYouEntry[]>([]);
  const [view, setView] = useState<BoardView>(createDefaultBoardView);
  const [scopeReady, setScopeReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAttention = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/portfolio/attention", {
        cache: "no-store",
      });
      const body = (await response.json()) as AttentionResponse;
      if (!response.ok) {
        throw new Error(body.error?.message ?? "Unable to load attention");
      }
      setItems(body.items);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load attention",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setView(parseBoardView(localStorage.getItem(BOARD_VIEW_STORAGE_KEY)));
      setScopeReady(true);
      void loadAttention();
    });
    return () => cancelAnimationFrame(frame);
  }, [loadAttention]);

  const visibleItems = useMemo(
    () =>
      items.filter((entry) =>
        isBoardSourceVisible(workItemForEntry(entry), view),
      ),
    [items, view],
  );

  return (
    <main className="flex h-dvh min-h-[560px] overflow-hidden bg-background text-foreground">
      <WorkspaceRail current="inbox" />
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-4 border-b px-5">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold tracking-[-0.005em]">
              Needs you
            </h1>
            <p className="text-xs text-muted-foreground">
              Attention inbox · {scopeReady ? visibleItems.length : "—"} in current board scope
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadAttention()}
            disabled={loading}
            className="ml-auto grid size-9 place-items-center rounded-md border bg-secondary text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50"
            aria-label="Refresh attention inbox"
          >
            <span className={loading ? "animate-spin" : ""}>
              <RefreshCw className="size-4" strokeWidth={1.75} />
            </span>
          </button>
        </header>

        {error !== null ? (
          <div
            className="flex min-h-10 items-center justify-between border-b border-destructive/40 bg-destructive/10 px-5 text-xs"
            role="alert"
          >
            <span>Attention unavailable · {error}</span>
            <button
              type="button"
              onClick={() => void loadAttention()}
              className="font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary"
            >
              Try again
            </button>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto px-5 py-6" aria-busy={loading}>
          <div className="mx-auto max-w-6xl">
            <div className="mb-5 flex items-end justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold">Current decisions</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  One current decision per source-qualified work item.
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                {items.length} total
              </p>
            </div>

            {loading && items.length === 0 ? (
              <p className="border-y py-16 text-center text-sm text-muted-foreground" role="status">
                Loading current decisions…
              </p>
            ) : error !== null && items.length === 0 ? null : (
              <AttentionDecisionList
                items={scopeReady ? visibleItems : []}
                totalCount={items.length}
              />
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
