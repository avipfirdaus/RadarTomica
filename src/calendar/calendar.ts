/**
 * F7: Kalender rilis Tomica — perhitungan Sabtu ketiga (JST), kalender rilis 90 hari
 * dengan penanda batas pre-order, pengingat H-7/H-3/H-1, dan pengecekan pekan rilis
 * (PRD §4 F7, §5, §8, §11).
 */
import { DateTime } from 'luxon';
import type { Db } from '../db/client.js';
import { JST, todayJst } from '../shared/time.js';
import type { Edition, ItemStatus } from '../shared/types.js';

export type ReminderCode = 'H-7' | 'H-3' | 'H-1';

export interface CalendarEntry {
  item_id: number;
  tomica_no: number | null;
  name_ja: string;
  name_id: string | null;
  edition: Edition;
  status: ItemStatus;
  release_date_jst: string;
  price_jpy: number | null;
  is_rare: boolean;
  /** True bila tanggal rilis jatuh pada Sabtu ketiga bulan tersebut. */
  is_third_saturday: boolean;
  /** Penanda batas pre-order (default H-7 sebelum tanggal rilis, format YYYY-MM-DD JST). */
  preorder_deadline_jst: string;
  /** Selisih hari dari `fromDate` menuju `release_date_jst`. */
  days_until_release: number;
}

export interface ReminderDueResult {
  today: string;
  nextThirdSaturday: string;
  daysUntil: number;
  due: ReminderCode[];
  isReleaseDay: boolean;
}

function toJstIsoDate(input: string | Date): string {
  if (input instanceof Date) {
    return todayJst(input);
  }
  const dt = DateTime.fromISO(input, { zone: JST });
  if (!dt.isValid) {
    throw new Error(`Tanggal JST tidak valid: ${input}`);
  }
  return dt.toISODate()!;
}

/**
 * Menghitung tanggal Sabtu ketiga untuk `(year, month)` dalam zona JST (`YYYY-MM-DD`).
 * `month` berbasis 1 (1 = Januari .. 12 = Desember).
 */
export function thirdSaturday(year: number, month: number): string {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Tahun/bulan tidak valid: year=${year}, month=${month}`);
  }
  const firstOfMonth = DateTime.fromObject({ year, month, day: 1 }, { zone: JST });
  // Luxon weekday: 1=Senin .. 6=Sabtu, 7=Minggu
  const offsetToFirstSat = (6 - firstOfMonth.weekday + 7) % 7;
  const thirdSatDay = 1 + offsetToFirstSat + 14;
  return firstOfMonth.set({ day: thirdSatDay }).toISODate()!;
}

/**
 * Mengembalikan daftar `months` tanggal Sabtu ketiga berikutnya mulai dari `fromDate` (inklusif).
 */
export function upcomingThirdSaturdays(fromDate: string | Date, months: number = 12): string[] {
  const fromIso = toJstIsoDate(fromDate);
  const start = DateTime.fromISO(fromIso, { zone: JST });
  const results: string[] = [];

  let cursor = start.set({ day: 1 });
  while (results.length < months) {
    const sat = thirdSaturday(cursor.year, cursor.month);
    if (sat >= fromIso) {
      results.push(sat);
    }
    cursor = cursor.plus({ months: 1 });
  }
  return results;
}

/**
 * Menyusun kalender rilis untuk `days` hari ke depan (default 90 hari) dari tabel `items`,
 * lengkap dengan penanda Sabtu ketiga dan batas pre-order (default H-7).
 */
export async function releaseCalendar(
  db: Db,
  fromDate: string | Date,
  days: number = 90,
  opts: { preorderLeadDays?: number } = {},
): Promise<CalendarEntry[]> {
  const fromIso = toJstIsoDate(fromDate);
  const fromDt = DateTime.fromISO(fromIso, { zone: JST });
  const toIso = fromDt.plus({ days }).toISODate()!;
  const preorderLeadDays = opts.preorderLeadDays ?? 7;

  const { rows } = await db.query<{
    id: number;
    tomica_no: number | null;
    name_ja: string;
    name_id: string | null;
    edition: Edition;
    status: ItemStatus;
    release_date_jst: string;
    price_jpy: number | null;
    is_rare: boolean;
  }>(
    `SELECT id, tomica_no, name_ja, name_id, edition, status, release_date_jst, price_jpy, is_rare
     FROM items
     WHERE ignored = false
       AND status <> 'cancelled'
       AND release_date_jst IS NOT NULL
       AND release_date_jst >= $1
       AND release_date_jst <= $2
     ORDER BY release_date_jst ASC, tomica_no ASC NULLS LAST, name_ja ASC`,
    [fromIso, toIso],
  );

  return rows.map((row) => {
    const relDt = DateTime.fromISO(row.release_date_jst, { zone: JST });
    const isThirdSat = row.release_date_jst === thirdSaturday(relDt.year, relDt.month);
    const deadlineIso = relDt.minus({ days: preorderLeadDays }).toISODate()!;
    const daysUntil = Math.round(relDt.diff(fromDt, 'days').days);

    return {
      item_id: row.id,
      tomica_no: row.tomica_no,
      name_ja: row.name_ja,
      name_id: row.name_id,
      edition: row.edition,
      status: row.status,
      release_date_jst: row.release_date_jst,
      price_jpy: row.price_jpy,
      is_rare: row.is_rare,
      is_third_saturday: isThirdSat,
      preorder_deadline_jst: deadlineIso,
      days_until_release: daysUntil,
    };
  });
}

/**
 * Menentukan pengingat H-7 / H-3 / H-1 mana yang jatuh tempo pada `today` (JST)
 * untuk rilis Sabtu ketiga berikutnya (PRD §8).
 */
export function reminderDue(today: string | Date): ReminderDueResult {
  const todayIso = toJstIsoDate(today);
  const todayDt = DateTime.fromISO(todayIso, { zone: JST });
  const nextThirdSat = upcomingThirdSaturdays(todayIso, 1)[0]!;
  const satDt = DateTime.fromISO(nextThirdSat, { zone: JST });
  const daysUntil = Math.round(satDt.diff(todayDt, 'days').days);

  const due: ReminderCode[] = [];
  if (daysUntil === 7) due.push('H-7');
  if (daysUntil === 3) due.push('H-3');
  if (daysUntil === 1) due.push('H-1');

  return {
    today: todayIso,
    nextThirdSaturday: nextThirdSat,
    daysUntil,
    due,
    isReleaseDay: daysUntil === 0,
  };
}

/**
 * Memeriksa apakah `date` jatuh pada pekan rilis (ISO week Senin–Minggu JST) yang sama
 * dengan `releaseDate`. Digunakan untuk aturan first edition (PRD §5).
 */
export function isReleaseWeek(date: string | Date, releaseDate: string): boolean {
  const dIso = toJstIsoDate(date);
  const dDt = DateTime.fromISO(dIso, { zone: JST });
  const rDt = DateTime.fromISO(releaseDate, { zone: JST });
  if (!dDt.isValid || !rDt.isValid) return false;
  return dDt.weekYear === rDt.weekYear && dDt.weekNumber === rDt.weekNumber;
}
