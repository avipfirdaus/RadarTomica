/**
 * Laporan mingguan operator (PRD §10 'Isi laporan mingguan', Senin 09:00 JST).
 * Memuat:
 * 1. Item baru dan berubah (7 hari terakhir)
 * 2. Kandidat LAYAK / BATAS beserta rasio
 * 3. Kalender rilis 30 hari ke depan
 * 4. Status tiap sumber
 * 5. Status metrik bisnis vs target go/no-go (anggota ≥150, penanya ≥20, form ≥30, model minat ≥5 ≥3)
 * 6. Biaya LLM pekan lalu (dari tabel `llm_calls`)
 * 7. Daftar item REVIEW yang belum diputuskan
 */
import { DateTime } from 'luxon';
import type { Db } from '../db/client.js';
import { formatJstWib, JST, todayJst } from '../shared/time.js';
import type { EventKind, Label, TelegramPort } from '../shared/types.js';
import { formatIdr, formatJpy, formatRatio } from '../telegram/format.js';

export const BUSINESS_TARGETS = {
  members: 150,
  howToOrderAskers: 20,
  formEntries: 30,
  modelsWithMinInterest: 3,
} as const;

export interface WeeklyReportOptions {
  brandName?: string;
  /** Jumlah model dengan minat ≥ 5 orang dari rekap form (opsional bila belum di DB). */
  modelsWithMinInterest?: number | null;
  monthlyBudgetUsd?: number;
}

function targetStatus(actual: number | null | undefined, target: number): string {
  if (actual == null) return `belum ada data (target ≥ ${target})`;
  const mark = actual >= target ? 'TERCAPAI' : 'BELUM';
  return `${actual} / ${target} [${mark}]`;
}

export async function buildWeeklyReport(
  db: Db,
  now: Date = new Date(),
  opts?: WeeklyReportOptions,
): Promise<string> {
  const brand = opts?.brandName ?? process.env.BRAND_NAME ?? 'Radar Tomica Jepang';
  const since7d = new Date(now.getTime() - 7 * 24 * 3_600_000);
  const today = todayJst(now);
  const plus30d = DateTime.fromJSDate(now).setZone(JST).plus({ days: 30 }).toISODate()!;

  // 1. Item baru dan berubah (7 hari terakhir)
  const eventsRes = await db.query<{
    kind: EventKind;
    tomica_no: number | null;
    name_ja: string;
    name_id: string | null;
    edition: string;
  }>(
    `SELECT e.kind, i.tomica_no, i.name_ja, i.name_id, i.edition
     FROM events e
     JOIN items i ON i.id = e.item_id
     WHERE e.created_at >= $1 AND e.created_at <= $2 AND i.ignored = false
     ORDER BY e.created_at DESC, e.id DESC`,
    [since7d, now],
  );

  // 2. Kandidat LAYAK / BATAS (evaluasi terbaru per item)
  const candidatesRes = await db.query<{
    item_id: number;
    tomica_no: number | null;
    name_ja: string;
    name_id: string | null;
    label: Label;
    po_ratio: number | null;
    po_price_idr: number | null;
    reference_idr: number | null;
    release_date_jst: string | null;
  }>(
    `SELECT * FROM (
       SELECT DISTINCT ON (ev.item_id)
              ev.item_id, i.tomica_no, i.name_ja, i.name_id,
              ev.label, ev.po_ratio, ev.po_price_idr, ev.reference_idr, i.release_date_jst
       FROM evaluations ev
       JOIN items i ON i.id = ev.item_id
       WHERE i.ignored = false AND i.status <> 'cancelled'
       ORDER BY ev.item_id, ev.created_at DESC, ev.id DESC
     ) latest
     WHERE latest.label IN ('LAYAK', 'BATAS')
     ORDER BY CASE latest.label WHEN 'LAYAK' THEN 1 ELSE 2 END,
              latest.po_ratio DESC NULLS LAST,
              latest.release_date_jst ASC NULLS LAST`,
  );

  // 3. Kalender 30 hari ke depan
  const calendarRes = await db.query<{
    tomica_no: number | null;
    name_ja: string;
    name_id: string | null;
    edition: string;
    release_date_jst: string;
    price_jpy: number | null;
  }>(
    `SELECT tomica_no, name_ja, name_id, edition, release_date_jst, price_jpy
     FROM items
     WHERE ignored = false
       AND status <> 'cancelled'
       AND release_date_jst IS NOT NULL
       AND release_date_jst >= $1
       AND release_date_jst <= $2
     ORDER BY release_date_jst ASC, id ASC`,
    [today, plus30d],
  );

  // 4. Status tiap sumber
  const sourcesRes = await db.query<{
    id: string;
    name: string;
    enabled: boolean;
    paused: boolean;
    last_status: string | null;
    consecutive_failures: number;
  }>(
    `SELECT id, name, enabled, paused, last_status, consecutive_failures
     FROM sources
     ORDER BY priority ASC, id ASC`,
  );

  // 5. Metrik bisnis terbaru (channel_stats)
  const statsRes = await db.query<{
    date: string;
    members: number | null;
    avg_views: number | null;
    replies: number | null;
    form_entries: number | null;
    how_to_order_askers: number | null;
  }>(
    `SELECT date, members, avg_views, replies, form_entries, how_to_order_askers
     FROM channel_stats
     ORDER BY date DESC
     LIMIT 1`,
  );
  const stats = statsRes.rows[0];

  // 6. Biaya LLM pekan lalu
  const llmRes = await db.query<{
    call_count: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  }>(
    `SELECT COUNT(*)::int AS call_count,
            COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
            COALESCE(SUM(cost_usd), 0)::numeric AS cost_usd
     FROM llm_calls
     WHERE created_at >= $1 AND created_at <= $2`,
    [since7d, now],
  );
  const llmStats = llmRes.rows[0] ?? { call_count: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };

  // 7. Daftar item REVIEW yang belum diputuskan
  const reviewQueueRes = await db.query<{
    id: number;
    kind: string;
    item_id: number | null;
    reason: string;
    name_ja: string | null;
  }>(
    `SELECT rq.id, rq.kind, rq.item_id, rq.reason, i.name_ja
     FROM review_queue rq
     LEFT JOIN items i ON i.id = rq.item_id
     WHERE rq.resolved = false
     ORDER BY rq.created_at ASC, rq.id ASC`,
  );

  const reviewItemsRes = await db.query<{
    item_id: number;
    name_ja: string;
    reason: string | null;
  }>(
    `SELECT * FROM (
       SELECT DISTINCT ON (ev.item_id) ev.item_id, i.name_ja, ev.label, ev.reason
       FROM evaluations ev
       JOIN items i ON i.id = ev.item_id
       WHERE i.ignored = false AND i.status <> 'cancelled'
       ORDER BY ev.item_id, ev.created_at DESC, ev.id DESC
     ) latest
     WHERE latest.label = 'REVIEW'
     ORDER BY latest.item_id ASC`,
  );

  const lines: string[] = [
    `[${brand}] Laporan Mingguan`,
    `Waktu: ${formatJstWib(now)}`,
    '',
    `1. Item Baru & Berubah (7 hari terakhir): ${eventsRes.rows.length}`,
  ];

  if (eventsRes.rows.length === 0) {
    lines.push('   - Tidak ada perubahan pekan ini.');
  } else {
    for (const e of eventsRes.rows) {
      const no = e.tomica_no != null ? `No.${e.tomica_no} ` : '';
      lines.push(`   - [${e.kind}] ${no}${e.name_ja} (${e.edition})`);
    }
  }

  lines.push('', `2. Kandidat LAYAK / BATAS: ${candidatesRes.rows.length}`);
  if (candidatesRes.rows.length === 0) {
    lines.push('   - Belum ada kandidat LAYAK/BATAS.');
  } else {
    for (const c of candidatesRes.rows) {
      const no = c.tomica_no != null ? `No.${c.tomica_no} ` : '';
      lines.push(
        `   - [${c.label}] ${no}${c.name_ja} | rasio ${formatRatio(c.po_ratio)} | HargaPO ${formatIdr(c.po_price_idr)} | Acuan ${formatIdr(c.reference_idr)}`,
      );
    }
  }

  lines.push('', `3. Kalender 30 Hari ke Depan (${today} s.d. ${plus30d} JST): ${calendarRes.rows.length}`);
  if (calendarRes.rows.length === 0) {
    lines.push('   - Belum ada rilis terjadwal dalam 30 hari.');
  } else {
    for (const it of calendarRes.rows) {
      const no = it.tomica_no != null ? `No.${it.tomica_no} ` : '';
      lines.push(`   - ${it.release_date_jst} JST: ${no}${it.name_ja} [${it.edition}] — ${formatJpy(it.price_jpy)}`);
    }
  }

  lines.push('', '4. Status Tiap Sumber:');
  if (sourcesRes.rows.length === 0) {
    lines.push('   - Belum ada sumber terdaftar.');
  } else {
    for (const s of sourcesRes.rows) {
      const state = !s.enabled ? 'NONAKTIF' : s.paused ? 'DIJEDA' : s.consecutive_failures > 0 ? 'GAGAL' : 'OK';
      lines.push(`   - ${s.name} (${s.id}): ${state} (status=${s.last_status ?? '-'}, gagal=${s.consecutive_failures})`);
    }
  }

  lines.push('', `5. Metrik Bisnis vs Target Go/No-Go${stats ? ` (data per ${stats.date})` : ''}:`);
  lines.push(`   - Anggota channel: ${targetStatus(stats?.members, BUSINESS_TARGETS.members)}`);
  lines.push(`   - Penanya cara pesan: ${targetStatus(stats?.how_to_order_askers, BUSINESS_TARGETS.howToOrderAskers)}`);
  lines.push(`   - Isian form minat: ${targetStatus(stats?.form_entries, BUSINESS_TARGETS.formEntries)}`);
  lines.push(
    `   - Model dengan minat ≥ 5 orang: ${targetStatus(opts?.modelsWithMinInterest, BUSINESS_TARGETS.modelsWithMinInterest)}`,
  );

  const budgetNote =
    opts?.monthlyBudgetUsd && opts.monthlyBudgetUsd > 0
      ? ` (batas bulanan USD ${opts.monthlyBudgetUsd.toFixed(2)})`
      : '';
  lines.push(
    '',
    `6. Biaya LLM Pekan Lalu: USD ${Number(llmStats.cost_usd).toFixed(4)} (${llmStats.call_count} panggilan, ${llmStats.input_tokens} in / ${llmStats.output_tokens} out token)${budgetNote}`,
  );

  lines.push(
    '',
    `7. Daftar Item REVIEW Belum Diputuskan (${reviewQueueRes.rows.length} antrean, ${reviewItemsRes.rows.length} evaluasi REVIEW):`,
  );
  if (reviewQueueRes.rows.length === 0 && reviewItemsRes.rows.length === 0) {
    lines.push('   - Tidak ada item REVIEW yang tertunda.');
  } else {
    for (const rq of reviewQueueRes.rows) {
      const label = rq.item_id != null ? `Item #${rq.item_id}${rq.name_ja ? ` (${rq.name_ja})` : ''}` : 'Umum';
      lines.push(`   - [queue #${rq.id}] ${rq.kind} — ${label}: ${rq.reason}`);
    }
    for (const ri of reviewItemsRes.rows) {
      lines.push(`   - [eval #${ri.item_id}] ${ri.name_ja}: ${ri.reason ?? 'data acuan belum cukup'}`);
    }
  }

  return lines.join('\n');
}

export async function sendWeeklyReport(
  db: Db,
  telegram: TelegramPort,
  now: Date = new Date(),
  opts?: WeeklyReportOptions,
): Promise<{ text: string; messageId: string }> {
  const text = await buildWeeklyReport(db, now, opts);
  const { messageId } = await telegram.sendToOperator(text);
  return { text, messageId };
}
