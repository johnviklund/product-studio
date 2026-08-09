# Product Studio TODO

This is the human's workflow-managed intake scratchpad, not a roadmap. Use `workflow todo`
to capture, shape, merge, update, or archive future work; `ROADMAP.md` owns the initial
delivery phases.

## Active Initiatives

### Give Execute and Review the same simplified card view as Idea through Plan

- **Status:** Proposed — the founder cannot tell what an execute item is doing. Found 2026-08-09 on
  `wi_f2d97c58`.
- **Idea:** `shapingEligible` gates the simplified decision card on `isShapingPhase`, so Idea,
  Brainstorm, Spec, and Plan get a card that states the situation and offers one obvious next
  action, while Execute, Review, and Patch drop straight to the dense full work item panel. Landing
  in Execute, the founder could not tell whether a run was in flight, had stopped, or had failed —
  in fact the run had already failed 19 seconds in, and nothing on the surface said so.
- **Purpose:** These are the phases where runs actually execute commands and change the repository,
  so they are exactly where an unreadable surface is most expensive.
- **Definition of done:** Execute and Review present the same shape as the shaping phases — current
  status in one sentence, whether a run is live, and the single next action — with the full panel
  available behind an explicit affordance rather than as the default.
- **Boundary:** Do not fork a second projection; extend the existing decision-view contract so the
  phases stay consistent. Keep review read-only.

### Let the agent recover from a request the runtime cannot interpret

- **Status:** Proposed — defect, ends runs the agent could have salvaged. Found 2026-08-09 on
  `wi_f2d97c58`, which died 19 seconds in on its first command.
- **Idea:** An unnormalizable request is rejected with a bare `reject_once`; the agent is never told
  what was wrong with it. The mission guidance already forbids shell operators and multi-line
  commands, and the agent violated it anyway, then gave up immediately rather than reformulating.
  The controller now records a precise reason, but that reason is only shown to the founder after
  the run is already dead.
- **Purpose:** A run that dies on a malformed request wastes a full launch cycle over a mistake the
  agent could have fixed in one turn.
- **Definition of done:** The rejection reason travels back to the agent in the permission response,
  and a run only fails on an unnormalizable request after the agent has had a bounded chance to
  reformulate it.
- **Boundary:** Do not widen `parseRestrictedShellWords` — it is the containment boundary. Explain
  the rejection; never accept the request.
- **Note 2026-08-09:** The ACP permission response carries only `outcome` plus a `_meta` field that
  implementations must not rely on, so there is no protocol channel to explain a rejection inline.
  The controller-authored commit below removes the largest source of these rejections, but the
  general case still needs a design that does not depend on `_meta`.

### Stop letting guidance-text changes strand every compiled mission

- **Status:** Delivered 2026-08-09 (commit `fc5b153`).
- **Why it was a defect:** `TASK.md` is a pure rendering of `mission.json`, but the snapshot check
  compared it by re-rendering and erroring on any difference. Editing the guidance text therefore
  invalidated every mission package compiled before that edit, on both the read and the write path,
  with `immutable mission snapshot differs from the compiled package` and no recovery. The previous
  commit changed the execute guidance and stranded every execute mission in the workspace, which is
  how it was found — `Launch connected run` could not compile or read anything.
- **Fix:** `mission.json` is still compared byte-for-byte, since it is the governed contract and the
  only real tamper signal. A differing `TASK.md` is treated as staleness and re-derived atomically
  from the verified mission, so the agent still reads exactly what the mission says. Shaping
  snapshots had the same flaw and share the repair.
- **Tradeoff accepted:** a historical `TASK.md` is rewritten to the wording its own schema version
  renders, so its bytes are no longer preserved verbatim across a renderer change. Version-specific
  renderers still keep older schema versions rendering their own text.

### Author the result commit in the controller so agents never run Git
- **Status:** Delivered 2026-08-09. Execute results may now omit `commit`; the controller validates
  the retained worktree against `allowed_scope` and the reported `changed_files`, then commits it
  with the work item title via `commitWorktreeExcludingFounder`. `.founder/` is excluded from the
  commit by pathspec. Mission guidance now tells the agent not to run Git at all.
- **Why it was a defect:** Every execute mission starts with zero approved commands, the capability
  envelope matches commands by exact argv, and the result contract required the agent to commit. An
  agent could therefore only commit if the founder had pre-approved the exact commit argv, message
  included — which nobody can know in advance. On `wi_f2d97c58` that produced 8 runs across 4
  attempts, 4 approved commands (all of them incidental exploration), 1 edit attempt and 0 results.
- **Boundary preserved:** out-of-scope worktree paths still reject before anything is committed, the
  reported `changed_files` must still match the worktree exactly, and the controller still runs
  authoritative verification rather than trusting the agent's self-report.

### Report why a shaping run failed instead of a generic sentence

- **Status:** Partly delivered — an unnormalizable permission request now names its precise cause
  in the run's terminal reason (commit below); a limit breach or adapter crash is still generic.
  Found 2026-08-09 on `wi_f2d97c58` ("View full work item page lacks a to navigate back").
- **Idea:** The plan run was killed by a containment limit after it had already written a complete,
  valid `result.json`. The founder saw only "The agent or result validation failed." and `run.json`
  recorded only `shaping_failed`. Nothing anywhere named the real cause; diagnosing it took reading
  the raw event log and measuring its byte size against the profile limits. `resultFromError`
  discards the error it caught, so `AcpRunResult` cannot distinguish a limit breach, a refusal, or
  an adapter crash — they all arrive as bare `failed`.
- **Purpose:** A failure the founder cannot act on is worse than no failure at all; it costs an
  expensive run and teaches nothing.
- **Definition of done:** A terminal failure carries a machine-readable cause from the adapter
  through to the board copy, so the founder is told which limit or condition ended the run.
- **Boundary:** Do not leak private agent output into the reason; the cause is a classification,
  not a transcript.

### Accept a shaping result that the agent already wrote before the run was killed

- **Status:** Proposed — defect, discards correct work. Found 2026-08-09 on `wi_f2d97c58`.
- **Idea:** The plan agent wrote a complete, schema-valid result into its single ingress file, and
  the run was then killed by a containment limit. The controller judged the run purely by the ACP
  outcome and threw the artifact away, so the founder had to pay for the whole run again. The
  ingress file is the mission's only deliverable and it was already sound.
- **Purpose:** Containment should bound what a run may do, not destroy what it correctly produced.
- **Definition of done:** When a shaping run ends non-clean but its ingress artifact validates
  against the mission identity and content hash, the founder is offered that result rather than
  only a retry.
- **Boundary:** Never accept an artifact that fails identity or schema validation, and keep the
  run's terminal outcome honest — offering the artifact is not the same as reporting success.

### Compile the mission package that a tuple-advancing transition points at

- **Status:** Proposed — defect, found 2026-08-09 running a live connected cycle.
- **Idea:** Transitions that advance the governed tuple rewrite `goal`/`state` but never compile
  the mission package for the new tuple, so the very next controller call resolves a directory
  that does not exist. Observed twice in one cycle on `wi_b9b852f6` ("Close project menu"):
  `applyScopeCorrection` bumped `2-2-0` and left `.founder/missions/.../execute-2-2-0` missing, and
  `decideCommandAuthorization` (`allow_once`) bumped `attempt` to 1 and left `execute-2-2-1`
  missing. Both surfaced to the founder as a raw
  `invalid_workspace: required directory is missing` with an `.founder/...` artifact path — no
  recovery affordance, no hint that "Compile mission" is the unblock.
- **Purpose:** Each occurrence dead-ends the founder mid-cycle on an error that names an internal
  path rather than an action. `commandAuthorizationPreflightEligible`'s `correctedExecuteRestart`
  branch deliberately makes the preflight eligible right after a scope correction, so the app
  routes the founder straight into the call that cannot succeed yet.
- **Definition of done:** A tuple-advancing transition either compiles the package for the tuple it
  commits, in the same lease, or the resolve failure raises a typed controller conflict carrying
  the recovery action instead of a workspace error. No founder-visible path leaks an
  `invalid_workspace` artifact path as its only guidance.
- **Boundary:** Scope to the transitions that already advance the tuple (scope correction, command
  authorization, attempt retry). Not a redesign of mission compilation, and not the broader
  step-count reduction tracked below.

### Reduce founder step count with supervised auto-recovery

- **Status:** Proposed — direction, not yet scoped.
- **User story:** As the founder, I want the workflow to carry an item forward on its own and ask
  me only for the decisions that genuinely need human authority, so that a single idea does not
  cost me a chain of small mechanical clicks and hand-diagnosed errors.
- **Purpose:** Measured on one real cycle (2026-08-09, "Close project menu"): reaching a committed
  implementation required the founder to hit a scope correction, a command preflight, a command
  authorization, two mission compilations, and a launch — plus two dead-end errors that needed
  source-level diagnosis to interpret. Most of those steps carried no human judgment; they were
  the controller asking the founder to perform its own bookkeeping. The steps that *did* need a
  human — approving exact commands, approving scope — were buried among the mechanical ones, which
  is the opposite of the intended "human authority is preserved where it matters" shape.
- **Definition of done:** A supervised recovery path advances an item through mechanically-implied
  next steps (compile the package a committed tuple implies, re-derive a stale proposal, resume a
  terminal run that produced no result) without founder action, while every capability, scope, and
  completion gate stays an explicit human decision. The founder-facing surface distinguishes "I am
  waiting on you" from "I am working", and never asks the founder to perform a step the controller
  could have taken itself.
- **Boundary:** Recovery only — it may not approve commands, widen scope, accept a result, or set an
  item to `completed`. Those remain human-only gates per AGENTS.md. Explicitly not an autonomous
  agent that decides product direction; the open design question is whether this is controller
  logic or a distinct orchestrator role, and that should be settled before scoping.

### Bound scope correction to the item, and freeze the tuple during a live run

- **Status:** Proposed — defect, found 2026-08-09 during the same live cycle.
- **Idea:** Two coupled failures observed on `wi_b9b852f6`. First, the scope-correction proposal is
  derived from the **entire retained worktree** (`listWorktreeChangedFilesExcludingFounder`), so any
  dirty file — including one edited by a human or a different tool, with no relationship to the work
  item — is proposed into that item's `allowed_scope` and written into its goal contract. In this
  cycle an unrelated `TODO.md` edit was absorbed into the goal contract of a UI work item. Second,
  the correction was applied **while a connected run was executing**: it bumped the tuple from
  `2-2-1` to `3-3-0` 90 seconds into the run, so when the run terminated `missing_permission`, its
  governed tuple no longer matched state and the denial was **silently discarded** — no attention,
  no surfaced command to approve, and the capability grant was reset because it was bound to the
  superseded mission.
- **Purpose:** Together these let an unrelated edit rewrite a work item's goal contract *and*
  destroy the outcome of an in-flight run, leaving the founder with a card that looks idle and no
  record of what the agent actually needed. It also silently widens the scope an agent is permitted
  to write to, which is a governance boundary, not a convenience.
- **Definition of done:** Scope-correction proposals only consider paths plausibly attributable to
  the work item's own run, and never absorb a path solely because it is dirty. A tuple-advancing
  transition is refused, or explicitly quarantined, while a connected run holds the tuple it would
  supersede; a terminal run whose tuple was superseded still records its outcome somewhere the
  founder can see rather than being dropped.
- **Boundary:** Not a change to what the founder may approve — widening scope stays a human
  decision. The fix is *which paths get proposed* and *when a transition may fire*, not who
  authorizes it.

### Freeze the mission Git base so a committed-then-failed attempt can still validate

- **Status:** Delivered — commits `325ca57`, `1364584`. `writeMissionPackage` now anchors
  `source_revision.git_base_commit` to attempt 0 of the governed tuple instead of re-reading `HEAD`
  at every compile; only attempt 0 reads `HEAD`, which stays correct because a scope correction
  resets the attempt and legitimately re-bases. Anchoring on the *first* attempt rather than the
  previous one also heals a chain a pre-fix attempt already poisoned. `validateGitProof` was not
  weakened. Regression test: "freezes the mission Git base across attempts in one governed tuple".
- **Idea:** `compileMission` captured `source_revision.git_base_commit` from current `HEAD` every
  time it compiles, and a fresh attempt recompiles. So when an attempt commits its work and *then*
  dies for an unrelated reason (here: attempt 5 committed `718b7ff`, then terminated on a denied
  `git log --oneline -10`), the next attempt's mission is compiled with that commit as its base.
  Attempt 6 correctly reported `commit: 718b7ff`, but `validateGitProof` diffs
  `git_base_commit..result_commit` — identical commits — and rejects with "Git reports no changed
  files for the result commit." The item lands in `execute` / `blocked`, and the only recovery
  (`retryExecuteAttempt`) recompiles the same base, so **every** subsequent attempt rejects
  identically. The work is committed and correct; the controller simply cannot prove it.
- **Purpose:** This is a permanent deadlock reachable from ordinary behavior — any attempt that
  commits before failing poisons the base for all successors. It also silently discards a correct
  result, which is worse than failing loudly.
- **Definition of done:** The Git base is captured once for the governed tuple (or derived from the
  work item's pre-execute revision) and reused across attempts rather than re-read from `HEAD` at
  each compile. A result whose commit already contains the change validates instead of rejecting,
  and a blocked item carries a recovery that can actually succeed.
- **Boundary:** Do not weaken `validateGitProof`'s scope, ancestry, HEAD-equality, or clean-worktree
  checks — the fix is *which base is compared*, not relaxing the proof.

### Make a failed import recoverable when its controller run never applied

- **Status:** Proposed — defect, wedges the item permanently. Found 2026-08-09 on `wi_b9b852f6`.
- **Idea:** An import that publishes failure evidence and then loses its controller run leaves the
  item unrecoverable. Here the import ran the authoritative checks, published immutable evidence with
  `outcome: failed`, but retained its lease before applying the state transition. Repairing the lease
  clears the lock and records no manifest, so the evidence now names a controller run with no applied
  manifest. `retryExecuteAttempt` refuses with "Deterministic-verification repair evidence does not
  bind its applied controller run", and re-importing refuses with "immutable import evidence differs
  from the published snapshot" because the evidence is already published. There is no third option:
  the item sits in `execute` / `blocked` with no legal move.
- **Purpose:** Every guard here is individually correct — immutable evidence, bound manifests,
  fail-closed repair. Together they leave no exit, which turns a transient infrastructure hiccup
  (two `next build` processes colliding) into a permanently dead work item.
- **Definition of done:** Lease repair either completes or explicitly voids the controller run it
  releases, so published evidence never dangles; and a blocked item whose evidence cannot bind an
  applied manifest still exposes one legal, evidenced recovery.
- **Boundary:** Do not make evidence mutable and do not let repair invent an applied manifest. The
  fix is to close the gap between publishing evidence and applying the transition.

### Run authoritative verification without colliding with the founder's dev server

- **Status:** Delivered — `NodeVerificationRunner` now holds an exclusive per-workspace lease around
  every required command, so two imports can never run `next build` at the same time. Found
  2026-08-09 on `wi_b9b852f6`.
- **Idea:** The import's required `Build` command failed with "Another next build process is already
  running" while Lint, Typecheck, and Test all passed. The same build succeeded standalone moments
  later. Verification ran `next build` against the shared build directory with no mutual exclusion,
  so a second concurrent import collided with the first, and a correct result was recorded as an
  immutable failure that cannot be retried away.
- **Purpose:** Authoritative verification decides whether work is accepted. It must not be able to
  fail for a reason that has nothing to do with the work.
- **Definition of done:** Verification runs builds in an isolated build directory or serializes them
  behind a lease, and a spawn-level collision is distinguishable from a genuine build failure.
- **Boundary:** Do not drop `Build` from required verification, and do not treat a failed build as
  advisory; isolate the run instead.
- **Delivered:** Each `run` acquires `.founder/.verification.lock` with an exclusive create before
  spawning and releases it afterwards, waiting up to 15 minutes for a peer to finish. A run that
  cannot acquire the lease records `spawn_error` — never `failed` — so a collision stays
  distinguishable from a genuine build failure. `next build` was separately confirmed not to
  conflict with a running dev server, so isolation only had to cover concurrent verification.

### Report an unnormalizable permission request as a failure the founder can act on

- **Status:** Partly delivered — the phantom success is closed (commit below); the recovery path is
  still open. Found 2026-08-09 on `wi_b9b852f6`, where it killed 3 of 11 connected runs.
- **Idea:** When the runtime cannot normalize a permission request, `recordPermissionEvaluation`
  records `invalid_request` and rejects the tool call — but `resultFromStopReason` only inspected
  `missing_permission`, so the run reported `completed` / `partial: false` with no result and no
  attention. From the board it looked like a clean success that mysteriously produced nothing.
  The concrete trigger is ordinary: `parseRestrictedShellWords` refuses any command containing a
  control character, so a conventional multi-line commit message is unnormalizable, and the agent
  was never told that constraint. The run now reports `failed` / `partial: true`, and the execute
  and patch task guidance states the single-line command rule explicitly.
- **Purpose:** A silent phantom success is the worst failure mode in the system — it burns a run,
  teaches the founder nothing, and looks like the agent simply did nothing.
- **Definition of done:** An `invalid_request` raises a founder-visible attention naming the
  operation the runtime could not interpret, and the agent receives a distinguishable signal so it
  can retry with an expressible command instead of ending its turn.
- **Boundary:** Do not widen `parseRestrictedShellWords` to accept shell metacharacters; the
  restricted grammar is the containment boundary. Fix the reporting and the guidance, not the parser.

### Give a blocked item a route back to active from any phase

- **Status:** Partly delivered — the bricking path is closed (commit below); the recovery gap is
  still open. Found 2026-08-09 on `wi_b9b852f6`.
- **Idea:** `validateStatusTransition` already states the rule — "Phase movement requires active
  status to remain active" — but `updateWorkItemPhase` only called `validatePhaseTransition`, so it
  never enforced it. A blocked item could therefore be dragged out of execute, and once it landed in
  `plan` / `blocked` it was inert: every shaping operation refuses a non-active item, and
  `retryExecuteAttempt` — the only `blocked` → `active` route in the system — requires
  `execute` phase. The item could not move, run, or recover. `updateWorkItemPhase` now validates
  status alongside phase, so the illegal move is refused instead of bricking the item.
- **Purpose:** Closing the trap is necessary but not sufficient. `blocked` is still a one-way door
  outside execute, and the founder's instinct on a stuck card — move it back a column — is exactly
  the move that used to destroy it.
- **Definition of done:** A blocked item exposes an explicit, surfaced recovery to `active` that does
  not depend on the phase it is in, and the board explains why a blocked card cannot be dragged.
- **Boundary:** Do not let a phase move silently reset status; recovery should be a deliberate,
  evidenced act, not a side effect of dragging a card.

### Stop requiring a work item to be the sole author of history since its Git base

- **Status:** Delivered 2026-08-09 — missions now record a `scope_base_commit` (the HEAD the
  attempt was actually compiled at) alongside the frozen `git_base_commit`. Identity and ancestry
  still anchor to the frozen base; `allowed_scope` and `changed_files` are measured from the scope
  base, so commits authored outside the work item before an attempt was compiled no longer
  invalidate it. Recovery is a normal retry: the new attempt compiles a fresh scope base.
  Extended 2026-08-09 (commit `cee4e87`): the scope base only bounded commits made *before* an
  attempt compiled, so founder commits made *during* a run still poisoned it — the common case,
  since bugs get fixed mid-run. Because the controller now authors the result commit, the agent's
  contribution is exactly that commit's diff against its parent, which is captured at commit time
  and used as the scope base. Commits from any other author, before or during the run, are now
  outside the measured range entirely.
  Remaining gap: work the item itself committed in an *earlier failed attempt* still falls outside
  the next attempt's scope base — tracked separately under the committed-then-failed retry entry.
- **Idea:** `validateGitProof` requires HEAD to equal the result commit and then walks every file in
  `git_base_commit..HEAD`, rejecting any path outside the item's `allowed_scope` and requiring the
  diff to match the agent's reported `changed_files` exactly. That is only sound if nothing else
  commits to the branch between the item's base and its result. In practice the founder does commit
  — while an item is blocked, they are usually committing the very fix that unblocks it. Here the
  two commits repairing the frozen-base defect (`src/workspace/`, `tests/`) landed on top of the
  agent's `718b7ff`, so the correctly-based item then failed for a *new* reason: "Changed path is
  outside allowed_scope." Every unrelated commit permanently invalidates every open item beneath it.
- **Purpose:** An item's proof should be about the item's own change, not about the branch staying
  frozen for its whole lifetime. Today the only escapes are widening `allowed_scope` until it lies,
  or reverting and re-running work that was already correct — both of which cost a full approval
  loop and neither of which is discoverable.
- **Definition of done:** The proof is evaluated against the item's own contribution — e.g. the
  commit range the attempt actually authored, or a three-dot/merge-base comparison, or the tree diff
  restricted to the attempt's commits — so that unrelated commits landing on the branch neither
  invalidate a valid result nor let out-of-scope changes pass unnoticed.
- **Boundary:** Do not solve this by widening scope or by trusting the agent's self-reported file
  list; the point is to compare the right range, not to check less. Interaction with the frozen base
  above is deliberate — both concern *which revisions are compared*, not the strictness of the proof.

### Connected model configuration settings page

- **Status:** Proposed.
- **User story:** As the founder running Product Studio locally, I want a settings page where I
  can configure and persist the connected Copilot runtime profile (executable, model, reasoning
  effort, tool policy), so I don't have to hand-craft and export a
  `PRODUCT_STUDIO_COPILOT_RUNTIME_PROFILE_JSON` env var and restart the dev server every time I
  want connected shaping/execute runs available.
- **Purpose:** Today the only way to enable connected mode is manually constructing a JSON blob
  for `PRODUCT_STUDIO_COPILOT_RUNTIME_PROFILE_JSON` (schema in
  `src/application/portfolio-service.ts`) by hand, including undocumented details — required tool
  names (`apply_patch`, `view`) and environment allowlist entries (`PATH`) — and restarting
  `npm run dev`. This was real, measured friction: getting Copilot CLI connected during a
  2026-08-05 session took significant trial and error (guessing model IDs, tool names, required
  env keys) even with full codebase access.
- **Definition of done:** A settings page persists the runtime profile durably (not just an env
  var) — executable path/version, auth status, default model, reasoning effort, available/excluded
  tools, environment allowlist — validated against the existing `copilotRuntimeProfileSchema`
  shape (or its durable-storage equivalent), and takes effect without a full dev-server restart.
  The page auto-discovers which model IDs the configured Copilot CLI/account can actually use,
  and surfaces preflight status (executable found, authenticated, model reachable) inline.
- **Boundary:** Scope to the existing single-adapter (Copilot ACP) profile — no multi-provider
  picker, no credential-inheritance changes, no new adapter. Model discovery only needs to surface
  IDs this CLI/account can use, not a cross-vendor catalog.
- *Pointer updated 2026-08-05 (ROADMAP 3.4 Slice 2): `ConnectedExecuteRuntime` gained a
  `configuration()` surface symmetric with the shaping runtime's — the per-runtime preflight shape
  (executable found, authenticated, model reachable) this item's definition of done would read.
  Groundwork only; durable config replacing the env var and model auto-discovery are untouched —
  the item stays open as written.*
  *Pointer updated 2026-08-09 (ROADMAP 3.4 Slice 3, commits `ce9c4d7`–`2c5dd19`): the Review
  connected runtime adds a second, independent `configuration()` preflight surface, and the guided
  decision surfaces now expose per-seat preflight state and model-picker options over a route for
  the first time — closer to this item's "surfaces preflight status inline" bar, but still
  read-only groundwork. Durable config replacing
  `PRODUCT_STUDIO_COPILOT_RUNTIME_PROFILE_JSON` and model auto-discovery remain untouched — the
  item stays open as written.*

## Deferred Initiatives

### Wire the `ambiguous_goal` attention decision

- **Status:** Deferred — needs a new result-contract field, out of ROADMAP 3.3's scope.
- **Idea:** ROADMAP 3.2 defines all 8 attention decision kinds in the schema (`work-item.ts`) and
  wires all 8 into the board projection switch (`board.ts`); ROADMAP 3.3 added a producer for
  `missing_permission` (connected Execute's adapter-observed out-of-envelope denial — see
  Archived). `ambiguous_goal` still has no producer: no result or import contract carries a
  "missing required clarification" signal, so a genuinely ambiguous goal currently surfaces as a
  generic rejected-import error instead of its dedicated, human-answerable inbox row (Phase 4
  review, 2026-07-25, P3, disposition: defer).
- **Boundary:** Needs a new result-contract field for an agent to report required clarification.
  Scope narrowly when picked up.
  *Pointer updated 2026-07-28 (ROADMAP 3.4 Slice 1): `BrainstormResultSubmission` (`src/domain/shaping.ts`)
  now carries an `open_questions` field, confined to the shaping contract and not wired to any
  attention production (spec's non-goals excluded that). This is a candidate producer shape, not a
  fix — the item stays open.*
  *Pointer updated 2026-08-04 (ROADMAP 3.4 Slice 2): `PlanResultSubmission` now also carries
  `open_questions`, and the guided decision surfaces render unresolved questions without producing
  `ambiguous_goal` attention. This adds another candidate signal shape, not a producer — the item
  stays open.*
  *Pointer updated 2026-08-05 (ROADMAP 3.4 Slice 2 wrap): the Plan approval decision surface now
  also reaches an approval gate (`Approve & run Execute`) without consuming `open_questions` into
  an `ambiguous_goal` attention. Same candidate-signal-shape situation, one more surface — the item
  stays open.*

### Guard the 13 remaining unguarded mutating API routes

- **Status:** Deferred — fenced out of ROADMAP 3.4 Slice 2 by patch-cycle decision D6 (2026-08-05).
- **Idea:** Slice 2 introduced `assertTrustedRequestOrigin` (`src/application/request-origin.ts`)
  and applied it to every shaping POST through the route factory. A full enumeration of `app/api`
  during Phase 4 cycle 2 found it guards **26 of 42** mutating route files — **16 are unguarded**.
  Three (`mission/connected/{permission,launch,cancel}`) are in Slice 2's own diff and are closed by
  its patch plan Steps 9–11. The remaining **13 are pre-existing and untouched**:
  `[workItemId]/route.ts` PATCH (`updateWorkItemPhase` — cross-origin phase transitions),
  `[workItemId]/edit/` PATCH, `mission/{route,retry,import}`, `mission/patch{,/import}`,
  `mission/review{,/import}`, `patch-plan/`, `portfolio/work-items/` POST, `work-items/rebuild/`
  POST, and `workspaces/` POST (`register()` → `resolve(workspace_path)`, which makes Product Studio
  index an attacker-chosen directory and persist it to the registry). The exposure is reachable, not
  theoretical: those routes call bare `await request.json()`, which ignores `Content-Type`, so a
  cross-origin `<form method="POST" enctype="text/plain">` is a CORS *simple* request needing no
  preflight and no readable response; the app binds `127.0.0.1` (`next dev -H 127.0.0.1`), which a
  page in the founder's browser can reach. `work-items/rebuild` takes **no body at all**, so a bare
  auto-submitting form fires it.
- **Boundary:** Not a Slice 2 regression — nothing was guarded at Base `25b64f4`; `request-origin.ts`
  is new in that slice. Scope as one design pass, not a patch: route all 13 through a single shared
  factory carrying the origin check *and* a capped read, since each currently reads its body its own
  way. Two things ride along and should land in the same slice. First, those same 13 routes read
  **unbounded** bodies (`request.json()` with no cap) while `readCappedJsonRequest` exists and is
  used elsewhere — fix the cap and the origin check together, never the cap alone. Second,
  **D1's tripwire:** `readCappedJsonRequest` deliberately does *not* require a JSON `Content-Type`,
  which is safe only for as long as `assertTrustedRequestOrigin` fails closed on a missing `Origin`
  header; if that is ever relaxed to admit a non-browser client, the `Content-Type` gate becomes
  load-bearing and must land in the same change.
  *Pointer updated 2026-08-05 (ROADMAP 3.4 Slice 2 wrap): the note that `[workItemId]/route.ts`
  PATCH is "the single enforcement point for the closed-transition policy" is now stale —
  `WorkItemController.transition()` enforces `dedicated_operation_required`/`closed_in_slice`
  directly (see the delivered controller item in Archived), so that route is no longer the sole
  point of truth for the closed-transition rule. The origin-guard and unbounded-body findings above
  are unaffected; only the cross-reference changes.*

## Small UI Changes

- **Replace the free-text tags box with a token/chip picker (capture panel + editor).**
  Tags are currently entered as a comma-separated text field (`parseTags` in
  `components/kanban/capture-panel.tsx`, `tagsFromInput` in `components/kanban/detail-panel.tsx`'s
  capture mode) that splits on commas but does not dedupe. The server rejects case-insensitive
  duplicate tags (`tagsSchema` in `src/domain/work-item.ts`), and that rejection surfaces only as
  a generic `400 "Invalid request"` (review P3 #1, 2026-07-21) with no hint that tags are the
  cause. Move to an explicit token/chip input (ideally suggesting existing tags) that dedupes
  case-insensitively on the client and shows a clear inline message — removing the last spot
  where free text is parsed into structure. Small and isolated; not urgent. *Pointer updated
  2026-07-21 (ROADMAP 1.5): `capture-editor.tsx` was deleted and its capture-mode field folded
  into `detail-panel.tsx`; this item was deliberately not folded into 1.5 (spec scoped the chip
  picker out) — the free-text behavior was preserved as-is. Pointer updated 2026-07-24 (ROADMAP 2.5): the
  unified `/edit` save flow rewrote `detail-panel.tsx`'s save handlers but left `tagsFromInput`
  and the free-text tags input untouched — this item still applies as written. Pointer updated
  2026-07-26 (ROADMAP 3.3): the connected-run surface added ~500 lines to `detail-panel.tsx` but
  did not touch `tagsFromInput` or the free-text tags input (spec explicitly scoped tag-chip work
  out) — this item still applies as written. Pointer updated 2026-07-28 (ROADMAP 3.4 Slice 1): the
  shaping section adds to `components/kanban/detail-panel.tsx`'s capture mode but deliberately
  leaves `tagsFromInput` and the free-text tags input untouched (spec's non-goals scoped
  card-metadata editing out of the slice) — this item still applies as written.*
  *Pointer updated 2026-08-04 (ROADMAP 3.4 Slice 2): the guided shaping, monitoring, recovery, and
  decision surfaces substantially rewrote `detail-panel.tsx` again but still leave `tagsFromInput`
  and the free-text tags input untouched — this item still applies as written.*
  *Pointer updated 2026-08-05 (ROADMAP 3.4 Slice 2 wrap): the Plan approval decision surface added
  to `detail-panel.tsx` again without touching `tagsFromInput` or the tags input — this item still
  applies as written.*

## Open Questions

## Archived

### Enforce writer/reviewer model independence for review missions

- **Status:** Roadmap-owned — superseded by ROADMAP 4.1.
- **Resolution:** ROADMAP 4.1 introduces a shared run-actor provenance contract and enforces exact
  writer/reviewer model separation only when the identity source is trustworthy enough to fail
  closed. Fully manual/BYOA runs retain human independence attestation rather than promoting
  self-reported identity to fact.

### Implement Multi-Agent AG-UI Kanban Orchestrator

- **Status:** Roadmap-owned — the validated connection need is superseded by ROADMAP 4.1.
- **Resolution:** Preserve a provider-neutral JSON connection boundary that can use a CLI or
  another approved local transport and begin with one evidence-selected adapter. MCP is unsupported
  and explicitly out of scope for every adapter. The exported vendor list, AG-UI framework choice,
  live reasoning/terminal stream, token-budget manager, automatic model selection, and board-driven
  provider orchestration were inspiration rather than accepted product direction and are not
  roadmap commitments.

### Price per task metric

- **Status:** Roadmap-owned — merged into ROADMAP 6.3.
- **Resolution:** Quality and deterministic review remain eligibility gates. Among eligible
  outcomes, total cost per successfully completed task, including retries, is the primary
  efficiency metric and time to successful completion is the second.

### Add an Inbox page for review and approvals

- **Status:** Delivered — superseded by ROADMAP 3.2 (commits `84c939a`–`22d8b36`). The
  cross-project attention inbox (`app/inbox/page.tsx`, `listAttention()`) ships this as an
  alternate view over durable workflow state/evidence, per the original boundary.

### Enforce the dedicated-transition policy inside the controller

- **Status:** Delivered — ROADMAP 3.4 Slice 2 (commits `54de9de`–`874d7c0`). Step 9 moved the
  `dedicated_operation_required`/`closed_in_slice` enforcement from the portfolio layer directly
  into `WorkItemController.transition()`, rewriting the three test setup helpers that previously
  drove transitions straight past it (`tests/api/portfolio-routes.test.ts`,
  `tests/application/work-item-controller.test.ts`, `tests/application/portfolio.test.ts`). The
  controller is now the single enforcement point named in AGENTS.md, not `portfolio.ts`.

### Wire the `missing_permission` attention decision (connected Execute half)

- **Status:** Delivered — ROADMAP 3.3 (commits `4c51ee0`–`995bf74`). Connected Execute's ACP
  adapter now produces a structured `missing_permission` attention for an exact,
  adapter-observed, out-of-envelope operation (`recordConnectedPermissionDenial`), surfaced
  read-only in the existing Inbox/DetailPanel recovery surfaces with "allow once and retry" /
  "keep denied" decisions bound to the exact operation hash. This was the half of the original
  combined item scoped to connected Execute; the `ambiguous_goal` half remains open above.
