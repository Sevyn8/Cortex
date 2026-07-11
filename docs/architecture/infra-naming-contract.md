# Infrastructure Naming Contract (target-state)

Status: target-state, pending ratification of ADR-INFRA-008 (single shared platform project). Until then, the existing per-product conventions in `docs/claude/naming-conventions.md` remain in force; this document defines the names the common-platform era will use and flags where it diverges from today's conventions (divergences are raised for the operator to resolve, not silently overridden).

Migration note: this file is platform-wide and language-neutral. It migrates to the `sevyn8/contracts` repo when Phase R creates it (per `docs/spec/v3/plan.md`). While it lives here it is the single source of truth for cross-stack naming.

Contingency: the spine namespace `spine.{event_type}.v{n}` and the cross-stack consumption rule apply regardless of the topology chosen in ADR-INFRA-008. Where the spine lives (a common project under option A, a thin shared-services project under option B, or the DIS project under option C) is the ADR-INFRA-008 decision. Any naming detail below that presumes one common project is contingent on option A.

## Cross-stack consumption rule

- Cross-stack consumption is by NAME via Terraform `data` sources (and, for runtime, by URL or by resolving a well-known name). Never `terraform_remote_state`. This matches `docs/spec/v3/architecture-spec.md` section 3 and the v3 invariant.
- Breaking renames happen only at phase-gate boundaries. Additive names (new topics, new secrets, new repos) may land anytime.

## Naming rules

### Event spine (Pub/Sub)

- Topic: `spine.{event_type}.v{n}` where `{event_type}` is the canonical event name (dotless segments joined by dots, e.g. `lead.scored`, `fact.superseded`) and `{n}` is the schema major version.
- Each topic has a registered JSON Schema named to match; producers SHALL NOT publish unregistered versions (architecture-spec C2).
- Note (divergence to resolve): DIS today uses internal, unversioned topic names (`csv.received`, `ingress.ready`, `pipeline.dlq`). Those are DIS-internal pipeline topics, not the cross-product spine. The spine namespace `spine.*` is additive and does not rename DIS internal topics; whether any DIS topic graduates to the spine is a Phase R decision.

### Service accounts

- Proposed common-platform pattern: `{product}-{service}@{project}.iam.gserviceaccount.com` (for example `dis-streaming-consumer@`, `cortex-planogram@`, `cm-backend@`).
- DIVERGENCE FROM EXISTING CONVENTION (flag for operator): `docs/claude/naming-conventions.md` defines runtime SAs as `<service-short-name>-runtime` (e.g. `planogram-runtime`) and cross-project admin SAs as `cortex-<purpose>-admin`, explicitly with NO product/module prefix on runtime SAs. The proposed `{product}-{service}` pattern adds a product prefix, which the existing convention forbade when there was one project per product. In a single shared platform project the product prefix becomes useful for disambiguation. These two conventions conflict; do not adopt `{product}-{service}` platform-wide until the operator chooses one. DIS already uses `dis-{service}@` and CM uses `admin-{backend,frontend}@`, so the product-prefix pattern is already partly in the estate.

### Secrets (Secret Manager)

- Keep the existing `cortex-<category>-<specific-name>` shape for Cortex; generalize to `{product}-<category>-<specific-name>` in the shared project so categories stay legible across products (categories per `docs/claude/naming-conventions.md`: auth, ai, email, db, webhook, integration, tenant-<id>, app).
- Strict per-env separation is retained. CMEK via the common keyring.

### GCS bucket prefixes

- Object-key isolation stays `tenants/{tenantId}/{...}` (unchanged; encryption-blob-storage convention).
- Bucket names: `{product}-{env}-{purpose}` (e.g. `cortex-prod-tenant-data`, `dis-bronze-{env}`). The state bucket is a single common backend with per-stack prefixes (e.g. `foundation/`, `cm/`, `dis/{env}`, `cortex/{env}`).

### Artifact Registry repositories

- `{scope}-{purpose}` in the common project (e.g. `cortex-apps`, `cortex-agents`, `cortex-mcp`, `dis-images`, `admin-images`). Repos are additive; image tagging rules are unchanged from `docs/claude/naming-conventions.md` (floating dev/staging/prod, semver, immutable sha- tags).

## Open items for ratification

1. Service-account pattern: `{product}-{service}` (this doc) vs `<service-short-name>-runtime` (existing). Pick one platform-wide.
2. Common project id and the non-overlapping VPC address plan (ADR-INFRA-008 prerequisite).
3. Which, if any, DIS internal topics graduate into the `spine.*` namespace.
