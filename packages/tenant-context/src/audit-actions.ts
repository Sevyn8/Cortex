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
  // F02 Slice C sub-phase 7.5 additions per SC2 + SC3 + Q-NEW-C12 locks.
  // TENANT_FORCE_TERMINATED is a distinct compliance event from
  // TENANT_TERMINATED (Option B per SC2): regulators querying "any
  // tenant terminated despite an active hold or before grace elapsed"
  // get an unambiguous filter handle without parsing payload.forced
  // metadata.
  // LEGAL_HOLD_SET / LEGAL_HOLD_RELEASED are the legal-hold lifecycle
  // domain actions per SC3. Compliance teams filter on these to audit
  // hold-set/release events independently of tenant-lifecycle events.
  // The catalog name prefix departs from TENANT_* — these are
  // legal-hold-domain events, not tenant-lifecycle events. Both
  // domains live in `@cortex/tenant-context` per planning-doc D4.
  { name: 'TENANT_FORCE_TERMINATED', verb: 'DELETE' },
  { name: 'LEGAL_HOLD_SET', verb: 'CREATE' },
  { name: 'LEGAL_HOLD_RELEASED', verb: 'DELETE' },
  // F02 Slice D D.3 — Q-OPEN-6 fold-in. Manual operator approval gate
  // for ENTERPRISE dedicated-DB provisioning. Sets
  // tenant.dedicated_db_approved=true; provisioning worker advances
  // REQUESTED → PROVISIONING only after this flag flips. UPDATE verb
  // (boolean transition false → true; before/after state captures the
  // flip). Caller actor preserved for forensic attribution — operators
  // querying "who approved the dedicated DB for tenant X" filter on
  // this action.
  { name: 'TENANT_DEDICATED_DB_APPROVED', verb: 'UPDATE' },
] as const);

/**
 * Literal-union of registered tenant-lifecycle action names. Derived
 * from the catalog so adding an entry to `TENANT_AUDIT_ACTIONS`
 * extends this type automatically.
 */
export type TenantAuditAction = (typeof TENANT_AUDIT_ACTIONS)[number]['name'];
