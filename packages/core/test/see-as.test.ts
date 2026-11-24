// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlClient } from '../src/index.js';
import { heron, T, type Heron } from './fixture.js';

let h: Heron;
beforeEach(async () => { h = await heron(); });
afterEach(async () => { await h.pg.close(); });

const at = T.at.toISOString();

class Rollback<T> { constructor(readonly value: T) {} }

async function rolledBack<R>(fn: (tx: SqlClient) => Promise<R>): Promise<R> {
  try {
    await h.app(async (tx) => { throw new Rollback(await fn(tx)); });
  } catch (e) {
    if (e instanceof Rollback) return e.value as R;
    throw e;
  }
  throw new Error('unreachable');
}

const begin = (tx: SqlClient, admin: string, group: string) =>
  tx.query<{ person_id: string; group_name: string; side: string; party_kind: string }>(
    `select * from see_as_begin($1, $2, $3, $4)`, [admin, h.ws, group, at]);

const listing = async (tx: SqlClient, person: string) => (await tx.query(
  `select node_id, level, can_upload, can_manage, can_publish from accessible_nodes($1, $2, $3, record_clock()) order by node_id`,
  [person, h.ws, at])).rows;

async function grant(group: string, node: string, level: number, upload = false) {
  await h.pg.query(`insert into access_grant (tenant_id, workspace_id, node_id, subject_group_id, level, can_upload, recorded_at)
    values ($1, $2, $3, $4, $5, $6, $7)`, [h.t1, h.ws, node, group, level, upload, T.grantsSet.toISOString()]);
}

describe('see_as_begin()', () => {
  beforeEach(async () => {
    await grant(h.group.a, h.node.fin, 20);
    await grant(h.group.aFin, h.node.aud, 50);
    await grant(h.group.b, h.node.tax, 50);
  });

  it('gives each team what a real member gets', async () => {
    const cases: [string, string][] = [
      [h.group.a, h.person.jan], [h.group.aFin, h.person.lars], [h.group.b, h.person.mei], [h.group.contributors, h.person.maria],
    ];
    for (const [group, real] of cases) {
      const [standIn, expected] = await rolledBack(async (tx) => {
        const row = (await begin(tx, h.person.anika, group)).rows[0];
        expect(row, group).toBeDefined();
        return [await listing(tx, row!.person_id), await listing(tx, real)];
      });
      expect(standIn, group).toEqual(expected);
    }
  });

  it('caps a subgroup at its parent', async () => {
    const levels = await rolledBack(async (tx) => {
      const row = (await begin(tx, h.person.anika, h.group.aFin)).rows[0]!;
      return (await tx.query<{ level: number }>(`select level from effective_level($1, $2, $3, record_clock())`, [row.person_id, h.node.aud1, at])).rows[0];
    });
    expect(levels?.level).toBe(20);
  });

  it('creates a plain member with the NDA accepted', async () => {
    const r = await rolledBack(async (tx) => {
      const row = (await begin(tx, h.person.anika, h.group.a)).rows[0]!;
      const nda = (await tx.query<{ ok: boolean }>(`select nda_accepted($1, $2, record_clock()) as ok`, [row.person_id, h.ws])).rows[0]!.ok;
      const groups = (await tx.query<{ group_id: string; role: string }>(`select group_id, role from membership where person_id = $1`, [row.person_id])).rows;
      const admin = (await tx.query<{ ok: boolean }>(`select is_workspace_admin($1, $2, $3) as ok`, [row.person_id, h.ws, at])).rows[0]!.ok;
      return { row, nda, groups, admin };
    });
    expect(r.row).toMatchObject({ group_name: 'Bidder A', side: 'bidders', party_kind: 'bidder' });
    expect(r.nda).toBe(true);
    expect(r.groups).toEqual([{ group_id: h.group.a, role: 'member' }]);
    expect(r.admin).toBe(false);
  });

  it('should only start for room admins and real teams', async () => {
    const rows = await rolledBack(async (tx) => [
      (await begin(tx, h.person.jan, h.group.a)).rows.length,
      (await begin(tx, h.person.maria, h.group.b)).rows.length,
      (await begin(tx, h.person.anika, h.group.admins)).rows.length,
      (await begin(tx, h.person.anika, '00000000-0000-4000-8000-000000000000')).rows.length,
    ]);
    expect(rows).toEqual([0, 0, 0, 0]);
  });

  it('previews a preparing room as open', async () => {
    const open = await h.app((tx) => listing(tx, h.person.jan));
    expect(open.length).toBeGreaterThan(0);
    await h.app((tx) => tx.query(`update workspace set state = 'preparing' where id = $1`, [h.ws]));
    const state = async (tx: SqlClient) => (await tx.query<{ s: string }>(`select workspace_state_at($1, $2) as s`, [h.ws, at])).rows[0]!.s;
    expect(await h.app((tx) => listing(tx, h.person.jan))).toEqual([]);
    const seen = await rolledBack(async (tx) => {
      const before = await state(tx);
      const row = (await begin(tx, h.person.anika, h.group.a)).rows[0]!;
      return { before, during: await state(tx), standIn: await listing(tx, row.person_id) };
    });
    expect(seen.before).toBe('preparing');
    expect(seen.during).toBe('open');
    expect(seen.standIn).toEqual(open);
    expect(await h.app(state)).toBe('preparing');
    expect(await h.app((tx) => listing(tx, h.person.jan))).toEqual([]);
  });

  it('keeps a closed room closed', async () => {
    await h.app((tx) => tx.query(`update workspace set state = 'closed' where id = $1`, [h.ws]));
    const standIn = await rolledBack(async (tx) => {
      const row = (await begin(tx, h.person.anika, h.group.a)).rows[0]!;
      return listing(tx, row.person_id);
    });
    expect(standIn).toEqual([]);
  });

  it('fails at commit', async () => {
    const people = async () => Number((await h.pg.query<{ n: string }>(`select count(*) as n from person`)).rows[0]!.n);
    const before = await people();
    await expect(h.app(async (tx) => { await begin(tx, h.person.anika, h.group.a); })).rejects.toThrow(/never saved/);
    expect(await people()).toBe(before);
    expect(Number((await h.pg.query<{ n: string }>(`select count(*) as n from see_as_preview`)).rows[0]!.n)).toBe(0);
  });

  it('backdates only the stand-in', async () => {
    // API clock 5 ms behind the database
    const apiAt = new Date(T.at.getTime() - 5).toISOString();
    const r = await rolledBack(async (tx) => {
      const p = (await tx.query<{ person_id: string }>(`select * from see_as_begin($1, $2, $3, $4)`, [h.person.anika, h.ws, h.group.a, apiAt])).rows[0]!.person_id;
      const m = (await tx.query<{ recorded_at: Date }>(`select recorded_at from membership where person_id = $1`, [p])).rows[0]!;
      const a = (await tx.query<{ accepted_at: Date }>(`select accepted_at from acceptance where person_id = $1`, [p])).rows[0]!;
      const level = (await tx.query<{ level: number }>(`select max(level) as level from accessible_nodes($1, $2, $3, record_clock())`, [p, h.ws, apiAt])).rows[0]!;
      const real = (await tx.query<{ recorded_at: Date }>(
        `insert into membership (tenant_id, person_id, group_id) values (current_tenant_id(), $1, $2) returning recorded_at`, [h.person.mei, h.group.b])).rows[0]!;
      return { m: new Date(m.recorded_at).getTime(), a: new Date(a.accepted_at).getTime(), level: Number(level.level), real: new Date(real.recorded_at).getTime() };
    });
    expect(r.m).toBe(T.at.getTime() - 5 - 60_000);
    expect(r.a).toBe(r.m);
    expect(r.level).toBeGreaterThan(0);
    expect(r.real).toBe(T.at.getTime());
  });
});

describe('see_as_teams()', () => {
  it('lists bidder and seller teams', async () => {
    const teams = await h.app(async (tx) => (await tx.query<{ name: string; side: string }>(
      `select name, side from see_as_teams($1, $2, $3)`, [h.person.anika, h.ws, at])).rows);
    teams.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    expect(teams).toEqual([
      { name: 'Bidder A', side: 'bidders' }, { name: 'Bidder A Q&A team', side: 'bidders' }, { name: 'Bidder A financier', side: 'bidders' },
      { name: 'Bidder B', side: 'bidders' }, { name: 'Seller finance team', side: 'seller' },
    ]);
  });

  it('returns nothing for non-admins', async () => {
    const n = await h.app(async (tx) => (await tx.query(`select * from see_as_teams($1, $2, $3)`, [h.person.jan, h.ws, at])).rows.length);
    expect(n).toBe(0);
  });
});
