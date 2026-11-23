/**
 * Modul Penjadwal (PRD §8) menggunakan `croner` di zona waktu Asia/Tokyo.
 * Menerima peta `JobName -> JobHandler` dari orkestrator sehingga modul ini
 * tetap terpisah dari modul agen lain.
 */
import { Cron } from 'croner';
import type { Db } from '../db/client.js';
import { logger, withRun } from '../shared/logger.js';
import { isPaused } from './controls.js';
import { getScheduleDefinitions, type JobName, type ScheduleDefinition } from './schedules.js';

export { getScheduleDefinitions, type JobName, type ScheduleDefinition } from './schedules.js';
export { forceRefetch, isPaused, recentRuns, resumeSource, setPaused, type RunRow } from './controls.js';

/** Handler pekerjaan terjadwal; opsional mengembalikan jumlah item yang diproses. */
export type JobHandler = () => Promise<number | void>;
export type JobHandlers = Partial<Record<JobName, JobHandler>>;

export interface SchedulerOptions {
  /** Mulai dalam keadaan croner paused (berguna untuk pengujian). Default: false. */
  startPaused?: boolean;
}

export interface ScheduledJobHandle {
  definition: ScheduleDefinition;
  cron: Cron;
  /** Memicu eksekusi pekerjaan secara manual (tetap menghormati jeda global & withRun). */
  runNow: () => Promise<'ok' | 'skipped'>;
}

export interface SchedulerInstance {
  jobs: Map<JobName, ScheduledJobHandle>;
  start(): void;
  stop(): void;
}

/**
 * Menjalankan satu pekerjaan terjadwal dengan pemeriksaan jeda global dan pencatatan `runs`.
 * Bila jeda global aktif, pekerjaan dilewati dengan status `'skipped'`.
 */
export async function runScheduledJob(
  db: Db,
  jobName: JobName,
  handler: JobHandler,
): Promise<'ok' | 'skipped'> {
  const moduleName = `scheduler:${jobName}`;
  if (await isPaused(db)) {
    await db.query(
      `INSERT INTO runs (module, started_at, finished_at, status, processed_count)
       VALUES ($1, now(), now(), 'skipped', 0)`,
      [moduleName],
    );
    logger.info({ job: jobName }, 'Pekerjaan terjadwal dilewati karena jeda global aktif');
    return 'skipped';
  }

  await withRun(db, moduleName, async ({ setProcessed }) => {
    const count = await handler();
    if (typeof count === 'number') {
      setProcessed(count);
    }
  });

  return 'ok';
}

/**
 * Membuat kumpulan pekerjaan `croner` sesuai PRD §8 (zona waktu Asia/Tokyo, anti-overlap `protect: true`).
 * Hanya pekerjaan yang memiliki handler di `handlers` yang didaftarkan.
 */
export function createScheduler(
  db: Db,
  handlers: JobHandlers,
  opts?: SchedulerOptions,
): SchedulerInstance {
  const jobs = new Map<JobName, ScheduledJobHandle>();

  for (const def of getScheduleDefinitions()) {
    const handler = handlers[def.name];
    if (!handler) continue;

    const runNow = () => runScheduledJob(db, def.name, handler);

    const cron = new Cron(
      def.cron,
      {
        timezone: def.timezone,
        protect: true,
        paused: opts?.startPaused ?? false,
        catch: (err) => {
          logger.error({ err, job: def.name }, 'Galat pada pekerjaan terjadwal');
        },
      },
      async () => {
        await runNow();
      },
    );

    jobs.set(def.name, { definition: def, cron, runNow });
  }

  return {
    jobs,
    start() {
      for (const handle of jobs.values()) {
        handle.cron.resume();
      }
    },
    stop() {
      for (const handle of jobs.values()) {
        handle.cron.stop();
      }
    },
  };
}
