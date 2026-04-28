output "signer_sa_email" {
  description = "Email of the export-signer SA. Application code (once SA-impersonation lands) passes this as `targetPrincipal` to GoogleAuth when constructing the GCS Storage client for pre-signed URL generation."
  value       = google_service_account.signer.email
}

output "signer_sa_name" {
  description = "Fully-qualified resource name of the signer SA (projects/{project}/serviceAccounts/{email}). Used by downstream IAM bindings that reference the SA as a resource rather than a member."
  value       = google_service_account.signer.name
}

output "signer_sa_id" {
  description = "Stable unique numeric ID of the signer SA. Useful for IAM audit-log correlation when the SA's display name or email is rotated."
  value       = google_service_account.signer.unique_id
}
