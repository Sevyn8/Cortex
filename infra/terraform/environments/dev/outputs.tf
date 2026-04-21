output "project_id" {
  description = "Dev project ID — pass-through for downstream tooling (gcloud invocations, make targets that need the project context)."
  value       = var.project_id
}

output "project_number" {
  description = "Dev project number. Exposed because several GCP resource formats (service-agent emails, IAM deny principals) use the numeric form."
  value       = data.google_project.current.number
}

output "vpc_id" {
  description = "Dev VPC network resource ID. Future modules that attach to the VPC reference this."
  value       = module.networking.vpc_id
}

output "vpc_self_link" {
  description = "Dev VPC self-link URL."
  value       = module.networking.vpc_self_link
}

output "subnet_compute_id" {
  description = "Dev compute subnet ID (10.10.0.0/20)."
  value       = module.networking.subnet_compute_id
}

output "subnet_data_id" {
  description = "Dev data subnet ID (10.10.16.0/20)."
  value       = module.networking.subnet_data_id
}

output "subnet_connector_id" {
  description = "Dev connector subnet ID (10.10.32.0/28). Exclusive to the Serverless VPC Access Connector."
  value       = module.networking.subnet_connector_id
}

output "psa_range_name" {
  description = "Name of the Private Service Access allocated range for dev. Referenced by P0.4 Cloud SQL for private IP."
  value       = module.networking.psa_range_name
}

output "vpc_connector_id" {
  description = "Dev Serverless VPC Access Connector. Cloud Run services reference this to reach private resources."
  value       = module.networking.vpc_connector_id
}

output "observer_sa_email" {
  description = "Email of the cortex-observer SA (read-only, Secret Manager access denied). Future observability tooling in P0.6 / P5.9 binds to this identity."
  value       = google_service_account.observer.email
}

output "cloud_sql_instance_name" {
  description = "Short name of the dev Cloud SQL instance (cortex-dev-postgres). Used by gcloud commands and Cloud SQL Auth Proxy config."
  value       = module.cloud_sql.instance_name
}

output "cloud_sql_connection_name" {
  description = "Cloud SQL connection name (project:region:instance) for the Auth Proxy."
  value       = module.cloud_sql.connection_name
}

output "cloud_sql_private_ip" {
  description = "Private IP of the dev Cloud SQL instance, allocated from the PSA range 10.10.240.0/20. Direct-IP consumers on the dev VPC use this."
  value       = module.cloud_sql.private_ip_address
}

output "cloud_sql_database_name" {
  description = "Default application database on the dev instance (cortex)."
  value       = module.cloud_sql.database_name
}
