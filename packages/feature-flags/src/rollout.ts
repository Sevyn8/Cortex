/**
 * P1.6 Slice A — Percentage-rollout hash helper.
 *
 * Per Q-NEW-FF-A-2 lock: SHA-256(`${userId}:${flagKey}`) → first 4
 * bytes interpreted as uint32 → modulo 100 → bucket [0, 99].
 *
 * Properties:
 *   - **Deterministic.** Same `(userId, flagKey)` always returns same
 *     bucket — stable assignment across calls + across deployments
 *     (no salt; salt would break determinism on config promote).
 *   - **Cross-flag independent.** A user in bucket 7 for flagA is
 *     independent of their bucket for flagB — the flagKey is part
 *     of the hash input.
 *   - **No tenant_id input.** Tenant-scope is implicit via the row
 *     that owns the flag config; including tenant_id would create
 *     no useful invariant since flags don't cross tenants.
 *
 * No-userId case: callers handle anonymous users at the `eval.ts`
 * layer (returns the flag's `default`); this helper requires both
 * userId + flagKey.
 *
 * P1.6 Slice A is the first crypto-hash consumer in the workspace
 * (no prior `createHash('sha256')` usage in production code).
 */

import { createHash } from 'node:crypto';

/**
 * Compute the percentage-rollout bucket [0, 99] for `(userId, flagKey)`.
 *
 * Bucket usage in `eval.ts`:
 *   `bucket < flag.rollout_percentage` → user gets `!flag.default`
 *   `bucket >= flag.rollout_percentage` → user gets `flag.default`
 *
 * E.g., `default: false, rollout_percentage: 25`:
 *   Buckets 0..24 (25% of users) → `!false` = `true` (rollout wave)
 *   Buckets 25..99 → `false` (baseline)
 */
export function rolloutBucket(userId: string, flagKey: string): number {
  if (userId.length === 0) {
    throw new Error('rolloutBucket: userId must not be empty');
  }
  if (flagKey.length === 0) {
    throw new Error('rolloutBucket: flagKey must not be empty');
  }
  const digest = createHash('sha256').update(`${userId}:${flagKey}`).digest();
  // First 4 bytes → uint32 (big-endian) → modulo 100.
  const uint32 = digest.readUInt32BE(0);
  return uint32 % 100;
}
