import pino from 'pino';

/** Logger bersama. Jangan pernah me-log token, API key, atau isi kredensial. */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: ['*.token', '*.apiKey', '*.api_key', '*.authorization', 'headers.authorization'],
});

/** Mencatat satu eksekusi modul ke tabel runs (PRD: log semua eksekusi). */
export async function withRun<T>(
  db: import('../db/client.js').Db,
  module: string,
  fn: (ctx: { setProcessed: (n: number) => void }) => Promise<T>,
): Promise<T> {
  const { rows } = await db.query<{ id: number }>('INSERT INTO runs (module) VALUES ($1) RETURNING id', [module]);
  const runId = rows[0]!.id;
  let processed = 0;
  try {
    const out = await fn({ setProcessed: (n) => (processed = n) });
    await db.query('UPDATE runs SET finished_at = now(), status = $2, processed_count = $3 WHERE id = $1', [runId, 'ok', processed]);
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.query('UPDATE runs SET finished_at = now(), status = $2, processed_count = $3, error = $4 WHERE id = $1', [runId, 'error', processed, msg]);
    throw e;
  }
}
