output "state_bucket_name" {
  description = "Name of the GCS bucket storing all Terraform state files. Referenced by each environment root module's backend.tf."
  value       = google_storage_bucket.tfstate.name
}

output "tf_admin_emails" {
  description = "Map of project key (dev|staging|prod|tfstate|shared) to cortex-tf-admin SA email. Used in environments/*/providers.tf for the impersonate_service_account attribute."
  value = {
    for k, sa in google_service_account.tf_admin : k => sa.email
  }
}

output "keyring_ids" {
  description = "Map of project key to KMS keyring resource ID. Env modules use data sources against these keyrings rather than consuming this output directly, but the list here is a single source of truth."
  value = {
    for k, kr in google_kms_key_ring.keyring : k => kr.id
  }
}

output "key_ids" {
  description = "Map of '<project_key>/<key_name>' to KMS key resource ID. Env modules reference these when attaching CMEK to resources they create."
  value = {
    for k, key in google_kms_crypto_key.keys : k => key.id
  }
}
