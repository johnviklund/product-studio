# Product Studio working rules

## Required reading

Before product, UI, workflow, or architecture work, read `PRODUCT.md`, `DESIGN.md`,
`ROADMAP.md`, and the relevant `.workflow/*` handoff artifacts. Consult `MEMORY.md`
only when it contains promoted, applicable evidence-backed learning. For `workflow todo`,
read `TODO.md` in full before proposing an update. `TODO.md` is workflow-managed intake,
not product direction or a delivery plan.

## Application boundary

Application work uses Next.js App Router, TypeScript, Tailwind CSS, shadcn/ui, and
better-sqlite3. Record any material deviation in `PRODUCT.md` or an approved workflow
artifact before relying on it. No application, package, test, database, or migration
tooling exists in this baseline yet.

## Durable truth and controller rules

- Keep product and workflow truth in durable files; SQLite is a rebuildable cache/index,
  never the only source of state.
- The controller owns transitions. Validate expected phase, status, input revision, and
  schema version before changing state.
- Transitions must be idempotent, use a single execution lease, recover from partial
  failures, and never guess a conflicting state.
- Keep provider-specific behavior behind adapters. Do not turn vendor names into product
  phases or state concepts.

## Execution and review

- Keep writers and reviewers independent where configured. Reviewers are read-only.
- Run required deterministic verification before accepting a result as review-ready.
- An agent cannot override a required red check, self-authorize completion, or set an item
  to `completed`; the controller and authorized human or policy gate decide progression.

## Workspace hygiene

- `TODO.md` starts empty: the roadmap owns the initial delivery phases.
- Use `workflow todo` (or an explicit user request) to add, merge, update, or archive ideas,
  initiative-sized future changes, small UI changes, and open questions. Preserve it as the
  human's managed log; do not silently repurpose or clear its entries during implementation.
- Use `.workflow/` for per-cycle scratch handoffs and execution state.
- Promote only evidence-backed, durable implementation or operating learning into
  `MEMORY.md`; do not make it a PRD summary or an active work log.

## Future command contract

The initial Next.js setup will add and document package-manager scripts for development,
linting, typechecking, testing, and production builds. Until then, no project command,
test framework, database migration, or source-directory convention is implied.
