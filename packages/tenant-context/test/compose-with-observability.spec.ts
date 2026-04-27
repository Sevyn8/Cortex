/**
 * End-to-end integration: when an app composes
 * `defaultContextProvider` (from `@cortex/observability`) with
 * `tenantContextProvider` (from this package) via
 * `composeContextProviders`, log fields receive `tenant_id`
 * automatically inside an async-local tenant binding.
 *
 * This is the test that proves the roadmap §4.13 decoupling preserves
 * user-visible behavior. The previous behavior — observability's
 * default provider implicitly auto-resolving tenant_id — is replaced
 * by explicit composition. The composition pattern is the contract
 * apps wire at startup.
 */

import { describe, expect, it } from 'vitest';
import {
  composeContextProviders,
  defaultContextProvider,
  stubContextProvider,
} from '@cortex/observability';
import { tenantContextProvider } from '../src/context-provider.js';
import { withTenantContext } from '../src/context.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OVERRIDE_TENANT_ID = '22222222-2222-4222-8222-222222222222';

describe('composeContextProviders — tenant_id flow', () => {
  it('returns undefined outside any tenant binding', () => {
    const provider = composeContextProviders(defaultContextProvider, tenantContextProvider);
    expect(provider.getTenantId()).toBeUndefined();
  });

  it('reflects the bound tenant id inside withTenantContext', async () => {
    const provider = composeContextProviders(defaultContextProvider, tenantContextProvider);
    await withTenantContext(TENANT_ID, () => {
      expect(provider.getTenantId()).toBe(TENANT_ID);
    });
  });

  it('returns to undefined after withTenantContext scope exits', async () => {
    const provider = composeContextProviders(defaultContextProvider, tenantContextProvider);
    await withTenantContext(TENANT_ID, () => {
      expect(provider.getTenantId()).toBe(TENANT_ID);
    });
    expect(provider.getTenantId()).toBeUndefined();
  });
});

describe('composeContextProviders — order semantics', () => {
  it('first non-undefined wins: a provider supplying a static tenant id overrides tenantContextProvider', async () => {
    const overrideProvider = { getTenantId: () => OVERRIDE_TENANT_ID };
    const provider = composeContextProviders(
      overrideProvider,
      defaultContextProvider,
      tenantContextProvider,
    );

    // Outside scope: override wins because it returns a non-undefined value first.
    expect(provider.getTenantId()).toBe(OVERRIDE_TENANT_ID);

    // Inside scope: override still wins (it's first).
    await withTenantContext(TENANT_ID, () => {
      expect(provider.getTenantId()).toBe(OVERRIDE_TENANT_ID);
    });
  });

  it('default-then-tenant order: tenantContextProvider supplies the value (default returns undefined for tenant_id)', async () => {
    const provider = composeContextProviders(defaultContextProvider, tenantContextProvider);
    await withTenantContext(TENANT_ID, () => {
      expect(provider.getTenantId()).toBe(TENANT_ID);
    });
  });

  it('all providers returning undefined yields undefined', () => {
    const provider = composeContextProviders(stubContextProvider, tenantContextProvider);
    expect(provider.getTenantId()).toBeUndefined();
  });
});

describe('composeContextProviders — non-tenant fields', () => {
  it('non-tenant getters fall through to defaultContextProvider (correlation, trace, span, user)', () => {
    const provider = composeContextProviders(defaultContextProvider, tenantContextProvider);

    // Outside any correlation context / OTel span: all return undefined,
    // matching defaultContextProvider's outside-context behavior.
    expect(provider.getUserId()).toBeUndefined();
    expect(provider.getCorrelationId()).toBeUndefined();
    expect(provider.getTraceId()).toBeUndefined();
    expect(provider.getSpanId()).toBeUndefined();
  });

  it('tenantContextProvider does not interfere with other fields when used alone', () => {
    const provider = composeContextProviders(tenantContextProvider);
    expect(provider.getTenantId()).toBeUndefined();
    expect(provider.getUserId()).toBeUndefined();
    expect(provider.getCorrelationId()).toBeUndefined();
    expect(provider.getTraceId()).toBeUndefined();
    expect(provider.getSpanId()).toBeUndefined();
  });
});
