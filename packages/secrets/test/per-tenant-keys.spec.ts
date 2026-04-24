import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getKeyForTenant } from '../src/per-tenant-keys.js';
import { SecretsValidationError } from '../src/errors.js';

const VALID_TENANT = '22222222-2222-2222-2222-222222222222';

describe('getKeyForTenant (Phase 1 stub)', () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ['GCP_PROJECT_ID', 'CORTEX_KMS_LOCATION', 'CORTEX_KMS_KEYRING'];

  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k];
    process.env.GCP_PROJECT_ID = 'sevyn8-cortex-dev';
    delete process.env.CORTEX_KMS_LOCATION;
    delete process.env.CORTEX_KMS_KEYRING;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
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

  it('emits [SECRETS-AUDIT] log on success', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getKeyForTenant(VALID_TENANT);
    expect(spy).toHaveBeenCalledOnce();
    const line = spy.mock.calls[0]?.[0] as string;
    expect(line).toContain('[SECRETS-AUDIT]');
    expect(line).toContain('"operation":"getKeyForTenant"');
    expect(line).toContain('"outcome":"ok"');
    expect(line).toContain(`"tenant_id":"${VALID_TENANT}"`);
  });

  it('emits [SECRETS-AUDIT] error log on validation failure', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => getKeyForTenant('bad')).toThrow();
    expect(spy).toHaveBeenCalledOnce();
    const line = spy.mock.calls[0]?.[0] as string;
    expect(line).toContain('"outcome":"error"');
    expect(line).toContain('"error_code":"VALIDATION"');
    expect(line).toContain('"tenant_id":null');
  });
});
