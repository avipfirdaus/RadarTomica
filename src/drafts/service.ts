/**
 * Manajemen siklus hidup draf & gerbang persetujuan operator (PRD §2 Aturan emas, §4 F9, §5, §9).
 *
 * ATURAN KETAT:
 * 1. Hanya `operatorUserId` yang boleh menyetujui, mengedit, atau menolak draf.
 * 2. `TelegramPort.sendToChannel` HANYA dipanggil di dalam `approveDraft`.
 * 3. Saat Setuju ditekan, bila `data_as_of` lebih tua dari parameter `stale_hours` (24 jam),
 *    panggil `recompute(draft)`. Bila nilai berubah, perbarui draf dan kirim ulang ke operator
 *    untuk persetujuan baru (JANGAN langsung kirim ke channel).
 * 4. Tolak => status `'rejected'` (diarsipkan, tidak pernah terkirim).
 * 5. Edit => operator membalas teks pengganti (`force_reply`), draf diperbarui dan dikirim ulang
 *    untuk persetujuan.
 * 6. Draf kedaluwarsa (`expires_at <= now`) tidak dapat disetujui; `expireOldDrafts(db)` menandai
 *    draf lama menjadi `'expired'`.
 * 7. Jejak audit tersimpan pada tabel `drafts` (prompt_version, params_version, sources, approver).
 */
import { loadParams } from '../config/params.js';
import type { Db } from '../db/client.js';
import { formatJstWib, hoursBetween } from '../shared/time.js';
import type { DraftKind, DraftRow, DraftStatus, LlmClient, TelegramPort } from '../shared/types.js';
import type { DraftActionHandler, DraftActionResult } from '../telegram/operator-bot.js';
import { polishDraftWithP4, TEMPLATE_PROMPT_VERSION } from './p4-polish.js';
import {
  DEFAULT_BRAND_NAME,
  renderDraftTemplate,
  type DraftSourceClaim,
  type DraftTemplateData,
} from './templates.js';

export type DraftCallbackAction = 'ok' | 'edit' | 'no';

export interface ParsedDraftCallback {
  action: DraftCallbackAction;
  draftId: number;
}

export function buildDraftButtons(draftId: number): { text: string; data: string }[][] {
  return [
    [
      { text: 'Setuju', data: `d:ok:${draftId}` },
      { text: 'Edit', data: `d:edit:${draftId}` },
      { text: 'Tolak', data: `d:no:${draftId}` },
    ],
  ];
}

export function parseDraftCallback(data: string): ParsedDraftCallback | null {
  const m = /^d:(ok|edit|no):(\d+)$/.exec(data.trim());
  if (!m) return null;
  return {
    action: m[1] as DraftCallbackAction,
    draftId: Number(m[2]),
  };
}

export interface RecomputeResult {
  changed: boolean;
  newText?: string;
  newDataAsOf?: Date;
  newParamsVersion?: number;
  newSources?: DraftSourceClaim[];
  summary?: string;
}

export type RecomputeDraftFn = (draft: DraftRow) => Promise<RecomputeResult>;

export interface DraftServiceDeps {
  db: Db;
  telegram: TelegramPort;
  operatorUserId: string;
  llm?: LlmClient;
  brandName?: string;
  recompute?: RecomputeDraftFn;
  now?: () => Date;
  defaultExpiryHours?: number;
}

export interface CreateDraftInput {
  kind: DraftKind;
  itemIds: number[];
  data: DraftTemplateData;
  dataAsOf?: Date;
  paramsVersion?: number;
  expiresAt?: Date | null;
  /** Default true bila `deps.llm` tersedia. */
  useP4?: boolean;
}

export type ApproveDraftResult =
  | { status: 'sent'; draft: DraftRow; telegramMessageId: string; message: string }
  | { status: 'reapproval_required'; draft: DraftRow; message: string }
  | { status: 'expired'; draft: DraftRow; message: string }
  | { status: 'unauthorized'; message: string }
  | { status: 'invalid_state'; message: string };

export type RejectDraftResult =
  | { status: 'rejected'; draft: DraftRow; message: string }
  | { status: 'unauthorized'; message: string }
  | { status: 'invalid_state'; message: string };

export type EditDraftResult =
  | { status: 'updated'; draft: DraftRow; message: string }
  | { status: 'unauthorized'; message: string }
  | { status: 'invalid_state'; message: string };

interface RawDraftRow {
  id: number;
  kind: DraftKind;
  item_ids: number[] | string[];
  text: string;
  status: DraftStatus;
  approved_by: string | null;
  approved_at: Date | string | null;
  telegram_message_id: string | null;
  operator_message_id: string | null;
  prompt_version: string | null;
  params_version: number | null;
  sources: DraftSourceClaim[] | string;
  data_as_of: Date | string;
  created_at: Date | string;
  expires_at: Date | string | null;
}

function hydrateDraft(row: RawDraftRow): DraftRow {
  const sources =
    typeof row.sources === 'string'
      ? (JSON.parse(row.sources) as DraftSourceClaim[])
      : (row.sources ?? []);
  return {
    id: Number(row.id),
    kind: row.kind,
    item_ids: (row.item_ids ?? []).map((x) => Number(x)),
    text: row.text,
    status: row.status,
    approved_by: row.approved_by,
    approved_at: row.approved_at ? new Date(row.approved_at) : null,
    telegram_message_id: row.telegram_message_id,
    operator_message_id: row.operator_message_id,
    prompt_version: row.prompt_version,
    params_version: row.params_version != null ? Number(row.params_version) : null,
    sources,
    data_as_of: new Date(row.data_as_of),
    created_at: new Date(row.created_at),
    expires_at: row.expires_at ? new Date(row.expires_at) : null,
  };
}

function isAuthorizedOperator(actorUserId: string, operatorUserId: string): boolean {
  return Boolean(operatorUserId) && String(actorUserId) === String(operatorUserId);
}

function formatOperatorReviewMessage(draft: DraftRow, brandName: string, note?: string): string {
  const headerLines = [
    `[${brandName}] Tinjau Draf #${draft.id} (${draft.kind})`,
    `Data per: ${formatJstWib(draft.data_as_of)}`,
    `Audit: prompt=${draft.prompt_version ?? '-'} | params_v=${draft.params_version ?? 0} | sumber=${draft.sources.length}`,
  ];
  if (draft.expires_at) {
    headerLines.push(`Kedaluwarsa: ${formatJstWib(draft.expires_at)}`);
  }
  if (note) {
    headerLines.push(`Catatan: ${note}`);
  }
  return `${headerLines.join('\n')}\n\n---\n${draft.text}`;
}

export async function getDraftById(db: Db, draftId: number): Promise<DraftRow | null> {
  const { rows } = await db.query<RawDraftRow>('SELECT * FROM drafts WHERE id = $1', [draftId]);
  return rows[0] ? hydrateDraft(rows[0]) : null;
}

/**
 * Membuat draf baru, menyimpannya di tabel `drafts` (status `'draft'`), dan
 * mengirim pesan tinjauan ke chat pribadi operator dengan tombol Setuju/Edit/Tolak.
 */
export async function createDraft(deps: DraftServiceDeps, input: CreateDraftInput): Promise<DraftRow> {
  const now = deps.now ? deps.now() : new Date();
  const brandName = input.data.brandName ?? deps.brandName ?? DEFAULT_BRAND_NAME;
  const templateData: DraftTemplateData = { ...input.data, brandName };

  const rendered = renderDraftTemplate(input.kind, templateData);
  let finalText = rendered.text;
  let promptVersion = TEMPLATE_PROMPT_VERSION;

  if (input.useP4 !== false && deps.llm) {
    const polished = await polishDraftWithP4(deps.llm, rendered.text, templateData, rendered.sources);
    finalText = polished.text;
    promptVersion = polished.promptVersion;
  }

  const paramsVersion =
    input.paramsVersion !== undefined ? input.paramsVersion : (await loadParams(deps.db, now)).version;
  const dataAsOf = input.dataAsOf ?? now;
  const expiryHours = deps.defaultExpiryHours ?? 72;
  const expiresAt =
    input.expiresAt !== undefined
      ? input.expiresAt
      : new Date(now.getTime() + expiryHours * 3_600_000);

  const insertRes = await deps.db.query<RawDraftRow>(
    `INSERT INTO drafts
       (kind, item_ids, text, status, prompt_version, params_version, sources, data_as_of, created_at, expires_at)
     VALUES ($1, $2::bigint[], $3, 'draft', $4, $5, $6::jsonb, $7, $8, $9)
     RETURNING *`,
    [
      input.kind,
      input.itemIds,
      finalText,
      promptVersion,
      paramsVersion,
      JSON.stringify(rendered.sources),
      dataAsOf,
      now,
      expiresAt,
    ],
  );
  let draft = hydrateDraft(insertRes.rows[0]!);

  const reviewMsg = formatOperatorReviewMessage(draft, brandName);
  const { messageId } = await deps.telegram.sendToOperator(reviewMsg, {
    buttons: buildDraftButtons(draft.id),
  });

  const updRes = await deps.db.query<RawDraftRow>(
    `UPDATE drafts SET operator_message_id = $2 WHERE id = $1 RETURNING *`,
    [draft.id, messageId],
  );
  draft = hydrateDraft(updRes.rows[0]!);
  return draft;
}

/**
 * Menyetujui draf dan mengirimkannya ke channel publik.
 * Satu-satunya fungsi yang memanggil `telegram.sendToChannel`.
 */
export async function approveDraft(
  deps: DraftServiceDeps,
  draftId: number,
  actorUserId: string,
): Promise<ApproveDraftResult> {
  if (!isAuthorizedOperator(actorUserId, deps.operatorUserId)) {
    return { status: 'unauthorized', message: 'Akses ditolak: hanya operator yang dapat menyetujui draf.' };
  }

  const now = deps.now ? deps.now() : new Date();
  const brandName = deps.brandName ?? DEFAULT_BRAND_NAME;
  const draft = await getDraftById(deps.db, draftId);
  if (!draft) {
    return { status: 'invalid_state', message: `Draf #${draftId} tidak ditemukan.` };
  }
  if (draft.status !== 'draft') {
    return {
      status: 'invalid_state',
      message: `Draf #${draftId} berstatus "${draft.status}" dan tidak dapat disetujui lagi.`,
    };
  }

  // Cek kedaluwarsa
  if (draft.expires_at && draft.expires_at.getTime() <= now.getTime()) {
    const expRes = await deps.db.query<RawDraftRow>(
      `UPDATE drafts SET status = 'expired' WHERE id = $1 RETURNING *`,
      [draft.id],
    );
    const expired = hydrateDraft(expRes.rows[0]!);
    return {
      status: 'expired',
      draft: expired,
      message: `Draf #${draft.id} sudah kedaluwarsa dan tidak dapat disetujui.`,
    };
  }

  // Cek aturan data basi (> stale_hours, default 24 jam)
  const { values: params } = await loadParams(deps.db, now);
  const ageHours = hoursBetween(draft.data_as_of, now);
  let activeDraft = draft;

  if (ageHours > params.stale_hours) {
    if (!deps.recompute) {
      return {
        status: 'invalid_state',
        message: `Draf #${draft.id} memakai data lebih tua dari ${params.stale_hours} jam, tetapi fungsi hitung ulang belum tersedia.`,
      };
    }
    const recomputed = await deps.recompute(draft);
    const refreshedAsOf = recomputed.newDataAsOf ?? now;
    const refreshedText = recomputed.newText ?? draft.text;
    const refreshedParamsVersion = recomputed.newParamsVersion ?? draft.params_version;
    const refreshedSources = recomputed.newSources ?? draft.sources;

    if (recomputed.changed) {
      const updRes = await deps.db.query<RawDraftRow>(
        `UPDATE drafts
         SET text = $2, data_as_of = $3, params_version = $4, sources = $5::jsonb
         WHERE id = $1
         RETURNING *`,
        [draft.id, refreshedText, refreshedAsOf, refreshedParamsVersion, JSON.stringify(refreshedSources)],
      );
      activeDraft = hydrateDraft(updRes.rows[0]!);

      const note =
        recomputed.summary ??
        `Data lebih tua dari ${params.stale_hours} jam dan nilai berubah setelah dihitung ulang. Mohon tinjau & setujui ulang.`;
      const reviewMsg = formatOperatorReviewMessage(activeDraft, brandName, note);
      const { messageId } = await deps.telegram.sendToOperator(reviewMsg, {
        buttons: buildDraftButtons(activeDraft.id),
      });
      const msgUpd = await deps.db.query<RawDraftRow>(
        `UPDATE drafts SET operator_message_id = $2 WHERE id = $1 RETURNING *`,
        [activeDraft.id, messageId],
      );
      activeDraft = hydrateDraft(msgUpd.rows[0]!);

      return {
        status: 'reapproval_required',
        draft: activeDraft,
        message: `Draf #${activeDraft.id} dihitung ulang karena data > ${params.stale_hours} jam dan nilainya berubah. Draf baru dikirim untuk persetujuan ulang.`,
      };
    }

    // Nilai tidak berubah -> perbarui data_as_of lalu lanjut posting
    const touchRes = await deps.db.query<RawDraftRow>(
      `UPDATE drafts SET data_as_of = $2 WHERE id = $1 RETURNING *`,
      [draft.id, refreshedAsOf],
    );
    activeDraft = hydrateDraft(touchRes.rows[0]!);
  }

  // Satu-satunya jalur publikasi ke channel
  const { messageId: channelMessageId } = await deps.telegram.sendToChannel(activeDraft.text);

  const sentRes = await deps.db.query<RawDraftRow>(
    `UPDATE drafts
     SET status = 'sent',
         approved_by = $2,
         approved_at = $3,
         telegram_message_id = $4
     WHERE id = $1
     RETURNING *`,
    [activeDraft.id, String(actorUserId), now, channelMessageId],
  );
  const sentDraft = hydrateDraft(sentRes.rows[0]!);

  return {
    status: 'sent',
    draft: sentDraft,
    telegramMessageId: channelMessageId,
    message: `Draf #${sentDraft.id} disetujui dan terkirim ke channel (message_id=${channelMessageId}).`,
  };
}

/** Menolak draf (diarsipkan sebagai `'rejected'`, tidak pernah dikirim ke channel). */
export async function rejectDraft(
  deps: DraftServiceDeps,
  draftId: number,
  actorUserId: string,
): Promise<RejectDraftResult> {
  if (!isAuthorizedOperator(actorUserId, deps.operatorUserId)) {
    return { status: 'unauthorized', message: 'Akses ditolak: hanya operator yang dapat menolak draf.' };
  }

  const now = deps.now ? deps.now() : new Date();
  const draft = await getDraftById(deps.db, draftId);
  if (!draft) {
    return { status: 'invalid_state', message: `Draf #${draftId} tidak ditemukan.` };
  }
  if (draft.status !== 'draft') {
    return {
      status: 'invalid_state',
      message: `Draf #${draftId} berstatus "${draft.status}" dan tidak dapat ditolak.`,
    };
  }

  const res = await deps.db.query<RawDraftRow>(
    `UPDATE drafts SET status = 'rejected', approved_by = $2, approved_at = $3 WHERE id = $1 RETURNING *`,
    [draft.id, String(actorUserId), now],
  );
  const rejected = hydrateDraft(res.rows[0]!);

  return {
    status: 'rejected',
    draft: rejected,
    message: `Draf #${rejected.id} ditolak dan diarsipkan.`,
  };
}

/** Mengganti teks draf lalu mengirimkannya kembali ke operator untuk persetujuan. */
export async function editDraft(
  deps: DraftServiceDeps,
  draftId: number,
  newText: string,
  actorUserId: string,
): Promise<EditDraftResult> {
  if (!isAuthorizedOperator(actorUserId, deps.operatorUserId)) {
    return { status: 'unauthorized', message: 'Akses ditolak: hanya operator yang dapat mengedit draf.' };
  }

  const trimmed = newText.trim();
  if (!trimmed) {
    return { status: 'invalid_state', message: 'Teks pengganti tidak boleh kosong.' };
  }

  const now = deps.now ? deps.now() : new Date();
  const brandName = deps.brandName ?? DEFAULT_BRAND_NAME;
  const draft = await getDraftById(deps.db, draftId);
  if (!draft) {
    return { status: 'invalid_state', message: `Draf #${draftId} tidak ditemukan.` };
  }
  if (draft.status !== 'draft') {
    return {
      status: 'invalid_state',
      message: `Draf #${draftId} berstatus "${draft.status}" dan tidak dapat diedit.`,
    };
  }
  if (draft.expires_at && draft.expires_at.getTime() <= now.getTime()) {
    await deps.db.query(`UPDATE drafts SET status = 'expired' WHERE id = $1`, [draft.id]);
    return { status: 'invalid_state', message: `Draf #${draft.id} sudah kedaluwarsa.` };
  }

  const updRes = await deps.db.query<RawDraftRow>(
    `UPDATE drafts SET text = $2 WHERE id = $1 RETURNING *`,
    [draft.id, trimmed],
  );
  let updated = hydrateDraft(updRes.rows[0]!);

  const reviewMsg = formatOperatorReviewMessage(updated, brandName, 'Teks diperbarui oleh operator. Silakan tinjau ulang.');
  const { messageId } = await deps.telegram.sendToOperator(reviewMsg, {
    buttons: buildDraftButtons(updated.id),
  });
  const msgUpd = await deps.db.query<RawDraftRow>(
    `UPDATE drafts SET operator_message_id = $2 WHERE id = $1 RETURNING *`,
    [updated.id, messageId],
  );
  updated = hydrateDraft(msgUpd.rows[0]!);

  return {
    status: 'updated',
    draft: updated,
    message: `Draf #${updated.id} diperbarui dan dikirim ulang untuk persetujuan.`,
  };
}

/** Menandai semua draf berstatus `'draft'` yang sudah melewati `expires_at` menjadi `'expired'`. */
export async function expireOldDrafts(db: Db, now: Date = new Date()): Promise<number[]> {
  const { rows } = await db.query<{ id: number }>(
    `UPDATE drafts
     SET status = 'expired'
     WHERE status = 'draft' AND expires_at IS NOT NULL AND expires_at <= $1
     RETURNING id`,
    [now],
  );
  return rows.map((r) => Number(r.id));
}

/**
 * Menghubungkan tombol inline (`d:ok:<id>`, `d:edit:<id>`, `d:no:<id>`) dan balasan
 * `force_reply` dari bot operator ke alur persetujuan draf.
 */
export function createDraftActionHandler(deps: DraftServiceDeps): DraftActionHandler {
  const pendingEdits = new Map<string, number>();

  return {
    async handleCallback(data: string, userId: string): Promise<DraftActionResult | null> {
      const parsed = parseDraftCallback(data);
      if (!parsed) return null;

      if (!isAuthorizedOperator(userId, deps.operatorUserId)) {
        return {
          replyText: '',
          callbackAlert: 'Akses ditolak.',
        };
      }

      if (parsed.action === 'ok') {
        const res = await approveDraft(deps, parsed.draftId, userId);
        return {
          replyText: res.message,
          callbackAlert: res.status === 'sent' ? 'Draf terkirim ke channel.' : res.message,
        };
      }

      if (parsed.action === 'no') {
        const res = await rejectDraft(deps, parsed.draftId, userId);
        return {
          replyText: res.message,
          callbackAlert: res.status === 'rejected' ? 'Draf ditolak.' : res.message,
        };
      }

      // action === 'edit'
      const draft = await getDraftById(deps.db, parsed.draftId);
      if (!draft || draft.status !== 'draft') {
        return {
          replyText: `Draf #${parsed.draftId} tidak dapat diedit (status: ${draft?.status ?? 'tidak ditemukan'}).`,
          callbackAlert: 'Draf tidak dapat diedit.',
        };
      }

      return {
        replyText: `[Edit Draf #${draft.id}] Balas pesan ini dengan teks pengganti lengkap untuk draf #${draft.id}:`,
        callbackAlert: `Kirim teks baru untuk draf #${draft.id}`,
        forceReply: true,
        onPromptSent: (promptMessageId: string) => {
          pendingEdits.set(promptMessageId, draft.id);
        },
      };
    },

    async handleEditReply(
      replyToMessageId: string,
      newText: string,
      userId: string,
      replyToText?: string,
    ): Promise<DraftActionResult | null> {
      let draftId = pendingEdits.get(replyToMessageId);
      if (draftId === undefined && replyToText) {
        const m = /\[Edit Draf #(\d+)\]/.exec(replyToText);
        if (m) draftId = Number(m[1]);
      }
      if (draftId === undefined) return null;

      pendingEdits.delete(replyToMessageId);
      const res = await editDraft(deps, draftId, newText, userId);
      return { replyText: res.message };
    },
  };
}
