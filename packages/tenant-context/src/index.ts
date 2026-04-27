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
export { bindTenantToDbSession, ensureBoundToTenant } from './db-session.js';

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
