import { describe, expect, it } from 'vitest';
import type { ComputePlacement, CortexEnv, GetComputePlacementParams } from '../src/index.js';

// ─────────────────────────────────────────────────────────────────────
// Compile-time helper: assert two types are equal. Forces TS to
// surface any divergence in the type-system shape; failure is a
// typecheck error, not a runtime failure. (Duplicated from
// @cortex/quotas test pattern — extract to a shared util when a
// fourth spec needs it; currently below the WET threshold.)
// ─────────────────────────────────────────────────────────────────────

type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

describe('CortexEnv literal-union', () => {
  it("equals 'dev' | 'staging' | 'prod'", () => {
    const _check: Equals<CortexEnv, 'dev' | 'staging' | 'prod'> = true;
    expect(_check).toBe(true);
  });
});

describe('ComputePlacement discriminated union — shared branch', () => {
  it('narrows to the shared branch when kind === "shared"', () => {
    const placement: ComputePlacement = {
      kind: 'shared',
      cloudRunService: 'api-gateway-shared',
      placementLabel: 'shared',
    };
    if (placement.kind === 'shared') {
      expect(placement.placementLabel).toBe('shared');
      expect(placement.cloudRunService).toBe('api-gateway-shared');
      // tenantId field NOT present on the shared branch — verified by
      // the absence of `placement.tenantId` reference (TS would error).
    }
  });
});

describe('ComputePlacement discriminated union — dedicated branch', () => {
  it('narrows to the dedicated branch when kind === "dedicated" and surfaces tenantId', () => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const placement: ComputePlacement = {
      kind: 'dedicated',
      cloudRunService: `api-gateway-tenant-${tenantId}`,
      placementLabel: 'dedicated',
      tenantId,
    };
    if (placement.kind === 'dedicated') {
      expect(placement.placementLabel).toBe('dedicated');
      expect(placement.tenantId).toBe(tenantId);
      expect(placement.cloudRunService).toContain('-tenant-');
    }
  });
});

describe('GetComputePlacementParams shape', () => {
  it('has tenantId, workload, env fields (compile-time check)', () => {
    const params: GetComputePlacementParams = {
      tenantId: '11111111-1111-4111-8111-111111111111',
      workload: 'api-gateway',
      env: 'dev',
    };
    expect(params.tenantId).toBeDefined();
    expect(params.workload).toBe('api-gateway');
    expect(params.env).toBe('dev');
  });
});
