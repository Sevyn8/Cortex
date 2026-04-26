/**
 * Public barrel for `@cortex/audit-events`.
 *
 * Test-only escape hatches (`__setEmitterForTesting`,
 * `__resetForTesting`) ARE re-exported here — they're conventionally
 * accessed by consuming packages' tests for in-test emitter swapping,
 * mirroring the pattern in `@cortex/secrets/audit`,
 * `@cortex/bootstrap`, and `@cortex/observability`.
 *
 * No subpath exports yet. `LogCapture` from
 * `@cortex/observability/test-utils` is the only test-helper module
 * downstream consumers need; we don't ship our own.
 */

// Errors + envelope
export {
  AuditEventError,
  AuditEventValidationError,
  AuditEventEmissionError,
  AuditEventConfigError,
  toAuditEventErrorEnvelope,
  type AuditEventErrorCode,
  type AuditEventErrorEnvelope,
} from './errors.js';

// Types + branded action + discriminated params
export {
  AUDIT_ACTION_NAME_REGEX,
  SOFT_PAYLOAD_LIMIT_BYTES,
  type ActorType,
  type AuditAction,
  type AuditActionName,
  type AuditEventCommon,
  type AuditEventParams,
  type CrudVerb,
  type JsonObject,
  type JsonValue,
} from './types.js';

// Schemas — exposed for callers wanting direct parse access
export {
  auditEventApproveSchema,
  auditEventCreateSchema,
  auditEventDeleteSchema,
  auditEventExecuteSchema,
  auditEventParamsSchema,
  auditEventReadSchema,
  auditEventRejectSchema,
  auditEventUpdateSchema,
  jsonObjectSchema,
  jsonValueSchema,
} from './schemas.js';

// Canonicalization helpers
export {
  canonicalizeJsonValue,
  checkPayloadSize,
  isoMicrosecondString,
  type PayloadSizeReport,
} from './canonicalize.js';

// Emitter — factory + default + convenience + test escapes
export {
  createAuditEventEmitter,
  emitAuditEvent,
  __setEmitterForTesting,
  __resetForTesting,
  type AuditEventEmitter,
  type CreateAuditEventEmitterOptions,
} from './emit.js';

// Catalog — registration + lookup + brand convenience
export {
  asAuditActionName,
  getActionByName,
  isRegisteredActionName,
  registerAuditActions,
  type AuditActionDescriptor,
} from './catalog.js';
