/**
 * Tests for `@cortex/temporal-query` (F03 Slice B).
 *
 * Covers all 5 functions + the F03 spec acceptance scenario:
 * "Create a retail.Product, update its price, query 'as of last week'
 *  — returns last week's price."
 *
 * Test fixture: retail_product table created from
 * test/fixtures/retail_product.sql in beforeAll. DROPped in afterAll.
 * Recipe-applied; the SCD trigger from migration 0002 fires on every
 * mutation (post-0006 binding includes INSERT branch for ms quantum).
 *
 * SCD-rotated `id` semantics: the SCD trigger rotates `id` on UPDATE
 * (NEW.id := gen_random_uuid()), so each row version has a distinct
 * `id`. The library's API takes `id` as the row-version identifier;
 * the per-version row remains in the table after closure (txn_time
 * upper set), so `asOf(prevId, asOfBeforeUpdate)` returns the
 * pre-update version's data.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { getPool } from '@cortex/test-db-harness';
import { asOf, between, currentState, diff, history } from '../src/index.js';

interface RetailProduct {
  id: string;
  tenant_id: string;
  external_sku: string;
  name: string;
  price_cents: number;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/retail_product.sql');
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();

describe('@cortex/temporal-query', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = getPool();
    // Idempotent setup — drop if a prior run aborted mid-flight.
    await pool.query(`DROP TABLE IF EXISTS retail_product CASCADE`);
    await pool.query(readFileSync(FIXTURE, 'utf8'));
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS retail_product CASCADE`);
    await pool.end();
  });

  // Helper: insert a fresh retail_product row and return its id +
  // domain values. The SCD trigger's INSERT branch normalizes
  // valid_time / txn_time to ms quantum.
  async function insertProduct(args: {
    tenantId: string;
    sku: string;
    name: string;
    priceCents: number;
    validFrom?: Date;
  }): Promise<string> {
    const validFrom = args.validFrom ?? new Date(Date.now() - 86_400_000); // 1 day ago default
    const r = await pool.query<{ id: string }>(
      `INSERT INTO retail_product (tenant_id, external_sku, name, price_cents, valid_time)
       VALUES ($1, $2, $3, $4, tstzrange($5, NULL))
       RETURNING id`,
      [args.tenantId, args.sku, args.name, args.priceCents, validFrom],
    );
    const inserted = r.rows[0];
    if (inserted === undefined) throw new Error('insert returned no row');
    return inserted.id;
  }

  describe('asOf — F03 spec acceptance scenario', () => {
    it('Create retail.Product → update price → query "as of before update" returns old price', async () => {
      // 1. Create.
      const v1Id = await insertProduct({
        tenantId: TENANT_A,
        sku: 'SKU-ASOF-1',
        name: 'Widget',
        priceCents: 1000,
      });
      // Time anchor BETWEEN creation and update — the SCD trigger uses
      // transaction-start time, so we wait a moment.
      await new Promise((r) => setTimeout(r, 30));
      const tBetween = new Date();
      await new Promise((r) => setTimeout(r, 30));

      // 2. Update price. SCD: v1Id row closed at T_update; new row v2Id inserted with price=1500.
      await pool.query(`UPDATE retail_product SET price_cents = 1500 WHERE id = $1`, [v1Id]);

      // 3. asOf(v1Id, tBetween, tBetween) — returns the pre-update row.
      // Both anchors must be in the past: business-anchor inside the row's
      // valid_time AND system-anchor inside the row's txn_time. The default
      // asOfSystemTs (now) would land AFTER t_update, when v1Id's txn_time
      // is closed — see the JSDoc @example in as-of.ts for the asymmetric-
      // default rationale.
      const row = await asOf<RetailProduct>(
        pool,
        TENANT_A,
        'retail_product',
        v1Id,
        tBetween,
        tBetween,
      );
      expect(row).not.toBeNull();
      expect(row?.price_cents).toBe(1000);
      expect(row?.name).toBe('Widget');
      expect(row?.id).toBe(v1Id);
    });

    it('asOf returns null when the entity did not exist at the anchor', async () => {
      const id = await insertProduct({
        tenantId: TENANT_A,
        sku: 'SKU-ASOF-2',
        name: 'Future',
        priceCents: 100,
        validFrom: new Date(Date.now() + 365 * 86_400_000), // 1 year future
      });
      // Anchor at "now" — the entity isn't valid yet (valid_time starts in the future).
      const row = await asOf<RetailProduct>(pool, TENANT_A, 'retail_product', id, new Date());
      expect(row).toBeNull();
    });

    it('asOf scopes by tenant_id (Q-NEW-F03B-6)', async () => {
      const id = await insertProduct({
        tenantId: TENANT_A,
        sku: 'SKU-TENANT-SCOPE',
        name: 'Scoped',
        priceCents: 200,
      });
      // Same id + different tenant → null.
      const row = await asOf<RetailProduct>(pool, TENANT_B, 'retail_product', id, new Date());
      expect(row).toBeNull();
    });
  });

  describe('currentState', () => {
    it('returns the open-txn_time row for the given id', async () => {
      const id = await insertProduct({
        tenantId: TENANT_A,
        sku: 'SKU-CURRENT-1',
        name: 'Current',
        priceCents: 300,
      });
      const row = await currentState<RetailProduct>(pool, TENANT_A, 'retail_product', id);
      expect(row).not.toBeNull();
      expect(row?.price_cents).toBe(300);
    });

    it('returns null when the id refers to a closed prior version', async () => {
      const v1Id = await insertProduct({
        tenantId: TENANT_A,
        sku: 'SKU-CURRENT-2',
        name: 'Closed',
        priceCents: 400,
      });
      await pool.query(`UPDATE retail_product SET price_cents = 450 WHERE id = $1`, [v1Id]);
      // v1Id row is now closed. currentState(v1Id) returns null.
      const row = await currentState<RetailProduct>(pool, TENANT_A, 'retail_product', v1Id);
      expect(row).toBeNull();
    });
  });

  describe('history', () => {
    it('returns the row with that id (SCD rotates ids → 1 row max per version)', async () => {
      const id = await insertProduct({
        tenantId: TENANT_A,
        sku: 'SKU-HISTORY-1',
        name: 'Historical',
        priceCents: 500,
      });
      const rows = await history<RetailProduct>(pool, TENANT_A, 'retail_product', id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.price_cents).toBe(500);
    });

    it('returns [] (never null) for a non-existent id', async () => {
      const rows = await history<RetailProduct>(pool, TENANT_A, 'retail_product', randomUUID());
      expect(rows).toEqual([]);
    });
  });

  describe('between — closed-open [from, to)', () => {
    it('returns rows whose valid_time overlaps the half-open range', async () => {
      const start = new Date(Date.now() - 86_400_000);
      const id = await insertProduct({
        tenantId: TENANT_A,
        sku: 'SKU-BETWEEN-1',
        name: 'Range',
        priceCents: 600,
        validFrom: start,
      });
      const from = new Date(start.getTime() - 1000);
      const to = new Date(Date.now() + 86_400_000);
      const rows = await between<RetailProduct>(pool, TENANT_A, 'retail_product', id, from, to);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.price_cents).toBe(600);
    });

    it('returns [] when the valid_time does not overlap', async () => {
      const id = await insertProduct({
        tenantId: TENANT_A,
        sku: 'SKU-BETWEEN-2',
        name: 'Outside',
        priceCents: 700,
      });
      // Range entirely before the row's valid_time.
      const from = new Date('2000-01-01');
      const to = new Date('2000-01-02');
      const rows = await between<RetailProduct>(pool, TENANT_A, 'retail_product', id, from, to);
      expect(rows).toEqual([]);
    });
  });

  describe('diff', () => {
    it('returns { before, after, changedColumns: [] } when both anchors fall within an open row version', async () => {
      // diff is id-scoped (NOT entity-scoped via business key) per Slice B's
      // shipped contract — it compares the same row at two timestamps, so
      // for a single row that hasn't been mutated, changedColumns is always
      // [] by construction. Cross-version "what changed about this entity
      // over time" is the diffByKey use case (Slice B.5; see CLAUDE.md
      // "Querying bi-temporal data" for the row-version-scoped caveat on
      // the current `diff` primitive).
      //
      // This test validates that diff works at all in its row-version
      // sense: two timestamps inside a single open row → both asOf calls
      // (system-default = now ∈ open txn_time) return the same row → diff
      // emits the {before, after, []} shape.
      const id = await insertProduct({
        tenantId: TENANT_A,
        sku: 'SKU-DIFF-1',
        name: 'Diffed',
        priceCents: 800,
      });
      await new Promise((r) => setTimeout(r, 30));
      const t1 = new Date();
      await new Promise((r) => setTimeout(r, 30));
      const t2 = new Date();
      const result = await diff<RetailProduct>(pool, TENANT_A, 'retail_product', id, t1, t2);
      expect(result.before).not.toBeNull();
      expect(result.after).not.toBeNull();
      expect(result.before?.price_cents).toBe(800);
      expect(result.after?.price_cents).toBe(800);
      expect(result.changedColumns).toEqual([]);
    });

    it('reports null-side semantics when entity did not exist at one timestamp', async () => {
      const id = await insertProduct({
        tenantId: TENANT_A,
        sku: 'SKU-DIFF-NULL',
        name: 'Half',
        priceCents: 1100,
      });
      // t1 = ancient (before insert); t2 = now.
      const t1 = new Date('2000-01-01');
      const t2 = new Date();
      const result = await diff<RetailProduct>(pool, TENANT_A, 'retail_product', id, t1, t2);
      expect(result.before).toBeNull();
      expect(result.after).not.toBeNull();
      // changedColumns = union of non-excluded keys present on the non-null side.
      expect(result.changedColumns).toContain('external_sku' as keyof RetailProduct);
      expect(result.changedColumns).toContain('name' as keyof RetailProduct);
      expect(result.changedColumns).toContain('price_cents' as keyof RetailProduct);
      // Excluded fields not present.
      expect(result.changedColumns).not.toContain('id' as keyof RetailProduct);
      expect(result.changedColumns).not.toContain('tenant_id' as keyof RetailProduct);
    });

    it('returns empty changedColumns when both sides are null', async () => {
      const result = await diff<RetailProduct>(
        pool,
        TENANT_A,
        'retail_product',
        randomUUID(),
        new Date('2000-01-01'),
        new Date('2000-01-02'),
      );
      expect(result.before).toBeNull();
      expect(result.after).toBeNull();
      expect(result.changedColumns).toEqual([]);
    });
  });

  describe('table-name validation', () => {
    it('rejects invalid table names (SQL injection guard)', async () => {
      await expect(
        asOf(
          pool,
          TENANT_A,
          'retail_product; DROP TABLE retail_product--',
          randomUUID(),
          new Date(),
        ),
      ).rejects.toThrow(/invalid table name/);
    });
  });
});
