# @cortex/tenant-context

Multi-tenancy substrate for Phase 1 — async-local tenant binding, DB session
glue for RLS, control-plane CRUD on the tenant registry, append-only audit
emission, and a framework-agnostic HTTP middleware.

This package is the runtime side of F01 Slice A. It owns: (1) the
`AsyncLocalStorage` store that threads `tenantId` through every async chain
in a request, (2) the bridge from that store to Postgres' `app.tenant_id`
session variable that RLS policies read, (3) the CRUD surface against the
`tenant` / `tenant_config_version` control-plane tables, and (4) audit-event
emission into the SHA-chained `audit_event` table. F02 (lifecycle workflows
— Cloud SQL provisioning, CMEK allocation) consumes this package; it does
not live here.

## Quick start

```ts
import {
  withTenantContext,
  ensureBoundToTenant,
  tenants,
  emitAuditEvent,
  buildTenantContextMiddleware,
} from '@cortex/tenant-context';

// At request entry — middleware sets the async-local context.
const middleware = buildTenantContextMiddleware({
  validateTenant: async (id) => {
    await tenants.get(db, id); // throws TenantNotFoundError if unknown
  },
  skipPaths: ['/health', '/readiness'],
});

// Inside any request handler — context is bound automatically.
await db.transaction(async (tx) => {
  await ensureBoundToTenant(tx); // app.tenant_id := <ctx tenantId>
  // ... RLS-protected queries against tx ...
});

// Control-plane CRUD (no caller-side context required).
const t = await tenants.create(
  db,
  { externalId: 'acme', displayName: 'ACME Corp', tier: 'STANDARD' },
  { actor: { type: 'service', id: 'cortex-foundation' } },
);
```

## Public API

### Async-local context

| Symbol                            | Purpose                                                                 |
| --------------------------------- | ----------------------------------------------------------------------- |
| `withTenantContext(tenantId, fn)` | Run `fn` in an async scope bound to a tenant. UUID-validated.           |
| `withoutTenantContext(fn)`        | Nested scope that hides any outer binding. Use for control-plane reads. |
| `getTenantId()`                   | Returns current tenant id, or `undefined` if no context.                |
| `getTenantOrThrow()`              | Throws `TenantContextMissingError` when context is absent.              |

### DB session binding

| Symbol                                | Purpose                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `bindTenantToDbSession(db, tenantId)` | Sets `app.tenant_id` for the current transaction via `set_config(..., true)`. |
| `ensureBoundToTenant(db)`             | Reads tenant id from the async-local store and binds it.                      |

Both functions REQUIRE the caller to be inside an open transaction —
`set_config(..., true)` is transaction-scoped (semantically `SET LOCAL`).

### Tenant CRUD — `tenants` namespace

| Method                                            | Notes                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `tenants.create(db, input, { actor })`            | Inserts tenant + optional `tenant_config_version` v=1, emits `TENANT_CREATED` (+ `TENANT_CONFIG_VERSION_CREATED`). |
| `tenants.get(db, id)`                             | Throws `TenantNotFoundError` if absent.                                                                            |
| `tenants.getByExternalId(db, externalId)`         | Slug lookup.                                                                                                       |
| `tenants.list(db, options?)`                      | Paginated `{ items, total, limit, offset }`. Default limit 50, max 200.                                            |
| `tenants.update(db, id, patch, { actor })`        | `displayName` only (other fields immutable). Refuses `TERMINATED`.                                                 |
| `tenants.setStatus(db, id, newStatus, { actor })` | Slice A whitelist; rejects same → same.                                                                            |

Every mutation runs in `db.transaction(...)` so the registry update and the
audit row commit (or roll back) atomically. Reads are plain SELECTs.

### Audit emission

| Symbol                       | Purpose                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `emitAuditEvent(db, params)` | INSERT one row into `audit_event`. Auto-fills `prev_hash`/`curr_hash` via DB trigger. |

Caller MUST have bound a tenant id to the DB session (RLS write policy
requires it) and MUST be inside a transaction. `audit_event` is append-only
— UPDATE/DELETE raise SQLSTATE 2F002.

### HTTP middleware

| Symbol                                   | Purpose                                       |
| ---------------------------------------- | --------------------------------------------- |
| `buildTenantContextMiddleware(options?)` | Returns `{ hono, express }` adapter methods.  |
| `defaultHeaderExtractor`                 | Reads `x-cortex-tenant-id`, case-insensitive. |
| `TenantExtractor`                        | Function type for custom extractors.          |

```ts
const m = buildTenantContextMiddleware({
  validateTenant: async (id) => {
    await tenants.get(db, id);
  },
  skipPaths: ['/health'],
});

// Hono:
honoApp.use(async (c, next) => m.hono(c, next));
// Express:
expressApp.use(m.express);
```

The framework choice is deferred — see future-roadmap §10.11.

## Async context vs DB session

Two different "current tenant" stores exist and they are kept in sync
explicitly:

```
HTTP request ──► middleware
                     │
                     ▼
            withTenantContext(id, fn)        ◄── JS async-local store
                     │
                     ▼
            db.transaction(async (tx) => {
              await ensureBoundToTenant(tx); ◄── reads JS store, sets DB store
              // ... RLS-protected queries ...
            })
```

`withTenantContext` populates the async-local store; `ensureBoundToTenant`
reads it and writes the DB session variable that RLS policies consult.
Forgetting the second step makes RLS fail-closed (SQLSTATE 42501).

## Operational notes

- **All RLS-bound queries must run inside a transaction.** The DB session
  binding is `set_config(..., true)` (transaction-scoped). Outside a
  transaction the binding evaporates and RLS reads fail closed.
- **Per-tenant CMEK is a Phase 1 stub.** `@cortex/secrets.getKeyForTenant`
  returns the env-level `cortex-general-key` regardless of tenant. F02
  populates `tenant_kms_key` and swaps the resolver in Phase 2+.
- **Audit chain integrity is enforced by triggers, not application code.**
  The `audit_chain_trigger` (BEFORE INSERT) auto-fills `prev_hash` /
  `curr_hash`. UPDATE/DELETE on `audit_event` raise SQLSTATE 2F002 —
  audit rows are immutable once written.
- **F02 owns lifecycle workflows.** `tenants.terminate` /
  `tenants.suspend` are NOT exposed here — those imply de-provisioning
  (Cloud SQL teardown, GCS, K8s namespaces). F02 will compose around
  `tenants.setStatus`.
- **No package-layer authorization yet.** Anything that imports
  `@cortex/tenant-context` can call any method. AC01 will layer authz —
  see future-roadmap §10.12.

## References

- F01 build prompt P1.1 (Slice A scope: tenant-context propagation +
  control-plane tables + RLS templates + tenant CRUD + audit emission).
- ADR-DB-002 (RLS posture, `cortex.current_tenant_id()` fail-closed
  reader).
- ADR-DB-003 (audit-event SHA chain, append-only enforcement).
- migration 0004 (`audit_event` + chain trigger).
- migration 0006 (ms-precision `now()` invariant).
- migration 0007 (control-plane tables: `tenant`,
  `tenant_config_version`, `tenant_quota_usage`, `tenant_kms_key`).
- future-roadmap.md §10.11 (HTTP framework choice), §10.12 (CRUD authz),
  §10.13 (cursor pagination), §10.14 (`external_id` format policy).
