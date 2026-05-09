SHELL := bash
.DEFAULT_GOAL := help

COMPOSE := docker compose -f infra/dev/docker-compose.yml

.PHONY: help \
        up down reset restart ps logs \
        db\:shell db\:seed \
        db-proxy-dev db-proxy-staging db-proxy-prod \
        db-migrate-dev db-migrate-staging db-migrate-prod \
        install lint typecheck test format build clean \
        hooks\:verify \
        tf-fmt \
        tf-bootstrap-init tf-bootstrap-plan tf-bootstrap-apply \
        tf-init-dev tf-plan-dev tf-apply-dev \
        tf-init-shared tf-plan-shared tf-apply-shared \
        tf-init-staging tf-plan-staging tf-apply-staging \
        tf-init-prod tf-plan-prod tf-apply-prod \
        tf-init-tfstate tf-plan-tfstate tf-apply-tfstate \
        tf-plan-all \
        cloud-build-pool-configure-dev cloud-build-pool-configure-staging \
        cloud-build-pool-configure-prod cloud-build-pools-configure-all

help: ## Show this help
	@awk 'BEGIN {FS = ": +##"; printf "\nCortex dev targets\n\nUsage: make <target>\n\n"} /^[a-zA-Z0-9_:\\-]+: +##/ {t = $$1; gsub(/\\:/, ":", t); printf "  \033[36m%-18s\033[0m %s\n", t, $$2}' $(MAKEFILE_LIST)
	@echo ""

# --- Local dev stack ---
up: ## Start all dev services (detached)
	$(COMPOSE) up -d
	@echo ""
	@$(MAKE) ps

down: ## Stop all dev services (keep volumes)
	$(COMPOSE) down

reset: ## Stop services + wipe volumes + re-up (destroys local data)
	$(COMPOSE) down -v
	$(COMPOSE) up -d

restart: ## Restart all services
	$(COMPOSE) restart

ps: ## Show service status
	$(COMPOSE) ps

logs: ## Tail all service logs (Ctrl-C to exit)
	$(COMPOSE) logs -f --tail=100

# --- Database (local compose) ---
db\:shell: ## Open psql shell in the postgres container (local compose)
	$(COMPOSE) exec postgres psql -U cortex -d cortex_dev

db\:seed: ## Run all registered seed modules
	pnpm tsx scripts/seed/index.ts

# --- Cloud SQL migrations (via cloud-sql-proxy) ---
# Start the matching db-proxy-<env> in a separate terminal, then run
# db-migrate-<env>. Password comes from the per-env break-glass secret
# (cortex-db-postgres-break-glass-<env>) in Secret Manager.
#
# NOTE: Dev uses public IP + authorized_networks allowlist (see Terraform).
# Staging and prod remain private-IP only — --private-ip flag required.
# When P0.5 Cloud Build lands, the dev public IP exception becomes
# unnecessary and can be reverted.

db-proxy-dev: ## Start cloud-sql-proxy → dev (private IP per ADR-INFRA-005; instance is ipv4Enabled=false; foreground)
	cloud-sql-proxy sevyn8-cortex-dev:asia-south1:cortex-dev-postgres --private-ip --port=5432

db-proxy-staging: ## Start cloud-sql-proxy → staging (foreground)
	cloud-sql-proxy sevyn8-cortex-staging:asia-south1:cortex-staging-postgres --private-ip --port=5432

db-proxy-prod: ## Start cloud-sql-proxy → prod (foreground)
	cloud-sql-proxy sevyn8-cortex-prod:asia-south1:cortex-prod-postgres --private-ip --port=5432

db-migrate-dev: ## Apply pending migrations to dev (requires db-proxy-dev running)
	PGPASSWORD=$$(gcloud secrets versions access latest --secret=cortex-db-postgres-break-glass-dev --project=sevyn8-cortex-dev) \
		pnpm db:migrate

db-migrate-staging: ## Apply pending migrations to staging (requires db-proxy-staging running)
	PGPASSWORD=$$(gcloud secrets versions access latest --secret=cortex-db-postgres-break-glass-staging --project=sevyn8-cortex-staging) \
		pnpm db:migrate

db-migrate-prod: ## Apply pending migrations to prod (requires CONFIRM=yes + db-proxy-prod running)
	@[ "$(CONFIRM)" = "yes" ] || (echo "Refusing: run 'make CONFIRM=yes db-migrate-prod'"; exit 1)
	PGPASSWORD=$$(gcloud secrets versions access latest --secret=cortex-db-postgres-break-glass-prod --project=sevyn8-cortex-prod) \
		pnpm db:migrate

# --- Workspace ---
install: ## pnpm install
	pnpm install

lint: ## pnpm -r lint
	pnpm -r lint

typecheck: ## pnpm -r typecheck
	pnpm -r typecheck

test: ## pnpm test
	pnpm test

format: ## Prettier write
	pnpm format

build: ## Turbo build
	pnpm build

clean: ## Remove build + cache artifacts (keeps node_modules)
	rm -rf .turbo **/.turbo **/dist **/.next **/*.tsbuildinfo

# --- Hooks ---
hooks\:verify: ## Verify husky + commitlint + lint-staged fire end-to-end
	@bash scripts/verify-hooks.sh

# --- Terraform ---
TF_BOOTSTRAP_DIR := infra/terraform/bootstrap
TF_DEV_DIR       := infra/terraform/environments/dev
TF_SHARED_DIR    := infra/terraform/environments/shared
TF_STAGING_DIR   := infra/terraform/environments/staging
TF_PROD_DIR      := infra/terraform/environments/prod
TF_TFSTATE_DIR   := infra/terraform/environments/tfstate

# SA emails for env impersonation. The env-var form of impersonation is
# needed specifically for google_service_networking_connection's first-apply
# propagation race (see ADR-INFRA-002). Provider-level impersonation in
# providers.tf handles everything else; this env var is belt-and-suspenders
# so one workflow covers both cases.
SA_DEV     := cortex-tf-admin@sevyn8-cortex-dev.iam.gserviceaccount.com
SA_SHARED  := cortex-tf-admin@sevyn8-cortex-shared.iam.gserviceaccount.com
SA_STAGING := cortex-tf-admin@sevyn8-cortex-staging.iam.gserviceaccount.com
SA_PROD    := cortex-tf-admin@sevyn8-cortex-prod.iam.gserviceaccount.com
SA_TFSTATE := cortex-tf-admin@sevyn8-cortex-tfstate.iam.gserviceaccount.com

tf-fmt: ## Format every .tf file under infra/terraform (recursive)
	terraform -chdir=infra/terraform fmt -recursive

# Bootstrap (one-time, personal ADC, local state)
tf-bootstrap-init: ## Initialize bootstrap (local backend; personal ADC)
	terraform -chdir=$(TF_BOOTSTRAP_DIR) init

tf-bootstrap-plan: ## Plan bootstrap changes
	terraform -chdir=$(TF_BOOTSTRAP_DIR) plan

tf-bootstrap-apply: ## Apply bootstrap (interactive confirm)
	terraform -chdir=$(TF_BOOTSTRAP_DIR) apply

# Dev
tf-init-dev: ## Initialize dev env (GCS backend)
	terraform -chdir=$(TF_DEV_DIR) init

tf-plan-dev: ## Plan dev (SA impersonation via GOOGLE_IMPERSONATE_SERVICE_ACCOUNT)
	GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=$(SA_DEV) terraform -chdir=$(TF_DEV_DIR) plan

tf-apply-dev: ## Apply dev (SA impersonation via GOOGLE_IMPERSONATE_SERVICE_ACCOUNT)
	GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=$(SA_DEV) terraform -chdir=$(TF_DEV_DIR) apply

# Shared (artifact registry plane)
tf-init-shared: ## Initialize shared env
	terraform -chdir=$(TF_SHARED_DIR) init

tf-plan-shared: ## Plan shared
	GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=$(SA_SHARED) terraform -chdir=$(TF_SHARED_DIR) plan

tf-apply-shared: ## Apply shared
	GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=$(SA_SHARED) terraform -chdir=$(TF_SHARED_DIR) apply

# Staging
tf-init-staging: ## Initialize staging env
	terraform -chdir=$(TF_STAGING_DIR) init

tf-plan-staging: ## Plan staging
	GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=$(SA_STAGING) terraform -chdir=$(TF_STAGING_DIR) plan

tf-apply-staging: ## Apply staging
	GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=$(SA_STAGING) terraform -chdir=$(TF_STAGING_DIR) apply

# Prod (GATED)
tf-init-prod: ## Initialize prod env
	terraform -chdir=$(TF_PROD_DIR) init

tf-plan-prod: ## Plan prod (safe — no gate)
	GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=$(SA_PROD) terraform -chdir=$(TF_PROD_DIR) plan

tf-apply-prod: ## Apply prod (requires CONFIRM=yes — see help body)
	@[ "$(CONFIRM)" = "yes" ] || (echo "Refusing: run 'make CONFIRM=yes tf-apply-prod'"; exit 1)
	GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=$(SA_PROD) terraform -chdir=$(TF_PROD_DIR) apply

# TFState (stub — no resources today)
tf-init-tfstate: ## Initialize tfstate env stub
	terraform -chdir=$(TF_TFSTATE_DIR) init

tf-plan-tfstate: ## Plan tfstate (expect no-op today)
	GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=$(SA_TFSTATE) terraform -chdir=$(TF_TFSTATE_DIR) plan

tf-apply-tfstate: ## Apply tfstate (no-op today)
	GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=$(SA_TFSTATE) terraform -chdir=$(TF_TFSTATE_DIR) apply

# Aggregate drift check across bootstrap + all envs. No tf-apply-all by design.
# Two-line form: first declaration holds the ## help text (parser requires
# '## desc' immediately after the first ':'); second declaration adds the
# prerequisite list. Make merges the two.
tf-plan-all: ## Plan every module (bootstrap + dev + shared + staging + prod + tfstate)
tf-plan-all: tf-bootstrap-plan tf-plan-dev tf-plan-shared tf-plan-staging tf-plan-prod tf-plan-tfstate

# --- Image bootstrap (cortex-apps registry plane in shared) ---
# One-time-per-app push of a SHA-tagged image to
# sevyn8-cortex-shared/cortex-apps/<APP>:sha-<HEAD>. Required before the
# first `tf-apply` for any new control-plane workload — TF can't create a
# Cloud Run service without an image. See tenant-lifecycle-convention.md
# §7.4 "Deploying a new control-plane workload" for full checklist.
#
# Auth: impersonates cortex-tf-admin@sevyn8-cortex-shared.iam (operator
# already holds tokenCreator on it from bootstrap). After push, set
# <workload>_image_uri in each env's local.auto.tfvars to the printed
# value.
#
# APP and WORKLOAD often differ (per ADR-COMPUTE-001 §3 / module
# tenant-cloud-run-service variable validation: workload ≤ 19 chars).
# Example: APP=tenant-lifecycle-api (full app dir), WORKLOAD=tenant-lifecycle
# (matches the TF var prefix tenant_lifecycle_image_uri). When omitted,
# WORKLOAD defaults to APP with hyphens replaced by underscores — fine
# when the names align, wrong when the app dir has an `-api` / `-worker`
# suffix the TF var doesn't carry.
image-bootstrap: ## Build + push SHA-tagged image to cortex-apps. Usage: make image-bootstrap APP=<dir> [WORKLOAD=<tf-prefix>]
	@[ -n "$(APP)" ] || (echo "Usage: make image-bootstrap APP=<app-dir-name> [WORKLOAD=<tf-var-prefix>]"; exit 1)
	@[ -d "apps/$(APP)" ] || (echo "apps/$(APP) does not exist"; exit 1)
	@[ -f "apps/$(APP)/Dockerfile" ] || (echo "apps/$(APP)/Dockerfile not found"; exit 1)
	@COMMIT_SHA=$$(git rev-parse --short HEAD); \
	REGION=asia-south1; \
	SHARED_PROJECT=sevyn8-cortex-shared; \
	IMAGE=$${REGION}-docker.pkg.dev/$${SHARED_PROJECT}/cortex-apps/$(APP):sha-$${COMMIT_SHA}; \
	WORKLOAD_VAR="$(or $(WORKLOAD),$(APP))"; \
	WORKLOAD_VAR=$$(echo "$${WORKLOAD_VAR}" | tr '-' '_'); \
	echo "==> Authenticating Docker to $${REGION}-docker.pkg.dev (impersonating cortex-tf-admin@$${SHARED_PROJECT})"; \
	gcloud auth print-access-token \
		--impersonate-service-account=cortex-tf-admin@$${SHARED_PROJECT}.iam.gserviceaccount.com \
		| docker login -u oauth2accesstoken --password-stdin $${REGION}-docker.pkg.dev; \
	echo "==> Building $${IMAGE} (context: repo root, COMMIT_SHA=$${COMMIT_SHA})"; \
	docker build --platform linux/amd64 \
		--build-arg COMMIT_SHA=$${COMMIT_SHA} \
		-t $${IMAGE} -f apps/$(APP)/Dockerfile .; \
	echo "==> Pushing $${IMAGE}"; \
	docker push $${IMAGE}; \
	echo ""; \
	echo "==> Add to each env's local.auto.tfvars:"; \
	echo "    $${WORKLOAD_VAR}_image_uri = \"$${IMAGE}\""

# Out-of-band Cloud Build private-pool config. google provider 6.50.0 does not
# expose egress_option on google_cloudbuild_worker_pool.network_config; migrate.yaml
# needs PUBLIC_EGRESS for apt/npm. Re-run after any pool recreate (DR, migrations).
# See ADR-CI-001 Impl Notes "CRITICAL PROVIDER GAP: egress_option".
cloud-build-pool-configure-dev: ## Flip dev migration-runner pool to PUBLIC_EGRESS (out-of-band, required until provider exposes egress_option)
	gcloud builds worker-pools update cortex-migration-runner \
		--region=asia-south1 --project=sevyn8-cortex-dev --public-egress

cloud-build-pool-configure-staging: ## Flip staging migration-runner pool to PUBLIC_EGRESS
	gcloud builds worker-pools update cortex-migration-runner \
		--region=asia-south1 --project=sevyn8-cortex-staging --public-egress

cloud-build-pool-configure-prod: ## Flip prod migration-runner pool to PUBLIC_EGRESS
	gcloud builds worker-pools update cortex-migration-runner \
		--region=asia-south1 --project=sevyn8-cortex-prod --public-egress

cloud-build-pools-configure-all: ## Flip all three migration-runner pools to PUBLIC_EGRESS
cloud-build-pools-configure-all: cloud-build-pool-configure-dev cloud-build-pool-configure-staging cloud-build-pool-configure-prod
