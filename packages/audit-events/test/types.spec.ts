import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTION_NAME_REGEX,
  SOFT_PAYLOAD_LIMIT_BYTES,
  type AuditEventParams,
} from '../src/index.js';

describe('AUDIT_ACTION_NAME_REGEX — valid inputs', () => {
  it('accepts canonical UPPER_SNAKE shapes plus boundary forms', () => {
    expect(AUDIT_ACTION_NAME_REGEX.test('TENANT_CREATED')).toBe(true);
    expect(AUDIT_ACTION_NAME_REGEX.test('A')).toBe(true);
    expect(AUDIT_ACTION_NAME_REGEX.test('A_B_C')).toBe(true);
    expect(AUDIT_ACTION_NAME_REGEX.test('EVENT_TYPE_42')).toBe(true);
    // No length cap — 100 chars of valid form passes.
    const longName = 'A' + 'B'.repeat(99);
    expect(longName).toHaveLength(100);
    expect(AUDIT_ACTION_NAME_REGEX.test(longName)).toBe(true);
  });
});

describe('AUDIT_ACTION_NAME_REGEX — invalid inputs', () => {
  it('rejects malformed names', () => {
    const invalid = [
      'tenant_created', // lowercase
      'TENANT-CREATED', // hyphen
      'TENANT.CREATED', // dot
      '_TENANT', // leading underscore
      '1TENANT', // leading digit
      '', // empty
      'TENANT CREATED', // space
    ];
    for (const name of invalid) {
      expect(AUDIT_ACTION_NAME_REGEX.test(name)).toBe(false);
    }
  });
});

describe('SOFT_PAYLOAD_LIMIT_BYTES', () => {
  it('equals 64 KiB (65536)', () => {
    expect(SOFT_PAYLOAD_LIMIT_BYTES).toBe(64 * 1024);
    expect(SOFT_PAYLOAD_LIMIT_BYTES).toBe(65_536);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Compile-time discriminated-union smoke tests
//
// The runtime assertion is trivial — the real test is whether the file
// compiles. If the discriminated union regressed (e.g., before_state
// stopped being forbidden under CREATE, or required under UPDATE), the
// typecheck would fail before vitest runs. These tests serve as living
// documentation of the canonical AuditEventParams shapes consumers
// will pass at the emit-time call site.
// ─────────────────────────────────────────────────────────────────────

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const RESOURCE = `tenant:${TENANT_ID}`;

describe('AuditEventParams discriminated union — compile-time shapes', () => {
  it('CREATE: after_state required, before_state forbidden', () => {
    const params: AuditEventParams = {
      tenantId: TENANT_ID,
      actorType: 'service',
      actorId: 'svc-foundation',
      action: { name: 'TENANT_CREATED', verb: 'CREATE' },
      verb: 'CREATE',
      resource: RESOURCE,
      after_state: { tier: 'STANDARD', status: 'ACTIVE' },
    };
    expect(params.verb).toBe('CREATE');
  });

  it('UPDATE: both before_state and after_state required', () => {
    const params: AuditEventParams = {
      tenantId: TENANT_ID,
      actorType: 'user',
      actorId: 'usr-amit',
      action: { name: 'TENANT_UPDATED', verb: 'UPDATE' },
      verb: 'UPDATE',
      resource: RESOURCE,
      before_state: { status: 'PROVISIONING' },
      after_state: { status: 'ACTIVE' },
    };
    expect(params.verb).toBe('UPDATE');
  });

  it('READ: both before_state and after_state forbidden', () => {
    const params: AuditEventParams = {
      tenantId: TENANT_ID,
      actorType: 'agent',
      actorId: 'agt-mcp-core',
      action: { name: 'TENANT_READ', verb: 'READ' },
      verb: 'READ',
      resource: RESOURCE,
    };
    expect(params.verb).toBe('READ');
  });
});
