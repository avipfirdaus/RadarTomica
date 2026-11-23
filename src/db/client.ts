/**
 * Abstraksi basis data minimal. Produksi memakai Postgres (`pg`), tes memakai
 * PGlite (Postgres in-process) sehingga SQL yang sama berjalan di keduanya.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface QueryResult<T> {
  rows: T[];
}

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Menjalankan fn di dalam transaksi; rollback bila fn melempar galat. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function createPgDb(connectionString: string): Promise<Db> {
  const pg = await import('pg');
  // Kembalikan bigint/numeric sebagai number (aman untuk skala data radar).
  pg.default.types.setTypeParser(20, (v: string) => Number(v));
  pg.default.types.setTypeParser(1700, (v: string) => Number(v));
  pg.default.types.setTypeParser(1082, (v: string) => v); // date -> 'YYYY-MM-DD'
  const pool = new pg.default.Pool({ connectionString });
  const wrap = (q: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }): Omit<Db, 'transaction' | 'close'> => ({
    async query<T>(sql: string, params?: unknown[]) {
      const r = await q.query(sql, params);
      return { rows: r.rows as T[] };
    },
  });
  return {
    ...wrap(pool),
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx: Db = {
          ...wrap(client),
          transaction: (inner) => inner(tx),
          close: async () => {},
        };
        const out = await fn(tx);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Basis data in-memory untuk tes. Sudah termigrasi. */
export async function createTestDb(): Promise<Db> {
  const { PGlite, types } = await import('@electric-sql/pglite');
  const pg = new PGlite({
    parsers: {
      [types.INT8]: (v: string) => Number(v),
      [types.NUMERIC]: (v: string) => Number(v),
      [types.DATE]: (v: string) => v,
    },
  });
  const db: Db = {
    async query<T>(sql: string, params?: unknown[]) {
      const r = await pg.query<T>(sql, params as unknown[] | undefined);
      return { rows: r.rows };
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return pg.transaction(async (t) => {
        const tx: Db = {
          async query<U>(sql: string, params?: unknown[]) {
            const r = await t.query<U>(sql, params as unknown[] | undefined);
            return { rows: r.rows };
          },
          transaction: (inner) => inner(tx),
          close: async () => {},
        };
        return fn(tx);
      }) as Promise<T>;
    },
    close: () => pg.close(),
  };
  await runMigrations(db);
  return db;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Menjalankan semua file migrations/*.sql secara berurutan (idempoten). */
export async function runMigrations(db: Db): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const ran: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, f), 'utf8');
    await db.transaction(async (tx) => {
      for (const stmt of splitSql(sql)) await tx.query(stmt);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    });
    ran.push(f);
  }
  return ran;
}

function splitSql(sql: string): string[] {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}
