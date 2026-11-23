/**
 * HTTP fetcher sopan (PRD §3 & §9):
 * - Memeriksa robots.txt per host (di-cache per host); jika dilarang => blocked_robots, tidak pernah fetch.
 * - Jeda minimal per host >= HTTP_MIN_DELAY_MS (minimal 5000 ms).
 * - User-Agent khusus dari env, timeout terukur, tanpa login, tanpa cookie.
 * - Fetch, sleep, dan jam dapat diinjeksi untuk pengujian deterministik tanpa jaringan.
 */
import robotsParser from 'robots-parser';
import type { Env } from '../config/env.js';

export type FetchFn = typeof globalThis.fetch;
export type SleepFn = (ms: number) => Promise<void>;
export type NowFn = () => Date;

type RobotInstance = ReturnType<typeof robotsParser>;

/** State politeness per siklus/instance: cache robots.txt dan waktu request terakhir per host. */
export interface PolitenessState {
  robotsCache: Map<string, RobotInstance | null>;
  lastRequestByHost: Map<string, number>;
}

export function createPolitenessState(): PolitenessState {
  return {
    robotsCache: new Map(),
    lastRequestByHost: new Map(),
  };
}

export interface FetcherOptions {
  env: Pick<Env, 'HTTP_USER_AGENT' | 'HTTP_MIN_DELAY_MS'>;
  fetch?: FetchFn;
  sleep?: SleepFn;
  now?: NowFn;
  timeoutMs?: number;
  politeness?: PolitenessState;
}

export type FetchResult =
  | {
      blocked: true;
      finalUrl: string;
    }
  | {
      blocked: false;
      finalUrl: string;
      status: number;
      contentType: string;
      bytes: Uint8Array;
      text: string;
    };

export const MIN_DELAY_FLOOR_MS = 5000;
const DEFAULT_TIMEOUT_MS = 15_000;

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultNow: NowFn = () => new Date();

export class PoliteFetcher {
  private readonly fetchFn: FetchFn;
  private readonly sleepFn: SleepFn;
  private readonly nowFn: NowFn;
  private readonly userAgent: string;
  private readonly minDelayMs: number;
  private readonly timeoutMs: number;
  private readonly state: PolitenessState;

  constructor(opts: FetcherOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.sleepFn = opts.sleep ?? defaultSleep;
    this.nowFn = opts.now ?? defaultNow;
    this.userAgent = opts.env.HTTP_USER_AGENT;
    // PRD §3: jeda minimal 5 detik antar permintaan ke satu host.
    this.minDelayMs = Math.max(MIN_DELAY_FLOOR_MS, opts.env.HTTP_MIN_DELAY_MS);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.state = opts.politeness ?? createPolitenessState();
  }

  /**
   * Mengambil URL setelah memverifikasi robots.txt dan menegakkan jeda per host.
   * Tidak mengirim cookie atau kredensial login.
   */
  async get(targetUrl: string, opts?: { binary?: boolean }): Promise<FetchResult> {
    const parsed = new URL(targetUrl);
    const origin = parsed.origin;
    const host = parsed.host.toLowerCase();

    const robot = await this.getRobots(origin, host);
    if (robot && robot.isAllowed(targetUrl, this.userAgent) === false) {
      return { blocked: true, finalUrl: targetUrl };
    }

    const crawlDelaySec = robot?.getCrawlDelay(this.userAgent);
    const effectiveDelayMs =
      crawlDelaySec !== undefined && Number.isFinite(crawlDelaySec)
        ? Math.max(this.minDelayMs, Math.ceil(crawlDelaySec * 1000))
        : this.minDelayMs;

    await this.waitForHost(host, effectiveDelayMs);
    const res = await this.rawFetch(targetUrl);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} saat mengambil ${targetUrl}`);
    }

    const finalUrl = res.url || targetUrl;
    const contentType = res.headers.get('content-type') ?? '';
    const buf = new Uint8Array(await res.arrayBuffer());
    const text = opts?.binary ? '' : new TextDecoder('utf-8').decode(buf);

    return {
      blocked: false,
      finalUrl,
      status: res.status,
      contentType,
      bytes: buf,
      text,
    };
  }

  private async getRobots(origin: string, host: string): Promise<RobotInstance | null> {
    if (this.state.robotsCache.has(origin)) {
      return this.state.robotsCache.get(origin) ?? null;
    }

    const robotsUrl = `${origin}/robots.txt`;
    await this.waitForHost(host, this.minDelayMs);
    const res = await this.rawFetch(robotsUrl);

    if (res.status === 404 || res.status === 410) {
      // Tidak ada robots.txt => diizinkan secara default.
      this.state.robotsCache.set(origin, null);
      return null;
    }

    if (!res.ok) {
      throw new Error(`Gagal mengambil robots.txt (${res.status}) untuk ${origin}`);
    }

    const body = await res.text();
    const parsed = robotsParser(robotsUrl, body);
    this.state.robotsCache.set(origin, parsed);
    return parsed;
  }

  private async waitForHost(host: string, delayMs: number): Promise<void> {
    const last = this.state.lastRequestByHost.get(host);
    if (last !== undefined) {
      const elapsed = this.nowFn().getTime() - last;
      if (elapsed < delayMs) {
        await this.sleepFn(delayMs - elapsed);
      }
    }
    this.state.lastRequestByHost.set(host, this.nowFn().getTime());
  }

  private async rawFetch(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(url, {
        method: 'GET',
        redirect: 'follow',
        credentials: 'omit',
        signal: controller.signal,
        headers: {
          'User-Agent': this.userAgent,
          Accept: '*/*',
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
