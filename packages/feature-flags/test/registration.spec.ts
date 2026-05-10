/**
 * P1.6 Slice A — Zod schema + registration unit tests.
 *
 * Pure-function tests; no DB needed.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  resetConsumerRegistry,
  resetSchemaRegistry,
  getConfigConsumer,
  getNamespaceSchema,
} from '@cortex/config-plane';
import {
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
  type FeatureFlagsNamespace,
} from '../src/index.js';

describe('Zod schemas — flag definitions', () => {
  it('BooleanFlagSchema accepts a valid boolean flag', () => {
    expect(
      BooleanFlagSchema.parse({
        type: 'boolean',
        description: 'Test flag',
        default: false,
      }),
    ).toMatchObject({ type: 'boolean', default: false });
  });

  it('BooleanFlagSchema rejects when description is empty', () => {
    expect(() =>
      BooleanFlagSchema.parse({ type: 'boolean', description: '', default: false }),
    ).toThrow();
  });

  it('VariantFlagSchema accepts a valid variant flag', () => {
    expect(
      VariantFlagSchema.parse({
        type: 'variant',
        description: 'A/B test',
        variants: ['A', 'B'],
        default: 'A',
      }),
    ).toMatchObject({ type: 'variant', variants: ['A', 'B'] });
  });

  it('VariantFlagSchema rejects fewer than 2 variants', () => {
    expect(() =>
      VariantFlagSchema.parse({
        type: 'variant',
        description: 'X',
        variants: ['only'],
        default: 'only',
      }),
    ).toThrow();
  });

  it('PercentageFlagSchema accepts 0-100 rollout percentage', () => {
    expect(
      PercentageFlagSchema.parse({
        type: 'percentage',
        description: 'Gradual',
        rollout_percentage: 25,
        default: false,
      }),
    ).toMatchObject({ rollout_percentage: 25 });
  });

  it('PercentageFlagSchema rejects rollout_percentage outside [0, 100]', () => {
    expect(() =>
      PercentageFlagSchema.parse({
        type: 'percentage',
        description: 'X',
        rollout_percentage: 150,
        default: false,
      }),
    ).toThrow();
  });

  it('FlagDefinitionSchema discriminates by type', () => {
    expect(
      FlagDefinitionSchema.parse({ type: 'boolean', description: 'X', default: true }),
    ).toMatchObject({
      type: 'boolean',
    });
    expect(
      FlagDefinitionSchema.parse({
        type: 'variant',
        description: 'X',
        variants: ['a', 'b'],
        default: 'a',
      }),
    ).toMatchObject({ type: 'variant' });
    expect(
      FlagDefinitionSchema.parse({
        type: 'percentage',
        description: 'X',
        rollout_percentage: 50,
        default: false,
      }),
    ).toMatchObject({ type: 'percentage' });
  });

  it('FeatureFlagsNamespaceSchema accepts a record of flag definitions', () => {
    const ns: FeatureFlagsNamespace = {
      'flag-a': { type: 'boolean', description: 'A', default: false },
      'flag-b': { type: 'variant', description: 'B', variants: ['x', 'y'], default: 'x' },
    };
    expect(FeatureFlagsNamespaceSchema.parse(ns)).toMatchObject(ns);
  });
});

describe('assertVariantConsistent — cross-field invariant', () => {
  it('passes when default is one of the variants', () => {
    expect(() =>
      assertVariantConsistent({
        type: 'variant',
        description: 'X',
        variants: ['A', 'B'],
        default: 'A',
      }),
    ).not.toThrow();
  });

  it('throws when default is not in variants', () => {
    expect(() =>
      assertVariantConsistent({
        type: 'variant',
        description: 'X',
        variants: ['A', 'B'],
        default: 'C',
      }),
    ).toThrow(/default "C" is not in variants list/);
  });
});

describe('registerFeatureFlagsConsumer — F04 consumer adoption', () => {
  afterEach(() => {
    resetConsumerRegistry();
    resetSchemaRegistry();
  });

  it('registers the consumer with the locked namespace + schemaVersion + ttl', () => {
    registerFeatureFlagsConsumer();
    const consumer = getConfigConsumer<FeatureFlagsNamespace>(FEATURE_FLAGS_NAMESPACE);
    expect(consumer).toBeDefined();
    expect(consumer!.namespace).toBe(FEATURE_FLAGS_NAMESPACE);
    expect(consumer!.schemaVersion).toBe(FEATURE_FLAGS_SCHEMA_VERSION);
    expect(consumer!.ttlSeconds).toBe(FEATURE_FLAGS_TTL_SECONDS);
    expect(consumer!.consumerModule).toBe(FEATURE_FLAGS_NAMESPACE);
    expect(consumer!.breakingChangePolicy).toBe('warn');
  });

  it('registers the schema under both tenant.feature-flags AND platform.feature-flags', () => {
    registerFeatureFlagsConsumer();
    expect(
      getNamespaceSchema(`tenant.${FEATURE_FLAGS_NAMESPACE}`, FEATURE_FLAGS_SCHEMA_VERSION),
    ).toBeDefined();
    expect(
      getNamespaceSchema(`platform.${FEATURE_FLAGS_NAMESPACE}`, FEATURE_FLAGS_SCHEMA_VERSION),
    ).toBeDefined();
  });

  it('uses an empty record as defaultValue when none is supplied', () => {
    registerFeatureFlagsConsumer();
    const consumer = getConfigConsumer<FeatureFlagsNamespace>(FEATURE_FLAGS_NAMESPACE);
    expect(consumer!.defaultValue).toEqual({});
  });

  it('accepts a populated defaultValue', () => {
    const customDefaults: FeatureFlagsNamespace = {
      'custom-flag': { type: 'boolean', description: 'Custom', default: true },
    };
    registerFeatureFlagsConsumer(customDefaults);
    const consumer = getConfigConsumer<FeatureFlagsNamespace>(FEATURE_FLAGS_NAMESPACE);
    expect(consumer!.defaultValue).toEqual(customDefaults);
  });
});
