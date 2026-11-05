import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HealthResponse } from '@diet/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { ensureOwner, runMigrations } from '../src/db/migrate.js';
import { appUser, profile } from '../src/db/schema.js';

// The tests drop and recreate the schema, so they only ever run against a database whose
// name says it is disposable.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error('TEST_DATABASE_URL is required for API tests. Run `pnpm db:up` (see README).');
}
if (new URL(databaseUrl).search) {
  // Query parameters such as `?database=` can silently override the database in the path.
  throw new Error('TEST_DATABASE_URL must not have query parameters.');
}

const { db, sql } = createDb(databaseUrl);
let webDist: string;

/** Wipes the test database, after checking on the same connection which database it is. */
async function resetTestDatabase() {
  const conn = await sql.reserve();
  try {
    const [row] = await conn<{ name: string }[]>`select current_database() as name`;
    if (!row?.name.endsWith('_test')) {
      throw new Error(`Refusing to wipe "${row?.name}": test database names must end in "_test".`);
    }
    await conn`drop schema if exists public cascade`;
    await conn`drop schema if exists drizzle cascade`;
    await conn`create schema public`;
  } finally {
    conn.release();
  }
}

beforeAll(async () => {
  await resetTestDatabase();
  await runMigrations(db);

  webDist = await mkdtemp(path.join(tmpdir(), 'diet-web-'));
  await mkdir(path.join(webDist, 'assets'));
  await writeFile(path.join(webDist, 'index.html'), '<!doctype html><title>Diet</title>');
  await writeFile(path.join(webDist, 'assets', 'app-abc123.js'), 'console.log(1)');
});

afterAll(async () => {
  await sql.end();
  await rm(webDist, { recursive: true, force: true });
});

describe('GET /api/health', () => {
  it('reports ok when the database answers', async () => {
    const app = createApp({ db, version: 'test', log: false });
    const res = await app.request('/api/health');

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = HealthResponse.parse(await res.json());
    expect(body).toMatchObject({ status: 'ok', db: 'ok', version: 'test' });
  });

  it('reports degraded with 503 when the database is unreachable', async () => {
    const dead = createDb('postgres://nobody:nothing@127.0.0.1:1/none');
    try {
      const app = createApp({ db: dead.db, version: 'test', log: false });
      const res = await app.request('/api/health');

      expect(res.status).toBe(503);
      expect(HealthResponse.parse(await res.json())).toMatchObject({
        status: 'degraded',
        db: 'down',
      });
    } finally {
      await dead.sql.end({ timeout: 0 });
    }
  });
});

describe('routing', () => {
  it('returns JSON 404 for unknown API routes instead of the app shell', async () => {
    const app = createApp({ db, version: 'test', webDist, log: false });
    const res = await app.request('/api/nope');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('serves the app shell for client-side routes', async () => {
    const app = createApp({ db, version: 'test', webDist, log: false });
    const res = await app.request('/progress');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<title>Diet</title>');
  });

  it('serves hashed assets with long-lived caching', async () => {
    const app = createApp({ db, version: 'test', webDist, log: false });
    const res = await app.request('/assets/app-abc123.js');

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  it('serves the service worker so it is always revalidated', async () => {
    await writeFile(path.join(webDist, 'sw.js'), 'self.skipWaiting()');
    const app = createApp({ db, version: 'test', webDist, log: false });
    const res = await app.request('/sw.js');

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('sets security headers', async () => {
    const app = createApp({ db, version: 'test', log: false });
    const res = await app.request('/api/health');

    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('ensureOwner', () => {
  it('creates exactly one owner with a profile, however often it runs', async () => {
    const results = await Promise.all([
      ensureOwner(db, 'Europe/Rome'),
      ensureOwner(db, 'Europe/Rome'),
      ensureOwner(db, 'Europe/Rome'),
    ]);

    expect(new Set(results).size).toBe(1);
    expect(await db.select().from(appUser)).toHaveLength(1);
    const [owner] = results;
    const rows = await db.select().from(profile).where(eq(profile.userId, owner!));
    expect(rows[0]).toMatchObject({
      timezone: 'Europe/Rome',
      activityFactor: 1.5,
      trainingWeekdays: [1, 3, 5],
    });
  });
});
