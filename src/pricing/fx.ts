/**
 * F6: Penyedia kurs JPY→IDR (Frankfurter API + Static) serta penguncian & deteksi
 * pergeseran kurs > 3% (PRD §3, §5).
 */
import { DEFAULT_PARAMS } from '../config/params.js';
import type { Db } from '../db/client.js';
import type { FxProvider } from '../shared/types.js';

export interface FxRate {
  rate: number;
  asOf: Date;
  source: string;
}

export interface FrankfurterFxOptions {
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
}

/**
 * Penyedia kurs publik via Frankfurter API (kurs referensi ECB).
 * Mendukung injeksi `fetch` untuk pengujian tanpa akses jaringan.
 */
export class FrankfurterFxProvider implements FxProvider {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly baseUrl: string;

  constructor(opts: FrankfurterFxOptions = {}) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.baseUrl = (opts.baseUrl ?? 'https://api.frankfurter.app').replace(/\/+$/, '');
  }

  async getIdrPerJpy(): Promise<FxRate> {
    const url = `${this.baseUrl}/latest?from=JPY&to=IDR`;
    const res = await this.fetchFn(url);
    if (!res.ok) {
      throw new Error(`Frankfurter FX gagal: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      date?: string;
      rates?: Record<string, number>;
    };
    const rate = body.rates?.IDR;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      throw new Error('Frankfurter FX tidak mengembalikan kurs IDR yang valid');
    }
    const asOf = body.date ? new Date(`${body.date}T00:00:00Z`) : new Date();
    return { rate, asOf, source: 'frankfurter' };
  }
}

/** Penyedia kurs statis untuk tes atau fallback manual. */
export class StaticFxProvider implements FxProvider {
  constructor(
    private readonly rate: number,
    private readonly source: string = 'static',
    private readonly asOf: Date = new Date(),
  ) {
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`Kurs statis harus angka positif, dapat: ${rate}`);
    }
  }

  async getIdrPerJpy(): Promise<FxRate> {
    return { rate: this.rate, asOf: this.asOf, source: this.source };
  }
}

export interface FxLock {
  rate: number;
  source: string;
  lockedAt: string; // ISO UTC
}

/** Membuat objek kurs terkunci saat PO dibuka (PRD §5). */
export function lockFx(rate: number, source: string = 'param', lockedAt: Date = new Date()): FxLock {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`Kurs terkunci harus angka positif, dapat: ${rate}`);
  }
  return {
    rate,
    source,
    lockedAt: lockedAt.toISOString(),
  };
}

/** Menyimpan kurs terkunci untuk suatu batch PO ke tabel `system_state`. */
export async function saveFxLock(db: Db, batchKey: string, lock: FxLock): Promise<void> {
  const key = `fx_lock:${batchKey}`;
  await db.query(
    `INSERT INTO system_state (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(lock)],
  );
}

/** Membaca kurs terkunci suatu batch PO dari `system_state`. */
export async function getFxLock(db: Db, batchKey: string): Promise<FxLock | null> {
  const key = `fx_lock:${batchKey}`;
  const { rows } = await db.query<{ value: FxLock }>(
    `SELECT value FROM system_state WHERE key = $1`,
    [key],
  );
  return rows[0]?.value ?? null;
}

export interface FxShiftCheck {
  lockedRate: number;
  currentRate: number;
  /** Pergeseran relatif bertanda: (current - locked) / locked. */
  shift: number;
  /** Nilai absolut pergeseran relatif. */
  absShift: number;
  /** Persentase pergeseran bertanda (mis. 3.48 untuk +3.48%). */
  shiftPercent: number;
  threshold: number;
  /** True bila |shift| > threshold (default 3% sesuai PRD §5). */
  alert: boolean;
  direction: 'up' | 'down' | 'flat';
}

/**
 * Memeriksa apakah kurs saat ini bergeser melebihi ambang (default 3%) dari kurs terkunci.
 * Bila `alert === true`, operator memutuskan siapa menanggung selisih (PRD §5).
 */
export function checkFxShift(
  locked: number | FxLock,
  current: number,
  threshold: number = DEFAULT_PARAMS.fx_shift_alert,
): FxShiftCheck {
  const lockedRate = typeof locked === 'number' ? locked : locked.rate;
  if (!Number.isFinite(lockedRate) || lockedRate <= 0) {
    throw new Error(`Kurs terkunci tidak valid: ${lockedRate}`);
  }
  if (!Number.isFinite(current) || current <= 0) {
    throw new Error(`Kurs saat ini tidak valid: ${current}`);
  }

  const shift = (current - lockedRate) / lockedRate;
  const absShift = Math.abs(shift);
  const shiftPercent = Number((shift * 100).toFixed(2));
  const alert = absShift > threshold + 1e-12;
  const direction: FxShiftCheck['direction'] = shift > 0 ? 'up' : shift < 0 ? 'down' : 'flat';

  return {
    lockedRate,
    currentRate: current,
    shift,
    absShift,
    shiftPercent,
    threshold,
    alert,
    direction,
  };
}
