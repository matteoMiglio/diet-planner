# Diet Planner

A self-hosted web app that builds and adjusts my diet from my own body data. See [SPEC.md](SPEC.md) for what it does and why, and [docs/deploy.md](docs/deploy.md) for running it on a VM.

## Layout

| Path              | What                                                                          |
| ----------------- | ----------------------------------------------------------------------------- |
| `apps/api`        | Hono API on Node, Drizzle + Postgres. Serves the built web app in production. |
| `apps/web`        | React + Vite, installable web app.                                            |
| `packages/shared` | Zod schemas and logic shared by both.                                         |
| `docker/backup`   | Nightly `pg_dump` + restic off-site copy, monthly restore test.               |

## Run with Docker Compose

The production stack (`compose.yml`) runs the app, Postgres 17 and the backup job. To try it on your machine you only need Docker:

```sh
cp .env.example .env      # then set POSTGRES_PASSWORD (openssl rand -hex 24)
docker compose up -d --build app    # builds the image, starts Postgres and the app
curl -s http://127.0.0.1:8080/api/health
```

Open <http://127.0.0.1:8080>. Migrations run when the app starts.

- **Port:** the app binds to `127.0.0.1:${APP_PORT}` (default `8080`), never to other interfaces.
- **Optional features** stay off until their `.env` values are set: `ANTHROPIC_API_KEY` (AI meal plans and label reading), `INGEST_TOKEN` (iOS Shortcuts), `VAPID_*` (push reminders).
- **Backups:** `docker compose up -d --build` without a service name also starts the `backup` container, which needs the `RESTIC_*` and `AWS_*` values. Leave it out locally.
- **Logs and stop:** `docker compose logs -f app`, `docker compose down`. The database lives in the `db-data` volume; `docker compose down -v` deletes it.

Deploying on the VM (Tailscale HTTPS, backups, updates) is in [docs/deploy.md](docs/deploy.md).

## Development

Needs Node 24 (`nvm use`), pnpm 12 and Docker.

```sh
cp .env.example .env      # dev defaults work as they are
pnpm install
pnpm db:up                # Postgres on 127.0.0.1:5432 (dev + test databases)
pnpm dev                  # API on :3000, web on :5173 (proxies /api)
```

| Command                                              |                                                                                                             |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                          | All tests. API tests need `pnpm db:up`; they wipe `diet_test` only.                                         |
| `pnpm lint` / `pnpm typecheck` / `pnpm format:check` | What CI runs.                                                                                               |
| `pnpm build`                                         | Web bundle + single-file API bundle.                                                                        |
| `pnpm --filter @diet/api db:generate`                | Create a migration after changing `apps/api/src/db/schema.ts`.                                              |
| `pnpm --filter @diet/api eval:plan -- --runs 3`      | Real plan generations against a fixture: pass rate, repairs, cost. Needs `ANTHROPIC_API_KEY`; spends money. |

Migrations run automatically when the API starts.
