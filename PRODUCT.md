# Product Studio

## 1. Mission and MVP promise

Product Studio is a local-first control plane for a technical solo founder to capture,
progress, review, and approve AI-assisted product work across several repositories. It
productizes the workflow skill's deliberate work loop into durable product behavior. Its MVP
makes the daily portfolio workflow calmer and more trustworthy: a focused Kanban,
one-sentence capture, portable agent missions, connected execution using different LLM models,
deterministic verification, independent review, and a clear human decision when attention is
required.

## 2. User, positioning, and non-goals

The first user is the product owner: a technical solo founder actively building and
operating multiple products with interchangeable AI tools. Product Studio is a
portfolio-level operating system for governed product outcomes, not an IDE, terminal
multiplexer, generic project-management suite, model chat application, or wrapper for
one vendor. It is not initially a multi-user hosted product, a full autonomous delivery
system, or a replacement for Git, pull requests, CI, or hosting.

MCP is unsupported in the target organizational environment and is not a Product Studio
integration option. Local agent connections must operate without configuring, starting,
connecting to, proxying, or exposing MCP servers or tools.

## 3. Settled product principles

- Durable files, rather than conversations or a local database, own product and workflow
  truth.
- A deterministic controller owns transitions, limits, policy checks, and completion
  decisions; agents only make bounded execution or review attempts.
- Autonomy is bounded, earned with evidence, and constrained by permanent risk floors.
- Writers and reviewers are independent where configured; reviewers are read-only.
- Human authority is preserved: an LLM cannot set a work item to `completed`.
- Product concepts are provider-neutral. GitHub, model vendors, CLIs, and runtimes are
  adapters, not workflow phases.
- Execution is external and replaceable. The product owns intent, evidence, and the next
  action; capable agent applications perform individual attempts.

## 4. MVP scope

Milestones 1–3 form the MVP:

1. A focused, cross-project Kanban with Todo, Spec, Plan, Execute, Review, Ship, and
   Done; project filtering; context-preserving side panels; and fast, unassigned capture.
2. Provider-neutral portable missions, durable controller state, result import, and
   deterministic verification, with manual bring-your-own-agent handoff retained as a recovery
   path.
3. An independent, read-only cross-agent review and patch loop with bounded retries, attention
   handling, and one transport-neutral connected adapter that can drive the agent-assisted
   workflow from shaping through approved implementation using different founder-selected LLM
   models for different steps.

The intended application stack is one deployable Next.js App Router application using
TypeScript, Tailwind CSS, shadcn/ui, and better-sqlite3 for its rebuildable local cache.
`DESIGN.md` remains the visual-system authority.

## 5. Post-MVP boundaries

Semantic Activity and live Updates, additional execution adapters, deployment and operational
adapters, governed learning proposals, model evaluation/routing expansion, multi-user
collaboration, and a hosted control plane are post-MVP. They require dogfooding evidence rather
than speculative architecture. Product Studio does not add them merely to remove every manual
action.

## 6. Lifecycle and gates

The lifecycle is Idea → Brainstorm → Spec → Plan → Execute → Review → Test → Ship → Learn,
with Operate as a continuous lane. Each active item has one bounded next action.

The controller validates preconditions, runs or records required deterministic checks,
then evaluates whether an item can advance, iterate, escalate, or ask for human approval.
Spec, plan, risky-change, patch/escalation, and ship/revert gates preserve human control.
Passing checks can make a result `review_ready`; only an authorized human or policy gate
may set it to `completed`.

## 7. Durable-state rule

Markdown holds semantic artifacts such as product direction, briefs, specifications,
plans, and review findings. JSON or YAML holds machine-readable state and contracts.
SQLite is a disposable local cache/index that can be rebuilt from durable files; it is
never the only copy of product or workflow state.

Product workspaces use `.founder/` as the initial metadata directory. Its version-2 product
manifest, version-2 goal contract, and version-2 state contract are implemented in
[`src/domain/work-item.ts`](src/domain/work-item.ts) and demonstrated by the checked-in
[`fixtures/sample-workspace`](fixtures/sample-workspace).

The version-2 work-item goal schema is additive: lightweight captures omit `goal_contract` and
controller fields, while governed items carry a complete nested version-1 goal contract with a
purpose, acceptance criteria, non-goals, allowed scope, and review readiness. Its `goal_version`
must match state `goal_version`, `input_revision`, and `attempt`. Controller runs use exclusive
per-item leases and strict durable manifests; incompatible or partial combinations fail closed.
SQLite schema v6 is a rebuildable projection of those files, including purpose, non-goals,
patch-cycle state, and attention, not
a migration authority.

## 8. Core documents

- [Design system](DESIGN.md)
- [Delivery roadmap](ROADMAP.md)
- [Repository working rules](AGENTS.md)
- [Promoted repository learning](MEMORY.md)
- [Intake scratchpad](TODO.md)
- [Archived PRD](docs/archive/PRD.md) — historical detail and rationale

## 9. Open product decisions

The following remain unresolved and must be decided with implementation evidence:

- Final product name.
- The first two proof repositories for provider-neutral manual handoff.
- Canonical mission and result-submission schemas, including which agent-specific renderers
  add real value.
- The first approved non-MCP local transport and reference adapter. Whether it uses a CLI or
  another approved local protocol is an implementation decision and must not alter the user
  workflow.
- Whether a future managed runner needs subprocess-only execution or PTY support.
- GitHub synchronization depth: repositories and pull requests only, or optional issue
  mirroring.
- Local-runner lifecycle: foreground process, background daemon, or tray utility.
- A method for estimating subscription and local-model effective cost.
- Evaluation grading format and critical-case thresholds.
- Initial monitoring sources for prototypes.
- When, if ever, to introduce a hosted control plane.

These decisions do not reopen the selected initial application stack. Any stack change or
other material product decision must be recorded deliberately here or in an approved
workflow artifact.
