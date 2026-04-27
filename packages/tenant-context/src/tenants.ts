/**
 * Tenant registry CRUD for `@cortex/tenant-context`.
 *
 * Owns the `tenant` table (control-plane registry, no RLS) and emits the
 * lifecycle audit chain into `audit_event`. All mutating operations run
 * inside a single `db.transaction(...)` so the registry mutation and its
 * audit row commit (or roll back) atomically.
 *
 * Design notes:
 *
 * - **Control-plane operations.** The `tenant` table itself has no RLS
 *   (it IS the registry that maps `app.tenant_id` to a tenant — RLS would
 *   be circular). Reads run as plain SELECTs; mutations rebind the DB
 *   session to the affected tenant id mid-transaction so the audit row
 *   passes the RLS write policy on `audit_event`.
 *
 * - **Actor parameter.** Mutating methods take `ctx: { actor }` rather
 *   than reading the actor from the async-local context. Phase 1's
 *   `TenantContextSnapshot` only carries `tenantId`; AC01 will add a
 *   `userId` and a request-scoped `Actor` resolver. Until then, callers
 *   thread the actor through explicitly.
 *
 * - **Package boundary.** Registry CRUD lives here (F01). Lifecycle
 *   workflow (Cloud SQL provisioning, CMEK allocation, GCS, K8s) lives
 *   in F02 — `setStatus` here is a thin column update + audit; F02 will
 *   compose around it. `tenants.terminate` / `tenants.suspend` are
 *   intentionally NOT exposed; F02 will own those workflows and call
 *   `setStatus` as the final step.
 *
 * - **No async-local wrapping.** This module does not wrap operations in
 *   `withTenantContext` / `withoutTenantContext`. AsyncLocalStorage is
 *   the caller's concern; the package only manipulates the *DB session*
 *   variable that RLS reads.
 *
 * - **Authorization.** Phase 1 has no authz at this layer — anything
 *   that imports the package can call `tenants.list` etc. AC01 will
 *   layer authz; recorded as a deviation in F01 deviations + future-
 *   roadmap.md §10.
 */

import { count, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { tenant, tenantConfigVersion, type Tenant } from '@cortex/canonical-schema';
import { getActionByName } from '@cortex/audit-events';
import { buildKeyResourceName } from '@cortex/secrets';
import { TENANT_AUDIT_ACTIONS } from './audit-actions.js';
import { emitAuditEvent } from './audit.js';
import { bindTenantToDbSession } from './db-session.js';
import { TenantNotFoundError, TenantStatusError, TenantValidationError } from './errors.js';
import type { TenantStatus, TenantTier } from './types.js';

// `@cortex/secrets` is imported statically since roadmap §4.13 (resolved):
// observability no longer depends on `@cortex/tenant-context`, so the
// prior `observability → tenant-context → secrets → observability`
// triangle is gone at the package-graph layer.

// ─────────────────────────────────────────────────────────────────────
// Validation schemas
// ─────────────────────────────────────────────────────────────────────

const idSchema = z.string().uuid();

const externalIdSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'external_id must be lowercase slug');

const displayNameSchema = z.string().min(1).max(255);

const tierSchema = z.enum(['STANDARD', 'ENTERPRISE'] as const satisfies readonly TenantTier[]);

const statusSchema = z.enum([
  'PROVISIONING',
  'ACTIVE',
  'SUSPENDED',
  'TERMINATED',
] as const satisfies readonly TenantStatus[]);

const actorSchema = z.object({
  type: z.enum(['service', 'user', 'system']),
  id: z.string().min(1).max(255),
  description: z.string().max(1024).optional(),
});

const createInputSchema = z.object({
  externalId: externalIdSchema,
  displayName: displayNameSchema,
  tier: tierSchema,
  initialConfig: z.record(z.string(), z.unknown()).optional(),
});

const updateInputSchema = z
  .object({
    displayName: displayNameSchema.optional(),
  })
  .refine((p) => Object.values(p).some((v) => v !== undefined), {
    message: 'update patch must contain at least one field',
  });

const listOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).default(0),
  })
  .default({});

export type Actor = z.infer<typeof actorSchema>;
export type CreateTenantInput = z.infer<typeof createInputSchema>;
export type UpdateTenantPatch = z.infer<typeof updateInputSchema>;
export type ListTenantsOptions = z.input<typeof listOptionsSchema>;

export interface TenantListResult {
  items: Tenant[];
  total: number;
  limit: number;
  offset: number;
}

// ─────────────────────────────────────────────────────────────────────
// Status transition policy (Slice A — replaced by full F02 state machine)
// ─────────────────────────────────────────────────────────────────────

const ALLOWED_TRANSITIONS: ReadonlyMap<TenantStatus, readonly TenantStatus[]> = new Map([
  ['PROVISIONING', ['ACTIVE']],
  ['ACTIVE', ['SUSPENDED', 'TERMINATED']],
  ['SUSPENDED', ['ACTIVE', 'TERMINATED']],
  ['TERMINATED', []],
]);

function assertTransitionAllowed(
  tenantId: string,
  current: TenantStatus,
  next: TenantStatus,
): void {
  if (current === next) {
    throw new TenantStatusError(tenantId, current, ALLOWED_TRANSITIONS.get(current) ?? []);
  }
  const allowed = ALLOWED_TRANSITIONS.get(current) ?? [];
  if (!allowed.includes(next)) {
    throw new TenantStatusError(tenantId, current, allowed);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────

function parseOrThrow<TOutput, TInput>(
  schema: z.ZodType<TOutput, z.ZodTypeDef, TInput>,
  value: unknown,
  contextLabel: string,
): TOutput {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new TenantValidationError(`${contextLabel}: ${parsed.error.message}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

const msNow = sql`date_trunc('millisecond', now())`;

// ─────────────────────────────────────────────────────────────────────
// CRUD operations
// ─────────────────────────────────────────────────────────────────────

/**
 * Create a new tenant. The new row is inserted with status=PROVISIONING
 * (DB default). A `tenant_kms_key` substrate row is provisioned in the
 * same transaction per ADR-INFRA-007 Decision 1; its
 * `kms_key_resource_name` points at the env's `cortex-general-key` in
 * Phase 1 (F02 swaps to a real per-tenant key without changing envelope
 * format). If `initialConfig` is supplied, a v=1 row in
 * `tenant_config_version` is also inserted.
 *
 * Transaction sequence:
 *   1. INSERT into `tenant` (no RLS — control plane).
 *   2. Bind `app.tenant_id` to the new id (so RLS write policies on
 *      `audit_event` and `tenant_kms_key` pass).
 *   3. Emit `TENANT_CREATED` audit event (parent lifecycle event;
 *      `after_state` captures the tenant row pre-substrate-binding).
 *   4. INSERT into `tenant_kms_key` (resolves env's KMS key resource
 *      name via `buildKeyResourceName('cortex-general-key')`).
 *   5. Emit `TENANT_KMS_KEY_BOUND` audit event (sub-resource event,
 *      ordered AFTER `TENANT_CREATED` so audit-chain readers see the
 *      parent before the child substrate row).
 *   6. (optional) INSERT into `tenant_config_version` v=1.
 *   7. (optional) Emit `TENANT_CONFIG_VERSION_CREATED` audit event.
 *
 * RLS: this method does NOT require caller-side tenant context to be
 * set. It binds the DB session itself, mid-transaction.
 *
 * @throws TenantValidationError invalid input
 * @throws postgres unique-violation if `externalId` already exists
 *         (caller layer should map to a 409)
 */
async function create(
  db: NodePgDatabase<Record<string, never>>,
  input: CreateTenantInput,
  ctx: { actor: Actor },
): Promise<Tenant> {
  const parsedInput = parseOrThrow(createInputSchema, input, 'createTenant input');
  const parsedActor = parseOrThrow(actorSchema, ctx.actor, 'createTenant actor');

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(tenant)
      .values({
        external_id: parsedInput.externalId,
        display_name: parsedInput.displayName,
        tier: parsedInput.tier,
      })
      .returning();
    const row = inserted[0];
    if (row === undefined) {
      throw new Error('tenants.create: INSERT returned no row');
    }

    await bindTenantToDbSession(tx, row.id);

    await emitAuditEvent(tx, {
      tenantId: row.id,
      actorType: parsedActor.type,
      actorId: parsedActor.id,
      ...(parsedActor.description !== undefined && { actorDescription: parsedActor.description }),
      action: getActionByName(TENANT_AUDIT_ACTIONS, 'TENANT_CREATED'),
      verb: 'CREATE',
      resource: `tenant:${row.id}`,
      after_state: {
        external_id: row.external_id,
        display_name: row.display_name,
        tier: row.tier,
        status: row.status,
      },
    });

    // Provision tenant_kms_key row per ADR-INFRA-007 Decision 1.
    // Phase 1: kms_key_resource_name points at env's cortex-general-key.
    // F02 swaps to real per-tenant keys; envelope format unchanged.
    const kmsKeyResourceName = buildKeyResourceName('cortex-general-key');
    await tx.execute(sql`
      INSERT INTO tenant_kms_key (tenant_id, kms_key_resource_name)
      VALUES (${row.id}, ${kmsKeyResourceName})
    `);

    await emitAuditEvent(tx, {
      tenantId: row.id,
      actorType: parsedActor.type,
      actorId: parsedActor.id,
      ...(parsedActor.description !== undefined && { actorDescription: parsedActor.description }),
      action: getActionByName(TENANT_AUDIT_ACTIONS, 'TENANT_KMS_KEY_BOUND'),
      verb: 'CREATE',
      resource: `tenant_kms_key:${row.id}`,
      after_state: {
        kms_key_resource_name: kmsKeyResourceName,
      },
    });

    if (parsedInput.initialConfig !== undefined) {
      const configRows = await tx
        .insert(tenantConfigVersion)
        .values({
          tenant_id: row.id,
          version_number: 1,
          config_json: parsedInput.initialConfig,
        })
        .returning();
      const configVersionId = configRows[0]?.id;
      if (configVersionId !== undefined) {
        await emitAuditEvent(tx, {
          tenantId: row.id,
          actorType: parsedActor.type,
          actorId: parsedActor.id,
          ...(parsedActor.description !== undefined && {
            actorDescription: parsedActor.description,
          }),
          action: getActionByName(TENANT_AUDIT_ACTIONS, 'TENANT_CONFIG_VERSION_CREATED'),
          verb: 'CREATE',
          resource: `tenant_config_version:${configVersionId}`,
          // initialConfig comes through as `Record<string, unknown>` per the
          // input schema; the audit layer's zod re-validates JSON-safety at
          // parse time, so the cast is safe modulo runtime caller-honor.
          after_state: {
            version_number: 1,
            config: (parsedInput.initialConfig ?? {}) as Record<string, never>,
          },
        });
      }
    }

    return row;
  });
}

/**
 * Fetch a tenant by primary key.
 *
 * @throws TenantValidationError invalid UUID
 * @throws TenantNotFoundError no row matches
 */
async function get(db: NodePgDatabase<Record<string, never>>, id: string): Promise<Tenant> {
  const parsedId = parseOrThrow(idSchema, id, 'getTenant id');
  const rows = await db.select().from(tenant).where(eq(tenant.id, parsedId)).limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new TenantNotFoundError(parsedId, 'id');
  }
  return row;
}

/**
 * Fetch a tenant by `external_id`.
 *
 * @throws TenantValidationError invalid externalId
 * @throws TenantNotFoundError no row matches
 */
async function getByExternalId(
  db: NodePgDatabase<Record<string, never>>,
  externalId: string,
): Promise<Tenant> {
  const parsed = parseOrThrow(externalIdSchema, externalId, 'getTenantByExternalId');
  const rows = await db.select().from(tenant).where(eq(tenant.external_id, parsed)).limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new TenantNotFoundError(parsed, 'external_id');
  }
  return row;
}

/**
 * Paginated list of all tenants. Limit/offset semantics; admin-style.
 * No tenant-context scoping — every caller sees every tenant. Authz at
 * a higher layer (post-AC01).
 *
 * @throws TenantValidationError invalid options
 */
async function list(
  db: NodePgDatabase<Record<string, never>>,
  options: ListTenantsOptions = {},
): Promise<TenantListResult> {
  const parsed = parseOrThrow(listOptionsSchema, options, 'listTenants options');

  const items = await db
    .select()
    .from(tenant)
    .orderBy(tenant.created_at)
    .limit(parsed.limit)
    .offset(parsed.offset);

  const totalRows = await db.select({ value: count() }).from(tenant);
  const total = totalRows[0]?.value ?? 0;

  return { items, total, limit: parsed.limit, offset: parsed.offset };
}

/**
 * Patch mutable fields on a tenant. Slice A only `displayName` is
 * mutable; `externalId` and `tier` are immutable here, `status` flows
 * through `setStatus`.
 *
 * The audit payload reports the actual delta — `changes` is the patch,
 * and `before` carries the prior values of fields that ARE changing
 * (per-field comparison; matching values are excluded from `before`).
 *
 * Refuses to update a tenant in `TERMINATED` status. The current row is
 * loaded with `SELECT ... FOR UPDATE` to serialize concurrent updates.
 *
 * @throws TenantValidationError invalid input or empty patch
 * @throws TenantNotFoundError no row matches `id`
 * @throws TenantStatusError tenant is `TERMINATED`
 */
async function update(
  db: NodePgDatabase<Record<string, never>>,
  id: string,
  patch: UpdateTenantPatch,
  ctx: { actor: Actor },
): Promise<Tenant> {
  const parsedId = parseOrThrow(idSchema, id, 'updateTenant id');
  const parsedPatch = parseOrThrow(updateInputSchema, patch, 'updateTenant patch');
  const parsedActor = parseOrThrow(actorSchema, ctx.actor, 'updateTenant actor');

  return db.transaction(async (tx) => {
    await bindTenantToDbSession(tx, parsedId);

    const currentRows = await tx
      .select()
      .from(tenant)
      .where(eq(tenant.id, parsedId))
      .for('update')
      .limit(1);
    const current = currentRows[0];
    if (current === undefined) {
      throw new TenantNotFoundError(parsedId, 'id');
    }
    if (current.status === 'TERMINATED') {
      throw new TenantStatusError(parsedId, 'TERMINATED', ['PROVISIONING', 'ACTIVE', 'SUSPENDED']);
    }

    const before: Record<string, string> = {};
    const after: Record<string, string> = {};
    if (parsedPatch.displayName !== undefined && parsedPatch.displayName !== current.display_name) {
      before.displayName = current.display_name;
      after.displayName = parsedPatch.displayName;
    }

    const updated = await tx
      .update(tenant)
      .set({
        ...(parsedPatch.displayName !== undefined && {
          display_name: parsedPatch.displayName,
        }),
        updated_at: msNow,
      })
      .where(eq(tenant.id, parsedId))
      .returning();
    const next = updated[0];
    if (next === undefined) {
      throw new Error('tenants.update: UPDATE returned no row');
    }

    await emitAuditEvent(tx, {
      tenantId: parsedId,
      actorType: parsedActor.type,
      actorId: parsedActor.id,
      ...(parsedActor.description !== undefined && { actorDescription: parsedActor.description }),
      action: getActionByName(TENANT_AUDIT_ACTIONS, 'TENANT_UPDATED'),
      verb: 'UPDATE',
      resource: `tenant:${parsedId}`,
      before_state: before,
      after_state: after,
    });

    return next;
  });
}

/**
 * Set the tenant's lifecycle status. Slice A enforces a minimal
 * transition whitelist (full state machine ships in F02):
 *   - PROVISIONING → ACTIVE
 *   - ACTIVE       → SUSPENDED | TERMINATED
 *   - SUSPENDED    → ACTIVE | TERMINATED
 *   - TERMINATED   → (none)
 *
 * Setting the status to its current value is rejected with
 * `TenantStatusError` — there is no idempotent no-op. A silent success
 * when nothing changed would lie to the audit log; callers must check
 * the current status first if they need conditional behavior.
 *
 * @throws TenantValidationError invalid input
 * @throws TenantNotFoundError no row matches `id`
 * @throws TenantStatusError disallowed transition (including same →
 *         same)
 */
async function setStatus(
  db: NodePgDatabase<Record<string, never>>,
  id: string,
  newStatus: TenantStatus,
  ctx: { actor: Actor },
): Promise<Tenant> {
  const parsedId = parseOrThrow(idSchema, id, 'setStatus id');
  const parsedStatus = parseOrThrow(statusSchema, newStatus, 'setStatus newStatus');
  const parsedActor = parseOrThrow(actorSchema, ctx.actor, 'setStatus actor');

  return db.transaction(async (tx) => {
    await bindTenantToDbSession(tx, parsedId);

    const currentRows = await tx
      .select()
      .from(tenant)
      .where(eq(tenant.id, parsedId))
      .for('update')
      .limit(1);
    const current = currentRows[0];
    if (current === undefined) {
      throw new TenantNotFoundError(parsedId, 'id');
    }

    assertTransitionAllowed(parsedId, current.status, parsedStatus);

    const updated = await tx
      .update(tenant)
      .set({ status: parsedStatus, updated_at: msNow })
      .where(eq(tenant.id, parsedId))
      .returning();
    const next = updated[0];
    if (next === undefined) {
      throw new Error('tenants.setStatus: UPDATE returned no row');
    }

    await emitAuditEvent(tx, {
      tenantId: parsedId,
      actorType: parsedActor.type,
      actorId: parsedActor.id,
      ...(parsedActor.description !== undefined && { actorDescription: parsedActor.description }),
      action: getActionByName(TENANT_AUDIT_ACTIONS, 'TENANT_STATUS_CHANGED'),
      verb: 'UPDATE',
      resource: `tenant:${parsedId}`,
      before_state: { status: current.status },
      after_state: { status: parsedStatus },
    });

    return next;
  });
}

// ─────────────────────────────────────────────────────────────────────
// Public namespace
// ─────────────────────────────────────────────────────────────────────

export const tenants = {
  create,
  get,
  getByExternalId,
  list,
  update,
  setStatus,
};
