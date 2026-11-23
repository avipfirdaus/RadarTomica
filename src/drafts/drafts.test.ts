import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type Db } from '../db/client.js';
import type { LlmClient } from '../shared/types.js';
import { DryRunTelegram, handleUpdate, type OperatorControls } from '../telegram/index.js';
import {
  P4_PROMPT_VERSION,
  TEMPLATE_PROMPT_VERSION,
  approveDraft,
  createDraft,
  createDraftActionHandler,
  editDraft,
  expireOldDrafts,
  getDraftById,
  rejectDraft,
  renderDraftTemplate,
  type DraftServiceDeps,
  type DraftTemplateData,
} from './index.js';

const OPERATOR_ID = '777001';
const INTRUDER_ID = '999999';

function makePoOpenData(): DraftTemplateData {
  return {
    brandName: 'Radar Tomica Jepang',
    releaseDateJst: '2026-12-19',
    items: [
      {
        itemId: 1,
        tomicaNo: 94,
        nameJa: '光岡 M55',
        nameId: 'Mitsuoka M55',
        edition: 'first',
        releaseDateJst: '2026-12-19',
        priceJpy: 594,
        poPriceIdr: 157000,
        referenceIdr: 253000,
        poRatio: 1.61,
        sourceUrl: 'https://www.takaratomy.co.jp/products/tomica/',
      },
    ],
    poTerms: {
      dpPercent: 50,
      deadline: '15 Des 2026 20:00 JST / 18:00 WIB',
      contactMethod: 'Isi formulir PO resmi Radar Tomica Jepang (tautan di pesan sematan)',
      taxNote: 'Selisih pajak impor batch #1 ditanggung penyelenggara sesuai ketentuan batch.',
    },
    sources: [
      { claim: 'Lineup resmi & harga JP', url: 'https://www.takaratomy.co.jp/products/tomica/' },
    ],
  };
}

function makeStubLlm(returnText: string): LlmClient {
  return {
    complete: vi.fn(async () => ({
      text: returnText,
      inputTokens: 100,
      outputTokens: 120,
      model: 'mock-claude',
    })),
  };
}

describe('drafts templates & P4 validation', () => {
  it('renders po_open with price, DP, deadline, contact method, source URL, disclaimer, and no hype', () => {
    const { text, sources } = renderDraftTemplate('po_open', makePoOpenData());
    expect(text).toContain('Rp157.000');
    expect(text).toContain('DP 50%: Rp78.500');
    expect(text).toContain('15 Des 2026 20:00 JST / 18:00 WIB');
    expect(text).toContain('formulir PO resmi Radar Tomica Jepang');
    expect(text).toContain('https://www.takaratomy.co.jp/products/tomica/');
    expect(text).toContain('tidak resmi dan tidak berafiliasi dengan Takara Tomy');
    expect(sources).toHaveLength(1);
  });

  it('renders monthly_release, reminder, and po_close templates', () => {
    const data = makePoOpenData();
    const monthly = renderDraftTemplate('monthly_release', { ...data, monthLabel: 'Desember 2026' });
    expect(monthly.text).toContain('Info Rilis Tomica — Desember 2026');
    expect(monthly.text).toContain('¥594');

    const reminder = renderDraftTemplate('reminder', { ...data, daysBeforeRelease: 7 });
    expect(reminder.text).toContain('Pengingat Rilis H-7 Tomica');

    const close = renderDraftTemplate('po_close', data);
    expect(close.text).toContain('PO Ditutup');
    expect(close.text).toContain('tidak resmi');
  });
});

describe('drafts lifecycle & approval gate (F9)', () => {
  let db: Db;
  let telegram: DryRunTelegram;
  let currentTime: Date;

  beforeEach(async () => {
    db = await createTestDb();
    telegram = new DryRunTelegram();
    currentTime = new Date('2026-12-10T00:00:00Z');
  });

  afterEach(async () => {
    await db.close();
  });

  function makeDeps(overrides?: Partial<DraftServiceDeps>): DraftServiceDeps {
    return {
      db,
      telegram,
      operatorUserId: OPERATOR_ID,
      brandName: 'Radar Tomica Jepang',
      now: () => currentTime,
      ...overrides,
    };
  }

  it('falls back to pure template when P4 LLM alters a number or adds hype', async () => {
    const { text: pureTemplate } = renderDraftTemplate('po_open', makePoOpenData());
    // LLM mengubah Rp157.000 menjadi Rp165.000
    const badNumberLlm = makeStubLlm(pureTemplate.replace('Rp157.000', 'Rp165.000'));

    const draft1 = await createDraft(makeDeps({ llm: badNumberLlm }), {
      kind: 'po_open',
      itemIds: [1],
      data: makePoOpenData(),
    });
    expect(draft1.prompt_version).toBe(TEMPLATE_PROMPT_VERSION);
    expect(draft1.text).toContain('Rp157.000');
    expect(draft1.text).not.toContain('Rp165.000');

    // LLM menambahkan klaim hype terlarang
    const hypeLlm = makeStubLlm(`${pureTemplate}\nSegera pesan, dijamin langka dan pasti naik harga!`);
    const draft2 = await createDraft(makeDeps({ llm: hypeLlm }), {
      kind: 'po_open',
      itemIds: [1],
      data: makePoOpenData(),
    });
    expect(draft2.prompt_version).toBe(TEMPLATE_PROMPT_VERSION);
    expect(draft2.text).not.toContain('dijamin langka');

    // LLM yang patuh (angka sama, sumber & disclaimer utuh) diterima dengan P4@1
    const goodPolished = pureTemplate.replace('Daftar item & harga PO:', 'Pilihan model PO batch ini:');
    const goodLlm = makeStubLlm(goodPolished);
    const draft3 = await createDraft(makeDeps({ llm: goodLlm }), {
      kind: 'po_open',
      itemIds: [1],
      data: makePoOpenData(),
    });
    expect(draft3.prompt_version).toBe(P4_PROMPT_VERSION);
    expect(draft3.text).toContain('Pilihan model PO batch ini:');
  });

  it('never posts to channel without operator approval and blocks non-operator approvals', async () => {
    const deps = makeDeps();
    const draft = await createDraft(deps, {
      kind: 'po_open',
      itemIds: [1],
      data: makePoOpenData(),
    });

    expect(draft.status).toBe('draft');
    expect(telegram.channelMessages).toHaveLength(0);
    expect(telegram.operatorMessages).toHaveLength(1);
    expect(telegram.operatorMessages[0]?.buttons?.[0]?.map((b) => b.data)).toEqual([
      `d:ok:${draft.id}`,
      `d:edit:${draft.id}`,
      `d:no:${draft.id}`,
    ]);

    // Non-operator mencoba approve -> ditolak, tidak posting ke channel
    const unauth = await approveDraft(deps, draft.id, INTRUDER_ID);
    expect(unauth.status).toBe('unauthorized');
    expect(telegram.channelMessages).toHaveLength(0);

    // Operator menyetujui -> terkirim ke channel + jejak audit tersimpan
    const approved = await approveDraft(deps, draft.id, OPERATOR_ID);
    expect(approved.status).toBe('sent');
    expect(telegram.channelMessages).toHaveLength(1);
    expect(telegram.channelMessages[0]?.text).toBe(draft.text);

    const saved = await getDraftById(db, draft.id);
    expect(saved?.status).toBe('sent');
    expect(saved?.approved_by).toBe(OPERATOR_ID);
    expect(saved?.approved_at).toBeInstanceOf(Date);
    expect(saved?.telegram_message_id).toBeTruthy();
    expect(saved?.sources).toHaveLength(1);
  });

  it('reject archives the draft and never sends to channel', async () => {
    const deps = makeDeps();
    const draft = await createDraft(deps, {
      kind: 'monthly_release',
      itemIds: [1],
      data: { ...makePoOpenData(), monthLabel: 'Desember 2026' },
    });

    const rej = await rejectDraft(deps, draft.id, OPERATOR_ID);
    expect(rej.status).toBe('rejected');
    expect(telegram.channelMessages).toHaveLength(0);

    const after = await approveDraft(deps, draft.id, OPERATOR_ID);
    expect(after.status).toBe('invalid_state');
    expect(telegram.channelMessages).toHaveLength(0);
  });

  it('triggers recompute and requires fresh approval when data_as_of is older than 24h and values changed', async () => {
    const staleDate = new Date('2026-12-08T00:00:00Z'); // 48 jam sebelum currentTime
    const recompute = vi.fn(async (d) => ({
      changed: true,
      newText: d.text.replace('Rp157.000', 'Rp162.000'),
      newDataAsOf: currentTime,
      newParamsVersion: 2,
      summary: 'Kurs berubah, HargaPO naik dari Rp157.000 menjadi Rp162.000.',
    }));

    const deps = makeDeps({ recompute });
    const draft = await createDraft(deps, {
      kind: 'po_open',
      itemIds: [1],
      data: makePoOpenData(),
      dataAsOf: staleDate,
    });

    // Persetujuan pertama pada data basi -> recompute jalan, nilai berubah -> minta persetujuan ulang, BELUM posting!
    const firstTry = await approveDraft(deps, draft.id, OPERATOR_ID);
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(firstTry.status).toBe('reapproval_required');
    expect(telegram.channelMessages).toHaveLength(0);
    expect(telegram.operatorMessages).toHaveLength(2);
    expect(telegram.operatorMessages[1]?.text).toContain('Rp162.000');

    // Persetujuan kedua dengan data segar -> baru diposting ke channel
    const secondTry = await approveDraft(deps, draft.id, OPERATOR_ID);
    expect(secondTry.status).toBe('sent');
    expect(telegram.channelMessages).toHaveLength(1);
    expect(telegram.channelMessages[0]?.text).toContain('Rp162.000');
  });

  it('supports edit flow via force_reply and re-presents draft for approval', async () => {
    const deps = makeDeps();
    const draft = await createDraft(deps, {
      kind: 'reminder',
      itemIds: [1],
      data: { ...makePoOpenData(), daysBeforeRelease: 3 },
    });

    const draftActions = createDraftActionHandler(deps);
    const dummyControls = {} as OperatorControls;

    // 1. Operator klik tombol Edit
    const editPrompt = await handleUpdate(
      { callback_query: { id: 'cb-edit', from: { id: OPERATOR_ID }, data: `d:edit:${draft.id}` } },
      { operatorChatId: OPERATOR_ID, controls: dummyControls, draftActions },
    );
    expect(editPrompt.forceReply).toBe(true);
    expect(editPrompt.replyText).toContain(`[Edit Draf #${draft.id}]`);
    await editPrompt.onPromptSent?.('prompt-msg-10');

    // 2. Operator membalas dengan teks pengganti
    const editedText = '[Radar Tomica Jepang] Teks pengingat yang sudah diedit.\nCatatan: Channel ini tidak resmi dan tidak berafiliasi dengan Takara Tomy.';
    const replyRes = await handleUpdate(
      {
        message: {
          from: { id: OPERATOR_ID },
          chat: { id: OPERATOR_ID },
          text: editedText,
          reply_to_message: { message_id: 'prompt-msg-10', text: editPrompt.replyText },
        },
      },
      { operatorChatId: OPERATOR_ID, controls: dummyControls, draftActions },
    );
    expect(replyRes.handled).toBe(true);
    expect(telegram.channelMessages).toHaveLength(0);
    expect(telegram.operatorMessages).toHaveLength(2);
    expect(telegram.operatorMessages[1]?.text).toContain('Teks pengingat yang sudah diedit.');

    // 3. Operator menyetujui hasil edit
    const approveRes = await handleUpdate(
      { callback_query: { id: 'cb-ok', from: { id: OPERATOR_ID }, data: `d:ok:${draft.id}` } },
      { operatorChatId: OPERATOR_ID, controls: dummyControls, draftActions },
    );
    expect(approveRes.handled).toBe(true);
    expect(telegram.channelMessages).toHaveLength(1);
    expect(telegram.channelMessages[0]?.text).toBe(editedText);
  });

  it('prevents approving expired drafts and expireOldDrafts marks them expired', async () => {
    const deps = makeDeps();
    const draft = await createDraft(deps, {
      kind: 'po_close',
      itemIds: [1],
      data: makePoOpenData(),
      expiresAt: new Date('2026-12-10T01:00:00Z'),
    });

    // Majukan waktu melewati expires_at
    currentTime = new Date('2026-12-10T02:00:00Z');
    const expTry = await approveDraft(deps, draft.id, OPERATOR_ID);
    expect(expTry.status).toBe('expired');
    expect(telegram.channelMessages).toHaveLength(0);

    // Buat draf kedua yang juga sudah lewat waktunya dan uji expireOldDrafts(db)
    const draft2 = await createDraft(deps, {
      kind: 'po_close',
      itemIds: [1],
      data: makePoOpenData(),
      expiresAt: new Date('2026-12-10T01:30:00Z'),
    });
    const expiredIds = await expireOldDrafts(db, currentTime);
    expect(expiredIds).toContain(draft2.id);

    const saved2 = await getDraftById(db, draft2.id);
    expect(saved2?.status).toBe('expired');

    // Edit pada draf kedaluwarsa juga ditolak
    const editRes = await editDraft(deps, draft2.id, 'teks baru', OPERATOR_ID);
    expect(editRes.status).toBe('invalid_state');
  });
});
