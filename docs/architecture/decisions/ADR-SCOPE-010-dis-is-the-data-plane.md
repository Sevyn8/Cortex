# ADR-SCOPE-010: DIS is the Data Plane

**Status:** Proposed (pending joint ratification with Sanjeev at gate GR)
**Date:** June 2026
**Deciders:** Amit and Sanjeev (Sevyn8 engineering); joint ratification at gate GR
**Context documents:** `docs/spec/v3/reconciliation.md` section 3 and section 6; `docs/spec/v3/architecture-spec.md` section 1 and section 2.2; `docs/spec/v3/specification.md` section 5.1 (V3-G01-FR-001); Cortex v2.2 Spec section 4.1a
**Supersedes (upon ratification):** ADR-SCOPE-009 (ROOS Remains External to Cortex); Cortex v2.2 Spec section 4.1a

---

## Context

Spec v2.2 (and ADR-SCOPE-009) characterized the external platform as "ROOS (Ithina DIS)": a single outside system to be consumed via the canonical topic `dis.golden.roos` and never subsumed. That characterization conflated two distinct systems and got two things wrong:

1. Ownership. DIS and Customer Master are Sevyn8 products; Ithina is a tenant, not the owner.
2. Identity. ROOS is not DIS. DIS's own README establishes ROOS as a separate downstream recommendation engine that reads from DIS; v2.2 treated the consumer (ROOS) and the data plane (DIS) as one system.

A third fact corroborates the correction: DIS's real implementation (Connect-a-System, SFTPGo, Pub/Sub, Postgres with RLS, GCP asia-south1) differs materially from the ROOS description in v2.2.

The boundary as written is therefore drift between the spec and the live estate, and the spec-or-code drift rule requires it to be corrected by decision rather than left uncommented. The surviving rule is unchanged: external systems, including ROOS, interact with the platform only through DIS's defined contract surfaces (front-door law; see V3-G01-FR-001).

## Decision

DIS is Cortex v3's data plane. The consume-only boundary is retired.

1. Cortex-repo modules dispositioned SATISFIED-BY-LIVE (see `reconciliation.md` section 2) stop being built as parallel implementations; their v2.2 FRs become conformance and gap tests against DIS.
2. External partner systems still enter the platform only through DIS's front door. The healthy half of v2.2 section 4.1a survives as front-door law: no external system reaches internal services directly.
3. Upon ratification at gate GR this ADR supersedes ADR-SCOPE-009 and v2.2 section 4.1a. Until then ADR-SCOPE-009 remains Accepted and this ADR remains Proposed.

## Consequences

- G01, G02, and D02 build effort is redirected from parallel rebuilds to the ADOPT list (connector abstraction, per-source webhook URLs with HMAC, streaming fast path, JDBC / Google Sheets / generic REST connectors).
- The `dis.golden.roos` consumption pattern is repurposed inward: it becomes the template for edge Cortex deployments feeding DIS as registered sources publishing canonical facts (V3-G01-FR-003).
- Spec v2.2 text referencing ROOS ownership is corrected in the v3 documents: DIS is Sevyn8's; Ithina is tenant-zero.

## References

- `docs/spec/v3/reconciliation.md` section 3 (draft text this ADR is extracted from), section 6 (spec drift corrections)
- `docs/spec/v3/architecture-spec.md` section 1 (governing correction), section 2.2 (data plane), section 5 invariant 4
- `docs/spec/v3/specification.md` section 5.1 (V3-G01-FR-001 supersedes section 4.1a)
- ADR-SCOPE-009 (the decision this supersedes upon ratification)
- ADR-IDENTITY-001 (companion v3 re-baseline decision)
