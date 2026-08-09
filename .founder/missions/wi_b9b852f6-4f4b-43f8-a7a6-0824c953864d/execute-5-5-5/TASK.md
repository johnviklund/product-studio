# Close project menu

Mission schema version: 7
Mission phase: execute
Package hash: 3c037746f4f43096ea68b839677d217760c1e20660872972fc089d308ffdc905

## Purpose

Make the Projects dropdown menu in the board header close when the user clicks outside the menu, following standard UI patterns for disclosure widgets.

## Acceptance criteria

- Clicking anywhere outside the Projects menu closes it when open
- Clicking on menu items or checkboxes inside the menu does NOT close the menu
- Clicking the Projects summary/trigger toggles the menu open/closed as before
- Menu closes correctly when user scrolls the board viewport while the menu is open
- Pressing Escape while the menu is open closes it and returns focus to the trigger

## Non-goals

- Converting the native details/summary element to a different component library (e.g., shadcn/ui Dropdown)
- Changing the visual styling, position, or content of the Projects menu
- Adding click-outside behavior to other menus or panels in the application
- Implementing focus-trap or advanced accessibility features beyond Escape-key closing

## Allowed scope

- components/kanban/kanban-board.tsx

## Review ready when

- The Projects menu closes when clicking outside its bounds while open
- The menu remains open when interacting with checkboxes and labels inside it
- Escape key closes the menu and restores focus to the trigger button
- No regressions in existing menu toggle behavior when clicking the summary
- Manual verification confirms expected behavior in Safari, Chrome, and Firefox

## Capability envelope

Execution mode: permission_mediated_local
Scope assurance: result_scope_validation
Allowed-scope digest: `651a926cc2f64b5d49af6c1833e43704249a8381e2268f554d66720e7666ddce`
Runtime containment: not_independently_enforced
Machine authority: launching_user
MCP: forbidden
Credentials: forbidden

Approved command forms:
- ["git","add","components/kanban/kanban-board.tsx"]
- ["git","diff","components/kanban/kanban-board.tsx"]
- ["git","status","--short"]
- ["npx","tsc","--noEmit"]
Approved command arrays are exact. Do not add arguments, message paragraphs, attribution trailers, or metadata.
Every command must be a single line built only from plain words and quoted words. Newlines, control characters, pipes, redirection, chaining, and substitution cannot be interpreted: the runtime refuses such a request outright and the run ends without a result. Keep commit messages to one line.

Approved URL operations:
- None

## Result contract

Write the structured result to `.founder/missions/wi_b9b852f6-4f4b-43f8-a7a6-0824c953864d/execute-5-5-5/result.json`.
Commit the code changes before returning the result.
Use this complete JSON shape:

```json
{
  "result_schema_version": 2,
  "mission_content_sha256": "3c037746f4f43096ea68b839677d217760c1e20660872972fc089d308ffdc905",
  "identity": {
    "phase": "execute",
    "work_item_id": "wi_b9b852f6-4f4b-43f8-a7a6-0824c953864d",
    "goal_version": 5,
    "input_revision": 5,
    "attempt": 5
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
