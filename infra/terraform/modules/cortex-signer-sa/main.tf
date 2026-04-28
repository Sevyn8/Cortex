# ─────────────────────────────────────────────────────────────────────────────
# cortex-signer-sa — per-env signing identity for tenant export archives.
#
# Per F02 Slice C convention §10.8 + sub-phase 7.6 locks (Q-NEW-C14, C15,
# C16, C21, C22, C23): a workload-scoped SA whose only authority is to sign
# GCS pre-signed URLs for tenant export archives. Decoupling the signer
# identity from the runtime identity gives:
#   - Defense-in-depth: signer SA holds only `roles/storage.objectViewer`
#     on the tenant-data bucket; runtime SA carries broader I/O perms.
#   - Audit clarity: every signed URL surfaces a stable signer identity
#     in `iam.googleapis.com/SignBlob` audit logs.
#   - Forward-readiness: the runtime SA grants
#     `roles/iam.serviceAccountTokenCreator` on this SA NOW. When the
#     application code (`packages/tenant-context/src/export-archive.ts`)
#     switches from default-ADC signing to SA impersonation
#     (`GoogleAuth({ targetPrincipal: <signerSAEmail> })` calling IAM
#     SignBlob), no infrastructure rollout is required.
#
# Phase 1 staging: TF landed in sub-phase 7.6; application impersonation
# deferred. Runtime SA currently signs as itself via default ADC. Phase 1
# has 0 production tenants, so no real signed URL is gated by the staging
# gap. See convention §6.1 for the full staged-rollout note.
# ─────────────────────────────────────────────────────────────────────────────

resource "google_service_account" "signer" {
  project      = var.project_id
  account_id   = "cortex-export-signer-${var.environment}"
  display_name = "Cortex export signer (${var.environment})"
  description  = "Workload-scoped signing identity for tenant export archives. F02 Slice C convention §10.8 + sub-phase 7.6. Runtime SA holds roles/iam.serviceAccountTokenCreator on this SA for future SignBlob-based signing; app-side impersonation deferred."
}

# Runtime SA can impersonate this signer SA via IAM SignBlob.
# Per CLAUDE.md TF conventions: iam_member (additive); never iam_policy
# (authoritative — would clobber other bindings).
resource "google_service_account_iam_member" "runtime_can_impersonate" {
  service_account_id = google_service_account.signer.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${var.runtime_sa_email}"
}

# Signer SA gets read access to the tenant-data bucket. Pre-signed URLs
# can only grant operations the signing identity itself is authorized to
# perform — without this grant, signed URLs (once impersonation lands)
# would return 403 from GCS regardless of the signature's validity.
resource "google_storage_bucket_iam_member" "signer_object_viewer" {
  bucket = var.tenant_data_bucket_name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.signer.email}"
}
