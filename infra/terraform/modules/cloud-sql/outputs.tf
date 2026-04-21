output "instance_name" {
  description = "Short name of the Cloud SQL instance (cortex-<env>-postgres)."
  value       = google_sql_database_instance.this.name
}

output "connection_name" {
  description = "Connection name used by the Cloud SQL Auth Proxy. Format: project:region:instance."
  value       = google_sql_database_instance.this.connection_name
}

output "private_ip_address" {
  description = "Private IP allocated from the PSA peering range (10.X.240.0/20). Consumers on the same VPC connect here."
  value       = google_sql_database_instance.this.private_ip_address
}

output "service_account_email_address" {
  description = "Service account email of the Cloud SQL instance itself. Distinct from the Cloud SQL service agent — this is the per-instance identity used for outbound operations (e.g. GCS imports). Useful for future grants."
  value       = google_sql_database_instance.this.service_account_email_address
}

output "database_name" {
  description = "Name of the default application database (cortex)."
  value       = google_sql_database.default.name
}

output "cloudsql_service_agent" {
  description = "Deterministic Cloud SQL service-agent member string (serviceAccount:service-<project_number>@gcp-sa-cloud-sql.iam.gserviceaccount.com). Exposed for downstream CMEK grants on additional keys if an instance ever encrypts data across more than one key class."
  value       = local.cloudsql_service_agent
}
