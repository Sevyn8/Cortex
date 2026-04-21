# Provider identity: cortex-tf-admin@sevyn8-cortex-prod.
# Operators (cortex-admins@sevyn8.com) hold tokenCreator on this SA via
# the bootstrap-installed binding. No JSON keys.

provider "google" {
  project                     = var.project_id
  region                      = var.region
  impersonate_service_account = "cortex-tf-admin@sevyn8-cortex-prod.iam.gserviceaccount.com"
}

provider "google-beta" {
  project                     = var.project_id
  region                      = var.region
  impersonate_service_account = "cortex-tf-admin@sevyn8-cortex-prod.iam.gserviceaccount.com"
}
