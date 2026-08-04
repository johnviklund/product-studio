import { useCallback, useRef, type KeyboardEvent } from "react";
import { useDraggable } from "@dnd-kit/core";

import type { PortfolioListItem } from "@/src/application/portfolio";
import {
  boardItemIdentityKey,
  nextActionForPhase,
  shapingCardStateForItem,
  type BoardItemIdentity,
} from "@/src/presentation/board";

type BoardCardStateInput = Pick<
  PortfolioListItem["work_item"]["state"],
  "phase" | "status" | "attention"
>;

interface BoardCardProps {
  item: PortfolioListItem;
  selectedIdentity: BoardItemIdentity | null;
  onSelect: (identity: BoardItemIdentity) => void;
  previousIdentity?: BoardItemIdentity;
  nextIdentity?: BoardItemIdentity;
  onMoveFocus?: (identity: BoardItemIdentity) => void;
  onOpenDetail?: (identity: BoardItemIdentity) => void;
  disabled?: boolean;
}

const updatedAtFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function statusDotClass(
  status: PortfolioListItem["work_item"]["state"]["status"],
): string {
  switch (status) {
    case "active":
      return "bg-success";
    case "blocked":
      return "bg-destructive";
    case "paused":
      return "bg-[#e4b93f]";
    case "cancelled":
      return "bg-[#7f8794]";
  }
}

export function nextActionForCardState(
  input:
    | PortfolioListItem
    | BoardCardStateInput,
): string {
  const item = "work_item" in input ? input : null;
  const state: BoardCardStateInput =
    "work_item" in input ? input.work_item.state : input;
  const shapingState = item === null ? null : shapingCardStateForItem(item);
  if (shapingState !== null) {
    return shapingState.next_action_label;
  }
  const phaseFallback =
    state.phase === "plan"
      ? "Review the plan result"
      : nextActionForPhase(state.phase);
  if (state.status !== "active") {
    return phaseFallback;
  }
  if (state.phase === "patch") {
    return "Compile or import the patch";
  }

  switch (state.attention?.kind) {
    case "patch_plan_approval":
      return "Approve the patch plan";
    case "unresolved_finding":
    case "ambiguous_goal":
    case "cycle_limit":
      return "Resolve the escalation";
    case "review_ready":
      return "Review the result";
    default:
      return phaseFallback;
  }
}

function BoardCardContent({ item }: { item: PortfolioListItem }) {
  const { goal, state } = item.work_item;
  const shapingState = shapingCardStateForItem(item);

  return (
    <>
      <span className="line-clamp-2 text-sm leading-5 font-semibold tracking-[-0.005em] text-card-foreground">
        {goal.title}
      </span>

      <span className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="truncate">
          {item.project?.product_name ?? "Unassigned"}
        </span>
        <span aria-hidden="true">·</span>
        <span>{goal.type ?? "Unclassified"}</span>
      </span>

      <span className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[#9aa2b1] capitalize">
        <span
          className={`size-1.5 shrink-0 rounded-full ${statusDotClass(state.status)}`}
          aria-hidden="true"
        />
        <span>{shapingState?.badge ?? state.phase}</span>
        {shapingState === null ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{state.status}</span>
          </>
        ) : null}
      </span>

      <span className="mt-3 flex items-center justify-between gap-3 border-t pt-2.5">
        <span className="flex min-w-0 items-center text-xs text-foreground">
          <span className="truncate">{nextActionForCardState(item)}</span>
        </span>
        <time
          dateTime={state.updated_at}
          className="shrink-0 text-[11px] text-[#7f8794]"
          title={state.updated_at}
        >
          {updatedAtFormatter.format(new Date(state.updated_at))}
        </time>
      </span>
    </>
  );
}

export function BoardCard({
  item,
  selectedIdentity,
  onSelect,
  previousIdentity,
  nextIdentity,
  onMoveFocus,
  onOpenDetail,
  disabled = false,
}: BoardCardProps) {
  const identity = {
    source_id: item.source_id,
    work_item_id: item.work_item.goal.work_item_id,
  };
  const selected =
    selectedIdentity !== null &&
    boardItemIdentityKey(selectedIdentity) === boardItemIdentityKey(identity);
  const { attributes, isDragging, listeners, setNodeRef } = useDraggable({
    id: boardItemIdentityKey(identity),
    data: { item },
    disabled,
  });
  const focusTargetRef = useRef<HTMLButtonElement>(null);
  const setRefs = useCallback(
    (node: HTMLButtonElement | null) => {
      setNodeRef(node);
      focusTargetRef.current = node;
    },
    [setNodeRef],
  );
  const { onKeyDown: onDragKeyDown, ...dragListeners } = listeners ?? {};

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    onDragKeyDown?.(event);
    if (event.defaultPrevented || isDragging || focusTargetRef.current === null) {
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (previousIdentity) {
        onMoveFocus?.(previousIdentity);
      }
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (nextIdentity) {
        onMoveFocus?.(nextIdentity);
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      onOpenDetail?.(identity);
    }
  }

  return (
    <button
      ref={setRefs}
      {...attributes}
      {...dragListeners}
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={() => onSelect(identity)}
      onKeyDown={handleKeyDown}
      data-board-item-key={boardItemIdentityKey(identity)}
      className={`group w-full touch-none rounded-md border p-3 text-left transition-[border-color,background-color,opacity] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-wait ${
        selected
          ? "border-primary bg-[#111c34]"
          : "border-transparent bg-card hover:border-[#3a404d] hover:bg-accent"
      } ${isDragging ? "cursor-grabbing opacity-30" : "cursor-grab"}`}
    >
      <BoardCardContent item={item} />
    </button>
  );
}

export function BoardCardPreview({ item }: { item: PortfolioListItem }) {
  return (
    <div className="kanban-drag-overlay w-[224px] rounded-md border border-[#3a404d] bg-card p-3 text-left">
      <BoardCardContent item={item} />
    </div>
  );
}
