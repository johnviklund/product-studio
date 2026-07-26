"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  Plus,
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
  boardItemIdentityKey,
  boardColumnForPhase,
  createDefaultBoardView,
  isBoardSourceVisible,
  parseBoardItemIdentityKey,
  parseBoardView,
  revealBoardItem,
  resolveBoardDrop,
  type BoardColumnId,
  type BoardItemIdentity,
  type BoardView,
} from "@/src/presentation/board";

import { BoardCardPreview } from "./board-card";
import { CapturePanel } from "./capture-panel";
import { DetailPanel } from "./detail-panel";
import { KanbanColumn } from "./kanban-column";
import { WorkspaceRail } from "../workspace-rail";

interface WorkspacesResponse {
  workspaces: RegisteredWorkspace[];
}

interface WorkItemsResponse {
  items: PortfolioWorkItem[];
}

interface ErrorResponse {
  error?: {
    message?: string;
  };
}

interface TransitionMessage {
  kind: "success" | "error";
  text: string;
}

type PanelState =
  | { kind: "capture" }
  | { kind: "detail"; identity: BoardItemIdentity }
  | null;

function loadBoardView(): BoardView {
  try {
    return parseBoardView(localStorage.getItem(BOARD_VIEW_STORAGE_KEY));
  } catch {
    return createDefaultBoardView();
  }
}

function saveBoardView(view: BoardView): void {
  try {
    localStorage.setItem(BOARD_VIEW_STORAGE_KEY, JSON.stringify(view));
  } catch {
    // Browser-local view state is optional and never workflow truth.
  }
}

function isBoardColumnId(value: string): value is BoardColumnId {
  return BOARD_COLUMNS.some((column) => column.id === value);
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

function identityForItem(item: PortfolioWorkItem): BoardItemIdentity {
  return {
    source_id: item.source_id,
    work_item_id: item.work_item.goal.work_item_id,
  };
}

function linkedBoardIdentity(): BoardItemIdentity | null {
  const search = new URLSearchParams(window.location.search);
  const sourceId = search.get("source");
  const workItemId = search.get("item");
  if (sourceId === null || workItemId === null) {
    return null;
  }
  return parseBoardItemIdentityKey(JSON.stringify([sourceId, workItemId]));
}

export function KanbanBoard() {
  const [items, setItems] = useState<PortfolioWorkItem[]>([]);
  const [workspaces, setWorkspaces] = useState<RegisteredWorkspace[]>([]);
  const [view, setView] = useState<BoardView>(createDefaultBoardView);
  const [viewReady, setViewReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeItem, setActiveItem] = useState<PortfolioWorkItem | null>(null);
  const [pendingItemKey, setPendingItemKey] = useState<string | null>(null);
  const [transitionMessage, setTransitionMessage] =
    useState<TransitionMessage | null>(null);
  const [panel, setPanel] = useState<PanelState>(null);
  const boardViewportRef = useRef<HTMLDivElement>(null);
  const restoredScrollRef = useRef(false);
  const linkedItemHandledRef = useRef(false);
  const scrollPositionRef = useRef(view.scroll);
  const scrollSaveFrameRef = useRef<number | null>(null);
  const viewRef = useRef(view);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  const openCapturePanel = useCallback(() => {
    setPanel((current) => current ?? { kind: "capture" });
    setTransitionMessage(null);
  }, []);

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
      if (!linkedItemHandledRef.current) {
        const identity = linkedBoardIdentity();
        linkedItemHandledRef.current = true;
        if (identity !== null) {
          const linkedItem = itemData.items.find(
            (item) =>
              boardItemIdentityKey(identityForItem(item)) ===
              boardItemIdentityKey(identity),
          );
          if (linkedItem === undefined) {
            setTransitionMessage({
              kind: "error",
              text: "The linked work item is not available in this portfolio.",
            });
          } else {
            setView((current) =>
              revealBoardItem(current, {
                ...identity,
                project: linkedItem.project,
              }),
            );
            setPanel({ kind: "detail", identity });
          }
        }
      }
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
    viewRef.current = view;
  }, [view]);

  useEffect(
    () => () => {
      if (scrollSaveFrameRef.current !== null) {
        cancelAnimationFrame(scrollSaveFrameRef.current);
      }
      saveBoardView({
        ...viewRef.current,
        scroll: scrollPositionRef.current,
      });
    },
    [],
  );

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const storedView = loadBoardView();
      scrollPositionRef.current = storedView.scroll;
      setView(storedView);
      setViewReady(true);
    });

    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => void loadPortfolio());
    return () => cancelAnimationFrame(frame);
  }, [loadPortfolio]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        !event.defaultPrevented &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "n"
      ) {
        event.preventDefault();
        openCapturePanel();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [openCapturePanel]);

  useEffect(() => {
    if (!viewReady) {
      return;
    }
    saveBoardView({ ...view, scroll: scrollPositionRef.current });
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

  const itemsByIdentity = useMemo(() => {
    const mapped = new Map<string, PortfolioWorkItem>();
    for (const item of items) {
      mapped.set(
        boardItemIdentityKey({
          source_id: item.source_id,
          work_item_id: item.work_item.goal.work_item_id,
        }),
        item,
      );
    }
    return mapped;
  }, [items]);
  const detailItem =
    panel?.kind === "detail"
      ? itemsByIdentity.get(boardItemIdentityKey(panel.identity)) ?? null
      : null;

  function handleSelectItem(identity: BoardItemIdentity): void {
    setView((current) => ({ ...current, selected_item: identity }));
    setPanel({ kind: "detail", identity });
  }

  function focusBoardItem(identity: BoardItemIdentity): void {
    const itemKey = boardItemIdentityKey(identity);
    requestAnimationFrame(() => {
      for (const target of document.querySelectorAll<HTMLButtonElement>(
        "[data-board-item-key]",
      )) {
        if (target.dataset.boardItemKey === itemKey) {
          target.focus();
          return;
        }
      }
    });
  }

  function handleMoveFocus(identity: BoardItemIdentity): void {
    if (panel !== null) {
      return;
    }
    setView((current) => ({ ...current, selected_item: identity }));
    focusBoardItem(identity);
  }

  function closeDetailPanel(identity: BoardItemIdentity): void {
    setPanel(null);
    focusBoardItem(identity);
  }

  function handleCaptureCreated(item: PortfolioWorkItem): void {
    const itemKey = boardItemIdentityKey(identityForItem(item));
    setItems((current) => [
      item,
      ...current.filter(
        (candidate) =>
          boardItemIdentityKey(identityForItem(candidate)) !== itemKey,
      ),
    ]);
    setView((current) =>
      revealBoardItem(current, {
        ...identityForItem(item),
        project: item.project,
      }),
    );
    setPanel(null);
    setTransitionMessage({
      kind: "success",
      text: `Captured in ${item.project?.product_name ?? "Unassigned"}.`,
    });
  }

  function handleCaptureUpdated(
    item: PortfolioWorkItem,
    message = "Capture details saved.",
  ): void {
    const itemKey = boardItemIdentityKey(identityForItem(item));
    setItems((current) =>
      current.map((candidate) =>
        boardItemIdentityKey(identityForItem(candidate)) === itemKey
          ? item
          : candidate,
      ),
    );
    setTransitionMessage({ kind: "success", text: message });
  }

  function handleCaptureAssigned(
    previous: PortfolioWorkItem,
    item: PortfolioWorkItem,
  ): void {
    const previousKey = boardItemIdentityKey(identityForItem(previous));
    const itemKey = boardItemIdentityKey(identityForItem(item));
    setItems((current) => [
      item,
      ...current.filter((candidate) => {
        const candidateKey = boardItemIdentityKey(identityForItem(candidate));
        return candidateKey !== previousKey && candidateKey !== itemKey;
      }),
    ]);
    setView((current) =>
      revealBoardItem(current, {
        ...identityForItem(item),
        project: item.project,
      }),
    );
    setPanel({ kind: "detail", identity: identityForItem(item) });
    setTransitionMessage({
      kind: "success",
      text: `Assigned to ${item.project?.product_name ?? "Unassigned"}.`,
    });
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

  function handleDragStart(event: DragStartEvent): void {
    setTransitionMessage(null);
    setActiveItem(itemsByIdentity.get(String(event.active.id)) ?? null);
  }

  async function commitTransition(
    item: PortfolioWorkItem,
    targetColumnId: BoardColumnId,
  ): Promise<void> {
    const resolution = resolveBoardDrop(
      item.work_item.state.phase,
      targetColumnId,
    );
    if (!resolution.ok) {
      setTransitionMessage({ kind: "error", text: resolution.reason });
      return;
    }
    if (!resolution.changed) {
      setTransitionMessage({
        kind: "success",
        text: `Already in ${boardColumnForPhase(item.work_item.state.phase).label}.`,
      });
      return;
    }

    const itemKey = boardItemIdentityKey({
      source_id: item.source_id,
      work_item_id: item.work_item.goal.work_item_id,
    });
    setPendingItemKey(itemKey);
    setTransitionMessage(null);

    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(item.work_item.goal.work_item_id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target_phase: resolution.target_phase }),
        },
      );
      const body = (await response.json()) as PortfolioWorkItem & ErrorResponse;
      if (!response.ok) {
        setTransitionMessage({
          kind: "error",
          text: body.error?.message ?? "The move was rejected.",
        });
        return;
      }

      setItems((current) =>
        current.map((candidate) =>
          boardItemIdentityKey({
            source_id: candidate.source_id,
            work_item_id: candidate.work_item.goal.work_item_id,
          }) === itemKey
            ? body
            : candidate,
        ),
      );
      setTransitionMessage({
        kind: "success",
        text: `Moved to ${boardColumnForPhase(body.work_item.state.phase).label}.`,
      });
    } catch {
      setTransitionMessage({
        kind: "error",
        text: "The move could not be confirmed. The board was refreshed.",
      });
      await loadPortfolio();
    } finally {
      setPendingItemKey(null);
    }
  }

  async function handleDragEnd(event: DragEndEvent): Promise<void> {
    setActiveItem(null);

    const item = itemsByIdentity.get(String(event.active.id));
    const targetColumnId = event.over ? String(event.over.id) : null;
    if (!item || targetColumnId === null || !isBoardColumnId(targetColumnId)) {
      return;
    }

    await commitTransition(item, targetColumnId);
  }

  return (
    <main className="flex h-dvh min-h-[560px] overflow-hidden bg-background text-foreground">
      <WorkspaceRail current="board" />

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

          <button
            type="button"
            onClick={openCapturePanel}
            className="ml-auto hidden h-10 min-w-0 max-w-md flex-1 items-center gap-2 rounded-md border bg-muted px-3 text-left text-sm text-muted-foreground transition-colors hover:border-[#3a404d] hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:flex"
          >
            <Plus className="size-4 shrink-0" strokeWidth={1.75} />
            <span className="truncate">Capture an idea or todo…</span>
            <kbd className="ml-auto shrink-0 text-[11px] text-[#7f8794]">⌘N</kbd>
          </button>

          <div className="flex items-center gap-2">
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
              <span className={loading ? "animate-spin" : ""}>
                <RefreshCw className="size-4" strokeWidth={1.75} />
              </span>
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

        {transitionMessage ? (
          <div
            className={`flex min-h-10 items-center border-b px-5 text-xs ${
              transitionMessage.kind === "error"
                ? "border-destructive/40 bg-destructive/10 text-foreground"
                : "bg-success/10 text-foreground"
            }`}
            role={transitionMessage.kind === "error" ? "alert" : "status"}
          >
            {transitionMessage.text}
          </div>
        ) : null}

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragCancel={() => setActiveItem(null)}
          onDragEnd={(event) => void handleDragEnd(event)}
          accessibility={{
            screenReaderInstructions: {
              draggable:
                "Press space to pick up a card, use arrow keys to move it, and press space again to drop.",
            },
          }}
        >
          <div
            ref={boardViewportRef}
            onScroll={(event) => {
              const viewport = event.currentTarget;
              scrollPositionRef.current = {
                x: viewport.scrollLeft,
                y: viewport.scrollTop,
              };
              if (scrollSaveFrameRef.current === null) {
                scrollSaveFrameRef.current = requestAnimationFrame(() => {
                  saveBoardView({
                    ...viewRef.current,
                    scroll: scrollPositionRef.current,
                  });
                  scrollSaveFrameRef.current = null;
                });
              }
            }}
            className="kanban-board-viewport min-h-0 flex-1 overflow-auto"
            aria-busy={loading}
          >
            <div className="grid min-h-full min-w-[1616px] grid-cols-[repeat(7,minmax(224px,1fr))] divide-x">
              {BOARD_COLUMNS.map((column) => (
                <KanbanColumn
                  key={column.id}
                  column={column}
                  items={itemsByColumn.get(column.id) ?? []}
                  loading={loading}
                  pendingItemKey={pendingItemKey}
                  selectedIdentity={view.selected_item}
                  onSelect={handleSelectItem}
                  onMoveFocus={handleMoveFocus}
                  onOpenDetail={handleSelectItem}
                />
              ))}
            </div>
          </div>
          <DragOverlay>
            {activeItem ? <BoardCardPreview item={activeItem} /> : null}
          </DragOverlay>
        </DndContext>
      </section>

      {panel?.kind === "capture" ? (
        <CapturePanel
          workspaces={workspaces}
          onClose={() => setPanel(null)}
          onCreated={handleCaptureCreated}
        />
      ) : null}
      {detailItem ? (
        <DetailPanel
          key={boardItemIdentityKey(identityForItem(detailItem))}
          item={detailItem}
          workspaces={workspaces}
          transitionPending={
            pendingItemKey !== null &&
            pendingItemKey ===
              boardItemIdentityKey(identityForItem(detailItem))
          }
          onClose={() => closeDetailPanel(identityForItem(detailItem))}
          onUpdated={handleCaptureUpdated}
          onAssigned={handleCaptureAssigned}
          onTransition={(item, targetColumnId) => {
            void commitTransition(item, targetColumnId);
          }}
        />
      ) : null}
    </main>
  );
}
