# Reviewer golden case — an age-only stale-lock takeover can steal from a live publisher

- **Seat:** strict reviewer
- **Date:** 2026-08-12
- **Cycle:** ROADMAP 4.1 semantic-event contract and durable publishing, Cycle 2 review (base
  `620ef99`, diff `620ef99..3dcdb05`)
- **Caught at:** a throwaway reviewer-written probe that paused a real publisher mid-reservation
  and started a second workspace instance on the same root, after a green `42 files / 867 tests`
  suite (including the append lock's own regression tests) found nothing wrong
- **Provenance:** finding recorded in this session's `.workflow/review.md` "Cycle 2 findings"
  section; fixed across commits `4e810d4`, `434d1dd`, `b563280`, `7ed229a` (reviewed clean in the
  following Cycle 3, base `7ed229a`).

## Input — a mutual-exclusion lock that infers abandonment from age instead of owner liveness

The diff under review adds `withSemanticEventAppendLock`, an exclusive lock guarding all writes to
a work item's semantic-event ledger (`src/workspace/product-workspace.ts`). Acquisition uses
`open(lockPath, "wx")`, which fails `EEXIST` if the lock file already exists. On that failure, the
code must decide whether the existing lock is still held by a live process or was abandoned by a
crashed one, so it can reclaim it instead of waiting forever.

The code as submitted:

```ts
let lockStats;
try {
  lockStats = await lstat(lockPath);
} catch (lockError) {
  if (isNodeError(lockError) && lockError.code === "ENOENT") {
    continue;
  }
  throw lockError;
}
const staleByAge =
  Date.now() - lockStats.mtimeMs >= DEFAULT_EXCLUSIVE_WAIT_MS;
if (staleByAge) {
  await unlink(lockPath);
  continue;
}
if (lockStats.size === 0) {
  await new Promise((resolveDelay) =>
    setTimeout(resolveDelay, DEFAULT_EXCLUSIVE_POLL_MS),
  );
  let confirmedStats;
  try {
    confirmedStats = await lstat(lockPath);
  } catch (lockError) {
    if (isNodeError(lockError) && lockError.code === "ENOENT") {
      continue;
    }
    throw lockError;
  }
  if (
    confirmedStats.size === 0 &&
    confirmedStats.mtimeMs === lockStats.mtimeMs
  ) {
    await unlink(lockPath);
    continue;
  }
}
// ... otherwise wait and retry until deadline, then throw repair_required
```

Both reclamation branches infer abandonment from a *time-based signal on the lock file itself* —
its `mtimeMs` age, or an unchanged zero-byte size across one poll interval — never from any
evidence about whether the process that created the lock is still running. `DEFAULT_EXCLUSIVE_WAIT_MS`
is 15 minutes; any lock older than that is treated as dead regardless of whether its owner is
mid-operation.

The lock file itself carries no owner identity at this point in the diff (`open(lockPath, "wx")`
writes only `token`, a random UUID, to the file — nothing that names a pid or host). So even a
reviewer who wanted to check liveness would find there is no owner information recorded to check
against.

The question this case exams: **does the reviewer notice that "old" and "abandoned" are being
conflated, and that the fix must persist owner identity before it can safely tell them apart** —
rather than accepting a green suite (including a same-cycle "abandoned lock is reclaimed" test) as
proof the mechanism is sound?

## Approved output — identify the age/liveness conflation and require owner-evidence gating

A passing review must report, as a fix-now finding (not a defer-worthy nit), that
`withSemanticEventAppendLock`'s reclamation logic can steal a lock from a publisher that is still
alive and mid-operation, merely because it has been slow or paused for 15+ minutes. The expected
reasoning chain:

1. Both reclamation branches (`staleByAge`, and the zero-byte "unchanged across one poll" check)
   are decisions based purely on the passage of time or an absence of *observed* change — neither
   is evidence that the original owner has actually died.
2. A slow, suspended, or GC-paused live publisher that legitimately holds the lock past the wait
   budget will have its lock unlinked out from under it by a second caller, exactly as if it had
   crashed.
3. Because the original code writes only a random token (no pid, no hostname, no acquired-at
   timestamp) into the lock file, there is no way to add a liveness check without first changing
   what the lock file *contains* — the fix is not "add a check," it is "make the check possible."
4. The impact is asymmetric and expensive: the stolen-from publisher's mutation may have already
   become durable by the time it discovers the lock is gone, so it can return an error for an
   operation that actually succeeded, while a second publisher proceeds concurrently through the
   same "abandoned" reclamation path — the lock briefly fails to serialize two live critical
   sections.
5. The fix must **not** just raise the age threshold or add a liveness *hint* — it must persist an
   owner identity (e.g. pid + hostname, written atomically with the lock's existence, not writable
   after the fact) and require a failed liveness probe against that specific owner before any
   reclamation, replacing age as the abandonment signal rather than supplementing it.

## Grading notes

**A passing answer must contain:**

1. The core conflation named explicitly: the code treats "the lock file looks old" or "the lock
   file didn't change for one poll" as proof of abandonment, when neither implies the owning
   process has exited.
2. The concrete mechanism of the failure: a live, slow, or paused publisher past the wait budget is
   indistinguishable, under this logic, from a crashed one — and will be reclaimed the same way.
3. The reason a same-cycle regression test suite passing (including a test that reclaims a
   genuinely abandoned lock) does not clear this finding — none of those tests pause a *live*
   publisher and attempt concurrent reclamation, so the suite is green while the defect is real.
4. The correct repair shape: persist an owner identity at acquisition time and gate every
   reclamation on a liveness check against that recorded owner, not on age or an absence of
   observed change.
5. Naming that the fix requires a schema/data change (owner identity must exist in the lock file)
   before a liveness check is even possible — not just an added `if` condition.

**Known traps (a failing answer often falls into these):**

- Accepting the finding as low-severity or a defer-worthy edge case. The impact is a live
  publisher's already-durable mutation getting reported as failed while a second publisher runs
  concurrently against the same "vacated" ledger — this is a correctness defect, not a nit.
- Proposing to simply raise `DEFAULT_EXCLUSIVE_WAIT_MS` or add a second time-based check (e.g.
  "require staleness for 2 poll intervals instead of 1"). Any purely time-based signal has the
  identical defect at a different threshold; the fix must be evidence-based, not longer-timeout.
- Treating the passing test suite as sufficient evidence the mechanism is sound. The suite's own
  "abandoned lock is reclaimed" test only proves the reclamation path works when the owner really
  is gone — it says nothing about what happens when the owner is merely slow.
- Missing that the current lock file format has no owner identity to check liveness against, and
  therefore proposing a liveness check without also flagging that the write path must change to
  persist that identity first.
- Suggesting the fix should also add cross-host support, or reject all age-based signals entirely
  (e.g. for a *foreign*-host owner, where a liveness probe is not locally possible and some
  age/manual-intervention fallback may still be legitimate) — the finding is about *local* liveness
  being available and unused, not that age can never be part of any lock's story.

**Generalizable smell:** any mutual-exclusion or lease mechanism that infers "the previous holder
is gone" from *time elapsed* or *no observed change*, rather than from evidence tied to the actual
holder (a pid probe, a heartbeat, a fencing token), will eventually steal from a holder that is
merely slow. A green test suite exercising only the "truly abandoned" and "still fresh" cases will
never expose this, because the exposing scenario requires deliberately pausing a live holder past
the timeout and attempting concurrent reclamation — a scenario the reviewer has to construct, not
one that shows up by chance in ordinary test runs.

## Source

- `src/workspace/product-workspace.ts`, `withSemanticEventAppendLock`, at base `620ef99` (pre-fix)
  and the fix landed across `4e810d4`, `434d1dd`, `b563280`, `7ed229a`.
- This session's `.workflow/review.md`, "Cycle 2 findings" → the P2 titled "Age-only stale-lock
  takeover can steal from a live publisher", and "Cycle 2 verdict".
- Reviewer probe evidence (throwaway, removed after the run): a real publisher paused in
  `afterSemanticSequenceReserved` with its still-owned, non-empty `.append.lock` aged past the
  wait budget; a second `ProductWorkspace` instance on the same root then settled successfully
  (`CONTENDER=fulfilled`) before the original publisher's own operation later rejected
  (`HOLDER=rejected`) — proving the lock failed to serialize the two overlapping critical sections.
