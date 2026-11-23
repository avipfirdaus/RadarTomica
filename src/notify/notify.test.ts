import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type Db } from '../db/client.js';
import { DryRunTelegram } from '../telegram/dry-run.js';
import { buildDailySummary, buildWeeklyReport, flushUrgentAlerts } from './index.js';

describe('notify (F8 daily summary, urgent alerts, weekly report)', () => {
  let db: Db;
  let telegram: DryRunTelegram;
  // 2026-12-15 08:00 JST = 2026-12-14 23:00 UTC
  const NOW = new Date('2026-12-14T23:00:00Z');

  beforeEach(async () => {
    db = await createTestDb();
    telegram = new DryRunTelegram();

    await db.query(
      `INSERT INTO sources (id, name, url, priority, kind, schedule, enabled, paused, last_status, last_error, consecutive_failures)
       VALUES
         ('takaratomy-lineup', 'Situs Resmi Tomica', 'https://www.takaratomy.co.jp/products/tomica/', 1, 'page', 'p1', true, false, 'ok', null, 0),
         ('motor-fan', 'Motor-Fan', 'https://motor-fan.jp/', 2, 'feed', 'p2', true, true, 'error', 'HTTP 503', 2)`,
    );

    const item1 = await db.query<{ id: number }>(
      `INSERT INTO items (canonical_key, tomica_no, name_ja, name_id, category, edition, release_date_jst, price_jpy, status, is_rare)
       VALUES ('mitsuoka-m55-first-2026-12-19', 94, '光岡 M55', 'Mitsuoka M55', 'first', 'first', '2026-12-19', 594, 'announced', true)
       RETURNING id`,
    );
    const item2 = await db.query<{ id: number }>(
      `INSERT INTO items (canonical_key, tomica_no, name_ja, name_id, category, edition, release_date_jst, price_jpy, status, is_rare)
       VALUES ('premium-gtr-2026-12-26', 12, 'トミカプレミアム GT-R', null, 'premium', 'premium', '2026-12-26', 1100, 'announced', false)
       RETURNING id`,
    );
    const id1 = item1.rows[0]!.id;
    const id2 = item2.rows[0]!.id;

    // Event dalam 24 jam terakhir (important, belum terkirim)
    await db.query(
      `INSERT INTO events (item_id, kind, old_value, new_value, important, created_at, sent)
       VALUES
         ($1, 'new', null, '{"edition":"first"}'::jsonb, true, $3, false),
         ($2, 'price', '1000'::jsonb, '1100'::jsonb, true, $4, false)`,
      [id1, id2, new Date('2026-12-14T20:00:00Z'), new Date('2026-12-14T21:00:00Z')],
    );

    // Evaluasi terbaru
    await db.query(
      `INSERT INTO evaluations (item_id, params_version, fx_idr_per_jpy, landed_idr, po_price_idr, reference_idr, reference_kind, data_count, po_ratio, label, reason, created_at)
       VALUES
         ($1, 1, 115, 120700, 157000, 253000, 'JP-used', 6, 1.61, 'LAYAK', 'Rasio >= 1.10', $3),
         ($2, 1, 115, 195000, 244000, null, null, 1, null, 'REVIEW', 'Data penjual kurang', $3)`,
      [id1, id2, new Date('2026-12-14T22:00:00Z')],
    );

    // Review queue
    await db.query(
      `INSERT INTO review_queue (kind, item_id, reason, resolved, created_at)
       VALUES ('classification', $1, 'Perlu konfirmasi edisi terbatas', false, $2)`,
      [id2, new Date('2026-12-14T22:10:00Z')],
    );
  });

  afterEach(async () => {
    await db.close();
  });

  it('buildDailySummary includes all expected sections, JST & WIB timestamps, brand name, and no personal data', async () => {
    const summary = await buildDailySummary(db, NOW, { brandName: 'Radar Tomica Jepang' });

    expect(summary).toContain('[Radar Tomica Jepang] Ringkasan Harian');
    expect(summary).toContain('JST /');
    expect(summary).toContain('WIB');
    expect(summary).toContain('Item Baru / Berubah (24 jam terakhir): 2');
    expect(summary).toContain('光岡 M55');
    expect(summary).toContain('Rilis dalam 7 Hari ke Depan');
    expect(summary).toContain('2026-12-19 JST');
    expect(summary).toContain('Evaluasi Terbaru per Item');
    expect(summary).toContain('[LAYAK]');
    expect(summary).toContain('Rp157.000');
    expect(summary).toContain('Rp253.000');
    expect(summary).toContain('1,61x');
    expect(summary).toContain('Status Sumber');
    expect(summary).toContain('[DIJEDA] Motor-Fan');
    expect(summary).toContain('Antrean REVIEW: 1 tugas review_queue | 1 item berlabel REVIEW');

    // Pastikan tidak ada data pribadi (nama/kota pribadi operator)
    expect(summary.toLowerCase()).not.toContain('avip');
    expect(summary.toLowerCase()).not.toContain('okayama');
  });

  it('flushUrgentAlerts marks sent=true only after successful send and does not resend', async () => {
    // 1. Simulasikan gagal kirim Telegram -> event TIDAK boleh ditandai sent=true
    telegram.failNextOperator(new Error('Network down'));
    await expect(
      flushUrgentAlerts(db, telegram, {
        now: NOW,
        sourceFailures: [
          { sourceId: 'motor-fan', sourceName: 'Motor-Fan', consecutiveFailures: 2, lastError: 'HTTP 503', paused: true },
        ],
      }),
    ).rejects.toThrow('Network down');

    const stillUnsent = await db.query<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM events WHERE sent = false');
    expect(stillUnsent.rows[0]?.cnt).toBe(2);
    expect(telegram.operatorMessages).toHaveLength(0);

    // 2. Pengiriman berhasil -> terkirim & ditandai sent=true
    const res1 = await flushUrgentAlerts(db, telegram, {
      now: NOW,
      sourceFailures: [
        { sourceId: 'motor-fan', sourceName: 'Motor-Fan', consecutiveFailures: 2, lastError: 'HTTP 503', paused: true },
      ],
    });
    expect(res1.eventsSent).toBe(2);
    expect(res1.sourceAlertsSent).toBe(1);
    expect(res1.messageId).toBeTruthy();
    expect(telegram.operatorMessages).toHaveLength(1);
    expect(telegram.operatorMessages[0]?.text).toContain('Peringatan Segera');
    expect(telegram.operatorMessages[0]?.text).toContain('Motor-Fan');
    expect(telegram.operatorMessages[0]?.text).toContain('LAYAK');

    const remaining = await db.query<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM events WHERE sent = false');
    expect(remaining.rows[0]?.cnt).toBe(0);

    // 3. Panggilan ulang -> idempoten, tidak mengirim ulang
    const res2 = await flushUrgentAlerts(db, telegram, { now: NOW });
    expect(res2.eventsSent).toBe(0);
    expect(res2.sourceAlertsSent).toBe(0);
    expect(res2.messageId).toBeNull();
    expect(telegram.operatorMessages).toHaveLength(1);
  });

  it('buildWeeklyReport includes business targets, LLM cost, 30-day calendar, and review items', async () => {
    await db.query(
      `INSERT INTO channel_stats (date, members, avg_views, replies, form_entries, how_to_order_askers)
       VALUES ('2026-12-14', 165, 90, 25, 34, 18)`,
    );
    await db.query(
      `INSERT INTO llm_calls (task, prompt_version, model, input_tokens, output_tokens, cost_usd, ok, created_at)
       VALUES
         ('P1', 'P1@1', 'claude-sonnet-4-5', 2000, 400, 0.012, true, $1),
         ('P4', 'P4@1', 'claude-sonnet-4-5', 800, 300, 0.006, true, $1)`,
      [new Date('2026-12-13T10:00:00Z')],
    );

    const report = await buildWeeklyReport(db, NOW, {
      brandName: 'Radar Tomica Jepang',
      modelsWithMinInterest: 4,
      monthlyBudgetUsd: 20,
    });

    expect(report).toContain('[Radar Tomica Jepang] Laporan Mingguan');
    expect(report).toContain('JST /');
    expect(report).toContain('WIB');
    expect(report).toContain('Kandidat LAYAK / BATAS: 1');
    expect(report).toContain('Kalender 30 Hari ke Depan');
    expect(report).toContain('2026-12-26 JST');
    expect(report).toContain('Anggota channel: 165 / 150 [TERCAPAI]');
    expect(report).toContain('Penanya cara pesan: 18 / 20 [BELUM]');
    expect(report).toContain('Isian form minat: 34 / 30 [TERCAPAI]');
    expect(report).toContain('Model dengan minat ≥ 5 orang: 4 / 3 [TERCAPAI]');
    expect(report).toContain('Biaya LLM Pekan Lalu: USD 0.0180');
    expect(report).toContain('Daftar Item REVIEW Belum Diputuskan');
  });
});
