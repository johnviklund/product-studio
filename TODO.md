# Product Studio TODO

This is the human's workflow-managed intake scratchpad, not a roadmap. Use `workflow todo`
to capture, shape, merge, update, or archive future work; `ROADMAP.md` owns the initial
delivery phases.

## Active Initiatives

### Expose the goal contract as an app-reachable route + UI form

- **User story:** As the founder, I want to define and update a work item's goal contract
  (acceptance criteria, allowed scope, review-ready commands) from the detail panel, so I can
  actually drive a work item through Execute → mission compile → import → review without
  hand-calling the controller in a test file.
- **Purpose:** `WorkItemController.updateGoalContract` (roadmap 2.1) is fully implemented and
  tested (`tests/application/work-item-controller.test.ts`), but no HTTP route or UI ever calls
  it. Every other Milestone 2 surface — mission compile, result import/retry, run evidence — is
  gated on an item having an active goal contract, so right now Milestone 2 cannot be exercised
  at all through the running app; only via unit tests calling the controller in-process.
  Discovered 2026-07-23 while trying to manually test Milestone 2 via the UI.
- **Definition of done:** A source-qualified route (e.g. `PATCH .../goal-contract`) exposes
  `updateGoalContract` with the existing expected-version/lease semantics and mapped errors, and
  a detail-panel form (acceptance criteria / allowed scope / review-ready lists) that calls it —
  enough to take an assigned item from a fresh contract through Execute without touching test
  code.
- **Details:** Input shape is `GoalContractUpdateInput` (`acceptance_criteria: string[]`,
  `allowed_scope: string[]`, `review_ready: string[]`, optional `expected_goal_version`/
  `expected_input_revision`) in `src/domain/work-item.ts`. No existing route under
  `app/api/portfolio/work-items/[sourceId]/[workItemId]/` covers it (only `assignment`,
  `details`, `mission*`, `run-evidence`). Mission-handoff visibility also requires the item be
  assigned to a real project (not Inbox) — worth covering in the same pass since both currently
  block Milestone 2 testing.

## Deferred Initiatives

### Add an Inbox page for review and approvals

- **Status:** Revisit after the Kanban view and full workflow cycle work end to end.
- **Idea:** Add an inbox-style, cross-project review page inspired by T3 Code. It should let the
  founder quickly scan items needing attention, open the relevant update, and approve or choose
  the next step without using the Kanban view.
- **Boundary:** This is an alternate view over Product Studio's existing workflow state and
  evidence, not a replacement for the Kanban or a second workflow.

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
  picker out) — the free-text behavior was preserved as-is.*

## Open Questions

### Implement Multi-Agent AG-UI Kanban Orchestrator

This is an export from a short brainstorming session with Gemini. Dont strictly follow this, its only for inspiration and a baseline.

#### 🎯 Objective
Build a local web-based Kanban interface that coordinates **Codex CLI**, **Claude CLI**, and **Copilot CLI** as modular steps in a development workflow (Spec → Plan → Code → Review). The system must optimize model selection, manage token budgets, and stream full agent reasoning/terminal interactions directly to the UI.

#### 🧱 Architectural Components

##### 1. Frontend (AG-UI Client)
*   **Kanban Board:** Handles card transitions. Emits `STATE_DELTA` events on card drag-and-drop actions.
*   **Interactive Console Component:** Subscribes to the AG-UI event stream. Renders collapsible agent `thinking steps`, `TOOL_CALL` milestones, and interactive confirmation prompts (Human-in-the-Loop interrupts).

##### 2. Local Backend (AG-UI Orchestrator Server)
*   **State Evaluator:** Listens for Kanban column transitions and dynamically maps tasks to the optimal CLI tool.
*   **Token Budget Manager:** Tracks API usage across CLIs. Enforces model-steering rules or fallbacks if thresholds are reached.
*   **Process Wrapper:** Spawns selected CLIs as local subprocesses. Captures and translates raw standard output (`stdio`) into formatted AG-UI protocol events.

#### 🚀 Implementation & Documentation Links
*   **Project Scaffolder:** `npx create-ag-ui-app` (Initial framework setup)
*   **Protocol Specification:** [AG-UI Introduction & Specs](https://ag-ui.com)
*   **Python SDK:** [agent-framework-ag-ui (PyPI)](https://pypi.org)
*   **UI Foundation:** CopilotKit components adhering to the AG-UI streaming standard.

### Price per task metric

- The main metric that matters is price per task completion. Second is speed to task completion.
