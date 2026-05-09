/**
 * Tests for the bi-temporal table scaffold script (F03 Slice A).
 *
 * Per scope-doc SD6 (raw-SQL-template-via-Makefile-target) +
 * Q-NEW-F03A-1 (WITH_WRAPPERS default y per operator synthesis).
 *
 * Round-trip verification: scaffold output is fed back into the lint
 * script (test/lint-bi-temporal.spec.ts already covers lint logic; here
 * we verify scaffold-emitted SQL passes the same lint).
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCAFFOLD = resolve(__dirname, '../scripts/scaffold-bitemporal.mjs');
const LINT = resolve(__dirname, '../scripts/lint-bi-temporal.mjs');

function runScaffold(env: Record<string, string>): {
  code: number | null;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync('node', [SCAFFOLD], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function lintSqlContent(sql: string): { code: number | null; stderr: string } {
  // Write to a temp file + invoke lint script with --files.
  const dir = mkdtempSync(join(tmpdir(), 'scaffold-test-'));
  const path = join(dir, 'scaffold-out.sql');
  writeFileSync(path, sql);
  const r = spawnSync('node', [LINT, '--files', path], { encoding: 'utf8' });
  return { code: r.status, stderr: r.stderr };
}

describe('scaffold-bitemporal', () => {
  it('emits a recipe-applied table with WITH_WRAPPERS=y (default)', () => {
    const r = runScaffold({ TABLE: 'retail_product', BUSINESS_KEY: 'external_sku' });
    expect(r.code).toBe(0);
    // tstzrange columns
    expect(r.stdout).toMatch(/valid_time\s+tstzrange/);
    expect(r.stdout).toMatch(/txn_time\s+tstzrange/);
    // Post-0006 trigger binding
    expect(r.stdout).toMatch(/BEFORE INSERT OR UPDATE OR DELETE ON retail_product/);
    expect(r.stdout).toMatch(/cortex\.cortex_scd_trigger/);
    // Exclusion constraint with the supplied business key
    expect(r.stdout).toMatch(/EXCLUDE USING gist/);
    expect(r.stdout).toMatch(/external_sku\s+WITH\s+=/);
    // GiST + current-version indexes
    expect(r.stdout).toMatch(/CREATE INDEX retail_product_temporal_gist/);
    expect(r.stdout).toMatch(/CREATE INDEX retail_product_tenant_current/);
    // Per-table wrappers (default WITH_WRAPPERS=y)
    expect(r.stdout).toMatch(/CREATE FUNCTION cortex\.retail_product_as_of_valid/);
    expect(r.stdout).toMatch(/CREATE FUNCTION cortex\.retail_product_as_of_latest/);
    expect(r.stdout).toMatch(/CREATE FUNCTION cortex\.retail_product_history/);
  });

  it('omits wrappers with WITH_WRAPPERS=n', () => {
    const r = runScaffold({
      TABLE: 'retail_product',
      BUSINESS_KEY: 'external_sku',
      WITH_WRAPPERS: 'n',
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/valid_time\s+tstzrange/);
    expect(r.stdout).not.toMatch(/CREATE FUNCTION cortex\.retail_product_as_of_valid/);
    expect(r.stdout).not.toMatch(/CREATE FUNCTION cortex\.retail_product_as_of_latest/);
    expect(r.stdout).not.toMatch(/CREATE FUNCTION cortex\.retail_product_history/);
  });

  it('round-trips: scaffold output passes the lint', () => {
    const r = runScaffold({ TABLE: 'retail_product', BUSINESS_KEY: 'external_sku' });
    expect(r.code).toBe(0);
    const lint = lintSqlContent(r.stdout);
    expect(lint.code).toBe(0);
  });

  it('rejects missing TABLE arg', () => {
    const r = runScaffold({ BUSINESS_KEY: 'external_sku' });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/TABLE env var required/);
  });

  it('rejects missing BUSINESS_KEY arg', () => {
    const r = runScaffold({ TABLE: 'retail_product' });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/BUSINESS_KEY env var required/);
  });

  it('rejects invalid TABLE name (uppercase)', () => {
    const r = runScaffold({ TABLE: 'RetailProduct', BUSINESS_KEY: 'external_sku' });
    expect(r.code).toBe(2);
  });

  it('rejects invalid WITH_WRAPPERS value', () => {
    const r = runScaffold({
      TABLE: 'retail_product',
      BUSINESS_KEY: 'external_sku',
      WITH_WRAPPERS: 'maybe',
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/WITH_WRAPPERS must be y or n/);
  });
});
