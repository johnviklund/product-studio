# Product Studio TODO

This is the human's workflow-managed intake scratchpad, not a roadmap. Use `workflow todo`
to capture, shape, merge, update, or archive future work; `ROADMAP.md` owns the initial
delivery phases.

## Active Initiatives

### Connected model configuration settings page

- **Status:** Proposed.
- **User story:** As the founder running Product Studio locally, I want a settings page where I
  can configure and persist the connected Copilot runtime profile (executable, model, reasoning
  effort, tool policy), so I don't have to hand-craft and export a
  `PRODUCT_STUDIO_COPILOT_RUNTIME_PROFILE_JSON` env var and restart the dev server every time I
  want connected shaping/execute runs available.
- **Purpose:** Today the only way to enable connected mode is manually constructing a JSON blob
  for `PRODUCT_STUDIO_COPILOT_RUNTIME_PROFILE_JSON` (schema in
  `src/application/portfolio-service.ts`) by hand, including undocumented details — required tool
  names (`apply_patch`, `view`) and environment allowlist entries (`PATH`) — and restarting
  `npm run dev`. This was real, measured friction: getting Copilot CLI connected during a
  2026-08-05 session took significant trial and error (guessing model IDs, tool names, required
  env keys) even with full codebase access.
- **Definition of done:** A settings page persists the runtime profile durably (not just an env
  var) — executable path/version, auth status, default model, reasoning effort, available/excluded
  tools, environment allowlist — validated against the existing `copilotRuntimeProfileSchema`
  shape (or its durable-storage equivalent), and takes effect without a full dev-server restart.
  The page auto-discovers which model IDs the configured Copilot CLI/account can actually use,
  and surfaces preflight status (executable found, authenticated, model reachable) inline.
- **Boundary:** Scope to the existing single-adapter (Copilot ACP) profile — no multi-provider
  picker, no credential-inheritance changes, no new adapter. Model discovery only needs to surface
  IDs this CLI/account can use, not a cross-vendor catalog.
- *Pointer updated 2026-08-05 (ROADMAP 3.4 Slice 2): `ConnectedExecuteRuntime` gained a
  `configuration()` surface symmetric with the shaping runtime's — the per-runtime preflight shape
  (executable found, authenticated, model reachable) this item's definition of done would read.
  Groundwork only; durable config replacing the env var and model auto-discovery are untouched —
  the item stays open as written.*
  *Pointer updated 2026-08-09 (ROADMAP 3.4 Slice 3, commits `ce9c4d7`–`2c5dd19`): the Review
  connected runtime adds a second, independent `configuration()` preflight surface, and the guided
  decision surfaces now expose per-seat preflight state and model-picker options over a route for
  the first time — closer to this item's "surfaces preflight status inline" bar, but still
  read-only groundwork. Durable config replacing
  `PRODUCT_STUDIO_COPILOT_RUNTIME_PROFILE_JSON` and model auto-discovery remain untouched — the
  item stays open as written.*

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
  *Pointer updated 2026-08-05 (ROADMAP 3.4 Slice 2 wrap): the Plan approval decision surface now
  also reaches an approval gate (`Approve & run Execute`) without consuming `open_questions` into
  an `ambiguous_goal` attention. Same candidate-signal-shape situation, one more surface — the item
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
  load-bearing and must land in the same change.
  *Pointer updated 2026-08-05 (ROADMAP 3.4 Slice 2 wrap): the note that `[workItemId]/route.ts`
  PATCH is "the single enforcement point for the closed-transition policy" is now stale —
  `WorkItemController.transition()` enforces `dedicated_operation_required`/`closed_in_slice`
  directly (see the delivered controller item in Archived), so that route is no longer the sole
  point of truth for the closed-transition rule. The origin-guard and unbounded-body findings above
  are unaffected; only the cross-reference changes.*

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
  *Pointer updated 2026-08-05 (ROADMAP 3.4 Slice 2 wrap): the Plan approval decision surface added
  to `detail-panel.tsx` again without touching `tagsFromInput` or the tags input — this item still
  applies as written.*

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

### Enforce the dedicated-transition policy inside the controller

- **Status:** Delivered — ROADMAP 3.4 Slice 2 (commits `54de9de`–`874d7c0`). Step 9 moved the
  `dedicated_operation_required`/`closed_in_slice` enforcement from the portfolio layer directly
  into `WorkItemController.transition()`, rewriting the three test setup helpers that previously
  drove transitions straight past it (`tests/api/portfolio-routes.test.ts`,
  `tests/application/work-item-controller.test.ts`, `tests/application/portfolio.test.ts`). The
  controller is now the single enforcement point named in AGENTS.md, not `portfolio.ts`.

### Wire the `missing_permission` attention decision (connected Execute half)

- **Status:** Delivered — ROADMAP 3.3 (commits `4c51ee0`–`995bf74`). Connected Execute's ACP
  adapter now produces a structured `missing_permission` attention for an exact,
  adapter-observed, out-of-envelope operation (`recordConnectedPermissionDenial`), surfaced
  read-only in the existing Inbox/DetailPanel recovery surfaces with "allow once and retry" /
  "keep denied" decisions bound to the exact operation hash. This was the half of the original
  combined item scoped to connected Execute; the `ambiguous_goal` half remains open above.
