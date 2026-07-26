# Product Studio TODO

This is the human's workflow-managed intake scratchpad, not a roadmap. Use `workflow todo`
to capture, shape, merge, update, or archive future work; `ROADMAP.md` owns the initial
delivery phases.

## Active Initiatives

## Deferred Initiatives

### Wire the `ambiguous_goal` and `missing_permission` attention decisions

- **Status:** Deferred — needs new contract fields, out of ROADMAP 3.2's scope.
- **Idea:** ROADMAP 3.2 (bounded patch loop and attention inbox) defines all 7 attention decision
  kinds in the schema (`work-item.ts`) and wires all 7 into the board projection switch
  (`board.ts`), but only 5 are ever produced: `spec_approval`/`plan_approval` (phase-derived) and
  `review_ready`/`unresolved_finding`/`cycle_limit`/`patch_plan_approval` (controller-routed).
  `ambiguous_goal` and `missing_permission` have no producer — no result or import contract
  carries a "missing required clarification" or "durable permission/harness reason" signal, so a
  genuinely ambiguous goal or missing-permission precondition currently surfaces as a generic
  rejected-import error instead of its dedicated, human-answerable inbox row (Phase 4 review,
  2026-07-25, P3, disposition: defer).
- **Boundary:** Wiring `ambiguous_goal` needs a new result-contract field for an agent to report
  required clarification; wiring `missing_permission` needs a compile/import precondition that
  reports a durable permission/harness reason — the latter brushes ROADMAP 3.2's explicit
  non-goal (no managed runner or harness launcher). Scope narrowly when picked up; don't fold in
  the broader non-goals.

### Enforce writer/reviewer model independence for review missions

- **Status:** Revisit once execution stops being fully manual/BYOA (e.g. a managed runner or
  mission launcher captures model identity automatically).
- **Idea:** ROADMAP 3.1 (Independent review mission and finding contract) trusts the founder to
  use a genuinely different model for review than for execution (FR-010's "different eligible
  model or vendor from the writer"), with no system check. Once model identity can be captured
  reliably rather than self-reported, add a required model-identity field to the writer's
  external-result submission and the review-mission compile request, and fail-closed block
  compiling the review mission if the reviewer's declared model exactly matches the writer's.
  Same vendor is fine; same model is not.
- **Boundary:** Independence enforcement only — not a general model-routing or evaluation system
  (that's ROADMAP Milestone 6).

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
  and the free-text tags input untouched — this item still applies as written.*

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

## Archived

### Add an Inbox page for review and approvals

- **Status:** Delivered — superseded by ROADMAP 3.2 (commits `84c939a`–`22d8b36`). The
  cross-project attention inbox (`app/inbox/page.tsx`, `listAttention()`) ships this as an
  alternate view over durable workflow state/evidence, per the original boundary.
