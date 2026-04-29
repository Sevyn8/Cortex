#!/usr/bin/env bash
# SD3 cold-start burst measurement.
#
# Cadence: revision rotation via `gcloud run services update-traffic`
# (NOT `gcloud run deploy` cycling — keeps the revision constant; only
# instances scale to zero and back, isolating the cold-start signal
# from revision-fresh effects per SD3 lock).
#
# Per cycle:
#   1. Park traffic on a parking revision (no-op revision deployed
#      once at the start of the burst). This forces the active revision
#      to scale to zero.
#   2. Sleep IDLE_SECONDS (default 900 s = 15 min) — Cloud Run scales
#      to zero after ~15 min idle by default for min-instances=0.
#   3. Re-route traffic to the active revision.
#   4. Issue a single curl GET /health. The first request lands on a
#      cold instance; the OTel cold_start_ms histogram is observed.
#   5. Pull the cold_start_ms observation from Cloud Logging (retry
#      loop — ingestion lag is normally <30 s but spikes to 60 s).
#      Cross-check against Cloud Run's instance_startup_latencies.
#   6. Append to CSV: cycle, revision, cold_start_ms_otel,
#      cold_start_ms_cloudrun.
#
# 30 cycles × ~15 min = ~7.5 hr unattended.
#
# SD3 thresholds (D.1 pass/fail decision tree):
#   - p95 ≤ 350 AND mean ≤ 250 → PASS row 1
#   - p95 350–500 AND mean ≤ 350 → PASS row 2 (with-headroom)
#   - p95 500–650 → SOFT FAIL (diagnose + remeasure)
#   - p95 > 650 OR any single > 1500 → HARD FAIL (reopen ADR-HTTP-001)
#   - range > 2 × mean → expand to 60-burst
#
# Idempotent: safe to interrupt and resume. CSV is appended; cycle
# counter is read from existing rows.
#
# Usage (invocable from anywhere inside the repo):
#   PARKING_REV=tenant-lifecycle-shared-parking \
#   ACTIVE_REV=tenant-lifecycle-shared-00042-abc \
#   ./scripts/cold-start-burst.sh                                # from app dir
#   apps/tenant-lifecycle-api/scripts/cold-start-burst.sh        # from repo root

set -euo pipefail

# cd to repo root so OUT_CSV anchors to a deterministic path
# regardless of invocation directory. `git rev-parse` is idempotent
# (cd-ing to where you already are is a no-op).
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "${REPO_ROOT}"

ENV="${ENV:-dev}"
PROJECT="sevyn8-cortex-${ENV}"
REGION="${REGION:-asia-south1}"
SERVICE="tenant-lifecycle-shared"
SAMPLES="${SAMPLES:-30}"
IDLE_SECONDS="${IDLE_SECONDS:-900}"
# Default lands the CSV alongside the app — predictable location for
# the next session to pick up. Override OUT_CSV to redirect.
OUT_CSV="${OUT_CSV:-apps/tenant-lifecycle-api/d1-cold-start-$(date +%Y%m%d).csv}"
PARKING_REV="${PARKING_REV:?must set PARKING_REV (tenant-lifecycle-shared-parking)}"
ACTIVE_REV="${ACTIVE_REV:?must set ACTIVE_REV (current revision suffix to measure)}"
SERVICE_URL="${SERVICE_URL:-$(gcloud run services describe "${SERVICE}" --project="${PROJECT}" --region="${REGION}" --format='value(status.url)')}"

# Init CSV on first run.
if [[ ! -f "${OUT_CSV}" ]]; then
  echo "cycle,timestamp_utc,revision,cold_start_ms_otel,cold_start_ms_cloudrun" > "${OUT_CSV}"
fi

# Resume support: skip cycles already recorded.
START_CYCLE="$(($(wc -l < "${OUT_CSV}") - 0))"
if [[ "${START_CYCLE}" -gt "${SAMPLES}" ]]; then
  echo "All ${SAMPLES} cycles already recorded in ${OUT_CSV}. Nothing to do."
  exit 0
fi

# Retry-with-backoff helpers. Cloud Logging's ingestion lag is
# normally <30 s but spikes under load — the previous fixed
# `sleep 5` in this script was insufficient and produced empty
# otel_ms values for racing cycles. Cloud Monitoring's lag is
# similar but the API surface is different (time-series list, not
# logging read), so we keep two helpers.
gcloud_logging_read_with_retry() {
  local max_attempts="$1"; shift
  local wait_seconds="$1"; shift
  local attempt=1
  local result=""
  while [[ "${attempt}" -le "${max_attempts}" ]]; do
    result="$(gcloud logging read "$@" 2>/dev/null || true)"
    if [[ -n "${result}" ]]; then
      printf '%s' "${result}"
      return 0
    fi
    sleep "${wait_seconds}"
    attempt=$((attempt + 1))
  done
  return 1
}

gcloud_monitoring_ts_with_retry() {
  local max_attempts="$1"; shift
  local wait_seconds="$1"; shift
  local attempt=1
  local result=""
  while [[ "${attempt}" -le "${max_attempts}" ]]; do
    result="$(gcloud monitoring time-series list "$@" 2>/dev/null || true)"
    if [[ -n "${result}" ]]; then
      printf '%s' "${result}"
      return 0
    fi
    sleep "${wait_seconds}"
    attempt=$((attempt + 1))
  done
  return 1
}

echo "==> Cold-start burst: ${SAMPLES} cycles, ${IDLE_SECONDS}s idle each"
echo "==> Service: ${SERVICE} @ ${SERVICE_URL}"
echo "==> Parking revision: ${PARKING_REV}"
echo "==> Active revision (under measurement): ${ACTIVE_REV}"
echo "==> Output: ${OUT_CSV}"
echo ""

for cycle in $(seq "${START_CYCLE}" "${SAMPLES}"); do
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "[cycle ${cycle}/${SAMPLES} @ ${ts}] parking traffic"
  gcloud run services update-traffic "${SERVICE}" \
    --project="${PROJECT}" \
    --region="${REGION}" \
    --to-revisions="${PARKING_REV}=100" \
    --quiet > /dev/null

  echo "[cycle ${cycle}/${SAMPLES}] idle ${IDLE_SECONDS}s for scale-to-zero"
  sleep "${IDLE_SECONDS}"

  echo "[cycle ${cycle}/${SAMPLES}] routing back to active"
  gcloud run services update-traffic "${SERVICE}" \
    --project="${PROJECT}" \
    --region="${REGION}" \
    --to-revisions="${ACTIVE_REV}=100" \
    --quiet > /dev/null

  # Issue the cold request. The first request after scale-to-zero
  # lands on a freshly-spawned instance; recordColdStartOnce() in
  # the app fires once + emits the cold_start_ms structured log.
  echo "[cycle ${cycle}/${SAMPLES}] cold request"
  curl --fail --silent --show-error \
    -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
    "${SERVICE_URL}/health" > /dev/null

  # Retry-loop the gcloud reads (was: a fixed `sleep 5` that raced
  # ingestion lag and produced empty values).
  echo "[cycle ${cycle}/${SAMPLES}] querying observations (Cloud Logging may take 30–60 s)"
  otel_ms="$(gcloud_logging_read_with_retry 9 10 \
    "resource.type=cloud_run_revision AND resource.labels.service_name=${SERVICE} AND jsonPayload.marker=d1-cold-start AND jsonPayload.revision=${ACTIVE_REV} AND timestamp>=\"${ts}\"" \
    --project="${PROJECT}" \
    --limit=1 \
    --format='value(jsonPayload.cold_start_ms)' \
    --order=desc || echo 'UNKNOWN')"

  # Cloud Run native cross-check via Cloud Monitoring. Distinct API
  # surface from Cloud Logging — uses time-series list, not log read.
  cloudrun_ms="$(gcloud_monitoring_ts_with_retry 6 10 \
    --project="${PROJECT}" \
    --filter="metric.type=\"run.googleapis.com/container/startup_latencies\" AND resource.labels.service_name=\"${SERVICE}\" AND resource.labels.revision_name=\"${ACTIVE_REV}\"" \
    --interval-end-time="$(date -u -d '+1 minute' +%Y-%m-%dT%H:%M:%SZ)" \
    --interval-start-time="${ts}" \
    --format='value(points[0].value.distributionValue.mean)' || echo 'UNKNOWN')"

  echo "${cycle},${ts},${ACTIVE_REV},${otel_ms},${cloudrun_ms}" >> "${OUT_CSV}"
  echo "[cycle ${cycle}/${SAMPLES}] otel=${otel_ms}ms cloudrun=${cloudrun_ms}ms"
done

echo ""
echo "==> Burst complete. Summarize:"
echo "    awk -F, 'NR>1 {print \$4}' ${OUT_CSV} | sort -n | awk 'BEGIN{c=0;s=0} {a[c++]=\$1; s+=\$1} END{p95=a[int(c*0.95)]; print \"n=\"c, \"mean=\"s/c, \"p50=\"a[int(c*0.5)], \"p95=\"p95, \"max=\"a[c-1]}'"
