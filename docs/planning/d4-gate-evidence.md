# F02 Slice D Sub-phase D.4 — gate evidence

> Captured 2026-05-08 against `tenant-lifecycle-shared` in dev.
> Service URL: `https://tenant-lifecycle-shared-fhl4kqrfca-el.a.run.app`
> Test tenant: `6f492b92-f885-46d2-8bf3-f313c99590e1` (external_id `d4-gate-evidence-2`)

## What this evidence proves

Sub-phase D.4 had two architectural goals:

1. **IAM + network gap closure** — runtime SA can read/write Cloud SQL through the runtime path declared in TF (Cloud SQL IAM grants + VPC connector + new internal-egress firewall + Cloud SQL Auth Proxy + RLS).
2. **Routes wired correctly** — every tenant-lifecycle endpoint reaches its handler with the right auth, validation, and state-machine guard.

The five curls below cover both. Where the brief expected lifecycle "happy-path" 202s, those require a tenant in `READY`/`ACTIVE` state — produced by the provisioning worker. Per `packages/tenant-context/src/tenants.ts:670`, that worker lands in **sub-phase 4.3** (not D.4). Tenants seeded in D.4 stay in `PROVISIONING`, so the offboard/terminate/force-terminate routes return well-formed 409s rather than 202s. The 409s are still meaningful evidence (route reachable, auth working, RFC 7807 envelope well-formed, state-machine guard enforced); see "Note on 409s" below.

## Curl 0 — POST /v1/tenants — seed (verifies worker URL closure)

```
$ curl -X POST -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    "$SERVICE_URL/v1/tenants" \
    -d '{"external_id":"d4-gate-evidence-2","display_name":"D.4 Gate Evidence Tenant 2","tier":"STANDARD"}'

{"tenant_id":"6f492b92-f885-46d2-8bf3-f313c99590e1","status":"PROVISIONING"}

HTTP 202    TIME 0.857675s
```

Proves:

- POST /v1/tenants reaches the handler
- `tenants.provision` creates the row + dispatches the Cloud Tasks dispatch successfully
- `PROVISIONING_WORKER_URL` env var is now set on the deployed service (closure of the worker-URL gap surfaced during D.4 close-out — see commit body)

## Curl 1 — GET /v1/tenants/:id — D.4 IAM gap closure proof (headline)

```
$ curl -H "Authorization: Bearer $TOKEN" \
    "$SERVICE_URL/v1/tenants/6f492b92-f885-46d2-8bf3-f313c99590e1"

{"id":"6f492b92-f885-46d2-8bf3-f313c99590e1","external_id":"d4-gate-evidence-2","display_name":"D.4 Gate Evidence Tenant 2","tier":"STANDARD","status":"PROVISIONING","created_at":"2026-05-08T19:17:29.651Z","updated_at":"2026-05-08T19:17:29.651Z","last_key_rotated_at":null,"terminated_at":null,"offboarding_grace_until":null,"legal_hold":false,"dedicated_db_approved":false}

HTTP 200    TIME 0.343411s
```

Proves end-to-end (every layer the D.4 work touched):

- Cloud Run invoker IAM accepts the SA token
- runtime SA → Cloud SQL `roles/cloudsql.client` + `roles/cloudsql.instanceUser` grants work (D.4 IAM gap closure)
- Cloud Run → VPC connector → connector subnet egress
- **NEW** internal-egress firewall rule allows connector → PSA range on TCP:3307 (would 500 in 10s without it; this rule was added in D.4 amending ADR-INFRA-003)
- Cloud SQL Auth Proxy mounts on Unix socket and authenticates via runtime SA token
- `google_sql_user` of type `CLOUD_IAM_SERVICE_ACCOUNT` registered the runtime SA as a DB role (D.4 TF binding)
- Migration 0012 GRANTed CONNECT/USAGE/SELECT to that role (D.4 migration)
- RLS-bound `withTenantDbClient` returns the row

## Curl 2 — POST /v1/tenants/:id/offboard

```
$ curl -X POST -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    "$SERVICE_URL/v1/tenants/6f492b92-f885-46d2-8bf3-f313c99590e1/offboard" \
    -d '{"grace_period_days":30}'

{"code":"CONFLICT","type":"about:blank","status":409,"title":"CONFLICT","detail":"Tenant 6f492b92-f885-46d2-8bf3-f313c99590e1 has status PROVISIONING; expected one of [READY, ACTIVE]","instance":"/v1/tenants/6f492b92-f885-46d2-8bf3-f313c99590e1/offboard"}

HTTP 409    TIME 0.302071s
```

Proves: route reachable, JSON validated, state-machine guard correctly rejects offboard from `PROVISIONING`.

Brief expectation was 202 (D.3 deferred-skip happy path #1) — requires `READY`/`ACTIVE`. Sub-phase 4.3 prerequisite.

## Curl 3 — POST /v1/tenants/:id/terminate — §7.4 contract evidence

```
$ curl -X POST -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    "$SERVICE_URL/v1/tenants/6f492b92-f885-46d2-8bf3-f313c99590e1/terminate" \
    -d '{}'

{"code":"CONFLICT","type":"about:blank","status":409,"title":"CONFLICT","detail":"Tenant 6f492b92-f885-46d2-8bf3-f313c99590e1 has status PROVISIONING; expected one of [OFFBOARDING]","instance":"/v1/tenants/6f492b92-f885-46d2-8bf3-f313c99590e1/terminate"}

HTTP 409    TIME 0.177562s
```

Proves: route reachable, empty-body validation passes, state-machine guard correctly rejects terminate from `PROVISIONING`.

Brief expectation was 202 if grace elapsed, 409 with §7.4 contract message otherwise. The 409 is the "otherwise" branch — but it's gating on state, not on grace, because the tenant is `PROVISIONING` (not `OFFBOARDING`). The §7.4 contract evidence (rejecting terminate before grace expires) is structurally indistinguishable from the response shape; deferred to when sub-phase 4.3 lands and a tenant can transition through `OFFBOARDING`.

## Curl 4 — POST /v1/tenants/:id/force-terminate

```
$ curl -X POST -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    "$SERVICE_URL/v1/tenants/6f492b92-f885-46d2-8bf3-f313c99590e1/force-terminate" \
    -d '{"reason":"D.4 gate evidence — force-terminate happy path"}'

{"code":"CONFLICT","type":"about:blank","status":409,"title":"CONFLICT","detail":"Tenant 6f492b92-f885-46d2-8bf3-f313c99590e1 has status PROVISIONING; expected one of [READY, ACTIVE]","instance":"/v1/tenants/6f492b92-f885-46d2-8bf3-f313c99590e1/force-terminate"}

HTTP 409    TIME 0.158710s
```

Proves: route reachable, super-admin guard (Phase-1 no-op per `tenants.ts:69-75`) doesn't reject, JSON-body validation accepts the `reason` field, state-machine guard correctly rejects from `PROVISIONING`.

Brief expectation was 202 (D.3 deferred-skip happy path #3). Sub-phase 4.3 prerequisite.

## Note on 409s vs. brief's expected 202s

The brief was written assuming a tenant could be created and would advance to `READY` autonomously (matching the eventual production behaviour). In D.4 we have:

- The provisioning Cloud Tasks queue receives the dispatch (proven: curl 0 returned 202).
- The worker that consumes from the queue and flips `PROVISIONING → READY` does NOT exist yet — `tenants.ts:670` comment: _"actual worker function lands in sub-phase 4.3"_.
- The `/v1/_workers/provision` route handler does not exist (only `/v1/_workers/key-rotation` exists in `apps/tenant-lifecycle-api/src/routes/workers/`).

Until 4.3 lands, every freshly-created tenant is stuck in `PROVISIONING`. The 409s in curls 2/3/4 are the **correct, expected behaviour** for that state — they prove the state-machine guards are working.

The only D.4 architectural concern that can't be evidenced by partial-state curls is the §7.4 terminate-before-grace contract message. Deferred to sub-phase 4.3 evidence.

## Acceptance criteria check (Slice D §3 + §7.4 + §7.5)

| Criterion                                                             | Status                                      | Evidence                                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| (a) `make tf-plan-{dev,staging,prod}` clean diff post-apply           | dev: PASS; staging/prod: deferred (billing) | dev plan after apply: `No changes`. staging/prod blocked by `BILLING_DISABLED`.                    |
| (b) `tenant-cloud-run-service` module validates with both mode shapes | PASS                                        | `shared` deployed in dev; `dedicated` covered by module unit-test                                  |
| (c) Cloud Run service deploys + receives traffic in dev               | PASS                                        | revision 00017 (worker-URL apply) serving 100% traffic; curl 1 returns 200 with DB-sourced payload |
| D.4 IAM gap closure end-to-end                                        | PASS                                        | curl 1                                                                                             |
| Lifecycle routes reachable + state-machine guards work                | PASS                                        | curls 2/3/4 (409s)                                                                                 |
| Lifecycle happy-paths (202s)                                          | DEFERRED to sub-phase D.4.5                 | requires provisioning worker                                                                       |
| §7.4 terminate-before-grace contract message                          | DEFERRED to sub-phase D.4.5                 | requires `OFFBOARDING`-state tenant                                                                |

## Follow-up

Provisioning worker tracked as Sub-phase **D.4.5** in `docs/planning/f02-slice-d-scope.md` (plan-inserted 2026-05-08 between D.4 and D.5; see SD1 "D.4.5 lineage" note for the reasoning behind the mid-stream insert). The 3 deferred D.3 happy paths (offboard / terminate / force-terminate) + the §7.4 contract evidence land when D.4.5 closes.
