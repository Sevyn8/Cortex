import { describe, expect, it } from 'vitest';
import { environmentSchema, objectNameSchema, signedUrlParamsSchema } from '../src/index.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';

describe('environmentSchema', () => {
  it('accepts dev / staging / prod; rejects others', () => {
    expect(environmentSchema.safeParse('dev').success).toBe(true);
    expect(environmentSchema.safeParse('staging').success).toBe(true);
    expect(environmentSchema.safeParse('prod').success).toBe(true);
    expect(environmentSchema.safeParse('local').success).toBe(false);
    expect(environmentSchema.safeParse('').success).toBe(false);
  });
});

describe('objectNameSchema', () => {
  it('accepts valid relative paths', () => {
    expect(objectNameSchema.safeParse('foo.csv').success).toBe(true);
    expect(objectNameSchema.safeParse('a/b/c.json').success).toBe(true);
    expect(objectNameSchema.safeParse('reports/2026/04/sales.parquet').success).toBe(true);
  });

  it('rejects empty / leading-slash / traversal / NUL / tenants-prefix', () => {
    expect(objectNameSchema.safeParse('').success).toBe(false);
    expect(objectNameSchema.safeParse('/leading').success).toBe(false);
    expect(objectNameSchema.safeParse('a/../b').success).toBe(false);
    expect(objectNameSchema.safeParse('evil\x00name').success).toBe(false);
    expect(objectNameSchema.safeParse('tenants/foo/bar').success).toBe(false);
  });

  it('rejects strings >1024 chars', () => {
    expect(objectNameSchema.safeParse('a'.repeat(1024)).success).toBe(true);
    expect(objectNameSchema.safeParse('a'.repeat(1025)).success).toBe(false);
  });
});

describe('signedUrlParamsSchema', () => {
  it('accepts a valid full params object (read action)', () => {
    const r = signedUrlParamsSchema.safeParse({
      tenantId: TENANT_A,
      objectName: 'reports/foo.csv',
      expiresInSeconds: 900,
      action: 'read',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a valid write-action params object with contentType', () => {
    const r = signedUrlParamsSchema.safeParse({
      tenantId: TENANT_A,
      objectName: 'uploads/file.bin',
      expiresInSeconds: 60,
      action: 'write',
      contentType: 'application/octet-stream',
    });
    expect(r.success).toBe(true);
  });

  it('rejects expiresInSeconds at or below 0', () => {
    expect(
      signedUrlParamsSchema.safeParse({
        tenantId: TENANT_A,
        objectName: 'foo',
        expiresInSeconds: 0,
        action: 'read',
      }).success,
    ).toBe(false);
  });

  it('rejects expiresInSeconds above 7 days (604800)', () => {
    expect(
      signedUrlParamsSchema.safeParse({
        tenantId: TENANT_A,
        objectName: 'foo',
        expiresInSeconds: 7 * 24 * 60 * 60 + 1,
        action: 'read',
      }).success,
    ).toBe(false);
  });

  it('rejects unsupported action values', () => {
    const r = signedUrlParamsSchema.safeParse({
      tenantId: TENANT_A,
      objectName: 'foo',
      expiresInSeconds: 60,
      action: 'delete',
    });
    expect(r.success).toBe(false);
  });
});
