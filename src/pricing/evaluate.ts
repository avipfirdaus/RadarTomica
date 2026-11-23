/**
 * F6: Evaluator harga & kelayakan berbasis basis data (`evaluateItem`, `evaluateAll`).
 * Menghitung memakai parameter aktif (`loadParams`, kurs Rp115 berbantalan sesuai PRD §5)
 * dan menyimpan informasi kurs pasar live (bila `fx` diberikan) untuk transparansi.
 */
import { loadParams, type ParamsSnapshot } from '../config/params.js';
import type { Db } from '../db/client.js';
import type { EvaluationRow, FxProvider, ItemRow, PriceRow } from '../shared/types.js';
import { evaluateItemPure, type PriceSampleInput } from './calc.js';
import type { FxRate } from './fx.js';

export interface EvaluateOptions {
  fx?: FxProvider;
  now?: Date;
}

export interface EvaluationResult extends EvaluationRow {
  release_date_jst: string | null;
  is_rare: boolean;
  effective_price_jpy: number | null;
  live_fx: FxRate | null;
}

async function evaluateItemInternal(
  db: Db,
  item: ItemRow,
  paramsSnap: ParamsSnapshot,
  liveFx: FxRate | null,
  now: Date,
): Promise<EvaluationResult> {
  const { rows: priceRows } = await db.query<PriceRow>(
    `SELECT id, item_id, market, platform, seller, price, currency, is_sold, in_stock, observed_at, url
     FROM prices
     WHERE item_id = $1
     ORDER BY observed_at DESC, id DESC`,
    [item.id],
  );

  const samples: PriceSampleInput[] = priceRows.map((p) => ({
    market: p.market,
    platform: p.platform,
    seller: p.seller,
    price: Number(p.price),
    currency: p.currency,
    is_sold: p.is_sold,
    in_stock: p.in_stock,
    observed_at: p.observed_at instanceof Date ? p.observed_at : new Date(p.observed_at),
    url: p.url,
  }));

  const pure = evaluateItemPure({
    edition: item.edition,
    officialPriceJpy: item.price_jpy,
    releaseDateJst: item.release_date_jst,
    isRareFlag: item.is_rare,
    prices: samples,
    params: paramsSnap.values,
    now,
  });

  const reason = liveFx
    ? `${pure.reason} [live_fx=${liveFx.rate} (${liveFx.source})]`
    : pure.reason;

  const { rows: inserted } = await db.query<EvaluationRow>(
    `INSERT INTO evaluations (
       item_id, params_version, fx_idr_per_jpy, landed_idr, po_price_idr,
       reference_idr, reference_kind, data_count, po_ratio, label, reason
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, item_id, params_version, fx_idr_per_jpy, landed_idr, po_price_idr,
               reference_idr, reference_kind, data_count, po_ratio, label, reason, created_at`,
    [
      item.id,
      paramsSnap.version,
      paramsSnap.values.fx_idr_per_jpy,
      pure.landed_idr,
      pure.po_price_idr,
      pure.reference_idr,
      pure.reference_kind,
      pure.data_count,
      pure.po_ratio,
      pure.label,
      reason,
    ],
  );

  const row = inserted[0]!;
  return {
    ...row,
    release_date_jst: item.release_date_jst,
    is_rare: pure.isRare,
    effective_price_jpy: pure.effectivePriceJpy,
    live_fx: liveFx,
  };
}

/**
 * Mengevaluasi satu item berdasarkan parameter aktif & data harga di DB, lalu menyimpannya ke `evaluations`.
 */
export async function evaluateItem(
  db: Db,
  itemId: number,
  opts: EvaluateOptions = {},
): Promise<EvaluationResult> {
  const now = opts.now ?? new Date();
  const { rows } = await db.query<ItemRow>(
    `SELECT id, canonical_key, tomica_no, name_ja, name_id, category, edition,
            release_date_jst, price_jpy, status, photo_url, is_rare, ignored,
            needs_review, replaces, created_at, updated_at
     FROM items
     WHERE id = $1`,
    [itemId],
  );
  const item = rows[0];
  if (!item) {
    throw new Error(`Item tidak ditemukan: id=${itemId}`);
  }

  const paramsSnap = await loadParams(db, now);
  const liveFx = opts.fx ? await opts.fx.getIdrPerJpy() : null;

  return evaluateItemInternal(db, item, paramsSnap, liveFx, now);
}

/**
 * Mengevaluasi seluruh item aktif (tidak diabaikan dan tidak dibatalkan) dan menyimpannya ke `evaluations`.
 */
export async function evaluateAll(
  db: Db,
  opts: EvaluateOptions = {},
): Promise<EvaluationResult[]> {
  const now = opts.now ?? new Date();
  const paramsSnap = await loadParams(db, now);
  const liveFx = opts.fx ? await opts.fx.getIdrPerJpy() : null;

  const { rows: items } = await db.query<ItemRow>(
    `SELECT id, canonical_key, tomica_no, name_ja, name_id, category, edition,
            release_date_jst, price_jpy, status, photo_url, is_rare, ignored,
            needs_review, replaces, created_at, updated_at
     FROM items
     WHERE ignored = false AND status <> 'cancelled'
     ORDER BY release_date_jst ASC NULLS LAST, id ASC`,
  );

  const results: EvaluationResult[] = [];
  for (const item of items) {
    results.push(await evaluateItemInternal(db, item, paramsSnap, liveFx, now));
  }
  return results;
}
