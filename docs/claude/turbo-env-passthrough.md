# Turbo env var passthrough

> Relocated from CLAUDE.md for context-budget; loaded on demand.

Turbo 2.x runs in strict env mode by default. Env vars are stripped from task
child processes unless explicitly declared:

- `task.env[]` - passes through AND includes in cache key (use for vars that
  change behavior, like PGHOST)
- `task.passThroughEnv[]` - passes through WITHOUT affecting cache key (use
  for secrets/tokens that shouldn't invalidate cache)
- `globalPassThroughEnv[]` - same but repo-wide

Forgetting this manifests as surprising `undefined` env vars in test/build
processes despite them being set at the shell or CI level. See `turbo.json`'s
`test.env` for the pattern.

First time encountered: P0.5 Phase 2C ci.yaml first-run - Postgres env vars
set at GHA job level weren't reaching vitest subprocess via `pnpm test` →
`turbo test` → `vitest`.
