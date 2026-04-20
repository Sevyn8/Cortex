# Contributing to Cortex

Full coding, commit, branching, audit, error, testing, stack, and feature-flag conventions live in `CLAUDE.md` at the repo root. Read it before contributing.

## Before you commit

- `pnpm format && pnpm lint && pnpm typecheck` pass locally.
- Tests cover every new acceptance criterion.
- Spec / code alignment preserved (update the spec or the code, never leave silent drift).

## Commits

Conventional commits, scope = module id (lowercase):

```
feat(f01): multi-tenancy infrastructure

Prompt: P1.1
Spec: §F01-FR-001..F01-FR-053
```

## Branching

Trunk-based. Short-lived branches `{prompt-id}-{short-desc}` (e.g. `p1.1-f01-multi-tenancy`). PR into `main`; at least one human review for non-trivial PRs.

## Running tasks

- `pnpm dev` — run all dev tasks in parallel via Turborepo
- `pnpm build` — build everything
- `pnpm -r typecheck` — typecheck every workspace
- `pnpm -r lint` — lint every workspace
- `pnpm test` — run all tests
- `pnpm format` — Prettier write

## Husky hooks

- `pre-commit`: `lint-staged` (ESLint + Prettier on staged files)
- `commit-msg`: `commitlint` (enforces conventional commit format)

Confidential — Sevyn8 Private Limited.
