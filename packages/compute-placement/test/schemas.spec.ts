import { describe, expect, it } from 'vitest';
import {
  cortexEnvSchema,
  cortexWorkloadSchema,
  getComputePlacementParamsSchema,
  tenantIdSchema,
} from '../src/index.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

describe('cortexEnvSchema', () => {
  it('accepts dev / staging / prod; rejects unknowns', () => {
    expect(cortexEnvSchema.safeParse('dev').success).toBe(true);
    expect(cortexEnvSchema.safeParse('staging').success).toBe(true);
    expect(cortexEnvSchema.safeParse('prod').success).toBe(true);
    expect(cortexEnvSchema.safeParse('local').success).toBe(false);
    expect(cortexEnvSchema.safeParse('PROD').success).toBe(false);
    expect(cortexEnvSchema.safeParse('').success).toBe(false);
  });
});

describe('tenantIdSchema', () => {
  it('accepts valid UUID; rejects non-UUID', () => {
    expect(tenantIdSchema.safeParse(TENANT_ID).success).toBe(true);
    expect(tenantIdSchema.safeParse('not-a-uuid').success).toBe(false);
    expect(tenantIdSchema.safeParse('').success).toBe(false);
  });
});

describe('cortexWorkloadSchema', () => {
  it('accepts valid workload names', () => {
    const valid = ['api-gateway', 'dis-worker', 'mcp-cortex-core', 'a', 'foundation'];
    for (const v of valid) {
      expect(cortexWorkloadSchema.safeParse(v).success).toBe(true);
    }
  });

  it('rejects invalid workload names', () => {
    const invalid = [
      '',
      '-leading-dash',
      '1starts-with-digit',
      'has_underscore',
      'UPPERCASE',
      'mixed-Case',
      'has space',
      'has.dot',
    ];
    for (const v of invalid) {
      expect(cortexWorkloadSchema.safeParse(v).success).toBe(false);
    }
  });

  it('enforces 19-char ceiling per ADR-COMPUTE-001 §4 length budget', () => {
    expect(cortexWorkloadSchema.safeParse('a'.repeat(19)).success).toBe(true);
    expect(cortexWorkloadSchema.safeParse('a'.repeat(20)).success).toBe(false);
  });
});

describe('getComputePlacementParamsSchema', () => {
  it('rejects via parent schema when workload is invalid', () => {
    const r = getComputePlacementParamsSchema.safeParse({
      tenantId: TENANT_ID,
      workload: 'BAD UPPERCASE',
      env: 'dev',
    });
    expect(r.success).toBe(false);
  });
});
