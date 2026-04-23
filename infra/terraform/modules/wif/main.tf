# ─────────────────────────────────────────────────────────────────────────────
# wif — Workload Identity Federation pool + GitHub OIDC provider.
#
# Per ADR-INFRA-006: single pool in shared, single OIDC provider for github.com,
# attribute_condition restricts to one repo. Per-SA bindings (workloadIdentityUser
# + serviceAccountTokenCreator + serviceAccountUser) live in consuming env roots,
# not in this module.
# ─────────────────────────────────────────────────────────────────────────────

# Project lookup — for project_number, used in the convenience principalSet base
# output (consumers compose member strings off it).
data "google_project" "this" {
  project_id = var.project_id
}

# ─── Workload Identity Pool ─────────────────────────────────────────────────
# Pool deletion enters a 30-day soft-delete during which the pool ID cannot be
# reused. prevent_destroy guards against accidental teardown via terraform destroy.
resource "google_iam_workload_identity_pool" "cortex_github" {
  project                   = var.project_id
  workload_identity_pool_id = var.pool_id
  display_name              = var.pool_display_name
  description               = var.pool_description

  lifecycle {
    prevent_destroy = true
  }
}

# ─── OIDC Provider for GitHub Actions ───────────────────────────────────────
# attribute_mapping extracts claims from GitHub's OIDC token into attributes
# consumed by per-SA principalSet bindings (ADR-INFRA-006 Decisions 2, 5, 6).
# attribute_condition is the provider-level repo restriction — defense in depth
# before per-SA condition checks (ADR-INFRA-006 Decision 3).
resource "google_iam_workload_identity_pool_provider" "cortex_github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.cortex_github.workload_identity_pool_id
  workload_identity_pool_provider_id = var.provider_id
  display_name                       = var.provider_display_name

  attribute_mapping = {
    "google.subject"         = "assertion.sub"
    "attribute.repository"   = "assertion.repository"
    "attribute.ref"          = "assertion.ref"
    "attribute.workflow_ref" = "assertion.workflow_ref"
    "attribute.actor"        = "assertion.actor"
  }

  attribute_condition = "assertion.repository == '${var.repo_full_name}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
    # No allowed_audiences — defaults to the provider's resource name, which is
    # what google-github-actions/auth@v2 sends by default.
  }
}
