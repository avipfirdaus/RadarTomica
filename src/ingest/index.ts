/**
 * Modul F1 Ingest (PRD §3 & §4 F1).
 * Mengambil halaman, PDF, pdf_index, dan feed dari sumber terdaftar secara berurutan,
 * membersihkan teks, menghitung hash SHA-256, menyimpan snapshot baru, dan menangani
 * kegagalan berturut-turut (2x gagal => jeda sumber + peringatan ke operator).
 */
import type { Db } from '../db/client.js';
import type { Env } from '../config/env.js';
import type { SourceRow } from '../shared/types.js';
import { logger, withRun } from '../shared/logger.js';
import { cleanFeed, cleanHtml, extractPdfLinks, extractPdfText, sha256 } from './clean.js';
import {
  PoliteFetcher,
  createPolitenessState,
  type FetchFn,
  type NowFn,
  type PolitenessState,
  type SleepFn,
} from './fetcher.js';

export { SEED_SOURCES, seedSources, type SeedSource } from './sources.js';
export { cleanFeed, cleanHtml, extractPdfLinks, extractPdfText, normalizeText, sha256 } from './clean.js';
export {
  MIN_DELAY_FLOOR_MS,
  PoliteFetcher,
  createPolitenessState,
  type FetchFn,
  type FetchResult,
  type FetcherOptions,
  type NowFn,
  type PolitenessState,
  type SleepFn,
} from './fetcher.js';

export interface IngestDeps {
  db: Db;
  env: Pick<Env, 'HTTP_USER_AGENT' | 'HTTP_MIN_DELAY_MS'>;
  fetch?: FetchFn;
  sleep?: SleepFn;
  now?: NowFn;
  timeoutMs?: number;
  politeness?: PolitenessState;
}

export type IngestStatus = 'ok' | 'unchanged' | 'blocked_robots' | 'error' | 'skipped';

export interface IngestAlert {
  sourceId: string;
  message: string;
}

export interface IngestResult {
  sourceId: string;
  status: IngestStatus;
  newSnapshotIds: number[];
  alert?: IngestAlert;
}

const FAILURE_PAUSE_THRESHOLD = 2;

/**
 * Mengambil satu sumber berdasarkan `sourceId`.
 * Sumber yang `paused` atau `enabled = false` dilewati kecuali `opts.force = true`.
 */
export async function ingestSource(
  deps: IngestDeps,
  sourceId: string,
  opts?: { force?: boolean },
): Promise<IngestResult> {
  const nowFn = deps.now ?? (() => new Date());
  const { rows } = await deps.db.query<SourceRow>('SELECT * FROM sources WHERE id = $1', [sourceId]);
  const source = rows[0];
  if (!source) {
    throw new Error(`Sumber tidak ditemukan: ${sourceId}`);
  }

  if (!opts?.force && (!source.enabled || source.paused)) {
    return { sourceId, status: 'skipped', newSnapshotIds: [] };
  }

  const fetcher = new PoliteFetcher({
    env: deps.env,
    fetch: deps.fetch,
    sleep: deps.sleep,
    now: nowFn,
    timeoutMs: deps.timeoutMs,
    politeness: deps.politeness,
  });

  try {
    if (source.kind === 'pdf_index') {
      return await ingestPdfIndex(deps.db, fetcher, source, nowFn, opts?.force ?? false);
    }

    const isBinary = source.kind === 'pdf';
    const fetched = await fetcher.get(source.url, { binary: isBinary });
    if (fetched.blocked) {
      await markBlockedRobots(deps.db, source.id, nowFn());
      return { sourceId, status: 'blocked_robots', newSnapshotIds: [] };
    }

    let cleaned: string;
    if (source.kind === 'pdf') {
      cleaned = await extractPdfText(fetched.bytes);
    } else if (source.kind === 'feed') {
      cleaned = cleanFeed(fetched.text);
    } else {
      cleaned = cleanHtml(fetched.text);
    }

    const insertedId = await insertSnapshotIfNew(deps.db, source.id, fetched.finalUrl, cleaned, nowFn());
    const newSnapshotIds = insertedId !== null ? [insertedId] : [];
    const status: IngestStatus = newSnapshotIds.length > 0 ? 'ok' : 'unchanged';

    await markSuccess(deps.db, source.id, status, nowFn(), opts?.force ?? false);
    return { sourceId, status, newSnapshotIds };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ sourceId, err: message }, 'Gagal mengambil sumber');
    return await recordFailure(deps.db, source, message, nowFn());
  }
}

/**
 * Mengambil semua sumber pada satu label jadwal ('p1' atau 'p2') secara berurutan.
 * Seluruh siklus dicatat ke tabel `runs` lewat `withRun`.
 */
export async function ingestSchedule(deps: IngestDeps, scheduleLabel: string): Promise<IngestResult[]> {
  return withRun(deps.db, 'ingest', async ({ setProcessed }) => {
    const { rows } = await deps.db.query<{ id: string }>(
      'SELECT id FROM sources WHERE schedule = $1 ORDER BY priority ASC, id ASC',
      [scheduleLabel],
    );

    const sharedPoliteness = deps.politeness ?? createPolitenessState();
    const sharedDeps: IngestDeps = { ...deps, politeness: sharedPoliteness };

    const results: IngestResult[] = [];
    let processed = 0;

    for (const row of rows) {
      const res = await ingestSource(sharedDeps, row.id);
      results.push(res);
      if (res.status !== 'skipped') {
        processed += 1;
      }
    }

    setProcessed(processed);
    return results;
  });
}

async function ingestPdfIndex(
  db: Db,
  fetcher: PoliteFetcher,
  source: SourceRow,
  nowFn: NowFn,
  unpause: boolean,
): Promise<IngestResult> {
  const indexRes = await fetcher.get(source.url);
  if (indexRes.blocked) {
    await markBlockedRobots(db, source.id, nowFn());
    return { sourceId: source.id, status: 'blocked_robots', newSnapshotIds: [] };
  }

  const pdfLinks = extractPdfLinks(indexRes.text, indexRes.finalUrl);
  const { rows: existingRows } = await db.query<{ final_url: string }>(
    'SELECT final_url FROM snapshots WHERE source_id = $1',
    [source.id],
  );
  const seenUrls = new Set(existingRows.map((r) => r.final_url));

  const newSnapshotIds: number[] = [];

  for (const pdfUrl of pdfLinks) {
    if (seenUrls.has(pdfUrl)) continue;
    const pdfRes = await fetcher.get(pdfUrl, { binary: true });
    if (pdfRes.blocked) {
      logger.warn({ sourceId: source.id, pdfUrl }, 'PDF diblokir oleh robots.txt, dilewati');
      continue;
    }
    const text = await extractPdfText(pdfRes.bytes);
    const insertedId = await insertSnapshotIfNew(db, source.id, pdfRes.finalUrl, text, nowFn());
    if (insertedId !== null) {
      newSnapshotIds.push(insertedId);
    }
    seenUrls.add(pdfRes.finalUrl);
    seenUrls.add(pdfUrl);
  }

  const status: IngestStatus = newSnapshotIds.length > 0 ? 'ok' : 'unchanged';
  await markSuccess(db, source.id, status, nowFn(), unpause);
  return { sourceId: source.id, status, newSnapshotIds };
}

async function insertSnapshotIfNew(
  db: Db,
  sourceId: string,
  finalUrl: string,
  cleanedText: string,
  fetchedAt: Date,
): Promise<number | null> {
  const hash = sha256(cleanedText);
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO snapshots (source_id, fetched_at, content_hash, raw_text, final_url)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (source_id, content_hash) DO NOTHING
     RETURNING id`,
    [sourceId, fetchedAt, hash, cleanedText, finalUrl],
  );
  return rows[0]?.id ?? null;
}

async function markSuccess(
  db: Db,
  sourceId: string,
  status: 'ok' | 'unchanged',
  fetchedAt: Date,
  unpause: boolean,
): Promise<void> {
  await db.query(
    `UPDATE sources
     SET consecutive_failures = 0,
         last_status = $2,
         last_error = NULL,
         last_fetched_at = $3,
         paused = CASE WHEN $4 THEN false ELSE paused END
     WHERE id = $1`,
    [sourceId, status, fetchedAt, unpause],
  );
}

async function markBlockedRobots(db: Db, sourceId: string, fetchedAt: Date): Promise<void> {
  await db.query(
    `UPDATE sources
     SET last_status = 'blocked_robots',
         last_error = NULL,
         last_fetched_at = $2
     WHERE id = $1`,
    [sourceId, fetchedAt],
  );
}

async function recordFailure(
  db: Db,
  source: SourceRow,
  errorMessage: string,
  fetchedAt: Date,
): Promise<IngestResult> {
  const nextFailures = source.consecutive_failures + 1;
  const shouldPause = nextFailures >= FAILURE_PAUSE_THRESHOLD;

  await db.query(
    `UPDATE sources
     SET consecutive_failures = $2,
         paused = CASE WHEN $3 THEN true ELSE paused END,
         last_status = 'error',
         last_error = $4,
         last_fetched_at = $5
     WHERE id = $1`,
    [source.id, nextFailures, shouldPause, errorMessage, fetchedAt],
  );

  const result: IngestResult = {
    sourceId: source.id,
    status: 'error',
    newSnapshotIds: [],
  };

  if (shouldPause) {
    result.alert = {
      sourceId: source.id,
      message: `Sumber "${source.name}" (${source.id}) gagal ${nextFailures} kali berturut-turut dan dijeda otomatis. Galat terakhir: ${errorMessage}`,
    };
  }

  return result;
}
