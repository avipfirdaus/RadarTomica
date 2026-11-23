import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type Db } from '../../db/client.js';
import {
  createLlmClient,
  LlmBudgetExceededError,
  OpenAiCompatibleLlmClient,
  recordLlmCall,
  type FetchLike,
} from './index.js';

describe('OpenAiCompatibleLlmClient', () => {
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('mengirim POST /chat/completions dengan Bearer token dan mencatat cost_usd=0 untuk model :free', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};

    const mockFetch: FetchLike = async (input, init) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          model: 'qwen/qwen3-8b:free',
          choices: [{ message: { content: '{"items":[]}' } }],
          usage: { prompt_tokens: 400, completion_tokens: 50 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const client = new OpenAiCompatibleLlmClient({
      db,
      baseUrl: 'https://openrouter.ai/api/v1/',
      apiKey: 'sk-or-test-key',
      model: 'qwen/qwen3-8b:free',
      fetch: mockFetch,
    });

    const out = await client.complete({
      task: 'P1',
      promptVersion: 'P1@1',
      system: 'PERAN: ekstrak',
      user: 'TEKS SUMBER',
      temperature: 0,
    });

    expect(capturedUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(capturedHeaders.authorization).toBe('Bearer sk-or-test-key');
    expect(capturedBody.model).toBe('qwen/qwen3-8b:free');
    expect(capturedBody.temperature).toBe(0);
    expect(out.text).toBe('{"items":[]}');
    expect(out.inputTokens).toBe(400);
    expect(out.outputTokens).toBe(50);

    const { rows } = await db.query<{ cost_usd: number; ok: boolean; model: string }>(
      'SELECT cost_usd, ok, model FROM llm_calls',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ok).toBe(true);
    expect(rows[0]!.cost_usd).toBe(0);
  });

  it('mengizinkan endpoint lokal (Ollama) tanpa API key dan mencatat cost_usd=0', async () => {
    let hasAuthHeader = false;
    const mockFetch: FetchLike = async (_input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      hasAuthHeader = 'authorization' in headers;
      return new Response(
        JSON.stringify({
          model: 'qwen2.5:7b',
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1000, completion_tokens: 200 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const client = new OpenAiCompatibleLlmClient({
      db,
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5:7b',
      fetch: mockFetch,
    });

    const out = await client.complete({
      task: 'P3',
      promptVersion: 'P3@1',
      system: 'ringkas',
      user: 'teks',
    });

    expect(hasAuthHeader).toBe(false);
    expect(out.text).toBe('ok');
    const { rows } = await db.query<{ cost_usd: number }>('SELECT cost_usd FROM llm_calls');
    expect(rows[0]!.cost_usd).toBe(0);
  });

  it('menolak endpoint non-lokal bila LLM_API_KEY kosong', () => {
    expect(
      () =>
        new OpenAiCompatibleLlmClient({
          baseUrl: 'https://api.groq.com/openai/v1',
          apiKey: '',
        }),
    ).toThrow(/LLM_API_KEY/);
  });

  it('menghormati budget guard sebelum memanggil fetch dan mencatat error HTTP', async () => {
    await recordLlmCall(db, {
      task: 'P1',
      promptVersion: 'P1@1',
      model: 'claude-sonnet-4-5',
      inputTokens: 100,
      outputTokens: 100,
      costUsd: 25,
      ok: true,
    });

    let called = false;
    const client = new OpenAiCompatibleLlmClient({
      db,
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
      monthlyBudgetUsd: 20,
      fetch: async () => {
        called = true;
        return new Response('{}', { status: 200 });
      },
    });

    await expect(
      client.complete({ task: 'P1', promptVersion: 'P1@1', system: 's', user: 'u' }),
    ).rejects.toBeInstanceOf(LlmBudgetExceededError);
    expect(called).toBe(false);

    // Uji galat HTTP dicatat ok=false
    const errClient = new OpenAiCompatibleLlmClient({
      db,
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
      monthlyBudgetUsd: 100,
      fetch: async () => new Response('rate limited', { status: 429 }),
    });

    await expect(
      errClient.complete({ task: 'P1', promptVersion: 'P1@1', system: 's', user: 'u' }),
    ).rejects.toThrow(/429/);

    const { rows } = await db.query<{ ok: boolean }>('SELECT ok FROM llm_calls ORDER BY id DESC LIMIT 1');
    expect(rows[0]!.ok).toBe(false);
  });

  it('createLlmClient memilih OpenAiCompatibleLlmClient saat provider=openai_compat', () => {
    const client = createLlmClient({
      mock: false,
      provider: 'openai_compat',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5:7b',
    });
    expect(client).toBeInstanceOf(OpenAiCompatibleLlmClient);
  });
});
