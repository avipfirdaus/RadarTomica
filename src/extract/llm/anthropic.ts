/**
 * Klien LLM berbasis Anthropic SDK (@anthropic-ai/sdk).
 * API key hanya dibaca dari environment (tidak pernah masuk prompt, DB, atau log).
 * Setiap panggilan dicatat ke tabel `llm_calls` dan dijaga oleh budget guard.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Db } from '../../db/client.js';
import type { LlmClient, LlmTask } from '../../shared/types.js';
import { logger } from '../../shared/logger.js';
import { assertWithinBudget, estimateCostUsd, recordLlmCall } from './budget.js';

export interface AnthropicMessagesClient {
  messages: {
    create(params: {
      model: string;
      max_tokens: number;
      temperature?: number;
      system?: string;
      messages: { role: 'user' | 'assistant'; content: string }[];
    }): Promise<{
      model: string;
      content: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    }>;
  };
}

export interface AnthropicLlmClientOptions {
  /** Opsional: bila diberikan, aktifkan pencatatan llm_calls & budget guard. */
  db?: Db;
  /** Default: process.env.LLM_MODEL ?? 'claude-sonnet-4-5'. */
  model?: string;
  /** Default: Number(process.env.LLM_MONTHLY_BUDGET_USD ?? 20). */
  monthlyBudgetUsd?: number;
  /** Default: process.env.ANTHROPIC_API_KEY (hanya dari env). */
  apiKey?: string;
  /** Injeksi klien untuk pengujian tanpa jaringan. */
  client?: AnthropicMessagesClient;
  /** Jam deterministik untuk pengujian. */
  now?: () => Date;
}

export class AnthropicLlmClient implements LlmClient {
  private readonly db: Db | undefined;
  private readonly model: string;
  private readonly monthlyBudgetUsd: number;
  private readonly client: AnthropicMessagesClient;
  private readonly now: () => Date;

  constructor(opts: AnthropicLlmClientOptions = {}) {
    this.db = opts.db;
    this.model = opts.model ?? process.env.LLM_MODEL ?? 'claude-sonnet-4-5';
    this.monthlyBudgetUsd = opts.monthlyBudgetUsd ?? Number(process.env.LLM_MONTHLY_BUDGET_USD ?? 20);
    this.now = opts.now ?? (() => new Date());

    if (opts.client) {
      this.client = opts.client;
    } else {
      const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY tidak tersedia di environment');
      }
      this.client = new Anthropic({ apiKey }) as unknown as AnthropicMessagesClient;
    }
  }

  async complete(req: {
    task: LlmTask;
    promptVersion: string;
    system: string;
    user: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ text: string; inputTokens: number; outputTokens: number; model: string }> {
    if (this.db) {
      await assertWithinBudget(this.db, this.monthlyBudgetUsd, this.now());
    }

    const temperature = req.temperature ?? 0;
    const maxTokens = req.maxTokens ?? 4096;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: maxTokens,
        temperature,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
      });

      const text = response.content
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text!)
        .join('');

      const inputTokens = response.usage?.input_tokens ?? 0;
      const outputTokens = response.usage?.output_tokens ?? 0;
      const usedModel = response.model || this.model;
      const costUsd = estimateCostUsd(usedModel, inputTokens, outputTokens);

      if (this.db) {
        await recordLlmCall(this.db, {
          task: req.task,
          promptVersion: req.promptVersion,
          model: usedModel,
          inputTokens,
          outputTokens,
          costUsd,
          ok: true,
          createdAt: this.now(),
        });
      }

      logger.debug(
        { task: req.task, promptVersion: req.promptVersion, model: usedModel, inputTokens, outputTokens, costUsd },
        'LLM call succeeded',
      );

      return { text, inputTokens, outputTokens, model: usedModel };
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
        }).catch(() => {
          // Jangan timpa galat asli bila pencatatan gagal.
        });
      }
      throw err;
    }
  }
}
