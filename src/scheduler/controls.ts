/**
 * Kontrol operator untuk penjadwal & sumber (PRD §4 Kontrol Operator & §8 Pengecualian):
 * - Jeda / lanjutkan semua otomasi (tabel `system_state` kunci `'paused'`).
 * - Lanjutkan satu sumber yang dijeda otomatis (`resumeSource`).
 * - Paksa ambil ulang satu sumber (`forceRefetch`).
 * - Lihat log eksekusi terbaru (`recentRuns`).
 */
import type { Db } from '../db/client.js';
import { ingestSource, type IngestDeps, type IngestResult } from '../ingest/index.js';

export interface RunRow {
  id: number;
  module: string;
  started_at: Date;
  finished_at: Date | null;
  status: 'running' | 'ok' | 'error' | 'skipped';
  processed_count: number;
  error: string | null;
}

const PAUSED_STATE_KEY = 'paused';

/** Memeriksa apakah jeda global sedang aktif (`system_state.key = 'paused'`). */
export async function isPaused(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ value: unknown }>(
    'SELECT value FROM system_state WHERE key = $1',
    [PAUSED_STATE_KEY],
  );
  const raw = rows[0]?.value;
  if (typeof raw === 'boolean') return raw;
  if (raw && typeof raw === 'object' && 'paused' in raw) {
    return Boolean((raw as { paused?: unknown }).paused);
  }
  return false;
}

/** Mengatur status jeda global beserta identitas pengubah (`by`). */
export async function setPaused(db: Db, paused: boolean, by: string): Promise<void> {
  const payload = JSON.stringify({ paused, by });
  await db.query(
    `INSERT INTO system_state (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       updated_at = now()`,
    [PAUSED_STATE_KEY, payload],
  );
}

/** Mengaktifkan kembali sumber yang dijeda dan mereset penghitung kegagalan berturut-turut. */
export async function resumeSource(db: Db, sourceId: string): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE sources
     SET paused = false,
         consecutive_failures = 0,
         last_error = NULL
     WHERE id = $1
     RETURNING id`,
    [sourceId],
  );
  return rows.length > 0;
}

/**
 * Memaksa pengambilan ulang satu sumber:
 * mereset penghitung kegagalan dan tetap mengambil meski sumber sedang dijeda.
 */
export async function forceRefetch(deps: IngestDeps, sourceId: string): Promise<IngestResult> {
  await deps.db.query(
    `UPDATE sources
     SET consecutive_failures = 0,
         last_error = NULL
     WHERE id = $1`,
    [sourceId],
  );
  return ingestSource(deps, sourceId, { force: true });
}

/** Mengambil log eksekusi terbaru dari tabel `runs` untuk operator. */
export async function recentRuns(db: Db, limit = 20): Promise<RunRow[]> {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const { rows } = await db.query<RunRow>(
    `SELECT id, module, started_at, finished_at, status, processed_count, error
     FROM runs
     ORDER BY id DESC
     LIMIT $1`,
    [safeLimit],
  );
  return rows;
}
