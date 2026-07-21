import { useDraggable } from "@dnd-kit/core";

import type { PortfolioWorkItem } from "@/src/domain/portfolio";
import {
  boardItemIdentityKey,
  nextActionForPhase,
  type BoardItemIdentity,
} from "@/src/presentation/board";

interface BoardCardProps {
  item: PortfolioWorkItem;
  selectedIdentity: BoardItemIdentity | null;
  onSelect: (identity: BoardItemIdentity) => void;
  disabled?: boolean;
}

const updatedAtFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function statusDotClass(
  status: PortfolioWorkItem["work_item"]["state"]["status"],
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

function BoardCardContent({ item }: { item: PortfolioWorkItem }) {
  const { goal, state } = item.work_item;

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
        <span>{goal.type}</span>
      </span>

      <span className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[#9aa2b1] capitalize">
        <span
          className={`size-1.5 shrink-0 rounded-full ${statusDotClass(state.status)}`}
          aria-hidden="true"
        />
        <span>{state.phase}</span>
        <span aria-hidden="true">·</span>
        <span>{state.status}</span>
      </span>

      <span className="mt-3 flex items-center justify-between gap-3 border-t pt-2.5">
        <span className="flex min-w-0 items-center text-xs text-foreground">
          <span className="truncate">{nextActionForPhase(state.phase)}</span>
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

  return (
    <button
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={() => onSelect(identity)}
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

export function BoardCardPreview({ item }: { item: PortfolioWorkItem }) {
  return (
    <div className="kanban-drag-overlay w-[224px] rounded-md border border-[#3a404d] bg-card p-3 text-left">
      <BoardCardContent item={item} />
    </div>
  );
}
