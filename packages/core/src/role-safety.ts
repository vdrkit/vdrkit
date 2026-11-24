// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from './db.js';

// Superuser or BYPASSRLS skips RLS silently, even when forced. The table owner is no safer: it can turn RLS off,
// and the event log revokes don't bind it.
export interface RoleCheck {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
  ownsTables: boolean;
  problems: string[];
}

export interface RoleCheckOptions {
  /** the migration and the sandbox reset connect as the owner on purpose */
  mayOwnTables?: boolean;
}

interface RoleRow {
  role: string;
  rolsuper: boolean | null;
  rolbypassrls: boolean | null;
  owns: boolean;
}

export async function checkRole(db: Database, opts: RoleCheckOptions = {}): Promise<RoleCheck> {
  const { rows } = await db.transaction((tx) => tx.query<RoleRow>(
    `select current_user::text as role, r.rolsuper, r.rolbypassrls,
            exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'public' and c.relname = 'event' and pg_has_role(c.relowner, 'MEMBER')) as owns
       from (select 1) one left join pg_roles r on r.rolname = current_user`));
  const row = rows[0] ?? { role: 'unknown', rolsuper: null, rolbypassrls: null, owns: false };
  const superuser = row.rolsuper === true;
  const bypassRls = row.rolbypassrls === true;
  const ownsTables = !superuser && row.owns === true;
  const problems: string[] = [];
  if (superuser) problems.push(`The role "${row.role}" is a superuser. A superuser ignores row-level security, so every room would be visible to every query.`);
  else if (bypassRls) problems.push(`The role "${row.role}" has BYPASSRLS. It ignores row-level security, so every room would be visible to every query.`);
  else if (ownsTables && !opts.mayOwnTables) {
    problems.push(`The role "${row.role}" owns the VDRkit tables. An owner is not held to the rules that keep the audit log unchangeable, and can switch row-level security off.`);
  }
  return { role: row.role, superuser, bypassRls, ownsTables, problems };
}

export async function refuseUnsafeRole(db: Database, what: string, who: string,
  opts: RoleCheckOptions = { mayOwnTables: what === 'MIGRATION_DATABASE_URL' }): Promise<RoleCheck> {
  const c = await checkRole(db, opts);
  if (c.problems.length) {
    if (c.ownsTables && !c.superuser && !c.bypassRls) {
      throw new Error(`${c.problems.join(' ')} The ${who} does not start. Point ${what} at the application's role `
        + '(vdrkit_app in the bundled Postgres), not at the owner that MIGRATION_DATABASE_URL uses, as the install guide describes.');
    }
    throw new Error(`${c.problems.join(' ')} The ${who} does not start. Point ${what} at a role made with `
      + `"create role ... login nosuperuser nobypassrls", as the install guide describes, or remove the attribute: `
      + `alter role ${c.role} nosuperuser nobypassrls;`);
  }
  return c;
}
