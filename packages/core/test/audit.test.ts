// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent, Level, setGrant, verifyChain, withTenant } from '../src/index.js';
import { heron, T, TEST_DATABASE_URL, type Heron } from './fixture.js';

let h: Heron;
beforeEach(async () => { h = await heron(); });
afterEach(async () => { await h.pg.close(); });

const opened = (h: Heron, i: number) => ({
  action: 'document.opened', workspaceId: h.ws, actorId: null, resourceType: 'node', resourceId: h.node.aud1,
  data: { page_count: 40, n: i }, occurredAt: new Date(T.at.getTime() + i * 1000),
  context: { ip: '198.51.100.10', userAgent: 'Mozilla/5.0' },
});

describe('event chain', () => {
  it('chains events with gapless numbering', async () => {
    const evs = await h.app(async (tx) => {
      const out = [];
      for (let i = 1; i <= 5; i++) out.push(await appendEvent(tx, opened(h, i)));
      return out;
    });
    expect(evs.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(evs.map((e) => e.chainPos)).toEqual([1, 2, 3, 4, 5]);
    for (let i = 1; i < evs.length; i++) expect(evs[i]!.prevHash).toBe(evs[i - 1]!.hash);
    expect(await h.app((tx) => verifyChain(tx, h.ws))).toEqual({ checked: 5, firstBroken: null });
  });

  it('keeps separate chains per workspace and for instance events', async () => {
    await h.app(async (tx) => {
      await appendEvent(tx, opened(h, 1));
      await appendEvent(tx, { action: 'tenant.settings_changed', data: { field: 'logo' } });
      await appendEvent(tx, opened(h, 2));
    });
    expect(await h.app((tx) => verifyChain(tx, h.ws))).toEqual({ checked: 2, firstBroken: null });
    expect(await h.app((tx) => verifyChain(tx, h.t1))).toEqual({ checked: 1, firstBroken: null });
  });

  it('detects an edited event', async () => {
    await h.app(async (tx) => { for (let i = 1; i <= 4; i++) await appendEvent(tx, opened(h, i)); });
    await h.pg.exec(`alter table event disable trigger event_append_only;
      update event set data = '{"page_count": 1}' where chain_pos = 3;
      alter table event enable trigger event_append_only;`);
    expect(await h.app((tx) => verifyChain(tx, h.ws))).toEqual({ checked: 3, firstBroken: 3 });
  });

  it('detects a deleted last event', async () => {
    await h.app(async (tx) => { for (let i = 1; i <= 3; i++) await appendEvent(tx, opened(h, i)); });
    await h.pg.exec(`alter table event disable trigger event_append_only;
      delete from event where chain_pos = 3;
      alter table event enable trigger event_append_only;`);
    expect((await h.app((tx) => verifyChain(tx, h.ws))).firstBroken).toBe(3);
  });

  it('should reject updates and deletes', async () => {
    await h.app((tx) => appendEvent(tx, opened(h, 1)));
    await expect(h.pg.query(`update event set action = 'x'`)).rejects.toThrow(/append-only/);
    await expect(h.pg.query(`delete from event`)).rejects.toThrow(/append-only/);
  });

  it('survives erasing personal data', async () => {
    await h.app(async (tx) => { for (let i = 1; i <= 3; i++) await appendEvent(tx, opened(h, i)); });
    await h.app(async (tx) => {
      await tx.query(`delete from event_context`);
      await tx.query(`update person set name = 'Erased user', email = 'erased-' || id || '@invalid', erased_at = now() where id = $1`, [h.person.jan]);
    });
    expect(await h.app((tx) => verifyChain(tx, h.ws))).toEqual({ checked: 3, firstBroken: null });
  });

  it('leaves the chain head and the counter to append_event', async () => {
    await h.app((tx) => appendEvent(tx, opened(h, 1)));
    const fn = (await h.pg.query<{ prosecdef: boolean; owner: string; app_owns: boolean }>(
      `select p.prosecdef, r.rolname as owner, r.rolname = 'vdrkit_app' as app_owns
         from pg_proc p join pg_roles r on r.oid = p.proowner where p.proname = 'append_event'`)).rows;
    expect(fn).toHaveLength(1);
    expect(fn[0]).toMatchObject({ prosecdef: true, app_owns: false });
    for (const sql of [
      `update event_chain set head_hash = repeat('f', 64)`,
      `update event_chain set length = length + 1`,
      `update event_counter set last_seq = 0`,
      `insert into event_counter (tenant_id) values (current_tenant_id()) on conflict do nothing`,
      `insert into event_chain (tenant_id, chain_key) values (current_tenant_id(), gen_random_uuid())`,
    ]) await expect(h.app((tx) => tx.query(sql))).rejects.toThrow(/permission denied/);
    const next = await h.app((tx) => appendEvent(tx, opened(h, 2)));
    expect(next.seq).toBe(2);
    expect(await h.app((tx) => verifyChain(tx, h.ws))).toEqual({ checked: 2, firstBroken: null });
  });

  it('writes into the monthly partition', async () => {
    await h.pg.query(`select ensure_event_partition('2026-11-01')`);
    await h.app((tx) => appendEvent(tx, opened(h, 1)));
    const r = await h.pg.query<{ c: number }>(`select count(*)::int c from event_2026_11`);
    expect(r.rows[0]!.c).toBe(1);
  });
});

describe('action and audit in one transaction', () => {
  it('writes the grant and its event together', async () => {
    await h.app((tx) => setGrant(tx, { workspaceId: h.ws, nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.Pdf, now: T.grantsSet }));
    const ev = await h.pg.query<{ action: string; data: any }>(`select action, data from event where workspace_id = $1`, [h.ws]);
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]!.action).toBe('grant.changed');
    expect(ev.rows[0]!.data.after.level).toBe(Level.Pdf);
  });

  it('rolls back both on failure', async () => {
    await expect(h.app(async (tx) => {
      await setGrant(tx, { workspaceId: h.ws, nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.Pdf, now: T.grantsSet });
      throw new Error('simulated failure after the grant');
    })).rejects.toThrow(/simulated/);
    const grants = await h.pg.query(`select 1 from access_grant where subject_group_id = $1`, [h.group.a]);
    const events = await h.pg.query(`select 1 from event`);
    expect([grants.rows.length, events.rows.length]).toEqual([0, 0]);
  });
});

describe('tenant isolation', () => {
  it('only returns rows of the current tenant', async () => {
    const own = await h.app((tx) => tx.query(`select id from workspace`));
    expect(own.rows).toHaveLength(1);
    const other = await withTenant(h.db, h.t2, (tx) => tx.query(`select id from workspace`), { role: 'vdrkit_app' });
    expect(other.rows).toHaveLength(0);
  });

  it('should not insert into another tenant', async () => {
    await expect(h.app((tx) => tx.query(`insert into workspace (tenant_id, name) values ($1, 'Smuggled')`, [h.t2])))
      .rejects.toThrow(/row-level security/);
  });

  it('denies the app role direct access to event partitions', async () => {
    await h.app((tx) => appendEvent(tx, opened(h, 1)));
    await h.pg.query(`select ensure_event_partition('2026-12-01')`);
    for (const part of ['event_default', 'event_2026_12']) {
      await expect(withTenant(h.db, h.t2, (tx) => tx.query(`select * from ${part}`), { role: 'vdrkit_app' })).rejects.toThrow(/permission denied/);
    }
    const other = await withTenant(h.db, h.t2, (tx) => tx.query(`select * from event`), { role: 'vdrkit_app' });
    expect(other.rows).toHaveLength(0);
  });

  it('app role is not superuser and does not bypass RLS', async () => {
    const r = await h.app((tx) => tx.query(`select current_user as role, rolsuper, rolbypassrls from pg_roles where rolname = current_user`));
    expect(r.rows).toEqual([{ role: 'vdrkit_app', rolsuper: false, rolbypassrls: false }]);
  });

  // PGlite only has a superuser role
  it.skipIf(!TEST_DATABASE_URL)('non-superuser owns every table and function', async () => {
    const owners = await h.pg.query<{ owner: string; rolsuper: boolean }>(
      `select distinct r.rolname as owner, r.rolsuper from pg_class c join pg_roles r on r.oid = c.relowner
        where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
       union
       select distinct r.rolname, r.rolsuper from pg_proc p join pg_roles r on r.oid = p.proowner
        where p.pronamespace = 'public'::regnamespace and p.prosecdef`);
    expect(owners.rows).toEqual([{ owner: 'vdrkit_owner', rolsuper: false }]);
  });

  it('returns nothing without a tenant', async () => {
    const rows = await h.db.transaction(async (tx) => {
      await tx.query('set local role vdrkit_app');
      return tx.query(`select id from node`);
    });
    expect(rows.rows).toHaveLength(0);
  });

  // logins are global, so the auth tables have no tenant
  const AUTH_TABLES = ['auth_user', 'auth_session', 'auth_account', 'auth_verification', 'auth_two_factor', 'auth_trusted_browser'];
  const NO_TENANT_TABLES = [...AUTH_TABLES, 'rate_limit_counter'];

  it('should force RLS with tenant_id on every table', async () => {
    const { rows } = await h.pg.query<{ relname: string; has_tenant: boolean; rls: boolean; force: boolean }>(`
      select c.relname,
             exists (select 1 from information_schema.columns col where col.table_name = c.relname and col.column_name in ('tenant_id')) as has_tenant,
             c.relrowsecurity as rls, c.relforcerowsecurity as force
        from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = 'public' and c.relkind in ('r', 'p')
         and c.relname not in ('schema_migrations', ${NO_TENANT_TABLES.map((t) => `'${t}'`).join(', ')})`);
    const bad = rows.filter((r) => !(r.rls && r.force && (r.has_tenant || r.relname === 'tenant')));
    expect(bad).toEqual([]);
  });
});
