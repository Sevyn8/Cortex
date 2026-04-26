// Canonical Drizzle schema — the `schema:` pointer for drizzle.config.ts.
// Migrations remain raw-SQL in services/foundation/migrations/ per CLAUDE.md;
// this file is for app-side typed queries only (not the migration source of
// truth). Add pgTable entries here when new cross-cutting tables land.

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// ─────────────────────────────────────────────────────────────────────
// Shared default expression — matches the temporal-quantum invariant
// established by migration 0006 (SCD trigger) + 0007 (control plane).
// ─────────────────────────────────────────────────────────────────────

const msNow = sql`date_trunc('millisecond', now())`;

// ─────────────────────────────────────────────────────────────────────
// Custom type — bytea ↔ Buffer for hash columns on `audit_event`.
// ─────────────────────────────────────────────────────────────────────

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

// ─────────────────────────────────────────────────────────────────────
// Pre-AC01 super-admin placeholder (P0.9 / migration 0005)
// ─────────────────────────────────────────────────────────────────────

/**
 * Pre-AC01 super-admin placeholder. Populated by the P0.9 bootstrap script in
 * dev/staging (password_secret_ref points to a Secret Manager version name).
 * Prod rows come from the WorkOS path with password_secret_ref = NULL.
 *
 * See services/foundation/migrations/0005_bootstrap_admin.sql for the DDL
 * of record, including the CHECK constraint on promoted_to_users +
 * promoted_at consistency (enforced DB-side; not expressible via Drizzle
 * column API).
 */
export const bootstrapAdmin = pgTable('bootstrap_admin', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  password_secret_ref: text('password_secret_ref'),
  env_created_in: text('env_created_in', {
    enum: ['dev', 'staging', 'prod'],
  }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  promoted_to_users: boolean('promoted_to_users').notNull().default(false),
  promoted_at: timestamp('promoted_at', { withTimezone: true }),
});

export type BootstrapAdmin = typeof bootstrapAdmin.$inferSelect;
export type NewBootstrapAdmin = typeof bootstrapAdmin.$inferInsert;

// ─────────────────────────────────────────────────────────────────────
// F01 control plane tables (migration 0007)
//
// Tenant registry + per-tenant config / quota / KMS-binding tables.
// Migration 0007_control_plane_tables.sql is the DDL source of truth;
// this file mirrors the shape for app-side typed queries only. Per the
// bootstrapAdmin precedent, CHECK constraints (tier, status enums) live
// migration-side only — Drizzle uses `enum: [...]` shorthand for TS
// narrowing without duplicating the SQL CHECK definition here.
// ─────────────────────────────────────────────────────────────────────

/**
 * Primary tenant registry. Control plane — NOT RLS-protected. Phase 1 only
 * Standard tier path implemented; ENTERPRISE enum reserved for F02+. See
 * migration 0007 + future-roadmap.md §10.1 (resolved by 0007).
 */
export const tenant = pgTable('tenant', {
  id: uuid('id').primaryKey().defaultRandom(),
  external_id: text('external_id').notNull().unique(),
  display_name: text('display_name').notNull(),
  tier: text('tier', { enum: ['STANDARD', 'ENTERPRISE'] }).notNull(),
  status: text('status', {
    enum: ['PROVISIONING', 'ACTIVE', 'SUSPENDED', 'TERMINATED'],
  })
    .notNull()
    .default('PROVISIONING'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().default(msNow),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().default(msNow),
});

export type Tenant = typeof tenant.$inferSelect;
export type NewTenant = typeof tenant.$inferInsert;

/**
 * Per-tenant versioned configuration (F04 consumer). RLS enabled in 0007 —
 * reads/writes scoped by app.tenant_id. version_number is monotonic per
 * tenant. created_by_user_id NULL pre-AC01.
 */
export const tenantConfigVersion = pgTable(
  'tenant_config_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id, { onDelete: 'restrict' }),
    version_number: integer('version_number').notNull(),
    config_json: jsonb('config_json').notNull().$type<Record<string, unknown>>().default({}),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().default(msNow),
    created_by_user_id: uuid('created_by_user_id'),
  },
  (t) => ({
    tenantVersionUnique: unique('tenant_config_version_tenant_id_version_number_key').on(
      t.tenant_id,
      t.version_number,
    ),
  }),
);

export type TenantConfigVersion = typeof tenantConfigVersion.$inferSelect;
export type NewTenantConfigVersion = typeof tenantConfigVersion.$inferInsert;

/**
 * Quota counters per (tenant, resource_class, window_start). RLS enabled.
 * Slice A creates the substrate; enforcement (token bucket, 429-on-exceed)
 * lands in F01 Slice C. resource_class is free-form for now; Slice C may
 * constrain via CHECK or enum.
 */
// Convention note: this is the first table in the codebase with bigint
// columns. mode: 'bigint' returns native BigInt at the call site, allowing
// quota values to exceed JS Number.MAX_SAFE_INTEGER (2^53-1) — required
// for byte-storage classes. Future tables with counters guaranteed to stay
// under 2^53 (e.g., user counts) may use mode: 'number'; the choice is
// per-column, not codebase-wide. Consumer call sites pay the BigInt
// arithmetic ergonomics cost.
export const tenantQuotaUsage = pgTable(
  'tenant_quota_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id, { onDelete: 'restrict' }),
    resource_class: text('resource_class').notNull(),
    current_value: bigint('current_value', { mode: 'bigint' }).notNull().default(0n),
    quota_limit: bigint('quota_limit', { mode: 'bigint' }).notNull(),
    window_start: timestamp('window_start', { withTimezone: true }).notNull().default(msNow),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().default(msNow),
  },
  (t) => ({
    tenantResourceWindowUnique: unique(
      'tenant_quota_usage_tenant_id_resource_class_window_start_key',
    ).on(t.tenant_id, t.resource_class, t.window_start),
  }),
);

export type TenantQuotaUsage = typeof tenantQuotaUsage.$inferSelect;
export type NewTenantQuotaUsage = typeof tenantQuotaUsage.$inferInsert;

/**
 * Per-tenant CMEK binding. Phase 1: empty — getKeyForTenant() in
 * @cortex/secrets returns env-level cortex-general-key regardless of tenant
 * (per ADR-INFRA-004 §Decision 5). F02 populates this table + swaps the
 * resolver when per-tenant CMEK lands in Phase 2+. RLS enabled with
 * SELECT-only policy in 0007 (writes via privileged F02 lifecycle paths).
 * See future-roadmap.md §1.1, §7.1.
 */
export const tenantKmsKey = pgTable('tenant_kms_key', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: uuid('tenant_id')
    .notNull()
    .unique()
    .references(() => tenant.id, { onDelete: 'restrict' }),
  kms_key_resource_name: text('kms_key_resource_name').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().default(msNow),
  rotated_at: timestamp('rotated_at', { withTimezone: true }),
});

export type TenantKmsKey = typeof tenantKmsKey.$inferSelect;
export type NewTenantKmsKey = typeof tenantKmsKey.$inferInsert;

// ─────────────────────────────────────────────────────────────────────
// Audit substrate (migrations 0004 + 0008)
//
// Tamper-evident audit log per ADR-DB-003. Per-tenant SHA chain stamped
// by `cortex.audit_chain_trigger` (BEFORE INSERT); UPDATE/DELETE raise
// SQLSTATE 2F002. RLS enabled — reads/writes scoped by `app.tenant_id`.
//
// `actor_type` extends to `'agent'` per migration 0008 (P0.10 §Decision 6
// in the planning doc + ADR-AU-001).
//
// Caller contract for INSERT (the `@cortex/audit-events` library wraps
// this in the production path):
//   - Bind `app.tenant_id` to the DB session via `bindTenantToDbSession`
//     so the RLS write policy authorizes the INSERT.
//   - Insert inside an open transaction; the chain trigger reads the
//     prev_hash from the live tail under the same MVCC snapshot.
//   - Do NOT supply `prev_hash` / `curr_hash` — the trigger overwrites
//     caller-supplied values with the chain-derived ones.
//   - Do NOT supply `occurred_at` from a JS `Date` — the column is µs-
//     precision and `Date` round-trips truncate to ms, breaking the
//     hash. Either let the column default fire (`now()` server-side) or
//     pass an ISO-8601 µs string. See ADR-DB-003 §3 caller contract.
//
// Reading caveats:
//   - `occurred_at` is `timestamptz` with µs precision. The `pg` default
//     parser converts to JS `Date` (ms precision) — sufficient for
//     display, INSUFFICIENT for re-computing canonical hashes client-
//     side. Hash verification must be done server-side via
//     `cortex.audit_canonical_hash(...)`.
//   - `prev_hash` / `curr_hash` are `bytea` mapped to `Buffer`. Use
//     `buf.toString('hex')` for display; binary equality for chain
//     verification.
export const auditEvent = pgTable(
  'audit_event',
  {
    event_id: uuid('event_id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id').notNull(),
    actor_type: text('actor_type', {
      enum: ['service', 'user', 'system', 'agent'],
    }).notNull(),
    actor_id: text('actor_id').notNull(),
    actor_description: text('actor_description'),
    action: text('action').notNull(),
    resource: text('resource').notNull(),
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>().default({}),
    occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    prev_hash: bytea('prev_hash'),
    curr_hash: bytea('curr_hash').notNull(),
    inserted_at: timestamp('inserted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantTimeIdx: index('audit_event_tenant_time').on(
      t.tenant_id,
      t.occurred_at.desc(),
      t.event_id,
    ),
  }),
);

export type AuditEvent = typeof auditEvent.$inferSelect;
export type NewAuditEvent = typeof auditEvent.$inferInsert;
