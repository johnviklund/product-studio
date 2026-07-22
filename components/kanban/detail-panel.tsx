"use client";

import {
  useCallback,
  useEffect,
  useId,
  useState,
  type FormEvent,
} from "react";
import { ArrowLeft, ArrowRight, LockKeyhole, X } from "lucide-react";

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
import {
  boardTransitionActionsForPhase,
  detailPanelModeForItem,
  nextActionForPhase,
  type BoardColumnId,
} from "@/src/presentation/board";

interface DetailPanelProps {
  item: PortfolioWorkItem;
  workspaces: RegisteredWorkspace[];
  onClose: () => void;
  onUpdated: (item: PortfolioWorkItem) => void;
  onAssigned: (previous: PortfolioWorkItem, item: PortfolioWorkItem) => void;
  onTransition: (item: PortfolioWorkItem, targetColumnId: BoardColumnId) => void;
  transitionPending?: boolean;
}

interface MutationErrorResponse {
  error?: {
    message?: string;
  };
}

type DetailTab = "overview" | "activity" | "files";

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

export function DetailPanel({
  item,
  workspaces,
  onClose,
  onUpdated,
  onAssigned,
  onTransition,
  transitionPending = false,
}: DetailPanelProps) {
  const fieldId = useId();
  const mode = detailPanelModeForItem(item);
  const { goal, state } = item.work_item;
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
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");
  const detailsDirty =
    title !== goal.title ||
    type !== (goal.type ?? "") ||
    priority !== (goal.priority ?? "") ||
    tags !== (goal.tags?.join(", ") ?? "") ||
    notes !== (goal.notes ?? "");
  const assignmentDirty = targetSourceId !== item.source_id;

  const attemptClose = useCallback(() => {
    if (
      mode === "capture" &&
      (detailsDirty || assignmentDirty) &&
      !window.confirm("Discard the unsaved capture changes?")
    ) {
      return;
    }
    onClose();
  }, [assignmentDirty, detailsDirty, mode, onClose]);

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

  const transitionActions = boardTransitionActionsForPhase(state.phase);

  return (
    <>
      <button
        type="button"
        aria-label="Close work item details"
        onClick={attemptClose}
        className="fixed inset-0 z-20 bg-black/45 lg:hidden"
      />
      <aside
        aria-labelledby="detail-panel-title"
        className="fixed inset-y-0 right-0 z-30 flex w-full shrink-0 flex-col border-l bg-muted sm:w-[410px] lg:static lg:z-auto"
      >
        <header className="flex h-16 shrink-0 items-center justify-between border-b px-4">
          <div className="min-w-0">
            <p className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
              {mode === "capture" ? "Capture details" : "Work item"}
            </p>
            <h2
              id="detail-panel-title"
              className="truncate text-base font-semibold tracking-[-0.005em]"
            >
              {goal.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={attemptClose}
            className="grid size-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            aria-label="Close work item details"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </header>

        {mode === "capture" ? (
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
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex border-b px-4" role="tablist" aria-label="Work item details">
              {(["overview", "activity", "files"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab}
                  onClick={() => setActiveTab(tab)}
                  className={`h-11 border-b-2 px-3 text-xs font-medium capitalize transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary ${
                    activeTab === tab
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>

            <div className="space-y-5 p-4" role="tabpanel">
              {activeTab === "overview" ? (
                <>
                  <section aria-labelledby={`${fieldId}-summary`}>
                    <h3 id={`${fieldId}-summary`} className="text-xs font-medium text-muted-foreground">
                      Summary
                    </h3>
                    <dl className="mt-3 divide-y border-y text-sm">
                      <div className="flex items-center justify-between gap-4 py-3">
                        <dt className="text-muted-foreground">Project</dt>
                        <dd className="truncate text-right">{item.project?.product_name ?? "Unassigned"}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-4 py-3">
                        <dt className="text-muted-foreground">Type</dt>
                        <dd>{goal.type ?? "Unclassified"}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-4 py-3">
                        <dt className="text-muted-foreground">Phase</dt>
                        <dd className="capitalize">{state.phase}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-4 py-3">
                        <dt className="text-muted-foreground">Status</dt>
                        <dd className="capitalize">{state.status}</dd>
                      </div>
                    </dl>
                  </section>

                  <section aria-labelledby={`${fieldId}-next-action`} className="border-l-2 border-primary bg-background px-3 py-3">
                    <h3 id={`${fieldId}-next-action`} className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
                      Next action
                    </h3>
                    <p className="mt-1 text-sm font-medium">{nextActionForPhase(state.phase)}</p>
                  </section>

                  {transitionActions.forward || transitionActions.back ? (
                    <section aria-label="Valid workflow transitions" className="flex flex-wrap gap-2">
                      {transitionActions.back ? (
                        <button
                          type="button"
                          disabled={transitionPending}
                          onClick={() => onTransition(item, transitionActions.back!.target_column_id)}
                          className="inline-flex h-9 items-center gap-2 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <ArrowLeft className="size-3.5" strokeWidth={1.75} />
                          {transitionActions.back.label}
                        </button>
                      ) : null}
                      {transitionActions.forward ? (
                        <button
                          type="button"
                          disabled={transitionPending}
                          onClick={() => onTransition(item, transitionActions.forward!.target_column_id)}
                          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {transitionActions.forward.label}
                          <ArrowRight className="size-3.5" strokeWidth={1.75} />
                        </button>
                      ) : null}
                    </section>
                  ) : null}
                </>
              ) : (
                <section className="border-l-2 border-border bg-background px-3 py-3">
                  <h3 className="text-sm font-medium capitalize">{activeTab}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {activeTab === "activity"
                      ? "No activity has been recorded yet."
                      : "No files are attached to this work item yet."}
                  </p>
                </section>
              )}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
