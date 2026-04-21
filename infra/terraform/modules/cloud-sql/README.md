# cloud-sql module

Provisions a CMEK-encrypted, private-IP-only Cloud SQL Postgres 17 instance for a single Cortex environment, plus the default `cortex` application database.

See **[ADR-INFRA-005](../../../../docs/architecture/decisions/ADR-INFRA-005-cloud-sql-posture.md)** for the full posture decision.

## What this creates

| Resource                                         | Purpose                                                                                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `google_kms_crypto_key_iam_member.cloudsql_cmek` | Grants the Cloud SQL service agent `cryptoKeyEncrypterDecrypter` on the env's `cortex-cloudsql-key`. Must exist before instance creation. |
| `google_sql_database_instance.this`              | The Postgres 17 Enterprise instance itself. Private IP only, CMEK-encrypted, IAM auth enabled.                                            |
| `google_sql_database.default`                    | The single `cortex` application database.                                                                                                 |

No `google_sql_user` resource — IAM authentication is the only active auth path (ADR-INFRA-005 Decision 11). Break-glass procedure for the built-in `postgres` superuser is documented in the Cloud SQL runbook.

## Required inputs (no defaults)

- `project_id` — env project hosting the instance
- `environment` — `dev` / `staging` / `prod`
- `tier` — machine tier (e.g. `db-custom-2-8192`)
- `availability_type` — `ZONAL` or `REGIONAL`
- `backup_retained_count` — daily backup count (per-env per ADR-INFRA-005)
- `pitr_retention_days` — 1–7 (Enterprise edition cap)
- `private_network_id` — VPC self-link from the `networking` module
- `max_connections` — 100 (dev/staging) or 200 (prod)
- `kms_key_id` — fully-qualified `cortex-cloudsql-key` resource name

## Per-env values (reference)

| Variable                | dev                | staging            | prod                |
| ----------------------- | ------------------ | ------------------ | ------------------- |
| `edition`               | `ENTERPRISE`       | `ENTERPRISE`       | `ENTERPRISE`        |
| `tier`                  | `db-custom-2-8192` | `db-custom-2-8192` | `db-custom-4-16384` |
| `availability_type`     | `ZONAL`            | `ZONAL`            | `REGIONAL`          |
| `backup_retained_count` | 7                  | 7                  | 14                  |
| `pitr_retention_days`   | 1                  | 3                  | 7                   |
| `max_connections`       | 100                | 100                | 200                 |

Note: `edition = ENTERPRISE` is explicit because Postgres 16+ defaults to ENTERPRISE_PLUS at the GCP API level (see ADR-INFRA-005 Decision 1).

## Outputs

- `instance_name`, `connection_name`, `private_ip_address` — for Cloud SQL Auth Proxy and direct-IP consumers.
- `service_account_email_address` — per-instance identity (not the service agent).
- `database_name` — `cortex`.
- `cloudsql_service_agent` — deterministic service-agent member string, for downstream CMEK grants.

## Lifecycle

- `deletion_protection = true` at the GCP level (default).
- `lifecycle { prevent_destroy = true }` at the Terraform level on the instance.
- Both layers on for every env — accidental `terraform destroy` will not remove a Postgres instance anywhere.

## Phase B handoff

Migrations, bi-temporal helpers, RLS policies, and the audit-event table are Phase B of P0.4. They run against the instance this module provisions but are owned by `/services/foundation/migrations/`, not Terraform.
