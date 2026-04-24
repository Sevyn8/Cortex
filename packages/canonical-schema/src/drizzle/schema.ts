// Canonical Drizzle schema — the `schema:` pointer for drizzle.config.ts.
// Migrations remain raw-SQL in services/foundation/migrations/ per CLAUDE.md;
// this file is for app-side typed queries only (not the migration source of
// truth). Add pgTable entries here when new cross-cutting tables land.

import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
