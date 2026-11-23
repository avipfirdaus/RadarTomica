import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, setParam } from '../config/params.js';
import { createTestDb, type Db } from '../db/client.js';
import type { Edition, Label, ReferenceKind } from '../shared/types.js';
import {
  calcLandedIdr,
  calcPoPriceIdr,
  calcRareReferenceIdr,
  checkFxShift,
  evaluateAll,
  evaluateItem,
  evaluateItemPure,
  FrankfurterFxProvider,
  getFxLock,
  lockFx,
  rankCandidates,
  removeOutliersIqr,
  saveFxLock,
  StaticFxProvider,
  type PriceSampleInput,
} from './index.js';

const NOW = new Date('2026-12-22T03:00:00Z');

function idPrices(prices: number[]): PriceSampleInput[] {
  return prices.map((price, idx) => ({
    market: 'ID-marketplace',
    platform: idx % 2 === 0 ? 'tokopedia' : 'shopee',
    seller: `seller-${idx + 1}`,
    price,
    currency: 'IDR',
    is_sold: false,
    in_stock: true,
    observed_at: NOW,
  }));
}

function usedSoldPrices(prices: number[]): PriceSampleInput[] {
  return prices.map((price, idx) => ({
    market: 'JP-used',
    platform: idx % 2 === 0 ? 'mercari' : 'yahoo_auctions',
    seller: `u-${idx + 1}`,
    price,
    currency: 'JPY',
    is_sold: true,
    in_stock: null,
    observed_at: new Date(NOW.getTime() - (idx + 1) * 86_400_000),
  }));
}

describe('F6 pricing — PRD worked examples', () => {
  it('matches PRD §5 worked examples within Rp1.000 tolerance', () => {
    // 1. Tomica regular ¥594 (m=30%): Landed ≈ Rp120.700, HargaPO ≈ Rp157.000, vs Rp94.900 -> ratio ≈ 0.60 TIDAK
    const regLanded = calcLandedIdr(594, DEFAULT_PARAMS);
    const regPo = calcPoPriceIdr(594, 'regular', DEFAULT_PARAMS);
    expect(Math.abs(regLanded - 120_700)).toBeLessThanOrEqual(1_000);
    expect(Math.abs(regPo - 157_000)).toBeLessThanOrEqual(1_000);

    const regEval = evaluateItemPure({
      edition: 'regular',
      officialPriceJpy: 594,
      releaseDateJst: '2026-12-19',
      isRareFlag: false,
      prices: idPrices([94_900, 94_900, 94_900]),
      now: NOW,
    });
    expect(regEval.label).toBe('TIDAK');
    expect(regEval.po_ratio!).toBeCloseTo(0.6, 1);

    // 2. First edition ¥594 with used sold ¥1.500 -> Acuan ≈ Rp253.000, ratio ≈ 1.6 LAYAK
    const rareRef = calcRareReferenceIdr(1_500, DEFAULT_PARAMS);
    expect(Math.abs(rareRef - 253_000)).toBeLessThanOrEqual(1_000);

    const firstEval = evaluateItemPure({
      edition: 'first',
      officialPriceJpy: 594,
      releaseDateJst: '2026-12-19',
      isRareFlag: false,
      prices: usedSoldPrices([1_450, 1_480, 1_500, 1_520, 1_550]),
      now: NOW,
    });
    expect(firstEval.isRare).toBe(true);
    expect(firstEval.reference_kind).toBe('JP-used');
    expect(Math.abs(firstEval.reference_idr! - 253_000)).toBeLessThanOrEqual(1_000);
    expect(firstEval.po_ratio!).toBeCloseTo(1.615, 2);
    expect(firstEval.label).toBe('LAYAK');

    // 3. Premium ¥1.100 (m=25%): HargaPO ≈ Rp244.000
    const premPo = calcPoPriceIdr(1_100, 'premium', DEFAULT_PARAMS);
    expect(Math.abs(premPo - 244_000)).toBeLessThanOrEqual(1_000);
  });
});

describe('F6 pricing — 10-item hand-calculated table (PRD §11 acceptance, tolerance <= Rp1.000)', () => {
  interface TableCase {
    name: string;
    edition: Edition;
    officialPriceJpy: number;
    isRareFlag: boolean;
    prices: PriceSampleInput[];
    expectedLanded: number;
    expectedPo: number;
    expectedRef: number | null;
    expectedRefKind: ReferenceKind;
    expectedRatio: number | null;
    expectedLabel: Label;
    expectedRare: boolean;
  }

  // Hitungan manual dengan DEFAULT_PARAMS:
  // O=180, K=50, (1+b)=1.274, kurs=115 => faktor=(1+b)*kurs=146.51
  const TABLE: TableCase[] = [
    {
      name: '1. Regular No.94 光岡 M55 (TIDAK)',
      edition: 'regular',
      officialPriceJpy: 594,
      isRareFlag: false,
      prices: idPrices([94_800, 94_900, 95_000]),
      expectedLanded: 120_724,
      expectedPo: 156_942,
      expectedRef: 94_900,
      expectedRefKind: 'ID-market',
      expectedRatio: 0.6047,
      expectedLabel: 'TIDAK',
      expectedRare: false,
    },
    {
      name: '2. First Edition No.94 光岡 M55 (RARE #1, LAYAK)',
      edition: 'first',
      officialPriceJpy: 594,
      isRareFlag: false,
      prices: usedSoldPrices([1_400, 1_450, 1_500, 1_550, 1_600]),
      expectedLanded: 120_724,
      expectedPo: 156_942,
      expectedRef: 253_462,
      expectedRefKind: 'JP-used',
      expectedRatio: 1.615,
      expectedLabel: 'LAYAK',
      expectedRare: true,
    },
    {
      name: '3. Premium No.12 カウンタック (BATAS)',
      edition: 'premium',
      officialPriceJpy: 1_100,
      isRareFlag: false,
      prices: idPrices([248_000, 255_000, 260_000]),
      expectedLanded: 194_858,
      expectedPo: 243_573,
      expectedRef: 255_000,
      expectedRefKind: 'ID-market',
      expectedRatio: 1.0469,
      expectedLabel: 'BATAS',
      expectedRare: false,
    },
    {
      name: '4. Premium Unlimited サイバーフォーミュラ (LAYAK)',
      edition: 'premium_unlimited',
      officialPriceJpy: 1_320,
      isRareFlag: false,
      prices: idPrices([320_000, 335_000, 340_000, 350_000]),
      expectedLanded: 227_091,
      expectedPo: 283_863,
      expectedRef: 337_500,
      expectedRefKind: 'ID-market',
      expectedRatio: 1.189,
      expectedLabel: 'LAYAK',
      expectedRare: false,
    },
    {
      name: '5. Mall Exclusive GT-R (RARE #2, LAYAK)',
      edition: 'exclusive',
      officialPriceJpy: 990,
      isRareFlag: false,
      prices: usedSoldPrices([2_100, 2_150, 2_200, 2_250, 2_300]),
      expectedLanded: 178_742,
      expectedPo: 232_365,
      expectedRef: 356_019,
      expectedRefKind: 'JP-used',
      expectedRatio: 1.5322,
      expectedLabel: 'LAYAK',
      expectedRare: true,
    },
    {
      name: '6. Collab Disney Motors ミッキー (LAYAK)',
      edition: 'collab',
      officialPriceJpy: 990,
      isRareFlag: false,
      prices: idPrices([265_000, 270_000, 275_000]),
      expectedLanded: 178_742,
      expectedPo: 232_365,
      expectedRef: 270_000,
      expectedRefKind: 'ID-market',
      expectedRatio: 1.162,
      expectedLabel: 'LAYAK',
      expectedRare: false,
    },
    {
      name: '7. Gift Set 緊急車両セット (BATAS)',
      edition: 'set',
      officialPriceJpy: 2_420,
      isRareFlag: false,
      prices: idPrices([515_000, 520_000, 530_000]),
      expectedLanded: 388_252,
      expectedPo: 504_727,
      expectedRef: 520_000,
      expectedRefKind: 'ID-market',
      expectedRatio: 1.0303,
      expectedLabel: 'BATAS',
      expectedRare: false,
    },
    {
      name: '8. Premium No.01 NISMO R34 (TIDAK)',
      edition: 'premium',
      officialPriceJpy: 990,
      isRareFlag: false,
      prices: idPrices([195_000, 200_000, 205_000]),
      expectedLanded: 178_742,
      expectedPo: 223_428,
      expectedRef: 200_000,
      expectedRefKind: 'ID-market',
      expectedRatio: 0.8951,
      expectedLabel: 'TIDAK',
      expectedRare: false,
    },
    {
      name: '9. Regular No.50 プリウス (REVIEW — penjual kurang)',
      edition: 'regular',
      officialPriceJpy: 594,
      isRareFlag: false,
      prices: idPrices([180_000, 185_000]),
      expectedLanded: 120_724,
      expectedPo: 156_942,
      expectedRef: null,
      expectedRefKind: 'ID-market',
      expectedRatio: null,
      expectedLabel: 'REVIEW',
      expectedRare: false,
    },
    {
      name: '10. First Edition No.17 フェラーリ (LAYAK — P efektif diskon toko ¥550)',
      edition: 'first',
      officialPriceJpy: 594,
      isRareFlag: false,
      prices: [
        {
          market: 'JP-shop',
          platform: 'yodobashi',
          seller: 'yodobashi',
          price: 550,
          currency: 'JPY',
          is_sold: false,
          in_stock: true,
          observed_at: NOW,
        },
        ...idPrices([175_000, 180_000, 185_000]),
      ],
      expectedLanded: 114_278,
      expectedPo: 148_561,
      expectedRef: 180_000,
      expectedRefKind: 'ID-market',
      expectedRatio: 1.2116,
      expectedLabel: 'LAYAK',
      expectedRare: false,
    },
  ];

  it.each(TABLE)('$name', (tc) => {
    const out = evaluateItemPure({
      edition: tc.edition,
      officialPriceJpy: tc.officialPriceJpy,
      releaseDateJst: '2026-12-19',
      isRareFlag: tc.isRareFlag,
      prices: tc.prices,
      now: NOW,
    });

    expect(out.isRare).toBe(tc.expectedRare);
    expect(Math.abs(out.landed_idr! - tc.expectedLanded)).toBeLessThanOrEqual(1_000);
    expect(Math.abs(out.po_price_idr! - tc.expectedPo)).toBeLessThanOrEqual(1_000);
    expect(out.reference_kind).toBe(tc.expectedRefKind);
    if (tc.expectedRef === null) {
      expect(out.reference_idr).toBeNull();
      expect(out.po_ratio).toBeNull();
    } else {
      expect(Math.abs(out.reference_idr! - tc.expectedRef)).toBeLessThanOrEqual(1_000);
      expect(out.po_ratio!).toBeCloseTo(tc.expectedRatio!, 3);
    }
    expect(out.label).toBe(tc.expectedLabel);
  });
});

describe('F6 pricing — outliers, rare edge cases, effective P, ranking', () => {
  it('removes outliers outside 1.5xIQR before computing median', () => {
    const { filtered, removed } = removeOutliersIqr([90_000, 95_000, 100_000, 500_000]);
    expect(removed).toEqual([500_000]);
    expect(filtered).toEqual([90_000, 95_000, 100_000]);

    // After removing outlier, 3 sellers remain -> median 95_000 (not skewed by 500_000)
    const out = evaluateItemPure({
      edition: 'regular',
      officialPriceJpy: 594,
      releaseDateJst: '2026-12-19',
      isRareFlag: false,
      prices: idPrices([90_000, 95_000, 100_000, 500_000]),
      now: NOW,
    });
    expect(out.reference_idr).toBe(95_000);
    expect(out.data_count).toBe(3);
  });

  it('marks rare item without sufficient used data as REVIEW (including sold-out at >= 2 shops within 7 days)', () => {
    const out = evaluateItemPure({
      edition: 'first',
      officialPriceJpy: 594,
      releaseDateJst: '2026-12-19',
      isRareFlag: false,
      prices: [
        {
          market: 'JP-shop',
          platform: 'amazon',
          seller: 'Amazon.co.jp',
          price: 594,
          currency: 'JPY',
          is_sold: false,
          in_stock: false,
          observed_at: new Date('2026-12-20T05:00:00Z'),
        },
        {
          market: 'JP-shop',
          platform: 'yodobashi',
          seller: 'Yodobashi',
          price: 594,
          currency: 'JPY',
          is_sold: false,
          in_stock: false,
          observed_at: new Date('2026-12-21T05:00:00Z'),
        },
        // Only 3 used transactions (< 5) -> insufficient
        ...usedSoldPrices([1_500, 1_550, 1_600]),
      ],
      now: NOW,
    });
    expect(out.isRare).toBe(true);
    expect(out.label).toBe('REVIEW');
    expect(out.reference_idr).toBeNull();
  });

  it('uses used price as effective P when all JP shops are sold out, dropping ratio below 1', () => {
    const out = evaluateItemPure({
      edition: 'first',
      officialPriceJpy: 594,
      releaseDateJst: '2026-12-19',
      isRareFlag: false,
      prices: [
        {
          market: 'JP-shop',
          platform: 'amazon',
          seller: 'Amazon.co.jp',
          price: 594,
          currency: 'JPY',
          is_sold: false,
          in_stock: false,
          observed_at: new Date('2026-12-20T05:00:00Z'),
        },
        ...usedSoldPrices([1_450, 1_480, 1_500, 1_520, 1_550]),
      ],
      now: NOW,
    });
    expect(out.usedOnlyFallback).toBe(true);
    expect(out.effectivePriceJpy).toBe(1_500);
    // AcuanLangka = Landed(1500), HargaPO = Landed(1500) * 1.3 => ratio ≈ 1 / 1.3 ≈ 0.7692
    expect(out.po_ratio!).toBeCloseTo(1 / 1.3, 2);
    expect(out.label).toBe('TIDAK');
  });

  it('ranks LAYAK before BATAS, highest ratio first, nearest release tie-break, capped at 10', () => {
    const candidates = [
      { item_id: 1, label: 'TIDAK' as Label, po_ratio: 0.7, release_date_jst: '2026-12-19' },
      { item_id: 2, label: 'REVIEW' as Label, po_ratio: null, release_date_jst: '2026-12-19' },
      { item_id: 3, label: 'BATAS' as Label, po_ratio: 1.09, release_date_jst: '2026-12-19' },
      { item_id: 4, label: 'LAYAK' as Label, po_ratio: 1.2, release_date_jst: '2027-01-16' },
      { item_id: 5, label: 'LAYAK' as Label, po_ratio: 1.2, release_date_jst: '2026-12-19' },
      { item_id: 6, label: 'LAYAK' as Label, po_ratio: 1.5, release_date_jst: '2027-02-20' },
      ...Array.from({ length: 8 }, (_, i) => ({
        item_id: 10 + i,
        label: 'BATAS' as Label,
        po_ratio: 1.01 + i * 0.005,
        release_date_jst: '2027-01-16',
      })),
    ];

    const ranked = rankCandidates(candidates);
    expect(ranked).toHaveLength(10);
    expect(ranked[0]!.item_id).toBe(6); // LAYAK 1.5
    expect(ranked[1]!.item_id).toBe(5); // LAYAK 1.2, earlier release 2026-12-19
    expect(ranked[2]!.item_id).toBe(4); // LAYAK 1.2, later release 2027-01-16
    expect(ranked[3]!.item_id).toBe(3); // BATAS 1.09
    expect(ranked.some((r) => r.label === 'TIDAK' || r.label === 'REVIEW')).toBe(false);
  });
});

describe('F6 FX provider, lockFx, checkFxShift & DB evaluateItem / setParam', () => {
  let db: Db;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.query('TRUNCATE evaluations, prices, items, params, system_state RESTART IDENTITY CASCADE');
  });

  it('FrankfurterFxProvider fetches with injectable fetch and checkFxShift alerts above 3%', async () => {
    const mockFetch: typeof globalThis.fetch = async (url) => {
      expect(String(url)).toContain('/latest?from=JPY&to=IDR');
      return new Response(
        JSON.stringify({ amount: 1, base: 'JPY', date: '2026-12-15', rates: { IDR: 112.4 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const provider = new FrankfurterFxProvider({ fetch: mockFetch });
    const rate = await provider.getIdrPerJpy();
    expect(rate.rate).toBe(112.4);
    expect(rate.source).toBe('frankfurter');

    const lock = lockFx(115, 'param', NOW);
    await saveFxLock(db, 'batch-1', lock);
    expect(await getFxLock(db, 'batch-1')).toEqual(lock);

    expect(checkFxShift(lock, 118).alert).toBe(false); // +2.61% <= 3%
    expect(checkFxShift(lock, 118.45).alert).toBe(false); // exactly +3.00%
    const shifted = checkFxShift(lock, 119); // +3.48% > 3%
    expect(shifted.alert).toBe(true);
    expect(shifted.direction).toBe('up');
    expect(shifted.shiftPercent).toBe(3.48);
  });

  it('evaluateItem uses buffered param fx_idr_per_jpy, stores live FX info, and reflects setParam overrides', async () => {
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO items (canonical_key, tomica_no, name_ja, edition, release_date_jst, price_jpy)
       VALUES ('prem-12:premium:2026-12-19', 12, 'カウンタック', 'premium', '2026-12-19', 1100)
       RETURNING id`,
    );
    const itemId = rows[0]!.id;

    await db.query(
      `INSERT INTO prices (item_id, market, platform, seller, price, currency, in_stock, observed_at) VALUES
       ($1, 'ID-marketplace', 'tokopedia', 's1', 260000, 'IDR', true, $2),
       ($1, 'ID-marketplace', 'shopee', 's2', 265000, 'IDR', true, $2),
       ($1, 'ID-marketplace', 'tokopedia', 's3', 270000, 'IDR', true, $2)`,
      [itemId, NOW],
    );

    const liveFx = new StaticFxProvider(111.5, 'frankfurter', NOW);
    const eval1 = await evaluateItem(db, itemId, { fx: liveFx, now: NOW });
    expect(eval1.fx_idr_per_jpy).toBe(115); // buffered param kurs
    expect(eval1.live_fx?.rate).toBe(111.5);
    expect(eval1.reason).toContain('live_fx=111.5');
    expect(eval1.po_price_idr).toBe(243_573);
    expect(eval1.reference_idr).toBe(265_000);
    expect(eval1.label).toBe('BATAS'); // 265000 / 243573 = 1.088

    // Override kurs param via setParam -> HargaPO drops, label flips from BATAS to LAYAK
    await setParam(db, 'fx_idr_per_jpy', 105, 'operator');
    const eval2 = await evaluateItem(db, itemId, { fx: liveFx, now: new Date(NOW.getTime() + 1_000) });
    expect(eval2.params_version).toBeGreaterThan(eval1.params_version);
    expect(eval2.fx_idr_per_jpy).toBe(105);
    expect(eval2.po_price_idr!).toBeLessThan(eval1.po_price_idr!);
    expect(eval2.label).toBe('LAYAK');

    // evaluateAll evaluates all active items
    const all = await evaluateAll(db, { fx: liveFx, now: new Date(NOW.getTime() + 2_000) });
    expect(all).toHaveLength(1);
    expect(all[0]!.item_id).toBe(itemId);
  });
});
