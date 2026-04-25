import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@cortex/observability';
import { createLogCapture, type LogCapture } from '@cortex/observability/test-utils';
import { getKeyForTenant } from '../src/per-tenant-keys.js';
import { __resetForTesting, __setLoggerForTesting } from '../src/audit.js';
import { SecretsValidationError } from '../src/errors.js';

const VALID_TENANT = '22222222-2222-2222-2222-222222222222';

let logCapture: LogCapture;

describe('getKeyForTenant (Phase 1 stub)', () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ['GCP_PROJECT_ID', 'CORTEX_KMS_LOCATION', 'CORTEX_KMS_KEYRING'];

  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k];
    process.env.GCP_PROJECT_ID = 'sevyn8-cortex-dev';
    delete process.env.CORTEX_KMS_LOCATION;
    delete process.env.CORTEX_KMS_KEYRING;
    logCapture = createLogCapture();
    __setLoggerForTesting(createLogger({ moduleId: 'cortex-secrets', destination: logCapture }));
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    __resetForTesting();
    vi.restoreAllMocks();
  });

  it('returns cortex-general-key resource name (ignores tenantId)', () => {
    const key = getKeyForTenant(VALID_TENANT);
    expect(key).toBe(
      'projects/sevyn8-cortex-dev/locations/asia-south1/keyRings/cortex-keyring/cryptoKeys/cortex-general-key',
    );
  });

  it('returns same key for different tenants (Phase 1 stub behavior)', () => {
    const k1 = getKeyForTenant(VALID_TENANT);
    const k2 = getKeyForTenant('33333333-3333-3333-3333-333333333333');
    expect(k1).toBe(k2);
  });

  it('rejects non-UUID tenantId', () => {
    expect(() => getKeyForTenant('not-a-uuid')).toThrow(SecretsValidationError);
  });

  it('rejects empty tenantId', () => {
    expect(() => getKeyForTenant('')).toThrow(SecretsValidationError);
  });

  it('honors CORTEX_KMS_LOCATION override', () => {
    process.env.CORTEX_KMS_LOCATION = 'us-central1';
    const key = getKeyForTenant(VALID_TENANT);
    expect(key).toContain('locations/us-central1');
  });

  it('emits an audit log on success', async () => {
    getKeyForTenant(VALID_TENANT);
    await logCapture.flush();
    expect(logCapture.logs).toHaveLength(1);
    expect(logCapture.logs[0]).toMatchObject({
      namespace: 'secrets-audit',
      operation: 'getKeyForTenant',
      outcome: 'ok',
      tenant_id: VALID_TENANT,
    });
  });

  it('emits an error audit on validation failure', async () => {
    expect(() => getKeyForTenant('bad')).toThrow();
    await logCapture.flush();
    expect(logCapture.logs).toHaveLength(1);
    expect(logCapture.logs[0]).toMatchObject({
      outcome: 'error',
      error_code: 'VALIDATION',
      tenant_id: null,
    });
  });
});
