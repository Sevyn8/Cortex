output "project_id" {
  description = "Shared project ID — pass-through for downstream tooling."
  value       = var.project_id
}

output "repository_ids" {
  description = "Map of repository_id to full resource ID. Env modules reference specific repos by key when granting runtime SA reader access."
  value       = module.artifact_registry.repository_ids
}

output "repository_urls" {
  description = "Map of repository_id to docker-pullable URL prefix (asia-south1-docker.pkg.dev/<project>/<repo>). Referenced by CI at image-tag time in P0.5."
  value       = module.artifact_registry.repository_urls
}

output "wif_pool_resource_name" {
  description = "Full pool resource name for hard-coding into env tfvars (ADR-INFRA-006 Decision 8)."
  value       = module.wif.pool_resource_name
}

output "wif_pool_principal_set_base" {
  description = "principalSet:// base string. Env bindings append /attribute.workflow_ref/<path>@<ref>."
  value       = module.wif.pool_principal_set_base
}

output "wif_provider_resource_name" {
  description = "Full provider resource name. Pass as workload_identity_provider to google-github-actions/auth in workflow files."
  value       = module.wif.provider_resource_name
}

output "wif_project_number" {
  description = "Project number of sevyn8-cortex-shared (for cross-state reference)."
  value       = module.wif.project_number
}
