"use client";

import type { ApproveReviewResultInput } from "@/src/domain/work-item";
import type { PatchAttentionProjection } from "@/src/presentation/board";

export type ReviewReadyProjection = Extract<
  PatchAttentionProjection,
  { mode: "review_ready" }
>;

export function shortEvidencePath(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length <= 4) {
    return path;
  }
  return `…/${segments.slice(-4).join("/")}`;
}

export function reviewApprovalRequest(
  sourceId: string,
  workItemId: string,
  approval: ApproveReviewResultInput,
) {
  return {
    route: `/api/portfolio/work-items/${encodeURIComponent(sourceId)}/${encodeURIComponent(workItemId)}/mission/review/approve`,
    init: {
      method: "POST" as const,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(approval),
    },
  };
}

export function ReviewReadyDecisionSection({
  fieldId,
  projection,
  pending,
  onApprove,
}: {
  fieldId: string;
  projection: ReviewReadyProjection;
  pending: boolean;
  onApprove: () => void;
}) {
  return (
    <section
      aria-labelledby={`${fieldId}-review-decision`}
      className="border-y py-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id={`${fieldId}-review-decision`} className="text-xs font-medium">
            Review ready
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Confirm the independent clean Review before moving this exact
            result into Ship.
          </p>
        </div>
        <span className="shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
          Human gate
        </span>
      </div>

      <div className="mt-3 border-l-2 border-success bg-success/10 px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-medium">{projection.result.summary}</p>
          <span className="shrink-0 text-[10px] font-medium tracking-[0.06em] text-success uppercase">
            Clean
          </span>
        </div>
        <dl className="mt-3 grid gap-2 text-[11px]">
          <div>
            <dt className="text-muted-foreground">Subject commit</dt>
            <dd
              className="mt-0.5 font-mono"
              title={projection.result.accepted_result_commit}
            >
              {projection.result.accepted_result_commit.slice(0, 12)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Applied evidence</dt>
            <dd
              className="mt-0.5 break-all leading-5"
              title={projection.result.evidence_path}
            >
              {shortEvidencePath(projection.result.evidence_path)}
            </dd>
          </div>
        </dl>
      </div>

      <button
        type="button"
        data-action-priority="primary"
        disabled={pending}
        onClick={onApprove}
        className="mt-3 h-10 rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Approving…" : "Approve result"}
      </button>
    </section>
  );
}
