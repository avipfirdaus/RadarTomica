import { describe, expect, it, vi } from 'vitest';
import {
  DryRunTelegram,
  GrammyTelegram,
  escapeHtml,
  escapeMarkdownV2,
  formatIdr,
  formatJpy,
  formatRatio,
  handleUpdate,
  type DraftActionHandler,
  type GrammyApiLike,
  type OperatorControls,
} from './index.js';

function createMockControls() {
  const controls: OperatorControls = {
    getStatus: vi.fn(async () => ({
      paused: false,
      activeSources: 4,
      pausedSources: 1,
      failingSources: 0,
      pendingDrafts: 2,
      pendingReviews: 3,
      lastRunAt: new Date('2026-11-23T23:00:00Z'),
    })),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    ignoreItem: vi.fn(async (id: number) => ({ ok: true, message: `Item #${id} diabaikan.` })),
    setParam: vi.fn(async () => {}),
    forceRefetch: vi.fn(async (sourceId: string) => ({ ok: true, message: `Refetch ${sourceId} selesai.` })),
    recentRuns: vi.fn(async () => ({
      runs: [
        {
          id: 10,
          module: 'ingest',
          started_at: new Date('2026-11-23T21:00:00Z'),
          finished_at: new Date('2026-11-23T21:01:00Z'),
          status: 'ok',
          processed_count: 3,
          error: null,
        },
      ],
      decisions: [
        {
          item_id: 7,
          name_ja: '光岡 M55',
          label: 'LAYAK' as const,
          po_ratio: 1.61,
          po_price_idr: 157000,
          reference_idr: 253000,
          created_at: new Date('2026-11-23T22:30:00Z'),
        },
      ],
    })),
    listReview: vi.fn(async () => [
      {
        id: 1,
        kind: 'classification',
        item_id: 9,
        item_name: 'トミカプレミアム 限定',
        reason: 'Edisi tidak pasti',
        created_at: new Date('2026-11-23T22:00:00Z'),
      },
    ]),
  };
  return controls;
}

describe('telegram formatting', () => {
  it('escapes HTML and MarkdownV2 characters', () => {
    expect(escapeHtml('A & <B> "C"')).toBe('A &amp; &lt;B&gt; &quot;C&quot;');
    expect(escapeMarkdownV2('Rp157.000 (1,5x) [OK]!_')).toBe('Rp157\\.000 \\(1,5x\\) \\[OK\\]\\!\\_');
  });

  it('formats IDR, JPY, and PO ratio', () => {
    expect(formatIdr(157000)).toBe('Rp157.000');
    expect(formatJpy(1100)).toBe('¥1.100');
    expect(formatRatio(1.456)).toBe('1,46x');
  });
});

describe('DryRunTelegram & GrammyTelegram', () => {
  it('DryRunTelegram records operator and channel messages in memory', async () => {
    const tg = new DryRunTelegram();
    const op = await tg.sendToOperator('Halo operator', {
      buttons: [[{ text: 'Setuju', data: 'd:ok:1' }]],
    });
    const ch = await tg.sendToChannel('Postingan publik');

    expect(op.messageId).toBe('dry-op-1');
    expect(ch.messageId).toBe('dry-ch-2');
    expect(tg.operatorMessages).toHaveLength(1);
    expect(tg.channelMessages).toHaveLength(1);
    expect(tg.operatorMessages[0]?.buttons?.[0]?.[0]?.data).toBe('d:ok:1');
  });

  it('GrammyTelegram delegates to grammY Api with InlineKeyboard', async () => {
    const sendMessage = vi.fn(async () => ({ message_id: 99 }));
    const api: GrammyApiLike = { sendMessage };
    const tg = new GrammyTelegram({
      api,
      operatorChatId: '111',
      channelId: '@radartomica',
      parseMode: 'HTML',
    });

    const op = await tg.sendToOperator('Tinjau', {
      buttons: [[{ text: 'Setuju', data: 'd:ok:5' }, { text: 'Tolak', data: 'd:no:5' }]],
    });
    expect(op.messageId).toBe('99');
    expect(sendMessage).toHaveBeenCalledWith(
      '111',
      'Tinjau',
      expect.objectContaining({
        parse_mode: 'HTML',
        reply_markup: expect.anything(),
      }),
    );

    await tg.sendToChannel('Rilis baru');
    expect(sendMessage).toHaveBeenCalledWith(
      '@radartomica',
      'Rilis baru',
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
  });
});

describe('Operator bot security & commands', () => {
  const OPERATOR_ID = '5550001';

  it('ignores commands and callback buttons from non-operator users', async () => {
    const controls = createMockControls();
    const draftActions: DraftActionHandler = {
      handleCallback: vi.fn(async () => ({ replyText: 'should not happen' })),
      handleEditReply: vi.fn(async () => ({ replyText: 'should not happen' })),
    };

    const cmdRes = await handleUpdate(
      { message: { from: { id: '9999999' }, chat: { id: '9999999' }, text: '/jeda' } },
      { operatorChatId: OPERATOR_ID, controls, draftActions },
    );
    expect(cmdRes.unauthorized).toBe(true);
    expect(cmdRes.handled).toBe(false);
    expect(controls.pause).not.toHaveBeenCalled();

    const cbRes = await handleUpdate(
      { callback_query: { id: 'cb1', from: { id: '9999999' }, data: 'd:ok:1' } },
      { operatorChatId: OPERATOR_ID, controls, draftActions },
    );
    expect(cbRes.unauthorized).toBe(true);
    expect(cbRes.handled).toBe(false);
    expect(draftActions.handleCallback).not.toHaveBeenCalled();
  });

  it('dispatches all Indonesian operator commands to OperatorControls', async () => {
    const controls = createMockControls();
    const deps = {
      operatorChatId: OPERATOR_ID,
      controls,
      now: () => new Date('2026-11-23T23:00:00Z'),
    };
    const msg = (text: string) => ({
      message: { from: { id: OPERATOR_ID }, chat: { id: OPERATOR_ID }, text },
    });

    const statusRes = await handleUpdate(msg('/status'), deps);
    expect(controls.getStatus).toHaveBeenCalledTimes(1);
    expect(statusRes.replyText).toContain('Status Sistem');
    expect(statusRes.replyText).toContain('JST');
    expect(statusRes.replyText).toContain('WIB');

    await handleUpdate(msg('/jeda'), deps);
    expect(controls.pause).toHaveBeenCalledWith(OPERATOR_ID);

    await handleUpdate(msg('/lanjut'), deps);
    expect(controls.resume).toHaveBeenCalledWith(OPERATOR_ID);

    await handleUpdate(msg('/abaikan 42'), deps);
    expect(controls.ignoreItem).toHaveBeenCalledWith(42, OPERATOR_ID);

    await handleUpdate(msg('/ambang threshold_layak 1.15'), deps);
    expect(controls.setParam).toHaveBeenCalledWith('threshold_layak', 1.15, OPERATOR_ID);

    await handleUpdate(msg('/ambilulang takaratomy-lineup'), deps);
    expect(controls.forceRefetch).toHaveBeenCalledWith('takaratomy-lineup', OPERATOR_ID);

    const logRes = await handleUpdate(msg('/log'), deps);
    expect(controls.recentRuns).toHaveBeenCalledWith(10);
    expect(logRes.replyText).toContain('ingest');
    expect(logRes.replyText).toContain('光岡 M55');

    const reviewRes = await handleUpdate(msg('/review'), deps);
    expect(controls.listReview).toHaveBeenCalledWith(10);
    expect(reviewRes.replyText).toContain('Edisi tidak pasti');
  });

  it('rejects invalid /ambang keys or non-numeric values without calling setParam', async () => {
    const controls = createMockControls();
    const deps = { operatorChatId: OPERATOR_ID, controls };
    const msg = (text: string) => ({
      message: { from: { id: OPERATOR_ID }, chat: { id: OPERATOR_ID }, text },
    });

    const badKey = await handleUpdate(msg('/ambang unknown_key 10'), deps);
    expect(badKey.replyText).toContain('tidak dikenal');
    expect(controls.setParam).not.toHaveBeenCalled();

    const badVal = await handleUpdate(msg('/ambang threshold_layak bukanangka'), deps);
    expect(badVal.replyText).toContain('harus berupa angka');
    expect(controls.setParam).not.toHaveBeenCalled();
  });
});
