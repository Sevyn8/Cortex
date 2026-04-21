# Bootstrap runs ONCE with personal Application Default Credentials.
# See README.md for the run sequence.
#
# Local state is intentional — the GCS backend does not yet exist when
# bootstrap runs for the first time. Subsequent Terraform root modules
# (environments/*) use GCS-backed state and SA impersonation.

terraform {
  backend "local" {
    path = "terraform.tfstate"
  }
}

provider "google" {
  region = var.region
}

provider "google-beta" {
  region = var.region
}

provider "random" {}
