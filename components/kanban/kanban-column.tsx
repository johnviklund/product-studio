import { useDroppable } from "@dnd-kit/core";

import type { PortfolioListItem } from "@/src/application/portfolio";
import {
  boardItemIdentityKey,
  type BoardColumn,
  type BoardItemIdentity,
} from "@/src/presentation/board";

import { BoardCard } from "./board-card";

interface KanbanColumnProps {
  column: BoardColumn;
  items: PortfolioListItem[];
  loading: boolean;
  pendingItemKey: string | null;
  selectedIdentity: BoardItemIdentity | null;
  onSelect: (identity: BoardItemIdentity) => void;
  onMoveFocus?: (identity: BoardItemIdentity) => void;
  onOpenDetail?: (identity: BoardItemIdentity) => void;
}

export function KanbanColumn({
  column,
  items,
  loading,
  pendingItemKey,
  selectedIdentity,
  onSelect,
  onMoveFocus,
  onOpenDetail,
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
        {items.map((item, index) => {
          const itemKey = boardItemIdentityKey({
            source_id: item.source_id,
            work_item_id: item.work_item.goal.work_item_id,
          });
          const previousItem = items[index - 1];
          const nextItem = items[index + 1];
          return (
            <div key={itemKey} role="listitem">
              <BoardCard
                item={item}
                selectedIdentity={selectedIdentity}
                onSelect={onSelect}
                previousIdentity={
                  previousItem
                    ? {
                        source_id: previousItem.source_id,
                        work_item_id: previousItem.work_item.goal.work_item_id,
                      }
                    : undefined
                }
                nextIdentity={
                  nextItem
                    ? {
                        source_id: nextItem.source_id,
                        work_item_id: nextItem.work_item.goal.work_item_id,
                      }
                    : undefined
                }
                onMoveFocus={onMoveFocus}
                onOpenDetail={onOpenDetail}
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
