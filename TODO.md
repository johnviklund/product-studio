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
  *Pointer updated 2026-08-04 (ROADMAP 3.4 Slice 2): `PlanResultSubmission` now also carries
  `open_questions`, and the guided decision surfaces render unresolved questions without producing
  `ambiguous_goal` attention. This adds another candidate signal shape, not a producer — the item
  stays open.*

### Guard the 13 remaining unguarded mutating API routes

- **Status:** Deferred — fenced out of ROADMAP 3.4 Slice 2 by patch-cycle decision D6 (2026-08-05).
- **Idea:** Slice 2 introduced `assertTrustedRequestOrigin` (`src/application/request-origin.ts`)
  and applied it to every shaping POST through the route factory. A full enumeration of `app/api`
  during Phase 4 cycle 2 found it guards **26 of 42** mutating route files — **16 are unguarded**.
  Three (`mission/connected/{permission,launch,cancel}`) are in Slice 2's own diff and are closed by
  its patch plan Steps 9–11. The remaining **13 are pre-existing and untouched**:
  `[workItemId]/route.ts` PATCH (`updateWorkItemPhase` — cross-origin phase transitions),
  `[workItemId]/edit/` PATCH, `mission/{route,retry,import}`, `mission/patch{,/import}`,
  `mission/review{,/import}`, `patch-plan/`, `portfolio/work-items/` POST, `work-items/rebuild/`
  POST, and `workspaces/` POST (`register()` → `resolve(workspace_path)`, which makes Product Studio
  index an attacker-chosen directory and persist it to the registry). The exposure is reachable, not
  theoretical: those routes call bare `await request.json()`, which ignores `Content-Type`, so a
  cross-origin `<form method="POST" enctype="text/plain">` is a CORS *simple* request needing no
  preflight and no readable response; the app binds `127.0.0.1` (`next dev -H 127.0.0.1`), which a
  page in the founder's browser can reach. `work-items/rebuild` takes **no body at all**, so a bare
  auto-submitting form fires it.
- **Boundary:** Not a Slice 2 regression — nothing was guarded at Base `25b64f4`; `request-origin.ts`
  is new in that slice. Scope as one design pass, not a patch: route all 13 through a single shared
  factory carrying the origin check *and* a capped read, since each currently reads its body its own
  way. Two things ride along and should land in the same slice. First, those same 13 routes read
  **unbounded** bodies (`request.json()` with no cap) while `readCappedJsonRequest` exists and is
  used elsewhere — fix the cap and the origin check together, never the cap alone. Second,
  **D1's tripwire:** `readCappedJsonRequest` deliberately does *not* require a JSON `Content-Type`,
  which is safe only for as long as `assertTrustedRequestOrigin` fails closed on a missing `Origin`
  header; if that is ever relaxed to admit a non-browser client, the `Content-Type` gate becomes
  load-bearing and must land in the same change. Note also that `[workItemId]/route.ts` PATCH is the
  single enforcement point for the closed-transition policy (see the controller item below), so the
  two items are worth reading together.

### Enforce the dedicated-transition policy inside the controller

- **Status:** Deferred — blocked on a dedicated `plan → execute` operation (patch-cycle decision D2,
  2026-08-05; raised as a Phase 4 P2 and re-upheld in cycle 2).
- **Idea:** `WorkItemController.transition()` validates against `ALLOWED_PHASE_TRANSITIONS` only and
  never consults `dedicatedTransitionPolicy` (`src/domain/workflow-policy.ts:95`), whose only callers
  are `src/application/portfolio.ts:1096` and `src/presentation/board.ts:728`. So the closed-set rule
  is enforced one layer above the controller. AGENTS.md states "the controller owns transitions" and
  `transition()` is public, which means the immutability guarantee for a decided revision currently
  rests on every future caller remembering to go through the portfolio. Verified not exploitable as
  of 3.4 Slice 2: the only production path is `[workItemId]/route.ts` PATCH →
  `service.updateWorkItemPhase` → the guarded call at `portfolio.ts:1096-1107`.
- **Boundary:** Cannot be made green inside Slice 2, which is why it is deferred rather than small.
  The test setup helpers drive `["spec", "plan", "execute"]` straight through `controller.transition()`
  (`tests/api/portfolio-routes.test.ts:222`, `tests/application/work-item-controller.test.ts:264`,
  `tests/application/portfolio.test.ts:747`), and that chain contains both `spec → plan`
  (`dedicated_operation_required`) and `plan → execute` (`closed_in_slice`) — for which no legitimate
  replacement operation exists yet ("Execute approval is not part of this slice",
  `src/domain/workflow-policy.ts:73-76`). Enforcing it earlier means either inventing the Execute
  approval operation or weakening the test setups. Belongs to the slice that introduces a dedicated
  `plan → execute` operation; move the check into `transition()` there, rejecting
  `dedicated_operation_required` and `closed_in_slice`.

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
  *Pointer updated 2026-08-04 (ROADMAP 3.4 Slice 2): the guided shaping, monitoring, recovery, and
  decision surfaces substantially rewrote `detail-panel.tsx` again but still leave `tagsFromInput`
  and the free-text tags input untouched — this item still applies as written.*

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
