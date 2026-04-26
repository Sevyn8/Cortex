import { describe, expect, it } from 'vitest';
import { ENCRYPTION_AUDIT_ACTIONS, type EncryptionAuditAction } from '../src/index.js';

// ─────────────────────────────────────────────────────────────────────
// Compile-time helper: assert two types are equal. Forces TS to surface
// any divergence in the type-system shape; failure is a typecheck error,
// not a runtime failure. (Duplicated from types.spec.ts — extract to a
// shared util when a third spec needs it; two copies of one line is
// below the WET-cost threshold.)
// ─────────────────────────────────────────────────────────────────────

type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

describe('ENCRYPTION_AUDIT_ACTIONS shape', () => {
  it('contains exactly 2 entries (defensive against silent expansion)', () => {
    expect(ENCRYPTION_AUDIT_ACTIONS).toHaveLength(2);
  });

  it("names are exactly ['PII_ENCRYPTED', 'PII_DECRYPTED']", () => {
    expect(ENCRYPTION_AUDIT_ACTIONS.map((a) => a.name)).toEqual(['PII_ENCRYPTED', 'PII_DECRYPTED']);
  });

  it("verbs are exactly ['CREATE', 'READ']", () => {
    expect(ENCRYPTION_AUDIT_ACTIONS.map((a) => a.verb)).toEqual(['CREATE', 'READ']);
  });
});

describe('EncryptionAuditAction type', () => {
  it("equals the literal union 'PII_ENCRYPTED' | 'PII_DECRYPTED'", () => {
    // Compile-time: failure here is a tsc error, not a runtime
    // assertion. Adding an entry to ENCRYPTION_AUDIT_ACTIONS extends
    // this union automatically; the witness fails to compile if the
    // expected union ever drifts.
    const _check: Equals<EncryptionAuditAction, 'PII_ENCRYPTED' | 'PII_DECRYPTED'> = true;
    expect(_check).toBe(true);
  });
});

describe('registerAuditActions enforcement', () => {
  it('catalog loaded successfully (no module-load throw)', () => {
    // The import at the top of this file would throw at module
    // evaluation if any catalog entry violated the action-name regex
    // (`/^[A-Z][A-Z0-9_]*$/`) or duplicated a name. Reaching this
    // assertion means `registerAuditActions` accepted the catalog.
    // This is the regression guard for future entries.
    expect(ENCRYPTION_AUDIT_ACTIONS).toBeDefined();
    expect(ENCRYPTION_AUDIT_ACTIONS).toHaveLength(2);
  });
});
