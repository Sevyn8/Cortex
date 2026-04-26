output "bucket_name" {
  description = "Name of the tenant-data bucket. Use this in @cortex/blob-storage's getTenantBucketName() resolver if the naming convention drifts from the default."
  value       = google_storage_bucket.tenant_data.name
}

output "bucket_url" {
  description = "gs:// URL of the tenant-data bucket."
  value       = google_storage_bucket.tenant_data.url
}

output "runtime_service_account_email" {
  description = "Email of the runtime SA bound to the bucket. Services impersonate this SA to perform tenant-prefixed I/O."
  value       = google_service_account.tenant_data_runtime.email
}
