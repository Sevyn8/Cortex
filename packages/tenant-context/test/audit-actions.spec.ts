/**
 * Catalog assertion tests for `TENANT_AUDIT_ACTIONS`. Pure catalog reads;
 * no DB dependency. Lives separately from `audit.spec.ts` (which exercises
 * the DB-dependent `emitAuditEvent` path) so this surface is testable
 * locally without a Postgres proxy.
 */

import { describe, expect, it } from 'vitest';
import { getActionByName } from '@cortex/audit-events';
import { TENANT_AUDIT_ACTIONS } from '../src/audit-actions.js';

describe('TENANT_AUDIT_ACTIONS — catalog shape', () => {
  it('has 15 total actions (5 Slice A + 6 F02 lifecycle + 3 Slice C 7.5 + 1 F02 D.3 addition)', () => {
    expect(TENANT_AUDIT_ACTIONS.length).toBe(15);
  });

  it('every entry has a non-empty name and a verb', () => {
    for (const entry of TENANT_AUDIT_ACTIONS) {
      // Slice C 7.5 added the LEGAL_HOLD_* prefix; both domains live in
      // @cortex/tenant-context per planning-doc D4, so the catalog
      // prefix-regex permits both TENANT_* and LEGAL_HOLD_*.
      expect(entry.name).toMatch(/^(TENANT_|LEGAL_HOLD_)/);
      expect(entry.name.length).toBeGreaterThan('TENANT_'.length);
      expect(entry.verb).toMatch(/^(CREATE|UPDATE|DELETE|READ|APPROVE|REJECT|EXECUTE)$/);
    }
  });

  it('action names are unique', () => {
    const names = TENANT_AUDIT_ACTIONS.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('TENANT_AUDIT_ACTIONS — Slice A entries (pre-F02)', () => {
  it('TENANT_CREATED is registered with CREATE verb', () => {
    expect(getActionByName(TENANT_AUDIT_ACTIONS, 'TENANT_CREATED').verb).toBe('CREATE');
  });

  it('TENANT_UPDATED is registered with UPDATE verb', () => {
    expect(getActionByName(TENANT_AUDIT_ACTIONS, 'TENANT_UPDATED').verb).toBe('UPDATE');
  });

  it('TENANT_STATUS_CHANGED is registered with UPDATE verb', () => {
    expect(getActionByName(TENANT_AUDIT_ACTIONS, 'TENANT_STATUS_CHANGED').verb).toBe('UPDATE');
  });

  it('TENANT_CONFIG_VERSION_CREATED is registered with CREATE verb', () => {
    expect(getActionByName(TENANT_AUDIT_ACTIONS, 'TENANT_CONFIG_VERSION_CREATED').verb).toBe(
      'CREATE',
    );
  });

  it('TENANT_KMS_KEY_BOUND is registered with CREATE verb', () => {
    expect(getActionByName(TENANT_AUDIT_ACTIONS, 'TENANT_KMS_KEY_BOUND').verb).toBe('CREATE');
  });
});

describe('TENANT_AUDIT_ACTIONS — F02 lifecycle additions', () => {
  it('TENANT_PROVISIONED is registered with CREATE verb', () => {
    expect(getActionByName(TENANT_AUDIT_ACTIONS, 'TENANT_PROVISIONED').verb).toBe('CREATE');
  });

  it('TENANT_SUSPENDED is registered with UPDATE verb (Slice B; cascade-event handle for AC01/S15/S17)', () => {
    expect(getActionByName(TENANT_AUDIT_ACTIONS, 'TENANT_SUSPENDED').verb).toBe('UPDATE');
  });

  it('TENANT_OFFBOARDING_STARTED is registered with UPDATE verb', () => {
    expect(getActionByName(TENANT_AUDIT_ACTIONS, 'TENANT_OFFBOARDING_STARTED').verb).toBe('UPDATE');
  });

  it('TENANT_TERMINATED is registered with DELETE verb', () => {
    expect(getActionByName(TENANT_AUDIT_ACTIONS, 'TENANT_TERMINATED').verb).toBe('DELETE');
  });

  it('TENANT_KEY_ROTATED is registered with UPDATE verb', () => {
    expect(getActionByName(TENANT_AUDIT_ACTIONS, 'TENANT_KEY_ROTATED').verb).toBe('UPDATE');
  });

  it('TENANT_CONFIG_VERSION_UPDATED is registered with UPDATE verb', () => {
    expect(getActionByName(TENANT_AUDIT_ACTIONS, 'TENANT_CONFIG_VERSION_UPDATED').verb).toBe(
      'UPDATE',
    );
  });
});

describe('TENANT_AUDIT_ACTIONS — F02 Slice C 7.5 additions', () => {
  it('TENANT_FORCE_TERMINATED is registered with DELETE verb (Super Admin override; SC2 lock)', () => {
    expect(getActionByName(TENANT_AUDIT_ACTIONS, 'TENANT_FORCE_TERMINATED').verb).toBe('DELETE');
  });

  it('LEGAL_HOLD_SET is registered with CREATE verb (legal-hold lifecycle; SC3 lock)', () => {
    expect(getActionByName(TENANT_AUDIT_ACTIONS, 'LEGAL_HOLD_SET').verb).toBe('CREATE');
  });

  it('LEGAL_HOLD_RELEASED is registered with DELETE verb', () => {
    expect(getActionByName(TENANT_AUDIT_ACTIONS, 'LEGAL_HOLD_RELEASED').verb).toBe('DELETE');
  });
});

describe('TENANT_AUDIT_ACTIONS — F02 D.3 additions', () => {
  it('TENANT_DEDICATED_DB_APPROVED is registered with UPDATE verb (Q-OPEN-6 manual gate flip)', () => {
    expect(getActionByName(TENANT_AUDIT_ACTIONS, 'TENANT_DEDICATED_DB_APPROVED').verb).toBe(
      'UPDATE',
    );
  });
});
