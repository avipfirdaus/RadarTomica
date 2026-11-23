/**
 * Klien LLM mock untuk pengujian tanpa jaringan dan mode LLM_MOCK=1.
 * Mendukung respons terprogram per tugas (P1..P4), matcher kustom, maupun antrean.
 */
import type { Db } from '../../db/client.js';
import type { LlmClient, LlmTask } from '../../shared/types.js';
import { assertWithinBudget, estimateCostUsd, recordLlmCall } from './budget.js';

export interface MockLlmRequest {
  task: LlmTask;
  promptVersion: string;
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
}

export type MockResponder = string | ((req: MockLlmRequest) => string | Promise<string>);

export interface MockMatcherRule {
  match: (req: MockLlmRequest) => boolean;
  respond: MockResponder;
}

export interface MockLlmClientOptions {
  /** Respons default per tugas. Bila array, dikonsumsi berurutan lalu elemen terakhir diulang. */
  byTask?: Partial<Record<LlmTask, MockResponder | MockResponder[]>>;
  /** Aturan pencocokan berurutan (diperiksa sebelum byTask). */
  matchers?: MockMatcherRule[];
  /** Respons cadangan bila tidak ada aturan yang cocok. */
  fallback?: MockResponder;
  /** Opsional: bila diberikan, catat ke llm_calls dan jalankan budget guard. */
  db?: Db;
  monthlyBudgetUsd?: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  now?: () => Date;
}

export class MockLlmClient implements LlmClient {
  readonly calls: MockLlmRequest[] = [];
  private readonly byTask: Partial<Record<LlmTask, MockResponder[]>>;
  private readonly taskCursors = new Map<LlmTask, number>();
  private readonly matchers: MockMatcherRule[];
  private readonly fallback: MockResponder | undefined;
  private readonly db: Db | undefined;
  private readonly monthlyBudgetUsd: number;
  private readonly model: string;
  private readonly inputTokens: number;
  private readonly outputTokens: number;
  private readonly now: () => Date;

  constructor(opts: MockLlmClientOptions = {}) {
    this.byTask = {};
    if (opts.byTask) {
      for (const [task, val] of Object.entries(opts.byTask) as [LlmTask, MockResponder | MockResponder[]][]) {
        this.byTask[task] = Array.isArray(val) ? [...val] : [val];
      }
    }
    this.matchers = opts.matchers ? [...opts.matchers] : [];
    this.fallback = opts.fallback;
    this.db = opts.db;
    this.monthlyBudgetUsd = opts.monthlyBudgetUsd ?? Number(process.env.LLM_MONTHLY_BUDGET_USD ?? 20);
    this.model = opts.model ?? 'mock-claude';
    this.inputTokens = opts.inputTokens ?? 500;
    this.outputTokens = opts.outputTokens ?? 200;
    this.now = opts.now ?? (() => new Date());
  }

  async complete(req: MockLlmRequest): Promise<{ text: string; inputTokens: number; outputTokens: number; model: string }> {
    if (this.db) {
      await assertWithinBudget(this.db, this.monthlyBudgetUsd, this.now());
    }

    this.calls.push(req);

    try {
      const responder = this.resolveResponder(req);
      const text = typeof responder === 'function' ? await responder(req) : responder;
      const costUsd = estimateCostUsd(this.model, this.inputTokens, this.outputTokens);

      if (this.db) {
        await recordLlmCall(this.db, {
          task: req.task,
          promptVersion: req.promptVersion,
          model: this.model,
          inputTokens: this.inputTokens,
          outputTokens: this.outputTokens,
          costUsd,
          ok: true,
          createdAt: this.now(),
        });
      }

      return {
        text,
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        model: this.model,
      };
    } catch (err) {
      if (this.db) {
        await recordLlmCall(this.db, {
          task: req.task,
          promptVersion: req.promptVersion,
          model: this.model,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          ok: false,
          createdAt: this.now(),
        }).catch(() => {});
      }
      throw err;
    }
  }

  private resolveResponder(req: MockLlmRequest): MockResponder {
    for (const rule of this.matchers) {
      if (rule.match(req)) return rule.respond;
    }

    const list = this.byTask[req.task];
    if (list && list.length > 0) {
      const idx = this.taskCursors.get(req.task) ?? 0;
      const chosen = list[Math.min(idx, list.length - 1)]!;
      this.taskCursors.set(req.task, idx + 1);
      return chosen;
    }

    if (this.fallback !== undefined) return this.fallback;

    // Default aman untuk mode LLM_MOCK=1 agar pipeline tidak crash.
    if (req.task === 'P1') return JSON.stringify({ items: [] });
    if (req.task === 'P2') return JSON.stringify({ edition: 'unknown', reason: 'Mock default.', needs_review: true });
    if (req.task === 'P3') return 'Ringkasan mock tersedia. Tidak ada fakta tambahan.';
    return 'Draf mock Radar Tomica Jepang.';
  }
}
