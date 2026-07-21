"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FolderKanban,
  LayoutGrid,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";

import type {
  PortfolioWorkItem,
  RegisteredWorkspace,
} from "@/src/domain/portfolio";
import {
  BOARD_COLUMNS,
  BOARD_VIEW_STORAGE_KEY,
  boardColumnForPhase,
  createDefaultBoardView,
  isBoardSourceVisible,
  parseBoardView,
  type BoardItemIdentity,
  type BoardView,
} from "@/src/presentation/board";

import { BoardCard } from "./board-card";

interface WorkspacesResponse {
  workspaces: RegisteredWorkspace[];
}

interface WorkItemsResponse {
  items: PortfolioWorkItem[];
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

function scopeLabel(view: BoardView, workspaces: RegisteredWorkspace[]): string {
  if (view.project_source_ids === null) {
    return view.include_unassigned ? "All work" : "All projects";
  }

  if (view.project_source_ids.length === 0) {
    return view.include_unassigned ? "Unassigned" : "No projects";
  }

  if (view.project_source_ids.length === 1 && !view.include_unassigned) {
    return (
      workspaces.find(
        (workspace) => workspace.workspace_id === view.project_source_ids?.[0],
      )?.product_name ?? "1 project"
    );
  }

  const sourceCount =
    view.project_source_ids.length + (view.include_unassigned ? 1 : 0);
  return `${sourceCount} sources`;
}

export function KanbanBoard() {
  const [items, setItems] = useState<PortfolioWorkItem[]>([]);
  const [workspaces, setWorkspaces] = useState<RegisteredWorkspace[]>([]);
  const [view, setView] = useState<BoardView>(createDefaultBoardView);
  const [viewReady, setViewReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const boardViewportRef = useRef<HTMLDivElement>(null);
  const restoredScrollRef = useRef(false);

  const loadPortfolio = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [workspacesResponse, itemsResponse] = await Promise.all([
        fetch("/api/workspaces", { cache: "no-store" }),
        fetch("/api/work-items", { cache: "no-store" }),
      ]);
      const [workspaceData, itemData] = await Promise.all([
        readJson<WorkspacesResponse>(workspacesResponse),
        readJson<WorkItemsResponse>(itemsResponse),
      ]);
      setWorkspaces(workspaceData.workspaces);
      setItems(itemData.items);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load the portfolio",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setView(parseBoardView(localStorage.getItem(BOARD_VIEW_STORAGE_KEY)));
      setViewReady(true);
    });

    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => void loadPortfolio());
    return () => cancelAnimationFrame(frame);
  }, [loadPortfolio]);

  useEffect(() => {
    if (!viewReady) {
      return;
    }
    localStorage.setItem(BOARD_VIEW_STORAGE_KEY, JSON.stringify(view));
  }, [view, viewReady]);

  useEffect(() => {
    if (
      !viewReady ||
      loading ||
      restoredScrollRef.current ||
      boardViewportRef.current === null
    ) {
      return;
    }

    boardViewportRef.current.scrollTo({
      left: view.scroll.x,
      top: view.scroll.y,
    });
    restoredScrollRef.current = true;
  }, [loading, view.scroll.x, view.scroll.y, viewReady]);

  const visibleItems = useMemo(
    () => items.filter((item) => isBoardSourceVisible(item, view)),
    [items, view],
  );

  const itemsByColumn = useMemo(() => {
    const grouped = new Map<string, PortfolioWorkItem[]>();
    for (const column of BOARD_COLUMNS) {
      grouped.set(column.id, []);
    }
    for (const item of visibleItems) {
      grouped.get(boardColumnForPhase(item.work_item.state.phase).id)?.push(item);
    }
    return grouped;
  }, [visibleItems]);

  function setSelectedItem(identity: BoardItemIdentity): void {
    setView((current) => ({
      ...current,
      selected_item:
        current.selected_item?.source_id === identity.source_id &&
        current.selected_item.work_item_id === identity.work_item_id
          ? null
          : identity,
    }));
  }

  function toggleProject(workspaceId: string): void {
    setView((current) => {
      const selected =
        current.project_source_ids ??
        workspaces.map((workspace) => workspace.workspace_id);
      const next = selected.includes(workspaceId)
        ? selected.filter((sourceId) => sourceId !== workspaceId)
        : [...selected, workspaceId];
      return { ...current, project_source_ids: next };
    });
  }

  return (
    <main className="flex h-dvh min-h-[560px] overflow-hidden bg-background text-foreground">
      <aside className="flex w-[58px] shrink-0 flex-col items-center border-r bg-sidebar py-3">
        <div
          className="grid size-9 place-items-center rounded-md bg-primary text-xs font-semibold text-primary-foreground"
          aria-label="Product Studio"
        >
          PS
        </div>
        <nav className="mt-5 flex flex-col gap-2" aria-label="Workspace">
          <button
            type="button"
            className="grid size-10 place-items-center rounded-md bg-accent text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="All work"
            aria-current="page"
          >
            <LayoutGrid className="size-5" strokeWidth={1.75} />
          </button>
          <span
            className="grid size-10 place-items-center text-muted-foreground"
            aria-hidden="true"
          >
            <FolderKanban className="size-5" strokeWidth={1.75} />
          </span>
        </nav>
        <span className="mt-auto size-1.5 rounded-full bg-success" aria-hidden="true" />
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-4 border-b px-5">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold tracking-[-0.005em]">
              {scopeLabel(view, workspaces)}
            </h1>
            <p className="text-xs text-muted-foreground">
              Portfolio board · {visibleItems.length} visible
            </p>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <details className="group relative">
              <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
                <SlidersHorizontal className="size-4" strokeWidth={1.75} />
                Projects
              </summary>
              <div className="absolute top-11 right-0 z-20 w-64 rounded-md border bg-popover p-2 text-sm">
                <label className="flex min-h-9 cursor-pointer items-center gap-3 rounded-sm px-2 hover:bg-accent">
                  <input
                    type="checkbox"
                    checked={view.project_source_ids === null}
                    onChange={(event) =>
                      setView((current) => ({
                        ...current,
                        project_source_ids: event.target.checked ? null : [],
                      }))
                    }
                    className="size-4 accent-[var(--primary)]"
                  />
                  <span>All projects</span>
                </label>

                <div className="my-1 border-t" />
                {workspaces.map((workspace) => (
                  <label
                    key={workspace.workspace_id}
                    className="flex min-h-9 cursor-pointer items-center gap-3 rounded-sm px-2 hover:bg-accent"
                  >
                    <input
                      type="checkbox"
                      checked={
                        view.project_source_ids === null ||
                        view.project_source_ids.includes(workspace.workspace_id)
                      }
                      onChange={() => toggleProject(workspace.workspace_id)}
                      className="size-4 accent-[var(--primary)]"
                    />
                    <span className="truncate">{workspace.product_name}</span>
                  </label>
                ))}

                <div className="my-1 border-t" />
                <label className="flex min-h-9 cursor-pointer items-center gap-3 rounded-sm px-2 hover:bg-accent">
                  <input
                    type="checkbox"
                    checked={view.include_unassigned}
                    onChange={(event) =>
                      setView((current) => ({
                        ...current,
                        include_unassigned: event.target.checked,
                      }))
                    }
                    className="size-4 accent-[var(--primary)]"
                  />
                  <span>Unassigned</span>
                </label>
              </div>
            </details>

            <button
              type="button"
              onClick={() => void loadPortfolio()}
              disabled={loading}
              className="grid size-9 place-items-center rounded-md border bg-secondary text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50"
              aria-label="Refresh portfolio"
            >
              <RefreshCw
                className={`size-4 ${loading ? "animate-spin" : ""}`}
                strokeWidth={1.75}
              />
            </button>
          </div>
        </header>

        {error ? (
          <div
            className="flex min-h-10 items-center justify-between border-b border-destructive/40 bg-destructive/10 px-5 text-xs text-foreground"
            role="alert"
          >
            <span>Portfolio unavailable · {error}</span>
            <button
              type="button"
              onClick={() => void loadPortfolio()}
              className="font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary"
            >
              Try again
            </button>
          </div>
        ) : null}

        <div
          ref={boardViewportRef}
          onScroll={(event) => {
            const viewport = event.currentTarget;
            setView((current) => ({
              ...current,
              scroll: { x: viewport.scrollLeft, y: viewport.scrollTop },
            }));
          }}
          className="min-h-0 flex-1 overflow-auto [scrollbar-color:#3a404d_transparent]"
          aria-busy={loading}
        >
          <div className="grid min-h-full min-w-[1616px] grid-cols-[repeat(7,minmax(224px,1fr))] divide-x">
            {BOARD_COLUMNS.map((column) => {
              const columnItems = itemsByColumn.get(column.id) ?? [];
              return (
                <section
                  key={column.id}
                  aria-labelledby={`column-${column.id}`}
                  className="min-w-0 px-2 pb-6"
                >
                  <header className="sticky top-0 z-10 flex h-12 items-center justify-between bg-background px-1">
                    <h2
                      id={`column-${column.id}`}
                      className="text-xs font-semibold tracking-[0.06em] text-muted-foreground uppercase"
                    >
                      {column.label}
                    </h2>
                    <span className="min-w-5 rounded-full bg-secondary px-1.5 py-0.5 text-center text-[11px] text-muted-foreground">
                      {columnItems.length}
                    </span>
                  </header>

                  <div className="space-y-2" role="list">
                    {columnItems.map((item) => (
                      <div
                        key={`${item.source_id}:${item.work_item.goal.work_item_id}`}
                        role="listitem"
                      >
                        <BoardCard
                          item={item}
                          selectedIdentity={view.selected_item}
                          onSelect={setSelectedItem}
                        />
                      </div>
                    ))}
                    {!loading && columnItems.length === 0 ? (
                      <p className="px-2 py-3 text-xs text-[#7f8794]">No work</p>
                    ) : null}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      </section>
    </main>
  );
}
