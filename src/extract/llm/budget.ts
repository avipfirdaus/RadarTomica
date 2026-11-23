/**
 * Penghitung biaya dan penjaga anggaran bulanan LLM (PRD §9 "Biaya").
 * Sebelum memanggil LLM, total cost_usd bulan berjalan diperiksa; bila mencapai
 * atau melebihi batas anggaran, lempar LlmBudgetExceededError agar pemanggil
 * memberi tahu operator.
 */
import type { Db } from '../../db/client.js';
import type { LlmTask } from '../../shared/types.js';
import { loadParams } from '../../config/params.js';

export class LlmBudgetExceededError extends Error {
  readonly spentUsd: number;
  readonly budgetUsd: number;
  readonly month: string;

  constructor(spentUsd: number, budgetUsd: number, month: string) {
    super(`Anggaran LLM bulanan tercapai untuk ${month}: terpakai $${spentUsd.toFixed(4)} / batas $${budgetUsd.toFixed(2)}`);
    this.name = 'LlmBudgetExceededError';
    this.spentUsd = spentUsd;
    this.budgetUsd = budgetUsd;
    this.month = month;
  }
}

/** Estimasi tarif per 1 juta token (USD). Nilai konservatif bila model tidak dikenal. */
const MODEL_PRICING_PER_MILLION: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-sonnet-4-0': { input: 3, output: 15 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-7-sonnet': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-opus-4': { input: 15, output: 75 },
};

const DEFAULT_PRICING = { input: 3, output: 15 };

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const lower = model.toLowerCase();
  let pricing = DEFAULT_PRICING;
  for (const [prefix, rates] of Object.entries(MODEL_PRICING_PER_MILLION)) {
    if (lower.startsWith(prefix) || lower.includes(prefix)) {
      pricing = rates;
      break;
    }
  }
  const cost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
  return Number(cost.toFixed(6));
}

export function monthBoundsUtc(at: Date = new Date()): { start: Date; end: Date; label: string } {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
  const label = `${year}-${String(month + 1).padStart(2, '0')}`;
  return { start, end, label };
}

/**
 * Mengambil batas anggaran bulanan efektif (USD):
 * pakai parameter `llm_monthly_budget_usd` bila > 0, selain itu pakai env `LLM_MONTHLY_BUDGET_USD`.
 */
export async function getMonthlyBudgetUsd(db: Db, envBudgetUsd: number, at: Date = new Date()): Promise<number> {
  const { values } = await loadParams(db, at);
  return values.llm_monthly_budget_usd > 0 ? values.llm_monthly_budget_usd : envBudgetUsd;
}

/** Total estimasi biaya LLM (USD) pada bulan berjalan (UTC). */
export async function getCurrentMonthSpendUsd(db: Db, at: Date = new Date()): Promise<number> {
  const { start, end } = monthBoundsUtc(at);
  const { rows } = await db.query<{ total: number | null }>(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total
     FROM llm_calls
     WHERE created_at >= $1 AND created_at < $2`,
    [start, end],
  );
  return Number(rows[0]?.total ?? 0);
}

/** Memastikan pemakaian bulan berjalan masih di bawah batas anggaran. */
export async function assertWithinBudget(db: Db, envBudgetUsd: number, at: Date = new Date()): Promise<void> {
  const budgetUsd = await getMonthlyBudgetUsd(db, envBudgetUsd, at);
  if (budgetUsd <= 0) return;
  const spentUsd = await getCurrentMonthSpendUsd(db, at);
  if (spentUsd >= budgetUsd) {
    const { label } = monthBoundsUtc(at);
    throw new LlmBudgetExceededError(spentUsd, budgetUsd, label);
  }
}

export interface LlmCallLogEntry {
  task: LlmTask;
  promptVersion: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  ok: boolean;
  createdAt?: Date;
}

/** Mencatat satu pemanggilan LLM ke tabel `llm_calls`. */
export async function recordLlmCall(db: Db, entry: LlmCallLogEntry): Promise<void> {
  if (entry.createdAt) {
    await db.query(
      `INSERT INTO llm_calls (task, prompt_version, model, input_tokens, output_tokens, cost_usd, ok, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.task,
        entry.promptVersion,
        entry.model,
        entry.inputTokens,
        entry.outputTokens,
        entry.costUsd,
        entry.ok,
        entry.createdAt,
      ],
    );
    return;
  }
  await db.query(
    `INSERT INTO llm_calls (task, prompt_version, model, input_tokens, output_tokens, cost_usd, ok)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [entry.task, entry.promptVersion, entry.model, entry.inputTokens, entry.outputTokens, entry.costUsd, entry.ok],
  );
}
