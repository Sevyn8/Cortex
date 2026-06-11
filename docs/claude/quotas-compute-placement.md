# Quotas + Compute Placement (F01 Slice C)

> Relocated from CLAUDE.md for context-budget; loaded on demand.

`@cortex/quotas`: token bucket per `(tenant, resource_class)` backed by `tenant_quota_usage`; HTTP middleware (framework-agnostic + Hono / Express adapters); 429 + `Retry-After` + `QUOTA_EXCEEDED` audit on every rejection.

`@cortex/compute-placement`: `getComputePlacement(tenantId, workload, env)` returns `ComputePlacement` (`shared` | `dedicated`). Phase 1 always shared; F02 will branch on `tenant.tier`.

Key conventions:

- Library returns `CheckQuotaResult`; does NOT throw on exceedance (throwing rolls back the audit row that just emitted). `QuotaExceededError` class exists for callers wanting throw-semantics — they construct manually from the result.
- `REJECT` verb covers both workflow-rejections AND throughput-rejections (quota, rate limit, circuit breaker). Audit consumers filter by action name to disambiguate.
- BigInt at API boundaries: `String()` before `JSON.stringify`, before pino, before HTTP response body. `pg` returns `bigint` as string for raw `db.execute()` — explicit `BigInt()` coercion at boundary.
- Cloud Run service names: `{workload}-shared` / `{workload}-tenant-{uuid}`; 19-char workload max; `env` in GCP project path, NOT in service name.
- `placement` label (`shared` | `dedicated`) is **deployment shape**, NOT commercial tier. `tenant.tier` (`STANDARD` | `ENTERPRISE`) is the commercial tier; lives in DB.
- Pre-check semantics for `api_calls` / `db_connections` (middleware fires `resolveIncrement` before request); post-emit pattern for `cpu_seconds` / `ram_mb` (call `checkQuota` directly after work completes).
- `db_connections` counts connections opened per minute (NOT concurrent). True concurrent-limiting belongs in PgBouncer / connection-pool layer.
- Strict-greater (`>`) for "exceeded" — request landing AT the limit passes; only over-the-limit rejects. Industry convention.
- Default per-tier quotas are TUNABLE baselines, not load-derived. Adjust via F02 `tenant_config_version` overrides, NOT by widening the constants.

References: ADR-COMPUTE-001 (Cloud Run vs K8s), ADR-INFRA-007 (substrate-now precedent), ADR-AU-001 (audit emission), planning doc `docs/planning/f01-slice-c-quotas-compute-isolation-scope.md`, convention doc `docs/architecture/quotas-compute-placement-convention.md`, F02 swap doc `docs/architecture/f02-swap-paths-for-slice-c-resolvers.md`.
