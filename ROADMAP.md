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

### 2.3 External-result import and deterministic verification

- **Goal:** Import manual-agent results, validate version/scope/revision, persist run evidence, and block on red checks.
- **Primary scope:** Result import, evidence storage, contract validation, and required verification commands.
- **Traceability:** PRD §11.7, FR-007/009/015.
- **Dependencies:** 2.1–2.2.
- **Completion signal:** A non-conforming result is preserved for repair but cannot advance the controller state.

### 2.4 Run evidence and history surface

- **Goal:** Show current and prior runs, including unavailable telemetry as `unknown`, without exposing raw tool detail on the board.
- **Primary scope:** Run history, provenance, outcome, duration, and progressive disclosure.
- **Traceability:** PRD FR-007/015, `DESIGN.md` progressive disclosure.
- **Dependencies:** 1.5 and 2.3.
- **Completion signal:** The founder can inspect a run's evidence and next action from the control panel.

**Milestone exit:** A contracted phase can be handed to an external agent, imported, verified, persisted, restarted, and inspected safely without a provider-specific runner.

## Milestone 3 — Cross-agent review loop

### 3.1 Independent review mission and finding contract

- **Goal:** Add read-only review packaging, independence checks, and structured findings.
- **Primary scope:** Reviewer missions, review contracts, and normalized evidence.
- **Traceability:** PRD §8.6, FR-010.
- **Dependencies:** 2.2–2.4.
- **Completion signal:** An independent reviewer returns structured findings without modifying the implementation.

### 3.2 Bounded patch loop and attention inbox

- **Goal:** Drive executor, verification, review, and patch transitions within explicit limits and show one clear next action.
- **Primary scope:** Loop/budget bounds, escalation, patch-plan routing, and attention handling.
- **Traceability:** PRD §11, §12, §9.7, FR-011/012.
- **Dependencies:** 2.3–2.4 and 3.1.
- **Completion signal:** A real feature reaches review-ready, blocked, budget, or cycle-limit status without silent looping.

### 3.3 Learning and evaluation proposals

- **Goal:** Produce reviewable product-memory and evaluation-case proposals from completed work.
- **Primary scope:** Provenance-aware learning, evaluation-case capture, and human promotion.
- **Traceability:** PRD §14–15, FR-018.
- **Dependencies:** 3.2.
- **Completion signal:** Completed work can propose, but not silently promote, one durable learning and one evaluation case.

**Milestone exit:** A real feature can move through executor, reviewer, and patch missions until human review without restating context or manually assembling prompts.

## Post-MVP placeholders

### Milestone 4 — Full product workflow

Post-MVP: expand Idea through Learn, feedback routing, approval binding, autonomy configuration, GitHub links/sync, and at most one justified managed adapter. **Exit:** a real idea can move from capture through approved implementation.

### Milestone 5 — Deployment and operations

Post-MVP: add one deployment adapter or configurable deployment command, deployment records, Gate E, monitoring, incident workflow, and rollback/kill-switch integration. **Exit:** a prototype can be launched and recovered through the same control panel.

### Milestone 6 — Evaluations and model routing

Post-MVP: add real-work golden cases, seat scorecards, shadow qualification, route changes, and cost/quality/latency trade-offs. **Exit:** a newly available model can be evaluated and safely promoted without redesigning the workflow.
