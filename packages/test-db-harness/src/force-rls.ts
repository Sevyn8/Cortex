import type { Pool } from 'pg';

/**
 * Idempotent ALTER TABLE audit_event FORCE ROW LEVEL SECURITY.
 *
 * `audit_event` is owned by `test_user` in the dev container; without
 * FORCE the owner bypasses RLS, which makes "RLS denies unbound writes"
 * tests silently pass. Intentionally NOT paired with an "unforce" — we
 * leave the FORCE state on so parallel test files can rely on the same
 * posture, matching the production runtime (where non-owner SAs are
 * naturally subject to RLS).
 */
export async function forceRlsOnAuditEvent(pool: Pool): Promise<void> {
  await pool.query(`ALTER TABLE audit_event FORCE ROW LEVEL SECURITY`);
}
