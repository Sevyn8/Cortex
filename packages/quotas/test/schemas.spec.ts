import { describe, expect, it } from 'vitest';
import {
  RESOURCE_CLASSES,
  checkQuotaParamsSchema,
  quotaTierSchema,
  resourceClassSchema,
} from '../src/index.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

describe('tenantId UUID validation (via checkQuotaParamsSchema)', () => {
  it('accepts a valid UUID; rejects a non-UUID string', () => {
    const ok = checkQuotaParamsSchema.safeParse({
      tenantId: TENANT_ID,
      resourceClass: 'api_calls_per_minute',
      increment: 1n,
    });
    expect(ok.success).toBe(true);

    const bad = checkQuotaParamsSchema.safeParse({
      tenantId: 'not-a-uuid',
      resourceClass: 'api_calls_per_minute',
      increment: 1n,
    });
    expect(bad.success).toBe(false);
  });
});

describe('resourceClassSchema', () => {
  it('accepts each of the 4 valid resource classes', () => {
    for (const cls of RESOURCE_CLASSES) {
      expect(resourceClassSchema.safeParse(cls).success).toBe(true);
    }
  });

  it('rejects unknown resource class strings', () => {
    const invalid = ['cpu_minutes', 'unknown', '', 'API_CALLS_PER_MINUTE', 'db_conn'];
    for (const value of invalid) {
      expect(resourceClassSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('quotaTierSchema', () => {
  it('accepts STANDARD + ENTERPRISE', () => {
    for (const tier of ['STANDARD', 'ENTERPRISE'] as const) {
      expect(quotaTierSchema.safeParse(tier).success).toBe(true);
    }
  });

  it('rejects unknown tier values (case-sensitive)', () => {
    const invalid = ['FREE', 'PRO', 'standard', 'enterprise', '', 'BASIC'];
    for (const value of invalid) {
      expect(quotaTierSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('checkQuotaParamsSchema', () => {
  it('accepts valid params with a positive bigint increment', () => {
    const r = checkQuotaParamsSchema.safeParse({
      tenantId: TENANT_ID,
      resourceClass: 'api_calls_per_minute',
      increment: 1n,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(typeof r.data.increment).toBe('bigint');
      expect(r.data.increment).toBe(1n);
    }
  });

  it('accepts increment: 0n (nonnegative refinement permits zero)', () => {
    const r = checkQuotaParamsSchema.safeParse({
      tenantId: TENANT_ID,
      resourceClass: 'cpu_seconds',
      increment: 0n,
    });
    expect(r.success).toBe(true);
  });

  it('rejects negative bigint increment with code "too_small"', () => {
    const r = checkQuotaParamsSchema.safeParse({
      tenantId: TENANT_ID,
      resourceClass: 'api_calls_per_minute',
      increment: -1n,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.join('.') === 'increment');
      expect(issue?.code).toBe('too_small');
    }
  });

  it('rejects non-bigint increment (number, string)', () => {
    const cases: Record<string, unknown>[] = [
      { tenantId: TENANT_ID, resourceClass: 'api_calls_per_minute', increment: 5 },
      { tenantId: TENANT_ID, resourceClass: 'api_calls_per_minute', increment: '5' },
    ];
    for (const fixture of cases) {
      const r = checkQuotaParamsSchema.safeParse(fixture);
      expect(r.success).toBe(false);
    }
  });
});
