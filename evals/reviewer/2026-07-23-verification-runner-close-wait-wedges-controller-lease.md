# Reviewer golden case — timeout kills only the direct child and waits on `'close'`, wedging the controller lease

- **Seat:** strict reviewer
- **Date:** 2026-07-23
- **Cycle:** ROADMAP 2.3 (External-result import and deterministic verification)
- **Caught at:** Phase 4 review, HEAD `61553dd`
- **Provenance:** written by the default-executor seat, caught by the strict-reviewer seat
  (cross-vendor review at `61553dd`); confirmed **P1**, fixed in the Step 1 patch cycle
  (`.workflow/patch_plan.md`), re-reviewed clean at HEAD `f348592` (degraded same-vendor
  re-review — the original cross-vendor reviewer harness was unavailable for the re-review only).

## Input — diff under review

`src/workspace/product-workspace.ts`, `NodeVerificationRunner.run()`, the local subprocess
runner a controller awaits under an on-disk lease while importing external verification results:

```ts
const child = spawn(command, args, { cwd, env: allowedEnv }); // no `detached: true`

const timer = setTimeout(() => {
  child.kill("SIGTERM");            // direct child only
  setTimeout(() => child.kill("SIGKILL"), killGraceMs);
}, timeoutSeconds * 1000);

child.once("close", () => {         // waits for every pipe-holding descendant to exit
  clearTimeout(timer);
  finish(/* ... */);
});
```

The command under verification is typically `npm run …`, which spawns its own descendant
worker processes. Those descendants inherit `child`'s stdout/stderr pipe file descriptors.

The controller awaits `run()` under a lease released only in a `finally` block
(`work-item-controller.ts`), with no stale-lock reclaim path (`flag: "wx"` → `EEXIST` →
`repair_required`).

**Spec/contract guarantee under test:** verification must be bounded — the controller must be
able to reach a terminal (`passed`/`failed`/`timed_out`) state within `timeout_seconds` and
release its lease, regardless of what the invoked command does internally.

## Approved output — the finding a passing review must produce

A reviewer must flag, at **P1** severity, that this timeout implementation does not actually
bound wall-clock time for commands like `npm run …` that spawn descendants:

1. `child.kill(signal)` (no `detached: true` at spawn, no `process.kill(-child.pid, signal)`)
   signals only the direct child process, not its process group — a descendant worker survives
   both the SIGTERM and the SIGKILL escalation.
2. The runner promise resolves from `child.once("close")`, which fires only once **every**
   pipe-holding process (including surviving descendants) has exited and closed its end of the
   stdio pipes — not from `'exit'` of the direct child, and with no independent deadline-driven
   fallback.
3. Compounding effect: if a descendant hangs (or simply outlives its parent), `'close'` never
   fires, `run()` never resolves, and the `await` inside the controller's operation never
   returns. Because the controller's lease release lives in a `finally` attached to that same
   awaited call, the lease is **never released**, and because there is no stale-lock reclaim,
   the work item is **permanently wedged** — across process restarts, since the lock is on disk.

A passing review must also identify the correct fix shape (not necessarily this exact diff, but
the mechanism): spawn `detached: true` so the child becomes its own POSIX process-group leader,
signal the whole group (`process.kill(-child.pid, signal)`, with an `ESRCH`-safe direct-child
fallback) for both SIGTERM and SIGKILL, and add an independent bounded backstop (e.g. a short
unref'd `drainGraceMs` timer after the SIGKILL escalation) that force-resolves the runner from
already-captured output buffers if `'close'` still hasn't fired — so total wall-clock is bounded
by `timeout + killGrace + drainGrace` regardless of descendant behavior.

## Grading notes

**A passing answer must contain:**
1. Identification that the kill target is the **direct child only** (no process-group signal),
   while the resolve condition is gated on **all** pipe holders via `'close'` — these are two
   separate, compounding bugs, not one.
2. The causal chain to the operational failure mode: unresolved promise → `await` under the
   controller's lease never returns → `finally` release never runs → no stale-lock reclaim →
   the work item is wedged **durably** (on-disk lock, survives restarts), not just slow.
3. Recognizes this is specifically dangerous because the verified commands are typically
   `npm run …`, which routinely spawns descendant workers that inherit stdio pipes — this is not
   a contrived edge case.
4. Names a viable fix mechanism: process-group kill via detached spawn, and a deadline-bound
   resolution path independent of `'close'` (e.g. a drain-grace force-finish), without requiring
   this exact prose.

**Known traps (a failing answer often falls into these):**
- Treating only the missing `SIGKILL` escalation as the bug and missing that even a working
  SIGTERM→SIGKILL escalation to the *direct child* doesn't help — the descendant is the one
  holding the pipes open.
- Proposing to fix this by only changing the resolve event to `'exit'` — `'exit'` fires on the
  direct child's own exit, but the promise is built around `'close'` specifically so buffered
  stdio is fully flushed; the real fix is bounding `'close'` with an independent timer, not
  abandoning it.
- Missing the lease/lock consequence entirely and describing this as merely "the timeout doesn't
  work" rather than surfacing that it durably wedges controller state with no recovery path.
- Suggesting an `unref()` on the main timeout/kill timers as sufficient — `unref()` only affects
  whether the timer keeps the Node process alive, it has no bearing on whether the awaited
  promise resolves or the process group actually dies.

## Source

- `.workflow/review.md` (original P1 at HEAD `61553dd`; re-review resolution at HEAD `f348592`)
- `.workflow/patch_plan.md` Step 1 (fix scope, verification checklist)
- `.workflow/learnings.md` (ROADMAP 2.3 cycle, now routed and deleted)
- `tests/verification-adapters.test.ts`, `tests/application/work-item-controller.test.ts`
  (regression coverage: bounded timeout with a stdout-inheriting descendant; timed-out
  verification clears the durable `active_run` and leaves no `.controller.lock`)
