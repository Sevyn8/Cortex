/**
 * Tests for the bi-temporal migration lint script (F03 Slice A).
 *
 * Per scope-doc SD5 + Q-NEW-F03A-3 (fail-closed): tenant-scoped CREATE TABLE
 * statements not in the bookkeeping allowlist + lacking the
 * `-- @bi-temporal: skip` directive must follow the bi-temporal recipe.
 *
 * Each fixture is a single .sql file under test/fixtures/bi-temporal-lint/.
 * The lint script accepts `--files <paths...>` (the lint-staged invocation
 * shape); we use that here to test fixture-by-fixture, asserting exit code +
 * (for failures) the missing-piece message in stderr.
 *
 * Production CI invocation uses `--dir services/foundation/migrations/` —
 * also exercised here against the real migrations directory to assert that
 * shipped migrations (post-0007 / 0010 / 0011 bookkeeping tables) pass.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, '../scripts/lint-bi-temporal.mjs');
const FIXTURES = resolve(__dirname, 'fixtures/bi-temporal-lint');
const REAL_MIGRATIONS = resolve(__dirname, '../migrations');

function runLint(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('lint-bi-temporal', () => {
  describe('per-fixture', () => {
    it('01-correct.sql passes', () => {
      const r = runLint(['--files', join(FIXTURES, '01-correct.sql')]);
      expect(r.code).toBe(0);
    });

    it('02-missing-columns.sql fails: reports missing valid_time + txn_time', () => {
      const r = runLint(['--files', join(FIXTURES, '02-missing-columns.sql')]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/missing: valid_time tstzrange column/);
      expect(r.stderr).toMatch(/missing: txn_time tstzrange column/);
    });

    it('03-columns-no-trigger.sql fails: reports missing trigger', () => {
      const r = runLint(['--files', join(FIXTURES, '03-columns-no-trigger.sql')]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/missing: BEFORE INSERT OR UPDATE OR DELETE trigger/);
    });

    it('04-columns-no-exclusion.sql fails: reports missing exclusion constraint', () => {
      const r = runLint(['--files', join(FIXTURES, '04-columns-no-exclusion.sql')]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/missing: EXCLUDE USING gist/);
    });

    it('05-opt-out.sql passes via directive', () => {
      const r = runLint(['--files', join(FIXTURES, '05-opt-out.sql')]);
      expect(r.code).toBe(0);
    });

    it('06-no-tenant-id.sql passes (rule does not apply)', () => {
      const r = runLint(['--files', join(FIXTURES, '06-no-tenant-id.sql')]);
      expect(r.code).toBe(0);
    });
  });

  describe('real migrations dir', () => {
    it('all shipped migrations pass via allowlist + (future) bi-temporal tables', () => {
      // Slice A's lint must not retroactively fail any of the 12 shipped
      // migrations. The 6 bookkeeping tables (tenant / tenant_config_version /
      // tenant_quota_usage / tenant_kms_key / legal_hold / audit_event) hit
      // the allowlist short-circuit; no other tenant-scoped tables exist yet.
      const r = runLint(['--dir', REAL_MIGRATIONS]);
      expect(r.code).toBe(0);
    });
  });
});
