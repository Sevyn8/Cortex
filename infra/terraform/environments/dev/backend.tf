# State lives in the cortex-tfstate project's bucket, under dev/ prefix.
#
# No impersonation on the backend — personal ADC reads/writes state directly.
# This works because the bootstrap module grants storage.objectAdmin on the
# state bucket to cortex-admins@sevyn8.com (the group operators belong to).
# Operators can therefore read/inspect state even if the SA impersonation
# chain is misconfigured, which is a useful recovery property.
#
# Provider blocks (providers.tf) DO impersonate the dev tf-admin SA. That
# separation is deliberate: humans own state, SAs own resources.
#
# Backend attributes cannot be interpolated in Terraform; bucket name is
# hardcoded. Value is the bootstrap output cortex-tfstate-5402eb.

terraform {
  backend "gcs" {
    bucket = "cortex-tfstate-5402eb"
    prefix = "dev"
  }
}
