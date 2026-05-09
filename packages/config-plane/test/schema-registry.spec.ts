/**
 * Tests for the `@cortex/config-plane` Zod schema registry per F04
 * D12 lock. Verifies:
 *   - register + lookup round-trip
 *   - per-version isolation (drafts pinned to v=1 keep validating
 *     against v=1 even after v=2 ships)
 *   - conflict on registering a different schema against an
 *     already-occupied (namespace, version) key
 *   - idempotent re-registration of the same schema reference
 */

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  NamespaceSchemaConflictError,
  getLatestRegisteredVersion,
  getNamespaceSchema,
  registerNamespaceSchema,
  resetSchemaRegistry,
} from '../src/schema-registry.js';

afterEach(() => {
  resetSchemaRegistry();
});

describe('schema-registry — registerNamespaceSchema + getNamespaceSchema', () => {
  it('registers + retrieves a schema for (namespace, version)', () => {
    const schema = z.object({ primary_color: z.string() });
    registerNamespaceSchema('platform.theme', schema, { version: 1 });
    const entry = getNamespaceSchema('platform.theme', 1);
    expect(entry).toBeDefined();
    expect(entry!.namespace).toBe('platform.theme');
    expect(entry!.version).toBe(1);
    expect(entry!.schema).toBe(schema);
  });

  it('returns undefined for unregistered (namespace, version)', () => {
    expect(getNamespaceSchema('platform.unknown', 1)).toBeUndefined();
  });

  it('keeps v=1 + v=2 schemas independent (per-version isolation)', () => {
    const v1 = z.object({ primary_color: z.string() });
    const v2 = z.object({
      primary_color: z.string(),
      secondary_color: z.string(),
    });
    registerNamespaceSchema('platform.theme', v1, { version: 1 });
    registerNamespaceSchema('platform.theme', v2, { version: 2 });

    expect(getNamespaceSchema('platform.theme', 1)!.schema).toBe(v1);
    expect(getNamespaceSchema('platform.theme', 2)!.schema).toBe(v2);
  });

  it('idempotent on re-registering the SAME schema reference', () => {
    const schema = z.object({ primary_color: z.string() });
    const first = registerNamespaceSchema('platform.theme', schema, { version: 1 });
    const second = registerNamespaceSchema('platform.theme', schema, { version: 1 });
    // Same reference → both calls return the same entry.
    expect(second).toBe(first);
  });

  it('throws NamespaceSchemaConflictError on a different schema for an already-occupied key', () => {
    const v1 = z.object({ primary_color: z.string() });
    const v1other = z.object({ primary_color: z.number() });
    registerNamespaceSchema('platform.theme', v1, { version: 1 });
    expect(() => registerNamespaceSchema('platform.theme', v1other, { version: 1 })).toThrow(
      NamespaceSchemaConflictError,
    );
    expect(() => registerNamespaceSchema('platform.theme', v1other, { version: 1 })).toThrow(
      /already registered/,
    );
  });

  it('getLatestRegisteredVersion returns the highest registered version for a namespace', () => {
    const v1 = z.object({ a: z.string() });
    const v2 = z.object({ a: z.string(), b: z.string() });
    const v3 = z.object({ a: z.string(), b: z.string(), c: z.string() });
    registerNamespaceSchema('platform.theme', v1, { version: 1 });
    registerNamespaceSchema('platform.theme', v3, { version: 3 });
    registerNamespaceSchema('platform.theme', v2, { version: 2 });
    expect(getLatestRegisteredVersion('platform.theme')).toBe(3);
  });

  it('getLatestRegisteredVersion throws when namespace has no registered schema', () => {
    expect(() => getLatestRegisteredVersion('platform.unknown')).toThrow(/no schema registered/);
  });

  it('isolates namespaces — `platform.theme` and `tenant.theme` are distinct keys', () => {
    const platformSchema = z.object({ source: z.literal('platform') });
    const tenantSchema = z.object({ source: z.literal('tenant') });
    registerNamespaceSchema('platform.theme', platformSchema, { version: 1 });
    registerNamespaceSchema('tenant.theme', tenantSchema, { version: 1 });
    expect(getNamespaceSchema('platform.theme', 1)!.schema).toBe(platformSchema);
    expect(getNamespaceSchema('tenant.theme', 1)!.schema).toBe(tenantSchema);
  });
});
