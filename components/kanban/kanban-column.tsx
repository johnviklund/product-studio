import { useDroppable } from "@dnd-kit/core";

import type { PortfolioWorkItem } from "@/src/domain/portfolio";
import {
  boardItemIdentityKey,
  type BoardColumn,
  type BoardItemIdentity,
} from "@/src/presentation/board";

import { BoardCard } from "./board-card";

interface KanbanColumnProps {
  column: BoardColumn;
  items: PortfolioWorkItem[];
  loading: boolean;
  pendingItemKey: string | null;
  selectedIdentity: BoardItemIdentity | null;
  onSelect: (identity: BoardItemIdentity) => void;
}

export function KanbanColumn({
  column,
  items,
  loading,
  pendingItemKey,
  selectedIdentity,
  onSelect,
}: KanbanColumnProps) {
  const { isOver, setNodeRef } = useDroppable({ id: column.id });

  return (
    <section
      ref={setNodeRef}
      aria-labelledby={`column-${column.id}`}
      className={`min-w-0 px-2 pb-6 transition-colors ${
        isOver ? "bg-primary/5" : ""
      }`}
    >
      <header className="sticky top-0 z-10 flex h-12 items-center justify-between bg-background px-1">
        <h2
          id={`column-${column.id}`}
          className="text-xs font-semibold tracking-[0.06em] text-muted-foreground uppercase"
        >
          {column.label}
        </h2>
        <span className="min-w-5 rounded-full bg-secondary px-1.5 py-0.5 text-center text-[11px] text-muted-foreground">
          {items.length}
        </span>
      </header>

      <div className="space-y-2" role="list">
        {items.map((item) => {
          const itemKey = boardItemIdentityKey({
            source_id: item.source_id,
            work_item_id: item.work_item.goal.work_item_id,
          });
          return (
            <div key={itemKey} role="listitem">
              <BoardCard
                item={item}
                selectedIdentity={selectedIdentity}
                onSelect={onSelect}
                disabled={pendingItemKey !== null}
              />
            </div>
          );
        })}
        {!loading && items.length === 0 ? (
          <p className="px-2 py-3 text-xs text-[#7f8794]">No work</p>
        ) : null}
      </div>
    </section>
  );
}
