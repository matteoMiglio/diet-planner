import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createDb } from './db/client.js';
import { ensureOwner, runMigrations } from './db/migrate.js';
import { loadEnv } from './env.js';
import { createClaudeModel } from './ai/model.js';
import { failInterruptedRuns } from './services/generate.js';
import { createPusher, startReminderLoop } from './services/push.js';

const env = loadEnv();
const { db, sql } = createDb(env.DATABASE_URL);

await runMigrations(db);
await ensureOwner(db, env.TZ_DEFAULT);
await failInterruptedRuns(db);

const planModel = env.ANTHROPIC_API_KEY
  ? createClaudeModel({ apiKey: env.ANTHROPIC_API_KEY, model: env.AI_MODEL, effort: env.AI_EFFORT })
  : null;
if (!planModel) console.warn('ANTHROPIC_API_KEY not set: plan generation is off');

const pusher =
  env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT
    ? createPusher({
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
        subject: env.VAPID_SUBJECT,
      })
    : null;
if (!pusher) console.warn('VAPID keys not set: push reminders are off');
if (!env.INGEST_TOKEN) console.warn('INGEST_TOKEN not set: the Shortcut endpoints are off');
// Reviews are scheduled even without push; reminders need it.
const stopReminders = startReminderLoop(db, pusher);

const app = createApp({
  db,
  version: env.APP_VERSION,
  webDist: env.WEB_DIST ? path.resolve(env.WEB_DIST) : undefined,
  ingestToken: env.INGEST_TOKEN,
  pusher,
  planModel,
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`diet-planner ${env.APP_VERSION} listening on :${info.port}`);
});

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopReminders();
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    sql.end({ timeout: 5 }).finally(() => process.exit(0));
  });
  // Don't hang forever on open keep-alive connections.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
