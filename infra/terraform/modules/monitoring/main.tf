# ─────────────────────────────────────────────────────────────────────────────
# monitoring — Per-env Cloud Monitoring alert policies + notification channels.
#
# Per ADR-OBS-001 Decisions 3-4:
#   - Library deferred; this module lands the operator-facing alert
#     infrastructure (sequenced first per Decision 3).
#   - Severity routing:
#       CRITICAL → email recipients + Google Chat webhook (local.channels_critical)
#       WARNING  → email recipients only (local.channels_warning) — Chat stays
#                  quiet to prevent alert fatigue.
#   - Google Chat channel uses webhook_tokenauth (Decision 4 amendment);
#     native google_chat type rejected because Cloud Monitoring bot isn't
#     discoverable in Amit's Workspace and the webhook URL already exists.
#
# Log-based metrics scoped in module (pragmatic; revisit if non-alerting
# consumers emerge). Data Access audit logs (iam.googleapis.com DATA_READ +
# ADMIN_READ) are enabled in project-baseline so STS token-exchange failures
# land in logs for wif_auth_failures to count.
#
# Filter strings for log-based metrics are best-guess; synthetic-failure
# validation required post-apply. See README "Post-apply verification" +
# ADR-OBS-001 Implementation notes (to be added after first apply).
# ─────────────────────────────────────────────────────────────────────────────

# ─── Notification channels ─────────────────────────────────────────────────

resource "google_monitoring_notification_channel" "email" {
  for_each = { for r in var.notification_recipients : r.display_name => r }

  project      = var.project_id
  display_name = "${each.value.display_name} (${var.environment})"
  type         = "email"
  labels = {
    email_address = each.value.email
  }
}

resource "google_monitoring_notification_channel" "chat" {
  project      = var.project_id
  display_name = "Cortex Alerts — Google Chat (${var.environment})"
  type         = "webhook_tokenauth"
  labels = {
    url = var.chat_webhook_url
  }
  # webhook_tokenauth's only descriptor label is `url`. The webhook URL
  # contains the shared secret as query-string params (key=...&token=...);
  # there is no separate auth_token field. Terraform's sensitive propagation
  # on var.chat_webhook_url redacts `labels` as a whole in plan output.
}

locals {
  channels_critical = concat(
    [for k, ch in google_monitoring_notification_channel.email : ch.id],
    [google_monitoring_notification_channel.chat.id],
  )
  channels_warning = [for k, ch in google_monitoring_notification_channel.email : ch.id]

  # Cloud Build failure severity is env-dependent per scope: CRITICAL in prod,
  # WARNING in dev/staging.
  cloud_build_failure_channels = var.environment == "prod" ? local.channels_critical : local.channels_warning
  cloud_build_failure_severity = var.environment == "prod" ? "CRITICAL" : "WARNING"

  # 80% of max connections (computed per env from caller-supplied max).
  cloud_sql_connections_threshold = floor(var.cloud_sql_max_connections * 0.8)

  # Cloud SQL resource label — `database_id` is "<project_id>:<instance_name>".
  cloud_sql_database_id = "${var.project_id}:${var.cloud_sql_instance_name}"
}

# ─── Log-based metrics ─────────────────────────────────────────────────────
# Both filters are starting-point best-guess. Post-apply validation:
# trigger a synthetic failure, confirm the metric counter increments.

resource "google_logging_metric" "wif_auth_failures" {
  project     = var.project_id
  name        = "cortex/wif_auth_failures"
  description = "IAM Security Token Service (STS) GenerateAccessToken failures. Source signal for WIF token exchange issues from GitHub Actions dispatches. Requires iam.googleapis.com DATA_READ audit logs enabled (see project-baseline module)."

  filter = <<-EOT
    protoPayload.serviceName="sts.googleapis.com"
    AND protoPayload.methodName=~"GenerateAccessToken"
    AND (protoPayload.status.code!=0 OR severity>=ERROR)
  EOT

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_logging_metric" "cloud_build_submit_failures" {
  project     = var.project_id
  name        = "cortex/cloud_build_submit_failures"
  description = "Cloud Build CreateBuild API failures (submit rejected before build runs). Source signal for IAM/quota/permission issues at submit time. Distinct from build-execution failures (see cloud_build_failures alert)."

  filter = <<-EOT
    protoPayload.serviceName="cloudbuild.googleapis.com"
    AND protoPayload.methodName="google.devtools.cloudbuild.v1.CloudBuild.CreateBuild"
    AND (protoPayload.status.code!=0 OR severity>=ERROR)
  EOT

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

# ─── Alert policies ────────────────────────────────────────────────────────
# Convention: severity set for metadata/grouping; routing driven by
# notification_channels list (CRITICAL → local.channels_critical, WARNING
# → local.channels_warning). documentation.content is short runbook prose.
# Every policy has alert_strategy.auto_close = 86400s (24h) — incidents
# that aren't resolved within a day auto-close; resurfaces fresh on next
# occurrence.

resource "google_monitoring_alert_policy" "cloud_sql_cpu_high" {
  project      = var.project_id
  display_name = "Cloud SQL CPU > 80% sustained (${var.environment})"
  severity     = "CRITICAL"
  combiner     = "OR"

  conditions {
    display_name = "CPU utilization > 80% for 15 minutes"
    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/cpu/utilization\" AND resource.type=\"cloudsql_database\" AND resource.labels.database_id=\"${local.cloud_sql_database_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.8
      duration        = "900s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }

  notification_channels = local.channels_critical

  alert_strategy {
    auto_close = "86400s"
  }

  documentation {
    content   = "Cloud SQL instance ${var.cloud_sql_instance_name} has sustained CPU > 80% for 15+ minutes. Likely causes: runaway query, missing index, or traffic spike. Check Query Insights in Cloud SQL console; consider tier upgrade if sustained."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "cloud_sql_connections_high" {
  project      = var.project_id
  display_name = "Cloud SQL connections > 80% of max (${var.environment})"
  severity     = "WARNING"
  combiner     = "OR"

  conditions {
    display_name = "Connections > ${local.cloud_sql_connections_threshold} (80% of ${var.cloud_sql_max_connections})"
    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/postgresql/num_backends\" AND resource.type=\"cloudsql_database\" AND resource.labels.database_id=\"${local.cloud_sql_database_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = local.cloud_sql_connections_threshold
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }

  notification_channels = local.channels_warning

  alert_strategy {
    auto_close = "86400s"
  }

  documentation {
    content   = "Cloud SQL instance ${var.cloud_sql_instance_name} has >${local.cloud_sql_connections_threshold} concurrent connections for 5+ minutes (threshold = 80% of max_connections=${var.cloud_sql_max_connections}). Check for connection leaks in services; consider raising max_connections via database flag if sustained."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "cloud_sql_disk_80" {
  project      = var.project_id
  display_name = "Cloud SQL disk > 80% (${var.environment})"
  severity     = "WARNING"
  combiner     = "OR"

  conditions {
    display_name = "Disk utilization > 80% for 5 minutes"
    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/disk/utilization\" AND resource.type=\"cloudsql_database\" AND resource.labels.database_id=\"${local.cloud_sql_database_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.8
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }

  notification_channels = local.channels_warning

  alert_strategy {
    auto_close = "86400s"
  }

  documentation {
    content   = "Cloud SQL instance ${var.cloud_sql_instance_name} disk is >80% full. disk_autoresize is enabled with a ceiling; confirm the ceiling isn't reached. Disk autoresize is irreversible — plan capacity before hitting 90%."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "cloud_sql_disk_90" {
  project      = var.project_id
  display_name = "Cloud SQL disk > 90% (${var.environment})"
  severity     = "CRITICAL"
  combiner     = "OR"

  conditions {
    display_name = "Disk utilization > 90% for 1 minute"
    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/disk/utilization\" AND resource.type=\"cloudsql_database\" AND resource.labels.database_id=\"${local.cloud_sql_database_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.9
      duration        = "60s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }

  notification_channels = local.channels_critical

  alert_strategy {
    auto_close = "86400s"
  }

  documentation {
    content   = "Cloud SQL instance ${var.cloud_sql_instance_name} disk is >90% full. Autoresize ceiling risk; instance could go read-only if full. Immediate action: check autoresize_limit on the instance, raise or trigger manual resize."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "cloud_build_failures" {
  project      = var.project_id
  display_name = "Cloud Build — build failures (${var.environment})"
  severity     = local.cloud_build_failure_severity
  combiner     = "OR"

  conditions {
    display_name = "Build completed with non-SUCCESS status"
    condition_matched_log {
      filter = <<-EOT
        resource.type="build"
        AND protoPayload.serviceName="cloudbuild.googleapis.com"
        AND operation.last=true
        AND (
          severity="ERROR"
          OR protoPayload.response.status="FAILURE"
          OR protoPayload.response.status="TIMEOUT"
          OR protoPayload.response.status="CANCELLED"
          OR protoPayload.response.status="INTERNAL_ERROR"
        )
      EOT
    }
  }

  notification_channels = local.cloud_build_failure_channels

  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "86400s"
  }

  documentation {
    content   = "Cloud Build execution completed with failure. Likely: migrate.yaml step failure, container pull error, or Cloud SQL connectivity issue. Check build log via Cloud Build console. Severity is ${local.cloud_build_failure_severity} for env=${var.environment}. Matches FAILURE/TIMEOUT/CANCELLED/INTERNAL_ERROR build statuses; CANCELLED is included as a legitimate-signal-with-false-positive-risk — revisit if noise becomes a problem."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "wif_auth_failures" {
  project      = var.project_id
  display_name = "WIF token exchange failures > 5/hour (${var.environment})"
  severity     = "WARNING"
  combiner     = "OR"

  conditions {
    display_name = "STS GenerateAccessToken failures > 5 in rolling hour"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.wif_auth_failures.name}\" AND resource.type=\"audited_resource\""
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "0s"
      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  notification_channels = local.channels_warning

  alert_strategy {
    # No notification_rate_limit: GCP API rejects it on condition_threshold
    # policies ("only log-based alert policies may specify a notification rate
    # limit" — meaning condition_matched_log; user-metric threshold doesn't
    # qualify). The 3600s alignment window + ALIGN_SUM + threshold already
    # naturally deduplicates — the condition fires once when the rolling hour
    # sum crosses the threshold and stays firing until it drops below.
    auto_close = "86400s"
  }

  documentation {
    content   = "More than 5 WIF token exchanges failed in the last hour. Likely: workflow_ref binding misconfigured, IAM propagation lag, or external principal trying invalid workflow_ref. Check audit logs for protoPayload.authenticationInfo.principalEmail to see which SA was targeted."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "cloud_build_submit_failures" {
  project      = var.project_id
  display_name = "Cloud Build submit failures > 3/hour (${var.environment})"
  severity     = "WARNING"
  combiner     = "OR"

  conditions {
    display_name = "CreateBuild API failures > 3 in rolling hour"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.cloud_build_submit_failures.name}\" AND resource.type=\"audited_resource\""
      comparison      = "COMPARISON_GT"
      threshold_value = 3
      duration        = "0s"
      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  notification_channels = local.channels_warning

  alert_strategy {
    # No notification_rate_limit: GCP API rejects it on condition_threshold
    # policies ("only log-based alert policies may specify a notification rate
    # limit" — meaning condition_matched_log; user-metric threshold doesn't
    # qualify). The 3600s alignment window + ALIGN_SUM + threshold already
    # naturally deduplicates — the condition fires once when the rolling hour
    # sum crosses the threshold and stays firing until it drops below.
    auto_close = "86400s"
  }

  documentation {
    content   = "More than 3 Cloud Build CreateBuild calls failed in the last hour. Distinct from build-execution failures. Likely: submit SA permissions (builds.builder role), API quota, or invalid service-account flag. Check audit logs for protoPayload.status.message."
    mime_type = "text/markdown"
  }
}
