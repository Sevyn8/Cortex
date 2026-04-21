# modules/secret

Creates a CMEK-encrypted Secret Manager secret. **No secret version is created** — callers write secret values via a separate step (often out-of-band, not in Terraform).

**Dormant in P0.3.** Per-module prompts (P0.7 and later) will call this module when they need to materialize a specific secret.

## Inputs

| Name                    | Type           | Default           | Description                                            |
| ----------------------- | -------------- | ----------------- | ------------------------------------------------------ |
| `project_id`            | `string`       | —                 | GCP project.                                           |
| `secret_id`             | `string`       | —                 | Must match `cortex-<category>-<name>` (see CLAUDE.md). |
| `kms_key_id`            | `string`       | —                 | CMEK key resource ID.                                  |
| `replication_locations` | `list(string)` | `["asia-south1"]` | user_managed replication regions.                      |
| `common_labels`         | `map(string)`  | `{}`              | Labels.                                                |

## Outputs

| Name          | Description         |
| ------------- | ------------------- |
| `secret_id`   | Short ID.           |
| `secret_name` | Full resource name. |

## Example

```hcl
module "workos_api_secret" {
  source                = "../../modules/secret"
  project_id            = var.project_id
  secret_id             = "cortex-auth-workos-api-key"
  kms_key_id            = data.google_kms_crypto_key.secrets.id
  common_labels         = local.common_labels
}
```

## Notes

- `user_managed` replication is forced because CMEK requires it. Automatic replication with CMEK is not supported by Secret Manager.
- Naming is enforced via a regex `validation` on `secret_id`. Failing names halt `terraform plan`.
- No IAM bindings here. Callers grant `secretmanager.secretAccessor` to the consuming runtime SA separately.
