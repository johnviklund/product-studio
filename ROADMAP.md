# Product Studio roadmap

This is a scoped delivery map, not an execution backlog. Each MVP phase is one
`workflow brainstorm → spec → plan → execute → review` cycle; intake belongs in
`TODO.md`, not here.

## Milestone 1 — Focused control panel and Kanban

### 1.1 Foundation and durable workspace contract

- **Goal:** Scaffold the local app and define the smallest file-backed portfolio and work-item contract without agent loops.
- **Primary scope:** Application boundary, durable artifacts, and rebuildable-cache seam.
- **Traceability:** PRD §16, §17.1, FR-001/004, NFR-001/003.
- **Dependencies:** Repository baseline.
- **Completion signal:** A local app can create, read, and reconstruct the minimum durable workspace state.

### 1.2 Portfolio registration and rebuildable index

- **Goal:** Register local product workspaces and rebuild a disposable local index from durable files.
- **Primary scope:** Workspace registration, file discovery, and cache rebuilding.
- **Traceability:** PRD §16.1, FR-001/002.
- **Dependencies:** 1.1.
- **Completion signal:** Registered workspaces reappear correctly after deleting and rebuilding the local index.

### 1.3 Focused Kanban and project filtering

- **Goal:** Project registered and unassigned work into the seven-column workflow board while preserving UI state.
- **Primary scope:** Todo, Spec, Plan, Execute, Review, Ship, and Done; project filtering and board context.
- **Traceability:** PRD §9.3, FR-002/021, `DESIGN.md` Kanban.
- **Dependencies:** 1.1–1.2.
- **Completion signal:** The founder can filter and return to a stable cross-project board without losing position or selection.
- **Status:** Delivered — commit `1fec11a` (seven-column board, source-qualified inbox/project filtering, accessible drag transitions, persisted board view).

### 1.4 One-sentence capture and progressive exploration

- **Goal:** Capture unassigned work globally, then shape it without losing the original idea or todo.
- **Primary scope:** Inbox capture, optional assignment, and non-destructive exploration.
- **Traceability:** PRD Journey B, FR-003/022, `DESIGN.md` capture panel.
- **Dependencies:** 1.3.
- **Completion signal:** A one-sentence capture appears in Inbox without project, type, or priority and can later be refined or assigned.

### 1.5 Context panel, valid transitions, and keyboard flow

- **Goal:** Add the reusable detail panel, one displayed next action, valid transitions, and keyboard navigation.
- **Primary scope:** Context-preserving side panel, transition explanations, and board keyboard flow.
- **Traceability:** PRD §9.9, FR-002/021, `DESIGN.md` detail panel.
- **Dependencies:** 1.3–1.4.
- **Completion signal:** A founder can inspect and progress an item from the board without losing filters or scroll position.
- **Status:** Delivered — commit `4dedf19` (reusable 410px detail panel with Todo-capture and governed modes, shared forward/back transition actions, column-local keyboard navigation, `capture-editor.tsx` retired into the panel's capture mode). Enter-to-open-panel (spec AC5) is descoped by explicit product-owner direction — pointer/click remains the supported open path; see `TODO.md` if reopened later.

**Milestone exit:** The founder can capture, find, explore, organize, and progress real work across products without relying on GitHub Projects or raw repository files.

## Milestone 2 — Portable mission handoff

### 2.1 Controller state and goal-contract foundation

- **Goal:** Implement versioned, controller-owned work state and goal contracts with transition validation.
- **Primary scope:** Expected-state checks, idempotency, leases, recoverable failure handling, and run manifests.
- **Traceability:** PRD §11, §16.3–16.5, FR-004/005/011.
- **Dependencies:** 1.1 and 1.5.
- **Completion signal:** Invalid or stale transitions are rejected without guessing conflicting state.
- **Status:** Delivered — commits `9ac50d2`–`a7326fd` (versioned work-item/goal-contract schemas
  fail closed for partial contracts; lease-guarded transitions validate every `expected_*` before
  writing; idempotent applied-key replay; compensated recovery from mid-write failure leaves an
  inspectable `failed` manifest; board and controller share one phase-transition policy; v4 cache
  round-trip drops/recreates cleanly). Reviewed clean, no P0–P2 findings; see `WORKLOG.md`.

### 2.2 Provider-neutral mission compiler

- **Goal:** Produce reproducible `TASK.md` handoff packages and structured output contracts.
- **Primary scope:** Versioned mission compilation and provider-neutral canonical inputs.
- **Traceability:** PRD §11.7, FR-007/008.
- **Dependencies:** 2.1.
- **Completion signal:** The same contracted work can be handed to two capable external agent products from durable artifacts.
- **Status:** Delivered — commits `290f39a`–`0c10068` (dependency-free `domain/mission.ts`
  compiles a strict `mission_schema_version: 1` package with a deterministic canonical-order
  SHA-256 hash and provider-neutral `TASK.md`; the workspace selects the single applied
  `execute` manifest by governed tuple, rejecting duplicates, and writes immutable
  `.founder/missions/<item>/<tuple>/` snapshots atomically, failing closed on any divergence or
  symlinked path; `PortfolioService.compileMission` stays read-only against controller state —
  no lease, mutation, verification, import, transition, or index rebuild; a source-qualified
  `POST .../mission` route and an eligibility-gated detail-panel handoff block expose the durable
  paths, hash, and a neutral copy-launch instruction). Reviewed clean at `0c10068`, no P0–P3
  findings; see `WORKLOG.md`.

### 2.3 External-result import and deterministic verification

- **Goal:** Import manual-agent results, validate version/scope/revision, persist run evidence, and block on red checks.
- **Primary scope:** Result import, evidence storage, contract validation, and required verification commands.
- **Traceability:** PRD §11.7, FR-007/009/015.
- **Dependencies:** 2.1–2.2.
- **Completion signal:** A non-conforming result is preserved for repair but cannot advance the controller state.
- **Status:** Delivered — commits `d252f68`–`61553dd` (versioned `ImportEvidenceEnvelope` and
  command-evidence contracts, Git-base-bound missions, a Node local verification runner,
  content-addressed immutable `.founder/run-evidence/` publication written before the controller
  mutation it backs, and source-qualified `mission/import`/`mission/retry` routes gating
  controller advancement on a fully green command run). A cross-vendor Phase 4 review later
  found a confirmed P1 (an unbounded verification command with a hanging descendant could wedge
  the controller lease permanently); fixed via process-group kill plus a bounded drain backstop
  and re-reviewed clean at `f348592` — see `WORKLOG.md`.

### 2.4 Run evidence and history surface

- **Goal:** Show current and prior runs, including unavailable telemetry as `unknown`, without exposing raw tool detail on the board.
- **Primary scope:** Run history, provenance, outcome, duration, and progressive disclosure.
- **Traceability:** PRD FR-007/015, `DESIGN.md` progressive disclosure.
- **Dependencies:** 1.5 and 2.3.
- **Completion signal:** The founder can inspect a run's evidence and next action from the control panel.
- **Status:** Delivered — commits `0eaef6a`–`b8119bd` (fail-closed durable listing across every
  historical mission identity for a work item, byte-authority reconciliation via the existing
  private evidence reader, a read-only source-qualified `listImportEvidence` query with no
  lease/rebuild/mutation, a bodyless node-runtime GET route, and an inline governed-overview
  `Run evidence` panel with collapsed-by-default rows, a `Latest` marker, `Telemetry: unknown`,
  and full command-record disclosure). Reviewed clean at `b8119bd`, no P0–P2 findings, two P3s
  wontfixed as intentional trade-offs; see `WORKLOG.md`.

### 2.5 Clear goal contracts and unified card editing

- **Goal:** Make governed work easy to define and edit so every mission has a clear why, an observable target, and an explicit boundary.
- **Primary scope:** A concise, plain-language goal contract covering purpose, acceptance criteria, non-goals, scope, and review readiness; the product manages stable references and versioning. Project, details, and goal contract share one detail-panel editing flow with a single Save action. Initial capture remains one sentence; LLM refinement remains a proposal until the founder accepts it.
- **Traceability:** `PRODUCT.md` lifecycle and gates, `DESIGN.md` detail panel, and the versioned goal-contract foundation from 2.1.
- **Dependencies:** 1.5 and 2.1–2.4.
- **Completion signal:** The founder can prepare a governed item for execution in one editing flow, and subsequent missions and evidence bind to the exact accepted goal version.
- **Status:** Delivered — commits `8eb7c47`–`d666423` (strict v2 nested goal contracts with purpose
  and non-goals; one source-qualified save/edit flow for project, card details, and contract;
  v5 rebuildable cache; updated mission/board/fixture consumers). Deterministic verification is
  green: lint, typecheck, 203 tests, and production build. Phase 4 review passed clean — ship
  as-is, no P0–P2 findings; see `WORKLOG.md`.

**Milestone exit:** A clear, accepted contract can be edited without unnecessary form boundaries, then handed to an external agent, imported, verified, persisted, restarted, and inspected safely without a provider-specific runner.

## Milestone 3 — Cross-agent review loop

### 3.1 Independent review mission and finding contract

- **Goal:** Review an exact result against its accepted goal contract without allowing the reviewer to modify the implementation.
- **Primary scope:** Reviewer missions, human-attested writer/reviewer independence, exact-result binding, and structured findings linked to acceptance criteria, non-goals, defects, security, or deterministic checks.
- **Traceability:** PRD §8.6, FR-010.
- **Dependencies:** 2.2–2.5.
- **Completion signal:** An independent reviewer returns criteria-linked findings for the exact result under review without modifying the implementation or authorizing completion.
- **Status:** Delivered — commits `202fbd2`–`2acb835` (phase-qualified v3 mission/result contracts;
  immutable applied-execute review subject sourcing; strict discriminated v2 review-result schema
  with typed findings; lease-guarded, no-transition review import with HEAD/clean-tree binding;
  source-qualified review eligibility/compile/import; review-handoff board projection and
  attested DetailPanel UI; phase-discriminated run-evidence history). Deterministic verification
  is green: lint, typecheck, 244 tests, and production build. Phase 4 review passed clean — ship
  as-is, one wontfix P3; see `WORKLOG.md`.

### 3.2 Bounded patch loop and attention inbox

- **Goal:** Drive executor, verification, review, and patch transitions within explicit limits and show one clear next action.
- **Primary scope:** One bounded work or repair unit per pass, repair-first routing within explicit limits, lease revalidation, patch-plan routing, and exact human-answerable escalation questions.
- **Traceability:** PRD §11, §12, §9.7, FR-011/012.
- **Dependencies:** 2.3–2.4 and 3.1.
- **Completion signal:** A real feature reaches review-ready, blocked, budget, or cycle-limit status without silent looping, repeated ambiguous retries, or lost contract context.
- **Status:** Delivered — commits `84c939a`–`22d8b36` (state v2 contract with governed
  `patch_cycle` and discriminated `attention`; `patch` mission/result contracts and a
  `ReviewSubject` execute|patch union with canonical finding-resolution coverage; controller
  `acceptPatchPlan`/`importPatchResult` and deterministic review-result routing bounded at three
  cycles; durable patch workspace, cache projection, source-qualified API routes; board patch
  handoff/attention projection folded into the Review column; DetailPanel patch-plan/escalation/
  review-ready controls; the cross-project attention inbox page). Deterministic verification is
  green: lint, typecheck, 301 tests, and production build. Phase 4 review passed clean — ship
  as-is, one deferred P3 (`ambiguous_goal`/`missing_permission` attention kinds are schema-defined
  but never produced this slice; tracked in `TODO.md`); see `WORKLOG.md`.

### 3.3 Transport-neutral connected execution and run provenance

- **Goal:** Make connected agent execution part of version one so the founder can launch a
  contracted workflow step from Product Studio without copying prompts or result files between
  applications.
- **User boundary:** The transport is an implementation detail. Product Studio owns one canonical
  JSON connection, capability, mission, and result boundary that may be carried by a CLI or another
  approved local transport. Version one selects one evidence-backed reference adapter; the product
  UI does not ask the founder to understand or choose a transport for each run.
- **Model choice:** The founder can select or configure the exact eligible LLM model for each
  agent-driven phase or seat. A real version-one cycle must use at least two distinct model
  identities. Automatic model selection, cost optimization, and evidence-based routing remain
  Milestone 6 concerns.
- **Run-actor provenance:** Bind each run immutably to its logical role or seat, exact model or
  deployment identity, effort, harness and adapter version, resolved profile and skill digests,
  and relevant capability and authorization-envelope digests. Record each identity group's
  assurance as controller-observed, adapter-attested, user-declared, or unknown. Model or harness
  identity never grants authority by itself.
- **Independence and authorization:** Keep the execution actor separate from the human or policy
  principal that authorized an action. Enforce exact writer/reviewer model separation only when
  identity assurance is sufficient to fail closed; otherwise retain explicit human attestation.
  Approvals remain bound to the exact governed tuple and action and cannot be replayed or
  transferred to an agent identity.
- **Trust boundary:** Every connected run receives an explicit capability envelope for workspace
  paths, write scope, tools, network, and credentials. Product Studio does not inherit credentials
  wholesale, treats adapter output as untrusted until existing validation and verification pass,
  bounds output and process lifetime where it owns them, and fails closed on connection or adapter
  errors.
- **MCP boundary:** MCP is unsupported in the target organizational environment and is an explicit
  non-goal. Product Studio does not configure, start, connect to, proxy, or expose MCP servers or
  tools. Every adapter must disable automatic MCP loading and fail before launch if a run would
  require MCP.
- **Other non-goals:** No multi-provider orchestration platform, live chain-of-thought or full
  terminal stream, token-budget manager, provider-shaped state machine, or broad adapter catalog.
- **Dependencies:** 2.2–2.4 and 3.2.
- **Completion signal:** The same immutable mission can round-trip through the existing manual
  artifact handoff and one connected adapter with identical controller validation, evidence, and
  transition behavior, and can be run with two distinct model identities without expanding either
  model's authority.
- **Status:** Delivered — commits `4c51ee0`–`995bf74` (capability envelope v1 with an
  exact-match, fail-closed evaluator and narrowing/digest contracts; mission schema v5 embedding
  the envelope into the immutable Execute mission, `content_sha256` covering it, with v4/v3 read
  compatibility preserved; structured `missing_permission` attention payload and permission
  decision contracts; append-only connected-run records with durable per-item launch guard,
  redaction, and reconciliation; the pinned `@agentclientprotocol/sdk` runtime dependency; a
  provider-neutral ACP client core and the Copilot reference runtime profile; controller connected
  launch/permission-denial/allow-once mutations sharing the existing lease/evidence-before-mutation
  shape; portfolio orchestration and the four connected API routes; DetailPanel connected-run
  controls and the connected `missing_permission` Inbox recovery row; a rebuildable connected-run
  summary cache projection). Deterministic verification is green: lint, typecheck, 349 tests, and
  production build. Phase 4 review found one P0 (a workspace-relative/absolute path mismatch
  between the Copilot profile's write classifier and the envelope schema that rejected every
  in-workspace agent write) — fixed and re-reviewed clean; see `WORKLOG.md`. Live Copilot/ACP
  execution was not run as part of this delivery; the feasibility gate (Step 0) used a probe
  client, and no connected launch has yet exercised the real Copilot binary end to end.

### 3.4 Version-one end-to-end multi-model workflow

- **Goal:** Let the founder drive one governed feature from initial shaping through approved
  implementation using different LLM models for different workflow steps.
- **Primary scope:** Extend the portable-mission *pattern* — content-addressed immutable task,
  structured result, and explicit human acceptance — across the agent-driven Brainstorm, Spec,
  Plan, Execute, and independent Review or Patch steps. Brainstorm and Spec shaping use a
  **separate** shaping contract where Execute's governed tuple and capability envelope do not
  apply; Execute, Review, and Patch continue to use the existing mission, connected-run,
  structured-result, deterministic verification, and approval contracts. The controller continues
  to expose one next action and exact human gates; agents cannot approve their own output or mark
  work completed.
- **Version-one experience:** The founder can start the next eligible step, choose its model when
  needed, see a truthful bounded state such as queued, working, blocked, failed, or ready for
  review, and approve or reject the exact result through the existing detail panel and attention
  inbox. Manual artifact handoff remains a recovery path, not the normal connected flow.
- **Cycle boundary:** Version one proves capture and shaping through reviewed, verified, and
  human-approved implementation. Automated deployment and operations, semantic live-update
  streams, broad feedback routing, and automatic learning or model routing remain later
  milestones.
- **Dependencies:** 2.1–2.5 and 3.1–3.3.
- **Slice 2 selected experience direction (2026-07-31):** Use the guided handoff defined in
  [`DESIGN.md`](DESIGN.md#connected-guided-handoff-through-execute-approval-roadmap-34-slice-2): connected
  Brainstorm, Spec, and Plan are the normal path, a ready Spec becomes one concise founder decision
  with `Approve & run Plan`, and manual artifact handoff remains collapsed recovery. The
  [directional mockup](docs/design/roadmap-3.4-slice-2-guided-handoff.png) supports the written
  contract but does not define lifecycle state. Slice 2 now reaches the governed Execute handoff
  through explicit Plan approval.
- **Status:** In progress — the guided handoff mechanism is delivered through Execute approval.
  Commits `6ca9b52`–`c0bf64f` delivered connected Brainstorm, Spec, and Plan launch, per-seat model
  selection, the Plan mission, a headed end-to-end run with three distinct adapter-observed
  effective model identities, and the closed three-cycle review. Commits `54de9de`–`874d7c0`
  deliver exact-result Plan approval, recoverable controller execution, Execute model selection,
  the approval API, the Plan decision surface, dedicated-transition enforcement inside the
  controller, and the closed review. The 3.4 completion signal is not yet claimed because the
  cycle does not reach approved implementation.
- **Completion signal:** A real feature completes the version-one cycle without manual prompt or
  result assembly, uses at least two distinct recorded LLM model identities across its
  agent-driven steps, preserves every required human gate, and leaves reproducible mission, result,
  verification, review, and approval evidence.

**Milestone exit:** Version one can drive a real feature from shaping through approved
implementation using different recorded LLM models for different steps, with the controller,
verification, independent review, bounded patch loop, and human authority preserved end to end.

## Post-MVP placeholders

### Milestone 4 — Live workflow experience and governed learning

#### 4.1 Semantic activity, live updates, and update review

- **Goal:** Build on the working connected cycle so the founder can see meaningful live progress,
  return after time away, and approve the next phase without reconstructing agent sessions.
- **Primary scope:** A provider-neutral semantic-event contract backed by durable controller changes
  and published evidence; stable event identity; an item-scoped Activity chronology; a
  cross-project, email-like Updates sequence; the existing Needs You decision queue as the
  actionable subset; and the Since-you-were-away entry point. Current work-item state, missions,
  results, and evidence remain authoritative; event records preserve meaningful history but never
  authorize or determine workflow state, and every read model remains rebuildable.
- **Live semantics:** Show bounded states and meaningful outcomes for connected runs, phase changes,
  verification, findings, decisions, approvals, and result replacement. Exclude raw reasoning,
  token streams, unbounded terminal output, indexing, autosaves, and duplicate controller churn.
  Entries carry a concise outcome, time, logical actor role, run identity, and immutable evidence
  handles.
- **View and action boundaries:** The Board remains the primary spatial workflow view; Activity is
  the complete semantic history for one governed item; Updates is the cross-project seen/unseen
  review sequence; Needs You contains unresolved human decisions only. Actionable entries open the
  existing exact-result-bound DetailPanel control rather than creating a second approval contract.
- **Acknowledgment:** Viewing, acknowledging, and resolving are distinct. Dismissal advances a
  stable last-acknowledged event position rather than recording wall-clock time; resolved and
  superseded entries leave active queues according to explicit rules but remain in item Activity.
- **Dependencies:** 3.3–3.4.
- **Completion signal:** The founder can watch truthful bounded progress, enter from Since you were
  away or Updates, inspect exact evidence, approve or answer through the existing governed control,
  and reach an honest caught-up state while every surface agrees about event identity and
  acknowledgment.

#### 4.2 Learning, skill, and evaluation proposals

- **Goal:** Produce reviewable product-memory, evaluation-case, and skill-change proposals from
  completed work.
- **Primary scope:** Provenance-aware learning classification; evaluation-case capture; candidate
  skill creation, update, merge, or retirement; and human promotion. Repository-specific facts,
  reusable skill guidance, model-routing evidence, and concrete regression cases remain distinct
  destinations rather than being folded into one generic memory stream.
- **Capture and routing:** Every phase and bounded attempt can append structured learning
  candidates as soon as evidence appears and before its execution context is reset. Each candidate
  is dispositioned to one canonical owner — product or design doctrine, operating policy,
  repository context/memory, a reusable skill, a detailed solution, an evaluation case,
  model-routing evidence, or an explicit drop with reason — rather than copied across stores.
- **Evidence hygiene:** Preserve the smallest self-contained evidence needed to review a proposal,
  preferably through immutable mission/run/commit handles instead of duplicated raw payloads.
  Exclude secrets, unnecessary transcripts, and person- or customer-level data. Do not clear
  transient learning inputs until every candidate is routed or deliberately dropped; expose a
  bounded, human-readable recent index that points back to durable evidence rather than becoming
  another source of truth.
- **Traceability:** PRD §14–15, FR-018.
- **Dependencies:** 3.4.
- **Completion signal:** Completed work can propose evidence-linked durable learning, evaluation,
  and skill changes, every captured candidate has an explicit disposition, and none can silently
  change the active skills or agent behavior.

#### 4.3 Workflow expansion and integrations

Post-MVP: add broader feedback routing, autonomy configuration, GitHub links/sync, remaining
Ship/Learn integrations, and additional adapters only when version-one evidence justifies them.
**Exit:** the proven connected cycle can expand without changing its controller, authorization,
evidence, or non-MCP boundaries.

### Milestone 5 — Deployment and operations

Post-MVP: add one deployment adapter or configurable deployment command, deployment records, Gate E, monitoring, incident workflow, and rollback/kill-switch integration. **Exit:** a prototype can be launched and recovered through the same control panel.

### Milestone 6 — Skill evolution, evaluations, and model routing

Product Studio's workflow phases and agent profiles remain model-neutral. Skills describe reusable
behavior, context, constraints, and capability requirements; routing binds a currently qualified
model and harness only when a mission is launched. A model can therefore be replaced without
rewriting the workflow or its skills.

The current personal `workflow` agent skill used for manual work across different CLIs is a
reference for proven phase outcomes, seats, handoffs, and learning patterns. Product Studio does
not mimic its package structure or depend on it at runtime; the product owns independent,
provider-neutral contracts informed by evidence from that manual workflow.

#### 6.1 Versioned skill registry and composable agent profiles

- **Goal:** Assemble the exact reusable capabilities needed for each workflow phase and individual
  plan step without coupling them to one model or agent product.
- **Primary scope:** Immutable skill versions; phase-profile defaults; repository, work-item, and
  plan-step overlays; required tool capabilities; bounded context selectors; and output and
  verification contracts. Each compiled mission pins the resolved profile, skill versions, and
  content digests so retries remain reproducible after the active registry changes.
- **Dependencies:** 3.1–3.4 and the learning-proposal contracts from 4.2.
- **Completion signal:** The same pinned profile can be materialized for two capable agent
  adapters, while a missing or incompatible required skill or capability fails closed.

#### 6.2 Evidence-driven skill evolution

- **Goal:** Improve agent behavior from repeated workflow evidence without silently self-modifying
  the active system.
- **Primary scope:** Convert verification outcomes, review findings, retries, interventions, and
  operator feedback into provenance-linked proposals to create, update, merge, or retire skills.
  Keep repository facts in repository context, concrete failures in evaluation cases, and
  model-specific observations in routing evidence rather than growing overlapping skills.
- **Promotion discipline:** Search the active registry and adapter-visible installed skills before
  proposing a new one; extend an existing owner first. A new skill requires recurrence evidence,
  reuse beyond one feature or repository-specific schema, and a genuine uncovered responsibility.
  The current manual workflow's three-or-more-occurrences rule is the initial reference heuristic,
  not a permanent hard-coded threshold. Strip concrete paths, object names, business data, and
  one-off implementation logic from reusable skill guidance.
- **Registry hygiene:** Detect name and scope collisions before publication. Keep active skills and
  learning indexes bounded by consolidating overlaps, superseding stale versions, and retiring
  weak or unused skills instead of treating growth as append-only.
- **Dependencies:** 4.2 and 6.1.
- **Completion signal:** A completed cycle can produce a reviewable candidate skill diff with its
  supporting evidence, expected improvement, evaluation cases, and rollback target; promotion
  remains an explicit human or authorized policy decision, and rejected proposals retain a reason
  without entering the active profile.

#### 6.3 Skill qualification and controlled promotion

- **Goal:** Demonstrate that a candidate skill or profile improves outcomes without overfitting to
  one work item or model.
- **Primary scope:** Real-work golden cases; replay or shadow evaluation; candidate-versus-active
  comparisons across fixed model baselines; regression thresholds; immutable publication; and
  rollback. Quality, deterministic verification, and review thresholds gate eligibility; among
  eligible results, measure total cost per successfully completed task, including retries, as the
  primary efficiency metric and time to successful completion as the second, alongside retry and
  human-intervention rates.
- **Golden-case intake:** Admit only cases likely to discriminate capability: an approved output
  that required real judgment, a known-correct mechanical transform, or a confirmed failure and
  the finding that caught it. Each case is self-contained with input, approved output, grading
  criteria and traps, profile/skill versions, commit or run provenance, and separate producing,
  grading, and approving identities. Keep a bounded rolling set per phase/profile; when full, a stronger case
  displaces the weakest. The manual workflow's roughly fifteen cases per seat is a reference,
  while Product Studio owns the configurable policy.
- **Exam protocol:** Run one candidate against one phase/profile at a time in fresh context with
  the approved output withheld and the same tools, skill versions, and repository conditions as
  the real seat. Grade with an independent strong reviewer, cross-vendor where practical, then
  require human review of every failure plus a sample of passes. Record candidate and grader model,
  harness, effort, provenance assurance, quality, total cost, latency, and any human overturn
  separately in a durable scorecard. Unknown or merely user-declared runtime identity may remain as
  historical evidence but cannot support automatic qualification or independence enforcement.
- **Corpus health:** Detect malformed, stale, redundant, weak, or trivially easy cases and profiles
  without enough discriminating evidence. Refuse to publish a meaningful-looking qualification
  when the usable corpus is too small; identify the missing cases future workflow runs should
  capture instead.
- **Dependencies:** 3.3 and 6.1–6.2.
- **Completion signal:** A qualified skill or profile version can be promoted with evidence while
  prior missions remain pinned to their original versions, the evaluation corpus stays bounded
  and healthy, and failed or partial qualification remains visible without mutating active skills.

#### 6.4 Model qualification and task-shaped routing

- **Goal:** Safely adopt newly released models for the workflow steps where they perform best.
- **Primary scope:** Evaluate candidate models against fixed skill and profile versions; maintain
  task-shaped seat scorecards; shadow qualification; availability-aware fallbacks; and explicit
  quality, cost, and latency trade-offs. Model observations update routing evidence, not skill
  content.
- **Qualification controls:** Confirm the exact candidate model and effort are available in the
  target harness and present the expected evaluation cost before running. Keep model exams
  separate from workflow execution, qualify one seat/profile at a time, record candidate and grader
  identities separately, and treat grader output as a hypothesis subject to the human spot check.
  Scorecards propose promote, fallback, demote, or reject decisions; only an authorized human or
  policy gate changes active routing.
- **Dependencies:** 3.3, 6.1, and 6.3.
- **Completion signal:** A newly available model can earn and assume a workflow seat without
  changing the workflow, active skills, mission contracts, or historical evidence, and a model
  that lacks availability or sufficient evidence cannot be silently selected.

**Milestone exit:** Repeated workflow cycles produce governed skill improvements and evaluation
cases, qualified models can be swapped by task shape, and every change remains reproducible,
reviewable, and reversible.
