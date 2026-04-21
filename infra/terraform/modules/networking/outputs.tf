output "vpc_id" {
  description = "VPC network resource ID."
  value       = google_compute_network.vpc.id
}

output "vpc_self_link" {
  description = "Self-link URL of the VPC network. Referenced by resources that accept self_link (Cloud SQL, etc.)."
  value       = google_compute_network.vpc.self_link
}

output "subnet_compute_id" {
  description = "ID of the compute subnet (10.X.0.0/20). For GKE nodes, VMs, most workloads."
  value       = google_compute_subnetwork.compute.id
}

output "subnet_compute_self_link" {
  description = "Self-link of the compute subnet."
  value       = google_compute_subnetwork.compute.self_link
}

output "subnet_data_id" {
  description = "ID of the data subnet (10.X.16.0/20). Reserved for data-plane services."
  value       = google_compute_subnetwork.data.id
}

output "subnet_data_self_link" {
  description = "Self-link of the data subnet."
  value       = google_compute_subnetwork.data.self_link
}

output "subnet_connector_id" {
  description = "ID of the connector subnet (10.X.32.0/28). Exclusive to the Serverless VPC Access Connector."
  value       = google_compute_subnetwork.connector.id
}

output "subnet_connector_self_link" {
  description = "Self-link of the connector subnet."
  value       = google_compute_subnetwork.connector.self_link
}

output "psa_range_name" {
  description = "Name of the Private Service Access allocated range. Referenced when creating PSA-consuming services (Cloud SQL, Filestore, Memorystore) in later prompts."
  value       = google_compute_global_address.psa.name
}

output "vpc_connector_id" {
  description = "Serverless VPC Access Connector ID. Cloud Run services reference this to reach private resources."
  value       = google_vpc_access_connector.connector.id
}
