import { sql } from 'drizzle-orm';
import { customType } from 'drizzle-orm/pg-core';
import { parseTstzRange, serializeTstzRange, type TstzRange } from '../temporal.js';

/**
 * Drizzle column type for Postgres `tstzrange` (ADR-DB-001 §1).
 */
export const tstzrange = customType<{ data: TstzRange; driverData: string }>({
  dataType() {
    return 'tstzrange';
  },
  fromDriver(value: string): TstzRange {
    return parseTstzRange(value);
  },
  toDriver(value: TstzRange): string {
    return serializeTstzRange(value);
  },
});

/**
 * Bi-temporal column set per ADR-DB-001. Spread into any pgTable definition.
 *
 *   export const tenants = pgTable("tenants", {
 *     ...biTemporalColumns,
 *     tenant_id: uuid("tenant_id").notNull(),
 *     business_key: text("business_key").notNull(),
 *   });
 */
export const biTemporalColumns = {
  valid_time: tstzrange('valid_time').notNull(),
  txn_time: tstzrange('txn_time')
    .notNull()
    .default(sql`tstzrange(now(), NULL)`),
} as const;
