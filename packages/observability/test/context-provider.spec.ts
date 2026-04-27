import { describe, it, expect } from 'vitest';
import { defaultContextProvider, stubContextProvider } from '../src/context-provider.js';
import { withCorrelationContext } from '../src/correlation-context.js';

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
  // Per roadmap §4.13 (resolved): tenant_id is NOT auto-resolved by
  // observability's default provider. Apps wanting tenant_id in log
  // fields compose `tenantContextProvider` from `@cortex/tenant-context`
  // via `composeContextProviders`. The integration is exercised in
  // `packages/tenant-context/test/compose-with-observability.spec.ts`.
  it('always returns undefined — observability is decoupled from tenant-context', () => {
    expect(defaultContextProvider.getTenantId()).toBeUndefined();
  });
});

describe('defaultContextProvider — getUserId', () => {
  // AC01 stub. Wired in P2.1.
  it('returns undefined (AC01 stub)', () => {
    expect(defaultContextProvider.getUserId()).toBeUndefined();
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
