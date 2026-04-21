output "secret_id" {
  description = "Short secret_id (matches input var.secret_id)."
  value       = google_secret_manager_secret.this.secret_id
}

output "secret_name" {
  description = "Fully-qualified resource name: projects/<project_number>/secrets/<secret_id>. Callers reference this when creating secret versions or IAM bindings."
  value       = google_secret_manager_secret.this.name
}
