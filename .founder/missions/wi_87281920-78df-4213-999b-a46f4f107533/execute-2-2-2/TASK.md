# Guard the remaining 13 mutating API routes

Mission schema version: 6
Mission phase: execute
Package hash: 2f17e3efa9511834ab312005671125027f1f8628a5ac04deeb2ff8743b30d14f

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

- app/api/portfolio/work-items/[sourceId]/[workItemId]/edit/route.ts
- app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/import/route.ts
- app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/patch/import/route.ts
- app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/patch/route.ts
- app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/retry/route.ts
- app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/review/import/route.ts
- app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/review/route.ts
- app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/route.ts
- app/api/portfolio/work-items/[sourceId]/[workItemId]/patch-plan/route.ts
- app/api/portfolio/work-items/[sourceId]/[workItemId]/route-factory.ts
- app/api/portfolio/work-items/[sourceId]/[workItemId]/route.ts
- app/api/portfolio/work-items/route.ts
- app/api/request-body.ts
- app/api/work-items/rebuild/route.ts
- app/api/workspaces/route.ts
- tests/api/portfolio-routes.test.ts

## Review ready when

- The 13-route inventory is confirmed against TODO.md, with no additional mutating route adoption.
- Focused route tests demonstrate rejection for missing or wrong Origin, oversized or malformed JSON, and unknown keys, plus unchanged valid same-origin behavior.
- The implementation is inspected to confirm every JSON-consuming route uses the common factory/parser and no Content-Type gate was introduced.

## Capability envelope

Execution mode: permission_mediated_local
Scope assurance: result_scope_validation
Allowed-scope digest: `675e74aede901f57ce18f749737e45fb944bc506c8766d4649d56e3012212309`
Runtime containment: not_independently_enforced
Machine authority: launching_user
MCP: forbidden
Credentials: forbidden

Approved command forms:
- None

Approved URL operations:
- None

## Result contract

Write the structured result to `.founder/missions/wi_87281920-78df-4213-999b-a46f4f107533/execute-2-2-2/result.json`.
Commit the code changes before returning the result.
Use this complete JSON shape:

```json
{
  "result_schema_version": 2,
  "mission_content_sha256": "2f17e3efa9511834ab312005671125027f1f8628a5ac04deeb2ff8743b30d14f",
  "identity": {
    "phase": "execute",
    "work_item_id": "wi_87281920-78df-4213-999b-a46f4f107533",
    "goal_version": 2,
    "input_revision": 2,
    "attempt": 2
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
