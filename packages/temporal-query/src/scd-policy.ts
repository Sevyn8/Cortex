/**
 * F03 Slice C — SCD policy schema + namespace registration.
 *
 * Per Q-NEW-F03C-2 lock (Slice C HOLD #1): the SCD policy lives in
 * the F04 namespace `tenant.scd` (per-tenant; no `platform.scd`
 * because F04's substrate is per-tenant only — D14 ships
 * platform → tenant resolution but both tiers are per-tenant rows).
 * The trigger's hardcoded Type-2 fallback IS the cross-tenant default
 * (Q-NEW-F03C-4).
 *
 * Per Q-NEW-F03C-5: the schema lives in this package (`@cortex/
 * temporal-query`) — F03's policy schemas in F03's package.
 * Importing `@cortex/temporal-query` triggers the registration as a
 * top-level side effect (same pattern as `@cortex/config-plane`'s
 * `audit-actions.ts` and `@cortex/tenant-context`'s catalog).
 *
 * Per Q-NEW-F03C-7: Types 3/4/6 schema fields are MINIMAL placeholders
 * at C.1 — `previousValueColumn`, `historyTableName`, `columnTypes`
 * are accepted as optional strings/records so Zod parses succeed for
 * all 5 type values. Real schema-design lock comes at HOLD #2 (between
 * C.2 trigger rewrite and C.3 per-type tests).
 *
 * Forward-compat note (recorded in C.5 scope-doc): if future F04
 * substrate work adds NULL-`tenant_id` support OR a separate
 * `platform_config` table + RLS carve-out, the trigger's hardcoded
 * Type-2 fallback can be replaced with a DB-driven default read from
 * the new substrate. Slice C's trigger keeps the default-path
 * isolated and replaceable for that future work.
 *
 * Per F03 ADR-DB-001 + 0002 trigger: SCD Types are a domain concept;
 * Type 2 is the only one currently implemented in the trigger
 * function. Slice C extends the trigger to dispatch by type.
 */

import { z } from 'zod';
import { registerNamespaceSchema } from '@cortex/config-plane';

/**
 * Type 1 — overwrite. UPDATE replaces the row in place; no history
 * preserved. SCD spec: "Original row is overwritten; previous values
 * lost." For low-history-value attributes (e.g., a typo correction
 * that doesn't need an audit trail).
 */
const Type1Schema = z.object({
  type: z.literal(1),
});

/**
 * Type 2 — new row per change. The current default in
 * `cortex.cortex_scd_trigger()`. Closes the OLD row's `txn_time`,
 * inserts a NEW row with the new state. Preserves full history.
 * SCD spec: "Add new row; original row preserved with end-date."
 */
const Type2Schema = z.object({
  type: z.literal(2),
});

/**
 * Snake_case column-identifier regex matching the validateIdentifier
 * convention used by `@cortex/temporal-query/_internals`. ≤63 chars,
 * lowercase first letter, then [a-z0-9_]. SQL-safe; same shape used
 * for table-name + column-name validation.
 */
const COLUMN_NAME_REGEX = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * Type 3 — previous value in column. UPDATE replaces row in place
 * BUT captures the previous value in a sibling column.
 *
 * Per Q-NEW-F03C-7a HOLD #2 lock: single `previousValueColumn`
 * (canonical SCD Type 3). Multi-column previous-value-only is a
 * hypothetical future Type 7 — flagged in scope doc as future-note
 * for first-consumer-driven refinement.
 *
 * Trigger semantics: caller's UPDATE proceeds in-place. OLD's value
 * of `previousValueColumn` is captured to sibling column
 * `<previousValueColumn>_previous`. The sibling column DDL is the
 * consumer's responsibility — trigger raises if the sibling column
 * is missing on the table. DELETE is physical (Type 3 isn't
 * history-preserving for deletes).
 */
const Type3Schema = z.object({
  type: z.literal(3),
  previousValueColumn: z.string().regex(COLUMN_NAME_REGEX),
});

/**
 * Type 4 — separate history table. UPDATE replaces row in place;
 * a copy of the OLD row is appended to a sibling history table.
 *
 * Per Q-NEW-F03C-7b HOLD #2 lock: caller's migration creates the
 * history table before promoting the Type 4 policy. Trigger raises
 * a clean error on first UPDATE/DELETE if the history table is
 * missing. Future enhancement (out of Slice C scope; tracked in
 * scope doc): F04 validateDraft hook to check
 * `information_schema.tables` at promote-time.
 *
 * `historyTableName` defaults to `<tableName>_history` in the same
 * schema as the source table. Optional override only when caller
 * needs a non-default name.
 */
const Type4Schema = z.object({
  type: z.literal(4),
  historyTableName: z.string().regex(COLUMN_NAME_REGEX).optional(),
});

/**
 * Type 6 — hybrid. Per Q-NEW-F03C-7c HOLD #2 lock: canonical Type 2
 * + Type 3 hybrid. Row-versioning preserved (Type 2 row rotation);
 * PLUS per-column previous-value capture on the NEW row for columns
 * listed in `previousValueColumns`. The literal "per-column type
 * specification" interpretation was rejected at HOLD #2 — Type 1
 * (in-place) and Type 2 (row-rotation) are mutually exclusive at
 * the row level.
 *
 * Trigger semantics: same as Type 2 (close OLD; INSERT NEW with
 * rotated id; cancel caller's UPDATE) PLUS NEW captures
 * `<col>_previous = OLD.<col>` for each col in
 * `previousValueColumns`. Sibling `<col>_previous` columns DDL is
 * consumer's responsibility (same as Type 3). DELETE: Type 2
 * logical close.
 */
const Type6Schema = z.object({
  type: z.literal(6),
  previousValueColumns: z.array(z.string().regex(COLUMN_NAME_REGEX)),
});

/**
 * SCD policy for a single entity type (table). Discriminated on
 * `type`. Used as the value side of `SCDPolicySchema` below.
 */
export const SCDEntityPolicySchema = z.discriminatedUnion('type', [
  Type1Schema,
  Type2Schema,
  Type3Schema,
  Type4Schema,
  Type6Schema,
]);

/**
 * Full SCD policy namespace shape — a record from entity-type
 * identifier (snake_case table name) to its SCD policy. Stored in
 * F04's `tenant_config_version.config_json` at namespace
 * `'tenant.scd'`.
 *
 * Example:
 *   {
 *     "retail_product": { "type": 2 },
 *     "customer_address": { "type": 3, "previousValueColumn": "old_zip" }
 *   }
 *
 * Tenants without a `tenant.scd` row → trigger falls back to Type 2
 * for all entity types (Q-NEW-F03C-4 mandatory backward compat).
 */
export const SCDPolicySchema = z.record(z.string(), SCDEntityPolicySchema);

export type SCDPolicy = z.infer<typeof SCDPolicySchema>;
export type SCDEntityPolicy = z.infer<typeof SCDEntityPolicySchema>;

/**
 * The F04 namespace SCD policies live in. Per Q-NEW-F03C-2 lock.
 */
export const SCD_POLICY_NAMESPACE = 'tenant.scd' as const;

/**
 * The schema_version pinned at C.1. Bumps when Types 3/4/6 schemas
 * are finalized at HOLD #2 (if shape changes are breaking) — bump
 * here, register a new version, leave v=1 callers validating
 * against v=1 per F04 D12.
 */
export const SCD_POLICY_SCHEMA_VERSION = 1 as const;

// Top-level side effect: register the schema with F04's registry.
// Same pattern as `@cortex/config-plane/src/audit-actions.ts`. Tests
// that call `resetSchemaRegistry()` lose this registration and must
// re-register manually (rare; only schema-registry tests do this).
registerNamespaceSchema(SCD_POLICY_NAMESPACE, SCDPolicySchema, {
  version: SCD_POLICY_SCHEMA_VERSION,
});
