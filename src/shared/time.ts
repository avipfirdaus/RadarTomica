/** Utilitas waktu: simpan UTC, tampilkan JST & WIB (PRD bagian 6). */
import { DateTime } from 'luxon';

export const JST = 'Asia/Tokyo';
export const WIB = 'Asia/Jakarta';

/** Tanggal hari ini di JST sebagai 'YYYY-MM-DD'. */
export function todayJst(now: Date = new Date()): string {
  return DateTime.fromJSDate(now).setZone(JST).toISODate()!;
}

/** Format tampilan ganda, mis. "23 Nov 2026 08:00 JST / 06:00 WIB". */
export function formatJstWib(d: Date): string {
  const j = DateTime.fromJSDate(d).setZone(JST);
  const w = DateTime.fromJSDate(d).setZone(WIB);
  return `${j.setLocale('id').toFormat('d LLL yyyy HH:mm')} JST / ${w.toFormat('HH:mm')} WIB`;
}

export function hoursBetween(a: Date, b: Date): number {
  return Math.abs(b.getTime() - a.getTime()) / 3_600_000;
}
