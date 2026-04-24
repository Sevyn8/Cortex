/**
 * Integration test: real GCP Secret Manager against dev project.
 *
 * Skipped unless CORTEX_INTEGRATION_TESTS=true is set. Requires:
 *   - gcloud auth application-default login  (once per session)
 *   - GCP_PROJECT_ID=sevyn8-cortex-dev
 *   - caller has roles/secretmanager.secretAccessor on
 *     cortex-db-postgres-break-glass-dev (Terraform-provisioned)
 *
 * Read-only: exercises secrets.get against the existing break-glass secret.
 * put integration deferred until F02 needs it (per P0.7 design lock).
 */
import { describe, expect, it } from 'vitest';
import { secrets } from '../../src/secret-manager.js';

const SKIP = !process.env.CORTEX_INTEGRATION_TESTS;

describe.skipIf(SKIP)('integration: real GCP Secret Manager', () => {
  it('reads cortex-db-postgres-break-glass-dev (non-empty UTF-8 payload)', async () => {
    const value = await secrets.get('cortex-db-postgres-break-glass-dev');
    expect(typeof value).toBe('string');
    expect(value.length).toBeGreaterThan(0);
  });

  it('rejects invalid secret name before making any GCP call', async () => {
    await expect(secrets.get('not-cortex-prefixed')).rejects.toThrow();
  });
});
