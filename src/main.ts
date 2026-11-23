/**
 * Titik masuk utama layanan Radar Tomica Jepang.
 * Menjalankan migrasi, seed sumber, penjadwal JST (croner), dan bot Telegram operator (bila token tersedia).
 */
import { loadEnv } from './config/env.js';
import { createPgDb, runMigrations } from './db/client.js';
import { logger } from './shared/logger.js';
import { createPolitenessState, seedSources } from './ingest/index.js';
import { createScheduler } from './scheduler/index.js';
import { createLlmClient } from './extract/index.js';
import { FrankfurterFxProvider } from './pricing/index.js';
import { createOperatorBot, createTelegramPort } from './telegram/index.js';
import {
  buildJobHandlers,
  createDraftActionHandler,
  createDraftServiceDeps,
  createOperatorControls,
  type PipelineDeps,
} from './pipeline/index.js';

async function main() {
  const env = loadEnv();
  const db = await createPgDb(env.DATABASE_URL);
  await runMigrations(db);
  const seeded = await seedSources(db);
  logger.info({ seeded, mockLlm: env.LLM_MOCK, dryRunTelegram: env.TELEGRAM_DRY_RUN }, 'Radar Tomica dimulai');

  const hasLiveLlmCreds =
    env.LLM_PROVIDER === 'openai_compat'
      ? Boolean(env.LLM_BASE_URL)
      : Boolean(env.ANTHROPIC_API_KEY);

  const llm = createLlmClient({
    db,
    mock: env.LLM_MOCK || !hasLiveLlmCreds,
    provider: env.LLM_PROVIDER,
    baseUrl: env.LLM_BASE_URL,
    apiKey: env.LLM_PROVIDER === 'openai_compat' ? env.LLM_API_KEY : env.ANTHROPIC_API_KEY,
    model: env.LLM_MODEL,
    monthlyBudgetUsd: env.LLM_MONTHLY_BUDGET_USD,
  });

  const telegram = createTelegramPort(env);
  const fx = new FrankfurterFxProvider();
  const ingestDeps = {
    db,
    env,
    politeness: createPolitenessState(),
  };

  const pipelineDeps: PipelineDeps = { db, env, llm, telegram, fx, ingestDeps };
  const handlers = buildJobHandlers(pipelineDeps);
  const scheduler = createScheduler(db, handlers);
  scheduler.start();

  let bot: ReturnType<typeof createOperatorBot> | null = null;
  if (!env.TELEGRAM_DRY_RUN && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_OPERATOR_CHAT_ID) {
    const controls = createOperatorControls(pipelineDeps);
    const draftActions = createDraftActionHandler(createDraftServiceDeps(pipelineDeps));
    bot = createOperatorBot(env.TELEGRAM_BOT_TOKEN, {
      operatorChatId: env.TELEGRAM_OPERATOR_CHAT_ID,
      controls,
      draftActions,
      brandName: env.BRAND_NAME,
    });
    void bot.start({
      onStart: () => logger.info('Bot operator Telegram aktif (long polling)'),
    });
  } else {
    logger.info('Mode dry-run Telegram atau token belum diisi; bot polling tidak dijalankan');
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Menghentikan Radar Tomica...');
    scheduler.stop();
    if (bot) await bot.stop();
    await db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Radar Tomica gagal dimulai');
  process.exit(1);
});
