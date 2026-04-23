output "submit_sa_email" {
  value       = google_service_account.submit.email
  description = "Submit SA email. Pass as service_account input to google-github-actions/auth in the migrate workflow."
}

output "submit_sa_resource_name" {
  value       = google_service_account.submit.name
  description = "Submit SA resource name (projects/<project>/serviceAccounts/<email>). Used by the env root to attach the workloadIdentityUser binding."
}

output "worker_sa_email" {
  value       = google_service_account.worker.email
  description = "Worker SA email. Pass as --service-account to gcloud builds submit (so Cloud Build runs AS this identity)."
}

output "worker_sa_resource_name" {
  value       = google_service_account.worker.name
  description = "Worker SA resource name. Useful for cross-state references and audit assertions."
}

output "worker_pool_resource_name" {
  value       = google_cloudbuild_worker_pool.cortex_migration_runner.id
  description = "Full worker pool resource name (projects/<project>/locations/<region>/workerPools/<id>). Reference in migrate.yaml options.pool.name."
}

output "worker_pool_id" {
  value       = google_cloudbuild_worker_pool.cortex_migration_runner.name
  description = "Short worker pool ID (e.g., cortex-migration-runner)."
}
