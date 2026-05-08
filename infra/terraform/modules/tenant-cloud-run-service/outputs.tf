output "service_name" {
  description = <<-EOT
    Resolved service name per ADR-COMPUTE-001 §3:
      mode=shared  → {workload}-shared
      mode=tenant  → {workload}-tenant-{tenant_id}
  EOT
  value       = google_cloud_run_v2_service.this.name
}

output "service_url" {
  description = "Public URL Cloud Run assigned to the service. Empty until first revision deploys."
  value       = google_cloud_run_v2_service.this.uri
}

output "service_account_email" {
  description = "Runtime SA the service runs as. Cross-references for downstream IAM bindings (e.g., D.5 invoker allowlist)."
  value       = var.runtime_sa_email
}

output "location" {
  description = "Cloud Run region. Useful for IAM grant resource paths in env-level main.tf."
  value       = google_cloud_run_v2_service.this.location
}

output "project" {
  description = "Project the service lives in."
  value       = google_cloud_run_v2_service.this.project
}
