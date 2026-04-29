#!/usr/bin/env bash
# SD4 SIGTERM verification: 3 sequential revision deploys with a
# slow-handler (/v1/test/slow-5s) in flight per deploy. Pass criteria
# (D.1 pass/fail decision tree, SIGTERM ladder):
#   row 1 — clean exit ≤ 8 s, in-flight 2xx, 3/3 deploys → PASS
#   row 2 — clean exit 8–10 s, in-flight 2xx, 3/3 → PASS (margin noted)
#   row 3 — clean exit 10–11 s — SOFT FAIL (investigate + retest)
#   row 4 — clean exit > 11 s OR any 503 → HARD FAIL (reopen ADR + fallback)
#   row 5 — 1 of 3 deploys flaky → repeat with 5; ≥ 2/5 fail → HARD FAIL
#
# Per deploy:
#   1. Capture old_rev (current routing target).
#   2. Start curl to /v1/test/slow-5s in background. The subshell
#      captures its OWN curl-start/end timestamps + status code +
#      response body. The OUTER script's timing measurements would
#      otherwise wrap the foreground `gcloud run services update`
#      call (which is itself blocking, 5–15 s on Cloud Run), making
#      observed inflight times useless.
#   3. Wait 3 s (request mid-handler).
#   4. Trigger Cloud Run revision update (label flip).
#   5. Wait for the curl subshell to complete; read its written
#      values from disk.
#   6. Verify request was served by old_rev (slow-5s response body
#      echoes `revision`). Hot-potato → HARD FAIL Condition 3.
#   7. Wait + retry-loop a Cloud Logging read for the structured
#      "graceful shutdown initiated" + "graceful shutdown complete"
#      log lines emitted by src/index.ts. Compute clean_exit_ms.
#   8. Map to SD4 ladder; append CSV row.
#
# Cloud Logging ingestion lag is 10–60 s. The retry helper waits up
# to 90 s per query.

set -euo pipefail

# cd to repo root so OUT_CSV anchors to a deterministic path
# regardless of invocation directory.
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "${REPO_ROOT}"

ENV="${ENV:-dev}"
PROJECT="sevyn8-cortex-${ENV}"
REGION="${REGION:-asia-south1}"
SERVICE="tenant-lifecycle-shared"
SERVICE_URL="${SERVICE_URL:-$(gcloud run services describe "${SERVICE}" --project="${PROJECT}" --region="${REGION}" --format='value(status.url)')}"

DEPLOY_COUNT="${DEPLOY_COUNT:-3}"
OUT_CSV="${OUT_CSV:-apps/tenant-lifecycle-api/d1-sigterm-$(date +%Y%m%d).csv}"

if [[ ! -f "${OUT_CSV}" ]]; then
  echo "deploy_idx,timestamp_utc,old_revision,new_revision,served_by_revision,inflight_status,inflight_elapsed_ms,shutdown_init_ts,shutdown_complete_ts,clean_exit_ms,verdict" > "${OUT_CSV}"
fi

# Retry-with-backoff helper. Polls Cloud Logging until a result
# materializes or max attempts exhausted. Cloud Logging's ingestion
# lag is normally <30 s but can spike to 90 s under load.
gcloud_logging_read_with_retry() {
  local max_attempts="$1"; shift
  local wait_seconds="$1"; shift
  # Remaining args are passed to gcloud logging read.
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

# Convert RFC3339 timestamp (e.g. 2026-04-29T13:48:12.345Z) to ms epoch.
ts_to_ms() {
  local ts="$1"
  [[ -z "${ts}" ]] && return 1
  date -u -d "${ts}" +%s%3N 2>/dev/null
}

# Extract a JSON string field via python3. Fails closed if the body
# isn't valid JSON or the field is absent.
extract_json_field() {
  local field="$1"
  local file="$2"
  python3 -c "
import json, sys
try:
  with open('${file}') as f:
    print(json.load(f).get('${field}', ''))
except Exception:
  print('')
" 2>/dev/null || echo ""
}

for i in $(seq 1 "${DEPLOY_COUNT}"); do
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  old_rev="$(gcloud run services describe "${SERVICE}" --project="${PROJECT}" --region="${REGION}" --format='value(status.traffic[0].revisionName)')"
  echo "[deploy ${i}/${DEPLOY_COUNT} @ ${ts}] old revision: ${old_rev}"

  body_tmp="$(mktemp)"
  status_tmp="$(mktemp)"
  elapsed_tmp="$(mktemp)"

  # Subshell captures its own start/end timestamps so the outer
  # script's measurement window doesn't wrap the gcloud blocking
  # call. Writes status + elapsed_ms + body to files we read after
  # `wait`.
  (
    set +e
    curl_start="$(date +%s%3N)"
    http_code="$(curl --silent --show-error \
      -o "${body_tmp}" \
      -w "%{http_code}" \
      --max-time 30 \
      -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
      "${SERVICE_URL}/v1/test/slow-5s")"
    curl_end="$(date +%s%3N)"
    echo "${http_code}" > "${status_tmp}"
    echo $((curl_end - curl_start)) > "${elapsed_tmp}"
  ) &
  inflight_pid=$!

  # Let the request reach mid-handler.
  sleep 3

  # Trigger revision update via label flip — harmless, no image change.
  echo "[deploy ${i}/${DEPLOY_COUNT}] triggering revision update"
  rev_start_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  gcloud run services update "${SERVICE}" \
    --project="${PROJECT}" \
    --region="${REGION}" \
    --update-labels="sigterm_test=$(date +%s)" \
    --quiet > /dev/null

  # Wait for the curl subshell to complete; read the values it
  # wrote to disk. inflight_elapsed is now the curl-only duration.
  wait "${inflight_pid}" || true
  inflight_status="$(cat "${status_tmp}")"
  inflight_elapsed="$(cat "${elapsed_tmp}")"
  served_by_revision="$(extract_json_field revision "${body_tmp}")"
  rm -f "${body_tmp}" "${status_tmp}" "${elapsed_tmp}"

  new_rev="$(gcloud run services describe "${SERVICE}" --project="${PROJECT}" --region="${REGION}" --format='value(status.traffic[0].revisionName)')"

  echo "[deploy ${i}/${DEPLOY_COUNT}] inflight: status=${inflight_status} elapsed=${inflight_elapsed}ms served_by=${served_by_revision}"

  # Wait for Cloud Logging to ingest, then query for the structured
  # shutdown log lines. retry helper polls every 10 s up to 9× = 90 s.
  echo "[deploy ${i}/${DEPLOY_COUNT}] querying shutdown logs (Cloud Logging may take 30–60 s to ingest)"

  shutdown_init_ts="$(gcloud_logging_read_with_retry 9 10 \
    "resource.type=cloud_run_revision AND resource.labels.service_name=${SERVICE} AND resource.labels.revision_name=${old_rev} AND jsonPayload.message=\"graceful shutdown initiated\" AND timestamp>=\"${rev_start_iso}\"" \
    --project="${PROJECT}" \
    --limit=1 \
    --format='value(timestamp)' \
    --order=desc || echo '')"

  shutdown_complete_ts="$(gcloud_logging_read_with_retry 9 10 \
    "resource.type=cloud_run_revision AND resource.labels.service_name=${SERVICE} AND resource.labels.revision_name=${old_rev} AND jsonPayload.message=\"graceful shutdown complete\" AND timestamp>=\"${rev_start_iso}\"" \
    --project="${PROJECT}" \
    --limit=1 \
    --format='value(timestamp)' \
    --order=desc || echo '')"

  init_ms="$(ts_to_ms "${shutdown_init_ts}" || echo '')"
  complete_ms="$(ts_to_ms "${shutdown_complete_ts}" || echo '')"

  if [[ -n "${init_ms}" && -n "${complete_ms}" ]]; then
    clean_exit_ms=$((complete_ms - init_ms))
  else
    clean_exit_ms="UNKNOWN"
  fi

  # Verdict per D.1 SIGTERM ladder. Hot-potato gets its own
  # distinguished verdict ahead of the clean_exit-based rows.
  verdict="UNKNOWN"
  if [[ "${served_by_revision}" != "${old_rev}" && "${served_by_revision}" != "unknown" && -n "${served_by_revision}" ]]; then
    # Request was served by a different revision (or by the
    # configurelessly-named one). Condition 3 is preserve-in-flight;
    # if Cloud Run hot-potato'd the request to a new revision, the
    # condition is violated regardless of clean_exit timing.
    verdict="HARD_FAIL_hot_potato_to_${served_by_revision}"
  elif [[ ! "${inflight_status}" =~ ^2 ]]; then
    verdict="HARD_FAIL_row5_inflight_status_${inflight_status}"
  elif [[ "${clean_exit_ms}" =~ ^[0-9]+$ ]]; then
    if [[ "${clean_exit_ms}" -le 8000 ]]; then verdict="PASS_row1"
    elif [[ "${clean_exit_ms}" -le 10000 ]]; then verdict="PASS_row2"
    elif [[ "${clean_exit_ms}" -le 11000 ]]; then verdict="SOFT_FAIL_row3"
    else verdict="HARD_FAIL_row4_clean_exit_${clean_exit_ms}ms"
    fi
  else
    verdict="UNKNOWN_log_lookup_failed"
  fi

  echo "${i},${ts},${old_rev},${new_rev},${served_by_revision},${inflight_status},${inflight_elapsed},${shutdown_init_ts:-UNKNOWN},${shutdown_complete_ts:-UNKNOWN},${clean_exit_ms},${verdict}" >> "${OUT_CSV}"
  echo "[deploy ${i}/${DEPLOY_COUNT}] clean_exit=${clean_exit_ms}ms verdict=${verdict}"
  echo ""

  # Small gap between deploys.
  sleep 30
done

echo ""
echo "==> SIGTERM verification complete. Summary:"
awk -F, 'NR>1 {print $1": "$11}' "${OUT_CSV}"
