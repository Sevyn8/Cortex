# @cortex/canonical-schema

Cross-cutting types and Drizzle helpers that cross Cortex service boundaries.

## Scope

**In:**

- `TstzRange` / `BiTemporalRow<T>` types and zod schemas (ADR-DB-001 §5)
- `tstzrange` Drizzle custom column type and `biTemporalColumns` spread helper
- `withTenantContext` / `withoutTenantContext` RLS test helpers (ADR-DB-002 §5)
- `createDrizzleClient` factory

**Out:**

- Per-service Drizzle schemas — live in `services/<svc>/src/schema/`
- Business logic
- Cross-service API contracts (those go in `@cortex/api-client`)

## Usage

### Bi-temporal table (per ADR-DB-001)

```ts
import { pgTable, uuid, text } from 'drizzle-orm/pg-core';
import { biTemporalColumns } from '@cortex/canonical-schema/drizzle';

export const tenants = pgTable('tenants', {
  tenant_id: uuid('tenant_id').notNull(),
  business_key: text('business_key').notNull(),
  ...biTemporalColumns,
});
```

Attach `cortex.cortex_scd_trigger` and the per-table GiST / exclusion
constraint in the migration — see ADR-DB-001 §4.

### RLS test (per ADR-DB-002)

```ts
import { withTenantContext } from '@cortex/canonical-schema/rls-test';

await withTenantContext(pool, tenantA, async (tx) => {
  await tx.query('INSERT INTO t (tenant_id, ...) VALUES ($1, ...)', [tenantA]);
});
```

## Subpath exports

- `@cortex/canonical-schema` — full barrel
- `@cortex/canonical-schema/temporal` — TstzRange, BiTemporalRow, parser/serializer
- `@cortex/canonical-schema/rls-test` — RLS test helpers
- `@cortex/canonical-schema/db-client` — createDrizzleClient
- `@cortex/canonical-schema/drizzle` — tstzrange column type, biTemporalColumns
