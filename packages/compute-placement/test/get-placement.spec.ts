import { describe, expect, it } from 'vitest';
import {
  ComputePlacementValidationError,
  getComputePlacement,
  parseCloudRunServiceName,
  type CortexEnv,
  type GetComputePlacementParams,
} from '../src/index.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

describe('getComputePlacement — Phase 1 stub', () => {
  it('returns shared placement for any tenant', async () => {
    const result = await getComputePlacement({
      tenantId: TENANT_ID,
      workload: 'api-gateway',
      env: 'dev',
    });
    expect(result.kind).toBe('shared');
    if (result.kind === 'shared') {
      expect(result.placementLabel).toBe('shared');
    }
  });

  it('cloudRunService format is {workload}-shared (no cortex- prefix, no env suffix)', async () => {
    const result = await getComputePlacement({
      tenantId: TENANT_ID,
      workload: 'api-gateway',
      env: 'dev',
    });
    expect(result.cloudRunService).toBe('api-gateway-shared');
    // Explicit absence checks per ADR-COMPUTE-001 §4 amendment
    expect(result.cloudRunService).not.toMatch(/^cortex-/);
    expect(result.cloudRunService).not.toMatch(/-(dev|staging|prod)$/);
  });

  it('placementLabel is always "shared" in Phase 1', async () => {
    const envs: readonly CortexEnv[] = ['dev', 'staging', 'prod'];
    for (const env of envs) {
      const result = await getComputePlacement({ tenantId: TENANT_ID, workload: 'foo', env });
      expect(result.placementLabel).toBe('shared');
    }
  });

  it('env value does NOT appear in cloudRunService string', async () => {
    // Run with all three envs; verify the env value isn't embedded
    // in the service name (ADR-COMPUTE-001 §1: env namespacing comes
    // from the GCP project, not the service name).
    const tenantId = TENANT_ID;
    const workload = 'api-gateway';
    const r1 = await getComputePlacement({ tenantId, workload, env: 'dev' });
    const r2 = await getComputePlacement({ tenantId, workload, env: 'staging' });
    const r3 = await getComputePlacement({ tenantId, workload, env: 'prod' });
    expect(r1.cloudRunService).toBe('api-gateway-shared');
    expect(r2.cloudRunService).toBe('api-gateway-shared');
    expect(r3.cloudRunService).toBe('api-gateway-shared');
  });

  it('different workload values produce distinct service names', async () => {
    const r1 = await getComputePlacement({
      tenantId: TENANT_ID,
      workload: 'api-gateway',
      env: 'dev',
    });
    const r2 = await getComputePlacement({
      tenantId: TENANT_ID,
      workload: 'dis-worker',
      env: 'dev',
    });
    expect(r1.cloudRunService).toBe('api-gateway-shared');
    expect(r2.cloudRunService).toBe('dis-worker-shared');
    expect(r1.cloudRunService).not.toBe(r2.cloudRunService);
  });

  it('throws ComputePlacementValidationError on malformed params', async () => {
    await expect(
      getComputePlacement({ tenantId: 'not-a-uuid', workload: 'foo', env: 'dev' }),
    ).rejects.toBeInstanceOf(ComputePlacementValidationError);

    await expect(
      getComputePlacement({ tenantId: TENANT_ID, workload: 'BAD UPPER', env: 'dev' }),
    ).rejects.toBeInstanceOf(ComputePlacementValidationError);
  });
});

describe('getComputePlacement + parseCloudRunServiceName round-trip', () => {
  it('shared placement output parses back to same workload', async () => {
    const params: GetComputePlacementParams = {
      tenantId: TENANT_ID,
      workload: 'api-gateway',
      env: 'dev',
    };
    const placement = await getComputePlacement(params);
    const parsed = parseCloudRunServiceName(placement.cloudRunService);
    expect(parsed.workload).toBe('api-gateway');
    expect(parsed.tenantId).toBeNull();
  });

  it('round-trip works for all currently-planned workloads', async () => {
    const workloads = [
      'api-gateway',
      'dis-worker',
      'mcp-cortex-core',
      'admin-console',
      'mcp-admin-ops',
    ];
    for (const workload of workloads) {
      const placement = await getComputePlacement({
        tenantId: TENANT_ID,
        workload,
        env: 'prod',
      });
      const parsed = parseCloudRunServiceName(placement.cloudRunService);
      expect(parsed.workload).toBe(workload);
      expect(parsed.tenantId).toBeNull();
    }
  });
});
