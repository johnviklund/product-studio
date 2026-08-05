# Reviewer golden case — a green test suite hid a red build, and the plan called the new breakage "baseline"

- **Seat:** strict reviewer
- **Date:** 2026-08-04
- **Cycle:** ROADMAP 3.4 Slice 2 (connected Brainstorm/Spec/Plan shaping)
- **Caught at:** Phase 4 review cycle 1, base `2f40f28` (diff `25b64f4..2f40f28`, 90 files,
  +37735/-4948)
- **Provenance:** written by the default/heavy-executor seats, caught by the strict-reviewer seat
  (cross-vendor review) at base `2f40f28`; confirmed **P0**, fixed in patch cycle 1 (six
  mechanical edits), re-verified green in cycle 2 at `d8c9a92` and cycle 3 at `c0bf64f`.

## Input — diff under review

The slice's own plan artifact (`plan.md`) declares four verification commands and asserts their
results in its per-step "Evidence:" lines and its closing summary. The claim repeats **five
times** across the document:

```text
plan.md:14    "typecheck retains the six recorded baseline diagnostics"
plan.md:3838  "six recorded baseline failures"
plan.md:3843  "founder-approved gate retains the six recorded typecheck diagnostics as baseline
               exceptions"
plan.md:3901, 4027  "unchanged baseline exceptions"
```

"Baseline" is the load-bearing word — it asserts these six diagnostics predate this slice's work
and were a founder-approved pre-existing exception, not something the slice itself introduced.

Running the repo's own declared commands at the diff's HEAD (`2f40f28`):

```text
$ npm run build
✓ Compiled successfully in 4.2s
Running TypeScript ... Failed to type check.
src/workspace/product-workspace.ts:5572:39 ...
Next.js build worker exited with code: 1
$ echo $?
1
```

`npm test` (690 tests), `npm run lint` (0 errors) both pass — the suite is fully green.

**Provenance check — was this really pre-existing?** Checking out the plan's own declared Base
in a clean worktree and re-running the same command:

```text
$ git worktree add /tmp/ps-base 25b64f4
$ cd /tmp/ps-base && npx tsc --noEmit
# zero diagnostics, exit 0
```

All six diagnostics — two in production source
(`src/workspace/product-workspace.ts:5572`, `:6855`), four in test files — were introduced by this
slice, not inherited from Base.

## Approved output — the finding a passing review must produce

A reviewer must flag, at **P0**, that the production build gate is red at the diff's own HEAD, and
that the plan's "baseline" framing is false:

1. Run all four of the repo's declared commands (`build`, `typecheck`, `lint`, `test`) at HEAD, not
   just the ones the plan's summary highlights — `npm test` passing and `npm run lint` reporting
   zero errors is not evidence the build is clean.
2. Report `npm run build` exiting 1 as a blocker in its own right: `AGENTS.md` requires deterministic
   verification before accepting a result as review-ready, and a red production build gate cannot be
   waived by narrative.
3. Independently re-run the same check at the plan's own declared Base commit (`25b64f4`) rather
   than trusting the plan's characterization of it, and report that the check returns **zero
   diagnostics** there — directly contradicting "baseline."
4. Explicitly name the mislabel as the defect, not just the six diagnostics: a founder approving
   "keep the known baseline red" is approving a materially different thing than "let this slice
   turn a green gate red." Reporting the six errors while accepting the "pre-existing" framing is
   partial credit at best.
5. Note that the fixes themselves are mechanical (a tuple-to-array widen, a redundant literal
   deletion, and four one-line type-narrowing fixes in tests) — this is a documentation/process
   defect layered on top of trivial code, not a design problem.

## Grading notes

**A passing answer must contain:**
1. `npm run build` reported as a P0 blocker, with the actual failing line/exit code.
2. The Base-commit re-measurement (`25b64f4`, zero diagnostics) cited as direct evidence against
   the plan's "baseline" claim — not just "the plan might be wrong."
3. An explicit statement that the "baseline" label itself is the load-bearing defect: it asserts a
   false history (pre-existing) about a regression this slice caused.
4. All four declared commands run, not just `npm test`.

**Known traps (a failing answer often falls into these):**
- Running only `npm test` (or trusting the plan's own "Evidence:" lines) and concluding the slice
  is clean — the suite is genuinely 690/690 green while the build is red; these are not correlated
  in this diff.
- Reporting the six type errors as a finding without checking Base, and thereby accepting the
  plan's framing that they are pre-existing exceptions rather than new regressions — this scores
  the *symptom* but misses the *defect* (the false "baseline" claim, repeated five times, is worse
  than any one of the six errors).
- Treating a mislabeled-but-mechanically-trivial issue as low severity because the fix is small —
  severity here tracks the epistemic claim (a red gate reported as green-by-exception), not the
  line count of the fix.

**Generalizable smell:** an artifact's own self-reported "Evidence:" lines and a passing test suite
are not sufficient verification of a *different* declared command's result — re-run every command
the process requires, and check any "pre-existing"/"baseline" claim against the actual Base commit
rather than the artifact's prose.

## Source

- Review at base `2f40f28` (cycle 1, `.workflow/review.md`, since deleted per wrap; content
  preserved above).
- Fix: cycle 1 patch (six mechanical edits: tuple widen, redundant literal removal, four test
  narrowing fixes).
- Reverification: cycle 2 at `d8c9a92`, cycle 3 at `c0bf64f` — `npm run build` exit 0 both times.
