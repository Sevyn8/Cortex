/**
 * P0.9 Super Admin bootstrap — pure-function business logic.
 *
 * CLI entry point (scripts/bootstrap/create-super-admin.ts) handles argv +
 * stdin prompts + exit codes; this module does the DB + Secret Manager
 * writes and the audit emission. Dependency injection lets tests mock the
 * GCP and DB surfaces without stdin/readline involvement.
 *
 * Password handling invariant: the raw password NEVER appears in return
 * values, logs, or error messages. Tests assert this.
 */
import { secrets } from '@cortex/secrets';
import { bootstrapAdmin } from '@cortex/canonical-schema';
import { createLogger, type Logger } from '@cortex/observability';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export type EnvKey = 'dev' | 'staging' | 'prod';

export type DbClient = NodePgDatabase<Record<string, never>>;

export interface ExistingAdminInfo {
  email: string;
  created_at: Date;
  promoted_to_users: boolean;
}

export type BootstrapAuditOperation = 'check_existing' | 'write_secret' | 'insert_row' | 'run';

export interface BootstrapAuditEntry {
  operation: BootstrapAuditOperation;
  outcome: 'ok' | 'error' | 'skipped';
  env: EnvKey;
  email: string | null;
  bootstrap_admin_id: string | null;
  password_secret_ref: string | null;
  actor: string;
  duration_ms: number;
  error_code: string | null;
}

export interface RunBootstrapInput {
  email: string;
  name: string;
  password: string;
  env: EnvKey;
}

export type RunBootstrapResult =
  | { outcome: 'created'; bootstrap_admin_id: string; password_secret_ref: string }
  | { outcome: 'already_exists'; existing: ExistingAdminInfo };

export interface BootstrapDeps {
  db: DbClient;
  secretsPut: typeof secrets.put;
}

function getActor(): string {
  return process.env.CORTEX_ACTOR ?? 'unknown';
}

/** Secret name convention — matches Terraform-provisioned secret metadata. */
export function secretIdForEnv(env: EnvKey): string {
  return `cortex-auth-super-admin-initial-${env}`;
}

/**
 * Query bootstrap_admin for an existing row. Returns minimal info if present,
 * null if empty. Does NOT include the password_secret_ref in the returned
 * object — callers that need it read the table directly.
 */
export async function checkExistingAdmin(db: DbClient): Promise<ExistingAdminInfo | null> {
  const rows = await db
    .select({
      email: bootstrapAdmin.email,
      created_at: bootstrapAdmin.created_at,
      promoted_to_users: bootstrapAdmin.promoted_to_users,
    })
    .from(bootstrapAdmin)
    .limit(1);

  const first = rows[0];
  if (first === undefined) return null;
  return {
    email: first.email,
    created_at: first.created_at,
    promoted_to_users: first.promoted_to_users,
  };
}

/**
 * Write a new Secret Manager version with the given password. Returns the
 * fully-qualified version name (projects/.../versions/N). The password
 * itself is never included in the return value.
 */
export async function writeSecretVersion(
  secretId: string,
  password: string,
  secretsPut: typeof secrets.put = secrets.put,
): Promise<string> {
  const result = await secretsPut(secretId, password);
  return result.name;
}

/**
 * Insert a row into bootstrap_admin. Password MUST already be stored in
 * Secret Manager (pass the version name as password_secret_ref).
 */
export async function insertBootstrapRow(
  db: DbClient,
  input: {
    email: string;
    name: string;
    password_secret_ref: string;
    env_created_in: EnvKey;
  },
): Promise<{ id: string }> {
  const [row] = await db
    .insert(bootstrapAdmin)
    .values({
      email: input.email,
      name: input.name,
      password_secret_ref: input.password_secret_ref,
      env_created_in: input.env_created_in,
    })
    .returning({ id: bootstrapAdmin.id });

  if (row === undefined) {
    throw new Error('INSERT INTO bootstrap_admin returned no row');
  }
  return row;
}

// ─── Audit emitter ─────────────────────────────────────────────────────────
//
// Per ADR-OBS-001 §Decision 5, audit emission goes through the
// `@cortex/observability` structured logger. Every audit line carries:
//   - `module_id` = `'cortex-bootstrap'` (set by the logger via mixin)
//   - `namespace` = `'bootstrap-audit'` (filter narrowing)
//   - the `BootstrapAuditEntry` fields
//
// Two consumption shapes:
//   1. `emitAuditLog(entry)` — the existing function-level API. Backed by a
//      module-scope default emitter. The 5 internal call sites in
//      `runBootstrap` use this and do not change.
//   2. `createBootstrapAuditEmitter(opts)` — factory for explicit
//      construction or to inject a pre-configured logger.
//
// Tests swap the default via `__setLoggerForTesting(logger)` and restore via
// `__resetForTesting()` — same convention as `@cortex/secrets/audit`.

export interface BootstrapAuditEmitter {
  audit(entry: Omit<BootstrapAuditEntry, 'actor'>): void;
}

export interface CreateBootstrapAuditEmitterOptions {
  /** Pre-configured logger. Defaults to `createLogger({ moduleId: 'cortex-bootstrap' })`. */
  logger?: Logger;
}

const NAMESPACE = 'bootstrap-audit';
const MODULE_ID = 'cortex-bootstrap';

export function createBootstrapAuditEmitter(
  opts: CreateBootstrapAuditEmitterOptions = {},
): BootstrapAuditEmitter {
  const logger = opts.logger ?? createLogger({ moduleId: MODULE_ID });
  return {
    audit(entry) {
      const full: BootstrapAuditEntry = { ...entry, actor: getActor() };
      logger.info({ ...full, namespace: NAMESPACE }, NAMESPACE);
    },
  };
}

let defaultEmitter: BootstrapAuditEmitter = createBootstrapAuditEmitter();

/**
 * Emit a single audit line. Preserved API — the 5 internal call sites in
 * `runBootstrap` are unchanged. Backed by the module-scope default emitter.
 *
 * The raw password is NEVER accepted by this function — the AuditEntry type
 * doesn't include it. Tests verify no log line contains the password.
 */
export function emitAuditLog(entry: Omit<BootstrapAuditEntry, 'actor'>): void {
  defaultEmitter.audit(entry);
}

/**
 * @internal — test-only logger swap. Pair with `__resetForTesting()` in
 * `afterEach` to restore production defaults between tests.
 */
export function __setLoggerForTesting(logger: Logger): void {
  defaultEmitter = createBootstrapAuditEmitter({ logger });
}

/** @internal — restore the production default emitter. */
export function __resetForTesting(): void {
  defaultEmitter = createBootstrapAuditEmitter();
}

/**
 * Orchestrator: check idempotency → write secret → insert row → audit.
 * Dependency injection lets tests swap db + secretsPut.
 *
 * On existing admin present: emits `skipped` audit + returns
 * `{ outcome: 'already_exists', existing }`. No secret write, no DB insert.
 *
 * On secret-write or insert failure: emits `error` audit with error_code,
 * then re-throws so the caller can decide whether to prompt / exit / retry.
 */
export async function runBootstrap(
  deps: BootstrapDeps,
  input: RunBootstrapInput,
): Promise<RunBootstrapResult> {
  const start = Date.now();
  const { db, secretsPut } = deps;
  const { email, name, password, env } = input;

  // Idempotency: existing-row check
  let existing: ExistingAdminInfo | null;
  try {
    existing = await checkExistingAdmin(db);
  } catch (err) {
    emitAuditLog({
      operation: 'check_existing',
      outcome: 'error',
      env,
      email: null,
      bootstrap_admin_id: null,
      password_secret_ref: null,
      duration_ms: Date.now() - start,
      error_code: errorCodeFor(err),
    });
    throw err;
  }

  if (existing !== null) {
    emitAuditLog({
      operation: 'run',
      outcome: 'skipped',
      env,
      email: existing.email,
      bootstrap_admin_id: null,
      password_secret_ref: null,
      duration_ms: Date.now() - start,
      error_code: null,
    });
    return { outcome: 'already_exists', existing };
  }

  // Secret version write
  let secretRef: string;
  const secretId = secretIdForEnv(env);
  try {
    secretRef = await writeSecretVersion(secretId, password, secretsPut);
  } catch (err) {
    emitAuditLog({
      operation: 'write_secret',
      outcome: 'error',
      env,
      email,
      bootstrap_admin_id: null,
      password_secret_ref: null,
      duration_ms: Date.now() - start,
      error_code: errorCodeFor(err),
    });
    throw err;
  }

  // Row insert
  let inserted: { id: string };
  try {
    inserted = await insertBootstrapRow(db, {
      email,
      name,
      password_secret_ref: secretRef,
      env_created_in: env,
    });
  } catch (err) {
    emitAuditLog({
      operation: 'insert_row',
      outcome: 'error',
      env,
      email,
      bootstrap_admin_id: null,
      password_secret_ref: secretRef,
      duration_ms: Date.now() - start,
      error_code: errorCodeFor(err),
    });
    throw err;
  }

  emitAuditLog({
    operation: 'run',
    outcome: 'ok',
    env,
    email,
    bootstrap_admin_id: inserted.id,
    password_secret_ref: secretRef,
    duration_ms: Date.now() - start,
    error_code: null,
  });

  return {
    outcome: 'created',
    bootstrap_admin_id: inserted.id,
    password_secret_ref: secretRef,
  };
}

function errorCodeFor(err: unknown): string {
  const e = err as { code?: string | number; name?: string } | undefined;
  if (typeof e?.code === 'string' && e.code.length > 0) return e.code;
  if (typeof e?.code === 'number') return String(e.code);
  if (typeof e?.name === 'string' && e.name.length > 0) return e.name;
  return 'UNKNOWN';
}

// Re-export raw SQL tag in case tests want to exec raw statements via the
// injected db client without pulling drizzle-orm separately.
export { sql };
