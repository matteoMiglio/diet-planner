import { loadEnv } from '../env.js';
import { createDb } from './client.js';
import { runMigrations } from './migrate.js';

const env = loadEnv();
const { db, sql } = createDb(env.DATABASE_URL);
try {
  await runMigrations(db);
  console.log('Migrations applied');
} finally {
  await sql.end();
}
