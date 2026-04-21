# Provider identity: cortex-tf-admin@sevyn8-cortex-tfstate.
# Operators (cortex-admins@sevyn8.com) hold tokenCreator on this SA via the
# bootstrap-installed binding. No JSON keys. These provider blocks are
# dormant until this module declares its first resource.

provider "google" {
  project                     = var.project_id
  region                      = "asia-south1"
  impersonate_service_account = "cortex-tf-admin@sevyn8-cortex-tfstate.iam.gserviceaccount.com"
}

provider "google-beta" {
  project                     = var.project_id
  region                      = "asia-south1"
  impersonate_service_account = "cortex-tf-admin@sevyn8-cortex-tfstate.iam.gserviceaccount.com"
}
