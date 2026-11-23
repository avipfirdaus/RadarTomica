/**
 * Pembersihan konten & hashing (PRD §4 F1):
 * - HTML -> teks utama bersih (buang script, style, nav, header, footer, aside, form, iframe,
 *   iklan, menu, jam berjalan, dan stempel waktu "updated at") agar elemen dinamis
 *   tidak memicu perubahan palsu.
 * - PDF -> teks via `unpdf`.
 * - Feed (RSS 2.0 / Atom / RDF) -> daftar entri terstruktur via `cheerio` xmlMode.
 * - pdf_index -> ekstraksi tautan PDF dari halaman daftar.
 */
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { extractText } from 'unpdf';

const NOISE_TAGS = [
  'script',
  'style',
  'noscript',
  'template',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'iframe',
  'svg',
  'canvas',
  'button',
  'input',
  'select',
  'textarea',
].join(', ');

const NOISE_ATTR_SELECTORS = [
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="complementary"]',
  '[aria-hidden="true"]',
  '[data-ad]',
  '[data-ads]',
].join(', ');

/** Pola token class/id yang menandakan iklan, menu, jam, atau stempel waktu dinamis. */
const NOISE_TOKEN_RE =
  /(?:^|[\s_-])(ad|ads|advert|advertisement|adslot|banner|sponsor|sponsored|promo|menu|navbar|navigation|sidebar|breadcrumb|breadcrumbs|clock|current-time|live-time|timestamp|updated-at|last-updated|cookie|cookie-banner|social-share|share-buttons|popup|modal)(?:$|[\s_-])/i;

/** Pola baris/frasa jam dan "updated at" yang berubah tiap kali halaman dimuat. */
const DYNAMIC_TIME_LINE_PATTERNS: readonly RegExp[] = [
  /^\s*(?:last\s+updated|updated\s+at|updated|page\s+generated|current\s+time)\s*[:：\-]?\s*.*$/i,
  /^\s*(?:最終更新|更新日時|現在時刻|ページ生成日時)\s*[:：\-]?\s*.*$/,
  /^\s*\d{1,2}:\d{2}(?::\d{2})?\s*(?:JST|UTC|GMT|WIB)?\s*$/i,
];

/** Menghitung SHA-256 hex dari teks yang sudah dibersihkan. */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Menormalkan spasi & baris kosong agar hash stabil. */
export function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u3000]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .filter((line) => !DYNAMIC_TIME_LINE_PATTERNS.some((re) => re.test(line)))
    .join('\n')
    .trim();
}

/**
 * Membersihkan HTML menjadi teks utama yang stabil untuk hashing dan ekstraksi.
 */
export function cleanHtml(html: string): string {
  const $ = cheerio.load(html);

  $(NOISE_TAGS).remove();
  $(NOISE_ATTR_SELECTORS).remove();

  // Hapus elemen yang class atau id-nya cocok dengan pola iklan/menu/jam/stempel waktu.
  $('*').each((_, el) => {
    if (el.type !== 'tag') return;
    const $el = $(el);
    const cls = $el.attr('class') ?? '';
    const id = $el.attr('id') ?? '';
    if ((cls && NOISE_TOKEN_RE.test(cls)) || (id && NOISE_TOKEN_RE.test(id))) {
      $el.remove();
    }
  });

  // Hapus teks jam / "updated at" di dalam elemen <time> yang punya kata kunci dinamis.
  $('time').each((_, el) => {
    const $el = $(el);
    const txt = $el.text().trim();
    if (/^\d{1,2}:\d{2}(?::\d{2})?\s*(?:JST|UTC|WIB)?$/i.test(txt)) {
      $el.remove();
    }
  });

  const main = $('main');
  const article = $('article');
  const root =
    main.length > 0 && main.text().trim().length > 0
      ? main
      : article.length > 0 && article.text().trim().length > 0
        ? article
        : $('body').length > 0
          ? $('body')
          : $(':root');

  // Sisipkan pemisah baris antar elemen blok agar kata tidak menempel.
  root.find('p, div, li, tr, h1, h2, h3, h4, h5, h6, br, section, dt, dd').each((_, el) => {
    $(el).append('\n');
  });

  return normalizeText(root.text());
}

/** Mengekstrak teks bersih dari biner PDF menggunakan `unpdf`. */
export async function extractPdfText(data: Uint8Array): Promise<string> {
  const copy = new Uint8Array(data);
  const { text } = await extractText(copy, { mergePages: true });
  return normalizeText(text);
}

/**
 * Mengubah RSS 2.0 / Atom / RDF menjadi teks entri yang stabil.
 * Stempel waktu build feed tingkat atas diabaikan agar tidak memicu hash palsu.
 */
export function cleanFeed(xml: string): string {
  const $ = cheerio.load(xml, { xmlMode: true });
  const entries: string[] = [];

  const nodes = $('item').length > 0 ? $('item') : $('entry');
  nodes.each((_, el) => {
    const $el = $(el);
    const title = $el.find('title').first().text().trim();
    const linkEl = $el.find('link').first();
    const link = (linkEl.attr('href') ?? linkEl.text()).trim();
    const date = (
      $el.find('pubDate').first().text() ||
      $el.find('published').first().text() ||
      $el.find('updated').first().text() ||
      $el.find('dc\\:date').first().text()
    ).trim();
    const rawDesc = (
      $el.find('description').first().text() ||
      $el.find('summary').first().text() ||
      $el.find('content').first().text() ||
      $el.find('content\\:encoded').first().text()
    ).trim();

    const desc = rawDesc ? normalizeText(cheerio.load(rawDesc).text()) : '';
    const parts = [title && `TITLE: ${title}`, link && `LINK: ${link}`, date && `DATE: ${date}`, desc && `SUMMARY: ${desc}`].filter(
      Boolean,
    );
    if (parts.length > 0) {
      entries.push(parts.join('\n'));
    }
  });

  return entries.join('\n---\n').trim();
}

/**
 * Mengekstrak semua tautan PDF absolut dari halaman daftar siaran pers (`pdf_index`).
 * Menghapus duplikat sambil mempertahankan urutan.
 */
export function extractPdfLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const links: string[] = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')?.trim();
    if (!href) return;
    try {
      const resolved = new URL(href, baseUrl);
      if (resolved.pathname.toLowerCase().endsWith('.pdf')) {
        const normalized = resolved.toString();
        if (!seen.has(normalized)) {
          seen.add(normalized);
          links.push(normalized);
        }
      }
    } catch {
      // Abaikan href tidak valid.
    }
  });

  return links;
}
