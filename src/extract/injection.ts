/**
 * Detektor heuristik prompt injection tingkat kode (PRD §7 aturan #1 & §9).
 * Memeriksa pola bahasa Inggris, Jepang, Indonesia, dan upaya pelarian pembatas data.
 */
import { SOURCE_BEGIN_DELIMITER, SOURCE_END_DELIMITER } from './prompts/p1.js';

export interface InjectionDetectionResult {
  suspected: boolean;
  matches: string[];
}

const INJECTION_PATTERNS: readonly { label: string; regex: RegExp }[] = [
  // Bahasa Inggris
  { label: 'en:ignore_instructions', regex: /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+instructions?\b/i },
  { label: 'en:system_prompt', regex: /\bsystem\s+prompt\b/i },
  { label: 'en:you_are_ai', regex: /\byou\s+are\s+(?:now\s+)?(?:an?\s+)?(?:ai|assistant|chatgpt|claude|language\s+model|dan)\b/i },
  { label: 'en:new_instructions', regex: /\bnew\s+instructions?\s*:/i },
  { label: 'en:override_rules', regex: /\boverride\s+(?:the\s+)?(?:system|instructions?|rules?|schema|prompt)\b/i },
  { label: 'en:jailbreak', regex: /\b(?:jailbreak|developer\s+mode|do\s+anything\s+now)\b/i },
  { label: 'en:role_hijack', regex: /\b(?:pretend\s+you\s+are|act\s+as\s+(?:a|an)\s+(?:system|admin|developer|unrestricted))\b/i },
  { label: 'en:output_hijack', regex: /\b(?:output\s+only|return\s+only|respond\s+with)\s+(?:the\s+following\s+)?json\b/i },

  // Bahasa Jepang
  { label: 'ja:ignore_instructions', regex: /(?:以前|前|これまで|上記)の(?:指示|命令|ルール|制約)を無視/ },
  { label: 'ja:ignore_instructions_short', regex: /指示を無視して/ },
  { label: 'ja:system_prompt', regex: /システムプロンプト/ },
  { label: 'ja:you_are_ai', regex: /あなたは(?:AI|エーアイ|アシスタント|言語モデル|Claude)/i },
  { label: 'ja:change_role', regex: /(?:あなたの)?役割を変更/ },
  { label: 'ja:new_instructions', regex: /新しい(?:指示|命令)\s*[:：]/ },
  { label: 'ja:reveal_prompt', regex: /プロンプトを(?:表示|出力|教え)/ },

  // Bahasa Indonesia
  { label: 'id:ignore_instructions', regex: /\babaikan\s+(?:semua\s+)?instruksi\s+sebelumnya\b/i },
  { label: 'id:system_prompt', regex: /\bprompt\s+sistem\b/i },

  // Upaya pelarian pembatas / tag peran
  { label: 'delimiter:xml_role', regex: /<\/?(?:system|assistant|instruction|developer)\s*>/i },
];

/**
 * Memindai teks sumber mentah untuk mendeteksi indikasi prompt injection.
 * Teks sumber dinormalisasi NFKC terlebih dahulu agar karakter full-width tetap terdeteksi.
 */
export function detectPromptInjection(rawText: string): InjectionDetectionResult {
  const normalized = rawText.normalize('NFKC');
  const matches: string[] = [];

  if (normalized.includes(SOURCE_BEGIN_DELIMITER) || normalized.includes(SOURCE_END_DELIMITER)) {
    matches.push('delimiter:source_boundary_escape');
  }

  for (const { label, regex } of INJECTION_PATTERNS) {
    if (regex.test(normalized)) {
      matches.push(label);
    }
  }

  return {
    suspected: matches.length > 0,
    matches,
  };
}
