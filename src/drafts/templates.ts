/**
 * Template draf postingan Telegram berbahasa Indonesia (PRD §4 F9, §7 aturan 5, §9).
 *
 * Aturan wajib:
 * - Seluruh angka (harga, DP, tanggal, rasio) diisi OLEH KODE dari data terstruktur.
 * - `po_open` wajib memuat harga PO, DP, tenggat, dan cara pesan (hanya nama brand, tanpa nama pribadi).
 * - Setiap klaim faktual mencantumkan URL sumber.
 * - Mencantumkan disclaimer bahwa channel tidak resmi dan tidak berafiliasi dengan Takara Tomy.
 * - Tanpa klaim hype ("dijamin langka", "pasti naik harga", dsb.).
 */
import type { DraftKind, Edition } from '../shared/types.js';
import { formatIdr, formatJpy } from '../telegram/format.js';

export const DEFAULT_BRAND_NAME = 'Radar Tomica Jepang';

export const UNOFFICIAL_DISCLAIMER =
  'Catatan: Channel ini tidak resmi dan tidak berafiliasi dengan Takara Tomy. Tomica adalah merek dagang milik Takara Tomy.';

/** Pola frasa hype yang dilarang (PRD §7 aturan 5). */
export const FORBIDDEN_HYPE_PATTERNS: readonly RegExp[] = [
  /dijamin\s+langka/i,
  /pasti\s+naik\s+harga/i,
  /pasti\s+cuan/i,
  /pasti\s+untung/i,
  /dijamin\s+naik/i,
  /investasi\s+pasti/i,
  /wajib\s+beli\s+sebelum\s+kehabisan/i,
];

export function containsForbiddenHype(text: string): boolean {
  return FORBIDDEN_HYPE_PATTERNS.some((re) => re.test(text));
}

export interface DraftSourceClaim {
  claim: string;
  url: string;
}

export interface DraftItemData {
  itemId?: number;
  tomicaNo?: number | null;
  nameJa: string;
  nameId?: string | null;
  edition: Edition;
  releaseDateJst?: string | null;
  priceJpy?: number | null;
  poPriceIdr?: number | null;
  referenceIdr?: number | null;
  poRatio?: number | null;
  sourceUrl?: string | null;
}

export interface PoTerms {
  /** Persentase DP, mis. 50 untuk 50%. */
  dpPercent: number;
  /** Nominal DP opsional per unit (bila kosong, dihitung otomatis dari poPriceIdr * dpPercent / 100). */
  dpAmountIdr?: number | null;
  /** Tenggat PO (tampilkan JST & WIB). */
  deadline: string;
  /** Cara pesan menggunakan akun/formulir brand, BUKAN nama atau nomor pribadi. */
  contactMethod: string;
  /** Catatan pajak opsional (mis. sesuai aturan batch). */
  taxNote?: string;
}

export interface DraftTemplateData {
  brandName?: string;
  /** Label bulan untuk `monthly_release`, mis. "Desember 2026". */
  monthLabel?: string;
  /** Jumlah hari menuju rilis untuk `reminder` (mis. 7, 3, 1). */
  daysBeforeRelease?: number;
  /** Tanggal rilis utama (YYYY-MM-DD JST). */
  releaseDateJst?: string;
  items: DraftItemData[];
  poTerms?: PoTerms;
  sources: DraftSourceClaim[];
}

const EDITION_LABEL: Record<Edition, string> = {
  regular: 'Regular',
  first: 'First Edition (初回特別仕様)',
  premium: 'Tomica Premium',
  premium_unlimited: 'Tomica Premium Unlimited',
  collab: 'Kolaborasi',
  exclusive: 'Eksklusif Toko',
  set: 'Set',
  random: 'Paket Acak',
  unknown: 'Lainnya',
};

function formatItemName(item: DraftItemData): string {
  const no = item.tomicaNo != null ? `No.${item.tomicaNo} ` : '';
  const idPart = item.nameId ? ` / ${item.nameId}` : '';
  return `${no}${item.nameJa}${idPart}`;
}

function collectSources(data: DraftTemplateData): DraftSourceClaim[] {
  const seen = new Set<string>();
  const out: DraftSourceClaim[] = [];
  for (const s of data.sources) {
    const key = `${s.claim}|${s.url}`;
    if (!seen.has(key) && s.url.trim()) {
      seen.add(key);
      out.push({ claim: s.claim, url: s.url.trim() });
    }
  }
  for (const item of data.items) {
    if (item.sourceUrl && item.sourceUrl.trim()) {
      const url = item.sourceUrl.trim();
      const claim = formatItemName(item);
      if (!out.some((s) => s.url === url)) {
        out.push({ claim, url });
      }
    }
  }
  return out;
}

function renderSourcesBlock(sources: DraftSourceClaim[]): string[] {
  if (sources.length === 0) return [];
  const lines = ['', 'Sumber:'];
  for (const s of sources) {
    lines.push(`- ${s.claim}: ${s.url}`);
  }
  return lines;
}

/** Merender teks draf bahasa Indonesia murni dari data terstruktur (tanpa LLM). */
export function renderDraftTemplate(kind: DraftKind, data: DraftTemplateData): { text: string; sources: DraftSourceClaim[] } {
  const brand = data.brandName ?? DEFAULT_BRAND_NAME;
  const sources = collectSources(data);
  const lines: string[] = [];

  switch (kind) {
    case 'monthly_release': {
      const heading = data.monthLabel
        ? `[${brand}] Info Rilis Tomica — ${data.monthLabel}`
        : `[${brand}] Info Rilis Tomica Bulanan`;
      lines.push(heading);
      if (data.releaseDateJst) {
        lines.push(`Jadwal rilis Jepang: ${data.releaseDateJst} (JST)`);
      }
      lines.push('', 'Daftar model:');
      for (const item of data.items) {
        const pricePart = item.priceJpy != null ? ` — Harga resmi JP ${formatJpy(item.priceJpy)}` : '';
        const datePart = item.releaseDateJst ? ` (rilis ${item.releaseDateJst} JST)` : '';
        lines.push(`- ${formatItemName(item)} [${EDITION_LABEL[item.edition]}]${pricePart}${datePart}`);
      }
      break;
    }

    case 'po_open': {
      if (!data.poTerms) {
        throw new Error('Draft kind "po_open" wajib menyertakan poTerms (DP, deadline, contactMethod).');
      }
      const { dpPercent, dpAmountIdr, deadline, contactMethod, taxNote } = data.poTerms;
      lines.push(`[${brand}] PO Dibuka`);
      if (data.releaseDateJst) {
        lines.push(`Perkiraan rilis Jepang: ${data.releaseDateJst} (JST)`);
      }
      lines.push('', 'Daftar item & harga PO:');
      for (const item of data.items) {
        if (item.poPriceIdr == null) {
          throw new Error(`Item "${item.nameJa}" pada draf po_open wajib memiliki poPriceIdr.`);
        }
        const computedDp = dpAmountIdr ?? Math.round((item.poPriceIdr * dpPercent) / 100);
        const refPart = item.referenceIdr != null ? ` | Acuan pasar: ${formatIdr(item.referenceIdr)}` : '';
        const jpPart = item.priceJpy != null ? ` (JP ${formatJpy(item.priceJpy)})` : '';
        lines.push(
          `- ${formatItemName(item)} [${EDITION_LABEL[item.edition]}]${jpPart}\n  Harga PO: ${formatIdr(item.poPriceIdr)} | DP ${dpPercent}%: ${formatIdr(computedDp)}${refPart}`,
        );
      }
      lines.push(
        '',
        `Ketentuan DP: ${dpPercent}% di muka untuk kunci slot.`,
        `Tenggat PO: ${deadline}`,
        `Cara pesan: ${contactMethod}`,
      );
      if (taxNote) {
        lines.push(`Catatan pajak: ${taxNote}`);
      }
      break;
    }

    case 'reminder': {
      const hMinus = data.daysBeforeRelease != null ? `H-${data.daysBeforeRelease} ` : '';
      lines.push(`[${brand}] Pengingat Rilis ${hMinus}Tomica`);
      if (data.releaseDateJst) {
        lines.push(`Tanggal rilis Jepang: ${data.releaseDateJst} (JST)`);
      }
      lines.push('', 'Model yang akan dirilis:');
      for (const item of data.items) {
        const pricePart =
          item.poPriceIdr != null
            ? ` — Harga PO ${formatIdr(item.poPriceIdr)}`
            : item.priceJpy != null
              ? ` — Harga JP ${formatJpy(item.priceJpy)}`
              : '';
        lines.push(`- ${formatItemName(item)} [${EDITION_LABEL[item.edition]}]${pricePart}`);
      }
      if (data.poTerms) {
        lines.push('', `Tenggat PO: ${data.poTerms.deadline}`, `Cara pesan: ${data.poTerms.contactMethod}`);
      }
      break;
    }

    case 'po_close': {
      lines.push(`[${brand}] PO Ditutup`);
      lines.push('', 'Daftar item pada batch ini:');
      for (const item of data.items) {
        const pricePart = item.poPriceIdr != null ? ` — ${formatIdr(item.poPriceIdr)}` : '';
        lines.push(`- ${formatItemName(item)} [${EDITION_LABEL[item.edition]}]${pricePart}`);
      }
      if (data.poTerms?.deadline) {
        lines.push('', `Batas akhir tercatat: ${data.poTerms.deadline}`);
      }
      lines.push(`Terima kasih atas partisipasinya bersama ${brand}. Pembaruan pengiriman akan diinformasikan di channel ini.`);
      break;
    }
  }

  lines.push(...renderSourcesBlock(sources));
  lines.push('', UNOFFICIAL_DISCLAIMER);

  const text = lines.join('\n');
  if (containsForbiddenHype(text)) {
    throw new Error('Draf mengandung frasa hype terlarang (PRD §7 aturan 5).');
  }
  return { text, sources };
}
