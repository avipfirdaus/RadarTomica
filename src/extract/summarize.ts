/**
 * Fungsi ringkasan dan terjemahan P3 (Jepang/Inggris → Indonesia, 2–4 kalimat).
 * Menegakkan aturan "tanpa fakta baru" (PRD §7): menolak keluaran bila mengandung
 * angka yang tidak ada di teks sumber.
 */
import type { LlmClient } from '../shared/types.js';
import { P3_GLOSSARY_VERSION, P3_PROMPT_VERSION, buildP3Prompt } from './prompts/p3.js';

export class SummaryValidationError extends Error {
  readonly unexpectedNumbers: string[];
  readonly summary: string;

  constructor(message: string, unexpectedNumbers: string[], summary: string) {
    super(message);
    this.name = 'SummaryValidationError';
    this.unexpectedNumbers = unexpectedNumbers;
    this.summary = summary;
  }
}

export interface SummarizeDeps {
  llm: LlmClient;
}

export interface SummarizeResult {
  summary: string;
  sentenceCount: number;
  promptVersion: string;
  glossaryVersion: string;
}

const KANJI_ORDINALS: readonly [RegExp, string][] = [
  [/第一/g, '1'],
  [/第二/g, '2'],
  [/第三/g, '3'],
  [/第四/g, '4'],
  [/第五/g, '5'],
];

/**
 * Mengekstrak himpunan angka ternormalisasi dari teks (NFKC, menangani pemisah ribuan
 * seperti 1,100 maupun 1.100 serta angka nol di depan seperti 04 → 4).
 */
export function extractNormalizedNumbers(text: string): Set<string> {
  let normalized = text.normalize('NFKC');
  const numbers = new Set<string>();

  for (const [regex, digit] of KANJI_ORDINALS) {
    if (regex.test(normalized)) {
      numbers.add(digit);
    }
  }

  const matches = normalized.match(/\d+(?:[.,]\d+)*/g) ?? [];
  for (const raw of matches) {
    // Pola pemisah ribuan: mis. 1,100 / 1.100 / 12,345 / 1.234.567
    if (/^\d{1,3}(?:[.,]\d{3})+$/.test(raw)) {
      const stripped = raw.replace(/[.,]/g, '').replace(/^0+(?=\d)/, '');
      numbers.add(stripped);
      continue;
    }

    // Angka desimal atau bulat biasa (ganti koma desimal Indonesia dengan titik)
    const canonical = raw.replace(',', '.').replace(/^0+(?=\d)/, '');
    numbers.add(canonical);
  }

  return numbers;
}

/**
 * Memeriksa apakah setiap angka pada teks ringkasan muncul di teks sumber.
 */
export function validateSummaryNumbers(
  sourceText: string,
  summaryText: string,
): { ok: boolean; unexpectedNumbers: string[] } {
  const sourceNums = extractNormalizedNumbers(sourceText);
  const summaryNums = extractNormalizedNumbers(summaryText);
  const unexpectedNumbers: string[] = [];

  for (const n of summaryNums) {
    if (!sourceNums.has(n)) {
      unexpectedNumbers.push(n);
    }
  }

  return {
    ok: unexpectedNumbers.length === 0,
    unexpectedNumbers,
  };
}

/** Menghitung perkiraan jumlah kalimat bahasa Indonesia (mengabaikan singkatan umum seperti No.94 / Rp.). */
export function countSentences(text: string): number {
  const cleaned = text
    .trim()
    .replace(/\b(?:No|Rp|Jl|Dr|Mr|Ms)\.\s*/gi, '$1 ')
    .replace(/(\d)\.(\d)/g, '$1$2');
  if (!cleaned) return 0;
  const parts = cleaned
    .split(/[.!?。！？]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length;
}

/**
 * Meringkas dan menerjemahkan teks Jepang/Inggris menjadi 2–4 kalimat bahasa Indonesia (P3).
 * Menolak (lempar SummaryValidationError) bila keluaran mengandung angka yang tidak ada di sumber.
 */
export async function summarizeJaToId(
  deps: SummarizeDeps,
  text: string,
  opts?: { sourceUrl?: string },
): Promise<SummarizeResult> {
  const prompt = buildP3Prompt({ rawText: text, sourceUrl: opts?.sourceUrl });
  const res = await deps.llm.complete({
    task: 'P3',
    promptVersion: prompt.version,
    system: prompt.system,
    user: prompt.user,
    temperature: 0,
  });

  const summary = res.text.trim();
  const numCheck = validateSummaryNumbers(text, summary);
  if (!numCheck.ok) {
    throw new SummaryValidationError(
      `Ringkasan P3 mengandung angka yang tidak ada di teks sumber: ${numCheck.unexpectedNumbers.join(', ')}`,
      numCheck.unexpectedNumbers,
      summary,
    );
  }

  return {
    summary,
    sentenceCount: countSentences(summary),
    promptVersion: P3_PROMPT_VERSION,
    glossaryVersion: P3_GLOSSARY_VERSION,
  };
}
