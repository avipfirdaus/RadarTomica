/** CLI: `npm run seed` — mendaftarkan sumber prioritas 1 & 2 secara idempoten. */
import { loadEnv } from '../config/env.js';
import { createPgDb, runMigrations } from './client.js';
import { seedSources } from '../ingest/index.js';

const env = loadEnv();
const db = await createPgDb(env.DATABASE_URL);
try {
  await runMigrations(db);
  const count = await seedSources(db);
  console.log(`Sumber terdaftar/diperbarui: ${count}`);
} finally {
  await db.close();
}
