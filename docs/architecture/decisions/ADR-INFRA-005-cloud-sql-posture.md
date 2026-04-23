# ADR-INFRA-005: Cloud SQL Posture — Postgres 17 Enterprise, Private IP, CMEK, Per-Env HA & Sizing

**Status:** Accepted
**Date:** April 2026
**Deciders:** Neerj (Sevyn8 engineering)
**Context documents:** Cortex v2.2 Spec §F01 §1.4 Data Model, §F03 Temporal Data Engine, §6 Security & Compliance; P0.3 build prompt (v3.1); P0.4 build prompt (v3.1)
**Companion decisions:** ADR-INFRA-002 (bootstrap), ADR-INFRA-003 (VPC topology), ADR-INFRA-004 (CMEK key hierarchy)

---

## Context

P0.3 landed the Cortex infrastructure substrate — projects, VPC, PSA, CMEK keyring, Artifact Registry — but deliberately stopped short of any workload-bearing resources. Cloud SQL was scoped to P0.4 because the database baseline (migration framework, bi-temporal helpers, RLS scaffolding) needs an actual instance to run against.

P0.4 therefore has two halves: **Phase A** closes the Cloud SQL infrastructure gap (this ADR); **Phase B** lands the migration framework, bi-temporal helpers, and RLS scaffolding against those instances (tracked separately).

Cortex's Phase 1 database posture needs to satisfy:

1. **Enterprise procurement expectations** — private IP only, CMEK, HA in prod, documented backups, PITR.
2. **DPDP data residency** — all instances in `asia-south1`, consistent with the rest of the GCP footprint.
3. **Display Data Phase 1 go-live scale** — single-region, single-instance-per-env, right-sized for a pre-revenue retail analytics workload, not speculative scale.
4. **Compatibility with F03 Temporal Data Engine requirements** — `pgvector` extension (for E01 embeddings, P0.4 Phase B enables via migration), bi-temporal columns, GiST range indexes, RLS.
5. **Cost discipline** — a small pre-revenue team cannot justify Cloud SQL Enterprise Plus (2–3× the price of Enterprise) or oversized instances when Phase 1 volumes don't need them.

Twelve architectural decisions close the P0.4 design. This ADR covers Decisions 1–6 and 11 (Phase A — Cloud SQL provisioning). Decisions 7–10 are captured in companion ADRs: ADR-STACK-003 (Drizzle ORM), ADR-STACK-005 (drizzle-kit migration tool), ADR-DB-001 (bi-temporal implementation), ADR-DB-002 (RLS contract), ADR-DB-003 (audit event SHA chain). Decision 12 (canonical-schema package structure) is documented in CLAUDE.md and the package README.

## Decision

**Single Postgres 17 Enterprise instance per env, private-IP only, CMEK-encrypted, HA on prod only, sized for Phase 1 workloads, pgvector-capable at the instance level.**

Specifically:

1. **Edition: `ENTERPRISE`, not Enterprise Plus.** Explicit `edition = "ENTERPRISE"` in Terraform — Postgres 16+ defaults to `ENTERPRISE_PLUS` which is ~2.5× the cost for features (data cache, Near-Zero Downtime maintenance) Phase 1 doesn't need. Revisit at commercial maturity, not before.

2. **Postgres 17.** `database_version = "POSTGRES_17"`. Latest GA major on GCP; brings B-tree deduplication, improved vacuum parallelism, and pgvector 0.8.1 availability.

3. **HA posture per env.**
   - dev / staging: `availability_type = "ZONAL"` — single zone, no standby.
   - prod: `availability_type = "REGIONAL"` — synchronous cross-zone replica, automatic failover.

4. **Instance sizing per env.**
   - dev / staging: `db-custom-2-8192` (2 vCPU, 8 GB RAM).
   - prod: `db-custom-4-16384` (4 vCPU, 16 GB RAM).
   - All envs: `disk_type = "PD_SSD"`, `disk_size = 20 GB`, `disk_autoresize = true`, `disk_autoresize_limit = 100 GB`.

5. **Backup and PITR per env.**
   - dev: 7 daily backups retained, 1 day PITR.
   - staging: 7 daily backups retained, 3 days PITR.
   - prod: 14 daily backups retained, 7 days PITR.
   - All envs: `start_time = "18:00"` (UTC = 23:30 IST, off-hours for India workloads).
   - All envs: `point_in_time_recovery_enabled = true` (requires binary logging).
   - Prod 14/7 values revised from an earlier "30 days" draft after a capacity/cost retrospective; restore-from-point-in-time of 7 days is enough for operational recovery, and full DR is covered by automated backups. Longer regulatory retention (1 year+) is a later-phase archival concern; approach (scheduled dumps to CMEK-encrypted GCS, BigQuery export, or Cloud SQL's Enhanced Backups feature) to be decided when an enterprise DPA requires it.

6. **`pgvector` supported at the instance level.** Cloud SQL Postgres 17 maintenance version used here ships `pgvector 0.8.1`. Extension creation is a P0.4 Phase B migration, not an instance-level Terraform concern — but Phase A validates availability via `SELECT ... FROM pg_available_extensions` against the provisioned instance before declaring Phase A complete.

7–10. **_(Reserved for Phase B subjects; see companion ADRs:)_**

- Migration-tool choice (ADR-STACK-005).
- ORM pairing (ADR-STACK-003).
- RLS session-variable contract (ADR-DB-002).
- Bi-temporal implementation (ADR-DB-001), audit-event SHA chain schema (ADR-DB-003) per Cortex v2.2 Spec §SCR-20-FR-009.

11. **Connection and networking.**
    - `ipv4_enabled = false` — no public IP, ever.
    - `private_network = <VPC self-link from P0.3 networking module>` — instance consumes the PSA peering range `10.X.240.0/20` allocated in P0.3 (dev: 10.10.240.0/20, staging: 10.20.240.0/20, prod: 10.30.240.0/20).
    - `database_flags`:
      - `cloudsql.iam_authentication = on` — IAM-based auth is the default path. The built-in `postgres` superuser exists at the instance level but has no password set in Phase A — IAM authentication is the only active auth path. Break-glass procedure (setting a password via `gcloud sql users set-password`, storing the generated value in Secret Manager under `cortex-db-postgres-break-glass-<env>`, and rotating after use) is documented in the Cloud SQL runbook; to be executed only when a specific incident requires superuser access.
      - `max_connections = 100` (dev / staging), `200` (prod).
    - **CMEK:** `encryption_key_name = <cortex-cloudsql-key in the same project's keyring>`. The Cloud SQL service agent (`service-<project_number>@gcp-sa-cloud-sql.iam.gserviceaccount.com`) gets `roles/cloudkms.cryptoKeyEncrypterDecrypter` on that specific key — grant declared in the env module adjacent to the instance, per ADR-INFRA-002 Quirk 5 (CMEK service-agent grant pattern).

12. **One instance per env, no read replicas in Phase 1.** Single writeable primary per env. Read-replica topology is a Phase 2 capacity decision once traffic warrants it; premature replicas add maintenance surface without measurable benefit.

### Dev exception to Decision 11 (P0.4 Phase B amendment, 2026-04-22)

To unblock laptop-based migration operations during Phase 1 build, dev overrides Decision 11's `ipv4_enabled = false` posture. Narrow, time-bounded, with explicit reversion plan.

- **What changes.** Dev: `ipv4_enabled = true` + `authorized_networks = [{ name = "amit-wsl-dev-migrations", value = "43.230.65.5/32" }]`. Staging and prod unchanged — both remain private-IP only per Decision 11.
- **Why.** Laptop → Cloud SQL private IP is not routable without VPN, IAP tunnel, or a VPC-resident bastion. Phase B scope did not include provisioning any of those. Cloud Shell was considered (runs inside Google's network, reaches private IPs natively) but rejected for developer-ergonomics reasons.
- **Safety.** Single authorized CIDR (/32) pinned to one operator's IP. Cloud SQL's default `ssl_mode = ENCRYPTED_ONLY` still applies; clients use `sslmode=require`. Private IP remains attached; future in-VPC services use it unchanged.
- **Reversion trigger.** When P0.5 Cloud Build lands a VPC-internal migration runner, the dev public IP becomes unnecessary. The `cloud-sql` module's `public_ip_enabled` defaults to `false`; reversion is a one-line edit in `environments/dev/main.tf` to drop the override.
- **Terraform shape.** Module gains two defaulted variables: `public_ip_enabled` (bool, default `false`) and `authorized_networks` (list of `{name,value}` objects, default `[]`). Added to `infra/terraform/modules/cloud-sql/{variables,main}.tf`. Dev env overrides both in `environments/dev/main.tf`. Staging and prod continue to call the module without overriding — defaults preserve original posture.

**Status update (2026-04-23):** Reverted after P0.5 Phase 2C delivered the VPC-internal migration runner (ADR-CI-001) and WIF-authenticated GitHub Actions dispatch (ADR-INFRA-006). Dev Cloud SQL now matches staging/prod private-IP-only posture. Migrations to dev flow via `migrate-dev.yaml` → Cloud Build private pool → private-IP connection, same as staging/prod. Laptop-direct access to dev Cloud SQL is no longer available; requires VPN/IAP/bastion if needed in future.

## Rationale

- **Enterprise edition vs Enterprise Plus.** The pricing delta (~2.5×) is material at a pre-revenue stage. Enterprise Plus's headline features — Data Cache, Near-Zero Downtime planned maintenance, 24/7/365 Premium Support — are infrastructure conveniences, not go-live blockers for a retail analytics workload of Display Data's Phase 1 size. Revisit when paid tenant count justifies it.
- **Postgres 17 over 16.** One-way door at this stage: picking 17 now avoids a major-version upgrade during Phase 1 build, and GCP's `POSTGRES_17` offering is stable (GA'd late 2024).
- **Private IP only.** Public IP on a database is a finding on every enterprise security questionnaire. `ipv4_enabled = false` closes that door at the resource level, not just via firewall.
- **Regional HA on prod only.** Regional instances cost ~2× zonal for the standby. dev and staging don't need it — downtime during a zonal incident is acceptable in non-prod, and the learning from experiencing it there is itself useful operational exposure.
- **20 GB starting disk with autoresize.** Phase 1 will not approach 20 GB of structured data; autoresize ceiling of 100 GB buys safety without premature allocation.
- **Backup retention 7/7/14 days.** Covers the rolling operational window where most "oh no" restores happen. Longer regulatory retention is a separate later-phase archival concern (see Decision 5).

## Consequences

### Positive

- Clear, cheap, compliant Phase 1 database posture.
- Each env pays for exactly what it needs; prod is the only regional instance.
- CMEK keys and PSA ranges already provisioned in P0.3 — Phase A is additive.

### Negative

- Edition upgrade to Enterprise Plus later requires a migration (instance-level attribute, not a flag). Accepted; migration path is documented by GCP.
- No read replicas means prod write primary is also the read primary. Fine for Phase 1 volume; Phase 2 adds replicas when analytics query load warrants it.
- `cloudsql.iam_authentication = on` means service accounts authenticate via short-lived tokens; application code must use the Cloud SQL Auth Proxy or IAM DB auth libraries. Phase B migration framework and services are built around this from day one.

### Neutral

- Backup window `18:00 UTC` is consistent across envs for operational simplicity.

## Alternatives considered

1. **Enterprise Plus on prod, Enterprise on dev/staging.** Rejected — mixed edition across envs makes prod a different animal to test against, defeats the "staging is prod-shaped" principle. If prod ever needs Plus, upgrade all three together.
2. **Single regional instance shared across envs, schema-per-env.** Rejected — violates the per-env-project isolation posture (ADR-INFRA-002). Blast radius of a noisy-neighbor incident would cross env boundaries.
3. **AlloyDB for Postgres.** Rejected for Phase 1 — higher floor cost, newer product, features (columnar accelerator) not needed until analytical workloads grow into it. Revisit at Phase 2+ if Cloud SQL becomes a bottleneck.
4. **Managed Postgres on a sibling CSP (AWS RDS / Azure Postgres).** Rejected — cross-cloud data egress, separate IAM surface, separate operational rota for a pre-revenue team. ADR-INFRA-002 commits Cortex to GCP primary; this ADR is consistent.

## Implementation notes

Two quirks and two observations surfaced during the P0.4 Phase A apply across dev, staging, and prod. Future modules that consume CMEK in fresh projects will likely hit Quirk 1; the remaining items are environmental or informational.

### Quirk 1 — Cloud SQL service agent materialization + IAM propagation race

The first dev apply failed on `google_kms_crypto_key_iam_member.cloudsql_cmek` with:

> `googleapi: Error 400: Service account service-<project_number>@gcp-sa-cloud-sql.iam.gserviceaccount.com does not exist., badRequest`

The `sqladmin.googleapis.com` API had been enabled in `project_baseline` during P0.3, but Cloud SQL's service agent is materialized lazily on first meaningful use, not at API-enable time. Adding `google_project_service_identity` (google-beta) forces eager materialization — but a CMEK grant issued in the same apply step still fails, because the identity resource's "create complete" signal precedes IAM-subsystem propagation of the agent's existence by roughly 30–60 seconds.

This is the same class as ADR-INFRA-002 Quirk 2 (PSA first-apply race): a create call succeeded, but an eventual-consistency side effect hasn't fully propagated.

**Resolution:** two-part fix in the module —

1. `google_project_service_identity.cloudsql` (google-beta) declares the agent and triggers its creation. Its `.email` and `.member` outputs are **not consumed** (those outputs are unreliable per ADR-INFRA-002 Quirk 1); the CMEK grant's member string is computed deterministically from `project_number` via a `data "google_project"` lookup.
2. `time_sleep.cloudsql_agent_propagation` (`hashicorp/time`, 60-second `create_duration`) sits between the identity resource and the CMEK grant. The grant has an explicit `depends_on` on the sleep, so it cannot fire until IAM has caught up.

With the fix in place, staging and prod applied cleanly on first attempt. The 60-second cost is paid once per fresh env project.

**Pattern for future modules:** any module that is the **first CMEK consumer** of a GCP service in a project — where "first consumer" means the service API is enabled but no resource of that service has ever been created — should include both a `google_project_service_identity` (google-beta) trigger and a short `time_sleep` wait before any IAM grant targeting the service's agent. Future candidates: Dataflow, Vertex AI, Eventarc. Modules whose native-resource creation itself triggers materialization (e.g., Pub/Sub creating a topic with inline CMEK) may be able to skip the explicit trigger, but declaring the identity resource anyway makes ordering robust.

### Quirk 2 — Transient GCS-backend state write failure during prod apply

The prod apply experienced a mid-apply network hiccup: after `google_project_service_identity.cloudsql` and `time_sleep.cloudsql_agent_propagation` landed successfully, Terraform attempted to persist state to `gs://cortex-tfstate-<suffix>/prod/default.tfstate` and failed with:

> `http2: client connection lost`
> `dial tcp: lookup storage.googleapis.com on 10.255.255.254:53: read udp ... i/o timeout`

The DNS resolver IP `10.255.255.254` is WSL2's built-in Linux-side forwarder; the failure was a one-second Windows-host DNS glitch, not a GCP or Terraform issue. Apply aborted, writing the up-to-date state to `errored.tfstate` locally.

**Resolution:** Terraform's documented recovery path.

1. Verify the local `errored.tfstate` is well-formed and contains the expected resources (JSON inspection).
2. `terraform state push errored.tfstate` — pushes the local state (aligned with GCP reality) to the GCS backend.
3. `rm errored.tfstate` — it's a recovery artifact, not committed to source control.
4. Fresh `terraform plan` shows only the resources the apply didn't reach (CMEK grant + instance + database in this case).
5. Apply the plan. The already-created resources are not re-created — Terraform sees them in state.

**Pattern for future operators:** a failed state write after successful resource creation is a known Terraform error mode. Never re-run `apply` without first reconciling state — a naive retry can leave backend state inconsistent with GCP reality (e.g., duplicate state entries, untracked resources). The `errored.tfstate` + `state push` recovery is idempotent and well-documented.

### Observation — `deletion_protection` has two distinct fields on `google_sql_database_instance`

The resource exposes both:

- Top-level `deletion_protection` — Terraform-side guard that blocks `terraform destroy`.
- `settings.deletion_protection_enabled` — GCP-side guard that blocks Console / gcloud / API deletion.

Initial dev apply set only the top-level field. Post-apply `gcloud describe` revealed `settings.deletionProtectionEnabled: false` — the GCP-side flag was defaulted to false, opening a Console-attack path.

**Fix:** added `deletion_protection_enabled = var.deletion_protection` inside the settings block. The single module variable drives both guards. Dev's post-discovery plan was a surgical one-field in-place update; staging and prod got both layers from first apply.

**Takeaway:** for defense-in-depth postures, verify that GCP-side and Terraform-side guards for the same concept are both set; don't assume one implies the other.

### Observation — Cloud SQL Postgres 17 Enterprise defaults to Cloud Storage for transaction logs

Older GCP documentation described `settings.transactionalLogStorageState` as `DISK` for Enterprise and `CLOUD_STORAGE` for Enterprise Plus. Our three Phase A instances — all Enterprise — all show `CLOUD_STORAGE`. PITR and retention behave identically regardless of storage location; no action needed. This appears to be a recent GCP default change on Postgres 17 maintenance versions (`POSTGRES_17_9.R20260319.00_02` observed across all three envs). Note here for future operators who encounter older reference material.

### Observation — Cloud SQL Auth Proxy ADC is separate from `gcloud` CLI auth

Cloud SQL Auth Proxy authenticates to `sqladmin.googleapis.com` via Application Default Credentials (ADC), not via the `gcloud` CLI's own credential store. A fresh `gcloud auth login` does NOT refresh ADC — you must run `gcloud auth application-default login` explicitly. On Google Workspace domains with reauth policies, the ADC's RAPT (Reauth Proof Token) can expire independently of the CLI's refresh token.

Two diagnostic details:

- **Proxy startup ≠ per-connection capability.** The proxy's `Listening / ready for new connections!` banner validates that ADC exists, but the per-client-connection call to `sqladmin.googleapis.com` happens lazily. If the RAPT expires between proxy startup and the first client connect, every connection fails with `oauth2: invalid_grant "invalid_rapt"` in the proxy log.
- **Client-side error is misleading.** When the proxy can't reach the upstream API, client connections get `server closed the connection unexpectedly` — which looks like an instance-side issue, not a proxy-upstream issue.

**Debugging rule:** when psql / drizzle-kit reports connection errors to 127.0.0.1, check the proxy's terminal output first. That's where the real error surfaces.

**Fix:** `gcloud auth application-default login` (separate from `gcloud auth login`). For CI and production workflows, Workload Identity Federation replaces ADC entirely — the developer-laptop path is inherently short-term; P0.5 CI takes over.

### Observation — `--private-ip` flag required for Cloud SQL Auth Proxy on private-only instances

Cloud SQL Auth Proxy defaults to probing the instance's public IP. Instances with `ipv4_enabled = false` (Phase 1 staging / prod per Decision 11) cause the proxy to log `Config error: instance does not have IP of type "PUBLIC"` and drop client connections at the TCP accept step.

**Fix:** pass `--private-ip` to the proxy CLI:

```
cloud-sql-proxy sevyn8-cortex-<env>:asia-south1:cortex-<env>-postgres --private-ip --port=5432
```

**Caveat.** `--private-ip` resolves the _configuration_ error but not the _network reachability_ problem. The proxy still needs a routable path to the instance's private IP (`10.X.240.X` in Cortex's PSA ranges). From outside the VPC (e.g., a developer laptop on a home ISP), this requires VPN, IAP tunnel, Cloud Shell, or a VPC-resident bastion. Phase B resolved this for **dev** via the public IP exception (see Dev exception to Decision 11); staging and prod will use a VPC-internal runner once P0.5 Cloud Build lands — `--private-ip` stays useful there because the runner will sit inside the VPC.

## References

- Cortex v2.2 Spec §F01 §1.4 Data Model — control-plane schema tables.
- Cortex v2.2 Spec §F03 Temporal Data Engine — bi-temporal requirements consumed by the instance.
- Cortex v2.2 Spec §6 Security & Compliance — CMEK, at-rest encryption, private networking.
- `ADR-INFRA-002-terraform-bootstrap.md` — SA identity model, bootstrap KMS keys, CMEK grant pattern (Quirk 5).
- `ADR-INFRA-003-vpc-topology.md` — PSA range allocations (10.X.240.0/20), VPC per env.
- `ADR-INFRA-004-cmek-key-hierarchy.md` — `cortex-cloudsql-key` inventory (keys #1, #6, #11 in the hierarchy table).
- GCP Cloud SQL Postgres editions: https://cloud.google.com/sql/docs/postgres/editions-intro
- GCP Cloud SQL PITR: https://cloud.google.com/sql/docs/postgres/backup-recovery/pitr
