/**
 * Legal-hold helpers per F02 Slice C convention §6.3.
 *
 * Two operations:
 *
 *   - `legalHolds.set(db, tenantId, options, ctx)` — place a hold on a
 *     tenant scope (`tenant` | `record` | `data_class`). Persists to
 *     the `legal_hold` table (migration 0011) and emits a
 *     `LEGAL_HOLD_SET` audit event.
 *   - `legalHolds.release(db, tenantId, holdId, options, ctx)` — release
 *     an existing hold. Sets `released_at` + `released_by_user_id`; the
 *     row is preserved as a historical record (compliance trail). Emits
 *     `LEGAL_HOLD_RELEASED` audit event.
 *
 * Phase 1 enforcement (per §6.3 dual-source):
 *
 *   - `scope='tenant'` blocks `tenants.terminate` (alongside the
 *     `tenant.legal_hold` boolean fast path from migration 0010).
 *   - `scope='record'` and `scope='data_class'` are stored but not yet
 *     enforced — Phase 2+ application code (e.g., `records.delete`
 *     RPCs) will consume these scopes when those modules ship.
 *
 * Idempotency:
 *
 *   - `set` is NOT idempotent — every call inserts a new row. Multiple
 *     active holds for the same scope/target are valid; each must be
 *     released independently.
 *   - `release` IS idempotent — re-call on an already-released hold
 *     returns the row without re-emitting audit. Audit emission fires
 *     once per release event.
 *
 * RLS contract: `legal_hold` is RLS-enabled (FOR ALL with
 * `tenant_id = cortex.current_tenant_id()`). Both functions bind
 * `app.tenant_id` to the target tenant before any read/write. Callers
 * supply `tenantId` explicitly even for `release` (the row's tenant_id
 * isn't readable without the bind already in place — chicken-and-egg).
 */

import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { legalHold, tenant, type LegalHold } from '@cortex/canonical-schema';
import { getActionByName } from '@cortex/audit-events';
import { TENANT_AUDIT_ACTIONS } from './audit-actions.js';
import { emitAuditEvent } from './audit.js';
import { bindTenantToDbSession } from './db-session.js';
import { TenantNotFoundError, TenantValidationError } from './errors.js';
import type { Actor } from './tenants.js';

// ─────────────────────────────────────────────────────────────────────
// Validation schemas (inline to avoid cross-module schema sharing)
// ─────────────────────────────────────────────────────────────────────

const idSchema = z.string().uuid();

const actorSchema = z.object({
  type: z.enum(['service', 'user', 'system']),
  id: z.string().min(1).max(255),
  description: z.string().max(1024).optional(),
});

const setHoldOptionsSchema = z.discriminatedUnion('scope', [
  z.object({
    scope: z.literal('tenant'),
    reason: z.string().min(1).max(1000),
    setByUserId: z.string().min(1).max(255),
  }),
  z.object({
    scope: z.literal('record'),
    recordId: z.string().uuid(),
    reason: z.string().min(1).max(1000),
    setByUserId: z.string().min(1).max(255),
  }),
  z.object({
    scope: z.literal('data_class'),
    dataClass: z.string().min(1).max(255),
    reason: z.string().min(1).max(1000),
    setByUserId: z.string().min(1).max(255),
  }),
]);

export type SetHoldOptions = z.infer<typeof setHoldOptionsSchema>;

const releaseHoldOptionsSchema = z.object({
  releasedByUserId: z.string().min(1).max(255),
  releaseReason: z.string().min(1).max(1000).optional(),
});

export type ReleaseHoldOptions = z.infer<typeof releaseHoldOptionsSchema>;

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new TenantValidationError(`${label}: ${result.error.message}`, { cause: result.error });
  }
  return result.data;
}

const msNow = sql`date_trunc('millisecond', now())`;

// ─────────────────────────────────────────────────────────────────────
// set
// ─────────────────────────────────────────────────────────────────────

/**
 * Place a legal hold on a tenant scope.
 *
 * @throws TenantValidationError invalid id, options, or actor.
 * @throws TenantNotFoundError tenant doesn't exist OR is TERMINATED
 *   (can't put a hold on a tombstone).
 */
async function set(
  db: NodePgDatabase<Record<string, never>>,
  tenantId: string,
  options: SetHoldOptions,
  ctx: { actor: Actor },
): Promise<LegalHold> {
  const parsedId = parseOrThrow(idSchema, tenantId, 'legalHolds.set tenantId');
  const parsedOptions = parseOrThrow(setHoldOptionsSchema, options, 'legalHolds.set options');
  const parsedActor = parseOrThrow(actorSchema, ctx.actor, 'legalHolds.set actor');

  return db.transaction(async (tx) => {
    // Verify tenant exists and is not TERMINATED. tenant has no RLS;
    // direct SELECT works without bind.
    const tenantRows = await tx.select().from(tenant).where(eq(tenant.id, parsedId)).limit(1);
    const tenantRow = tenantRows[0];
    if (tenantRow === undefined || tenantRow.status === 'TERMINATED') {
      throw new TenantNotFoundError(parsedId, 'id');
    }

    // Bind for the legal_hold INSERT (RLS WITH CHECK).
    await bindTenantToDbSession(tx, parsedId);

    // Build scope-discriminated row. Drizzle's typed legalHold accepts
    // null for record_id / data_class; the SQL CHECK constraints
    // (migration 0011) enforce scope ↔ field consistency.
    const insertRow = await tx
      .insert(legalHold)
      .values({
        tenant_id: parsedId,
        scope: parsedOptions.scope,
        reason: parsedOptions.reason,
        set_by_user_id: parsedOptions.setByUserId,
        record_id: parsedOptions.scope === 'record' ? parsedOptions.recordId : null,
        data_class: parsedOptions.scope === 'data_class' ? parsedOptions.dataClass : null,
      })
      .returning();
    const row = insertRow[0];
    if (row === undefined) {
      throw new Error('legalHolds.set: INSERT returned no row');
    }

    await emitAuditEvent(tx, {
      tenantId: parsedId,
      actorType: parsedActor.type,
      actorId: parsedActor.id,
      ...(parsedActor.description !== undefined && { actorDescription: parsedActor.description }),
      action: getActionByName(TENANT_AUDIT_ACTIONS, 'LEGAL_HOLD_SET'),
      verb: 'CREATE',
      resource: `legal_hold:${row.id}`,
      after_state: {
        scope: row.scope,
        reason: row.reason,
        set_by_user_id: row.set_by_user_id,
        ...(row.record_id !== null && { record_id: row.record_id }),
        ...(row.data_class !== null && { data_class: row.data_class }),
      },
    });

    return row;
  });
}

// ─────────────────────────────────────────────────────────────────────
// release
// ─────────────────────────────────────────────────────────────────────

/**
 * Release an existing legal hold. Sets `released_at` + `released_by_user_id`;
 * the row is preserved as a historical record.
 *
 * Idempotent: re-call on an already-released hold returns the row
 * without re-emitting audit.
 *
 * @throws TenantValidationError invalid id, holdId, options, or actor.
 * @throws TenantNotFoundError hold not found for the given (tenantId, holdId).
 */
async function release(
  db: NodePgDatabase<Record<string, never>>,
  tenantId: string,
  holdId: string,
  options: ReleaseHoldOptions,
  ctx: { actor: Actor },
): Promise<LegalHold> {
  const parsedTenantId = parseOrThrow(idSchema, tenantId, 'legalHolds.release tenantId');
  const parsedHoldId = parseOrThrow(idSchema, holdId, 'legalHolds.release holdId');
  const parsedOptions = parseOrThrow(
    releaseHoldOptionsSchema,
    options,
    'legalHolds.release options',
  );
  const parsedActor = parseOrThrow(actorSchema, ctx.actor, 'legalHolds.release actor');

  return db.transaction(async (tx) => {
    await bindTenantToDbSession(tx, parsedTenantId);

    // Lock the hold row for the read+update sequence. eq on both
    // tenant_id and id defends against caller passing a holdId that
    // doesn't belong to tenantId.
    const currentRows = await tx
      .select()
      .from(legalHold)
      .where(eq(legalHold.id, parsedHoldId))
      .for('update')
      .limit(1);
    const current = currentRows[0];
    if (current?.tenant_id !== parsedTenantId) {
      throw new TenantNotFoundError(parsedHoldId, 'id');
    }

    // Idempotent fast-path: already released — return as-is, no audit.
    if (current.released_at !== null) {
      return current;
    }

    const updated = await tx
      .update(legalHold)
      .set({
        released_at: msNow,
        released_by_user_id: parsedOptions.releasedByUserId,
      })
      .where(eq(legalHold.id, parsedHoldId))
      .returning();
    const next = updated[0];
    if (next === undefined) {
      throw new Error('legalHolds.release: UPDATE returned no row');
    }

    await emitAuditEvent(tx, {
      tenantId: parsedTenantId,
      actorType: parsedActor.type,
      actorId: parsedActor.id,
      ...(parsedActor.description !== undefined && { actorDescription: parsedActor.description }),
      action: getActionByName(TENANT_AUDIT_ACTIONS, 'LEGAL_HOLD_RELEASED'),
      verb: 'DELETE',
      resource: `legal_hold:${parsedHoldId}`,
      before_state: {
        scope: current.scope,
        reason: current.reason,
        set_by_user_id: current.set_by_user_id,
        set_at: current.set_at.toISOString(),
        ...(current.record_id !== null && { record_id: current.record_id }),
        ...(current.data_class !== null && { data_class: current.data_class }),
      },
      payload: {
        released_by_user_id: parsedOptions.releasedByUserId,
        ...(parsedOptions.releaseReason !== undefined && {
          release_reason: parsedOptions.releaseReason,
        }),
      },
    });

    return next;
  });
}

export const legalHolds = {
  set,
  release,
};
