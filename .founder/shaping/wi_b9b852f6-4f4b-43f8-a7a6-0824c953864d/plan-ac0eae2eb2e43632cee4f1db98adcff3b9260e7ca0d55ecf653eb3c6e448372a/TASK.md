# Plan shaping task

Use the immutable input below. Write one JSON result named `result.json`.

Mission content SHA-256: `17f99dc018a115e6214598cec87f2beb58fb2a7ee2c50d22480bb4283d69449a`

## Input

```json
{
  "phase": "plan",
  "title": "Close project menu",
  "notes": "The project menu in the top panel does not hide/close when I click out side the menu. I want it to close when I click somewhere else.",
  "spec_approval_sha256": "4ab4ee01f0df486c33dcb2564c12e118da96a6846e2611687ba31c365f909505",
  "spec_approval": {
    "shaping_schema_version": 2,
    "identity": {
      "phase": "spec",
      "work_item_id": "wi_b9b852f6-4f4b-43f8-a7a6-0824c953864d",
      "input_sha256": "9d91be0a1e0e665d051cc44b7b1b66865b115bf7ca3aecd013cdca6cca8d1390"
    },
    "mission_content_sha256": "cbd68ce81b1bedb6164e92483f8a57dda3f7e8167d59002dffd145fe54d486eb",
    "result_content_sha256": "f5b0bbcbe3b0a451e5729a093a7a9bb3ecd72a5f3e6a9b90ee141c0426cfa596",
    "goal_contract_sha256": "880ec9fbe75156ea232a0ce74fb000b75b58ffab42618c6c0c6b9dff8d6a5ad5"
  },
  "spec_result": {
    "result_schema_version": 1,
    "spec_mission_content_sha256": "cbd68ce81b1bedb6164e92483f8a57dda3f7e8167d59002dffd145fe54d486eb",
    "identity": {
      "phase": "spec",
      "work_item_id": "wi_b9b852f6-4f4b-43f8-a7a6-0824c953864d",
      "input_sha256": "9d91be0a1e0e665d051cc44b7b1b66865b115bf7ca3aecd013cdca6cca8d1390"
    },
    "proposal": {
      "purpose": "Make the Projects dropdown menu in the board header close when the user clicks outside the menu, following standard UI patterns for disclosure widgets.",
      "acceptance_criteria": [
        "Clicking anywhere outside the Projects menu closes it when open",
        "Clicking on menu items or checkboxes inside the menu does NOT close the menu",
        "Clicking the Projects summary/trigger toggles the menu open/closed as before",
        "Menu closes correctly when user scrolls the board viewport while the menu is open",
        "Pressing Escape while the menu is open closes it and returns focus to the trigger"
      ],
      "non_goals": [
        "Converting the native details/summary element to a different component library (e.g., shadcn/ui Dropdown)",
        "Changing the visual styling, position, or content of the Projects menu",
        "Adding click-outside behavior to other menus or panels in the application",
        "Implementing focus-trap or advanced accessibility features beyond Escape-key closing"
      ],
      "allowed_scope": [
        "components/kanban/kanban-board.tsx"
      ],
      "review_ready": [
        "The Projects menu closes when clicking outside its bounds while open",
        "The menu remains open when interacting with checkboxes and labels inside it",
        "Escape key closes the menu and restores focus to the trigger button",
        "No regressions in existing menu toggle behavior when clicking the summary",
        "Manual verification confirms expected behavior in Safari, Chrome, and Firefox"
      ]
    }
  },
  "repository_base_commit": "bfa402f136dc7d6cef4c57107caa95bf6c8a8c96",
  "goal_contract_sha256": "880ec9fbe75156ea232a0ce74fb000b75b58ffab42618c6c0c6b9dff8d6a5ad5",
  "goal_version": 1
}
```

## Required result fields

- `result_schema_version`
- `plan_mission_content_sha256`
- `identity`
- `summary`
- `checklist`
- `relevant_skills`
- `product_doc_impacts`
- `todo_impacts`
- `open_questions`

Do not modify the work item, advance its phase, or treat this proposal as adopted state.
