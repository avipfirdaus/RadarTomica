import { describe, it, expect } from 'vitest';
import { MockLlmClient } from '../extract/llm/mock.js';
import { P2_PROMPT_VERSION } from '../extract/prompts/p2.js';
import { classifyDeterministic, classifyItem, isWithinReleaseWeek } from './index.js';

describe('isWithinReleaseWeek', () => {
  it('returns true within the same ISO week (Mon–Sun JST) and false outside', () => {
    // 2026-12-19 is Saturday (3rd Saturday of Dec 2026); ISO week is Mon 2026-12-14 .. Sun 2026-12-20
    expect(isWithinReleaseWeek('2026-12-19', '2026-12-14')).toBe(true);
    expect(isWithinReleaseWeek('2026-12-19', '2026-12-19')).toBe(true);
    expect(isWithinReleaseWeek('2026-12-19', '2026-12-20')).toBe(true);
    expect(isWithinReleaseWeek('2026-12-19', '2026-12-13')).toBe(false);
    expect(isWithinReleaseWeek('2026-12-19', '2026-12-21')).toBe(false);
    expect(isWithinReleaseWeek('2026-12-19', '2026-11-23')).toBe(false);
  });
});

describe('classifyDeterministic (PRD §5)', () => {
  it('classifies First Edition ONLY when text has 初回特別仕様/First Edition AND within release week', () => {
    const within = classifyDeterministic({
      item: {
        tomica_no: 36,
        name_ja: 'ホンダ プレリュード（初回特別仕様）',
        name_id: null,
        edition: 'first',
        release_date_jst: '2026-12-19',
      },
      sourceText: 'No.36 ホンダ プレリュード 初回特別仕様 2026年12月19日発売',
      referenceDateJst: '2026-12-17',
    });
    expect(within.edition).toBe('first');
    expect(within.offerablePerModel).toBe(true);
    expect(within.needsReview).toBe(false);

    // Outside release week (2 weeks later) => NOT first edition!
    const outsideAfter = classifyDeterministic({
      item: {
        tomica_no: 36,
        name_ja: 'ホンダ プレリュード（初回特別仕様）',
        name_id: null,
        edition: 'first',
        release_date_jst: '2026-12-19',
      },
      sourceText: 'No.36 ホンダ プレリュード First Edition',
      referenceDateJst: '2027-01-05',
    });
    expect(outsideAfter.edition).not.toBe('first');
    expect(outsideAfter.edition).toBe('regular');
    expect(outsideAfter.needsReview).toBe(false);

    // Outside release week (month earlier) => NOT first edition!
    const outsideBefore = classifyDeterministic({
      item: {
        tomica_no: 36,
        name_ja: 'ホンダ プレリュード（初回特別仕様）',
        name_id: null,
        edition: 'first',
        release_date_jst: '2026-12-19',
      },
      sourceText: 'No.36 ホンダ プレリュード 初回特別仕様',
      referenceDateJst: '2026-11-23',
    });
    expect(outsideBefore.edition).not.toBe('first');
    expect(outsideBefore.edition).toBe('regular');
  });

  it('classifies Premium and Premium Unlimited', () => {
    const premium = classifyDeterministic({
      item: { tomica_no: 21, name_ja: 'トヨタ ソアラ', name_id: null, edition: 'unknown', release_date_jst: '2026-12-19' },
      sourceText: 'トミカプレミアム 21 トヨタ ソアラ 1,100円（税込）',
    });
    expect(premium.edition).toBe('premium');
    expect(premium.offerablePerModel).toBe(true);

    const unlimited = classifyDeterministic({
      item: { tomica_no: null, name_ja: 'AE86 トレノ', name_id: null, edition: 'unknown', release_date_jst: '2027-01-16' },
      sourceText: 'トミカプレミアム アンリミテッド 頭文字D AE86',
    });
    expect(unlimited.edition).toBe('premium_unlimited');
    expect(unlimited.offerablePerModel).toBe(true);
  });

  it('classifies store-exclusive as non-offerable unless operatorAllowedPo is true', () => {
    const blocked = classifyDeterministic({
      item: { tomica_no: null, name_ja: 'イオンオリジナル GRヤリス', name_id: null, edition: 'unknown', release_date_jst: '2027-01-01' },
      sourceText: 'イオン店舗限定モデル',
    });
    expect(blocked.edition).toBe('exclusive');
    expect(blocked.isStoreExclusive).toBe(true);
    expect(blocked.offerablePerModel).toBe(false);

    const allowed = classifyDeterministic({
      item: { tomica_no: null, name_ja: 'イオンオリジナル GRヤリス', name_id: null, edition: 'unknown', release_date_jst: '2027-01-01' },
      sourceText: 'イオン店舗限定モデル',
      operatorAllowedPo: true,
    });
    expect(allowed.isStoreExclusive).toBe(true);
    expect(allowed.offerablePerModel).toBe(true);
  });

  it('classifies random/kuji/New Year mystery boxes and sets as non-offerable per model', () => {
    const kuji = classifyDeterministic({
      item: { tomica_no: null, name_ja: '福舞トミカ', name_id: null, edition: 'unknown', release_date_jst: '2026-12-26' },
      sourceText: '新春シリーズ 福舞トミカ ブラインドパッケージ ランダム封入',
    });
    expect(kuji.edition).toBe('random');
    expect(kuji.offerablePerModel).toBe(false);

    const giftSet = classifyDeterministic({
      item: { tomica_no: null, name_ja: '緊急車両コレクション 4台セット', name_id: null, edition: 'unknown', release_date_jst: '2026-12-19' },
      sourceText: 'トミカギフト 4台セット',
    });
    expect(giftSet.edition).toBe('set');
    expect(giftSet.offerablePerModel).toBe(false);
  });

  it('classifies collab items', () => {
    const collab = classifyDeterministic({
      item: { tomica_no: null, name_ja: 'ドリームトミカ SP ちいかわ', name_id: null, edition: 'unknown', release_date_jst: '2026-12-19' },
      sourceText: 'ドリームトミカ コラボ新商品',
    });
    expect(collab.edition).toBe('collab');
    expect(collab.offerablePerModel).toBe(true);
  });
});

describe('classifyItem with P2 fallback', () => {
  it('does not call LLM when deterministic rules succeed', async () => {
    const llm = new MockLlmClient();
    const res = await classifyItem(
      { llm },
      {
        item: { tomica_no: 94, name_ja: '光岡 M55', name_id: null, edition: 'regular', release_date_jst: '2026-04-18' },
        sourceText: 'No.94 光岡 M55 通常版',
      },
    );
    expect(res.edition).toBe('regular');
    expect(res.usedLlm).toBe(false);
    expect(llm.calls).toHaveLength(0);
  });

  it('calls P2 when rules are ambiguous and propagates needsReview when P2 is unsure', async () => {
    const llm = new MockLlmClient({
      byTask: {
        P2: JSON.stringify({
          edition: 'unknown',
          reason: 'Teks sumber tidak menyebutkan seri maupun edisi secara jelas.',
          needs_review: true,
        }),
      },
    });

    const res = await classifyItem(
      { llm },
      {
        item: { tomica_no: null, name_ja: '特別企画モデル X', name_id: null, edition: 'unknown', release_date_jst: null },
        sourceText: '新作モデル X が今冬登場予定。詳細は後日発表。',
      },
    );

    expect(res.usedLlm).toBe(true);
    expect(res.promptVersion).toBe(P2_PROMPT_VERSION);
    expect(res.edition).toBe('unknown');
    expect(res.needsReview).toBe(true);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.task).toBe('P2');
  });

  it('resolves ambiguous item via P2 when P2 returns a confident edition', async () => {
    const llm = new MockLlmClient({
      byTask: {
        P2: JSON.stringify({
          edition: 'collab',
          reason: 'Produk merupakan kolaborasi resmi dengan waralaba film.',
          needs_review: false,
        }),
      },
    });

    const res = await classifyItem(
      { llm },
      {
        item: { tomica_no: null, name_ja: '劇場版スペシャルカー', name_id: null, edition: 'unknown', release_date_jst: '2027-02-20' },
        sourceText: '映画公開記念スペシャルカー発売決定。',
      },
    );

    expect(res.usedLlm).toBe(true);
    expect(res.edition).toBe('collab');
    expect(res.needsReview).toBe(false);
    expect(res.offerablePerModel).toBe(true);
  });
});
