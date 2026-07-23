"use client";

import {
  useCallback,
  useEffect,
  useId,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  LockKeyhole,
  X,
} from "lucide-react";

import type {
  MissionCompilation,
  PortfolioImportResult,
  PortfolioRetryResult,
} from "@/src/application/portfolio";
import {
  INBOX_SOURCE_ID,
  type PortfolioWorkItem,
  type RegisteredWorkspace,
} from "@/src/domain/portfolio";
import type {
  CommandEvidenceRecord,
  ImportEvidenceOutcome,
  StoredImportEvidence,
} from "@/src/domain/result";
import {
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_TYPES,
  type WorkItemPriority,
  type WorkItemType,
} from "@/src/domain/work-item";
import {
  boardTransitionActionsForPhase,
  detailPanelModeForItem,
  missionHandoffModeForItem,
  nextActionForPhase,
  type BoardColumnId,
} from "@/src/presentation/board";

interface DetailPanelProps {
  item: PortfolioWorkItem;
  workspaces: RegisteredWorkspace[];
  onClose: () => void;
  onUpdated: (item: PortfolioWorkItem, message?: string) => void;
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

interface MissionCompilationState {
  itemKey: string;
  result: MissionCompilation;
}

interface MissionImportState {
  itemKey: string;
  result: PortfolioImportResult["evidence"];
}

interface RunEvidenceState {
  itemKey: string;
  result: StoredImportEvidence[];
  loading: boolean;
  error: string | null;
}

interface ExpandedRunEvidenceState {
  itemKey: string;
  runIds: Set<string>;
}

interface RunEvidenceSectionProps {
  fieldId: string;
  evidence: StoredImportEvidence[];
  loading: boolean;
  error: string | null;
  expandedRunIds: Set<string>;
  onToggle: (importRunId: string) => void;
}

const capturedAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const runCompletedAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const EMPTY_RUN_IDS = new Set<string>();

function tagsFromInput(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function shortEvidencePath(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length <= 4) {
    return path;
  }
  return `…/${segments.slice(-4).join("/")}`;
}

async function requestRunEvidence(
  sourceId: string,
  workItemId: string,
  signal?: AbortSignal,
): Promise<
  { result: StoredImportEvidence[] | null; error: string | null } | null
> {
  try {
    const response = await fetch(
      `/api/portfolio/work-items/${encodeURIComponent(sourceId)}/${encodeURIComponent(workItemId)}/run-evidence`,
      { signal },
    );
    const body = (await response.json()) as
      | StoredImportEvidence[]
      | MutationErrorResponse;
    if (signal?.aborted) {
      return null;
    }
    if (!response.ok) {
      return {
        result: null,
        error: !Array.isArray(body)
          ? body.error?.message ?? "Run evidence could not be loaded."
          : "Run evidence could not be loaded.",
      };
    }
    return { result: body as StoredImportEvidence[], error: null };
  } catch {
    if (signal?.aborted) {
      return null;
    }
    return {
      result: null,
      error: "Run evidence could not be loaded. Check the local server and try again.",
    };
  }
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs} ms`;
  }
  if (durationMs < 60_000) {
    const seconds = durationMs / 1_000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes} min ${seconds} s`;
}

function runDuration(entry: StoredImportEvidence): string {
  return formatDuration(
    Math.max(
      0,
      new Date(entry.evidence.completed_at).getTime() -
        new Date(entry.evidence.started_at).getTime(),
    ),
  );
}

function outcomeLabel(outcome: ImportEvidenceOutcome): string {
  return `${outcome[0]?.toUpperCase()}${outcome.slice(1)}`;
}

function outcomeClassName(outcome: ImportEvidenceOutcome): string {
  return outcome === "applied" ? "text-success" : "text-destructive";
}

function commandStatusClassName(status: CommandEvidenceRecord["status"]): string {
  if (status === "passed") {
    return "text-success";
  }
  if (status === "not_run") {
    return "text-muted-foreground";
  }
  return "text-destructive";
}

function commandExitLabel(command: CommandEvidenceRecord): string {
  if (command.signal !== null) {
    return `Signal ${command.signal}`;
  }
  if (command.exit_code !== null) {
    return `Exit ${command.exit_code}`;
  }
  return command.status === "not_run" ? "Not run" : "No exit code";
}

function RunEvidenceSection({
  fieldId,
  evidence,
  loading,
  error,
  expandedRunIds,
  onToggle,
}: RunEvidenceSectionProps) {
  return (
    <section
      aria-labelledby={`${fieldId}-run-evidence`}
      className="border-y py-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id={`${fieldId}-run-evidence`} className="text-xs font-medium">
            Run evidence
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Immutable imported results and deterministic command records.
          </p>
        </div>
        {loading && evidence.length > 0 ? (
          <span className="text-[11px] text-muted-foreground" role="status">
            Refreshing…
          </span>
        ) : null}
      </div>

      {error ? (
        <p
          className="mt-3 border-l-2 border-destructive bg-destructive/10 px-3 py-2 text-xs text-foreground"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {loading && evidence.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground" role="status">
          Loading run evidence…
        </p>
      ) : null}

      {!loading && error === null && evidence.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No imported runs yet.
        </p>
      ) : null}

      {evidence.length > 0 ? (
        <div className="mt-3 space-y-2">
          {evidence.map((entry, index) => {
            const { evidence: run, verification } = entry;
            const expanded = expandedRunIds.has(run.import_run_id);
            const detailsId = `${fieldId}-run-${run.import_run_id}`;
            const shortRunId = run.import_run_id.slice(0, 12);

            return (
              <article key={run.import_run_id} className="border bg-background">
                <div className="p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-xs font-medium ${outcomeClassName(run.outcome)}`}
                        >
                          {outcomeLabel(run.outcome)}
                        </span>
                        {index === 0 ? (
                          <span className="rounded-sm border px-1.5 py-0.5 text-[10px] font-medium tracking-[0.04em] text-muted-foreground uppercase">
                            Latest
                          </span>
                        ) : null}
                      </div>
                      <p
                        className="mt-1 truncate text-[11px] text-muted-foreground"
                        title={run.result_commit ?? undefined}
                      >
                        {run.result_commit === null
                          ? "No result commit"
                          : `Result commit · ${run.result_commit.slice(0, 12)}`}
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={detailsId}
                      aria-label={`${expanded ? "Collapse" : "Expand"} ${outcomeLabel(run.outcome).toLowerCase()} run ${shortRunId}`}
                      onClick={() => onToggle(run.import_run_id)}
                      className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border bg-secondary px-2.5 text-[11px] font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    >
                      {expanded ? "Hide details" : "View details"}
                      <ChevronDown
                        className={`size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
                        strokeWidth={1.75}
                        aria-hidden="true"
                      />
                    </button>
                  </div>

                  <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
                    <div>
                      <dt className="text-muted-foreground">Governed identity</dt>
                      <dd className="mt-0.5">
                        Goal {run.identity.goal_version} · Revision{" "}
                        {run.identity.input_revision} · Attempt {run.identity.attempt}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Completed</dt>
                      <dd className="mt-0.5">
                        {runCompletedAtFormatter.format(new Date(run.completed_at))}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Duration</dt>
                      <dd className="mt-0.5">{runDuration(entry)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Telemetry</dt>
                      <dd className="mt-0.5">unknown</dd>
                    </div>
                  </dl>
                </div>

                {expanded ? (
                  <div id={detailsId} className="space-y-4 border-t px-3 py-3">
                    {run.reasons.length > 0 ? (
                      <div>
                        <h4 className="text-[11px] font-medium text-muted-foreground">
                          Reasons
                        </h4>
                        <ul className="mt-2 space-y-1.5 text-xs leading-5">
                          {run.reasons.map((reason, reasonIndex) => (
                            <li
                              key={`${run.import_run_id}-reason-${reasonIndex}`}
                              className="border-l-2 border-destructive pl-2.5"
                            >
                              {reason}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    <div>
                      <h4 className="text-[11px] font-medium text-muted-foreground">
                        Commands
                      </h4>
                      {verification.length === 0 ? (
                        <p className="mt-2 text-xs text-muted-foreground">
                          No verification commands recorded.
                        </p>
                      ) : (
                        <div className="mt-2 space-y-3">
                          {verification.map((command, commandIndex) => (
                            <div
                              key={`${run.import_run_id}-${commandIndex}`}
                              className="border-l-2 border-border bg-muted/40 px-3 py-2.5"
                            >
                              <div className="flex items-center justify-between gap-3 text-xs">
                                <span className="font-medium">{command.name}</span>
                                <span className={commandStatusClassName(command.status)}>
                                  {command.status.replaceAll("_", " ")}
                                </span>
                              </div>
                              <p className="mt-1 break-all text-[11px] leading-5 text-muted-foreground">
                                {command.argv.join(" ")}
                              </p>
                              <p className="mt-1 text-[11px] text-muted-foreground">
                                {formatDuration(command.duration_ms)} · {commandExitLabel(command)}
                              </p>
                              {command.output_truncated ? (
                                <p className="mt-2 text-[11px] text-destructive">
                                  Captured output was truncated.
                                </p>
                              ) : null}
                              <div className="mt-3 space-y-3">
                                <div>
                                  <p className="text-[11px] font-medium text-muted-foreground">
                                    stdout
                                  </p>
                                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words border bg-background p-2 text-[11px] leading-5">
                                    {command.stdout || "No stdout recorded."}
                                  </pre>
                                </div>
                                <div>
                                  <p className="text-[11px] font-medium text-muted-foreground">
                                    stderr
                                  </p>
                                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words border bg-background p-2 text-[11px] leading-5">
                                    {command.stderr || "No stderr recorded."}
                                  </pre>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
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
  const [compilingMission, setCompilingMission] = useState(false);
  const [importingResult, setImportingResult] = useState(false);
  const [startingRepair, setStartingRepair] = useState(false);
  const [missionCompilationState, setMissionCompilationState] =
    useState<MissionCompilationState | null>(null);
  const [missionImportState, setMissionImportState] =
    useState<MissionImportState | null>(null);
  const [copiedMissionKey, setCopiedMissionKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runEvidenceState, setRunEvidenceState] =
    useState<RunEvidenceState | null>(null);
  const [expandedRunEvidenceState, setExpandedRunEvidenceState] =
    useState<ExpandedRunEvidenceState | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");
  const detailsDirty =
    title !== goal.title ||
    type !== (goal.type ?? "") ||
    priority !== (goal.priority ?? "") ||
    tags !== (goal.tags?.join(", ") ?? "") ||
    notes !== (goal.notes ?? "");
  const assignmentDirty = targetSourceId !== item.source_id;
  const missionItemKey = [
    item.source_id,
    goal.work_item_id,
    goal.goal_version,
    state.input_revision,
    state.attempt,
  ].join(":");
  const missionHandoffMode = missionHandoffModeForItem(item);
  const missionEligible = missionHandoffMode === "active";
  const repairEligible = missionHandoffMode === "repair";
  const missionBusy = compilingMission || importingResult || startingRepair;
  const missionCompilation =
    missionCompilationState?.itemKey === missionItemKey
      ? missionCompilationState.result
      : null;
  const missionImport =
    missionImportState?.itemKey === missionItemKey
      ? missionImportState.result
      : null;
  const runEvidenceItemKey = `${item.source_id}:${goal.work_item_id}`;
  const runEvidence =
    mode === "governed" && runEvidenceState?.itemKey === runEvidenceItemKey
      ? runEvidenceState.result
      : [];
  const runEvidenceLoading =
    mode === "governed" &&
    (runEvidenceState?.itemKey !== runEvidenceItemKey ||
      runEvidenceState.loading);
  const runEvidenceError =
    mode === "governed" && runEvidenceState?.itemKey === runEvidenceItemKey
      ? runEvidenceState.error
      : null;
  const expandedRunIds =
    expandedRunEvidenceState?.itemKey === runEvidenceItemKey
      ? expandedRunEvidenceState.runIds
      : EMPTY_RUN_IDS;

  const loadRunEvidence = useCallback(
    async (signal?: AbortSignal) => {
      const loaded = await requestRunEvidence(
        item.source_id,
        goal.work_item_id,
        signal,
      );
      if (loaded === null) {
        return;
      }
      setRunEvidenceState((current) => ({
        itemKey: runEvidenceItemKey,
        result:
          loaded.result ??
          (current?.itemKey === runEvidenceItemKey ? current.result : []),
        loading: false,
        error: loaded.error,
      }));
    },
    [goal.work_item_id, item.source_id, runEvidenceItemKey],
  );

  const markRunEvidenceLoading = useCallback(() => {
    setRunEvidenceState((current) => ({
      itemKey: runEvidenceItemKey,
      result: current?.itemKey === runEvidenceItemKey ? current.result : [],
      loading: true,
      error: null,
    }));
  }, [runEvidenceItemKey]);

  const handleToggleRunEvidence = useCallback(
    (importRunId: string) => {
      setExpandedRunEvidenceState((current) => {
        const runIds =
          current?.itemKey === runEvidenceItemKey
            ? new Set(current.runIds)
            : new Set<string>();
        if (runIds.has(importRunId)) {
          runIds.delete(importRunId);
        } else {
          runIds.add(importRunId);
        }
        return { itemKey: runEvidenceItemKey, runIds };
      });
    },
    [runEvidenceItemKey],
  );

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

  useEffect(() => {
    if (mode !== "governed") {
      return;
    }
    const controller = new AbortController();
    void requestRunEvidence(
      item.source_id,
      goal.work_item_id,
      controller.signal,
    ).then((loaded) => {
      if (loaded === null) {
        return;
      }
      setRunEvidenceState((current) => ({
        itemKey: runEvidenceItemKey,
        result:
          loaded.result ??
          (current?.itemKey === runEvidenceItemKey ? current.result : []),
        loading: false,
        error: loaded.error,
      }));
    });
    return () => controller.abort();
  }, [goal.work_item_id, item.source_id, mode, runEvidenceItemKey]);

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

  async function handleCompileMission() {
    setCompilingMission(true);
    setError(null);
    setCopiedMissionKey(null);

    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/mission`,
        { method: "POST" },
      );
      const body = (await response.json()) as
        | MissionCompilation
        | MutationErrorResponse;
      if (!response.ok) {
        setError(
          "error" in body
            ? body.error?.message ?? "The mission could not be compiled."
            : "The mission could not be compiled.",
        );
        return;
      }

      setMissionCompilationState({
        itemKey: missionItemKey,
        result: body as MissionCompilation,
      });
    } catch {
      setError(
        "The mission could not be compiled. Check the local server and try again.",
      );
    } finally {
      setCompilingMission(false);
    }
  }

  async function handleImportResult() {
    setImportingResult(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/mission/import`,
        { method: "POST" },
      );
      const body = (await response.json()) as
        | PortfolioImportResult
        | MutationErrorResponse;
      if (!response.ok) {
        setError(
          "error" in body
            ? body.error?.message ?? "The returned result could not be imported."
            : "The returned result could not be imported.",
        );
        return;
      }

      const imported = body as PortfolioImportResult;
      setMissionImportState({
        itemKey: missionItemKey,
        result: imported.evidence,
      });
      markRunEvidenceLoading();
      await loadRunEvidence();
      onUpdated(
        imported,
        imported.evidence.outcome === "applied"
          ? "Result imported and ready for review."
          : "Result imported; a repair attempt is required.",
      );
    } catch {
      setError(
        "The returned result could not be imported. Check the local server and try again.",
      );
    } finally {
      setImportingResult(false);
    }
  }

  async function handleStartRepair() {
    setStartingRepair(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/mission/retry`,
        { method: "POST" },
      );
      const body = (await response.json()) as
        | PortfolioRetryResult
        | MutationErrorResponse;
      if (!response.ok) {
        setError(
          "error" in body
            ? body.error?.message ?? "A repair attempt could not be started."
            : "A repair attempt could not be started.",
        );
        return;
      }

      setMissionCompilationState(null);
      setMissionImportState(null);
      const retried = body as PortfolioRetryResult;
      markRunEvidenceLoading();
      await loadRunEvidence();
      onUpdated(retried, "Repair attempt started.");
    } catch {
      setError(
        "A repair attempt could not be started. Check the local server and try again.",
      );
    } finally {
      setStartingRepair(false);
    }
  }

  async function handleCopyLaunchInstruction() {
    if (missionCompilation === null) {
      return;
    }

    try {
      await navigator.clipboard.writeText(
        `Open the workspace in your chosen agent and follow ${missionCompilation.task_path}.`,
      );
      setCopiedMissionKey(missionItemKey);
    } catch {
      setError("The launch instruction could not be copied.");
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
              {error ? (
                <p
                  className="border-l-2 border-destructive bg-destructive/10 px-3 py-2 text-xs text-foreground"
                  role="alert"
                >
                  {error}
                </p>
              ) : null}
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

                  {missionEligible || repairEligible || missionImport ? (
                    <section
                      aria-labelledby={`${fieldId}-mission-handoff`}
                      className="border-y py-4"
                    >
                      <div>
                        <div>
                          <h3
                            id={`${fieldId}-mission-handoff`}
                            className="text-xs font-medium"
                          >
                            Mission handoff
                          </h3>
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            {repairEligible
                              ? "The last import is blocked. Prior evidence stays immutable when you create a new attempt."
                              : missionEligible
                                ? "Compile durable instructions, then import the result returned by the external agent."
                                : "The returned result has been processed by the controller."}
                          </p>
                        </div>
                        {missionEligible ? (
                          <div className="mt-3 flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={missionBusy}
                              onClick={() => void handleCompileMission()}
                              className="h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {compilingMission ? "Compiling…" : "Compile mission"}
                            </button>
                            <button
                              type="button"
                              disabled={missionBusy}
                              onClick={() => void handleImportResult()}
                              className="h-9 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {importingResult ? "Importing…" : "Import result"}
                            </button>
                          </div>
                        ) : null}
                        {repairEligible ? (
                          <button
                            type="button"
                            disabled={missionBusy}
                            onClick={() => void handleStartRepair()}
                            className="mt-3 h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {startingRepair
                              ? "Starting repair…"
                              : "Start repair attempt"}
                          </button>
                        ) : null}
                      </div>

                      {missionImport ? (
                        <div
                          className={`mt-4 border-l-2 px-3 py-3 text-xs ${
                            missionImport.outcome === "applied"
                              ? "border-success bg-success/10"
                              : "border-destructive bg-destructive/10"
                          }`}
                          role="status"
                        >
                          <p className="font-medium">
                            {missionImport.outcome === "applied"
                              ? "Ready for review"
                              : "Import blocked"}
                          </p>
                          <p
                            className="mt-1 break-all leading-5 text-muted-foreground"
                            title={missionImport.evidence_path}
                          >
                            Evidence · {shortEvidencePath(missionImport.evidence_path)}
                          </p>
                        </div>
                      ) : null}

                      {missionEligible && missionCompilation ? (
                        <div className="mt-4 border-l-2 border-border bg-background px-3 py-3">
                          <dl className="space-y-3 text-xs">
                            <div>
                              <dt className="text-muted-foreground">TASK.md</dt>
                              <dd className="mt-1 break-all leading-5">
                                {missionCompilation.task_path}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-muted-foreground">Mission JSON</dt>
                              <dd className="mt-1 break-all leading-5">
                                {missionCompilation.mission_path}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-muted-foreground">Workspace</dt>
                              <dd className="mt-1 break-all leading-5">
                                {missionCompilation.workspace_path}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-muted-foreground">Package hash</dt>
                              <dd className="mt-1 break-all text-[11px] leading-5">
                                {missionCompilation.mission.content_sha256}
                              </dd>
                            </div>
                          </dl>
                          <div className="mt-4 flex items-center gap-3">
                            <button
                              type="button"
                              onClick={() => void handleCopyLaunchInstruction()}
                              className="h-9 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                            >
                              Copy launch instruction
                            </button>
                            <span
                              className="text-[11px] text-muted-foreground"
                              role="status"
                              aria-live="polite"
                            >
                              {copiedMissionKey === missionItemKey ? "Copied" : ""}
                            </span>
                          </div>
                        </div>
                      ) : null}
                    </section>
                  ) : null}

                  <RunEvidenceSection
                    fieldId={fieldId}
                    evidence={runEvidence}
                    loading={runEvidenceLoading}
                    error={runEvidenceError}
                    expandedRunIds={expandedRunIds}
                    onToggle={handleToggleRunEvidence}
                  />

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
