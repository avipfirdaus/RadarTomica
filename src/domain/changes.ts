/**
 * F4: Deteksi perubahan item (new / date / price / edition / cancelled)
 * dengan penanda `important` untuk antrean peringatan segera F8 (PRD §4 F4, §8).
 */
import type { Db } from '../db/client.js';
import type { Edition, EventKind, EventRow, ItemRow } from '../shared/types.js';

const SPECIAL_EDITIONS: ReadonlySet<Edition> = new Set<Edition>([
  'first',
  'premium',
  'premium_unlimited',
  'collab',
  'exclusive',
  'set',
  'random',
]);

export function isSpecialEdition(edition: Edition): boolean {
  return SPECIAL_EDITIONS.has(edition);
}

export interface DetectedChange {
  kind: EventKind;
  old_value: unknown;
  new_value: unknown;
  important: boolean;
}

/**
 * Fungsi murni untuk membandingkan state item sebelum dan sesudah upsert.
 * Idempoten: bila tidak ada perubahan bermakna, mengembalikan array kosong.
 */
export function detectItemChanges(before: ItemRow | null, after: ItemRow): DetectedChange[] {
  if (before === null) {
    return [
      {
        kind: 'new',
        old_value: null,
        new_value: {
          canonical_key: after.canonical_key,
          tomica_no: after.tomica_no,
          name_ja: after.name_ja,
          edition: after.edition,
          release_date_jst: after.release_date_jst,
          price_jpy: after.price_jpy,
        },
        important: true,
      },
    ];
  }

  const changes: DetectedChange[] = [];

  if (before.release_date_jst !== after.release_date_jst) {
    changes.push({
      kind: 'date',
      old_value: before.release_date_jst,
      new_value: after.release_date_jst,
      important: true,
    });
  }

  if (before.price_jpy !== after.price_jpy) {
    changes.push({
      kind: 'price',
      old_value: before.price_jpy,
      new_value: after.price_jpy,
      important: true,
    });
  }

  if (before.edition !== after.edition) {
    // Edisi khusus muncul ditandai important untuk antrean peringatan segera.
    const important = isSpecialEdition(after.edition);
    changes.push({
      kind: 'edition',
      old_value: before.edition,
      new_value: after.edition,
      important,
    });
  }

  if (before.status !== 'cancelled' && after.status === 'cancelled') {
    changes.push({
      kind: 'cancelled',
      old_value: before.status,
      new_value: after.status,
      important: true,
    });
  }

  return changes;
}

/**
 * Membandingkan `before` vs `after` lalu menyisipkan baris ke tabel `events`.
 */
export async function recordItemChanges(
  db: Db,
  before: ItemRow | null,
  after: ItemRow,
): Promise<EventRow[]> {
  const changes = detectItemChanges(before, after);
  if (changes.length === 0) return [];

  const inserted: EventRow[] = [];
  for (const ch of changes) {
    const { rows } = await db.query<EventRow>(
      `INSERT INTO events (item_id, kind, old_value, new_value, important)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
       RETURNING id, item_id, kind, old_value, new_value, important, created_at, sent`,
      [
        after.id,
        ch.kind,
        ch.old_value === null ? null : JSON.stringify(ch.old_value),
        ch.new_value === null ? null : JSON.stringify(ch.new_value),
        ch.important,
      ],
    );
    if (rows[0]) inserted.push(rows[0]);
  }
  return inserted;
}
