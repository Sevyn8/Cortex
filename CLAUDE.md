# Cortex: Claude Code instructions

> This file is the always-loaded core. Situation-specific detail has been relocated to
> `docs/claude/<topic>.md` to stay under the context-window budget. Read the relevant topic
> doc before working in that area (see "Topic docs" at the bottom). Nothing was deleted, only
> moved.

## Prose convention

- No em-dashes (the long dash, Unicode U+2014) anywhere in prose. Use commas, parentheses,
  colons, or rewrite the sentence. This applies to this file, commit messages, and PR text.

## Plan mode

- Enter plan mode and get operator sign-off before any non-trivial or hard-to-reverse change:
  multi-file refactors, schema migrations, infrastructure applies, or anything touching prod.
- Skip plan mode only for trivial, clearly-scoped edits (typos, single obvious fixes).

## Authorization protocol (HOLD)

- Never `git push`, nor create or move a git tag, without explicit operator go-ahead. This is
  the HOLD gate. Stage work as local commits and pause for authorization.
- Slice work that breaks across sessions stages as a local WIP commit and squashes at HOLD #3
  composition. Before writing a WIP commit, read `docs/claude/wip-commits.md`.

## Spec-first workflow

- Read `/docs/spec/cortex_v2.2.docx` before implementing any module or screen
- Every functional requirement (FR-NNN) in a spec section has at least one test
- Spec drift: update the spec OR update the code, never leave drift uncommented
- Significant divergence: open an ADR in `/docs/architecture/decisions/`

## Coding conventions

- TypeScript strict. No implicit any. No @ts-ignore without ADR reference.
- Functions under 40 lines; files under 400 lines (soft limits, flag violations in PR review)
- No business logic in controllers/routes. Thin HTTP handlers, then service layer, then
  repository.
- Zod schemas for every API input and output
- No `console.log`; use `@cortex/observability` logger
- Before choosing a convention-doc filename, read `docs/claude/convention-doc-naming.md`

## Commit conventions

- Conventional commits. Types: feat, fix, docs, refactor, test, chore, ops (commitlint also
  allows perf, style, build, ci, revert).
- Scope = module ID (lowercase): `feat(f01): ...`
- Include prompt ID in commit body: `Prompt: P1.1`
- Reference spec section: `Spec: §F01-FR-003`
- Commitlint constraints: type MUST be one of the allowed types above (`wip` is rejected by
  `type-enum`); subject MUST be lowercase, module IDs included (`d.1-d.4` passes, `D.1-D.4`
  fails `subject-case`).

### Co-Authored-By trailer

Commit messages MUST NOT include `Co-Authored-By: Claude` or any AI co-author trailer unless the operator explicitly requests one in the current turn. Default to no trailer. This applies to all squash bodies, single commits, and amended commits without exception.

## Branching & PR

### Trunk-based with mandatory PR gating

Main is protected. Direct pushes are blocked. All changes, including chores, docs, and trivial fixes, go through a feature branch plus a PR plus a CI-green gate. CI is the only gate; no human review required for solo-dev velocity.

### Standard workflow per change

1. `git checkout -b <branch-name>` (slice branches as `pX.Y-fNN-slice-Z`, fixes as
   `fix-<slug>`, chores as `chore-<slug>`).
2. Local verification: `pnpm vitest run` against compose Postgres. Must pass before push.
   Before running local tests or DB setup, read `docs/claude/local-development.md`.
3. `git push -u origin <branch-name>` (operator HOLD applies; see Authorization protocol).
4. `gh pr create --fill --base main`
5. Wait for CI on the PR. Required check: `Run foundation tests against ephemeral Postgres`.
6. After CI green: `gh pr merge --merge --delete-branch` (or `--squash --delete-branch` for
   slice-style multi-commit branches that should land as one squashed commit).
7. Pull main locally: `git checkout main && git pull`.

Background on why there is no admin bypass and the solo-dev review posture lives in
`docs/claude/branching-notes.md`.

## Error responses

- Standard shape: `{ code, message, correlation_id, details? }`
- HTTP status alignment: 400 VALIDATION, 401 UNAUTH, 403 FORBIDDEN, 404 NOT_FOUND, 409 CONFLICT, 422 BUSINESS_RULE, 429 RATE_LIMIT, 500 INTERNAL
- Use `@cortex/http-errors` package

## Testing

- Unit test coverage: 80% line / 70% branch minimum
- Every acceptance criterion from spec maps to at least one test
- Regression tests required for bug fixes
- Every widget and screen passes axe-core (WCAG 2.1 AA)

## Stack constraints

- Auth: WorkOS (not Auth0, not self-hosted)
- ORM: Drizzle (not Prisma, not raw pg)
- Monorepo: Turborepo (not Nx)
- CSS: Tailwind 4 with CSS vars for theming
- Node: 22 LTS
- Package manager: pnpm

## Feature flags

- All new capabilities roll out behind a feature flag (`@cortex/feature-flags`)
- Flags tracked in F04; retire within 6 months of stability
- Before working on `@cortex/feature-flags` internals, read `docs/claude/feature-flags.md`

## Topic docs (lazy-loaded detail)

Read the matching doc before working in that area:

- Before emitting audit events, read `docs/claude/audit-events.md`
- Before using encryption or blob storage, read `docs/claude/encryption-blob-storage.md`
- Before touching quotas or compute placement, read `docs/claude/quotas-compute-placement.md`
- Before writing a migration or working with RLS, bi-temporal, or `audit_event` tables, read
  `docs/claude/database-conventions.md`
- Before working on the F04 configuration plane, read `docs/claude/config-plane.md`
- Before changing SCD policies or the SCD trigger, read `docs/claude/scd-policies.md`
- Before adding a service or an `apps/<workload>-api` workload, read
  `docs/claude/workspace-layout.md`
- Before adding turbo task env vars, read `docs/claude/turbo-env-passthrough.md`
- Before running local tests or DB setup, read `docs/claude/local-development.md`
- Before writing Terraform or debugging IAM errors, read `docs/claude/terraform.md`
- Before naming a service account, secret, or image tag, read
  `docs/claude/naming-conventions.md`
- Before working on feature-flags internals, read `docs/claude/feature-flags.md`
- Before writing a WIP commit, read `docs/claude/wip-commits.md`
- Before choosing a convention-doc filename, read `docs/claude/convention-doc-naming.md`
- Background on branch protection and the no-admin-bypass decision:
  `docs/claude/branching-notes.md`
