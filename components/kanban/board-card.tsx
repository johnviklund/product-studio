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

export function BoardCard({
  item,
  selectedIdentity,
  onSelect,
}: BoardCardProps) {
  const identity = {
    source_id: item.source_id,
    work_item_id: item.work_item.goal.work_item_id,
  };
  const selected =
    selectedIdentity !== null &&
    boardItemIdentityKey(selectedIdentity) === boardItemIdentityKey(identity);
  const { goal, state } = item.work_item;

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(identity)}
      className={`group w-full rounded-md border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
        selected
          ? "border-primary bg-[#111c34]"
          : "border-transparent bg-card hover:border-[#3a404d] hover:bg-accent"
      }`}
    >
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

      <span className="mt-3 flex items-center justify-between gap-3 border-t pt-2.5">
        <span className="flex min-w-0 items-center gap-2 text-xs text-foreground">
          <span
            className={`size-1.5 shrink-0 rounded-full ${statusDotClass(state.status)}`}
            aria-hidden="true"
          />
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

      <span className="sr-only">
        Phase {state.phase}. Status {state.status}.
      </span>
    </button>
  );
}
