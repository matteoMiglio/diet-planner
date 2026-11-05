import { createDb } from '../src/db/client.js';
import { ensureOwner, runMigrations } from '../src/db/migrate.js';

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

export function createTestDb() {
  return createDb(databaseUrl!);
}

/** Wipes and migrates the test database, after checking on the same connection which one it is. */
export async function resetTestDatabase(handle: ReturnType<typeof createTestDb>): Promise<void> {
  const conn = await handle.sql.reserve();
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
  await runMigrations(handle.db);
}

/** Resets the database and creates the owner; returns the owner's id. */
export async function freshOwner(handle: ReturnType<typeof createTestDb>): Promise<string> {
  await resetTestDatabase(handle);
  return ensureOwner(handle.db, 'Europe/Rome');
}
