/**
 * Klasifikasi F5: jalankan aturan deterministik lebih dulu; hanya panggil P2 (LLM)
 * saat aturan ambigu. Hasil akhir yang tetap ragu => needsReview = true (label REVIEW).
 */
import type { Edition, LlmClient } from '../shared/types.js';
import { P2OutputSchema, P2_PROMPT_VERSION, buildP2Prompt } from '../extract/prompts/p2.js';
import { parseJsonFromLlm } from '../extract/json.js';
import { LlmBudgetExceededError } from '../extract/llm/budget.js';
import { classifyDeterministic, isWithinReleaseWeek, type ClassifyInput } from './rules.js';
import { todayJst } from '../shared/time.js';

export interface ClassifyDeps {
  llm?: LlmClient;
}

export interface ClassificationResult {
  edition: Edition;
  category: string;
  isStoreExclusive: boolean;
  offerablePerModel: boolean;
  needsReview: boolean;
  reason: string;
  usedLlm: boolean;
  promptVersion?: string;
}

function deriveFlagsFromEdition(
  edition: Edition,
  operatorAllowedPo: boolean,
): { category: string; isStoreExclusive: boolean; offerablePerModel: boolean } {
  if (edition === 'exclusive') {
    return { category: 'exclusive', isStoreExclusive: true, offerablePerModel: operatorAllowedPo };
  }
  if (edition === 'random' || edition === 'set') {
    return { category: edition, isStoreExclusive: false, offerablePerModel: false };
  }
  if (edition === 'unknown') {
    return { category: 'unknown', isStoreExclusive: false, offerablePerModel: false };
  }
  return { category: edition, isStoreExclusive: false, offerablePerModel: true };
}

/**
 * Mengklasifikasikan satu item Tomica sesuai PRD §5.
 * Mengutamakan aturan deterministik dan hanya memanggil LLM (P2) bila ambigu.
 */
export async function classifyItem(deps: ClassifyDeps, input: ClassifyInput): Promise<ClassificationResult> {
  const det = classifyDeterministic(input);
  if (!det.ambiguous) {
    return {
      edition: det.edition,
      category: det.category,
      isStoreExclusive: det.isStoreExclusive,
      offerablePerModel: det.offerablePerModel,
      needsReview: det.needsReview,
      reason: det.reason,
      usedLlm: false,
    };
  }

  if (!deps.llm) {
    return {
      edition: 'unknown',
      category: 'unknown',
      isStoreExclusive: false,
      offerablePerModel: false,
      needsReview: true,
      reason: `${det.reason} (LLM P2 tidak tersedia; perlu REVIEW operator).`,
      usedLlm: false,
    };
  }

  const excerpt = input.sourceText.slice(0, 1200);
  const prompt = buildP2Prompt({ item: input.item, excerpt });

  try {
    const res = await deps.llm.complete({
      task: 'P2',
      promptVersion: prompt.version,
      system: prompt.system,
      user: prompt.user,
      temperature: 0,
      maxTokens: 512,
    });

    const parsed = P2OutputSchema.safeParse(parseJsonFromLlm(res.text));
    if (!parsed.success) {
      return {
        edition: 'unknown',
        category: 'unknown',
        isStoreExclusive: false,
        offerablePerModel: false,
        needsReview: true,
        reason: 'Keluaran P2 tidak sesuai skema; ditandai REVIEW.',
        usedLlm: true,
        promptVersion: P2_PROMPT_VERSION,
      };
    }

    let edition = parsed.data.edition;
    let needsReview = parsed.data.needs_review || edition === 'unknown';
    let reason = parsed.data.reason;

    // Penegakan aturan PRD §5: P2 pun tidak boleh meloloskan 'first' di luar pekan rilis.
    if (edition === 'first') {
      const refDate = input.referenceDateJst ?? todayJst();
      if (!input.item.release_date_jst) {
        edition = 'unknown';
        needsReview = true;
        reason = `${reason} (tanggal rilis kosong sehingga pekan rilis tidak dapat dipastikan).`;
      } else if (!isWithinReleaseWeek(input.item.release_date_jst, refDate)) {
        edition = 'regular';
        reason = `${reason} (di luar pekan rilis ${input.item.release_date_jst}, bukan first edition).`;
      }
    }

    const flags = deriveFlagsFromEdition(edition, Boolean(input.operatorAllowedPo));
    return {
      edition,
      category: flags.category,
      isStoreExclusive: flags.isStoreExclusive,
      offerablePerModel: flags.offerablePerModel,
      needsReview,
      reason,
      usedLlm: true,
      promptVersion: P2_PROMPT_VERSION,
    };
  } catch (err) {
    if (err instanceof LlmBudgetExceededError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      edition: 'unknown',
      category: 'unknown',
      isStoreExclusive: false,
      offerablePerModel: false,
      needsReview: true,
      reason: `Gagal memanggil/mengurai P2 (${msg}); ditandai REVIEW.`,
      usedLlm: true,
      promptVersion: P2_PROMPT_VERSION,
    };
  }
}
