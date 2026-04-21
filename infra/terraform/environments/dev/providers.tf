# Provider identity: cortex-tf-admin@sevyn8-cortex-dev.
# Operators (members of cortex-admins@sevyn8.com) hold
# roles/iam.serviceAccountTokenCreator on this SA — that group binding is
# the single mechanism by which a human gains authority to run dev apply.
# No JSON keys, no gcloud auth activate-service-account.
#
# Same SA for both google and google-beta providers so plan/apply behavior
# is consistent across resource types that require the beta provider.

provider "google" {
  project                     = var.project_id
  region                      = var.region
  impersonate_service_account = "cortex-tf-admin@sevyn8-cortex-dev.iam.gserviceaccount.com"
}

provider "google-beta" {
  project                     = var.project_id
  region                      = var.region
  impersonate_service_account = "cortex-tf-admin@sevyn8-cortex-dev.iam.gserviceaccount.com"
}
