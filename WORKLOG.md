# Worklog

A bounded, rolling, newest-first index of what was built or changed. This is a pointer, not a
source of truth — git is the source of truth for *what* changed; `PRODUCT.md`/`DESIGN.md`/
`AGENTS.md` own *what we're building*. Capped at roughly 15 entries; oldest roll off (deleted,
not archived — they remain in git history).

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
