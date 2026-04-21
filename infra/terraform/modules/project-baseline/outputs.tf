output "project_id" {
  description = "Pass-through of var.project_id for caller convenience — lets callers reference the module output instead of tracking the project_id variable separately."
  value       = var.project_id
}

output "activated_apis" {
  description = "List of APIs that were activated. Callers depend_on this output (via the module output, or on the API resources directly) to serialize API-dependent resource creation inside the environment root."
  value       = [for api, _ in google_project_service.activated : api]
}
