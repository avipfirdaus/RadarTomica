/**
 * Peringatan segera operator (PRD §4 F8, §8 jadwal tiap 15 menit).
 * Mengirim event penting (important=true AND sent=false) dan peringatan kegagalan
 * sumber ke chat pribadi operator. Menandai `sent = true` HANYA setelah pengiriman
 * berhasil sehingga idempoten dan aman dijalankan ulang.
 */
import type { Db } from '../db/client.js';
import { formatJstWib } from '../shared/time.js';
import type { EventKind, Label, TelegramPort } from '../shared/types.js';
import { formatIdr, formatRatio } from '../telegram/format.js';

export interface SourceFailureAlert {
  sourceId: string;
  sourceName: string;
  consecutiveFailures: number;
  lastError?: string | null;
  paused?: boolean;
}

export interface FlushUrgentAlertsOptions {
  sourceFailures?: SourceFailureAlert[];
  now?: Date;
  brandName?: string;
}

export interface FlushUrgentAlertsResult {
  eventsSent: number;
  sourceAlertsSent: number;
  messageId: string | null;
}

const EVENT_TITLE: Record<EventKind, string> = {
  new: 'Item Baru Penting',
  date: 'Perubahan Tanggal Rilis',
  price: 'Perubahan Harga',
  edition: 'Edisi Khusus / Perubahan Edisi',
  cancelled: 'Item Dibatalkan',
};

export async function flushUrgentAlerts(
  db: Db,
  telegram: TelegramPort,
  opts?: FlushUrgentAlertsOptions,
): Promise<FlushUrgentAlertsResult> {
  const brand = opts?.brandName ?? process.env.BRAND_NAME ?? 'Radar Tomica Jepang';
  const now = opts?.now ?? new Date();
  const sourceFailures = opts?.sourceFailures ?? [];

  const pendingRes = await db.query<{
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
    label: Label | null;
    po_ratio: number | null;
    po_price_idr: number | null;
  }>(
    `SELECT e.id, e.item_id, e.kind, e.old_value, e.new_value, e.created_at,
            i.tomica_no, i.name_ja, i.name_id, i.edition,
            ev.label, ev.po_ratio, ev.po_price_idr
     FROM events e
     JOIN items i ON i.id = e.item_id
     LEFT JOIN LATERAL (
       SELECT label, po_ratio, po_price_idr
       FROM evaluations
       WHERE item_id = e.item_id
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     ) ev ON true
     WHERE e.important = true AND e.sent = false AND i.ignored = false
     ORDER BY e.created_at ASC, e.id ASC`,
  );

  const pendingEvents = pendingRes.rows;
  if (pendingEvents.length === 0 && sourceFailures.length === 0) {
    return { eventsSent: 0, sourceAlertsSent: 0, messageId: null };
  }

  const lines: string[] = [
    `[${brand}] Peringatan Segera`,
    `Waktu: ${formatJstWib(now)}`,
  ];

  if (pendingEvents.length > 0) {
    lines.push('', `Perubahan Penting (${pendingEvents.length}):`);
    for (const ev of pendingEvents) {
      const no = ev.tomica_no != null ? `No.${ev.tomica_no} ` : '';
      const idPart = ev.name_id ? ` (${ev.name_id})` : '';
      const evalPart = ev.label
        ? ` | ${ev.label} (rasio ${formatRatio(ev.po_ratio)}, PO ${formatIdr(ev.po_price_idr)})`
        : '';
      const detail =
        ev.kind === 'new'
          ? ''
          : ` | ${ev.old_value == null ? '-' : JSON.stringify(ev.old_value)} → ${ev.new_value == null ? '-' : JSON.stringify(ev.new_value)}`;
      lines.push(`- [${EVENT_TITLE[ev.kind]}] ${no}${ev.name_ja}${idPart} (${ev.edition})${detail}${evalPart}`);
    }
  }

  if (sourceFailures.length > 0) {
    lines.push('', `Peringatan Sumber Gagal (${sourceFailures.length}):`);
    for (const sf of sourceFailures) {
      const state = sf.paused ? 'DIJEDA OTOMATIS' : 'GAGAL';
      const errPart = sf.lastError ? ` — ${sf.lastError}` : '';
      lines.push(`- [${state}] ${sf.sourceName} (${sf.sourceId}): gagal ${sf.consecutiveFailures}x berturut-turut${errPart}`);
    }
  }

  // Kirim terlebih dahulu; bila gagal, biarkan `sent = false` agar dicoba ulang pada siklus berikutnya.
  const { messageId } = await telegram.sendToOperator(lines.join('\n'));

  if (pendingEvents.length > 0) {
    const ids = pendingEvents.map((e) => e.id);
    await db.query(`UPDATE events SET sent = true WHERE id = ANY($1::bigint[])`, [ids]);
  }

  return {
    eventsSent: pendingEvents.length,
    sourceAlertsSent: sourceFailures.length,
    messageId,
  };
}
