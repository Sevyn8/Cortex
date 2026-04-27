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
  it('has 10 total tenant-lifecycle actions (5 Slice A + 5 F02 additions)', () => {
    expect(TENANT_AUDIT_ACTIONS.length).toBe(10);
  });

  it('every entry has a non-empty name and a verb', () => {
    for (const entry of TENANT_AUDIT_ACTIONS) {
      expect(entry.name).toMatch(/^TENANT_/);
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
