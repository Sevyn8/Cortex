#!/usr/bin/env bash
# Cloud Run dev deploy for D.1 prototype per SD2 (real Cloud Run dev,
# not local Docker). Inline gcloud commands; D.4 ships the proper
# tenant-cloud-run-service TF module.
#
# ── Auth model (ADR-INFRA-005 Decision 11) ──────────────────────────
# `cloudsql.iam_authentication = on` is the only active path. The
# postgres superuser has no password set; the break-glass secret
# (cortex-db-postgres-break-glass-{env}) is for emergency-only
# manual access, NOT application use.
#
# This deploy uses Cloud Run's native --add-cloudsql-instances
# connector (option a per the operator's note): Cloud Run injects a
# Unix socket at /cloudsql/{INSTANCE_CONNECTION_NAME}; the app's
# pg.Pool authenticates with PG_IAM_USER + a password callback that
# fetches OAuth tokens for the runtime SA (see src/db.ts).
#
# ── D.4 follow-up (TF gap, blocking /v1/tenants/{id} only) ───────────
# The runtime SA tenant-lifecycle-runtime-dev currently lacks:
#   1. roles/cloudsql.client on sevyn8-cortex-dev (network reach).
#   2. roles/cloudsql.instanceUser on the cortex-dev-postgres
#      instance (IAM-auth login).
#   3. A google_sql_user resource of type CLOUD_IAM_SERVICE_ACCOUNT
#      registering tenant-lifecycle-runtime@sevyn8-cortex-dev.iam
#      as a Cloud SQL database user.
#   4. SQL grants (CONNECT on cortex, USAGE on schema, SELECT on
#      tenant + tenant_kms_key + …) — applied via migration in D.4.
#
# Until D.4 lands these, /v1/tenants/{id} returns 500 on first DB
# query. /health and /v1/test/slow-5s do NOT touch the DB, so D.1's
# Conditions 2 + 3 measurement (cold-start + SIGTERM) proceeds against
# them unchanged.
#
# ── Per Q-NEW-D-11 + SD8 ─────────────────────────────────────────────
# No new runtime SAs in D.1; we re-use tenant-lifecycle-runtime-dev
# (Slice C 7.6, commit e6e44c9). Service deployed with
# --no-allow-unauthenticated; operator access during measurement via
# `gcloud run services proxy` or an explicit --member grant.
#
# Usage (invocable from anywhere inside the repo, including the root
# and apps/tenant-lifecycle-api/):
#   ./scripts/deploy-dev.sh           # from apps/tenant-lifecycle-api/
#   apps/tenant-lifecycle-api/scripts/deploy-dev.sh   # from repo root

set -euo pipefail

# The Dockerfile uses workspace-rooted COPY paths
# (apps/tenant-lifecycle-api/..., packages/..., pnpm-lock.yaml, etc.) so
# the build context MUST be the repo root. `git rev-parse` is
# idempotent — cd-ing into a directory you're already in is a no-op,
# so this works whether invoked from the repo root or any subdir.
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "${REPO_ROOT}"

ENV="${ENV:-dev}"
PROJECT="sevyn8-cortex-${ENV}"
REGION="${REGION:-asia-south1}"
SERVICE="tenant-lifecycle-shared"
RUNTIME_SA_ACCOUNT="tenant-lifecycle-runtime"
RUNTIME_SA="${RUNTIME_SA_ACCOUNT}@${PROJECT}.iam.gserviceaccount.com"
# Cloud SQL IAM-auth username = full SA email minus the
# .gserviceaccount.com suffix per Cloud SQL docs.
PG_IAM_USER="${RUNTIME_SA_ACCOUNT}@${PROJECT}.iam"

# Cloud SQL instance connection name (matches infra/cloud-build/migrate.yaml).
INSTANCE_CONNECTION_NAME="${PROJECT}:${REGION}:cortex-${ENV}-postgres"

# Image tagging per CLAUDE.md §"Image tagging": SHA tags immutable;
# floating dev tag for human convenience.
COMMIT_SHA="$(git rev-parse --short HEAD)"
IMAGE_REPO="${REGION}-docker.pkg.dev/${PROJECT}/cortex-images/tenant-lifecycle-api"
IMAGE_SHA="${IMAGE_REPO}:sha-${COMMIT_SHA}"
IMAGE_DEV="${IMAGE_REPO}:dev"

echo "==> Building image ${IMAGE_SHA} (context: ${REPO_ROOT})"
docker build \
  --platform linux/amd64 \
  -t "${IMAGE_SHA}" \
  -t "${IMAGE_DEV}" \
  -f apps/tenant-lifecycle-api/Dockerfile \
  .

echo "==> Pushing image"
docker push "${IMAGE_SHA}"
docker push "${IMAGE_DEV}"

echo "==> Deploying to Cloud Run (${SERVICE} in ${PROJECT}/${REGION})"
# --add-cloudsql-instances: Cloud Run mounts the Cloud SQL Auth Proxy
# socket at /cloudsql/{INSTANCE_CONNECTION_NAME}; the app reads
# CLOUDSQL_INSTANCE_CONNECTION_NAME and composes the host path itself.
# Test-routes flag is the dev-only gate (per ENABLE_TEST_ROUTES in
# config.ts). NODE_ENV=development unlocks the slow-5s endpoint.
# COMMIT_SHA exposed for /health response shape.
# NO --update-secrets: IAM auth replaces password-based auth; there
# are no PG-credential secrets to inject.
gcloud run deploy "${SERVICE}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --image="${IMAGE_SHA}" \
  --service-account="${RUNTIME_SA}" \
  --no-allow-unauthenticated \
  --port=8080 \
  --min-instances=0 \
  --max-instances=10 \
  --cpu=1 \
  --memory=512Mi \
  --concurrency=80 \
  --timeout=60 \
  --add-cloudsql-instances="${INSTANCE_CONNECTION_NAME}" \
  --set-env-vars="NODE_ENV=development,ENABLE_TEST_ROUTES=true,COMMIT_SHA=${COMMIT_SHA},GCP_PROJECT_ID=${PROJECT},CLOUDSQL_INSTANCE_CONNECTION_NAME=${INSTANCE_CONNECTION_NAME},PG_IAM_USER=${PG_IAM_USER},PGDATABASE=cortex" \
  --labels="workload=tenant-lifecycle,placement=shared,managed_by=manual,prompt=p1-2-slice-d-d1"

echo ""
echo "==> Service URL:"
gcloud run services describe "${SERVICE}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --format='value(status.url)'

echo ""
echo "==> Operator access (SD8 deny-by-default; needs invoker IAM):"
echo "    gcloud run services proxy ${SERVICE} --project=${PROJECT} --region=${REGION}"
echo "    # then in another shell:"
echo "    curl http://localhost:8080/health"
echo ""
echo "==> Reminder: /v1/tenants/{id} requires the D.4 TF follow-up"
echo "    (cloudsql.client + cloudsql.instanceUser + google_sql_user +"
echo "    SQL grants for ${PG_IAM_USER}). /health and /v1/test/slow-5s"
echo "    work without it; cold-start + SIGTERM measurement proceeds."
