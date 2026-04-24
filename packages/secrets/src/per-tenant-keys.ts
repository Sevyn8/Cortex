import { z } from 'zod';
import { auditLog } from './audit.js';
import { buildKeyResourceName } from './config.js';
import { SecretsValidationError } from './errors.js';

const tenantIdSchema = z.string().uuid();

/**
 * Return the fully-qualified KMS key resource name for a tenant.
 *
 * Phase 1 stub: ignores `tenantId`, returns the env's `cortex-general-key`.
 * Per ADR-INFRA-004 Decision 5, per-tenant keys are deferred to Phase 2+;
 * F02 will swap this implementation to consult the `tenant_kms_key`
 * control-plane table.
 *
 * @returns `projects/<proj>/locations/<loc>/keyRings/<ring>/cryptoKeys/cortex-general-key`
 * @throws SecretsValidationError invalid tenantId (non-UUID)
 * @throws ConfigError GCP_PROJECT_ID env var missing
 */
export function getKeyForTenant(tenantId: string): string {
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
  const resourceName = buildKeyResourceName('cortex-general-key');
  auditLog({
    operation: 'getKeyForTenant',
    tenant_id: parsed.data,
    secret_id: null,
    key_id: resourceName,
    outcome: 'ok',
    error_code: null,
    duration_ms: Date.now() - start,
  });
  return resourceName;
}
