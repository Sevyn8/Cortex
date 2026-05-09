/**
 * F04 Slice B lifecycle helpers — `createDraft`, `updateDraft`,
 * `discardDraft`. The user-driven write path for F04 configuration.
 *
 * Each helper opens its own `db.transaction` (matches F02 precedent),
 * binds tenant context for RLS, performs the mutation, emits the
 * appropriate audit event, and returns / throws as documented.
 *
 * Locks captured (per docs/planning/p1.4-f04-configuration-plane-
 * scope.md + Slice B HOLD #1):
 *   D3       — separate config_draft table; author-only via
 *              created_by_user_id filter pre-AC01.
 *   Q-NEW-F04B-1  active drafts UNIQUE (tenant, namespace, author)
 *   Q-NEW-F04B-7  optimistic UPDATE with expected updated_at;
 *                 mismatch → DraftConcurrencyError (409 at HTTP).
 *   Q-NEW-F04B-8  Actor accepts user/service/system; actor.id is
 *                 recorded as created_by_user_id.
 *   Q-NEW-F04B-9  schemaVersion is EXPLICIT on createDraft;
 *                 callers wanting "latest" use
 *                 getLatestRegisteredVersion(namespace).
 */

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z, type ZodError } from 'zod';
import { configDraft, type ConfigDraft } from '@cortex/canonical-schema';
import { emitAuditEvent, getActionByName } from '@cortex/audit-events';
import { CONFIG_AUDIT_ACTIONS } from './audit-actions.js';
import { actorSchema, type Actor } from './types.js';
import { getNamespaceSchema } from './schema-registry.js';

// ──────────────────────────────────────────────────────────────────────
// Errors (forward-declare; used by promoteDraft below)
// ──────────────────────────────────────────────────────────────────────

export class PromoteValidationError extends Error {
  public readonly draftId: string;
  public readonly errors: ZodError;
  constructor(draftId: string, errors: ZodError) {
    super(
      `config-plane: cannot promote draft ${draftId} — re-validation failed (${errors.issues.length} issue(s) per Q-NEW-F04B-6 defensive re-validate).`,
    );
    this.name = 'PromoteValidationError';
    this.draftId = draftId;
    this.errors = errors;
  }
}

export class PromoteConcurrencyError extends Error {
  constructor(tenantId: string, namespace: string) {
    super(
      `config-plane: promote of (tenant=${tenantId}, namespace=${namespace}) lost the race after retry; ` +
        'another writer concurrently promoted into the same namespace. Refresh draft state and retry per D13 optimistic-concurrency contract.',
    );
    this.name = 'PromoteConcurrencyError';
  }
}

export class RollbackAtGenesisError extends Error {
  constructor(tenantId: string, namespace: string) {
    super(
      `config-plane: cannot rollback (tenant=${tenantId}, namespace=${namespace}) — current latest version is genesis (parent_version_id IS NULL). ` +
        'Rollback requires a prior version in the chain.',
    );
    this.name = 'RollbackAtGenesisError';
  }
}

export class RollbackNoVersionError extends Error {
  constructor(tenantId: string, namespace: string) {
    super(
      `config-plane: cannot rollback (tenant=${tenantId}, namespace=${namespace}) — no version exists for this (tenant, namespace). ` +
        'Promote a draft first before attempting rollback.',
    );
    this.name = 'RollbackNoVersionError';
  }
}

export class RollbackConcurrencyError extends Error {
  constructor(tenantId: string, namespace: string) {
    super(
      `config-plane: rollback of (tenant=${tenantId}, namespace=${namespace}) lost the race after retry; ` +
        'another writer concurrently mutated the version chain. Refresh and retry per D13 optimistic-concurrency contract.',
    );
    this.name = 'RollbackConcurrencyError';
  }
}

// ──────────────────────────────────────────────────────────────────────
// Tenant binding (inlined — avoids dependency on @cortex/tenant-context)
// ──────────────────────────────────────────────────────────────────────

/**
 * Bind `app.tenant_id` for the current transaction so RLS policies on
 * config_draft + tenant_config_version resolve to the supplied tenant.
 * Inlined here so `@cortex/config-plane` stays a leaf w.r.t.
 * `@cortex/tenant-context`. Same `set_config(..., true)` shape as
 * tenant-context's helper.
 */
async function bindTenant(
  tx: NodePgDatabase<Record<string, never>>,
  tenantId: string,
): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
}

// ──────────────────────────────────────────────────────────────────────
// Validation schemas
// ──────────────────────────────────────────────────────────────────────

const tenantIdSchema = z.string().uuid();
const draftIdSchema = z.string().uuid();
const namespaceSchema = z.string().min(1).max(255);
const schemaVersionSchema = z.number().int().positive();
const draftJsonSchema = z.record(z.string(), z.unknown());

// ──────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────

export class DraftConcurrencyError extends Error {
  constructor(draftId: string) {
    super(
      `config-plane: draft ${draftId} was concurrently updated by another caller; ` +
        'refresh the draft and retry with the new updated_at.',
    );
    this.name = 'DraftConcurrencyError';
  }
}

export class DraftNotFoundError extends Error {
  constructor(draftId: string) {
    super(
      `config-plane: draft ${draftId} not found, not active, or not owned by the supplied actor. ` +
        "(Pre-AC01 author-only enforcement: the actor.id must match the draft's created_by_user_id.)",
    );
    this.name = 'DraftNotFoundError';
  }
}

export class SchemaNotRegisteredError extends Error {
  constructor(namespace: string, version: number) {
    super(
      `config-plane: no schema registered for namespace ${JSON.stringify(namespace)} v=${version}. ` +
        'Register the schema via registerNamespaceSchema before creating drafts.',
    );
    this.name = 'SchemaNotRegisteredError';
  }
}

// ──────────────────────────────────────────────────────────────────────
// createDraft
// ──────────────────────────────────────────────────────────────────────

export interface CreateDraftParams {
  tenantId: string;
  namespace: string;
  /** Schema version to pin against (Q-NEW-F04B-9: explicit). */
  schemaVersion: number;
  draftJson: Record<string, unknown>;
  actor: Actor;
}

/**
 * Create a new active draft. Pre-checks that the schema is registered
 * for `(namespace, schemaVersion)` so callers don't get a deferred
 * surprise at validateDraft time. UNIQUE constraint on
 * `(tenant_id, namespace, created_by_user_id) WHERE status='active'`
 * (Q-NEW-F04B-1) means a second active draft from the same author
 * will fail with SQLSTATE 23505 — caller decides whether to surface
 * or merge.
 *
 * Emits `CONFIG_DRAFT_CREATED` (verb: CREATE).
 */
export async function createDraft(
  db: NodePgDatabase<Record<string, never>>,
  params: CreateDraftParams,
): Promise<ConfigDraft> {
  const tenantId = tenantIdSchema.parse(params.tenantId);
  const namespace = namespaceSchema.parse(params.namespace);
  const schemaVersion = schemaVersionSchema.parse(params.schemaVersion);
  const draftJson = draftJsonSchema.parse(params.draftJson);
  const actor = actorSchema.parse(params.actor);

  // Pre-check schema registration. Fail fast at create time so callers
  // don't get surprised at validateDraft.
  if (getNamespaceSchema(namespace, schemaVersion) === undefined) {
    throw new SchemaNotRegisteredError(namespace, schemaVersion);
  }

  return db.transaction(async (tx) => {
    await bindTenant(tx, tenantId);

    const inserted = await tx
      .insert(configDraft)
      .values({
        tenant_id: tenantId,
        namespace,
        schema_version: schemaVersion,
        draft_json: draftJson,
        created_by_user_id: actor.id,
      })
      .returning();
    const row = inserted[0];
    if (row === undefined) {
      throw new Error('config-plane: createDraft INSERT returned no row');
    }

    await emitAuditEvent(tx, {
      tenantId,
      actorType: actor.type,
      actorId: actor.id,
      ...(actor.description !== undefined && { actorDescription: actor.description }),
      action: getActionByName(CONFIG_AUDIT_ACTIONS, 'CONFIG_DRAFT_CREATED'),
      verb: 'CREATE',
      resource: `config_draft:${row.id}`,
      after_state: {
        namespace,
        schema_version: schemaVersion,
        status: 'active',
      },
    });

    return row;
  });
}

// ──────────────────────────────────────────────────────────────────────
// updateDraft
// ──────────────────────────────────────────────────────────────────────

export interface UpdateDraftParams {
  draftId: string;
  draftJson: Record<string, unknown>;
  /** Optimistic concurrency check (Q-NEW-F04B-7). */
  expectedUpdatedAt: Date;
  actor: Actor;
}

/**
 * Update a draft's `draft_json`. Optimistic concurrency on
 * `updated_at` per Q-NEW-F04B-7: the UPDATE only succeeds if the
 * supplied `expectedUpdatedAt` matches the row's current value.
 * Mismatch → `DraftConcurrencyError` (intended for HTTP 409).
 *
 * Author-only enforcement (D3 sub-lock pre-AC01): the UPDATE filters
 * on `created_by_user_id = actor.id` in addition to draft id. If the
 * draft exists but isn't owned by the supplied actor, the UPDATE
 * affects 0 rows and `DraftNotFoundError` raises.
 *
 * Resets `validation_state` to `'unvalidated'` and clears
 * `validation_errors` — any prior validation outcome is stale once
 * the draft_json changes. Caller MUST re-validate before promoting.
 *
 * Emits `CONFIG_DRAFT_UPDATED` (verb: UPDATE; before/after capture
 * the updated_at transition for forensic trace).
 */
export async function updateDraft(
  db: NodePgDatabase<Record<string, never>>,
  tenantId: string,
  params: UpdateDraftParams,
): Promise<ConfigDraft> {
  const validatedTenantId = tenantIdSchema.parse(tenantId);
  const draftId = draftIdSchema.parse(params.draftId);
  const draftJson = draftJsonSchema.parse(params.draftJson);
  const actor = actorSchema.parse(params.actor);
  const expectedUpdatedAt = params.expectedUpdatedAt;

  return db.transaction(async (tx) => {
    await bindTenant(tx, validatedTenantId);

    const updated = await tx.execute<ConfigDraft>(sql`
      UPDATE config_draft
        SET draft_json       = ${JSON.stringify(draftJson)}::jsonb,
            updated_at       = date_trunc('millisecond', now()),
            validation_state = 'unvalidated',
            validation_errors = NULL
        WHERE id = ${draftId}
          AND created_by_user_id = ${actor.id}
          AND status = 'active'
          AND updated_at = ${expectedUpdatedAt.toISOString()}::timestamptz
        RETURNING *
    `);

    if (updated.rows.length === 0) {
      // 0 rows could mean: concurrency miss (updated_at changed),
      // not-found, not-active, or wrong author. Probe to disambiguate
      // — concurrency miss returns a clear 409-shaped error; the
      // others return 404-shaped.
      const probe = await tx.execute<{ exists: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM config_draft
          WHERE id = ${draftId}
            AND created_by_user_id = ${actor.id}
            AND status = 'active'
        ) AS exists
      `);
      if (probe.rows[0]?.exists === true) {
        throw new DraftConcurrencyError(draftId);
      }
      throw new DraftNotFoundError(draftId);
    }

    const row = updated.rows[0]!;

    await emitAuditEvent(tx, {
      tenantId: validatedTenantId,
      actorType: actor.type,
      actorId: actor.id,
      ...(actor.description !== undefined && { actorDescription: actor.description }),
      action: getActionByName(CONFIG_AUDIT_ACTIONS, 'CONFIG_DRAFT_UPDATED'),
      verb: 'UPDATE',
      resource: `config_draft:${draftId}`,
      before_state: { updated_at: expectedUpdatedAt.toISOString() },
      after_state: {
        updated_at:
          row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      },
    });

    return row;
  });
}

// ──────────────────────────────────────────────────────────────────────
// promoteDraft
// ──────────────────────────────────────────────────────────────────────

export interface PromoteDraftParams {
  draftId: string;
  actor: Actor;
}

export interface PromoteDraftResult {
  /** New tenant_config_version row id created by the promote. */
  versionId: string;
  /** New version_number (parent.version_number + 1, or 1 if first). */
  versionNumber: number;
  /** The draft, now with status='promoted' + promoted_to_version_id set. */
  draft: ConfigDraft;
}

/**
 * Promote a draft to a new `tenant_config_version` row. Atomic across:
 *   1. Defensive re-validate (Q-NEW-F04B-6).
 *   2. INSERT new version with `version_number = parent.version_number
 *      + 1` and `parent_version_id = parent.id` — computed atomically
 *      inside the INSERT subquery.
 *   3. UPDATE draft.status='promoted' + draft.promoted_to_version_id
 *      = new version's id.
 *   4. Emit `CONFIG_VERSION_PROMOTED` (verb: CREATE; after_state
 *      captures the new version's namespace + version_number +
 *      schema_version + draft_id reference).
 *
 * Optimistic concurrency (D13): the UNIQUE constraint on
 * (tenant_id, namespace, version_number) catches concurrent promotes.
 * The INSERT attempts up to **twice** — first with the parent the
 * function computes from a SELECT-MAX subquery, and on 23505 conflict
 * retries the WHOLE transaction once with a fresh MAX. Two
 * consecutive 23505s → `PromoteConcurrencyError`.
 *
 * Retry must wrap the entire transaction (not just the INSERT)
 * because Postgres aborts the transaction on first error; subsequent
 * commands fail until ROLLBACK. So each retry opens a fresh
 * `db.transaction(...)`. Validation + draft fetch + audit emission
 * also re-run on retry — keeps the trace honest about what landed
 * (audit row count = number of successful promotes, not attempts).
 *
 * Throws:
 *   - `DraftNotFoundError` — draft missing, not active, or not owned
 *     by actor.
 *   - `SchemaNotRegisteredError` — schema for draft's
 *     `(namespace, schema_version)` deregistered between
 *     createDraft and promoteDraft.
 *   - `PromoteValidationError` — defensive re-validate failed
 *     (per Q-NEW-F04B-6). Caller must updateDraft + re-validate
 *     before retrying.
 *   - `PromoteConcurrencyError` — both attempts hit 23505. Caller
 *     refreshes draft state + retries (the calling layer; the
 *     library is one-retry).
 */
export async function promoteDraft(
  db: NodePgDatabase<Record<string, never>>,
  tenantId: string,
  params: PromoteDraftParams,
): Promise<PromoteDraftResult> {
  const validatedTenantId = tenantIdSchema.parse(tenantId);
  const draftId = draftIdSchema.parse(params.draftId);
  const actor = actorSchema.parse(params.actor);

  try {
    return await attemptPromote(db, validatedTenantId, draftId, actor);
  } catch (err) {
    if (isUniqueViolation(err)) {
      try {
        return await attemptPromote(db, validatedTenantId, draftId, actor);
      } catch (err2) {
        if (isUniqueViolation(err2)) {
          // Need namespace for the error; we lost the draft fetch on
          // the failed attempt. Re-fetch JUST the namespace for the
          // error message. (Cheap; outside the transaction.)
          const { rows } = await db.execute<{ namespace: string }>(sql`
            SELECT namespace FROM config_draft WHERE id = ${draftId}
          `);
          throw new PromoteConcurrencyError(validatedTenantId, rows[0]?.namespace ?? '<unknown>');
        }
        throw err2;
      }
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

async function attemptPromote(
  db: NodePgDatabase<Record<string, never>>,
  tenantId: string,
  draftId: string,
  actor: Actor,
): Promise<PromoteDraftResult> {
  return db.transaction(async (tx) => {
    await bindTenant(tx, tenantId);

    // 1. Fetch + lock the draft (author-only; FOR UPDATE prevents
    //    concurrent updateDraft/discardDraft from racing this
    //    promote).
    const fetched = await tx.execute<ConfigDraft>(sql`
      SELECT * FROM config_draft
        WHERE id = ${draftId}
          AND created_by_user_id = ${actor.id}
          AND status = 'active'
        FOR UPDATE
    `);
    if (fetched.rows.length === 0) {
      throw new DraftNotFoundError(draftId);
    }
    const draft = fetched.rows[0]!;

    // 2. Defensive re-validate (Q-NEW-F04B-6).
    const entry = getNamespaceSchema(draft.namespace, draft.schema_version);
    if (entry === undefined) {
      throw new SchemaNotRegisteredError(draft.namespace, draft.schema_version);
    }
    const parsed = entry.schema.safeParse(draft.draft_json);
    if (!parsed.success) {
      throw new PromoteValidationError(draftId, parsed.error);
    }

    // 3. INSERT new tenant_config_version row. Subquery atomically
    //    computes parent_version_id + version_number; UNIQUE
    //    (tenant_id, namespace, version_number) catches concurrent
    //    promotes (handled by the outer attempt-twice retry).
    const inserted = await tx.execute<{ id: string; version_number: number }>(sql`
      INSERT INTO tenant_config_version
        (tenant_id, namespace, version_number, parent_version_id, schema_version, config_json)
      VALUES (
        ${tenantId},
        ${draft.namespace},
        (SELECT COALESCE(MAX(version_number), 0) + 1 FROM tenant_config_version
          WHERE tenant_id = ${tenantId} AND namespace = ${draft.namespace}),
        (SELECT id FROM tenant_config_version
          WHERE tenant_id = ${tenantId} AND namespace = ${draft.namespace}
          ORDER BY version_number DESC LIMIT 1),
        ${draft.schema_version},
        ${JSON.stringify(draft.draft_json)}::jsonb
      )
      RETURNING id, version_number
    `);
    const newVersion = inserted.rows[0]!;

    // 4. UPDATE draft.status='promoted' + promoted_to_version_id.
    const updatedDraft = await tx.execute<ConfigDraft>(sql`
      UPDATE config_draft
        SET status = 'promoted',
            promoted_to_version_id = ${newVersion.id},
            validation_state = 'valid',
            validation_errors = NULL,
            updated_at = date_trunc('millisecond', now())
        WHERE id = ${draftId}
        RETURNING *
    `);

    // 5. Audit emission.
    await emitAuditEvent(tx, {
      tenantId,
      actorType: actor.type,
      actorId: actor.id,
      ...(actor.description !== undefined && { actorDescription: actor.description }),
      action: getActionByName(CONFIG_AUDIT_ACTIONS, 'CONFIG_VERSION_PROMOTED'),
      verb: 'CREATE',
      resource: `tenant_config_version:${newVersion.id}`,
      after_state: {
        namespace: draft.namespace,
        version_number: newVersion.version_number,
        schema_version: draft.schema_version,
        from_draft_id: draftId,
      },
    });

    return {
      versionId: newVersion.id,
      versionNumber: newVersion.version_number,
      draft: updatedDraft.rows[0]!,
    };
  });
}

// ──────────────────────────────────────────────────────────────────────
// rollbackVersion
// ──────────────────────────────────────────────────────────────────────

export interface RollbackVersionParams {
  namespace: string;
  actor: Actor;
}

export interface RollbackVersionResult {
  /** New tenant_config_version row id (the rollback row). */
  versionId: string;
  /** New version_number (current.version_number + 1). */
  versionNumber: number;
  /** Version we rolled back FROM (was the latest before rollback). */
  rolledBackFromVersionId: string;
  /** Version whose content is now active (current.parent_version_id). */
  rolledBackToVersionId: string;
}

/**
 * Roll back the latest version for `(tenant, namespace)` to its
 * parent's content. Whole-namespace per Q-NEW-F04B-3 — rolls back
 * the namespace as a unit; per-key rollback is structurally
 * incompatible with D1's row-per-(tenant, namespace, version) shape.
 *
 * Algorithm:
 *   1. Find current latest version for `(tenant, namespace)`.
 *   2. If no version exists → `RollbackNoVersionError`.
 *   3. If `current.parent_version_id IS NULL` (genesis) →
 *      `RollbackAtGenesisError`.
 *   4. Fetch parent (the version current was rolled back FROM, or
 *      the version current was promoted from).
 *   5. INSERT new rollback row:
 *        - `config_json` + `schema_version` copied from parent
 *        - `version_number` = current.version_number + 1 (append-only)
 *        - `parent_version_id` = current.id (chain integrity:
 *          rollback row points to the version it rolled back FROM)
 *   6. Emit `CONFIG_VERSION_ROLLED_BACK` (verb: CREATE; after_state
 *      captures namespace + new version_number + rolled_back_from
 *      reference).
 *
 * Optimistic concurrency: same UNIQUE-conflict retry pattern as
 * `promoteDraft` — `(tenant_id, namespace, version_number)` UNIQUE
 * catches concurrent rollback/promote attempts. Two consecutive
 * 23505s → `RollbackConcurrencyError`.
 *
 * Rollback ladder semantics: rolling back a rollback row works
 * naturally — current's parent is the previous-in-chain version.
 * E.g.: v=1 (genesis) → v=2 (promote) → rollback creates v=3
 * (config = v=1; parent = v=2) → rollback creates v=4 (config = v=2;
 * parent = v=3). Each rollback is the inverse of the operation
 * before it; chain integrity preserved across the ladder.
 *
 * Author note: rollback is NOT author-scoped. Any actor with valid
 * tenant context can rollback; audit captures the acting actor.
 * Future RBAC (AC01) may add a "rollback" capability gate at the
 * caller's HTTP-layer; this library doesn't enforce role.
 */
export async function rollbackVersion(
  db: NodePgDatabase<Record<string, never>>,
  tenantId: string,
  params: RollbackVersionParams,
): Promise<RollbackVersionResult> {
  const validatedTenantId = tenantIdSchema.parse(tenantId);
  const namespace = namespaceSchema.parse(params.namespace);
  const actor = actorSchema.parse(params.actor);

  try {
    return await attemptRollback(db, validatedTenantId, namespace, actor);
  } catch (err) {
    if (isUniqueViolation(err)) {
      try {
        return await attemptRollback(db, validatedTenantId, namespace, actor);
      } catch (err2) {
        if (isUniqueViolation(err2)) {
          throw new RollbackConcurrencyError(validatedTenantId, namespace);
        }
        throw err2;
      }
    }
    throw err;
  }
}

async function attemptRollback(
  db: NodePgDatabase<Record<string, never>>,
  tenantId: string,
  namespace: string,
  actor: Actor,
): Promise<RollbackVersionResult> {
  return db.transaction(async (tx) => {
    await bindTenant(tx, tenantId);

    // 1. Find current latest version. Inline type literal (not a
    // named interface) — drizzle's tx.execute<T> generic requires
    // T extends Record<string, unknown>; named interfaces don't
    // structurally match without an explicit index signature.
    const currentResult = await tx.execute<{
      id: string;
      version_number: number;
      parent_version_id: string | null;
    }>(sql`
      SELECT id, version_number, parent_version_id
        FROM tenant_config_version
        WHERE tenant_id = ${tenantId} AND namespace = ${namespace}
        ORDER BY version_number DESC
        LIMIT 1
        FOR UPDATE
    `);
    if (currentResult.rows.length === 0) {
      throw new RollbackNoVersionError(tenantId, namespace);
    }
    const current = currentResult.rows[0]!;

    // 2. Genesis guard.
    if (current.parent_version_id === null) {
      throw new RollbackAtGenesisError(tenantId, namespace);
    }

    // 3. Fetch parent for content + schema_version.
    const parentResult = await tx.execute<{
      config_json: Record<string, unknown>;
      schema_version: number;
    }>(sql`
      SELECT config_json, schema_version
        FROM tenant_config_version
        WHERE id = ${current.parent_version_id}
    `);
    if (parentResult.rows.length === 0) {
      // Defensive: parent_version_id pointed at a row that doesn't
      // exist. Should never happen given append-only invariant +
      // FK ON DELETE behavior; treat as a substrate violation.
      throw new Error(
        `config-plane: rollback found dangling parent_version_id ${current.parent_version_id} ` +
          `for (tenant=${tenantId}, namespace=${namespace}). Substrate violation.`,
      );
    }
    const parent = parentResult.rows[0]!;

    // 4. INSERT rollback row.
    const inserted = await tx.execute<{ id: string; version_number: number }>(sql`
      INSERT INTO tenant_config_version
        (tenant_id, namespace, version_number, parent_version_id, schema_version, config_json)
      VALUES (
        ${tenantId},
        ${namespace},
        ${current.version_number + 1},
        ${current.id},
        ${parent.schema_version},
        ${JSON.stringify(parent.config_json)}::jsonb
      )
      RETURNING id, version_number
    `);
    const newVersion = inserted.rows[0]!;

    // 5. Audit emission.
    await emitAuditEvent(tx, {
      tenantId,
      actorType: actor.type,
      actorId: actor.id,
      ...(actor.description !== undefined && { actorDescription: actor.description }),
      action: getActionByName(CONFIG_AUDIT_ACTIONS, 'CONFIG_VERSION_ROLLED_BACK'),
      verb: 'CREATE',
      resource: `tenant_config_version:${newVersion.id}`,
      after_state: {
        namespace,
        version_number: newVersion.version_number,
        schema_version: parent.schema_version,
        rolled_back_from_version_id: current.id,
        rolled_back_to_version_id: current.parent_version_id,
      },
    });

    return {
      versionId: newVersion.id,
      versionNumber: newVersion.version_number,
      rolledBackFromVersionId: current.id,
      rolledBackToVersionId: current.parent_version_id,
    };
  });
}

// ──────────────────────────────────────────────────────────────────────
// validateDraft
// ──────────────────────────────────────────────────────────────────────

export interface ValidateDraftParams {
  draftId: string;
  actor: Actor;
}

export type ValidateDraftResult =
  | { valid: true; draft: ConfigDraft }
  | { valid: false; draft: ConfigDraft; errors: ZodError };

/**
 * Validate a draft against its registered Zod schema. Updates
 * `validation_state` to `'valid'` or `'invalid'` and stores the Zod
 * error tree in `validation_errors` on failure. Idempotent — re-
 * running `validateDraft` re-evaluates against the latest draft_json
 * + schema registration; result reflects current state.
 *
 * Author-only (D3): UPDATE filters on `created_by_user_id = actor.id`.
 *
 * Emits `CONFIG_DRAFT_VALIDATED` (verb: READ; outcome metadata in
 * payload — `{ outcome: 'valid'|'invalid', namespace, schema_version,
 * error_count }`). READ verb is per Q-NEW-F04B-5: validation outcome
 * lives on the draft row's columns; audit captures the *attempt* +
 * outcome metadata, not a state diff.
 *
 * Throws:
 *   - `DraftNotFoundError` — draft missing, not active, or not owned
 *     by actor.
 *   - `SchemaNotRegisteredError` — no schema registered for the
 *     draft's pinned `(namespace, schema_version)`.
 */
export async function validateDraft(
  db: NodePgDatabase<Record<string, never>>,
  tenantId: string,
  params: ValidateDraftParams,
): Promise<ValidateDraftResult> {
  const validatedTenantId = tenantIdSchema.parse(tenantId);
  const draftId = draftIdSchema.parse(params.draftId);
  const actor = actorSchema.parse(params.actor);

  return db.transaction(async (tx) => {
    await bindTenant(tx, validatedTenantId);

    // Fetch the draft (author-only). Lock the row FOR UPDATE so the
    // validation-state UPDATE below is consistent with what we
    // validated.
    const fetched = await tx.execute<ConfigDraft>(sql`
      SELECT * FROM config_draft
        WHERE id = ${draftId}
          AND created_by_user_id = ${actor.id}
          AND status = 'active'
        FOR UPDATE
    `);
    if (fetched.rows.length === 0) {
      throw new DraftNotFoundError(draftId);
    }
    const draft = fetched.rows[0]!;

    const entry = getNamespaceSchema(draft.namespace, draft.schema_version);
    if (entry === undefined) {
      throw new SchemaNotRegisteredError(draft.namespace, draft.schema_version);
    }

    const parsed = entry.schema.safeParse(draft.draft_json);

    let result: ValidateDraftResult;
    if (parsed.success) {
      const updated = await tx.execute<ConfigDraft>(sql`
        UPDATE config_draft
          SET validation_state = 'valid',
              validation_errors = NULL,
              updated_at = date_trunc('millisecond', now())
          WHERE id = ${draftId}
          RETURNING *
      `);
      result = { valid: true, draft: updated.rows[0]! };
    } else {
      const errorJson = JSON.stringify(parsed.error.issues);
      const updated = await tx.execute<ConfigDraft>(sql`
        UPDATE config_draft
          SET validation_state = 'invalid',
              validation_errors = ${errorJson}::jsonb,
              updated_at = date_trunc('millisecond', now())
          WHERE id = ${draftId}
          RETURNING *
      `);
      result = { valid: false, draft: updated.rows[0]!, errors: parsed.error };
    }

    await emitAuditEvent(tx, {
      tenantId: validatedTenantId,
      actorType: actor.type,
      actorId: actor.id,
      ...(actor.description !== undefined && { actorDescription: actor.description }),
      action: getActionByName(CONFIG_AUDIT_ACTIONS, 'CONFIG_DRAFT_VALIDATED'),
      verb: 'READ',
      resource: `config_draft:${draftId}`,
      payload: {
        outcome: result.valid ? 'valid' : 'invalid',
        namespace: draft.namespace,
        schema_version: draft.schema_version,
        error_count: result.valid ? 0 : result.errors.issues.length,
      },
    });

    return result;
  });
}

// ──────────────────────────────────────────────────────────────────────
// discardDraft
// ──────────────────────────────────────────────────────────────────────

export interface DiscardDraftParams {
  draftId: string;
  actor: Actor;
}

/**
 * Mark a draft `status='discarded'`. Author-only — the actor.id must
 * match the draft's created_by_user_id; otherwise raises
 * `DraftNotFoundError` (treats not-found, not-active, and wrong-author
 * the same — caller can't distinguish someone else's draft from a
 * non-existent one).
 *
 * After discard, the (tenant, namespace, author) slot is freed (the
 * partial UNIQUE only covers `status='active'` rows), so the author
 * can immediately createDraft again.
 *
 * Emits `CONFIG_DRAFT_DISCARDED` (verb: DELETE; before_state captures
 * the active status the draft was in pre-discard).
 */
export async function discardDraft(
  db: NodePgDatabase<Record<string, never>>,
  tenantId: string,
  params: DiscardDraftParams,
): Promise<void> {
  const validatedTenantId = tenantIdSchema.parse(tenantId);
  const draftId = draftIdSchema.parse(params.draftId);
  const actor = actorSchema.parse(params.actor);

  await db.transaction(async (tx) => {
    await bindTenant(tx, validatedTenantId);

    const result = await tx.execute<{ id: string }>(sql`
      UPDATE config_draft
        SET status = 'discarded',
            updated_at = date_trunc('millisecond', now())
        WHERE id = ${draftId}
          AND created_by_user_id = ${actor.id}
          AND status = 'active'
        RETURNING id
    `);

    if (result.rows.length === 0) {
      throw new DraftNotFoundError(draftId);
    }

    await emitAuditEvent(tx, {
      tenantId: validatedTenantId,
      actorType: actor.type,
      actorId: actor.id,
      ...(actor.description !== undefined && { actorDescription: actor.description }),
      action: getActionByName(CONFIG_AUDIT_ACTIONS, 'CONFIG_DRAFT_DISCARDED'),
      verb: 'DELETE',
      resource: `config_draft:${draftId}`,
      before_state: { status: 'active' },
    });
  });
}
