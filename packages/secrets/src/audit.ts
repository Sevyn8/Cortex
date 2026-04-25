/**
 * Audit-event emitter for `@cortex/secrets`.
 *
 * Per ADR-OBS-001 §Decision 5, audit emission goes through the
 * `@cortex/observability` structured logger — not raw `console.error`.
 * Every audit line carries:
 *   - `module_id`     = `'cortex-secrets'` (set by the logger via mixin)
 *   - `namespace`     = `'secrets-audit'`  (so downstream filters can
 *                                           narrow without knowing module ids)
 *   - the `AuditEntry` fields (operation, outcome, tenant_id, ...)
 *
 * Two consumption shapes:
 *
 *   1. `auditLog(entry)` — the existing function-level API. Backed by a
 *      module-scope default emitter. The 14 internal call sites in
 *      `kms.ts`, `secret-manager.ts`, `per-tenant-keys.ts` use this and
 *      do not change.
 *
 *   2. `createSecretsAuditEmitter(opts)` — factory returning a
 *      `SecretsAuditEmitter`. Preferred for new code that wants explicit
 *      construction or to inject a pre-configured logger (e.g., a logger
 *      bound to a parent's child logger with extra context).
 *
 * Tests swap the default emitter via `__setLoggerForTesting(logger)` and
 * restore via `__resetForTesting()`. This mirrors the convention in
 * `correlation-context.ts` and `@cortex/tenant-context`'s test escape
 * hatches.
 */

import { createLogger, type Logger } from '@cortex/observability';

export type AuditOperation = 'get' | 'put' | 'encrypt' | 'decrypt' | 'getKeyForTenant';

export interface AuditEntry {
  operation: AuditOperation;
  tenant_id: string | null;
  secret_id: string | null;
  key_id: string | null;
  outcome: 'ok' | 'error';
  error_code: string | null;
  duration_ms: number;
  actor: string;
}

export interface SecretsAuditEmitter {
  audit(entry: Omit<AuditEntry, 'actor'>): void;
}

export interface CreateSecretsAuditEmitterOptions {
  /**
   * Pre-configured logger to emit through. When omitted, a default
   * logger with `moduleId: 'cortex-secrets'` is constructed.
   */
  logger?: Logger;
}

const NAMESPACE = 'secrets-audit';
const MODULE_ID = 'cortex-secrets';

function getActor(): string {
  return process.env.CORTEX_ACTOR ?? 'unknown';
}

/**
 * Construct a `SecretsAuditEmitter`. Prefer this factory for new code;
 * legacy callers continue to use the module-scope `auditLog`.
 */
export function createSecretsAuditEmitter(
  opts: CreateSecretsAuditEmitterOptions = {},
): SecretsAuditEmitter {
  const logger = opts.logger ?? createLogger({ moduleId: MODULE_ID });
  return {
    audit(entry) {
      const full: AuditEntry = { ...entry, actor: getActor() };
      logger.info({ ...full, namespace: NAMESPACE }, NAMESPACE);
    },
  };
}

// Module-scope default emitter. The 14 internal call sites in
// kms.ts / secret-manager.ts / per-tenant-keys.ts import `auditLog`
// directly and emit through this instance.
let defaultEmitter: SecretsAuditEmitter = createSecretsAuditEmitter();

/**
 * Emit a single audit line. Preserved API — existing call sites do not
 * need to change. Backed by the module-scope default emitter.
 */
export function auditLog(entry: Omit<AuditEntry, 'actor'>): void {
  defaultEmitter.audit(entry);
}

/**
 * @internal
 *
 * Test-only escape: swap the logger backing the default emitter. Pair
 * with `__resetForTesting()` in `afterEach` to restore production
 * defaults between tests.
 */
export function __setLoggerForTesting(logger: Logger): void {
  defaultEmitter = createSecretsAuditEmitter({ logger });
}

/**
 * @internal
 *
 * Restore the production default emitter (logger built from
 * `createLogger({ moduleId: 'cortex-secrets' })`).
 */
export function __resetForTesting(): void {
  defaultEmitter = createSecretsAuditEmitter();
}
