# ADR-INFRA-008: Cross-Product Infrastructure Topology

**Status:** Proposed (joint decision with Sanjeev at the Phase R / GR gate)
**Date:** June 2026
**Deciders:** Amit and Sanjeev (Sevyn8 engineering); joint ratification at Phase R / GR
**Context documents:** `docs/architecture/infra-shared-resource-register.md`; `docs/spec/v3/architecture-spec.md` section 4; `docs/spec/v3/plan.md` section 1; ADR-INFRA-002 (Terraform bootstrap), ADR-INFRA-003 (VPC topology)
**Companion decisions:** ADR-SCOPE-010 (DIS is the data plane), ADR-IDENTITY-001 (CM is the identity plane)

---

## Context

A read-only discovery (see the shared-resource register) found the three products deployed as fully isolated Terraform stacks, one GCP project each, three separate state backends, with zero cross-stack references and zero duplicated resources:

- Cortex: `sevyn8-cortex-{dev,staging,prod,shared,tfstate}`
- DIS: `ithina-retail-dis`
- Customer Master: `ithina-retail-admin`

v3 mandates cross-stack consumption by name, never `terraform_remote_state`. A BFSI security review is on the roadmap (plan Phase 5), and project-level isolation between identity (CM, Auth0), the data plane (DIS), and platform services (Cortex) is today a clean, evidenceable asset for that review. Any topology change should be weighed against that.

## The problem we are actually solving

The concrete cross-product need is shared access to an event SPINE: a Pub/Sub topic set with versioned schemas (architecture-spec C2, `spine.{event_type}.v{n}`) that more than one product publishes to or consumes from. No spine exists yet (DIS has only internal pipeline topics; Cortex has none). Smaller, separable candidates for sharing are a common Artifact Registry and a shared KMS keyring.

There is no established need to share VPC, Cloud SQL, compute, or identity across products; those are, and should remain, per-product. So the decision is how to provide shared SPINE access (and optionally AR/KMS), not whether to collapse the platform into one project.

## Options

### Option A: One common platform project

Collapse Cortex, DIS, and CM onto one GCP project holding a shared foundation (VPC, KMS, Artifact Registry, DNS, spine); services converge incrementally.

### Option B: Three isolated projects plus a thin shared-services project

Keep the three product projects unchanged. Add one small shared-services project holding ONLY cross-cutting resources: spine Pub/Sub topics and schemas, a shared Artifact Registry, and a shared KMS keyring. Products reach it by cross-project IAM (publisher/subscriber on spine topics, reader on AR, encrypter on KMS). No migration, no VPC change.

### Option C: Three projects, spine in DIS

Keep three projects and add no new project. The spine topics and schemas live in the DIS project (DIS is the data-plane front door and already runs Pub/Sub); CM and Cortex get cross-project publish/subscribe by IAM. AR/KMS stay per-product (or become a later, separate decision).

## Comparison

| Dimension                    | A: one common project                                                                                                                  | B: shared-services project                                                                            | C: spine in DIS                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| v3 invariant 3 / isolation   | Weakens: identity, data, and platform share one project's IAM, quota, and blast radius; invariant 3 enforced only by intra-project IAM | Preserved: products stay isolated; shared-services holds no identity and no tenant data               | Preserved: CM and Cortex stay isolated; identity stays in CM; DIS owns the bus                                                            |
| Migration cost               | High: recreate and data-migrate Cloud SQL (DIS has live tenants), GCS, Pub/Sub, service accounts, secrets, AR; staged cutovers         | None: shared-services is net-new; the spine is new regardless                                         | None: spine is net-new in DIS, which already operates Pub/Sub                                                                             |
| VPC impact                   | High: forced renumber of overlapping CIDRs (DIS 10.20.0.0/24, CM 10.10.0.0/20, Cortex 10.10/10.20/10.30) into one VPC                  | None: spine/AR/KMS are managed services needing no VPC merge                                          | None                                                                                                                                      |
| BFSI-review posture          | Weaker: collapses isolation just before the review; harder to evidence plane and tenant separation                                     | Strong: isolation preserved; shared surface is minimal, auditable, carries no identity or tenant data | Strong on isolation; minor caveat: a product (DIS) owns a cross-product bus inside its own blast radius                                   |
| Ops overhead (two engineers) | Low steady-state, but very high one-time migration plus cross-swimlane coordination; single blast radius raises incident risk          | Moderate: one extra small project and cross-project IAM grants to maintain                            | Lowest: no new project; cross-project IAM grants only; reuses DIS Pub/Sub practice; others depend on DIS project availability for the bus |

## Synthesis (fit to the stated problem)

The problem is shared spine access (and maybe AR/KMS), not shared compute, data, VPC, or identity. Options B and C both solve it with zero migration, no VPC renumber, and preserved isolation, which is the right posture entering a BFSI review. Option A also solves it but over-solves: it collapses isolation and incurs large migration and renumber cost, moving in the wrong direction relative to BFSI.

The remaining choice is B versus C. B gives neutral ownership of the cross-product bus (no single product owns shared infra) at the cost of running one more small project. C has the fewest moving parts but places the shared bus inside DIS's project and Amit's swimlane, and makes the bus depend on DIS project availability. AR/KMS sharing is a minor, separable add-on under B and a later decision under C.

## Recommended direction (non-binding, decided at GR)

The authors lean toward option B or C over A: B and C solve the stated problem (shared spine access) with the v3 isolation invariant preserved and zero migration, whereas A over-solves and softens isolation ahead of the BFSI review.

Between B and C, the lean is B. Option C (spine in the DIS project) is fewer moving parts but re-establishes DIS as a privileged project the others depend on, a soft coupling that runs against the clean per-product separation the discovery found; option B (a thin shared-services project) costs one extra project but keeps the products symmetric and gives the spine, Artifact Registry, and KMS a neutral owner. Lean B, flagged as the GR decision. This section is non-binding; the choice is made jointly with Sanjeev at the Phase R / GR gate.

## Decision

Deferred to joint ratification with Sanjeev at the Phase R / GR gate. This ADR frames the choice and does not unilaterally pick. The analysis indicates B or C (isolation-preserving, no migration, no renumber) fit the actual problem; A is documented in full with its costs for completeness and is not favored given the imminent BFSI review.

## Consequences (by chosen option)

- If A: plan the data migrations, the VPC renumber, and cross-swimlane cutovers; re-evidence isolation for BFSI via intra-project IAM and folders. (Migration order would be foundation, CM, DIS, platform, per the deploy-order runbook, with state backups and no-op verification at each cutover.)
- If B: stand up the shared-services project; define cross-project IAM for spine topics (and AR/KMS); document the minimal shared surface for the BFSI package.
- If C: create spine topics and schemas in DIS; grant CM and Cortex cross-project publish/subscribe; document DIS as the spine owner and its availability dependency.
- Regardless of option: spine topics follow `spine.{event_type}.v{n}` (naming contract); cross-stack consumption is by name; repos stay separate with CODEOWNERS.

## References

- `docs/architecture/infra-shared-resource-register.md` (the discovery this ADR rests on)
- `docs/architecture/infra-naming-contract.md` (spine and cross-stack naming)
- `docs/runbooks/deploy-order.md`, `docs/runbooks/cm-infra-handoff.md`
- `docs/spec/v3/architecture-spec.md` sections 3 and 4; `docs/spec/v3/plan.md` section 1
- ADR-SCOPE-010, ADR-IDENTITY-001 (companion v3 re-baseline decisions)
