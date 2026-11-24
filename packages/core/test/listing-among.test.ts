// SPDX-License-Identifier: AGPL-3.0-only
// Randomised rooms, compared against the previous accessible_nodes()/readable_nodes() and effective_level().
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { heron, pinClock, T, TEST_DATABASE_URL, type Heron } from './fixture.js';

const CASES = Number(process.env.AMONG_CASES ?? (TEST_DATABASE_URL ? 10 : 6));

const migration = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');

function oldFunctions(): string {
  const acc = migration('0020_fast_access.sql')
    .replace('create or replace function accessible_nodes(', 'create or replace function accessible_nodes_old(')
    .replace(/grant execute on function accessible_nodes\(.*\n/, '');
  const src = migration('0014_cleanup.sql');
  const start = src.indexOf('create or replace function readable_nodes(');
  const end = src.indexOf('\n$$;', start) + 4;
  const read = src.slice(start, end)
    .replace('function readable_nodes(', 'function readable_nodes_old(')
    .replace('from accessible_nodes(', 'from accessible_nodes_old(');
  if (start < 0 || !read.includes('accessible_nodes_old(') || !acc.includes('accessible_nodes_old(')) throw new Error('Old functions not found');
  return `${acc}\n${read}`;
}

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <X>(xs: readonly X[]): X => xs[Math.floor(next() * xs.length)]!,
    chance: (p: number) => next() < p,
  };
}

const day = (d: number) => new Date(Date.UTC(2026, 10, d, 8));
const LEVELS = [0, 10, 20, 30, 40, 50, 60] as const;
const sha = (i: number) => i.toString(16).padStart(64, '0');

let h: Heron | null = null;
afterEach(async () => { await h?.pg.close(); h = null; });

async function one(sql: string, params: unknown[] = []): Promise<string> {
  return (await h!.pg.query<{ id: string }>(sql, params)).rows[0]!.id;
}

async function build(seed: number) {
  h = await heron();
  const r = rng(seed);
  const { t1, t2, ws } = h;
  const groups = [h.group.admins, h.group.contributors, h.group.a, h.group.aQna, h.group.aFin, h.group.b];
  const outsider = await one(`insert into person (tenant_id, name, email) values ($1, 'Outsider', 'out@example.com') returning id`, [t1]);
  const people = [...Object.values(h.person), outsider];
  const ola = await one(`insert into person (tenant_id, name, email) values ($1, 'Ola', 'ola@bidder-a.example') returning id`, [t1]);
  people.push(ola);

  await pinClock(h.pg, day(4));
  for (const g of [h.group.a, h.group.aQna]) {
    await h.pg.query(`insert into membership (tenant_id, person_id, group_id) values ($1, $2, $3)`, [t1, ola, g]);
  }
  await h.pg.query(`insert into acceptance (tenant_id, agreement_version_id, person_id, accepted_at) values ($1, $2, $3, $4)`,
    [t1, h.nda.v1, ola, day(4).toISOString()]);
  const folders: (string | null)[] = [null, h.node.fin, h.node.aud, h.node.tax, h.node.it];
  const nodes: string[] = Object.values(h.node);
  const docs: string[] = [h.node.aud1, h.node.audDraft, h.node.tax1];
  const size = 15 + r.int(20);
  for (let i = 0; i < size; i++) {
    const kind = r.chance(0.35) ? 'folder' : 'document';
    const state = r.pick(['published', 'published', 'published', 'draft', 'withdrawn'] as const);
    const id = await one(`insert into node (tenant_id, workspace_id, parent_id, kind, name, index_number, state)
      values ($1, $2, $3, $4, $5, $6, $7) returning id`, [t1, ws, r.pick(folders), kind, `N${i}`, `9.${i}`, state]);
    nodes.push(id);
    if (kind === 'folder') folders.push(id);
    else docs.push(id);
  }

  const used = new Set<string>([`${h.node.fin}|${h.group.admins}|false`, `${h.node.it}|${h.group.admins}|false`, `${h.node.fin}|${h.group.contributors}|false`]);
  const grantIds: string[] = [];
  const grants = 10 + r.int(25);
  for (let i = 0; i < grants; i++) {
    const node = r.pick(folders.filter((f): f is string => f !== null).concat(docs));
    const deny = r.chance(0.12);
    const byPerson = deny || r.chance(0.25);
    const subject = byPerson ? r.pick(people) : r.pick(groups);
    const key = `${node}|${subject}|${deny}`;
    if (used.has(key)) continue;
    used.add(key);
    const validTo = r.chance(0.1) ? day(7).toISOString() : 'infinity';
    grantIds.push(await one(`insert into access_grant (tenant_id, workspace_id, node_id, subject_group_id, subject_person_id, effect, level,
        can_upload, can_manage, can_publish, valid_to)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
    [t1, ws, node, byPerson ? null : subject, byPerson ? subject : null, deny ? 'deny' : 'allow', deny ? 0 : r.pick(LEVELS),
      !deny && r.chance(0.2), !deny && r.chance(0.15), !deny && r.chance(0.15), validTo]));
  }

  let v = 0;
  for (const d of docs) {
    const count = r.int(3);
    for (let n = 1; n <= count; n++) {
      const released = r.chance(0.7);
      await h.pg.query(`insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime,
          visible_to_group_ids, awaiting_release, released_at, withdrawn_at)
        values ($1, $2, $3, 'k', $4, 1, 'application/pdf', $5, $6, $7, $8)`,
      [t1, d, n, sha(++v), r.chance(0.2) ? [r.pick(groups)] : [], !released, released ? day(4).toISOString() : null,
        released && r.chance(0.15) ? day(5).toISOString() : null]);
    }
  }

  const ws2 = await one(`insert into workspace (tenant_id, name, state) values ($1, 'Other room', 'open') returning id`, [t1]);
  const foreign: string[] = [];
  for (let i = 0; i < 3; i++) {
    foreign.push(await one(`insert into node (tenant_id, workspace_id, kind, name, state) values ($1, $2, 'document', $3, 'published') returning id`,
      [t1, ws2, `O${i}`]));
  }
  if (TEST_DATABASE_URL) await h.pg.query(`select set_config('app.tenant_id', $1, false)`, [t2]);
  const ws3 = await one(`insert into workspace (tenant_id, name, state) values ($1, 'Other tenant', 'open') returning id`, [t2]);
  foreign.push(await one(`insert into node (tenant_id, workspace_id, kind, name, state) values ($1, $2, 'document', 'T', 'published') returning id`,
    [t2, ws3]));
  if (TEST_DATABASE_URL) await h.pg.query(`select set_config('app.tenant_id', $1, false)`, [t1]);

  // later changes, so asking about day 6 takes the per-node path
  await pinClock(h.pg, day(8));
  const live = new Set(nodes);
  for (let i = 0; i < 4; i++) {
    const n = r.pick(nodes.filter((x) => live.has(x)));
    const to = r.pick(folders);
    if (to === n) continue;
    await h.pg.query(`update node set parent_id = $1 where id = $2`, [to, n]).catch(() => undefined);
  }
  // a refused move can drop the tenant setting on real Postgres
  if (TEST_DATABASE_URL) await h.pg.query(`select set_config('app.tenant_id', $1, false)`, [t1]);
  for (let i = 0; i < 3; i++) {
    const n = r.pick(docs.filter((x) => live.has(x)));
    await h.pg.query(`update node set deleted_at = $1 where id = $2`, [day(8).toISOString(), n]);
    live.delete(n);
  }
  for (let i = 0; i < 3; i++) {
    await h.pg.query(`update node set state = $1 where id = $2`, [r.pick(['draft', 'published', 'withdrawn']), r.pick(nodes)]);
  }
  for (const id of grantIds) {
    if (r.chance(0.15)) await h.pg.query(`update access_grant set superseded_at = 'infinity'::timestamptz - interval '1 day' where id = $1`, [id]);
  }
  const memberships = (await h.pg.query<{ id: string }>(`select m.id from membership m join groups g on g.id = m.group_id where g.workspace_id = $1`, [ws])).rows;
  for (const m of memberships) {
    const roll = r.next();
    if (roll < 0.08) await h.pg.query(`update membership set valid_to = $1 where id = $2`, [day(8).toISOString(), m.id]);
    else if (roll < 0.14) await h.pg.query(`update membership set status = 'revoked' where id = $1`, [m.id]);
    else if (roll < 0.2) await h.pg.query(`update membership set superseded_at = 'infinity'::timestamptz - interval '1 day' where id = $1`, [m.id]);
  }
  if (r.chance(0.4)) {
    const v2 = await one(`insert into agreement_version (tenant_id, agreement_id, version_no, body, published_at) values ($1, $2, 2, 'Version 2', $3) returning id`,
      [t1, h.nda.agreement, day(8).toISOString()]);
    await pinClock(h.pg, day(9));
    for (const p of people) {
      if (r.chance(0.5)) {
        await h.pg.query(`insert into acceptance (tenant_id, agreement_version_id, person_id, accepted_at) values ($1, $2, $3, $4)`,
          [t1, v2, p, day(9).toISOString()]);
      }
    }
    await pinClock(h.pg, day(8));
  }
  if (r.chance(0.25)) await h.pg.query(`update workspace set requires_nda = false where id = $1`, [ws]);
  const state = r.pick(['open', 'open', 'open', 'frozen', 'preparing', 'closed'] as const);
  if (state !== 'open') await h.pg.query(`update workspace set state = $1 where id = $2`, [state, ws]);
  await pinClock(h.pg, T.at);

  return { r, ws, ws2, ws3, people, nodes, foreign };
}

type Row = Record<string, unknown>;
const key = (rows: Row[]) => JSON.stringify(rows.map((x) => JSON.stringify(x)).sort());

describe('accessible_nodes_among and readable_nodes_among', () => {
  it.each(Array.from({ length: CASES }, (_, i) => 7001 + i * 7919))('generated room, seed %i', async (seed) => {
    const { r, ws, ws2, ws3, people, nodes, foreign } = await build(seed);
    await h!.pg.exec(oldFunctions());
    let compared = 0;
    let nonEmpty = 0;
    for (const at of [T.at, day(6)]) {
      for (const known of ['null', 'record_clock()']) {
        for (const person of people) {
          const args = [person, ws, at.toISOString()];
          const q = (sql: string, params: unknown[] = args) => h!.app((tx) => tx.query<Row>(sql, params)).then((x) => x.rows);
          const accCols = 'node_id, level, can_upload, can_manage, can_publish';
          const oldAcc = await q(`select ${accCols} from accessible_nodes_old($1, $2, $3, ${known})`);
          const newAcc = await q(`select ${accCols} from accessible_nodes($1, $2, $3, ${known})`);
          expect(key(newAcc), `accessible_nodes, person ${person} at ${at.toISOString()} known ${known}`).toBe(key(oldAcc));
          const oldRead = await q(`select ${accCols}, version_id from readable_nodes_old($1, $2, $3, ${known})`);
          const newRead = await q(`select ${accCols}, version_id from readable_nodes($1, $2, $3, ${known})`);
          expect(key(newRead), 'readable_nodes').toBe(key(oldRead));
          for (const agent of [false, true]) {
            const a = await q(`select ${accCols}, version_id from readable_nodes_old($1, $2, $3, ${known}, $4)`, [...args, agent]);
            const b = await q(`select ${accCols}, version_id from readable_nodes($1, $2, $3, ${known}, $4)`, [...args, agent]);
            expect(key(b), 'readable_nodes for an agent').toBe(key(a));
          }
          if (newAcc.length) nonEmpty++;

          const made = '00000000-0000-4000-8000-000000000001';
          const subsets: string[][] = [nodes, [], foreign, [made]];
          for (let s = 0; s < 3; s++) {
            const part = nodes.filter(() => r.chance(0.4));
            subsets.push([...part, ...part.slice(0, 2), ...(r.chance(0.5) ? foreign : []), ...(r.chance(0.3) ? [made] : [])]);
          }
          for (const ids of subsets) {
            const single = await q(
              `select n.id as node_id, e.level, e.can_upload, e.can_manage, e.can_publish
                 from node n cross join lateral effective_level($1, n.id, $3, ${known}) e
                where n.workspace_id = $2 and n.id = any ($4::uuid[]) and (e.level > 0 or e.can_upload or e.can_manage or e.can_publish)`,
              [...args, ids]);
            const among = await q(`select ${accCols} from accessible_nodes_among($1, $2, $4::uuid[], $3, ${known})`, [...args, ids]);
            expect(key(among), `accessible_nodes_among, person ${person} at ${at.toISOString()} known ${known} ids ${ids.length}`).toBe(key(single));
            const wanted = new Set(ids);
            const readAmong = await q(`select ${accCols}, version_id from readable_nodes_among($1, $2, $4::uuid[], $3, ${known})`, [...args, ids]);
            expect(key(readAmong), 'readable_nodes_among').toBe(key(oldRead.filter((x) => wanted.has(x.node_id as string))));
            compared++;
          }
          for (const other of [ws2, ws3]) {
            expect(await q(`select * from accessible_nodes_among($1::uuid, $2::uuid, $4::uuid[], $3, ${known})`, [person, other, at.toISOString(), foreign])).toEqual([]);
            expect(await q(`select * from readable_nodes_among($1::uuid, $2::uuid, null, $3, ${known})`, [person, other, at.toISOString()])).toEqual([]);
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(0);
    expect(nonEmpty).toBeGreaterThan(0);
  }, 300_000);
});
