# ─────────────────────────────────────────────────────────────────────────────
# artifact-registry — create N Docker repositories with CMEK, cleanup policies,
# vulnerability scanning, and a parametric reader-member IAM grant.
#
# One registry plane for all envs (shared project). Environment isolation is
# enforced at the IMAGE level — images tagged :dev, :staging, :prod are pulled
# by the respective env's runtime SAs. This module does not model env-scoped
# IAM on specific tags; Cloud Run's role bindings gate who deploys what.
# ─────────────────────────────────────────────────────────────────────────────

# Flatten repositories list into a map keyed by repository_id for for_each.
locals {
  repos_by_id = { for r in var.repositories : r.repository_id => r }

  # Cartesian product of (repository × reader_member) for IAM-member for_each.
  repo_readers = merge([
    for repo_id, _ in local.repos_by_id : {
      for member in var.reader_members :
      "${repo_id}/${member}" => {
        repo_id = repo_id
        member  = member
      }
    }
  ]...)
}

# ─── Repositories ───────────────────────────────────────────────────────────
resource "google_artifact_registry_repository" "this" {
  for_each = local.repos_by_id

  project       = var.project_id
  location      = var.location
  repository_id = each.value.repository_id
  description   = each.value.description
  format        = "DOCKER"

  kms_key_name = var.kms_key_id

  docker_config {
    immutable_tags = var.immutable_tags
  }

  # Cleanup policies — four rules:
  #   1. Keep the 20 most-recent versions (any tag state) — per-package
  #   2. Keep all dev/staging/prod-tagged versions
  #   3. Keep all semver-tagged versions (v*) indefinitely
  #   4. Delete untagged images older than 90 days
  #
  # Rules 2 and 3 use tag_prefixes which does prefix match, not exact match.
  # By CLAUDE.md convention, Cortex floating tags are EXACTLY "dev",
  # "staging", "prod" (no variants). Semver tags are "v<major>.<minor>.<patch>".
  # With that convention, prefix match is safe — no tag starts with these
  # strings except the intended ones.
  #
  # A single cleanup rule may use EITHER condition OR most_recent_versions,
  # not both (API-enforced — Terraform schema allows both but apply fails).
  # "most-recent-N per semver" is therefore not expressible as a single
  # rule; rule 3 keeps all semver-tagged versions instead (semver releases
  # are infrequent and small, indefinite retention is acceptable).
  cleanup_policies {
    id     = "keep-most-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 20
    }
  }

  cleanup_policies {
    id     = "keep-env-tagged"
    action = "KEEP"
    condition {
      tag_state    = "TAGGED"
      tag_prefixes = ["dev", "staging", "prod"]
    }
  }

  cleanup_policies {
    id     = "keep-semver-releases"
    action = "KEEP"
    condition {
      tag_state    = "TAGGED"
      tag_prefixes = ["v"]
    }
  }

  cleanup_policies {
    id     = "delete-untagged-old"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "7776000s" # 90 days
    }
  }

  labels = var.common_labels
}

# ─── IAM: roles/artifactregistry.reader for each (repo × member) pair ──────
resource "google_artifact_registry_repository_iam_member" "reader" {
  for_each = local.repo_readers

  project    = var.project_id
  location   = var.location
  repository = google_artifact_registry_repository.this[each.value.repo_id].name
  role       = "roles/artifactregistry.reader"
  member     = each.value.member
}
