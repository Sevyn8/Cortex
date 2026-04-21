# ─────────────────────────────────────────────────────────────────────────────
# project-baseline — activate a list of APIs on a GCP project.
#
# Deliberately does NOT:
#   - Apply project-level labels (see infra/terraform/README.md for why).
#   - Manage the google_project resource itself (projects are created
#     out-of-band, billing is linked out-of-band).
#   - Enable APIs globally; callers curate the list per environment.
# ─────────────────────────────────────────────────────────────────────────────

resource "google_project_service" "activated" {
  for_each = toset(var.activate_apis)

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
