import * as crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setClientFactoryForTesting, envelope } from '../src/kms.js';
import { EnvelopeDecryptError, SecretsValidationError } from '../src/errors.js';

const TENANT_A = '22222222-2222-2222-2222-222222222222';
const TENANT_B = '33333333-3333-3333-3333-333333333333';

/**
 * In-memory KMS stand-in: wrap = prepend a 4-byte "KMSW" magic + raw DEK.
 * Unwrap = strip the magic and return the DEK. Keeps the tests focused on
 * wire format + AEAD semantics without touching real GCP.
 */
function inMemoryKms() {
  return {
    encrypt: vi.fn((req: { name?: string; plaintext?: Uint8Array | string }) => {
      const dek = req.plaintext as Uint8Array;
      const wrapped = Buffer.concat([Buffer.from('KMSW', 'utf8'), Buffer.from(dek)]);
      return Promise.resolve([{ ciphertext: wrapped }]);
    }),
    decrypt: vi.fn((req: { name?: string; ciphertext?: Uint8Array | string }) => {
      const wrapped = Buffer.from(req.ciphertext as Uint8Array);
      if (wrapped.slice(0, 4).toString('utf8') !== 'KMSW') {
        return Promise.reject(Object.assign(new Error('KMS malformed ciphertext'), { code: 3 }));
      }
      return Promise.resolve([{ plaintext: wrapped.slice(4) }]);
    }),
  };
}

describe('envelope', () => {
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
    __setClientFactoryForTesting(null);
    vi.restoreAllMocks();
  });

  describe('wire format', () => {
    it('encrypt produces buffer with version byte 0x01', async () => {
      __setClientFactoryForTesting(() => inMemoryKms() as never);
      const ct = await envelope.encrypt(TENANT_A, 'hello');
      expect(ct.readUInt8(0)).toBe(0x01);
    });

    it('encrypt produces big-endian wrap_len matching actual wrapped DEK length', async () => {
      __setClientFactoryForTesting(() => inMemoryKms() as never);
      const ct = await envelope.encrypt(TENANT_A, 'hello');
      const wrapLen = ct.readUInt16BE(1);
      // Our in-memory KMS wraps 32-byte DEK with 4-byte magic = 36 bytes
      expect(wrapLen).toBe(36);
    });

    it('encrypt output length matches: 1 + 2 + wrap_len + 12 + 16 + plaintext.length', async () => {
      __setClientFactoryForTesting(() => inMemoryKms() as never);
      const plaintext = 'hello';
      const ct = await envelope.encrypt(TENANT_A, plaintext);
      const wrapLen = ct.readUInt16BE(1);
      expect(ct.length).toBe(1 + 2 + wrapLen + 12 + 16 + plaintext.length);
    });
  });

  describe('round-trip', () => {
    it('encrypt then decrypt returns original plaintext (string input)', async () => {
      __setClientFactoryForTesting(() => inMemoryKms() as never);
      const ct = await envelope.encrypt(TENANT_A, 'hello world');
      const pt = await envelope.decrypt(TENANT_A, ct);
      expect(pt.toString('utf8')).toBe('hello world');
    });

    it('encrypt then decrypt returns original plaintext (Buffer input)', async () => {
      __setClientFactoryForTesting(() => inMemoryKms() as never);
      const original = Buffer.from([0x01, 0x02, 0x03, 0xff, 0xfe, 0x00]);
      const ct = await envelope.encrypt(TENANT_A, original);
      const pt = await envelope.decrypt(TENANT_A, ct);
      expect(pt.equals(original)).toBe(true);
    });

    it('empty plaintext round-trips', async () => {
      __setClientFactoryForTesting(() => inMemoryKms() as never);
      const ct = await envelope.encrypt(TENANT_A, '');
      const pt = await envelope.decrypt(TENANT_A, ct);
      expect(pt.length).toBe(0);
    });

    it('produces different ciphertexts for same plaintext (random DEK + IV)', async () => {
      __setClientFactoryForTesting(() => inMemoryKms() as never);
      const ct1 = await envelope.encrypt(TENANT_A, 'hello');
      const ct2 = await envelope.encrypt(TENANT_A, 'hello');
      expect(ct1.equals(ct2)).toBe(false);
    });
  });

  describe('AAD binding (cross-tenant protection)', () => {
    it('decrypt with different tenantId fails with EnvelopeDecryptError', async () => {
      __setClientFactoryForTesting(() => inMemoryKms() as never);
      const ct = await envelope.encrypt(TENANT_A, 'secret-for-tenant-A');
      await expect(envelope.decrypt(TENANT_B, ct)).rejects.toBeInstanceOf(EnvelopeDecryptError);
    });
  });

  describe('tamper detection', () => {
    it('flipped byte in ciphertext fails auth tag', async () => {
      __setClientFactoryForTesting(() => inMemoryKms() as never);
      const ct = await envelope.encrypt(TENANT_A, 'hello world');
      // Flip a byte in the ciphertext region (after the header + wrapped_DEK + IV + tag)
      const wrapLen = ct.readUInt16BE(1);
      const ciphertextStart = 1 + 2 + wrapLen + 12 + 16;
      const tampered = Buffer.from(ct);
      tampered[ciphertextStart] = (tampered[ciphertextStart] ?? 0) ^ 0xff;
      await expect(envelope.decrypt(TENANT_A, tampered)).rejects.toBeInstanceOf(
        EnvelopeDecryptError,
      );
    });

    it('flipped byte in auth tag fails', async () => {
      __setClientFactoryForTesting(() => inMemoryKms() as never);
      const ct = await envelope.encrypt(TENANT_A, 'hello');
      const wrapLen = ct.readUInt16BE(1);
      const tagStart = 1 + 2 + wrapLen + 12;
      const tampered = Buffer.from(ct);
      tampered[tagStart] = (tampered[tagStart] ?? 0) ^ 0xff;
      await expect(envelope.decrypt(TENANT_A, tampered)).rejects.toBeInstanceOf(
        EnvelopeDecryptError,
      );
    });
  });

  describe('wire-format validation on decrypt', () => {
    it('rejects unsupported version byte', async () => {
      __setClientFactoryForTesting(() => inMemoryKms() as never);
      const ct = await envelope.encrypt(TENANT_A, 'hello');
      const bad = Buffer.from(ct);
      bad[0] = 0x02;
      await expect(envelope.decrypt(TENANT_A, bad)).rejects.toBeInstanceOf(SecretsValidationError);
    });

    it('rejects ciphertext shorter than minimum header size', async () => {
      const tooShort = Buffer.alloc(10);
      tooShort[0] = 0x01;
      await expect(envelope.decrypt(TENANT_A, tooShort)).rejects.toBeInstanceOf(
        SecretsValidationError,
      );
    });

    it('rejects truncated ciphertext (wrap_len claims more than buffer has)', async () => {
      __setClientFactoryForTesting(() => inMemoryKms() as never);
      const ct = await envelope.encrypt(TENANT_A, 'hello');
      // Write a fake huge wrap_len
      const bad = Buffer.from(ct);
      bad.writeUInt16BE(0xfff0, 1);
      await expect(envelope.decrypt(TENANT_A, bad)).rejects.toBeInstanceOf(SecretsValidationError);
    });
  });

  describe('input validation', () => {
    it('encrypt rejects non-UUID tenantId', async () => {
      __setClientFactoryForTesting(() => inMemoryKms() as never);
      await expect(envelope.encrypt('not-a-uuid', 'x')).rejects.toBeInstanceOf(
        SecretsValidationError,
      );
    });

    it('decrypt rejects non-UUID tenantId', async () => {
      __setClientFactoryForTesting(() => inMemoryKms() as never);
      await expect(envelope.decrypt('not-a-uuid', Buffer.alloc(64))).rejects.toBeInstanceOf(
        SecretsValidationError,
      );
    });
  });

  describe('audit logging', () => {
    it('emits [SECRETS-AUDIT] on encrypt success', async () => {
      __setClientFactoryForTesting(() => inMemoryKms() as never);
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await envelope.encrypt(TENANT_A, 'hello');
      const line = spy.mock.calls[0]?.[0] as string;
      expect(line).toContain('[SECRETS-AUDIT]');
      expect(line).toContain('"operation":"encrypt"');
      expect(line).toContain('"outcome":"ok"');
      expect(line).toContain(`"tenant_id":"${TENANT_A}"`);
      expect(line).toContain('"key_id":');
    });

    it('emits [SECRETS-AUDIT] on decrypt AAD-mismatch error', async () => {
      __setClientFactoryForTesting(() => inMemoryKms() as never);
      const ct = await envelope.encrypt(TENANT_A, 'hello');
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await expect(envelope.decrypt(TENANT_B, ct)).rejects.toBeDefined();
      // The decrypt call's audit log is the last one (encrypt logged in a prior scope with no spy)
      const line = spy.mock.calls.at(-1)?.[0] as string;
      expect(line).toContain('"operation":"decrypt"');
      expect(line).toContain('"outcome":"error"');
      expect(line).toContain('"error_code":"ENVELOPE_DECRYPT_FAILED"');
    });
  });

  describe('deterministic sanity check using node crypto directly', () => {
    // Validates our understanding of AES-256-GCM with AAD — not testing our
    // module here, just the underlying primitive.
    it('AES-256-GCM with AAD round-trips', () => {
      const key = crypto.randomBytes(32);
      const iv = crypto.randomBytes(12);
      const aad = Buffer.from('aad', 'utf8');

      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(aad);
      const ct = Buffer.concat([c.update('hi', 'utf8'), c.final()]);
      const tag = c.getAuthTag();

      const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
      d.setAAD(aad);
      d.setAuthTag(tag);
      const pt = Buffer.concat([d.update(ct), d.final()]);
      expect(pt.toString('utf8')).toBe('hi');
    });
  });
});
