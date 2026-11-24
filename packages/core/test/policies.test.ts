// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent, withTenant } from '../src/index.js';
import { heron, T, type Heron } from './fixture.js';

let h: Heron;
beforeEach(async () => { h = await heron(); });
afterEach(async () => { await h.pg.close(); });

interface Policy { tablename: string; policyname: string; cmd: string; roles: string[]; qual: string | null; with_check: string | null; owner: string }

const ISOLATION = '(tenant_id = current_tenant_id())';
const listing = (setting: string) => `(current_setting('vdrkit.${setting}'::text, true) = 'on'::text)`;

// 'owner' ran the migrations: vdrkit_owner on Postgres, the superuser on PGlite
const ACCEPTED: Record<string, { cmd: string; roles: 'owner' | 'public'; qual: string | null; with_check: string | null }> = {
  // the tenant row itself
  'tenant.tenant_isolation': { cmd: 'ALL', roles: 'public', qual: '(id = current_tenant_id())', with_check: '(id = current_tenant_id())' },
  // sign-in looks up the person by email before a tenant is known
  'auth_person.read_any': { cmd: 'SELECT', roles: 'public', qual: 'true', with_check: null },
  'auth_person.write_own_insert': { cmd: 'INSERT', roles: 'public', qual: null, with_check: ISOLATION },
  'auth_person.write_own_update': { cmd: 'UPDATE', roles: 'public', qual: ISOLATION, with_check: ISOLATION },
  'auth_person.write_own_delete': { cmd: 'DELETE', roles: 'public', qual: ISOLATION, with_check: null },
  // the sign-in page reads the site tenant and the sandbox flag
  'site_instance.read_any': { cmd: 'SELECT', roles: 'public', qual: 'true', with_check: null },
  'site_instance.write_own': { cmd: 'INSERT', roles: 'public', qual: null, with_check: ISOLATION },
  'sandbox_instance.read_any': { cmd: 'SELECT', roles: 'public', qual: 'true', with_check: null },
  'sandbox_instance.owner_writes': { cmd: 'ALL', roles: 'owner', qual: 'true', with_check: 'true' },
  // cross-tenant listings for background jobs, switched on per transaction
  'notification.due_tenant_listing': { cmd: 'SELECT', roles: 'owner', qual: listing('due_tenant_listing'), with_check: null },
  'tenant.setup_listing': { cmd: 'SELECT', roles: 'owner', qual: listing('setup_listing'), with_check: null },
  'milestone.due_reminder_listing': { cmd: 'SELECT', roles: 'owner', qual: listing('due_reminder_listing'), with_check: null },
  'event.failed_sign_in_purge': { cmd: 'SELECT', roles: 'owner', qual: listing('sign_in_purge'), with_check: null },
  'event_context.failed_sign_in_purge': { cmd: 'DELETE', roles: 'owner', qual: listing('sign_in_purge'), with_check: null },
  'event_context.failed_sign_in_purge_read': { cmd: 'SELECT', roles: 'owner', qual: listing('sign_in_purge'), with_check: null },
  'upload_session.expired_upload_listing': { cmd: 'SELECT', roles: 'owner', qual: listing('expired_upload_listing'), with_check: null },
  'document_version.stuck_processing_listing': { cmd: 'SELECT', roles: 'owner', qual: listing('stuck_processing_listing'), with_check: null },
};
const READ_ANY = ['auth_person.read_any', 'site_instance.read_any', 'sandbox_instance.read_any'];

const WITHOUT_ISOLATION: Record<string, string> = {
  auth_user: 'logins are global; no tenant column',
  auth_session: 'logins are global; no tenant column',
  auth_account: 'logins are global; no tenant column',
  auth_verification: 'logins are global; no tenant column',
  auth_two_factor: 'logins are global; no tenant column',
  auth_trusted_browser: 'logins are global; no tenant column',
  rate_limit_counter: 'hashed keys, no tenant data; the app role only calls its functions',
  auth_person: 'its own policies above, readable by email before a tenant is known',
  site_instance: 'its own policies above, one row per installation',
  sandbox_instance: 'its own policies above, one row per installation',
};

async function policies(): Promise<Policy[]> {
  const { rows } = await h.pg.query<Policy>(`
    select p.tablename, p.policyname, p.cmd, p.roles::text[] as roles, p.qual, p.with_check, r.rolname as owner
      from pg_policies p
      join pg_class c on c.relname = p.tablename and c.relnamespace = 'public'::regnamespace
      join pg_roles r on r.oid = c.relowner
     where p.schemaname = 'public'
     order by 1, 2`);
  return rows;
}

describe('row-level security policies', () => {
  it('gives every table its tenant_isolation policy', async () => {
    const { rows } = await h.pg.query<{ relname: string }>(`
      select c.relname from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and c.relname <> 'schema_migrations'
         and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname and p.policyname = 'tenant_isolation')
       order by 1`);
    expect(rows.map((r) => r.relname)).toEqual(Object.keys(WITHOUT_ISOLATION).sort());
    const plain = (await policies()).filter((p) => p.policyname === 'tenant_isolation' && p.tablename !== 'tenant');
    expect(plain.filter((p) => !(p.cmd === 'ALL' && p.qual === ISOLATION && p.with_check === ISOLATION && p.roles.join() === 'public'))).toEqual([]);
  });

  it('allows no other policy than the listed ones', async () => {
    const others = (await policies()).filter((p) => !(p.policyname === 'tenant_isolation' && p.tablename !== 'tenant'));
    const seen = Object.fromEntries(others.map((p) => [`${p.tablename}.${p.policyname}`, {
      cmd: p.cmd, roles: p.roles.join() === p.owner ? 'owner' : p.roles.join(), qual: p.qual, with_check: p.with_check,
    }]));
    expect(seen).toEqual(ACCEPTED);
  });

  it('lets only the read-any policies ignore the tenant for the app role', async () => {
    const open = (await policies()).filter((p) => p.roles.includes('public') || p.roles.includes('vdrkit_app'))
      .filter((p) => [p.qual, p.with_check].some((e) => e !== null && !e.includes('current_tenant_id()')));
    expect(open.map((p) => `${p.tablename}.${p.policyname}`)).toEqual(READ_ANY.slice().sort());
  });
});

describe('cross-tenant listings', () => {
  // each puts a row in tenant 1; tenant 2 must not see it with the switch on
  const cases: { policy: string; table: string; setting: string; seed: () => Promise<unknown> }[] = [
    { policy: 'due_tenant_listing', table: 'notification', setting: 'due_tenant_listing', seed: () => h.pg.query(
      `insert into notification (tenant_id, workspace_id, person_id, category, mode, first_event_at, last_event_at, due_at)
       values ($1, $2, $3, 'documents', 'bundled', $4, $4, $4)`, [h.t1, h.ws, h.person.jan, T.at.toISOString()]) },
    { policy: 'setup_listing', table: 'tenant', setting: 'setup_listing', seed: async () => undefined },
    { policy: 'due_reminder_listing', table: 'milestone', setting: 'due_reminder_listing', seed: () => h.pg.query(
      `insert into milestone (tenant_id, workspace_id, title, due_at) values ($1, $2, 'Non-binding offers due', $3)`, [h.t1, h.ws, T.at.toISOString()]) },
    { policy: 'failed_sign_in_purge', table: 'event', setting: 'sign_in_purge', seed: () => h.app((tx) => appendEvent(tx, signInFailed())) },
    { policy: 'failed_sign_in_purge_read', table: 'event_context', setting: 'sign_in_purge', seed: () => h.app((tx) => appendEvent(tx, signInFailed())) },
    { policy: 'expired_upload_listing', table: 'upload_session', setting: 'expired_upload_listing', seed: async () => {
      const principal = await principalOf(h.person.maria);
      await h.pg.query(`insert into upload_session (tenant_id, workspace_id, person_id, principal_id, target_folder_id, relative_path, declared_size, declared_sha256, mime, quarantine_key, expires_at)
        values ($1, $2, $3, $4, $5, 'Old.pdf', 10, $6, 'application/pdf', 'q/old', $7)`,
        [h.t1, h.ws, h.person.maria, principal, h.node.aud, 'a'.repeat(64), new Date(T.at.getTime() - 86_400_000).toISOString()]);
    } },
    { policy: 'stuck_processing_listing', table: 'document_version', setting: 'stuck_processing_listing', seed: () => h.pg.query(
      `insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime) values ($1, $2, 1, 'k', $3, 1, 'application/pdf')`,
      [h.t1, h.node.audDraft, 'b'.repeat(64)]) },
  ];

  const signInFailed = () => ({
    action: 'auth.sign_in_failed', workspaceId: null, actorId: null, resourceType: 'person', resourceId: h.person.jan,
    data: {}, occurredAt: T.at, context: { ip: '198.51.100.10', userAgent: 'Mozilla/5.0' },
  });
  const principalOf = async (person: string) => (await h.pg.query<{ id: string }>(
    `insert into principal (tenant_id, kind, person_id, name) values ($1, 'person', $2, 'maria') returning id`, [h.t1, person])).rows[0]!.id;
  const tenantColumn = (table: string) => (table === 'tenant' ? 'id' : 'tenant_id');

  it('covers every listing policy', () => {
    const listed = Object.entries(ACCEPTED).filter(([, p]) => p.roles === 'owner' && p.qual?.startsWith('(current_setting(')).map(([k]) => k.split('.')[1]);
    expect(cases.map((c) => c.policy).sort()).toEqual([...new Set(listed)].sort());
  });

  for (const c of cases) {
    it(`${c.policy} shows the app role nothing of another tenant`, async () => {
      await c.seed();
      const theirs = `select count(*)::int as n from ${c.table} where ${tenantColumn(c.table)} = $1`;
      expect((await h.pg.query<{ n: number }>(theirs, [h.t1])).rows[0]!.n).toBeGreaterThan(0);
      const seen = await withTenant(h.db, h.t2, async (tx) => {
        await tx.query(`select set_config('vdrkit.${c.setting}', 'on', true)`);
        return (await tx.query<{ n: number }>(theirs, [h.t1])).rows[0]!.n;
      }, { role: 'vdrkit_app' });
      expect(seen).toBe(0);
    });
  }

  it('failed_sign_in_purge deletes nothing of another tenant for the app role', async () => {
    await h.app((tx) => appendEvent(tx, signInFailed()));
    const count = async () => (await h.pg.query<{ n: number }>(`select count(*)::int as n from event_context where tenant_id = $1`, [h.t1])).rows[0]!.n;
    const before = await count();
    expect(before).toBeGreaterThan(0);
    await withTenant(h.db, h.t2, async (tx) => {
      await tx.query(`select set_config('vdrkit.sign_in_purge', 'on', true)`);
      await tx.query(`delete from event_context`);
    }, { role: 'vdrkit_app' });
    expect(await count()).toBe(before);
  });
});
