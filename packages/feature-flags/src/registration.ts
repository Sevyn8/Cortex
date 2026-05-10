/**
 * P1.6 Slice A — Flag-definition Zod schemas + `registerConfigConsumer`
 * adoption.
 *
 * Per Q-NEW-FF-A-1 lock: three-discriminated-union flag types
 * (`boolean` / `variant` / `percentage`); namespace shape is a record
 * keyed by flag key.
 *
 * Per Q-NEW-FF-A-3 lock: F04 consumer-registry adoption with
 * `feature-flags` namespace + `ttl=30` (criterion 1's 30s propagation
 * requirement); `consumerModule = 'feature-flags'` opts into Slice D
 * impact analysis with `breakingChangePolicy: 'warn'`.
 *
 * Per F04 D6 + Slice E gate-evidence reconciliation: namespace literal
 * is `feature-flags` (hyphenated, matches package name `@cortex/
 * feature-flags`). The `flags.*` form from F04's earlier draft is
 * superseded.
 *
 * Schemas locked at v=1. Future schema bumps follow F04's version-
 * pinning rules (Q-NEW-F04A-2): bump version when shape changes
 * incompatibly; older drafts continue validating against their pinned
 * version.
 */

import { z } from 'zod';
import { registerConfigConsumer } from '@cortex/config-plane';

// ──────────────────────────────────────────────────────────────────────
// Per-type flag schemas (Q-NEW-FF-A-1)
// ──────────────────────────────────────────────────────────────────────

/**
 * Boolean flag — `isEnabled` returns the configured `default` (or
 * the tenant override of `default`). Simplest type; covers the
 * majority of use cases.
 */
export const BooleanFlagSchema = z.object({
  type: z.literal('boolean'),
  description: z.string().min(1),
  default: z.boolean(),
});
export type BooleanFlag = z.infer<typeof BooleanFlagSchema>;

/**
 * Variant flag — `getVariant` returns one of the configured `variants`
 * (the configured `default` in Phase 1 — no per-user assignment until
 * AC01 attribute-based targeting in Phase 2). `isEnabled` on a variant
 * flag is undefined behavior; callers should use `getVariant`. Phase
 * 1 returns `null` from `getVariant` for non-variant flags.
 *
 * Schema-shape only; the cross-field invariant "`variants` MUST include
 * `default`" is enforced at registration time (`assertVariantConsistent`
 * below) rather than via `.refine()` — `z.discriminatedUnion` requires
 * raw `ZodObject` shapes, not `ZodEffects`-wrapped variants.
 */
export const VariantFlagSchema = z.object({
  type: z.literal('variant'),
  description: z.string().min(1),
  variants: z.array(z.string().min(1)).min(2),
  default: z.string().min(1),
});
export type VariantFlag = z.infer<typeof VariantFlagSchema>;

/**
 * Cross-field invariant for variant flags. Called by callers that
 * register a flag definition (e.g., from `initial-flags.ts` or test
 * fixtures) before promoting; `isEnabled` / `getVariant` runtime
 * paths trust the substrate rather than re-asserting on every call.
 */
export function assertVariantConsistent(flag: VariantFlag): void {
  if (!flag.variants.includes(flag.default)) {
    throw new Error(
      `Variant flag default ${JSON.stringify(flag.default)} is not in variants list ` +
        `${JSON.stringify(flag.variants)}.`,
    );
  }
}

/**
 * Percentage flag — `isEnabled` returns `!default` for users whose
 * `(userId, flagKey)` SHA-256 bucket falls below `rollout_percentage`
 * (Q-NEW-FF-A-2). Anonymous calls (`userId === undefined`) return
 * `default` — anonymous users don't participate in gradual rollout.
 *
 * Convention: `rollout_percentage` is the % of users who see the
 * FLIPPED state. `default: false` + `rollout_percentage: 25` →
 * 25% of users see `true`. `default: true` + `rollout_percentage: 25`
 * → 25% of users see `false` (kill-switch pattern).
 */
export const PercentageFlagSchema = z.object({
  type: z.literal('percentage'),
  description: z.string().min(1),
  rollout_percentage: z.number().int().min(0).max(100),
  default: z.boolean(),
});
export type PercentageFlag = z.infer<typeof PercentageFlagSchema>;

/**
 * Discriminated union over the three flag types. Discriminator is
 * `type` (matches F03 Slice C `SCDEntityPolicySchema` precedent).
 */
export const FlagDefinitionSchema = z.discriminatedUnion('type', [
  BooleanFlagSchema,
  VariantFlagSchema,
  PercentageFlagSchema,
]);
export type FlagDefinition = z.infer<typeof FlagDefinitionSchema>;

/**
 * Namespace shape — record from flag-key to its definition.
 * Stored in F04's `tenant_config_version.config_json` at namespace
 * `tenant.feature-flags` (or `platform.feature-flags`).
 *
 * Flag keys follow dotted-namespace convention (e.g.,
 * `admin-console.display-data-workspace-switcher`). No regex
 * enforcement at the substrate level — keys are caller-chosen.
 */
export const FeatureFlagsNamespaceSchema = z.record(z.string(), FlagDefinitionSchema);
export type FeatureFlagsNamespace = z.infer<typeof FeatureFlagsNamespaceSchema>;

// ──────────────────────────────────────────────────────────────────────
// F04 consumer registration (A.3)
// ──────────────────────────────────────────────────────────────────────

/**
 * The logical namespace P1.6 registers with F04. Tier-prefixed at
 * registration time by `registerConfigConsumer` (creates both
 * `tenant.feature-flags` and `platform.feature-flags` schema entries).
 */
export const FEATURE_FLAGS_NAMESPACE = 'feature-flags' as const;

/**
 * Pinned schema version. Bump when the shape changes incompatibly;
 * F04's version-keyed registry isolates older drafts.
 */
export const FEATURE_FLAGS_SCHEMA_VERSION = 1 as const;

/**
 * TTL = 30s per Q-NEW-FF-A-3 / criterion 1's 30s propagation
 * requirement. Sets F04's resolver-cache TTL for this namespace.
 * P1.6's own per-key cache (`eval.ts`) mirrors this TTL — both layers
 * expire within the same window so freshness is bounded by 30s
 * regardless of which cache serves the read.
 */
export const FEATURE_FLAGS_TTL_SECONDS = 30 as const;

/**
 * Idempotent registration helper. `initial-flags.ts` calls this at
 * top-level side-effect time with the 4 named build-prompt flags;
 * tests that reset the consumer registry can call it explicitly with
 * a custom `defaultValue` to scope the consumer's in-code defaults.
 *
 * `defaultValue` populates F04's third resolver tier (consumer
 * default) — flags present in this record are visible to `isEnabled`
 * / `getVariant` even when no tenant or platform config row exists.
 */
export function registerFeatureFlagsConsumer(defaultValue: FeatureFlagsNamespace = {}): void {
  registerConfigConsumer({
    namespace: FEATURE_FLAGS_NAMESPACE,
    schema: FeatureFlagsNamespaceSchema,
    schemaVersion: FEATURE_FLAGS_SCHEMA_VERSION,
    defaultValue,
    ttl: FEATURE_FLAGS_TTL_SECONDS,
    consumerModule: FEATURE_FLAGS_NAMESPACE,
    breakingChangePolicy: 'warn',
  });
}
