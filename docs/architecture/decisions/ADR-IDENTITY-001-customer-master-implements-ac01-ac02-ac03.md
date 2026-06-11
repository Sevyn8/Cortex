# ADR-IDENTITY-001: Customer Master Implements AC01, AC02, AC03

**Status:** Proposed (pending joint ratification with Sanjeev at gate GR)
**Date:** June 2026
**Deciders:** Sanjeev (Sevyn8 engineering) ratifies; drafted with Amit; joint ratification at gate GR
**Context documents:** `docs/spec/v3/reconciliation.md` section 4; `docs/spec/v3/architecture-spec.md` section 2.1 and section 5 invariant 3; `docs/spec/v3/specification.md` section 4 (AC01 / AC02 / AC03 amendments); Cortex v2.2 Spec sections AC01, AC02, AC03
**Companion decisions:** ADR-SCOPE-010 (DIS is the data plane)

---

## Context

Spec v2.2 specifies AC01 (ABAC plus RBAC), AC02 (Hierarchy Engine), and AC03 (Consent and Privacy Manager) as Cortex modules to be built. Customer Master is live and is the platform's identity SSOT: Auth0 OIDC and SSO, the Superadmin 4-tuple (Module, Resource, Action with VIEW / CONFIGURE / EXECUTE / APPROVE / OVERRIDE / AUDIT, Scope), a fixed scope hierarchy, and tenant and store resolution via `identity_mirror`. Specifying parallel Cortex identity and policy services would create a second identity authority, which the platform must never have.

## Decision

Customer Master is the implementation of AC01 and AC02. AC03 is adopted into CM as the consent ledger.

1. The v2.2 AC01 and AC02 FRs apply as a conformance and gap suite against CM, not as a build of new services.
2. AC03 FRs apply as build requirements inside CM (the consent ledger).
3. The AC FR gap analysis (expected gaps: ABAC attribute-condition evaluation, the consent ledger, and machine and agent principals) is produced in Phase 0 and becomes CM backlog items, not new services.
4. No second identity or policy authority is ever built.

## Consequences

- One identity authority (architecture-spec invariant 3): nothing in the platform re-validates what Customer Master asserts.
- Vertical display vocabulary (Store vs Branch vs Dealership) is handled by pack i18n labels (IC02) over fixed scopes; RLS and isolation logic never vary by vertical.
- The machine-auth token contract (C1) is the first artifact in the contracts repo and the first joint work item in Phase 0.

## References

- `docs/spec/v3/reconciliation.md` section 4 (draft text this ADR is extracted from), items 21 to 23 and section 6
- `docs/spec/v3/architecture-spec.md` section 2.1 (identity plane), section 5 invariant 3
- `docs/spec/v3/specification.md` section 4 (V3-AC01 / V3-AC02 / V3-AC03 amendments)
- ADR-SCOPE-010 (companion v3 re-baseline decision)
