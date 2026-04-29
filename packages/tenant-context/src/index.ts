// Errors
export {
  TenantContextError,
  TenantContextMissingError,
  TenantGraceNotElapsedError,
  TenantLegalHoldError,
  TenantNotFoundError,
  TenantRotationCooldownError,
  TenantStatusError,
  TenantValidationError,
} from './errors.js';
export type { TenantContextErrorCode } from './errors.js';

// Public types
export type { TenantContextSnapshot, TenantStatus, TenantSummary, TenantTier } from './types.js';

// Async-local context
export {
  getTenantId,
  getTenantOrThrow,
  withTenantContext,
  withoutTenantContext,
} from './context.js';

// Observability composition adapter (see roadmap §4.13).
export { tenantContextProvider } from './context-provider.js';

// DB session binding
export { bindTenantToDbSession, ensureBoundToTenant, withTenantDbClient } from './db-session.js';

// Audit emission — thin facade over @cortex/audit-events.
export { emitAuditEvent } from './audit.js';
export { TENANT_AUDIT_ACTIONS } from './audit-actions.js';
export type { TenantAuditAction } from './audit-actions.js';

// Tenant CRUD
export { tenants } from './tenants.js';
export type {
  Actor,
  CreateTenantInput,
  ListTenantsOptions,
  OffboardOptions,
  OffboardResult,
  TenantListResult,
  TerminateOptions,
  UpdateTenantPatch,
} from './tenants.js';

// F02 lifecycle worker (Slice A — provisioning).
export { cleanupFailedProvisioning, provisioningWorker } from './provisioning-worker.js';
export type { ProvisioningTaskPayload } from './provisioning-worker.js';

// F02 Slice C — export archive utility (consumed by `tenants.offboard`;
// callers may also use directly for ad-hoc operator exports).
export { generateExportArchive, EXPORT_ARCHIVE_SCHEMA_VERSION } from './export-archive.js';
export type {
  ExportArchive,
  ExportArchiveEntityType,
  GenerateExportArchiveOptions,
} from './export-archive.js';

// F02 Slice C sub-phase 7.5 — legal-hold helpers (consumed by ops
// runbooks + future compliance UIs; callers use this surface to set/
// release holds independent of `tenants.terminate`'s in-line check).
export { legalHolds } from './legal-holds.js';
export type { SetHoldOptions, ReleaseHoldOptions } from './legal-holds.js';

// HTTP middleware
export { buildTenantContextMiddleware, defaultHeaderExtractor } from './middleware.js';
export type {
  TenantContextMiddleware,
  TenantContextMiddlewareOptions,
  TenantExtractor,
} from './middleware.js';
