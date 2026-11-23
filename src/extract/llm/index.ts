import type { Db } from '../../db/client.js';
import type { LlmClient } from '../../shared/types.js';
import { AnthropicLlmClient } from './anthropic.js';
import { MockLlmClient, type MockLlmClientOptions } from './mock.js';
import { OpenAiCompatibleLlmClient } from './openai-compat.js';

export type LlmProvider = 'anthropic' | 'openai_compat';

export {
  LlmBudgetExceededError,
  estimateCostUsd,
  monthBoundsUtc,
  getMonthlyBudgetUsd,
  getCurrentMonthSpendUsd,
  assertWithinBudget,
  recordLlmCall,
  type LlmCallLogEntry,
} from './budget.js';
export { AnthropicLlmClient, type AnthropicLlmClientOptions, type AnthropicMessagesClient } from './anthropic.js';
export {
  OpenAiCompatibleLlmClient,
  type OpenAiCompatLlmClientOptions,
  type FetchLike,
} from './openai-compat.js';
export { MockLlmClient, type MockLlmClientOptions, type MockLlmRequest, type MockMatcherRule, type MockResponder } from './mock.js';

/**
 * Factory klien LLM:
 * - MockLlmClient saat LLM_MOCK=1/true
 * - OpenAiCompatibleLlmClient saat provider='openai_compat' (OpenRouter, Groq, Gemini, GitHub Models, Ollama)
 * - AnthropicLlmClient (default)
 */
export function createLlmClient(opts: {
  db?: Db;
  mock?: boolean;
  provider?: LlmProvider;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  monthlyBudgetUsd?: number;
  mockOptions?: MockLlmClientOptions;
} = {}): LlmClient {
  const useMock = opts.mock ?? (process.env.LLM_MOCK === '1' || process.env.LLM_MOCK === 'true');
  if (useMock) {
    return new MockLlmClient({
      db: opts.db,
      monthlyBudgetUsd: opts.monthlyBudgetUsd,
      ...opts.mockOptions,
    });
  }

  const provider: LlmProvider =
    opts.provider ?? (process.env.LLM_PROVIDER === 'openai_compat' ? 'openai_compat' : 'anthropic');

  if (provider === 'openai_compat') {
    return new OpenAiCompatibleLlmClient({
      db: opts.db,
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      monthlyBudgetUsd: opts.monthlyBudgetUsd,
    });
  }

  return new AnthropicLlmClient({
    db: opts.db,
    apiKey: opts.apiKey,
    model: opts.model,
    monthlyBudgetUsd: opts.monthlyBudgetUsd,
  });
}
