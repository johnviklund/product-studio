# Worklog

A bounded, rolling, newest-first index of what was built or changed. This is a pointer, not a
source of truth — git is the source of truth for *what* changed; `PRODUCT.md`/`DESIGN.md`/
`AGENTS.md` own *what we're building*. Capped at roughly 15 entries; oldest roll off (deleted,
not archived — they remain in git history).

## 2026-07-26 · Transport-neutral connected execution and run provenance (roadmap 3.3) · Copilot/Codex mixed
- Cut capability envelope v1 (exact-match, fail-closed command/URL evaluator; workspace writes
  unconditionally in-scope; narrowing + order-insensitive digest) and folded it into mission
  schema v5 as the immutable Execute mission's versioned envelope, covered by `content_sha256`,
  with v4/v3 read compatibility preserved. Added a structured `missing_permission` attention
  payload and permission-decision contracts, append-only connected-run records with a durable
  per-item launch guard/redaction/reconciliation, the pinned `@agentclientprotocol/sdk` runtime
  dependency, a provider-neutral ACP client core, and the Copilot reference runtime profile
  (preflighted model list, forbidden-argv guard, effective-model-from-observed-event only).
- Wired controller connected launch/permission-denial/allow-once mutations onto the existing
  lease/evidence-before-mutation shape, portfolio orchestration and four connected API routes,
  DetailPanel connected-run controls, the connected `missing_permission` Inbox recovery row, and
  a rebuildable connected-run summary cache projection.
- Verified: lint, typecheck, 349 tests, and production build pass. Phase 4 review (Claude Opus
  4.8, cross-vendor) found one **P0**: the Copilot profile's write classifier emitted an absolute
  path for in-workspace writes while the envelope schema required a relative one, so every
  in-workspace agent write was silently rejected — defeating the feature's core auto-allow
  guarantee, undetected because the producer and consumer were unit-tested with mismatched path
  shapes. Fixed (commit `995bf74`) with a real producer→consumer seam regression test; re-review
  clean. No live Copilot/ACP execution was run this cycle (Step 0 used a probe client); a live
  smoke test remains before this path is exercised against the real binary.
- Commits: `4c51ee0`..`995bf74`
- Why: let the founder launch a governed Execute step directly from Product Studio without
  copying prompts or result files, per ROADMAP 3.3.

## 2026-07-25 · Bounded patch loop and attention inbox (roadmap 3.2) · Copilot/Codex mixed
- Cut a clean state-v2 contract: required non-negative `patch_cycle` on governed items plus a
  discriminated `attention` record (7 kinds) pinning the current human decision's paths/commit/
  hashes; agent-reported cost/model fields are schema-rejected. v1 durable state upgrades on
  read (`patch_cycle: 0`); no write-time compat shim.
  Added `patch` to `MISSION_PHASES`/`WORK_ITEM_PHASES` with a `PatchMissionPackage` and a
  `ReviewSubject` execute|patch union; patch-subject re-reviews carry a canonical
  `finding_id → resolved|unresolved` resolution list that rejects unknown/missing/duplicate/
  reordered IDs.
- Added controller `acceptPatchPlan`/`importPatchResult` with the same lease/evidence-before-
  mutation/idempotent-replay shape as execute import, and extended review-result assessment to
  route deterministically: clean → `review_ready` (never completed); any unresolved assigned
  finding → immediate escalation; new findings → next bounded patch while `patch_cycle < 3`;
  a 4th cycle fails closed independently in both the router and `acceptPatchPlan`. A red patch
  import never consumes a cycle.
- Wired durable patch workspace/evidence dirs, a rebuildable cache projection (schema v5→v6),
  source-qualified patch/attention API routes, a patch handoff/attention board projection that
  folds `patch` into the existing Review column (no new column), DetailPanel patch-plan/
  escalation/review-ready controls, and a new cross-project attention inbox page
  (`app/inbox/page.tsx`) reachable from a real accessible nav link.
- Verified: lint, typecheck, 301 tests, and production build pass. Phase 4 review (Claude Opus
  4.8, cross-vendor) traced the cycle gate, evidence-before-mutation, and resolution-coverage
  guarantees against real code and found no P0–P2; one deferred P3 (`ambiguous_goal`/
  `missing_permission` attention kinds are wired but never produced this slice — no contract
  carries the trigger signal; tracked in `TODO.md`).
- Commits: 84c939a 0f1beb8 f17bd32 8172c98 426e13f bd09710 d6ce0e2 537e19a 30043d8 f7d6152 9ee41e3 22d8b36
- Why: delivers roadmap 3.2's bounded repair loop and the attention inbox together — the loop's
  real durable decisions (patch-plan approval, escalation, review-ready) now have both a
  three-cycle-bounded enforcement path and a dedicated cross-project surface to act on them.

## 2026-07-25 · Independent review mission and finding contract (roadmap 3.1) · Copilot/Codex mixed
- Added a phase-qualified v3 mission/result contract (`MissionPhase = "execute" | "review"`),
  advancing mission/result-contract to v3 and submission/evidence to v2 in lockstep; phase-prefixed
  `.founder/` paths so execute and review artifacts for one tuple never collide.
- Built an immutable applied-execute review-subject reader (fail-closed on 0/>1 matches, binds
  mission hash/git base/accepted commit/command evidence) and a strict discriminated review-result
  schema with typed findings (acceptance_criteria/non_goals/defect/security/deterministic_checks)
  verified against the exact pinned goal and command evidence.
- Added a lease-guarded, no-transition `importReviewResult`: evidence written before a
  state-preserving commit, no verification commands run, rejects on moved HEAD or a dirty
  non-`.founder` worktree, idempotent replay, lease released on every path — leaving
  `review`/`active` and `workflow-policy.ts` untouched.
- Wired source-qualified review eligibility/compile/import through the portfolio service, new
  `mission/review` + `mission/review/import` API routes, a fail-closed board review-handoff
  projection, and an attested DetailPanel review UI (verdict is display-only; no transition acts
  on it).
- Verified: lint, typecheck, 244 tests, and production build pass; Phase 4 review clean (no
  P0–P2, one wontfix P3, no patch plan required).
- Commits: 202fbd2 cf73f90 7fa485e 5b1084b e5f5ad0 47a1dc6 f516034 b15b476 740dfdf c80b9e6 a24eccf 1a82d25 e35fc91 2acb835
- Why: delivers roadmap 3.1's independent review loop — a reviewer can assess the exact accepted
  execute result and return structured findings without ever modifying the workspace or
  authorizing completion; 3.2 owns routing on those findings.

## 2026-07-24 · Clear goal contracts and unified card editing (roadmap 2.5) · Codex GPT-5.6
- Replaced the flat v1 goal contract with a strict v2 work-item goal and nested version-1 contract
  carrying purpose, acceptance criteria, non-goals, allowed scope, and review readiness. Lightweight
  captures remain contract-less; incomplete and cross-file-mismatched durable artifacts fail closed.
- Consolidated project, details, and optional contract changes into one source-qualified `/edit`
  save flow. The controller retains lease, exact-replay, and revision semantics; cross-source saves
  use the recoverable transfer journal and contracted items cannot be moved between projects.
- Updated missions, the board handoff gate, the SQLite v5 rebuildable cache, checked-in fixtures,
  and test fixtures to consume the nested contract consistently.
- Verified: lint, TypeScript, the full test suite, and production build pass. The initial build sandbox
  port-bind failure was environmental; the approved host rerun passed. Browser/visual QA was not
  run in this execution step.
- Commits: `8eb7c47` through `d666423`. Phase 4 review passed clean — ship as-is, no P0–P2
  findings (one cosmetic P3: empty leftover route dirs, not committed).

## 2026-07-23 · App-reachable goal contracts (roadmap 2.1 reachability) · Codex GPT-5.6 / Copilot Claude review
- Added a single editability policy `canUpdateGoalContract(phase)` (`src/domain/workflow-policy.ts`,
  true set exactly `idea|brainstorm|spec|plan`) and enforced it at the controller boundary:
  `WorkItemController.updateGoalContract` now throws a new `goal_contract_locked`
  `ControllerConflictError` as the first statement inside its lease `try`, so a locked-phase update
  releases its lease and writes no manifest/durable mutation; gated on the leased reread, not the
  pre-lock read.
- Exposed it app-side: `PortfolioService.updateGoalContract(sourceId, workItemId, input)`
  (source-qualified, 404 on unknown item, rebuild only after a successful mutation) behind a new
  node-runtime `PATCH .../goal-contract` route reusing the existing schema + `errorResponse` 409 mapping.
- Added a detail-panel goal-contract editor (`components/kanban/detail-panel.tsx`): one-per-line
  textareas for acceptance criteria / allowed scope / review-ready in capture mode and governed
  Overview for editable phases, read-only version + lists for locked phases; first activation omits
  expected versions, revisions send the displayed pair; dirty/saving guards, discard-confirm awareness,
  and `onUpdated` board refresh. Same predicate drives UI and controller, no UI-only duplicate.
- Verified: lint, typecheck, 205/205 tests, production build all green; Phase 4 review clean at
  `af5870c` (no P0–P2). Browser/visual QA still pending (no browser binding in this env — approved
  fallback, not claimed as done).
- Commits: 9d9ae2b 2d503d7 765f334 77eaf3d 8e89945 b8bc67d 9bbbdf5 4150412 4bd423b af5870c
- Why: `updateGoalContract` (roadmap 2.1) had no HTTP/UI caller, so every downstream Milestone 2
  surface was unreachable through the running app; this makes an assigned item drivable from a fresh
  contract into Execute without hand-calling the controller from a test.

## 2026-07-23 · Run evidence and history surface (roadmap 2.4)
- Added `ProductWorkspace.listImportEvidence(workItemId)`: a fail-closed, read-only durable
  listing across every historical mission identity for a work item — it enumerates only safe,
  non-symlink directories, reconstructs candidate identities/run-ids from directory names under
  a strict schema, and delegates to the existing private byte-authority reader so directory
  names are never trusted over file content (a misfiled or divergent evidence directory throws
  rather than producing a partial trustworthy-looking history).
- Exposed `PortfolioService.listImportEvidence(sourceId, workItemId)` (source-qualified,
  404 on unknown item, no lease/rebuild/mutation) and a bodyless node-runtime
  `GET .../run-evidence` route mapping `PortfolioWorkItemNotFoundError` → 404 and
  `InvalidWorkspaceError` → 422.
- Rendered an inline governed-overview `Run evidence` section in the detail panel: newest-first
  rows collapsed by default with an accessible disclosure control, a `Latest` marker on the
  newest row only, `Telemetry: unknown` presentation copy, and full command-record detail
  (argv, status, duration, exit/signal, truncation, pre-wrapped stdout/stderr) behind expansion;
  refreshes once after a successful import/repair, never polls, and a fetch failure leaves
  mission controls usable.
- Verified: lint, typecheck, 200/200 tests, and production build all green; Phase 4 review clean
  at `b8119bd` (no P0–P2, two P3s wontfixed as intentional trade-offs — fail-closed rejection of
  a stray non-directory entry, and locale-dependent tie-break sort with no correctness impact).
- Commits: 0eaef6a 9ed9cfa eaf8770 b1edef2 d61c22d b8119bd
- Why: completes roadmap 2.4's evidence/history surface so the founder can inspect a work item's
  full run provenance and outcome from the control panel without exposing raw tool detail on
  the board or trusting unvalidated directory structure.

## 2026-07-23 · Bounded verification runner timeout (roadmap 2.3, review patch cycle)
- Cross-vendor Phase 4 review of `NodeVerificationRunner` (external-result import,
  roadmap 2.3) found a confirmed P1: signaling only the direct child and resolving from
  `'close'` let an `npm run …` descendant that inherits stdout/stderr survive the kill and hold
  `'close'` open indefinitely, wedging the controller's on-disk lease permanently (no stale-lock
  reclaim) whenever a verified command spawned a hanging descendant.
- Fixed by spawning `detached: true` and killing the whole POSIX process group
  (`process.kill(-child.pid, signal)`, `ESRCH`-safe direct-child fallback) for both the SIGTERM
  and SIGKILL escalation, plus an unref'd `drainGraceMs` backstop timer that force-finishes
  timed-out evidence from already-captured buffers if `'close'` still hasn't fired — bounding
  total wall-clock to `timeout + killGrace + drainGrace` regardless of descendant behavior. The
  normal (non-timeout) completion path still resolves from `'close'` unchanged.
- Added a focused runner test (TERM-ignoring child with a stdout-inheriting descendant still
  resolves `timed_out` within budget) and a controller test (timed-out verification yields
  `execute/blocked` failed evidence and leaves no `.controller.lock`). Two P3 findings (compile
  fail-fast location, subdirectory `git diff --relative` reachability) were dispositioned as
  defer/confirm-intent and left untouched — not part of this patch.
- Verified: lint, typecheck, 196/196 tests, and production build all green; re-review at
  HEAD `f348592` confirmed clean (degraded same-vendor mode — the cross-vendor reviewer harness
  that found the original P1 was unavailable for the re-review only).
- Commits: 61553dd f348592
- Why: closes the ROADMAP 2.3 gap where an unbounded verification command could silently and
  permanently wedge a work item's controller lease across restarts, defeating the "bounded
  verification" guarantee the external-result-import feature depends on.

## 2026-07-22 · Provider-neutral mission compiler (roadmap 2.2)
- Added dependency-free `domain/mission.ts`: a strict `mission_schema_version: 1` Zod package
  (identity, controller-run provenance, full goal contract, versioned result contract) with a
  canonical fixed-field-order SHA-256 hash (stable across key reordering/reparse) and a
  deterministic `renderTaskMd` carrying no provider/CLI/clock terms.
- Extended the workspace with `findAppliedExecuteManifest` (enumerates safe `runs/*.json`,
  validates each, selects the single `execute`+`applied`+tuple match, raises `mission_not_ready`
  on duplicates/zero) and `writeMissionPackage` (atomic staged-`rename` write of immutable
  `.founder/missions/<item>/<goal>-<rev>-<attempt>/`, byte-exact replay on re-compile, fail-closed
  on partial/divergent/symlinked snapshots, with a TOCTOU re-check of the durable tuple).
- Added `PortfolioService.compileMission` — read-only against controller state (no lease,
  mutation, attempt bump, verification, import, transition, or index rebuild); a source-qualified
  `POST /api/portfolio/work-items/[sourceId]/[workItemId]/mission` returning 200 first + idempotent
  replay via the shared `errorResponse` (`mission_not_ready` → 409); and an eligibility-gated
  detail-panel handoff block (TASK.md/mission/workspace paths, hash, neutral copy-launch action).
- Verified: lint, typecheck, 142 tests (14 files), and production build pass; artifacts survive
  SQLite cache deletion. Phase 4 review clean at `0c10068` — no P0–P3 findings.
- Commits: 290f39a 25d58df 26a4095 c4e0134 7792844 c16159f 0c10068
- Why: delivers roadmap 2.2 — the same contracted work item can be handed to two external agent
  products from durable, hashed, provider-neutral artifacts, giving 2.3 a deterministic result
  location to import against without any state transition happening here.

## 2026-07-21 · Controller state and goal-contract foundation (roadmap 2.1)
- Added versioned work-item goal-contract schemas (`workItemGoalSchema` + aggregate
  `workItemSchema` `superRefine`) that fail closed on partial or cross-file-mismatched contracts;
  uncontracted items carry no controller state.
- Built lease-guarded controller transitions: `validateTransitionExpectations` +
  `validateWorkItemTransition` reject every `expected_*` mismatch (`contract_required`,
  `stale_expectation`, `invalid_transition`, `attempt_conflict`) before any write, with first
  activation at 1/1/0 and single-per-revision increment.
- Made applied-key replay idempotent (content-addressed `deriveControllerRunId`, `pending`
  manifest durable before mutation) and failure recovery compensated: a mid-write crash restores
  the prior leased goal+state, leaves an inspectable `failed` manifest, and leaks no
  `.controller.lock`/`.tmp`; concurrent lease attempts get `repair_required`.
- Extracted `domain/workflow-policy` as the single phase-transition matrix shared by board and
  controller (board keeps its column-aware reason strings); bumped the SQLite cache to schema v4
  (JSON-encoded controller arrays/`active_run`, no NULL-backed optional keys).
- Verified: lint, typecheck, 119 tests (13 files), and production build pass; Phase 4 review
  clean at `a7326fd` — no P0–P2 findings, three P3s deferred/wontfix as intentional 2.2/2.3
  forward scaffolding or out-of-scope per spec.
- Commits: 9ac50d2 a5d5072 cf00d16 9a5796d 87d7014 292f81e 236dbb3 51f615b a7326fd
- Why: delivers roadmap 2.1's controller-owned, versioned work state so transitions are validated
  against expected state and never guess a conflicting one — the foundation 2.2's mission
  compiler builds on.

## 2026-07-21 · Context panel, valid transitions, and keyboard flow (roadmap 1.5)
- Added pure board policy helpers (`detailPanelModeForItem`, `boardTransitionActionsForPhase`,
  `BoardTransitionAction`) so panel mode and the one displayed next transition are derived, not
  duplicated, across drag and panel paths.
- Built a reusable 410px `DetailPanel` with Todo-capture and governed modes, source-qualified
  capture mutations, governed tabs, and callback-only forward/back transitions; retired
  `capture-editor.tsx` into the panel's capture mode.
- Added roving-focus and keyboard callbacks (Arrow Up/Down navigate, Enter opens) to board cards,
  threaded through column-local ordering so boundary arrows are no-ops; every card now opens the
  shared `DetailPanel` from `kanban-board.tsx`, with `commitTransition` shared by drag and panel
  actions and a `transitionPending` guard added in the patch cycle to block duplicate in-flight
  transitions.
- Verified: lint, typecheck, 95 tests, and production build pass; Phase 4 review clean at
  `4dedf19` — P2 double-submit guard resolved and verified, P1 (Enter-opens-panel) **wontfix**
  by explicit product-owner descope (pointer/click remains the supported open path; the dnd-kit
  `KeyboardSensor`-vs-custom-Enter-handler collision is recorded and captured as a reviewer
  eval case), two P3 a11y/focus items deferred.
- Commits: ebf9422 ac5af25 6d69a1f 44dd491 a3e89bc 1a4596b 55005b3 54e0b3c 4dedf19
- Why: delivers roadmap 1.5's context-preserving detail panel and keyboard flow so a founder can
  inspect and progress a board item without losing filters or scroll position.

## 2026-07-21 · One-sentence capture and progressive exploration (roadmap 1.4)
- Added durable capture domain contracts (source, kind, optional tags/notes) and a dependency-free
  value-object module for source-ID validation to break a schema/aggregate circular import.
- Projected capture metadata into the cache (schema v2→v3), rehydrating without NULL-backed
  optional keys so untyped captures still pass strict validation.
- Added atomic capture workspace operations plus a recoverable, journaled cross-workspace
  transfer protocol (validate → stage → publish → remove-source) whose recovery inspects durable
  target state rather than trusting the journal stage alone, with a dedicated staging-discard
  repository primitive for unpublished rollback.
- Exposed source-qualified capture create/detail/assignment mutations over HTTP with mapped
  errors (`409` collision/transfer-failed, `400` bad body, `404` unknown source/item).
- Shipped `⌘N`/`Ctrl+N` one-sentence capture and a narrow refinement side panel with immutable
  provenance (original title/kind/captured-at) above editable metadata.
- Verified: lint, typecheck, 93 tests, and production build pass; Phase 4 review clean (no
  P0–P2, four deferred/wontfix P3s, no patch plan required).
- Commits: ace4a9a a8f7a76 525abf6 501aae5 174d231
- Why: delivers roadmap 1.4's fast, frictionless capture with safe recoverable project transfer,
  keeping the refinement surface intentionally narrow ahead of any future promotion/AI-shaping work.

## 2026-07-21 · Focused Kanban and project filtering (roadmap 1.3)
- Renamed the durable `explore` phase to `brainstorm` and added a shared, pure board module:
  seven-column projection, an adjacent-column transition policy, phase-derived next actions,
  composite `(source_id, work_item_id)` identity, and fail-closed board-view parsing — imported
  by both server and client so the policy cannot drift.
- Made portfolio projections source-qualified with a nullable project, added a durable
  `.portfolio/inbox` "Unassigned" source (atomic, never-overwrite manifest), and bumped the
  SQLite cache to schema v2 with a drop/recreate migration.
- Added an atomic, re-validated `state.json` phase-update seam (temp file + rename, goal
  untouched) and a source-qualified `PATCH` route with stable mapped errors (404 unknown
  source / 404 missing item / 409 invalid transition / 400 bad body).
- Built the `"use client"` Kanban over the local APIs: seven scrollable columns, all/one/multi/
  unassigned project filters, accessible `@dnd-kit` drag transitions with fail-closed recovery,
  and a versioned `localStorage` board view; aligned PRODUCT/DESIGN/ROADMAP and the archived PRD.
- Verified: lint, typecheck, 68 tests, and production build pass; delete-and-rebuild restores
  both project and inbox sources with identical composite identities; Phase 4 review clean
  (`.workflow/review.md`, no P0–P3). Live browser drag/filter/scroll unexercised (headless env).
- Commits: c80f3ea 3698751 000208e 809a6ad 668d284 f9e79ce d57e865 ecdfc2b 8d924e7 a818e3e f432ab1 d3f716e 15e3546 b481276 1fec11a
- Why: delivers roadmap 1.3's focused cross-project board so the founder can filter, move, and
  return to stable work across products without GitHub Projects or raw repository files.

## 2026-07-17 · Portfolio registration and rebuildable index (roadmap 1.2)
- Added a strict, atomically written v1 workspace registry as durable portfolio truth and kept
  invalid registrations visible for repair.
- Replaced the single-workspace cache with a versioned SQLite portfolio projection keyed by
  workspace and work-item IDs, with atomic full replacement and deterministic ordering.
- Added portfolio registration/rebuild coordination plus Node-runtime workspace and work-item
  routes, shared error envelopes, and removal of ambiguous single-workspace handlers.
- Verified all eight acceptance scenarios and reconstructed the same two-workspace projection
  after deleting the SQLite index using only registry and `.founder/` artifacts.
- Commits: e416789 203c556 c7759a7 5ef7bca 935a97e addb81b fc63456 3e17eea
- Why: completes roadmap 1.2's durable portfolio seam so the focused cross-project Kanban can
  build on registered workspaces without treating local cache state as truth.

## 2026-07-17 · Durable workspace foundation (roadmap 1.1)
- Defined the work-item domain contract and schema-versioned `.founder/` filesystem repository
  (goal.yaml + state.json as durable truth).
- Added a fully rebuildable SQLite index (never the source of truth) and an application service
  coordinating repository + index.
- Exposed the HTTP work-item contract (list/create/get/delete + rebuild route) and shipped a
  fixture, seed script, and minimal shell.
- Commits: b14922b 0df4128 2d375e5 f29e6bb 88ddb65 98b3c62 d93a37d
- Why: establishes the durable, rebuildable-index architecture roadmap phase 1.1 requires before
  any UI/board work can build on it.
