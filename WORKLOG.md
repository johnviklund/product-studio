# Worklog

A bounded, rolling, newest-first index of what was built or changed. This is a pointer, not a
source of truth — git is the source of truth for *what* changed; `PRODUCT.md`/`DESIGN.md`/
`AGENTS.md` own *what we're building*. Capped at roughly 15 entries; oldest roll off (deleted,
not archived — they remain in git history).

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
