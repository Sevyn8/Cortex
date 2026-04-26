/**
 * Tenant-lifecycle audit-action catalog. Owned by `@cortex/tenant-context`
 * (per planning-doc Decision 4 catalog-ownership rule). Actions outside
 * this set belong to other modules' catalogs — surface as a roadmap entry
 * rather than extending here.
 *
 * Lives in its own module (separate from `audit.ts`) so that test files
 * mocking `audit.ts` via `vi.mock(...)` don't trip over a top-level
 * `registerAuditActions(...)` call evaluating before the
 * `@cortex/audit-events` module has its exports initialized. Vitest
 * hoists `vi.mock` factories above transitive workspace-dep
 * initialization; keeping audit.ts as a pure re-export module avoids
 * the race.
 */

import { registerAuditActions } from '@cortex/audit-events';

export const TENANT_AUDIT_ACTIONS = registerAuditActions([
  { name: 'TENANT_CREATED', verb: 'CREATE' },
  { name: 'TENANT_UPDATED', verb: 'UPDATE' },
  { name: 'TENANT_STATUS_CHANGED', verb: 'UPDATE' },
  { name: 'TENANT_CONFIG_VERSION_CREATED', verb: 'CREATE' },
] as const);

/**
 * Literal-union of registered tenant-lifecycle action names. Derived
 * from the catalog so adding an entry to `TENANT_AUDIT_ACTIONS`
 * extends this type automatically.
 */
export type TenantAuditAction = (typeof TENANT_AUDIT_ACTIONS)[number]['name'];
