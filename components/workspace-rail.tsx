import Link from "next/link";
import { Inbox, LayoutGrid } from "lucide-react";

type WorkspaceDestination = "board" | "inbox";

interface WorkspaceRailProps {
  current: WorkspaceDestination;
}

function navigationClass(active: boolean): string {
  return [
    "grid size-10 place-items-center rounded-md outline-none transition-colors",
    "focus-visible:ring-2 focus-visible:ring-ring",
    active
      ? "bg-accent text-foreground"
      : "text-muted-foreground hover:bg-accent hover:text-foreground",
  ].join(" ");
}

export function WorkspaceRail({ current }: WorkspaceRailProps) {
  return (
    <aside className="flex w-[58px] shrink-0 flex-col items-center border-r bg-sidebar py-3">
      <div
        className="grid size-9 place-items-center rounded-md bg-primary text-xs font-semibold text-primary-foreground"
        aria-label="Product Studio"
      >
        PS
      </div>
      <nav className="mt-5 flex flex-col gap-2" aria-label="Workspace">
        <Link
          href="/"
          className={navigationClass(current === "board")}
          aria-label="All work"
          aria-current={current === "board" ? "page" : undefined}
        >
          <LayoutGrid className="size-5" strokeWidth={1.75} />
        </Link>
        <Link
          href="/inbox"
          className={navigationClass(current === "inbox")}
          aria-label="Needs you"
          aria-current={current === "inbox" ? "page" : undefined}
        >
          <Inbox className="size-5" strokeWidth={1.75} />
        </Link>
      </nav>
      <span
        className="mt-auto size-1.5 rounded-full bg-success"
        aria-hidden="true"
      />
    </aside>
  );
}
