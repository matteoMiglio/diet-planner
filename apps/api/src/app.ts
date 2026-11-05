import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { HealthResponse } from '@diet/shared';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import type { Db } from './db/client.js';
import { HttpError } from './lib/http.js';
import { type ApiDeps, createApi } from './routes/api.js';

export interface AppDeps extends ApiDeps {
  db: Db;
  version: string;
  /** Absolute path to the built web app. When omitted, only the API is served. */
  webDist?: string | undefined;
  log?: boolean;
}

const DB_PING_TIMEOUT_MS = 2000;

async function pingDb(db: Db): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), DB_PING_TIMEOUT_MS);
  });
  try {
    const ping = db.execute(sql`select 1`).then(
      () => true,
      () => false,
    );
    return await Promise.race([ping, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createApp({ db, version, webDist, log = true, ...apiDeps }: AppDeps) {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.code, message: err.message, details: err.details }, err.status);
    }
    console.error(err);
    return c.json({ error: 'internal', message: 'Something went wrong on the server.' }, 500);
  });

  if (log) app.use(logger());
  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    }),
  );

  const api = new Hono();

  api.get('/health', async (c) => {
    const dbOk = await pingDb(db);
    const body: HealthResponse = {
      status: dbOk ? 'ok' : 'degraded',
      version,
      db: dbOk ? 'ok' : 'down',
      time: new Date().toISOString(),
    };
    c.header('Cache-Control', 'no-store');
    return c.json(body, dbOk ? 200 : 503);
  });

  api.route('/', createApi({ db, ...apiDeps }));
  api.all('*', (c) => c.json({ error: 'not_found' }, 404));
  app.route('/api', api);

  if (webDist) {
    const root = path.relative(process.cwd(), webDist) || '.';
    let indexHtml: string | undefined;

    // Hashed build assets never change; everything else (the service worker, the manifest,
    // icons) must be revalidated so updates reach the phone.
    app.use('*', async (c, next) => {
      await next();
      if (c.req.path.startsWith('/api/') || c.res.headers.has('Cache-Control')) return;
      const immutable = c.res.ok && c.req.path.startsWith('/assets/');
      c.res.headers.set(
        'Cache-Control',
        immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    });
    app.use('*', serveStatic({ root }));

    // Anything else is a client-side route: serve the app shell.
    app.get('*', async (c) => {
      indexHtml ??= await readFile(path.join(webDist, 'index.html'), 'utf8');
      c.header('Cache-Control', 'no-cache');
      return c.html(indexHtml);
    });
  }

  return app;
}
