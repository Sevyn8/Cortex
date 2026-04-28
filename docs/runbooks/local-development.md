# Local development runbook

Target platform: Windows 11 with WSL 2 Ubuntu. Working directory must live inside the WSL filesystem (`~/projects/Cortex`), never `/mnt/c/...` — Windows filesystem from Linux is ~10× slower for Node tooling and breaks some file watchers.

## Prerequisites

Before your first `make up`:

| Tool           | Version        | How                                                                                                               |
| -------------- | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| WSL 2 Ubuntu   | 22.04 or 24.04 | Enable in Windows via `wsl --install -d Ubuntu`                                                                   |
| Docker Desktop | latest         | Settings → Resources → WSL Integration → enable for your Ubuntu distro                                            |
| Node.js        | 22 LTS         | `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh \| bash && nvm install 22 && nvm use 22` |
| pnpm           | 10.33.0        | `corepack enable && corepack prepare pnpm@10.33.0 --activate`                                                     |
| Git            | any recent     | `sudo apt install git`                                                                                            |

Confirm:

```bash
docker info              # should print the WSL-integrated Docker daemon info
node --version           # v22.x
pnpm --version           # 10.33.x
```

## One-time setup

```bash
cd ~/projects/Cortex
cp .env.example .env.local
# Fill in secrets you have (WorkOS, Anthropic, Resend).
# Placeholders OK for emulator-only work.
pnpm install
make up
make db:migrate          # no-op until P0.4; confirms path
make db:seed             # no-op until seeds land; confirms path
pnpm -r typecheck
pnpm -r lint
```

### What a healthy `make up` looks like

First run pulls images (~2–3 min on a fast connection; the `pubsub-emulator` image is ~500 MB). Cached runs start in under 10 seconds. Expected `make ps` once services settle:

```
NAME                           STATUS
cortex-dev-postgres-1          Up N seconds (healthy)
cortex-dev-pubsub-emulator-1   Up N seconds (healthy)
cortex-dev-fake-gcs-1          Up N seconds (healthy)
cortex-dev-redis-1             Up N seconds (healthy)
cortex-dev-adminer-1           Up N seconds
```

All five services should reach `Up … (healthy)` within ~30 s on a warm cache (Adminer has no healthcheck and depends on postgres health, so it appears last). If anything sits in `(starting)` for more than a minute or goes `(unhealthy)`, run `make logs` and scroll for the culprit.

## Daily loop

```bash
make up                  # start stack
make ps                  # confirm health
# ... work ...
make down                # stop stack (keeps volumes — data persists across restarts)
```

Adminer is at http://localhost:18080 (server: `postgres`, user: `cortex`, password: `cortex`, database: `cortex_dev`).

## Task reference

`make help` lists every target with a one-line description:

```
make up              Start all dev services (detached)
make down            Stop all dev services (keep volumes)
make reset           Stop services + wipe volumes + re-up (destroys local data)
make restart         Restart all services
make ps              Show service status
make logs            Tail all service logs (Ctrl-C to exit)
make db:shell        Open psql shell in the postgres container
make db:migrate      Run all pending DB migrations (no-op until P0.4 lands)
make db:seed         Run all registered seed modules
make install         pnpm install
make lint            pnpm -r lint
make typecheck       pnpm -r typecheck
make test            pnpm test
make format          Prettier write
make build           Turbo build
make clean           Remove build + cache artifacts (keeps node_modules)
make hooks:verify    Verify husky + commitlint + lint-staged fire end-to-end
```

For single-workspace tasks, fall back to the equivalent `pnpm` invocations (`pnpm --filter @cortex/widgets lint`, etc.) — `make` is for stack-level convenience.

## Troubleshooting (WSL + Docker)

**Port conflicts with Windows-side services.** If `make up` fails with `bind: address already in use`, find the culprit:

```bash
# In WSL
ss -ltn

# In Windows PowerShell (admin)
netstat -ano | findstr :5432
```

Override the port in `infra/dev/docker-compose.yml` (change the `host:container` port mapping, e.g. `'5433:5432'`) and update `DATABASE_URL` in your `.env.local`.

**`docker info` fails inside WSL.** Docker Desktop is not wired to your distro. Open Docker Desktop → Settings → Resources → WSL Integration → toggle your Ubuntu distro on → Apply & Restart.

**Clock skew after laptop sleep.** WSL's clock drifts from the Windows host after suspend/resume. Symptoms: JWT signature errors, Google SDK auth failures with "token expired". Fix:

```bash
sudo hwclock -s
# or, nuclear option from PowerShell:
wsl --shutdown    # then relaunch WSL
```

**`inotify` limit exceeded for file watchers.** Next.js dev server stops noticing file changes. Fix:

```bash
echo "fs.inotify.max_user_watches=524288" | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

**Volume permission errors.** Docker volumes are owned by the container's user (postgres runs as UID 999). Do not `chown` or `chmod` these volumes from the WSL host — let Docker manage them. If a volume is corrupt, `make reset` wipes and recreates it.

**`localhost` not resolving.** Rare on modern Docker Desktop. Substitute `127.0.0.1` explicitly in `.env.local` and retry.

**VS Code.** Install the "WSL" extension. Open projects via `code .` from a WSL terminal, never from Windows Explorer. Otherwise VS Code runs tooling from the Windows side and node_modules paths break.

**First `pnpm install` is slow.** Cold-start pulls ~250 packages. Subsequent installs reuse the pnpm store in `~/.local/share/pnpm/store`.

**Pub/Sub emulator doesn't persist topics.** By design. Each `make down && make up` cycle wipes topics. If you need persistence across restarts for a specific test scenario, create topics via an init script — but typically you re-create them in the test setup.

## Resetting to zero

`make reset` destroys local volumes — Postgres data, GCS objects, Redis keys all go. Use when local state is tangled. For a full nuclear reset including node_modules:

```bash
make reset
rm -rf node_modules packages/*/node_modules apps/*/node_modules services/**/node_modules
pnpm install
```

### Schema-level reset (`pnpm db:reset`)

For drizzle-journal drift — drizzle-kit re-runs already-applied migrations and trips on existing extensions/triggers/functions (typically SQLSTATE `42723` "function already exists" or `42P07` "relation already exists") — reset the schema without touching the volume:

```bash
pnpm db:reset
```

This drops `public` + `cortex` schemas, drops the `test_user` role, re-runs `drizzle-kit migrate`, then re-applies CI's `test_user` setup verbatim (including the `audit_event` ownership transfer that FORCE-RLS specs depend on). Idempotent; refuses to run if `PGHOST` is not localhost. Defaults to `127.0.0.1:5433` / `postgres` / `testpw` / `cortex` — override via env vars.

## Verifying the git commit hooks

After any change to `.husky/`, `commitlint.config.cjs`, `eslint.config.mjs`, or `package.json` lint-staged config, run:

```bash
make hooks:verify
```

This creates a scratch file, attempts two throwaway commits (one with a bad message, one with a badly-formatted file), verifies commitlint rejects the first and lint-staged fires on the second, then cleans up. Takes a few seconds; leaves no commit behind.
