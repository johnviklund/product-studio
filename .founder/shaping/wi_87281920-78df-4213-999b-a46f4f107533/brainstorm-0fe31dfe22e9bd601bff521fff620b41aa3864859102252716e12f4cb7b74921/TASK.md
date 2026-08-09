# Brainstorm shaping task

Use the immutable input below. Write one JSON result named `result.json`.

Mission content SHA-256: `236bf1a5a2d7c7d0e7a038d0c70a878959befcd2787ce5abcfa2497cdc8395d9`

## Input

```json
{
  "phase": "brainstorm",
  "title": "Guard the remaining 13 mutating API routes",
  "notes": "Use one shared origin-plus-capped-JSON route factory across exactly the 13 pre-existing unguarded mutating routes named in TODO.md. Preserve existing request schemas and controller semantics. Do not add a Content-Type gate. Verify wrong or missing Origin, oversize or malformed JSON, unknown keys, and valid same-origin behavior. Keep this work within the accepted TODO boundary."
}
```

## Required result fields

- `result_schema_version`
- `brainstorm_mission_content_sha256`
- `identity`
- `problem_statement`
- `approach`
- `non_goals`
- `open_questions`

Do not modify the work item, advance its phase, or treat this proposal as adopted state.
