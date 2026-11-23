/**
 * Klien LLM untuk endpoint OpenAI-compatible (OpenRouter, Groq, Google Gemini
 * OpenAI-compat, GitHub Models, Cerebras, maupun Ollama lokal).
 *
 * Memakai `fetch` bawaan Node 22 tanpa dependensi tambahan.
 * API key hanya dibaca dari environment (opsional untuk Ollama di localhost)
 * dan tidak pernah masuk ke prompt, DB, atau log.
 */
import type { Db } from '../../db/client.js';
import type { LlmClient, LlmTask } from '../../shared/types.js';
import { logger } from '../../shared/logger.js';
import { assertWithinBudget, estimateCostUsd, recordLlmCall } from './budget.js';

export type FetchLike = typeof fetch;

export interface OpenAiCompatLlmClientOptions {
  /** Opsional: bila diberikan, aktifkan pencatatan llm_calls & budget guard. */
  db?: Db;
  /** URL dasar API, mis. 'https://openrouter.ai/api/v1' atau 'http://localhost:11434/v1'. */
  baseUrl?: string;
  /** Nama model sesuai provider, mis. 'qwen/qwen3-8b:free' atau 'qwen2.5:7b'. */
  model?: string;
  /** API key (hanya dari env; boleh kosong untuk localhost/Ollama). */
  apiKey?: string;
  /** Batas anggaran bulanan USD. Default: Number(process.env.LLM_MONTHLY_BUDGET_USD ?? 20). */
  monthlyBudgetUsd?: number;
  /** Timeout permintaan dalam ms. Default: 60000. */
  timeoutMs?: number;
  /** Injeksi fetch untuk pengujian tanpa jaringan. */
  fetch?: FetchLike;
  /** Jam deterministik untuk pengujian. */
  now?: () => Date;
}

interface OpenAiChatResponse {
  model?: string;
  choices?: {
    message?: {
      content?: string | { type?: string; text?: string }[] | null;
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    const host = u.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === 'ollama' || host.endsWith('.local');
  } catch {
    return false;
  }
}

function extractMessageText(content: string | { type?: string; text?: string }[] | null | undefined): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => typeof part?.text === 'string')
      .map((part) => part.text!)
      .join('');
  }
  return '';
}

export class OpenAiCompatibleLlmClient implements LlmClient {
  private readonly db: Db | undefined;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly monthlyBudgetUsd: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchLike;
  private readonly now: () => Date;
  private readonly isLocal: boolean;

  constructor(opts: OpenAiCompatLlmClientOptions = {}) {
    this.db = opts.db;
    const rawBaseUrl = opts.baseUrl ?? process.env.LLM_BASE_URL;
    if (!rawBaseUrl) {
      throw new Error('LLM_BASE_URL wajib diisi saat LLM_PROVIDER=openai_compat');
    }
    this.baseUrl = rawBaseUrl.replace(/\/+$/, '');
    this.isLocal = isLocalEndpoint(this.baseUrl);
    this.model = opts.model ?? process.env.LLM_MODEL ?? 'qwen/qwen3-8b:free';
    this.apiKey = opts.apiKey ?? process.env.LLM_API_KEY;
    this.monthlyBudgetUsd = opts.monthlyBudgetUsd ?? Number(process.env.LLM_MONTHLY_BUDGET_USD ?? 20);
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? (() => new Date());

    if (!this.apiKey && !this.isLocal) {
      throw new Error('LLM_API_KEY tidak tersedia di environment untuk endpoint non-lokal');
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

    const endpoint = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-title': 'Radar Tomica Jepang',
    };
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchFn(endpoint, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          temperature: req.temperature ?? 0,
          max_tokens: req.maxTokens ?? 4096,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
        }),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`OpenAI-compat HTTP ${res.status}: ${errBody.slice(0, 300)}`);
      }

      const data = (await res.json()) as OpenAiChatResponse;
      const text = extractMessageText(data.choices?.[0]?.message?.content);
      const inputTokens = data.usage?.prompt_tokens ?? 0;
      const outputTokens = data.usage?.completion_tokens ?? 0;
      const usedModel = data.model || this.model;
      const costUsd = this.isLocal ? 0 : estimateCostUsd(usedModel, inputTokens, outputTokens);

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
        'OpenAI-compat LLM call succeeded',
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
    } finally {
      clearTimeout(timer);
    }
  }
}
