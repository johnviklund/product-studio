# Reviewer golden case — a spot check found the unlocked door and missed two thirds of the building

- **Seat:** strict reviewer
- **Date:** 2026-08-05
- **Cycle:** ROADMAP 3.4 Slice 2 (connected Brainstorm/Spec/Plan shaping)
- **Caught at:** Phase 4 review cycle 2, base `d8c9a92`, checking cycle 1's own finding at
  `2f40f28` against the full `app/api` surface
- **Provenance:** cycle 1 (strict-reviewer seat) reported 3 unguarded routes; cycle 2 (same seat,
  fresh context) re-derived the same claim by enumerating the whole handler surface and found 16.
  Confirmed **P1** in cycle 2; the 3 in-slice routes closed in the same patch cycle, the other 13
  deferred to `TODO.md` by explicit decision (D6).

## Input — the control and what a full sweep finds

The control: cycle 1 of this same review (see the sibling case
`2026-08-04-csrf-control-missing-on-approval-gate.md`) correctly identified that
`assertTrustedRequestOrigin` was missing from three `mission/connected/*` routes.

The question this case exams: **is 3 the whole story?** Sweeping every route file under `app/api`
that exports a `POST`/`PATCH`/`PUT`/`DELETE` handler and checking each for
`createShapingPostRoute` or `assertTrustedRequestOrigin` directly (not by grepping the `mission/`
subtree cycle 1 had been working in):

- **42 mutating route files total.**
- **26 guarded** at cycle 1's HEAD — every `shaping/**` route plus `repair-controller-lease`.
- **16 unguarded**, including:
  - `[workItemId]/route.ts` PATCH → `service.updateWorkItemPhase` — cross-origin **phase
    transitions** on any work item.
  - `workspaces/route.ts` POST → `service.register()` → `resolve(workspace_path)` — indexes an
    **attacker-chosen filesystem path**, persisted to the registry.
  - `work-items/rebuild/route.ts` POST — takes **no request body at all**, so a bare
    auto-submitting cross-origin `<form>` fires it with zero preparation.
  - The 3 `mission/connected/*` routes cycle 1 already named.
  - 12 more mission/patch/review/import/create routes, listed in full in `.workflow/review.md`
    cycle 2 findings (since deleted per wrap).

`git diff --stat 25b64f4..2f40f28` over the unguarded set confirms only the 3
`mission/connected/*` routes were touched by this slice — the other 13 are pre-existing and
untouched, and neither group is a regression (`request-origin.ts` is new in this slice, so nothing
was guarded at Base).

## Approved output — the finding a passing review must produce

A reviewer re-examining this same area must not simply reproduce cycle 1's 3-route answer. It must:

1. Enumerate the **full** handler surface under `app/api` (every mutating route file), not just
   the subtree the diff or the previous finding happened to be anchored in.
2. Report a **count** against that full surface: 42 mutating routes, 26 guarded, 16 unguarded.
3. Surface the highest-impact members of the unguarded set by name — at minimum the PATCH
   phase-transition route and the `workspaces` registration route — not just repeat the
   `mission/connected/*` three.
4. Keep the scope split honest: 3 of the 16 are in this slice's own diff (fix now, same patch
   cycle); the other 13 are pre-existing and belong to a separate, explicitly deferred slice —
   neither group is a regression, since the origin-check helper itself is new in this diff.
5. Recognize *why* the narrower answer happened: cycle 1 arrived at this area from the
   connected-run subsystem and grepped the directory it was already standing in — a spot check,
   not an enumeration — and reproducing that same scope in a fresh pass is the failure mode being
   examined, not merely "did you find 3 routes."

## Grading notes

**A passing answer must contain:**
1. An enumerated count over the full route surface (42 / 26 / 16), not a re-statement of the
   3-route finding.
2. At least the PATCH phase-transition route and the `workspaces` route named as high-impact
   unguarded members.
3. The 3-in-slice vs. 13-pre-existing scope split, correctly classifying neither as a regression.

**Known traps (a failing answer often falls into these):**
- Reproducing the exact 3-route answer from the prior finding with full confidence — every word of
  it is true, but a reviewer that stops there scores low on this case, because the case exams
  *enumeration versus spot check*, not whether the 3-route finding itself is correct.
- Folding all 16 unguarded routes into "this slice's problem" and demanding they all be fixed in
  the same patch cycle — 13 of them are pre-existing and untouched; treating them as an in-scope
  regression is a calibration failure in severity/scope, not a stronger finding.
- Reporting a vague "there are probably more unguarded routes" without an actual enumerated count
  — the case specifically rewards the count and the concrete list, not a hedge.

**Generalizable smell:** when a review of a new control's coverage arrives at an area from one
subsystem's diff (grep-scoped to the files already open), the reviewable question is not "is this
one door locked?" but "how many doors exist, and which does this change leave open?" — a control
introduced mid-codebase should be checked against the *whole* surface it claims to protect, not
just the files the diff touched.

## Source

- Cycle 1 finding and cycle 2 re-derivation, both in `.workflow/review.md` (since deleted per
  wrap; content preserved above), cycle 2 at base `d8c9a92`.
- Disposition: 3 in-slice routes fixed same patch cycle (`31e7f0f`); 13 pre-existing routes
  deferred to `TODO.md` under "Guard the 13 remaining unguarded mutating API routes" by
  patch-cycle decision D6 (2026-08-05), re-verified as 29 guarded / 13 unguarded of 42 in cycle 3
  at `c0bf64f` (the 3 delta from cycle 2's 16 accounts exactly for the 3 now-guarded routes).
