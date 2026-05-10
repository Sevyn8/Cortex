/**
 * P1.6 Slice A — Initial flags registration unit tests.
 *
 * Verifies the 4 named build-prompt flags are registered as F04
 * consumer defaults at module-import time (Q-NEW-FF-A-4 eager pattern)
 * + verifies cross-field invariants for variant flags.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resetConsumerRegistry,
  resetSchemaRegistry,
  getConfigConsumer,
} from '@cortex/config-plane';
import {
  INITIAL_FLAGS,
  registerInitialFeatureFlags,
  assertVariantConsistent,
  FEATURE_FLAGS_NAMESPACE,
  type FeatureFlagsNamespace,
} from '../src/index.js';

describe('INITIAL_FLAGS — 4 named build-prompt flags', () => {
  it('registers admin-console.display-data-workspace-switcher as a percentage flag', () => {
    const flag = INITIAL_FLAGS['admin-console.display-data-workspace-switcher'];
    expect(flag).toBeDefined();
    expect(flag!.type).toBe('percentage');
  });

  it('registers analytical.cx-dd-01-beta as a boolean flag', () => {
    const flag = INITIAL_FLAGS['analytical.cx-dd-01-beta'];
    expect(flag).toBeDefined();
    expect(flag!.type).toBe('boolean');
  });

  it('registers agents.planogram.v2-model as a variant flag', () => {
    const flag = INITIAL_FLAGS['agents.planogram.v2-model'];
    expect(flag).toBeDefined();
    expect(flag!.type).toBe('variant');
  });

  it('registers ingestion.csv-agent-v2 as a variant flag', () => {
    const flag = INITIAL_FLAGS['ingestion.csv-agent-v2'];
    expect(flag).toBeDefined();
    expect(flag!.type).toBe('variant');
  });

  it('all variant flags satisfy the variants-include-default invariant', () => {
    for (const [, flag] of Object.entries(INITIAL_FLAGS)) {
      if (flag.type === 'variant') {
        // Discriminated union narrows `flag` to VariantFlag here.
        expect(() => assertVariantConsistent(flag)).not.toThrow();
      }
    }
  });
});

describe('registerInitialFeatureFlags — eager registration helper', () => {
  beforeEach(() => {
    resetConsumerRegistry();
    resetSchemaRegistry();
  });

  afterEach(() => {
    resetConsumerRegistry();
    resetSchemaRegistry();
  });

  it('registers the consumer with INITIAL_FLAGS as defaultValue', () => {
    registerInitialFeatureFlags();
    const consumer = getConfigConsumer<FeatureFlagsNamespace>(FEATURE_FLAGS_NAMESPACE);
    expect(consumer).toBeDefined();
    expect(consumer!.defaultValue).toEqual(INITIAL_FLAGS);
  });

  it('all 4 named flags are present in the registered defaultValue', () => {
    registerInitialFeatureFlags();
    const consumer = getConfigConsumer<FeatureFlagsNamespace>(FEATURE_FLAGS_NAMESPACE);
    const flagKeys = Object.keys(consumer!.defaultValue!);
    expect(flagKeys).toContain('admin-console.display-data-workspace-switcher');
    expect(flagKeys).toContain('analytical.cx-dd-01-beta');
    expect(flagKeys).toContain('agents.planogram.v2-model');
    expect(flagKeys).toContain('ingestion.csv-agent-v2');
    expect(flagKeys).toHaveLength(4);
  });
});
