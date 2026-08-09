# Reviewer golden case — proving a regression test non-vacuous requires mutating both the old and new file

- **Seat:** strict reviewer
- **Date:** 2026-08-09
- **Cycle:** ROADMAP 3.4 Slice 3, Cycle 4 close-out review (delta `2d5b816..2c5dd19`)
- **Caught at:** Phase 4 review Cycle 4, checking Cycle 3's own "close this gap" recommendation
- **Provenance:** Cycle 3 (same run, prior cycle) found that two contract-test negatives in
  `tests/workspace-contract.test.ts` passed even with the guard they claimed to test removed — a
  vacuous regression test. It recommended pinning the guard's own error message instead of a
  coarse `kind` matcher. Cycle 4 (cross-vendor, Claude Opus 5) verified the fix actually closed the
  gap, and found the closure was in fact real — but only after mutating the file *twice*.

## Input — the fix under review and the two-directional test that examines it

The reviewed delta changed two assertions in `tests/workspace-contract.test.ts` from:

```ts
await expect(importResult(...)).rejects.toMatchObject({ kind: "invalid_workspace" });
```

to:

```ts
await expect(importResult(...)).rejects.toThrow(
  "import evidence identity does not match the submitted result bytes"
);
```

The write-site guard under test lives in `src/workspace/product-workspace.ts:4936`:
`expectedImportRunId(evidence) !== evidence.import_run_id` throws with that exact message. A
*different* guard exists at the read-back path (`product-workspace.ts:6342`) that raises the same
`kind: "invalid_workspace"` but a different message — this is exactly why the old, coarse
`toMatchObject({ kind: ... })` assertion was vacuous: neutralizing the write-site guard still let
the read-back guard fire with the same `kind`, so the test passed either way.

The question this case exams: **does swapping in an exact-message assertion actually close the
gap, or does it just look more specific while still passing on a mutated file?**

A single mutation — deleting only the current (post-fix) test file's guard and re-running — cannot
answer this. It only shows the test is *sensitive* to something; it can't distinguish "genuinely
closed" from "differently vacuous."

## Approved output — the two-directional mutation a passing review must run

The reviewer must apply the **same mutation** (neutralizing
`expectedImportRunId(evidence) !== evidence.import_run_id` at `product-workspace.ts:4936`, leaving
the result-bytes clause and the read-back guard intact) against **both** versions of the test file:

1. **Against the pre-fix test file** (at commit `2d5b816`, using the old
   `toMatchObject({ kind: "invalid_workspace" })` assertion): the test **passes** under the
   mutation — this reproduces and confirms the original vacuity finding was real, not a
   misdiagnosis.
2. **Against the post-fix test file** (at commit `2c5dd19`, using the new exact-message
   assertion): the test **fails**, because the write-site guard's specific message
   (`"import evidence identity does not match the submitted result bytes"`) no longer fires — the
   read-back guard's different message doesn't satisfy the assertion.

Only this pairing proves the gap is closed: the pre-delta run establishes the mutation is a valid
probe (it reproduces the known-vacuous behavior), and the post-delta run shows the same probe now
gets caught. A reviewer that only runs step 2 has shown the new test *can* fail under some
mutation — not that it specifically closes the gap Cycle 3 named.

## Grading notes

**A passing answer must contain:**
1. Explicit mutation of the same guard clause run against **both** the pre-fix and post-fix
   versions of the test file (or functionally equivalent before/after comparison) — not a single
   mutation against only the current file.
2. The pre-fix result reported as **passing** under mutation (confirming the original vacuity was
   real) and the post-fix result reported as **failing** under the identical mutation (confirming
   closure).
3. Identification that the reason a coarse `kind` matcher was vacuious is a **second guard on a
   different code path** (the read-back guard) raising the same `kind` value — not just "the old
   assertion was too loose" in the abstract.

**Known traps (a failing answer often falls into these):**
- Running the mutation once against only the current (post-fix) file, seeing it fail, and
  declaring the gap closed. This shows sensitivity to *a* mutation, not that the mutation
  specifically reproduces and then closes the *named* prior vacuity.
- Trusting the fix because the exact-message string now appears in the assertion, without ever
  executing a mutation to confirm the message is actually load-bearing (see the companion case on
  isolating which half of a fix is load-bearing).
- Treating "the test currently passes on the clean tree" as evidence of non-vacuity — a vacuous
  test also passes on the clean tree; that is precisely what makes vacuity dangerous.

**Generalizable smell:** whenever a review is asked to verify that a *previously flagged vacuous
test* has been fixed, a single "does it fail under mutation now" check is necessary but not
sufficient — it doesn't distinguish a genuine fix from a differently-shaped vacuity. Re-run the
exact mutation that exposed the original gap against **both** the old and new test file and expect
opposite outcomes; only the contrast is proof.

## Source

- `.workflow/review.md` Cycle 4, "CLOSED — Gap 1: the contract negatives now fail under guard
  removal (proven both directions)" (content preserved above; `.workflow/review.md` deleted per
  wrap).
- `tests/workspace-contract.test.ts` @ `2d5b816` (pre-fix) vs `2c5dd19` (post-fix).
- `src/workspace/product-workspace.ts:4936` (write-site guard) and `:6342` (read-back guard).
