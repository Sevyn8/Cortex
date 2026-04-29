/**
 * Tests for `tenants.rotateKeys` (F02 Slice D D.2).
 *
 * Covers the 8-step phase sequence + idempotency contract per
 * planning-doc §"D.2 acceptance" + convention §7.2 / §7.5.
 *
 * KMS is stubbed via `__setClientFactoryForTesting` from
 * `@cortex/secrets`. The stub records the rotation calls and lets
 * tests assert the dispatcher → primitive → KMS chain end-to-end
 * without leaving the test process.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { tenant } from '@cortex/canonical-schema';
import { __setClientFactoryForTesting } from '@cortex/secrets';
import { bindTenantToDbSession } from '../src/db-session.js';
import {
  TenantNotFoundError,
  TenantRotationCooldownError,
  TenantStatusError,
  TenantValidationError,
} from '../src/errors.js';
import { tenants } from '../src/tenants.js';
import { fetchAuditEvents } from './helpers/audit.js';
import { forceRlsOnAuditEvent, getPool, withBoundClient } from './helpers/db.js';

const RUN_TAG = randomUUID().slice(0, 8);
const ACTOR = { type: 'service' as const, id: 'rotate-keys-spec', description: 'RK test' };

/**
 * In-memory KMS stub. Tracks createCryptoKeyVersion +
 * updateCryptoKeyPrimaryVersion + destroyCryptoKeyVersion calls.
 * `getCryptoKey` returns a synthetic primary version derived from
 * the test-state counter so consecutive rotations produce
 * monotonically-increasing version names.
 */
interface KmsStub {
  encrypt: ReturnType<typeof vi.fn>;
  decrypt: ReturnType<typeof vi.fn>;
  getCryptoKey: ReturnType<typeof vi.fn>;
  createCryptoKeyVersion: ReturnType<typeof vi.fn>;
  updateCryptoKeyPrimaryVersion: ReturnType<typeof vi.fn>;
  destroyCryptoKeyVersion: ReturnType<typeof vi.fn>;
  /** Per-key version counter so successive rotations advance the version. */
  versionCounter: Map<string, number>;
  /** Recorded destroyCryptoKeyVersion calls. */
  destroyed: string[];
}

function inMemoryKms(opts: { destroyShouldFail?: boolean } = {}): KmsStub {
  // Tracks the CURRENT primary version per logical key. Implicit
  // initial state: primary = 1. createCryptoKeyVersion mints
  // (current + 1) and promotes; getCryptoKey reads whatever is
  // current. So on a fresh key:
  //   getCryptoKey → primary version 1
  //   createCryptoKeyVersion → version 2; promote → primary now 2
  //   second rotation: getCryptoKey → 2; createCryptoKeyVersion → 3
  // Mirrors how Cloud KMS auto-numbers versions.
  const versionCounter = new Map<string, number>();
  const destroyed: string[] = [];

  function currentPrimary(key: string): number {
    return versionCounter.get(key) ?? 1;
  }
  function mintNextVersion(parent: string): number {
    const next = currentPrimary(parent) + 1;
    return next;
  }
  function promotePrimary(key: string, version: number): void {
    versionCounter.set(key, version);
  }

  return {
    versionCounter,
    destroyed,
    encrypt: vi.fn(),
    decrypt: vi.fn(),
    getCryptoKey: vi.fn((req: { name?: string }) => {
      const key = req.name ?? '';
      const v = currentPrimary(key);
      return Promise.resolve([{ name: key, primary: { name: `${key}/cryptoKeyVersions/${v}` } }]);
    }),
    createCryptoKeyVersion: vi.fn((req: { parent?: string }) => {
      const parent = req.parent ?? '';
      const v = mintNextVersion(parent);
      // Real KMS createCryptoKeyVersion returns the new version but
      // does NOT promote. Promotion happens in updateCryptoKeyPrimaryVersion.
      // The stub stores the just-minted version on a side channel so
      // updateCryptoKeyPrimaryVersion can read it back.
      versionCounter.set(`${parent}::pending`, v);
      return Promise.resolve([{ name: `${parent}/cryptoKeyVersions/${v}` }]);
    }),
    updateCryptoKeyPrimaryVersion: vi.fn((req: { name?: string; cryptoKeyVersionId?: string }) => {
      const key = req.name ?? '';
      const v = parseInt(req.cryptoKeyVersionId ?? '', 10);
      if (!Number.isNaN(v)) promotePrimary(key, v);
      return Promise.resolve([{}]);
    }),
    destroyCryptoKeyVersion: vi.fn((req: { name?: string }) => {
      if (opts.destroyShouldFail === true) {
        return Promise.reject(new Error('synthetic destroy failure'));
      }
      destroyed.push(req.name ?? '');
      return Promise.resolve([{}]);
    }),
  };
}

describe('tenants.rotateKeys', () => {
  let pool: Pool;
  let db: NodePgDatabase<Record<string, never>>;
  const createdTenantIds: string[] = [];
  let kms: KmsStub;

  beforeAll(async () => {
    process.env.GCP_PROJECT_ID ??= 'sevyn8-cortex-dev';
    pool = getPool();
    db = drizzle(pool);
    await forceRlsOnAuditEvent(pool);
  });

  afterAll(async () => {
    for (const id of createdTenantIds) {
      try {
        await withBoundClient(pool, id, async (client) => {
          await client.query('DELETE FROM tenant_config_version WHERE tenant_id = $1', [id]);
          await client.query('DELETE FROM tenant_kms_key WHERE tenant_id = $1', [id]);
        });
      } catch {
        // ignore
      }
      await pool.query('DELETE FROM tenant WHERE id = $1', [id]);
    }
    await pool.end();
    __setClientFactoryForTesting(null);
  });

  afterEach(() => {
    __setClientFactoryForTesting(null);
  });

  function externalIdFor(label: string): string {
    return `test-rotate-keys-${RUN_TAG}-${label}`;
  }

  async function createActive(label: string): Promise<string> {
    const created = await tenants.create(
      db,
      {
        externalId: externalIdFor(label),
        displayName: `RK ${label}`,
        tier: 'STANDARD',
        initialStatus: 'ACTIVE',
      },
      { actor: ACTOR },
    );
    createdTenantIds.push(created.id);
    return created.id;
  }

  function withKms(stub: KmsStub): void {
    __setClientFactoryForTesting(() => stub as never);
  }

  // ───────────────────────────────────────────────────────────────────
  // Happy path
  // ───────────────────────────────────────────────────────────────────

  describe('happy path', () => {
    it('rotates an ACTIVE tenant; updates tenant_kms_key + tenant.last_key_rotated_at; emits TENANT_KEY_ROTATED', async () => {
      kms = inMemoryKms();
      withKms(kms);

      const id = await createActive('happy-1');

      // tenant table has no RLS (control-plane registry per
      // tenants.ts header). Read with the unbound `db` directly.
      const before = await db.select().from(tenant).where(eq(tenant.id, id)).limit(1);
      expect(before[0]?.last_key_rotated_at).toBeNull();

      const after = await tenants.rotateKeys(db, id, { actor: ACTOR }, { trigger: 'on_demand' });

      expect(after.id).toBe(id);
      expect(after.last_key_rotated_at).not.toBeNull();
      expect(kms.createCryptoKeyVersion).toHaveBeenCalledTimes(1);
      expect(kms.updateCryptoKeyPrimaryVersion).toHaveBeenCalledTimes(1);
      expect(kms.destroyCryptoKeyVersion).toHaveBeenCalledTimes(1);

      // tenant_kms_key has FOR ALL RLS (migration 0009); verification
      // SELECT must bind app.tenant_id. Wraps in a drizzle txn with
      // bindTenantToDbSession (mirrors the helpers/audit.ts pattern).
      const rotatedAt = await db.transaction(async (tx) => {
        await bindTenantToDbSession(tx, id);
        const result = await tx.execute<{ rotated_at: Date | null }>(
          sql`SELECT rotated_at FROM tenant_kms_key WHERE tenant_id = ${id}`,
        );
        return result.rows[0]?.rotated_at ?? null;
      });
      expect(rotatedAt).not.toBeNull();

      // Audit row carries before/after envelope with version-qualified names.
      const events = await fetchAuditEvents(db, id);
      const rotated = events.find((e) => e.action === 'TENANT_KEY_ROTATED');
      expect(rotated).toBeDefined();
      expect(rotated?.payload).toMatchObject({
        before_state: { kms_key_resource_name: expect.stringMatching(/cryptoKeyVersions\/1$/) },
        after_state: { kms_key_resource_name: expect.stringMatching(/cryptoKeyVersions\/2$/) },
        trigger: 'on_demand',
      });
      expect(rotated?.actor_type).toBe(ACTOR.type);
      expect(rotated?.actor_id).toBe(ACTOR.id);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Status guards
  // ───────────────────────────────────────────────────────────────────

  describe('status guards', () => {
    it('SUSPENDED tenant rejects with TenantStatusError', async () => {
      kms = inMemoryKms();
      withKms(kms);
      const id = await createActive('status-suspended');
      await tenants.suspend(db, id, 'guard test', { actor: ACTOR });
      await expect(
        tenants.rotateKeys(db, id, { actor: ACTOR }, { trigger: 'on_demand' }),
      ).rejects.toBeInstanceOf(TenantStatusError);
    });

    it('OFFBOARDING tenant rejects with TenantStatusError', async () => {
      kms = inMemoryKms();
      withKms(kms);
      const id = await createActive('status-offboarding');
      await tenants.setStatus(db, id, 'OFFBOARDING', { actor: ACTOR });
      await expect(
        tenants.rotateKeys(db, id, { actor: ACTOR }, { trigger: 'on_demand' }),
      ).rejects.toBeInstanceOf(TenantStatusError);
    });

    it('TERMINATED tenant rejects with TenantStatusError', async () => {
      kms = inMemoryKms();
      withKms(kms);
      const id = await createActive('status-terminated');
      await tenants.setStatus(db, id, 'TERMINATED', { actor: ACTOR });
      await expect(
        tenants.rotateKeys(db, id, { actor: ACTOR }, { trigger: 'on_demand' }),
      ).rejects.toBeInstanceOf(TenantStatusError);
    });

    it('non-existent tenant throws TenantNotFoundError', async () => {
      kms = inMemoryKms();
      withKms(kms);
      const ghostId = randomUUID();
      await expect(
        tenants.rotateKeys(db, ghostId, { actor: ACTOR }, { trigger: 'on_demand' }),
      ).rejects.toBeInstanceOf(TenantNotFoundError);
    });

    it('invalid uuid throws TenantValidationError', async () => {
      kms = inMemoryKms();
      withKms(kms);
      await expect(
        tenants.rotateKeys(db, 'not-a-uuid', { actor: ACTOR }, { trigger: 'on_demand' }),
      ).rejects.toBeInstanceOf(TenantValidationError);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Idempotency / cooldown
  // ───────────────────────────────────────────────────────────────────

  describe('cooldown', () => {
    it('scheduled trigger within 24 h of last rotation no-ops; no audit emit; no KMS call', async () => {
      kms = inMemoryKms();
      withKms(kms);
      const id = await createActive('cooldown-noop');
      // Prime: one successful rotation.
      await tenants.rotateKeys(db, id, { actor: ACTOR }, { trigger: 'on_demand' });
      const eventsAfterPrime = await fetchAuditEvents(db, id);
      const primeKmsCalls = kms.createCryptoKeyVersion.mock.calls.length;

      // Second call as scheduled — within cooldown → no-op.
      const after = await tenants.rotateKeys(db, id, { actor: ACTOR }, { trigger: 'scheduled' });
      expect(after.id).toBe(id);
      expect(kms.createCryptoKeyVersion.mock.calls.length).toBe(primeKmsCalls);
      const eventsAfterNoop = await fetchAuditEvents(db, id);
      expect(eventsAfterNoop.length).toBe(eventsAfterPrime.length);
    });

    it('on_demand trigger within 24 h proceeds (no cooldown for operator-driven rotation)', async () => {
      kms = inMemoryKms();
      withKms(kms);
      const id = await createActive('cooldown-on-demand-bypass');
      await tenants.rotateKeys(db, id, { actor: ACTOR }, { trigger: 'on_demand' });
      const primeKmsCalls = kms.createCryptoKeyVersion.mock.calls.length;

      await tenants.rotateKeys(db, id, { actor: ACTOR }, { trigger: 'on_demand' });
      expect(kms.createCryptoKeyVersion.mock.calls.length).toBe(primeKmsCalls + 1);
    });

    it('errorOnCooldown=true + scheduled within 24 h throws TenantRotationCooldownError', async () => {
      kms = inMemoryKms();
      withKms(kms);
      const id = await createActive('cooldown-error');
      await tenants.rotateKeys(db, id, { actor: ACTOR }, { trigger: 'on_demand' });

      await expect(
        tenants.rotateKeys(
          db,
          id,
          { actor: ACTOR },
          { trigger: 'scheduled', errorOnCooldown: true },
        ),
      ).rejects.toBeInstanceOf(TenantRotationCooldownError);
    });

    it('scheduled trigger past the 24 h cooldown proceeds', async () => {
      kms = inMemoryKms();
      withKms(kms);
      const id = await createActive('cooldown-elapsed');
      await tenants.rotateKeys(db, id, { actor: ACTOR }, { trigger: 'on_demand' });

      // Force the last_key_rotated_at column 25 hours into the past.
      await pool.query(
        `UPDATE tenant SET last_key_rotated_at = now() - interval '25 hours' WHERE id = $1`,
        [id],
      );

      const primeKmsCalls = kms.createCryptoKeyVersion.mock.calls.length;
      await tenants.rotateKeys(db, id, { actor: ACTOR }, { trigger: 'scheduled' });
      expect(kms.createCryptoKeyVersion.mock.calls.length).toBe(primeKmsCalls + 1);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // KMS schedule-destroy failure handling
  // ───────────────────────────────────────────────────────────────────

  describe('KMS scheduleDestroy failure', () => {
    it('rotation commits + audit emits even if scheduleDestroy fails (per §7.5 manual-cleanup runbook)', async () => {
      kms = inMemoryKms({ destroyShouldFail: true });
      withKms(kms);
      const id = await createActive('destroy-fail');

      // Suppress the warn console line emitted by the catch path.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation((..._args: unknown[]) => {
        // suppress
      });

      const after = await tenants.rotateKeys(db, id, { actor: ACTOR }, { trigger: 'on_demand' });
      expect(after.last_key_rotated_at).not.toBeNull();
      expect(warnSpy).toHaveBeenCalled();

      const events = await fetchAuditEvents(db, id);
      const rotated = events.find((e) => e.action === 'TENANT_KEY_ROTATED');
      expect(rotated).toBeDefined();

      warnSpy.mockRestore();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // FOR UPDATE concurrency — structural assertion only
  // ───────────────────────────────────────────────────────────────────

  describe('concurrency', () => {
    it('two concurrent rotations on the same tenant serialize via FOR UPDATE (both succeed; no half-write)', async () => {
      kms = inMemoryKms();
      withKms(kms);
      const id = await createActive('concurrency-1');

      const [a, b] = await Promise.all([
        tenants.rotateKeys(db, id, { actor: ACTOR }, { trigger: 'on_demand' }),
        tenants.rotateKeys(db, id, { actor: ACTOR }, { trigger: 'on_demand' }),
      ]);

      expect(a.id).toBe(id);
      expect(b.id).toBe(id);
      // Two rotations → two version creates + two scheduleDestroy calls.
      expect(kms.createCryptoKeyVersion).toHaveBeenCalledTimes(2);

      // Audit chain has two TENANT_KEY_ROTATED events.
      const events = await fetchAuditEvents(db, id);
      const rotations = events.filter((e) => e.action === 'TENANT_KEY_ROTATED');
      expect(rotations.length).toBe(2);

      // Versions are monotonically increasing across the two rotations.
      const v1 = (rotations[0]?.payload as { after_state?: { kms_key_resource_name?: string } })
        .after_state?.kms_key_resource_name;
      const v2 = (rotations[1]?.payload as { after_state?: { kms_key_resource_name?: string } })
        .after_state?.kms_key_resource_name;
      expect(v1).toBeDefined();
      expect(v2).toBeDefined();
      expect(v1).not.toBe(v2);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Dual-key overlap (per SD6 + convention §7.2)
  // ───────────────────────────────────────────────────────────────────

  describe('dual-key overlap', () => {
    it('app-layer overlap is functionally infinite: rotation does not invalidate previously-recorded version names', async () => {
      kms = inMemoryKms();
      withKms(kms);
      const id = await createActive('overlap-1');

      // Pre-rotation: record what the "current primary version" was.
      // After the first rotation, that exact version name still
      // appears in the audit chain — proving the historical record
      // is preserved (the overlap-window correctness invariant).
      await tenants.rotateKeys(db, id, { actor: ACTOR }, { trigger: 'on_demand' });
      const eventsAfterFirst = await fetchAuditEvents(db, id);
      const firstRotation = eventsAfterFirst.find((e) => e.action === 'TENANT_KEY_ROTATED');
      const oldVersionRecordedInFirst = (
        firstRotation?.payload as { before_state?: { kms_key_resource_name?: string } }
      ).before_state?.kms_key_resource_name;

      // Force cooldown elapse to allow a second scheduled rotation.
      await pool.query(
        `UPDATE tenant SET last_key_rotated_at = now() - interval '25 hours' WHERE id = $1`,
        [id],
      );
      await tenants.rotateKeys(db, id, { actor: ACTOR }, { trigger: 'scheduled' });

      // After two rotations, the original version name still appears
      // verbatim in the immutable audit chain. Per ADR-DB-003 the
      // chain is append-only — payloads referring to old versions
      // remain forensically intact regardless of subsequent rotations.
      const eventsAfterSecond = await fetchAuditEvents(db, id);
      const stillThere = eventsAfterSecond.find(
        (e) =>
          e.action === 'TENANT_KEY_ROTATED' &&
          (e.payload as { before_state?: { kms_key_resource_name?: string } }).before_state
            ?.kms_key_resource_name === oldVersionRecordedInFirst,
      );
      expect(stillThere).toBeDefined();
      expect(oldVersionRecordedInFirst).toMatch(/cryptoKeyVersions\/1$/);
    });
  });
});
