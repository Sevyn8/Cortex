import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIER_QUOTAS,
  RESOURCE_CLASSES,
  WINDOW_BY_RESOURCE_CLASS,
  type QuotaTier,
  type ResourceClass,
} from '../src/index.js';

// ─────────────────────────────────────────────────────────────────────
// Compile-time helper: assert two types are equal. Forces TS to surface
// any divergence in the type-system shape; failure is a typecheck error,
// not a runtime failure. (Duplicated from @cortex/encryption test
// pattern — extract to a shared util when a third spec needs it; below
// the WET-cost threshold.)
// ─────────────────────────────────────────────────────────────────────

type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

describe('RESOURCE_CLASSES const tuple', () => {
  it('has exactly 4 entries in the documented order', () => {
    expect(RESOURCE_CLASSES).toHaveLength(4);
    expect(RESOURCE_CLASSES).toEqual([
      'api_calls_per_minute',
      'db_connections',
      'cpu_seconds',
      'ram_mb',
    ]);
  });
});

describe('ResourceClass literal-union derivation', () => {
  it("equals the literal union 'api_calls_per_minute' | 'db_connections' | 'cpu_seconds' | 'ram_mb'", () => {
    // Compile-time witness — failure is a tsc error. Adding an entry
    // to RESOURCE_CLASSES extends this union automatically.
    const _check: Equals<
      ResourceClass,
      'api_calls_per_minute' | 'db_connections' | 'cpu_seconds' | 'ram_mb'
    > = true;
    expect(_check).toBe(true);
  });
});

describe('DEFAULT_TIER_QUOTAS shape', () => {
  it('STANDARD has all 4 resource classes with positive bigint values', () => {
    for (const cls of RESOURCE_CLASSES) {
      const v = DEFAULT_TIER_QUOTAS.STANDARD[cls];
      expect(typeof v).toBe('bigint');
      expect(v).toBeGreaterThan(0n);
    }
  });

  it('ENTERPRISE values are strictly greater than STANDARD per class', () => {
    for (const cls of RESOURCE_CLASSES) {
      const std = DEFAULT_TIER_QUOTAS.STANDARD[cls];
      const ent = DEFAULT_TIER_QUOTAS.ENTERPRISE[cls];
      expect(typeof std).toBe('bigint');
      expect(typeof ent).toBe('bigint');
      expect(ent).toBeGreaterThan(std);
    }
  });
});

describe('WINDOW_BY_RESOURCE_CLASS shape', () => {
  it('has entries for all 4 resource classes with correct alignment + duration', () => {
    expect(Object.keys(WINDOW_BY_RESOURCE_CLASS).sort()).toEqual([...RESOURCE_CLASSES].sort());

    expect(WINDOW_BY_RESOURCE_CLASS.api_calls_per_minute.alignment).toBe('minute');
    expect(WINDOW_BY_RESOURCE_CLASS.api_calls_per_minute.durationSeconds).toBe(60);

    expect(WINDOW_BY_RESOURCE_CLASS.db_connections.alignment).toBe('minute');
    expect(WINDOW_BY_RESOURCE_CLASS.db_connections.durationSeconds).toBe(60);

    expect(WINDOW_BY_RESOURCE_CLASS.cpu_seconds.alignment).toBe('hour');
    expect(WINDOW_BY_RESOURCE_CLASS.cpu_seconds.durationSeconds).toBe(3600);

    expect(WINDOW_BY_RESOURCE_CLASS.ram_mb.alignment).toBe('hour');
    expect(WINDOW_BY_RESOURCE_CLASS.ram_mb.durationSeconds).toBe(3600);
  });
});

describe('QuotaTier literal-union', () => {
  it("equals 'STANDARD' | 'ENTERPRISE'", () => {
    const _check: Equals<QuotaTier, 'STANDARD' | 'ENTERPRISE'> = true;
    expect(_check).toBe(true);
  });
});
