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

import { and, count, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { Storage } from '@google-cloud/storage';
import {
  legalHold,
  tenant,
  tenantConfigVersion,
  tenantKmsKey,
  tenantQuotaUsage,
  type Tenant,
} from '@cortex/canonical-schema';
import { getActionByName } from '@cortex/audit-events';
import { getTenantBucketName, getTenantPrefix, type Environment } from '@cortex/blob-storage';
import { buildKeyResourceName, kmsAdmin } from '@cortex/secrets';
import { TENANT_AUDIT_ACTIONS } from './audit-actions.js';
import { emitAuditEvent } from './audit.js';
import { dispatchCloudTask } from './cloud-tasks.js';
import { bindTenantToDbSession } from './db-session.js';
import {
  TenantGraceNotElapsedError,
  TenantLegalHoldError,
  TenantNotFoundError,
  TenantRotationCooldownError,
  TenantStatusError,
  TenantValidationError,
} from './errors.js';
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
 * Per F02 Slice C Q-NEW-C8 lock: TERMINATED tenants are soft-retained
 * tombstones (status='TERMINATED', terminated_at set). This filter
 * surfaces them as `TenantNotFoundError` to callers — indistinguishable
 * from hard delete at the API surface, matching spec §3 ("post-
 * termination queries return tenant-not-found"). Operators wanting
 * tombstone visibility for compliance review can read directly via SQL
 * or call `tenants.list` (intentionally unfiltered).
 *
 * @throws TenantValidationError invalid UUID
 * @throws TenantNotFoundError no row matches OR row is TERMINATED
 */
async function get(db: NodePgDatabase<Record<string, never>>, id: string): Promise<Tenant> {
  const parsedId = parseOrThrow(idSchema, id, 'getTenant id');
  const rows = await db.select().from(tenant).where(eq(tenant.id, parsedId)).limit(1);
  const row = rows[0];
  if (row === undefined || row.status === 'TERMINATED') {
    throw new TenantNotFoundError(parsedId, 'id');
  }
  return row;
}

/**
 * Fetch a tenant by `external_id`. TERMINATED tombstones are filtered
 * per Q-NEW-C8 (same rationale as `get`).
 *
 * @throws TenantValidationError invalid externalId
 * @throws TenantNotFoundError no row matches OR row is TERMINATED
 */
async function getByExternalId(
  db: NodePgDatabase<Record<string, never>>,
  externalId: string,
): Promise<Tenant> {
  const parsed = parseOrThrow(externalIdSchema, externalId, 'getTenantByExternalId');
  const rows = await db.select().from(tenant).where(eq(tenant.external_id, parsed)).limit(1);
  const row = rows[0];
  if (row === undefined || row.status === 'TERMINATED') {
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
// F02 lifecycle workflow — terminate (Slice C)
// ─────────────────────────────────────────────────────────────────────

export interface TerminateOptions {
  /**
   * Optional override for the GCS Storage client used by the cascade's
   * recursive prefix delete. Tests inject a stub. Production callers
   * omit so the default ADC/WIF-backed client constructs lazily.
   */
  cascadeOverrides?: { storage?: Storage };
}

/**
 * Terminate an OFFBOARDING tenant. Hard-deletes child substrate; soft-
 * retains the tenant row as a tombstone.
 *
 * Per F02 Slice C SC1 + SC4 + Q-NEW-C5 + Q-NEW-C8 + Q-NEW-C10 + Q-NEW-C11:
 *
 *   - Status guard: must be OFFBOARDING (else TenantStatusError).
 *   - Grace guard: `now() >= tenant.offboarding_grace_until` (Q-NEW-C10
 *     strict; else TenantGraceNotElapsedError).
 *   - Legal-hold guard: dual-source check per convention §6.3 — fast
 *     path on `tenant.legal_hold` boolean (migration 0010) AND granular
 *     path on `legal_hold` table (migration 0011, scope discriminator).
 *     Either active hold blocks (TenantLegalHoldError); use
 *     `tenants.forceTerminate` for Super Admin override.
 *
 * 5-step cascade:
 *
 *   1. Cloud Run service delete (ENTERPRISE only) — Phase 1 STUB per
 *      Q-NEW-C5; lights up with ADR-INFRA-005 swap (Slice D's
 *      per-tenant Cloud Run TF module).
 *   2. GCS prefix recursive delete — `tenants/{tenantId}/` via
 *      `@google-cloud/storage` `bucket.deleteFiles({prefix, force: true})`.
 *      Idempotent (force: true means no error if no files match).
 *   3. Cloud SQL instance delete (ENTERPRISE only) — Phase 1 STUB per
 *      Q-NEW-C5; lights up with ADR-INFRA-005 swap.
 *   4. Shared-DB hard delete (children) + soft-retain (tenant row),
 *      single transaction:
 *        - Emit TENANT_TERMINATED audit event with full before_state +
 *          kms_key_resource_name in payload (RLS write policy needs
 *          tenant row still extant; emit BEFORE the delete).
 *        - DELETE legal_hold, tenant_kms_key, tenant_config_version,
 *          tenant_quota_usage rows for this tenant.
 *        - UPDATE tenant SET status='TERMINATED', terminated_at=msNow.
 *          Tombstone row keeps audit_event.tenant_id references valid.
 *   5. KMS key tombstone — Phase 1 records the resource name in the
 *      audit payload as a tombstone signal; no destroy call (env-level
 *      shared key per Q-NEW-C11). Future per-tenant CMEK swap
 *      (ADR-INFRA-007) lights up `keys.scheduleDestroy` with a 7-day
 *      recovery window.
 *
 * Idempotency: re-call on a TERMINATED tombstone returns the row
 * without re-emitting audit or re-running the cascade (mirrors SB5
 * Option α from suspend/resume/offboard).
 *
 * Failure semantics (SC4 lock): retry-from-scratch with per-step
 * pre-checks. GCS delete is idempotent; shared-DB cascade is wrapped
 * in a single txn (atomic delete + tombstone update); Cloud Run +
 * Cloud SQL deletes are stubbed in Phase 1 so failure modes there
 * don't apply. If Phase 4's txn fails after a successful Phase 3
 * GCS delete, the tenant remains in OFFBOARDING — operator re-runs
 * `tenants.terminate`; the GCS prefix-already-empty case is a no-op,
 * and the txn reaches the same final state.
 *
 * @throws TenantValidationError invalid id or actor.
 * @throws TenantNotFoundError no row matches `id`.
 * @throws TenantStatusError current status is not OFFBOARDING.
 * @throws TenantGraceNotElapsedError grace period not yet elapsed.
 * @throws TenantLegalHoldError active legal hold blocks termination.
 * @throws Error from `@google-cloud/storage` on GCS delete failure;
 *   caller retries.
 */
async function terminate(
  db: NodePgDatabase<Record<string, never>>,
  id: string,
  ctx: { actor: Actor },
  options: TerminateOptions = {},
): Promise<Tenant> {
  const parsedId = parseOrThrow(idSchema, id, 'terminate id');
  const parsedActor = parseOrThrow(actorSchema, ctx.actor, 'terminate actor');

  // PHASE 1: idempotent fast-path. Read without lock; if already
  // TERMINATED, return the tombstone.
  const preflight = await db.select().from(tenant).where(eq(tenant.id, parsedId)).limit(1);
  const preflightRow = preflight[0];
  if (preflightRow === undefined) {
    throw new TenantNotFoundError(parsedId, 'id');
  }
  if (preflightRow.status === 'TERMINATED') {
    return preflightRow;
  }

  // PHASE 2: validate prerequisites BEFORE any destructive action.
  if (preflightRow.status !== 'OFFBOARDING') {
    throw new TenantStatusError(parsedId, preflightRow.status, ['OFFBOARDING']);
  }
  if (preflightRow.offboarding_grace_until === null) {
    // Defensive: OFFBOARDING without grace_until is an inconsistent
    // state — only `tenants.offboard` writes the column, and it always
    // sets it. Surface as Error (not a domain error class) since this
    // is a data-integrity bug, not a caller-facing condition.
    throw new Error(
      `tenants.terminate: tenant ${parsedId} is OFFBOARDING but offboarding_grace_until is NULL`,
    );
  }
  const now = new Date();
  if (now < preflightRow.offboarding_grace_until) {
    throw new TenantGraceNotElapsedError(parsedId, preflightRow.offboarding_grace_until, now);
  }

  // Legal-hold check: dual-source per convention §6.3. Fast path on the
  // tenant.legal_hold boolean; granular path on the legal_hold table.
  // Read inside a tenant-bound txn so the legal_hold RLS policy permits
  // the SELECT.
  if (preflightRow.legal_hold === true) {
    throw new TenantLegalHoldError(
      parsedId,
      'tenant',
      '(tenant.legal_hold boolean set; no granular legal_hold record)',
      '(unknown — pre-table fast path)',
    );
  }
  await db.transaction(async (tx) => {
    await bindTenantToDbSession(tx, parsedId);
    const activeHolds = await tx
      .select()
      .from(legalHold)
      .where(and(eq(legalHold.tenant_id, parsedId), isNull(legalHold.released_at)))
      .limit(1);
    const activeHold = activeHolds[0];
    if (activeHold !== undefined) {
      throw new TenantLegalHoldError(
        parsedId,
        activeHold.scope,
        activeHold.reason,
        activeHold.set_by_user_id,
      );
    }
  });

  // PHASE 3: external resource cascade (Cloud Run / GCS / Cloud SQL).
  // Outside any DB txn — these are network calls.

  // Step 1 — Cloud Run service delete (ENTERPRISE only; Phase 1 STUB).
  if (preflightRow.tier === 'ENTERPRISE') {
    // TODO ADR-INFRA-005 (per-tenant Cloud Run): delete the tenant's
    // Cloud Run service(s) here. Slice D's per-tenant TF module
    // ships the service registry; for now log a marker so operators
    // know the substrate gap exists.
    console.warn(
      `[tenants.terminate] TODO Cloud Run delete deferred for ENTERPRISE tenant ${parsedId} ` +
        `(ADR-INFRA-005 swap-path)`,
    );
  }

  // Step 2 — GCS prefix recursive delete (real per Q-NEW-C5).
  const env = (process.env.CORTEX_ENV as Environment | undefined) ?? 'dev';
  const bucketName = getTenantBucketName(env);
  const tenantPrefix = getTenantPrefix(parsedId); // 'tenants/{tenantId}/' (validated)
  const storage = options.cascadeOverrides?.storage ?? new Storage();
  await storage.bucket(bucketName).deleteFiles({ prefix: tenantPrefix, force: true });

  // Step 3 — Cloud SQL instance delete (ENTERPRISE only; Phase 1 STUB).
  if (preflightRow.tier === 'ENTERPRISE') {
    // TODO ADR-INFRA-005 (per-tenant Cloud SQL): delete the tenant's
    // dedicated Cloud SQL instance here. Slice D's per-tenant TF
    // module ships the instance registry.
    console.warn(
      `[tenants.terminate] TODO Cloud SQL delete deferred for ENTERPRISE tenant ${parsedId} ` +
        `(ADR-INFRA-005 swap-path)`,
    );
  }

  // PHASE 4: single txn — emit audit, hard-delete children, soft-retain
  // the tenant tombstone.
  const updatedTenant = await db.transaction(async (tx) => {
    await bindTenantToDbSession(tx, parsedId);

    // Re-read with row lock for race safety.
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
    // Race-safe idempotency: a parallel terminate may have completed
    // between Phase 1 and Phase 4. The cascade runs were idempotent
    // (GCS deleteFiles with force: true is a no-op when prefix is
    // empty); just return the tombstone.
    if (current.status === 'TERMINATED') {
      return current;
    }

    // Read kms_key_resource_name BEFORE deleting tenant_kms_key — we
    // need it in the audit payload as the tombstone signal (Q-NEW-C11).
    const kmsKeyRows = await tx
      .select()
      .from(tenantKmsKey)
      .where(eq(tenantKmsKey.tenant_id, parsedId))
      .limit(1);
    const kmsKeyResourceName = kmsKeyRows[0]?.kms_key_resource_name ?? null;

    // Emit TENANT_TERMINATED BEFORE the deletes — RLS write policy on
    // audit_event needs `app.tenant_id` bound (it is) and the tenant
    // row to be in scope. Soft-retain UPDATE comes after so the
    // tenant row is still tier='ENTERPRISE'/'STANDARD' for the audit
    // before_state snapshot.
    await emitAuditEvent(tx, {
      tenantId: parsedId,
      actorType: parsedActor.type,
      actorId: parsedActor.id,
      ...(parsedActor.description !== undefined && { actorDescription: parsedActor.description }),
      action: getActionByName(TENANT_AUDIT_ACTIONS, 'TENANT_TERMINATED'),
      verb: 'DELETE',
      resource: `tenant:${parsedId}`,
      // DELETE verb: only before_state. Soft-retain UPDATE to
      // status='TERMINATED' is below; the audit row's role is the
      // pre-termination snapshot for the forensic chain.
      before_state: {
        status: current.status,
        tier: current.tier,
        external_id: current.external_id,
        display_name: current.display_name,
        kms_key_resource_name: kmsKeyResourceName,
        offboarding_grace_until: current.offboarding_grace_until?.toISOString() ?? null,
      },
      payload: {
        cascade_steps: {
          cloud_run_delete:
            current.tier === 'ENTERPRISE' ? 'STUB_TODO_ADR_INFRA_005' : 'NA_STANDARD',
          gcs_prefix_delete: 'EXECUTED',
          cloud_sql_delete:
            current.tier === 'ENTERPRISE' ? 'STUB_TODO_ADR_INFRA_005' : 'NA_STANDARD',
          shared_db_delete: 'EXECUTED',
          kms_destroy: 'TOMBSTONE_ONLY_PHASE_1',
        },
        kms_key_resource_name: kmsKeyResourceName,
      },
    });

    // Hard-delete children. legal_hold rows (active + released) are
    // wiped per spec §3 "deletes every tenant-scoped trace"; the audit
    // chain (preserved by ADR-DB-003 append-only) is the historical
    // record. Order doesn't matter here — none of these tables FK each
    // other; all FK to `tenant` (which we soft-retain).
    await tx.delete(legalHold).where(eq(legalHold.tenant_id, parsedId));
    await tx.delete(tenantKmsKey).where(eq(tenantKmsKey.tenant_id, parsedId));
    await tx.delete(tenantConfigVersion).where(eq(tenantConfigVersion.tenant_id, parsedId));
    await tx.delete(tenantQuotaUsage).where(eq(tenantQuotaUsage.tenant_id, parsedId));

    // Soft-retain the tenant row as a tombstone (Q-NEW-C8).
    const updated = await tx
      .update(tenant)
      .set({
        status: 'TERMINATED',
        terminated_at: msNow,
        updated_at: msNow,
      })
      .where(eq(tenant.id, parsedId))
      .returning();
    const next = updated[0];
    if (next === undefined) {
      throw new Error(`tenants.terminate: UPDATE returned no row for tenant ${parsedId}`);
    }
    return next;
  });

  return updatedTenant;
}

// ─────────────────────────────────────────────────────────────────────
// F02 lifecycle workflow — forceTerminate (Slice C sub-phase 7.5)
// ─────────────────────────────────────────────────────────────────────

const forceTerminateReasonSchema = z.string().min(1).max(2000);

/**
 * Super Admin override path for tenant termination.
 *
 * Per F02 Slice C SC2 lock + convention §6.4: emits the dedicated
 * `TENANT_FORCE_TERMINATED` action (NOT `TENANT_TERMINATED`) so
 * compliance regulators can grep for "any tenant terminated despite an
 * active hold or before grace elapsed" without parsing payload metadata.
 *
 * Differences from `tenants.terminate`:
 *
 *   - **Skips legal-hold check.** The whole point of the override.
 *     Active hold details are STILL captured in the audit payload
 *     (`override_metadata.active_legal_hold`) for forensic
 *     attribution — operators reviewing the override can see
 *     exactly what hold was bypassed.
 *   - **Skips grace-period check.** OFFBOARDING tenants can be
 *     force-terminated mid-grace; ACTIVE / SUSPENDED tenants skip
 *     OFFBOARDING entirely. Whether the grace was actually skipped
 *     is captured in `override_metadata.skipped_grace_period`.
 *   - **Requires `reason`** — the operator's justification, captured
 *     in `payload.reason` for the forensic chain. Length-validated
 *     (1-2000 chars) since this is the audit row's narrative
 *     attribution.
 *   - **Allowed transitions:** ACTIVE / SUSPENDED / OFFBOARDING →
 *     TERMINATED. ALLOWED_TRANSITIONS already permits all three
 *     (Slice A's pre-flight pre-validated this). Other states
 *     (REQUESTED, PROVISIONING, READY) reject — those tenants haven't
 *     gone public yet; use `cleanupFailedProvisioning` instead.
 *
 * Same as `tenants.terminate` for everything else: 5-step cascade
 * (Cloud Run STUB / GCS recursive delete / Cloud SQL STUB / shared-DB
 * single txn / KMS tombstone-only); soft-retain tombstone with
 * children hard-deleted; `tenants.get` filters TERMINATED.
 *
 * Authz: Phase 1 has no enforcement at this layer — anything that
 * imports the package can call. AC01 will gate via per-method authz
 * (recorded as a deviation in F02 deviations).
 *
 * @throws TenantValidationError invalid id, reason, or actor.
 * @throws TenantNotFoundError no row matches `id`.
 * @throws TenantStatusError current status disallows TERMINATED
 *   (e.g., REQUESTED, PROVISIONING, READY).
 */
async function forceTerminate(
  db: NodePgDatabase<Record<string, never>>,
  id: string,
  reason: string,
  ctx: { actor: Actor },
  options: TerminateOptions = {},
): Promise<Tenant> {
  const parsedId = parseOrThrow(idSchema, id, 'forceTerminate id');
  const parsedReason = parseOrThrow(forceTerminateReasonSchema, reason, 'forceTerminate reason');
  const parsedActor = parseOrThrow(actorSchema, ctx.actor, 'forceTerminate actor');

  // PHASE 1: idempotent fast-path. TERMINATED → return tombstone.
  const preflight = await db.select().from(tenant).where(eq(tenant.id, parsedId)).limit(1);
  const preflightRow = preflight[0];
  if (preflightRow === undefined) {
    throw new TenantNotFoundError(parsedId, 'id');
  }
  if (preflightRow.status === 'TERMINATED') {
    return preflightRow;
  }

  // PHASE 2: validate transition. ACTIVE/SUSPENDED/OFFBOARDING only.
  // Skip grace-period and legal-hold checks (override semantics).
  assertTransitionAllowed(parsedId, preflightRow.status, 'TERMINATED');

  // PHASE 3: capture override forensics — active legal hold + skipped
  // grace period — for the audit payload. We intentionally don't
  // BLOCK on these; we just record what's being bypassed.
  let activeLegalHoldDetails: {
    scope: 'tenant' | 'record' | 'data_class';
    reason: string;
    set_by_user_id: string;
  } | null = null;
  let skippedLegalHoldBoolean = false;

  if (preflightRow.legal_hold === true) {
    skippedLegalHoldBoolean = true;
  }
  await db.transaction(async (tx) => {
    await bindTenantToDbSession(tx, parsedId);
    const activeHolds = await tx
      .select()
      .from(legalHold)
      .where(and(eq(legalHold.tenant_id, parsedId), isNull(legalHold.released_at)))
      .limit(1);
    const hold = activeHolds[0];
    if (hold !== undefined) {
      activeLegalHoldDetails = {
        scope: hold.scope,
        reason: hold.reason,
        set_by_user_id: hold.set_by_user_id,
      };
    }
  });

  const now = new Date();
  const skippedGracePeriod =
    preflightRow.status === 'OFFBOARDING' &&
    preflightRow.offboarding_grace_until !== null &&
    now < preflightRow.offboarding_grace_until;

  // PHASE 4: external resource cascade (same as terminate).
  if (preflightRow.tier === 'ENTERPRISE') {
    console.warn(
      `[tenants.forceTerminate] TODO Cloud Run delete deferred for ENTERPRISE tenant ${parsedId} ` +
        `(ADR-INFRA-005 swap-path)`,
    );
  }

  const env = (process.env.CORTEX_ENV as Environment | undefined) ?? 'dev';
  const bucketName = getTenantBucketName(env);
  const tenantPrefix = getTenantPrefix(parsedId);
  const storage = options.cascadeOverrides?.storage ?? new Storage();
  await storage.bucket(bucketName).deleteFiles({ prefix: tenantPrefix, force: true });

  if (preflightRow.tier === 'ENTERPRISE') {
    console.warn(
      `[tenants.forceTerminate] TODO Cloud SQL delete deferred for ENTERPRISE tenant ${parsedId} ` +
        `(ADR-INFRA-005 swap-path)`,
    );
  }

  // PHASE 5: single txn — emit TENANT_FORCE_TERMINATED, hard-delete
  // children, soft-retain tenant tombstone.
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
    if (current.status === 'TERMINATED') {
      return current;
    }

    const kmsKeyRows = await tx
      .select()
      .from(tenantKmsKey)
      .where(eq(tenantKmsKey.tenant_id, parsedId))
      .limit(1);
    const kmsKeyResourceName = kmsKeyRows[0]?.kms_key_resource_name ?? null;

    await emitAuditEvent(tx, {
      tenantId: parsedId,
      actorType: parsedActor.type,
      actorId: parsedActor.id,
      ...(parsedActor.description !== undefined && { actorDescription: parsedActor.description }),
      action: getActionByName(TENANT_AUDIT_ACTIONS, 'TENANT_FORCE_TERMINATED'),
      verb: 'DELETE',
      resource: `tenant:${parsedId}`,
      before_state: {
        status: current.status,
        tier: current.tier,
        external_id: current.external_id,
        display_name: current.display_name,
        kms_key_resource_name: kmsKeyResourceName,
        offboarding_grace_until: current.offboarding_grace_until?.toISOString() ?? null,
        legal_hold: current.legal_hold,
      },
      payload: {
        reason: parsedReason,
        cascade_steps: {
          cloud_run_delete:
            current.tier === 'ENTERPRISE' ? 'STUB_TODO_ADR_INFRA_005' : 'NA_STANDARD',
          gcs_prefix_delete: 'EXECUTED',
          cloud_sql_delete:
            current.tier === 'ENTERPRISE' ? 'STUB_TODO_ADR_INFRA_005' : 'NA_STANDARD',
          shared_db_delete: 'EXECUTED',
          kms_destroy: 'TOMBSTONE_ONLY_PHASE_1',
        },
        kms_key_resource_name: kmsKeyResourceName,
        // Override forensics — the operator reviewing this audit row
        // can see exactly what protective check was bypassed and why.
        override_metadata: {
          skipped_legal_hold: skippedLegalHoldBoolean || activeLegalHoldDetails !== null,
          skipped_grace_period: skippedGracePeriod,
          ...(activeLegalHoldDetails !== null && {
            active_legal_hold: activeLegalHoldDetails,
          }),
          ...(skippedLegalHoldBoolean && {
            tenant_legal_hold_boolean_was_set: true,
          }),
        },
      },
    });

    await tx.delete(legalHold).where(eq(legalHold.tenant_id, parsedId));
    await tx.delete(tenantKmsKey).where(eq(tenantKmsKey.tenant_id, parsedId));
    await tx.delete(tenantConfigVersion).where(eq(tenantConfigVersion.tenant_id, parsedId));
    await tx.delete(tenantQuotaUsage).where(eq(tenantQuotaUsage.tenant_id, parsedId));

    const updated = await tx
      .update(tenant)
      .set({
        status: 'TERMINATED',
        terminated_at: msNow,
        updated_at: msNow,
      })
      .where(eq(tenant.id, parsedId))
      .returning();
    const next = updated[0];
    if (next === undefined) {
      throw new Error(`tenants.forceTerminate: UPDATE returned no row for tenant ${parsedId}`);
    }
    return next;
  });

  return updatedTenant;
}

// ─────────────────────────────────────────────────────────────────────
// F02 lifecycle workflow — rotateKeys (Slice D D.2)
// ─────────────────────────────────────────────────────────────────────

const rotateKeysOptionsSchema = z
  .object({
    /**
     * Discriminates scheduled (90-day cadence) from on-demand (operator
     * trigger). Scheduled rotations within the 24-hour cooldown of the
     * previous rotation no-op (idempotent re-dispatch protection per
     * §7.5); on-demand rotations always proceed.
     */
    trigger: z.enum(['scheduled', 'on_demand'] as const),
    /**
     * When true and a scheduled rotation hits the cooldown, throw
     * `TenantRotationCooldownError` instead of silently no-op'ing.
     * Default false. Cloud Tasks worker route uses default behavior;
     * an HTTP API caller may opt in for explicit feedback.
     */
    errorOnCooldown: z.boolean().default(false),
  })
  .strict();

export type RotateKeysOptions = z.input<typeof rotateKeysOptionsSchema>;

const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Rotate the tenant's CMEK key. Phase sequence (single transaction
 * for the DB writes; KMS schedule-destroy is the one side effect
 * that lives outside the txn — it runs last so a txn rollback
 * cannot orphan a destruction schedule):
 *
 *   1. SELECT ... FOR UPDATE on the tenant row (concurrency guard).
 *   2. Preflight: tenant exists; status === ACTIVE.
 *   3. Idempotency: scheduled trigger within 24 h of last rotation
 *      → no-op (return current row); on-demand always proceeds.
 *   4. KMS createCryptoKeyVersion + updateCryptoKeyPrimaryVersion
 *      via `kmsAdmin.rotateCryptoKey` on the tenant's logical key.
 *   5. UPDATE `tenant_kms_key.rotated_at = now()`.
 *   6. UPDATE `tenant.last_key_rotated_at = now()`.
 *   7. Emit `TENANT_KEY_ROTATED` audit (catalog action; no new
 *      registration). before_state / after_state envelope carries
 *      the version-qualified resource names (workspace standard).
 *   8. Schedule old version destruction (KMS destroyCryptoKeyVersion
 *      with the crypto-key's destroyScheduledDuration governing the
 *      30-day window per SD6). Failure here is logged + warned but
 *      does NOT roll back the rotation — the operator runbook in
 *      §7.5 covers manual cleanup.
 *
 * Per Q-NEW-D-12 + convention §7.2: dual-key overlap is functionally
 * infinite at the application layer (envelope encryption records the
 * encrypting key version per payload; decrypts use the recorded
 * version regardless of current primary). The 30-day KMS window is
 * incident-recovery margin, not a functional read window.
 *
 * @throws TenantValidationError invalid id / actor / options.
 * @throws TenantNotFoundError no tenant row matches `id`.
 * @throws TenantStatusError tenant exists but status !== ACTIVE.
 * @throws TenantRotationCooldownError only when `options.errorOnCooldown=true`
 *         AND scheduled trigger AND within 24 h cooldown.
 */
async function rotateKeys(
  db: NodePgDatabase<Record<string, never>>,
  id: string,
  ctx: { actor: Actor },
  options: RotateKeysOptions,
): Promise<Tenant> {
  const parsedId = parseOrThrow(idSchema, id, 'rotateKeys id');
  const parsedActor = parseOrThrow(actorSchema, ctx.actor, 'rotateKeys actor');
  const parsedOptions = parseOrThrow(rotateKeysOptionsSchema, options, 'rotateKeys options');

  // Step 1+2+3+5+6+7 inside one transaction. Step 4 (KMS) sits inside
  // the txn so a KMS failure rolls back the row writes (no half-state).
  // Step 8 (KMS scheduleDestroy) runs AFTER commit so a rollback never
  // orphans a destruction schedule.
  const result = await db.transaction(async (tx) => {
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

    // Status guard: only ACTIVE tenants rotate. SUSPENDED tenants
    // cannot mutate; OFFBOARDING / TERMINATED tenants are on the
    // teardown path and their keys are scheduled for tombstone via
    // tenants.terminate, not rotation.
    if (current.status !== 'ACTIVE') {
      throw new TenantStatusError(parsedId, current.status, ['ACTIVE']);
    }

    // Idempotency / cooldown for scheduled re-dispatch.
    const lastRotatedAt = current.last_key_rotated_at;
    if (
      parsedOptions.trigger === 'scheduled' &&
      lastRotatedAt !== null &&
      Date.now() - lastRotatedAt.getTime() < COOLDOWN_MS
    ) {
      if (parsedOptions.errorOnCooldown) {
        throw new TenantRotationCooldownError(
          parsedId,
          lastRotatedAt,
          new Date(lastRotatedAt.getTime() + COOLDOWN_MS),
        );
      }
      return { row: current, oldVersion: null, newVersion: null };
    }

    // Resolve the tenant's logical key resource name. RLS read is
    // satisfied by the bind above. Both kms_key_resource_name + the
    // version-qualified primary version flow into the audit chain.
    const kmsRows = await tx
      .select()
      .from(tenantKmsKey)
      .where(eq(tenantKmsKey.tenant_id, parsedId))
      .limit(1);
    const kmsRow = kmsRows[0];
    if (kmsRow === undefined) {
      // tenant_kms_key is provisioned at tenants.create time; absence
      // here is a substrate corruption.
      throw new Error(`tenants.rotateKeys: tenant_kms_key row missing for ${parsedId}`);
    }

    const { oldPrimaryVersion, newPrimaryVersion } = await kmsAdmin.rotateCryptoKey(
      kmsRow.kms_key_resource_name,
    );

    await tx
      .update(tenantKmsKey)
      .set({ rotated_at: msNow })
      .where(eq(tenantKmsKey.tenant_id, parsedId));

    const updated = await tx
      .update(tenant)
      .set({ last_key_rotated_at: msNow, updated_at: msNow })
      .where(eq(tenant.id, parsedId))
      .returning();
    const next = updated[0];
    if (next === undefined) {
      throw new Error('tenants.rotateKeys: UPDATE returned no row');
    }

    await emitAuditEvent(tx, {
      tenantId: parsedId,
      actorType: parsedActor.type,
      actorId: parsedActor.id,
      ...(parsedActor.description !== undefined && { actorDescription: parsedActor.description }),
      action: getActionByName(TENANT_AUDIT_ACTIONS, 'TENANT_KEY_ROTATED'),
      verb: 'UPDATE',
      resource: `tenant:${parsedId}`,
      before_state: { kms_key_resource_name: oldPrimaryVersion },
      after_state: { kms_key_resource_name: newPrimaryVersion },
      payload: { trigger: parsedOptions.trigger },
    });

    return { row: next, oldVersion: oldPrimaryVersion, newVersion: newPrimaryVersion };
  });

  // Step 8: post-commit KMS schedule-destroy on the OLD version.
  // No-op when oldVersion is null (cooldown no-op path).
  if (result.oldVersion !== null) {
    try {
      await kmsAdmin.scheduleCryptoKeyVersionDestroy(result.oldVersion);
    } catch (err) {
      // Best-effort: rotation already committed. Log + continue.
      // §7.5 operator runbook covers manual cleanup if this fails.
      console.warn(
        `tenants.rotateKeys: KMS scheduleDestroy failed for ${result.oldVersion}; ` +
          `rotation committed but old version not scheduled for destruction. ` +
          `Cause: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result.row;
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
  terminate,
  forceTerminate,
  rotateKeys,
};
