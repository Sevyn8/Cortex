/**
 * Public barrel for `@cortex/quotas`.
 *
 * Surface (post sub-phase 4):
 *   - Errors + envelope
 *   - Types (resource classes, tier, window strategy, defaults)
 *   - Schemas (zod validators)
 *   - Catalog (registered action set; mock-safe split per the
 *     `@cortex/encryption` precedent)
 *   - `getQuotaConfig` per-tier defaults helper
 *   - Token-bucket runtime (factory + default + convenience + test escapes)
 *   - HTTP middleware (framework-agnostic core + Hono / Express adapters)
 */

// Errors + envelope
export {
  QuotaError,
  QuotaConfigError,
  QuotaExceededError,
  QuotaExecutionError,
  QuotaValidationError,
  toQuotaErrorEnvelope,
  type QuotaErrorCode,
  type QuotaErrorEnvelope,
} from './errors.js';

// Types
export {
  DEFAULT_TIER_QUOTAS,
  RESOURCE_CLASSES,
  WINDOW_BY_RESOURCE_CLASS,
  type CheckQuotaParams,
  type CheckQuotaResult,
  type QuotaConfig,
  type QuotaTier,
  type QuotaWindow,
  type ResourceClass,
  type WindowAlignment,
} from './types.js';

// Schemas — exposed for callers wanting direct parse access
export { checkQuotaParamsSchema, quotaTierSchema, resourceClassSchema } from './schemas.js';

// Catalog — registered action set
export { QUOTA_AUDIT_ACTIONS, type QuotaAuditAction } from './catalog.js';

// Per-tier defaults
export { getQuotaConfig } from './config.js';

// Token-bucket runtime — factory + default + convenience + test escapes
export {
  checkQuota,
  createQuotaChecker,
  __setCheckerForTesting,
  __resetForTesting,
  type CheckQuota,
  type CheckQuotaCallOptions,
  type CreateQuotaCheckerOptions,
} from './check-quota.js';

// HTTP middleware — framework-agnostic core + Hono / Express adapters
export {
  buildQuotaMiddlewareCore,
  expressQuotaMiddleware,
  honoQuotaMiddleware,
  type QuotaCheckOutcome,
  type QuotaMiddlewareCore,
  type QuotaMiddlewareOptions,
} from './middleware.js';
