/**
 * `@cortex/config-plane` — F04 Configuration Plane.
 *
 * The tenant-facing config layer. Every tenant-scoped setting lives
 * here; every configuration change goes through F04. Built on the
 * `tenant_config_version` substrate (reshape landed in migration 0014
 * per F04 Slice A).
 *
 * Slice A (this commit set) ships:
 *   - Storage substrate (tenant_config_version reshape via migration
 *     0014; per-namespace versioning + parent_version_id chain +
 *     schema_version pinning per F04 D1/D2/D12)
 *   - Audit-actions catalog (6 verbs registered; emissions land in
 *     Slice B per D11)
 *   - Zod schema registry (registerNamespaceSchema / getNamespaceSchema
 *     per D12)
 *   - Read API (getConfig — async, single-namespace, no layering, no
 *     caching; layering ships in Slice C per D8)
 *
 * Slice B (next) ships the lifecycle: draft / validate / promote /
 * rollback + audit emissions. Slice C ships layered resolution +
 * caching. Slice D ships impact analysis. Slice E ships git-sync stub
 * + module close.
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
 *
 * Reference: docs/planning/p1.4-f04-configuration-plane-scope.md
 *            docs/planning/f04-slice-A-scope.md (slice-specific scope)
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
