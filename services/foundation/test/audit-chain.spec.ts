// TODO: when multi-developer testing arrives, restructure to use a dedicated
// _test_audit_event mirror table + generalized trigger so test state never
// touches the real audit_event. Phase B single-operator dev: TRUNCATE +
// FORCE toggle on the real table is acceptable.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { withTenantContext, withoutTenantContext } from '@cortex/canonical-schema/rls-test';
import { getPool as getTestPool } from '@cortex/test-db-harness';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('audit event chain (ADR-DB-003)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = getTestPool();
    // Clear stale test rows. TRUNCATE bypasses the append-only ROW trigger
    // (TRUNCATE does not fire per-row triggers) — intentional for dev cleanup.
    await pool.query(`TRUNCATE TABLE audit_event`);
    // FORCE so postgres superuser is subject to RLS (same pattern as RLS spec).
    await pool.query(`ALTER TABLE audit_event FORCE ROW LEVEL SECURITY`);
  });

  afterAll(async () => {
    // Restore production posture (real services don't run as superuser).
    await pool.query(`ALTER TABLE audit_event NO FORCE ROW LEVEL SECURITY`);
    await pool.query(`TRUNCATE TABLE audit_event`);
    await pool.end();
  });

  // Tests in this describe block form a linear narrative: genesis event,
  // second-event chaining, tenant B's independent genesis, hash reproducibility.
  // State is shared across tests in declaration order. DO NOT add per-test
  // beforeEach that clears audit_event — tests depend on prior-test insertions.
  describe('chain computation on INSERT', () => {
    it('genesis event for tenant A has NULL prev_hash + 32-byte curr_hash', async () => {
      const result = await withTenantContext(pool, TENANT_A, async (tx) => {
        const { rows } = await tx.query(
          `INSERT INTO audit_event (tenant_id, actor_type, actor_id, action, resource, payload)
           VALUES ($1, 'system', 'test-actor', 'create', 'tenant', '{"name":"ACME"}'::jsonb)
           RETURNING prev_hash, curr_hash`,
          [TENANT_A],
        );
        return rows[0];
      });
      expect(result.prev_hash).toBeNull();
      expect(Buffer.isBuffer(result.curr_hash)).toBe(true);
      expect(result.curr_hash.length).toBe(32); // SHA-256 = 32 bytes
    });

    it('second event for tenant A chains prev_hash = first.curr_hash', async () => {
      const { first, second } = await withTenantContext(pool, TENANT_A, async (tx) => {
        const first = (
          await tx.query(
            `SELECT curr_hash FROM audit_event
               WHERE tenant_id = $1 ORDER BY occurred_at ASC LIMIT 1`,
            [TENANT_A],
          )
        ).rows[0];

        const second = (
          await tx.query(
            `INSERT INTO audit_event (tenant_id, actor_type, actor_id, action, resource)
               VALUES ($1, 'user', 'user-1', 'update', 'tenant')
               RETURNING prev_hash, curr_hash`,
            [TENANT_A],
          )
        ).rows[0];

        return { first, second };
      });
      expect(second.prev_hash).toEqual(first.curr_hash);
    });

    it("tenant B's genesis event has NULL prev_hash (independent chain)", async () => {
      const result = await withTenantContext(pool, TENANT_B, async (tx) => {
        const { rows } = await tx.query(
          `INSERT INTO audit_event (tenant_id, actor_type, actor_id, action, resource)
           VALUES ($1, 'service', 'svc-b', 'probe', 'health')
           RETURNING prev_hash`,
          [TENANT_B],
        );
        return rows[0];
      });
      expect(result.prev_hash).toBeNull();
    });

    it('stored curr_hash is reproducible via cortex.audit_canonical_hash', async () => {
      // Recompute server-side so occurred_at never round-trips through JS Date
      // (which has ms precision and would drop Postgres's µs, changing the hash).
      // Verifies the trigger uses the same canonical-hash path as a direct call.
      await withTenantContext(pool, TENANT_A, async (tx) => {
        const { rows } = await tx.query(
          `SELECT
             curr_hash AS stored,
             sha256(
               COALESCE(prev_hash, '\\x'::bytea) ||
               cortex.audit_canonical_hash(
                 event_id, tenant_id, actor_type, actor_id, actor_description,
                 action, resource, payload, occurred_at
               )
             ) AS recomputed
           FROM audit_event
           WHERE tenant_id = $1
           ORDER BY occurred_at ASC
           LIMIT 1`,
          [TENANT_A],
        );
        expect(rows[0].recomputed).toEqual(rows[0].stored);
      });
    });
  });

  describe('append-only enforcement', () => {
    it('UPDATE on audit_event raises 2F002', async () => {
      await expect(
        withTenantContext(pool, TENANT_A, async (tx) => {
          await tx.query(`UPDATE audit_event SET action = 'tampered' WHERE tenant_id = $1`, [
            TENANT_A,
          ]);
        }),
      ).rejects.toMatchObject({
        code: '2F002',
        message: expect.stringContaining('append-only'),
      });
    });

    it('DELETE on audit_event raises 2F002', async () => {
      await expect(
        withTenantContext(pool, TENANT_A, async (tx) => {
          await tx.query(`DELETE FROM audit_event WHERE tenant_id = $1`, [TENANT_A]);
        }),
      ).rejects.toMatchObject({
        code: '2F002',
        message: expect.stringContaining('append-only'),
      });
    });
  });

  describe('RLS isolation', () => {
    it("tenant A cannot SELECT tenant B's events", async () => {
      const rows = await withTenantContext(pool, TENANT_A, async (tx) => {
        const { rows } = await tx.query(`SELECT tenant_id FROM audit_event WHERE tenant_id = $1`, [
          TENANT_B,
        ]);
        return rows;
      });
      expect(rows).toHaveLength(0);
    });

    it("tenant B sees only tenant B's events", async () => {
      const rows = await withTenantContext(pool, TENANT_B, async (tx) => {
        const { rows } = await tx.query(`SELECT tenant_id FROM audit_event`);
        return rows;
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.tenant_id === TENANT_B)).toBe(true);
    });

    it('without tenant context, SELECT raises via current_tenant_id', async () => {
      await expect(
        withoutTenantContext(pool, async (tx) => {
          await tx.query(`SELECT * FROM audit_event`);
        }),
      ).rejects.toMatchObject({
        code: '42501',
        message: expect.stringContaining('app.tenant_id is not set'),
      });
    });
  });
});
