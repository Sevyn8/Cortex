import { describe, expect, it } from 'vitest';
import {
  ENCRYPTION_PAYLOAD_VERSION,
  type DecryptParams,
  type EncryptParams,
  type EncryptedPayload,
} from '../src/index.js';

// ─────────────────────────────────────────────────────────────────────
// Compile-time helper: assert two types are equal. Forces TS to surface
// any divergence in the type-system shape; failure is a typecheck error,
// not a runtime failure.
// ─────────────────────────────────────────────────────────────────────

type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

describe('ENCRYPTION_PAYLOAD_VERSION', () => {
  it('equals 1 and is narrowed to the literal type via `as const`', () => {
    expect(ENCRYPTION_PAYLOAD_VERSION).toBe(1);

    // Compile-time: the constant is `1` (literal), not `number`. If the
    // `as const` narrowing ever drops, this assertion fails to compile.
    const _check: Equals<typeof ENCRYPTION_PAYLOAD_VERSION, 1> = true;
    expect(_check).toBe(true);
  });
});

describe('EncryptParams shape', () => {
  it('accepts string plaintext (typed variable compiles)', () => {
    const params: EncryptParams = {
      tenantId: TENANT_ID,
      plaintext: 'sensitive PII string',
    };
    expect(params.tenantId).toBe(TENANT_ID);
  });

  it('accepts Buffer plaintext (typed variable compiles)', () => {
    const params: EncryptParams = {
      tenantId: TENANT_ID,
      plaintext: Buffer.from('sensitive PII bytes'),
    };
    expect(Buffer.isBuffer(params.plaintext)).toBe(true);
  });
});

describe('EncryptedPayload shape', () => {
  it('structural shape (envelope, keyResourceName, tenantId, aad)', () => {
    const payload: EncryptedPayload = {
      envelope: Buffer.from('opaque-envelope-bytes'),
      keyResourceName: 'projects/x/locations/y/keyRings/z/cryptoKeys/k',
      tenantId: TENANT_ID,
      aad: Buffer.from(TENANT_ID, 'utf8'),
    };
    expect(payload.tenantId).toBe(TENANT_ID);
  });
});

describe('DecryptParams nesting', () => {
  it('accepts a full nested EncryptedPayload', () => {
    const params: DecryptParams = {
      tenantId: TENANT_ID,
      payload: {
        envelope: Buffer.from('opaque-envelope-bytes'),
        keyResourceName: 'projects/x/locations/y/keyRings/z/cryptoKeys/k',
        tenantId: TENANT_ID,
        aad: Buffer.from(TENANT_ID, 'utf8'),
      },
    };
    expect(params.tenantId).toBe(params.payload.tenantId);
  });
});
