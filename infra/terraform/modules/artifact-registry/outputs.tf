output "repository_ids" {
  description = "Map of repository_id to full resource ID (projects/.../locations/.../repositories/...). Callers reference specific repos for IAM grants or tags."
  value = {
    for id, repo in google_artifact_registry_repository.this : id => repo.id
  }
}

output "repository_urls" {
  description = "Map of repository_id to the docker-pullable URL prefix (asia-south1-docker.pkg.dev/<project>/<repo>). Used by CI to tag and push images."
  value = {
    for id, repo in google_artifact_registry_repository.this :
    id => "${var.location}-docker.pkg.dev/${var.project_id}/${id}"
  }
}
