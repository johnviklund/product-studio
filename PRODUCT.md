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

The loopback bind is the local runtime perimeter: Product Studio is served on `127.0.0.1`,
and non-loopback deployment is unsupported. Every shaping mutation fails closed unless
`PRODUCT_STUDIO_APP_ORIGIN` is exactly one configured loopback origin and the request's `Origin`
and `Host` headers both match it; forwarded headers are ignored. These checks, exact hash binding,
and structural freshness provide browser-CSRF protection and freshness, not identity or
human-presence proof. They do not defend against a malicious same-user local process, including an
agent launched by Product Studio. The principles above therefore remain workflow guarantees, not
OS-enforced containment.

Product Studio gives a producing shaping agent no approval action, approval endpoint capability,
or approval credential:
`PRODUCT_STUDIO_APP_ORIGIN` is excluded by name from the spawned environment allowlist; no origin,
route path, or binding hash is included in its prompt, `TASK.md`, mission, launch instruction, or run
record; and every ACP-mediated command or URL attempt is denied. The controller never advances from
agent output automatically; each phase move is a separate founder-initiated leased decision. At
the controller/workflow layer, an agent cannot approve its own result. This describes what the
product supplies and what the controller does, not a technical inability of a
same-user process to call the loopback decision routes. Closing that gap would require a distinct
user account, an OS sandbox, or real authentication and is outside this slice.

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

Forward shaping transitions are reserved to their dedicated decision operations:
`idea → brainstorm`, `brainstorm → spec`, and `spec → plan`; the `plan → execute` workflow
decision is likewise reserved to its dedicated Plan-approval operation. `Start Brainstorm`, in
connected or manual-recovery mode, is the only route from Idea into Brainstorm, so entry always
publishes a mission. The generic phase-update route and controller reject direct requests for those
reserved transitions, while `idea → spec`, `spec → brainstorm`, and `plan → spec` remain closed.
Spec requires a real Brainstorm selection, backward movement uses phase-local `Request changes`,
and `Approve & run Execute` validates the exact Plan result and current governed contract before
creating the governed Execute handoff.

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
a migration authority. A further immutable artifact family exists at
`.founder/shaping/<work_item_id>/<phase>-<input_sha256>/` for Brainstorm, Spec, and Plan at
`shaping_schema_version: 2`. Its missions form immutable, feedback-bearing revision chains. Each
revision carries at most one applied result, atomically published under `applied/` with
`result.json`, `import.json`, one `production.json`, and the `applied.json` commit marker, plus one
immutable decision receipt when that revision is decided. A separate
`.founder/shaping-runs/<work_item_id>/<run_id>/` family holds artifact-only run records and their
hash-bound launch instruction with a single writable `ingress/` path. Deterministic manual ingress
lives separately under `.founder/shaping-ingress/<work_item_id>/<phase>-<input_sha256>/`, whose
root is gitignored. These shaping families are deliberately unprojected — no SQLite table indexes
them.

An applied shaping result is recognized only as a complete, commit-marked bundle: readers accept
`applied/` only after `applied.json` validates every component. Publication and terminal run
success are crash-coupled in one order — validate, publish the bundle, then mark the run ready — so
reconciliation can finish a crash between those operations without accepting a partial result or
creating a duplicate run.

Founder seat-model preferences persist in the versioned, gitignored application-root document
`.portfolio/model-preferences.json`. They are reusable preferences, not product or workflow truth,
which is why they live outside `.founder/` and outside SQLite.

Shaping artifacts are versioned durable files with no backward-compatible reader. A schema cut
therefore requires an explicit founder decision about both the existing artifacts and the durable
state that depends on them. On 2026-08-01 that decision archived and reset the disposable workspace
because two active work items had governed goal contracts derived from the retired v1 results.

A retained per-work-item `.controller.lock` fails closed. The controller neither identifies its
owner nor claims or takes over another process's lock; it reports an actionable `repair_required`
with the lock, recorded run, and repair action. Explicit founder-invoked repair verifies that the
lock payload and `state.active_run` describe the same acknowledged run, clears both durable
representations in a crash-safe order, and is idempotent. Automatic owner identification, claiming,
takeover, and orphan signalling remain a later controller-reliability slice. Shaping-run
reconciliation retains its separate non-destructive signal-0 liveness probe, with PID reuse failing
closed by treating a responding PID as live. Each shaping decision intent also records the exact
pre- and post-operation `goal.yaml` and `state.json` bytes and hashes, so recovery is decided from
durable files alone.

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
  - **Decided (2026-07-28, ROADMAP 3.4 Slice 1, commits `d94ed51`–`be08779`):** the Brainstorm,
    Spec, and Plan shaping phases use their **own** contract (`src/domain/shaping.ts`,
    `shaping_schema_version: 2`, identity `(phase, work_item_id, input_sha256)`) rather than
    widening `MissionPhase` — Execute's identity requires a governed goal version, input revision,
    and attempt that shaping items do not all legitimately have, so `MISSION_PHASES` stays
    `["execute","review","patch"]`. Shaping mission content is model-independent and
    path-independent: model provenance belongs to each run, while every concrete ingress path is
    carried by a hash-bound per-launch instruction. Renderers: exactly one provider-neutral
    `renderShapingTaskMd`, no agent-specific renderers. The Execute/Review/Patch half of this
    decision — which agent-specific renderers, if any, add real value there — remains open.
- The first approved non-MCP local transport and reference adapter. Whether it uses a CLI or
  another approved local protocol is an implementation decision and must not alter the user
  workflow.
  - **Decided (2026-07-26, ROADMAP 3.3, commits `4c51ee0`–`995bf74`):** Copilot CLI over ACP v1
    stdio, adapter id `copilot-acp`. Version one is permission-mediated local execution — an
    explicit versioned capability envelope (workspace scope digest, approved command/URL forms,
    forbidden MCP/credentials) evaluated per exact normalized operation, not independent OS
    containment (`not_independently_enforced` / `launching_user` machine authority, disclosed to
    the founder). A future adapter must satisfy the same contract; the transport/protocol choice
    itself must still not alter the user workflow.
    Shaping runs use no capability envelope: their narrow artifact-only write policy is part of the
    shaping-run contract and is enforced by a shaping-specific pure evaluator because the shared
    envelope evaluator permits every in-workspace write. This guarantee covers ACP-mediated
    permission requests only; unmediated writes are not prevented and repository reads are not
    isolated, under the same `permission_mediated_local` / `not_independently_enforced` disclosure.
- Connected shaping runs record an adapter-observed effective model resolved from ACP `session/new`
  configuration options and `config_option_update` notifications. The evidence is hashed and
  redacted before persistence: option id, type, category, current value, choice values, and the
  validated `deployment_id` scalar are retained in the hash input, while other `_meta` keys and all
  names and descriptions are discarded. Effective identity is never backfilled from the requested
  model, launch arguments, or configured model list; an unobserved model is recorded and rendered
  as the literal `unknown`. Per-seat model independence is proven from observed effective identities,
  not requests.
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
