import { describe, expect, it } from 'vitest';
import {
  BlobStorageValidationError,
  TENANT_PATH_PREFIX,
  assertObjectInTenantPrefix,
  buildFullObjectPath,
  getTenantBucketName,
  getTenantPrefix,
} from '../src/index.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

describe('TENANT_PATH_PREFIX', () => {
  it("equals 'tenants/'", () => {
    expect(TENANT_PATH_PREFIX).toBe('tenants/');
  });
});

describe('getTenantPrefix', () => {
  it('returns tenants/{tenantId}/ for a valid UUID', () => {
    expect(getTenantPrefix(TENANT_A)).toBe(`tenants/${TENANT_A}/`);
  });

  it('throws BlobStorageValidationError for non-UUID input', () => {
    expect(() => getTenantPrefix('not-a-uuid')).toThrow(BlobStorageValidationError);
  });
});

describe('getTenantBucketName', () => {
  it('returns cortex-{env}-tenant-data for each Phase 1 environment', () => {
    expect(getTenantBucketName('dev')).toBe('cortex-dev-tenant-data');
    expect(getTenantBucketName('staging')).toBe('cortex-staging-tenant-data');
    expect(getTenantBucketName('prod')).toBe('cortex-prod-tenant-data');
  });
});

describe('buildFullObjectPath', () => {
  it('happy path: assembles tenants/{id}/{name}', () => {
    expect(buildFullObjectPath(TENANT_A, 'reports/2026/04/sales.csv')).toBe(
      `tenants/${TENANT_A}/reports/2026/04/sales.csv`,
    );
  });

  it('rejects non-UUID tenantId', () => {
    expect(() => buildFullObjectPath('xxx', 'foo.txt')).toThrow(BlobStorageValidationError);
  });

  it('rejects objectName with leading slash', () => {
    expect(() => buildFullObjectPath(TENANT_A, '/leading/slash.txt')).toThrow(
      BlobStorageValidationError,
    );
  });

  it('rejects objectName containing path traversal (..)', () => {
    expect(() => buildFullObjectPath(TENANT_A, '../escape.txt')).toThrow(
      BlobStorageValidationError,
    );
    expect(() => buildFullObjectPath(TENANT_A, 'a/b/../c.txt')).toThrow(BlobStorageValidationError);
  });

  it('rejects objectName containing NUL bytes', () => {
    expect(() => buildFullObjectPath(TENANT_A, 'evil\x00name')).toThrow(BlobStorageValidationError);
  });

  it('rejects objectName starting with tenants/ prefix (caller-bypass attempt)', () => {
    expect(() => buildFullObjectPath(TENANT_A, `tenants/${TENANT_B}/sneaky.txt`)).toThrow(
      BlobStorageValidationError,
    );
  });

  it('rejects empty objectName', () => {
    expect(() => buildFullObjectPath(TENANT_A, '')).toThrow(BlobStorageValidationError);
  });
});

describe('assertObjectInTenantPrefix', () => {
  it('happy path: tenant-prefixed full path passes', () => {
    expect(() =>
      assertObjectInTenantPrefix(TENANT_A, `tenants/${TENANT_A}/foo/bar.csv`),
    ).not.toThrow();
  });

  it('cross-tenant: throws when full path belongs to a different tenant', () => {
    expect(() => assertObjectInTenantPrefix(TENANT_A, `tenants/${TENANT_B}/foo/bar.csv`)).toThrow(
      BlobStorageValidationError,
    );
  });

  it('throws when full path lacks the tenants/ prefix entirely', () => {
    expect(() => assertObjectInTenantPrefix(TENANT_A, 'public/foo.csv')).toThrow(
      BlobStorageValidationError,
    );
  });

  it('throws when tenantId itself is malformed', () => {
    expect(() => assertObjectInTenantPrefix('not-uuid', 'anything')).toThrow(
      BlobStorageValidationError,
    );
  });
});
