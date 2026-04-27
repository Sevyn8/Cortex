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

// Tenants seeded by `seedTenantKmsKey` for tests that exercise
// `encryptForTenant` (which now consults `tenant_kms_key` per F02 Slice
// A's `getKeyForTenant` swap). Cleaned in afterAll.
const seededTenantIds: string[] = [];

/**
 * Seed a `tenant` row + `tenant_kms_key` row for the given tenantId.
 * Required for every test that invokes `encryptForTenant` /
 * `decryptForTenant` post-F02-swap — the resolver queries
 * `tenant_kms_key` and throws `TenantKmsKeyNotFoundError` if no row
 * exists. The `tenant` insert is needed because `tenant_kms_key.tenant_id`
 * has a FK to `tenant.id`. Idempotent via ON CONFLICT for the
 * tenant-reuse case (e.g., the hybrid-DI test that uses one tenantId
 * across two transactions).
 */
async function seedTenantKmsKey(tenantId: string): Promise<void> {
  await pool.query(
    `INSERT INTO tenant (id, external_id, display_name, tier)
     VALUES ($1, $2, 'Test', 'STANDARD')
     ON CONFLICT (id) DO NOTHING`,
    [tenantId, `test-encrypt-${tenantId.slice(0, 8)}`],
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    await client.query(
      `INSERT INTO tenant_kms_key (tenant_id, kms_key_resource_name)
       VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [
        tenantId,
        'projects/sevyn8-cortex-dev/locations/asia-south1/keyRings/cortex-keyring/cryptoKeys/cortex-general-key',
      ],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  if (!seededTenantIds.includes(tenantId)) {
    seededTenantIds.push(tenantId);
  }
}

afterAll(async () => {
  // Cleanup substrate seeded by tests. tenant_kms_key has FK ON DELETE
  // RESTRICT; child rows go first under tenant binding. tenant table
  // has no RLS; direct DELETE.
  for (const id of seededTenantIds) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [id]);
      await client.query('DELETE FROM tenant_kms_key WHERE tenant_id = $1', [id]);
      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK').catch(() => undefined);
    } finally {
      client.release();
    }
    await pool.query('DELETE FROM tenant WHERE id = $1', [id]);
  }
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
    await seedTenantKmsKey(tenantId);
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
    await seedTenantKmsKey(tenantId);
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
    await seedTenantKmsKey(tenantId);
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
    await seedTenantKmsKey(tenantId);
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
    await seedTenantKmsKey(tenantId);
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
    await seedTenantKmsKey(tenantA);
    await seedTenantKmsKey(tenantB);
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
    await seedTenantKmsKey(tenantA);
    await seedTenantKmsKey(tenantB);
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
    await seedTenantKmsKey(tenantId);
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
    await seedTenantKmsKey(tenantId);
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
    await seedTenantKmsKey(tenantId);
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
  it('encryptForTenant without bindTenantToDbSession fails closed via cortex.current_tenant_id()', async () => {
    // Pre-F02-swap, this test asserted on AuditEventEmissionError (42501)
    // because the audit emission was the first RLS-protected write. F02
    // Slice A's getKeyForTenant swap (sub-phase 5.2) added a SECOND
    // RLS-protected operation earlier in the call sequence: the
    // tenant_kms_key SELECT, which evaluates the FOR-ALL policy's USING
    // clause `tenant_id = cortex.current_tenant_id()`. The
    // `cortex.current_tenant_id()` function is fail-closed (per
    // ADR-DB-002) — it raises when `app.tenant_id` is not set. The
    // error surfaces as a raw DB error before either the
    // TenantKmsKeyNotFoundError "0 rows" branch or the audit-emit's
    // 42501 path. The error MESSAGE is the canonical signal; the
    // class varies because the error bubbles from PG via Drizzle.
    const tenantId = randomUUID();
    await seedTenantKmsKey(tenantId);
    let captured: unknown;
    try {
      await db.transaction(async (tx) => {
        // No bindTenantToDbSession — fail-closed at the first
        // RLS-policy evaluation (the tenant_kms_key SELECT).
        await encryptForTenant(tx, { tenantId, plaintext: 'denied' });
      });
    } catch (err) {
      captured = err;
    }
    // Property: the call rejects, and the error message identifies the
    // missing-bind cause (cortex.current_tenant_id / app.tenant_id).
    // Same proof as the pre-swap "42501 audit-RLS denial" — bind required.
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toMatch(/app\.tenant_id|current_tenant_id/);
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
    await seedTenantKmsKey(tenantId);
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
    await seedTenantKmsKey(tenantId);

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
