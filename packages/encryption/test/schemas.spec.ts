import { describe, expect, it } from 'vitest';
import { decryptParamsSchema, encryptParamsSchema, encryptedPayloadSchema } from '../src/index.js';

// ─────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const KEY_RESOURCE_NAME =
  'projects/test-proj/locations/asia-south1/keyRings/cortex-keyring/cryptoKeys/cortex-general-key';

function validPayload() {
  return {
    envelope: Buffer.from('opaque-envelope-bytes'),
    keyResourceName: KEY_RESOURCE_NAME,
    tenantId: TENANT_ID,
    aad: Buffer.from(TENANT_ID, 'utf8'),
  };
}

// ─────────────────────────────────────────────────────────────────────
// encryptParamsSchema
// ─────────────────────────────────────────────────────────────────────

describe('encryptParamsSchema', () => {
  it('accepts valid string plaintext + UUID tenantId', () => {
    const r = encryptParamsSchema.safeParse({
      tenantId: TENANT_ID,
      plaintext: 'sensitive PII string',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.tenantId).toBe(TENANT_ID);
      expect(r.data.plaintext).toBe('sensitive PII string');
    }
  });

  it('accepts valid Buffer plaintext', () => {
    const buf = Buffer.from('sensitive PII bytes');
    const r = encryptParamsSchema.safeParse({
      tenantId: TENANT_ID,
      plaintext: buf,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(Buffer.isBuffer(r.data.plaintext)).toBe(true);
    }
  });

  it('rejects empty Buffer (byteLength > 0 refinement)', () => {
    const r = encryptParamsSchema.safeParse({
      tenantId: TENANT_ID,
      plaintext: Buffer.alloc(0),
    });
    expect(r.success).toBe(false);
  });

  it('rejects non-UUID tenantId', () => {
    const r = encryptParamsSchema.safeParse({
      tenantId: 'not-a-uuid',
      plaintext: 'x',
    });
    expect(r.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// encryptedPayloadSchema
// ─────────────────────────────────────────────────────────────────────

describe('encryptedPayloadSchema', () => {
  it('accepts a valid full payload (all 4 fields populated)', () => {
    const r = encryptedPayloadSchema.safeParse(validPayload());
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.envelope.byteLength).toBeGreaterThan(0);
      expect(r.data.keyResourceName).toBe(KEY_RESOURCE_NAME);
      expect(r.data.tenantId).toBe(TENANT_ID);
      expect(r.data.aad.byteLength).toBeGreaterThan(0);
    }
  });

  it('rejects empty envelope buffer', () => {
    const r = encryptedPayloadSchema.safeParse({ ...validPayload(), envelope: Buffer.alloc(0) });
    expect(r.success).toBe(false);
  });

  it('rejects empty aad buffer', () => {
    const r = encryptedPayloadSchema.safeParse({ ...validPayload(), aad: Buffer.alloc(0) });
    expect(r.success).toBe(false);
  });

  it('rejects empty keyResourceName string AND non-UUID tenantId', () => {
    const cases: Record<string, unknown>[] = [
      { ...validPayload(), keyResourceName: '' },
      { ...validPayload(), tenantId: 'not-a-uuid' },
    ];
    for (const fixture of cases) {
      const r = encryptedPayloadSchema.safeParse(fixture);
      expect(r.success).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// decryptParamsSchema
// ─────────────────────────────────────────────────────────────────────

describe('decryptParamsSchema', () => {
  it('accepts valid params; rejects malformed nested payload', () => {
    const ok = decryptParamsSchema.safeParse({
      tenantId: TENANT_ID,
      payload: validPayload(),
    });
    expect(ok.success).toBe(true);

    // Nested-payload validation propagates: an empty envelope inside
    // payload must surface as a parse failure on the outer schema.
    const badNested = decryptParamsSchema.safeParse({
      tenantId: TENANT_ID,
      payload: { ...validPayload(), envelope: Buffer.alloc(0) },
    });
    expect(badNested.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// NFC normalization NOT enforced at the schema layer
//
// Decomposed strings written as escape sequences (́ = combining
// acute, é = composed é) to prevent silent NFC normalization by
// editor / formatter / write pipelines. Bare 'café' literals are unsafe
// — the source-file byte representation can drift between (composed,
// 4 codepoints, U+00E9) and (decomposed, 5 codepoints, U+0065 U+0301)
// depending on tooling, defeating the test. See roadmap §1.11.
// ─────────────────────────────────────────────────────────────────────

describe('NFC normalization NOT enforced at schema layer', () => {
  it('passes decomposed strings through unchanged (canonicalization is a runtime concern)', () => {
    const decomposed = 'cafe\u0301'; // c-a-f-e + combining acute (5 code units)
    const composed = 'caf\u00e9'; // c-a-f-é (4 code units)
    expect(decomposed.length).toBe(5);
    expect(composed.length).toBe(4);

    const r = encryptParamsSchema.safeParse({
      tenantId: TENANT_ID,
      plaintext: decomposed,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      // Schema accepts as-is — the NFC normalization step lives in the
      // runtime emit path (encrypt.ts, before Buffer.from(..., 'utf8')).
      expect(r.data.plaintext).toBe(decomposed);
      expect(r.data.plaintext).not.toBe(composed);
    }
  });
});
