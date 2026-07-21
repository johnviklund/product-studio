"use client";

import {
  useCallback,
  useEffect,
  useId,
  useState,
  type FormEvent,
} from "react";
import { ArrowRight, LockKeyhole, X } from "lucide-react";

import {
  INBOX_SOURCE_ID,
  type PortfolioWorkItem,
  type RegisteredWorkspace,
} from "@/src/domain/portfolio";
import {
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_TYPES,
  type WorkItemPriority,
  type WorkItemType,
} from "@/src/domain/work-item";

interface CaptureEditorProps {
  item: PortfolioWorkItem;
  workspaces: RegisteredWorkspace[];
  onClose: () => void;
  onUpdated: (item: PortfolioWorkItem) => void;
  onAssigned: (previous: PortfolioWorkItem, item: PortfolioWorkItem) => void;
}

interface MutationErrorResponse {
  error?: {
    message?: string;
  };
}

const capturedAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function tagsFromInput(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

export function CaptureEditor({
  item,
  workspaces,
  onClose,
  onUpdated,
  onAssigned,
}: CaptureEditorProps) {
  const fieldId = useId();
  const { goal } = item.work_item;
  const [title, setTitle] = useState(goal.title);
  const [type, setType] = useState<WorkItemType | "">(goal.type ?? "");
  const [priority, setPriority] = useState<WorkItemPriority | "">(
    goal.priority ?? "",
  );
  const [tags, setTags] = useState(goal.tags?.join(", ") ?? "");
  const [notes, setNotes] = useState(goal.notes ?? "");
  const [targetSourceId, setTargetSourceId] = useState(item.source_id);
  const [savingDetails, setSavingDetails] = useState(false);
  const [savingAssignment, setSavingAssignment] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detailsDirty =
    title !== goal.title ||
    type !== (goal.type ?? "") ||
    priority !== (goal.priority ?? "") ||
    tags !== (goal.tags?.join(", ") ?? "") ||
    notes !== (goal.notes ?? "");
  const assignmentDirty = targetSourceId !== item.source_id;

  const attemptClose = useCallback(() => {
    if (
      (detailsDirty || assignmentDirty) &&
      !window.confirm("Discard the unsaved capture changes?")
    ) {
      return;
    }
    onClose();
  }, [assignmentDirty, detailsDirty, onClose]);

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

  async function handleDetailsSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingDetails(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/details`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: title.trim(),
            type: type === "" ? null : type,
            priority: priority === "" ? null : priority,
            tags: tagsFromInput(tags),
            notes: notes.trim().length === 0 ? null : notes,
          }),
        },
      );
      const body = (await response.json()) as
        | PortfolioWorkItem
        | MutationErrorResponse;
      if (!response.ok) {
        setError(
          "error" in body
            ? body.error?.message ?? "The details could not be saved."
            : "The details could not be saved.",
        );
        return;
      }

      const updated = body as PortfolioWorkItem;
      setTitle(updated.work_item.goal.title);
      setType(updated.work_item.goal.type ?? "");
      setPriority(updated.work_item.goal.priority ?? "");
      setTags(updated.work_item.goal.tags?.join(", ") ?? "");
      setNotes(updated.work_item.goal.notes ?? "");
      onUpdated(updated);
    } catch {
      setError("The details could not be saved. Check the local server and try again.");
    } finally {
      setSavingDetails(false);
    }
  }

  async function handleAssignmentSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!assignmentDirty) {
      return;
    }
    setSavingAssignment(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/assignment`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target_source_id: targetSourceId }),
        },
      );
      const body = (await response.json()) as
        | PortfolioWorkItem
        | MutationErrorResponse;
      if (!response.ok) {
        setError(
          "error" in body
            ? body.error?.message ?? "The project could not be changed."
            : "The project could not be changed.",
        );
        return;
      }

      onAssigned(item, body as PortfolioWorkItem);
    } catch {
      setError("The project could not be changed. Check the local server and try again.");
    } finally {
      setSavingAssignment(false);
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label="Close capture editor"
        onClick={attemptClose}
        className="fixed inset-0 z-20 bg-black/45 lg:hidden"
      />
      <aside
        aria-labelledby="capture-editor-title"
        className="fixed inset-y-0 right-0 z-30 flex w-full shrink-0 flex-col border-l bg-muted sm:w-[410px] lg:static lg:z-auto"
      >
        <header className="flex h-16 shrink-0 items-center justify-between border-b px-4">
          <div className="min-w-0">
            <p className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
              Capture details
            </p>
            <h2
              id="capture-editor-title"
              className="truncate text-base font-semibold tracking-[-0.005em]"
            >
              {goal.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={attemptClose}
            className="grid size-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            aria-label="Close capture editor"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          <section aria-labelledby={`${fieldId}-provenance`}>
            <div className="mb-2 flex items-center gap-2">
              <LockKeyhole className="size-3.5 text-muted-foreground" strokeWidth={1.75} />
              <h3 id={`${fieldId}-provenance`} className="text-xs font-medium">
                Original capture
              </h3>
            </div>
            <div className="border-l-2 border-primary bg-background px-3 py-2.5">
              <p className="text-sm leading-5 text-foreground">
                {goal.capture?.original_title}
              </p>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                {goal.capture?.kind === "todo" ? "Todo" : "Idea"} · captured {" "}
                {goal.capture
                  ? capturedAtFormatter.format(new Date(goal.capture.captured_at))
                  : "before provenance tracking"}
              </p>
            </div>
          </section>

          <form
            onSubmit={(event) => void handleDetailsSubmit(event)}
            className="space-y-4 border-t pt-5"
          >
            <div>
              <label htmlFor={`${fieldId}-title`} className="mb-2 block text-xs font-medium">
                Current title
              </label>
              <input
                id={`${fieldId}-title`}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor={`${fieldId}-type`} className="mb-2 block text-xs font-medium">
                  Work type
                </label>
                <select
                  id={`${fieldId}-type`}
                  value={type}
                  onChange={(event) => setType(event.target.value as WorkItemType | "")}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                >
                  <option value="">Unclassified</option>
                  {WORK_ITEM_TYPES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor={`${fieldId}-priority`} className="mb-2 block text-xs font-medium">
                  Priority
                </label>
                <select
                  id={`${fieldId}-priority`}
                  value={priority}
                  onChange={(event) =>
                    setPriority(event.target.value as WorkItemPriority | "")
                  }
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                >
                  <option value="">Not set</option>
                  {WORK_ITEM_PRIORITIES.map((option) => (
                    <option key={option} value={option} className="capitalize">
                      {option[0]?.toUpperCase()}{option.slice(1)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label htmlFor={`${fieldId}-tags`} className="mb-2 block text-xs font-medium">
                Tags
              </label>
              <input
                id={`${fieldId}-tags`}
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                placeholder="Question, Front-end"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none placeholder:text-[#7f8794] focus:border-primary focus:ring-1 focus:ring-primary"
              />
            </div>

            <div>
              <label htmlFor={`${fieldId}-notes`} className="mb-2 block text-xs font-medium">
                Context
              </label>
              <textarea
                id={`${fieldId}-notes`}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={5}
                className="w-full resize-y rounded-md border bg-background px-3 py-2.5 text-sm leading-5 outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              />
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={savingDetails || !detailsDirty || title.trim().length === 0}
                className="h-9 rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                {savingDetails ? "Saving…" : "Save details"}
              </button>
            </div>
          </form>

          <form
            onSubmit={(event) => void handleAssignmentSubmit(event)}
            className="space-y-3 border-t pt-5"
          >
            <div>
              <label htmlFor={`${fieldId}-project`} className="mb-2 block text-xs font-medium">
                Project assignment
              </label>
              <select
                id={`${fieldId}-project`}
                value={targetSourceId}
                onChange={(event) => setTargetSourceId(event.target.value)}
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
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={savingAssignment || !assignmentDirty || detailsDirty}
                className="flex h-9 items-center gap-2 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                {savingAssignment ? "Moving…" : "Change project"}
                <ArrowRight className="size-3.5" strokeWidth={1.75} />
              </button>
            </div>
            {detailsDirty && assignmentDirty ? (
              <p className="text-right text-[11px] text-muted-foreground">
                Save detail changes before moving this capture.
              </p>
            ) : null}
          </form>

          {error ? (
            <p
              className="border-l-2 border-destructive bg-destructive/10 px-3 py-2 text-xs text-foreground"
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </div>
      </aside>
    </>
  );
}
