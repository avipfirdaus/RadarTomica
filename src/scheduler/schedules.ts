/**
 * Definisi jadwal otomatis Radar Tomica (PRD §8, semua dalam zona waktu Asia/Tokyo / JST).
 * Dipisahkan sebagai helper murni agar mudah diuji unit tanpa menjalankan timer.
 */
import { JST } from '../shared/time.js';

export type JobName =
  | 'p1_pipeline'
  | 'p2_ingest'
  | 'fx_evaluate'
  | 'daily_summary'
  | 'urgent_alerts'
  | 'weekly_report'
  | 'release_reminders'
  | 'release_day_check'
  | 'daily_backup';

export interface ScheduleDefinition {
  name: JobName;
  cron: string;
  timezone: typeof JST;
  description: string;
}

const SCHEDULE_DEFINITIONS: readonly ScheduleDefinition[] = [
  {
    name: 'p1_pipeline',
    cron: '0 6,18 * * *',
    timezone: JST,
    description: '06:00 dan 18:00 JST — Ambil sumber prioritas 1, ekstrak, deteksi perubahan',
  },
  {
    name: 'p2_ingest',
    cron: '0 7 * * *',
    timezone: JST,
    description: '07:00 JST — Ambil sumber prioritas 2 (media dan toko)',
  },
  {
    name: 'fx_evaluate',
    cron: '30 7 * * *',
    timezone: JST,
    description: '07:30 JST — Perbarui kurs, hitung ulang evaluasi harga',
  },
  {
    name: 'daily_summary',
    cron: '0 8 * * *',
    timezone: JST,
    description: '08:00 JST — Kirim ringkasan harian ke chat pribadi operator',
  },
  {
    name: 'urgent_alerts',
    cron: '*/15 * * * *',
    timezone: JST,
    description: 'Tiap 15 menit — Kirim peringatan penting yang antre (LAYAK baru, perubahan tanggal/harga)',
  },
  {
    name: 'weekly_report',
    cron: '0 9 * * 1',
    timezone: JST,
    description: 'Senin 09:00 JST — Sampel harga pasar Indonesia kandidat, kirim laporan mingguan',
  },
  {
    name: 'release_reminders',
    cron: '30 8 * * *',
    timezone: JST,
    description: 'Cek harian 08:30 JST — Siapkan draf pengingat H-7, H-3, H-1 sebelum Sabtu ketiga',
  },
  {
    name: 'release_day_check',
    cron: '0 10 * * 6#3',
    timezone: JST,
    description: 'Sabtu ketiga 10:00 JST — Cek ulang sumber resmi pada hari rilis',
  },
  {
    name: 'daily_backup',
    cron: '0 3 * * *',
    timezone: JST,
    description: '03:00 JST — Cadangkan data',
  },
] as const;

/** Helper murni yang mengembalikan daftar lengkap definisi jadwal (ekspresi cron + zona waktu JST). */
export function getScheduleDefinitions(): readonly ScheduleDefinition[] {
  return SCHEDULE_DEFINITIONS;
}
