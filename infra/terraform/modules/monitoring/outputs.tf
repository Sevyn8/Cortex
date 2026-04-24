output "email_channel_ids" {
  description = "Map of recipient display_name → notification channel ID. Future consumers (Phase 2 library for per-service alerts, Phase 3 dashboards linking alert state) can reference individual recipients by name or all via values()."
  value       = { for k, ch in google_monitoring_notification_channel.email : k => ch.id }
}

output "chat_channel_id" {
  description = "Google Chat notification channel ID (webhook_tokenauth type). Future consumers needing CRITICAL-route alerts (Phase 2 library, Phase 3 dashboards) reference this."
  value       = google_monitoring_notification_channel.chat.id
}

output "alert_policy_ids" {
  description = "Map of alert policy key → policy ID. Useful for Phase 3 dashboards that link alert state to dashboard panels. Keys match the resource addresses in main.tf for traceability."
  value = {
    cloud_sql_cpu_high          = google_monitoring_alert_policy.cloud_sql_cpu_high.id
    cloud_sql_connections_high  = google_monitoring_alert_policy.cloud_sql_connections_high.id
    cloud_sql_disk_80           = google_monitoring_alert_policy.cloud_sql_disk_80.id
    cloud_sql_disk_90           = google_monitoring_alert_policy.cloud_sql_disk_90.id
    cloud_build_failures        = google_monitoring_alert_policy.cloud_build_failures.id
    wif_auth_failures           = google_monitoring_alert_policy.wif_auth_failures.id
    cloud_build_submit_failures = google_monitoring_alert_policy.cloud_build_submit_failures.id
  }
}
