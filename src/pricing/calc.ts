/**
 * F6: Fungsi murni perhitungan Landed, HargaPO, harga acuan (pasar ID & bekas JP),
 * penghapusan outlier 1.5×IQR, deteksi item langka, label kelayakan, dan peringkat kandidat
 * (PRD §5).
 *
 * Konvensi pembulatan IDR:
 * - Seluruh nilai rupiah dibulatkan ke bilangan bulat terdekat (`Math.round`).
 * - `HargaPO` dihitung dari nilai `Landed` sebelum pembulatan (`(P + O + K) × (1 + b) × kurs × (1 + m)`)
 *   lalu dibulatkan ke integer IDR agar menghindari galat pembulatan ganda.
 */
import { DEFAULT_PARAMS, type Params } from '../config/params.js';
import type { Edition, Label, ReferenceKind } from '../shared/types.js';

/** Menghitung ongkir per unit (O) dalam yen: shipping_jpy_per_kg × unit_weight_kg. */
export function shippingPerUnitJpy(params: Params = DEFAULT_PARAMS): number {
  return params.shipping_jpy_per_kg * params.unit_weight_kg;
}

/** Menentukan markup (m) berdasarkan edisi (PRD §5). */
export function markupForEdition(edition: Edition, params: Params = DEFAULT_PARAMS): number {
  if (edition === 'first') return params.markup_first;
  if (edition === 'premium' || edition === 'premium_unlimited') return params.markup_premium;
  return params.markup_default;
}

/** Landed = (P + O + K) × (1 + b) × kurs (dibulatkan ke integer IDR). */
export function calcLandedIdr(priceJpy: number, params: Params = DEFAULT_PARAMS): number {
  const o = shippingPerUnitJpy(params);
  const raw = (priceJpy + o + params.packaging_jpy) * (1 + params.import_tax_factor) * params.fx_idr_per_jpy;
  return Math.round(raw);
}

/** HargaPO = (P + O + K) × (1 + b) × kurs × (1 + m) (dibulatkan ke integer IDR). */
export function calcPoPriceIdr(
  priceJpy: number,
  edition: Edition,
  params: Params = DEFAULT_PARAMS,
): number {
  const o = shippingPerUnitJpy(params);
  const m = markupForEdition(edition, params);
  const raw =
    (priceJpy + o + params.packaging_jpy) *
    (1 + params.import_tax_factor) *
    params.fx_idr_per_jpy *
    (1 + m);
  return Math.round(raw);
}

/** AcuanLangka = (P_bekas + O + K) × (1 + b) × kurs (dibulatkan ke integer IDR). */
export function calcRareReferenceIdr(usedMedianJpy: number, params: Params = DEFAULT_PARAMS): number {
  return calcLandedIdr(usedMedianJpy, params);
}

/** Menghitung persentil linear (metode PERCENTILE.INC / NumPy linear) dari array terurut naik. */
function percentileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0]!;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const weight = idx - lo;
  return sorted[lo]! * (1 - weight) + sorted[hi]! * weight;
}

/** Menghitung median dari array angka non-kosong. */
export function median(values: number[]): number {
  if (values.length === 0) {
    throw new Error('Tidak dapat menghitung median dari array kosong');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Membuang outlier di luar rentang [Q1 - 1.5×IQR, Q3 + 1.5×IQR] (PRD §5).
 * Untuk jumlah data < 4, seluruh data dikembalikan apa adanya.
 */
export function removeOutliersIqr(values: number[]): {
  filtered: number[];
  removed: number[];
  q1: number | null;
  q3: number | null;
  iqr: number | null;
} {
  if (values.length < 4) {
    return { filtered: [...values], removed: [], q1: null, q3: null, iqr: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = percentileSorted(sorted, 0.25);
  const q3 = percentileSorted(sorted, 0.75);
  const iqr = q3 - q1;
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;

  const filtered: number[] = [];
  const removed: number[] = [];
  for (const v of sorted) {
    if (v >= lower && v <= upper) {
      filtered.push(v);
    } else {
      removed.push(v);
    }
  }
  return { filtered, removed, q1, q3, iqr };
}

/** Menentukan label kelayakan berdasarkan Rasio PO (PRD §5). */
export function classifyLabel(poRatio: number | null, params: Params = DEFAULT_PARAMS): Label {
  if (poRatio === null || !Number.isFinite(poRatio)) return 'REVIEW';
  if (poRatio >= params.threshold_layak) return 'LAYAK';
  if (poRatio >= params.threshold_batas) return 'BATAS';
  return 'TIDAK';
}

export interface PriceSampleInput {
  market: 'JP-shop' | 'JP-used' | 'ID-marketplace';
  platform: string | null;
  seller: string | null;
  price: number;
  currency: 'JPY' | 'IDR';
  is_sold: boolean;
  in_stock: boolean | null;
  observed_at: Date;
  url?: string | null;
}

export interface PureEvalInput {
  edition: Edition;
  officialPriceJpy: number | null;
  releaseDateJst: string | null;
  isRareFlag: boolean;
  prices: PriceSampleInput[];
  params?: Params;
  now?: Date;
}

export interface PureEvalOutput {
  isRare: boolean;
  rareReasons: string[];
  effectivePriceJpy: number | null;
  usedOnlyFallback: boolean;
  landed_idr: number | null;
  po_price_idr: number | null;
  reference_idr: number | null;
  reference_kind: ReferenceKind | null;
  data_count: number;
  po_ratio: number | null;
  label: Label;
  reason: string;
}

/**
 * Evaluasi kelayakan murni untuk satu item sesuai seluruh aturan PRD §5:
 * - Deteksi langka (median bekas ≥ 1.5× resmi; habis di ≥ 2 toko besar dlm 7 hari rilis; edisi terbatas/lotre).
 * - P efektif: harga beli JP-shop in-stock terendah; bila hanya tersedia bekas, P = median bekas.
 * - Harga acuan: item biasa = median penjual ID in-stock (≥ 3 setelah buang outlier 1.5×IQR);
 *   item langka = AcuanLangka dari median harga terjual bekas (≥ 2 platform, ≥ 5 transaksi, 30 hari).
 * - Item langka tanpa data bekas cukup => REVIEW.
 */
export function evaluateItemPure(input: PureEvalInput): PureEvalOutput {
  const params = input.params ?? DEFAULT_PARAMS;
  const now = input.now ?? new Date();

  // 1. Kumpulkan data JP-used terjual dalam window (default 30 hari).
  const usedWindowMs = params.used_window_days * 86_400_000;
  const recentUsedSold = input.prices.filter(
    (p) =>
      p.market === 'JP-used' &&
      p.currency === 'JPY' &&
      p.is_sold === true &&
      p.price > 0 &&
      now.getTime() - p.observed_at.getTime() <= usedWindowMs &&
      p.observed_at.getTime() <= now.getTime() + 60_000,
  );

  // Buang outlier 1.5×IQR pada harga terjual bekas dengan tetap melacak platform masing-masing.
  let qualifyingUsedPrices: number[] = [];
  let usedPlatformCount = 0;
  let usedMedianJpy: number | null = null;

  if (recentUsedSold.length > 0) {
    const { q1, q3, iqr } = removeOutliersIqr(recentUsedSold.map((p) => p.price));
    const lower = q1 !== null && iqr !== null ? q1 - 1.5 * iqr : -Infinity;
    const upper = q3 !== null && iqr !== null ? q3 + 1.5 * iqr : Infinity;
    const keptUsed = recentUsedSold.filter((p) => p.price >= lower && p.price <= upper);
    const platforms = new Set(keptUsed.map((p) => p.platform?.trim().toLowerCase()).filter(Boolean));
    usedPlatformCount = platforms.size;
    if (keptUsed.length >= params.min_used_transactions && usedPlatformCount >= params.min_used_platforms) {
      qualifyingUsedPrices = keptUsed.map((p) => p.price);
      usedMedianJpy = median(qualifyingUsedPrices);
    }
  }

  // 2. Deteksi kondisi langka (salah satu dari 3 syarat PRD §5).
  const rareReasons: string[] = [];

  if (
    usedMedianJpy !== null &&
    input.officialPriceJpy !== null &&
    input.officialPriceJpy > 0 &&
    usedMedianJpy >= params.rare_multiplier * input.officialPriceJpy
  ) {
    rareReasons.push(
      `median bekas ¥${Math.round(usedMedianJpy)} >= ${params.rare_multiplier}x resmi ¥${input.officialPriceJpy}`,
    );
  }

  // Syarat (2): habis di >= rare_soldout_min_shops (2) toko besar dalam 7 hari sejak rilis.
  if (input.releaseDateJst) {
    const releaseStartMs = Date.parse(`${input.releaseDateJst}T00:00:00+09:00`);
    const releaseEndMs = releaseStartMs + (params.rare_soldout_window_days + 1) * 86_400_000 - 1;
    const soldOutShops = new Set<string>();
    for (const p of input.prices) {
      if (p.market === 'JP-shop' && p.in_stock === false) {
        const obs = p.observed_at.getTime();
        if (obs >= releaseStartMs && obs <= releaseEndMs) {
          const shopKey = (p.seller ?? p.platform ?? p.url ?? 'unknown').trim().toLowerCase();
          soldOutShops.add(shopKey);
        }
      }
    }
    if (soldOutShops.size >= params.rare_soldout_min_shops) {
      rareReasons.push(
        `habis di ${soldOutShops.size} toko besar dalam ${params.rare_soldout_window_days} hari sejak rilis`,
      );
    }
  }

  // Syarat (3): flag is_rare atau edisi terbatas/lotre (exclusive / random).
  if (input.isRareFlag || input.edition === 'exclusive' || input.edition === 'random') {
    rareReasons.push(
      input.isRareFlag ? 'ditandai langka' : `edisi terbatas/lotre (${input.edition})`,
    );
  }

  const isRare = rareReasons.length > 0;

  // 3. Tentukan P efektif (harga beli terendah yang terkonfirmasi; fallback ke bekas bila hanya bekas tersedia).
  const jpShops = input.prices.filter((p) => p.market === 'JP-shop' && p.currency === 'JPY' && p.price > 0);
  const inStockJpShops = jpShops.filter((p) => p.in_stock === true);
  const allShopsSoldOut = jpShops.length > 0 && inStockJpShops.length === 0 && jpShops.every((p) => p.in_stock === false);

  let effectivePriceJpy: number | null = null;
  let usedOnlyFallback = false;

  if (inStockJpShops.length > 0) {
    effectivePriceJpy = Math.min(...inStockJpShops.map((p) => p.price));
  } else if (allShopsSoldOut && usedMedianJpy !== null) {
    effectivePriceJpy = Math.round(usedMedianJpy);
    usedOnlyFallback = true;
  } else if (input.officialPriceJpy !== null && input.officialPriceJpy > 0) {
    effectivePriceJpy = input.officialPriceJpy;
  } else if (usedMedianJpy !== null) {
    effectivePriceJpy = Math.round(usedMedianJpy);
    usedOnlyFallback = true;
  }

  if (effectivePriceJpy === null) {
    return {
      isRare,
      rareReasons,
      effectivePriceJpy: null,
      usedOnlyFallback: false,
      landed_idr: null,
      po_price_idr: null,
      reference_idr: null,
      reference_kind: null,
      data_count: 0,
      po_ratio: null,
      label: 'REVIEW',
      reason: 'Harga beli Jepang (P efektif) belum tersedia',
    };
  }

  const landed_idr = calcLandedIdr(effectivePriceJpy, params);
  const po_price_idr = calcPoPriceIdr(effectivePriceJpy, input.edition, params);

  // 4. Hitung harga acuan sesuai kategori langka vs biasa.
  if (isRare) {
    if (usedMedianJpy === null) {
      return {
        isRare: true,
        rareReasons,
        effectivePriceJpy,
        usedOnlyFallback,
        landed_idr,
        po_price_idr,
        reference_idr: null,
        reference_kind: 'JP-used',
        data_count: recentUsedSold.length,
        po_ratio: null,
        label: 'REVIEW',
        reason: `Item langka (${rareReasons.join('; ')}) tanpa data terjual bekas cukup (butuh >= ${params.min_used_transactions} transaksi dari >= ${params.min_used_platforms} platform dalam ${params.used_window_days} hari)`,
      };
    }

    const reference_idr = calcRareReferenceIdr(usedMedianJpy, params);
    const po_ratio = Number((reference_idr / po_price_idr).toFixed(4));
    const label = classifyLabel(po_ratio, params);
    const reasonParts = [
      `Item langka (${rareReasons.join('; ')})`,
      `acuan bekas ¥${Math.round(usedMedianJpy)} (${qualifyingUsedPrices.length} transaksi, ${usedPlatformCount} platform)`,
    ];
    if (usedOnlyFallback) {
      reasonParts.push('hanya tersedia bekas (P efektif = harga bekas)');
    }

    return {
      isRare: true,
      rareReasons,
      effectivePriceJpy,
      usedOnlyFallback,
      landed_idr,
      po_price_idr,
      reference_idr,
      reference_kind: 'JP-used',
      data_count: qualifyingUsedPrices.length,
      po_ratio,
      label,
      reason: reasonParts.join('; '),
    };
  }

  // Item biasa: median penjual Indonesia in-stock, deduplikasi terbaru per (platform, seller), buang outlier 1.5×IQR.
  const idInStock = input.prices
    .filter((p) => p.market === 'ID-marketplace' && p.currency === 'IDR' && p.in_stock === true && p.price > 0)
    .sort((a, b) => b.observed_at.getTime() - a.observed_at.getTime());

  const dedupedIdPrices: number[] = [];
  const seenSellers = new Set<string>();
  for (const p of idInStock) {
    if (p.seller) {
      const key = `${(p.platform ?? '').toLowerCase()}::${p.seller.trim().toLowerCase()}`;
      if (seenSellers.has(key)) continue;
      seenSellers.add(key);
    }
    dedupedIdPrices.push(p.price);
  }

  const { filtered: filteredId, removed: removedId } = removeOutliersIqr(dedupedIdPrices);
  if (filteredId.length < params.min_id_sellers) {
    return {
      isRare: false,
      rareReasons: [],
      effectivePriceJpy,
      usedOnlyFallback,
      landed_idr,
      po_price_idr,
      reference_idr: null,
      reference_kind: 'ID-market',
      data_count: filteredId.length,
      po_ratio: null,
      label: 'REVIEW',
      reason: `Data penjual Indonesia tidak cukup (${filteredId.length} < ${params.min_id_sellers} setelah buang ${removedId.length} outlier)`,
    };
  }

  const reference_idr = Math.round(median(filteredId));
  const po_ratio = Number((reference_idr / po_price_idr).toFixed(4));
  const label = classifyLabel(po_ratio, params);

  return {
    isRare: false,
    rareReasons: [],
    effectivePriceJpy,
    usedOnlyFallback,
    landed_idr,
    po_price_idr,
    reference_idr,
    reference_kind: 'ID-market',
    data_count: filteredId.length,
    po_ratio,
    label,
    reason: `Acuan pasar ID median ${filteredId.length} penjual (buang ${removedId.length} outlier)`,
  };
}

export interface RankableEvaluation {
  item_id: number;
  label: Label;
  po_ratio: number | null;
  release_date_jst?: string | null;
}

/**
 * Mengurutkan kandidat PO sesuai PRD §5:
 * - Hanya LAYAK dan BATAS; LAYAK selalu di atas BATAS.
 * - Di dalam label yang sama: rasio PO tertinggi dulu, lalu tanggal rilis terdekat (null di belakang).
 * - Maksimal `maxCandidates` (default `max_candidates_per_batch = 10`).
 */
export function rankCandidates<T extends RankableEvaluation>(
  evals: readonly T[],
  maxCandidates: number = DEFAULT_PARAMS.max_candidates_per_batch,
): T[] {
  const labelRank = (l: Label): number => (l === 'LAYAK' ? 0 : l === 'BATAS' ? 1 : 2);

  return evals
    .filter((e) => e.label === 'LAYAK' || e.label === 'BATAS')
    .slice()
    .sort((a, b) => {
      const lr = labelRank(a.label) - labelRank(b.label);
      if (lr !== 0) return lr;

      const ratioDiff = (b.po_ratio ?? -Infinity) - (a.po_ratio ?? -Infinity);
      if (ratioDiff !== 0) return ratioDiff;

      const da = a.release_date_jst ?? '9999-12-31';
      const db = b.release_date_jst ?? '9999-12-31';
      if (da !== db) return da < db ? -1 : 1;

      return a.item_id - b.item_id;
    })
    .slice(0, maxCandidates);
}
