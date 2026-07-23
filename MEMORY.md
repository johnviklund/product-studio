# Product Studio memory

Use this file only for durable, evidence-backed implementation and operating learnings that
will help future work. It is not a product requirements summary, active execution log, or
idea backlog.

## Entry template

### YYYY-MM-DD — concise learning title

- **Scope:** affected product area, workflow, or operating practice.
- **Evidence:** verified command, test, incident, review finding, or shipped result.
- **Guidance:** the reusable decision, constraint, or practice.
- **Supersession:** active, replaced by <link>, or retired because <reason>.

## Learnings

### 2026-07-23 — Substitute a human visual-approval checkpoint when no browser-control backend exists

- **Scope:** Phase 3 browser/UI QA for any UI-facing roadmap step, when the environment has no
  browser-automation backend and adding one solely for a QA checkpoint is out of scope.
- **Evidence:** Roadmap 2.4's `Run evidence` panel QA (populated and fail-closed Execute cards)
  was verified by preparing ignored local fixtures on the already-running dev app, presenting the
  exact review states to the human, and recording their explicit approval in
  `.workflow/plan.md`'s Deviations — the user explicitly declined a CE-specific setup dependency.
- **Guidance:** When no browser-control backend is available, don't add a CE or browser
  dependency solely to satisfy a QA checkpoint. Instead, prepare ignored local fixtures on the
  already-running app, present the exact review states to the human, and record explicit visual
  approval as a logged Deviation.
- **Supersession:** active.

### 2026-07-23 — Publish immutable import evidence before the controller mutation it backs

- **Scope:** External result import (roadmap 2.3), any recoverable multi-step controller
  operation that must not repeat an authoritative side effect on replay.
- **Evidence:** `tests/application/work-item-controller.test.ts` imports a green result once and
  replays immutable evidence without rerunning the underlying verification/import command; the
  content-addressed evidence file is written and durable before the controller's state mutation
  commits, so a crash between the two leaves evidence a replay can reconcile from without
  re-invoking the authoritative command.
- **Guidance:** Order any two-step "produce evidence, then mutate state" operation so the
  content-addressed, immutable evidence publish happens strictly before the state mutation; on
  replay, reconcile a missing mutation from the existing evidence file instead of re-running the
  command that produced it.
- **Supersession:** active.

### 2026-07-23 — Local verification runner: process-group kill + bounded drain backstop, not just direct-child TERM/KILL

- **Scope:** `NodeVerificationRunner` (`src/workspace/product-workspace.ts`) and any local
  subprocess runner awaited under a controller lease (roadmap 2.3 external verification).
- **Evidence:** Confirmed P1 at HEAD `61553dd` (`.workflow/review.md`, `.workflow/patch_plan.md`):
  spawning without `detached: true` and resolving the runner promise from `'close'` let a
  `npm run …` descendant that inherits stdout/stderr survive a direct-child kill and hold
  `'close'` open forever — the controller lease is released only in `finally`, so a hung
  descendant permanently wedged the work item with no stale-lock reclaim. Fixed by spawning
  `detached: true`, killing the whole process group (`process.kill(-child.pid, signal)` with an
  `ESRCH`-safe direct-child fallback) for both SIGTERM and the SIGKILL escalation, and adding an
  unref'd `drainGraceMs` timer after SIGKILL that force-finishes from already-captured buffers if
  `'close'` still hasn't fired — bounding total wall-clock to `timeout + killGrace + drainGrace`.
  Verified by a focused runner test (TERM-ignoring child with a stdout-inheriting descendant
  still resolves `timed_out` within budget) and a controller test (timed-out verification clears
  the durable `active_run` and leaves no `.controller.lock`). A local verification runner should
  also use argv-only spawn (no shell), an explicit environment allowlist, and per-stream byte
  caps, recording every terminal outcome as structured evidence.
- **Guidance:** Any local subprocess runner awaited under a lease/lock must (1) spawn detached
  and kill by process group, not just the direct child, (2) resolve from a bounded timeout path
  independent of `'close'`/`'exit'` waiting on descendant pipe holders, and (3) use argv-only
  spawn, an env allowlist, and per-stream byte caps. POSIX-only process-group kill is an accepted
  constraint for a Darwin/Linux-only target.
- **Supersession:** active.

### 2026-07-21 — Break schema/cache circular deps at the value-object seam, not the aggregate

- **Scope:** Domain schemas and the rebuildable SQLite cache projection (roadmap 1.4, source-qualified capture work).
- **Evidence:** Importing a source-ID validator from the aggregate `portfolio` module into `work-item` schemas created a runtime circular dependency; extracting the validator into a dependency-free `portfolio-source.ts` value-object module (re-exported by `portfolio.ts`) resolved it without changing public imports. Separately, cache rows rehydrated from SQLite must omit NULL-backed optional keys rather than passing them as explicit `null` — nullable SQL columns are a projection detail, not a durable schema value, and `strictObject` validation rejects the extra key otherwise.
- **Guidance:** When a schema needs a validator owned by another aggregate module, extract the shared piece into its own small value-object module first rather than importing across aggregates. When projecting SQLite rows back into strict domain schemas, drop NULL-backed optional keys during rehydration instead of setting them to `null`.
- **Supersession:** active.

### 2026-07-21 — Transfer recovery must trust durable target state, not the journal stage alone

- **Scope:** Cross-workspace work-item transfer (recoverable capture moves, roadmap 1.4).
- **Evidence:** `tests/application/portfolio.test.ts` exercises a crash after atomic publish but before the journal is rewritten to `published`; recovery that only reads the journal's `staged` field would wrongly roll back and lose the moved item. Recovery instead re-checks the actual target/source filesystem state before deciding to complete vs. roll back. An unpublished `staged` rollback also needed a dedicated `discardStagedWorkItem` repository primitive so the orchestration layer isn't reaching into workspace filesystem internals directly.
- **Guidance:** Any journal/WAL-based recovery path must re-derive its decision from durable target state at recovery time, not just the last-written journal stage. Give orchestration a dedicated repository primitive for each cleanup action instead of having it manipulate another module's filesystem internals directly.
- **Supersession:** active.

### 2026-07-17 — Isolate this repo's Git identity/auth from the work GitHub account

- **Scope:** Local development environment (macOS laptop shared by personal and work GitHub accounts).
- **Evidence:** `gh auth status` shows two logged-in github.com accounts with `jviklun1` (work) active; `gh auth git-credential` only returns the **active** account token and returns nothing for a URL-pinned username, so HTTPS pushes would use the work account. `ssh -T git@github.com` authenticates as `johnviklund` (personal). SSH push of the baseline to `johnviklund/product-studio` succeeded.
- **Guidance:** This repo uses an SSH remote (`git@github.com:johnviklund/product-studio.git`) with a repo-local pinned key (`git config --local core.sshCommand "ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes"`) and a repo-local personal identity (`user.email john@viklund.se`). Do not switch it to HTTPS/`gh` credentials, which resolve to the active (work) account. Make no global git/gh changes for this.
- **Supersession:** active.

## Routing

- Put speculative product decisions in `PRODUCT.md`.
- Keep active execution detail in `.workflow/`.
- Capture new ideas and future changes in `TODO.md` through `workflow todo`.
