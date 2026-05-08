# ─────────────────────────────────────────────────────────────────────────────
# tenant-cloud-run-service — generic per-tenant or shared Cloud Run service
# for Cortex control-plane workloads (F02 Slice D D.4 + ENTERPRISE swap path).
#
# Per Q-NEW-D-10 the module accepts `mode = "shared" | "tenant"`. Slice D
# wires only `mode="shared"` for tenant-lifecycle-shared; the `mode="tenant"`
# branch is reachable today (terraform validate exercises it) but no env
# instantiates it until ENTERPRISE per-tenant deploys land post-ADR-INFRA-005.
#
# Service-name format per ADR-COMPUTE-001 §3:
#   shared:  {workload}-shared
#   tenant:  {workload}-tenant-{tenant_id}
#
# Auth posture per planning-doc SD8: --no-allow-unauthenticated (deny-by-
# default at the Cloud Run invoker IAM floor). D.5 owns the run.invoker
# allowlist; this module sets up the deny-by-default surface but does NOT
# grant invoker IAM.
#
# Cloud SQL: Unix-socket via --add-cloudsql-instances, IAM auth per
# ADR-INFRA-005 Decision 11. The runtime SA's cloudsql.client +
# cloudsql.instanceUser bindings + the google_sql_user resource live in
# env-level main.tf (not this module — those grants attach to the runtime
# SA, which is created in env main.tf, before this module is instantiated).
# ─────────────────────────────────────────────────────────────────────────────

locals {
  service_name = var.mode == "shared" ? "${var.workload}-shared" : "${var.workload}-tenant-${var.tenant_id}"

  # PG IAM user = SA email minus the .gserviceaccount.com suffix per
  # Cloud SQL IAM-auth username convention (see ADR-INFRA-005 Decision 11
  # + apps/tenant-lifecycle-api/scripts/deploy-dev.sh comment).
  pg_iam_user = replace(var.runtime_sa_email, ".gserviceaccount.com", "")

  base_env = {
    NODE_ENV                          = "production"
    GCP_PROJECT_ID                    = var.project_id
    CLOUDSQL_INSTANCE_CONNECTION_NAME = var.cloudsql_instance_connection_name
    PG_IAM_USER                       = local.pg_iam_user
    PGDATABASE                        = "cortex"
    # Q-NEW-D-11 lock (Option 1): worker routes validate inbound OIDC
    # tokens against the runtime SA email. The dispatcher is the same
    # SA; one fewer identity to manage in Phase 1.
    CLOUD_TASKS_INVOKER_SA_EMAIL = var.runtime_sa_email
  }

  module_labels = merge(
    var.common_labels,
    {
      workload  = var.workload
      placement = var.mode
    },
    var.mode == "tenant" ? { tenant_id = var.tenant_id } : {},
  )
}

resource "google_cloud_run_v2_service" "this" {
  project  = var.project_id
  location = var.location
  name     = local.service_name

  # Deny-by-default per SD8. D.5 grants run.invoker to specific caller SAs.
  ingress      = "INGRESS_TRAFFIC_ALL"
  launch_stage = "GA"

  labels = local.module_labels

  # Service-level scaling block (distinct from template-level scaling
  # below). Cloud Run v2 surfaces both: this one carries
  # service-wide manual-mode controls, the template one carries
  # per-revision min/max for automatic mode. The provider renders
  # manual_instance_count + min_instance_count = 0 from the live API
  # even when the service is in automatic-scaling mode, so a
  # gcloud-deployed service imported into TF state shows a
  # "0 -> null" diff on every plan unless we declare matching
  # zeros here. Idempotency-only — automatic scaling lives in
  # `template.scaling` below; this block is a no-op for runtime
  # behavior under automatic mode (the default for our workloads).
  scaling {
    min_instance_count    = 0
    manual_instance_count = 0
  }

  template {
    service_account = var.runtime_sa_email

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    # VPC egress via the Serverless VPC Access connector. Required for
    # Cloud SQL private-IP reach: the Cloud SQL Auth Proxy sidecar dials
    # the instance at its private IP (10.X.240.0/20 range, allocated via
    # PSA peering); without a connector, Cloud Run instances live in the
    # Google-managed network and can't reach the env VPC's private ranges.
    # PRIVATE_RANGES_ONLY: only RFC 1918 / private-range traffic flows
    # through the connector. Public APIs (Cloud SQL Admin, KMS, Secret
    # Manager, etc.) continue via the default public egress — cheaper +
    # avoids needlessly funneling them through the connector. Switch to
    # ALL_TRAFFIC only if a workload's policy requires all egress
    # private (e.g., DLP-flagged data exiting only via VPC).
    vpc_access {
      connector = var.vpc_connector_id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    timeout = "${var.timeout_seconds}s"

    # Cloud SQL volume — Cloud Run mounts the proxy socket at
    # /cloudsql/{ICN} per Cloud Run docs.
    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [var.cloudsql_instance_connection_name]
      }
    }

    containers {
      image = var.image_uri

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      ports {
        name           = "http1"
        container_port = 8080
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      dynamic "env" {
        for_each = merge(local.base_env, var.extra_env_vars)
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.secret_env_vars
        content {
          name = env.value.name
          value_source {
            secret_key_ref {
              secret  = env.value.secret_name
              version = env.value.version
            }
          }
        }
      }
    }

    # Per-request concurrency; Cloud Run distributes requests up to this
    # cap per instance.
    max_instance_request_concurrency = var.concurrency
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  # Lifecycle: ignore image changes from out-of-band gcloud-run-deploy
  # operations. Per the operator workflow (D.1 deploy-dev.sh), images
  # are pushed + deployed via gcloud during dev iteration; the TF module
  # owns the SHAPE of the service but not the deployed-image-SHA. When
  # operator runs `make tf-apply-dev` after a gcloud-side deploy, terraform
  # would otherwise revert the image. lifecycle.ignore_changes preserves
  # the deployed image. Production deploys (D.6+) tighten this.
  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
    ]
  }
}
