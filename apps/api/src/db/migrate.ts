import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Db } from './client.js';
import { appUser, profile } from './schema.js';

/**
 * Location of the generated SQL migrations. In the bundled image they sit next to the
 * server bundle (`MIGRATIONS_DIR`); in development they're in `apps/api/drizzle`.
 */
export function migrationsDir(): string {
  return process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL('../../drizzle', import.meta.url));
}

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: migrationsDir() });
}

/** Creates the single owner and their profile on first start. Safe to call on every start. */
export async function ensureOwner(db: Db, timezone: string): Promise<string> {
  return db.transaction(async (tx) => {
    // Serialise concurrent starts so two instances can't both create an owner.
    await tx.execute('select pg_advisory_xact_lock(4242)');
    const existing = await tx.select({ id: appUser.id }).from(appUser).limit(1);
    if (existing[0]) return existing[0].id;

    const [owner] = await tx.insert(appUser).values({}).returning({ id: appUser.id });
    if (!owner) throw new Error('Failed to create the owner user');
    await tx.insert(profile).values({ userId: owner.id, timezone });
    return owner.id;
  });
}
