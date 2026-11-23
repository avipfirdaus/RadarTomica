import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cron } from 'croner';
import { DateTime } from 'luxon';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type Db } from '../db/client.js';
import { seedSources, type FetchFn } from '../ingest/index.js';
import type { SourceRow } from '../shared/types.js';
import {
  createScheduler,
  forceRefetch,
  getScheduleDefinitions,
  isPaused,
  recentRuns,
  resumeSource,
  runScheduledJob,
  setPaused,
} from './index.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures/ingest');

describe('Scheduler — definisi jadwal (PRD §8, zona Asia/Tokyo)', () => {
  it('mengekspor seluruh jadwal PRD §8 dalam zona waktu Asia/Tokyo dengan ekspresi cron valid', () => {
    const defs = getScheduleDefinitions();
    const byName = new Map(defs.map((d) => [d.name, d]));

    expect(defs.every((d) => d.timezone === 'Asia/Tokyo')).toBe(true);
    expect(byName.get('p1_pipeline')?.cron).toBe('0 6,18 * * *');
    expect(byName.get('p2_ingest')?.cron).toBe('0 7 * * *');
    expect(byName.get('fx_evaluate')?.cron).toBe('30 7 * * *');
    expect(byName.get('daily_summary')?.cron).toBe('0 8 * * *');
    expect(byName.get('urgent_alerts')?.cron).toBe('*/15 * * * *');
    expect(byName.get('weekly_report')?.cron).toBe('0 9 * * 1');
    expect(byName.get('release_reminders')?.cron).toBe('30 8 * * *');
    expect(byName.get('release_day_check')?.cron).toBe('0 10 * * 6#3');
    expect(byName.get('daily_backup')?.cron).toBe('0 3 * * *');

    // Validasi bahwa setiap ekspresi bisa diparsing oleh croner
    for (const def of defs) {
      const c = new Cron(def.cron, { timezone: def.timezone, paused: true });
      expect(c.nextRun(new Date('2026-11-23T00:00:00Z'))).toBeInstanceOf(Date);
      c.stop();
    }
  });

  it('jadwal release_day_check tepat jatuh pada Sabtu ketiga 10:00 JST (19 Des 2026 & 16 Jan 2027)', () => {
    const def = getScheduleDefinitions().find((d) => d.name === 'release_day_check')!;
    const c = new Cron(def.cron, { timezone: def.timezone, paused: true });

    const dec = c.nextRun(new Date('2026-12-01T00:00:00Z'))!;
    const jan = c.nextRun(dec)!;
    const feb = c.nextRun(jan)!;
    c.stop();

    const toJst = (d: Date) => DateTime.fromJSDate(d).setZone('Asia/Tokyo').toFormat('yyyy-MM-dd HH:mm');
    expect(toJst(dec)).toBe('2026-12-19 10:00');
    expect(toJst(jan)).toBe('2027-01-16 10:00');
    expect(toJst(feb)).toBe('2027-02-20 10:00');
  });
});

describe('Scheduler — jeda global, kontrol operator, dan log runs', () => {
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    await seedSources(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('jeda global melewati pekerjaan terjadwal dengan status skipped', async () => {
    expect(await isPaused(db)).toBe(false);

    let called = 0;
    const handler = async () => {
      called += 1;
      return 5;
    };

    // Aktifkan jeda global
    await setPaused(db, true, 'operator');
    expect(await isPaused(db)).toBe(true);

    const r1 = await runScheduledJob(db, 'daily_summary', handler);
    expect(r1).toBe('skipped');
    expect(called).toBe(0);

    // Matikan jeda global
    await setPaused(db, false, 'operator');
    expect(await isPaused(db)).toBe(false);

    const r2 = await runScheduledJob(db, 'daily_summary', handler);
    expect(r2).toBe('ok');
    expect(called).toBe(1);

    const runs = await recentRuns(db, 10);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.module).toBe('scheduler:daily_summary');
    expect(runs[0]?.status).toBe('ok');
    expect(runs[0]?.processed_count).toBe(5);
    expect(runs[1]?.status).toBe('skipped');
  });

  it('createScheduler mendaftarkan job croner dengan handler dan mendukung runNow + stop', async () => {
    let executed = 0;
    const scheduler = createScheduler(
      db,
      {
        p1_pipeline: async () => {
          executed += 1;
          return 3;
        },
        daily_backup: async () => {
          throw new Error('disk full');
        },
      },
      { startPaused: true },
    );

    try {
      expect(scheduler.jobs.size).toBe(2);
      const status = await scheduler.jobs.get('p1_pipeline')!.runNow();
      expect(status).toBe('ok');
      expect(executed).toBe(1);

      await expect(scheduler.jobs.get('daily_backup')!.runNow()).rejects.toThrow('disk full');

      const runs = await recentRuns(db, 5);
      expect(runs[0]?.module).toBe('scheduler:daily_backup');
      expect(runs[0]?.status).toBe('error');
      expect(runs[0]?.error).toContain('disk full');
      expect(runs[1]?.module).toBe('scheduler:p1_pipeline');
      expect(runs[1]?.status).toBe('ok');
    } finally {
      scheduler.stop();
    }
  });

  it('resumeSource mengaktifkan kembali sumber yang dijeda dan mereset penghitung gagal', async () => {
    await db.query(
      `UPDATE sources SET paused = true, consecutive_failures = 2, last_error = 'timeout' WHERE id = 'motor-fan'`,
    );

    const updated = await resumeSource(db, 'motor-fan');
    expect(updated).toBe(true);
    expect(await resumeSource(db, 'tidak-ada')).toBe(false);

    const { rows } = await db.query<SourceRow>(`SELECT * FROM sources WHERE id = 'motor-fan'`);
    expect(rows[0]?.paused).toBe(false);
    expect(rows[0]?.consecutive_failures).toBe(0);
    expect(rows[0]?.last_error).toBeNull();
  });

  it('forceRefetch mereset kegagalan dan tetap mengambil meski sumber sedang paused', async () => {
    await db.query(
      `UPDATE sources SET paused = true, consecutive_failures = 2, last_error = 'HTTP 500' WHERE id = 'takaratomy-lineup'`,
    );

    const html = readFileSync(join(FIXTURES_DIR, 'lineup-v1.html'), 'utf8');
    const mockFetch: FetchFn = async (input) => {
      if (String(input).endsWith('/robots.txt')) return new Response('', { status: 404 });
      return new Response(html, { status: 200 });
    };

    const res = await forceRefetch(
      {
        db,
        env: { HTTP_USER_AGENT: 'RadarTomicaTestBot/0.1', HTTP_MIN_DELAY_MS: 5000 },
        fetch: mockFetch,
        sleep: async () => {},
        now: () => new Date('2026-11-23T01:00:00Z'),
      },
      'takaratomy-lineup',
    );

    expect(res.status).toBe('ok');
    expect(res.newSnapshotIds).toHaveLength(1);

    const { rows } = await db.query<SourceRow>(`SELECT * FROM sources WHERE id = 'takaratomy-lineup'`);
    expect(rows[0]?.paused).toBe(false);
    expect(rows[0]?.consecutive_failures).toBe(0);
    expect(rows[0]?.last_status).toBe('ok');
  });
});
