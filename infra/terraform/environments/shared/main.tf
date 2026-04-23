# ─────────────────────────────────────────────────────────────────────────────
# environments/shared — Cortex shared plane.
#
# Hosts Artifact Registry for all environments. No workloads, no networking,
# no observer SA (platform observability is a per-env concern; shared is just
# the artifact plane).
# ─────────────────────────────────────────────────────────────────────────────

# Project lookup — present for symmetry with env roots (makes future additions
# that need project_number trivial).
data "google_project" "current" {
  project_id = var.project_id
}

# ─── Project-baseline APIs ──────────────────────────────────────────────────
# cloudkms is already enabled by bootstrap; re-declaring here is idempotent
# and keeps the shared root's API set declarative and self-contained.
# containeranalysis activates project-wide vulnerability scanning that AR
# repositories automatically use.
module "project_baseline" {
  source     = "../../modules/project-baseline"
  project_id = var.project_id

  activate_apis = [
    "artifactregistry.googleapis.com",
    "cloudkms.googleapis.com",
    "containeranalysis.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
  ]
}

# ─── CMEK grant: Artifact Registry service agent gets encrypt/decrypt on the CMEK key ──
# Without this, repository creation fails with a cryptic CMEK permission error.
# The AR service agent was materialized when artifactregistry.googleapis.com was
# enabled (via project_baseline). Its email follows a deterministic format keyed
# on project number — computed here rather than looked up via
# google_project_service_identity (which has a null-email quirk; see ADR-INFRA-002).
# Pattern: any env introducing a CMEK-requiring GCP service adds its service-agent
# grant in the env's root module. Bootstrap is for root-of-trust primitives only.
resource "google_kms_crypto_key_iam_member" "artifactregistry_cmek" {
  crypto_key_id = var.kms_key_id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-artifactregistry.iam.gserviceaccount.com"

  depends_on = [module.project_baseline]
}

# ─── Artifact Registry — 3 Docker repos with CMEK and cross-env reader IAM ──
module "artifact_registry" {
  source = "../../modules/artifact-registry"

  project_id = var.project_id
  location   = var.region
  kms_key_id = var.kms_key_id

  repositories = [
    {
      repository_id = "cortex-apps"
      description   = "Application containers — api-gateway, admin-console, analytical, dis-worker."
    },
    {
      repository_id = "cortex-agents"
      description   = "Ithina agent containers — planogram, pac, promotion, perishable."
    },
    {
      repository_id = "cortex-mcp"
      description   = "MCP server containers — mcp-cortex-core, mcp-edge, mcp-admin-ops."
    },
  ]

  reader_members = [for email in var.env_tf_admin_emails : "serviceAccount:${email}"]

  common_labels = var.common_labels

  depends_on = [
    module.project_baseline,
    google_kms_crypto_key_iam_member.artifactregistry_cmek,
  ]
}

# ─── Workload Identity Federation — GitHub Actions OIDC pool + provider ──
# Per ADR-INFRA-006: single pool in shared, single OIDC provider for github.com,
# attribute_condition restricts token exchange to the Cortex repo.
# Per-SA bindings live in consuming env roots (dev/staging/prod), not here.
module "wif" {
  source = "../../modules/wif"

  project_id     = var.project_id
  repo_full_name = "rahul-1974/Cortex"

  # Module defaults used for pool_id (cortex-github-pool),
  # provider_id (cortex-github-provider), and display names.
}
