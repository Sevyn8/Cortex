# State lives in the cortex-tfstate project's bucket, under tfstate/ prefix.
#
# No impersonation on the backend — personal ADC reads/writes state directly.
# This works because the bootstrap module grants storage.objectAdmin on the
# state bucket to cortex-admins@sevyn8.com.
#
# Provider blocks (providers.tf) DO impersonate the tfstate tf-admin SA for
# any future resources this root module adds. humans own state, SAs own resources.

terraform {
  backend "gcs" {
    bucket = "cortex-tfstate-5402eb"
    prefix = "tfstate"
  }
}
