# ADR-INFRA-006: Workload Identity Federation Topology

**Status:** Accepted
**Date:** April 2026
**Deciders:** Amit (Sevyn8 engineering)
**Context documents:** P0.5 build prompt (v3.1)
**Companion decisions:** ADR-INFRA-002 (Terraform bootstrap, SA identity model, "no JSON keys" posture), ADR-INFRA-005 (Cloud SQL posture; Dev exception this ADR enables reverting), ADR-CI-001 (Cloud Build migration runner — first WIF consumer)

---

## Context

Phase B (P0.4) surfaced two limits of the current GCP-auth model:

- **Migration runner has no non-interactive path.** All migration access requires a human running `gcloud auth application-default login` to refresh ADC for `cloud-sql-proxy`. CI workflows have no way to authenticate without either (a) a long-lived service-account JSON key (rejected per ADR-INFRA-002), or (b) a federated identity that mints short-lived tokens on demand.
- **Dev public-IP exception (ADR-INFRA-005) cannot be reverted** until staging and prod can run migrations from inside the VPC. That requires Cloud Build (or equivalent in-VPC runner) which itself needs non-interactive GCP credentials.

Workload Identity Federation (WIF) closes both gaps. GitHub Actions exchanges its OIDC token for a short-lived GCP access token via a federated identity provider; no long-lived secrets traverse GitHub or sit in env vars. This ADR locks the WIF substrate; ADR-CI-001 is the first consumer (Cloud Build migration runner).

## Decision

**One WIF pool in `sevyn8-cortex-shared` with a single GitHub OIDC provider; per-env submit + worker service-account pairs in env projects, with the submit SA holding the `workloadIdentityUser` binding (attribute-conditioned per workflow file) and the worker SA reachable only via Cloud Build impersonation chain.**

Specifically:

1. **Single WIF pool: `cortex-github-pool` in `sevyn8-cortex-shared`.** One pool covering all envs. Per-env pools were the prior-session lean but rejected — a single pool with attribute-conditioned per-SA bindings is operationally simpler with equivalent security. The impersonation target is enforced by per-SA binding conditions, not by which pool issued the token.

2. **OIDC provider: `cortex-github-provider` for `github.com`.** Issuer `https://token.actions.githubusercontent.com`. Attribute mapping:
   - `google.subject` ← `assertion.sub`
   - `attribute.repository` ← `assertion.repository` (e.g., `rahul-1974/Cortex`)
   - `attribute.ref` ← `assertion.ref` (e.g., `refs/heads/main`)
   - `attribute.workflow_ref` ← `assertion.workflow_ref` (e.g., `rahul-1974/Cortex/.github/workflows/migrate-staging.yaml@refs/heads/main`)
   - `attribute.actor` ← `assertion.actor` (for audit visibility)

3. **Provider-level attribute condition: `assertion.repository == 'rahul-1974/Cortex'`.** A hard wall before SA-level checks. Even if a future SA's binding is misconfigured (omits the workflow attribute), the provider-level repo check still rejects token exchange from any external repo. Belt-and-suspenders.

4. **CI service accounts — separate submit + worker per env, plus a single test SA in shared.**

   Per env (`{env}` = `dev` | `staging` | `prod`):
   - `cortex-ci-submit-{env}@sevyn8-cortex-{env}.iam.gserviceaccount.com` — **submitter.** Receives the WIF binding; submits Cloud Build jobs specifying the worker SA as the build's runtime identity. Roles:
     - `roles/cloudbuild.builds.editor` (submit builds in the env project)
     - `roles/iam.serviceAccountUser` on `cortex-ci-migration-{env}` (authorize submissions that run as the worker)

   - `cortex-ci-migration-{env}@sevyn8-cortex-{env}.iam.gserviceaccount.com` — **worker.** Cloud Build runs AS this identity during the migration job. Roles on itself and inbound bindings:
     - `roles/cloudsql.client` (proxy connect to env's Cloud SQL)
     - `roles/secretmanager.secretAccessor` scoped to `cortex-db-postgres-break-glass-{env}` (fetch migration password)
     - Inbound binding: `service-<env-project-number>@gcp-sa-cloudbuild.iam.gserviceaccount.com` gets `roles/iam.serviceAccountTokenCreator` on this SA (lets Cloud Build assume the worker identity at build runtime — explicit and required, NOT implicit via `cloudbuild.serviceAgent`).

   Shared:
   - `cortex-ci-test-shared@sevyn8-cortex-shared.iam.gserviceaccount.com` — CI test workflow identity. Receives WIF binding for the test workflow. Roles: `roles/artifactregistry.reader` only. Tests don't need env-specific access; living in shared keeps blast radius minimal.

5. **`workloadIdentityUser` bindings — on submit SAs only, attribute-conditioned per `workflow_ref`.** For each `cortex-ci-submit-{env}` SA:

   ```hcl
   resource "google_service_account_iam_member" "wif_submit_<env>" {
     service_account_id = google_service_account.cortex_ci_submit.name
     role               = "roles/iam.workloadIdentityUser"
     member             = "principalSet://iam.googleapis.com/projects/<shared-project-number>/locations/global/workloadIdentityPools/cortex-github-pool/attribute.workflow_ref/rahul-1974/Cortex/.github/workflows/migrate-<env>.yaml@refs/heads/main"
   }
   ```

   Worker SAs (`cortex-ci-migration-{env}`) have **no** WIF binding — they are never directly impersonated by external principals. Their only inbound access is via the submit SA's `serviceAccountUser` grant (at build-submission time) and the Cloud Build service agent's `serviceAccountTokenCreator` grant (at build-runtime). The test SA (`cortex-ci-test-shared`) gets its own WIF binding restricted to `.github/workflows/ci.yaml@refs/heads/main` (or equivalent test workflow path).

6. **Per-`workflow_ref` binding as the in-repo security boundary.** Only the _exact_ workflow file at the _exact_ ref can federate into each SA. A `.github/workflows/leak.yaml` added by a malicious PR cannot impersonate any migration-submit SA — its `workflow_ref` doesn't match. PR runs of `migrate-staging.yaml` (which produce `workflow_ref` ending `@refs/pull/N/merge` instead of `@refs/heads/main`) also fail. This is the primary in-repo escalation control: PRs with write access to `.github/workflows/` cannot reach privileged SAs.

7. **Terraform layout.**
   - **New module:** `infra/terraform/modules/wif/` — pool + provider + provider attribute condition + outputs (pool resource name, provider resource name, project number).
   - **Shared root:** `infra/terraform/environments/shared/main.tf` instantiates the WIF module, creates `cortex-ci-test-shared` SA and its `workloadIdentityUser` binding.
   - **Env roots** (`dev`, `staging`, `prod`): each creates the submit + worker SA pair, grants the env-specific roles on each, grants the Cloud Build service agent's `serviceAccountTokenCreator` on the worker, and creates the `workloadIdentityUser` binding on the submit SA.

8. **Cross-state pool reference: hard-coded in env `terraform.tfvars`.** Env Terraform needs the shared pool's resource name (`projects/<shared-project-number>/locations/global/workloadIdentityPools/cortex-github-pool`). `data "terraform_remote_state" "shared"` considered for cleaner cross-state reads but rejected — pool rename is a one-time op, cross-state adds state-bucket reader IAM complexity, hard-coded tfvars is auditable in `git diff`. Document the binding format in CLAUDE.md so future maintainers know where to update if the pool is ever renamed.

9. **What WIF does NOT replace:**
   - Developer-laptop ADC (`gcloud auth application-default login`) for ad-hoc operations and Terraform applies. WIF is for non-interactive automation; humans still use ADC + SA impersonation.
   - Local `cloud-sql-proxy` on dev with break-glass password. Phase B's developer workflow stays as-is.
   - The Terraform-admin SA impersonation chain (`GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=cortex-tf-admin@...`). Operators still impersonate from their human gcloud creds.

## Rationale

- **Single shared pool over per-env pools.** Per-env pools mean 3 OIDC providers, 3 attribute-condition mappings, 3 issuer URLs to keep in sync. Same security posture (SA-level attribute conditions are the binding wall). Rejected three times the moving parts for no security gain.
- **Provider-level repo condition as defense-in-depth.** A misconfigured SA binding could conceivably omit the workflow attribute and accept tokens from any GitHub workflow on any repo. The provider-level `repository == 'rahul-1974/Cortex'` blocks that token exchange before SA-level checks are evaluated. Costs nothing, eliminates a class of misconfiguration risk.
- **Per-`workflow_ref` SA bindings.** GitHub's OIDC `workflow_ref` is `<repo>/<workflow-path>@<ref>` — the most specific identity attribute the assertion carries. Binding on it means PRs that add or modify workflow files cannot impersonate sensitive SAs. Less specific attributes (e.g., just `repository == ours` or just `ref == main`) leave room for in-repo escalation.
- **No SA keys, ever.** Cortex's posture from ADR-INFRA-002. WIF preserves it for automation.
- **Separate submit + worker SAs per env.** Submit authority (permission to create a Cloud Build job) and execute authority (permission to touch Cloud SQL and read the break-glass secret) are semantically different. Separating them:
  - Keeps the worker SA out of WIF entirely — no external principal directly impersonates it; the only impersonators are internal GCP principals (submit SA at build-creation, Cloud Build service agent at runtime). Removes it from the class of identities exposed to any external OIDC exchange.
  - Makes the audit trail explicit. Cloud Audit Logs show the submission event under the submit SA and every DB operation under the worker SA.
  - Avoids the "`serviceAccountUser` on self" self-reference that the single-SA-does-both variant requires. That pattern works but is the kind of construct that makes IAM reviewers squint.
  - Costs one extra SA per env (6 migration-related SAs across dev/staging/prod instead of 3). Operationally negligible.
- **Test SA single (shared), migration SAs per-env.** Test workflows have no env-specific access need; one SA in shared keeps binding surface minimal. Migration SAs need env-scoped roles (Cloud SQL client in that env project, Secret Manager reader on that env's break-glass secret); per-env scoping contains the blast radius of any binding mistake.

## Consequences

### Positive

- Migration runner can authenticate to GCP without operator ADC.
- All CI workflows are key-free.
- Per-`workflow_ref` SA binding is a meaningful in-repo security boundary — feature branches and PR-added workflows cannot impersonate migration-related SAs.
- Worker SAs never appear in WIF principal-set strings — their reach is strictly internal.
- ADR-INFRA-005 Dev exception becomes revertable: once Cloud Build (ADR-CI-001) runs migrations against staging + prod private IPs via WIF, dev's public-IP carve-out is unnecessary.

### Negative

- **6 migration-related SAs across 3 envs (3 submit + 3 worker)** instead of 3. Trivial at current scale; worth noting as SA inventory grows.
- **Cross-state coupling.** Env `terraform.tfvars` must carry the shared pool's resource name as a string. If shared's WIF pool is destroyed and recreated, env binding strings break until tfvars are updated. Mitigation: pool resource has `lifecycle { prevent_destroy = true }`.
- **GitHub-shaped today.** Provider configuration is specific to GitHub Actions OIDC. If Cortex ever moves CI to a different host, the provider needs reprovisioning. Acceptable — CI host is rarely changed.
- **IAM propagation delays.** Both `workloadIdentityUser` and `serviceAccountTokenCreator` bindings take ~30-60s to propagate. First impersonation attempts can fail even though bindings show in `gcloud`. Same class as ADR-INFRA-002 Quirk 1.
- **Verbose binding string.** The `principalSet://iam.googleapis.com/...` format is long and easy to mistype. Document in CLAUDE.md.

### Neutral

- WIF pool is a billable IAM resource; cost is pennies/month — negligible.

## Alternatives considered

1. **Per-env WIF pools (one in each of `sevyn8-cortex-{dev,staging,prod}`).** Triple the OIDC providers, attribute mappings, and issuer URLs. Same security as single-pool-with-conditions. Rejected for operational complexity.
2. **Service Account JSON keys in GitHub Secrets.** Standard in many CI setups. Rejected categorically per ADR-INFRA-002 "No downloaded JSON keys" — long-lived secrets exfiltrable via PR-injected workflow code, no fine-grained scoping, no audit trail beyond Secret Manager.
3. **Single CI SA per env that both submits and runs as itself (Option B').** Migration SA would hold `cloudbuild.builds.editor` + `iam.serviceAccountUser` on itself + `cloudsql.client` + `secretmanager.secretAccessor`. Simpler (one SA per env), but: (a) the worker SA sits directly in WIF, giving it external reach; (b) `serviceAccountUser on self` is a non-standard IAM pattern; (c) audit trail blurs submit and execution into one identity. Rejected — the extra SA per env is cheap, the separation is semantically correct.
4. **One CI SA per workflow** (even finer than per-env-per-purpose). Granular but multiplies SA count fast. Per-env submit + per-env worker + single shared test is granular enough for Phase 1; can split further if any SA accumulates too many roles.
5. **Cloud Build with GitHub App trigger (no GitHub Actions intermediation).** Tighter GCP integration; moves CI logic out of `.github/workflows/` into Cloud Build trigger config. Rejected — pipeline definitions in `.github/workflows/` are visible to PR reviewers; Cloud Build trigger config is GCP Console state, harder to review.
6. **`roles/iam.serviceAccountTokenCreator` instead of `roles/iam.workloadIdentityUser` for the WIF binding.** Different mechanism (operator delegation, not federation). Wrong tool for the WIF principal-set binding. Note: `serviceAccountTokenCreator` IS used in this ADR — for the Cloud Build service agent → worker binding, a different relationship.

## Implementation notes

- **Two IAM propagation quirks.** Both `workloadIdentityUser` (submit SA) and `serviceAccountTokenCreator` (Cloud Build service agent → worker SA) bindings take ~30-60s to propagate after creation. First impersonation typically fails with `Permission 'iam.serviceAccounts.getAccessToken' denied for resource ...` even though `gcloud iam service-accounts get-iam-policy` shows the binding. Wait + retry is the baseline. Same class as ADR-INFRA-002 Quirk 1 (PSA service-agent propagation race) and ADR-INFRA-005 Quirk 1 (Cloud SQL service agent materialization).
- **Two distinct "impersonation" roles on the worker SA.** Worth spelling out because they're easy to conflate:
  - `roles/iam.serviceAccountUser` on the submit SA — authorizes _submission_ of a build that runs as the worker.
  - `roles/iam.serviceAccountTokenCreator` on the Cloud Build service agent — authorizes _runtime token minting_ when the build actually executes.
    Both are required; neither is implicit; they're separate bindings.
- **Dev exception reversion (ADR-INFRA-005 → revertable).** ADR-CI-001's Cloud Build migration runner is the consumer that makes ADR-INFRA-005's dev public-IP exception revertable. Reversion sequence:
  1. ADR-CI-001 lands and runs migrations end-to-end against staging via WIF + private IP from inside the VPC.
  2. Same runner is verified against dev's private IP (no public-IP path).
  3. `environments/dev/main.tf` drops the `public_ip_enabled = true` + `authorized_networks` overrides.
  4. ADR-INFRA-005 amendment marked "reverted on <date>" with the new commit SHA.

  Until step 3 lands, the dev exception remains; until the WIF substrate (this ADR) lands, ADR-CI-001 cannot land.

- **Fail-closed posture.** If the WIF provider is misconfigured (wrong issuer, wrong attribute mapping, missing repo condition), GCP STS returns `Unauthenticated` and no access token is issued. The workflow fails at the `google-github-actions/auth` step with a clear error before any GCP API call. **Misconfiguration cannot leak credentials; it can only deny issuance.** Same applies to misconfigured SA-level bindings: a workflow with the wrong `workflow_ref` for a given SA fails at `iam.serviceAccounts.getAccessToken`. A missing Cloud Build → worker `serviceAccountTokenCreator` grant fails the build at runtime with `permission denied on service account`.
- **Token lifetime.** GCP federated tokens default to 1 hour, configurable down to 10 minutes. Phase B uses the default; can shorten for migration workflows once pipeline duration is empirically known.
- **Audit trail.** Every WIF token exchange logs to Cloud Audit Logs (`iam.googleapis.com/v1/sts.GenerateAccessToken`). The `assertion.actor` claim (the GitHub user who triggered the workflow) flows through to the impersonation event. Under the submit + worker split, build-creation events log under submit SA and build-step operations log under worker SA — forensic continuity from GitHub PR → submit → execute is preserved through the identity chain.
- **End-to-end validation (deferred to ADR-CI-001):** a `.github/workflows/migrate-staging.yaml` push to `main` successfully impersonates `cortex-ci-submit-staging`, submits a Cloud Build run configured to execute as `cortex-ci-migration-staging`, connects to staging Cloud SQL via Auth Proxy + `--private-ip` from inside the VPC, applies a no-op migration verification, exits 0. This validates the full chain: WIF token exchange, submit SA creates the build, Cloud Build service agent assumes worker identity, worker SA reads the break-glass secret and connects to Cloud SQL. Credentials never touch a developer machine.

## References

- ADR-INFRA-002 — Terraform bootstrap, SA identity model, "No downloaded JSON keys" posture.
- ADR-INFRA-005 — Cloud SQL posture; Dev exception to Decision 11 (this ADR enables its reversion).
- ADR-CI-001 — Cloud Build migration runner (first consumer of this WIF infrastructure).
- GCP Workload Identity Federation for GitHub Actions: https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines
- GCP Cloud Build custom service accounts: https://cloud.google.com/build/docs/securing-builds/configure-user-specified-service-accounts
- GitHub OIDC token claims (`workflow_ref`, `repository`, `actor`, etc.): https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect
