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

### 2026-07-26 — ACP's `requestPermission` callback does not gate every workspace mutation; normalize and evaluate per canonical operation

- **Scope:** Any local/CLI agent adapter reached over ACP (verified against Copilot CLI 1.0.75,
  ACP v1, SDK 1.3.0) that Product Studio must fail closed against.
- **Evidence:** The live feasibility gate (`.workflow/acp-feasibility-evidence.json`, superseded
  interpretation preserved as historical evidence in `.workflow/plan.superseded.md`) observed a
  file write complete without a client `requestPermission` call, while a shell command did
  request explicit one-shot permission — so relying on ACP's `requestPermission` callback alone
  cannot enforce an allow-only path/tool/network envelope. ACP v1 also exposes only a generic
  `requestPermission` tool call, not a canonical command/URL/path operation
  (`src/infrastructure/acp/acp-client.ts`, `src/domain/capability-envelope.ts`).
- **Guidance:** Keep raw-to-canonical request normalization inside each provider's own profile
  (`normalize_permission`), and let the shared ACP client core evaluate only a successfully
  normalized `CanonicalCapabilityRequest` against the immutable capability envelope. Treat any
  operation ACP surfaces without a callback as already inside the adapter's own execution —
  Product Studio's guarantee is result-scope validation on import, not interception of every
  mutation (`permission_mediated_local` / `not_independently_enforced`, not physical containment).
- **Supersession:** active.

### 2026-07-26 — Copilot ACP reference profile: fail closed before spawn, never trust requested identity

- **Scope:** `src/infrastructure/acp/copilot-runtime-profile.ts` and any future ACP provider
  profile.
- **Evidence:** `createCopilotRuntimeProfile` requires the requested model to appear in an
  explicitly preflighted `available_model_ids` list and throws before ever invoking the adapter
  otherwise (`tests/infrastructure/acp/copilot-runtime-profile.test.ts` — "fails an unknown model
  before invoking the ACP adapter and never falls back"); `extractEffectiveModel` only accepts a
  model identity sourced from a verified ACP config-option event, never from the requested
  `--model` value or `"auto"`; the child environment is built from an explicit non-secret
  allowlist (`SAFE_ENVIRONMENT_KEYS`), confirmed not to leak a credential value into any produced
  record.
- **Guidance:** A provider profile for a locally spawned agent must (1) fail before spawn on an
  unavailable/unverified model rather than falling back silently, (2) treat "effective model" as
  constructible only from an adapter-observed event, and (3) build the child environment from an
  explicit allowlist rather than passing through the parent process environment.
- **Supersession:** active.

### 2026-07-26 — Serialize ACP session-update and permission callbacks before recording evidence

- **Scope:** `StdioAcpSession` (`src/infrastructure/acp/acp-client.ts`) and any ACP client core
  handling concurrent protocol callbacks.
- **Evidence:** `requestPermission` and `session/update` notifications can arrive interleaved from
  the agent process; recording them without ordering risks non-deterministic evidence sequencing.
  `enqueueCallback` funnels both callback kinds through one serialized promise chain before each is
  recorded and hashed, verified by `tests/infrastructure/acp/acp-client.test.ts`'s ordered
  `previous_event_sha256` chain assertion.
- **Guidance:** When a protocol exposes multiple callback types that can fire concurrently for one
  session, funnel all of them through a single serialized queue before recording or exposing them,
  so the hashed evidence chain and any observer callbacks preserve true protocol order.
- **Supersession:** active.

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
  operation that must not repeat an authoritative side effect on replay — including a connected
  launch that starts a long-running external process (roadmap 3.3).
- **Evidence:** `tests/application/work-item-controller.test.ts` imports a green result once and
  replays immutable evidence without rerunning the underlying verification/import command; the
  content-addressed evidence file is written and durable before the controller's state mutation
  commits, so a crash between the two leaves evidence a replay can reconcile from without
  re-invoking the authoritative command. The connected-execute launch path applies the same shape
  one boundary earlier: the durable run record (with its atomically created launch guard) is
  persisted and the controller lease released *before* the ACP child process is spawned, so the
  short-lived lease never spans the long-running external run and a replay finds exactly one
  durable nonterminal run instead of spawning a duplicate.
- **Guidance:** Order any two-step "produce evidence, then mutate state" operation so the
  content-addressed, immutable evidence publish happens strictly before the state mutation; on
  replay, reconcile a missing mutation from the existing evidence file instead of re-running the
  command that produced it. When the follow-on work is a long-running external process rather
  than an in-process step, release the controller lease before starting it — never hold a
  short-lived lease for the duration of an external run.
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
