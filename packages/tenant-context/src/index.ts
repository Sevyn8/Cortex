// Errors
export {
  TenantContextError,
  TenantContextMissingError,
  TenantNotFoundError,
  TenantStatusError,
  TenantValidationError,
} from './errors.js';
export type { TenantContextErrorCode } from './errors.js';

// Public types
export type {
  AuditAction,
  TenantContextSnapshot,
  TenantStatus,
  TenantSummary,
  TenantTier,
} from './types.js';

// Async-local context
export {
  getTenantId,
  getTenantOrThrow,
  withTenantContext,
  withoutTenantContext,
} from './context.js';

// DB session binding
export { bindTenantToDbSession, ensureBoundToTenant } from './db-session.js';

// Audit emission
export { emitAuditEvent } from './audit.js';
export type { AuditParams } from './audit.js';

// Tenant CRUD
export { tenants } from './tenants.js';
export type {
  Actor,
  CreateTenantInput,
  ListTenantsOptions,
  TenantListResult,
  UpdateTenantPatch,
} from './tenants.js';

// HTTP middleware
export { buildTenantContextMiddleware, defaultHeaderExtractor } from './middleware.js';
export type {
  TenantContextMiddleware,
  TenantContextMiddlewareOptions,
  TenantExtractor,
} from './middleware.js';
