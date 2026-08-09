# Guard the remaining 13 mutating API routes

Mission schema version: 6
Mission phase: execute
Package hash: 204cc830eaa7fe3ab22c1e6a2eccdfdda8aef3f83262381bcbba67700a8a1022

## Purpose

Protect exactly the 13 pre-existing unguarded mutating API routes within the accepted TODO boundary by adopting one shared route factory that fails closed for untrusted origins and caps JSON request bodies, while preserving each route's existing request schema and controller semantics.

## Acceptance criteria

- A single shared route factory applies assertTrustedRequestOrigin and readCappedJsonRequest across exactly the 13 named pre-existing routes: [workItemId] PATCH, [workItemId]/edit PATCH, mission/{route,retry,import}, mission/patch{,/import}, mission/review{,/import}, patch-plan, portfolio/work-items POST, work-items/rebuild POST, and workspaces POST.
- Each of the 13 routes rejects requests with a missing or wrong Origin before its mutating behavior runs, while valid same-origin requests retain their current success behavior and controller semantics.
- JSON-consuming routes reject oversized bodies, malformed JSON, and unknown request keys using the shared capped parser and their existing schemas; work-items/rebuild retains its bodyless behavior while receiving the origin guard.
- The shared factory does not require a JSON Content-Type header, preserving the current intentional request-parsing behavior while Origin validation remains fail-closed.

## Non-goals

- Guarding mutating API routes outside the 13 pre-existing routes named in TODO.md.
- Changing existing route request schemas, controller semantics, or closed-transition policy.
- Adding a Content-Type gate or relaxing missing-Origin rejection for non-browser clients.

## Allowed scope

- src/application/request-origin.ts
- The existing shared capped JSON request parser and its direct tests
- The route factory used by shaping POST routes and its direct tests
- app/api/**/[workItemId]/route.ts
- app/api/**/[workItemId]/edit/route.ts
- app/api/**/mission/route.ts
- app/api/**/mission/retry/route.ts
- app/api/**/mission/import/route.ts
- app/api/**/mission/patch/route.ts
- app/api/**/mission/patch/import/route.ts
- app/api/**/mission/review/route.ts
- app/api/**/mission/review/import/route.ts
- app/api/**/patch-plan/route.ts
- app/api/**/portfolio/work-items/route.ts
- app/api/**/work-items/rebuild/route.ts
- app/api/**/workspaces/route.ts
- Focused tests covering the shared factory and these 13 route behaviors

## Review ready when

- The 13-route inventory is confirmed against TODO.md, with no additional mutating route adoption.
- Focused route tests demonstrate rejection for missing or wrong Origin, oversized or malformed JSON, and unknown keys, plus unchanged valid same-origin behavior.
- The implementation is inspected to confirm every JSON-consuming route uses the common factory/parser and no Content-Type gate was introduced.

## Capability envelope

Execution mode: permission_mediated_local
Scope assurance: result_scope_validation
Allowed-scope digest: `7e71d30cfdebe08e6ec9783c3d446998189a97bdd3e477ee6290541aead490c5`
Runtime containment: not_independently_enforced
Machine authority: launching_user
MCP: forbidden
Credentials: forbidden

Approved command forms:
- None

Approved URL operations:
- None

## Result contract

Write the structured result to `.founder/missions/wi_87281920-78df-4213-999b-a46f4f107533/execute-1-1-0/result.json`.
Commit the code changes before returning the result.
Use this complete JSON shape:

```json
{
  "result_schema_version": 2,
  "mission_content_sha256": "204cc830eaa7fe3ab22c1e6a2eccdfdda8aef3f83262381bcbba67700a8a1022",
  "identity": {
    "phase": "execute",
    "work_item_id": "wi_87281920-78df-4213-999b-a46f4f107533",
    "goal_version": 1,
    "input_revision": 1,
    "attempt": 0
  },
  "commit": "<full 40-character Git commit SHA>",
  "summary": "<concise implementation summary>",
  "changed_files": ["<workspace-relative POSIX path>"],
  "verification": [
    { "name": "<check name>", "status": "passed", "detail": "<optional detail>" }
  ]
}
```

Each reported verification status must be passed, failed, or not_run.
Reported verification is context only. The controller validates the commit and runs the authoritative checks.

## Next gate

Return the result for validation; do not advance controller state.
