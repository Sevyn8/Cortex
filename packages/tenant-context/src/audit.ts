/**
 * Audit event emission for `@cortex/tenant-context`.
 *
 * As of P0.10 sub-phase 7, this module is a thin re-export of
 * `@cortex/audit-events`'s `emitAuditEvent`. The tenant-lifecycle
 * action catalog (`TENANT_AUDIT_ACTIONS`) lives in `./audit-actions.ts`
 * — see that file's header for the rationale on the split.
 *
 * Caller contract — bound tenant on DB session, open transaction —
 * unchanged. The library overwrites `occurred_at` with
 * `clock_timestamp()` per planning-doc Decision 11 to guarantee strict
 * ordering of same-transaction sequential emits.
 *
 * Validation errors now surface as `AuditEventValidationError` (not the
 * historical `TenantValidationError`); RLS / DB failures as
 * `AuditEventEmissionError` (was raw pg error). Callers that catch
 * audit-emission errors should narrow on those types.
 */

export { emitAuditEvent } from '@cortex/audit-events';
