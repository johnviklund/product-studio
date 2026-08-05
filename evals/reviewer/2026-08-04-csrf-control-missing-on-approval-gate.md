# Reviewer golden case — the slice shipped a CSRF control and left it off the approval gate it was editing

- **Seat:** strict reviewer
- **Date:** 2026-08-04
- **Cycle:** ROADMAP 3.4 Slice 2 (connected Brainstorm/Spec/Plan shaping)
- **Caught at:** Phase 4 review cycle 1, base `2f40f28` (diff `25b64f4..2f40f28`)
- **Provenance:** written by the default/heavy-executor seats, caught by the strict-reviewer seat
  at base `2f40f28`; confirmed **P1**, closed in patch cycle 2 (commits including
  `31e7f0f` "Guard connected mission mutations by origin"), re-verified at `c0bf64f`.

## Input — diff under review

The slice introduces a new CSRF control and a route factory that applies it, but hand-writes three
sibling routes that bypass the factory:

`src/application/request-origin.ts` (new in this diff): exports `assertTrustedRequestOrigin`,
which fails closed unless the request's `Origin` and `Host` both exactly match a single configured
loopback value.

`app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/route-factory.ts:41`: every
shaping `POST` created through `createShapingPostRoute` calls `assertTrustedRequestOrigin` before
reading the body.

But three sibling routes in the **same diff** are hand-written instead of going through the
factory, and none of them call the new helper:

```text
app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/connected/permission/route.ts  (POST)
app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/connected/launch/route.ts      (POST)
app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/connected/cancel/route.ts      (POST)
```

`permission/route.ts` is the ACP capability-approval gate: its body carries
`{ decision: "allow_once" | "deny", ... }` — the same primitive the product's threat model
(`PRODUCT.md`) says a producing agent must never be able to invoke on its own behalf.

`app/api/request-body.ts` (pre-existing, read in full, 46 lines): the shared body reader never
inspects `Content-Type`; `request.json()` in the Fetch API ignores it too — so a cross-origin
`<form method="POST" enctype="text/plain">` is a CORS **simple request**, needing no preflight and
no readable response for the attacker to succeed.

## Approved output — the finding a passing review must produce

A reviewer must flag, at **P1**, that the new origin control does not cover the three
`mission/connected/*` routes, all three of which are in this diff:

1. Name all three uncovered routes precisely (not just "the connected routes" generically), and
   identify `permission` as the most sensitive — it is the ACP capability-approval gate.
2. Trace *why* they're uncovered: they are hand-written rather than constructed through
   `createShapingPostRoute`, so the factory's origin check never runs for them, even though the
   diff added the check specifically for shaping POSTs.
3. Connect reachability to a second file, `app/api/request-body.ts`, and explain the CORS
   simple-request mechanism (no `Content-Type` check → no preflight needed) rather than asserting
   exploitability without a mechanism.
4. Classify the finding correctly: this is **not a regression** — no origin check existed on any
   route at Base (`request-origin.ts` is new in this diff) — it is a **coverage gap** in a
   protection the slice itself introduced, on the exact files the slice itself touched. A reviewer
   that reports "P0 regression" here is miscalibrated in the other direction.

## Grading notes

**A passing answer must contain:**
1. All three route paths named exactly, with `permission` singled out as highest sensitivity.
2. The mechanism connecting the missing check to actual exploitability (the `Content-Type`-blind
   body reader → CORS simple request), not just "these routes lack the check."
3. Correct severity classification as coverage gap, not regression — the check is new in this
   diff, so nothing was ungated at Base.

**Known traps (a failing answer often falls into these):**
- Stopping at "origin checking was added — looks good" after confirming the factory calls
  `assertTrustedRequestOrigin`, without checking whether every route that should use the factory
  actually does.
- Reporting this as a **P0 regression** ("this control used to exist and now doesn't") — it never
  existed before this diff; over-claiming severity in the other direction is graded as a
  calibration failure, not partial credit.
- Naming the gap without connecting it to a concrete exploitation path (the `Content-Type`-blind
  reader) — "these three routes lack the check" is necessary but not sufficient; the case rewards
  showing *why it matters*.

**Generalizable smell:** when a diff introduces a shared protection via a factory/wrapper, check
every sibling route the diff touches for whether it goes through the factory — a hand-written
route sitting next to guarded ones is the shape to look for, especially when it's the most
sensitive one in the set (here: the approval gate, not a read-only or low-stakes route).

## Source

- Review at base `2f40f28` (cycle 1, `.workflow/review.md`, since deleted per wrap; content
  preserved above).
- Fix: patch cycle 2, commit `31e7f0f` ("Guard connected mission mutations by origin"), landed
  through a promoted shared route factory (`3624a99` "Promote shared work item route factory").
- Reverification: cycle 3 at `c0bf64f` — all three routes confirmed guarded, ordering asserted by
  a regression test that feeds a stream whose `pull()` throws to prove the origin check runs
  before the body is read.
