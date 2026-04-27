output "queue_id" {
  value       = google_cloud_tasks_queue.this.id
  description = "Full resource ID of the queue (projects/{project}/locations/{location}/queues/{name})."
}

output "queue_name" {
  value       = google_cloud_tasks_queue.this.name
  description = "Queue name (without project/location prefix)."
}

output "queue_path" {
  value       = "projects/${var.project_id}/locations/${var.location}/queues/${var.queue_name}"
  description = "Canonical queue path for SDK use. Same shape as `google_cloud_tasks_queue.this.id` but assembled deterministically (useful for env-config emission before the resource exists)."
}
