/**
 * Adaptor TelegramPort menggunakan grammY untuk chat pribadi operator dan channel publik.
 */
import { Api, InlineKeyboard } from 'grammy';
import type { TelegramPort } from '../shared/types.js';
import type { Env } from '../config/env.js';
import { DryRunTelegram } from './dry-run.js';

export type TelegramParseMode = 'HTML' | 'MarkdownV2';

export interface GrammyApiLike {
  sendMessage(
    chat_id: number | string,
    text: string,
    other?: {
      parse_mode?: TelegramParseMode;
      reply_markup?: InlineKeyboard;
      link_preview_options?: { is_disabled?: boolean };
    },
  ): Promise<{ message_id: number }>;
}

export interface GrammyTelegramOptions {
  api: GrammyApiLike;
  operatorChatId: string;
  channelId: string;
  parseMode?: TelegramParseMode;
  disableLinkPreview?: boolean;
}

/** Membangun InlineKeyboard grammY dari matriks tombol `{ text, data }`. */
export function buildInlineKeyboard(buttons?: { text: string; data: string }[][]): InlineKeyboard | undefined {
  if (!buttons || buttons.length === 0) return undefined;
  const kb = new InlineKeyboard();
  for (let i = 0; i < buttons.length; i++) {
    const row = buttons[i]!;
    for (const btn of row) {
      kb.text(btn.text, btn.data);
    }
    if (i < buttons.length - 1) {
      kb.row();
    }
  }
  return kb;
}

export class GrammyTelegram implements TelegramPort {
  private readonly api: GrammyApiLike;
  private readonly operatorChatId: string;
  private readonly channelId: string;
  private readonly parseMode?: TelegramParseMode;
  private readonly disableLinkPreview: boolean;

  constructor(opts: GrammyTelegramOptions) {
    if (!opts.operatorChatId) throw new Error('GrammyTelegram memerlukan operatorChatId');
    if (!opts.channelId) throw new Error('GrammyTelegram memerlukan channelId');
    this.api = opts.api;
    this.operatorChatId = opts.operatorChatId;
    this.channelId = opts.channelId;
    this.parseMode = opts.parseMode;
    this.disableLinkPreview = opts.disableLinkPreview ?? true;
  }

  static fromToken(
    botToken: string,
    operatorChatId: string,
    channelId: string,
    opts?: { parseMode?: TelegramParseMode; disableLinkPreview?: boolean },
  ): GrammyTelegram {
    const api = new Api(botToken);
    return new GrammyTelegram({
      api,
      operatorChatId,
      channelId,
      parseMode: opts?.parseMode,
      disableLinkPreview: opts?.disableLinkPreview,
    });
  }

  async sendToOperator(
    text: string,
    opts?: { buttons?: { text: string; data: string }[][] },
  ): Promise<{ messageId: string }> {
    const replyMarkup = buildInlineKeyboard(opts?.buttons);
    const msg = await this.api.sendMessage(this.operatorChatId, text, {
      ...(this.parseMode ? { parse_mode: this.parseMode } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      ...(this.disableLinkPreview ? { link_preview_options: { is_disabled: true } } : {}),
    });
    return { messageId: String(msg.message_id) };
  }

  async sendToChannel(text: string): Promise<{ messageId: string }> {
    const msg = await this.api.sendMessage(this.channelId, text, {
      ...(this.parseMode ? { parse_mode: this.parseMode } : {}),
      ...(this.disableLinkPreview ? { link_preview_options: { is_disabled: true } } : {}),
    });
    return { messageId: String(msg.message_id) };
  }
}

/** Factory: pilih DryRunTelegram bila TELEGRAM_DRY_RUN=1, selain itu GrammyTelegram. */
export function createTelegramPort(env: Env, opts?: { parseMode?: TelegramParseMode }): TelegramPort {
  if (env.TELEGRAM_DRY_RUN) {
    return new DryRunTelegram();
  }
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_OPERATOR_CHAT_ID || !env.TELEGRAM_CHANNEL_ID) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN, TELEGRAM_OPERATOR_CHAT_ID, dan TELEGRAM_CHANNEL_ID wajib diisi saat TELEGRAM_DRY_RUN=0',
    );
  }
  return GrammyTelegram.fromToken(
    env.TELEGRAM_BOT_TOKEN,
    env.TELEGRAM_OPERATOR_CHAT_ID,
    env.TELEGRAM_CHANNEL_ID,
    opts,
  );
}
