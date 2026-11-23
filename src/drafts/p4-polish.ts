/**
 * Pemolesan bahasa draf menggunakan LLM tugas P4 (PRD §7 P4, aturan 5–6).
 *
 * LLM HANYA boleh merapikan kalimat bahasa Indonesia.
 * Kode memverifikasi bahwa:
 * 1. Setiap angka dalam keluaran LLM benar-benar ada di nilai data/template asal.
 * 2. Tidak ada klaim hype terlarang ("dijamin langka", "pasti naik harga", dsb.).
 * 3. Semua URL sumber dan disclaimer tidak resmi tetap dipertahankan.
 * Jika salah satu gagal atau panggilan LLM galat, otomatis kembali ke template murni.
 */
import { logger } from '../shared/logger.js';
import type { LlmClient } from '../shared/types.js';
import {
  containsForbiddenHype,
  type DraftSourceClaim,
  type DraftTemplateData,
} from './templates.js';

export const P4_PROMPT_VERSION = 'P4@1';
export const TEMPLATE_PROMPT_VERSION = 'template@1';

const P4_SYSTEM_PROMPT = [
  'PERAN: Kamu editor teks postingan channel Telegram "Radar Tomica Jepang".',
  'TUGAS: Rapikan kalimat bahasa Indonesia pada draf agar ramah, ringkas, dan mudah dibaca kolektor.',
  'ATURAN WAJIB:',
  '1. JANGAN mengubah, menghitung ulang, atau menambahkan angka apa pun (harga, DP, persen, tanggal, nomor model).',
  '2. JANGAN menghapus URL sumber mana pun.',
  '3. JANGAN menghapus disclaimer bahwa channel ini tidak resmi dan tidak berafiliasi dengan Takara Tomy.',
  '4. JANGAN menambahkan klaim spekulatif atau hype seperti "dijamin langka" atau "pasti naik harga".',
  '5. Gunakan hanya nama brand; jangan cantumkan nama pribadi.',
  '6. Keluarkan HANYA teks postingan final tanpa pengantar atau komentar tambahan.',
].join('\n');

const URL_REGEX = /https?:\/\/\S+/gi;

/** Normalisasi token angka agar "157.000" == "157000" dan "1,45" == "1.45". */
function normalizeNumericToken(token: string): string {
  // Pola pemisah ribuan Indonesia/Eropa: mis. 157.000 atau 1.250.000
  if (/^\d{1,3}(?:\.\d{3})+$/.test(token)) {
    return token.replaceAll('.', '');
  }
  // Pola desimal koma: mis. 1,45 atau 27,4
  if (/^\d+,\d+$/.test(token)) {
    return token.replace(',', '.');
  }
  return token;
}

/** Ekstrak himpunan angka ternormalisasi dari teks (mengabaikan angka di dalam URL). */
export function extractNormalizedNumbers(text: string): string[] {
  const withoutUrls = text.replace(URL_REGEX, ' ');
  const matches = withoutUrls.match(/\d+(?:[.,]\d+)*/g) ?? [];
  return matches.map(normalizeNumericToken);
}

/** Kumpulkan semua angka yang sah dari template dan data masukan. */
export function collectAllowedNumbers(templateText: string, data: DraftTemplateData): Set<string> {
  const allowed = new Set<string>(extractNormalizedNumbers(templateText));

  const addNum = (n: number | null | undefined): void => {
    if (n == null || !Number.isFinite(n)) return;
    allowed.add(String(n));
    allowed.add(String(Math.round(n)));
  };

  addNum(data.daysBeforeRelease);
  if (data.poTerms) {
    addNum(data.poTerms.dpPercent);
    addNum(data.poTerms.dpAmountIdr);
  }
  for (const item of data.items) {
    addNum(item.tomicaNo);
    addNum(item.priceJpy);
    addNum(item.poPriceIdr);
    addNum(item.referenceIdr);
    addNum(item.poRatio);
  }
  return allowed;
}

export interface P4PolishResult {
  text: string;
  promptVersion: string;
  usedFallback: boolean;
  fallbackReason?: string;
}

/** Validasi keluaran P4 terhadap template & data asal. */
export function validateP4Output(
  candidateText: string,
  templateText: string,
  data: DraftTemplateData,
  sources: DraftSourceClaim[],
): { ok: true } | { ok: false; reason: string } {
  const trimmed = candidateText.trim();
  if (!trimmed) {
    return { ok: false, reason: 'Keluaran P4 kosong' };
  }
  if (containsForbiddenHype(trimmed)) {
    return { ok: false, reason: 'Keluaran P4 mengandung frasa hype terlarang' };
  }

  // Periksa bahwa disclaimer tidak resmi masih ada
  const lower = trimmed.toLowerCase();
  if (!lower.includes('tidak resmi') || !lower.includes('takara tomy')) {
    return { ok: false, reason: 'Keluaran P4 menghilangkan disclaimer tidak resmi Takara Tomy' };
  }

  // Periksa bahwa setiap URL sumber masih tercantum
  for (const src of sources) {
    if (!trimmed.includes(src.url)) {
      return { ok: false, reason: `Keluaran P4 menghilangkan URL sumber: ${src.url}` };
    }
  }

  // Periksa bahwa setiap angka pada keluaran LLM berasal dari data/template
  const allowedNumbers = collectAllowedNumbers(templateText, data);
  const candidateNumbers = extractNormalizedNumbers(trimmed);
  for (const num of candidateNumbers) {
    if (!allowedNumbers.has(num)) {
      return { ok: false, reason: `Keluaran P4 mengandung angka tidak ada di data: ${num}` };
    }
  }

  return { ok: true };
}

export async function polishDraftWithP4(
  llm: LlmClient,
  templateText: string,
  data: DraftTemplateData,
  sources: DraftSourceClaim[],
): Promise<P4PolishResult> {
  try {
    const res = await llm.complete({
      task: 'P4',
      promptVersion: P4_PROMPT_VERSION,
      system: P4_SYSTEM_PROMPT,
      user: `DRAF TEMPLATE:\n${templateText}`,
      temperature: 0.2,
      maxTokens: 1200,
    });
    const candidate = res.text.trim();
    const check = validateP4Output(candidate, templateText, data, sources);
    if (!check.ok) {
      logger.warn({ reason: check.reason, promptVersion: P4_PROMPT_VERSION }, 'P4 fallback ke template murni');
      return {
        text: templateText,
        promptVersion: TEMPLATE_PROMPT_VERSION,
        usedFallback: true,
        fallbackReason: check.reason,
      };
    }
    return {
      text: candidate,
      promptVersion: P4_PROMPT_VERSION,
      usedFallback: false,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ err: reason, promptVersion: P4_PROMPT_VERSION }, 'Panggilan LLM P4 gagal, fallback ke template murni');
    return {
      text: templateText,
      promptVersion: TEMPLATE_PROMPT_VERSION,
      usedFallback: true,
      fallbackReason: `LLM error: ${reason}`,
    };
  }
}
