/**
 * P1.6 Slice A — Initial flag definitions per build-prompt §P1.6
 * (line 1235-1240) + eager top-level registration per Q-NEW-FF-A-4.
 *
 * Importing `@cortex/feature-flags` triggers `registerFeatureFlagsConsumer(INITIAL_FLAGS)`
 * as a top-level side effect — matches F03 Slice C's `scd-policy.ts`
 * eager-registration precedent + audit-actions module pattern.
 *
 * Tests that call `resetConsumerRegistry()` (from `@cortex/config-plane`)
 * lose this registration and must re-import the module OR call
 * `registerInitialFeatureFlags()` explicitly to re-register.
 *
 * The 4 named flags here ARE the consumer's `defaultValue` in F04's
 * resolver tier 3. They're visible to `isEnabled` / `getVariant`
 * before any tenant or platform config row exists.
 */

import {
  FEATURE_FLAGS_NAMESPACE,
  registerFeatureFlagsConsumer,
  type FeatureFlagsNamespace,
} from './registration.js';

/**
 * The 4 initial flags from build-prompt §P1.6 line 1237-1240.
 * Each flag's type + default chosen to reflect the build-prompt's
 * descriptor:
 *
 *   - `admin-console.display-data-workspace-switcher` ("gradual
 *     rollout") → `percentage` flag, `default: false`,
 *     `rollout_percentage: 0` — operator bumps up via F04 promote.
 *   - `analytical.cx-dd-01-beta` ("start as beta for Display Data
 *     workspaces") → `boolean` flag, `default: false` — operator
 *     flips to `true` when ready.
 *   - `agents.planogram.v2-model` ("model version rollout"; A02
 *     champion/challenger consumer per build-prompt §3316) →
 *     `variant` flag, variants `['v1', 'v2']`, `default: 'v1'`
 *     (champion) — operator flips to `'v2'` when challenger
 *     promotes.
 *   - `ingestion.csv-agent-v2` ("CSV agent version control") →
 *     `variant` flag, variants `['v1', 'v2']`, `default: 'v1'`.
 */
export const INITIAL_FLAGS: FeatureFlagsNamespace = {
  'admin-console.display-data-workspace-switcher': {
    type: 'percentage',
    description: 'Display Data workspace switcher in admin console (gradual rollout).',
    rollout_percentage: 0,
    default: false,
  },
  'analytical.cx-dd-01-beta': {
    type: 'boolean',
    description: 'CX Display Data v1 beta — promote when ready for general availability.',
    default: false,
  },
  'agents.planogram.v2-model': {
    type: 'variant',
    description: 'Planogram agent model version (champion=v1, challenger=v2).',
    variants: ['v1', 'v2'],
    default: 'v1',
  },
  'ingestion.csv-agent-v2': {
    type: 'variant',
    description: 'CSV agent version control (champion=v1, challenger=v2).',
    variants: ['v1', 'v2'],
    default: 'v1',
  },
};

/**
 * Register the 4 initial flags as F04 consumer defaults. Called
 * automatically as a top-level side effect when `@cortex/feature-flags`
 * is imported. Tests that called `resetConsumerRegistry()` from
 * `@cortex/config-plane` must call this to re-register.
 */
export function registerInitialFeatureFlags(): void {
  registerFeatureFlagsConsumer(INITIAL_FLAGS);
}

// Top-level side effect: register the 4 initial flags. Same pattern
// as F03 Slice C `scd-policy.ts:177` and `@cortex/config-plane/src/audit-actions.ts`.
registerInitialFeatureFlags();

// Re-export the namespace constant so callers consuming `@cortex/feature-flags`
// can reference it without reaching into `registration.ts`.
export { FEATURE_FLAGS_NAMESPACE };
