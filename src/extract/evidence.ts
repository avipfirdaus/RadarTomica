/**
 * Verifikasi bukti kutipan di kode (PRD §4 F2 & §7 aturan #3):
 * - Setiap kutipan bukti harus benar-benar muncul di raw_text snapshot (normalisasi NFKC + whitespace).
 * - Panjang kutipan harus < 15 kata.
 * - Field penting (price_jpy_tax_incl, release_date_jst, edition, tomica_no) tanpa kutipan terverifikasi
 *   diisi null (edition -> 'unknown') dan tingkat keyakinan (confidence) diturunkan.
 */
import type { Confidence, Evidence, ExtractedItem } from '../shared/types.js';

export const IMPORTANT_EVIDENCE_FIELDS = [
  'price_jpy_tax_incl',
  'release_date_jst',
  'edition',
  'tomica_no',
] as const;

export type ImportantEvidenceField = (typeof IMPORTANT_EVIDENCE_FIELDS)[number];

export const MAX_EVIDENCE_WORDS = 15; // ketat: harus < 15 kata

export interface VerifiedExtractedItem extends ExtractedItem {
  verifiedEvidence: Evidence[];
  unverifiedFields: ImportantEvidenceField[];
  promptVersion: string;
}

/** Normalisasi NFKC + rapikan spasi + huruf kecil untuk pencocokan kutipan bukti. */
export function normalizeForMatch(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Hitung jumlah kata (dipisahkan whitespace setelah NFKC). */
export function countWords(text: string): number {
  const normalized = text.normalize('NFKC').trim();
  if (!normalized) return 0;
  return normalized.split(/\s+/).length;
}

/** Memeriksa apakah satu kutipan bukti sah: non-kosong, < 15 kata, dan muncul di teks sumber. */
export function isEvidenceQuoteValid(quote: string, rawText: string): boolean {
  const words = countWords(quote);
  if (words === 0 || words >= MAX_EVIDENCE_WORDS) return false;
  const normQuote = normalizeForMatch(quote);
  if (!normQuote) return false;
  const normSource = normalizeForMatch(rawText);
  return normSource.includes(normQuote);
}

export function lowerConfidence(c: Confidence, steps = 1): Confidence {
  const order: Confidence[] = ['low', 'medium', 'high'];
  const idx = order.indexOf(c);
  const next = Math.max(0, idx - Math.max(1, steps));
  return order[next] ?? 'low';
}

/**
 * Memverifikasi seluruh bukti pada satu item hasil P1 terhadap raw_text snapshot.
 * Field penting yang tidak memiliki bukti terverifikasi dinulkan (edition -> 'unknown')
 * dan confidence diturunkan.
 */
export function verifyItemEvidence(
  item: ExtractedItem,
  rawText: string,
  promptVersion: string,
): VerifiedExtractedItem {
  const verifiedEvidence = item.evidence.filter((ev) => isEvidenceQuoteValid(ev.quote_ja, rawText));
  const verifiedFields = new Set(verifiedEvidence.map((ev) => ev.field));

  let price_jpy_tax_incl = item.price_jpy_tax_incl;
  let release_date_jst = item.release_date_jst;
  let edition = item.edition;
  let tomica_no = item.tomica_no;
  const unverifiedFields: ImportantEvidenceField[] = [];

  if (price_jpy_tax_incl !== null && !verifiedFields.has('price_jpy_tax_incl')) {
    price_jpy_tax_incl = null;
    unverifiedFields.push('price_jpy_tax_incl');
  }
  if (release_date_jst !== null && !verifiedFields.has('release_date_jst')) {
    release_date_jst = null;
    unverifiedFields.push('release_date_jst');
  }
  if (edition !== 'unknown' && !verifiedFields.has('edition')) {
    edition = 'unknown';
    unverifiedFields.push('edition');
  }
  if (tomica_no !== null && !verifiedFields.has('tomica_no')) {
    tomica_no = null;
    unverifiedFields.push('tomica_no');
  }

  const confidence =
    unverifiedFields.length > 0 ? lowerConfidence(item.confidence, unverifiedFields.length) : item.confidence;

  return {
    ...item,
    tomica_no,
    edition,
    release_date_jst,
    price_jpy_tax_incl,
    evidence: verifiedEvidence,
    confidence,
    verifiedEvidence,
    unverifiedFields,
    promptVersion,
  };
}
