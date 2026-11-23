/**
 * Bot kontrol operator Telegram (PRD §4 Kontrol operator & §9 Keamanan).
 *
 * Logika routing dipisahkan menjadi fungsi murni `handleUpdate` agar dapat dites
 * tanpa jaringan, sedangkan `attachOperatorBot` / `createOperatorBot` adalah
 * pembungkus tipis grammY.
 *
 * KEAMANAN: hanya menerima perintah & tombol callback dari `operatorChatId`.
 * Semua update dari user ID lain diabaikan dan dicatat di log.
 */
import { Bot } from 'grammy';
import { DEFAULT_PARAMS, type ParamKey } from '../config/params.js';
import { logger } from '../shared/logger.js';
import { formatJstWib } from '../shared/time.js';
import type { Label } from '../shared/types.js';
import { formatIdr, formatRatio } from './format.js';

// ---------- Kontrak injeksi (di-wire oleh orkestrator) ----------

export interface StatusSummary {
  paused: boolean;
  activeSources: number;
  pausedSources: number;
  failingSources: number;
  pendingDrafts: number;
  pendingReviews: number;
  lastRunAt?: Date | null;
}

export interface RunLogEntry {
  id: number;
  module: string;
  started_at: Date;
  finished_at: Date | null;
  status: string;
  processed_count: number;
  error: string | null;
}

export interface DecisionLogEntry {
  item_id: number;
  name_ja: string;
  label: Label;
  po_ratio: number | null;
  po_price_idr: number | null;
  reference_idr: number | null;
  created_at: Date;
}

export interface ReviewEntry {
  id: number;
  kind: string;
  item_id: number | null;
  item_name?: string | null;
  reason: string;
  created_at: Date;
}

export interface OperatorControls {
  getStatus(): Promise<StatusSummary>;
  pause(by: string): Promise<void>;
  resume(by: string): Promise<void>;
  ignoreItem(itemId: number, by: string): Promise<{ ok: boolean; message?: string }>;
  setParam(key: ParamKey, value: number | string, by: string): Promise<void>;
  forceRefetch(sourceId: string, by: string): Promise<{ ok: boolean; message?: string }>;
  recentRuns(limit?: number): Promise<{ runs: RunLogEntry[]; decisions: DecisionLogEntry[] }>;
  listReview(limit?: number): Promise<ReviewEntry[]>;
}

export interface DraftActionResult {
  replyText: string;
  callbackAlert?: string;
  forceReply?: boolean;
  /** Dipanggil setelah pesan prompt force_reply terkirim agar edit reply dapat dipetakan. */
  onPromptSent?: (promptMessageId: string) => Promise<void> | void;
}

export interface DraftActionHandler {
  handleCallback(data: string, userId: string): Promise<DraftActionResult | null>;
  handleEditReply(
    replyToMessageId: string,
    newText: string,
    userId: string,
    replyToText?: string,
  ): Promise<DraftActionResult | null>;
}

export interface OperatorRouterDeps {
  operatorChatId: string;
  controls: OperatorControls;
  draftActions?: DraftActionHandler;
  brandName?: string;
  now?: () => Date;
}

// ---------- Abstraksi update Telegram (tanpa dependensi jaringan) ----------

export interface UpdateLike {
  message?: {
    message_id?: number | string;
    from?: { id: number | string };
    chat?: { id: number | string };
    text?: string;
    reply_to_message?: {
      message_id: number | string;
      text?: string;
    };
  };
  callback_query?: {
    id: string;
    from?: { id: number | string };
    data?: string;
    message?: {
      message_id: number | string;
      chat?: { id: number | string };
      text?: string;
    };
  };
}

export interface RouterResponse {
  handled: boolean;
  unauthorized?: boolean;
  replyText?: string;
  callbackAlert?: string;
  forceReply?: boolean;
  onPromptSent?: (promptMessageId: string) => Promise<void> | void;
}

// ---------- Utilitas parsing & otorisasi ----------

function isOperator(fromId: number | string | undefined, operatorChatId: string): boolean {
  if (fromId === undefined || fromId === null || !operatorChatId) return false;
  return String(fromId) === String(operatorChatId);
}

function parseCommand(text: string): { command: string; args: string[] } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const parts = trimmed.split(/\s+/);
  const rawCmd = parts[0]!;
  // Buang suffix @botusername bila ada (mis. /status@RadarTomicaBot)
  const command = rawCmd.split('@')[0]!.toLowerCase();
  return { command, args: parts.slice(1) };
}

function parseParamValue(key: ParamKey, raw: string): { ok: true; value: number | string } | { ok: false; error: string } {
  const expectedType = typeof DEFAULT_PARAMS[key];
  if (expectedType === 'number') {
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      return { ok: false, error: `Nilai untuk "${key}" harus berupa angka (diterima: "${raw}").` };
    }
    return { ok: true, value: num };
  }
  return { ok: true, value: raw };
}

// ---------- Router murni ----------

export async function handleUpdate(update: UpdateLike, deps: OperatorRouterDeps): Promise<RouterResponse> {
  const brand = deps.brandName ?? 'Radar Tomica Jepang';
  const now = deps.now ? deps.now() : new Date();

  // 1. Callback query (tombol inline)
  if (update.callback_query) {
    const cb = update.callback_query;
    const fromId = cb.from?.id;
    if (!isOperator(fromId, deps.operatorChatId)) {
      logger.warn(
        { fromId: fromId ?? null, updateType: 'callback_query', data: cb.data },
        'Callback query dari pengguna non-operator diabaikan',
      );
      return { handled: false, unauthorized: true };
    }

    const data = cb.data ?? '';
    if (deps.draftActions) {
      const res = await deps.draftActions.handleCallback(data, String(fromId));
      if (res) {
        return {
          handled: true,
          replyText: res.replyText,
          callbackAlert: res.callbackAlert,
          forceReply: res.forceReply,
          onPromptSent: res.onPromptSent,
        };
      }
    }

    return {
      handled: true,
      callbackAlert: 'Aksi tombol tidak dikenali.',
    };
  }

  // 2. Pesan teks
  if (update.message) {
    const msg = update.message;
    const fromId = msg.from?.id;
    if (!isOperator(fromId, deps.operatorChatId)) {
      logger.warn(
        { fromId: fromId ?? null, chatId: msg.chat?.id ?? null, updateType: 'message' },
        'Pesan dari pengguna non-operator diabaikan',
      );
      return { handled: false, unauthorized: true };
    }

    const text = (msg.text ?? '').trim();
    if (!text) {
      return { handled: false };
    }

    const userId = String(fromId);
    const parsed = parseCommand(text);

    // 2a. Balasan teks untuk edit draf (force_reply)
    if (!parsed && msg.reply_to_message && deps.draftActions) {
      const res = await deps.draftActions.handleEditReply(
        String(msg.reply_to_message.message_id),
        text,
        userId,
        msg.reply_to_message.text,
      );
      if (res) {
        return {
          handled: true,
          replyText: res.replyText,
          forceReply: res.forceReply,
          onPromptSent: res.onPromptSent,
        };
      }
      return { handled: false };
    }

    if (!parsed) {
      return { handled: false };
    }

    // 2b. Perintah operator berbahasa Indonesia
    const { command, args } = parsed;
    switch (command) {
      case '/status': {
        const s = await deps.controls.getStatus();
        const stateText = s.paused ? 'DIJEDA' : 'AKTIF';
        const lastRun = s.lastRunAt ? formatJstWib(s.lastRunAt) : 'belum ada';
        const lines = [
          `[${brand}] Status Sistem`,
          `Waktu: ${formatJstWib(now)}`,
          `Otomasi: ${stateText}`,
          `Sumber aktif: ${s.activeSources} | Dijeda: ${s.pausedSources} | Gagal: ${s.failingSources}`,
          `Draf menunggu persetujuan: ${s.pendingDrafts}`,
          `Antrean REVIEW: ${s.pendingReviews}`,
          `Eksekusi terakhir: ${lastRun}`,
        ];
        return { handled: true, replyText: lines.join('\n') };
      }

      case '/jeda': {
        await deps.controls.pause(userId);
        return {
          handled: true,
          replyText: `[${brand}] Semua otomasi dijeda. Gunakan /lanjut untuk mengaktifkan kembali.`,
        };
      }

      case '/lanjut': {
        await deps.controls.resume(userId);
        return {
          handled: true,
          replyText: `[${brand}] Otomasi dilanjutkan kembali.`,
        };
      }

      case '/abaikan': {
        const rawId = args[0];
        if (!rawId || !/^\d+$/.test(rawId)) {
          return {
            handled: true,
            replyText: 'Format: /abaikan <item_id> (contoh: /abaikan 42)',
          };
        }
        const itemId = Number(rawId);
        const res = await deps.controls.ignoreItem(itemId, userId);
        return {
          handled: true,
          replyText: res.message ?? (res.ok ? `Item #${itemId} ditandai abaikan.` : `Item #${itemId} tidak ditemukan.`),
        };
      }

      case '/ambang': {
        const key = args[0];
        const rawVal = args.slice(1).join(' ');
        if (!key || !rawVal) {
          return {
            handled: true,
            replyText: 'Format: /ambang <param_key> <value> (contoh: /ambang threshold_layak 1.15)',
          };
        }
        if (!(key in DEFAULT_PARAMS)) {
          const validKeys = Object.keys(DEFAULT_PARAMS).join(', ');
          return {
            handled: true,
            replyText: `Parameter "${key}" tidak dikenal.\nDaftar parameter: ${validKeys}`,
          };
        }
        const typedKey = key as ParamKey;
        const parsedVal = parseParamValue(typedKey, rawVal);
        if (!parsedVal.ok) {
          return { handled: true, replyText: parsedVal.error };
        }
        await deps.controls.setParam(typedKey, parsedVal.value, userId);
        return {
          handled: true,
          replyText: `Parameter ${typedKey} diperbarui menjadi ${String(parsedVal.value)}.`,
        };
      }

      case '/ambilulang': {
        const sourceId = args[0];
        if (!sourceId) {
          return {
            handled: true,
            replyText: 'Format: /ambilulang <source_id> (contoh: /ambilulang takaratomy-lineup)',
          };
        }
        const res = await deps.controls.forceRefetch(sourceId, userId);
        return {
          handled: true,
          replyText:
            res.message ??
            (res.ok ? `Pengambilan ulang sumber "${sourceId}" berhasil dijalankan.` : `Sumber "${sourceId}" tidak ditemukan.`),
        };
      }

      case '/log': {
        const { runs, decisions } = await deps.controls.recentRuns(10);
        const lines: string[] = [`[${brand}] Log Eksekusi & Keputusan Terbaru`, `Waktu: ${formatJstWib(now)}`];

        lines.push('', 'Eksekusi terbaru:');
        if (runs.length === 0) {
          lines.push('- Belum ada riwayat eksekusi.');
        } else {
          for (const r of runs) {
            const errPart = r.error ? ` | galat: ${r.error}` : '';
            lines.push(`- #${r.id} ${r.module} [${r.status}] (${r.processed_count} item) — ${formatJstWib(r.started_at)}${errPart}`);
          }
        }

        lines.push('', 'Keputusan evaluasi terbaru:');
        if (decisions.length === 0) {
          lines.push('- Belum ada keputusan evaluasi.');
        } else {
          for (const d of decisions) {
            lines.push(
              `- #${d.item_id} ${d.name_ja}: ${d.label} | rasio ${formatRatio(d.po_ratio)} | PO ${formatIdr(d.po_price_idr)} | acuan ${formatIdr(d.reference_idr)}`,
            );
          }
        }

        return { handled: true, replyText: lines.join('\n') };
      }

      case '/review': {
        const reviews = await deps.controls.listReview(10);
        const lines: string[] = [`[${brand}] Antrean REVIEW (${reviews.length})`];
        if (reviews.length === 0) {
          lines.push('Tidak ada item yang menunggu review.');
        } else {
          for (const rv of reviews) {
            const itemPart = rv.item_id != null ? `Item #${rv.item_id}${rv.item_name ? ` (${rv.item_name})` : ''}` : 'Umum';
            lines.push(`- [#${rv.id}] ${rv.kind} — ${itemPart}: ${rv.reason}`);
          }
        }
        return { handled: true, replyText: lines.join('\n') };
      }

      case '/bantuan':
      case '/help': {
        const lines = [
          `[${brand}] Perintah Operator:`,
          '/status — Status sistem, sumber, draf, dan antrean review',
          '/jeda — Jeda semua otomasi',
          '/lanjut — Lanjutkan otomasi',
          '/abaikan <item_id> — Tandai item agar diabaikan',
          '/ambang <param_key> <value> — Ubah parameter bisnis/ambang',
          '/ambilulang <source_id> — Paksa ambil ulang satu sumber',
          '/log — Lihat log eksekusi dan keputusan terbaru',
          '/review — Lihat daftar item menunggu review',
        ];
        return { handled: true, replyText: lines.join('\n') };
      }

      default:
        return {
          handled: true,
          replyText: `Perintah "${command}" tidak dikenal. Ketik /bantuan untuk daftar perintah.`,
        };
    }
  }

  return { handled: false };
}

// ---------- Bootstrap tipis grammY ----------

export function attachOperatorBot(bot: Bot, deps: OperatorRouterDeps): Bot {
  bot.on('message:text', async (ctx) => {
    const update: UpdateLike = {
      message: {
        message_id: ctx.message.message_id,
        from: ctx.from ? { id: ctx.from.id } : undefined,
        chat: { id: ctx.chat.id },
        text: ctx.message.text,
        reply_to_message: ctx.message.reply_to_message
          ? {
              message_id: ctx.message.reply_to_message.message_id,
              text: 'text' in ctx.message.reply_to_message ? ctx.message.reply_to_message.text : undefined,
            }
          : undefined,
      },
    };
    const res = await handleUpdate(update, deps);
    if (res.unauthorized || !res.handled) return;
    if (res.replyText) {
      const sent = await ctx.reply(res.replyText, {
        ...(res.forceReply ? { reply_markup: { force_reply: true } } : {}),
        link_preview_options: { is_disabled: true },
      });
      if (res.onPromptSent) {
        await res.onPromptSent(String(sent.message_id));
      }
    }
  });

  bot.on('callback_query:data', async (ctx) => {
    const update: UpdateLike = {
      callback_query: {
        id: ctx.callbackQuery.id,
        from: ctx.from ? { id: ctx.from.id } : undefined,
        data: ctx.callbackQuery.data,
        message: ctx.callbackQuery.message
          ? {
              message_id: ctx.callbackQuery.message.message_id,
              chat: { id: ctx.callbackQuery.message.chat.id },
              text: 'text' in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : undefined,
            }
          : undefined,
      },
    };
    const res = await handleUpdate(update, deps);
    if (res.unauthorized || !res.handled) return;
    if (res.callbackAlert) {
      await ctx.answerCallbackQuery({ text: res.callbackAlert });
    } else {
      await ctx.answerCallbackQuery();
    }
    if (res.replyText) {
      const sent = await ctx.reply(res.replyText, {
        ...(res.forceReply ? { reply_markup: { force_reply: true } } : {}),
        link_preview_options: { is_disabled: true },
      });
      if (res.onPromptSent) {
        await res.onPromptSent(String(sent.message_id));
      }
    }
  });

  return bot;
}

export function createOperatorBot(botToken: string, deps: OperatorRouterDeps): Bot {
  const bot = new Bot(botToken);
  return attachOperatorBot(bot, deps);
}
