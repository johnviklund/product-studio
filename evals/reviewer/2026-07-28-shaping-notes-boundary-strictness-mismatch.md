# Reviewer golden case — untrimmed `notes` makes Brainstorm/Spec compile impossible for a common, valid card

- **Seat:** strict reviewer
- **Date:** 2026-07-28
- **Cycle:** ROADMAP 3.4 Slice 1 (Brainstorm and Spec shaping missions)
- **Caught at:** Phase 4 review cycle 1, base `ac4b6f4`
- **Provenance:** written by the default-executor seat (GPT-5.6 Terra), caught by the
  strict-reviewer seat (cross-vendor review, Claude Opus 4.6) at base `ac4b6f4`; confirmed **P1**,
  fixed in the patch cycle (commit `56d589b`), re-reviewed clean at HEAD `be08779`.

## Input — diff under review

The shaping slice adds a Brainstorm/Spec mission-compile path that hashes a work item's fields
into a content-addressed task. Two independent schemas describe the same `notes` field with
different strictness, joined by a pass-through at the service boundary:

`src/domain/work-item.ts` (durable work-item storage — what a card is allowed to persist):

```ts
// notesSchema, lines 496-498
const notesSchema = z
  .string()
  .refine((v) => v.trim().length > 0, "notes must not be empty");
// Deliberately does NOT require notes === notes.trim() — unlike titleSchema (478-484), which does.
// So "Some context\n" is a valid, durably-savable note.
```

`src/domain/shaping.ts` (the shaping contract — what may go into a content-addressed mission
hash):

```ts
// nonEmptyTrimmedStringSchema, lines 30-36
const nonEmptyTrimmedStringSchema = z
  .string()
  .min(1)
  .refine((v) => v === v.trim(), "must not have leading or trailing whitespace");
```

`src/application/portfolio.ts` (the service boundary — passes the field through unchanged):

```ts
// compileBrainstormMission, lines 761-771
function compileBrainstormMission(workItem) {
  // ...
  const input = hashShapingInput({
    // ...
    notes: workItem.goal.notes,   // <-- passed through verbatim, no normalization
  });
  // hashShapingInput validates each field with nonEmptyTrimmedStringSchema before hashing
}
```

`components/kanban/detail-panel.tsx` (the client — how a note actually gets typed and saved):

```tsx
// line 2239 — the save handler
notes: notes.trim().length === 0 ? null : notes,
// trims ONLY to decide null-vs-value; sends the UNTRIMMED string either way.
// A 5-row <textarea> (line 3062) makes a trailing newline the default outcome of pressing Enter.
```

`app/api/responses.ts` (the error mapper):

```ts
// errorResponse — maps any ZodError to a generic client error
if (err instanceof ZodError) {
  return NextResponse.json({ error: "invalid_request", message: "Invalid request" }, { status: 400 });
}
// Compare the deliberate mission_not_ready / ControllerConflictError -> 409 path used for
// every other "not ready yet" case elsewhere in the same slice.
```

**Spec/contract guarantee under test:** any legally saved work item (one that round-trips through
`ProductWorkspace.read`/`saveWorkItem` without error) must be able to compile a Brainstorm/Spec
mission — compiling is the slice's headline feature and must not silently exclude ordinary,
valid cards.

## Approved output — the finding a passing review must produce

A reviewer must flag, at **P1** severity, that a work item with a trailing newline in `notes` —
the default result of typing into the detail panel's textarea and pressing Enter — can never
compile a Brainstorm or Spec mission:

1. Identify the exact schema mismatch: `notesSchema` permits untrimmed notes (only checks
   `trim().length > 0`) while `nonEmptyTrimmedStringSchema` forbids them (`v === v.trim()`), and
   that `compileBrainstormMission` passes `workItem.goal.notes` through the boundary unchanged
   into the stricter schema.
2. Show reachability is high, not theoretical: trace the client's save handler
   (`detail-panel.tsx:2239`) trimming only to decide null-vs-value while sending the untrimmed
   string, and that a trailing newline is the ordinary outcome of using a multi-row `<textarea>`
   (not a crafted edge case).
3. Trace the failure end to end through the **real** service, not just the two schemas read side
   by side: `createCapture` → `saveWorkItem({ notes: "...\n" })` (persists verbatim, valid) →
   `updateWorkItemPhase({ target_phase: "brainstorm" })` → `compileBrainstormMission` throws a raw
   `ZodError` on `notes` → `errorResponse` maps it to a generic `400 invalid_request` "Invalid
   request" — misreporting a well-formed request against valid durable state as the caller's
   fault, unlike the deliberate `409` path used elsewhere in the same slice for other not-ready
   states.
4. Note the same value flows into the Spec compile path and a staleness comparison elsewhere in
   the same file, so Spec compile breaks identically for the same cards — not an isolated
   Brainstorm-only bug.
5. Explain why the green test suite missed it: every shaping test in the diff builds its own
   already-trimmed input fixture; none drives `compileBrainstormMission` from a card saved through
   the real `saveWorkItem` with realistic textarea text.
6. Recommend the fix direction: normalize (trim) `notes` at the service boundary in both compile
   methods (and the staleness comparison, so all three stay consistent) — do **not** relax
   `nonEmptyTrimmedStringSchema` itself, since it also guards result submissions elsewhere.

## Grading notes

**A passing answer must contain:**
1. The precise two-schema mismatch (untrimmed-permitting `notesSchema` vs. exactly-trimmed
   `nonEmptyTrimmedStringSchema`) and that the service boundary passes the field through
   unnormalized.
2. That reachability is the *default* interaction (typing + Enter in a textarea), not a
   constructed edge case.
3. The full empirical trace through the real service (`createCapture` → `saveWorkItem` →
   `updateWorkItemPhase` → `compileBrainstormMission` → raw `ZodError` → generic `400`), not just
   "these two schemas disagree."
4. That this blocks the slice's *headline* feature for ordinary valid cards, and that the error
   surfaced is misleading (blames the caller via `400` instead of the deliberate `409` not-ready
   path used elsewhere).
5. A fix direction that trims at the boundary rather than loosening the shared strict schema.

**Known traps (a failing answer often falls into these):**
- Reading `notesSchema` and `nonEmptyTrimmedStringSchema` in isolation and noting "one is
  stricter" without tracing an actual saved card through the real compile path to confirm it
  throws — a reviewer that only reads the diff, or only trusts a green suite (386 tests, lint,
  typecheck, build all passed), scores this clean.
- Treating the trailing newline as a crafted adversarial input rather than recognizing it as the
  textarea's default behavior for anyone who presses Enter while typing notes.
- Proposing to fix it by relaxing `nonEmptyTrimmedStringSchema` — that schema also guards result
  submissions, so loosening it for `notes` convenience would weaken an unrelated guarantee;
  normalizing at the boundary is the smaller, safer change.
- Missing that the same defect exists in the Spec compile path and a staleness comparison, not
  just Brainstorm compile — a narrow fix to only one call site leaves the bug live in the other
  two.

**Generalizable smell:** two schemas describing the same field with different strictness, joined
by an unnormalized pass-through at a service boundary — worth checking any time a value crosses
from a permissive storage schema into a stricter downstream contract.

## Source

- Review at base `ac4b6f4` (cycle 1, this cycle's review artifact, since deleted per wrap;
  content preserved above) and re-review clean at HEAD `be08779` (cycle 2).
- Fix commit: `56d589b` ("fix(shaping): normalize goal input consistently").
- Verification commits: `da39419` (cycle-1 fix verification), `be08779` (cycle-2 reverification).
