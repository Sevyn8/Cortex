project_id = "sevyn8-cortex-shared"
region     = "asia-south1"

# Bootstrap-owned key — see infra/terraform/bootstrap/main.tf.
# Keep in sync with bootstrap/locals.tf if the keyring or key name ever changes.
kms_key_id = "projects/sevyn8-cortex-shared/locations/asia-south1/keyRings/cortex-keyring/cryptoKeys/cortex-artifactregistry-key"

# Each env's Terraform identity — pulls images during env apply workflows.
env_tf_admin_emails = [
  "cortex-tf-admin@sevyn8-cortex-dev.iam.gserviceaccount.com",
  "cortex-tf-admin@sevyn8-cortex-staging.iam.gserviceaccount.com",
  "cortex-tf-admin@sevyn8-cortex-prod.iam.gserviceaccount.com",
]

common_labels = {
  managed_by  = "terraform"
  project     = "cortex"
  prompt      = "p0-3"
  environment = "shared"
}
