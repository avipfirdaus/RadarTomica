import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type Db } from '../db/client.js';
import {
  isReleaseWeek,
  releaseCalendar,
  reminderDue,
  thirdSaturday,
  upcomingThirdSaturdays,
} from './index.js';

describe('F7 calendar', () => {
  it('computes thirdSaturday (JST) accurately for 12 months from Dec 2026 (PRD §11)', () => {
    const expected12Months: [number, number, string][] = [
      [2026, 12, '2026-12-19'], // PRD §11 explicit
      [2027, 1, '2027-01-16'], // PRD §11 explicit
      [2027, 2, '2027-02-20'],
      [2027, 3, '2027-03-20'],
      [2027, 4, '2027-04-17'],
      [2027, 5, '2027-05-15'],
      [2027, 6, '2027-06-19'],
      [2027, 7, '2027-07-17'],
      [2027, 8, '2027-08-21'],
      [2027, 9, '2027-09-18'],
      [2027, 10, '2027-10-16'],
      [2027, 11, '2027-11-20'],
    ];

    for (const [y, m, iso] of expected12Months) {
      expect(thirdSaturday(y, m)).toBe(iso);
    }

    expect(upcomingThirdSaturdays('2026-12-01', 12)).toEqual(expected12Months.map((e) => e[2]));
  });

  it('determines H-7 / H-3 / H-1 reminderDue for upcoming third Saturday', () => {
    // 2026-12-19 is 3rd Saturday
    expect(reminderDue('2026-12-12')).toEqual({
      today: '2026-12-12',
      nextThirdSaturday: '2026-12-19',
      daysUntil: 7,
      due: ['H-7'],
      isReleaseDay: false,
    });
    expect(reminderDue('2026-12-16')).toEqual({
      today: '2026-12-16',
      nextThirdSaturday: '2026-12-19',
      daysUntil: 3,
      due: ['H-3'],
      isReleaseDay: false,
    });
    expect(reminderDue('2026-12-18')).toEqual({
      today: '2026-12-18',
      nextThirdSaturday: '2026-12-19',
      daysUntil: 1,
      due: ['H-1'],
      isReleaseDay: false,
    });
    expect(reminderDue('2026-12-19')).toEqual({
      today: '2026-12-19',
      nextThirdSaturday: '2026-12-19',
      daysUntil: 0,
      due: [],
      isReleaseDay: true,
    });
    // Day after Dec 19 looks ahead to Jan 16, 2027
    expect(reminderDue('2026-12-20').nextThirdSaturday).toBe('2027-01-16');
    expect(reminderDue('2026-12-20').due).toEqual([]);
  });

  it('checks isReleaseWeek (ISO week Mon–Sun JST) for first-edition rule', () => {
    // 2026-12-19 (Sat): ISO week is Mon 2026-12-14 .. Sun 2026-12-20
    expect(isReleaseWeek('2026-12-13', '2026-12-19')).toBe(false);
    expect(isReleaseWeek('2026-12-14', '2026-12-19')).toBe(true);
    expect(isReleaseWeek('2026-12-19', '2026-12-19')).toBe(true);
    expect(isReleaseWeek('2026-12-20', '2026-12-19')).toBe(true);
    expect(isReleaseWeek('2026-12-21', '2026-12-19')).toBe(false);
  });

  describe('releaseCalendar (DB)', () => {
    let db: Db;

    beforeAll(async () => {
      db = await createTestDb();
    });

    afterAll(async () => {
      await db.close();
    });

    beforeEach(async () => {
      await db.query('TRUNCATE items RESTART IDENTITY CASCADE');
    });

    it('returns items within 90 days with third-Saturday and preorder deadline markers', async () => {
      await db.query(
        `INSERT INTO items (canonical_key, tomica_no, name_ja, edition, release_date_jst, price_jpy, status, ignored) VALUES
         ('a:regular:2026-12-19', 94, '光岡 M55', 'regular', '2026-12-19', 594, 'announced', false),
         ('b:first:2027-01-16', 17, 'フェラーリ', 'first', '2027-01-16', 594, 'preorder', false),
         ('c:collab:2026-12-25', NULL, 'ディズニー ミッキー', 'collab', '2026-12-25', 990, 'announced', false),
         ('d:regular:2027-06-19', 50, '遠いモデル', 'regular', '2027-06-19', 594, 'announced', false),
         ('e:regular:2026-12-19', 10, 'キャンセル品', 'regular', '2026-12-19', 594, 'cancelled', false),
         ('f:regular:2026-12-19', 11, '無視品', 'regular', '2026-12-19', 594, 'announced', true)`,
      );

      const cal = await releaseCalendar(db, '2026-12-01', 90);
      expect(cal).toHaveLength(3);

      expect(cal[0]).toMatchObject({
        name_ja: '光岡 M55',
        release_date_jst: '2026-12-19',
        is_third_saturday: true,
        preorder_deadline_jst: '2026-12-12',
        days_until_release: 18,
      });

      expect(cal[1]).toMatchObject({
        name_ja: 'ディズニー ミッキー',
        release_date_jst: '2026-12-25',
        is_third_saturday: false,
        preorder_deadline_jst: '2026-12-18',
        days_until_release: 24,
      });

      expect(cal[2]).toMatchObject({
        name_ja: 'フェラーリ',
        release_date_jst: '2027-01-16',
        is_third_saturday: true,
        preorder_deadline_jst: '2027-01-09',
        days_until_release: 46,
      });
    });
  });
});
