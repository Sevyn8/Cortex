# @cortex/bootstrap

P0.9 Super Admin bootstrap — CLI + business-logic module for creating the
first Super Admin identity in dev / staging. Production uses WorkOS SSO
(no CLI, no initial password).

For the full procedure — including production, emergency break-glass, and
the reset path — see [/docs/runbooks/super-admin-bootstrap.md](../../docs/runbooks/super-admin-bootstrap.md).

## Quick start (dev)

```
# In one terminal
make db-proxy-dev

# In another terminal
export GCP_PROJECT_ID=sevyn8-cortex-dev
pnpm bootstrap:super-admin --env=dev
```

Same flow for staging with `--env=staging` and `GCP_PROJECT_ID=sevyn8-cortex-staging`.

## Layout

- `create-super-admin.ts` — thin CLI (argv, preflight, stdin prompts)
- `lib/bootstrap.ts` — pure-function business logic with dependency
  injection for the DB + `@cortex/secrets.secrets.put`
- `lib/bootstrap.test.ts` — unit tests (14 tests, including the
  password-never-in-logs invariant)

Run tests: `pnpm --filter @cortex/bootstrap test`.
