# State lives in the cortex-tfstate project's bucket, under prod/ prefix.
#
# No impersonation on the backend — personal ADC reads/writes state directly.
# This works because the bootstrap module grants storage.objectAdmin on the
# state bucket to cortex-admins@sevyn8.com.
#
# Provider blocks (providers.tf) DO impersonate the prod tf-admin SA.
# humans own state, SAs own resources.

terraform {
  backend "gcs" {
    bucket = "cortex-tfstate-5402eb"
    prefix = "prod"
  }
}
