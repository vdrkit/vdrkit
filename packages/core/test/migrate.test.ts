// SPDX-License-Identifier: AGPL-3.0-only
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import pg from 'pg';
import { fromPGlite, fromPgPool, migrate, migrationStatus, MigrationError, MIGRATIONS_DIR, type Database } from '../src/index.js';
import { emptyOwnerDatabase, TEST_DATABASE_URL } from './real-postgres.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function ownerDatabase(): Promise<{ db: Database; app: Database; another?: () => Database; superuser?: pg.Pool }> {
  if (TEST_DATABASE_URL) {
    const e = await emptyOwnerDatabase();
    const pools: pg.Pool[] = [];
    const pool = (url: string) => { const p = new pg.Pool({ connectionString: url, max: 2 }); pools.push(p); return p; };
    const appUrl = new URL(e.url.owner);
    appUrl.username = 'vdrkit_app';
    appUrl.password = 'vdrkit_app_test';
    cleanups.push(async () => { await Promise.all(pools.map((p) => p.end())); await e.drop(); });
    return {
      db: fromPgPool(pool(e.url.owner)),
      app: fromPgPool(pool(appUrl.toString())),
      another: () => fromPgPool(pool(e.url.owner)),
      superuser: pool(e.url.superuser),
    };
  }
  const lite = new PGlite({ extensions: { ltree } });
  cleanups.push(() => lite.close());
  const db = fromPGlite(lite);
  const app: Database = {
    transaction: (fn) => db.transaction(async (tx) => { await tx.query('set local role vdrkit_app'); return fn(tx); }),
    exec: (sql) => db.exec(sql),
  };
  return { db, app };
}

async function folder(upTo: string, extra: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vdrkit-migrate-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  for (const f of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql') && f < upTo)) await copyFile(join(MIGRATIONS_DIR, f), join(dir, f));
  for (const [name, sql] of Object.entries(extra)) await writeFile(join(dir, name), sql);
  return dir;
}

const shipped = async () => (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

describe('migrate', () => {
  it('logs one line per migration', async () => {
    const { db } = await ownerDatabase();
    const lines: string[] = [];
    const applied = await migrate(db, { log: (l) => lines.push(l) });
    const all = await shipped();
    expect(applied).toEqual(all);
    expect(lines[0]).toBe(`Applying ${all.length} of ${all.length} migrations.`);
    for (const f of all) expect(lines.filter((l) => l.startsWith(`Migration ${f} applied in `))).toHaveLength(1);
    expect(lines.at(-1)).toBe(`Database is up to date: ${all.length} migrations applied.`);

    const again: string[] = [];
    expect(await migrate(db, { log: (l) => again.push(l) })).toEqual([]);
    expect(again).toEqual([`Database is up to date: ${all.length} migrations, none pending.`]);
  });

  it('accepts a folder as the second argument', async () => {
    const { db } = await ownerDatabase();
    const dir = await folder('0003');
    expect(await migrate(db, dir)).toEqual(['0001_core.sql', '0002_workspace_keys.sql']);
  });

  it('should roll back a failed migration and stop', async () => {
    const { db } = await ownerDatabase();
    const dir = await folder('0003', {
      '0002_zz_broken.sql': `create table half_done (id int);\nselect no_such_function();`,
      '0002_zzz_after.sql': `create table after_broken (id int);`,
    });
    const lines: string[] = [];
    const err = await migrate(db, { dir, log: (l) => lines.push(l) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MigrationError);
    expect((err as MigrationError).file).toBe('0002_zz_broken.sql');
    expect((err as Error).message).toMatch(/^Migration 0002_zz_broken\.sql failed and was rolled back\. Nothing after it was applied\. /);
    expect(lines).toContainEqual(expect.stringMatching(/^Migration 0002_zz_broken\.sql failed after \d+ ms and was rolled back\.$/));

    const names = (await db.transaction((tx) => tx.query<{ name: string }>('select name from schema_migrations order by name'))).rows.map((r) => r.name);
    expect(names).toEqual(['0001_core.sql', '0002_workspace_keys.sql']);
    const tables = (await db.transaction((tx) => tx.query<{ n: string }>(
      `select table_name n from information_schema.tables where table_name in ('half_done', 'after_broken')`))).rows;
    expect(tables).toEqual([]);

    await rm(join(dir, '0002_zz_broken.sql'));
    expect(await migrate(db, dir)).toEqual(['0002_zzz_after.sql']);
  });
});

describe('migrationStatus', () => {
  it('finds nothing pending on a migrated database', async () => {
    const { db, app } = await ownerDatabase();
    await migrate(db);
    expect(await migrationStatus(app)).toEqual({ pending: [], unknown: [] });
  });

  it('lists pending and unknown migrations', async () => {
    const { db, app } = await ownerDatabase();
    await migrate(db);
    const newer = await folder('9999', { '0999_future.sql': 'select 1;' });
    expect(await migrationStatus(app, newer)).toEqual({ pending: ['0999_future.sql'], unknown: [] });
    const older = await folder('0250');
    expect(await migrationStatus(app, older)).toEqual({ pending: [], unknown: (await shipped()).filter((f) => f >= '0250') });
  });

  it('treats 0250 onwards as pending on an old database', async () => {
    const { db, app } = await ownerDatabase();
    await migrate(db, await folder('0250'));
    const status = await migrationStatus(app);
    expect(status.pending).toEqual((await shipped()).filter((f) => f >= '0250'));
  });

  it('counts everything as pending on an empty database', async () => {
    const { db } = await ownerDatabase();
    expect((await migrationStatus(db)).pending).toEqual(await shipped());
  });

  it('should not let the app role write', async () => {
    const { db, app } = await ownerDatabase();
    await migrate(db);
    await expect(app.transaction((tx) => tx.query(`insert into schema_migrations (name) values ('9999_forged.sql')`))).rejects.toThrow(/permission denied/);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('migration lock', () => {
  it('lets two instances migrate at once', async () => {
    const { db, another } = await ownerDatabase();
    const second = another!();
    const a: string[] = [];
    const b: string[] = [];
    const [ra, rb] = await Promise.all([
      migrate(db, { log: (l) => a.push(l), lockPollMs: 50 }),
      migrate(second, { log: (l) => b.push(l), lockPollMs: 50 }),
    ]);
    const all = await shipped();
    expect([...ra, ...rb].sort()).toEqual(all);
    expect([ra.length, rb.length].sort((x, y) => x - y)).toEqual([0, all.length]);
    const waited = ra.length === 0 ? a : b;
    expect(waited).toContain('Another instance is applying migrations. Waiting for it to finish.');
    expect(waited.at(-1)).toBe(`Database is up to date: ${all.length} migrations, none pending.`);
  });

  it('times out waiting for the lock', async () => {
    const { db, superuser } = await ownerDatabase();
    const holder = await superuser!.connect();
    try {
      await holder.query(`select pg_advisory_lock(hashtext('vdrkit migrations'))`);
      await expect(migrate(db, { lockWaitMs: 300, lockPollMs: 50 })).rejects.toThrow(/held the migration lock for 0 seconds/);
      const run = migrate(db, { lockWaitMs: 10_000, lockPollMs: 50 });
      await new Promise((r) => setTimeout(r, 200));
      await holder.query(`select pg_advisory_unlock(hashtext('vdrkit migrations'))`);
      expect((await run).length).toBe((await shipped()).length);
    } finally {
      holder.release();
    }
  });
});
