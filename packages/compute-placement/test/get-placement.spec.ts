/**
 * Tests for `getComputePlacement` — F02 Slice A swap (sub-phase 5.4).
 *
 * Pre-swap (Phase 1) the function returned shared unconditionally; tests
 * asserted on the static behavior. Post-swap the function queries
 * `tenant.tier` and branches per ADR-COMPUTE-001. Tests use a mock db
 * (per planning-doc SA4 + sub-phase 5.4 lock) — `@cortex/compute-placement`
 * stays DB-independent for testing; the production caller passes a real
 * `NodePgDatabase`.
 */

import { describe, expect, it, vi } from 'vitest';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  ComputePlacementConfigError,
  ComputePlacementValidationError,
  getComputePlacement,
  parseCloudRunServiceName,
  type CortexEnv,
  type GetComputePlacementParams,
} from '../src/index.js';

const STANDARD_TENANT = '11111111-1111-4111-8111-111111111111';
const ENTERPRISE_TENANT = '22222222-2222-4222-8222-222222222222';

/**
 * Mock db for the `select({ tier }).from(tenant).where(eq(...)).limit(1)`
 * chain. `rows` is the array returned by `.limit(1)`. Pass `[{tier:
 * 'STANDARD'}]` for shared, `[{tier: 'ENTERPRISE'}]` for dedicated, `[]`
 * for tenant-not-found.
 */
function mockDb(
  rows: { tier: 'STANDARD' | 'ENTERPRISE' }[],
): NodePgDatabase<Record<string, never>> {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  } as unknown as NodePgDatabase<Record<string, never>>;
}

const standardDb = (): NodePgDatabase<Record<string, never>> => mockDb([{ tier: 'STANDARD' }]);
const enterpriseDb = (): NodePgDatabase<Record<string, never>> => mockDb([{ tier: 'ENTERPRISE' }]);
const emptyDb = (): NodePgDatabase<Record<string, never>> => mockDb([]);

describe('getComputePlacement — STANDARD tier (shared placement)', () => {
  it('STANDARD tenant returns shared placement', async () => {
    const result = await getComputePlacement(
      { tenantId: STANDARD_TENANT, workload: 'api-gateway', env: 'dev' },
      standardDb(),
    );
    expect(result.kind).toBe('shared');
    if (result.kind === 'shared') {
      expect(result.placementLabel).toBe('shared');
    }
  });

  it('cloudRunService format is {workload}-shared (no cortex- prefix, no env suffix)', async () => {
    const result = await getComputePlacement(
      { tenantId: STANDARD_TENANT, workload: 'api-gateway', env: 'dev' },
      standardDb(),
    );
    expect(result.cloudRunService).toBe('api-gateway-shared');
    // Explicit absence checks per ADR-COMPUTE-001 §4.
    expect(result.cloudRunService).not.toMatch(/^cortex-/);
    expect(result.cloudRunService).not.toMatch(/-(dev|staging|prod)$/);
  });

  it('placementLabel is "shared" across all envs (env not embedded in name)', async () => {
    const envs: readonly CortexEnv[] = ['dev', 'staging', 'prod'];
    for (const env of envs) {
      const result = await getComputePlacement(
        { tenantId: STANDARD_TENANT, workload: 'foo', env },
        standardDb(),
      );
      expect(result.placementLabel).toBe('shared');
    }
  });

  it('env value does NOT appear in cloudRunService string', async () => {
    const tenantId = STANDARD_TENANT;
    const workload = 'api-gateway';
    const r1 = await getComputePlacement({ tenantId, workload, env: 'dev' }, standardDb());
    const r2 = await getComputePlacement({ tenantId, workload, env: 'staging' }, standardDb());
    const r3 = await getComputePlacement({ tenantId, workload, env: 'prod' }, standardDb());
    expect(r1.cloudRunService).toBe('api-gateway-shared');
    expect(r2.cloudRunService).toBe('api-gateway-shared');
    expect(r3.cloudRunService).toBe('api-gateway-shared');
  });

  it('different workload values produce distinct service names', async () => {
    const r1 = await getComputePlacement(
      { tenantId: STANDARD_TENANT, workload: 'api-gateway', env: 'dev' },
      standardDb(),
    );
    const r2 = await getComputePlacement(
      { tenantId: STANDARD_TENANT, workload: 'dis-worker', env: 'dev' },
      standardDb(),
    );
    expect(r1.cloudRunService).toBe('api-gateway-shared');
    expect(r2.cloudRunService).toBe('dis-worker-shared');
    expect(r1.cloudRunService).not.toBe(r2.cloudRunService);
  });
});

describe('getComputePlacement — ENTERPRISE tier (dedicated placement)', () => {
  it('ENTERPRISE tenant returns dedicated placement with tenant-specific service name', async () => {
    const result = await getComputePlacement(
      { tenantId: ENTERPRISE_TENANT, workload: 'api-gateway', env: 'dev' },
      enterpriseDb(),
    );
    expect(result.kind).toBe('dedicated');
    if (result.kind === 'dedicated') {
      expect(result.placementLabel).toBe('dedicated');
      expect(result.tenantId).toBe(ENTERPRISE_TENANT);
    }
  });

  it('cloudRunService format is {workload}-tenant-{uuid} per ADR-COMPUTE-001', async () => {
    const result = await getComputePlacement(
      { tenantId: ENTERPRISE_TENANT, workload: 'api-gateway', env: 'dev' },
      enterpriseDb(),
    );
    expect(result.cloudRunService).toBe(`api-gateway-tenant-${ENTERPRISE_TENANT}`);
    // Service name length under the 63-char Cloud Run limit:
    //   workload (≤19) + '-tenant-' (8) + uuid (36) = 63 max.
    expect(result.cloudRunService.length).toBeLessThanOrEqual(63);
  });

  it('env value does NOT appear in dedicated service name', async () => {
    const result = await getComputePlacement(
      { tenantId: ENTERPRISE_TENANT, workload: 'api-gateway', env: 'prod' },
      enterpriseDb(),
    );
    expect(result.cloudRunService).not.toMatch(/-(dev|staging|prod)$/);
    expect(result.cloudRunService).not.toContain('-prod-');
  });

  it('placementLabel is "dedicated" across all envs', async () => {
    const envs: readonly CortexEnv[] = ['dev', 'staging', 'prod'];
    for (const env of envs) {
      const result = await getComputePlacement(
        { tenantId: ENTERPRISE_TENANT, workload: 'foo', env },
        enterpriseDb(),
      );
      expect(result.placementLabel).toBe('dedicated');
    }
  });
});

describe('getComputePlacement — error paths', () => {
  it('throws ComputePlacementConfigError when tenant row not found', async () => {
    await expect(
      getComputePlacement({ tenantId: STANDARD_TENANT, workload: 'foo', env: 'dev' }, emptyDb()),
    ).rejects.toBeInstanceOf(ComputePlacementConfigError);
  });

  it('not-found error message includes tenantId for forensic context', async () => {
    await expect(
      getComputePlacement({ tenantId: STANDARD_TENANT, workload: 'foo', env: 'dev' }, emptyDb()),
    ).rejects.toThrow(new RegExp(STANDARD_TENANT));
  });

  it('throws ComputePlacementValidationError on malformed params (non-UUID tenantId)', async () => {
    await expect(
      getComputePlacement({ tenantId: 'not-a-uuid', workload: 'foo', env: 'dev' }, standardDb()),
    ).rejects.toBeInstanceOf(ComputePlacementValidationError);
  });

  it('throws ComputePlacementValidationError on malformed params (workload regex violation)', async () => {
    await expect(
      getComputePlacement(
        { tenantId: STANDARD_TENANT, workload: 'BAD UPPER', env: 'dev' },
        standardDb(),
      ),
    ).rejects.toBeInstanceOf(ComputePlacementValidationError);
  });
});

describe('getComputePlacement + parseCloudRunServiceName round-trip', () => {
  it('shared placement output parses back to same workload + null tenantId', async () => {
    const params: GetComputePlacementParams = {
      tenantId: STANDARD_TENANT,
      workload: 'api-gateway',
      env: 'dev',
    };
    const placement = await getComputePlacement(params, standardDb());
    const parsed = parseCloudRunServiceName(placement.cloudRunService);
    expect(parsed.workload).toBe('api-gateway');
    expect(parsed.tenantId).toBeNull();
  });

  it('dedicated placement output parses back to same workload + tenantId', async () => {
    const params: GetComputePlacementParams = {
      tenantId: ENTERPRISE_TENANT,
      workload: 'api-gateway',
      env: 'dev',
    };
    const placement = await getComputePlacement(params, enterpriseDb());
    const parsed = parseCloudRunServiceName(placement.cloudRunService);
    expect(parsed.workload).toBe('api-gateway');
    expect(parsed.tenantId).toBe(ENTERPRISE_TENANT);
  });

  it('round-trip works for all currently-planned workloads (shared)', async () => {
    const workloads = [
      'api-gateway',
      'dis-worker',
      'mcp-cortex-core',
      'admin-console',
      'mcp-admin-ops',
    ];
    for (const workload of workloads) {
      const placement = await getComputePlacement(
        { tenantId: STANDARD_TENANT, workload, env: 'prod' },
        standardDb(),
      );
      const parsed = parseCloudRunServiceName(placement.cloudRunService);
      expect(parsed.workload).toBe(workload);
      expect(parsed.tenantId).toBeNull();
    }
  });

  it('round-trip works for all currently-planned workloads (dedicated)', async () => {
    const workloads = [
      'api-gateway',
      'dis-worker',
      'mcp-cortex-core',
      'admin-console',
      'mcp-admin-ops',
    ];
    for (const workload of workloads) {
      const placement = await getComputePlacement(
        { tenantId: ENTERPRISE_TENANT, workload, env: 'prod' },
        enterpriseDb(),
      );
      const parsed = parseCloudRunServiceName(placement.cloudRunService);
      expect(parsed.workload).toBe(workload);
      expect(parsed.tenantId).toBe(ENTERPRISE_TENANT);
    }
  });
});
