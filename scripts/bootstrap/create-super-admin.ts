#!/usr/bin/env node
/**
 * P0.9 Super Admin bootstrap — CLI entry point.
 *
 * Thin wrapper: argv parsing + preflight + stdin prompts + delegate to
 * `lib/bootstrap.ts:runBootstrap`. Password collection lives here only —
 * the library never sees the terminal and cannot accidentally log to it.
 *
 * Usage:
 *   pnpm bootstrap:super-admin --env=dev
 *   pnpm bootstrap:super-admin --env=staging
 *
 * See /docs/runbooks/super-admin-bootstrap.md for the full procedure
 * (including the production path via WorkOS and the break-glass).
 */
import { execSync, spawnSync } from 'node:child_process';
import { Socket } from 'node:net';
import { input, password as passwordPrompt } from '@inquirer/prompts';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { secrets } from '@cortex/secrets';
import { checkExistingAdmin, runBootstrap, type EnvKey } from './lib/bootstrap.js';

const USAGE = `
Usage: pnpm bootstrap:super-admin --env=<dev|staging>

Creates the first Super Admin identity for dev or staging. Production
uses WorkOS SSO (see docs/runbooks/super-admin-bootstrap.md).

Prerequisites:
  - gcloud auth application-default login   (once per session)
  - make db-proxy-<env>                     (in another terminal)
  - GCP_PROJECT_ID=sevyn8-cortex-<env>

Flags:
  --env=<dev|staging>  Required. Must match GCP_PROJECT_ID.
  --help               Show this message.
`.trim();

function parseArgs(argv: readonly string[]): { env: EnvKey } | { help: true } {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) return { help: true };

  const envArg = args.find((a) => a.startsWith('--env='));
  if (envArg === undefined) {
    throw new Error('Missing required --env flag. Run with --help for usage.');
  }
  const env = envArg.slice('--env='.length);
  if (env !== 'dev' && env !== 'staging' && env !== 'prod') {
    throw new Error(`Invalid --env value: ${env}. Must be dev or staging.`);
  }
  if (env === 'prod') {
    throw new Error(
      'Production does not use this script. Production bootstrap is WorkOS\n' +
        'SSO with CORTEX_SUPER_ADMIN_EMAIL set at deploy time and AC01\n' +
        'resolving the identity on first run. See\n' +
        'docs/runbooks/super-admin-bootstrap.md#production-procedure.',
    );
  }
  return { env };
}

function expectProjectId(env: EnvKey): string {
  const id = process.env.GCP_PROJECT_ID;
  const expected = `sevyn8-cortex-${env}`;
  if (id === undefined || id.length === 0) {
    throw new Error(
      `GCP_PROJECT_ID is not set. Expected: ${expected}\n` +
        `Suggest:  export GCP_PROJECT_ID=${expected}`,
    );
  }
  if (id !== expected) {
    throw new Error(
      `GCP_PROJECT_ID=${id} does not match --env=${env}.\n` +
        `Expected: ${expected}\n` +
        `Suggest:  export GCP_PROJECT_ID=${expected}`,
    );
  }
  return id;
}

async function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

async function preflight(env: EnvKey): Promise<void> {
  const reachable = await probeTcp('127.0.0.1', 5432, 2000);
  if (!reachable) {
    throw new Error(
      `Cloud SQL Proxy not running on 127.0.0.1:5432.\n` +
        `Run 'make db-proxy-${env}' in another terminal, then re-run this script.`,
    );
  }

  const adc = spawnSync('gcloud', ['auth', 'application-default', 'print-access-token'], {
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (adc.status !== 0) {
    throw new Error(
      `gcloud ADC not set up or expired.\n` +
        `Run 'gcloud auth application-default login' and re-run this script.`,
    );
  }
}

function fetchPgPassword(env: EnvKey, projectId: string): string {
  try {
    return execSync(
      `gcloud secrets versions access latest ` +
        `--secret=cortex-db-postgres-break-glass-${env} ` +
        `--project=${projectId}`,
      { encoding: 'utf8', timeout: 15000 },
    ).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to fetch break-glass password from Secret Manager: ${msg}\n` +
        `Verify your gcloud identity has secretmanager.secretAccessor on ` +
        `cortex-db-postgres-break-glass-${env}.`,
    );
  }
}

function openPool(pgPassword: string): Pool {
  return new Pool({
    host: '127.0.0.1',
    port: 5432,
    user: 'postgres',
    password: pgPassword,
    database: 'cortex',
  });
}

const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function promptInputs(): Promise<{ email: string; name: string; password: string }> {
  const email = await input({
    message: 'Super admin email',
    validate: (v: string) =>
      EMAIL_REGEX.test(v.trim()) || 'Enter a valid email address (user@domain.tld)',
  });

  const name = await input({
    message: 'Super admin name',
    validate: (v: string) => v.trim().length > 0 || 'Name cannot be empty',
  });

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const pw = await passwordPrompt({
      message: 'Initial super admin password (min 12 chars, hidden)',
      mask: true,
      validate: (v: string) => v.length >= 12 || 'Password must be at least 12 characters',
    });
    const confirm = await passwordPrompt({
      message: 'Confirm password',
      mask: true,
    });
    if (pw === confirm) {
      return { email: email.trim(), name: name.trim(), password: pw };
    }
    if (attempt < MAX_ATTEMPTS) {
      process.stderr.write(
        `Passwords do not match. Attempt ${attempt}/${MAX_ATTEMPTS}. Try again.\n`,
      );
    }
  }
  throw new Error(`Password confirmation failed ${MAX_ATTEMPTS} times. Aborting.`);
}

async function main(): Promise<void> {
  let parsed: { env: EnvKey } | { help: true };
  try {
    parsed = parseArgs(process.argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  if ('help' in parsed) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const { env } = parsed;
  const projectId = expectProjectId(env);

  await preflight(env);

  const pgPassword = fetchPgPassword(env, projectId);
  const pool = openPool(pgPassword);

  try {
    const db = drizzle(pool);

    const existing = await checkExistingAdmin(db);
    if (existing !== null) {
      process.stdout.write(
        `A super admin already exists in ${env}:\n` +
          `   - email: ${existing.email}\n` +
          `   - created_at: ${existing.created_at.toISOString()}\n` +
          `   - promoted_to_users: ${existing.promoted_to_users}\n` +
          `\n` +
          `If AC01 has shipped, use its promotion flow, not this script.\n` +
          `If you need to reset bootstrap_admin (dev only), see\n` +
          `/docs/runbooks/super-admin-bootstrap.md#reset-procedure.\n`,
      );
      return;
    }

    const { email, name, password } = await promptInputs();

    const result = await runBootstrap(
      { db, secretsPut: secrets.put },
      { email, name, password, env },
    );

    if (result.outcome === 'already_exists') {
      // Race: another caller inserted between checkExistingAdmin above and
      // runBootstrap's internal re-check. Surface as success with guidance.
      process.stdout.write(
        `A super admin was created concurrently in ${env}:\n` +
          `   - email: ${result.existing.email}\n` +
          `No changes made by this invocation.\n`,
      );
      return;
    }

    process.stdout.write(
      `\n✓ Super admin bootstrap complete.\n` +
        `  Email:          ${email}\n` +
        `  Secret version: ${result.password_secret_ref}\n` +
        `\n` +
        `Next steps:\n` +
        `  - The bootstrap_admin row is staged for AC01 promotion.\n` +
        `  - Use this password to log in once AC01 (P2.1) ships.\n` +
        `  - See /docs/runbooks/super-admin-bootstrap.md#post-ac01-promotion.\n`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\n${msg}\n`);
  process.exit(1);
});
