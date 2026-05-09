/**
 * Migration 0005 smoke test — bootstrap_admin table shape + constraints.
 *
 * Verifies the DDL landed correctly and enforces what it claims to enforce.
 * No RLS on this table (it's control-plane-ish, not tenant-scoped), so
 * INSERTs succeed without `app.tenant_id` being set — this is deliberate
 * and tested here.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { getPool as getTestPool } from '@cortex/test-db-harness';

describe('bootstrap_admin (migration 0005)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = getTestPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM bootstrap_admin');
  });

  afterEach(async () => {
    await pool.query('DELETE FROM bootstrap_admin');
  });

  it('table exists', async () => {
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_class WHERE relname = 'bootstrap_admin' AND relkind = 'r'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('has the expected columns with correct types and nullability', async () => {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = 'bootstrap_admin'
       ORDER BY ordinal_position`,
    );

    // Shape the rows into a lookup for tidy assertions.
    const cols = new Map<
      string,
      { data_type: string; is_nullable: string; column_default: string | null }
    >();
    for (const r of rows as {
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }[]) {
      cols.set(r.column_name, {
        data_type: r.data_type,
        is_nullable: r.is_nullable,
        column_default: r.column_default,
      });
    }

    expect(cols.get('id')).toMatchObject({ data_type: 'uuid', is_nullable: 'NO' });
    expect(cols.get('id')?.column_default).toContain('gen_random_uuid');

    expect(cols.get('email')).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(cols.get('name')).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(cols.get('password_secret_ref')).toMatchObject({
      data_type: 'text',
      is_nullable: 'YES',
    });
    expect(cols.get('env_created_in')).toMatchObject({
      data_type: 'text',
      is_nullable: 'NO',
    });
    expect(cols.get('created_at')).toMatchObject({
      data_type: 'timestamp with time zone',
      is_nullable: 'NO',
    });
    expect(cols.get('created_at')?.column_default).toContain('now()');
    expect(cols.get('promoted_to_users')).toMatchObject({
      data_type: 'boolean',
      is_nullable: 'NO',
    });
    expect(cols.get('promoted_to_users')?.column_default).toContain('false');
    expect(cols.get('promoted_at')).toMatchObject({
      data_type: 'timestamp with time zone',
      is_nullable: 'YES',
    });
  });

  it('UNIQUE(email) is enforced', async () => {
    await pool.query(
      `INSERT INTO bootstrap_admin (email, name, env_created_in) VALUES ($1, $2, $3)`,
      ['a@b.com', 'A', 'dev'],
    );
    await expect(
      pool.query(`INSERT INTO bootstrap_admin (email, name, env_created_in) VALUES ($1, $2, $3)`, [
        'a@b.com',
        'B',
        'dev',
      ]),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('env_created_in CHECK rejects invalid values', async () => {
    await expect(
      pool.query(`INSERT INTO bootstrap_admin (email, name, env_created_in) VALUES ($1, $2, $3)`, [
        'x@y.com',
        'X',
        'production',
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('promoted CHECK rejects promoted_to_users=true with promoted_at=NULL', async () => {
    await expect(
      pool.query(
        `INSERT INTO bootstrap_admin (email, name, env_created_in, promoted_to_users)
         VALUES ($1, $2, $3, true)`,
        ['x@y.com', 'X', 'dev'],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('promoted CHECK rejects promoted_to_users=false with promoted_at=now()', async () => {
    await expect(
      pool.query(
        `INSERT INTO bootstrap_admin (email, name, env_created_in, promoted_to_users, promoted_at)
         VALUES ($1, $2, $3, false, now())`,
        ['x@y.com', 'X', 'dev'],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('happy-path INSERT (unpromoted) succeeds', async () => {
    const { rows } = await pool.query(
      `INSERT INTO bootstrap_admin (email, name, env_created_in)
       VALUES ($1, $2, $3)
       RETURNING id, promoted_to_users, promoted_at`,
      ['ok@example.com', 'OK', 'dev'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].promoted_to_users).toBe(false);
    expect(rows[0].promoted_at).toBeNull();
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('UPDATE to promoted_to_users=true + promoted_at=now() succeeds (AC01 promotion shape)', async () => {
    await pool.query(
      `INSERT INTO bootstrap_admin (email, name, env_created_in) VALUES ($1, $2, $3)`,
      ['promo@example.com', 'Promo', 'dev'],
    );
    const { rows } = await pool.query(
      `UPDATE bootstrap_admin
       SET promoted_to_users = true, promoted_at = now()
       WHERE email = $1
       RETURNING promoted_to_users, promoted_at`,
      ['promo@example.com'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].promoted_to_users).toBe(true);
    expect(rows[0].promoted_at).toBeInstanceOf(Date);
  });

  it('RLS NOT enabled — INSERT/SELECT works without app.tenant_id set', async () => {
    // This is the differentiator vs tenant-scoped tables. cortex.current_tenant_id()
    // would fail-closed if RLS were on and app.tenant_id unset; since bootstrap_admin
    // has no RLS, it works transparently.
    const { rows: rlsCheck } = await pool.query(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'bootstrap_admin'`,
    );
    expect(rlsCheck[0].relrowsecurity).toBe(false);

    // Prove INSERT+SELECT work in a transaction that never sets app.tenant_id.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Do NOT call set_config('app.tenant_id', ...) here.
      await client.query(
        `INSERT INTO bootstrap_admin (email, name, env_created_in) VALUES ($1, $2, $3)`,
        ['no-tenant@example.com', 'NT', 'dev'],
      );
      const { rows } = await client.query(`SELECT email FROM bootstrap_admin WHERE email = $1`, [
        'no-tenant@example.com',
      ]);
      expect(rows).toHaveLength(1);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });
});
