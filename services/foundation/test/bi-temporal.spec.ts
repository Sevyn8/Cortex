// TODO: when multi-developer testing arrives, restructure to use a dedicated
// _test schema that's dropped CASCADE at suite end to avoid public-schema
// pollution. Phase B single-operator dev: the _test_ prefix is sufficient.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { getTestPool } from './helpers/db.js';

const TABLE = '_test_bitemporal_tenants';

describe('bi-temporal helpers (ADR-DB-001)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = getTestPool();

    await pool.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await pool.query(`
      CREATE TABLE ${TABLE} (
        id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id    uuid        NOT NULL,
        business_key text        NOT NULL,
        name         text        NOT NULL,
        valid_time   tstzrange   NOT NULL DEFAULT tstzrange(now(), NULL),
        txn_time     tstzrange   NOT NULL DEFAULT tstzrange(now(), NULL)
      )
    `);
    await pool.query(`
      CREATE TRIGGER ${TABLE}_scd
        BEFORE UPDATE OR DELETE ON ${TABLE}
        FOR EACH ROW EXECUTE FUNCTION cortex.cortex_scd_trigger()
    `);
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await pool.end();
  });

  describe('cortex.at_time_t predicate', () => {
    it('returns true when both ranges contain their anchors', async () => {
      const { rows } = await pool.query(`
        SELECT cortex.at_time_t(
          tstzrange('2026-01-01'::timestamptz, '2026-12-31'::timestamptz),
          tstzrange(now(), NULL),
          '2026-06-15'::timestamptz,
          now()
        ) AS ok
      `);
      expect(rows[0].ok).toBe(true);
    });

    it('returns false when valid_time anchor is outside the valid range', async () => {
      const { rows } = await pool.query(`
        SELECT cortex.at_time_t(
          tstzrange('2026-01-01'::timestamptz, '2026-12-31'::timestamptz),
          tstzrange(now(), NULL),
          '2025-06-15'::timestamptz,
          now()
        ) AS ok
      `);
      expect(rows[0].ok).toBe(false);
    });

    it('returns false when txn_time anchor is outside the txn range', async () => {
      const { rows } = await pool.query(`
        SELECT cortex.at_time_t(
          tstzrange('2026-01-01'::timestamptz, '2026-12-31'::timestamptz),
          tstzrange('2026-03-01'::timestamptz, '2026-06-01'::timestamptz),
          '2026-04-15'::timestamptz,
          '2026-07-15'::timestamptz
        ) AS ok
      `);
      expect(rows[0].ok).toBe(false);
    });
  });

  describe('cortex_scd_trigger on UPDATE', () => {
    it('closes old row + inserts new row; as-of prior returns old value', async () => {
      const tenantId = '11111111-1111-1111-1111-111111111111';

      await pool.query(`INSERT INTO ${TABLE} (tenant_id, business_key, name) VALUES ($1, $2, $3)`, [
        tenantId,
        'acme',
        'ACME Corp',
      ]);

      const before = (await pool.query(`SELECT now() AS t`)).rows[0].t as Date;
      await new Promise((r) => setTimeout(r, 50));

      await pool.query(`UPDATE ${TABLE} SET name = 'ACME Holdings' WHERE business_key = $1`, [
        'acme',
      ]);

      const versions = (
        await pool.query(
          `SELECT name, upper(txn_time) AS upper_tt
           FROM ${TABLE}
           WHERE business_key = 'acme'
           ORDER BY lower(txn_time)`,
        )
      ).rows;

      expect(versions).toHaveLength(2);
      expect(versions[0].name).toBe('ACME Corp');
      expect(versions[0].upper_tt).not.toBeNull(); // closed
      expect(versions[1].name).toBe('ACME Holdings');
      expect(versions[1].upper_tt).toBeNull(); // open

      const asOf = await pool.query(
        `SELECT name FROM ${TABLE}
         WHERE business_key = 'acme'
           AND cortex.at_time_t(valid_time, txn_time, now(), $1::timestamptz)`,
        [before],
      );
      expect(asOf.rows).toHaveLength(1);
      expect(asOf.rows[0].name).toBe('ACME Corp');
    });
  });

  describe('cortex_scd_trigger on DELETE', () => {
    it('closes old row; no new row; as-of prior returns value, as-of now returns nothing', async () => {
      const tenantId = '22222222-2222-2222-2222-222222222222';

      await pool.query(`INSERT INTO ${TABLE} (tenant_id, business_key, name) VALUES ($1, $2, $3)`, [
        tenantId,
        'globex',
        'Globex Inc',
      ]);

      // [BITEMP-DIAG] t_str preserves µs; JS Date on `before` is ms-truncated.
      // See docs/deviations.md §"bi-temporal test flake". Remove after diagnosis.
      const beforeRow = (await pool.query(`SELECT now() AS t, now()::text AS t_str`)).rows[0];
      const before = beforeRow.t as Date;
      const tSRaw = beforeRow.t_str as string;
      await new Promise((r) => setTimeout(r, 50));

      await pool.query(`DELETE FROM ${TABLE} WHERE business_key = $1`, ['globex']);

      const all = (
        await pool.query(
          `SELECT name, upper(txn_time) AS upper_tt,
                  lower(txn_time)::text AS t_i_lower_str,
                  upper(txn_time)::text AS t_d_upper_str
           FROM ${TABLE}
           WHERE business_key = 'globex'`,
        )
      ).rows;
      expect(all).toHaveLength(1);
      expect(all[0].name).toBe('Globex Inc');
      expect(all[0].upper_tt).not.toBeNull(); // closed

      const asOfPrior = await pool.query(
        `SELECT name FROM ${TABLE}
         WHERE business_key = 'globex'
           AND cortex.at_time_t(valid_time, txn_time, now(), $1::timestamptz)`,
        [before],
      );
      // [BITEMP-DIAG] Logs on both pass and fail so healthy vs failing µs-delta
      // distributions are visible. Remove after flake is diagnosed.
      console.error(
        `[BITEMP-DIAG] T_I=${all[0].t_i_lower_str} T_D=${all[0].t_d_upper_str} ` +
          `T_S_raw=${tSRaw} before=${before.toISOString()} rows=${asOfPrior.rows.length}`,
      );
      expect(asOfPrior.rows).toHaveLength(1);
      expect(asOfPrior.rows[0].name).toBe('Globex Inc');

      const asOfNow = await pool.query(
        `SELECT name FROM ${TABLE}
         WHERE business_key = 'globex'
           AND cortex.at_time_t(valid_time, txn_time, now(), now())`,
      );
      expect(asOfNow.rows).toHaveLength(0);
    });
  });
});
