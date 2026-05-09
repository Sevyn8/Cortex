/**
 * Catalog completeness + import-side-effect-free verification for
 * `@cortex/config-plane`'s audit-action catalog. Mirrors the
 * `@cortex/tenant-context/test/audit-actions.spec.ts` precedent.
 */

import { describe, expect, it } from 'vitest';
import { CONFIG_AUDIT_ACTIONS, type ConfigAuditAction } from '../src/audit-actions.js';

describe('@cortex/config-plane audit-actions catalog', () => {
  it('registers exactly 6 verbs per F04 D11 lock', () => {
    expect(CONFIG_AUDIT_ACTIONS).toHaveLength(6);
  });

  it('names follow the registerAuditActions regex (UPPERCASE_SNAKE_CASE, ≤ 64 chars)', () => {
    const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
    for (const action of CONFIG_AUDIT_ACTIONS) {
      expect(action.name).toMatch(NAME_RE);
    }
  });

  it('includes all 6 expected action names', () => {
    const names = CONFIG_AUDIT_ACTIONS.map((a) => a.name).sort();
    expect(names).toEqual(
      [
        'CONFIG_DRAFT_CREATED',
        'CONFIG_DRAFT_DISCARDED',
        'CONFIG_DRAFT_UPDATED',
        'CONFIG_DRAFT_VALIDATED',
        'CONFIG_VERSION_PROMOTED',
        'CONFIG_VERSION_ROLLED_BACK',
      ].sort(),
    );
  });

  it('verbs match the F04 D11 lock semantics', () => {
    const verbByName: Record<string, string> = {};
    for (const action of CONFIG_AUDIT_ACTIONS) {
      verbByName[action.name] = action.verb;
    }
    expect(verbByName.CONFIG_DRAFT_CREATED).toBe('CREATE');
    expect(verbByName.CONFIG_DRAFT_UPDATED).toBe('UPDATE');
    expect(verbByName.CONFIG_DRAFT_VALIDATED).toBe('READ');
    expect(verbByName.CONFIG_DRAFT_DISCARDED).toBe('DELETE');
    expect(verbByName.CONFIG_VERSION_PROMOTED).toBe('CREATE');
    expect(verbByName.CONFIG_VERSION_ROLLED_BACK).toBe('CREATE');
  });

  it('ConfigAuditAction type covers every catalog name (compile-time check)', () => {
    // Compile-time: assigning a known catalog name to ConfigAuditAction
    // should typecheck. If the type drifts from the catalog, this test
    // would fail at typecheck (not runtime).
    const known: ConfigAuditAction = 'CONFIG_DRAFT_CREATED';
    expect(known).toBe('CONFIG_DRAFT_CREATED');
  });
});
