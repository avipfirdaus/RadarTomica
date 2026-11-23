/**
 * Integrasi end-to-end Radar Tomica Jepang (Orkestrator).
 * Menghubungkan F1 (ingest) → F2 (ekstraksi) → F5 (klasifikasi) → F3/F4 (normalisasi & perubahan)
 * → F6 (harga & kelayakan) → F7 (kalender) → F8 (peringatan) → F9 (draf & gerbang persetujuan)
 * serta kontrol operator Telegram dan penjadwal cron JST.
 */
import type { Db } from '../db/client.js';
import type { Env } from '../config/env.js';
import { loadParams, setParam as setParamDb, type ParamKey } from '../config/params.js';
import type { FxProvider, LlmClient, TelegramPort } from '../shared/types.js';
import { logger } from '../shared/logger.js';
import { todayJst } from '../shared/time.js';
import {
  ingestSchedule,
  ingestSource,
  type IngestDeps,
  type IngestResult,
} from '../ingest/index.js';
import {
  forceRefetch as schedulerForceRefetch,
  isPaused,
  recentRuns as schedulerRecentRuns,
  setPaused,
  type JobHandlers,
} from '../scheduler/index.js';
import {
  extractSnapshot,
  LlmBudgetExceededError,
} from '../extract/index.js';
import { classifyItem } from '../classify/index.js';
import { upsertExtractedItems, type UpsertExtractedItemInput } from '../domain/index.js';
import { evaluateAll, evaluateItem } from '../pricing/index.js';
import { releaseCalendar, reminderDue } from '../calendar/index.js';
import {
  flushUrgentAlerts,
  sendDailySummary,
  sendWeeklyReport,
  type SourceFailureAlert,
} from '../notify/index.js';
import {
  createDraft,
  createDraftActionHandler,
  expireOldDrafts,
  renderDraftTemplate,
  type DraftItemData,
  type DraftServiceDeps,
  type RecomputeDraftFn,
} from '../drafts/index.js';
import type {
  DecisionLogEntry,
  OperatorControls,
  ReviewEntry,
  StatusSummary,
} from '../telegram/index.js';

export interface PipelineDeps {
  db: Db;
  env: Env;
  llm: LlmClient;
  telegram: TelegramPort;
  fx: FxProvider;
  ingestDeps: IngestDeps;
  now?: () => Date;
}

export interface CycleResult {
  schedule: string;
  ingestResults: IngestResult[];
  extractedSnapshots: number;
  upsertedItems: number;
  eventsCreated: number;
  evaluatedItems: number;
  sourceAlertsSent: number;
  budgetExceeded: boolean;
}

/**
 * Menjalankan satu siklus penuh untuk label jadwal ('p1' atau 'p2'):
 * F1 ingest → F2 ekstraksi → F5 klasifikasi → F3/F4 upsert & deteksi perubahan → F6 evaluasi harga.
 */
export async function runIngestAndExtractCycle(
  deps: PipelineDeps,
  scheduleLabel: string,
): Promise<CycleResult> {
  const now = deps.now ?? (() => new Date());
  const ingestResults = await ingestSchedule(deps.ingestDeps, scheduleLabel);

  const sourceFailures: SourceFailureAlert[] = [];
  for (const r of ingestResults) {
    if (r.alert) {
      const { rows } = await deps.db.query<{ name: string; consecutive_failures: number; last_error: string | null; paused: boolean }>(
        'SELECT name, consecutive_failures, last_error, paused FROM sources WHERE id = $1',
        [r.sourceId],
      );
      const src = rows[0];
      sourceFailures.push({
        sourceId: r.sourceId,
        sourceName: src?.name ?? r.sourceId,
        consecutiveFailures: src?.consecutive_failures ?? 2,
        lastError: src?.last_error ?? r.alert.message,
        paused: src?.paused ?? true,
      });
    }
  }

  let extractedSnapshots = 0;
  let upsertedItems = 0;
  let eventsCreated = 0;
  let budgetExceeded = false;

  for (const r of ingestResults) {
    if (budgetExceeded) break;
    if (r.newSnapshotIds.length === 0) continue;

    const { rows: srcRows } = await deps.db.query<{ priority: 1 | 2 | 3 }>(
      'SELECT priority FROM sources WHERE id = $1',
      [r.sourceId],
    );
    const sourcePriority = srcRows[0]?.priority ?? 2;

    for (const snapshotId of r.newSnapshotIds) {
      try {
        const extracted = await extractSnapshot({ db: deps.db, llm: deps.llm }, snapshotId);
        if (extracted.skipped) continue;
        extractedSnapshots += 1;

        const { rows: snapRows } = await deps.db.query<{ raw_text: string }>(
          'SELECT raw_text FROM snapshots WHERE id = $1',
          [snapshotId],
        );
        const rawText = snapRows[0]?.raw_text ?? '';

        const classifiedItems: UpsertExtractedItemInput[] = [];
        for (const item of extracted.items) {
          const cls = await classifyItem(
            { llm: deps.llm },
            {
              item,
              sourceText: rawText,
              referenceDateJst: todayJst(now()),
            },
          );
          classifiedItems.push({
            ...item,
            edition: cls.edition,
            category: cls.category,
            needs_review: item.needs_review || cls.needsReview,
            verifiedEvidence: item.verifiedEvidence,
            promptVersion: item.promptVersion,
          });
        }

        if (classifiedItems.length > 0) {
          const upsertRes = await upsertExtractedItems(deps.db, {
            snapshotId,
            sourceId: r.sourceId,
            sourcePriority,
            sourceUrl: extracted.sourceUrl,
            items: classifiedItems,
          });
          upsertedItems += upsertRes.createdIds.length + upsertRes.updatedIds.length;
          eventsCreated += upsertRes.events.length;
        }
      } catch (err) {
        if (err instanceof LlmBudgetExceededError) {
          budgetExceeded = true;
          logger.error({ err: err.message }, 'Anggaran bulanan LLM tercapai; ekstraksi dihentikan');
          await deps.telegram.sendToOperator(
            `⚠️ [${deps.env.BRAND_NAME}] Batas anggaran LLM bulanan tercapai (${err.message}). Pemanggilan LLM dihentikan otomatis hingga batas dinaikkan atau bulan berganti.`,
          );
          break;
        }
        logger.error({ err, snapshotId, sourceId: r.sourceId }, 'Gagal memproses snapshot');
      }
    }
  }

  let evaluatedItems = 0;
  if (upsertedItems > 0) {
    const evals = await evaluateAll(deps.db, { fx: deps.fx, now: now() });
    evaluatedItems = evals.length;
  }

  let sourceAlertsSent = 0;
  if (sourceFailures.length > 0) {
    const flushed = await flushUrgentAlerts(deps.db, deps.telegram, {
      sourceFailures,
      now: now(),
      brandName: deps.env.BRAND_NAME,
    });
    sourceAlertsSent = flushed.sourceAlertsSent;
  }

  return {
    schedule: scheduleLabel,
    ingestResults,
    extractedSnapshots,
    upsertedItems,
    eventsCreated,
    evaluatedItems,
    sourceAlertsSent,
    budgetExceeded,
  };
}

/** Menghitung ulang evaluasi & teks draf bila data draf sudah lebih tua dari `stale_hours` (24 jam). */
export function createDraftRecomputer(deps: PipelineDeps): RecomputeDraftFn {
  const now = deps.now ?? (() => new Date());
  return async (draft) => {
    if (!draft.item_ids || draft.item_ids.length === 0) {
      return { changed: false, newDataAsOf: now() };
    }

    const paramsSnap = await loadParams(deps.db, now());
    let changed = false;
    const updatedItems: DraftItemData[] = [];
    const changesSummary: string[] = [];

    for (const itemId of draft.item_ids) {
      const prevEvalRes = await deps.db.query<{ po_price_idr: number | null; reference_idr: number | null }>(
        'SELECT po_price_idr, reference_idr FROM evaluations WHERE item_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
        [itemId],
      );
      const prevPo = prevEvalRes.rows[0]?.po_price_idr ?? null;

      const fresh = await evaluateItem(deps.db, itemId, { fx: deps.fx, now: now() });
      const { rows: itemRows } = await deps.db.query<{
        tomica_no: number | null;
        name_ja: string;
        name_id: string | null;
        edition: DraftItemData['edition'];
        release_date_jst: string | null;
        price_jpy: number | null;
      }>('SELECT tomica_no, name_ja, name_id, edition, release_date_jst, price_jpy FROM items WHERE id = $1', [itemId]);
      const it = itemRows[0];
      if (!it) continue;

      if (prevPo !== fresh.po_price_idr) {
        changed = true;
        changesSummary.push(`${it.name_ja}: HargaPO ${prevPo ?? '-'} → ${fresh.po_price_idr ?? '-'}`);
      }

      updatedItems.push({
        itemId,
        tomicaNo: it.tomica_no,
        nameJa: it.name_ja,
        nameId: it.name_id,
        edition: it.edition,
        releaseDateJst: it.release_date_jst,
        priceJpy: it.price_jpy,
        poPriceIdr: fresh.po_price_idr,
        referenceIdr: fresh.reference_idr,
        poRatio: fresh.po_ratio,
      });
    }

    if (!changed) {
      return { changed: false, newDataAsOf: now(), newParamsVersion: paramsSnap.version };
    }

    const rendered = renderDraftTemplate(draft.kind, {
      brandName: deps.env.BRAND_NAME,
      items: updatedItems,
      sources: draft.sources,
      poTerms:
        draft.kind === 'po_open'
          ? {
              dpPercent: 50,
              deadline: 'Lihat pengumuman PO terbaru',
              contactMethod: `Pesan lewat bot/form resmi ${deps.env.BRAND_NAME}`,
            }
          : undefined,
    });

    return {
      changed: true,
      newText: rendered.text,
      newDataAsOf: now(),
      newParamsVersion: paramsSnap.version,
      newSources: rendered.sources,
      summary: changesSummary.join('; '),
    };
  };
}

/** Membangun `DraftServiceDeps` lengkap untuk F9 (termasuk recompute > 24 jam). */
export function createDraftServiceDeps(deps: PipelineDeps): DraftServiceDeps {
  return {
    db: deps.db,
    telegram: deps.telegram,
    operatorUserId: deps.env.TELEGRAM_OPERATOR_CHAT_ID ?? 'operator',
    llm: deps.llm,
    brandName: deps.env.BRAND_NAME,
    recompute: createDraftRecomputer(deps),
    now: deps.now,
  };
}

/** Membangun implementasi `OperatorControls` untuk bot Telegram operator. */
export function createOperatorControls(deps: PipelineDeps): OperatorControls {
  return {
    async getStatus(): Promise<StatusSummary> {
      const paused = await isPaused(deps.db);
      const { rows: srcCounts } = await deps.db.query<{
        active: number;
        paused: number;
        failing: number;
      }>(`
        SELECT
          COUNT(*) FILTER (WHERE enabled AND NOT paused)::int AS active,
          COUNT(*) FILTER (WHERE paused)::int AS paused,
          COUNT(*) FILTER (WHERE consecutive_failures > 0)::int AS failing
        FROM sources
      `);
      const { rows: draftCount } = await deps.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM drafts WHERE status = 'draft'`,
      );
      const { rows: reviewCount } = await deps.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM review_queue WHERE NOT resolved`,
      );
      const { rows: lastRun } = await deps.db.query<{ started_at: Date }>(
        `SELECT started_at FROM runs ORDER BY id DESC LIMIT 1`,
      );
      return {
        paused,
        activeSources: srcCounts[0]?.active ?? 0,
        pausedSources: srcCounts[0]?.paused ?? 0,
        failingSources: srcCounts[0]?.failing ?? 0,
        pendingDrafts: draftCount[0]?.c ?? 0,
        pendingReviews: reviewCount[0]?.c ?? 0,
        lastRunAt: lastRun[0]?.started_at ?? null,
      };
    },

    async pause(by: string): Promise<void> {
      await setPaused(deps.db, true, by);
    },

    async resume(by: string): Promise<void> {
      await setPaused(deps.db, false, by);
    },

    async ignoreItem(itemId: number): Promise<{ ok: boolean; message?: string }> {
      const { rows } = await deps.db.query<{ id: number; name_ja: string }>(
        'UPDATE items SET ignored = true, updated_at = now() WHERE id = $1 RETURNING id, name_ja',
        [itemId],
      );
      if (!rows[0]) return { ok: false, message: `Item #${itemId} tidak ditemukan.` };
      return { ok: true, message: `Item #${rows[0].id} (${rows[0].name_ja}) ditandai diabaikan.` };
    },

    async setParam(key: ParamKey, value: number | string, by: string): Promise<void> {
      await setParamDb(deps.db, key, value, by);
    },

    async forceRefetch(sourceId: string): Promise<{ ok: boolean; message?: string }> {
      const res = await schedulerForceRefetch(deps.ingestDeps, sourceId);
      return {
        ok: res.status === 'ok' || res.status === 'unchanged',
        message: `Sumber ${sourceId}: status=${res.status}, snapshot baru=${res.newSnapshotIds.length}`,
      };
    },

    async recentRuns(limit = 10) {
      const runs = await schedulerRecentRuns(deps.db, limit);
      const { rows: decisions } = await deps.db.query<DecisionLogEntry>(
        `SELECT e.item_id, i.name_ja, e.label, e.po_ratio, e.po_price_idr, e.reference_idr, e.created_at
         FROM evaluations e
         JOIN items i ON i.id = e.item_id
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT $1`,
        [limit],
      );
      return { runs, decisions };
    },

    async listReview(limit = 10): Promise<ReviewEntry[]> {
      const { rows } = await deps.db.query<ReviewEntry>(
        `SELECT r.id, r.kind, r.item_id, i.name_ja AS item_name, r.reason, r.created_at
         FROM review_queue r
         LEFT JOIN items i ON i.id = r.item_id
         WHERE NOT r.resolved
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT $1`,
        [limit],
      );
      return rows;
    },

    async sendSummaryNow(): Promise<{ ok: boolean; message?: string }> {
      const now = deps.now ?? (() => new Date());
      await sendDailySummary(deps.db, deps.telegram, now(), { brandName: deps.env.BRAND_NAME });
      return { ok: true, message: 'Ringkasan harian berhasil dikirim.' };
    },

    async createTestDraft(): Promise<{ ok: boolean; draftId?: number; message?: string }> {
      const draftDeps = createDraftServiceDeps(deps);
      const draft = await createDraft(draftDeps, {
        kind: 'po_open',
        itemIds: [],
        useP4: false,
        data: {
          brandName: `${deps.env.BRAND_NAME} [UJI STAGING]`,
          items: [
            {
              tomicaNo: 94,
              nameJa: '光岡 M55 [UJI STAGING]',
              nameId: 'Mitsuoka M55 (Contoh Uji Staging)',
              edition: 'first',
              releaseDateJst: '2026-12-19',
              priceJpy: 594,
              poPriceIdr: 156942,
              referenceIdr: 253462,
              poRatio: 1.61,
              sourceUrl: 'https://www.takaratomy.co.jp/products/tomica/',
            },
          ],
          poTerms: {
            dpPercent: 50,
            deadline: 'Contoh tenggat uji staging (JST / WIB)',
            contactMethod: `Contoh cara pesan — ${deps.env.BRAND_NAME} (UJI STAGING)`,
          },
          sources: [
            {
              claim: 'Data contoh uji staging (bukan rilis aktual)',
              url: 'https://www.takaratomy.co.jp/products/tomica/',
            },
          ],
        },
      });
      return {
        ok: true,
        draftId: draft.id,
        message: `Draf uji staging #${draft.id} dikirim untuk review (Setuju / Edit / Tolak).`,
      };
    },
  };
}

/** Menghubungkan semua 9 jadwal PRD §8 ke handler nyata. */
export function buildJobHandlers(deps: PipelineDeps): JobHandlers {
  const now = deps.now ?? (() => new Date());
  const draftDeps = createDraftServiceDeps(deps);

  return {
    p1_pipeline: async () => {
      const res = await runIngestAndExtractCycle(deps, 'p1');
      return res.upsertedItems;
    },
    p2_ingest: async () => {
      const res = await runIngestAndExtractCycle(deps, 'p2');
      return res.upsertedItems;
    },
    fx_evaluate: async () => {
      const evals = await evaluateAll(deps.db, { fx: deps.fx, now: now() });
      return evals.length;
    },
    daily_summary: async () => {
      await sendDailySummary(deps.db, deps.telegram, now(), { brandName: deps.env.BRAND_NAME });
      return 1;
    },
    urgent_alerts: async () => {
      const res = await flushUrgentAlerts(deps.db, deps.telegram, {
        now: now(),
        brandName: deps.env.BRAND_NAME,
      });
      return res.eventsSent + res.sourceAlertsSent;
    },
    weekly_report: async () => {
      await sendWeeklyReport(deps.db, deps.telegram, now(), {
        brandName: deps.env.BRAND_NAME,
        monthlyBudgetUsd: deps.env.LLM_MONTHLY_BUDGET_USD,
      });
      return 1;
    },
    release_reminders: async () => {
      const rem = reminderDue(now());
      if (rem.due.length === 0) return 0;

      const cal = await releaseCalendar(deps.db, todayJst(now()), 14);
      const upcoming = cal.filter((c) => c.release_date_jst === rem.nextThirdSaturday);
      if (upcoming.length === 0) return 0;

      const items: DraftItemData[] = upcoming.map((u) => ({
        itemId: u.item_id,
        tomicaNo: u.tomica_no,
        nameJa: u.name_ja,
        nameId: u.name_id,
        edition: u.edition,
        releaseDateJst: u.release_date_jst,
        priceJpy: u.price_jpy,
      }));

      await createDraft(draftDeps, {
        kind: 'reminder',
        itemIds: upcoming.map((u) => u.item_id),
        data: {
          brandName: deps.env.BRAND_NAME,
          daysBeforeRelease: rem.daysUntil,
          releaseDateJst: rem.nextThirdSaturday,
          items,
          sources: [{ claim: 'Jadwal rilis resmi Takara Tomy', url: 'https://www.takaratomy.co.jp/products/tomica/' }],
        },
        useP4: false,
      });
      return 1;
    },
    release_day_check: async () => {
      const res = await runIngestAndExtractCycle(deps, 'p1');
      return res.upsertedItems;
    },
    daily_backup: async () => {
      const expired = await expireOldDrafts(deps.db, now());
      logger.info({ expiredDrafts: expired.length }, 'Pemeliharaan harian & penanda cadangan selesai');
      return expired.length;
    },
  };
}

export { createDraftActionHandler, ingestSource };
