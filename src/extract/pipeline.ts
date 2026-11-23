/**
 * Pipeline ekstraksi F2: `extractSnapshot(deps, snapshotId)` (PRD §4 F2, §7, §9).
 * - Hanya memproses snapshot dengan extracted_at IS NULL.
 * - Memanggil P1, mengurai HANYA JSON, memvalidasi dengan P1OutputSchema.
 * - Gagal validasi skema: ulang maksimal 2 kali, lalu masukkan review_queue ('extraction_failed').
 * - Verifikasi bukti kutipan di kode (NFKC + whitespace, < 15 kata).
 * - Deteksi prompt injection di kode + needs_review dari model -> review_queue ('injection_suspected').
 * - Menandai snapshot.extracted_at, dan TIDAK menulis tabel items (milik sub-agen C).
 */
import type { Db } from '../db/client.js';
import { P1OutputSchema, type LlmClient, type P1Output, type SnapshotRow } from '../shared/types.js';
import { logger } from '../shared/logger.js';
import { LlmBudgetExceededError } from './llm/budget.js';
import { buildP1Prompt } from './prompts/p1.js';
import { parseJsonFromLlm } from './json.js';
import { verifyItemEvidence, type VerifiedExtractedItem } from './evidence.js';
import { detectPromptInjection } from './injection.js';

export interface ExtractDeps {
  db: Db;
  llm: LlmClient;
  /** Jumlah percobaan ulang saat gagal skema/JSON. Default: 2 (total maksimal 3 panggilan). */
  maxRetries?: number;
}

export interface ExtractFlags {
  injectionSuspected: boolean;
  injectionMatches: string[];
  extractionFailed: boolean;
  failureReason?: string;
  attempts: number;
}

export interface ExtractSnapshotResult {
  snapshotId: number;
  sourceUrl: string;
  skipped: boolean;
  items: VerifiedExtractedItem[];
  flags: ExtractFlags;
}

export async function extractSnapshot(deps: ExtractDeps, snapshotId: number): Promise<ExtractSnapshotResult> {
  const { rows } = await deps.db.query<SnapshotRow>(
    `SELECT id, source_id, fetched_at, content_hash, raw_text, final_url, extracted_at
     FROM snapshots
     WHERE id = $1`,
    [snapshotId],
  );
  const snapshot = rows[0];
  if (!snapshot) {
    throw new Error(`Snapshot tidak ditemukan: id=${snapshotId}`);
  }

  // Idempoten: snapshot yang sudah diekstrak tidak diproses ulang.
  if (snapshot.extracted_at !== null) {
    return {
      snapshotId: snapshot.id,
      sourceUrl: snapshot.final_url,
      skipped: true,
      items: [],
      flags: {
        injectionSuspected: false,
        injectionMatches: [],
        extractionFailed: false,
        attempts: 0,
      },
    };
  }

  const injection = detectPromptInjection(snapshot.raw_text);
  const prompt = buildP1Prompt({ sourceUrl: snapshot.final_url, rawText: snapshot.raw_text });
  const maxRetries = deps.maxRetries ?? 2;
  const maxAttempts = 1 + Math.max(0, maxRetries);

  let parsedOutput: P1Output | null = null;
  let lastError = '';
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    try {
      const res = await deps.llm.complete({
        task: 'P1',
        promptVersion: prompt.version,
        system: prompt.system,
        user: prompt.user,
        temperature: 0,
      });

      const rawJson = parseJsonFromLlm(res.text);
      const validated = P1OutputSchema.safeParse(rawJson);
      if (validated.success) {
        parsedOutput = validated.data;
        break;
      }

      lastError = `Validasi skema P1 gagal (percobaan ${attempt}/${maxAttempts}): ${validated.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`;
      logger.warn({ snapshotId, attempt, maxAttempts, error: lastError }, 'P1 schema validation failed');
    } catch (err) {
      // Batas anggaran terlampaui: hentikan segera tanpa retry & tanpa menandai extracted_at.
      if (err instanceof LlmBudgetExceededError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      lastError = `Gagal ekstraksi P1 (percobaan ${attempt}/${maxAttempts}): ${msg}`;
      logger.warn({ snapshotId, attempt, maxAttempts, error: lastError }, 'P1 extraction attempt failed');
    }
  }

  if (!parsedOutput) {
    await deps.db.query(
      `INSERT INTO review_queue (kind, snapshot_id, reason, payload)
       VALUES ($1, $2, $3, $4)`,
      [
        'extraction_failed',
        snapshot.id,
        lastError || 'Ekstraksi P1 gagal setelah percobaan maksimal',
        JSON.stringify({
          attempts,
          promptVersion: prompt.version,
          sourceUrl: snapshot.final_url,
          injectionSuspected: injection.suspected,
        }),
      ],
    );

    if (injection.suspected) {
      await deps.db.query(
        `INSERT INTO review_queue (kind, snapshot_id, reason, payload)
         VALUES ($1, $2, $3, $4)`,
        [
          'injection_suspected',
          snapshot.id,
          `Indikasi prompt injection pada teks sumber: ${injection.matches.join(', ')}`,
          JSON.stringify({ matches: injection.matches, sourceUrl: snapshot.final_url }),
        ],
      );
    }

    await deps.db.query('UPDATE snapshots SET extracted_at = now() WHERE id = $1', [snapshot.id]);

    return {
      snapshotId: snapshot.id,
      sourceUrl: snapshot.final_url,
      skipped: false,
      items: [],
      flags: {
        injectionSuspected: injection.suspected,
        injectionMatches: injection.matches,
        extractionFailed: true,
        failureReason: lastError,
        attempts,
      },
    };
  }

  // Verifikasi bukti kutipan di kode untuk setiap item.
  const verifiedItems: VerifiedExtractedItem[] = parsedOutput.items.map((item) => {
    const verified = verifyItemEvidence(item, snapshot.raw_text, prompt.version);
    if (injection.suspected) {
      return { ...verified, needs_review: true };
    }
    return verified;
  });

  if (injection.suspected) {
    await deps.db.query(
      `INSERT INTO review_queue (kind, snapshot_id, reason, payload)
       VALUES ($1, $2, $3, $4)`,
      [
        'injection_suspected',
        snapshot.id,
        `Indikasi prompt injection pada teks sumber: ${injection.matches.join(', ')}`,
        JSON.stringify({
          matches: injection.matches,
          sourceUrl: snapshot.final_url,
          itemCount: verifiedItems.length,
        }),
      ],
    );
  }

  await deps.db.query('UPDATE snapshots SET extracted_at = now() WHERE id = $1', [snapshot.id]);

  return {
    snapshotId: snapshot.id,
    sourceUrl: snapshot.final_url,
    skipped: false,
    items: verifiedItems,
    flags: {
      injectionSuspected: injection.suspected,
      injectionMatches: injection.matches,
      extractionFailed: false,
      attempts,
    },
  };
}
