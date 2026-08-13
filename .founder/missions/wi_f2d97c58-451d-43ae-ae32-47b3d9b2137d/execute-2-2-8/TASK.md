# View full work item page lacks a to navigate back

Mission schema version: 8
Mission phase: execute
Package hash: c7fe70274559deba3caed16a7e349be20927872bfc54495d60f6bbcb2f7aa1f2

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

## Approved Plan

This is the exact human-approved implementation package. Complete every checklist entry and its verification check.
Plan mission hash: `83c13f18c5c38ba85a53e6e4044b0f089aafc9ad5267ac795a2866f51bc65a06`
Plan result hash: `3ba0a1c845fb997e6529967b1f44d4aab72594e492c0bf1bb8c134efec7bed89`
Goal contract hash: `2600e6eef71a4ed11168d2972a721a5397f10d25492c0e6a59b706953e2a6f7c`
Approved at: 2026-08-09T17:54:43.723Z

Add unconditional back-navigation button to the full work item view in detail-panel.tsx. Currently the 'Back to shaping decision' button only appears when shapingDecisionProjection is non-null, leaving users without a visible return path when shaping context is unavailable. The fix moves the back button outside the conditional block so it always appears when showFullWorkItem is true, with context-appropriate labeling.

### step-1

Refactor the full work item view (line ~8227) in detail-panel.tsx to always render a back-navigation button at the top when showFullWorkItem is true, regardless of whether shapingDecisionProjection is null. Use conditional text: 'Back to shaping decision' when shaping is active, or 'Back to details panel' otherwise.

Verification: Run `npm run typecheck` to confirm no TypeScript errors. Manually verify the back button appears unconditionally in the full work item view by loading a work item with and without shaping context.

### step-2

Add an ArrowLeft icon prefix to the back button for visual clarity and consistency with common navigation patterns. The icon is already imported at the top of detail-panel.tsx.

Verification: Visual inspection confirms the ArrowLeft icon appears before the button text.

### step-3

Add a test case in tests/detail-panel.test.tsx that renders the DetailPanel in full work item view mode and asserts the back button is present and clickable, returning the user to the details panel state.

Verification: Run `npm test -- tests/detail-panel.test.tsx` and confirm the new test passes.

Relevant skills:
- None

Product document impacts:
- None

TODO impacts:
- None

Open questions:
- None

## Capability envelope

Execution mode: permission_mediated_local
Scope assurance: result_scope_validation
Allowed-scope digest: `c690bc2dcab8fb7f3368f8c5b3b9d0fc3af0a557983e2249a99d58e4e16c3d44`
Runtime containment: not_independently_enforced
Machine authority: launching_user
MCP: forbidden
Credentials: forbidden

Approved command forms:
- None
Approved command arrays are exact. Do not add arguments, message paragraphs, attribution trailers, or metadata.
Every command must be a single line built only from plain words and quoted words. Newlines, control characters, pipes, redirection, chaining, and substitution cannot be interpreted: the runtime refuses such a request outright and the run ends without a result. Keep commit messages to one line.

Approved URL operations:
- None

## Result contract

Write the structured result to `.founder/missions/wi_f2d97c58-451d-43ae-ae32-47b3d9b2137d/execute-2-2-8/result.json`.
Do not run Git. Leave your edits uncommitted in the working tree: the controller commits them for you once it has proven they are in scope.
If every approved checklist entry is already satisfied at the compiled commit, report an empty changed_files array; the controller still runs authoritative verification.
Use this complete JSON shape:

```json
{
  "result_schema_version": 2,
  "mission_content_sha256": "c7fe70274559deba3caed16a7e349be20927872bfc54495d60f6bbcb2f7aa1f2",
  "identity": {
    "phase": "execute",
    "work_item_id": "wi_f2d97c58-451d-43ae-ae32-47b3d9b2137d",
    "goal_version": 2,
    "input_revision": 2,
    "attempt": 8
  },
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
