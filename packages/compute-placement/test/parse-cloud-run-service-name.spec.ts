import { describe, expect, it } from 'vitest';
import { ComputePlacementValidationError, parseCloudRunServiceName } from '../src/index.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

describe('parseCloudRunServiceName — happy paths', () => {
  it('parses a shared service name to { workload, tenantId: null }', () => {
    const result = parseCloudRunServiceName('api-gateway-shared');
    expect(result.workload).toBe('api-gateway');
    expect(result.tenantId).toBeNull();
  });

  it('parses a dedicated service name to { workload, tenantId }', () => {
    const result = parseCloudRunServiceName(`api-gateway-tenant-${TENANT_ID}`);
    expect(result.workload).toBe('api-gateway');
    expect(result.tenantId).toBe(TENANT_ID);
  });

  it('19-char workload + dedicated UUID = exactly 63 chars and parses cleanly (boundary)', () => {
    // 19 chars (max) + '-tenant-' (8) + UUID (36) = 63 exactly
    const workload = 'mcp-cortex-core-svc'; // 19 chars
    expect(workload.length).toBe(19);
    const serviceName = `${workload}-tenant-${TENANT_ID}`;
    expect(serviceName.length).toBe(63);
    const result = parseCloudRunServiceName(serviceName);
    expect(result.workload).toBe(workload);
    expect(result.tenantId).toBe(TENANT_ID);
  });
});

describe('parseCloudRunServiceName — rejection paths', () => {
  it('throws on >63 chars', () => {
    // 20-char workload pushes dedicated form over the limit
    const tooLong = `${'a'.repeat(20)}-tenant-${TENANT_ID}`;
    expect(tooLong.length).toBe(64);
    expect(() => parseCloudRunServiceName(tooLong)).toThrow(ComputePlacementValidationError);
  });

  it('throws on uppercase letters in workload', () => {
    expect(() => parseCloudRunServiceName('API-Gateway-shared')).toThrow(
      ComputePlacementValidationError,
    );
  });

  it('throws on malformed UUID in dedicated form', () => {
    // Wrong UUID shape (missing hyphens / hex digits)
    expect(() => parseCloudRunServiceName('api-gateway-tenant-not-a-real-uuid')).toThrow(
      ComputePlacementValidationError,
    );
  });

  it('throws on a non-Cortex pattern entirely', () => {
    expect(() => parseCloudRunServiceName('foo-bar-baz')).toThrow(ComputePlacementValidationError);
    expect(() => parseCloudRunServiceName('api-gateway')).toThrow(ComputePlacementValidationError);
  });
});
