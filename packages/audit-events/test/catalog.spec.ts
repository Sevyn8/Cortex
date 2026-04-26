import { describe, expect, it } from 'vitest';
import {
  asAuditActionName,
  AuditEventValidationError,
  getActionByName,
  isRegisteredActionName,
  registerAuditActions,
  type AuditActionDescriptor,
} from '../src/index.js';

// ─────────────────────────────────────────────────────────────────────
// registerAuditActions — success
// ─────────────────────────────────────────────────────────────────────

describe('registerAuditActions — success', () => {
  it('returns the input array unchanged for a valid catalog', () => {
    const input = [
      { name: 'TENANT_CREATED', verb: 'CREATE' },
      { name: 'TENANT_UPDATED', verb: 'UPDATE' },
    ] as const;
    const out = registerAuditActions(input);
    expect(out).toBe(input);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ name: 'TENANT_CREATED', verb: 'CREATE' });
    expect(out[1]).toEqual({ name: 'TENANT_UPDATED', verb: 'UPDATE' });
  });

  it('accepts an empty array (vacuously valid)', () => {
    const out = registerAuditActions([] as const);
    expect(out).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// registerAuditActions — failure
// ─────────────────────────────────────────────────────────────────────

describe('registerAuditActions — failure', () => {
  it('throws AuditEventValidationError when a name fails the regex', () => {
    expect(() =>
      registerAuditActions([{ name: 'tenant_created', verb: 'CREATE' }] as const),
    ).toThrow(AuditEventValidationError);
    try {
      registerAuditActions([{ name: 'tenant_created', verb: 'CREATE' }] as const);
    } catch (err) {
      expect(err).toBeInstanceOf(AuditEventValidationError);
      expect((err as Error).message).toContain('tenant_created');
    }
  });

  it('throws AuditEventValidationError when a verb is not a CrudVerb', () => {
    // Cast through unknown to bypass the compile-time CrudVerb constraint —
    // simulates an `as` cast that would slip past the type system.
    const badCatalog = [{ name: 'TENANT_BOGUS', verb: 'TELEPORT' as unknown as 'CREATE' }] as const;
    expect(() => registerAuditActions(badCatalog)).toThrow(AuditEventValidationError);
    try {
      registerAuditActions(badCatalog);
    } catch (err) {
      expect((err as Error).message).toContain('TENANT_BOGUS');
      expect((err as Error).message).toContain('TELEPORT');
    }
  });

  it('throws AuditEventValidationError on duplicate names', () => {
    const dup = [
      { name: 'TENANT_CREATED', verb: 'CREATE' },
      { name: 'TENANT_CREATED', verb: 'UPDATE' }, // duplicate name, different verb
    ] as const;
    expect(() => registerAuditActions(dup)).toThrow(AuditEventValidationError);
    try {
      registerAuditActions(dup);
    } catch (err) {
      expect((err as Error).message).toContain('Duplicate');
      expect((err as Error).message).toContain('TENANT_CREATED');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// getActionByName
// ─────────────────────────────────────────────────────────────────────

describe('getActionByName', () => {
  const CATALOG = registerAuditActions([
    { name: 'TENANT_CREATED', verb: 'CREATE' },
    { name: 'TENANT_UPDATED', verb: 'UPDATE' },
    { name: 'TENANT_REMOVED', verb: 'DELETE' },
  ] as const);

  it('returns the matching descriptor for a registered name (verb narrows)', () => {
    const created = getActionByName(CATALOG, 'TENANT_CREATED');
    expect(created.name).toBe('TENANT_CREATED');
    expect(created.verb).toBe('CREATE');

    const updated = getActionByName(CATALOG, 'TENANT_UPDATED');
    expect(updated.name).toBe('TENANT_UPDATED');
    expect(updated.verb).toBe('UPDATE');
  });

  it('throws AuditEventValidationError for an unregistered name (defensive runtime check)', () => {
    // Bypass the compile-time literal-union constraint via a cast.
    type CatalogName = (typeof CATALOG)[number]['name'];
    expect(() => getActionByName(CATALOG, 'TENANT_GHOST' as CatalogName)).toThrow(
      AuditEventValidationError,
    );
    try {
      getActionByName(CATALOG, 'TENANT_GHOST' as CatalogName);
    } catch (err) {
      expect((err as Error).message).toContain('TENANT_GHOST');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// isRegisteredActionName
// ─────────────────────────────────────────────────────────────────────

describe('isRegisteredActionName', () => {
  const CATALOG: readonly AuditActionDescriptor[] = registerAuditActions([
    { name: 'TENANT_CREATED', verb: 'CREATE' },
    { name: 'TENANT_UPDATED', verb: 'UPDATE' },
  ] as const);

  it('returns true for registered names and false for unregistered names', () => {
    expect(isRegisteredActionName(CATALOG, 'TENANT_CREATED')).toBe(true);
    expect(isRegisteredActionName(CATALOG, 'TENANT_UPDATED')).toBe(true);
    expect(isRegisteredActionName(CATALOG, 'TENANT_GHOST')).toBe(false);
    expect(isRegisteredActionName(CATALOG, '')).toBe(false);
    expect(isRegisteredActionName(CATALOG, 'tenant_created')).toBe(false); // case-sensitive
  });
});

// ─────────────────────────────────────────────────────────────────────
// asAuditActionName
// ─────────────────────────────────────────────────────────────────────

describe('asAuditActionName', () => {
  it('returns the validated name as a branded value when regex matches', () => {
    const name = asAuditActionName('VALID_NAME');
    // Brand erases at runtime — the value is identity-equal to its source string.
    expect(name).toBe('VALID_NAME');
  });

  it('throws AuditEventValidationError when name fails the regex', () => {
    expect(() => asAuditActionName('lowercase_name')).toThrow(AuditEventValidationError);
    expect(() => asAuditActionName('LEADING_SPACE ')).toThrow(AuditEventValidationError);
    expect(() => asAuditActionName('')).toThrow(AuditEventValidationError);
  });
});
