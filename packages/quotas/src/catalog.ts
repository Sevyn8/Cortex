/**
 * Audit-action catalog for `@cortex/quotas`.
 *
 * Owned by this package per planning-doc Decision 1 (catalog-ownership
 * rule). Quota-specific actions live here; cross-module action sharing
 * is a code smell — surface as a roadmap item rather than extending
 * another module's catalog.
 *
 * Lives in its own module (separate from `check-quota.ts`) so that test
 * files mocking `check-quota.ts` via `vi.mock(...)` don't trip over a
 * top-level `registerAuditActions(...)` call. Same split pattern as
 * `@cortex/encryption/src/catalog.ts` and
 * `@cortex/tenant-context/src/audit-actions.ts`.
 *
 * Convention pointer: per ADR-AU-001 Decision 3, verb `REJECT` covers
 * BOTH workflow-style rejections (e.g., approval-flow rejections) AND
 * throughput-style rejections (e.g., quota / rate-limit /
 * circuit-breaker). Audit consumers querying for REJECT events must
 * filter by action name to disambiguate: `QUOTA_EXCEEDED` is throughput;
 * future `*_REJECTED` actions from F02-onward workflows are workflow.
 */

import { registerAuditActions } from '@cortex/audit-events';

export const QUOTA_AUDIT_ACTIONS = registerAuditActions([
  { name: 'QUOTA_EXCEEDED', verb: 'REJECT' },
] as const);

/**
 * Literal-union of registered quota-action names. Derived from the
 * catalog so adding an entry to `QUOTA_AUDIT_ACTIONS` extends this
 * type automatically.
 */
export type QuotaAuditAction = (typeof QUOTA_AUDIT_ACTIONS)[number]['name'];
