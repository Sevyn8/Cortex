# ADR-DB-002: Row-Level Security Session-Variable Contract

**Status:** Accepted
**Date:** April 2026
**Deciders:** Neerj (Sevyn8 engineering)
**Context documents:** Cortex v2.2 Spec §F01 §1.2 Tenant Isolation, §F01 §1.3 RBAC/ABAC context; P0.4 build prompt (v3.1)
**Companion decisions:** ADR-INFRA-005 (Cloud SQL posture), ADR-DB-001 (bi-temporal), ADR-DB-003 (audit SHA chain)

---

## Context

Every tenant-scoped Cortex table carries a `tenant_id` column; F01 requires the database to reject cross-tenant reads and writes at the boundary, not rely on the application layer to always remember a `WHERE tenant_id = ?` clause. PostgreSQL's Row-Level Security (RLS) is the enforcement mechanism.

RLS policies reference a tenant identifier at query time. There are two widely-used patterns:

- **Query parameter.** Every SELECT/UPDATE/DELETE explicitly supplies the tenant id; policies compare against the parameter.
- **Session variable.** The caller sets a `tenant_id` on the connection/transaction once; policies compare against `current_setting('...')`.

F01 middleware (not yet built — P1.1) will inject tenant context into every request. Phase B locks in the **contract** that middleware will satisfy, and the database-side enforcement that makes the contract non-negotiable. Phase B also ships test helpers so services can exercise RLS paths before F01 middleware exists.

This ADR is deliberately narrow:

- It establishes the session-variable name, the fail-closed reader function, and the two policy templates.
- It **defers** admin-bypass. No `cortex_admin` role, no `BYPASSRLS`, no bypass policy template.
- It **omits** actor tracking at the session level. Actor identity flows through the audit path (ADR-DB-003) via the `audit_event.actor` column, not a database session variable.

## Decision

**One session variable (`app.tenant_id`, uuid), one fail-closed reader (`cortex.current_tenant_id()`), two policy templates (`tenant_read_policy`, `tenant_write_policy`), applied per-table by the owning migration.**

Specifically:

1. **Session variable: `app.tenant_id`.**
   - Qualified name (`app.` prefix) is required — PostgreSQL reserves unqualified names for its own configuration parameters and raises `unrecognized configuration parameter` on `current_setting('tenant_id', ...)` unless a matching custom GUC is registered at server startup. A qualified name works on any Postgres 17 instance with no server-side configuration.
   - Set by F01 middleware using `SET LOCAL app.tenant_id = '<uuid>';` inside the request transaction. **Never `SET SESSION`** — session-scoped vars leak across pooled connections.
   - Only `app.tenant_id` is defined in Phase B. No `app.actor_id`, no `app.role`, no other session vars. Actor tracking is the audit layer's concern (ADR-DB-003).

2. **Reader function: `cortex.current_tenant_id() RETURNS uuid`.**
   - Reads `current_setting('app.tenant_id', true)` (the `true` is `missing_ok`; returns `NULL` instead of raising if the GUC is unset).
   - **Fail-closed:** if the result is `NULL` or empty string, raises `insufficient_privilege` (SQLSTATE `42501`) with message `cortex.current_tenant_id: app.tenant_id is not set; refusing to evaluate tenant-scoped policy`.
   - Otherwise casts to `uuid` and returns. Invalid uuid format surfaces as Postgres's built-in cast error (`22P02`), which is also fail-closed — the query aborts rather than evaluating policy against a garbage tenant id.
   - `STABLE PARALLEL SAFE`. Not `IMMUTABLE` — value depends on session state.

3. **Two policy templates, applied per-table by the table's owning migration.**

   ```sql
   ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;

   CREATE POLICY tenant_read_policy ON <t>
     FOR SELECT TO public
     USING (tenant_id = cortex.current_tenant_id());

   CREATE POLICY tenant_write_policy ON <t>
     FOR ALL TO public
     USING (tenant_id = cortex.current_tenant_id())
     WITH CHECK (tenant_id = cortex.current_tenant_id());
   ```

   - `tenant_read_policy` — SELECT only, USING clause filters visible rows.
   - `tenant_write_policy` — FOR ALL with both USING and WITH CHECK, covers INSERT / UPDATE / DELETE. The USING predicate also participates in SELECT, but since both policies evaluate the same expression, the OR'd result is unchanged.
   - The two-policy split (rather than a single `FOR ALL` policy) exists so a future admin-bypass can override read semantics without loosening write semantics — it adds forward-compat with zero runtime cost.
   - The 0003 migration creates `cortex.current_tenant_id()` and embeds this template as a SQL comment block. It does **not** apply policies to any table — that happens per-table in D01 / module migrations when tenant-scoped tables land.

4. **Admin-bypass deferred.**
   - No `cortex_admin` role in Phase B.
   - No `BYPASSRLS` on any Postgres role in Phase B.
   - No bypass policy template.
   - Trigger to revisit: the first service that genuinely needs cross-tenant reads — expected to be SCR-20 (audit log browsing for platform admins). When that arrives, extend this ADR (or supersede it) with the bypass mechanism. Candidate shapes: (a) a dedicated Postgres role with `BYPASSRLS` used only by the audit service; (b) an additional policy `admin_read_policy FOR SELECT TO cortex_admin USING (true)` alongside a role check in `cortex.current_tenant_id()` that short-circuits for bypass-eligible roles. Picking between (a) and (b) is SCR-20's call, not Phase B's.

5. **Test helpers in `@cortex/canonical-schema`.**
   - `packages/canonical-schema/src/rls-test.ts` exports two helpers used by every service's RLS acceptance tests:

     ```ts
     // Opens a transaction on `db`, issues SET LOCAL app.tenant_id, runs fn, commits.
     withTenantContext<T>(db: Pg.Client, tenantId: string, fn: (tx) => Promise<T>): Promise<T>;

     // Opens a transaction on `db` with no tenant context set, runs fn. Used to verify
     // that current_tenant_id() fail-closed raises on unset context.
     withoutTenantContext<T>(db: Pg.Client, fn: (tx) => Promise<T>): Promise<T>;
     ```

   - Pattern matches how F01 middleware will behave in production — `SET LOCAL` inside a transaction — so tests exercise the same code path as live requests.
   - No `withAdminContext` in Phase B. Adding it when admin-bypass lands is an additive change to this file.

## Rationale

- **Session variable over query parameter.** A query-parameter policy would require every service, every query, every ad-hoc psql session to remember a `WHERE tenant_id = $N` clause, and would make ORM-generated queries awkward. Session vars let the middleware enforce tenant context once per request; services write tenant-naïve SQL and the database enforces isolation. Defense-in-depth: forgetting the `WHERE` clause is a policy violation, not a silent data leak.
- **Fail-closed on unset tenant.** An RLS policy that returns no rows when `current_setting('app.tenant_id', true)` is NULL is superficially safe — the query returns zero rows, no cross-tenant leak. But silent empty results are the worst kind of RLS failure: they look like "this tenant has no data" and propagate through the stack as false negatives. Raising at the database makes the missing-context bug loud and immediate. A misconfigured service fails the request, not the isolation guarantee.
- **Qualified name `app.tenant_id`.** Unqualified names (`tenant_id`) are reserved for Postgres's own config. `current_setting('tenant_id', ...)` raises on an unconfigured server. `app.` is the conventional namespace for application-defined GUCs and requires zero server-side configuration.
- **Two policies instead of one.** A single `FOR ALL USING(...) WITH CHECK(...)` policy is equivalent at Phase B's level of strictness. Splitting into read and write policies gives us a clean seam to add admin-read-bypass later without touching write semantics. Zero runtime cost — the planner sees the same expressions either way.
- **`SET LOCAL` over `SET SESSION`.** Cloud SQL connection-pooler modes (pgbouncer transaction-pooling, or a client-side pool) recycle connections across requests. A session-scoped GUC set by request A leaks into request B. `SET LOCAL` is transaction-scoped and expires at COMMIT/ROLLBACK.
- **Actor tracking off the session.** A session variable for actor identity would be tempting (every service sets `app.actor_id` alongside `app.tenant_id`). We don't: (a) actor identity is audit's concern, not isolation's; (b) the audit path (ADR-DB-003) explicitly includes an `actor` column, making session-level actor redundant; (c) fewer session vars = simpler middleware contract.

## Consequences

### Positive

- Tenant isolation is enforced at the database boundary — application-layer bugs cannot exfiltrate cross-tenant data.
- Middleware contract is minimal: `SET LOCAL app.tenant_id` inside the request transaction, nothing else.
- Per-table policies are two copy-paste SQL statements; zero bespoke logic per table.
- Services can test RLS paths today via the test helpers, before F01 middleware exists.

### Negative

- Requires transaction-pooled connection discipline (`SET LOCAL`, not `SET SESSION`). Misconfigured pools that use session pooling would leak context across requests — caught by tests (see `withoutTenantContext` pattern), but a real operational constraint.
- Admin-bypass deferral means services that genuinely need cross-tenant access must wait (or accept that they run in a temporarily-missing RLS context — not recommended). SCR-20 will need to address this.
- Tables without `tenant_id` (e.g., global reference data, audit chain itself has tenant_id but the chain verification logic needs cross-tenant read) must either (a) not enable RLS, or (b) carry explicit policies that override the template. Both paths are individually ADR-worthy when they arrive.

### Neutral

- `current_tenant_id()` is `STABLE PARALLEL SAFE` — the planner can evaluate it once per query, not once per row. RLS predicates get that optimization for free.

## Alternatives considered

1. **Query parameter (`WHERE tenant_id = $1`).** Rejected — defense in depth requires the DB to enforce, not the caller. Every ORM-generated query would have to carry the parameter; the first forgotten case is a cross-tenant leak.
2. **Separate database schema per tenant.** Rejected — incompatible with F02 dynamic tenant provisioning (creating a schema on every signup), breaks shared query plans, operationally expensive at scale.
3. **Separate Postgres role per tenant (rely on `OWNER` + `REVOKE`).** Rejected — Postgres role count is capped; tenant count is not.
4. **Session-scoped GUC (`SET` not `SET LOCAL`).** Rejected — leaks across pooled connections.
5. **Unqualified GUC name (`tenant_id`).** Rejected — requires server-side `custom_variable_classes` configuration; doesn't exist on Cloud SQL without support ticket.
6. **Silent-empty-result on missing tenant context.** Rejected — invisible failure mode; misconfigured middleware would look like "empty tenant" in prod.
7. **Session variable for actor (`app.actor_id`) alongside `app.tenant_id`.** Rejected — not needed for isolation; duplicates audit's `actor` column (ADR-DB-003).
8. **Ship admin-bypass in Phase B.** Rejected — premature. No Phase B consumer needs it; adding `BYPASSRLS` to any role now is a security surface without a driving use case. SCR-20 is the natural trigger.

## Implementation notes

- `cortex.current_tenant_id()` uses `current_setting(..., true)` pattern — the `missing_ok` form returns NULL on unset GUC rather than raising. The raise-on-NULL check is our responsibility and is explicit.
- Empty-string check (`WHEN '' THEN RAISE`) matters because `SET LOCAL app.tenant_id = '';` is a no-op in some drivers but leaves the GUC readable as `''`. Both NULL and empty-string are fail-closed paths.
- The `SQLSTATE 42501` (`insufficient_privilege`) error code is chosen so services can detect "RLS context missing" specifically and return a 500 with a clear internal error, not a 403 that might confuse downstream consumers.
- Phase B acceptance test (`services/foundation/test/rls.spec.ts`):
  1. Create a tiny temp table with `tenant_id` + tenant_read_policy + tenant_write_policy.
  2. `withTenantContext(db, tenantA, tx => tx.query('INSERT ... tenant_id = tenantA'))` — writes a row.
  3. `withTenantContext(db, tenantA, tx => tx.query('SELECT ...'))` — returns the row.
  4. `withTenantContext(db, tenantB, tx => tx.query('SELECT ...'))` — returns zero rows.
  5. `withoutTenantContext(db, tx => tx.query('SELECT ...'))` — raises SQLSTATE 42501.
- F01 middleware contract (to be honored when P1.1 lands): at the start of every request's transaction, before any query runs, set `app.tenant_id` via `SELECT set_config('app.tenant_id', $1, true)` where `$1` is the UUID resolved from the request's authenticated principal. No fallback to a "default tenant" — missing tenant = 500, not implicit scoping. (Note: `SET LOCAL app.tenant_id = $1` is NOT valid Postgres; see the observation below.)

### Observation — `SET LOCAL` does not accept bind parameters (P0.4 Phase B discovery)

Postgres `SET` and `SET LOCAL` commands reject parameterized values at the parser level. `SET LOCAL app.tenant_id = $1` raises SQLSTATE `42601` (`syntax_error`) because the `SET` grammar treats `$1` as a literal identifier, not a bind marker.

The initial `withTenantContext` helper in `@cortex/canonical-schema/rls-test` used this pattern; the bug was latent until the RLS acceptance tests first exercised the helper against real Postgres. Symptom: `syntax error at or near "$1"` with `DatabaseError.code = 42601` and the helper's SQL string in the stack trace.

**Fix:** use the functional form `SELECT set_config(name, value, is_local=true)`. Semantics are identical to `SET LOCAL`; the function-call path accepts `$1` because it's a normal query, not a `SET` command.

```sql
-- Broken (raises 42601):
SET LOCAL app.tenant_id = $1;

-- Works:
SELECT set_config('app.tenant_id', $1, true);
```

Cross-ref: CLAUDE.md "Database conventions" → "Session variables".

## References

- Cortex v2.2 Spec §F01 §1.2 Tenant Isolation — database-layer enforcement requirement.
- Cortex v2.2 Spec §F01 §1.3 RBAC/ABAC context — upstream of F01 middleware.
- PostgreSQL docs, Row Security Policies — https://www.postgresql.org/docs/17/ddl-rowsecurity.html
- PostgreSQL docs, `current_setting` and GUCs — https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADMIN-SET
- ADR-DB-001 — bi-temporal model (independent of RLS; trigger runs before RLS evaluation).
- ADR-DB-003 — audit SHA chain (actor column, the reason there's no `app.actor_id`).
