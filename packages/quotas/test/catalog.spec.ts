import { describe, expect, it } from 'vitest';
import { QUOTA_AUDIT_ACTIONS, type QuotaAuditAction } from '../src/index.js';

// ─────────────────────────────────────────────────────────────────────
// Compile-time helper: assert two types are equal. Forces TS to surface
// any divergence in the type-system shape; failure is a typecheck error,
// not a runtime failure. (Duplicated from types.spec.ts — extract to a
// shared util when a third spec needs it; two copies of one line is
// below the WET-cost threshold.)
// ─────────────────────────────────────────────────────────────────────

type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

describe('QUOTA_AUDIT_ACTIONS shape', () => {
  it('contains exactly 1 entry (defensive against silent expansion)', () => {
    expect(QUOTA_AUDIT_ACTIONS).toHaveLength(1);
  });

  it("the single entry is { name: 'QUOTA_EXCEEDED', verb: 'REJECT' }", () => {
    expect(QUOTA_AUDIT_ACTIONS.map((a) => a.name)).toEqual(['QUOTA_EXCEEDED']);
    expect(QUOTA_AUDIT_ACTIONS.map((a) => a.verb)).toEqual(['REJECT']);
  });
});

describe('QuotaAuditAction type', () => {
  it("equals the literal 'QUOTA_EXCEEDED'", () => {
    // Compile-time: failure here is a tsc error. Adding an entry to
    // QUOTA_AUDIT_ACTIONS extends this union automatically; the
    // witness fails to compile if the expected literal ever drifts.
    const _check: Equals<QuotaAuditAction, 'QUOTA_EXCEEDED'> = true;
    expect(_check).toBe(true);
  });
});

describe('registerAuditActions enforcement', () => {
  it('catalog loaded successfully (no module-load throw)', () => {
    // The import at the top of this file would throw at module
    // evaluation if the catalog entry violated the action-name regex
    // (`/^[A-Z][A-Z0-9_]*$/`) or duplicated a name. Reaching this
    // assertion means `registerAuditActions` accepted the catalog.
    // This is the regression guard for future entries.
    expect(QUOTA_AUDIT_ACTIONS).toBeDefined();
    expect(QUOTA_AUDIT_ACTIONS).toHaveLength(1);
  });
});
