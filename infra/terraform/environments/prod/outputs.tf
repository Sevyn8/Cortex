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
