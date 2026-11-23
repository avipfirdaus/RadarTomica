import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, runMigrations, type Db } from '../src/db/client.js';
import { loadParams, setParam } from '../src/config/params.js';

describe('scaffold', () => {
  let db: Db;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => db.close());

  it('migrasi idempoten dan semua tabel ada', async () => {
    expect(await runMigrations(db)).toEqual([]);
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = rows.map((r) => r.table_name);
    for (const t of ['sources', 'snapshots', 'items', 'item_sources', 'events', 'prices', 'evaluations', 'drafts', 'params', 'channel_stats', 'runs']) {
      expect(names).toContain(t);
    }
  });

  it('params: default lalu override dengan riwayat', async () => {
    const before = await loadParams(db);
    expect(before.version).toBe(0);
    expect(before.values.fx_idr_per_jpy).toBe(115);
    await setParam(db, 'fx_idr_per_jpy', 112, 'operator');
    const after = await loadParams(db);
    expect(after.values.fx_idr_per_jpy).toBe(112);
    expect(after.version).toBeGreaterThan(0);
    await expect(setParam(db, 'fx_idr_per_jpy', 'x', 'operator')).rejects.toThrow();
  });
});
