# Product Studio TODO

This is the human's workflow-managed intake scratchpad, not a roadmap. Use `workflow todo`
to capture, shape, merge, update, or archive future work; `ROADMAP.md` owns the initial
delivery phases.

## Active Initiatives

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
