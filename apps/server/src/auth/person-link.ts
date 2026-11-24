// SPDX-License-Identifier: AGPL-3.0-only
import { withTenant, type Database, type SqlClient } from '@vdrkit/core';
import type { Caller } from '../auth.js';
import { HttpProblem } from '../problems.js';

export interface Login {
  userId: string;
  email: string;
  emailVerified: boolean;
}

export interface LinkRow {
  tenant_id: string;
  person_id: string;
  user_id: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function outsideTenant<T>(db: Database, dbRole: 'vdrkit_app' | undefined, fn: (tx: SqlClient) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    if (dbRole) await tx.query(`set local role ${dbRole}`);
    return fn(tx);
  });
}

// unbound links only for a verified email: callerForLogin binds them
export async function linksForLogin(db: Database, login: Login, dbRole?: 'vdrkit_app'): Promise<LinkRow[]> {
  return outsideTenant(db, dbRole, async (tx) => (await tx.query<LinkRow>(
    `select tenant_id::text, person_id::text, user_id from auth_person
      where user_id = $1 or (user_id is null and $3 and lower(email) = lower($2))
      order by created_at`, [login.userId, login.email, login.emailVerified])).rows);
}

export async function linksForEmail(db: Database, email: string, dbRole?: 'vdrkit_app'): Promise<LinkRow[]> {
  return outsideTenant(db, dbRole, async (tx) => (await tx.query<LinkRow>(
    `select tenant_id::text, person_id::text, user_id from auth_person where lower(email) = lower($1) order by created_at`, [email])).rows);
}

export async function linkPersonToLogin(tx: SqlClient, personId: string): Promise<void> {
  await tx.query(`insert into auth_person (tenant_id, person_id, email)
    select tenant_id, id, email from person where id = $1 and erased_at is null and disabled_at is null on conflict do nothing`, [personId]);
}

export const tenantRequired = () => new HttpProblem({
  type: 'https://vdrkit.com/problems/tenant-required', title: 'Choose an organisation', status: 400,
  detail: 'This sign-in belongs to more than one organisation. Send the X-VDRkit-Tenant header with the one you mean.',
});

export async function callerForLogin(db: Database, login: Login, opts: { tenantId?: string; dbRole?: 'vdrkit_app' } = {}): Promise<Caller | null> {
  const links = await linksForLogin(db, login, opts.dbRole);
  let link: LinkRow | undefined;
  if (opts.tenantId) {
    if (!UUID.test(opts.tenantId)) return null;
    link = links.find((l) => l.tenant_id === opts.tenantId);
  } else {
    if (new Set(links.map((l) => l.tenant_id)).size > 1) throw tenantRequired();
    link = links[0];
  }
  if (!link) return null;
  const chosen = link;
  const ok = await withTenant(db, chosen.tenant_id, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(`select id from person where id = $1 and erased_at is null and disabled_at is null`, [chosen.person_id]);
    if (!rows[0]) return false;
    if (chosen.user_id === null) {
      await tx.query(`update auth_person set user_id = $2 where person_id = $1 and user_id is null`, [chosen.person_id, login.userId]);
    }
    return true;
  }, opts.dbRole ? { role: opts.dbRole } : {});
  if (!ok) return null;
  return { tenantId: chosen.tenant_id, principal: { kind: 'person', personId: chosen.person_id }, actorId: null };
}
