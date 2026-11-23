/**
 * Registri sumber data prioritas 1 dan 2 (PRD bagian 3).
 *
 * CATATAN FASE 0 (belum diverifikasi):
 * - URL persis halaman daftar siaran pers, ketersediaan RSS resmi Takara Tomy,
 *   serta URL feed media (Motor-Fan, Car Watch, Toy People) wajib diverifikasi di Fase 0.
 * - Takara Tomy Mall hanya memantau halaman produk yang ditandai operator; akses
 *   dari luar Jepang juga perlu diuji di Fase 0.
 */
import type { Db } from '../db/client.js';
import type { SourceKind } from '../shared/types.js';

export interface SeedSource {
  id: string;
  name: string;
  url: string;
  priority: 1 | 2 | 3;
  kind: SourceKind;
  /** Label jadwal: 'p1' (06:00 & 18:00 JST) atau 'p2' (07:00 JST). */
  schedule: 'p1' | 'p2';
  enabled: boolean;
}

/**
 * Daftar sumber awal dari PRD §3.
 * URL/RSS persis ditandai untuk verifikasi di Fase 0.
 */
export const SEED_SOURCES: readonly SeedSource[] = [
  {
    id: 'takaratomy-lineup',
    name: 'Situs Resmi Tomica (Takara Tomy)',
    // Fase 0: verifikasi apakah halaman lineup memakai konten statis atau perlu sub-halaman bulanan, serta cek ketersediaan RSS.
    url: 'https://www.takaratomy.co.jp/products/tomica/',
    priority: 1,
    kind: 'page',
    schedule: 'p1',
    enabled: true,
  },
  {
    id: 'takaratomy-press',
    name: 'Siaran Pers Takara Tomy (PDF)',
    // Fase 0: verifikasi URL halaman daftar siaran pers (JP/EN) yang memuat tautan PDF per tanggal.
    url: 'https://www.takaratomy.co.jp/english/product_release/',
    priority: 1,
    kind: 'pdf_index',
    schedule: 'p1',
    enabled: true,
  },
  {
    id: 'takaratomy-mall',
    name: 'Takara Tomy Mall',
    // Fase 0: verifikasi akses luar Jepang; di produksi operator menandai URL halaman produk spesifik.
    url: 'https://takaratomymall.jp/',
    priority: 1,
    kind: 'shop',
    schedule: 'p1',
    enabled: true,
  },
  {
    id: 'motor-fan',
    name: 'Motor-Fan',
    // Fase 0: verifikasi URL RSS resmi atau ganti ke halaman kategori Tomica bila RSS tidak tersedia.
    url: 'https://motor-fan.jp/feed/',
    priority: 2,
    kind: 'feed',
    schedule: 'p2',
    enabled: true,
  },
  {
    id: 'car-watch',
    name: 'Car Watch',
    // Fase 0: verifikasi URL RSS/RDF Car Watch dan filter berita Tomica.
    url: 'https://car.watch.impress.co.jp/data/rss/1.0/car/feed.rdf',
    priority: 2,
    kind: 'feed',
    schedule: 'p2',
    enabled: true,
  },
  {
    id: 'toy-people',
    name: 'Toy People JP',
    // Fase 0: verifikasi URL RSS Toy People JP atau halaman kategori Tomica.
    url: 'https://www.toy-people.com/jp/feed',
    priority: 2,
    kind: 'feed',
    schedule: 'p2',
    enabled: true,
  },
] as const;

/**
 * Mengisi / memperbarui tabel `sources` secara idempoten (upsert).
 * Tidak menimpa status operasional (`enabled`, `paused`, `last_status`, `consecutive_failures`).
 */
export async function seedSources(db: Db, sources: readonly SeedSource[] = SEED_SOURCES): Promise<number> {
  for (const s of sources) {
    await db.query(
      `INSERT INTO sources (id, name, url, priority, kind, schedule, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         url = EXCLUDED.url,
         priority = EXCLUDED.priority,
         kind = EXCLUDED.kind,
         schedule = EXCLUDED.schedule`,
      [s.id, s.name, s.url, s.priority, s.kind, s.schedule, s.enabled],
    );
  }
  return sources.length;
}
