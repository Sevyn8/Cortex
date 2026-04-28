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
 *   in F02 — `setStatus` here is a thin column update + audit; F02
 *   workflows (`provision`, `suspend`, `resume`) compose around it.
 *   F02 Slice A added `provision`; Slice B added `suspend` + `resume`
 *   (asymmetric audit emission per SB1 lock — TENANT_SUSPENDED for
 *   suspend, TENANT_STATUS_CHANGED for resume; convention §5).
 *   `tenants.terminate` is reserved for Slice C.
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
import { dispatchCloudTask } from './cloud-tasks.js';
import { bindTenantToDbSession } from './db-session.js';
import { TenantNotFoundError, TenantStatusError, TenantValidationError } from './errors.js';
import {
  generateExportArchive,
  type ExportArchive,
  type GenerateExportArchiveOptions,
} from './export-archive.js';
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
  'REQUESTED',
  'PROVISIONING',
  'READY',
  'ACTIVE',
  'SUSPENDED',
  'OFFBOARDING',
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
  // Optional initial status override. tenants.provision sets this to
  // 'REQUESTED' for ENTERPRISE tenants awaiting manual approval
  // (Q-OPEN-6); other callers leave it undefined → DB default
  // 'PROVISIONING' applies. zod validates against the 7-value
  // TenantStatus union; the DB CHECK (`tenant_status_check` per
  // migration 0010) is the second-layer guard.
  initialStatus: statusSchema.optional(),
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

// F02 Slice B — `tenants.suspend` reason validation (Q-NEW-1 lock).
// Free-form string, 1–500 chars, required. Stored in
// audit_event.payload.reason via the user-payload merge in
// @cortex/audit-events (emit.ts line 135-136).
const suspendReasonSchema = z.string().min(1).max(500);

// F02 Slice C — `tenants.offboard` options validation. Default 30-day
// grace per planning-doc D7 + spec §3. Cap at 365 days — Cloud Tasks
// caps schedule_time at 30 days actually, so 365 here is the input
// validation guard; dispatch will fail at the SDK if anything >30 days
// is supplied. Convention §6 captures the upgrade path for "indefinite
// offboarding" if a future compliance use case requires it.
const offboardOptionsSchema = z
  .object({
    gracePeriodDays: z.number().int().min(1).max(365).default(30),
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
// Status transition policy (F02 lifecycle state machine per
// ADR-LIFECYCLE-001). Migration 0010 extended the DB CHECK to allow the
// new states; this map adds the transition edges that connect them.
//
// Forward path:
//   REQUESTED → PROVISIONING → READY → ACTIVE
// Suspension cycle (reversible):
//   ACTIVE → SUSPENDED → ACTIVE
// Offboarding/termination (terminal):
//   ACTIVE → OFFBOARDING → TERMINATED
//   SUSPENDED → OFFBOARDING (alt path: suspended tenant skips re-active)
//   SUSPENDED → TERMINATED  (alt path: suspended tenant terminates direct;
//                            kept for backward compat with Slice A
//                            transitions and operator escape hatch)
//
// PROVISIONING → ACTIVE retained as a backward-compat edge for existing
// Slice A test fixtures and bootstrap code paths that don't yet route
// through READY. F02 provisioning workflow uses the explicit
// PROVISIONING → READY → ACTIVE path; legacy PROVISIONING → ACTIVE is
// permitted but discouraged. Convention doc §1 documents the dual-path
// tolerance and the migration plan to retire the direct edge once all
// fixtures route via READY.
// ─────────────────────────────────────────────────────────────────────

const ALLOWED_TRANSITIONS: ReadonlyMap<TenantStatus, readonly TenantStatus[]> = new Map([
  ['REQUESTED', ['PROVISIONING']],
  ['PROVISIONING', ['READY', 'ACTIVE']],
  ['READY', ['ACTIVE']],
  ['ACTIVE', ['SUSPENDED', 'OFFBOARDING', 'TERMINATED']],
  ['SUSPENDED', ['ACTIVE', 'OFFBOARDING', 'TERMINATED']],
  ['OFFBOARDING', ['TERMINATED']],
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
        // tenants.provision sets initialStatus='REQUESTED' for ENTERPRISE
        // tenants awaiting Q-OPEN-6 approval; other callers leave it
        // undefined and the DB default ('PROVISIONING') applies. Drizzle
        // omits the field from the INSERT when undefined, preserving the
        // DB default behavior.
        ...(parsedInput.initialStatus !== undefined && {
          status: parsedInput.initialStatus,
        }),
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
// F02 lifecycle workflow — provision (Slice A)
// ─────────────────────────────────────────────────────────────────────

/**
 * Provision a new tenant via the F02 lifecycle workflow.
 *
 * Inserts the tenant row at `status='REQUESTED'` (ENTERPRISE awaiting
 * manual approval per Q-OPEN-6) or `'PROVISIONING'` (Standard, ready to
 * advance), then enqueues a Cloud Task to drive the async provisioning
 * workflow. Returns immediately after enqueue per planning-doc SA3 —
 * caller polls `tenant.status` via `tenants.get(tenantId)`.
 *
 * Standard path: REQUESTED is skipped; tenant lands at PROVISIONING and
 * the worker advances PROVISIONING → READY → ACTIVE.
 *
 * Enterprise path: tenant lands at REQUESTED. The worker is enqueued
 * but no-ops while `tenant.dedicated_db_approved=false`. An operator
 * marks the flag true via the control plane (HTTP API in Slice D); the
 * worker is then re-enqueued (TBD — Slice A workflow code lands sub-
 * phase 4.3). Convention doc §4 captures the operator workflow.
 *
 * Idempotency: Cloud Tasks `taskId='provisioning-{tenantId}'` dedups
 * duplicate enqueue attempts within ~1h. Worker also pre-checks
 * `tenant.status` per planning-doc SA11 so a duplicate that slips
 * through dedup becomes a no-op.
 *
 * Failure: hard rollback per planning-doc SA10. Substrate INSERTs
 * (tenant + tenant_kms_key + optional tenant_config_version) commit
 * atomically inside `tenants.create`; if `tenants.create` throws, the
 * txn rolls back and no row exists. If Cloud Tasks dispatch fails
 * AFTER the substrate commit, the tenant row exists at `REQUESTED` /
 * `PROVISIONING` with no scheduled worker — operator must run
 * `cleanupFailedProvisioning` (lands sub-phase 4.5) before retrying.
 *
 * Audit emission: `tenants.create` already emits `TENANT_CREATED` +
 * `TENANT_KMS_KEY_BOUND` (+ optional `TENANT_CONFIG_VERSION_CREATED`).
 * `TENANT_PROVISIONED` is NOT emitted here — it fires in the worker
 * when status reaches READY.
 *
 * Requires env: `GCP_PROJECT_ID`, `PROVISIONING_WORKER_URL`. Optional:
 * `GCP_LOCATION` (defaults to `asia-south1`).
 *
 * @throws TenantValidationError invalid input or actor.
 * @throws Postgres unique-violation if `externalId` already exists
 *   (caller layer should map to a 409).
 * @throws Error if `PROVISIONING_WORKER_URL` env is missing.
 * @throws Error from Cloud Tasks SDK on dispatch failure — caller MUST
 *   reconcile (see "Failure" above).
 */
async function provision(
  db: NodePgDatabase<Record<string, never>>,
  input: CreateTenantInput,
  ctx: { actor: Actor },
): Promise<{ tenantId: string; status: TenantStatus }> {
  // ENTERPRISE → REQUESTED (worker awaits dedicated_db_approved).
  // STANDARD   → PROVISIONING (worker advances immediately).
  const initialStatus: TenantStatus = input.tier === 'ENTERPRISE' ? 'REQUESTED' : 'PROVISIONING';

  // Re-uses tenants.create for substrate INSERTs + audit emission chain
  // (TENANT_CREATED + TENANT_KMS_KEY_BOUND + optional
  // TENANT_CONFIG_VERSION_CREATED). The initialStatus override (added
  // to CreateTenantInput in this same sub-phase) flows through to the
  // tenant INSERT.
  const created = await create(db, { ...input, initialStatus }, ctx);

  // Enqueue provisioning task. Worker URL is configured per env; the
  // actual worker function lands in sub-phase 4.3.
  const targetUrl = process.env.PROVISIONING_WORKER_URL;
  if (targetUrl === undefined || targetUrl === '') {
    throw new Error('PROVISIONING_WORKER_URL env required for tenants.provision');
  }

  await dispatchCloudTask({
    queueName: 'provisioning-queue',
    taskId: `provisioning-${created.id}`,
    targetUrl,
    payload: {
      tenantId: created.id,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      ...(ctx.actor.description !== undefined && { actorDescription: ctx.actor.description }),
    },
  });

  return { tenantId: created.id, status: initialStatus };
}

// ─────────────────────────────────────────────────────────────────────
// F02 lifecycle workflow — suspend + resume (Slice B)
// ─────────────────────────────────────────────────────────────────────

/**
 * Suspend an ACTIVE tenant. Flips `status` to SUSPENDED inside a single
 * row-locked transaction (`SELECT ... FOR UPDATE` matches `setStatus`'s
 * pessimistic-locking pattern; §10.15 contention test verifies in
 * Slice B sub-phase 3) and emits a `TENANT_SUSPENDED` audit event with
 * the operator-supplied reason in `payload.reason`.
 *
 * Per SB1 lock, suspend uses the dedicated `TENANT_SUSPENDED` action
 * (NOT `TENANT_STATUS_CHANGED`) — it serves as the cascade-event handle
 * for AC01 session revoke + S15 device pause + S17 outbound stop. F02
 * emits; downstream consumers subscribe when they ship (planning doc
 * §Drift 3 / §Drift 4; convention §5).
 *
 * Per SB5 Option α (idempotent), calling `suspend` on an already-
 * SUSPENDED tenant is a no-op — the current row is returned without
 * a state change and without an audit emission. Operators retrying
 * after a flaky network response see clean success rather than a
 * `TenantStatusError`. Logging a no-op audit row would be misleading
 * (no state change occurred); the original suspend's audit row remains
 * the canonical record.
 *
 * Transitions disallowed by `ALLOWED_TRANSITIONS` raise
 * `TenantStatusError` (e.g., suspending a REQUESTED or TERMINATED
 * tenant).
 *
 * @throws TenantValidationError invalid id or reason (empty / >500
 *         chars).
 * @throws TenantNotFoundError no row matches `id`.
 * @throws TenantStatusError current status disallows the SUSPENDED
 *         transition (e.g., REQUESTED, PROVISIONING, READY,
 *         OFFBOARDING, TERMINATED).
 */
async function suspend(
  db: NodePgDatabase<Record<string, never>>,
  id: string,
  reason: string,
  ctx: { actor: Actor },
): Promise<Tenant> {
  const parsedId = parseOrThrow(idSchema, id, 'suspend id');
  const parsedReason = parseOrThrow(suspendReasonSchema, reason, 'suspend reason');
  const parsedActor = parseOrThrow(actorSchema, ctx.actor, 'suspend actor');

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

    // SB5 Option α: idempotent re-call is no-op. Return the locked row
    // (still inside the txn — caller sees the consistent SUSPENDED
    // snapshot). NO audit emission and NO updated_at touch.
    if (current.status === 'SUSPENDED') {
      return current;
    }

    assertTransitionAllowed(parsedId, current.status, 'SUSPENDED');

    const updated = await tx
      .update(tenant)
      .set({ status: 'SUSPENDED', updated_at: msNow })
      .where(eq(tenant.id, parsedId))
      .returning();
    const next = updated[0];
    if (next === undefined) {
      throw new Error('tenants.suspend: UPDATE returned no row');
    }

    await emitAuditEvent(tx, {
      tenantId: parsedId,
      actorType: parsedActor.type,
      actorId: parsedActor.id,
      ...(parsedActor.description !== undefined && { actorDescription: parsedActor.description }),
      action: getActionByName(TENANT_AUDIT_ACTIONS, 'TENANT_SUSPENDED'),
      verb: 'UPDATE',
      resource: `tenant:${parsedId}`,
      before_state: { status: current.status },
      after_state: { status: 'SUSPENDED' },
      payload: { reason: parsedReason },
    });

    return next;
  });
}

/**
 * Resume a SUSPENDED tenant back to ACTIVE. Mirrors `suspend`'s
 * single-transaction row-locked shape; emits `TENANT_STATUS_CHANGED`
 * (NOT a `TENANT_RESUMED` domain action) per SB1 lock + convention §5
 * — resume is the reversible inverse with no cascade subscribers, so
 * one STATUS_CHANGED row reads cleanly.
 *
 * Per SB5 Option α (idempotent), calling `resume` on an already-
 * ACTIVE tenant is a no-op — current row returned, no audit emit.
 *
 * Per Q-NEW-2 lock, `resume` takes no `reason` parameter — the audit
 * chain shows what was suspended and why; resume's "why" is implicit
 * ("ready again"). Future Slice may add a structured resume-reason
 * RPC if operators need it.
 *
 * @throws TenantValidationError invalid id.
 * @throws TenantNotFoundError no row matches `id`.
 * @throws TenantStatusError current status disallows the ACTIVE
 *         transition (e.g., REQUESTED, PROVISIONING, OFFBOARDING,
 *         TERMINATED). Note `READY → ACTIVE` is allowed but is the
 *         provisioning-worker's path; calling `resume` from READY is
 *         disallowed at the API surface (`ALLOWED_TRANSITIONS` permits
 *         it; resume is documented as SUSPENDED-only).
 */
async function resume(
  db: NodePgDatabase<Record<string, never>>,
  id: string,
  ctx: { actor: Actor },
): Promise<Tenant> {
  const parsedId = parseOrThrow(idSchema, id, 'resume id');
  const parsedActor = parseOrThrow(actorSchema, ctx.actor, 'resume actor');

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

    // SB5 Option α: idempotent re-call is no-op.
    if (current.status === 'ACTIVE') {
      return current;
    }

    assertTransitionAllowed(parsedId, current.status, 'ACTIVE');

    const updated = await tx
      .update(tenant)
      .set({ status: 'ACTIVE', updated_at: msNow })
      .where(eq(tenant.id, parsedId))
      .returning();
    const next = updated[0];
    if (next === undefined) {
      throw new Error('tenants.resume: UPDATE returned no row');
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
      after_state: { status: 'ACTIVE' },
    });

    return next;
  });
}

// ─────────────────────────────────────────────────────────────────────
// F02 lifecycle workflow — offboard (Slice C)
// ─────────────────────────────────────────────────────────────────────

export interface OffboardOptions {
  /** Grace period before scheduled termination. Default 30 days. */
  gracePeriodDays?: number;
  /**
   * Optional override forwarded to `generateExportArchive`. Tests use
   * this to inject a stubbed `Storage` / `SignedUrlSigner`. Production
   * callers omit and the default ADC/WIF-backed clients construct
   * lazily.
   */
  archiveOverrides?: GenerateExportArchiveOptions;
}

export interface OffboardResult {
  tenant: Tenant;
  graceUntil: Date;
  /**
   * Archive metadata. `undefined` when offboard returned via the
   * idempotent fast-path (caller is retrying after the original call
   * already completed). Original archive's `gcsUri` lives in the
   * `TENANT_OFFBOARDING_STARTED` audit event payload — operator queries
   * `fetchAuditEvents` to recover it; a future
   * `tenants.regenerateOffboardingArchiveUrl(tenantId)` will refresh
   * the signed URL when needed.
   */
  exportArchive: ExportArchive | undefined;
}

/**
 * Begin the offboarding workflow for an ACTIVE or SUSPENDED tenant.
 *
 * Per F02 Slice C SC1 lock + convention §6.1:
 *   1. Idempotency fast-path: if status is already OFFBOARDING, return
 *      the current row + grace_until without regenerating the archive
 *      or re-dispatching the terminate task. Mirrors SB5 Option α from
 *      `suspend` / `resume`.
 *   2. Generate export archive (gzipped JSONL of all 6 entity types,
 *      uploaded to `tenants/{tenantId}/exports/{ts}.jsonl.gz`, V4
 *      signed URL with 7-day TTL — GCS server-side cap; Q-NEW-C6).
 *   3. Single transaction: row-lock the tenant, re-check idempotency
 *      (race-safe), transition ACTIVE/SUSPENDED → OFFBOARDING, set
 *      `offboarding_grace_until = now() + gracePeriodDays`, emit
 *      `TENANT_OFFBOARDING_STARTED` audit event with archive metadata
 *      (gcsUri, sizeBytes, schemaVersion — NOT signedUrl: the URL is
 *      a short-lived auth token; logging it leaks credentials).
 *   4. Dispatch delayed Cloud Task on `lifecycle-queue` with
 *      `taskId='terminate-{tenantId}'` and `scheduleTime=graceUntil`.
 *      Worker URL via `LIFECYCLE_WORKER_URL` env var (Slice D ships
 *      the worker; sub-phase 7.6 ships the queue TF).
 *
 * Failure modes:
 *   - Archive generation fails → no state mutation, no audit row, no
 *     scheduled task. Caller retries the whole call.
 *   - State mutation + audit emit are atomic (single txn). If audit
 *     emission fails, transition rolls back.
 *   - Cloud Task dispatch fails AFTER the txn commits → tenant is in
 *     OFFBOARDING with grace_until set + audit row emitted, but no
 *     scheduled terminate. Operator runbook (sub-phase 7.7 §6) covers
 *     manual reconciliation: re-call `tenants.offboard` (idempotent
 *     fast-path returns) then explicitly dispatch the terminate task,
 *     OR call `tenants.terminate` directly after grace_until elapses.
 *
 * Requires env: `GCP_PROJECT_ID`, `LIFECYCLE_WORKER_URL`. Optional:
 * `GCP_LOCATION` (defaults to `asia-south1`), `CORTEX_ENV` (defaults
 * to `dev` for the tenant-data bucket name).
 *
 * @throws TenantValidationError invalid id, options, or actor.
 * @throws TenantNotFoundError no row matches `id`.
 * @throws TenantStatusError current status disallows the OFFBOARDING
 *         transition (e.g., REQUESTED, PROVISIONING, READY,
 *         TERMINATED).
 * @throws Error if `LIFECYCLE_WORKER_URL` env is missing.
 * @throws BlobStorageValidationError on tenant-prefix violations
 *         (defense-in-depth from `@cortex/blob-storage`).
 * @throws Error from `@google-cloud/storage` on upload failure or from
 *         Cloud Tasks SDK on dispatch failure — caller MUST reconcile.
 */
async function offboard(
  db: NodePgDatabase<Record<string, never>>,
  id: string,
  options: OffboardOptions = {},
  ctx: { actor: Actor },
): Promise<OffboardResult> {
  const parsedId = parseOrThrow(idSchema, id, 'offboard id');
  const parsedOptions = parseOrThrow(
    offboardOptionsSchema,
    { gracePeriodDays: options.gracePeriodDays },
    'offboard options',
  );
  const parsedActor = parseOrThrow(actorSchema, ctx.actor, 'offboard actor');

  // PHASE 1: idempotent fast-path. Read without lock; if already
  // OFFBOARDING, return early (no archive regen, no audit emit, no task
  // dispatch). The Phase 3 row-lock re-checks for race safety.
  const preflight = await db.select().from(tenant).where(eq(tenant.id, parsedId)).limit(1);
  const preflightRow = preflight[0];
  if (preflightRow === undefined) {
    throw new TenantNotFoundError(parsedId, 'id');
  }
  if (preflightRow.status === 'OFFBOARDING') {
    if (preflightRow.offboarding_grace_until === null) {
      // Defensive: status=OFFBOARDING without grace_until is an
      // inconsistent state — should never happen post-this-workflow.
      throw new Error(
        `tenants.offboard: tenant ${parsedId} is OFFBOARDING but offboarding_grace_until is NULL`,
      );
    }
    return {
      tenant: preflightRow,
      graceUntil: preflightRow.offboarding_grace_until,
      exportArchive: undefined,
    };
  }
  // Pre-validate the transition before generating an archive, so an
  // invalid transition (e.g., REQUESTED → OFFBOARDING) fails fast.
  assertTransitionAllowed(parsedId, preflightRow.status, 'OFFBOARDING');

  // Compute graceUntil up front so the Phase 2 archive metadata + Phase
  // 3 column update + Phase 4 task scheduleTime all share the same
  // wall-clock value.
  const graceUntil = new Date(Date.now() + parsedOptions.gracePeriodDays * 24 * 60 * 60 * 1000);

  // PHASE 2: generate archive (outside any txn). Reads the 6 entities
  // under an RLS-bound transaction internally. Long-running — uploads
  // gzipped JSONL to GCS + signs URL.
  const archive = await db.transaction(async (tx) => {
    await bindTenantToDbSession(tx, parsedId);
    return generateExportArchive(tx, parsedId, options.archiveOverrides ?? {});
  });

  // PHASE 3: single txn — row-lock, re-check idempotency for race
  // safety, transition, emit audit with archive metadata.
  const updatedTenant = await db.transaction(async (tx) => {
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

    // Race-safe idempotency: if a parallel offboard committed between
    // Phase 1 and Phase 3, return current. Note the wasted archive in
    // GCS — orphaned object stays scoped to the tenant prefix; storage
    // waste only, no security implication.
    if (current.status === 'OFFBOARDING') {
      return current;
    }

    assertTransitionAllowed(parsedId, current.status, 'OFFBOARDING');

    const updated = await tx
      .update(tenant)
      .set({
        status: 'OFFBOARDING',
        offboarding_grace_until: graceUntil,
        updated_at: msNow,
      })
      .where(eq(tenant.id, parsedId))
      .returning();
    const next = updated[0];
    if (next === undefined) {
      throw new Error('tenants.offboard: UPDATE returned no row');
    }

    await emitAuditEvent(tx, {
      tenantId: parsedId,
      actorType: parsedActor.type,
      actorId: parsedActor.id,
      ...(parsedActor.description !== undefined && { actorDescription: parsedActor.description }),
      action: getActionByName(TENANT_AUDIT_ACTIONS, 'TENANT_OFFBOARDING_STARTED'),
      verb: 'UPDATE',
      resource: `tenant:${parsedId}`,
      before_state: { status: current.status },
      after_state: {
        status: 'OFFBOARDING',
        offboarding_grace_until: graceUntil.toISOString(),
      },
      payload: {
        gracePeriodDays: parsedOptions.gracePeriodDays,
        // signedUrl deliberately omitted — short-lived auth token;
        // logging leaks credentials.
        exportArchive: {
          gcsUri: archive.gcsUri,
          fullObjectPath: archive.fullObjectPath,
          bucket: archive.bucket,
          sizeBytes: archive.sizeBytes,
          schemaVersion: archive.schemaVersion,
          entityCounts: archive.entityCounts,
          generatedAt: archive.generatedAt.toISOString(),
        },
      },
    });

    return next;
  });

  // PHASE 4: dispatch delayed terminate task. The worker URL env var
  // gates dispatch — Slice D / sub-phase 7.6 will populate it. Failure
  // here leaves state in OFFBOARDING + audit emitted; operator
  // reconciles per JSDoc "Failure modes" above.
  const lifecycleWorkerUrl = process.env.LIFECYCLE_WORKER_URL;
  if (lifecycleWorkerUrl === undefined || lifecycleWorkerUrl === '') {
    throw new Error('LIFECYCLE_WORKER_URL env required for tenants.offboard');
  }

  await dispatchCloudTask({
    queueName: 'lifecycle-queue',
    taskId: `terminate-${parsedId}`,
    targetUrl: lifecycleWorkerUrl,
    payload: {
      tenantId: parsedId,
      action: 'terminate',
      offboardingGraceUntil: graceUntil.toISOString(),
      actorType: parsedActor.type,
      actorId: parsedActor.id,
      ...(parsedActor.description !== undefined && { actorDescription: parsedActor.description }),
    },
    scheduleTime: graceUntil,
  });

  // If Phase 3 returned the already-OFFBOARDING current row (race
  // path), updatedTenant.offboarding_grace_until is the original — not
  // graceUntil. Surface the correct value to the caller.
  return {
    tenant: updatedTenant,
    graceUntil:
      updatedTenant.status === 'OFFBOARDING' && updatedTenant.offboarding_grace_until !== null
        ? updatedTenant.offboarding_grace_until
        : graceUntil,
    exportArchive: archive,
  };
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
  provision,
  suspend,
  resume,
  offboard,
};
