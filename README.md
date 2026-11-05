# Diet Planner

A self-hosted web app that builds and adjusts my diet from my own body data. See [SPEC.md](SPEC.md) for what it does and why, and [docs/deploy.md](docs/deploy.md) for running it on a VM.

## Layout

| Path              | What                                                                          |
| ----------------- | ----------------------------------------------------------------------------- |
| `apps/api`        | Hono API on Node, Drizzle + Postgres. Serves the built web app in production. |
| `apps/web`        | React + Vite, installable web app.                                            |
| `packages/shared` | Zod schemas and logic shared by both.                                         |
| `docker/backup`   | Nightly `pg_dump` + restic off-site copy, monthly restore test.               |

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
