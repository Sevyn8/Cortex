# Customer Master Infra Handoff (for Sanjeev)

Status: handoff note, not an instruction. Customer Master infrastructure (`ithina-retail-admin-infra`) is your swimlane and was NOT edited; this was a read-only review from the Cortex side. It records what the proposed common-platform model means for CM and what needs your decision.

## What was decided (proposed, needs your ratification)

ADR-INFRA-008 (`docs/architecture/decisions/ADR-INFRA-008-cross-product-infra-topology.md`) weighs three cross-product topology options: (A) converge Cortex, DIS, and CM onto one common platform project; (B) keep the three isolated projects and add a thin shared-services project for the spine (and optionally Artifact Registry and KMS); (C) keep three projects with the spine in DIS. It does not pick one, and the isolation-preserving options (B, C) are favored ahead of the BFSI review. It is Status: Proposed and requires your ratification at the Phase R / GR gate before any execution. Nothing migrates without your sign-off, and CM's own stack edits would be made by you, not by platform tooling.

## What the read-only review found in your stack

- CM is a self-contained stack in project `ithina-retail-admin` (dev), state backend `ithina-retail-admin-tfstate` (prefix `envs/dev`).
- It owns its own VPC (`ithina-retail-admin-vpc`, subnet `10.10.0.0/20`), Cloud SQL (`admin-master-dev`, PG15, db `ithina_platform_db`), Artifact Registry (`admin-images`), and service accounts (`admin-backend@`, `admin-frontend@`).
- It has NO `data` references to Cortex or DIS resources, and NO resources that duplicate a Cortex/DIS resource. Duplicate-risk: none.
- JWT key material lives on disk under `terraform/keys/`, not in KMS or Secret Manager-as-CMEK.

Contingency: ADR-INFRA-008 now weighs three options. Only option A converges CM into a common project. Under options B and C, CM stays its own project and simply consumes the shared spine (and optionally Artifact Registry and KMS) by cross-project IAM, with no migration and no VPC renumber. Treat the convergence framing below as contingent on the ADR outcome.

## What CM would consume by name (shared spine, and optionally AR/KMS)

If ADR-INFRA-008 is ratified, CM would, over time, consume from the common platform project by name (Terraform `data` sources / well-known names), never via `terraform_remote_state`:

- the common VPC and networking (CM keeps its own subnets within the renumbered plan);
- the common KMS keyring (for Secret Manager CMEK and JWT key storage);
- the common Artifact Registry (CM images published to a shared repo);
- the event spine topics (`spine.{event_type}.v{n}`) if/when CM publishes or consumes platform events;
- naming per `docs/architecture/infra-naming-contract.md`.

## Decisions that need you

1. Ratify or revise ADR-INFRA-008 (one common platform project, incremental convergence).
2. Service-account naming: the infra naming contract flags a conflict between `{product}-{service}` and the existing `<service-short-name>-runtime` pattern. CM already uses `admin-{backend,frontend}@`; your preference feeds the platform-wide choice.
3. The non-overlapping VPC address plan: CM's `10.10.0.0/20` overlaps Cortex per-env ranges; convergence needs a renumber you agree to.
4. CM Cloud SQL convergence (if and when): would be a dump/restore or DMS cutover that you own and schedule.

## References

- `docs/architecture/decisions/ADR-INFRA-008-cross-product-infra-topology.md`
- `docs/architecture/infra-shared-resource-register.md`
- `docs/architecture/infra-naming-contract.md`
- `docs/runbooks/deploy-order.md`
