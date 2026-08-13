# View full work item page lacks a to navigate back

Mission schema version: 7
Mission phase: execute
Package hash: 6cd445df51feb181a9fbe1104f6a49b1f5738746fcc34f54f4b45b2aaadc4712

## Purpose

Define a focused back-navigation flow from the full work item page to the details-panel context the user came from.

## Acceptance criteria

- From the full work item page opened via 'View full work item', the user can trigger a visible back action that returns to the previously open work item details panel without manually closing and reopening it.

## Non-goals

- Redesigning global application navigation, breadcrumbs, or multi-step history beyond returning from the full work item page to its originating details-panel context.

## Allowed scope

- work-item details panel to full-page work-item navigation and return behavior

## Review ready when

- The proposal specifies the entry point, the back-navigation affordance on the full work item page, and the expected restored destination context when returning to the details panel.

## Capability envelope

Execution mode: permission_mediated_local
Scope assurance: result_scope_validation
Allowed-scope digest: `dc03f47661422bb0b33922ac46bafaae8080cb7ea68a100f8cebdda3f2276802`
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

Write the structured result to `.founder/missions/wi_f2d97c58-451d-43ae-ae32-47b3d9b2137d/execute-1-1-11/result.json`.
Do not run Git. Leave your edits uncommitted in the working tree: the controller commits them for you once it has proven they are in scope.
Use this complete JSON shape:

```json
{
  "result_schema_version": 2,
  "mission_content_sha256": "6cd445df51feb181a9fbe1104f6a49b1f5738746fcc34f54f4b45b2aaadc4712",
  "identity": {
    "phase": "execute",
    "work_item_id": "wi_f2d97c58-451d-43ae-ae32-47b3d9b2137d",
    "goal_version": 1,
    "input_revision": 1,
    "attempt": 11
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
