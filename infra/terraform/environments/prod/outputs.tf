output "project_id" {
  description = "Prod project ID — pass-through for downstream tooling."
  value       = var.project_id
}

output "project_number" {
  description = "Prod project number. Exposed because several GCP resource formats use the numeric form."
  value       = data.google_project.current.number
}

output "vpc_id" {
  description = "Prod VPC network resource ID."
  value       = module.networking.vpc_id
}

output "vpc_self_link" {
  description = "Prod VPC self-link URL."
  value       = module.networking.vpc_self_link
}

output "subnet_compute_id" {
  description = "Prod compute subnet ID (10.30.0.0/20)."
  value       = module.networking.subnet_compute_id
}

output "subnet_data_id" {
  description = "Prod data subnet ID (10.30.16.0/20)."
  value       = module.networking.subnet_data_id
}

output "subnet_connector_id" {
  description = "Prod connector subnet ID (10.30.32.0/28)."
  value       = module.networking.subnet_connector_id
}

output "psa_range_name" {
  description = "Prod Private Service Access allocated range. Referenced by P0.4 Cloud SQL for private IP."
  value       = module.networking.psa_range_name
}

output "vpc_connector_id" {
  description = "Prod Serverless VPC Access Connector."
  value       = module.networking.vpc_connector_id
}

output "observer_sa_email" {
  description = "Email of the cortex-observer SA (read-only, no Secret Manager access)."
  value       = google_service_account.observer.email
}

output "cloud_sql_instance_name" {
  description = "Short name of the prod Cloud SQL instance (cortex-prod-postgres). Used by gcloud commands and Cloud SQL Auth Proxy config."
  value       = module.cloud_sql.instance_name
}

output "cloud_sql_connection_name" {
  description = "Cloud SQL connection name (project:region:instance) for the Auth Proxy."
  value       = module.cloud_sql.connection_name
}

output "cloud_sql_private_ip" {
  description = "Private IP of the prod Cloud SQL instance, allocated from the PSA range 10.30.240.0/20. Direct-IP consumers on the prod VPC use this."
  value       = module.cloud_sql.private_ip_address
}

output "cloud_sql_database_name" {
  description = "Default application database on the prod instance (cortex)."
  value       = module.cloud_sql.database_name
}

output "tenant_data_bucket_name" {
  description = "Name of the prod tenant-data bucket (F01 Slice B)."
  value       = module.tenant_data_bucket.bucket_name
}

output "tenant_data_runtime_sa_email" {
  description = "Runtime SA email — services impersonate this for tenant blob I/O on the prod bucket."
  value       = module.tenant_data_bucket.runtime_service_account_email
}
