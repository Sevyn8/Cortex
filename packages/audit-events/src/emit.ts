/**
 * Core emit function + hybrid DI for `@cortex/audit-events`.
 *
 * Caller contract (mirrors `packages/tenant-context/src/audit.ts` and
 * the convention doc landing in sub-phase 8):
 *
 *   - Caller MUST have bound a tenant id to the DB session via
 *     `bindTenantToDbSession` from `@cortex/tenant-context` BEFORE
 *     calling. `audit_event` enforces RLS keyed on
 *     `cortex.current_tenant_id()` — without the binding the INSERT
 *     raises SQLSTATE 42501 and we surface that as
 *     `AuditEventEmissionError`.
 *
 *   - Caller MUST be inside an open transaction. The session binding
 *     is transaction-scoped (`set_config(..., true)`); the audit hash
 *     chain stays consistent only when the surrounding work and the
 *     audit row commit (or roll back) atomically.
 *
 *   - DO NOT supply `prev_hash` / `curr_hash` — the chain trigger
 *     auto-fills them from the per-tenant tail (per ADR-DB-003 §4).
 *
 *   - DO NOT supply `occurred_at` — the library injects
 *     `clock_timestamp()` per planning-doc Decision 11 to guarantee
 *     strict ordering of audit events emitted within a single
 *     transaction (`now()` is constant within a txn; sequential
 *     INSERTs sharing the column default would tie on `occurred_at`
 *     and fork the chain). Callers' top-level type for `AuditEventParams`
 *     omits `occurred_at` for this reason.
 *
 *   - DO NOT mutate `audit_event` rows after emission. UPDATE / DELETE
 *     raise SQLSTATE 2F002 from the trigger; surfaces as
 *     `AuditEventEmissionError` if attempted via the typed API (would
 *     require a different code path than `emitAuditEvent` — provided
 *     here for completeness).
 */

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
// `@cortex/observability` is imported statically since roadmap §4.13
// (resolved): observability no longer depends on `@cortex/tenant-context`,
// so the prior cycle (`tenant-context → audit-events → observability →
// tenant-context`) is gone at the package-graph layer.
import { createLogger, type Logger } from '@cortex/observability';
import { canonicalizeJsonValue, checkPayloadSize } from './canonicalize.js';
import { AuditEventEmissionError, AuditEventValidationError } from './errors.js';
import { auditEventParamsSchema } from './schemas.js';
import type { AuditEventParams, JsonObject, JsonValue } from './types.js';

const MODULE_ID = 'cortex-audit-events';

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

export interface AuditEventEmitter {
  emit(db: NodePgDatabase<Record<string, never>>, params: AuditEventParams): Promise<void>;
}

export interface CreateAuditEventEmitterOptions {
  /**
   * Pre-configured logger to use for canonicalization warnings (e.g.,
   * the soft 64 KB payload-size signal). When omitted, a default
   * logger with `moduleId: 'cortex-audit-events'` is constructed.
   */
  logger?: Logger;
}

// ─────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────

/**
 * Construct an `AuditEventEmitter`. Prefer this factory for new code;
 * legacy callers continue to use the module-scope `emitAuditEvent`.
 */
export function createAuditEventEmitter(
  opts: CreateAuditEventEmitterOptions = {},
): AuditEventEmitter {
  let cachedLogger: Logger | null = opts.logger ?? null;
  function getLogger(): Logger {
    cachedLogger ??= createLogger({ moduleId: MODULE_ID });
    return cachedLogger;
  }
  return {
    async emit(db, params) {
      // 1. Validate.
      const parsed = auditEventParamsSchema.safeParse(params);
      if (!parsed.success) {
        throw new AuditEventValidationError(`Invalid audit-event params: ${parsed.error.message}`, {
          cause: parsed.error,
        });
      }
      const data = parsed.data;

      // 2. Build the merged payload — user-supplied payload + the
      //    rich fields that don't have first-class columns yet
      //    (sessionId / requestId / ipAddress / userAgent /
      //    workspaceId — per planning-doc Decision 7 and Risks
      //    §"Spec SCR-20-FR-001 fields not yet first-class columns")
      //    + the per-verb state fields.
      //
      //    Wire-format names use snake_case (matches the spec text,
      //    the SQL column for `payload` is jsonb so nested keys are
      //    operator-facing). The TS-side API uses camelCase per Node
      //    convention; the mapping happens here.
      const richFields: Record<string, JsonValue> = {};
      if (data.sessionId !== undefined) richFields.session_id = data.sessionId;
      if (data.requestId !== undefined) richFields.request_id = data.requestId;
      if (data.ipAddress !== undefined) richFields.ip_address = data.ipAddress;
      if (data.userAgent !== undefined) richFields.user_agent = data.userAgent;
      if (data.workspaceId !== undefined) richFields.workspace_id = data.workspaceId;

      switch (data.verb) {
        case 'CREATE':
          richFields.after_state = data.after_state;
          break;
        case 'UPDATE':
          richFields.before_state = data.before_state;
          richFields.after_state = data.after_state;
          break;
        case 'DELETE':
          richFields.before_state = data.before_state;
          break;
        case 'READ':
          // No state fields for READ.
          break;
        case 'APPROVE':
        case 'REJECT':
        case 'EXECUTE':
          if (data.before_state !== undefined) richFields.before_state = data.before_state;
          if (data.after_state !== undefined) richFields.after_state = data.after_state;
          break;
      }

      const userPayload: JsonObject = data.payload ?? {};
      const merged = canonicalizeJsonValue({ ...userPayload, ...richFields }) as JsonObject;

      // 3. Soft-size signal — WARN above 64 KB serialized; do NOT
      //    throw (per planning-doc Decision 2 and roadmap §1.9). The
      //    logger is constructed lazily on first WARN.
      const sizeReport = checkPayloadSize(merged);
      if (sizeReport.exceedsSoftLimit) {
        const logger = getLogger();
        logger.warn(
          {
            tenant_id: data.tenantId,
            action_name: data.action.name,
            payload_size_bytes: sizeReport.sizeBytes,
          },
          'audit payload exceeds soft 64 KB threshold',
        );
      }

      // 4. INSERT. `occurred_at = clock_timestamp()` per Decision 11.
      //    `prev_hash` and `curr_hash` are filled by the BEFORE INSERT
      //    trigger; we must NOT supply them. Schema is `public` (the
      //    table lives in public; functions in `cortex`).
      const payloadJson = JSON.stringify(merged);
      try {
        await db.execute(sql`
          INSERT INTO audit_event (
            tenant_id,
            actor_type,
            actor_id,
            actor_description,
            action,
            resource,
            payload,
            occurred_at
          ) VALUES (
            ${data.tenantId},
            ${data.actorType},
            ${data.actorId},
            ${data.actorDescription ?? null},
            ${data.action.name},
            ${data.resource},
            ${payloadJson}::jsonb,
            clock_timestamp()
          )
        `);
      } catch (err) {
        throw classifyEmissionError(err);
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────────────────────────────

function classifyEmissionError(err: unknown): AuditEventEmissionError {
  const code = (err as { code?: unknown }).code;
  const cause = err instanceof Error ? err : undefined;

  if (code === '42501') {
    return new AuditEventEmissionError(
      'audit_event INSERT denied (SQLSTATE 42501). RLS rejected the write — ' +
        'verify the tenant id is bound to the DB session via ' +
        'bindTenantToDbSession from @cortex/tenant-context before calling emit().',
      cause === undefined ? undefined : { cause },
    );
  }
  if (code === '23514') {
    return new AuditEventEmissionError(
      'audit_event INSERT failed CHECK constraint (SQLSTATE 23514). ' +
        'Likely actor_type outside (service|user|system|agent) or another DB-side guard.',
      cause === undefined ? undefined : { cause },
    );
  }
  if (code === '2F002') {
    return new AuditEventEmissionError(
      'audit_event INSERT rejected as append-only violation (SQLSTATE 2F002). ' +
        'This should not happen on INSERT — investigate trigger state or driver behavior.',
      cause === undefined ? undefined : { cause },
    );
  }
  const message =
    cause !== undefined
      ? `audit_event INSERT failed: ${cause.message}`
      : 'audit_event INSERT failed';
  return new AuditEventEmissionError(message, cause === undefined ? undefined : { cause });
}

// ─────────────────────────────────────────────────────────────────────
// Module-scope default + convenience export + test escape hatches
// ─────────────────────────────────────────────────────────────────────

let defaultEmitter: AuditEventEmitter = createAuditEventEmitter();

/**
 * Convenience export for the canonical emit path. Backed by the
 * module-scope default emitter; consumers that want explicit
 * construction (custom logger, test isolation) use
 * `createAuditEventEmitter` directly.
 *
 * @throws AuditEventValidationError — params fail zod schema
 * @throws AuditEventEmissionError — DB INSERT failure (RLS / CHECK / driver)
 */
export async function emitAuditEvent(
  db: NodePgDatabase<Record<string, never>>,
  params: AuditEventParams,
): Promise<void> {
  await defaultEmitter.emit(db, params);
}

/**
 * @internal
 *
 * Test-only escape: swap the module-scope default emitter. Pair with
 * `__resetForTesting()` in `afterEach` to restore between tests.
 * Mirrors the convention in `@cortex/secrets/audit`,
 * `@cortex/bootstrap`, and `@cortex/observability`.
 */
export function __setEmitterForTesting(emitter: AuditEventEmitter): void {
  defaultEmitter = emitter;
}

/**
 * @internal
 *
 * Restore the production default emitter (logger built from
 * `createLogger({ moduleId: 'cortex-audit-events' })`).
 */
export function __resetForTesting(): void {
  defaultEmitter = createAuditEventEmitter();
}
