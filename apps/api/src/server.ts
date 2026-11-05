import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createDb } from './db/client.js';
import { ensureOwner, runMigrations } from './db/migrate.js';
import { loadEnv } from './env.js';

const env = loadEnv();
const { db, sql } = createDb(env.DATABASE_URL);

await runMigrations(db);
await ensureOwner(db, env.TZ_DEFAULT);

const app = createApp({
  db,
  version: env.APP_VERSION,
  webDist: env.WEB_DIST ? path.resolve(env.WEB_DIST) : undefined,
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`diet-planner ${env.APP_VERSION} listening on :${info.port}`);
});

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    sql.end({ timeout: 5 }).finally(() => process.exit(0));
  });
  // Don't hang forever on open keep-alive connections.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
