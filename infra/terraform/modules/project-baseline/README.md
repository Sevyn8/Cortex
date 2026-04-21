# modules/project-baseline

Enables a list of GCP APIs on a project. Zero-opinion on which APIs — callers provide the list.

## Inputs

| Name            | Type           | Description                                         |
| --------------- | -------------- | --------------------------------------------------- |
| `project_id`    | `string`       | Project to baseline.                                |
| `activate_apis` | `list(string)` | API service names (e.g., `compute.googleapis.com`). |

## Outputs

| Name             | Description             |
| ---------------- | ----------------------- |
| `project_id`     | Pass-through.           |
| `activated_apis` | List of APIs activated. |

## Example

```hcl
module "project_baseline" {
  source        = "../../modules/project-baseline"
  project_id    = "sevyn8-cortex-dev"
  activate_apis = [
    "compute.googleapis.com",
    "servicenetworking.googleapis.com",
    # ...
  ]
}
```

## Notes

- `disable_on_destroy = false` on every activation: disabling an API on destroy is a footgun (other resources in the project break). Destroy means "remove from Terraform state", not "disable the API".
- Bootstrap already activates 6 foundational APIs (see `bootstrap/locals.tf`). This module activates the module-specific APIs each environment root needs beyond that set.
