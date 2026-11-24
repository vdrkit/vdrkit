// SPDX-License-Identifier: AGPL-3.0-only
import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import type pg from 'pg';
import { fromPGlite, migrate, withTenant, type Database, type SqlClient } from '../src/index.js';
import { realDatabase, TEST_DATABASE_URL, type TestPg } from './real-postgres.js';

export { TEST_DATABASE_URL, type TestPg } from './real-postgres.js';

// On PGlite, db and pg are the same superuser connection.
export async function freshDatabase(): Promise<{ db: Database; pg: TestPg; appPool?: pg.Pool; ownerUrl?: string }> {
  if (TEST_DATABASE_URL) {
    const real = await realDatabase();
    return { ...real, ownerUrl: real.url.owner };
  }
  const lite = new PGlite({ extensions: { ltree } });
  const db = fromPGlite(lite);
  await migrate(db);
  return { db, pg: lite };
}

export const T = {
  setup: new Date('2026-10-01T08:00:00Z'),
  ndaPublished: new Date('2026-11-01T08:00:00Z'),
  grantsSet: new Date('2026-11-02T08:00:00Z'),
  ndaAccepted: new Date('2026-11-03T08:00:00Z'),
  at: new Date('2026-11-12T08:00:00Z'),
};

export interface Heron {
  db: Database;
  pg: TestPg;
  appPool?: pg.Pool;
  // Postgres only
  ownerUrl?: string;
  t1: string;
  t2: string;
  ws: string;
  party: { seller: string; bidderA: string; bidderB: string };
  group: { admins: string; contributors: string; a: string; aQna: string; aFin: string; b: string };
  person: { anika: string; maria: string; jan: string; lars: string; mei: string };
  node: { fin: string; aud: string; aud1: string; audDraft: string; tax: string; tax1: string; it: string };
  nda: { agreement: string; v1: string };
  app<R>(fn: (tx: SqlClient) => Promise<R>): Promise<R>;
  pin(at: Date | null): Promise<void>;
}

export async function pinClock(pg: TestPg, at: Date | null): Promise<void> {
  const value = at ? `'${at.toISOString()}'::timestamptz` : 'null::timestamptz';
  await pg.exec(`create or replace function db_clock_pin() returns timestamptz language sql stable as $$ select ${value} $$`);
}

async function one(pg: TestPg, sql: string, params: unknown[] = []): Promise<string> {
  const r = await pg.query<{ id: string }>(sql, params);
  const row = r.rows[0];
  if (!row) throw new Error(`No row from: ${sql}`);
  return row.id;
}

export async function heron(): Promise<Heron> {
  const { db, pg, appPool, ownerUrl } = await freshDatabase();
  const rec = T.setup.toISOString();
  await pinClock(pg, T.setup);

  const t1 = await one(pg, `insert into tenant (name) values ('Quillmont Advisory') returning id`);
  const t2 = await one(pg, `insert into tenant (name) values ('Another tenant') returning id`);
  // node_history's trigger is under RLS on Postgres
  if (TEST_DATABASE_URL) await pg.query(`select set_config('app.tenant_id', $1, false)`, [t1]);
  const ws = await one(pg, `insert into workspace (tenant_id, name, state, requires_nda, time_zone)
    values ($1, 'Project Heron', 'open', true, 'Africa/Johannesburg') returning id`, [t1]);

  const party = {
    seller: await one(pg, `insert into party (tenant_id, workspace_id, name, kind) values ($1, $2, 'Seller', 'seller') returning id`, [t1, ws]),
    bidderA: await one(pg, `insert into party (tenant_id, workspace_id, name, kind) values ($1, $2, 'Bidder A', 'bidder') returning id`, [t1, ws]),
    bidderB: await one(pg, `insert into party (tenant_id, workspace_id, name, kind) values ($1, $2, 'Bidder B', 'bidder') returning id`, [t1, ws]),
  };
  const grp = (party: string, name: string, parent: string | null = null, role = 'member') =>
    one(pg, `insert into groups (tenant_id, workspace_id, party_id, name, parent_group_id, role_template) values ($1, $2, $3, $4, $5, $6) returning id`,
      [t1, ws, party, name, parent, role]);
  const group = {
    admins: await grp(party.seller, 'Room admins', null, 'admin'),
    contributors: await grp(party.seller, 'Seller finance team'),
    a: await grp(party.bidderA, 'Bidder A'),
    aQna: await grp(party.bidderA, 'Bidder A Q&A team'),
    b: await grp(party.bidderB, 'Bidder B'),
    aFin: '',
  };
  group.aFin = await grp(party.bidderA, 'Bidder A financier', group.a);

  const per = (name: string, email: string) =>
    one(pg, `insert into person (tenant_id, name, email) values ($1, $2, $3) returning id`, [t1, name, email]);
  const person = {
    anika: await per('Anika Pillay', 'anika@quillmont.example'),
    maria: await per('Maria Botha', 'maria@drosvelt.example'),
    jan: await per('Jan de Vries', 'jan@bidder-a.example'),
    lars: await per('Lars Eriksen', 'lars@skarvik.example'),
    mei: await per('Mei Tanaka', 'mei@bidder-b.example'),
  };
  const member = (p: string, g: string) =>
    pg.query(`insert into membership (tenant_id, person_id, group_id, recorded_at) values ($1, $2, $3, $4)`, [t1, p, g, rec]);
  await member(person.anika, group.admins);
  await member(person.maria, group.contributors);
  await member(person.jan, group.a);
  await member(person.lars, group.aFin);
  await member(person.mei, group.b);

  const nd = (name: string, idx: string, parent: string | null, kind = 'folder', state = 'published') =>
    one(pg, `insert into node (tenant_id, workspace_id, parent_id, kind, name, index_number, state)
      values ($1, $2, $3, $4, $5, $6, $7) returning id`, [t1, ws, parent, kind, name, idx, state]);
  const fin = await nd('Finance', '3', null);
  const aud = await nd('Audited financials', '3.2', fin);
  const node = {
    fin,
    aud,
    aud1: await nd('Audited financial statements FY2025.pdf', '3.2.1', aud, 'document'),
    audDraft: await nd("Auditor's management letter FY2025.pdf", '3.2.5', aud, 'document', 'draft'),
    tax: '',
    tax1: '',
    it: await nd('IT', '6', null),
  };
  node.tax = await nd('Tax', '3.4', fin);
  node.tax1 = await nd('Tax clearance certificate 2026.pdf', '3.4.6', node.tax, 'document');

  const agreement = await one(pg, `insert into agreement (tenant_id, workspace_id, kind, name) values ($1, $2, 'nda', 'Project Heron NDA') returning id`, [t1, ws]);
  await pinClock(pg, T.ndaPublished);
  const v1 = await one(pg, `insert into agreement_version (tenant_id, agreement_id, version_no, body, published_at)
    values ($1, $2, 1, 'Confidentiality undertaking, version 1', $3) returning id`, [t1, agreement, T.ndaPublished.toISOString()]);
  await pinClock(pg, T.ndaAccepted);
  for (const p of [person.jan, person.lars, person.mei]) {
    await pg.query(`insert into acceptance (tenant_id, agreement_version_id, person_id, accepted_at) values ($1, $2, $3, $4)`,
      [t1, v1, p, T.ndaAccepted.toISOString()]);
  }

  await pinClock(pg, T.grantsSet);
  const g = (subjectGroup: string, n: string, level: number, upload = false, manage = false) =>
    pg.query(`insert into access_grant (tenant_id, workspace_id, node_id, subject_group_id, level, can_upload, can_manage, recorded_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8)`, [t1, ws, n, subjectGroup, level, upload, manage, T.grantsSet.toISOString()]);
  await g(group.admins, fin, 60, true, true);
  await g(group.admins, node.it, 60, true, true);
  await g(group.contributors, fin, 20, true, false);
  await pinClock(pg, T.at);

  return {
    db, pg, appPool, ownerUrl, t1, t2, ws, party, group, person, node,
    nda: { agreement, v1 },
    app: (fn) => withTenant(db, t1, fn, { role: 'vdrkit_app' }),
    pin: (at) => pinClock(pg, at),
  };
}

// every person and room: listings must agree with effective_level()
export async function expectListingMatchesSingleChecks(h: Heron, at: Date = T.at): Promise<number> {
  const when = at.toISOString();
  const people = (await h.pg.query<{ id: string }>(`select id from person where tenant_id = $1`, [h.t1])).rows.map((r) => r.id);
  const rooms = (await h.pg.query<{ id: string }>(`select id from workspace where tenant_id = $1`, [h.t1])).rows.map((r) => r.id);
  let compared = 0;
  for (const ws of rooms) {
    const changed = (await h.app((tx) => tx.query<{ c: boolean }>(`select tree_changed_since($1, $2) as c`, [ws, when]))).rows[0]!.c;
    if (changed) continue;
    for (const person of people) {
      for (const known of [null, 'record_clock()']) {
        const k = known ?? 'null';
        const listed = (await h.app((tx) => tx.query(
          `select node_id, level, can_upload, can_manage, can_publish from accessible_nodes($1, $2, $3, ${k}) order by node_id`,
          [person, ws, when]))).rows;
        const single = (await h.app((tx) => tx.query(
          `select nd.id as node_id, e.level, e.can_upload, e.can_manage, e.can_publish
             from node nd cross join lateral effective_level($1, nd.id, $3, ${k}) e
            where nd.workspace_id = $2 and nd.deleted_at is null and (e.level > 0 or e.can_upload or e.can_manage or e.can_publish)
            order by nd.id`, [person, ws, when]))).rows;
        if (JSON.stringify(listed) !== JSON.stringify(single)) {
          throw new Error(`accessible_nodes() and effective_level() disagree for person ${person} in room ${ws} at ${when} (known ${k}):\n`
            + `listing ${JSON.stringify(listed)}\nsingle  ${JSON.stringify(single)}`);
        }
        const byFolder = (await h.app((tx) => tx.query(
          `select a.node_id, a.level, a.can_upload, a.can_manage, a.can_publish
             from (select f.id from node f where f.workspace_id = $2 and f.kind = 'folder' union all select null::uuid) p
             cross join lateral accessible_nodes_among($1, $2,
               array(select c.id from node c where c.workspace_id = $2 and c.parent_id is not distinct from p.id), $3, ${k}) a
            order by a.node_id`, [person, ws, when]))).rows;
        if (JSON.stringify(byFolder) !== JSON.stringify(single)) {
          throw new Error(`accessible_nodes_among() by folder and effective_level() disagree for person ${person} in room ${ws} at ${when} (known ${k}):\n`
            + `by folder ${JSON.stringify(byFolder)}\nsingle    ${JSON.stringify(single)}`);
        }
        compared++;
      }
    }
  }
  return compared;
}
