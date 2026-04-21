# modules/kms

Creates a KMS keyring and a list of symmetric ENCRYPT_DECRYPT keys.

**Dormant in P0.3.** Environment keyrings and keys are bootstrap-owned. This module is the canonical pattern for future modules that need their own narrow-scope keyring.

## Inputs

| Name               | Type           | Default            | Description                                         |
| ------------------ | -------------- | ------------------ | --------------------------------------------------- |
| `project_id`       | `string`       | —                  | Project to place the keyring in.                    |
| `location`         | `string`       | `"asia-south1"`    | KMS location. Must match encrypted-resource region. |
| `keyring_name`     | `string`       | —                  | Name of the keyring.                                |
| `keys`             | `list(string)` | —                  | Key names to create.                                |
| `rotation_period`  | `string`       | `"7776000s"` (90d) | Auto-rotation cadence.                              |
| `protection_level` | `string`       | `"SOFTWARE"`       | `SOFTWARE` or `HSM`.                                |
| `common_labels`    | `map(string)`  | `{}`               | Labels applied to each key.                         |

## Outputs

| Name         | Description                        |
| ------------ | ---------------------------------- |
| `keyring_id` | Keyring resource ID.               |
| `key_ids`    | Map of key_name → key resource ID. |

## Notes

- `lifecycle { prevent_destroy = true }` on every key. This cannot be a variable (Terraform requires lifecycle args to be literal). To destroy a key via this module, `terraform state rm` first — the friction is intentional.
- No IAM bindings here. Callers grant service-agent access separately.
