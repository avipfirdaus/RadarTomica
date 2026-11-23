/**
 * Parser JSON ketat untuk keluaran LLM: hanya menerima JSON valid,
 * namun toleran terhadap pembungkus markdown code fence (```json ... ```).
 */

export class LlmJsonParseError extends Error {
  readonly rawText: string;

  constructor(message: string, rawText: string) {
    super(message);
    this.name = 'LlmJsonParseError';
    this.rawText = rawText;
  }
}

/** Menghapus code fence pembuka/penutup jika seluruh teks dibungkus olehnya. */
export function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const match = /^```(?:json|JSON)?\s*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  if (match && match[1] !== undefined) {
    return match[1].trim();
  }
  return trimmed;
}

/**
 * Mengurai keluaran LLM sebagai JSON murni.
 * Menolak teks tambahan di luar JSON (di luar code fence).
 */
export function parseJsonFromLlm(raw: string): unknown {
  const cleaned = stripCodeFences(raw);
  if (!cleaned) {
    throw new LlmJsonParseError('Keluaran LLM kosong', raw);
  }
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LlmJsonParseError(`Keluaran LLM bukan JSON valid: ${msg}`, raw);
  }
}
