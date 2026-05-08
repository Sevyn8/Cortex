# F02 Slice D Sub-phase D.5 — gate evidence

> Captured 2026-05-08 against `tenant-lifecycle-shared` in dev.
> Service URL: `https://tenant-lifecycle-shared-fhl4kqrfca-el.a.run.app`

## What this evidence proves

D.5's acceptance criterion is the 3-case integration-test set: unauth → 403, authenticated test SA → 2xx, operator-user (or impersonation) token → 2xx. All 3 cases below run against the LIVE Cloud Run dev service post-`tf-apply-dev` of the D.5 invoker IAM allowlist (3 members: `cortex-tf-admin@sevyn8-cortex-dev`, `tenant-lifecycle-runtime@sevyn8-cortex-dev`, `amit@sevyn8.com`).

The pre-D.5 state — Cloud Run service with no `--allow-unauthenticated` and no explicit IAM bindings — meant the service was reachable only via project-IAM inheritance (operator's `cortex-admins` group). D.5 makes the allowlist explicit + declarative + auditable; cuts off any future Cortex SA without an explicit grant.

## Live IAM policy post-apply

```yaml
$ gcloud run services get-iam-policy tenant-lifecycle-shared \
    --project=sevyn8-cortex-dev --region=asia-south1 --format=yaml

bindings:
- members:
  - serviceAccount:cortex-tf-admin@sevyn8-cortex-dev.iam.gserviceaccount.com
  - serviceAccount:tenant-lifecycle-runtime@sevyn8-cortex-dev.iam.gserviceaccount.com
  - user:amit@sevyn8.com
  role: roles/run.invoker
etag: BwZRVKvUBVg=
version: 1
```

## Case A — unauth (no token) → 403

```
$ curl -w "\nHTTP %{http_code}\nTIME %{time_total}s\n" \
    "https://tenant-lifecycle-shared-fhl4kqrfca-el.a.run.app/health"

<html><head>
<meta http-equiv="content-type" content="text/html;charset=utf-8">
<title>403 Forbidden</title>
</head>
<body text=#000000 bgcolor=#ffffff>
<h1>Error: Forbidden</h1>
<h2>Your client does not have permission to get URL <code>/health</code> from this server.</h2>
</body></html>

HTTP 403
TIME 0.480817s
```

Proves: deny-by-default. Cloud Run platform layer rejects with 403 (Google front-end HTML response, never reaches the Hono app); no SA, no user, no `allUsers` member can call without a valid invoker grant.

## Case B — operator user token → 200

```
$ TOKEN=$(gcloud auth print-identity-token)
$ curl -w "\nHTTP %{http_code}\nTIME %{time_total}s\n" \
    -H "Authorization: Bearer $TOKEN" \
    "https://tenant-lifecycle-shared-fhl4kqrfca-el.a.run.app/health"

{"status":"ok","commit":"2f84286"}

HTTP 200
TIME 3.175504s
```

Proves: `user:amit@sevyn8.com` invoker grant works. Token's default audience matched against the user-grant principal type. (TIME > 3s reflects cold-start — first request after scale-to-zero; subsequent requests in Case C show warm-path latency.)

## Case C — cortex-tf-admin-dev SA impersonation token → 200

```
$ TOKEN=$(gcloud auth print-identity-token \
    --impersonate-service-account=cortex-tf-admin@sevyn8-cortex-dev.iam.gserviceaccount.com \
    --audiences="https://tenant-lifecycle-shared-fhl4kqrfca-el.a.run.app")
$ curl -w "\nHTTP %{http_code}\nTIME %{time_total}s\n" \
    -H "Authorization: Bearer $TOKEN" \
    "https://tenant-lifecycle-shared-fhl4kqrfca-el.a.run.app/health"

{"status":"ok","commit":"2f84286"}

HTTP 200
TIME 0.144956s
```

Proves: SA impersonation flow works (operator → `iam.serviceAccounts.getAccessToken` on `cortex-tf-admin-dev` via `cortex-admins` group's `tokenCreator` binding; mint OIDC ID token with `--audiences=$SERVICE_URL`; service accepts because `serviceAccount:cortex-tf-admin-dev` has the invoker grant). This is the integration-test path — automated tests can reproduce it without per-developer credentials.

## Acceptance criteria check (Slice D §3 + scope row D.5)

| Criterion                                           | Status | Evidence                      |
| --------------------------------------------------- | ------ | ----------------------------- |
| (a) unauth GET → 403                                | PASS   | Case A                        |
| (b) authenticated test SA GET → 2xx                 | PASS   | Case C                        |
| (c) `cortex-tf-admin-dev` impersonation works       | PASS   | Case C                        |
| Live IAM policy explicit + matches TF declared list | PASS   | `get-iam-policy` output above |
| `make tf-plan-dev` clean diff post-apply            | PASS   | `No changes`                  |

## Note on the runtime SA invoker grant

`tenant-lifecycle-runtime@sevyn8-cortex-dev` is the third invoker member, granted at the per-env wiring level (not in this evidence file's curls). Per Q-NEW-D-11 Option 1, the runtime SA is also the Cloud Tasks OIDC token subject — Cloud Tasks dispatcher and worker target are the same SA. The grant is required for D.2's deployed `POST /v1/_workers/key-rotation` and D.4.5's future provisioning worker. Verifying this end-to-end requires actual Cloud Tasks dispatch (D.4.5 work or a synthetic enqueue test); deferred from D.5's gate.

## Forward-looking

- D.6 may add a CI integration-test runner (`apps/tenant-lifecycle-api/test/integration/iam-authz.spec.ts` or equivalent) that mints tokens via `gcloud auth print-identity-token` + impersonation and asserts the 3 cases. Phase 1: skipped without `RUN_LIVE_INTEGRATION_TESTS=1` env flag (CI doesn't have gcloud auth wired).
- AC01 (P2.1) replaces invoker IAM with per-method authz. The deny-by-default floor stays; per-method gates layer on top.
