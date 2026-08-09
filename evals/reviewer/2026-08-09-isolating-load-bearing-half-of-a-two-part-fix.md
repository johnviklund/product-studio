# Reviewer golden case — isolating which half of a two-part fix actually carries the guard

- **Seat:** strict reviewer
- **Date:** 2026-08-09
- **Cycle:** ROADMAP 3.4 Slice 3, Cycle 4 close-out review (delta `2d5b816..2c5dd19`)
- **Caught at:** Phase 4 review Cycle 4, checking a fix that changed two things at once
- **Provenance:** Cycle 3 offered two options to close a vacuous-test gap — use fresh unused
  receipt ids, **or** assert the guard's own message. The delta applied **both** changes at once.
  Cycle 4 (cross-vendor, Claude Opus 5) isolated which of the two actually does the work by
  reverting each half separately, and found one of the two changes does nothing.

## Input — a fix that looks like two changes but is carried by only one

The delta changed the `tests/workspace-contract.test.ts` negatives in two ways simultaneously:

1. Swapped stale receipt ids (`"a"`-derived) for fresh, previously-unused ones (`"c"`/`"b"`).
2. Swapped the assertion from `rejects.toMatchObject({ kind: "invalid_workspace" })` to
   `rejects.toThrow("import evidence identity does not match the submitted result bytes")`.

Bidirectional mutation (see the companion case on proving non-vacuity) already confirmed the
combined fix closes the gap: the guard-removal mutation passes against the pre-fix file and fails
against the post-fix file. But that only proves the *pair* of changes together closes the gap — it
does not say whether both changes are load-bearing, or whether one of them is inert and the whole
fix is carried by the other.

The question this case exams: **when two independent-looking changes ship together as "the fix,"
does a review verify each one's individual contribution, or does it accept the pair on faith once
the combined result passes?**

## Approved output — isolating each half by reverting it alone

The reviewer must construct an **isolation test**: keep one change, revert the other, and re-check
under the same guard-removal mutation used to prove the combined fix works.

- Keep the delta's fresh ids (`"c"`/`"b"`), but revert *only* the two assertions back to the old
  `rejects.toMatchObject({ kind: "invalid_workspace" })`.
- Re-apply the write-site guard mutation (neutralizing
  `expectedImportRunId(evidence) !== evidence.import_run_id` at `product-workspace.ts:4936`).
- Result: the test **passes** under the mutation — i.e., still vacuous. The fresh ids alone do not
  close the gap.

Root cause, verified by reading the guarded code paths rather than assumed: with the write-site
guard neutralized, the (now-fresh) evidence bytes still get written, and the **read-back** guard at
`product-workspace.ts:6342` independently rejects them — a *different* guard, but one that raises
the *same* `kind: "invalid_workspace"`. A coarse `kind` matcher cannot distinguish the two guards
firing, which is exactly how the original assertions were vacuous regardless of which ids are used.

Conclusion: the fresh ids are **not load-bearing** for this specific vacuity gap; the entire fix is
carried by the exact-message assertion (`rejects.toThrow("import evidence identity does not match
the submitted result bytes")`), which pins the write-site guard's specific wording and cannot be
satisfied by the read-back guard's different message.

Disposition recorded: **wontfix (code is correct as shipped)** — the fresh ids are harmless, just
inert for this purpose — but this is captured as a durable learning rather than a code comment,
specifically to warn that a future "cleanup" pass that relaxes the exact-message assertion back to
a `kind`/shape matcher (reasoning that the fresh ids already make the test rigorous) would silently
reopen the exact vacuity this fix closed.

## Grading notes

**A passing answer must contain:**
1. An isolation test that reverts **only one** of the two co-shipped changes (here: keep fresh ids,
   revert to the old coarse matcher) and re-runs the same mutation used to validate the combined
   fix.
2. The correct finding that the reverted-assertion version **still passes** under mutation (i.e.,
   the fresh ids alone are insufficient) — not an assumption that both changes contribute equally
   because they shipped together.
3. Identification of the actual root cause: a **second guard on a different code path** (the
   read-back guard) that raises the same `kind` as the guard under test, which is why only the
   exact-message assertion (not the ids) can discriminate between them.

**Known traps (a failing answer often falls into these):**
- Accepting a two-part fix as fully justified once the *combined* result passes review, without
  checking whether each part individually contributes — this misses that one part can be
  decorative rather than load-bearing.
- Assuming "using fresh ids is generally good practice" is sufficient justification for keeping
  them, without testing whether they specifically address *this* vacuity (they don't — the vacuity
  is about guard identity via `kind`, not about id staleness).
- Recommending removing the "inert" fresh ids as unnecessary cleanup — they are inert for *this*
  gap but still may guard against an unrelated id-collision scenario; the case only shows they
  don't carry the message-assertion fix, not that they're pointless. Overreaching past what the
  isolation test actually proved is itself a review error.

**Generalizable smell:** when a fix ships as two or more changes bundled into a single commit or
patch, review each change's causal contribution independently by reverting one at a time under the
same test that validates the combined result — a passing combined test proves the *pair* works
together, never that each half is individually necessary. This matters most when a second guard or
code path can produce a superficially similar signal (same error `kind`, same status code, same
log line) that masks which specific guard a coarse assertion is actually catching.

## Source

- `.workflow/review.md` Cycle 4, "P3 — Gap 1 is closed by the message assertion alone; the fresh
  ids do no work" (content preserved above; `.workflow/review.md` deleted per wrap).
- `tests/workspace-contract.test.ts` (ids at `"c"`/`"b"`, assertions at the reviewed lines).
- `src/workspace/product-workspace.ts:4936` (write-site guard, message pinned by the fix) and
  `:6342` (read-back guard, same `kind`, different message).
