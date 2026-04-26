/**
 * Core emit function + hybrid DI for `@cortex/encryption`.
 *
 * Wraps `@cortex/secrets.envelope.encrypt/decrypt` with tenant-bound
 * semantics, audit emission via `@cortex/audit-events`, and the
 * canonical `EncryptedPayload` shape.
 *
 * Caller contract (mirrors `@cortex/audit-events/src/emit.ts`):
 *
 *   - Caller MUST have bound a tenant id to the DB session via
 *     `bindTenantToDbSession` from `@cortex/tenant-context` BEFORE
 *     calling. Audit emission requires the binding (RLS); encryption
 *     itself does not consult `app.tenant_id` but the audit row does.
 *
 *   - Caller MUST be inside an open transaction. Audit emission is
 *     transactional with the surrounding work; the chain integrity
 *     model from ADR-DB-003 / ADR-AU-001 demands the audit row
 *     commit/roll-back atomically with the source operation.
 *
 *   - `decryptForTenant` emits a `PII_DECRYPTED` audit event on every
 *     call — F01 §1.2.4 mandates that sensitive reads are audited.
 *     Callers that need to bulk-decrypt should consider whether the
 *     resulting audit volume is acceptable (see roadmap §1.9 for the
 *     soft-cap discussion).
 *
 * The action catalog lives in `./catalog.ts` — a side-effect-free
 * re-export module so test files using `vi.mock('./encrypt.js')` don't
 * trip over the top-level `registerAuditActions(...)` call. Same split
 * pattern as `@cortex/tenant-context/src/audit-actions.ts`.
 */

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
// `Logger` is imported type-only and `createLogger` via dynamic import to
// avoid closing any future load-order cycle through observability — same
// pattern as `@cortex/audit-events/src/emit.ts`. See roadmap §4.13.
import type { Logger } from '@cortex/observability';
import { envelope, getKeyForTenant } from '@cortex/secrets';
import { emitAuditEvent, getActionByName } from '@cortex/audit-events';
import { ENCRYPTION_AUDIT_ACTIONS } from './catalog.js';
import {
  EncryptionConfigError,
  EncryptionExecutionError,
  EncryptionValidationError,
} from './errors.js';
import { decryptParamsSchema, encryptParamsSchema } from './schemas.js';
import type { DecryptParams, EncryptParams, EncryptedPayload } from './types.js';

const MODULE_ID = 'cortex-encryption';

/**
 * Soft warning threshold for encrypted-envelope byte size. Mirrors the
 * 64 KB threshold in `@cortex/audit-events` (per planning-doc Decision
 * 2 + roadmap §1.9). Above this, the library logs a `WARN` with
 * tenantId + size; it does NOT throw. Pre-summarization is the caller's
 * responsibility for known-large payloads.
 */
const SOFT_ENVELOPE_LIMIT_BYTES = 64 * 1024;

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

export interface EncryptForTenant {
  encrypt(
    db: NodePgDatabase<Record<string, never>>,
    params: EncryptParams,
  ): Promise<EncryptedPayload>;
  decrypt(db: NodePgDatabase<Record<string, never>>, params: DecryptParams): Promise<Buffer>;
}

export interface CreateEncryptionEmitterOptions {
  /**
   * Pre-configured logger for diagnostic output (e.g., decrypt failure
   * forensic notes). When omitted, a default logger with
   * `moduleId: 'cortex-encryption'` is constructed lazily on first
   * use via dynamic import (cycle break — see file header).
   */
  logger?: Logger;
}

// ─────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────

/**
 * Construct an `EncryptForTenant` instance. Prefer this factory for
 * new code; legacy / convention callers continue to use the
 * module-scope `encryptForTenant` / `decryptForTenant` exports.
 *
 * @throws EncryptionConfigError if `opts.logger` is supplied but invalid
 */
export function createEncryptionEmitter(
  opts: CreateEncryptionEmitterOptions = {},
): EncryptForTenant {
  if (opts.logger !== undefined && typeof opts.logger.warn !== 'function') {
    throw new EncryptionConfigError(
      'createEncryptionEmitter: opts.logger does not implement the Logger interface',
    );
  }

  // Lazy logger: avoid eager import of @cortex/observability at module
  // load. Same pattern as @cortex/audit-events/src/emit.ts. The dynamic
  // import resolves at first use; cached thereafter.
  let cachedLogger: Logger | null = opts.logger ?? null;
  async function getLogger(): Promise<Logger> {
    if (cachedLogger === null) {
      const observability = (await import('@cortex/observability')) as {
        createLogger: (options: { moduleId: string }) => Logger;
      };
      cachedLogger = observability.createLogger({ moduleId: MODULE_ID });
    }
    return cachedLogger;
  }

  return {
    async encrypt(db, params) {
      // 1. Validate.
      const parsed = encryptParamsSchema.safeParse(params);
      if (!parsed.success) {
        throw new EncryptionValidationError(`Invalid encrypt params: ${parsed.error.message}`, {
          cause: parsed.error,
        });
      }
      const data = parsed.data;

      // 2. Convert plaintext to Buffer. Strings are NFC-normalized
      //    before UTF-8 encoding — same convention as
      //    @cortex/audit-events/src/canonicalize.ts. Buffers pass
      //    through verbatim (caller owns canonicalization for binary).
      const plaintextBuf =
        typeof data.plaintext === 'string'
          ? Buffer.from(data.plaintext.normalize('NFC'), 'utf8')
          : data.plaintext;

      // 3. Resolve the tenant's KMS key. Per ADR-INFRA-007 Decision 2,
      //    the resolver MUST be consulted on every call (no caching).
      //    Phase 1 stub returns env's cortex-general-key regardless of
      //    tenantId; F02 swaps to a real per-tenant key.
      const keyResourceName = getKeyForTenant(data.tenantId);

      // 4. Envelope-encrypt. AAD = utf8(tenantId) is set inside
      //    @cortex/secrets.envelope.encrypt — the cryptographic
      //    tenant-isolation property is established at the AEAD layer.
      let envelopeBuf: Buffer;
      try {
        envelopeBuf = await envelope.encrypt(data.tenantId, plaintextBuf);
      } catch (err) {
        throw classifyExecutionError(err, 'encrypt');
      }

      // 5. Build the public EncryptedPayload. The aad bytes are
      //    recorded for forensic verifiability — auditors can
      //    reconstruct from tenantId alone, but storing them sidesteps
      //    encoding-drift surprises during a future investigation.
      const aad = Buffer.from(data.tenantId, 'utf8');
      const payload: EncryptedPayload = {
        envelope: envelopeBuf,
        keyResourceName,
        tenantId: data.tenantId,
        aad,
      };

      // 5b. Soft-size signal. Above 64 KB, log a WARN; do NOT throw.
      //     Mirrors the audit-events convention (planning-doc Decision
      //     2, roadmap §1.9). Threshold is heuristic; revisit when
      //     observed distribution surfaces a pattern.
      if (envelopeBuf.byteLength > SOFT_ENVELOPE_LIMIT_BYTES) {
        const logger = await getLogger();
        logger.warn(
          {
            tenant_id: data.tenantId,
            key_resource_name: keyResourceName,
            envelope_byte_size: envelopeBuf.byteLength,
          },
          'encrypted envelope exceeds soft 64 KB threshold',
        );
      }

      // 6. Emit PII_ENCRYPTED audit event. Phase 1 actor is a fixed
      //    service identity ('cortex-encryption'); AC01 will introduce
      //    a request-scoped actor resolver and the encryption layer
      //    will pick it up via async-local context. The tenantId field
      //    inside after_state is informational redundancy with the
      //    audit row's tenant_id column — surfaced explicitly so audit
      //    consumers can express "PII was encrypted FOR tenant X".
      await emitAuditEvent(db, {
        tenantId: data.tenantId,
        actorType: 'service',
        actorId: 'cortex-encryption',
        action: getActionByName(ENCRYPTION_AUDIT_ACTIONS, 'PII_ENCRYPTED'),
        verb: 'CREATE',
        resource: `pii:${data.tenantId}`,
        after_state: {
          tenant_id: data.tenantId,
          key_resource_name: keyResourceName,
          payload_byte_size: envelopeBuf.byteLength,
        },
      });

      return payload;
    },

    async decrypt(db, params) {
      // 1. Validate.
      const parsed = decryptParamsSchema.safeParse(params);
      if (!parsed.success) {
        throw new EncryptionValidationError(`Invalid decrypt params: ${parsed.error.message}`, {
          cause: parsed.error,
        });
      }
      const data = parsed.data;

      // 2. Defense in depth: the supplied tenantId MUST match the
      //    payload's recorded tenantId. The AAD check inside the
      //    envelope would catch a mismatch anyway (auth-tag failure)
      //    but an explicit check produces a clearer error and avoids
      //    consuming a KMS unwrap call on an obviously-wrong request.
      if (data.tenantId !== data.payload.tenantId) {
        throw new EncryptionValidationError(
          `decryptForTenant: supplied tenantId (${data.tenantId}) does not match ` +
            `payload.tenantId (${data.payload.tenantId}). Cross-tenant decryption ` +
            `attempt or stale payload reference.`,
        );
      }

      // 3. Envelope-decrypt. Auth-tag failure inside the AEAD layer
      //    surfaces as an EnvelopeDecryptError from @cortex/secrets;
      //    we map it (and any other secrets-layer error) to
      //    EncryptionExecutionError with the original cause attached.
      let plaintextBuf: Buffer;
      try {
        plaintextBuf = await envelope.decrypt(data.tenantId, data.payload.envelope);
      } catch (err) {
        throw classifyExecutionError(err, 'decrypt');
      }

      // 4. Emit PII_DECRYPTED audit event. Sensitive reads are audited
      //    per F01 §1.2.4. Verb is READ (no before/after_state); the
      //    audit row's tenant_id and resource convey the binding.
      await emitAuditEvent(db, {
        tenantId: data.tenantId,
        actorType: 'service',
        actorId: 'cortex-encryption',
        action: getActionByName(ENCRYPTION_AUDIT_ACTIONS, 'PII_DECRYPTED'),
        verb: 'READ',
        resource: `pii:${data.tenantId}`,
      });

      return plaintextBuf;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────────────────────────────

function classifyExecutionError(err: unknown, op: 'encrypt' | 'decrypt'): EncryptionExecutionError {
  const cause = err instanceof Error ? err : undefined;
  const causeName = cause?.name ?? '';
  const causeMessage = cause?.message ?? '';

  // Auth-tag mismatch on decrypt: @cortex/secrets surfaces
  // EnvelopeDecryptError. The message text indicates AEAD failure;
  // we re-surface with a tenant-isolation framing for clearer ops
  // diagnosis.
  if (op === 'decrypt' && causeName === 'EnvelopeDecryptError') {
    return new EncryptionExecutionError(
      'decrypt failed: AAD mismatch — likely cross-tenant decryption attempt or corrupted ciphertext',
      cause === undefined ? undefined : { cause },
    );
  }

  const message = cause !== undefined ? `${op} failed: ${causeMessage}` : `${op} failed`;
  return new EncryptionExecutionError(message, cause === undefined ? undefined : { cause });
}

// ─────────────────────────────────────────────────────────────────────
// Module-scope default + convenience exports + test escape hatches
// ─────────────────────────────────────────────────────────────────────

let defaultEmitter: EncryptForTenant = createEncryptionEmitter();

/**
 * Convenience export for the canonical encrypt path. Backed by the
 * module-scope default emitter; consumers wanting explicit construction
 * (custom logger, test isolation) use `createEncryptionEmitter`
 * directly.
 *
 * Caller MUST be inside an open transaction with `app.tenant_id` bound
 * (RLS prerequisite for the PII_ENCRYPTED audit row INSERT).
 *
 * @throws EncryptionValidationError — params fail zod schema
 * @throws EncryptionExecutionError — KMS API failure, encryption layer error
 * @throws AuditEventEmissionError — audit row INSERT failure (RLS / CHECK / driver)
 */
export async function encryptForTenant(
  db: NodePgDatabase<Record<string, never>>,
  params: EncryptParams,
): Promise<EncryptedPayload> {
  return defaultEmitter.encrypt(db, params);
}

/**
 * Convenience export for the canonical decrypt path. Backed by the
 * module-scope default emitter.
 *
 * Caller MUST be inside an open transaction with `app.tenant_id` bound.
 * Every call emits a `PII_DECRYPTED` audit event — sensitive reads are
 * audited per F01 §1.2.4. Bulk-decrypt callers should consider the
 * resulting audit volume.
 *
 * @throws EncryptionValidationError — params fail zod schema, or
 *   tenantId mismatch with payload.tenantId (cross-tenant attempt)
 * @throws EncryptionExecutionError — KMS unwrap failure, AAD mismatch
 *   (cross-tenant or tampered ciphertext)
 * @throws AuditEventEmissionError — audit row INSERT failure
 */
export async function decryptForTenant(
  db: NodePgDatabase<Record<string, never>>,
  params: DecryptParams,
): Promise<Buffer> {
  return defaultEmitter.decrypt(db, params);
}

/**
 * @internal
 *
 * Test-only escape: swap the module-scope default emitter. Pair with
 * `__resetForTesting()` in `afterEach` to restore between tests.
 * Mirrors the convention in `@cortex/audit-events`,
 * `@cortex/secrets/audit`, `@cortex/bootstrap`, and
 * `@cortex/observability`.
 */
export function __setEmitterForTesting(emitter: EncryptForTenant): void {
  defaultEmitter = emitter;
}

/**
 * @internal
 *
 * Restore the production default emitter (logger built lazily from
 * `createLogger({ moduleId: 'cortex-encryption' })`).
 */
export function __resetForTesting(): void {
  defaultEmitter = createEncryptionEmitter();
}
