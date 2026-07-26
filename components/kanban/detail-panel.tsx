"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
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
  PatchMissionCompilation,
  PortfolioImportResult,
  PortfolioPatchImportResult,
  PortfolioPatchPlanResult,
  PortfolioReviewImportResult,
  PortfolioRetryResult,
  ReviewMissionCompilation,
} from "@/src/application/portfolio";
import {
  INBOX_SOURCE_ID,
  type PortfolioWorkItem,
  type RegisteredWorkspace,
} from "@/src/domain/portfolio";
import type {
  CommandEvidenceRecord,
  ImportEvidenceOutcome,
  ReviewFinding,
  StoredImportEvidence,
} from "@/src/domain/result";
import type { ConnectedRunSummary } from "@/src/domain/connected-run";
import {
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_TYPES,
  type WorkItemPriority,
  type WorkItemType,
} from "@/src/domain/work-item";
import { canUpdateGoalContract } from "@/src/domain/workflow-policy";
import {
  boardTransitionActionsForPhase,
  connectedExecuteForItem,
  detailPanelModeForItem,
  missionHandoffModeForItem,
  nextActionForPhase,
  patchAttentionForItem,
  reviewHandoffForItem,
  type BoardColumnId,
  type ConnectedExecuteProjection,
  type PatchAttentionProjection,
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

interface ReviewMissionCompilationState {
  itemKey: string;
  result: ReviewMissionCompilation;
}

interface ReviewMissionImportState {
  itemKey: string;
  result: PortfolioReviewImportResult;
}

interface PatchMissionCompilationState {
  itemKey: string;
  result: PatchMissionCompilation;
}

interface PatchMissionImportState {
  itemKey: string;
  result: PortfolioPatchImportResult["evidence"];
}

type PatchMutation = "accepting_plan" | "compiling" | "importing";

interface ReviewAttestationState {
  itemKey: string;
  checked: boolean;
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

interface ConnectedRunState {
  itemKey: string;
  result: ConnectedRunSummary[];
  loading: boolean;
  error: string | null;
}

type ConnectedMutation = "launching" | "allowing_once" | "keeping_denied";

interface RunEvidenceSectionProps {
  fieldId: string;
  evidence: StoredImportEvidence[];
  loading: boolean;
  error: string | null;
  expandedRunIds: Set<string>;
  onToggle: (
    phase: "execute" | "review" | "patch",
    importRunId: string,
  ) => void;
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

function connectedRunValue(value: { value: string | null }): string {
  return value.value ?? "unknown";
}

function connectedHarnessValue(
  value: ConnectedRunSummary["provenance"]["harness"],
): string {
  return value.value === null
    ? "unknown"
    : `${value.value.id} ${value.value.version}`;
}

function effectiveModelValue(
  value: ConnectedRunSummary["provenance"]["effective_model"],
): string {
  return value.model_id === null ? "unknown" : value.model_id;
}

function latestConnectedRun(
  runs: readonly ConnectedRunSummary[],
): ConnectedRunSummary | null {
  return runs.reduce<ConnectedRunSummary | null>((latest, run) => {
    if (
      latest === null ||
      new Date(run.lifecycle.updated_at).getTime() >
        new Date(latest.lifecycle.updated_at).getTime()
    ) {
      return run;
    }
    return latest;
  }, null);
}

function connectedStatusLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function tagsFromInput(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function goalContractLines(values: string[] | undefined): string {
  return values?.join("\n") ?? "";
}

function goalContractValues(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
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

async function requestConnectedRuns(
  sourceId: string,
  workItemId: string,
  signal?: AbortSignal,
): Promise<
  { result: ConnectedRunSummary[] | null; error: string | null } | null
> {
  try {
    const response = await fetch(
      `/api/portfolio/work-items/${encodeURIComponent(sourceId)}/${encodeURIComponent(workItemId)}/mission/connected/run`,
      { signal },
    );
    const body = (await response.json()) as
      | ConnectedRunSummary[]
      | MutationErrorResponse;
    if (signal?.aborted) {
      return null;
    }
    if (!response.ok || !Array.isArray(body)) {
      return {
        result: null,
        error:
          !Array.isArray(body) && body.error?.message
            ? body.error.message
            : "Connected run status could not be loaded.",
      };
    }
    return { result: body, error: null };
  } catch {
    if (signal?.aborted) {
      return null;
    }
    return {
      result: null,
      error: "Connected run status could not be loaded. Check the local server and try again.",
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

function findingSeverityClassName(severity: ReviewFinding["severity"]): string {
  if (severity === "P0" || severity === "P1") {
    return "text-destructive";
  }
  if (severity === "P2") {
    return "text-[var(--chart-3)]";
  }
  return "text-muted-foreground";
}

function findingLinkLabel(link: ReviewFinding["link"]): string {
  switch (link.type) {
    case "acceptance_criteria":
      return `Acceptance criterion · ${link.criterion}`;
    case "non_goals":
      return `Non-goal · ${link.non_goal}`;
    case "defect":
      return `Defect · ${link.evidence_summary}`;
    case "security":
      return `Security · ${link.evidence_summary}`;
    case "deterministic_checks":
      return `Deterministic check · ${link.command}`;
  }
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

export function RunEvidenceSection({
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
            const { evidence: run, verification, submission } = entry;
            const evidenceKey = `${run.phase}:${run.import_run_id}`;
            const expanded = expandedRunIds.has(evidenceKey);
            const detailsId = `${fieldId}-run-${run.phase}-${run.import_run_id}`;
            const shortRunId = run.import_run_id.slice(0, 12);
            const reviewSubmission =
              submission && "review_mission_content_sha256" in submission
                ? submission
                : null;

            return (
              <article key={evidenceKey} className="border bg-background">
                <div className="p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
                          {run.phase === "execute"
                            ? "Execute"
                            : run.phase === "review"
                              ? "Review"
                              : "Patch"}
                        </span>
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
                          : `${run.phase === "review" ? "Subject" : "Result"} commit · ${run.result_commit.slice(0, 12)}`}
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={detailsId}
                      aria-label={`${expanded ? "Collapse" : "Expand"} ${outcomeLabel(run.outcome).toLowerCase()} run ${shortRunId}`}
                      onClick={() => onToggle(run.phase, run.import_run_id)}
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
                              key={`${evidenceKey}:reason:${reasonIndex}`}
                              className="border-l-2 border-destructive pl-2.5"
                            >
                              {reason}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {run.phase === "review" ? (
                      <div>
                        <h4 className="text-[11px] font-medium text-muted-foreground">
                          Review result
                        </h4>
                        {reviewSubmission === null ? (
                          <p className="mt-2 text-xs text-muted-foreground">
                            Structured review output is unavailable for this rejected import.
                          </p>
                        ) : (
                          <div className="mt-2 space-y-3">
                            <div className="border-l-2 border-border bg-muted/40 px-3 py-2.5">
                              <div className="flex items-center justify-between gap-3">
                                <span className="text-xs font-medium">Verdict</span>
                                <span
                                  className={`text-xs font-medium ${
                                    reviewSubmission.verdict === "clean"
                                      ? "text-success"
                                      : "text-destructive"
                                  }`}
                                >
                                  {reviewSubmission.verdict === "clean"
                                    ? "Clean"
                                    : `${reviewSubmission.findings.length} finding${reviewSubmission.findings.length === 1 ? "" : "s"}`}
                                </span>
                              </div>
                              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                                {reviewSubmission.summary}
                              </p>
                            </div>
                            {reviewSubmission.findings.map((finding) => (
                              <article
                                key={`${evidenceKey}:${finding.finding_id}`}
                                className="border-l-2 border-border px-3 py-2.5"
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div>
                                    <p className="text-xs font-medium">
                                      {finding.title}
                                    </p>
                                    <p className="mt-1 text-[11px] text-muted-foreground">
                                      {findingLinkLabel(finding.link)}
                                    </p>
                                  </div>
                                  <span
                                    className={`shrink-0 text-[11px] font-semibold ${findingSeverityClassName(finding.severity)}`}
                                  >
                                    {finding.severity}
                                  </span>
                                </div>
                                <p className="mt-2 text-xs leading-5">
                                  {finding.evidence.summary}
                                </p>
                                {finding.evidence.path ? (
                                  <p className="mt-1 break-all text-[11px] text-muted-foreground">
                                    {finding.evidence.path}
                                  </p>
                                ) : null}
                                <div className="mt-2 border-t pt-2">
                                  <p className="text-[10px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
                                    Required action
                                  </p>
                                  <p className="mt-1 text-xs leading-5">
                                    {finding.required_action}
                                  </p>
                                </div>
                              </article>
                            ))}
                          </div>
                        )}
                        <p className="mt-3 text-[11px] leading-5 text-muted-foreground">
                          No commands were rerun during review import.
                        </p>
                      </div>
                    ) : (
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
                                key={`${evidenceKey}:command:${commandIndex}`}
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
                    )}
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

interface PatchWorkflowSectionProps {
  fieldId: string;
  projection: PatchAttentionProjection;
  patchCycle: number | null;
  mutation: PatchMutation | null;
  compilation: PatchMissionCompilation | null;
  importedEvidence: PortfolioPatchImportResult["evidence"] | null;
  copied: boolean;
  onAcceptPatchPlan: () => void;
  onCompilePatch: () => void;
  onImportPatch: () => void;
  onCopyLaunchInstruction: () => void;
}

function patchWorkflowHeading(projection: PatchAttentionProjection): string {
  switch (projection.mode) {
    case "patch_plan":
      return "Patch plan";
    case "patch_active":
      return "Patch handoff";
    case "escalation":
      return "Needs your decision";
    case "review_ready":
      return "Review ready";
    case "hidden":
      return "Patch handoff";
  }
}

function patchWorkflowStatus(projection: PatchAttentionProjection): string {
  switch (projection.mode) {
    case "patch_plan":
      return "Needs approval";
    case "patch_active":
      return "Active";
    case "escalation":
      return "Escalated";
    case "review_ready":
      return "Human gate";
    case "hidden":
      return "Processed";
  }
}

function patchWorkflowNextAction(
  projection: PatchAttentionProjection,
): string | null {
  switch (projection.mode) {
    case "patch_plan":
      return "Approve the patch plan";
    case "patch_active":
      return "Compile or import the patch";
    case "escalation":
      return "Resolve the escalation";
    case "review_ready":
      return "Review the result";
    case "hidden":
      return null;
  }
}

export function PatchWorkflowSection({
  fieldId,
  projection,
  patchCycle,
  mutation,
  compilation,
  importedEvidence,
  copied,
  onAcceptPatchPlan,
  onCompilePatch,
  onImportPatch,
  onCopyLaunchInstruction,
}: PatchWorkflowSectionProps) {
  if (
    projection.mode === "hidden" &&
    compilation === null &&
    importedEvidence === null
  ) {
    return null;
  }

  const attention = projection.attention;
  const busy = mutation !== null;

  return (
    <section
      aria-labelledby={`${fieldId}-patch-workflow`}
      className="border-y py-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id={`${fieldId}-patch-workflow`} className="text-xs font-medium">
            {patchWorkflowHeading(projection)}
          </h3>
          {projection.mode === "patch_active" ? (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Compile durable patch instructions, then import the exact result
              returned by the external agent.
            </p>
          ) : attention !== null ? (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {attention.question}
            </p>
          ) : null}
        </div>
        <span className="shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
          {patchWorkflowStatus(projection)}
        </span>
      </div>

      {attention !== null ? (
        <p className="mt-3 border-l-2 border-primary bg-background px-3 py-2.5 text-xs leading-5">
          {attention.recommendation}
        </p>
      ) : null}

      {patchCycle !== null ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-y py-3 text-[11px]">
          <div>
            <dt className="text-muted-foreground">Patch cycle</dt>
            <dd className="mt-0.5">{patchCycle} of 3</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Cost/capacity</dt>
            <dd className="mt-0.5">unknown</dd>
          </div>
          {attention?.pins.evidence_paths[0] ? (
            <div className="col-span-2">
              <dt className="text-muted-foreground">Pinned evidence</dt>
              <dd
                className="mt-0.5 break-all leading-5"
                title={attention.pins.evidence_paths[0]}
              >
                {shortEvidencePath(attention.pins.evidence_paths[0])}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {projection.mode === "patch_plan" ? (
        <button
          type="button"
          disabled={busy}
          onClick={onAcceptPatchPlan}
          className="mt-3 h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {mutation === "accepting_plan" ? "Approving…" : "Approve patch plan"}
        </button>
      ) : null}

      {projection.mode === "patch_active" ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCompilePatch}
            className="h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {mutation === "compiling" ? "Compiling…" : "Compile patch mission"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onImportPatch}
            className="h-9 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {mutation === "importing" ? "Importing…" : "Import patch result"}
          </button>
        </div>
      ) : null}

      {projection.mode === "escalation" ? (
        <p className="mt-3 text-xs font-medium" role="status">
          Resolve the decision above before another patch attempt.
        </p>
      ) : null}

      {projection.mode === "review_ready" ? (
        <p className="mt-3 text-xs font-medium" role="status">
          Review the pinned result; completion remains a separate human gate.
        </p>
      ) : null}

      {importedEvidence !== null ? (
        <div
          className={`mt-4 border-l-2 px-3 py-3 text-xs ${
            importedEvidence.outcome === "applied"
              ? "border-success bg-success/10"
              : "border-destructive bg-destructive/10"
          }`}
          role="status"
        >
          <p className="font-medium">
            {importedEvidence.outcome === "applied"
              ? "Patch imported; ready for re-review"
              : "Patch import blocked"}
          </p>
          <p
            className="mt-1 break-all leading-5 text-muted-foreground"
            title={importedEvidence.evidence_path}
          >
            Evidence · {shortEvidencePath(importedEvidence.evidence_path)}
          </p>
        </div>
      ) : null}

      {compilation !== null ? (
        <div className="mt-4 border-l-2 border-border bg-background px-3 py-3">
          <dl className="space-y-3 text-xs">
            <div>
              <dt className="text-muted-foreground">TASK.md</dt>
              <dd className="mt-1 break-all leading-5">
                {compilation.task_path}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Mission JSON</dt>
              <dd className="mt-1 break-all leading-5">
                {compilation.mission_path}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Package hash</dt>
              <dd className="mt-1 break-all text-[11px] leading-5">
                {compilation.mission.content_sha256}
              </dd>
            </div>
          </dl>
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={onCopyLaunchInstruction}
              className="h-9 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              Copy patch instruction
            </button>
            <span
              className="text-[11px] text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              {copied ? "Copied" : ""}
            </span>
          </div>
        </div>
      ) : null}
    </section>
  );
}

interface ConnectedExecuteSectionProps {
  fieldId: string;
  projection: ConnectedExecuteProjection;
  runs: readonly ConnectedRunSummary[];
  loading: boolean;
  error: string | null;
  modelOverride: string;
  mutation: ConnectedMutation | null;
  onModelOverrideChange: (value: string) => void;
  onLaunch: () => void;
  onAllowOnce: () => void;
  onKeepDenied: () => void;
}

export function ConnectedExecuteSection({
  fieldId,
  projection,
  runs,
  loading,
  error,
  modelOverride,
  mutation,
  onModelOverrideChange,
  onLaunch,
  onAllowOnce,
  onKeepDenied,
}: ConnectedExecuteSectionProps) {
  const latest = latestConnectedRun(runs);
  const busy = mutation !== null;

  if (
    projection.mode === "hidden" &&
    latest === null &&
    !loading &&
    error === null
  ) {
    return null;
  }

  return (
    <section
      aria-labelledby={`${fieldId}-connected-execute`}
      className="border-y py-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id={`${fieldId}-connected-execute`} className="text-xs font-medium">
            Connected execution
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Launch the governed Execute mission here, or use the manual mission handoff below to recover.
          </p>
        </div>
        {latest ? (
          <span className="shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
            {connectedStatusLabel(latest.lifecycle.status)}
          </span>
        ) : null}
      </div>

      <p className="mt-3 border-l-2 border-border bg-background px-3 py-2.5 text-[11px] leading-5 text-muted-foreground">
        Local execution has the same machine authority as launching the agent manually. Product Studio enforces mission permissions and result gates; it does not physically sandbox approved operations.
      </p>

      {projection.mode === "launch" ? (
        <div className="mt-4 space-y-3">
          <div>
            <label
              htmlFor={`${fieldId}-connected-model-override`}
              className="mb-2 block text-xs font-medium"
            >
              Model override <span className="text-muted-foreground">(this run only)</span>
            </label>
            <input
              id={`${fieldId}-connected-model-override`}
              value={modelOverride}
              maxLength={200}
              autoComplete="off"
              onChange={(event) => onModelOverrideChange(event.target.value)}
              placeholder="Use the configured model"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none placeholder:text-[#7f8794] focus:border-primary focus:ring-1 focus:ring-primary"
            />
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onLaunch}
            className="h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {mutation === "launching" ? "Launching…" : "Launch connected run"}
          </button>
        </div>
      ) : null}

      {projection.mode === "permission" ? (
        <div className="mt-4 border-l-2 border-warning bg-background px-3 py-3">
          <p className="text-xs font-medium">Permission required</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {projection.permission.question}
          </p>
          <p className="mt-2 break-all text-[11px] text-muted-foreground">
            Exact operation hash · {projection.permission.operation.operation_sha256}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onAllowOnce}
              className="h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {mutation === "allowing_once" ? "Allowing…" : "Allow once and retry"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onKeepDenied}
              className="h-9 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {mutation === "keeping_denied" ? "Keeping denied…" : "Keep denied"}
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p
          className="mt-3 border-l-2 border-destructive bg-destructive/10 px-3 py-2 text-xs text-foreground"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {loading && latest === null ? (
        <p className="mt-3 text-xs text-muted-foreground" role="status">
          Loading connected run status…
        </p>
      ) : null}

      {latest ? (
        <div className="mt-4 border-l-2 border-border bg-background px-3 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium">Latest sanitized run</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {latest.connected_run_id.slice(0, 12)} · updated {runCompletedAtFormatter.format(new Date(latest.lifecycle.updated_at))}
              </p>
            </div>
            {latest.lifecycle.terminal_outcome ? (
              <span className="shrink-0 text-[11px] font-medium text-muted-foreground capitalize">
                {connectedStatusLabel(latest.lifecycle.terminal_outcome)}
              </span>
            ) : null}
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-y py-3 text-[11px]">
            <div>
              <dt className="text-muted-foreground">Runtime</dt>
              <dd className="mt-0.5 break-words">
                {connectedHarnessValue(latest.provenance.harness)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Effective model</dt>
              <dd className="mt-0.5 break-words">
                {effectiveModelValue(latest.provenance.effective_model)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Requested model</dt>
              <dd className="mt-0.5 break-words">
                {connectedRunValue(latest.provenance.requested_model)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Effort</dt>
              <dd className="mt-0.5 break-words">
                {connectedRunValue(latest.provenance.effort)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Bounded diagnostics</dt>
              <dd className="mt-0.5">
                {latest.diagnostics.count}
                {latest.diagnostics.truncated ? " (truncated)" : ""}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Run state</dt>
              <dd className="mt-0.5 capitalize">
                {connectedStatusLabel(latest.lifecycle.status)}
                {latest.lifecycle.partial ? " · partial" : ""}
              </dd>
            </div>
          </dl>
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
  const [saving, setSaving] = useState(false);
  const goalContract = goal.goal_contract;
  const [purpose, setPurpose] = useState(goalContract?.purpose ?? "");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(
    goalContractLines(goalContract?.acceptance_criteria),
  );
  const [nonGoals, setNonGoals] = useState(
    goalContractLines(goalContract?.non_goals),
  );
  const [allowedScope, setAllowedScope] = useState(
    goalContractLines(goalContract?.allowed_scope),
  );
  const [reviewReady, setReviewReady] = useState(
    goalContractLines(goalContract?.review_ready),
  );
  const [compilingMission, setCompilingMission] = useState(false);
  const [importingResult, setImportingResult] = useState(false);
  const [startingRepair, setStartingRepair] = useState(false);
  const [compilingReviewMission, setCompilingReviewMission] = useState(false);
  const [importingReviewResult, setImportingReviewResult] = useState(false);
  const [patchMutation, setPatchMutation] = useState<PatchMutation | null>(null);
  const [missionCompilationState, setMissionCompilationState] =
    useState<MissionCompilationState | null>(null);
  const [missionImportState, setMissionImportState] =
    useState<MissionImportState | null>(null);
  const [reviewMissionCompilationState, setReviewMissionCompilationState] =
    useState<ReviewMissionCompilationState | null>(null);
  const [reviewMissionImportState, setReviewMissionImportState] =
    useState<ReviewMissionImportState | null>(null);
  const [patchMissionCompilationState, setPatchMissionCompilationState] =
    useState<PatchMissionCompilationState | null>(null);
  const [patchMissionImportState, setPatchMissionImportState] =
    useState<PatchMissionImportState | null>(null);
  const [reviewAttestationState, setReviewAttestationState] =
    useState<ReviewAttestationState | null>(null);
  const [copiedMissionKey, setCopiedMissionKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runEvidenceState, setRunEvidenceState] =
    useState<RunEvidenceState | null>(null);
  const [expandedRunEvidenceState, setExpandedRunEvidenceState] =
    useState<ExpandedRunEvidenceState | null>(null);
  const [connectedRunState, setConnectedRunState] =
    useState<ConnectedRunState | null>(null);
  const [connectedModelOverride, setConnectedModelOverride] = useState("");
  const [connectedMutation, setConnectedMutation] =
    useState<ConnectedMutation | null>(null);
  const connectedMutationRef = useRef(false);
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");
  const detailsDirty =
    title !== goal.title ||
    type !== (goal.type ?? "") ||
    priority !== (goal.priority ?? "") ||
    tags !== (goal.tags?.join(", ") ?? "") ||
    notes !== (goal.notes ?? "");
  const assignmentDirty = targetSourceId !== item.source_id;
  const acceptanceCriteriaValues = goalContractValues(acceptanceCriteria);
  const nonGoalsValues = goalContractValues(nonGoals);
  const allowedScopeValues = goalContractValues(allowedScope);
  const reviewReadyValues = goalContractValues(reviewReady);
  const contractDirty =
    purpose !== (goalContract?.purpose ?? "") ||
    acceptanceCriteria !== goalContractLines(goalContract?.acceptance_criteria) ||
    nonGoals !== goalContractLines(goalContract?.non_goals) ||
    allowedScope !== goalContractLines(goalContract?.allowed_scope) ||
    reviewReady !== goalContractLines(goalContract?.review_ready);
  const canEditGoalContract = canUpdateGoalContract(state.phase);
  const hasContractInput =
    goalContract !== undefined ||
    purpose.trim().length > 0 ||
    acceptanceCriteriaValues.length > 0 ||
    nonGoalsValues.length > 0 ||
    allowedScopeValues.length > 0 ||
    reviewReadyValues.length > 0;
  const contractComplete =
    purpose.trim().length > 0 &&
    acceptanceCriteriaValues.length > 0 &&
    nonGoalsValues.length > 0 &&
    allowedScopeValues.length > 0 &&
    reviewReadyValues.length > 0;
  const missionItemKey = [
    "execute",
    item.source_id,
    goal.work_item_id,
    goalContract?.goal_version,
    state.input_revision,
    state.attempt,
  ].join(":");
  const reviewMissionItemKey = [
    "review",
    item.source_id,
    goal.work_item_id,
    goalContract?.goal_version,
    state.input_revision,
    state.attempt,
  ].join(":");
  const patchMissionItemKey = [
    "patch",
    item.source_id,
    goal.work_item_id,
    goalContract?.goal_version,
    state.input_revision,
    state.attempt,
    state.patch_cycle,
  ].join(":");
  const missionHandoffMode = missionHandoffModeForItem(item);
  const connectedExecute = connectedExecuteForItem(item);
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
  const connectedRunItemKey = [
    item.source_id,
    goal.work_item_id,
    state.goal_version,
    state.input_revision,
    state.attempt,
  ].join(":");
  const runEvidence =
    mode === "governed" && runEvidenceState?.itemKey === runEvidenceItemKey
      ? runEvidenceState.result
      : [];
  const connectedRuns =
    mode === "governed" &&
    connectedRunState?.itemKey === connectedRunItemKey
      ? connectedRunState.result
      : [];
  const connectedRunsLoading =
    mode === "governed" &&
    (connectedRunState?.itemKey !== connectedRunItemKey ||
      connectedRunState.loading);
  const connectedRunsError =
    mode === "governed" &&
    connectedRunState?.itemKey === connectedRunItemKey
      ? connectedRunState.error
      : null;
  const patchAttention = patchAttentionForItem(item, runEvidence);
  const reviewHandoff = reviewHandoffForItem(item, runEvidence);
  const reviewEligible =
    reviewHandoff.mode === "active" && patchAttention.mode === "hidden";
  const reviewAttested =
    reviewAttestationState?.itemKey === reviewMissionItemKey &&
    reviewAttestationState.checked;
  const reviewBusy = compilingReviewMission || importingReviewResult;
  const reviewMissionCompilation =
    reviewMissionCompilationState?.itemKey === reviewMissionItemKey
      ? reviewMissionCompilationState.result
      : null;
  const reviewMissionImport =
    reviewMissionImportState?.itemKey === reviewMissionItemKey
      ? reviewMissionImportState.result
      : null;
  const patchMissionCompilation =
    patchMissionCompilationState?.itemKey === patchMissionItemKey
      ? patchMissionCompilationState.result
      : null;
  const patchMissionImport =
    patchMissionImportState?.itemKey === patchMissionItemKey
      ? patchMissionImportState.result
      : null;
  const appliedReviewSubject = runEvidence.find(
    (stored) =>
      stored.evidence.phase ===
        (state.patch_cycle === 0 ? "execute" : "patch") &&
      stored.evidence.outcome === "applied" &&
      stored.evidence.identity.work_item_id === goal.work_item_id &&
      stored.evidence.identity.goal_version === state.goal_version &&
      stored.evidence.identity.input_revision === state.input_revision &&
      stored.evidence.identity.attempt === state.attempt &&
      (state.patch_cycle === 0 ||
        (stored.evidence.phase === "patch" &&
          stored.evidence.identity.patch_cycle === state.patch_cycle)),
  );
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
    (phase: "execute" | "review" | "patch", importRunId: string) => {
      setExpandedRunEvidenceState((current) => {
        const evidenceKey = `${phase}:${importRunId}`;
        const runIds =
          current?.itemKey === runEvidenceItemKey
            ? new Set(current.runIds)
            : new Set<string>();
        if (runIds.has(evidenceKey)) {
          runIds.delete(evidenceKey);
        } else {
          runIds.add(evidenceKey);
        }
        return { itemKey: runEvidenceItemKey, runIds };
      });
    },
    [runEvidenceItemKey],
  );

  const loadConnectedRuns = useCallback(
    async (signal?: AbortSignal) => {
      const loaded = await requestConnectedRuns(
        item.source_id,
        goal.work_item_id,
        signal,
      );
      if (loaded === null) {
        return;
      }
      setConnectedRunState((current) => ({
        itemKey: connectedRunItemKey,
        result:
          loaded.result ??
          (current?.itemKey === connectedRunItemKey ? current.result : []),
        loading: false,
        error: loaded.error,
      }));
    },
    [connectedRunItemKey, goal.work_item_id, item.source_id],
  );

  const markConnectedRunsLoading = useCallback(() => {
    setConnectedRunState((current) => ({
      itemKey: connectedRunItemKey,
      result:
        current?.itemKey === connectedRunItemKey ? current.result : [],
      loading: true,
      error: null,
    }));
  }, [connectedRunItemKey]);

  const attemptClose = useCallback(() => {
    if (
      mode === "capture" &&
      (detailsDirty || assignmentDirty || contractDirty) &&
      !window.confirm("Discard the unsaved capture changes?")
    ) {
      return;
    }
    onClose();
  }, [assignmentDirty, contractDirty, detailsDirty, mode, onClose]);

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

  useEffect(() => {
    if (mode !== "governed") {
      return;
    }
    const controller = new AbortController();
    void requestConnectedRuns(
      item.source_id,
      goal.work_item_id,
      controller.signal,
    ).then((loaded) => {
      if (loaded === null) {
        return;
      }
      setConnectedRunState((current) => ({
        itemKey: connectedRunItemKey,
        result:
          loaded.result ??
          (current?.itemKey === connectedRunItemKey ? current.result : []),
        loading: false,
        error: loaded.error,
      }));
    });
    return () => controller.abort();
  }, [
    connectedRunItemKey,
    goal.work_item_id,
    item.source_id,
    mode,
  ]);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEditGoalContract || title.trim().length === 0) {
      return;
    }
    if (hasContractInput && !contractComplete) {
      setError("Complete every goal contract field before saving it.");
      return;
    }
    if (
      goalContract === undefined &&
      hasContractInput &&
      targetSourceId === INBOX_SOURCE_ID
    ) {
      setError("Choose a project before activating a goal contract.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/edit`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            target_source_id: targetSourceId,
            title: title.trim(),
            type: type === "" ? null : type,
            priority: priority === "" ? null : priority,
            tags: tagsFromInput(tags),
            notes: notes.trim().length === 0 ? null : notes,
            ...(hasContractInput
              ? {
                  goal_contract: {
                    purpose: purpose.trim(),
                    acceptance_criteria: acceptanceCriteriaValues,
                    non_goals: nonGoalsValues,
                    allowed_scope: allowedScopeValues,
                    review_ready: reviewReadyValues,
                  },
                  ...(goalContract === undefined
                    ? {}
                    : {
                        expected_goal_version: goalContract.goal_version,
                        expected_input_revision: state.input_revision,
                      }),
                }
              : {}),
          }),
        },
      );
      const body = (await response.json()) as
        | PortfolioWorkItem
        | MutationErrorResponse;
      if (!response.ok) {
        setError(
          "error" in body
            ? body.error?.message ?? "The work item could not be saved."
            : "The work item could not be saved.",
        );
        return;
      }

      const updated = body as PortfolioWorkItem;
      setTitle(updated.work_item.goal.title);
      setType(updated.work_item.goal.type ?? "");
      setPriority(updated.work_item.goal.priority ?? "");
      setTags(updated.work_item.goal.tags?.join(", ") ?? "");
      setNotes(updated.work_item.goal.notes ?? "");
      setTargetSourceId(updated.source_id);
      setPurpose(updated.work_item.goal.goal_contract?.purpose ?? "");
      setAcceptanceCriteria(
        goalContractLines(updated.work_item.goal.goal_contract?.acceptance_criteria),
      );
      setNonGoals(goalContractLines(updated.work_item.goal.goal_contract?.non_goals));
      setAllowedScope(goalContractLines(updated.work_item.goal.goal_contract?.allowed_scope));
      setReviewReady(goalContractLines(updated.work_item.goal.goal_contract?.review_ready));
      if (updated.source_id === item.source_id) {
        onUpdated(updated, "Work item saved.");
      } else {
        onAssigned(item, updated);
      }
    } catch {
      setError("The work item could not be saved. Check the local server and try again.");
    } finally {
      setSaving(false);
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

  async function handleCompileReviewMission() {
    if (!reviewAttested) {
      return;
    }
    setCompilingReviewMission(true);
    setError(null);
    setCopiedMissionKey(null);

    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/mission/review`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ independence_attested: true }),
        },
      );
      const body = (await response.json()) as
        | ReviewMissionCompilation
        | MutationErrorResponse;
      if (!response.ok) {
        setError(
          "error" in body
            ? body.error?.message ?? "The review mission could not be compiled."
            : "The review mission could not be compiled.",
        );
        return;
      }

      setReviewMissionCompilationState({
        itemKey: reviewMissionItemKey,
        result: body as ReviewMissionCompilation,
      });
    } catch {
      setError(
        "The review mission could not be compiled. Check the local server and try again.",
      );
    } finally {
      setCompilingReviewMission(false);
    }
  }

  async function handleImportReviewResult() {
    setImportingReviewResult(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/mission/review/import`,
        { method: "POST" },
      );
      const body = (await response.json()) as
        | PortfolioReviewImportResult
        | MutationErrorResponse;
      if (!response.ok) {
        setError(
          "error" in body
            ? body.error?.message ?? "The review result could not be imported."
            : "The review result could not be imported.",
        );
        return;
      }

      const imported = body as PortfolioReviewImportResult;
      setReviewMissionImportState({
        itemKey: reviewMissionItemKey,
        result: imported,
      });
      markRunEvidenceLoading();
      await loadRunEvidence();
      onUpdated(
        imported,
        imported.evidence.outcome === "applied"
          ? imported.result?.verdict === "findings"
            ? "Review findings imported; the next decision is ready."
            : "Clean review imported; human review is ready."
          : "Review output was rejected; the current workflow state is unchanged.",
      );
    } catch {
      setError(
        "The review result could not be imported. Check the local server and try again.",
      );
    } finally {
      setImportingReviewResult(false);
    }
  }

  async function handleAcceptPatchPlan() {
    setPatchMutation("accepting_plan");
    setError(null);

    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/patch-plan`,
        { method: "POST" },
      );
      const body = (await response.json()) as
        | PortfolioPatchPlanResult
        | MutationErrorResponse;
      if (!response.ok) {
        setError(
          "error" in body
            ? body.error?.message ?? "The patch plan could not be approved."
            : "The patch plan could not be approved.",
        );
        return;
      }

      const accepted = body as PortfolioPatchPlanResult;
      setPatchMissionCompilationState(null);
      setPatchMissionImportState(null);
      onUpdated(
        accepted,
        `Patch cycle ${accepted.work_item.state.patch_cycle ?? "unknown"} started.`,
      );
    } catch {
      setError(
        "The patch plan could not be approved. Check the local server and try again.",
      );
    } finally {
      setPatchMutation(null);
    }
  }

  async function handleCompilePatchMission() {
    setPatchMutation("compiling");
    setError(null);
    setCopiedMissionKey(null);

    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/mission/patch`,
        { method: "POST" },
      );
      const body = (await response.json()) as
        | PatchMissionCompilation
        | MutationErrorResponse;
      if (!response.ok) {
        setError(
          "error" in body
            ? body.error?.message ?? "The patch mission could not be compiled."
            : "The patch mission could not be compiled.",
        );
        return;
      }

      setPatchMissionCompilationState({
        itemKey: patchMissionItemKey,
        result: body as PatchMissionCompilation,
      });
    } catch {
      setError(
        "The patch mission could not be compiled. Check the local server and try again.",
      );
    } finally {
      setPatchMutation(null);
    }
  }

  async function handleImportPatchResult() {
    setPatchMutation("importing");
    setError(null);

    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/mission/patch/import`,
        { method: "POST" },
      );
      const body = (await response.json()) as
        | PortfolioPatchImportResult
        | MutationErrorResponse;
      if (!response.ok) {
        setError(
          "error" in body
            ? body.error?.message ?? "The patch result could not be imported."
            : "The patch result could not be imported.",
        );
        return;
      }

      const imported = body as PortfolioPatchImportResult;
      setPatchMissionImportState({
        itemKey: patchMissionItemKey,
        result: imported.evidence,
      });
      markRunEvidenceLoading();
      await loadRunEvidence();
      onUpdated(
        imported,
        imported.evidence.outcome === "applied"
          ? "Patch imported and ready for independent re-review."
          : "Patch imported; correct the rejected result before retrying.",
      );
    } catch {
      setError(
        "The patch result could not be imported. Check the local server and try again.",
      );
    } finally {
      setPatchMutation(null);
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

  async function handleCopyLaunchInstruction(
    compilation:
      | MissionCompilation
      | ReviewMissionCompilation
      | PatchMissionCompilation,
    itemKey: string,
  ) {
    try {
      await navigator.clipboard.writeText(
        `Open the workspace in your chosen agent and follow ${compilation.task_path}.`,
      );
      setCopiedMissionKey(itemKey);
    } catch {
      setError("The launch instruction could not be copied.");
    }
  }

  async function handleLaunchConnectedRun() {
    if (connectedMutationRef.current || !connectedExecute.can_launch) {
      return;
    }
    connectedMutationRef.current = true;
    setConnectedMutation("launching");
    markConnectedRunsLoading();

    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/mission/connected/launch`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            connectedModelOverride.trim().length === 0
              ? {}
              : { model_override: connectedModelOverride.trim() },
          ),
        },
      );
      const body = (await response.json()) as
        | ConnectedRunSummary
        | MutationErrorResponse;
      if (!response.ok) {
        setConnectedRunState((current) => ({
          itemKey: connectedRunItemKey,
          result:
            current?.itemKey === connectedRunItemKey ? current.result : [],
          loading: false,
          error:
            "error" in body
              ? body.error?.message ?? "The connected run could not be launched."
              : "The connected run could not be launched.",
        }));
        return;
      }

      setConnectedRunState({
        itemKey: connectedRunItemKey,
        result: [body as ConnectedRunSummary],
        loading: false,
        error: null,
      });
      setConnectedModelOverride("");
    } catch {
      setConnectedRunState((current) => ({
        itemKey: connectedRunItemKey,
        result:
          current?.itemKey === connectedRunItemKey ? current.result : [],
        loading: false,
        error: "The connected run could not be launched. Check the local server and try again.",
      }));
    } finally {
      connectedMutationRef.current = false;
      setConnectedMutation(null);
    }
  }

  async function handleConnectedPermission(
    decision: "allow_once" | "keep_denied",
  ) {
    if (
      connectedMutationRef.current ||
      connectedExecute.mode !== "permission"
    ) {
      return;
    }
    connectedMutationRef.current = true;
    setConnectedMutation(
      decision === "allow_once" ? "allowing_once" : "keeping_denied",
    );

    try {
      const response = await fetch(
        `/api/portfolio/work-items/${encodeURIComponent(item.source_id)}/${encodeURIComponent(goal.work_item_id)}/mission/connected/permission`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            connected_run_id: connectedExecute.permission.operation.connected_run_id,
            operation_sha256:
              connectedExecute.permission.operation.operation_sha256,
            decision,
          }),
        },
      );
      const body = (await response.json()) as
        | PortfolioWorkItem
        | MutationErrorResponse;
      if (!response.ok) {
        setConnectedRunState((current) => ({
          itemKey: connectedRunItemKey,
          result:
            current?.itemKey === connectedRunItemKey ? current.result : [],
          loading: false,
          error:
            "error" in body
              ? body.error?.message ?? "The permission decision could not be recorded."
              : "The permission decision could not be recorded.",
        }));
        return;
      }

      markConnectedRunsLoading();
      await loadConnectedRuns();
      onUpdated(
        body as PortfolioWorkItem,
        decision === "allow_once"
          ? "Exact permission allowed once; a fresh Execute attempt is ready."
          : "Exact permission remains denied.",
      );
    } catch {
      setConnectedRunState((current) => ({
        itemKey: connectedRunItemKey,
        result:
          current?.itemKey === connectedRunItemKey ? current.result : [],
        loading: false,
        error: "The permission decision could not be recorded. Check the local server and try again.",
      }));
    } finally {
      connectedMutationRef.current = false;
      setConnectedMutation(null);
    }
  }

  const transitionActions = boardTransitionActionsForPhase(state.phase);
  const displayedNextAction =
    patchWorkflowNextAction(patchAttention) ?? nextActionForPhase(state.phase);
  const goalContractFields: Array<[string, string[] | undefined]> = [
    ["Acceptance criteria", goalContract?.acceptance_criteria],
    ["Non-goals", goalContract?.non_goals],
    ["Allowed scope", goalContract?.allowed_scope],
    ["Review-ready checks", goalContract?.review_ready],
  ];
  const goalContractContent = (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <h3 id={`${fieldId}-goal-contract`} className="text-xs font-medium">
          Goal contract
        </h3>
        <p className="text-[11px] text-muted-foreground">
          Version {goalContract?.goal_version ?? "not set"}
        </p>
      </div>
      <dl className="mt-3 space-y-4 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Purpose</dt>
          <dd className="mt-1">
            {goalContract?.purpose ?? (
              <span className="text-muted-foreground">Not recorded.</span>
            )}
          </dd>
        </div>
        {goalContractFields.map(([label, values]) => (
          <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1">
              {values !== undefined && values.length > 0 ? (
                <ul className="list-disc space-y-1 pl-4">
                  {values.map((value, index) => (
                    <li key={`${value}-${index}`}>{value}</li>
                  ))}
                </ul>
              ) : (
                <span className="text-muted-foreground">Not recorded.</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
  const workItemEditor = canEditGoalContract ? (
    <form onSubmit={(event) => void handleSave(event)} className="space-y-4 border-t pt-5">
      <div>
        <label htmlFor={`${fieldId}-project`} className="mb-2 block text-xs font-medium">
          Project
        </label>
        <select
          id={`${fieldId}-project`}
          value={targetSourceId}
          disabled={goalContract !== undefined}
          onChange={(event) => setTargetSourceId(event.target.value)}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-70"
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
        <label htmlFor={`${fieldId}-title`} className="mb-2 block text-xs font-medium">Current title</label>
        <input id={`${fieldId}-title`} value={title} onChange={(event) => setTitle(event.target.value)} required className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={`${fieldId}-type`} className="mb-2 block text-xs font-medium">Work type</label>
          <select id={`${fieldId}-type`} value={type} onChange={(event) => setType(event.target.value as WorkItemType | "")} className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary">
            <option value="">Unclassified</option>
            {WORK_ITEM_TYPES.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${fieldId}-priority`} className="mb-2 block text-xs font-medium">Priority</label>
          <select id={`${fieldId}-priority`} value={priority} onChange={(event) => setPriority(event.target.value as WorkItemPriority | "")} className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary">
            <option value="">Not set</option>
            {WORK_ITEM_PRIORITIES.map((option) => <option key={option} value={option} className="capitalize">{option[0]?.toUpperCase()}{option.slice(1)}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor={`${fieldId}-tags`} className="mb-2 block text-xs font-medium">Tags</label>
        <input id={`${fieldId}-tags`} value={tags} onChange={(event) => setTags(event.target.value)} placeholder="Question, Front-end" className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none placeholder:text-[#7f8794] focus:border-primary focus:ring-1 focus:ring-primary" />
      </div>
      <div>
        <label htmlFor={`${fieldId}-notes`} className="mb-2 block text-xs font-medium">Context</label>
        <textarea id={`${fieldId}-notes`} value={notes} onChange={(event) => setNotes(event.target.value)} rows={5} className="w-full resize-y rounded-md border bg-background px-3 py-2.5 text-sm leading-5 outline-none focus:border-primary focus:ring-1 focus:ring-primary" />
      </div>
      <section aria-labelledby={`${fieldId}-goal-contract`} className="space-y-4 border-t pt-5">
        <div>
          <h3 id={`${fieldId}-goal-contract`} className="text-xs font-medium">Goal contract</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">Complete every field to govern this item. Keep list entries one per line.</p>
        </div>
        <div>
          <label htmlFor={`${fieldId}-purpose`} className="mb-2 block text-xs font-medium">Purpose</label>
          <input id={`${fieldId}-purpose`} value={purpose} onChange={(event) => setPurpose(event.target.value)} className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary" />
        </div>
        <div>
          <label htmlFor={`${fieldId}-acceptance-criteria`} className="mb-2 block text-xs font-medium">Acceptance criteria</label>
          <textarea id={`${fieldId}-acceptance-criteria`} value={acceptanceCriteria} onChange={(event) => setAcceptanceCriteria(event.target.value)} rows={4} className="w-full resize-y rounded-md border bg-background px-3 py-2.5 text-sm leading-5 outline-none focus:border-primary focus:ring-1 focus:ring-primary" />
        </div>
        <div>
          <label htmlFor={`${fieldId}-non-goals`} className="mb-2 block text-xs font-medium">Non-goals</label>
          <textarea id={`${fieldId}-non-goals`} value={nonGoals} onChange={(event) => setNonGoals(event.target.value)} rows={3} className="w-full resize-y rounded-md border bg-background px-3 py-2.5 text-sm leading-5 outline-none focus:border-primary focus:ring-1 focus:ring-primary" />
        </div>
        <div>
          <label htmlFor={`${fieldId}-allowed-scope`} className="mb-2 block text-xs font-medium">Allowed scope</label>
          <textarea id={`${fieldId}-allowed-scope`} value={allowedScope} onChange={(event) => setAllowedScope(event.target.value)} rows={3} className="w-full resize-y rounded-md border bg-background px-3 py-2.5 text-sm leading-5 outline-none focus:border-primary focus:ring-1 focus:ring-primary" />
        </div>
        <div>
          <label htmlFor={`${fieldId}-review-ready`} className="mb-2 block text-xs font-medium">Review-ready checks</label>
          <textarea id={`${fieldId}-review-ready`} value={reviewReady} onChange={(event) => setReviewReady(event.target.value)} rows={3} className="w-full resize-y rounded-md border bg-background px-3 py-2.5 text-sm leading-5 outline-none focus:border-primary focus:ring-1 focus:ring-primary" />
        </div>
      </section>
      <div className="flex justify-end">
        <button type="submit" disabled={saving || (!detailsDirty && !assignmentDirty && !contractDirty) || title.trim().length === 0 || (hasContractInput && !contractComplete) || (goalContract === undefined && hasContractInput && targetSourceId === INBOX_SOURCE_ID)} className="h-9 rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50">
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  ) : null;

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

            {workItemEditor}

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
                  {workItemEditor}
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
                    <p className="mt-1 text-sm font-medium">{displayedNextAction}</p>
                  </section>

                  <section
                    aria-labelledby={`${fieldId}-goal-contract`}
                    className="border-y py-4"
                  >
                    {goalContractContent}
                  </section>

                  <ConnectedExecuteSection
                    fieldId={fieldId}
                    projection={connectedExecute}
                    runs={connectedRuns}
                    loading={connectedRunsLoading}
                    error={connectedRunsError}
                    modelOverride={connectedModelOverride}
                    mutation={connectedMutation}
                    onModelOverrideChange={setConnectedModelOverride}
                    onLaunch={() => void handleLaunchConnectedRun()}
                    onAllowOnce={() =>
                      void handleConnectedPermission("allow_once")
                    }
                    onKeepDenied={() =>
                      void handleConnectedPermission("keep_denied")
                    }
                  />

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
                              onClick={() =>
                                void handleCopyLaunchInstruction(
                                  missionCompilation,
                                  missionItemKey,
                                )
                              }
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

                  <PatchWorkflowSection
                    fieldId={fieldId}
                    projection={patchAttention}
                    patchCycle={state.patch_cycle ?? null}
                    mutation={patchMutation}
                    compilation={patchMissionCompilation}
                    importedEvidence={patchMissionImport}
                    copied={copiedMissionKey === patchMissionItemKey}
                    onAcceptPatchPlan={() => void handleAcceptPatchPlan()}
                    onCompilePatch={() => void handleCompilePatchMission()}
                    onImportPatch={() => void handleImportPatchResult()}
                    onCopyLaunchInstruction={() => {
                      if (patchMissionCompilation !== null) {
                        void handleCopyLaunchInstruction(
                          patchMissionCompilation,
                          patchMissionItemKey,
                        );
                      }
                    }}
                  />

                  {reviewEligible && appliedReviewSubject ? (
                    <section
                      aria-labelledby={`${fieldId}-review-handoff`}
                      className="border-y py-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3
                            id={`${fieldId}-review-handoff`}
                            className="text-xs font-medium"
                          >
                            Review handoff
                          </h3>
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            Assess the pinned {appliedReviewSubject.evidence.phase} result without editing files or rerunning checks.
                          </p>
                        </div>
                        <span className="shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
                          Read only
                        </span>
                      </div>

                      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-y py-3 text-[11px]">
                        <div>
                          <dt className="text-muted-foreground">Subject commit</dt>
                          <dd
                            className="mt-0.5 truncate"
                            title={appliedReviewSubject.evidence.result_commit ?? undefined}
                          >
                            {appliedReviewSubject.evidence.result_commit?.slice(0, 12) ??
                              "Unavailable"}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground capitalize">
                            {appliedReviewSubject.evidence.phase} mission
                          </dt>
                          <dd
                            className="mt-0.5 truncate"
                            title={appliedReviewSubject.evidence.mission_content_sha256}
                          >
                            {appliedReviewSubject.evidence.mission_content_sha256.slice(
                              0,
                              12,
                            )}
                          </dd>
                        </div>
                        <div className="col-span-2">
                          <dt className="text-muted-foreground">Immutable mission</dt>
                          <dd className="mt-0.5 break-all leading-5">
                            {`.founder/missions/${goal.work_item_id}/${appliedReviewSubject.evidence.phase}-${appliedReviewSubject.evidence.identity.goal_version}-${appliedReviewSubject.evidence.identity.input_revision}-${appliedReviewSubject.evidence.identity.attempt}${appliedReviewSubject.evidence.phase === "patch" ? `-${appliedReviewSubject.evidence.identity.patch_cycle}` : ""}/mission.json`}
                          </dd>
                        </div>
                        <div className="col-span-2">
                          <dt className="text-muted-foreground">Immutable evidence</dt>
                          <dd className="mt-0.5 break-all leading-5">
                            {appliedReviewSubject.summary.evidence_path}
                          </dd>
                        </div>
                      </dl>

                      <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-xs leading-5">
                        <input
                          type="checkbox"
                          checked={reviewAttested}
                          onChange={(event) =>
                            setReviewAttestationState({
                              itemKey: reviewMissionItemKey,
                              checked: event.target.checked,
                            })
                          }
                          className="mt-0.5 size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                        />
                        <span>
                          I attest that this reviewer is independent from the execute writer.
                        </span>
                      </label>

                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={reviewBusy || !reviewAttested}
                          onClick={() => void handleCompileReviewMission()}
                          className="h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {compilingReviewMission
                            ? "Compiling…"
                            : "Compile review mission"}
                        </button>
                        <button
                          type="button"
                          disabled={reviewBusy}
                          onClick={() => void handleImportReviewResult()}
                          className="h-9 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {importingReviewResult
                            ? "Importing…"
                            : "Import review findings"}
                        </button>
                      </div>

                      {reviewMissionImport ? (
                        <div
                          className={`mt-4 border-l-2 px-3 py-3 text-xs ${
                            reviewMissionImport.evidence.outcome === "applied"
                              ? "border-success bg-success/10"
                              : "border-destructive bg-destructive/10"
                          }`}
                          role="status"
                        >
                          <p className="font-medium">
                            {reviewMissionImport.evidence.outcome === "applied"
                              ? reviewMissionImport.result?.verdict === "findings"
                                ? `${reviewMissionImport.result.findings.length} review finding${reviewMissionImport.result.findings.length === 1 ? "" : "s"} imported`
                                : "Clean review imported"
                              : "Review import rejected"}
                          </p>
                          <p className="mt-1 leading-5 text-muted-foreground">
                            Workflow state remains Review · Active.
                          </p>
                        </div>
                      ) : null}

                      {reviewMissionCompilation ? (
                        <div className="mt-4 border-l-2 border-border bg-background px-3 py-3">
                          <dl className="space-y-3 text-xs">
                            <div>
                              <dt className="text-muted-foreground">TASK.md</dt>
                              <dd className="mt-1 break-all leading-5">
                                {reviewMissionCompilation.task_path}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-muted-foreground">Mission JSON</dt>
                              <dd className="mt-1 break-all leading-5">
                                {reviewMissionCompilation.mission_path}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-muted-foreground">Package hash</dt>
                              <dd className="mt-1 break-all text-[11px] leading-5">
                                {reviewMissionCompilation.mission.content_sha256}
                              </dd>
                            </div>
                          </dl>
                          <div className="mt-4 flex items-center gap-3">
                            <button
                              type="button"
                              onClick={() =>
                                void handleCopyLaunchInstruction(
                                  reviewMissionCompilation,
                                  reviewMissionItemKey,
                                )
                              }
                              className="h-9 rounded-md border bg-secondary px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                            >
                              Copy review instruction
                            </button>
                            <span
                              className="text-[11px] text-muted-foreground"
                              role="status"
                              aria-live="polite"
                            >
                              {copiedMissionKey === reviewMissionItemKey
                                ? "Copied"
                                : ""}
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
