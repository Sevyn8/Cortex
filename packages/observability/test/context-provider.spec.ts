import { describe, it, expect } from 'vitest';
import { withTenantContext } from '@cortex/tenant-context';
import { defaultContextProvider, stubContextProvider } from '../src/context-provider.js';
import { withCorrelationContext } from '../src/correlation-context.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CORRELATION_ID = 'corr-test-fixed-value';

describe('stubContextProvider', () => {
  it('all five getters return undefined', () => {
    expect(stubContextProvider.getTenantId()).toBeUndefined();
    expect(stubContextProvider.getUserId()).toBeUndefined();
    expect(stubContextProvider.getCorrelationId()).toBeUndefined();
    expect(stubContextProvider.getTraceId()).toBeUndefined();
    expect(stubContextProvider.getSpanId()).toBeUndefined();
  });

  it('is frozen', () => {
    expect(Object.isFrozen(stubContextProvider)).toBe(true);
  });
});

describe('defaultContextProvider — getTenantId', () => {
  it('returns undefined outside any tenant context', () => {
    expect(defaultContextProvider.getTenantId()).toBeUndefined();
  });

  it('returns the bound tenant id inside withTenantContext', async () => {
    await withTenantContext(TENANT_ID, () => {
      expect(defaultContextProvider.getTenantId()).toBe(TENANT_ID);
    });
  });
});

describe('defaultContextProvider — getCorrelationId', () => {
  it('returns undefined outside any correlation context', () => {
    expect(defaultContextProvider.getCorrelationId()).toBeUndefined();
  });

  it('returns the bound correlation id inside withCorrelationContext', async () => {
    await withCorrelationContext(CORRELATION_ID, () => {
      expect(defaultContextProvider.getCorrelationId()).toBe(CORRELATION_ID);
    });
  });
});

describe('defaultContextProvider — trace and span ids', () => {
  it('returns undefined for both when no active span exists', () => {
    expect(defaultContextProvider.getTraceId()).toBeUndefined();
    expect(defaultContextProvider.getSpanId()).toBeUndefined();
  });
});

describe('defaultContextProvider — composition', () => {
  it('exposes tenant_id and correlation_id when both contexts are bound simultaneously', async () => {
    await withTenantContext(TENANT_ID, async () => {
      await withCorrelationContext(CORRELATION_ID, () => {
        expect(defaultContextProvider.getTenantId()).toBe(TENANT_ID);
        expect(defaultContextProvider.getCorrelationId()).toBe(CORRELATION_ID);
      });
    });
  });
});
