/**
 * `@cortex/config-plane` — F04 Configuration Plane.
 *
 * The tenant-facing config layer. Every tenant-scoped setting lives
 * here; every configuration change goes through F04. Built on the
 * `tenant_config_version` substrate (reshape landed in migration 0014
 * per F04 Slice A).
 *
 * Slices shipped through D:
 *   - Slice A: storage substrate (`tenant_config_version` reshape +
 *     6-verb audit catalog + `registerNamespaceSchema` + `getConfig`)
 *   - Slice B: lifecycle helpers (createDraft / updateDraft /
 *     validateDraft / promoteDraft / rollbackVersion / discardDraft)
 *   - Slice C: layered resolution + per-process LRU cache
 *     (`resolveConfig` walks tenant.<ns> → platform.<ns> → registered
 *     default; `registerConfigConsumer` thin wrapper records the
 *     resolver default + TTL; lifecycle invalidates cache on
 *     promote/rollback)
 *   - Slice D: impact analysis + breaking-change blocker
 *     (`analyzeImpact` walks `(current, draft)` JSON diff + intersects
 *     consumer keyPaths + detects schema-version drift; promoteDraft
 *     accepts `confirmBreakingChanges?: true`; `ImpactBlockedError`
 *     carries the report; CONFIG_PROMOTE_BLOCKED audit row commits in
 *     a separate transaction from the rolled-back attempt)
 *
 * Slice E ships git-sync stub + module close.
 *
 * Public API takes the same `Queryable` seam shape as `@cortex/
 * temporal-query` (drizzle's NodePgDatabase, pg.Pool, pg.PoolClient
 * all satisfy it). No direct `pg` import in the public surface.
 *
 * Locks (per docs/planning/p1.4-f04-configuration-plane-scope.md):
 *   D1  reshape tenant_config_version (D1a)
 *   D2  append-only chain with parent_version_id
 *   D11 new package @cortex/config-plane; 6-verb audit catalog
 *   D12 dynamic registerNamespaceSchema with explicit schema_version
 *   D14 per-tenant-only substrate; cross-tenant defaults are in-code
 *       via registerConfigConsumer (Slice C tier 3)
 *
 * Reference: docs/planning/p1.4-f04-configuration-plane-scope.md
 *            docs/planning/f04-slice-A-scope.md (Slice A)
 *            docs/planning/f04-slice-B-scope.md (Slice B)
 *            docs/planning/f04-slice-C-scope.md (Slice C)
 */
export { CONFIG_AUDIT_ACTIONS, type ConfigAuditAction } from './audit-actions.js';
export {
  registerNamespaceSchema,
  getNamespaceSchema,
  getLatestRegisteredVersion,
  resetSchemaRegistry,
  NamespaceSchemaConflictError,
  type RegisteredSchemaEntry,
} from './schema-registry.js';
export { getConfig, NamespaceSchemaNotRegisteredError } from './get-config.js';
export { actorSchema, type Actor } from './types.js';
export {
  createDraft,
  updateDraft,
  validateDraft,
  promoteDraft,
  rollbackVersion,
  discardDraft,
  DraftConcurrencyError,
  DraftNotFoundError,
  SchemaNotRegisteredError,
  PromoteValidationError,
  PromoteConcurrencyError,
  ImpactBlockedError,
  RollbackAtGenesisError,
  RollbackNoVersionError,
  RollbackConcurrencyError,
  type CreateDraftParams,
  type UpdateDraftParams,
  type ValidateDraftParams,
  type ValidateDraftResult,
  type PromoteDraftParams,
  type PromoteDraftResult,
  type RollbackVersionParams,
  type RollbackVersionResult,
  type DiscardDraftParams,
} from './lifecycle.js';

// ──────────────────────────────────────────────────────────────────────
// F04 Slice C — layered resolution + caching
// ──────────────────────────────────────────────────────────────────────

export { resolveConfig, invalidateResolverCache } from './resolve.js';

export {
  registerConfigConsumer,
  getConfigConsumer,
  getImpactEligibleConsumers,
  resetConsumerRegistry,
  DEFAULT_CONSUMER_TTL_SECONDS,
  type RegisterConfigConsumerParams,
  type ConsumerEntry,
  type BreakingChangePolicy,
} from './consumer-registry.js';

// Cache primitives — exposed for advanced callers + tests. Most
// consumers should rely on resolveConfig + invalidateResolverCache;
// the raw cache surface is for instrumentation, test assertions, and
// future Redis swap-in tooling.
export {
  cacheGet,
  cacheSet,
  cacheInvalidate,
  cacheClear,
  cacheSize,
  setCacheMaxEntries,
} from './cache.js';

// ──────────────────────────────────────────────────────────────────────
// F04 Slice D — impact analysis + breaking-change blocker
// ──────────────────────────────────────────────────────────────────────

export {
  analyzeImpact,
  ImpactAnalysisDraftNotFoundError,
  diffJson,
  pathMatchesKeyPath,
  type ImpactReport,
  type AffectedConsumer,
  type BreakingChange,
  type Warning,
  type BreakingChangeKind,
  type DiffChangeKind,
  type JsonDiffEntry,
} from './impact-analysis.js';

export { detectSchemaIncompatibilities, type SchemaDriftFindings } from './schema-drift.js';
