/**
 * Audit-action catalog for `@cortex/encryption`.
 *
 * Owned by this package per planning-doc Decision 4 (catalog-ownership
 * rule). Encryption-specific actions live here; cross-module action
 * sharing is a code smell — surface as a roadmap item rather than
 * extending another module's catalog.
 *
 * Lives in its own module (separate from `encrypt.ts`) so that test
 * files mocking `encrypt.ts` via `vi.mock(...)` don't trip over a
 * top-level `registerAuditActions(...)` call before
 * `@cortex/audit-events`'s exports are initialized. Vitest hoists
 * `vi.mock` factories before module evaluation; pure re-export modules
 * are safe targets, modules with side-effecting top-level calls are
 * not. The split mirrors `@cortex/tenant-context/src/audit-actions.ts`
 * established in P0.10 sub-phase 7.
 *
 * The `registerAuditActions` call validates names + verbs at module
 * load. Adding an entry without an `as const` literal will fail
 * typecheck due to const-generic literal-narrowing in the helper.
 *
 * Convention pointer: per ADR-AU-001 Decision 3, verb `CREATE` may
 * apply to derivative artifacts — the encrypted payload itself is
 * being created, even if the underlying PII existed before encryption.
 */

import { registerAuditActions } from '@cortex/audit-events';

export const ENCRYPTION_AUDIT_ACTIONS = registerAuditActions([
  { name: 'PII_ENCRYPTED', verb: 'CREATE' },
  { name: 'PII_DECRYPTED', verb: 'READ' },
] as const);

/**
 * Literal-union of registered encryption-action names. Derived from
 * the catalog so adding an entry to `ENCRYPTION_AUDIT_ACTIONS` extends
 * this type automatically.
 */
export type EncryptionAuditAction = (typeof ENCRYPTION_AUDIT_ACTIONS)[number]['name'];
