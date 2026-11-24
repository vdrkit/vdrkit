// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import pg from 'pg';
import { checkRole, fromPGlite, fromPgPool, refuseUnsafeRole, type Database } from '../src/index.js';
import { emptyOwnerDatabase, TEST_DATABASE_URL } from './real-postgres.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function server(): Promise<{ superuser: Database; as(role: string): Database; owner?: Database }> {
  let superuser: Database;
  let owner: Database | undefined;
  if (TEST_DATABASE_URL) {
    const e = await emptyOwnerDatabase();
    const pools = [new pg.Pool({ connectionString: e.url.superuser, max: 1 }), new pg.Pool({ connectionString: e.url.owner, max: 1 })];
    cleanups.push(async () => { await Promise.all(pools.map((p) => p.end())); await e.drop(); });
    superuser = fromPgPool(pools[0]!);
    owner = fromPgPool(pools[1]!);
  } else {
    const lite = new PGlite({ extensions: { ltree } });
    cleanups.push(() => lite.close());
    superuser = fromPGlite(lite);
  }
  // cluster-wide roles, nologin
  await superuser.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'vdrkit_t_plain') then create role vdrkit_t_plain nologin nosuperuser nobypassrls; end if;
      if not exists (select 1 from pg_roles where rolname = 'vdrkit_t_bypass') then create role vdrkit_t_bypass nologin nosuperuser bypassrls; end if;
    end $$;`);
  const as = (role: string): Database => ({
    transaction: (fn) => superuser.transaction(async (tx) => { await tx.query(`set local role ${role}`); return fn(tx); }),
    exec: (sql) => superuser.exec(sql),
  });
  return { superuser, as, ...(owner ? { owner } : {}) };
}

describe('role safety', () => {
  it('accepts an ordinary role', async () => {
    const s = await server();
    const c = await checkRole(s.as('vdrkit_t_plain'));
    expect(c).toEqual({ role: 'vdrkit_t_plain', superuser: false, bypassRls: false, ownsTables: false, problems: [] });
    await expect(refuseUnsafeRole(s.as('vdrkit_t_plain'), 'DATABASE_URL', 'api')).resolves.toMatchObject({ problems: [] });
  });

  it('refuses a superuser', async () => {
    const s = await server();
    const c = await checkRole(s.superuser);
    expect(c.superuser).toBe(true);
    expect(c.problems).toEqual([`The role "${c.role}" is a superuser. A superuser ignores row-level security, so every room would be visible to every query.`]);
    await expect(refuseUnsafeRole(s.superuser, 'DATABASE_URL', 'api')).rejects.toThrow(
      `is a superuser. A superuser ignores row-level security, so every room would be visible to every query. The api does not start. Point DATABASE_URL at a role made with "create role ... login nosuperuser nobypassrls"`);
  });

  it('refuses BYPASSRLS', async () => {
    const s = await server();
    const c = await checkRole(s.as('vdrkit_t_bypass'));
    expect(c).toMatchObject({ role: 'vdrkit_t_bypass', superuser: false, bypassRls: true });
    await expect(refuseUnsafeRole(s.as('vdrkit_t_bypass'), 'MIGRATION_DATABASE_URL', 'migration')).rejects.toThrow(
      'The role "vdrkit_t_bypass" has BYPASSRLS. It ignores row-level security, so every room would be visible to every query. The migration does not start. '
      + 'Point MIGRATION_DATABASE_URL at a role made with "create role ... login nosuperuser nobypassrls", as the install guide describes, or remove the attribute: alter role vdrkit_t_bypass nosuperuser nobypassrls;');
  });

  it.skipIf(!TEST_DATABASE_URL)('accepts the bundled owner role', async () => {
    const s = await server();
    expect(await checkRole(s.owner!)).toEqual({ role: 'vdrkit_owner', superuser: false, bypassRls: false, ownsTables: false, problems: [] });
  });

  async function withEventTable(s: Awaited<ReturnType<typeof server>>): Promise<void> {
    await s.superuser.exec(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'vdrkit_t_owner') then create role vdrkit_t_owner nologin nosuperuser nobypassrls; end if;
        if not exists (select 1 from pg_roles where rolname = 'vdrkit_t_member') then create role vdrkit_t_member nologin nosuperuser nobypassrls; end if;
      end $$;
      grant vdrkit_t_owner to vdrkit_t_member;
      create table public.event (id bigint);
      alter table public.event owner to vdrkit_t_owner;`);
  }

  it('refuses the table owner as the app role', async () => {
    const s = await server();
    await withEventTable(s);
    for (const role of ['vdrkit_t_owner', 'vdrkit_t_member']) {
      const c = await checkRole(s.as(role));
      expect(c).toMatchObject({ role, superuser: false, bypassRls: false, ownsTables: true });
      await expect(refuseUnsafeRole(s.as(role), 'DATABASE_URL', 'api')).rejects.toThrow(
        `The role "${role}" owns the VDRkit tables. An owner is not held to the rules that keep the audit log unchangeable, and can switch row-level security off. `
        + "The api does not start. Point DATABASE_URL at the application's role (vdrkit_app in the bundled Postgres), not at the owner that MIGRATION_DATABASE_URL uses");
    }
  });

  it('accepts the owner for migrations and a plain role for the API', async () => {
    const s = await server();
    await withEventTable(s);
    await expect(refuseUnsafeRole(s.as('vdrkit_t_owner'), 'MIGRATION_DATABASE_URL', 'migration')).resolves.toMatchObject({ ownsTables: true, problems: [] });
    await expect(refuseUnsafeRole(s.as('vdrkit_t_plain'), 'DATABASE_URL', 'api')).resolves.toMatchObject({ ownsTables: false, problems: [] });
    // a lone superuser, as on PGlite
    expect(await checkRole(s.superuser)).toMatchObject({ superuser: true, ownsTables: false });
  });
});
