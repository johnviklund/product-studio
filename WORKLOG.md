# Worklog

A bounded, rolling, newest-first index of what was built or changed. This is a pointer, not a
source of truth — git is the source of truth for *what* changed; `PRODUCT.md`/`DESIGN.md`/
`AGENTS.md` own *what we're building*. Capped at roughly 15 entries; oldest roll off (deleted,
not archived — they remain in git history).

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
