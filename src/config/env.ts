/** Konfigurasi lingkungan. Rahasia hanya dari env, tidak pernah ke prompt/DB/log. */
import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === '1' || v === 'true');

const EnvSchema = z.object({
  DATABASE_URL: z.string().default('postgres://radar:radar@localhost:5432/radar'),
  BRAND_NAME: z.string().default('Radar Tomica Jepang'),

  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('claude-sonnet-4-5'),
  LLM_MOCK: bool,
  LLM_MONTHLY_BUDGET_USD: z.coerce.number().default(20),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  /** Chat ID pribadi operator; juga satu-satunya user ID yang boleh menekan tombol. */
  TELEGRAM_OPERATOR_CHAT_ID: z.string().optional(),
  TELEGRAM_CHANNEL_ID: z.string().optional(),
  TELEGRAM_DRY_RUN: bool,

  HTTP_USER_AGENT: z.string().default('RadarTomicaBot/0.1 (+contact via channel)'),
  /** Jeda minimal antar permintaan ke satu host (ms). PRD: ≥ 5 detik. */
  HTTP_MIN_DELAY_MS: z.coerce.number().min(5000).default(5000),

  LOG_LEVEL: z.string().default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
