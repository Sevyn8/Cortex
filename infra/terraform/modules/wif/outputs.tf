output "pool_id" {
  value       = google_iam_workload_identity_pool.cortex_github.workload_identity_pool_id
  description = "Short pool ID (e.g., 'cortex-github-pool')."
}

output "pool_resource_name" {
  value       = google_iam_workload_identity_pool.cortex_github.name
  description = "Full pool resource name (projects/<project-number>/locations/global/workloadIdentityPools/<pool-id>). Hard-code this into env terraform.tfvars per ADR-INFRA-006 Decision 8."
}

output "pool_principal_set_base" {
  value       = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.cortex_github.name}"
  description = "Base for principalSet:// member strings. Append '/attribute.<key>/<value>' to construct per-SA WIF member bindings. Convenience output to reduce string-concatenation errors."
}

output "provider_id" {
  value       = google_iam_workload_identity_pool_provider.cortex_github.workload_identity_pool_provider_id
  description = "Short OIDC provider ID (e.g., 'cortex-github-provider')."
}

output "provider_resource_name" {
  value       = "${google_iam_workload_identity_pool.cortex_github.name}/providers/${google_iam_workload_identity_pool_provider.cortex_github.workload_identity_pool_provider_id}"
  description = "Full provider resource name. Pass as workload_identity_provider input to google-github-actions/auth in workflow files."
}

output "project_number" {
  value       = data.google_project.this.number
  description = "Project number of the WIF host project. Useful for composing principalSet:// strings outside the module."
}
