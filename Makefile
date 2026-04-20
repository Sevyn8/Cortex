SHELL := bash
.DEFAULT_GOAL := help

COMPOSE := docker compose -f infra/dev/docker-compose.yml

.PHONY: help \
        up down reset restart ps logs \
        db\:shell db\:migrate db\:seed \
        install lint typecheck test format build clean \
        hooks\:verify

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

# --- Database ---
db\:shell: ## Open psql shell in the postgres container
	$(COMPOSE) exec postgres psql -U cortex -d cortex_dev

db\:migrate: ## Run all pending DB migrations (no-op until P0.4 lands)
	@echo "No migrations registered yet — P0.4 adds the migration framework."

db\:seed: ## Run all registered seed modules
	pnpm tsx scripts/seed/index.ts

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
