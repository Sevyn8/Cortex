# syntax=docker/dockerfile:1.7
# Multi-stage build for apps/tenant-lifecycle-api.
# Image size affects Cloud Run cold-start container-pull latency
# (per SD3 cross-check rationale). Final image is distroless-node22.

# Global build arg — bound at build time via `--build-arg COMMIT_SHA=$(git
# rev-parse --short HEAD)` (make image-bootstrap supplies it). Baking the
# SHA into the image at build time (vs setting via Cloud Run env var at
# deploy time) closes the deploy-vs-TF env-var drift seam: TF's base_env
# stays the source-of-truth for runtime env vars; per-build identifiers
# travel with the image.
ARG COMMIT_SHA=unknown

# ── Stage 1: build (pnpm install + tsc) ─────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /repo

ENV PNPM_HOME=/usr/local/pnpm \
    PATH=/usr/local/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# Copy workspace manifests for the dep graph this app needs.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/tenant-lifecycle-api/package.json apps/tenant-lifecycle-api/tsconfig.json apps/tenant-lifecycle-api/tsconfig.build.json apps/tenant-lifecycle-api/
COPY packages/observability/package.json packages/observability/
COPY packages/tenant-context/package.json packages/tenant-context/
COPY packages/audit-events/package.json packages/audit-events/
COPY packages/canonical-schema/package.json packages/canonical-schema/
COPY packages/secrets/package.json packages/secrets/
COPY packages/blob-storage/package.json packages/blob-storage/
COPY packages/encryption/package.json packages/encryption/

RUN pnpm install --filter @cortex/tenant-lifecycle-api... --frozen-lockfile

# Copy build configs (tsconfig.json + tsconfig.build.json) for each
# @cortex/* package consumed transitively. Each package builds with
# `tsc -b tsconfig.build.json`; tsconfig.build.json is the emit config
# (composite + outDir=dist + rootDir=src), tsconfig.json is the
# typecheck config (kept for parity with other workflows).
COPY packages/observability/tsconfig.json packages/observability/tsconfig.build.json packages/observability/
COPY packages/tenant-context/tsconfig.json packages/tenant-context/tsconfig.build.json packages/tenant-context/
COPY packages/audit-events/tsconfig.json packages/audit-events/tsconfig.build.json packages/audit-events/
COPY packages/canonical-schema/tsconfig.json packages/canonical-schema/tsconfig.build.json packages/canonical-schema/
COPY packages/secrets/tsconfig.json packages/secrets/tsconfig.build.json packages/secrets/
COPY packages/blob-storage/tsconfig.json packages/blob-storage/tsconfig.build.json packages/blob-storage/
COPY packages/encryption/tsconfig.json packages/encryption/tsconfig.build.json packages/encryption/

# Copy sources only for the targeted slice of the workspace.
COPY apps/tenant-lifecycle-api/src apps/tenant-lifecycle-api/src
COPY packages/observability/src packages/observability/src
COPY packages/tenant-context/src packages/tenant-context/src
COPY packages/audit-events/src packages/audit-events/src
COPY packages/canonical-schema/src packages/canonical-schema/src
COPY packages/secrets/src packages/secrets/src
COPY packages/blob-storage/src packages/blob-storage/src
COPY packages/encryption/src packages/encryption/src

# Trailing `...` includes all workspace dependencies (transitive). Without
# it, only @cortex/tenant-lifecycle-api would build; the @cortex/* libs
# it imports would stay as TS source under node_modules and Node would
# refuse to load them at runtime (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
RUN pnpm --filter @cortex/tenant-lifecycle-api... build

# Prune dev dependencies for the production image.
# `--legacy` reverts pnpm v10's default behavior of refusing to deploy
# from workspaces that aren't `inject-workspace-packages=true`. The
# workspace-wide migration to injected workspace packages is a deliberate
# decision (downstream effects on linking semantics) deferred outside
# D.1 scope; surgical --legacy here keeps the blast radius minimal and
# the call site explicit. Revisit when a future app prefers the v10-
# native pattern (would lift to .npmrc / pnpm-workspace.yaml at that
# point).
RUN pnpm --filter @cortex/tenant-lifecycle-api deploy --legacy --prod /out

# ── Stage 2: runtime (distroless, no shell) ──────────────────────────
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app

# Re-declare the global ARG to bring it into this stage's scope (Docker
# build-arg quirk: globals declared before any FROM aren't auto-visible
# inside stages without a no-default re-declare).
ARG COMMIT_SHA

COPY --from=build /out/dist /app/dist
COPY --from=build /out/node_modules /app/node_modules
COPY --from=build /out/package.json /app/package.json

# Cloud Run injects PORT (default 8080); the app reads from env.
# COMMIT_SHA propagates from build-arg into runtime env so the /health
# endpoint surfaces the deployed SHA. NODE_ENV defaults to production
# here; per-env overrides land via the TF module's extra_env_vars
# (dev/main.tf sets NODE_ENV=development; staging/prod inherit).
ENV NODE_ENV=production \
    COMMIT_SHA=${COMMIT_SHA}
EXPOSE 8080

# distroless's `nonroot` user (uid 65532). PID 1 = node so SIGTERM
# reaches the process directly (no shell-wrapper signal-swallowing).
USER nonroot
CMD ["/app/dist/index.js"]
