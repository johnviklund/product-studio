# Spec shaping task

Use the immutable input below. Write one JSON result named `result.json`.

Mission content SHA-256: `cbd68ce81b1bedb6164e92483f8a57dda3f7e8167d59002dffd145fe54d486eb`

## Input

```json
{
  "phase": "spec",
  "title": "Close project menu",
  "notes": "The project menu in the top panel does not hide/close when I click out side the menu. I want it to close when I click somewhere else.",
  "brainstorm_selection_sha256": "afd96c43928406b493bfa1c97d23780bc767455c750f0cec88533a6c1a33efa3",
  "brainstorm_selection": {
    "shaping_schema_version": 2,
    "identity": {
      "phase": "brainstorm",
      "work_item_id": "wi_b9b852f6-4f4b-43f8-a7a6-0824c953864d",
      "input_sha256": "c78748722dec4c646d4c7e98fca17d9dac42cf3350b3ad1b61df1627ecb0fdfc"
    },
    "mission_content_sha256": "720205cabfb7f85f783c6c32b33129ce94c616474b84268684374992eb52bcb2",
    "result_content_sha256": "00d595ecc40f1658e2aa8250677006276bfc6300c40cbb8e0c6e3c7469185355"
  },
  "brainstorm_result": {
    "result_schema_version": 1,
    "brainstorm_mission_content_sha256": "720205cabfb7f85f783c6c32b33129ce94c616474b84268684374992eb52bcb2",
    "identity": {
      "phase": "brainstorm",
      "work_item_id": "wi_b9b852f6-4f4b-43f8-a7a6-0824c953864d",
      "input_sha256": "c78748722dec4c646d4c7e98fca17d9dac42cf3350b3ad1b61df1627ecb0fdfc"
    },
    "problem_statement": "The project menu in the top panel remains open when users click outside of it, failing to follow standard UI patterns where dropdown menus close on outside clicks. This creates a frustrating user experience where the menu obstructs content until explicitly closed.",
    "approach": "Implement click-outside detection for the project menu component using event listeners or React hooks (useEffect with document click handler or useClickOutside pattern). Add logic to check if click target is outside the menu bounds and toggle the menu closed state. Ensure the implementation handles edge cases like clicks on the menu trigger itself, nested dropdowns, and rapid click sequences.",
    "non_goals": [
      "Changing the visual design or position of the project menu",
      "Adding keyboard-based menu closing (ESC key) unless trivial to include",
      "Modifying other menus or dropdowns in the application",
      "Creating a shared menu component library or refactoring existing menu architecture"
    ],
    "open_questions": [
      "Should the menu close when clicking on menu items that trigger actions, or only on outside clicks?",
      "Are there any accessibility implications or ARIA attributes that need updating with this behavior change?",
      "Does the current project menu implementation use a UI library component (like shadcn/ui Dropdown) that may already have this feature available?",
      "Should the menu close when the user scrolls the page, or only on explicit outside clicks?"
    ]
  }
}
```

## Required result fields

- `result_schema_version`
- `spec_mission_content_sha256`
- `identity`
- `proposal`

Do not modify the work item, advance its phase, or treat this proposal as adopted state.
