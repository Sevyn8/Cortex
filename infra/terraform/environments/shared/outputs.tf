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
