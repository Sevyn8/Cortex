# Infrastructure Shared-Resource Register (June 2026)

Status: discovery record backing ADR-INFRA-008. Read-only inventory of the three live Terraform stacks (Cortex, DIS, Customer Master), produced to answer: which resources are foundation-grade, which stack owns each, which stacks reference each, and whether any resource is defined in more than one stack.

## Headline finding

The three products are fully self-contained Terraform stacks, each in its own GCP project, each with its own state backend. There are zero cross-stack references and zero duplicated resources. Cross-project resource migration is therefore impossible by Terraform state move, and there is nothing currently shared to centralize. This is the basis for ADR-INFRA-008 (converge on one common platform project incrementally).

## Per-stack foundation inventory

| Layer                   | Cortex (this repo)                                                 | DIS (ithina-retail-dis)                                                                                                                                        | Customer Master (ithina-retail-admin-infra)                          |
| ----------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| GCP project(s)          | sevyn8-cortex-{dev,staging,prod,shared,tfstate}                    | ithina-retail-dis (staging only)                                                                                                                               | ithina-retail-admin (dev only)                                       |
| State backend bucket    | cortex-tfstate-5402eb (prefixes dev/staging/prod/shared/tfstate)   | sevyn8-tfstate (prefix dis/staging)                                                                                                                            | ithina-retail-admin-tfstate (prefix envs/dev)                        |
| State backend project   | sevyn8-cortex-tfstate                                              | ithina-retail-dis                                                                                                                                              | ithina-retail-admin                                                  |
| Region                  | asia-south1                                                        | asia-south1                                                                                                                                                    | asia-south1                                                          |
| VPC                     | cortex-vpc (per env)                                               | dis-vpc                                                                                                                                                        | ithina-retail-admin-vpc                                              |
| Subnets (CIDR)          | compute/data/connector per env (10.10/10.20/10.30.0.0/20 families) | dis-subnet 10.20.0.0/24, connector 10.8.0.0/28                                                                                                                 | gke-subnet 10.10.0.0/20 (+ secondary 10.20.0.0/16, 10.30.0.0/20)     |
| KMS                     | cortex-keyring + cortex-tfstate-keyring, 17 keys (bootstrap)       | none in Terraform                                                                                                                                              | none (JWT keys on disk under terraform/keys/)                        |
| Artifact Registry       | cortex-apps, cortex-agents, cortex-mcp (shared project)            | dis-images                                                                                                                                                     | admin-images                                                         |
| Pub/Sub                 | none yet (cortex-pubsub-key reserved)                              | 7 internal topics (csv.received, ingress.ready, ingress.resubmit, identity.changed, mapping.changed, quarantine, pipeline.dlq) + 7 subs; not an external spine | none                                                                 |
| Cloud SQL               | cortex-{dev,staging,prod}-postgres (PG17)                          | dis-pg (PG16, db ithina_dis_db)                                                                                                                                | admin-master-dev (PG15, db ithina_platform_db)                       |
| GCS buckets             | cortex-{env}-tenant-data; cortex-tfstate-5402eb                    | dis-bronze-staging, dis-upload-staging, dis-onboarding-staging-staging                                                                                         | tfstate only                                                         |
| DNS                     | none in Terraform                                                  | none                                                                                                                                                           | none                                                                 |
| Service-account pattern | <service-short-name>-runtime; cortex-<purpose>-admin               | dis-{service}@ (6 SAs)                                                                                                                                         | admin-backend@, admin-frontend@                                      |
| Cross-stack data refs   | n/a                                                                | zero references to Cortex or CM                                                                                                                                | zero references; agent verdict "self-contained, duplicate-risk NONE" |

## Disposition per foundation resource class

Because no resource is shared or duplicated today, the disposition is uniform: every resource currently STAYS with its owning stack. There is nothing to move cross-stack now. The "Target under ADR-INFRA-008" column below reflects option A (one common platform project) and is CONTINGENT on the ADR outcome: ADR-INFRA-008 weighs options A, B, and C, and under options B or C the existing resources stay in place and only the spine (and optionally Artifact Registry and KMS) becomes shared, via a thin shared-services project (B) or the DIS project (C). The classes and their option-A target:

| Resource class                                  | Current owner(s)                             | Target under ADR-INFRA-008                               | Duplicate today?                             |
| ----------------------------------------------- | -------------------------------------------- | -------------------------------------------------------- | -------------------------------------------- |
| GCP project / project-services                  | each product, own project                    | common platform project                                  | no                                           |
| VPC / networking                                | each product, own VPC (overlapping CIDRs)    | one common VPC (requires renumber)                       | no (but CIDRs overlap, blocking naive merge) |
| KMS keyring / keys                              | Cortex only                                  | common project KMS                                       | no                                           |
| Artifact Registry                               | each product, own repo                       | common Artifact Registry                                 | no                                           |
| Event spine (Pub/Sub + schemas)                 | none cross-product (DIS has internal topics) | common project spine (spine.{event_type}.v{n})           | no                                           |
| DNS                                             | none in Terraform                            | common project DNS                                       | no                                           |
| Terraform state bucket                          | three separate buckets                       | one common backend (per-stack prefixes)                  | no                                           |
| Cloud SQL / GCS / secrets / SAs (service layer) | each product                                 | converge into common project at cutover (data migration) | no                                           |

## Notes

- DIS has 10 Terraform modules, not the ~18 the session assumed; it manages no KMS, no DNS, and no external spine topic.
- The DIS repo forbids AI / Co-Authored-By trailers (its CLAUDE.md) and uses `make check` as its pre-commit gate; no husky / commitlint. Relevant only if future work touches that repo.
- This register is a point-in-time read; re-run discovery before any convergence cutover.
