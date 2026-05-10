/**
 * P1.6 Slice A — `rolloutBucket` unit tests.
 *
 * Pure-function tests; no DB needed. Verify determinism, distribution
 * uniformity, edge cases.
 */

import { describe, expect, it } from 'vitest';
import { rolloutBucket } from '../src/rollout.js';

describe('rolloutBucket — SHA-256 percentage hash', () => {
  it('returns a bucket in [0, 99]', () => {
    const bucket = rolloutBucket('user-1', 'flag-a');
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThanOrEqual(99);
  });

  it('is deterministic — same (userId, flagKey) returns same bucket across calls', () => {
    const a = rolloutBucket('user-42', 'agents.planogram.v2-model');
    const b = rolloutBucket('user-42', 'agents.planogram.v2-model');
    expect(a).toBe(b);
  });

  it('different flagKeys produce independent buckets for the same userId', () => {
    // Sample 50 flags; verify NOT all the same bucket. Sketchy property
    // (could in principle hit the same bucket but vanishingly unlikely
    // for 50 distinct hashes).
    const buckets = new Set<number>();
    for (let i = 0; i < 50; i++) {
      buckets.add(rolloutBucket('stable-user', `flag-${i}`));
    }
    expect(buckets.size).toBeGreaterThan(1);
  });

  it('different userIds produce independent buckets for the same flagKey', () => {
    const buckets = new Set<number>();
    for (let i = 0; i < 50; i++) {
      buckets.add(rolloutBucket(`user-${i}`, 'agents.planogram.v2-model'));
    }
    expect(buckets.size).toBeGreaterThan(1);
  });

  it('1000-user distribution is roughly uniform across buckets (broad sanity)', () => {
    // 1000 users / 100 buckets = 10 per bucket on average.
    // Allow wide tolerance (no bucket should be empty; no bucket should
    // claim >5% of population). This catches obvious hash failures.
    const counts = new Array<number>(100).fill(0);
    for (let i = 0; i < 1000; i++) {
      const bucket = rolloutBucket(`user-${i}`, 'flag');
      counts[bucket]! += 1;
    }
    const populated = counts.filter((c) => c > 0).length;
    expect(populated).toBeGreaterThan(70); // most buckets should see at least 1
    const max = Math.max(...counts);
    expect(max).toBeLessThan(50); // no single bucket should dominate
  });

  it('throws on empty userId', () => {
    expect(() => rolloutBucket('', 'flag-a')).toThrow(/userId must not be empty/);
  });

  it('throws on empty flagKey', () => {
    expect(() => rolloutBucket('user-1', '')).toThrow(/flagKey must not be empty/);
  });
});
