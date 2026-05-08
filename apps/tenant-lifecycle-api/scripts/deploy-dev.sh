#!/usr/bin/env bash
# Cloud Run dev deploy for tenant-lifecycle-shared (image-update-only).
# Post-D.4: the TF module `tenant-cloud-run-service` (instantiated as
# module.tenant_lifecycle_shared in dev/main.tf) owns the service
# shape — runtime SA, Cloud SQL Unix-socket mount, scaling, ingress,
# CPU/memory, labels. This script ONLY updates the Cloud Run service
# to point at a SHA-tagged image already present in cortex-apps.
#
# Image bootstrap is a separate concern. To push a new SHA-tagged
# image, run:
#     make image-bootstrap APP=tenant-lifecycle-api WORKLOAD=tenant-lifecycle
# from the repo root. That target (Makefile) handles the build +
# push to sevyn8-cortex-shared/cortex-apps; this script handles the
# subsequent service-image-update. Two commands per deploy, one
# concern per command. cortex-apps has tag immutability enabled
# (immutable_tags = true on the AR repo) — pushing the same SHA
# twice is rejected, which is why image-bootstrap and deploy are
# separate steps.
#
# TF's `lifecycle.ignore_changes = [template[0].containers[0].image]`
# preserves the deployed SHA on subsequent `tf-apply-dev` runs.
#
# ── Auth model (ADR-INFRA-005 Decision 11) ──────────────────────────
# `cloudsql.iam_authentication = on` is the only active path. The
# postgres superuser has no password; the break-glass secret
# (cortex-db-postgres-break-glass-{env}) is emergency-only.
#
# Cloud Run's --add-cloudsql-instances connector (TF-set) injects a
# Unix socket at /cloudsql/{INSTANCE_CONNECTION_NAME}; the app's
# pg.Pool authenticates with PG_IAM_USER + an OAuth-token password
# callback for the runtime SA (see src/db.ts). All of these env vars
# are TF-set — this script does not touch them.
#
# Usage (invocable from anywhere inside the repo):
#   ./scripts/deploy-dev.sh           # from apps/tenant-lifecycle-api/
#   apps/tenant-lifecycle-api/scripts/deploy-dev.sh   # from repo root

set -euo pipefail

ENV="${ENV:-dev}"
PROJECT="sevyn8-cortex-${ENV}"
REGION="${REGION:-asia-south1}"
SERVICE="tenant-lifecycle-shared"

# Image SHA derives from current HEAD. The image must already exist
# in cortex-apps (push via `make image-bootstrap` first). git
# rev-parse works from any subdir of the repo.
COMMIT_SHA="$(git rev-parse --short HEAD)"
SHARED_PROJECT="${SHARED_PROJECT:-sevyn8-cortex-shared}"
IMAGE_REPO="${REGION}-docker.pkg.dev/${SHARED_PROJECT}/cortex-apps/tenant-lifecycle-api"
IMAGE_SHA="${IMAGE_REPO}:sha-${COMMIT_SHA}"

echo "==> Updating Cloud Run service image (${SERVICE} in ${PROJECT}/${REGION})"
echo "    target image: ${IMAGE_SHA}"
# `gcloud run services update` not `gcloud run deploy`: the latter
# performs full revision replacement with all flags re-applied;
# `update` is partial (only the flags supplied). For TF-managed
# services we want partial — to avoid blanking out TF-owned config.
#
# Image-update-only by design — env vars are TF-managed
# (dev/main.tf module.tenant_lifecycle_shared.extra_env_vars carries
# NODE_ENV=development + ENABLE_TEST_ROUTES=true) and COMMIT_SHA is
# baked into the image at build time (Dockerfile ARG, set by
# `make image-bootstrap`). Both seams that D.4 finalization closed.
gcloud run services update "${SERVICE}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --image="${IMAGE_SHA}"

echo ""
echo "==> Service URL:"
gcloud run services describe "${SERVICE}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --format='value(status.url)'

echo ""
echo "==> Operator access (SD8 deny-by-default; D.5 grants invoker IAM):"
echo "    gcloud run services proxy ${SERVICE} --project=${PROJECT} --region=${REGION}"
echo "    # then in another shell:"
echo "    curl http://localhost:8080/health"
