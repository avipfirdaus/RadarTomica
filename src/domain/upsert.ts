/**
 * F3: Upsert & deduplikasi item lintas sumber + aturan kualitas data (PRD §4 F3, §5).
 * Satu item fisik = satu baris di `items`; setiap field menyimpan provenance di `item_sources`.
 */
import { DateTime } from 'luxon';
import type { Db } from '../db/client.js';
import { JST } from '../shared/time.js';
import type { Edition, Evidence, EventRow, ExtractedItem, ItemRow, ItemStatus } from '../shared/types.js';
import { recordItemChanges } from './changes.js';
import { buildCanonicalKey, normalizeExtractedItem } from './normalize.js';

export interface UpsertExtractedItemInput extends ExtractedItem {
  verifiedEvidence?: Evidence[];
  promptVersion?: string;
  /** Status opsional (mis. 'cancelled' bila sumber menandai rilis dibatalkan). */
  status?: ItemStatus;
  photoUrl?: string | null;
  category?: string;
  isRare?: boolean;
}

export interface UpsertInput {
  snapshotId: number;
  sourceId: string;
  sourcePriority: 1 | 2 | 3;
  sourceUrl: string;
  items: UpsertExtractedItemInput[];
}

export interface UpsertResult {
  createdIds: number[];
  updatedIds: number[];
  unchangedIds: number[];
  ignoredIds: number[];
  skippedCount: number;
  events: EventRow[];
}

export interface PublishableField<T> {
  publishable: boolean;
  value: T | null;
  basis: 'priority_1' | 'priority_2_corroborated' | 'unverified';
  confirmingSources: string[];
  quotes: string[];
  sourceUrls: string[];
}

export interface PublishableFieldsResult {
  itemId: number;
  price_jpy: PublishableField<number>;
  release_date_jst: PublishableField<string>;
}

const ITEM_SELECT_COLS = `
  id, canonical_key, tomica_no, name_ja, name_id, category, edition,
  release_date_jst, price_jpy, status, photo_url, is_rare, ignored,
  needs_review, replaces, created_at, updated_at
`;

function daysDiffJst(a: string, b: string): number {
  const da = DateTime.fromISO(a, { zone: JST });
  const db = DateTime.fromISO(b, { zone: JST });
  if (!da.isValid || !db.isValid) return Number.POSITIVE_INFINITY;
  return Math.abs(db.diff(da, 'days').days);
}

/**
 * Mencari item fisik yang sudah ada di DB:
 * 1. Pencocokan eksak `canonical_key`.
 * 2. Fallback: nama + edisi sama (dan tomica_no cocok bila keduanya ada) untuk kasus
 *    tanggal rilis yang tadinya null atau bergeser (<= 180 hari).
 * 3. Fallback edisi: item dengan tomica_no + nama + tanggal sama yang sebelumnya `unknown`.
 */
async function findExistingItem(
  tx: Db,
  canonicalKey: string,
  nameJa: string,
  edition: Edition,
  tomicaNo: number | null,
  releaseDateJst: string | null,
): Promise<ItemRow | null> {
  const exact = await tx.query<ItemRow>(
    `SELECT ${ITEM_SELECT_COLS} FROM items WHERE canonical_key = $1 LIMIT 1`,
    [canonicalKey],
  );
  if (exact.rows[0]) return exact.rows[0];

  // Fallback 1: sama nama & edisi, tanggal null atau bergeser <= 180 hari
  const byNameEdition = await tx.query<ItemRow>(
    `SELECT ${ITEM_SELECT_COLS} FROM items WHERE name_ja = $1 AND edition = $2 ORDER BY id ASC`,
    [nameJa, edition],
  );
  for (const row of byNameEdition.rows) {
    if (tomicaNo !== null && row.tomica_no !== null && row.tomica_no !== tomicaNo) continue;
    if (row.release_date_jst === null || releaseDateJst === null) return row;
    if (daysDiffJst(row.release_date_jst, releaseDateJst) <= 180) return row;
  }

  // Fallback 2: item sebelumnya beredisi 'unknown', kini teridentifikasi edisinya
  if (edition !== 'unknown' && releaseDateJst !== null) {
    const byUnknown = await tx.query<ItemRow>(
      `SELECT ${ITEM_SELECT_COLS} FROM items
       WHERE name_ja = $1 AND release_date_jst = $2 AND edition = 'unknown'
       ORDER BY id ASC LIMIT 1`,
      [nameJa, releaseDateJst],
    );
    const candidate = byUnknown.rows[0];
    if (candidate && (tomicaNo === null || candidate.tomica_no === null || candidate.tomica_no === tomicaNo)) {
      return candidate;
    }
  }

  return null;
}

async function getBestFieldPriorities(tx: Db, itemId: number): Promise<Map<string, number>> {
  const { rows } = await tx.query<{ field: string; best_priority: number }>(
    `SELECT isrc.field, MIN(src.priority)::int AS best_priority
     FROM item_sources isrc
     JOIN snapshots snap ON snap.id = isrc.snapshot_id
     JOIN sources src ON src.id = snap.source_id
     WHERE isrc.item_id = $1 AND isrc.value IS NOT NULL
     GROUP BY isrc.field`,
    [itemId],
  );
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(r.field, Number(r.best_priority));
  }
  return map;
}

function findEvidenceForField(evidence: Evidence[], field: string): Evidence | undefined {
  if (field === 'price_jpy') {
    return evidence.find((e) => e.field === 'price_jpy' || e.field === 'price_jpy_tax_incl');
  }
  return evidence.find((e) => e.field === field);
}

async function recordItemSources(
  tx: Db,
  itemId: number,
  input: UpsertInput,
  rawItem: UpsertExtractedItemInput,
  fieldValues: Record<string, unknown>,
): Promise<void> {
  const evidenceList = rawItem.verifiedEvidence ?? rawItem.evidence ?? [];
  const promptVersion = rawItem.promptVersion ?? null;

  for (const [field, val] of Object.entries(fieldValues)) {
    if (val === null || val === undefined) continue;
    const ev = findEvidenceForField(evidenceList, field);
    const quote = ev?.quote_ja ?? null;
    const sourceUrl = ev?.source_url ?? input.sourceUrl;
    const valueJson = JSON.stringify(val);

    // Idempoten: jangan gandakan baris untuk (item_id, snapshot_id, field) yang sama.
    const existing = await tx.query<{ id: number }>(
      `SELECT id FROM item_sources WHERE item_id = $1 AND snapshot_id = $2 AND field = $3 LIMIT 1`,
      [itemId, input.snapshotId, field],
    );
    if (existing.rows[0]) continue;

    await tx.query(
      `INSERT INTO item_sources (item_id, snapshot_id, field, value, confidence, quote, source_url, prompt_version)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
      [itemId, input.snapshotId, field, valueJson, rawItem.confidence, quote, sourceUrl, promptVersion],
    );
  }
}

/**
 * Menormalisasi, menggabungkan (dedup), menyimpan `item_sources`, dan mencatat event F4
 * untuk sekumpulan item hasil ekstraksi satu snapshot.
 *
 * - Item tanpa `name_ja` dilewati dan dikirim ke `review_queue`.
 * - Item dengan `ignored = true` tidak diubah dan tidak memicu event.
 * - Nilai dari sumber prioritas 1 menang atas konflik sumber prioritas 2.
 */
export async function upsertExtractedItems(db: Db, input: UpsertInput): Promise<UpsertResult> {
  const result: UpsertResult = {
    createdIds: [],
    updatedIds: [],
    unchangedIds: [],
    ignoredIds: [],
    skippedCount: 0,
    events: [],
  };

  await db.transaction(async (tx) => {
    for (const rawItem of input.items) {
      const normalized = normalizeExtractedItem(rawItem);
      if (!normalized) {
        await tx.query(
          `INSERT INTO review_queue (kind, snapshot_id, reason, payload)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [
            'missing_name_ja',
            input.snapshotId,
            'Item tanpa name_ja dilewati saat normalisasi (F3)',
            JSON.stringify(rawItem),
          ],
        );
        result.skippedCount += 1;
        continue;
      }

      const existing = await findExistingItem(
        tx,
        normalized.canonical_key,
        normalized.name_ja,
        normalized.edition,
        normalized.tomica_no,
        normalized.release_date_jst,
      );

      const category = rawItem.category ?? (normalized.edition === 'unknown' ? 'regular' : normalized.edition);

      if (!existing) {
        const status: ItemStatus = rawItem.status ?? 'announced';
        const isRare = rawItem.isRare ?? false;
        const { rows } = await tx.query<ItemRow>(
          `INSERT INTO items (
             canonical_key, tomica_no, name_ja, name_id, category, edition,
             release_date_jst, price_jpy, status, photo_url, is_rare, needs_review, replaces
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING ${ITEM_SELECT_COLS}`,
          [
            normalized.canonical_key,
            normalized.tomica_no,
            normalized.name_ja,
            normalized.name_id,
            category,
            normalized.edition,
            normalized.release_date_jst,
            normalized.price_jpy,
            status,
            rawItem.photoUrl ?? null,
            isRare,
            normalized.needs_review,
            normalized.replaces,
          ],
        );
        const created = rows[0]!;
        await recordItemSources(tx, created.id, input, rawItem, {
          name_ja: normalized.name_ja,
          name_id: normalized.name_id,
          tomica_no: normalized.tomica_no,
          edition: normalized.edition,
          release_date_jst: normalized.release_date_jst,
          price_jpy: normalized.price_jpy,
          replaces: normalized.replaces,
        });
        const events = await recordItemChanges(tx, null, created);
        result.createdIds.push(created.id);
        result.events.push(...events);
        continue;
      }

      // Hormati kontrol operator: items.ignored
      if (existing.ignored) {
        result.ignoredIds.push(existing.id);
        continue;
      }

      // Cek prioritas sumber yang sudah tercatat untuk tiap field.
      // Prioritas 1 menang atas konflik prioritas 2 (dan 3).
      const bestPriorities = await getBestFieldPriorities(tx, existing.id);
      const canOverwrite = (field: string): boolean => {
        const best = bestPriorities.get(field);
        if (best === undefined) return true;
        return input.sourcePriority <= best;
      };

      const nextTomicaNo =
        normalized.tomica_no !== null && (existing.tomica_no === null || canOverwrite('tomica_no'))
          ? normalized.tomica_no
          : existing.tomica_no;

      const nextNameId =
        normalized.name_id !== null && (existing.name_id === null || canOverwrite('name_id'))
          ? normalized.name_id
          : existing.name_id;

      const nextEdition: Edition =
        normalized.edition !== 'unknown' && (existing.edition === 'unknown' || canOverwrite('edition'))
          ? normalized.edition
          : existing.edition;

      const nextReleaseDate =
        normalized.release_date_jst !== null &&
        (existing.release_date_jst === null || canOverwrite('release_date_jst'))
          ? normalized.release_date_jst
          : existing.release_date_jst;

      const nextPriceJpy =
        normalized.price_jpy !== null && (existing.price_jpy === null || canOverwrite('price_jpy'))
          ? normalized.price_jpy
          : existing.price_jpy;

      const nextReplaces =
        normalized.replaces !== null && (existing.replaces === null || canOverwrite('replaces'))
          ? normalized.replaces
          : existing.replaces;

      const nextStatus: ItemStatus =
        rawItem.status !== undefined && canOverwrite('status') ? rawItem.status : existing.status;

      const nextPhotoUrl = rawItem.photoUrl ?? existing.photo_url;
      const nextIsRare = existing.is_rare || (rawItem.isRare ?? false);
      const nextNeedsReview = existing.needs_review || normalized.needs_review;
      const nextCategory = rawItem.category ?? (nextEdition !== existing.edition ? nextEdition : existing.category);
      const nextCanonicalKey = buildCanonicalKey(existing.name_ja, nextEdition, nextReleaseDate);

      // Tetap catat provenance sumber masuk ke item_sources (termasuk jika kalah prioritas, untuk audit).
      await recordItemSources(tx, existing.id, input, rawItem, {
        name_ja: normalized.name_ja,
        name_id: normalized.name_id,
        tomica_no: normalized.tomica_no,
        edition: normalized.edition,
        release_date_jst: normalized.release_date_jst,
        price_jpy: normalized.price_jpy,
        replaces: normalized.replaces,
      });

      const changed =
        nextCanonicalKey !== existing.canonical_key ||
        nextTomicaNo !== existing.tomica_no ||
        nextNameId !== existing.name_id ||
        nextCategory !== existing.category ||
        nextEdition !== existing.edition ||
        nextReleaseDate !== existing.release_date_jst ||
        nextPriceJpy !== existing.price_jpy ||
        nextStatus !== existing.status ||
        nextPhotoUrl !== existing.photo_url ||
        nextIsRare !== existing.is_rare ||
        nextNeedsReview !== existing.needs_review ||
        nextReplaces !== existing.replaces;

      if (!changed) {
        result.unchangedIds.push(existing.id);
        continue;
      }

      const { rows } = await tx.query<ItemRow>(
        `UPDATE items
         SET canonical_key = $2,
             tomica_no = $3,
             name_id = $4,
             category = $5,
             edition = $6,
             release_date_jst = $7,
             price_jpy = $8,
             status = $9,
             photo_url = $10,
             is_rare = $11,
             needs_review = $12,
             replaces = $13,
             updated_at = now()
         WHERE id = $1
         RETURNING ${ITEM_SELECT_COLS}`,
        [
          existing.id,
          nextCanonicalKey,
          nextTomicaNo,
          nextNameId,
          nextCategory,
          nextEdition,
          nextReleaseDate,
          nextPriceJpy,
          nextStatus,
          nextPhotoUrl,
          nextIsRare,
          nextNeedsReview,
          nextReplaces,
        ],
      );
      const updated = rows[0]!;
      const events = await recordItemChanges(tx, existing, updated);
      result.updatedIds.push(updated.id);
      result.events.push(...events);
    }
  });

  return result;
}

interface SourceEvidenceRow {
  id: number;
  field: string;
  value: unknown;
  quote: string | null;
  source_url: string | null;
  source_id: string;
  priority: number;
  created_at: Date;
}

function resolvePublishableField<T>(rows: SourceEvidenceRow[]): PublishableField<T> {
  const nonNull = rows.filter((r) => r.value !== null && r.value !== undefined);
  if (nonNull.length === 0) {
    return {
      publishable: false,
      value: null,
      basis: 'unverified',
      confirmingSources: [],
      quotes: [],
      sourceUrls: [],
    };
  }

  // 1. Sumber prioritas 1 selalu menang atas konflik prioritas 2.
  const p1Rows = nonNull.filter((r) => r.priority === 1);
  if (p1Rows.length > 0) {
    // Sudah terurut DESC berdasarkan created_at, id.
    const latest = p1Rows[0]!;
    const matching = p1Rows.filter((r) => JSON.stringify(r.value) === JSON.stringify(latest.value));
    return {
      publishable: true,
      value: latest.value as T,
      basis: 'priority_1',
      confirmingSources: [...new Set(matching.map((r) => r.source_id))],
      quotes: matching.map((r) => r.quote).filter((q): q is string => Boolean(q)),
      sourceUrls: [...new Set(matching.map((r) => r.source_url).filter((u): u is string => Boolean(u)))],
    };
  }

  // 2. Tanpa prioritas 1: butuh konfirmasi minimal 2 sumber prioritas 2 berbeda dengan nilai sama.
  const p2Rows = nonNull.filter((r) => r.priority === 2);
  // Ambil nilai terbaru per source_id agar 1 sumber yang mengambil 2 snapshot tidak dihitung ganda.
  const latestPerSource = new Map<string, SourceEvidenceRow>();
  for (const r of p2Rows) {
    if (!latestPerSource.has(r.source_id)) {
      latestPerSource.set(r.source_id, r);
    }
  }

  const groups = new Map<string, SourceEvidenceRow[]>();
  for (const r of latestPerSource.values()) {
    const key = JSON.stringify(r.value);
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  let bestGroup: SourceEvidenceRow[] | null = null;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    if (!bestGroup || group.length > bestGroup.length) {
      bestGroup = group;
    } else if (group.length === bestGroup.length) {
      const groupMaxId = Math.max(...group.map((g) => g.id));
      const bestMaxId = Math.max(...bestGroup.map((g) => g.id));
      if (groupMaxId > bestMaxId) bestGroup = group;
    }
  }

  if (bestGroup && bestGroup.length >= 2) {
    return {
      publishable: true,
      value: bestGroup[0]!.value as T,
      basis: 'priority_2_corroborated',
      confirmingSources: bestGroup.map((r) => r.source_id),
      quotes: bestGroup.map((r) => r.quote).filter((q): q is string => Boolean(q)),
      sourceUrls: [...new Set(bestGroup.map((r) => r.source_url).filter((u): u is string => Boolean(u)))],
    };
  }

  return {
    publishable: false,
    value: null,
    basis: 'unverified',
    confirmingSources: [],
    quotes: [],
    sourceUrls: [],
  };
}

/**
 * Aturan kualitas data PRD §5:
 * Harga (`price_jpy`) dan tanggal rilis (`release_date_jst`) hanya layak tayang (publishable)
 * bila berasal dari sumber prioritas 1, ATAU dikonfirmasi oleh ≥ 2 sumber prioritas 2 dengan
 * nilai yang sama. Nilai prioritas 1 menang atas konflik prioritas 2.
 */
export async function getPublishableFields(db: Db, itemId: number): Promise<PublishableFieldsResult> {
  const { rows } = await db.query<SourceEvidenceRow>(
    `SELECT isrc.id, isrc.field, isrc.value, isrc.quote, isrc.source_url,
            snap.source_id, src.priority, isrc.created_at
     FROM item_sources isrc
     JOIN snapshots snap ON snap.id = isrc.snapshot_id
     JOIN sources src ON src.id = snap.source_id
     WHERE isrc.item_id = $1 AND isrc.field IN ('price_jpy', 'release_date_jst')
     ORDER BY isrc.created_at DESC, isrc.id DESC`,
    [itemId],
  );

  const priceRows = rows.filter((r) => r.field === 'price_jpy');
  const dateRows = rows.filter((r) => r.field === 'release_date_jst');

  return {
    itemId,
    price_jpy: resolvePublishableField<number>(priceRows),
    release_date_jst: resolvePublishableField<string>(dateRows),
  };
}
