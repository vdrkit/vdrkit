// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, copyFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import pg from 'pg';
import { fromPGlite, fromPgPool, migrate, MIGRATIONS_DIR, type Database } from '../src/index.js';
import { emptyOwnerDatabase, TEST_DATABASE_URL, type TestPg } from './real-postgres.js';

let dir: string | undefined;
let cleanup: (() => Promise<void>) | undefined;
let lite: TestPg | undefined;
afterEach(async () => {
  await cleanup?.();
  if (dir) await rm(dir, { recursive: true, force: true });
  lite = undefined; dir = undefined; cleanup = undefined;
});

async function freshDatabase(): Promise<{ db: Database; su: TestPg }> {
  if (TEST_DATABASE_URL) {
    const e = await emptyOwnerDatabase();
    const owner = new pg.Pool({ connectionString: e.url.owner, max: 1 });
    const superuser = new pg.Pool({ connectionString: e.url.superuser, max: 1 });
    cleanup = async () => { await Promise.all([owner.end(), superuser.end()]); await e.drop(); };
    const su: TestPg = {
      async query(text, params) { const r = await superuser.query(text, params as unknown[]); return { rows: r.rows }; },
      exec: (sql) => superuser.query(sql),
      close: async () => undefined,
    };
    return { db: fromPgPool(owner), su };
  }
  const l = new PGlite({ extensions: { ltree } });
  cleanup = () => l.close();
  return { db: fromPGlite(l), su: l as unknown as TestPg };
}

async function siteBefore0211(rule: 'site_admins' | 'listed' | 'domain') {
  dir = await mkdtemp(join(tmpdir(), 'vdrkit-0211-'));
  for (const f of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql') && f < '0211')) await copyFile(join(MIGRATIONS_DIR, f), join(dir, f));
  const { db, su } = await freshDatabase();
  lite = su;
  await migrate(db, dir);
  const one = async (sql: string, params: unknown[] = []) => (await lite!.query<{ id: string }>(sql, params)).rows[0]!.id;
  const t = await one(`insert into tenant (name) values ('Quillmont') returning id`);
  const person = (name: string, email: string, extra = '') =>
    one(`insert into person (tenant_id, name, email${extra ? ', ' + extra : ''}) values ($1, $2, $3${extra ? ', true' : ''}) returning id`, [t, name, email]);
  const people = {
    admin: await person('Thabo Molefe', 'thabo@quillmont.example', 'is_site_admin'),
    listed: await person('Ruth Mahlangu', 'ruth@elsewhere.example', 'can_create_rooms'),
    atDomain: await person('Anika Pillay', 'anika@quillmont.example'),
    other: await person('Jan de Vries', 'jan@bidder-a.example'),
  };
  const disabled = await person('Sipho Dlamini', 'sipho@quillmont.example');
  await su.query(`update person set disabled_at = now() where id = $1`, [disabled]);
  const all: Record<string, string> = { ...people, disabled };
  await su.query(`insert into site_settings (tenant_id, room_creation, org_domain) values ($1, $2, 'quillmont.example')`, [t, rule]);
  const can = async () => {
    const out: Record<string, boolean> = {};
    for (const [k, id] of Object.entries(all)) {
      out[k] = (await lite!.query<{ c: boolean }>(`select person_can_create_rooms($1) as c`, [id])).rows[0]!.c;
    }
    return out;
  };
  const enable = () => su.query(`update person set disabled_at = null where id = $1`, [disabled]);
  return { db, can, enable };
}

describe('upgrading room creation rules to 0211', () => {
  for (const rule of ['site_admins', 'listed', 'domain'] as const) {
    it(`keeps room creators under ${rule}`, async () => {
      const { db, can, enable } = await siteBefore0211(rule);
      const before = await can();
      expect(await migrate(db)).toEqual(expect.arrayContaining(['0211_room_creators_list.sql']));
      expect(await can()).toEqual(before);
      expect(before.admin).toBe(true);
      expect(before.other).toBe(false);
      expect(before.listed).toBe(rule === 'listed');
      expect(before.atDomain).toBe(rule === 'domain');
      const cols = (await lite!.query(`select 1 from information_schema.columns where table_name = 'site_settings' and column_name = 'room_creation'`)).rows;
      expect(cols).toHaveLength(0);
      await enable();
      expect((await can()).disabled).toBe(rule === 'domain');
      const forced = (await lite!.query<{ relname: string; relforcerowsecurity: boolean }>(
        `select relname, relforcerowsecurity from pg_class where relname in ('person', 'site_settings') and relkind = 'r' order by relname`)).rows;
      expect(forced).toEqual([
        { relname: 'person', relforcerowsecurity: true },
        { relname: 'site_settings', relforcerowsecurity: true },
      ]);
    });
  }
});
