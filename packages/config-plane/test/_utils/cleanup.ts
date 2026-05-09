/**
 * Test-only FK-safe cleanup chain for config-plane state tied to a
 * tenant. Centralized here so config-draft-constraints.spec.ts +
 * lifecycle.spec.ts (and Slice B's forthcoming rollback.spec.ts)
 * don't drift in their cleanup ordering.
 *
 * Order matters because of FK chains:
 *   audit_event           — no FK to other config-plane tables; cleanup first.
 *   config_draft          — FK to tenant_config_version is `ON DELETE
 *                           SET NULL` (defense in depth) so order
 *                           doesn't strictly matter, BUT cleaning
 *                           drafts before versions keeps the FK
 *                           reference clean for any concurrent
 *                           reader observing the cleanup window.
 *   tenant_config_version — FK to tenant is `ON DELETE RESTRICT`;
 *                           must clean before tenant DELETE if the
 *                           caller plans to drop the tenant too.
 *
 * `tenant` itself is NOT cleaned by this helper — most callers
 * preserve the test tenant across tests in the same suite. afterAll
 * in each spec is the right place to DELETE the tenant row.
 */

import type { Pool } from 'pg';

export async function cleanupConfigPlaneState(pool: Pool, tenantId: string): Promise<void> {
  await pool
    .query(`DELETE FROM audit_event WHERE tenant_id = $1`, [tenantId])
    .catch(() => undefined);
  await pool.query(`DELETE FROM config_draft WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM tenant_config_version WHERE tenant_id = $1`, [tenantId]);
}
