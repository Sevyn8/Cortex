locals {
  # Per-project configuration: keyring + which keys belong in that ring.
  # See ADR-INFRA-004 for the key-hierarchy rationale.
  projects = {
    dev = {
      project_id     = var.projects.dev.project_id
      project_number = var.projects.dev.project_number
      keyring_name   = "cortex-keyring"
      keys = [
        "cortex-cloudsql-key",
        "cortex-gcs-key",
        "cortex-pubsub-key",
        "cortex-secrets-key",
        "cortex-general-key",
      ]
    }
    staging = {
      project_id     = var.projects.staging.project_id
      project_number = var.projects.staging.project_number
      keyring_name   = "cortex-keyring"
      keys = [
        "cortex-cloudsql-key",
        "cortex-gcs-key",
        "cortex-pubsub-key",
        "cortex-secrets-key",
        "cortex-general-key",
      ]
    }
    prod = {
      project_id     = var.projects.prod.project_id
      project_number = var.projects.prod.project_number
      keyring_name   = "cortex-keyring"
      keys = [
        "cortex-cloudsql-key",
        "cortex-gcs-key",
        "cortex-pubsub-key",
        "cortex-secrets-key",
        "cortex-general-key",
      ]
    }
    tfstate = {
      project_id     = var.projects.tfstate.project_id
      project_number = var.projects.tfstate.project_number
      keyring_name   = "cortex-tfstate-keyring"
      keys           = ["cortex-tfstate-key"]
    }
    shared = {
      project_id     = var.projects.shared.project_id
      project_number = var.projects.shared.project_number
      keyring_name   = "cortex-keyring"
      keys           = ["cortex-artifactregistry-key"]
    }
  }

  # Flat map for for_each over all 17 keys: "<project_key>/<key_name>" => metadata.
  all_keys = merge([
    for project_key, project in local.projects : {
      for key_name in project.keys : "${project_key}/${key_name}" => {
        project_key = project_key
        key_name    = key_name
      }
    }
  ]...)

  # APIs required in every project before bootstrap can create resources.
  # Module-specific APIs (pubsub, sqladmin, artifactregistry, etc.) are enabled
  # by the modules/project-baseline module in each environment root.
  bootstrap_apis = [
    "cloudresourcemanager.googleapis.com",
    "serviceusage.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "cloudkms.googleapis.com",
    "storage.googleapis.com",
  ]

  # 90-day key rotation — ADR-INFRA-004.
  key_rotation_period = "7776000s"

  # Labels applied to every resource that supports labels.
  common_labels = {
    managed_by = "terraform"
    project    = "cortex"
    prompt     = "p0-3"
    scope      = "bootstrap"
  }
}
