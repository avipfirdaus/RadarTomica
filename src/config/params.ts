/**
 * Parameter bisnis (PRD bagian 5). Nilai awal di sini; nilai efektif dibaca dari
 * tabel `params` (riwayat tersimpan) sehingga operator bisa mengubah tanpa kode.
 */
import type { Db } from '../db/client.js';

export const DEFAULT_PARAMS = {
  /** O: ongkir per kg (yen). */
  shipping_jpy_per_kg: 1500,
  /** Berat per Tomica (kg). */
  unit_weight_kg: 0.12,
  /** K: kemasan per unit (yen). */
  packaging_jpy: 50,
  /** b: faktor pajak impor (BM 7,5% + PPN 11% + PPh 7,5%). */
  import_tax_factor: 0.274,
  /** kurs IDR per JPY untuk HargaPO (sudah termasuk bantalan). */
  fx_idr_per_jpy: 115,
  /** m: markup per edisi; default dipakai untuk edisi lain. */
  markup_first: 0.3,
  markup_premium: 0.25,
  markup_default: 0.3,
  /** Ambang label: LAYAK bila rasio ≥ threshold_layak, BATAS bila ≥ threshold_batas. */
  threshold_layak: 1.1,
  threshold_batas: 1.0,
  /** Syarat data harga acuan. */
  min_id_sellers: 3,
  min_used_transactions: 5,
  min_used_platforms: 2,
  used_window_days: 30,
  /** Item langka bila median bekas ≥ rare_multiplier × harga resmi. */
  rare_multiplier: 1.5,
  rare_soldout_min_shops: 2,
  rare_soldout_window_days: 7,
  /** REVIEW: minat form ≥ n bisa jadi dasar keputusan operator. */
  review_interest_min: 5,
  max_candidates_per_batch: 10,
  /** Data draf lebih tua dari ini dihitung ulang saat Setuju. */
  stale_hours: 24,
  /** Pergeseran kurs dari kurs terkunci yang memicu keputusan operator. */
  fx_shift_alert: 0.03,
  /** Batas anggaran LLM bulanan (USD); 0 = belum ditetapkan (pakai env LLM_MONTHLY_BUDGET_USD). */
  llm_monthly_budget_usd: 0,
  /** Tanggal terakhir parameter pajak ditinjau (NFR bea & pajak). */
  tax_reviewed_at: '2026-11-23',
} as const;

export type ParamKey = keyof typeof DEFAULT_PARAMS;
export type Params = { -readonly [K in ParamKey]: (typeof DEFAULT_PARAMS)[K] extends number ? number : string };

export interface ParamsSnapshot {
  values: Params;
  /** Versi = id baris params terbaru (0 bila semua masih default). */
  version: number;
}

/** Membaca nilai parameter efektif (baris terbaru per kunci, default bila tidak ada). */
export async function loadParams(db: Db, at: Date = new Date()): Promise<ParamsSnapshot> {
  const { rows } = await db.query<{ id: number; key: string; value: unknown }>(
    `SELECT DISTINCT ON (key) id, key, value FROM params WHERE effective_from <= $1 ORDER BY key, effective_from DESC, id DESC`,
    [at],
  );
  const values = { ...DEFAULT_PARAMS } as Params;
  let version = 0;
  for (const r of rows) {
    if (r.key in DEFAULT_PARAMS) {
      (values as Record<string, unknown>)[r.key] = r.value;
      version = Math.max(version, r.id);
    }
  }
  return { values, version };
}

/** Mengubah satu parameter (riwayat disimpan, tidak menimpa). */
export async function setParam(db: Db, key: ParamKey, value: number | string, changedBy: string): Promise<void> {
  if (!(key in DEFAULT_PARAMS)) throw new Error(`Parameter tidak dikenal: ${key}`);
  if (typeof value !== typeof DEFAULT_PARAMS[key]) throw new Error(`Tipe nilai ${key} harus ${typeof DEFAULT_PARAMS[key]}`);
  await db.query('INSERT INTO params (key, value, changed_by) VALUES ($1, $2, $3)', [key, JSON.stringify(value), changedBy]);
}
