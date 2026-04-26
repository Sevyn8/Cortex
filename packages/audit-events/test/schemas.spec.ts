import { describe, expect, it } from 'vitest';
import {
  auditEventCreateSchema,
  auditEventDeleteSchema,
  auditEventParamsSchema,
  auditEventReadSchema,
  auditEventUpdateSchema,
  jsonObjectSchema,
  jsonValueSchema,
} from '../src/index.js';

// ─────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const RESOURCE = `tenant:${TENANT_ID}`;

function commonInput(verbName: string, verb: string): Record<string, unknown> {
  return {
    tenantId: TENANT_ID,
    actorType: 'service',
    actorId: 'svc-foundation',
    action: { name: verbName, verb },
    verb,
    resource: RESOURCE,
  };
}

// ─────────────────────────────────────────────────────────────────────
// jsonValueSchema acceptance
// ─────────────────────────────────────────────────────────────────────

describe('jsonValueSchema — acceptance', () => {
  it('accepts strings (NFC-normalized in output)', () => {
    const r = jsonValueSchema.safeParse('hello');
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe('hello');
  });

  it('accepts numbers, booleans, and null', () => {
    expect(jsonValueSchema.safeParse(42).success).toBe(true);
    expect(jsonValueSchema.safeParse(3.14).success).toBe(true);
    expect(jsonValueSchema.safeParse(true).success).toBe(true);
    expect(jsonValueSchema.safeParse(false).success).toBe(true);
    expect(jsonValueSchema.safeParse(null).success).toBe(true);
  });

  it('accepts deeply-nested arrays and objects (5 levels)', () => {
    const deep = {
      level1: {
        level2: {
          level3: [{ level4: { level5: 'value' } }, 42, null],
        },
      },
    };
    expect(jsonValueSchema.safeParse(deep).success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// jsonValueSchema rejection
// ─────────────────────────────────────────────────────────────────────

describe('jsonValueSchema — rejection', () => {
  it('rejects non-JSON-safe value types', () => {
    const invalid: unknown[] = [
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      () => {},
      Symbol('foo'),
      BigInt(1),
      new Date(),
    ];
    for (const value of invalid) {
      const r = jsonValueSchema.safeParse(value);
      expect(r.success).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// NFC normalization
//
// Decomposed strings written as escape sequences (́ = combining
// acute, é = composed é) to prevent silent NFC normalization by
// editor / formatter / write pipelines. Bare 'café' literals are unsafe
// — the source-file byte representation can drift between (composed,
// 4 codepoints, U+00E9) and (decomposed, 5 codepoints, U+0065 U+0301)
// depending on tooling, defeating the test. See roadmap §1.11 and
// canonicalize.spec.ts for the convention.
// ─────────────────────────────────────────────────────────────────────

describe('NFC normalization', () => {
  it('top-level string: combining-acute (NFD) → composed (NFC)', () => {
    const decomposed = 'cafe\u0301'; // c-a-f-e + combining acute (5 code units)
    const composed = 'caf\u00e9'; // c-a-f-é (4 code units)
    expect(decomposed.length).toBe(5);
    expect(composed.length).toBe(4);

    const r = jsonValueSchema.safeParse(decomposed);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toBe(composed);
      expect((r.data as string).normalize('NFC')).toBe(r.data);
      expect((r.data as string).normalize('NFD')).not.toBe(r.data);
    }
  });

  it('nested string inside payload object: NFC applied recursively', () => {
    const decomposed = 'cafe\u0301';
    const composed = 'caf\u00e9';
    const r = jsonObjectSchema.safeParse({
      user: { display_name: decomposed, nested: { tagline: decomposed } },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      const data = r.data as Record<string, Record<string, unknown>>;
      expect(data.user?.display_name).toBe(composed);
      const nested = data.user?.nested as Record<string, unknown>;
      expect(nested.tagline).toBe(composed);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Per-verb schemas
// ─────────────────────────────────────────────────────────────────────

describe('auditEventCreateSchema', () => {
  it('accepts after_state, rejects supplied before_state', () => {
    const ok = auditEventCreateSchema.safeParse({
      ...commonInput('TENANT_CREATED', 'CREATE'),
      after_state: { tier: 'STANDARD' },
    });
    expect(ok.success).toBe(true);

    const bad = auditEventCreateSchema.safeParse({
      ...commonInput('TENANT_CREATED', 'CREATE'),
      after_state: { tier: 'STANDARD' },
      before_state: { tier: 'BASIC' },
    });
    expect(bad.success).toBe(false);
  });
});

describe('auditEventUpdateSchema', () => {
  it('requires both before_state and after_state', () => {
    const okBoth = auditEventUpdateSchema.safeParse({
      ...commonInput('TENANT_UPDATED', 'UPDATE'),
      before_state: { status: 'PROVISIONING' },
      after_state: { status: 'ACTIVE' },
    });
    expect(okBoth.success).toBe(true);

    const missingBefore = auditEventUpdateSchema.safeParse({
      ...commonInput('TENANT_UPDATED', 'UPDATE'),
      after_state: { status: 'ACTIVE' },
    });
    expect(missingBefore.success).toBe(false);

    const missingAfter = auditEventUpdateSchema.safeParse({
      ...commonInput('TENANT_UPDATED', 'UPDATE'),
      before_state: { status: 'PROVISIONING' },
    });
    expect(missingAfter.success).toBe(false);
  });
});

describe('auditEventDeleteSchema', () => {
  it('requires before_state, rejects supplied after_state', () => {
    const ok = auditEventDeleteSchema.safeParse({
      ...commonInput('TENANT_REMOVED', 'DELETE'),
      before_state: { tier: 'STANDARD' },
    });
    expect(ok.success).toBe(true);

    const bad = auditEventDeleteSchema.safeParse({
      ...commonInput('TENANT_REMOVED', 'DELETE'),
      before_state: { tier: 'STANDARD' },
      after_state: { tier: 'BASIC' },
    });
    expect(bad.success).toBe(false);

    const missing = auditEventDeleteSchema.safeParse({
      ...commonInput('TENANT_REMOVED', 'DELETE'),
    });
    expect(missing.success).toBe(false);
  });
});

describe('auditEventReadSchema', () => {
  it('rejects both before_state and after_state when supplied', () => {
    const ok = auditEventReadSchema.safeParse({
      ...commonInput('TENANT_READ', 'READ'),
    });
    expect(ok.success).toBe(true);

    const withBefore = auditEventReadSchema.safeParse({
      ...commonInput('TENANT_READ', 'READ'),
      before_state: { tier: 'STANDARD' },
    });
    expect(withBefore.success).toBe(false);

    const withAfter = auditEventReadSchema.safeParse({
      ...commonInput('TENANT_READ', 'READ'),
      after_state: { tier: 'STANDARD' },
    });
    expect(withAfter.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Discriminated union
// ─────────────────────────────────────────────────────────────────────

describe('auditEventParamsSchema (discriminated union)', () => {
  it('routes to the matching per-verb schema based on verb literal', () => {
    const create = auditEventParamsSchema.safeParse({
      ...commonInput('TENANT_CREATED', 'CREATE'),
      after_state: { tier: 'STANDARD' },
    });
    expect(create.success).toBe(true);
    if (create.success) expect(create.data.verb).toBe('CREATE');

    const update = auditEventParamsSchema.safeParse({
      ...commonInput('TENANT_UPDATED', 'UPDATE'),
      before_state: { status: 'PROVISIONING' },
      after_state: { status: 'ACTIVE' },
    });
    expect(update.success).toBe(true);
    if (update.success) expect(update.data.verb).toBe('UPDATE');

    // CREATE-shaped (after_state, no before_state) but with verb='UPDATE'
    // should fail because UPDATE requires before_state.
    const mismatch = auditEventParamsSchema.safeParse({
      ...commonInput('TENANT_UPDATED', 'UPDATE'),
      after_state: { status: 'ACTIVE' },
      // missing before_state — UPDATE schema rejects
    });
    expect(mismatch.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Field-level guards
// ─────────────────────────────────────────────────────────────────────

describe('action-name regex enforcement at schema layer', () => {
  it('rejects action.name with lowercase characters', () => {
    const r = auditEventParamsSchema.safeParse({
      ...commonInput('tenant_created', 'CREATE'), // lowercase name
      after_state: { tier: 'STANDARD' },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      // Surface that the issue is in action.name
      const flat = r.error.flatten();
      const fieldErrors = flat.fieldErrors as Record<string, unknown>;
      const formErrors = flat.formErrors;
      const rendered = JSON.stringify({ fieldErrors, formErrors });
      expect(rendered.toLowerCase()).toMatch(/action|name/);
    }
  });
});

describe('tenantId UUID validation', () => {
  it('rejects non-UUID tenantId', () => {
    const r = auditEventParamsSchema.safeParse({
      ...commonInput('TENANT_CREATED', 'CREATE'),
      tenantId: 'not-a-uuid',
      after_state: { tier: 'STANDARD' },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const rendered = JSON.stringify(r.error.flatten());
      expect(rendered.toLowerCase()).toMatch(/uuid|tenant/);
    }
  });
});
