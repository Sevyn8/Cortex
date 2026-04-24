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
import { describe, expect, it } from 'vitest';
import { envelope } from '../../src/kms.js';
import { EnvelopeDecryptError } from '../../src/errors.js';

const TENANT_A = '22222222-2222-2222-2222-222222222222';
const TENANT_B = '33333333-3333-3333-3333-333333333333';

const SKIP = !process.env.CORTEX_INTEGRATION_TESTS;

describe.skipIf(SKIP)('integration: real KMS envelope', () => {
  it('encrypt then decrypt round-trips against real cortex-general-key', async () => {
    const plaintext = 'integration-test-payload';
    const ct = await envelope.encrypt(TENANT_A, plaintext);
    expect(ct.readUInt8(0)).toBe(0x01); // version marker
    const pt = await envelope.decrypt(TENANT_A, ct);
    expect(pt.toString('utf8')).toBe(plaintext);
  });

  it('cross-tenant decrypt fails (AAD binding)', async () => {
    const ct = await envelope.encrypt(TENANT_A, 'tenant-A-data');
    await expect(envelope.decrypt(TENANT_B, ct)).rejects.toBeInstanceOf(EnvelopeDecryptError);
  });

  it('tampered ciphertext fails', async () => {
    const ct = await envelope.encrypt(TENANT_A, 'hello');
    const wrapLen = ct.readUInt16BE(1);
    const ciphertextStart = 1 + 2 + wrapLen + 12 + 16;
    const tampered = Buffer.from(ct);
    tampered[ciphertextStart] = (tampered[ciphertextStart] ?? 0) ^ 0xff;
    await expect(envelope.decrypt(TENANT_A, tampered)).rejects.toBeInstanceOf(EnvelopeDecryptError);
  });
});
