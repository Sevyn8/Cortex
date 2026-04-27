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
  // Slice A (initial; pre-F02)
  { name: 'TENANT_CREATED', verb: 'CREATE' },
  { name: 'TENANT_UPDATED', verb: 'UPDATE' },
  { name: 'TENANT_STATUS_CHANGED', verb: 'UPDATE' },
  { name: 'TENANT_CONFIG_VERSION_CREATED', verb: 'CREATE' },
  { name: 'TENANT_KMS_KEY_BOUND', verb: 'CREATE' },
  // F02 lifecycle additions per planning-doc D6 (hybrid catalog).
  // Asymmetric suspend/resume per Slice B SB1 lock + convention §5:
  //   - suspend uses TENANT_SUSPENDED (cascade-event handle for
  //     AC01/S15/S17 push-style subscribers — the new domain action
  //     gives consumers a clean filter target without parsing
  //     after_state.status).
  //   - resume uses TENANT_STATUS_CHANGED (reversible inverse, no
  //     cascade subscribers; one STATUS_CHANGED row reads cleanly).
  // Other domain actions cover irreversible / compliance events.
  { name: 'TENANT_PROVISIONED', verb: 'CREATE' },
  { name: 'TENANT_SUSPENDED', verb: 'UPDATE' },
  { name: 'TENANT_OFFBOARDING_STARTED', verb: 'UPDATE' },
  { name: 'TENANT_TERMINATED', verb: 'DELETE' },
  { name: 'TENANT_KEY_ROTATED', verb: 'UPDATE' },
  { name: 'TENANT_CONFIG_VERSION_UPDATED', verb: 'UPDATE' },
] as const);

/**
 * Literal-union of registered tenant-lifecycle action names. Derived
 * from the catalog so adding an entry to `TENANT_AUDIT_ACTIONS`
 * extends this type automatically.
 */
export type TenantAuditAction = (typeof TENANT_AUDIT_ACTIONS)[number]['name'];
