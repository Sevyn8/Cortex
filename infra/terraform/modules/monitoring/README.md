# monitoring

Per-env Cloud Monitoring alert policies + notification channels. Operator-facing
observability substrate: email + Google Chat channels, Cloud SQL health alerts,
Cloud Build failure alerts, log-based metrics for WIF + Cloud Build submit
failures.

Library package (`@cortex/observability`) is a separate future deliverable —
see ADR-OBS-001 Decision 3 for sequencing rationale.

## Inputs

| Variable                    | Type                                             | Required | Description                                                                                                                                                                |
| --------------------------- | ------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project_id`                | string                                           | yes      | Env GCP project hosting monitoring resources (e.g., `sevyn8-cortex-dev`).                                                                                                  |
| `environment`               | string                                           | yes      | Environment key: `dev` / `staging` / `prod`. Drives display names and Cloud Build failure severity routing (CRITICAL in prod, WARNING elsewhere).                          |
| `cloud_sql_instance_name`   | string                                           | yes      | Cloud SQL instance name (e.g., `cortex-dev-postgres`). Used to filter Cloud SQL metrics to the single per-env instance.                                                    |
| `cloud_sql_max_connections` | number                                           | yes      | Max connections database flag (dev/staging=100, prod=200). 80% of this is the connections-high alert threshold.                                                            |
| `notification_recipients`   | list(object({display_name=string,email=string})) | yes      | Per-env email recipients. One `email`-type channel created per recipient. Comes from `terraform.tfvars.local` (gitignored — personal identities out of repo).              |
| `chat_webhook_url`          | string (sensitive)                               | yes      | Google Chat incoming webhook URL. Becomes `labels.url` on `webhook_tokenauth` channel. Sensitive propagation redacts in plan; plaintext in state (CMEK-encrypted at rest). |

## Outputs

| Output              | Type        | Description                                                                                                                                   |
| ------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `email_channel_ids` | map(string) | Recipient display_name → channel ID. For Phase 2 library per-service alerts and Phase 3 dashboards.                                           |
| `chat_channel_id`   | string      | Google Chat channel ID. For future CRITICAL-route consumers.                                                                                  |
| `alert_policy_ids`  | map(string) | Alert policy key → policy ID. Keys match main.tf resource addresses (e.g., `cloud_sql_cpu_high`). For Phase 3 dashboards linking alert state. |

## Usage

Instantiated per env from the env root module. Example (dev):

```hcl
module "monitoring" {
  source = "../../modules/monitoring"

  project_id                = var.project_id
  environment               = "dev"
  cloud_sql_instance_name   = "cortex-dev-postgres"
  cloud_sql_max_connections = 100
  notification_recipients   = var.notification_recipients  # from tfvars.local
  chat_webhook_url          = var.chat_webhook_url         # from tfvars.local

  depends_on = [module.project_baseline]
}
```

`module.project_baseline` must run first — monitoring/logging APIs live in its
`activate_apis` list, and the IAM audit-log config for STS log visibility lives
in the same module.

## Post-apply verification

Two classes of verification: channel delivery (do alerts reach operators?) and
log-based metric accuracy (do the filters actually match the events we care
about?).

### Channel delivery

For each env, in the Cloud Monitoring console:

1. Navigate to Alerting → Notification Channels
2. Find an email channel (e.g., "Amit (dev)") and click "Test"
3. Confirm email arrives at the expected address
4. Repeat for the `Cortex Alerts — Google Chat (dev)` channel — confirm a test
   message appears in the Cortex Alerts Chat space

If the Chat test fails: regenerate the webhook URL in the Chat space, update
the env's `terraform.tfvars.local`, re-apply.

### Log-based metric filters — synthetic failure tests

The filter strings for `wif_auth_failures` and `cloud_build_submit_failures`
are best-guess starting points. Validate by triggering synthetic failures and
confirming the counter increments.

**WIF auth failure synthetic:**

1. Dispatch migrate-dev.yaml with a workflow file at the wrong ref (e.g., push
   a temporary branch and dispatch from there — the `workflow_ref` attribute
   won't match the SA binding, STS token exchange fails)
2. Check Cloud Monitoring → Metrics Explorer → search `cortex/wif_auth_failures`
3. Confirm the counter increments within a minute

**Cloud Build submit failure synthetic:**

1. Run `gcloud builds submit` with an invalid `--service-account` (e.g., an SA
   that doesn't exist in the project)
2. The CreateBuild API call returns 403; the submit fails
3. Check `cortex/cloud_build_submit_failures` counter — should increment

If either counter doesn't increment despite a real failure being triggered:

- Check Cloud Logging filter directly via the console with the module's filter
  string; adjust if needed
- Post-apply refinements: add an Observation to ADR-OBS-001 Implementation
  notes documenting the filter string that worked

### Alert policy firing — smoke test (optional, dev-only)

To confirm an alert policy actually fires and routes:

1. In dev only, temporarily lower the `cloud_sql_disk_80` threshold to 0.001
   (0.1%). Disk utilization is never zero on a running instance, so this is
   guaranteed to fire quickly. (Don't use CPU for this — a Cloud SQL instance
   with no traffic may genuinely idle below 0.01 CPU, making the test
   ambiguous.)
2. Wait ~5 minutes for the condition's duration (300s) to elapse
3. Confirm email notification received (disk_80 routes to WARNING channels,
   i.e., emails only — no Chat)
4. Revert threshold

Don't do this in staging or prod.

## Design notes

### webhook_tokenauth for Google Chat (not native google_chat)

Google Cloud Monitoring's native `google_chat` channel type requires the
Cloud Monitoring bot to be added as a member of the target Chat space. In
Sevyn8's Workspace, the bot wasn't discoverable via the standard Chat
member-add flow (verified during P0.6 scoping — screenshot confirmed). Rather
than debug Workspace admin settings, the module uses `webhook_tokenauth`
pointing at the incoming-webhook URL of the Cortex Alerts space. The URL
embeds the auth token in query-string params (`key=...&token=...`); there is
no separate `auth_token` field to move into `sensitive_labels`.

Terraform's sensitive-variable propagation (via `var.chat_webhook_url` marked
`sensitive = true`) redacts the `labels` map as a whole in plan output. In
state file, the URL is stored plaintext — mitigation is GCS CMEK encryption at
rest (P0.3 state posture). Rotation is a 3-step operator path: regenerate URL
in Chat, update tfvars.local, re-apply.

See ADR-OBS-001 Decision 4 for the full pivot history.

### Severity routing

CRITICAL alerts route to email recipients + Chat webhook. WARNING alerts route
to email only, keeping Chat quiet to prevent alert fatigue. Env-dependent:
Cloud Build failures are CRITICAL in prod, WARNING in dev/staging.

See ADR-OBS-001 Decision 4 (routing) and scope doc "In scope → Operator
infrastructure" for the severity table.

## References

- ADR-OBS-001 — Observability baseline architecture (authoritative decisions;
  live Implementation notes section for post-apply observations).
- `docs/planning/p0-6-observability-scope.md` — scope delineation.
- `docs/deviations.md` — catalog entries for all 6 P0.6 divergences.
