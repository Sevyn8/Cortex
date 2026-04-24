import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkExistingAdmin,
  emitAuditLog,
  insertBootstrapRow,
  runBootstrap,
  secretIdForEnv,
  writeSecretVersion,
  type BootstrapDeps,
  type DbClient,
} from './bootstrap.js';

// ─── Fixtures + mock factories ─────────────────────────────────────────────

function captureAllLogs(): { captured: string[]; restore: () => void } {
  const captured: string[] = [];
  const push = (msg: unknown): void => {
    captured.push(typeof msg === 'string' ? msg : String(msg));
  };
  const spies = [
    vi.spyOn(console, 'error').mockImplementation(push),
    vi.spyOn(console, 'log').mockImplementation(push),
    vi.spyOn(process.stderr, 'write').mockImplementation(((msg: string | Uint8Array) => {
      push(typeof msg === 'string' ? msg : Buffer.from(msg).toString('utf8'));
      return true;
    }) as typeof process.stderr.write),
    vi.spyOn(process.stdout, 'write').mockImplementation(((msg: string | Uint8Array) => {
      push(typeof msg === 'string' ? msg : Buffer.from(msg).toString('utf8'));
      return true;
    }) as typeof process.stdout.write),
  ];
  return {
    captured,
    restore: () => spies.forEach((s) => s.mockRestore()),
  };
}

// Minimal Drizzle-compatible mock. Returns pre-programmed results for the two
// operations bootstrap.ts performs: select(…).from(bootstrapAdmin).limit(1)
// and insert(bootstrapAdmin).values(…).returning(…).
interface MockDbBehavior {
  existingRow?: {
    email: string;
    created_at: Date;
    promoted_to_users: boolean;
  };
  insertReturnsId?: string;
  insertThrows?: Error;
  selectThrows?: Error;
}

function createMockDb(behavior: MockDbBehavior = {}): DbClient {
  const selectChain = {
    from: vi.fn().mockReturnValue({
      limit: vi.fn().mockImplementation(() => {
        if (behavior.selectThrows) return Promise.reject(behavior.selectThrows);
        return Promise.resolve(behavior.existingRow ? [behavior.existingRow] : []);
      }),
    }),
  };
  const insertChain = {
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockImplementation(() => {
        if (behavior.insertThrows) return Promise.reject(behavior.insertThrows);
        const id = behavior.insertReturnsId ?? '11111111-1111-1111-1111-111111111111';
        return Promise.resolve([{ id }]);
      }),
    }),
  };
  return {
    select: vi.fn().mockReturnValue(selectChain),
    insert: vi.fn().mockReturnValue(insertChain),
  } as unknown as DbClient;
}

function createMockSecretsPut(opts: { throws?: Error } = {}) {
  return vi.fn().mockImplementation((secretId: string, _payload: string) => {
    if (opts.throws) return Promise.reject(opts.throws);
    return Promise.resolve({
      name: `projects/test-project/secrets/${secretId}/versions/1`,
      versionId: '1',
    });
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('secretIdForEnv', () => {
  it('composes the Terraform-provisioned secret id per env', () => {
    expect(secretIdForEnv('dev')).toBe('cortex-auth-super-admin-initial-dev');
    expect(secretIdForEnv('staging')).toBe('cortex-auth-super-admin-initial-staging');
    expect(secretIdForEnv('prod')).toBe('cortex-auth-super-admin-initial-prod');
  });
});

describe('checkExistingAdmin', () => {
  it('returns null on empty table', async () => {
    const db = createMockDb();
    const result = await checkExistingAdmin(db);
    expect(result).toBeNull();
  });

  it('returns row info when row present', async () => {
    const now = new Date('2026-04-24T12:00:00Z');
    const db = createMockDb({
      existingRow: {
        email: 'amit@sevyn8.com',
        created_at: now,
        promoted_to_users: false,
      },
    });
    const result = await checkExistingAdmin(db);
    expect(result).toEqual({
      email: 'amit@sevyn8.com',
      created_at: now,
      promoted_to_users: false,
    });
  });
});

describe('writeSecretVersion', () => {
  it('calls secretsPut with the secret id and password, returns full version name', async () => {
    const spy = createMockSecretsPut();
    const result = await writeSecretVersion('cortex-auth-super-admin-initial-dev', 'pw', spy);
    expect(spy).toHaveBeenCalledWith('cortex-auth-super-admin-initial-dev', 'pw');
    expect(result).toBe(
      'projects/test-project/secrets/cortex-auth-super-admin-initial-dev/versions/1',
    );
  });
});

describe('insertBootstrapRow', () => {
  it('inserts with the expected shape and returns id', async () => {
    const db = createMockDb({ insertReturnsId: '22222222-2222-2222-2222-222222222222' });
    const result = await insertBootstrapRow(db, {
      email: 'a@b.com',
      name: 'A',
      password_secret_ref: 'projects/p/secrets/s/versions/3',
      env_created_in: 'dev',
    });
    expect(result.id).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('throws when insert returns no row', async () => {
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as unknown as DbClient;
    await expect(
      insertBootstrapRow(db, {
        email: 'a@b.com',
        name: 'A',
        password_secret_ref: 'ref',
        env_created_in: 'dev',
      }),
    ).rejects.toThrow(/returned no row/);
  });
});

describe('emitAuditLog', () => {
  const { captured, restore } = (() => {
    const { captured: c, restore: r } = captureAllLogs();
    return { captured: c, restore: r };
  })();

  afterEach(() => restore());

  it('emits a [BOOTSTRAP-AUDIT] line with valid JSON', () => {
    const cap = captureAllLogs();
    emitAuditLog({
      operation: 'run',
      outcome: 'ok',
      env: 'dev',
      email: 'a@b.com',
      bootstrap_admin_id: 'abc',
      password_secret_ref: 'ref',
      duration_ms: 42,
      error_code: null,
    });
    const line = cap.captured.find((s) => s.includes('[BOOTSTRAP-AUDIT]'));
    expect(line).toBeDefined();
    const json = line!.replace('[BOOTSTRAP-AUDIT] ', '');
    const parsed = JSON.parse(json);
    expect(parsed.operation).toBe('run');
    expect(parsed.outcome).toBe('ok');
    expect(parsed.env).toBe('dev');
    expect(parsed.email).toBe('a@b.com');
    expect(parsed.duration_ms).toBe(42);
    expect(parsed).toHaveProperty('actor');
    cap.restore();
  });

  // Keep the outer captured/restore unused to silence the linter; the inner
  // helper instantiation is the real test mechanism.
  void captured;
});

describe('runBootstrap orchestrator', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('happy path: creates secret version + inserts row + emits ok audit', async () => {
    const deps: BootstrapDeps = {
      db: createMockDb({ insertReturnsId: '33333333-3333-3333-3333-333333333333' }),
      secretsPut: createMockSecretsPut(),
    };
    const result = await runBootstrap(deps, {
      email: 'admin@sevyn8.com',
      name: 'Admin',
      password: 'hunter-2-very-long',
      env: 'dev',
    });
    expect(result.outcome).toBe('created');
    if (result.outcome === 'created') {
      expect(result.bootstrap_admin_id).toBe('33333333-3333-3333-3333-333333333333');
      expect(result.password_secret_ref).toBe(
        'projects/test-project/secrets/cortex-auth-super-admin-initial-dev/versions/1',
      );
    }
  });

  it('idempotent: returns already_exists when a row is present; no secret write, no insert', async () => {
    const secretsPut = createMockSecretsPut();
    const deps: BootstrapDeps = {
      db: createMockDb({
        existingRow: {
          email: 'existing@sevyn8.com',
          created_at: new Date('2026-04-01T00:00:00Z'),
          promoted_to_users: false,
        },
      }),
      secretsPut,
    };
    const result = await runBootstrap(deps, {
      email: 'different@sevyn8.com',
      name: 'New',
      password: 'new-password-very-long',
      env: 'dev',
    });
    expect(result.outcome).toBe('already_exists');
    if (result.outcome === 'already_exists') {
      expect(result.existing.email).toBe('existing@sevyn8.com');
    }
    expect(secretsPut).not.toHaveBeenCalled();
  });

  it('emits error audit when secret.put fails', async () => {
    const cap = captureAllLogs();
    const err = Object.assign(new Error('denied'), { code: 'PERMISSION_DENIED' });
    const deps: BootstrapDeps = {
      db: createMockDb(),
      secretsPut: createMockSecretsPut({ throws: err }),
    };
    await expect(
      runBootstrap(deps, {
        email: 'a@b.com',
        name: 'A',
        password: 'p',
        env: 'dev',
      }),
    ).rejects.toBe(err);
    const auditLines = cap.captured.filter((s) => s.includes('[BOOTSTRAP-AUDIT]'));
    expect(auditLines.some((s) => s.includes('"operation":"write_secret"'))).toBe(true);
    expect(auditLines.some((s) => s.includes('"error_code":"PERMISSION_DENIED"'))).toBe(true);
    cap.restore();
  });

  it('emits error audit when insert fails (e.g., duplicate email race)', async () => {
    const cap = captureAllLogs();
    const err = Object.assign(new Error('dup'), { code: '23505' });
    const deps: BootstrapDeps = {
      db: createMockDb({ insertThrows: err }),
      secretsPut: createMockSecretsPut(),
    };
    await expect(
      runBootstrap(deps, {
        email: 'a@b.com',
        name: 'A',
        password: 'p',
        env: 'dev',
      }),
    ).rejects.toBe(err);
    const auditLines = cap.captured.filter((s) => s.includes('[BOOTSTRAP-AUDIT]'));
    expect(auditLines.some((s) => s.includes('"operation":"insert_row"'))).toBe(true);
    expect(auditLines.some((s) => s.includes('"error_code":"23505"'))).toBe(true);
    cap.restore();
  });

  it('emits error audit when idempotency check fails', async () => {
    const cap = captureAllLogs();
    const err = new Error('db down');
    const deps: BootstrapDeps = {
      db: createMockDb({ selectThrows: err }),
      secretsPut: createMockSecretsPut(),
    };
    await expect(
      runBootstrap(deps, {
        email: 'a@b.com',
        name: 'A',
        password: 'p',
        env: 'dev',
      }),
    ).rejects.toBe(err);
    const auditLines = cap.captured.filter((s) => s.includes('[BOOTSTRAP-AUDIT]'));
    expect(auditLines.some((s) => s.includes('"operation":"check_existing"'))).toBe(true);
    cap.restore();
  });

  it('NEVER logs the password anywhere', async () => {
    const PASSWORD = 'test-password-secret-12345';
    const cap = captureAllLogs();

    const deps: BootstrapDeps = {
      db: createMockDb({ insertReturnsId: '44444444-4444-4444-4444-444444444444' }),
      secretsPut: createMockSecretsPut(),
    };

    await runBootstrap(deps, {
      email: 'admin@sevyn8.com',
      name: 'Test Admin',
      password: PASSWORD,
      env: 'dev',
    });

    const joined = cap.captured.join('\n');
    expect(joined).not.toContain(PASSWORD);
    expect(joined).not.toContain('test-password');
    cap.restore();
  });

  it('NEVER logs the password on error paths either', async () => {
    const PASSWORD = 'secret-error-path-98765';
    const cap = captureAllLogs();

    const err = Object.assign(new Error('denied'), { code: 'PERMISSION_DENIED' });
    const deps: BootstrapDeps = {
      db: createMockDb(),
      secretsPut: createMockSecretsPut({ throws: err }),
    };

    await runBootstrap(deps, {
      email: 'admin@sevyn8.com',
      name: 'A',
      password: PASSWORD,
      env: 'dev',
    }).catch(() => {
      /* expected */
    });

    const joined = cap.captured.join('\n');
    expect(joined).not.toContain(PASSWORD);
    expect(joined).not.toContain('secret-error-path');
    cap.restore();
  });
});
