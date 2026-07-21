# Worklog

A bounded, rolling, newest-first index of what was built or changed. This is a pointer, not a
source of truth — git is the source of truth for *what* changed; `PRODUCT.md`/`DESIGN.md`/
`AGENTS.md` own *what we're building*. Capped at roughly 15 entries; oldest roll off (deleted,
not archived — they remain in git history).

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
