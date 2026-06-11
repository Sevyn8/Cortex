# Workspace layout

> Relocated from CLAUDE.md for context-budget; loaded on demand.

The `services/` tree contains both patterns:

- **Top-level services** at `services/<name>/` — cross-cutting services that don't belong to a feature category (e.g., `services/foundation/`).
- **Categorized services** at `services/<category>/<name>/` — grouped under feature domains (e.g., `services/access/ac01/`).

`pnpm-workspace.yaml` globs both `services/*` and `services/*/*`. Avoid mixing: a service at `services/foundation/package.json` cannot also have `services/foundation/<sub>/package.json` — the two globs would double-match and pnpm would reject.

### `apps/<workload>-api/` — control-plane HTTP services

Cortex control-plane HTTP workloads (e.g., `apps/tenant-lifecycle-api/` shipped in F02 Slice D) follow a Hono + workspace-deps pattern:

- **Hono app + workspace deps.** `package.json` declares `hono`, `@hono/zod-validator`, `hono-pino`, `hono-problem-details` + the `@cortex/*` workspace deps the workload consumes. `tsconfig.build.json` for `dist/` emit; `tsconfig.json` for typecheck/lint includes `test/`.
- **Parallel `src/` + `test/` shape.** `src/{app,config,error-mapper,observability}.ts` + `src/routes/{health,test,v1/tenants,workers/<verb>}.ts`; tests mirror at `test/routes/...`. Worker routes (`/v1/_workers/<verb>`) live alongside user routes but bypass the user-tenant-context middleware via `skipPaths` — see convention §7.4.0 for the OIDC-validated worker-route shape.
- **`scripts/deploy-{env}.sh` for image-only updates.** Service shape is TF-owned (per `infra/terraform/modules/tenant-cloud-run-service/`); deploy scripts only call `gcloud run services update --image=<sha-tagged>`. NO `--service-account`, `--port`, `--cpu`, `--memory`, `--labels` — those flags fight TF on subsequent applies. Image bootstrap via `make image-bootstrap APP=<workload>`. Convention §7.4.0 deploy-checklist captures the full new-workload sequence.
