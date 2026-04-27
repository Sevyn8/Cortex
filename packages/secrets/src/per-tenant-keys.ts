import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { tenantKmsKey } from '@cortex/canonical-schema';
import { auditLog } from './audit.js';
import { SecretsValidationError, TenantKmsKeyNotFoundError } from './errors.js';

const tenantIdSchema = z.string().uuid();

/**
 * Resolves the KMS key resource name for a given tenant.
 *
 * F02 Slice A swap (commit TBD): queries `tenant_kms_key` for the row
 * matching `tenantId`. F01 Slice B's `tenants.create` populates this
 * row at provisioning time with the env-level key resource name (built
 * via `buildKeyResourceName`); the Phase 1 stub returned the static
 * env path regardless of `tenantId`. F02 actually consults the
 * binding, which makes per-tenant key migration purely additive
 * (ADR-INFRA-007 Decision 5) — switching a tenant to a real per-
 * tenant key in Phase 2+ becomes one row update.
 *
 * RLS: `tenant_kms_key` has FOR ALL RLS policy (per migration 0009).
 * **Caller MUST `bindTenantToDbSession(tx, tenantId)` before invoking
 * this function.** The resolver does not bind — the caller's
 * transaction may already have its own session-bound state, and a
 * resolver-side bind would over-bind the txn.
 *
 * Operational audit log (SA15): preserves the existing
 * `[SECRETS-AUDIT]` emission pattern. One log line per resolution;
 * consistent with `kms.ts` and `secret-manager.ts`. The `key_id`
 * field captures the resolved resource name on success and is null
 * on validation / not-found errors.
 *
 * @throws SecretsValidationError when `tenantId` fails UUID validation.
 * @throws TenantKmsKeyNotFoundError when no row exists for `tenantId`
 *   (or when RLS denies the read because the session isn't bound).
 */
export async function getKeyForTenant(
  db: NodePgDatabase<Record<string, never>>,
  tenantId: string,
): Promise<string> {
  const start = Date.now();
  const parsed = tenantIdSchema.safeParse(tenantId);
  if (!parsed.success) {
    auditLog({
      operation: 'getKeyForTenant',
      tenant_id: null,
      secret_id: null,
      key_id: null,
      outcome: 'error',
      error_code: 'VALIDATION',
      duration_ms: Date.now() - start,
    });
    throw new SecretsValidationError(`invalid tenantId: ${parsed.error.message}`);
  }

  const rows = await db
    .select({ kms_key_resource_name: tenantKmsKey.kms_key_resource_name })
    .from(tenantKmsKey)
    .where(eq(tenantKmsKey.tenant_id, parsed.data))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    auditLog({
      operation: 'getKeyForTenant',
      tenant_id: parsed.data,
      secret_id: null,
      key_id: null,
      outcome: 'error',
      error_code: 'NOT_FOUND',
      duration_ms: Date.now() - start,
    });
    throw new TenantKmsKeyNotFoundError(parsed.data);
  }

  auditLog({
    operation: 'getKeyForTenant',
    tenant_id: parsed.data,
    secret_id: null,
    key_id: row.kms_key_resource_name,
    outcome: 'ok',
    error_code: null,
    duration_ms: Date.now() - start,
  });
  return row.kms_key_resource_name;
}
