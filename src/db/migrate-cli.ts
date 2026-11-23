/** CLI: `npm run migrate` — menjalankan migrasi ke DATABASE_URL. */
import { loadEnv } from '../config/env.js';
import { createPgDb, runMigrations } from './client.js';

const env = loadEnv();
const db = await createPgDb(env.DATABASE_URL);
try {
  const ran = await runMigrations(db);
  console.log(ran.length ? `Migrasi dijalankan: ${ran.join(', ')}` : 'Skema sudah terbaru.');
} finally {
  await db.close();
}
