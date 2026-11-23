/**
 * Ringkasan harian operator (PRD §2, §4 F8, §8 jadwal 08:00 JST).
 * Menampilkan:
 * 1. Item baru atau berubah dalam 24 jam terakhir (tabel `events`)
 * 2. Item dengan jadwal rilis dalam 7 hari ke depan
 * 3. Evaluasi terbaru per item (label, rasio PO, HargaPO, harga acuan)
 * 4. Status sumber (dijeda / gagal)
 * 5. Jumlah antrean REVIEW
 *
 * Seluruh stempel waktu ditampilkan dalam JST dan WIB; tidak ada nama pribadi (pakai BRAND_NAME).
 */
import { DateTime } from 'luxon';
import type { Db } from '../db/client.js';
import { formatJstWib, JST, todayJst } from '../shared/time.js';
import type { EventKind, Label, ReferenceKind, TelegramPort } from '../shared/types.js';
import { formatIdr, formatJpy, formatRatio } from '../telegram/format.js';

export interface DailySummaryOptions {
  brandName?: string;
}

const EVENT_KIND_ID: Record<EventKind, string> = {
  new: 'BARU',
  date: 'TANGGAL BERUBAH',
  price: 'HARGA BERUBAH',
  edition: 'EDISI BERUBAH',
  cancelled: 'DIBATALKAN',
};

const LABEL_PRIORITY: Record<Label, number> = {
  LAYAK: 1,
  BATAS: 2,
  REVIEW: 3,
  TIDAK: 4,
};

function formatItemTitle(item: { tomica_no: number | null; name_ja: string; name_id: string | null }): string {
  const no = item.tomica_no != null ? `No.${item.tomica_no} ` : '';
  const idPart = item.name_id ? ` (${item.name_id})` : '';
  return `${no}${item.name_ja}${idPart}`;
}

function formatEventChange(kind: EventKind, oldVal: unknown, newVal: unknown): string {
  if (kind === 'new') return 'item baru terdeteksi';
  if (kind === 'cancelled') return 'status dibatalkan';
  const oldStr = oldVal == null ? '-' : typeof oldVal === 'string' ? oldVal : JSON.stringify(oldVal);
  const newStr = newVal == null ? '-' : typeof newVal === 'string' ? newVal : JSON.stringify(newVal);
  return `${oldStr} → ${newStr}`;
}

function formatRefKind(kind: ReferenceKind | null): string {
  if (kind === 'ID-market') return 'pasar-ID';
  if (kind === 'JP-used') return 'bekas-JP';
  return '-';
}

export async function buildDailySummary(
  db: Db,
  now: Date = new Date(),
  opts?: DailySummaryOptions,
): Promise<string> {
  const brand = opts?.brandName ?? process.env.BRAND_NAME ?? 'Radar Tomica Jepang';
  const since24h = new Date(now.getTime() - 24 * 3_600_000);
  const today = todayJst(now);
  const plus7d = DateTime.fromJSDate(now).setZone(JST).plus({ days: 7 }).toISODate()!;

  // 1. Item baru atau berubah dalam 24 jam terakhir
  const recentEventsRes = await db.query<{
    id: number;
    item_id: number;
    kind: EventKind;
    old_value: unknown;
    new_value: unknown;
    created_at: Date;
    tomica_no: number | null;
    name_ja: string;
    name_id: string | null;
    edition: string;
  }>(
    `SELECT e.id, e.item_id, e.kind, e.old_value, e.new_value, e.created_at,
            i.tomica_no, i.name_ja, i.name_id, i.edition
     FROM events e
     JOIN items i ON i.id = e.item_id
     WHERE e.created_at >= $1 AND e.created_at <= $2 AND i.ignored = false
     ORDER BY e.created_at DESC, e.id DESC`,
    [since24h, now],
  );

  // 2. Item dalam 7 hari menuju rilis
  const upcomingRes = await db.query<{
    id: number;
    tomica_no: number | null;
    name_ja: string;
    name_id: string | null;
    edition: string;
    release_date_jst: string;
    price_jpy: number | null;
  }>(
    `SELECT id, tomica_no, name_ja, name_id, edition, release_date_jst, price_jpy
     FROM items
     WHERE ignored = false
       AND status <> 'cancelled'
       AND release_date_jst IS NOT NULL
       AND release_date_jst >= $1
       AND release_date_jst <= $2
     ORDER BY release_date_jst ASC, id ASC`,
    [today, plus7d],
  );

  // 3. Evaluasi terbaru per item
  const evalsRes = await db.query<{
    item_id: number;
    tomica_no: number | null;
    name_ja: string;
    name_id: string | null;
    edition: string;
    release_date_jst: string | null;
    label: Label;
    po_ratio: number | null;
    po_price_idr: number | null;
    reference_idr: number | null;
    reference_kind: ReferenceKind | null;
    data_count: number;
  }>(
    `SELECT DISTINCT ON (ev.item_id)
            ev.item_id, i.tomica_no, i.name_ja, i.name_id, i.edition, i.release_date_jst,
            ev.label, ev.po_ratio, ev.po_price_idr, ev.reference_idr, ev.reference_kind, ev.data_count
     FROM evaluations ev
     JOIN items i ON i.id = ev.item_id
     WHERE i.ignored = false AND i.status <> 'cancelled'
     ORDER BY ev.item_id, ev.created_at DESC, ev.id DESC`,
  );

  const sortedEvals = [...evalsRes.rows].sort((a, b) => {
    const pDiff = LABEL_PRIORITY[a.label] - LABEL_PRIORITY[b.label];
    if (pDiff !== 0) return pDiff;
    const rDiff = (b.po_ratio ?? -1) - (a.po_ratio ?? -1);
    if (rDiff !== 0) return rDiff;
    const dA = a.release_date_jst ?? '9999-12-31';
    const dB = b.release_date_jst ?? '9999-12-31';
    return dA.localeCompare(dB);
  });

  // 4. Status sumber
  const sourcesRes = await db.query<{
    id: string;
    name: string;
    enabled: boolean;
    paused: boolean;
    last_status: string | null;
    last_error: string | null;
    consecutive_failures: number;
  }>(
    `SELECT id, name, enabled, paused, last_status, last_error, consecutive_failures
     FROM sources
     ORDER BY priority ASC, id ASC`,
  );

  const problemSources = sourcesRes.rows.filter(
    (s) => s.paused || s.consecutive_failures > 0 || s.last_status === 'error',
  );

  // 5. Antrean REVIEW
  const reviewQueueRes = await db.query<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt FROM review_queue WHERE resolved = false`,
  );
  const reviewQueueCount = reviewQueueRes.rows[0]?.cnt ?? 0;
  const reviewEvalCount = sortedEvals.filter((e) => e.label === 'REVIEW').length;

  // Rakit pesan ringkasan bahasa Indonesia
  const lines: string[] = [
    `[${brand}] Ringkasan Harian`,
    `Waktu: ${formatJstWib(now)}`,
    '',
    `1. Item Baru / Berubah (24 jam terakhir): ${recentEventsRes.rows.length}`,
  ];

  if (recentEventsRes.rows.length === 0) {
    lines.push('   - Tidak ada perubahan dalam 24 jam terakhir.');
  } else {
    for (const ev of recentEventsRes.rows) {
      lines.push(
        `   - [${EVENT_KIND_ID[ev.kind]}] ${formatItemTitle(ev)} (${ev.edition}): ${formatEventChange(ev.kind, ev.old_value, ev.new_value)}`,
      );
    }
  }

  lines.push('', `2. Rilis dalam 7 Hari ke Depan (${today} s.d. ${plus7d} JST): ${upcomingRes.rows.length}`);
  if (upcomingRes.rows.length === 0) {
    lines.push('   - Tidak ada rilis dalam 7 hari ke depan.');
  } else {
    for (const it of upcomingRes.rows) {
      lines.push(
        `   - ${it.release_date_jst} JST: ${formatItemTitle(it)} [${it.edition}] — ${formatJpy(it.price_jpy)}`,
      );
    }
  }

  lines.push('', `3. Evaluasi Terbaru per Item: ${sortedEvals.length}`);
  if (sortedEvals.length === 0) {
    lines.push('   - Belum ada evaluasi harga.');
  } else {
    for (const ev of sortedEvals) {
      const refInfo =
        ev.reference_idr != null
          ? `${formatIdr(ev.reference_idr)} (${formatRefKind(ev.reference_kind)}, n=${ev.data_count})`
          : 'belum cukup data';
      lines.push(
        `   - [${ev.label}] ${formatItemTitle(ev)} | rasio ${formatRatio(ev.po_ratio)} | HargaPO ${formatIdr(ev.po_price_idr)} | Acuan ${refInfo}`,
      );
    }
  }

  lines.push('', '4. Status Sumber:');
  if (sourcesRes.rows.length === 0) {
    lines.push('   - Belum ada sumber terdaftar.');
  } else if (problemSources.length === 0) {
    lines.push(`   - Semua sumber aktif normal (${sourcesRes.rows.filter((s) => s.enabled).length} sumber).`);
  } else {
    for (const s of problemSources) {
      const state = s.paused ? 'DIJEDA' : 'GAGAL';
      const err = s.last_error ? ` — ${s.last_error}` : '';
      lines.push(`   - [${state}] ${s.name} (${s.id}): gagal berturut ${s.consecutive_failures}x${err}`);
    }
  }

  lines.push(
    '',
    `5. Antrean REVIEW: ${reviewQueueCount} tugas review_queue | ${reviewEvalCount} item berlabel REVIEW`,
  );

  return lines.join('\n');
}

export async function sendDailySummary(
  db: Db,
  telegram: TelegramPort,
  now: Date = new Date(),
  opts?: DailySummaryOptions,
): Promise<{ text: string; messageId: string }> {
  const text = await buildDailySummary(db, now, opts);
  const { messageId } = await telegram.sendToOperator(text);
  return { text, messageId };
}
