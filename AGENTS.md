# Product Studio working rules

## Skill invocation (process invariant)

A message of the form `workflow <command>` or `/workflow <command>` (brainstorm, spec, plan,
execute, review, learn, wrap, status, next, log, compact, todo, bootstrap, improve) is a
**deliberate skill invocation, not a request to improvise**. Before reading files, running
commands, or emitting any output, **invoke the `workflow` skill as the first action** and
follow its loaded instructions (seat, verification bar, and the mandatory closing next-step
card). Reading the skill's `SKILL.md` or `references/*.md` directly is **not** a substitute for
invoking the skill. The same rule applies to any message that matches an available skill's
documented trigger: invoke the skill first, then act.

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
- Every connected seat must narrow its tool grant to the write policy that will judge it, at the
  point the runtime profile is built — never rely on the permission evaluator to deny a tool the
  seat should not have been offered. A denial is terminal: a forbidden call ends the run as
  `missing_permission`, so an over-broad grant is a latent, model-dependent run failure that a
  green test suite and one well-behaved model will not reveal. Shared runtime-profile config is
  the union across seats; each runtime is responsible for the intersection with its own policy.
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

## GitHub CLI account

This repo lives under the personal `johnviklund` GitHub account, but `gh`'s global default
on this machine is a work account. To avoid globally switching accounts (which races across
concurrent terminals), the personal token is provided per-shell via `GH_TOKEN`:

- **Interactive terminals:** direnv loads the repo's `.envrc`, which exports `GH_TOKEN` from
  `~/.config/gh-tokens/johnviklund` (chmod 600, never committed). `cd` into the repo and gh
  is personal automatically; other terminals keep the global work default. No action needed.
- **Agent-run `gh` commands** (this tool runs fresh non-interactive shells that do **not**
  trigger direnv): prefix every `gh` invocation with the token so it targets the personal
  account without touching global state:

  ```bash
  GH_TOKEN="$(cat "$HOME/.config/gh-tokens/johnviklund")" gh <args>
  ```

  Do this automatically as part of the `gh` step — do not ask the user, and do **not** use
  `gh auth switch` (it is global and races with the user's other terminals). If the token
  file is missing, fall back to `gh auth switch --user johnviklund` and tell the user to
  re-seed the file. `git push`/`pull` use SSH and are unaffected — this applies to `gh` only.

## Future command contract

The initial Next.js setup will add and document package-manager scripts for development,
linting, typechecking, testing, and production builds. Until then, no project command,
test framework, database migration, or source-directory convention is implied.
