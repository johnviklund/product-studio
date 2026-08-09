# Spec shaping task

Use the immutable input below. Write one JSON result named `result.json`.

Mission content SHA-256: `ec1c51531cbceda3c8526841e07a3fec59bcb6298b7a33c65f8bf168126b8500`

## Input

```json
{
  "phase": "spec",
  "title": "Guard the remaining 13 mutating API routes",
  "notes": "Use one shared origin-plus-capped-JSON route factory across exactly the 13 pre-existing unguarded mutating routes named in TODO.md. Preserve existing request schemas and controller semantics. Do not add a Content-Type gate. Verify wrong or missing Origin, oversize or malformed JSON, unknown keys, and valid same-origin behavior. Keep this work within the accepted TODO boundary.",
  "brainstorm_selection_sha256": "0a498070ca098c3a693eded0efb17d796814c2a3c6578edc4b99564e88f181d3",
  "brainstorm_selection": {
    "shaping_schema_version": 2,
    "identity": {
      "phase": "brainstorm",
      "work_item_id": "wi_87281920-78df-4213-999b-a46f4f107533",
      "input_sha256": "0fe31dfe22e9bd601bff521fff620b41aa3864859102252716e12f4cb7b74921"
    },
    "mission_content_sha256": "236bf1a5a2d7c7d0e7a038d0c70a878959befcd2787ce5abcfa2497cdc8395d9",
    "result_content_sha256": "9c82e28802cea13da3cd8418877ef8ed4633c7fdfa7e681aef3dc7d52df6b505"
  },
  "brainstorm_result": {
    "result_schema_version": 1,
    "brainstorm_mission_content_sha256": "236bf1a5a2d7c7d0e7a038d0c70a878959befcd2787ce5abcfa2497cdc8395d9",
    "identity": {
      "phase": "brainstorm",
      "work_item_id": "wi_87281920-78df-4213-999b-a46f4f107533",
      "input_sha256": "0fe31dfe22e9bd601bff521fff620b41aa3864859102252716e12f4cb7b74921"
    },
    "problem_statement": "Exactly 13 pre-existing mutating API routes identified in TODO.md remain unguarded, leaving inconsistent protection against wrong or missing Origin headers, oversized or malformed JSON bodies, and unknown request keys while their existing request schemas and controller semantics must remain unchanged.",
    "approach": "Introduce one shared route factory that enforces same-origin requests and capped JSON parsing, then adopt it across exactly the 13 named unguarded mutating routes without adding a Content-Type gate. Preserve each route's schema and controller behavior, and verify rejection of wrong or missing Origin, oversized or malformed JSON, and unknown keys alongside successful valid same-origin requests.",
    "non_goals": [
      "Changing mutating routes outside the 13 routes named in the accepted TODO boundary, altering controller semantics or request schemas, or introducing a Content-Type requirement."
    ],
    "open_questions": [
      "What existing JSON body-size cap and same-origin error response conventions should the shared route factory preserve across the 13 routes?"
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
