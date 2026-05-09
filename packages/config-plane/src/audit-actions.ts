/**
 * F04 Configuration Plane audit-action catalog. Owned by
 * `@cortex/config-plane` per the catalog-ownership rule (each module
 * owns its own catalog; cross-cutting helpers live in
 * `@cortex/audit-events`).
 *
 * Lives in its own module (separate from any `audit.ts` re-export)
 * so that test files mocking other modules via `vi.mock(...)` don't
 * trip over a top-level `registerAuditActions(...)` call evaluating
 * before the `@cortex/audit-events` module has its exports
 * initialized. Same gotcha that `@cortex/tenant-context/src/audit-
 * actions.ts` solves; precedent applies here.
 *
 * Six verbs locked at HOLD #0 per docs/planning/p1.4-f04-
 * configuration-plane-scope.md D11. Slice A REGISTERS the catalog;
 * Slice B EMITS via the lifecycle paths (createDraft / updateDraft /
 * validateDraft / discardDraft / promoteDraft / rollbackVersion).
 *
 * Note on `TENANT_CONFIG_VERSION_CREATED` coexistence (per
 * Q-NEW-F04A-10 lock): F02's existing `TENANT_CONFIG_VERSION_CREATED`
 * (in `@cortex/tenant-context`'s `TENANT_AUDIT_ACTIONS`) emits at v=1
 * provisioning seed and is a *substrate-bootstrap* event ("system
 * created this tenant's config substrate"). F04's `CONFIG_VERSION_
 * PROMOTED` is a *user-driven* event ("user committed a new config
 * version via the lifecycle"). Different actors, different triggers,
 * different audit contexts — both stay. Slice B does NOT deprecate
 * the F02 event.
 */

import { registerAuditActions } from '@cortex/audit-events';

export const CONFIG_AUDIT_ACTIONS = registerAuditActions([
  // Draft lifecycle (Slice B emits).
  { name: 'CONFIG_DRAFT_CREATED', verb: 'CREATE' },
  { name: 'CONFIG_DRAFT_UPDATED', verb: 'UPDATE' },
  // Validate is a READ (no state mutation captured in audit) per
  // Q-NEW-F04B-5 recommendation — validation outcome lands on the
  // draft row's `validation_state` column; audit captures the
  // *attempt* + outcome metadata, not a state diff.
  { name: 'CONFIG_DRAFT_VALIDATED', verb: 'READ' },
  { name: 'CONFIG_DRAFT_DISCARDED', verb: 'DELETE' },
  // Version-chain events — both CREATE verbs because each promote /
  // rollback materializes a NEW row in tenant_config_version (the
  // append-only chain per D2).
  { name: 'CONFIG_VERSION_PROMOTED', verb: 'CREATE' },
  { name: 'CONFIG_VERSION_ROLLED_BACK', verb: 'CREATE' },
] as const);

/**
 * Literal-union of registered F04 action names. Derived from the
 * catalog so adding an entry to `CONFIG_AUDIT_ACTIONS` extends this
 * type automatically.
 */
export type ConfigAuditAction = (typeof CONFIG_AUDIT_ACTIONS)[number]['name'];
