# Plan shaping task

Use the immutable input below. Write one JSON result named `result.json`.

Mission content SHA-256: `16113ba6de260569e50e7652a054b3129db8426bb835f4f521c17dcf31189341`

## Input

```json
{
  "phase": "plan",
  "title": "Guard the remaining 13 mutating API routes",
  "notes": "Use one shared origin-plus-capped-JSON route factory across exactly the 13 pre-existing unguarded mutating routes named in TODO.md. Preserve existing request schemas and controller semantics. Do not add a Content-Type gate. Verify wrong or missing Origin, oversize or malformed JSON, unknown keys, and valid same-origin behavior. Keep this work within the accepted TODO boundary.",
  "spec_approval_sha256": "703200bfd3458c85c2cac43c6c5ecf06d2e254482440e5b62fcc73011d6f0aa2",
  "spec_approval": {
    "shaping_schema_version": 2,
    "identity": {
      "phase": "spec",
      "work_item_id": "wi_87281920-78df-4213-999b-a46f4f107533",
      "input_sha256": "02e49909d9b749e9a90d504782848807dcea0de6dc772cd0cca2f79c070dd71a"
    },
    "mission_content_sha256": "ec1c51531cbceda3c8526841e07a3fec59bcb6298b7a33c65f8bf168126b8500",
    "result_content_sha256": "61ef39409866b335e9167430ebb0987e136c02b15a667b1f63b872349576f2c2",
    "goal_contract_sha256": "d8e82e60427a3205bb4d9b48428acd9d619f8f3a60e05b2201a655c99b1edb4b"
  },
  "spec_result": {
    "result_schema_version": 1,
    "spec_mission_content_sha256": "ec1c51531cbceda3c8526841e07a3fec59bcb6298b7a33c65f8bf168126b8500",
    "identity": {
      "phase": "spec",
      "work_item_id": "wi_87281920-78df-4213-999b-a46f4f107533",
      "input_sha256": "02e49909d9b749e9a90d504782848807dcea0de6dc772cd0cca2f79c070dd71a"
    },
    "proposal": {
      "purpose": "Protect exactly the 13 pre-existing unguarded mutating API routes within the accepted TODO boundary by adopting one shared route factory that fails closed for untrusted origins and caps JSON request bodies, while preserving each route's existing request schema and controller semantics.",
      "acceptance_criteria": [
        "A single shared route factory applies assertTrustedRequestOrigin and readCappedJsonRequest across exactly the 13 named pre-existing routes: [workItemId] PATCH, [workItemId]/edit PATCH, mission/{route,retry,import}, mission/patch{,/import}, mission/review{,/import}, patch-plan, portfolio/work-items POST, work-items/rebuild POST, and workspaces POST.",
        "Each of the 13 routes rejects requests with a missing or wrong Origin before its mutating behavior runs, while valid same-origin requests retain their current success behavior and controller semantics.",
        "JSON-consuming routes reject oversized bodies, malformed JSON, and unknown request keys using the shared capped parser and their existing schemas; work-items/rebuild retains its bodyless behavior while receiving the origin guard.",
        "The shared factory does not require a JSON Content-Type header, preserving the current intentional request-parsing behavior while Origin validation remains fail-closed."
      ],
      "non_goals": [
        "Guarding mutating API routes outside the 13 pre-existing routes named in TODO.md.",
        "Changing existing route request schemas, controller semantics, or closed-transition policy.",
        "Adding a Content-Type gate or relaxing missing-Origin rejection for non-browser clients."
      ],
      "allowed_scope": [
        "src/application/request-origin.ts",
        "The existing shared capped JSON request parser and its direct tests",
        "The route factory used by shaping POST routes and its direct tests",
        "app/api/**/[workItemId]/route.ts",
        "app/api/**/[workItemId]/edit/route.ts",
        "app/api/**/mission/route.ts",
        "app/api/**/mission/retry/route.ts",
        "app/api/**/mission/import/route.ts",
        "app/api/**/mission/patch/route.ts",
        "app/api/**/mission/patch/import/route.ts",
        "app/api/**/mission/review/route.ts",
        "app/api/**/mission/review/import/route.ts",
        "app/api/**/patch-plan/route.ts",
        "app/api/**/portfolio/work-items/route.ts",
        "app/api/**/work-items/rebuild/route.ts",
        "app/api/**/workspaces/route.ts",
        "Focused tests covering the shared factory and these 13 route behaviors"
      ],
      "review_ready": [
        "The 13-route inventory is confirmed against TODO.md, with no additional mutating route adoption.",
        "Focused route tests demonstrate rejection for missing or wrong Origin, oversized or malformed JSON, and unknown keys, plus unchanged valid same-origin behavior.",
        "The implementation is inspected to confirm every JSON-consuming route uses the common factory/parser and no Content-Type gate was introduced."
      ]
    }
  },
  "repository_base_commit": "0cce77d40c57b7e374a7bcc485528543364ea2d1",
  "goal_contract_sha256": "d8e82e60427a3205bb4d9b48428acd9d619f8f3a60e05b2201a655c99b1edb4b",
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
