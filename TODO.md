# Product Studio TODO

This is the human's workflow-managed intake scratchpad, not a roadmap. Use `workflow todo`
to capture, shape, merge, update, or archive future work; `ROADMAP.md` owns the initial
delivery phases.

## Active Initiatives

## Deferred Initiatives

### Wire the `ambiguous_goal` attention decision

- **Status:** Deferred — needs a new result-contract field, out of ROADMAP 3.3's scope.
- **Idea:** ROADMAP 3.2 defines all 8 attention decision kinds in the schema (`work-item.ts`) and
  wires all 8 into the board projection switch (`board.ts`); ROADMAP 3.3 added a producer for
  `missing_permission` (connected Execute's adapter-observed out-of-envelope denial — see
  Archived). `ambiguous_goal` still has no producer: no result or import contract carries a
  "missing required clarification" signal, so a genuinely ambiguous goal currently surfaces as a
  generic rejected-import error instead of its dedicated, human-answerable inbox row (Phase 4
  review, 2026-07-25, P3, disposition: defer).
- **Boundary:** Needs a new result-contract field for an agent to report required clarification.
  Scope narrowly when picked up.
  *Pointer updated 2026-07-28 (ROADMAP 3.4 Slice 1): `BrainstormResultSubmission` (`src/domain/shaping.ts`)
  now carries an `open_questions` field, confined to the shaping contract and not wired to any
  attention production (spec's non-goals excluded that). This is a candidate producer shape, not a
  fix — the item stays open.*

## Small UI Changes

- **Replace the free-text tags box with a token/chip picker (capture panel + editor).**
  Tags are currently entered as a comma-separated text field (`parseTags` in
  `components/kanban/capture-panel.tsx`, `tagsFromInput` in `components/kanban/detail-panel.tsx`'s
  capture mode) that splits on commas but does not dedupe. The server rejects case-insensitive
  duplicate tags (`tagsSchema` in `src/domain/work-item.ts`), and that rejection surfaces only as
  a generic `400 "Invalid request"` (review P3 #1, 2026-07-21) with no hint that tags are the
  cause. Move to an explicit token/chip input (ideally suggesting existing tags) that dedupes
  case-insensitively on the client and shows a clear inline message — removing the last spot
  where free text is parsed into structure. Small and isolated; not urgent. *Pointer updated
  2026-07-21 (ROADMAP 1.5): `capture-editor.tsx` was deleted and its capture-mode field folded
  into `detail-panel.tsx`; this item was deliberately not folded into 1.5 (spec scoped the chip
  picker out) — the free-text behavior was preserved as-is. Pointer updated 2026-07-24 (ROADMAP 2.5): the
  unified `/edit` save flow rewrote `detail-panel.tsx`'s save handlers but left `tagsFromInput`
  and the free-text tags input untouched — this item still applies as written. Pointer updated
  2026-07-26 (ROADMAP 3.3): the connected-run surface added ~500 lines to `detail-panel.tsx` but
  did not touch `tagsFromInput` or the free-text tags input (spec explicitly scoped tag-chip work
  out) — this item still applies as written. Pointer updated 2026-07-28 (ROADMAP 3.4 Slice 1): the
  shaping section adds to `components/kanban/detail-panel.tsx`'s capture mode but deliberately
  leaves `tagsFromInput` and the free-text tags input untouched (spec's non-goals scoped
  card-metadata editing out of the slice) — this item still applies as written.*

## Open Questions

## Archived

### Enforce writer/reviewer model independence for review missions

- **Status:** Roadmap-owned — superseded by ROADMAP 4.1.
- **Resolution:** ROADMAP 4.1 introduces a shared run-actor provenance contract and enforces exact
  writer/reviewer model separation only when the identity source is trustworthy enough to fail
  closed. Fully manual/BYOA runs retain human independence attestation rather than promoting
  self-reported identity to fact.

### Implement Multi-Agent AG-UI Kanban Orchestrator

- **Status:** Roadmap-owned — the validated connection need is superseded by ROADMAP 4.1.
- **Resolution:** Preserve a provider-neutral JSON connection boundary that can use a CLI or
  another approved local transport and begin with one evidence-selected adapter. MCP is unsupported
  and explicitly out of scope for every adapter. The exported vendor list, AG-UI framework choice,
  live reasoning/terminal stream, token-budget manager, automatic model selection, and board-driven
  provider orchestration were inspiration rather than accepted product direction and are not
  roadmap commitments.

### Price per task metric

- **Status:** Roadmap-owned — merged into ROADMAP 6.3.
- **Resolution:** Quality and deterministic review remain eligibility gates. Among eligible
  outcomes, total cost per successfully completed task, including retries, is the primary
  efficiency metric and time to successful completion is the second.

### Add an Inbox page for review and approvals

- **Status:** Delivered — superseded by ROADMAP 3.2 (commits `84c939a`–`22d8b36`). The
  cross-project attention inbox (`app/inbox/page.tsx`, `listAttention()`) ships this as an
  alternate view over durable workflow state/evidence, per the original boundary.

### Wire the `missing_permission` attention decision (connected Execute half)

- **Status:** Delivered — ROADMAP 3.3 (commits `4c51ee0`–`995bf74`). Connected Execute's ACP
  adapter now produces a structured `missing_permission` attention for an exact,
  adapter-observed, out-of-envelope operation (`recordConnectedPermissionDenial`), surfaced
  read-only in the existing Inbox/DetailPanel recovery surfaces with "allow once and retry" /
  "keep denied" decisions bound to the exact operation hash. This was the half of the original
  combined item scoped to connected Execute; the `ambiguous_goal` half remains open above.
