// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../src/index.js';
import { freshDatabase, heron, T, type Heron } from './fixture.js';


let h: Heron;
beforeEach(async () => { h = await heron(); });
afterEach(async () => { await h.pg.close(); });

const asApp = <R>(tenant: string, fn: (tx: { query: <T = any>(sql: string, p?: unknown[]) => Promise<{ rows: T[] }> }) => Promise<R>) =>
  withTenant(h.db, tenant, fn as never, { role: 'vdrkit_app' });

describe('site settings', () => {
  it('keeps settings per tenant', async () => {
    await h.pg.query(`insert into site_settings (tenant_id, org_name) values ($1, 'Quillmont'), ($2, 'Other')`, [h.t1, h.t2]);
    expect(await asApp(h.t1, async (tx) => (await tx.query(`select org_name from site_settings`)).rows)).toEqual([{ org_name: 'Quillmont' }]);
    await expect(asApp(h.t1, (tx) => tx.query(`insert into site_settings (tenant_id) values ($1)`, [h.t2]))).rejects.toThrow();
    await asApp(h.t1, (tx) => tx.query(`update site_settings set org_name = 'Hijacked' where tenant_id = $1`, [h.t2]));
    expect((await h.pg.query<any>(`select org_name from site_settings where tenant_id = $1`, [h.t2])).rows[0].org_name).toBe('Other');
    await expect(asApp(h.t1, (tx) => tx.query(`insert into site_health_state (tenant_id, check_key, status, last_checked_at) values ($1, 'database', 'ok', now())`, [h.t2]))).rejects.toThrow();
  });

  it('stamps changes with database time', async () => {
    await h.pin(T.ndaPublished);
    await asApp(h.t1, (tx) => tx.query(`insert into site_settings (tenant_id, updated_at) values (current_tenant_id(), '2000-01-01')`));
    const r = (await h.pg.query<any>(`select updated_at from site_settings`)).rows[0];
    expect(new Date(r.updated_at).toISOString()).toBe(T.ndaPublished.toISOString());
  });

  it('only allows alert delays of 5, 15 or 60 minutes', async () => {
    await expect(h.pg.query(`insert into site_settings (tenant_id, alert_after_minutes) values ($1, 10)`, [h.t1])).rejects.toThrow();
  });
});

describe('site tenant', () => {
  it('can be set once by its own tenant', async () => {
    await expect(asApp(h.t1, (tx) => tx.query(`insert into site_instance (tenant_id) values ($1)`, [h.t2]))).rejects.toThrow();
    await asApp(h.t1, (tx) => tx.query(`insert into site_instance (tenant_id) values (current_tenant_id())`));
    await expect(asApp(h.t2, (tx) => tx.query(`insert into site_instance (tenant_id) values (current_tenant_id())`))).rejects.toThrow();
    await expect(asApp(h.t1, (tx) => tx.query(`update site_instance set tenant_id = $1`, [h.t2]))).rejects.toThrow();
    await expect(asApp(h.t1, (tx) => tx.query(`delete from site_instance`))).rejects.toThrow();
    // readable without a tenant, for the sign-in page logo
    const r = await h.db.transaction(async (tx) => { await tx.query(`set local role vdrkit_app`); return (await tx.query(`select tenant_id from site_instance`)).rows; });
    expect(r).toEqual([{ tenant_id: h.t1 }]);
  });
});

describe('first-run setup', () => {
  it('is open only on an empty installation', async () => {
    const asAppNoTenant = (sql: string) => h.db.transaction(async (tx) => { await tx.query(`set local role vdrkit_app`); return (await tx.query<any>(sql)).rows[0]; });
    expect(await asAppNoTenant(`select site_setup_open() as open`)).toEqual({ open: false });
    const empty = await freshDatabase();
    try {
      const q = (sql: string) => empty.db.transaction(async (tx) => { await tx.query(`set local role vdrkit_app`); return (await tx.query<any>(sql)).rows[0]; });
      expect(await q(`select site_setup_open() as open`)).toEqual({ open: true });
      await empty.pg.query(`insert into auth_user (id, name, email) values ('u1', 'Someone', 's@x.example')`);
      expect(await q(`select site_setup_open() as open`)).toEqual({ open: false });
    } finally { await empty.pg.close(); }
  });

  it('should not let the app role list tenants', async () => {
    const rows = await h.db.transaction(async (tx) => {
      await tx.query(`set local role vdrkit_app`);
      await tx.query(`select set_config('vdrkit.setup_listing', 'on', true)`);
      return (await tx.query(`select id from tenant`)).rows;
    });
    expect(rows).toEqual([]);
  });
});

describe('site admins and room creators', () => {
  const can = (p: string) => asApp(h.t1, async (tx) => (await tx.query<{ c: boolean }>(`select person_can_create_rooms($1) as c`, [p])).rows[0]!.c);

  it('lets site admins and listed people create rooms', async () => {
    await h.pg.query(`update person set is_site_admin = true where id = $1`, [h.person.anika]);
    await h.pg.query(`update person set can_create_rooms = true where id = $1`, [h.person.maria]);
    expect([await can(h.person.anika), await can(h.person.maria), await can(h.person.jan)]).toEqual([true, true, false]);
    await h.pg.query(`insert into site_settings (tenant_id, org_domain) values ($1, 'bidder-a.example')`, [h.t1]);
    expect([await can(h.person.anika), await can(h.person.maria), await can(h.person.jan)]).toEqual([true, true, false]);
    const other = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email, is_site_admin) values ($1, 'X', 'x@x.example', true) returning id`, [h.t2])).rows[0]!.id;
    expect(await can(other)).toBe(false);
  });

  it('stamps disabled_at once and unlinks sign-in', async () => {
    await h.pg.query(`insert into auth_person (tenant_id, person_id, email) values ($1, $2, 'jan@bidder-a.example')`, [h.t1, h.person.jan]);
    await h.pin(T.setup);
    await asApp(h.t1, (tx) => tx.query(`update person set disabled_at = '1999-01-01' where id = $1`, [h.person.jan]));
    const first = (await h.pg.query<any>(`select disabled_at from person where id = $1`, [h.person.jan])).rows[0].disabled_at;
    expect(new Date(first).toISOString()).toBe(T.setup.toISOString());
    await h.pin(T.at);
    await asApp(h.t1, (tx) => tx.query(`update person set disabled_at = now() where id = $1`, [h.person.jan]));
    expect(new Date((await h.pg.query<any>(`select disabled_at from person where id = $1`, [h.person.jan])).rows[0].disabled_at).toISOString()).toBe(T.setup.toISOString());
    expect((await h.pg.query(`select 1 from auth_person where person_id = $1`, [h.person.jan])).rows).toHaveLength(0);
    expect(await can(h.person.jan)).toBe(false);
  });
});

describe('upgrading an existing installation', () => {
  async function upgrade(tenants: string[]) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { ltree } = await import('@electric-sql/pglite/contrib/ltree');
    const { mkdtemp, readdir, copyFile, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { fromPGlite, migrate, MIGRATIONS_DIR } = await import('../src/index.js');
    const dir = await mkdtemp(join(tmpdir(), 'vdrkit-0017-'));
    const lite = new PGlite({ extensions: { ltree } });
    try {
      const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
      for (const f of files.filter((f) => f < '0017')) await copyFile(join(MIGRATIONS_DIR, f), join(dir, f));
      const db = fromPGlite(lite);
      await migrate(db, dir);
      for (const name of tenants) await lite.query(`insert into tenant (name) values ($1)`, [name]);
      for (const f of files.filter((f) => f >= '0017')) await copyFile(join(MIGRATIONS_DIR, f), join(dir, f));
      await migrate(db, dir);
      return (await lite.query<{ tenant_id: string; name: string }>(`select s.tenant_id, t.name from site_instance s join tenant t on t.id = s.tenant_id`)).rows;
    } finally {
      await lite.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('uses the only tenant as the site tenant', async () => {
    expect(await upgrade(['Quillmont Advisory'])).toEqual([{ tenant_id: expect.any(String), name: 'Quillmont Advisory' }]);
  });

  it('guesses nothing with several tenants or none', async () => {
    expect(await upgrade(['Quillmont Advisory', 'Other'])).toEqual([]);
    expect(await upgrade([])).toEqual([]);
  });
});
