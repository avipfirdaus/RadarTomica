import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type Db } from '../db/client.js';
import type { SnapshotRow, SourceRow } from '../shared/types.js';
import {
  cleanFeed,
  cleanHtml,
  createPolitenessState,
  extractPdfLinks,
  extractPdfText,
  ingestSchedule,
  ingestSource,
  seedSources,
  sha256,
  type FetchFn,
  type IngestDeps,
} from './index.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures/ingest');

function loadFixtureText(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

function loadFixtureBytes(name: string): Buffer {
  return readFileSync(join(FIXTURES_DIR, name));
}

function createFakeClock(startMs = Date.UTC(2026, 10, 23, 0, 0, 0)) {
  let currentMs = startMs;
  const sleeps: number[] = [];
  return {
    now: () => new Date(currentMs),
    sleep: async (ms: number) => {
      sleeps.push(ms);
      currentMs += ms;
    },
    advance: (ms: number) => {
      currentMs += ms;
    },
    sleeps,
  };
}

const TEST_ENV = {
  HTTP_USER_AGENT: 'RadarTomicaTestBot/0.1',
  HTTP_MIN_DELAY_MS: 5000,
};

describe('F1 Ingest — pembersihan konten & hash', () => {
  it('menghasilkan hash identik meski iklan, menu, jam, dan updated-at berubah', () => {
    const html1 = loadFixtureText('lineup-v1.html');
    const html2 = loadFixtureText('lineup-v2-same-content.html');
    const html3 = loadFixtureText('lineup-v3-changed.html');

    const cleaned1 = cleanHtml(html1);
    const cleaned2 = cleanHtml(html2);
    const cleaned3 = cleanHtml(html3);

    expect(cleaned1).toContain('No.94 光岡 M55');
    expect(cleaned1).not.toContain('広告バナー');
    expect(cleaned1).not.toContain('06:00:01');
    expect(cleaned1).not.toContain('最終更新');
    expect(cleaned1).toBe(cleaned2);
    expect(sha256(cleaned1)).toBe(sha256(cleaned2));
    expect(sha256(cleaned1)).not.toBe(sha256(cleaned3));
  });

  it('membersihkan RSS feed dan mengabaikan lastBuildDate tingkat feed', () => {
    const rss1 = loadFixtureText('media-feed.xml');
    const rss2 = rss1.replace('Mon, 23 Nov 2026 07:00:00 +0900', 'Mon, 23 Nov 2026 19:00:00 +0900');

    const cleaned1 = cleanFeed(rss1);
    const cleaned2 = cleanFeed(rss2);

    expect(cleaned1).toContain('トミカ No.94 光岡 M55 初回特別仕様が登場');
    expect(cleaned1).toContain('https://motor-fan.jp/article/1456717/');
    expect(sha256(cleaned1)).toBe(sha256(cleaned2));
  });

  it('mengekstrak teks dari fixture PDF via unpdf', async () => {
    const pdfBytes = loadFixtureBytes('press-release.pdf');
    const text = await extractPdfText(new Uint8Array(pdfBytes));
    expect(text).toContain('Takara Tomy Press Release');
    expect(text).toContain('Mitsuoka M55');
    expect(text).toContain('594 JPY');
  });

  it('mengekstrak tautan PDF unik dan absolut dari halaman daftar siaran pers', () => {
    const html = loadFixtureText('press-index.html');
    const links = extractPdfLinks(html, 'https://www.takaratomy.co.jp/english/product_release/');
    expect(links).toEqual([
      'https://www.takaratomy.co.jp/english/product_release/pdf/p261219_en.pdf',
      'https://www.takaratomy.co.jp/english/product_release/pdf/p261220_en.pdf',
    ]);
  });
});

describe('F1 Ingest — database, robots.txt, rate limit, dan kegagalan', () => {
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    await seedSources(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('seedSources bersifat idempoten dan mempertahankan status operasional', async () => {
    await db.query(`UPDATE sources SET paused = true, consecutive_failures = 2 WHERE id = 'motor-fan'`);
    const count = await seedSources(db);
    expect(count).toBe(6);

    const { rows } = await db.query<SourceRow>(`SELECT * FROM sources WHERE id = 'motor-fan'`);
    expect(rows[0]?.paused).toBe(true);
    expect(rows[0]?.consecutive_failures).toBe(2);
  });

  it('dedup berdasarkan content_hash: isi sama tidak membuat snapshot baru', async () => {
    const clock = createFakeClock();
    const htmlV1 = loadFixtureText('lineup-v1.html');
    const htmlV2 = loadFixtureText('lineup-v2-same-content.html');
    const htmlV3 = loadFixtureText('lineup-v3-changed.html');

    let currentHtml = htmlV1;
    const seenHeaders: Record<string, string>[] = [];

    const mockFetch: FetchFn = async (input, init) => {
      const url = String(input);
      const h = new Headers(init?.headers);
      seenHeaders.push({ ua: h.get('user-agent') ?? '', cookie: h.get('cookie') ?? '' });
      if (url.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nAllow: /\n', { status: 200 });
      }
      return new Response(currentHtml, { status: 200, headers: { 'content-type': 'text/html' } });
    };

    const deps: IngestDeps = {
      db,
      env: TEST_ENV,
      fetch: mockFetch,
      sleep: clock.sleep,
      now: clock.now,
      politeness: createPolitenessState(),
    };

    // 1. Pertama kali: snapshot baru dibuat
    const r1 = await ingestSource(deps, 'takaratomy-lineup');
    expect(r1.status).toBe('ok');
    expect(r1.newSnapshotIds).toHaveLength(1);
    expect(seenHeaders[0]?.ua).toBe('RadarTomicaTestBot/0.1');
    expect(seenHeaders[0]?.cookie).toBe('');

    // 2. Isi utama sama, hanya iklan/jam berubah => unchanged, tidak ada snapshot baru
    currentHtml = htmlV2;
    const r2 = await ingestSource(deps, 'takaratomy-lineup');
    expect(r2.status).toBe('unchanged');
    expect(r2.newSnapshotIds).toHaveLength(0);

    // 3. Isi utama berubah => snapshot baru dibuat
    currentHtml = htmlV3;
    const r3 = await ingestSource(deps, 'takaratomy-lineup');
    expect(r3.status).toBe('ok');
    expect(r3.newSnapshotIds).toHaveLength(1);

    const { rows } = await db.query<SnapshotRow>(
      `SELECT * FROM snapshots WHERE source_id = 'takaratomy-lineup' ORDER BY id ASC`,
    );
    expect(rows).toHaveLength(2);
  });

  it('memblokir URL yang dilarang robots.txt dan tidak pernah mengambil halaman target', async () => {
    const clock = createFakeClock();
    const robotsTxt = loadFixtureText('robots-disallow.txt');
    const requestedUrls: string[] = [];

    await db.query(
      `INSERT INTO sources (id, name, url, priority, kind, schedule)
       VALUES ('blocked-src', 'Sumber Dilarang', 'https://example.jp/blocked/page.html', 2, 'page', 'p2')`,
    );

    const mockFetch: FetchFn = async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.endsWith('/robots.txt')) {
        return new Response(robotsTxt, { status: 200 });
      }
      throw new Error('Tidak boleh dipanggil saat robots.txt melarang');
    };

    const res = await ingestSource(
      { db, env: TEST_ENV, fetch: mockFetch, sleep: clock.sleep, now: clock.now },
      'blocked-src',
    );

    expect(res.status).toBe('blocked_robots');
    expect(res.newSnapshotIds).toHaveLength(0);
    expect(requestedUrls).toEqual(['https://example.jp/robots.txt']);

    const { rows } = await db.query<SourceRow>(`SELECT * FROM sources WHERE id = 'blocked-src'`);
    expect(rows[0]?.last_status).toBe('blocked_robots');
    expect(rows[0]?.consecutive_failures).toBe(0);
  });

  it('menegakkan jeda minimal >= 5000ms antar permintaan ke host yang sama (jam palsu)', async () => {
    const clock = createFakeClock();
    const requestTimestamps: number[] = [];

    const mockFetch: FetchFn = async (input) => {
      const url = String(input);
      requestTimestamps.push(clock.now().getTime());
      if (url.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nAllow: /\n', { status: 200 });
      }
      return new Response(loadFixtureText('lineup-v1.html'), { status: 200 });
    };

    // Bahkan bila env diberi < 5000, floor 5000ms tetap ditegakkan.
    const deps: IngestDeps = {
      db,
      env: { HTTP_USER_AGENT: 'RadarTomicaTestBot/0.1', HTTP_MIN_DELAY_MS: 1000 },
      fetch: mockFetch,
      sleep: clock.sleep,
      now: clock.now,
      politeness: createPolitenessState(),
    };

    await ingestSource(deps, 'takaratomy-lineup');
    await ingestSource(deps, 'takaratomy-lineup');

    // Permintaan 0: robots.txt, Permintaan 1: halaman (call 1), Permintaan 2: halaman (call 2, robots di-cache)
    expect(requestTimestamps).toHaveLength(3);
    expect(requestTimestamps[1]! - requestTimestamps[0]!).toBeGreaterThanOrEqual(5000);
    expect(requestTimestamps[2]! - requestTimestamps[1]!).toBeGreaterThanOrEqual(5000);
    expect(clock.sleeps.every((ms) => ms >= 5000)).toBe(true);
  });

  it('pdf_index hanya mengunduh PDF yang belum pernah dilihat dan menyimpan tiap PDF sebagai snapshot', async () => {
    const clock = createFakeClock();
    const indexHtml = loadFixtureText('press-index.html');
    const pdf1 = loadFixtureBytes('press-release.pdf');
    const pdf2 = loadFixtureBytes('press-release-2.pdf');
    const fetchedPdfs: string[] = [];

    const mockFetch: FetchFn = async (input) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) {
        return new Response('', { status: 404 });
      }
      if (url.endsWith('p261219_en.pdf')) {
        fetchedPdfs.push(url);
        return new Response(pdf1, { status: 200, headers: { 'content-type': 'application/pdf' } });
      }
      if (url.endsWith('p261220_en.pdf')) {
        fetchedPdfs.push(url);
        return new Response(pdf2, { status: 200, headers: { 'content-type': 'application/pdf' } });
      }
      return new Response(indexHtml, { status: 200, headers: { 'content-type': 'text/html' } });
    };

    const deps: IngestDeps = {
      db,
      env: TEST_ENV,
      fetch: mockFetch,
      sleep: clock.sleep,
      now: clock.now,
      politeness: createPolitenessState(),
    };

    const r1 = await ingestSource(deps, 'takaratomy-press');
    expect(r1.status).toBe('ok');
    expect(r1.newSnapshotIds).toHaveLength(2);
    expect(fetchedPdfs).toHaveLength(2);

    // Jalankan ulang: kedua PDF sudah pernah dilihat (by final_url), tidak boleh diunduh ulang
    const r2 = await ingestSource(deps, 'takaratomy-press');
    expect(r2.status).toBe('unchanged');
    expect(r2.newSnapshotIds).toHaveLength(0);
    expect(fetchedPdfs).toHaveLength(2);
  });

  it('2 kegagalan berturut-turut menjeda sumber & menghasilkan peringatan; sukses mereset penghitung', async () => {
    const clock = createFakeClock();
    let shouldFail = true;

    const mockFetch: FetchFn = async (input) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) {
        return new Response('', { status: 404 });
      }
      if (shouldFail) {
        return new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' });
      }
      return new Response(loadFixtureText('media-feed.xml'), { status: 200 });
    };

    const deps: IngestDeps = {
      db,
      env: TEST_ENV,
      fetch: mockFetch,
      sleep: clock.sleep,
      now: clock.now,
    };

    // Gagal ke-1 pada motor-fan: belum paused, belum ada alert
    const f1 = await ingestSource(deps, 'motor-fan');
    expect(f1.status).toBe('error');
    expect(f1.alert).toBeUndefined();
    let src = (await db.query<SourceRow>(`SELECT * FROM sources WHERE id = 'motor-fan'`)).rows[0]!;
    expect(src.consecutive_failures).toBe(1);
    expect(src.paused).toBe(false);

    // Sukses setelah 1 gagal: penghitung direset ke 0
    shouldFail = false;
    const ok = await ingestSource(deps, 'motor-fan');
    expect(ok.status).toBe('ok');
    src = (await db.query<SourceRow>(`SELECT * FROM sources WHERE id = 'motor-fan'`)).rows[0]!;
    expect(src.consecutive_failures).toBe(0);
    expect(src.paused).toBe(false);

    // Sekarang 2 gagal berturut-turut => paused=true + alert
    shouldFail = true;
    const e1 = await ingestSource(deps, 'motor-fan');
    expect(e1.status).toBe('error');
    expect(e1.alert).toBeUndefined();

    const e2 = await ingestSource(deps, 'motor-fan');
    expect(e2.status).toBe('error');
    expect(e2.alert).toBeDefined();
    expect(e2.alert?.sourceId).toBe('motor-fan');
    expect(e2.alert?.message).toContain('2 kali berturut-turut');

    src = (await db.query<SourceRow>(`SELECT * FROM sources WHERE id = 'motor-fan'`)).rows[0]!;
    expect(src.consecutive_failures).toBe(2);
    expect(src.paused).toBe(true);

    // Panggilan berikutnya tanpa force => skipped
    const skipped = await ingestSource(deps, 'motor-fan');
    expect(skipped.status).toBe('skipped');
  });

  it('ingestSchedule membungkus siklus dalam withRun dan menjalankan semua sumber jadwal tsb', async () => {
    const clock = createFakeClock();
    const rss = loadFixtureText('media-feed.xml');

    const mockFetch: FetchFn = async (input) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
      return new Response(rss, { status: 200 });
    };

    const results = await ingestSchedule(
      { db, env: TEST_ENV, fetch: mockFetch, sleep: clock.sleep, now: clock.now },
      'p2',
    );

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === 'ok')).toBe(true);

    const { rows } = await db.query<{ module: string; status: string; processed_count: number }>(
      `SELECT module, status, processed_count FROM runs ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]).toEqual({ module: 'ingest', status: 'ok', processed_count: 3 });
  });
});
