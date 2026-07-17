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

### 2026-07-17 — Isolate this repo's Git identity/auth from the work GitHub account

- **Scope:** Local development environment (macOS laptop shared by personal and work GitHub accounts).
- **Evidence:** `gh auth status` shows two logged-in github.com accounts with `jviklun1` (work) active; `gh auth git-credential` only returns the **active** account token and returns nothing for a URL-pinned username, so HTTPS pushes would use the work account. `ssh -T git@github.com` authenticates as `johnviklund` (personal). SSH push of the baseline to `johnviklund/product-studio` succeeded.
- **Guidance:** This repo uses an SSH remote (`git@github.com:johnviklund/product-studio.git`) with a repo-local pinned key (`git config --local core.sshCommand "ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes"`) and a repo-local personal identity (`user.email john@viklund.se`). Do not switch it to HTTPS/`gh` credentials, which resolve to the active (work) account. Make no global git/gh changes for this.
- **Supersession:** active.

## Routing

- Put speculative product decisions in `PRODUCT.md`.
- Keep active execution detail in `.workflow/`.
- Capture new ideas and future changes in `TODO.md` through `workflow todo`.
