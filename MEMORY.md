# Product Studio memory

Use this file only for durable, evidence-backed implementation and operating learnings that
will help future work. It is not a product requirements summary, active execution log, or
idea backlog.

## Entry template

### YYYY-MM-DD — concise learning title

- **Scope:** affected product area, workflow, or operating practice.
- **Evidence:** verified command, test, incident, review finding, or shipped result.
- **Guidance:** the reusable decision, constraint, or practice.
- **Supersession:** active, replaced by <link>, or retired because <reason>.

## Learnings

### 2026-07-21 — Break schema/cache circular deps at the value-object seam, not the aggregate

- **Scope:** Domain schemas and the rebuildable SQLite cache projection (roadmap 1.4, source-qualified capture work).
- **Evidence:** Importing a source-ID validator from the aggregate `portfolio` module into `work-item` schemas created a runtime circular dependency; extracting the validator into a dependency-free `portfolio-source.ts` value-object module (re-exported by `portfolio.ts`) resolved it without changing public imports. Separately, cache rows rehydrated from SQLite must omit NULL-backed optional keys rather than passing them as explicit `null` — nullable SQL columns are a projection detail, not a durable schema value, and `strictObject` validation rejects the extra key otherwise.
- **Guidance:** When a schema needs a validator owned by another aggregate module, extract the shared piece into its own small value-object module first rather than importing across aggregates. When projecting SQLite rows back into strict domain schemas, drop NULL-backed optional keys during rehydration instead of setting them to `null`.
- **Supersession:** active.

### 2026-07-21 — Transfer recovery must trust durable target state, not the journal stage alone

- **Scope:** Cross-workspace work-item transfer (recoverable capture moves, roadmap 1.4).
- **Evidence:** `tests/application/portfolio.test.ts` exercises a crash after atomic publish but before the journal is rewritten to `published`; recovery that only reads the journal's `staged` field would wrongly roll back and lose the moved item. Recovery instead re-checks the actual target/source filesystem state before deciding to complete vs. roll back. An unpublished `staged` rollback also needed a dedicated `discardStagedWorkItem` repository primitive so the orchestration layer isn't reaching into workspace filesystem internals directly.
- **Guidance:** Any journal/WAL-based recovery path must re-derive its decision from durable target state at recovery time, not just the last-written journal stage. Give orchestration a dedicated repository primitive for each cleanup action instead of having it manipulate another module's filesystem internals directly.
- **Supersession:** active.

### 2026-07-17 — Isolate this repo's Git identity/auth from the work GitHub account

- **Scope:** Local development environment (macOS laptop shared by personal and work GitHub accounts).
- **Evidence:** `gh auth status` shows two logged-in github.com accounts with `jviklun1` (work) active; `gh auth git-credential` only returns the **active** account token and returns nothing for a URL-pinned username, so HTTPS pushes would use the work account. `ssh -T git@github.com` authenticates as `johnviklund` (personal). SSH push of the baseline to `johnviklund/product-studio` succeeded.
- **Guidance:** This repo uses an SSH remote (`git@github.com:johnviklund/product-studio.git`) with a repo-local pinned key (`git config --local core.sshCommand "ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes"`) and a repo-local personal identity (`user.email john@viklund.se`). Do not switch it to HTTPS/`gh` credentials, which resolve to the active (work) account. Make no global git/gh changes for this.
- **Supersession:** active.

## Routing

- Put speculative product decisions in `PRODUCT.md`.
- Keep active execution detail in `.workflow/`.
- Capture new ideas and future changes in `TODO.md` through `workflow todo`.
