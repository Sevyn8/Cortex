#!/usr/bin/env node
/**
 * Bi-temporal migration lint (F03 Slice A).
 *
 * Per ADR-DB-001 + f03-slice-A-scope.md SD5 (exception-list with named opt-out):
 * any tenant-scoped table that isn't in the bookkeeping allowlist + doesn't
 * carry a `-- @bi-temporal: skip` directive must follow the bi-temporal
 * recipe (post-0006 binding):
 *   - `valid_time tstzrange NOT NULL`
 *   - `txn_time tstzrange NOT NULL DEFAULT tstzrange(now(), NULL)`
 *   - `CREATE TRIGGER ... BEFORE INSERT OR UPDATE OR DELETE ... FOR EACH ROW
 *     EXECUTE FUNCTION cortex.cortex_scd_trigger()`
 *   - `EXCLUDE USING gist (tenant_id WITH =, <business_key> WITH =,
 *     valid_time WITH &&) WHERE (upper(txn_time) IS NULL)`
 *   - `CREATE INDEX ... USING gist (tenant_id, valid_time, txn_time)`
 *
 * Fail-closed (Q-NEW-F03A-3): tenant-scoped table not in allowlist + no
 * directive + missing any piece → exit 1 with a per-table report.
 *
 * Invocation:
 *   --dir <path>      Lint all *.sql files in the given directory.
 *   --files <f1> <f2> Lint the given files. Used by lint-staged.
 *
 * Pure JS regex parsing — no `pg` dependency, runs without DB. CI invokes
 * with `--dir services/foundation/migrations/`; lint-staged invokes with
 * `--files <staged-paths>`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Bookkeeping allowlist — tenant-scoped tables that are NOT bi-temporal.
// Confirmed at F03 Slice A HOLD #1 against migrations 0007 / 0010 / 0011.
// New bookkeeping tables: add here OR add `-- @bi-temporal: skip` directive.
const BOOKKEEPING_ALLOWLIST = new Set([
  'tenant', // primary registry; control plane (NO RLS per migration 0007)
  'tenant_config_version', // F04 versioned config (own version_number scheme)
  'tenant_quota_usage', // counter table (F01 Slice C)
  'tenant_kms_key', // singular per-tenant binding
  'legal_hold', // soft-delete via released_at (F02 Slice C)
  'audit_event', // append-only audit chain (own structure per ADR-DB-003)
]);

const SKIP_DIRECTIVE_RE = /--\s*@bi-temporal:\s*skip\b/i;

// Match `CREATE TABLE [IF NOT EXISTS] [<schema>.]<name> (`. Captures the
// (optionally schema-qualified) table name in group 1.
const CREATE_TABLE_RE = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[\w]+\.)?(\w+)\s*\(/gi;

function parseArgs(argv) {
  const out = { dir: null, files: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir') {
      i += 1;
      out.dir = argv[i];
    } else if (a === '--files') {
      i += 1;
      while (i < argv.length && !argv[i].startsWith('--')) {
        out.files.push(argv[i]);
        i += 1;
      }
      i -= 1;
    }
  }
  return out;
}

function listSqlFiles(dir) {
  const result = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) continue;
    if (!entry.endsWith('.sql')) continue;
    result.push(full);
  }
  return result.sort();
}

/**
 * Extract each `CREATE TABLE` block + its preceding 5 lines (for directive
 * detection). Returns an array of { tableName, body, leadingContext, line }.
 * `body` is the full text from `CREATE TABLE` through the matching `);`
 * (best-effort — we don't fully tokenize; just balance paren-depth at top
 * level). `leadingContext` is the 5 lines preceding the CREATE TABLE.
 */
function extractCreateTableBlocks(sql) {
  const blocks = [];
  const lines = sql.split('\n');
  let pos = 0;
  CREATE_TABLE_RE.lastIndex = 0;
  let m;
  while ((m = CREATE_TABLE_RE.exec(sql)) !== null) {
    const tableName = m[1];
    const startIdx = m.index;
    // Find matching `);` by scanning forward at paren-depth 1.
    let depth = 1;
    let j = sql.indexOf('(', startIdx) + 1;
    while (j < sql.length && depth > 0) {
      if (sql[j] === '(') depth += 1;
      else if (sql[j] === ')') depth -= 1;
      j += 1;
    }
    // j is now index AFTER the matching `)`.
    const body = sql.slice(startIdx, j);
    // Compute line number of the CREATE TABLE statement.
    const lineNum = sql.slice(0, startIdx).split('\n').length;
    // Leading context: 5 lines before the CREATE TABLE.
    const ctxStartLine = Math.max(0, lineNum - 6);
    const leadingContext = lines.slice(ctxStartLine, lineNum).join('\n');
    blocks.push({ tableName, body, leadingContext, line: lineNum });
    pos = j;
    CREATE_TABLE_RE.lastIndex = pos;
  }
  return blocks;
}

/**
 * Check the surrounding SQL (whole file) for the trigger + exclusion +
 * index satellites referencing this table. The recipe spreads these across
 * separate statements after CREATE TABLE; we look across the file.
 */
function checkSatellites(sql, tableName) {
  // Trigger: BEFORE INSERT OR UPDATE OR DELETE on this table referencing
  // cortex.cortex_scd_trigger.
  const triggerRe = new RegExp(
    String.raw`CREATE\s+TRIGGER[\s\S]+?BEFORE\s+INSERT\s+OR\s+UPDATE\s+OR\s+DELETE[\s\S]+?ON\s+(?:[\w]+\.)?${tableName}\b[\s\S]+?cortex\.cortex_scd_trigger`,
    'i',
  );
  const exclusionRe = new RegExp(
    String.raw`ALTER\s+TABLE[\s\S]+?${tableName}[\s\S]+?EXCLUDE\s+USING\s+gist[\s\S]*?valid_time\s+WITH\s+&&[\s\S]*?upper\(txn_time\)\s+IS\s+NULL`,
    'i',
  );
  const gistIdxRe = new RegExp(
    String.raw`CREATE\s+INDEX[\s\S]+?ON\s+(?:[\w]+\.)?${tableName}[\s\S]+?USING\s+gist\s*\([\s\S]*?tenant_id[\s\S]*?valid_time[\s\S]*?txn_time`,
    'i',
  );
  return {
    hasTrigger: triggerRe.test(sql),
    hasExclusion: exclusionRe.test(sql),
    hasGistIndex: gistIdxRe.test(sql),
  };
}

function lintFile(filepath) {
  const sql = readFileSync(filepath, 'utf8');
  const blocks = extractCreateTableBlocks(sql);
  const failures = [];

  for (const block of blocks) {
    const { tableName, body, leadingContext } = block;

    // Allowlist short-circuit.
    if (BOOKKEEPING_ALLOWLIST.has(tableName)) continue;

    // Opt-out directive — adjacent comment block.
    if (SKIP_DIRECTIVE_RE.test(leadingContext)) continue;

    // Determine if tenant-scoped (has a `tenant_id` column declaration).
    const tenantScoped = /\btenant_id\s+uuid\b/i.test(body);
    if (!tenantScoped) continue;

    // Tenant-scoped + not in allowlist + no directive: must satisfy recipe.
    const missing = [];
    if (!/\bvalid_time\s+tstzrange\b/i.test(body)) missing.push('valid_time tstzrange column');
    if (!/\btxn_time\s+tstzrange\b/i.test(body)) missing.push('txn_time tstzrange column');

    const sats = checkSatellites(sql, tableName);
    if (!sats.hasTrigger)
      missing.push('BEFORE INSERT OR UPDATE OR DELETE trigger calling cortex.cortex_scd_trigger');
    if (!sats.hasExclusion)
      missing.push(
        'EXCLUDE USING gist (tenant_id, business_key, valid_time) WHERE upper(txn_time) IS NULL',
      );
    if (!sats.hasGistIndex)
      missing.push('CREATE INDEX ... USING gist (tenant_id, valid_time, txn_time)');

    if (missing.length > 0) {
      failures.push({ filepath, tableName, line: block.line, missing });
    }
  }

  return failures;
}

function main() {
  const args = parseArgs(process.argv);
  let files = [];
  if (args.dir !== null) {
    files = listSqlFiles(args.dir);
  } else if (args.files.length > 0) {
    files = args.files;
  } else {
    console.error('lint-bi-temporal: usage: --dir <path> | --files <files...>');
    process.exit(2);
  }

  const allFailures = [];
  for (const f of files) {
    allFailures.push(...lintFile(f));
  }

  if (allFailures.length === 0) {
    process.exit(0);
  }

  console.error(`bi-temporal lint failed: ${allFailures.length} table(s) violate the recipe.\n`);
  for (const fail of allFailures) {
    console.error(`  ${fail.filepath}:${fail.line}  CREATE TABLE ${fail.tableName}`);
    for (const m of fail.missing) {
      console.error(`    - missing: ${m}`);
    }
    console.error('');
  }
  console.error('Fix:');
  console.error('  1. If this is a tenant-scoped domain table, follow the recipe (see CLAUDE.md');
  console.error('     "Bi-temporal table convention") or run `make db-scaffold-bitemporal`.');
  console.error('  2. If this is bookkeeping (queue / counter / lookup), add a directive');
  console.error('     `-- @bi-temporal: skip` immediately before CREATE TABLE.');
  console.error('  3. If this is a new platform-level bookkeeping table, also add it to the');
  console.error('     BOOKKEEPING_ALLOWLIST in services/foundation/scripts/lint-bi-temporal.mjs.');
  process.exit(1);
}

main();
