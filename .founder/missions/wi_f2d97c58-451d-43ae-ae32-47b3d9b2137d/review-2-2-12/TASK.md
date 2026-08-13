# View full work item page lacks a to navigate back

Mission schema version: 8
Mission phase: review
Package hash: 146938027120816885d92788c9fec69b2d1b15383ef78bd1053e5a014c40a615

## Purpose

Define a focused back-navigation flow from the full work item page to the details-panel context the user came from.

## Acceptance criteria

- From the full work item page opened via 'View full work item', the user can trigger a visible back action that returns to the previously open work item details panel without manually closing and reopening it.

## Non-goals

- Redesigning global application navigation, breadcrumbs, or multi-step history beyond returning from the full work item page to its originating details-panel context.

## Allowed scope

- PRODUCT.md
- components/kanban/detail-panel.tsx
- src/application/portfolio.ts
- src/application/work-item-controller.ts
- src/domain/mission.ts
- src/workspace/product-workspace.ts
- tests/application/portfolio.test.ts
- tests/application/work-item-controller.test.ts
- tests/detail-panel.test.tsx
- tests/domain/mission.test.ts
- tests/workspace-contract.test.ts

## Review ready when

- The proposal specifies the entry point, the back-navigation affordance on the full work item page, and the expected restored destination context when returning to the details panel.

## Review assignment

Assess the exact pinned implementation as a read-only reviewer.
Do not modify workspace files or execute verification commands.

Pinned subject commit: `2b7020ed700164153650eac1ad1538cb2a7e1639`
Git base: `7c18d3fd173b4a08775d2276cc172d36d1d4a6b3`
Execute mission hash: `8bb3db375c9eba0b88327ba9f2922afe2bcce819b6f7174018bd7e595827bdaa`
Execute result hash: `792408656206722930c3333b7d1f65032136efe0f2d78bd726af4dd6ccc4e5bb`
Immutable mission: `.founder/missions/wi_f2d97c58-451d-43ae-ae32-47b3d9b2137d/execute-2-2-12/mission.json`
Immutable evidence: `.founder/run-evidence/wi_f2d97c58-451d-43ae-ae32-47b3d9b2137d/execute-2-2-12/4f83feaf9165922a1ca36e9791962d3a273b35284d96740e7431b68d7b12e84e`

Changed files:
- components/kanban/detail-panel.tsx
- tests/detail-panel.test.tsx

Authoritative verification:
- Lint: passed (npm run lint)
- Typecheck: passed (npm run typecheck)
- Test: passed (npm test)
- Build: passed (npm run build)

## Review result contract

Write the structured review to `.founder/missions/wi_f2d97c58-451d-43ae-ae32-47b3d9b2137d/review-2-2-12/result.json`.
Use this complete JSON shape:

```json
{
  "result_schema_version": 2,
  "review_mission_content_sha256": "146938027120816885d92788c9fec69b2d1b15383ef78bd1053e5a014c40a615",
  "identity": {
    "phase": "review",
    "work_item_id": "wi_f2d97c58-451d-43ae-ae32-47b3d9b2137d",
    "goal_version": 2,
    "input_revision": 2,
    "attempt": 12
  },
  "execute_mission_content_sha256": "8bb3db375c9eba0b88327ba9f2922afe2bcce819b6f7174018bd7e595827bdaa",
  "execute_result_content_sha256": "792408656206722930c3333b7d1f65032136efe0f2d78bd726af4dd6ccc4e5bb",
  "git_base_commit": "7c18d3fd173b4a08775d2276cc172d36d1d4a6b3",
  "accepted_result_commit": "2b7020ed700164153650eac1ad1538cb2a7e1639",
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
