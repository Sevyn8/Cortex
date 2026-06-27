# ADR-INFRA-003: VPC Topology — Per-Project Independent VPCs, asia-south1 Primary, DR Reserved

**Status:** Accepted
**Date:** April 2026
**Deciders:** Neerj (Sevyn8 engineering)
**Context documents:** Cortex v2.2 Spec §3 Infrastructure & Deployment, §6 Security & Compliance; P0.3 build prompt (v3.1)
**Companion decisions:** ADR-INFRA-002 (bootstrap), ADR-INFRA-004 (CMEK)

---

## Context

Cortex Phase 1 operates 3 workload environments (dev, staging, prod) plus two meta-projects (tfstate for Terraform state, shared for Artifact Registry). Each environment hosts a full data plane — future Cloud SQL, Pub/Sub, Cloud Run services, GKE workloads — and isolation between environments is compliance-relevant, not just hygienic.

Four forcing functions shape the network topology:

1. **Multi-tenant data plane.** Display Data is the first tenant; more follow. Tenant isolation happens at the application layer (RLS, per-tenant CMEK, tenant-scoped APIs). But infrastructure-layer isolation between _environments_ is a separate concern — a dev experiment must not touch prod data, and the blast radius of a misconfigured dev resource must stop at the dev VPC boundary.

2. **Future DR region (`asia-south2`).** Phase 1 is single-region (`asia-south1`, Mumbai). DR activation is Phase 2+ (P11.x). CIDR re-allocation after workloads land in production is expensive and error-prone; the DR ranges need to be reserved in the IP plan now even though no resources are provisioned there yet.

3. **Enterprise-tier compliance reviews.** Buyers will ask "what's your network topology?" in their security questionnaire. The answer needs to be legible in one diagram: which VPCs exist, what CIDR ranges they own, which egress paths are permitted, where the compliance region lives. Complex topologies (Shared VPC with many host/service projects, ad-hoc peerings) cost review cycles to explain.

4. **DPDP compliance region.** Organization-level policy pins `asia-south1` (Mumbai) as the primary region for Cortex infrastructure. The VPC plan must match.

The v3 P0.3 prompt scoped "per-project independent VPCs, single-region Phase 1, DR CIDRs reserved" without specifying the exact subnet plan, firewall posture, or the reasoning for rejecting Shared VPC. That is the design space this ADR closes.

## Decision

**Per-project independent VPCs (not Shared VPC). Single-region `asia-south1` for Phase 1. `asia-south2` DR CIDRs reserved in the IP plan but not provisioned. Default-deny egress with narrow explicit allows.**

Specifically:

1. **One VPC per env project.** `cortex-vpc` in each of `sevyn8-cortex-{dev,staging,prod}`. No VPCs in `sevyn8-cortex-tfstate` or `sevyn8-cortex-shared` — those projects host no workloads. `auto_create_subnetworks = false` on every VPC — no surprise default subnets.

2. **Per-environment /16 CIDR:** dev = `10.10.0.0/16`, staging = `10.20.0.0/16`, prod = `10.30.0.0/16`. Non-overlapping — future peering is trivially possible without re-IP.

3. **Four subnets per VPC** at derived offsets (where X = 10/20/30):
   - `cortex-subnet-compute` — `10.X.0.0/20` — workloads (GKE, VMs, Cloud Run via connector)
   - `cortex-subnet-data` — `10.X.16.0/20` — data-plane services
   - `cortex-subnet-connector` — `10.X.32.0/28` — Serverless VPC Access Connector (exclusive; /28 is the connector's required size)
   - PSA range — `10.X.240.0/20` — Private Service Access peering, consumed by Cloud SQL and similar managed services

4. **DR ranges reserved, not provisioned.** `asia-south2` DR subnets use the `+64` offset: `10.X.64.0/20` compute, `10.X.80.0/20` data, `10.X.96.0/28` connector. Documented in `modules/networking/locals.tf` as comments. **No resources created** — activation is P11.x.

5. **Routing mode `REGIONAL`** for Phase 1. Flipped to `GLOBAL` at DR activation. Change is in-place, no resource recreation.

6. **Private Google Access enabled on every subnet** — private-IP workloads reach GCP APIs without traversing public internet.

7. **Cloud NAT per VPC** with logging enabled and `min_ports_per_vm = 64` explicit. All egress that actually leaves the VPC is logged and NAT-translated.

8. **Serverless VPC Access Connector** at minimum size (2x e2-micro, max 3). Cloud Run → private resources flow through this.

9. **Five firewall rules per VPC** (see Firewall posture below).

## Subnet design rationale

| Subnet    | Size | Usable | Purpose                                                                                              |
| --------- | ---- | -----: | ---------------------------------------------------------------------------------------------------- |
| compute   | /20  |   4094 | GKE node pools, VMs, Cloud Run internal targets                                                      |
| data      | /20  |   4094 | Cloud SQL private IP consumption, future Memorystore, bulk data workloads                            |
| connector | /28  |     14 | Serverless VPC Access Connector — subnet must be /28, exclusive to the connector                     |
| PSA       | /20  |   4094 | Service Networking peering range for Cloud SQL private IP and similar PSA-consuming managed services |

**Why /20 for compute and data:** 4094 usable is far more than Phase 1 needs (tens of workloads max), but cheap headroom. /24 (254 usable) would be tight once GKE node pools scale; /22 is overkill and uses up low-offset ranges.

**Why /28 for connector:** the Serverless VPC Access Connector documentation requires exactly /28 and exclusive use (no other resources can consume IPs from this subnet). We allocate exactly that.

**Why /20 for PSA:** Cloud SQL private IP consumes ~/24 per instance at scale. /20 provides headroom for many instances across the env's lifetime. The PSA range sits at the high end of the /16 (`10.X.240.0/20`) so it's visually distinct from workload subnets.

**Why `+64` offset for DR:** leaves the `10.X.48.0/20` band unused — future use (e.g., a dedicated observability subnet, a quarantine subnet) without touching DR plans.

## Cloud NAT rationale

Every egress that leaves the VPC passes through Cloud NAT. Three reasons:

1. **Logging for compliance.** Cloud NAT logs every outbound connection with source subnet, dest IP, port, time. Required for audit evidence in Enterprise-tier compliance reviews.
2. **Predictable external IPs.** Upstream APIs (Anthropic, Resend, Auth0, future Kafka producers) may require IP allowlisting. NAT gives each VPC a stable set of NAT IPs to provide to upstream allowlists.
3. **Defense in depth.** NAT-only egress means workloads cannot accidentally receive inbound traffic from the internet — any public-IP config leak is self-contained because the VPC has no public-IP resources by default.

Configuration: `nat_ip_allocate_option = "AUTO_ONLY"` (auto-allocated IPs; switch to manual only when a specific upstream needs a pre-declared IP), `source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"`, `min_ports_per_vm = 64`, `log_config { enable = true, filter = "ALL" }`.

## Firewall posture

Five rules per VPC — intentionally minimal:

| #   | Name                              | Priority | Direction | Action | Protocol:Port    | Source / Dest                             |
| --- | --------------------------------- | -------: | --------- | ------ | ---------------- | ----------------------------------------- |
| 1   | `cortex-deny-all-egress`          |    65534 | EGRESS    | DENY   | all              | dest `0.0.0.0/0`                          |
| 2   | `cortex-allow-google-apis-egress` |     1000 | EGRESS    | ALLOW  | TCP:443          | dest `199.36.153.4/30`, `199.36.153.8/30` |
| 3   | `cortex-allow-https-egress`       |     1100 | EGRESS    | ALLOW  | TCP:443          | dest `0.0.0.0/0`                          |
| 4   | `cortex-allow-internal-ingress`   |     1000 | INGRESS   | ALLOW  | all              | src `10.X.0.0/16`                         |
| 5   | `cortex-allow-internal-egress`    |     1050 | EGRESS    | ALLOW  | TCP / UDP / ICMP | dest `10.X.0.0/16`                        |

- **Rule 1 overrides GCP's implicit `allow-all-egress` at priority 65535.** The default-deny is not a no-op.
- **Rule 2 uses the `restricted.googleapis.com` and `private.googleapis.com` ranges** — Google API traffic takes the Private Google Access path, avoiding NAT and egress cost.
- **Rule 3 is the open-internet hardening gap.** TCP:443 to `0.0.0.0/0` is the only outbound path to third-party APIs (Anthropic, Resend, Auth0 — all with dynamic IPs). Marked in code with a `TODO(P11.x)` comment enumerating hardening options (egress proxy, per-destination routing, Service Connect).
- **Rule 4 allows VPC-internal traffic.** GCP's implicit ingress deny-all at 65535 handles everything else.
- **Rule 5 allows VPC-internal egress within the env's /16.** Required for the Serverless VPC Access connector subnet (`10.X.32.0/28`) to reach Cloud SQL private IP (`10.X.240.0/20` PSA range) on TCP:3307 via the Cloud SQL Auth Proxy. Without it, rule 1's default-deny catches connector→PSA traffic before the proxy can establish.

### Decision/Observation: Rule 5 was added in F02 D.4 (2026-05-08)

The original posture published with this ADR contained four rules. F02 Slice D Sub-phase D.4 (`tenant-lifecycle-shared` — Cortex's first Cloud Run workload that talks to Cloud SQL via private IP through the connector) surfaced a structural gap: connector-egressed packets to the PSA range had no offsetting allow against the default-deny at 65534. Symptom: Cloud SQL Auth Proxy timed out at 10s; `/v1/tenants` returned 500. Cloud Build private-pool reach to the same Cloud SQL instance worked because the private-pool networking has its own egress path.

The diagnosis was confirmed by a temporary `cortex-allow-internal-egress-test` rule created via `gcloud` direct (priority 1050, dest `10.10.0.0/16`, protocols `tcp,udp,icmp`) — with it present, `/v1/tenants` returned 200; without it, 500. Rule 5 above is the declarative replacement for that temp rule, applied across all three envs in the same D.4 commit. See `docs/planning/cortex-deviations.md` row §F02 Slice D Sub-phase D.4 for the deviation entry.

**Not included in baseline** (added when consuming workloads land): IAP-SSH allow (add when first bastion or VM is provisioned), GCLB health-check allow (add when first load-balanced service deploys — `35.191.0.0/16`, `130.211.0.0/22`).

## Rationale

### Where Shared VPC would have won (and why we chose differently)

Shared VPC centralizes network administration: one host project owns the network, service projects attach to it. Benefits: a single network-admin team manages CIDRs/firewall/peering; cross-project network concerns are consolidated.

Accepted as real — at 10+ projects with a dedicated network team, Shared VPC is the right choice.

Rejected for Phase 1 because:

- Sevyn8 is 2–3 operators; there is no network-admin team to consolidate authority into.
- Blast radius of a misconfigured firewall in the host VPC would span every attached service project. Per-project VPCs keep a dev firewall mistake to dev.
- Setup complexity (host-project permissions, service-project attachments, org policy `constraints/compute.sharedReservedInstanceOwnerProjects`) is meaningful for an early-phase team. The operational saving Shared VPC offers is paid for at scale, not at Phase 1.

### Where default VPCs would have won

Nothing — default VPCs have open SSH/RDP allows from `0.0.0.0/0` and no egress controls. Rejected outright. Default VPCs are treated as non-operational in all Cortex projects; explicit deletion is queued (see auto-memory P0.3 follow-up, targeted for P0.5/P0.6).

### Where VPC peering from the start would have won

Peering solves cross-VPC communication. Cortex currently has no cross-env communication requirement — each env is self-contained. Peering today would be a solution without a problem. Non-overlapping CIDR allocation (dev=10.10, staging=10.20, prod=10.30) means peering is trivially layerable if the requirement emerges.

### What this decision is NOT

- NOT a commitment to single-region forever. DR (`asia-south2`) is an explicit Phase 2+ item with CIDR space already reserved. Activating DR flips `routing_mode` to `GLOBAL` and provisions the `+64` subnets; no re-IP.
- NOT a rejection of Shared VPC for the long term. It's a defer decision, with a specific revisit trigger (project count > ~6 or centralized network admin becoming a real need).
- NOT a complete firewall story. IP-allowlist hardening of the HTTPS egress (rule 3) is queued for P11.x. IAP-SSH and GCLB health-check allows are deferred to when consuming workloads land. The Phase 1 firewall is _minimal but correct_, not final.
- NOT the data-plane isolation story — that's tenant isolation (F01, AC01, per-tenant CMEK), which is application-level, not network-level. Network topology gives us environment isolation; tenant isolation is layered on top.

## Consequences

### Positive

- **Clean environment isolation.** A misconfigured firewall in dev doesn't spill into staging or prod. Each VPC has independent state, independent IAM, independent routing.
- **Non-overlapping CIDRs** future-proof peering. If cross-env communication is ever needed (e.g., a staging → prod data-copy pipeline for load tests with anonymized data), peering is a config change, not a re-IP.
- **Compliance posture is legible.** The topology answer is "three environment projects, one VPC each, no inter-VPC routing, all in asia-south1, DR reserved in asia-south2." One sentence. Security reviewers parse it quickly.
- **DR ready without re-IP.** Activating asia-south2 is mechanical when the time comes; no CIDR math under pressure.

### Negative

- **Three sets of identical firewall rules to maintain.** The `modules/networking` module parameterizes them so changes apply uniformly — one PR touches all envs — but each env re-applies independently.
- **No centralized network admin.** If Sevyn8 grows to a size where a dedicated platform-ops team would want one network config to manage, Shared VPC migration becomes a project.
- **Cross-env communication requires explicit peering.** Not hard in the future, but the ergonomic cost is non-zero: add `google_compute_network_peering_routes_config` resources, manage CIDR overlap (none today — good), manage firewall reach (Cortex's default-deny means peered traffic needs an allow rule).

### Neutral

- **Cloud NAT adds ~₹500/month per environment** (Phase 1 volumes). Acceptable cost for controlled, logged egress. Revisit if FinOps observability (OB02) flags egress cost as material.
- **VPC Connector at 2x e2-micro** is the minimum supported configuration. Upgrade to larger instance types or higher max-instance counts when S12 observability shows saturation (sustained throughput near e2-micro's ~250 Mbps cap, or queueing).
- **Default VPC still exists in each project.** No Cortex resources use it, but its open SSH/RDP allows remain a surface until the cleanup module (P0.5/P0.6) deletes it.

## Alternatives considered

### Alternative 1: Shared VPC with host + service projects

Rejected for Phase 1. See Rationale above. Revisit trigger: project count > 6 OR a dedicated network-admin function emerges on the team.

### Alternative 2: Default VPCs as-operational

Rejected outright. Default VPCs have `default-allow-ssh` from `0.0.0.0/0`, no egress controls, auto-subnet creation in every region. Every property is wrong for a compliance-oriented platform.

### Alternative 3: VPC peering from day one

Rejected for Phase 1. No current cross-env communication requirement. CIDR non-overlap means peering can be layered on later without re-IP.

### Alternative 4: Multi-region from day one (asia-south1 + asia-south2 both provisioned)

Rejected. No operational resources in asia-south2 today; subnets would be decorative. Defer provisioning to DR activation (P11.x). Reserve CIDR space in the documented plan so activation is mechanical.

### Alternative 5: Per-tenant VPCs

Rejected. Tenant isolation is an application-layer concern (F01 RLS, AC01 policies, per-tenant CMEK in F02). Network-layer tenant isolation doesn't match Cortex's multi-tenant-shared-infrastructure model; it would imply one VPC per tenant, which scales badly and doesn't match the product architecture.

## Implementation pattern

```
GCP Organization: sevyn8.com (395217984150)
│
├── sevyn8-cortex-dev (732341182091)
│   └── cortex-vpc                      (10.10.0.0/16)
│       ├── cortex-subnet-compute       (10.10.0.0/20)    + PGA, flow logs
│       ├── cortex-subnet-data          (10.10.16.0/20)   + PGA, flow logs
│       ├── cortex-subnet-connector     (10.10.32.0/28)   + PGA, flow logs
│       └── PSA range (VPC peering)     (10.10.240.0/20)
│
├── sevyn8-cortex-staging (1068369519814)
│   └── cortex-vpc                      (10.20.0.0/16)
│       └── <same structure as dev>
│
├── sevyn8-cortex-prod (1049927930827)
│   └── cortex-vpc                      (10.30.0.0/16)
│       └── <same structure as dev>
│
├── sevyn8-cortex-tfstate (501622945381) — no VPC (Terraform state only)
└── sevyn8-cortex-shared (242079866727) — no VPC (Artifact Registry only)

DR reserved (not provisioned — P11.x):
  asia-south2 subnets use +64 offset:
    compute   10.X.64.0/20
    data      10.X.80.0/20
    connector 10.X.96.0/28
```

Every VPC ships with: Cloud Router, Cloud NAT (AUTO_ONLY, min_ports_per_vm=64, log_config ALL), Serverless VPC Access Connector (e2-micro, min 2 / max 3), Private Service Access global address + service networking connection, and the 5 firewall rules.

## Implementation notes

- **Network resources applied without quirks in P0.3.** The PSA peering first-apply race is an IAM + Service Networking API quirk, not a topology quirk — documented in ADR-INFRA-002 Quirk 2.
- **VPC flow logs** enabled at `INTERVAL_5_MIN` / `flow_sampling = 0.5` / `INCLUDE_ALL_METADATA` on every subnet. Dev-appropriate defaults; consider per-env tuning before Display Data go-live (shorter interval and higher sampling for prod; S12 observability will surface log cost if excessive).
- **`google_compute_network_peering_routes_config` NOT configured on the PSA peering.** Default behavior (no custom route export or import) is what we want — Cloud SQL and other PSA-consuming services can reach the VPC; this VPC doesn't need to reach into GCP's service network.

## Revisit triggers

This decision should be revisited if any of the following happen:

- **Project count grows beyond ~6** — evaluate Shared VPC migration. The operational-saving-at-scale calculus flips.
- **DR activation in P11.x** — flip `routing_mode` to `GLOBAL`, provision the `+64` subnets in asia-south2, extend PSA to the DR region if Cloud SQL replicas go there.
- **Cross-env communication requirement emerges** — evaluate targeted peering (`google_compute_network_peering`) vs. reopening Shared VPC. Targeted peering is simpler if the cross-env case is narrow.
- **VPC connector saturation** — S12 observability reveals sustained connector throughput near limits. Scale via larger `machine_type` or higher `max_instances`.
- **Regulatory change affecting network topology** — e.g., a new data-residency rule requiring a second primary region, or a rule that forbids NAT egress. Would trigger a wholesale review.
- **Cloud NAT egress cost becomes material** — FinOps observability (OB02) shows NAT egress as a top-N spend line. Consider egress-proxy alternative or service-specific Private Service Connect.

## References

- Cortex v2.2 Spec §3 Infrastructure & Deployment, §6 Security & Compliance
- ADR-INFRA-002 — Terraform bootstrap (companion)
- ADR-INFRA-004 — CMEK key hierarchy (companion)
- P0.3 build prompt (cortex_build_prompts_v3.md §P0.3)
- `infra/terraform/modules/networking/` — implementation
- Google Cloud VPC documentation — https://cloud.google.com/vpc/docs/overview
- Cloud NAT documentation — https://cloud.google.com/nat/docs/overview
- Serverless VPC Access documentation — https://cloud.google.com/vpc/docs/configure-serverless-vpc-access
- Private Service Access documentation — https://cloud.google.com/vpc/docs/private-services-access
