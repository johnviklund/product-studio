# Product Studio TODO

This is the human's workflow-managed intake scratchpad, not a roadmap. Use `workflow todo`
to capture, shape, merge, update, or archive future work; `ROADMAP.md` owns the initial
delivery phases.

## Active Initiatives

### Compile the mission package that a tuple-advancing transition points at

- **Status:** Proposed — defect, found 2026-08-09 running a live connected cycle.
- **Idea:** Transitions that advance the governed tuple rewrite `goal`/`state` but never compile
  the mission package for the new tuple, so the very next controller call resolves a directory
  that does not exist. Observed twice in one cycle on `wi_b9b852f6` ("Close project menu"):
  `applyScopeCorrection` bumped `2-2-0` and left `.founder/missions/.../execute-2-2-0` missing, and
  `decideCommandAuthorization` (`allow_once`) bumped `attempt` to 1 and left `execute-2-2-1`
  missing. Both surfaced to the founder as a raw
  `invalid_workspace: required directory is missing` with an `.founder/...` artifact path — no
  recovery affordance, no hint that "Compile mission" is the unblock.
- **Purpose:** Each occurrence dead-ends the founder mid-cycle on an error that names an internal
  path rather than an action. `commandAuthorizationPreflightEligible`'s `correctedExecuteRestart`
  branch deliberately makes the preflight eligible right after a scope correction, so the app
  routes the founder straight into the call that cannot succeed yet.
- **Definition of done:** A tuple-advancing transition either compiles the package for the tuple it
  commits, in the same lease, or the resolve failure raises a typed controller conflict carrying
  the recovery action instead of a workspace error. No founder-visible path leaks an
  `invalid_workspace` artifact path as its only guidance.
- **Boundary:** Scope to the transitions that already advance the tuple (scope correction, command
  authorization, attempt retry). Not a redesign of mission compilation, and not the broader
  step-count reduction tracked below.

### Reduce founder step count with supervised auto-recovery

- **Status:** Proposed — direction, not yet scoped.
- **User story:** As the founder, I want the workflow to carry an item forward on its own and ask
  me only for the decisions that genuinely need human authority, so that a single idea does not
  cost me a chain of small mechanical clicks and hand-diagnosed errors.
- **Purpose:** Measured on one real cycle (2026-08-09, "Close project menu"): reaching a committed
  implementation required the founder to hit a scope correction, a command preflight, a command
  authorization, two mission compilations, and a launch — plus two dead-end errors that needed
  source-level diagnosis to interpret. Most of those steps carried no human judgment; they were
  the controller asking the founder to perform its own bookkeeping. The steps that *did* need a
  human — approving exact commands, approving scope — were buried among the mechanical ones, which
  is the opposite of the intended "human authority is preserved where it matters" shape.
- **Definition of done:** A supervised recovery path advances an item through mechanically-implied
  next steps (compile the package a committed tuple implies, re-derive a stale proposal, resume a
  terminal run that produced no result) without founder action, while every capability, scope, and
  completion gate stays an explicit human decision. The founder-facing surface distinguishes "I am
  waiting on you" from "I am working", and never asks the founder to perform a step the controller
  could have taken itself.
- **Boundary:** Recovery only — it may not approve commands, widen scope, accept a result, or set an
  item to `completed`. Those remain human-only gates per AGENTS.md. Explicitly not an autonomous
  agent that decides product direction; the open design question is whether this is controller
  logic or a distinct orchestrator role, and that should be settled before scoping.

### Bound scope correction to the item, and freeze the tuple during a live run

- **Status:** Proposed — defect, found 2026-08-09 during the same live cycle.
- **Idea:** Two coupled failures observed on `wi_b9b852f6`. First, the scope-correction proposal is
  derived from the **entire retained worktree** (`listWorktreeChangedFilesExcludingFounder`), so any
  dirty file — including one edited by a human or a different tool, with no relationship to the work
  item — is proposed into that item's `allowed_scope` and written into its goal contract. In this
  cycle an unrelated `TODO.md` edit was absorbed into the goal contract of a UI work item. Second,
  the correction was applied **while a connected run was executing**: it bumped the tuple from
  `2-2-1` to `3-3-0` 90 seconds into the run, so when the run terminated `missing_permission`, its
  governed tuple no longer matched state and the denial was **silently discarded** — no attention,
  no surfaced command to approve, and the capability grant was reset because it was bound to the
  superseded mission.
- **Purpose:** Together these let an unrelated edit rewrite a work item's goal contract *and*
  destroy the outcome of an in-flight run, leaving the founder with a card that looks idle and no
  record of what the agent actually needed. It also silently widens the scope an agent is permitted
  to write to, which is a governance boundary, not a convenience.
- **Definition of done:** Scope-correction proposals only consider paths plausibly attributable to
  the work item's own run, and never absorb a path solely because it is dirty. A tuple-advancing
  transition is refused, or explicitly quarantined, while a connected run holds the tuple it would
  supersede; a terminal run whose tuple was superseded still records its outcome somewhere the
  founder can see rather than being dropped.
- **Boundary:** Not a change to what the founder may approve — widening scope stays a human
  decision. The fix is *which paths get proposed* and *when a transition may fire*, not who
  authorizes it.

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
