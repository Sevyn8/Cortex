import { describe, expect, it } from 'vitest';
import { tenantContextProvider } from '../src/context-provider.js';
import { withTenantContext } from '../src/context.js';

const OUTER_TENANT_ID = '11111111-1111-4111-8111-111111111111';
const INNER_TENANT_ID = '22222222-2222-4222-8222-222222222222';

describe('tenantContextProvider — getTenantId', () => {
  it('returns undefined when no async-local tenant binding is active', () => {
    expect(tenantContextProvider.getTenantId()).toBeUndefined();
  });

  it('returns the bound tenant id inside withTenantContext', async () => {
    await withTenantContext(OUTER_TENANT_ID, () => {
      expect(tenantContextProvider.getTenantId()).toBe(OUTER_TENANT_ID);
    });
  });

  it('reflects nested binding (innermost wins)', async () => {
    await withTenantContext(OUTER_TENANT_ID, async () => {
      expect(tenantContextProvider.getTenantId()).toBe(OUTER_TENANT_ID);
      await withTenantContext(INNER_TENANT_ID, () => {
        expect(tenantContextProvider.getTenantId()).toBe(INNER_TENANT_ID);
      });
      expect(tenantContextProvider.getTenantId()).toBe(OUTER_TENANT_ID);
    });
  });

  it('returns to undefined after withTenantContext scope exits', async () => {
    await withTenantContext(OUTER_TENANT_ID, () => {
      expect(tenantContextProvider.getTenantId()).toBe(OUTER_TENANT_ID);
    });
    expect(tenantContextProvider.getTenantId()).toBeUndefined();
  });
});
