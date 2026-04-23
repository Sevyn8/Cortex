# ADR-CI-001: Cloud Build Migration Runner

**Status:** Accepted
**Date:** April 2026
**Deciders:** Amit (Sevyn8 engineering)
**Context documents:** P0.5 build prompt (v3.1)
**Companion decisions:** ADR-INFRA-005 (Cloud SQL posture; Dev exception this ADR makes revertable), ADR-INFRA-006 (WIF substrate consumed here), ADR-DB-001 / DB-002 / DB-003 (migration content subject to these)

---

## Context

P0.4 Phase B applied 4 migrations to dev Cloud SQL via a laptop-based workflow: operator runs `cloud-sql-proxy` with ADC, then `make db-migrate-dev` shells drizzle-kit against `127.0.0.1`. Staging and prod migrations were deferred because:

- Laptops can't reach Cloud SQL private IPs (no VPN, no IAP bastion).
- ADC is human-interactive; CI automation can't obtain it without OIDC federation.

ADR-INFRA-005 introduced a temporary dev public-IP exception to unblock Phase B. ADR-INFRA-006 landed the WIF substrate for non-interactive GCP auth. This ADR closes the loop: a **Cloud Build migration runner** that applies drizzle-kit migrations from inside the VPC, authenticated via WIF, triggered manually by an operator. Once verified, it replaces the laptop path for staging / prod and makes the dev public-IP exception revertable.

## Decision

**Per-env Cloud Build private worker pool peered to env VPC; single `migrate.yaml` config invoked from per-env GitHub Actions workflows that federate via WIF to submit builds running as the worker SA.**

Specifically:

1. **Cloud Build private worker pool per env.** `cortex-migration-runner` pool in each env project (`sevyn8-cortex-{dev,staging,prod}`), peered to that env's `cortex-vpc` via Service Networking. Jobs in the pool run inside the VPC with native routing to the env's Cloud SQL private IP (10.X.240.0/20 range). Private pool is the only Cloud Build topology that reaches private-IP Cloud SQL without additional infra (PSC, IAP bastion, VPN).

2. **`migrate.yaml` structure (single file, env-agnostic, substitution-driven).** Located at `infra/cloud-build/migrate.yaml`. Steps:
   - Fetch break-glass password from Secret Manager (worker SA holds `secretmanager.secretAccessor` on the scoped secret).
   - Install toolchain: Node 22 + pnpm + `cloud-sql-proxy` binary + psql client.
   - Start `cloud-sql-proxy --private-ip --port=5432 $_INSTANCE_CONNECTION_NAME` in background.
   - Poll liveness on `127.0.0.1:5432` (max ~30s).
   - `pnpm install --frozen-lockfile` + `pnpm db:migrate`.
   - Verification: `psql -c "SELECT count(*), max(created_at) FROM __drizzle_migrations"`.
   - Tear down proxy.
   - Options block: `pool.name` (env-scoped private pool), `region: asia-south1`, `logging: CLOUD_LOGGING_ONLY` (private-pool requirement).

3. **Manual trigger via `workflow_dispatch` — never auto on merge.** Operator clicks "Run workflow" in GitHub UI or uses `gh workflow run migrate-{env}.yaml`. Schema changes are deliberate operator decisions, not code-merge side effects.

4. **Substitution variables (GitHub Actions → Cloud Build):**
   - `_ENV` — `dev` | `staging` | `prod`.
   - `_INSTANCE_CONNECTION_NAME` — `sevyn8-cortex-{env}:asia-south1:cortex-{env}-postgres`.
   - `_SECRET_NAME` — `cortex-db-postgres-break-glass-{env}`.
   - The worker SA is passed separately via `gcloud builds submit --service-account=...` (not a substitution — GCP requires it as a flag).

5. **GitHub Actions wrapper: one workflow file per env.** `.github/workflows/migrate-{dev,staging,prod}.yaml`. Per-env file required by ADR-INFRA-006 Decision 6 — WIF `workloadIdentityUser` bindings are scoped to exact `workflow_ref` values, one per env. Each workflow:
   - `on: workflow_dispatch: {}` (manual only).
   - `permissions: id-token: write, contents: read` (required for WIF).
   - `google-github-actions/auth@v2` with the shared WIF provider + `cortex-ci-submit-{env}` SA.
   - `google-github-actions/setup-gcloud@v2`.
   - `gcloud builds submit --region=asia-south1 --config=infra/cloud-build/migrate.yaml --service-account=projects/sevyn8-cortex-{env}/serviceAccounts/cortex-ci-migration-{env}@... --substitutions=_ENV={env},_INSTANCE_CONNECTION_NAME=...,_SECRET_NAME=...`.
   - No GitHub Secrets; no hard-coded credentials; the only env-specific literals are the substitution values inside the workflow file.

6. **Region pin in two places.** `migrate.yaml` options block pins `region: asia-south1`. `gcloud builds submit --region=asia-south1` in the GitHub workflow. Missing either produces a confusing "pool not found" error when Cloud Build defaults to `us-central1`. Pin both — the flag and the config must agree.

7. **Failure handling — forward-only, drizzle-kit resume, PITR as last resort.**
   - **Mid-migration failure** (file N applies, file N+1 fails): drizzle-kit wraps each migration file in a single transaction (absent operations like `CREATE INDEX CONCURRENTLY` that can't be in a transaction; Phase 1 migrations use none). Failed file rolls back; `__drizzle_migrations` does NOT record it. Re-running the runner resumes from file N+1.
   - **Proxy / auth failure pre-migration**: build fails at liveness poll or at `pnpm db:migrate` connect. Zero DB state change. Safe to retry after root-cause.
   - **WIF / IAM propagation failure**: workflow fails at the `auth` step or at `gcloud builds submit`. Zero DB state change, zero Cloud Build invocation.
   - **Unrecoverable corruption** (partial DDL that can't roll back via transaction — should be impossible with Phase 1 migrations, but): PITR is the fallback per ADR-INFRA-005 Decision 5 (dev 1d / staging 3d / prod 7d retention). Out of scope for this ADR.
   - **No auto-rollback.** Schema rollback is Phase 2+ territory; Phase 1 is forward-only.

8. **What this ADR does NOT cover:**
   - Deploy pipelines for Cloud Run services (ADR-CI-002 or later, when the first service exists).
   - CI test workflow (`ci.yaml` with ephemeral pgvector Postgres). Documented in CLAUDE.md "CI conventions" when Phase A lands; not ADR-worthy.
   - Schema rollback mechanism.
   - Developer-laptop migration workflow (ADR-INFRA-005's Dev exception). Stays operational until this runner is validated against dev; then reverts.

9. **Revisit triggers:**
   - Phase 2 tenant traffic demands auto-migration-on-merge.
   - Multi-tenant sharding lands (runner per shard? Per region?).
   - Breaking schema change needs coordinated deploy + DB rollback path.
   - Cloud Build pricing changes make private pools untenable (revisit PSC-endpoint-on-Cloud-SQL alternative).

## Rationale

- **Private worker pool over default pool.** Cloud Build default pool can't reach private-IP Cloud SQL — it runs outside our VPC. Alternatives: PSC endpoint on Cloud SQL (requires Cloud SQL config change we haven't made), IAP bastion (adds a VM), or private pool. Private pool is the cleanest fit: one Terraform resource per env, native VPC peering, managed by GCP.
- **Manual trigger over auto-on-merge.** Schema changes have non-trivial rollback cost and irreversible semantics for some DDL (e.g., column drop). Forcing an operator to click "Run workflow" is a cheap safety valve. Auto-trigger can be revisited in Phase 2 when merge cadence picks up and schema-change review moves into PR discipline.
- **Workflow-per-env over one parameterized workflow.** ADR-INFRA-006 Decision 6 scopes WIF bindings to exact `workflow_ref` values. A single `migrate.yaml` with env as input would have a single `workflow_ref` and either bind to all 3 envs' submit SAs (over-broad) or require dynamic binding logic (doesn't exist). Per-env files give clean per-env bindings.
- **Cloud Build over GitHub-hosted runners.** GitHub-hosted runners can't reach private IPs without self-hosted runners inside the VPC — which means maintaining runner VMs, patching, scaling. Cloud Build private pool is GCP-managed and integrates natively with IAM and VPC peering.
- **Substitutions over per-env config files.** The `migrate.yaml` is identical across envs; only substitution values differ. One source of truth for the build definition; env-specific knobs live in the (narrow, audited) GitHub Actions workflow file.

## Consequences

### Positive

- Migrations run inside VPC with private-IP access — no credentials on developer machines, no SA keys, no public-IP exposure.
- ADR-INFRA-005 Dev exception becomes revertable once this runner is green on dev.
- Uniform pipeline across envs; operator workflow identical regardless of target.
- Cloud Logging provides a searchable audit trail: submit SA, worker SA, timestamp, substitutions, migration outcome.

### Negative

- **Private pool cost.** Private pools have per-minute billing with no free tier (~$0.03/vCPU-hour e2-medium equivalent). For weekly 5-minute migration runs across 3 envs, cost amortizes to a few dollars/month. Acceptable; revisit if cadence grows significantly.
- **Per-env infrastructure to maintain.** 3 private pools + 3 pool-to-VPC peerings + 3 workflow files. Terraform handles the first two; operational burden is maintaining 3 near-identical YAMLs in `.github/workflows/`.
- **Workflow-file duplication.** `.github/workflows/migrate-{dev,staging,prod}.yaml` are near-identical. Mitigation: document the template in CLAUDE.md "CI conventions"; a composite action could DRY it up in Phase 2.
- **Manual trigger adds human latency.** Migration ready Monday, nobody triggers = wait. Acceptable for Phase 1; revisit with release cadence.

### Neutral

- Region pin (`asia-south1`) means Cloud Build Console defaults to `us-central1` won't show the builds — operators must switch region in the console UI. Documented in CLAUDE.md "CI conventions" and in the runbook.

## Alternatives considered

1. **GitHub Actions runs migrations directly (no Cloud Build).** Requires GitHub-hosted runner or self-hosted runner to reach private IP. GitHub-hosted runners can't; self-hosted means maintaining runner VMs in VPC. Rejected — more infra, fewer benefits.
2. **Auto-trigger on merge to main.** Every merge that touches `services/foundation/migrations/` auto-applies. Rejected — schema changes should be a deliberate act, not a merge side-effect. Revisit in Phase 2.
3. **Cloud Run job instead of Cloud Build.** Cloud Run jobs run containers once on-demand. Simpler than Cloud Build in some ways, BUT lacks per-step logs, lacks the substitution/build-step ergonomics, and still needs a VPC connector to reach private IPs (same infra burden as the private pool). Rejected for observability.
4. **Terraform `null_resource` + `local-exec`.** Couples Terraform apply with DB mutation. Rejected — Terraform state and DB migration state are separate concerns with different ownership and rollback semantics; coupling makes blast radius larger.
5. **Bastion VM with cron.** Explicit compute to maintain (SSH, patching, monitoring, backups). Rejected — private pool is managed-service equivalent.
6. **PSC endpoint on Cloud SQL + Cloud Build default pool.** Would let the default pool reach private IP via PSC. Requires a PSC config on the Cloud SQL instance; also needs a PSC network endpoint in a VPC. Equivalent infra burden to private pool, plus changes Cloud SQL posture. Revisit if private-pool pricing becomes an issue.

## Implementation notes

- **`--private-ip` flag still required even from inside the VPC.** Cloud SQL Auth Proxy's default probe is for public IP regardless of where the proxy runs. Without `--private-ip`, the proxy errors out against staging / prod instances (ipv4_enabled=false) with `Config error: instance does not have IP of type "PUBLIC"`. Same quirk as ADR-INFRA-005 observation; applies to the Cloud Build case too.
- **IAM propagation first-run (ADR-INFRA-002 Quirk 1 pattern).** Both `workloadIdentityUser` (on submit SA) and `serviceAccountTokenCreator` (Cloud Build service agent → worker SA) bindings take ~30-60s to propagate. First run after Terraform lands may fail with `Permission 'iam.serviceAccounts.getAccessToken' denied`. Wait 60s, retry. ADR-INFRA-006 Impl Notes catalogs the same pattern.
- **Cloud Logging routing lag is a separate, longer wait.** When a new `roles/logging.logWriter` grant lands for a custom service account used in Cloud Build, IAM policy propagation (~30-60s) is NOT sufficient for step logs to flow. The routing path from Cloud Build → Cloud Logging → the `log_name='cloudbuild'` stream can take 2-5 additional minutes on first-ever-use of that SA. During this window, builds succeed silently with audit-only log entries. Second and subsequent builds using the same SA stream normally. Retry after ~5 minutes if first-use builds produce no step output despite the grant being in place.
- **Region pin in two places.** `migrate.yaml` options + `gcloud builds submit --region` flag. If the flag is omitted, `gcloud` uses the user/gcloud-config default (often `us-central1`), where our private pool doesn't exist; the submit fails with `workerPool projects/.../workerPools/cortex-migration-runner not found in region us-central1`. Always pin both.
- **Private pool logging constraint.** Private pools require `options.logging: CLOUD_LOGGING_ONLY`. Default pools support other values; private pools reject anything else. Forgetting this fails submission with `Invalid value for build.options.logging`.
- **Private pool PSA range allocation.** Cloud Build private pools peer to env VPC via Service Networking, requiring a dedicated PSA range separate from Cloud SQL's. Per-env allocation:

  | Env     | Cloud SQL PSA (existing) | Cloud Build PSA (new) |
  | ------- | ------------------------ | --------------------- |
  | dev     | `10.10.240.0/20`         | `10.10.224.0/24`      |
  | staging | `10.20.240.0/20`         | `10.20.224.0/24`      |
  | prod    | `10.30.240.0/20`         | `10.30.224.0/24`      |

  Sizing: /24 (256 IPs) accommodates the single Phase 1 pool with headroom for additional pools later. Ownership: the range is created in the networking module and added to the existing `google_service_networking_connection.psa.reserved_peering_ranges` list; the ci-runner module consumes the CIDR via the `cloudbuild_psa_range_cidr` input.

- **Private pool provisioning lead time.** First creation of a Cloud Build private worker pool can take 5–10 minutes as GCP provisions the tenant project and PSA peering on its side. Subsequent updates are fast. Don't abort `terraform apply` if it appears stuck on `google_cloudbuild_worker_pool.cortex_migration_runner` — check GCP Console for the pool's provisioning state before assuming a hang.
- **Custom migration builder image (future optimization).** First-pass `migrate.yaml` pulls `node:22-slim` and installs pnpm + proxy + psql per run (~30-60s setup cost). Optimization: bake a `cortex-apps/cortex-migration-runner:v1` image in Artifact Registry with the toolchain pre-installed. Deferred — not worth image-lifecycle overhead for Phase 1's low run frequency.
- **End-to-end validation sequence** (this is the deferred acceptance test referenced in ADR-INFRA-006 Impl Notes):
  1. WIF + private pool + CI SAs Terraform all applied across shared + 3 env roots.
  2. `gh workflow run migrate-staging.yaml` from `main` → workflow impersonates `cortex-ci-submit-staging` via WIF → submits Cloud Build → build runs in staging private pool → proxy connects to staging Cloud SQL private IP → `pnpm db:migrate` applies 0001-0004 to staging.
  3. Staging `__drizzle_migrations` shows 4 rows matching dev.
  4. Repeat for prod via `migrate-prod.yaml`; operator reviews the planned changes before triggering.
  5. Repeat for dev via `migrate-dev.yaml` — validates the runner against dev (dev already has the migrations from Phase B, so this is a no-op apply that verifies the runner path works against dev's private IP).
  6. Once step 5 is green, drop `public_ip_enabled = true` + `authorized_networks` from `environments/dev/main.tf`, commit, apply — reverts the ADR-INFRA-005 Dev exception.
- **Drizzle-kit migrate semantics for failure resume.** Each migration file runs in one Postgres transaction (drizzle-kit default). On failure, the entire file rolls back; `__drizzle_migrations` doesn't record it; the next run picks up from the failed file. One caveat: operations that can't run in a transaction (e.g., `CREATE INDEX CONCURRENTLY`, `VACUUM`) require migration-level escape hatches we haven't needed yet. When we do, document them per-migration in the SQL header.

### Observation — Private pool + CLOUD_LOGGING_ONLY requires explicit logWriter grant (P0.5 Phase 2B discovery)

Cloud Build private pools require `options.logging: CLOUD_LOGGING_ONLY` (other
logging modes are rejected). With custom service accounts impersonated via
`--service-account`, the worker SA must have `roles/logging.logWriter` on its
own project. Without it, the build submission succeeds with warning
"The service account running this build <SA> does not have permission to write
logs to Cloud Logging" — but NO step output is captured anywhere. Cloud Logging
queries for the build return zero entries. The build reports SUCCESS but the
operator has no visibility into what happened.

Surfaced in Phase 2B's first smoke test against dev: build reported SUCCESS but
all 4 identity/connectivity checks were unverifiable. IAM inspection showed the
worker SA held only cloudsql.client (project-level) and secretmanager.secretAccessor
(resource-level). Adding roles/logging.logWriter made subsequent builds fully
observable.

**Rule:** Any service account assuming runtime identity for a Cloud Build private
pool build must hold roles/logging.logWriter on its own project. The ci-runner
module now grants this; when extending this pattern (e.g., deploy pipelines in
Phase C), preserve the grant.

Cross-ref: ADR-INFRA-006 Decision 4 (worker SA role list).

### Observation — Custom SA + source-upload build requires storage.objectViewer (P0.5 Phase 2B discovery)

`gcloud builds submit` with source upload uploads the build tarball to the
auto-created `{project}_cloudbuild` GCS bucket before queueing the build.
With a custom service account (`--service-account=...`), that SA — not the
default Cloud Build SA — must read the object. Without the grant, submission
fails with `storage.objects.get denied` on the source object.

Bucket-scoped IAM would be stricter but introduces a chicken-and-egg
dependency: the `{project}_cloudbuild` bucket is lazily created by gcloud on
first use. Project-level `roles/storage.objectViewer` on the worker SA avoids
the ordering issue and is semantically appropriate for a build runner.

Surfaced in Phase 2B when migrate.yaml was first submitted with source upload
instead of `--no-source`. The earlier smoke test used `--no-source` so this
wasn't exercised until the real migrate run.

Cross-ref: ADR-INFRA-006 Decision 4 (worker SA role list).

### Observation — CRITICAL PROVIDER GAP: egress_option not in Terraform schema (P0.5 Phase 2B discovery)

**This is a known-silent-drift situation. Read before touching the migration runner.**

Cloud Build private pools default to `egressOption: NO_PUBLIC_EGRESS` when unset. This blocks outbound traffic to non-Google destinations (apt repos, npm registry, public container images). Private Google Access still routes Google services, which was sufficient for the smoke test but NOT for migrate.yaml's `apt-get install` and the cloud-sql-proxy download.

**Provider gap:** Terraform's `google_cloudbuild_worker_pool.network_config` block does NOT expose `egress_option` as of google provider 6.50.0 (both `google` and `google-beta`). The GCP API accepts the field; the Terraform provider does not surface it. Attempting to set it in Terraform fails validation: "An argument named `egress_option` is not expected here."

**Fix (out-of-band):**

```
gcloud builds worker-pools update cortex-migration-runner \
  --region=asia-south1 --project=sevyn8-cortex-<env> --public-egress
```

This state is NOT tracked by Terraform. `terraform plan` will NOT surface the deviation — the field is invisible to the provider.

**Coupled field: `no_external_ip`.** GCP's `--public-egress` gcloud flag flips both `egressOption` AND `no_external_ip` together. `NO_PUBLIC_EGRESS` requires `no_external_ip=true`; `PUBLIC_EGRESS` requires `no_external_ip=false`. The ci-runner module's `no_external_ip` value is declared explicitly in worker_config to match the PUBLIC_EGRESS posture — this is Terraform-managed. If the egress posture is ever reverted to `NO_PUBLIC_EGRESS` (via the pre-baked builder image trigger below), BOTH the gcloud egress flip AND the module's `no_external_ip = true` change must happen as one coherent operation.

**Disaster recovery implications:**

- `terraform destroy` then `terraform apply` will recreate the pool with GCP's default (`NO_PUBLIC_EGRESS`)
- migrate.yaml WILL FAIL after DR rebuild with the exact error seen in Phase 2B build `89e8dd7b` (`E: Unable to locate package curl` / `Package 'ca-certificates' has no installation candidate`)
- The out-of-band gcloud update MUST be re-run after any DR rebuild

**Required runbook entry:** Any project-rebuild runbook for Cortex must include re-running the gcloud egress-option update as a post-Terraform-apply step. See Makefile target `cloud-build-pool-configure-{env}`.

**Triggers for removing this drift:**

- **Option 1:** google provider exposes `egress_option` in a future release. Check provider changelog periodically; when available, add the field to the `ci-runner` module and re-plan. Terraform will see no change (field already set) and state is reconciled.
- **Option 2:** we build a pre-baked builder image (`cortex-apps/cortex-migration-runner:v1`) that eliminates the apt-get + public-registry dependencies. At that point, `NO_PUBLIC_EGRESS` is the correct posture and the gcloud out-of-band update is reverted.

**Concrete trigger for Option 2:** when a second Cloud Build config is added to `infra/cloud-build/` (ci.yaml for tests, or deploy pipelines). Pre-baked image amortizes across configs at that point.

## References

- ADR-INFRA-005 — Cloud SQL posture; Dev exception reverts when this runner is green on dev.
- ADR-INFRA-006 — WIF substrate (submit + worker SAs, principal-set bindings, Cloud Build service agent impersonation).
- ADR-DB-001 / DB-002 / DB-003 — migration content subject to these ADRs.
- GCP Cloud Build private pools: https://cloud.google.com/build/docs/private-pools/create-manage-private-pools
- GCP Cloud Build user-specified service accounts: https://cloud.google.com/build/docs/securing-builds/configure-user-specified-service-accounts
- Drizzle-kit migrate transaction semantics: https://orm.drizzle.team/docs/migrations
