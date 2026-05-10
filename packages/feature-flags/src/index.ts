/**
 * `@cortex/feature-flags` — P1.6 Feature Flags service.
 *
 * Built as a thin consumer of F04 Configuration Plane per F04 D6 lock.
 * Flag definitions live in F04's `tenant_config_version` substrate
 * under namespace `feature-flags` (tier-prefixed `tenant.feature-flags`
 * and `platform.feature-flags`); P1.6 ships the evaluation logic +
 * percentage-rollout hash + per-key tier-walk merge + own LRU cache.
 *
 * Slice A surface:
 *   - `isEnabled(client, tenantId, { flagKey, userId? })` — boolean
 *     evaluation supporting boolean / variant / percentage flag types.
 *   - `getVariant(client, tenantId, { flagKey, userId? })` — variant
 *     evaluation; returns `null` for non-variant or unknown flags.
 *   - `INITIAL_FLAGS` + eager top-level registration of 4 named
 *     build-prompt flags (admin-console.display-data-workspace-switcher,
 *     analytical.cx-dd-01-beta, agents.planogram.v2-model,
 *     ingestion.csv-agent-v2).
 *
 * Slice B (next) ships the non-React client shim. Slice C ships the
 * Admin UI stub + module wrap-up.
 *
 * Importing this module triggers `registerInitialFeatureFlags()` as
 * a top-level side effect (Q-NEW-FF-A-4) — same pattern as F03 Slice
 * C's `scd-policy.ts`.
 *
 * Reference: `docs/planning/p1.6-feature-flags-scope.md` (D1-D8 locks);
 * `docs/planning/feature-flags-slice-A-scope.md` (Slice A specifics).
 */

// Top-level side-effect import — registers the 4 initial flags with
// F04's consumer registry on module load (Q-NEW-FF-A-4 eager pattern).
import './initial-flags.js';

// Eval surface (Slice A's load-bearing API per Q-NEW-FF-A-3 + A-6).
// `evaluateAllFlags` is Slice B's bulk-fetch primitive (Q-NEW-FF-B-2).
export {
  isEnabled,
  getVariant,
  evaluateAllFlags,
  type EvalParams,
  type FlagEvaluation,
} from './eval.js';

// Registration surface — schemas + consumer-registry helper. Most
// consumers import only the eval surface; schemas are exposed for
// callers that want to validate flag-config JSON manually OR for
// tests that need to register custom flag-sets.
export {
  BooleanFlagSchema,
  VariantFlagSchema,
  PercentageFlagSchema,
  FlagDefinitionSchema,
  FeatureFlagsNamespaceSchema,
  registerFeatureFlagsConsumer,
  assertVariantConsistent,
  FEATURE_FLAGS_NAMESPACE,
  FEATURE_FLAGS_SCHEMA_VERSION,
  FEATURE_FLAGS_TTL_SECONDS,
  type BooleanFlag,
  type VariantFlag,
  type PercentageFlag,
  type FlagDefinition,
  type FeatureFlagsNamespace,
} from './registration.js';

// Initial-flags surface — exposed for tests + consumers that want to
// inspect the 4 named build-prompt flags.
export { INITIAL_FLAGS, registerInitialFeatureFlags } from './initial-flags.js';

// Rollout surface — pure helper exposed for tests + bespoke callers
// that want bucket logic without `isEnabled`.
export { rolloutBucket } from './rollout.js';

// Slice B — non-React client shim (Q-NEW-FF-B-1 lock (e); calls
// the `apps/feature-flags-api` HTTP endpoint via configurable fetch
// + polls + diff-notifies subscribers).
export {
  createFeatureFlagsClient,
  type FeatureFlagsClient,
  type FeatureFlagsClientOptions,
  type FlagSubscriber,
} from './client.js';

// Cache primitives — exposed for advanced callers + tests. Most
// consumers should rely on `isEnabled` / `getVariant` and let the
// cache work transparently; the raw cache surface is for instrumentation
// + test assertions.
export {
  flagsCacheGet,
  flagsCacheSet,
  flagsCacheInvalidate,
  flagsCacheClear,
  flagsCacheSize,
  setFlagsCacheMaxEntries,
} from './cache.js';
