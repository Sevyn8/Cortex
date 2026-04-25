# `@cortex/observability` smoke test

End-to-end verification that the observability pipeline (`createLogger`,
`createTracer`, `createMetricsRegistry`, `initObservabilitySdk`) actually
exports to GCP — Cloud Logging, Cloud Trace, Cloud Monitoring.

**Manual / on-demand only.** Not wired into CI. Each run emits ~10 log
lines, 2 spans, 3 metric points; cost is negligible per run, but
automating the loop would burn quota and inflate the Cloud Logging bill.
Suggested cadence: once per release, or after any change touching
`packages/observability/src/sdk.ts`.

## What it verifies

1. **Logger** — emits one entry at each severity (DEBUG / INFO / WARNING /
   ERROR) with `module_id`, `correlation_id`, and a custom `marker` field.
   Verifies pino → Cloud Logging field-shape mapping.
2. **Tracer** — opens a `smoke-test/parent` span containing a
   `smoke-test/child` span. Verifies both spans share a `trace_id`.
3. **Metrics** — increments `smoke_test.runs_total` (counter), records
   `smoke_test.duration_ms` (histogram), sets
   `smoke_test.last_run_timestamp_ms` (gauge). Verifies OTLP metric
   export round-trips through Cloud Monitoring.
4. **Correlation context** — wraps everything in `withCorrelationContext`
   so all emissions carry the same `correlation_id` for join-on-id
   filtering across the three backends.

## Prerequisites

- `GCP_PROJECT_ID` — defaults to `sevyn8-cortex-dev`.
- `OTEL_EXPORTER_OTLP_ENDPOINT` — points at an OTel Collector that
  forwards to GCP. Typical setup: `otelcol-contrib` running locally on
  port `4318` with the [`googlecloud` exporter][gcp-exporter] configured.
  If unset, the SDK falls back to `http://localhost:4318`.
- `gcloud auth application-default login` — so the collector / GCP
  exporter can mint tokens.

[gcp-exporter]: https://github.com/GoogleCloudPlatform/opentelemetry-operations-collector

## Run

```bash
# from the repo root
pnpm observability:smoke

# or directly
pnpm --filter @cortex/observability-smoke smoke
```

## Expected output

```
[smoke] correlation_id: <uuid>
[smoke] project:        sevyn8-cortex-dev
[smoke] otlp endpoint:  http://localhost:4318

=== Verification URLs ===
Cloud Logging:    https://console.cloud.google.com/logs/query;query=...
Cloud Trace:      https://console.cloud.google.com/traces/list?tid=...
Cloud Monitoring: https://console.cloud.google.com/monitoring/metrics-explorer?project=...

Note: metric export interval defaults to 60s. Allow ~1 min for ...
```

Open each URL in the browser and verify:

- **Cloud Logging** — 4 entries, one per severity, all with the
  smoke-test's `correlation_id`. `severity` field is uppercase
  (`DEBUG` / `INFO` / `WARNING` / `ERROR`); structured fields appear in
  `jsonPayload`; no `pid` / `hostname`.
- **Cloud Trace** — one trace with two spans (`smoke-test/parent` and
  `smoke-test/child`); child is nested under parent; total duration
  ~100ms (the `setTimeout` inside the child).
- **Cloud Monitoring → Metrics Explorer** — query
  `workload.googleapis.com/smoke_test.runs_total` (counter — should
  increment each run), `smoke_test.duration_ms` (histogram), and
  `smoke_test.last_run_timestamp_ms` (gauge — wall-clock value of the
  last run). Allow ~60s after the script exits before metrics appear,
  per the SDK's default `metricExportIntervalMs`.

## Cost

Per run: ~10 log lines @ <500 bytes each (≈5 KB Cloud Logging
ingestion), 2 spans (Cloud Trace free tier covers 2.5M spans/month), 3
metric points (Cloud Monitoring free tier covers basic metrics). Free
under any reasonable manual cadence.

If the run cost ever becomes nonzero in practice, the SDK's
`metricExportIntervalMs` and `enableAutoInstrumentations: false` knobs
are the levers — both exposed via `initObservabilitySdk` options.

## Troubleshooting

- **No entries in Cloud Logging** — collector probably not running or
  not authenticated. Check `OTEL_EXPORTER_OTLP_ENDPOINT` and that the
  collector is forwarding successfully (its own logs will show the
  outbound HTTP failures).
- **Spans appear but no metrics** — wait a full 60s. The
  `PeriodicExportingMetricReader` flushes on the export interval; on
  shutdown, the SDK flushes pending points, but the smoke test exits
  immediately after the metric writes, so the last interval's data goes
  out via the shutdown drain (handled by `shutdownObservabilitySdk`).
- **`shutdown timed out` warning to stderr** — the collector is
  unreachable; OTLP exports queued past the 5s shutdown timeout. Fix
  the endpoint or auth.
