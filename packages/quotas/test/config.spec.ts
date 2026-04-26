import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIER_QUOTAS,
  RESOURCE_CLASSES,
  getQuotaConfig,
  type QuotaTier,
} from '../src/index.js';

const TIERS: readonly QuotaTier[] = ['STANDARD', 'ENTERPRISE'];

describe('getQuotaConfig — per-tier lookup', () => {
  it('STANDARD returns DEFAULT_TIER_QUOTAS.STANDARD values for each resource class', () => {
    for (const cls of RESOURCE_CLASSES) {
      expect(getQuotaConfig('STANDARD', cls)).toBe(DEFAULT_TIER_QUOTAS.STANDARD[cls]);
    }
  });

  it('ENTERPRISE returns DEFAULT_TIER_QUOTAS.ENTERPRISE values for each resource class', () => {
    for (const cls of RESOURCE_CLASSES) {
      expect(getQuotaConfig('ENTERPRISE', cls)).toBe(DEFAULT_TIER_QUOTAS.ENTERPRISE[cls]);
    }
  });

  it('return type is bigint (not number, not string) for every (tier, class) pair', () => {
    for (const tier of TIERS) {
      for (const cls of RESOURCE_CLASSES) {
        const value = getQuotaConfig(tier, cls);
        expect(typeof value).toBe('bigint');
      }
    }
  });
});

describe('getQuotaConfig vs DEFAULT_TIER_QUOTAS — table consistency', () => {
  it('every (tier, class) lookup matches the table verbatim — F02 swap regression guard', () => {
    // If F02 swaps getQuotaConfig to consult tenant_config_version
    // with fallback to DEFAULT_TIER_QUOTAS, this test ensures the
    // Phase 1 fallback values stay aligned with the table. Drift
    // here means the F02 implementation accidentally changed the
    // fallback semantics — the audit-doc Decision 7 "defaults are a
    // floor, not a target" framing is violated.
    for (const tier of TIERS) {
      for (const cls of RESOURCE_CLASSES) {
        expect(getQuotaConfig(tier, cls)).toBe(DEFAULT_TIER_QUOTAS[tier][cls]);
      }
    }
  });
});
