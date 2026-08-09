# Guard the remaining 13 mutating API routes

Mission schema version: 7
Mission phase: review
Package hash: be0b4e32bbf134af896c1d8ed09ef28ad99bc41bd3a25a52f6514f8cfca21baf

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

## Review assignment

Assess the exact pinned implementation as a read-only reviewer.
Do not modify workspace files or execute verification commands.

Pinned subject commit: `fdcc3f87c7b7f50fb083c73dc3a07d0d873867d9`
Git base: `8dd4f2c435216622f42623927c43dc5e163e305d`
Execute mission hash: `9f6db7d7c0e745ca4d8e87ae5d5cf062a476974efc580e8b6999dc8f6d18f601`
Execute result hash: `5a8df318d1ade2c524e49caabd4a2d11a508da2d0c4688a773d66118bd3cb758`
Immutable mission: `.founder/missions/wi_87281920-78df-4213-999b-a46f4f107533/execute-2-2-17/mission.json`
Immutable evidence: `.founder/run-evidence/wi_87281920-78df-4213-999b-a46f4f107533/execute-2-2-17/3cf2a05259f896a1745a81a1de3e5d093561700aa2ff3902a1e08c5520205a19`

Changed files:
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

Authoritative verification:
- Lint: passed (npm run lint)
- Typecheck: passed (npm run typecheck)
- Test: passed (npm test)
- Build: passed (npm run build)

## Review result contract

Write the structured review to `.founder/missions/wi_87281920-78df-4213-999b-a46f4f107533/review-2-2-17/result.json`.
Use this complete JSON shape:

```json
{
  "result_schema_version": 2,
  "review_mission_content_sha256": "be0b4e32bbf134af896c1d8ed09ef28ad99bc41bd3a25a52f6514f8cfca21baf",
  "identity": {
    "phase": "review",
    "work_item_id": "wi_87281920-78df-4213-999b-a46f4f107533",
    "goal_version": 2,
    "input_revision": 2,
    "attempt": 17
  },
  "execute_mission_content_sha256": "9f6db7d7c0e745ca4d8e87ae5d5cf062a476974efc580e8b6999dc8f6d18f601",
  "execute_result_content_sha256": "5a8df318d1ade2c524e49caabd4a2d11a508da2d0c4688a773d66118bd3cb758",
  "git_base_commit": "8dd4f2c435216622f42623927c43dc5e163e305d",
  "accepted_result_commit": "fdcc3f87c7b7f50fb083c73dc3a07d0d873867d9",
  "summary": "<concise review summary>",
  "verdict": "clean | findings",
  "findings": [
    {
      "finding_id": "<unique id>",
      "severity": "P0 | P1 | P2 | P3",
      "title": "<finding title>",
      "evidence": { "summary": "<concrete evidence>" },
      "required_action": "<required correction>",
      "link": {
        "type": "defect",
        "evidence_summary": "<concrete defect evidence>"
      }
    }
  ]
}
```

Return the review for immutable import; do not advance controller state.
