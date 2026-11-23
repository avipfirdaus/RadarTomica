import type { Db } from '../../db/client.js';
import type { LlmClient } from '../../shared/types.js';
import { AnthropicLlmClient } from './anthropic.js';
import { MockLlmClient, type MockLlmClientOptions } from './mock.js';

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
export { MockLlmClient, type MockLlmClientOptions, type MockLlmRequest, type MockMatcherRule, type MockResponder } from './mock.js';

/** Factory klien LLM: memilih MockLlmClient saat LLM_MOCK=1/true, selain itu AnthropicLlmClient. */
export function createLlmClient(opts: {
  db?: Db;
  mock?: boolean;
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
  return new AnthropicLlmClient({
    db: opts.db,
    model: opts.model,
    monthlyBudgetUsd: opts.monthlyBudgetUsd,
  });
}
