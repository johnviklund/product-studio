"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { X } from "lucide-react";

import {
  INBOX_SOURCE_ID,
  type PortfolioWorkItem,
  type RegisteredWorkspace,
} from "@/src/domain/portfolio";
import type {
  CaptureKind,
  WorkItemPriority,
} from "@/src/domain/work-item";

interface CapturePanelProps {
  workspaces: RegisteredWorkspace[];
  onClose: () => void;
  onCreated: (item: PortfolioWorkItem) => void;
}

interface MutationErrorResponse {
  error?: {
    message?: string;
  };
}

function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

export function CapturePanel({
  workspaces,
  onClose,
  onCreated,
}: CapturePanelProps) {
  const titleId = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<CaptureKind>("idea");
  const [title, setTitle] = useState("");
  const [sourceId, setSourceId] = useState(INBOX_SOURCE_ID);
  const [priority, setPriority] = useState<WorkItemPriority | "">("");
  const [tags, setTags] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty =
    kind !== "idea" ||
    title.length > 0 ||
    sourceId !== INBOX_SOURCE_ID ||
    priority !== "" ||
    tags.length > 0 ||
    notes.length > 0;

  const attemptClose = useCallback(() => {
    if (
      dirty &&
      !window.confirm("Discard this unsaved capture?")
    ) {
      return;
    }
    onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        attemptClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [attemptClose]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    try {
      const parsedTags = parseTags(tags);
      const response = await fetch("/api/portfolio/work-items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          capture_kind: kind,
          ...(sourceId === INBOX_SOURCE_ID ? {} : { source_id: sourceId }),
          ...(priority === "" ? {} : { priority }),
          ...(parsedTags.length === 0 ? {} : { tags: parsedTags }),
          ...(notes.trim().length === 0 ? {} : { notes }),
        }),
      });
      const body = (await response.json()) as
        | PortfolioWorkItem
        | MutationErrorResponse;
      if (!response.ok) {
        setError(
          "error" in body
            ? body.error?.message ?? "The capture could not be saved."
            : "The capture could not be saved.",
        );
        return;
      }

      onCreated(body as PortfolioWorkItem);
    } catch {
      setError("The capture could not be saved. Check the local server and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label="Close capture panel"
        onClick={attemptClose}
        className="fixed inset-0 z-20 bg-black/45 lg:hidden"
      />
      <aside
        aria-labelledby="capture-panel-title"
        className="fixed inset-y-0 right-0 z-30 flex w-full shrink-0 flex-col border-l bg-muted sm:w-[390px] lg:static lg:z-auto"
      >
        <header className="flex h-16 shrink-0 items-center justify-between border-b px-4">
          <div>
            <h2
              id="capture-panel-title"
              className="text-base font-semibold tracking-[-0.005em]"
            >
              New idea or todo
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              One sentence is enough.
            </p>
          </div>
          <button
            type="button"
            onClick={attemptClose}
            className="grid size-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            aria-label="Close capture panel"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </header>

        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
            <fieldset>
              <legend className="mb-2 text-xs font-medium text-muted-foreground">
                Capture as
              </legend>
              <div className="grid grid-cols-2 rounded-md border bg-background p-1">
                {(["idea", "todo"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={kind === option}
                    onClick={() => setKind(option)}
                    className={`h-9 rounded-sm text-xs font-medium capitalize transition-colors focus-visible:outline-2 focus-visible:outline-primary ${
                      kind === option
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground"
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </fieldset>

            <div>
              <label htmlFor={titleId} className="mb-2 block text-xs font-medium">
                What are you thinking?
              </label>
              <input
                ref={titleRef}
                id={titleId}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                maxLength={240}
                placeholder="A single sentence…"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none placeholder:text-[#7f8794] focus:border-primary focus:ring-1 focus:ring-primary"
              />
            </div>

            <div>
              <label htmlFor={`${titleId}-project`} className="mb-2 block text-xs font-medium">
                Project <span className="text-muted-foreground">· optional</span>
              </label>
              <select
                id={`${titleId}-project`}
                value={sourceId}
                onChange={(event) => setSourceId(event.target.value)}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                <option value={INBOX_SOURCE_ID}>Unassigned</option>
                {workspaces.map((workspace) => (
                  <option key={workspace.workspace_id} value={workspace.workspace_id}>
                    {workspace.product_name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor={`${titleId}-priority`} className="mb-2 block text-xs font-medium">
                Priority <span className="text-muted-foreground">· optional</span>
              </label>
              <select
                id={`${titleId}-priority`}
                value={priority}
                onChange={(event) =>
                  setPriority(event.target.value as WorkItemPriority | "")
                }
                className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                <option value="">Not set</option>
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
              </select>
            </div>

            <div>
              <label htmlFor={`${titleId}-tags`} className="mb-2 block text-xs font-medium">
                Tags <span className="text-muted-foreground">· optional</span>
              </label>
              <input
                id={`${titleId}-tags`}
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                placeholder="Question, Front-end"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none placeholder:text-[#7f8794] focus:border-primary focus:ring-1 focus:ring-primary"
              />
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Separate tags with commas.
              </p>
            </div>

            <div>
              <label htmlFor={`${titleId}-notes`} className="mb-2 block text-xs font-medium">
                Context <span className="text-muted-foreground">· optional</span>
              </label>
              <textarea
                id={`${titleId}-notes`}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={5}
                placeholder="Anything worth preserving with the original thought…"
                className="w-full resize-y rounded-md border bg-background px-3 py-2.5 text-sm leading-5 outline-none placeholder:text-[#7f8794] focus:border-primary focus:ring-1 focus:ring-primary"
              />
            </div>

            {error ? (
              <p
                className="border-l-2 border-destructive bg-destructive/10 px-3 py-2 text-xs text-foreground"
                role="alert"
              >
                {error}
              </p>
            ) : null}
          </div>

          <footer className="flex shrink-0 items-center justify-end gap-2 border-t bg-muted p-4">
            <button
              type="button"
              onClick={attemptClose}
              className="h-9 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || title.trim().length === 0}
              className="h-9 rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </footer>
        </form>
      </aside>
    </>
  );
}
