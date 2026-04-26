/**
 * Integration tests for `@cortex/encryption`.
 *
 * Real DB (p09-repro) for audit_event INSERT + chain trigger + RLS.
 * In-memory KMS stub (via `__setClientFactoryForTesting` from
 * @cortex/secrets) for DEK wrap/unwrap — DEK wrap is faked, AEAD
 * itself runs through real `node:crypto` AES-256-GCM. AAD-mismatch /
 * cross-tenant / tampered-ciphertext cases behave identically to real
 * KMS, so the cryptographic isolation property is genuinely exercised.
 *
 * Mirrors `packages/audit-events/test/emit.spec.ts` setup convention.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { bindTenantToDbSession } from '@cortex/tenant-context';
import { __setClientFactoryForTesting } from '@cortex/secrets';
import { AuditEventEmissionError } from '@cortex/audit-events';
import { createLogger } from '@cortex/observability';
import { createLogCapture } from '@cortex/observability/test-utils';
import {
  EncryptionExecutionError,
  EncryptionValidationError,
  __resetForTesting,
  __setEmitterForTesting,
  createEncryptionEmitter,
  decryptForTenant,
  encryptForTenant,
  type EncryptedPayload,
} from '../src/index.js';

// buildKeyResourceName needs GCP_PROJECT_ID; placeholder is fine since
// we never hit real KMS (the stub intercepts wrap/unwrap).
process.env.GCP_PROJECT_ID ??= 'sevyn8-cortex-dev';

// In-memory KMS stub. Wrap = "KMSW" magic + raw DEK; unwrap = strip
// magic. Same shape as packages/secrets/test/kms.spec.ts:inMemoryKms.
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
        return Promise.reject(Object.assign(new Error('KMS unwrap failed'), { code: 3 }));
      }
      return Promise.resolve([{ plaintext: wrapped.slice(4) }]);
    }),
  };
}

let pool: Pool;
let db: NodePgDatabase<Record<string, never>>;

beforeAll(async () => {
  pool = new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5433),
    user: process.env.PGUSER ?? 'test_user',
    password: process.env.PGPASSWORD ?? 'testpw',
    database: process.env.PGDATABASE ?? 'cortex',
  });
  db = drizzle(pool);
  // audit_event is owned by test_user in p09-repro; without FORCE the
  // owner bypasses RLS, which makes the unbound-emit denial test
  // silently pass.
  await pool.query('ALTER TABLE audit_event FORCE ROW LEVEL SECURITY');
  __setClientFactoryForTesting(() => inMemoryKms() as never);
});

afterAll(async () => {
  __setClientFactoryForTesting(null);
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

type AuditRow = {
  action: string;
  resource: string;
  occurred_at: string;
  payload: Record<string, unknown>;
  prev_hash: Buffer | null;
  curr_hash: Buffer;
} & Record<string, unknown>;

async function fetchAuditRows(tenantId: string): Promise<AuditRow[]> {
  return db.transaction(async (tx) => {
    await bindTenantToDbSession(tx, tenantId);
    const r = await tx.execute<AuditRow>(sql`
      SELECT action, resource, occurred_at, payload, prev_hash, curr_hash
      FROM audit_event
      WHERE tenant_id = ${tenantId}
      ORDER BY occurred_at ASC, ctid ASC
    `);
    return r.rows;
  });
}

// ─────────────────────────────────────────────────────────────────────
// Group: encryptForTenant happy path
// ─────────────────────────────────────────────────────────────────────

describe('encryptForTenant — happy path', () => {
  it('encrypts string plaintext, returns valid EncryptedPayload structure', async () => {
    const tenantId = randomUUID();
    const payload = await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, tenantId);
      return encryptForTenant(tx, { tenantId, plaintext: 'sensitive PII string' });
    });

    expect(Buffer.isBuffer(payload.envelope)).toBe(true);
    expect(payload.envelope.byteLength).toBeGreaterThan(0);
    expect(payload.envelope.readUInt8(0)).toBe(0x01); // version byte
    expect(payload.keyResourceName).toContain('cortex-general-key');
    expect(payload.tenantId).toBe(tenantId);
    expect(payload.aad.equals(Buffer.from(tenantId, 'utf8'))).toBe(true);
  });

  it('encrypts Buffer plaintext, returns valid EncryptedPayload structure', async () => {
    const tenantId = randomUUID();
    const buf = Buffer.from([0x01, 0x02, 0x03, 0xff, 0xfe, 0x00]);
    const payload = await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, tenantId);
      return encryptForTenant(tx, { tenantId, plaintext: buf });
    });
    expect(payload.envelope.byteLength).toBeGreaterThan(buf.byteLength);
    expect(payload.tenantId).toBe(tenantId);
  });

  it('NFC-normalizes string plaintext before encryption (round-trip yields composed form)', async () => {
    const tenantId = randomUUID();
    const decomposed = 'cafe\u0301'; // c-a-f-e + combining acute (5 code units)
    const composed = 'caf\u00e9'; // c-a-f-é (4 code units)
    expect(decomposed.length).toBe(5);
    expect(composed.length).toBe(4);

    const payload = await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, tenantId);
      return encryptForTenant(tx, { tenantId, plaintext: decomposed });
    });
    const decrypted = await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, tenantId);
      return decryptForTenant(tx, { tenantId, payload });
    });
    const recovered = decrypted.toString('utf8');
    expect(recovered).toBe(composed);
    expect(recovered.normalize('NFC')).toBe(recovered);
    expect(recovered.normalize('NFD')).not.toBe(recovered);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group: decryptForTenant happy path
// ─────────────────────────────────────────────────────────────────────

describe('decryptForTenant — happy path', () => {
  it('round-trip Buffer plaintext: encrypt → decrypt returns identical bytes', async () => {
    const tenantId = randomUUID();
    const original = Buffer.from([0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80]);
    const result = await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, tenantId);
      const payload = await encryptForTenant(tx, { tenantId, plaintext: original });
      return decryptForTenant(tx, { tenantId, payload });
    });
    expect(result.equals(original)).toBe(true);
  });

  it("round-trip string plaintext: encrypt('hello') → decrypt → 'hello'", async () => {
    const tenantId = randomUUID();
    const result = await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, tenantId);
      const payload = await encryptForTenant(tx, { tenantId, plaintext: 'hello' });
      return decryptForTenant(tx, { tenantId, payload });
    });
    expect(result.toString('utf8')).toBe('hello');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group: Cross-tenant decryption isolation
// ─────────────────────────────────────────────────────────────────────

describe('cross-tenant decryption isolation', () => {
  it('decrypt with mismatched tenantId throws EncryptionValidationError (defense in depth)', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const payload = await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, tenantA);
      return encryptForTenant(tx, { tenantId: tenantA, plaintext: 'secret-for-A' });
    });

    let captured: unknown;
    try {
      await db.transaction(async (tx) => {
        await bindTenantToDbSession(tx, tenantB);
        await decryptForTenant(tx, { tenantId: tenantB, payload });
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(EncryptionValidationError);
    expect((captured as Error).message).toMatch(/does not match payload\.tenantId/);
  });

  it('AAD mismatch via tampered payload.tenantId surfaces as EncryptionExecutionError (real AEAD)', async () => {
    // Encrypt for tenant A, then construct DecryptParams that bypass
    // the explicit tenantId-match check by setting BOTH the supplied
    // tenantId AND the payload.tenantId field to tenant B. The aad
    // field on the payload stays at utf8(tenantA) — but envelope.decrypt
    // recomputes AAD from the supplied tenantId (tenantB) and the
    // ciphertext was sealed with utf8(tenantA), so the auth tag fails.
    // This exercises the cryptographic isolation, not the explicit
    // check.
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const aPayload = await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, tenantA);
      return encryptForTenant(tx, { tenantId: tenantA, plaintext: 'secret-for-A' });
    });

    const tampered: EncryptedPayload = {
      envelope: aPayload.envelope,
      keyResourceName: aPayload.keyResourceName,
      tenantId: tenantB, // ← swapped
      aad: aPayload.aad, // forensic-only; not used by decrypt
    };

    let captured: unknown;
    try {
      await db.transaction(async (tx) => {
        await bindTenantToDbSession(tx, tenantB);
        await decryptForTenant(tx, { tenantId: tenantB, payload: tampered });
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(EncryptionExecutionError);
    expect((captured as Error).message).toMatch(/AAD mismatch|cross-tenant|corrupted/);
    const cause = (captured as { cause?: { name?: string } }).cause;
    expect(cause?.name).toBe('EnvelopeDecryptError');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group: Audit emission verification
// ─────────────────────────────────────────────────────────────────────

describe('audit emission', () => {
  it('PII_ENCRYPTED event lands in audit_event with after_state forensics', async () => {
    const tenantId = randomUUID();
    const payload = await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, tenantId);
      return encryptForTenant(tx, { tenantId, plaintext: 'audit-test-payload' });
    });

    const rows = await fetchAuditRows(tenantId);
    const encrypted = rows.filter((r) => r.action === 'PII_ENCRYPTED');
    expect(encrypted).toHaveLength(1);
    const event = encrypted[0]!;
    expect(event.resource).toBe(`pii:${tenantId}`);
    expect(event.payload).toMatchObject({
      after_state: {
        tenant_id: tenantId,
        key_resource_name: payload.keyResourceName,
        payload_byte_size: payload.envelope.byteLength,
      },
    });
  });

  it('PII_DECRYPTED event lands on every decrypt call', async () => {
    const tenantId = randomUUID();
    await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, tenantId);
      const payload = await encryptForTenant(tx, { tenantId, plaintext: 'roundtrip' });
      await decryptForTenant(tx, { tenantId, payload });
    });
    const rows = await fetchAuditRows(tenantId);
    const decrypted = rows.filter((r) => r.action === 'PII_DECRYPTED');
    expect(decrypted).toHaveLength(1);
    expect(decrypted[0]!.resource).toBe(`pii:${tenantId}`);
  });

  it('encrypt + decrypt produces 2 chained audit rows in order', async () => {
    const tenantId = randomUUID();
    await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, tenantId);
      const payload = await encryptForTenant(tx, { tenantId, plaintext: 'chain-test' });
      await decryptForTenant(tx, { tenantId, payload });
    });

    const rows = await fetchAuditRows(tenantId);
    expect(rows.map((r) => r.action)).toEqual(['PII_ENCRYPTED', 'PII_DECRYPTED']);

    // Chain integrity: row 1's prev_hash equals row 0's curr_hash.
    // Both hashes are bytea — compare as hex.
    const row0CurrHex = rows[0]!.curr_hash.toString('hex');
    const row1PrevHex = rows[1]!.prev_hash?.toString('hex');
    expect(row1PrevHex).toBe(row0CurrHex);
    expect(row0CurrHex).not.toBe(rows[1]!.curr_hash.toString('hex'));
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group: RLS enforcement
// ─────────────────────────────────────────────────────────────────────

describe('RLS enforcement', () => {
  it('encryptForTenant without bindTenantToDbSession throws AuditEventEmissionError (42501)', async () => {
    const tenantId = randomUUID();
    let captured: unknown;
    try {
      await db.transaction(async (tx) => {
        // No bindTenantToDbSession — encrypt itself succeeds (no DB
        // touch) but the audit emission's RLS write policy denies.
        await encryptForTenant(tx, { tenantId, plaintext: 'denied' });
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(AuditEventEmissionError);
    const cause = (captured as { cause?: { code?: unknown } }).cause;
    expect(cause?.code).toBe('42501');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group: Validation failures
// ─────────────────────────────────────────────────────────────────────

describe('validation failures', () => {
  it('bad UUID tenantId throws EncryptionValidationError before any KMS call (no audit row)', async () => {
    const realTenantId = randomUUID();
    let captured: unknown;
    try {
      await db.transaction(async (tx) => {
        await bindTenantToDbSession(tx, realTenantId);
        await encryptForTenant(tx, {
          tenantId: 'not-a-uuid',
          plaintext: 'x',
        });
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(EncryptionValidationError);

    // No audit row should have been emitted under the real tenant id —
    // validation throws before any side effect.
    const rows = await fetchAuditRows(realTenantId);
    expect(rows).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group: Soft-size warning + hybrid DI escape hatches
// ─────────────────────────────────────────────────────────────────────

describe('soft-size warning + hybrid DI', () => {
  it('encrypting >64 KB plaintext emits a WARN through the configured logger; encrypt still succeeds', async () => {
    const tenantId = randomUUID();
    const capture = createLogCapture();
    const logger = createLogger({ moduleId: 'cortex-encryption-test', destination: capture });
    const customEmitter = createEncryptionEmitter({ logger });

    // 70 KB plaintext → envelope ≈ 70 KB + ~67 B framing > 64 KB.
    const big = 'x'.repeat(70 * 1024);

    const payload = await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, tenantId);
      return customEmitter.encrypt(tx, { tenantId, plaintext: big });
    });
    await capture.flush();

    expect(payload.envelope.byteLength).toBeGreaterThan(64 * 1024);

    const warn = capture.logs.find(
      (line) => typeof line.envelope_byte_size === 'number' && line.envelope_byte_size > 64 * 1024,
    );
    expect(warn).toBeDefined();
    expect(warn?.severity).toBe('WARNING');
    expect(warn?.tenant_id).toBe(tenantId);

    // Soft warn does NOT block emission — payload returned successfully.
    expect(Buffer.isBuffer(payload.envelope)).toBe(true);
  });

  it('__setEmitterForTesting + __resetForTesting swap and restore the module-scope emitter', async () => {
    const tenantId = randomUUID();

    // Install a custom emitter whose encrypt returns a sentinel value
    // distinguishable from real envelope output.
    const sentinel: EncryptedPayload = {
      envelope: Buffer.from('SENTINEL-ENVELOPE'),
      keyResourceName: 'sentinel-key',
      tenantId,
      aad: Buffer.from(tenantId, 'utf8'),
    };
    __setEmitterForTesting({
      encrypt: () => Promise.resolve(sentinel),
      decrypt: () => Promise.resolve(Buffer.from('sentinel-pt')),
    });
    try {
      const swapped = await db.transaction(async (tx) => {
        await bindTenantToDbSession(tx, tenantId);
        return encryptForTenant(tx, { tenantId, plaintext: 'whatever' });
      });
      expect(swapped.keyResourceName).toBe('sentinel-key');
      expect(swapped.envelope.toString('utf8')).toBe('SENTINEL-ENVELOPE');
    } finally {
      __resetForTesting();
    }

    // After reset, the default emitter is back — real envelope (with
    // version byte 0x01) is produced again.
    const defaultPayload = await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, tenantId);
      return encryptForTenant(tx, { tenantId, plaintext: 'whatever' });
    });
    expect(defaultPayload.envelope.readUInt8(0)).toBe(0x01);
    expect(defaultPayload.keyResourceName).toContain('cortex-general-key');
  });
});
