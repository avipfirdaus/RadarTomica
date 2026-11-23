import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type Db } from '../db/client.js';
import type { EventRow, ExtractedItem, ItemRow } from '../shared/types.js';
import {
  buildCanonicalKey,
  getPublishableFields,
  normalizeNameJa,
  normalizePriceJpy,
  normalizeReleaseDateJst,
  normalizeTomicaNo,
  slugifyName,
  upsertExtractedItems,
} from './index.js';

function makeItem(overrides: Partial<ExtractedItem> = {}): ExtractedItem {
  return {
    tomica_no: 94,
    name_ja: 'トミカ No.94 光岡 M55',
    name_id: 'Mitsuoka M55',
    edition: 'regular',
    release_date_jst: '2026-04-18',
    price_jpy_tax_incl: 594,
    replaces: '日産 セレナ',
    evidence: [
      { field: 'price_jpy_tax_incl', quote_ja: '希望小売価格 594円（税込）', source_url: 'https://takaratomy.co.jp/p1' },
      { field: 'release_date_jst', quote_ja: '2026年4月18日発売', source_url: 'https://takaratomy.co.jp/p1' },
    ],
    confidence: 'high',
    needs_review: false,
    ...overrides,
  };
}

describe('F3 normalization (pure)', () => {
  it('normalizes full/half width, whitespace, and common prefixes in name_ja', () => {
    expect(normalizeNameJa('　トミカ　Ｎｏ．９４　光岡　Ｍ５５　')).toBe('光岡 M55');
    expect(normalizeNameJa('トミカNo.94 光岡 M55')).toBe('光岡 M55');
    expect(normalizeNameJa('トミカプレミアム 12 ﾗﾝﾎﾞﾙｷﾞｰﾆ ｶｳﾝﾀｯｸ')).toBe('12 ランボルギーニ カウンタック');
    expect(normalizeNameJa('TOMICA No. 17 フェラーリ ローマ')).toBe('フェラーリ ローマ');
    expect(normalizeNameJa('トミカワールド びゅんびゅんサーキット')).toBe('トミカワールド びゅんびゅんサーキット');
  });

  it('normalizes tomica_no from numbers and strings', () => {
    expect(normalizeTomicaNo(94)).toBe(94);
    expect(normalizeTomicaNo('Ｎｏ．０９４')).toBe(94);
    expect(normalizeTomicaNo('No. 17')).toBe(17);
    expect(normalizeTomicaNo(null)).toBeNull();
    expect(normalizeTomicaNo(0)).toBeNull();
  });

  it('normalizes release dates to ISO JST date', () => {
    expect(normalizeReleaseDateJst('2026-04-18')).toBe('2026-04-18');
    expect(normalizeReleaseDateJst('2026年4月18日')).toBe('2026-04-18');
    expect(normalizeReleaseDateJst('２０２６／４／１８')).toBe('2026-04-18');
    // 2026-04-17T15:00:00Z = 2026-04-18 00:00:00 JST
    expect(normalizeReleaseDateJst('2026-04-17T15:00:00Z')).toBe('2026-04-18');
    expect(normalizeReleaseDateJst('invalid')).toBeNull();
  });

  it('normalizes prices to tax-included integer JPY (converting 税抜 with 10% tax)', () => {
    expect(normalizePriceJpy(594)).toBe(594);
    expect(normalizePriceJpy('￥594（税込）')).toBe(594);
    expect(normalizePriceJpy('540円（税抜）')).toBe(594);
    expect(normalizePriceJpy('1,000円+税')).toBe(1100);
    expect(normalizePriceJpy(540, { taxExcluded: true })).toBe(594);
    expect(normalizePriceJpy(null)).toBeNull();
  });

  it('builds deterministic canonical_key from slug(name_ja) + edition + release_date', () => {
    expect(slugifyName('トミカ No.94 光岡 Ｍ５５')).toBe('光岡-m55');
    expect(buildCanonicalKey('トミカ No.94 光岡 M55', 'regular', '2026-04-18')).toBe(
      '光岡-m55:regular:2026-04-18',
    );
    expect(buildCanonicalKey('ディズニー ミッキー', 'collab', null)).toBe(
      'ディズニー-ミッキー:collab:tbd',
    );
  });
});

describe('F3 upsert, dedup, data quality & F4 change detection (DB)', () => {
  let db: Db;
  let snapP1: number;
  let snapP2a: number;
  let snapP2b: number;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.query('TRUNCATE review_queue, events, item_sources, prices, evaluations, items, snapshots, sources RESTART IDENTITY CASCADE');

    await db.query(
      `INSERT INTO sources (id, name, url, priority, kind, schedule) VALUES
       ('tt-official', 'Takara Tomy Official', 'https://takaratomy.co.jp/tomica', 1, 'page', 'p1'),
       ('motor-fan', 'Motor-Fan', 'https://motor-fan.jp', 2, 'feed', 'p2'),
       ('car-watch', 'Car Watch', 'https://car.watch.impress.co.jp', 2, 'feed', 'p2')`,
    );

    const s1 = await db.query<{ id: number }>(
      `INSERT INTO snapshots (source_id, content_hash, raw_text, final_url)
       VALUES ('tt-official', 'h1', 'raw1', 'https://takaratomy.co.jp/p1') RETURNING id`,
    );
    const s2 = await db.query<{ id: number }>(
      `INSERT INTO snapshots (source_id, content_hash, raw_text, final_url)
       VALUES ('motor-fan', 'h2', 'raw2', 'https://motor-fan.jp/art1') RETURNING id`,
    );
    const s3 = await db.query<{ id: number }>(
      `INSERT INTO snapshots (source_id, content_hash, raw_text, final_url)
       VALUES ('car-watch', 'h3', 'raw3', 'https://car.watch.impress.co.jp/art1') RETURNING id`,
    );
    snapP1 = s1.rows[0]!.id;
    snapP2a = s2.rows[0]!.id;
    snapP2b = s3.rows[0]!.id;
  });

  it('deduplicates same physical item across sources and is idempotent on re-run', async () => {
    const first = await upsertExtractedItems(db, {
      snapshotId: snapP1,
      sourceId: 'tt-official',
      sourcePriority: 1,
      sourceUrl: 'https://takaratomy.co.jp/p1',
      items: [{ ...makeItem(), promptVersion: 'p1-v1' }],
    });
    expect(first.createdIds).toHaveLength(1);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]!.kind).toBe('new');
    expect(first.events[0]!.important).toBe(true);

    // Re-running with identical data creates 0 events and 0 duplicate items
    const rerun = await upsertExtractedItems(db, {
      snapshotId: snapP1,
      sourceId: 'tt-official',
      sourcePriority: 1,
      sourceUrl: 'https://takaratomy.co.jp/p1',
      items: [{ ...makeItem(), promptVersion: 'p1-v1' }],
    });
    expect(rerun.unchangedIds).toEqual(first.createdIds);
    expect(rerun.events).toHaveLength(0);

    // Second source with full-width formatting merges into the same item
    const second = await upsertExtractedItems(db, {
      snapshotId: snapP2a,
      sourceId: 'motor-fan',
      sourcePriority: 2,
      sourceUrl: 'https://motor-fan.jp/art1',
      items: [
        makeItem({
          name_ja: 'Ｎｏ．９４　光岡　Ｍ５５',
          name_id: null,
        }),
      ],
    });
    expect(second.createdIds).toHaveLength(0);
    expect(second.unchangedIds).toEqual(first.createdIds);
    expect(second.events).toHaveLength(0);

    const { rows: allItems } = await db.query<ItemRow>('SELECT * FROM items');
    expect(allItems).toHaveLength(1);
    expect(allItems[0]!.name_ja).toBe('光岡 M55');
  });

  it('skips items without name_ja and records them in review_queue', async () => {
    const res = await upsertExtractedItems(db, {
      snapshotId: snapP1,
      sourceId: 'tt-official',
      sourcePriority: 1,
      sourceUrl: 'https://takaratomy.co.jp/p1',
      items: [makeItem({ name_ja: null }), makeItem({ name_ja: '   ' })],
    });
    expect(res.createdIds).toHaveLength(0);
    expect(res.skippedCount).toBe(2);

    const { rows: rq } = await db.query<{ kind: string }>('SELECT kind FROM review_queue');
    expect(rq).toHaveLength(2);
    expect(rq[0]!.kind).toBe('missing_name_ja');
  });

  it('respects items.ignored and emits no events for ignored items', async () => {
    const created = await upsertExtractedItems(db, {
      snapshotId: snapP1,
      sourceId: 'tt-official',
      sourcePriority: 1,
      sourceUrl: 'https://takaratomy.co.jp/p1',
      items: [makeItem()],
    });
    const itemId = created.createdIds[0]!;
    await db.query('UPDATE items SET ignored = true WHERE id = $1', [itemId]);

    const next = await upsertExtractedItems(db, {
      snapshotId: snapP1,
      sourceId: 'tt-official',
      sourcePriority: 1,
      sourceUrl: 'https://takaratomy.co.jp/p1',
      items: [makeItem({ price_jpy_tax_incl: 660 })],
    });
    expect(next.ignoredIds).toEqual([itemId]);
    expect(next.events).toHaveLength(0);

    const { rows } = await db.query<ItemRow>('SELECT price_jpy FROM items WHERE id = $1', [itemId]);
    expect(rows[0]!.price_jpy).toBe(594);
  });

  it('enforces priority-1 wins over priority-2 conflicts and evaluates publishable fields (PRD §5)', async () => {
    // 1. Single priority-2 source -> NOT publishable yet
    const r1 = await upsertExtractedItems(db, {
      snapshotId: snapP2a,
      sourceId: 'motor-fan',
      sourcePriority: 2,
      sourceUrl: 'https://motor-fan.jp/art1',
      items: [makeItem({ price_jpy_tax_incl: 600, release_date_jst: '2026-04-18' })],
    });
    const itemId = r1.createdIds[0]!;

    const pub1 = await getPublishableFields(db, itemId);
    expect(pub1.price_jpy.publishable).toBe(false);
    expect(pub1.release_date_jst.publishable).toBe(false);

    // 2. Second priority-2 source confirms same price & date -> publishable!
    await upsertExtractedItems(db, {
      snapshotId: snapP2b,
      sourceId: 'car-watch',
      sourcePriority: 2,
      sourceUrl: 'https://car.watch.impress.co.jp/art1',
      items: [makeItem({ price_jpy_tax_incl: 600, release_date_jst: '2026-04-18' })],
    });

    const pub2 = await getPublishableFields(db, itemId);
    expect(pub2.price_jpy.publishable).toBe(true);
    expect(pub2.price_jpy.value).toBe(600);
    expect(pub2.price_jpy.basis).toBe('priority_2_corroborated');
    expect(pub2.price_jpy.confirmingSources).toHaveLength(2);
    expect(pub2.release_date_jst.publishable).toBe(true);
    expect(pub2.release_date_jst.value).toBe('2026-04-18');

    // 3. Priority-1 official source arrives with ¥594 -> overrides priority-2 conflict & emits price event
    const r3 = await upsertExtractedItems(db, {
      snapshotId: snapP1,
      sourceId: 'tt-official',
      sourcePriority: 1,
      sourceUrl: 'https://takaratomy.co.jp/p1',
      items: [makeItem({ price_jpy_tax_incl: 594, release_date_jst: '2026-04-18' })],
    });
    expect(r3.events.some((e) => e.kind === 'price' && e.old_value === 600 && e.new_value === 594)).toBe(true);

    const pub3 = await getPublishableFields(db, itemId);
    expect(pub3.price_jpy.publishable).toBe(true);
    expect(pub3.price_jpy.value).toBe(594);
    expect(pub3.price_jpy.basis).toBe('priority_1');

    // 4. Subsequent priority-2 source with conflicting price ¥650 CANNOT overwrite priority-1 item value
    const s4 = await db.query<{ id: number }>(
      `INSERT INTO snapshots (source_id, content_hash, raw_text, final_url)
       VALUES ('motor-fan', 'h4', 'raw4', 'https://motor-fan.jp/art2') RETURNING id`,
    );
    const r4 = await upsertExtractedItems(db, {
      snapshotId: s4.rows[0]!.id,
      sourceId: 'motor-fan',
      sourcePriority: 2,
      sourceUrl: 'https://motor-fan.jp/art2',
      items: [makeItem({ price_jpy_tax_incl: 650, release_date_jst: '2026-04-18' })],
    });
    expect(r4.events).toHaveLength(0);
    const { rows } = await db.query<ItemRow>('SELECT price_jpy FROM items WHERE id = $1', [itemId]);
    expect(rows[0]!.price_jpy).toBe(594);
  });

  it('records F4 events for date, price, edition (special -> important), and cancelled', async () => {
    const r1 = await upsertExtractedItems(db, {
      snapshotId: snapP1,
      sourceId: 'tt-official',
      sourcePriority: 1,
      sourceUrl: 'https://takaratomy.co.jp/p1',
      items: [makeItem({ edition: 'unknown', price_jpy_tax_incl: 594, release_date_jst: '2026-04-18' })],
    });
    const itemId = r1.createdIds[0]!;

    // Update: edition becomes 'first' (special), date shifts to 2026-04-25, price changes to 605, status cancelled
    const s2 = await db.query<{ id: number }>(
      `INSERT INTO snapshots (source_id, content_hash, raw_text, final_url)
       VALUES ('tt-official', 'h-upd', 'raw-upd', 'https://takaratomy.co.jp/p1-upd') RETURNING id`,
    );
    const r2 = await upsertExtractedItems(db, {
      snapshotId: s2.rows[0]!.id,
      sourceId: 'tt-official',
      sourcePriority: 1,
      sourceUrl: 'https://takaratomy.co.jp/p1-upd',
      items: [
        {
          ...makeItem({ edition: 'first', price_jpy_tax_incl: 605, release_date_jst: '2026-04-18' }),
        },
      ],
    });
    expect(r2.updatedIds).toEqual([itemId]);
    expect(r2.events.map((e) => e.kind).sort()).toEqual(['edition', 'price']);
    expect(r2.events.every((e) => e.important)).toBe(true);

    // Date change + cancellation
    const s3 = await db.query<{ id: number }>(
      `INSERT INTO snapshots (source_id, content_hash, raw_text, final_url)
       VALUES ('tt-official', 'h-cancel', 'raw-cancel', 'https://takaratomy.co.jp/p1-cancel') RETURNING id`,
    );
    const r3 = await upsertExtractedItems(db, {
      snapshotId: s3.rows[0]!.id,
      sourceId: 'tt-official',
      sourcePriority: 1,
      sourceUrl: 'https://takaratomy.co.jp/p1-cancel',
      items: [
        {
          ...makeItem({ edition: 'first', price_jpy_tax_incl: 605, release_date_jst: '2026-04-25' }),
          status: 'cancelled',
        },
      ],
    });
    expect(r3.events.map((e) => e.kind).sort()).toEqual(['cancelled', 'date']);
    expect(r3.events.every((e) => e.important)).toBe(true);

    const { rows: allEvents } = await db.query<EventRow>('SELECT * FROM events WHERE item_id = $1 ORDER BY id', [itemId]);
    expect(allEvents).toHaveLength(5); // new, price, edition, date, cancelled
  });
});
