// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { fromPGlite, migrate, type Database } from '@vdrkit/core';
import { MemoryStorage } from '../src/pipeline/pipeline.js';

// hands the worker's pool the PGlite below
const pool = vi.hoisted(() => ({ lite: null as null | { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> } }));
vi.mock('pg', () => ({
  default: {
    Pool: class {
      async connect() { return { query: (t: string, p?: unknown[]) => pool.lite!.query(t, p), release() {} }; }
      async end() {}
    },
  },
}));

const { refuseUnsafeWorkerStart, runWorker } = await import('../src/worker-main.js');

const lites: PGlite[] = [];
const saved = { ...process.env };
beforeEach(() => {
  Object.assign(process.env, { DATABASE_URL: 'postgres://worker@127.0.0.1:1/vdrkit', VDRKIT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') });
});
afterEach(async () => {
  for (const k of ['DATABASE_URL', 'VDRKIT_MASTER_KEY']) {
    if (k in saved) process.env[k] = saved[k]; else delete process.env[k];
  }
  for (const l of lites.splice(0)) await l.close();
});

async function lite(migrated: boolean): Promise<{ lite: PGlite; db: Database; as(role: string): Database }> {
  const l = new PGlite({ extensions: { ltree } });
  lites.push(l);
  const db = fromPGlite(l);
  if (migrated) await migrate(db);
  await db.exec(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'vdrkit_t_plain') then create role vdrkit_t_plain nologin nosuperuser nobypassrls; end if;
  end $$;`);
  const as = (role: string): Database => ({
    transaction: (fn) => db.transaction(async (tx) => { await tx.query(`set local role ${role}`); return fn(tx); }),
    exec: (sql) => db.exec(sql),
  });
  return { lite: l, db, as };
}

describe('worker start-up checks', () => {
  it('starts on an up-to-date database', async () => {
    const s = await lite(true);
    await expect(refuseUnsafeWorkerStart(s.as('vdrkit_app'))).resolves.toBeUndefined();
  });

  it('refuses a superuser', async () => {
    const s = await lite(true);
    await expect(refuseUnsafeWorkerStart(s.db)).rejects.toThrow(/is a superuser\. .* The worker does not start\./);
  });

  it('refuses a database with migrations not applied', async () => {
    const s = await lite(false);
    await expect(refuseUnsafeWorkerStart(s.as('vdrkit_t_plain'))).rejects.toThrow(
      /^The database is not up to date: \d+ migrations not applied \(0001_core\.sql, .*\)\. The worker does not start\. Run the migrate command first/);
  });

  it('checks before starting the queue', async () => {
    const s = await lite(true);
    pool.lite = s.lite as unknown as typeof pool.lite;
    await expect(runWorker({ storage: new MemoryStorage() })).rejects.toThrow(/is a superuser\. .* The worker does not start\./);
  });
});
