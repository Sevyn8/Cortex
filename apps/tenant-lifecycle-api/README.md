# `@cortex/tenant-lifecycle-api`

F02 Slice D HTTP surface — the operator-facing entry point for tenant
lifecycle workflows. D.1 ships the prototype gate (this commit); D.2 → D.6
land the full surface.

## Status

- **D.1** — Hono prototype: `/health` + `GET /v1/tenants/{id}` +
  `/v1/test/slow-5s` (dev-only). Verifies ADR-HTTP-001 Conditions 2 + 3
  (cold-start ≤ 500 ms p95, SIGTERM clean within Cloud Run's 10 s grace).
- D.2 — `tenants.rotateKeys` library workflow + worker route.
- D.3 — full 12-endpoint HTTP API.
- D.4 — `infra/terraform/modules/tenant-cloud-run-service` TF module.
- D.5 — Cloud Run invoker IAM authz.
- D.6 — convention §7 finalize + Slice D close.

## Local dev

```bash
# Postgres reachable via .env or env vars (PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE).
pnpm install
pnpm --filter @cortex/tenant-lifecycle-api dev
```

## Cloud Run dev deploy

`scripts/deploy-dev.sh` deploys to `sevyn8-cortex-dev` per SD2. SA
impersonation chain: `cortex-tf-admin-dev` (existing dev access). The
deploy uses `--no-allow-unauthenticated` per SD8; access during
measurement is via `gcloud run services proxy` or an explicit
`--member` grant.

## D.1 measurement scripts

- `scripts/cold-start-burst.sh` — SD3 30-burst cadence via revision
  rotation. Outputs CSV.
- `scripts/sigterm-verify.sh` — SD4 3-deploy slow-handler protocol.
  Outputs PASS/FAIL.

Both scripts are idempotent. The cold-start burst is ~7.5 hr unattended
(15 min idle × 30 samples).

## Convention reference

Convention `tenant-lifecycle-convention.md` §7.1 (added in this commit)
captures the prototype's existence + the SIGTERM handler shape + the
OTel cold-start instrumentation. D.2 → D.6 extend §7 incrementally per
Q-NEW-D-12.
