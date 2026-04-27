/**
 * Integration test: real KMS envelope encrypt/decrypt against dev's
 * cortex-general-key (per ADR-INFRA-004).
 *
 * Skipped unless CORTEX_INTEGRATION_TESTS=true is set. Requires:
 *   - gcloud auth application-default login
 *   - GCP_PROJECT_ID=sevyn8-cortex-dev
 *   - caller has roles/cloudkms.cryptoKeyEncrypterDecrypter on
 *     cortex-general-key in sevyn8-cortex-dev
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { envelope } from '../../src/kms.js';
import { buildKeyResourceName } from '../../src/config.js';
import { EnvelopeDecryptError } from '../../src/errors.js';

const TENANT_A = '22222222-2222-2222-2222-222222222222';
const TENANT_B = '33333333-3333-3333-3333-333333333333';

const SKIP = !process.env.CORTEX_INTEGRATION_TESTS;

describe.skipIf(SKIP)('integration: real KMS envelope', () => {
  // Per planning-doc §4.15 (sub-phase 6.1): envelope.encrypt/decrypt now
  // require a caller-supplied keyResourceName. Integration tests use
  // the env's cortex-general-key resolved via `buildKeyResourceName`,
  // which reads GCP_PROJECT_ID. Resolved in beforeAll (rather than at
  // collection time) so this spec doesn't throw on module load when
  // the integration tests are skipped (CORTEX_INTEGRATION_TESTS unset).
  let KEY_RESOURCE_NAME: string;
  beforeAll(() => {
    KEY_RESOURCE_NAME = buildKeyResourceName('cortex-general-key');
  });
  it('encrypt then decrypt round-trips against real cortex-general-key', async () => {
    const plaintext = 'integration-test-payload';
    const ct = await envelope.encrypt(TENANT_A, plaintext, KEY_RESOURCE_NAME);
    expect(ct.readUInt8(0)).toBe(0x01); // version marker
    const pt = await envelope.decrypt(TENANT_A, ct, KEY_RESOURCE_NAME);
    expect(pt.toString('utf8')).toBe(plaintext);
  });

  it('cross-tenant decrypt fails (AAD binding)', async () => {
    const ct = await envelope.encrypt(TENANT_A, 'tenant-A-data', KEY_RESOURCE_NAME);
    await expect(envelope.decrypt(TENANT_B, ct, KEY_RESOURCE_NAME)).rejects.toBeInstanceOf(
      EnvelopeDecryptError,
    );
  });

  it('tampered ciphertext fails', async () => {
    const ct = await envelope.encrypt(TENANT_A, 'hello', KEY_RESOURCE_NAME);
    const wrapLen = ct.readUInt16BE(1);
    const ciphertextStart = 1 + 2 + wrapLen + 12 + 16;
    const tampered = Buffer.from(ct);
    tampered[ciphertextStart] = (tampered[ciphertextStart] ?? 0) ^ 0xff;
    await expect(envelope.decrypt(TENANT_A, tampered, KEY_RESOURCE_NAME)).rejects.toBeInstanceOf(
      EnvelopeDecryptError,
    );
  });
});
