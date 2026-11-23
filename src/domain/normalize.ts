/**
 * F3: Normalisasi nama model, nomor Tomica, tanggal rilis (JST), harga (JPY termasuk pajak),
 * dan pembuatan canonical_key untuk deduplikasi item (PRD §4 F3, §6).
 */
import { DateTime } from 'luxon';
import { JST } from '../shared/time.js';
import type { Edition, ExtractedItem } from '../shared/types.js';

/** Tarif pajak konsumsi Jepang (10%) untuk konversi harga 税抜 -> 税込. */
export const JP_CONSUMPTION_TAX_RATE = 0.1;

const LEADING_BRAND_PREFIXES: RegExp[] = [
  /^(?:トミカプレミアム\s*unlimited|tomica\s+premium\s+unlimited)(?=\s|$|No\.?|№)/i,
  /^(?:トミカプレミアム|tomica\s+premium)(?=\s|$|No\.?|№)/i,
  /^(?:トミカ|tomica)(?=\s|No\.?|№)/i,
];

const LEADING_NO_PREFIX = /^(?:No\.?|№|#)\s*\d+\s*/i;

/**
 * Menormalisasi nama model bahasa Jepang:
 * 1. NFKC (menyamakan full-width/half-width ASCII, katakana, angka, spasi).
 * 2. Merapikan spasi berlebih.
 * 3. Menghapus prefiks umum di awal ('トミカ', 'トミカプレミアム', 'No.94', dll.) agar
 *    item yang sama dari sumber berbeda menghasilkan nama kanonik yang sama.
 */
export function normalizeNameJa(raw: string): string {
  const nfkc = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!nfkc) return '';

  let cleaned = nfkc;
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of LEADING_BRAND_PREFIXES) {
      const next = cleaned.replace(re, '').trim();
      if (next !== cleaned && next.length > 0) {
        cleaned = next;
        changed = true;
      }
    }
    const afterNo = cleaned.replace(LEADING_NO_PREFIX, '').trim();
    if (afterNo !== cleaned && afterNo.length > 0) {
      cleaned = afterNo;
      changed = true;
    }
  }

  return cleaned.replace(/\s+/g, ' ').trim();
}

/**
 * Menormalisasi nomor Tomica menjadi bilangan bulat positif (atau null bila kosong/tidak valid).
 * Mendukung angka maupun string seperti "No.94", "Ｎｏ．０９４", "94".
 */
export function normalizeTomicaNo(raw: number | string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0 || !Number.isInteger(raw)) return null;
    return raw;
  }
  const nfkc = raw.normalize('NFKC').trim();
  if (!nfkc) return null;
  const match = nfkc.match(/(?:No\.?|№|#)?\s*(\d+)/i);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Menormalisasi tanggal rilis menjadi tanggal ISO JST 'YYYY-MM-DD' tanpa jam.
 * Mendukung ISO date, ISO datetime (dikonversi ke zona Asia/Tokyo), YYYY/MM/DD, YYYY.MM.DD,
 * serta format Jepang "2026年4月18日".
 */
export function normalizeReleaseDateJst(raw: string | Date | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    return DateTime.fromJSDate(raw).setZone(JST).toISODate();
  }

  const s = raw.normalize('NFKC').trim();
  if (!s) return null;

  // Format ISO date persis: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const dt = DateTime.fromISO(s, { zone: JST });
    return dt.isValid ? dt.toISODate() : null;
  }

  // Format Jepang: 2026年4月18日
  const jpMatch = s.match(/^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日$/);
  if (jpMatch) {
    const dt = DateTime.fromObject(
      {
        year: Number(jpMatch[1]),
        month: Number(jpMatch[2]),
        day: Number(jpMatch[3]),
      },
      { zone: JST },
    );
    return dt.isValid ? dt.toISODate() : null;
  }

  // Format slash / titik: 2026/4/18 atau 2026.04.18
  const sepMatch = s.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);
  if (sepMatch) {
    const dt = DateTime.fromObject(
      {
        year: Number(sepMatch[1]),
        month: Number(sepMatch[2]),
        day: Number(sepMatch[3]),
      },
      { zone: JST },
    );
    return dt.isValid ? dt.toISODate() : null;
  }

  // ISO datetime dengan zona waktu (mis. 2026-04-17T15:00:00Z -> 2026-04-18 JST)
  const isoDt = DateTime.fromISO(s, { setZone: true });
  if (isoDt.isValid) {
    return isoDt.setZone(JST).toISODate();
  }

  return null;
}

const TAX_EXCLUDED_RE = /税抜|税別|\+\s*税|tax[\s-]*excl|excl\.?\s*tax|before\s+tax/i;
const TAX_INCLUDED_RE = /税込|tax[\s-]*incl|incl\.?\s*tax/i;

/**
 * Menormalisasi harga menjadi bilangan bulat yen termasuk pajak (tax-included).
 *
 * Aturan pembulatan:
 * - Bila sumber menandakan harga belum termasuk pajak (税抜 / 税別 / +税 / tax-excl) atau
 *   `opts.taxExcluded === true`, dikalikan `(1 + 0.10)` (pajak konsumsi Jepang 10%) lalu
 *   dibulatkan ke yen terdekat dengan `Math.round`.
 * - Harga sudah termasuk pajak dibulatkan ke yen terdekat dengan `Math.round`.
 */
export function normalizePriceJpy(
  raw: number | string | null | undefined,
  opts?: { taxExcluded?: boolean },
): number | null {
  if (raw === null || raw === undefined) return null;

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const adjusted = opts?.taxExcluded ? raw * (1 + JP_CONSUMPTION_TAX_RATE) : raw;
    return Math.round(adjusted);
  }

  const nfkc = raw.normalize('NFKC').trim();
  if (!nfkc) return null;

  const textIndicatesTaxExcluded = TAX_EXCLUDED_RE.test(nfkc) && !TAX_INCLUDED_RE.test(nfkc);
  const taxExcluded = opts?.taxExcluded ?? textIndicatesTaxExcluded;

  const numMatch = nfkc.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  if (!numMatch?.[1]) return null;

  const parsed = Number.parseFloat(numMatch[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;

  const adjusted = taxExcluded ? parsed * (1 + JP_CONSUMPTION_TAX_RATE) : parsed;
  return Math.round(adjusted);
}

/**
 * Membuat slug deterministik dari nama model (mempertahankan aksara Jepang & alfanumerik).
 */
export function slugifyName(nameJa: string): string {
  const normalized = normalizeNameJa(nameJa).toLowerCase();
  return normalized
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Membuat kunci kanonik sesuai PRD §6:
 * `slug(normalised name_ja) + edition + release_date` (tomica_no boleh null untuk kolaborasi).
 */
export function buildCanonicalKey(
  nameJa: string,
  edition: Edition,
  releaseDateJst: string | null,
): string {
  const slug = slugifyName(nameJa);
  const datePart = releaseDateJst ?? 'tbd';
  return `${slug}:${edition}:${datePart}`;
}

export interface NormalizedItemData {
  canonical_key: string;
  tomica_no: number | null;
  name_ja: string;
  name_id: string | null;
  edition: Edition;
  release_date_jst: string | null;
  price_jpy: number | null;
  replaces: string | null;
  needs_review: boolean;
}

/**
 * Menormalisasi seluruh field dari satu ExtractedItem.
 * Mengembalikan null bila `name_ja` kosong setelah normalisasi (harus masuk review_queue).
 */
export function normalizeExtractedItem(item: ExtractedItem): NormalizedItemData | null {
  if (!item.name_ja) return null;
  const nameJa = normalizeNameJa(item.name_ja);
  if (!nameJa) return null;

  const tomicaNo = normalizeTomicaNo(item.tomica_no);
  const releaseDateJst = normalizeReleaseDateJst(item.release_date_jst);

  // Periksa apakah kutipan bukti harga menyebutkan harga belum termasuk pajak (税抜).
  const priceQuote = item.evidence.find(
    (e) => e.field === 'price_jpy_tax_incl' || e.field === 'price_jpy',
  )?.quote_ja;
  const quoteTaxExcluded =
    priceQuote !== undefined && TAX_EXCLUDED_RE.test(priceQuote.normalize('NFKC')) && !TAX_INCLUDED_RE.test(priceQuote.normalize('NFKC'));

  const priceJpy = normalizePriceJpy(item.price_jpy_tax_incl, { taxExcluded: quoteTaxExcluded });
  const nameId = item.name_id ? item.name_id.normalize('NFKC').replace(/\s+/g, ' ').trim() || null : null;
  const replaces = item.replaces ? normalizeNameJa(item.replaces) || null : null;

  return {
    canonical_key: buildCanonicalKey(nameJa, item.edition, releaseDateJst),
    tomica_no: tomicaNo,
    name_ja: nameJa,
    name_id: nameId,
    edition: item.edition,
    release_date_jst: releaseDateJst,
    price_jpy: priceJpy,
    replaces,
    needs_review: item.needs_review,
  };
}
