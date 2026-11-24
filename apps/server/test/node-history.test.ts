// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { accessibleNodes, appendEvent, effectiveAccess, Level } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';


let h: Heron;
let app: FastifyInstance;
let clock: Date;
const hour = (n: number) => new Date(T.at.getTime() + n * 3_600_000);

async function setClock(at: Date) {
  clock = at;
  await h.pin(at);
}

beforeEach(async () => {
  h = await heron();
  clock = T.at;
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => clock });
});
afterEach(async () => {
  await app.close();
  await h.pg.close();
});

const call = (method: 'GET' | 'PUT' | 'PATCH' | 'POST', url: string, person: string, payload?: unknown) =>
  app.inject({ method, url: `/v1/workspaces/${h.ws}${url}`, headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1 }, ...(payload ? { payload } : {}) });

const nameOf = (body: any, id: string) => body.nodes.find((n: any) => n.id === id)?.name;

describe('node history', () => {
  it('records reorders with sort_key', async () => {
    await h.pg.query(`update node set sort_key = case id when $1 then 1 when $2 then 2 end where id in ($1, $2)`, [h.node.aud, h.node.tax]);
    await setClock(hour(1));
    const res = await call('PATCH', `/nodes/${h.node.tax}`, h.person.anika, { position: 1, confirmRenumberPublished: true });
    expect(res.statusCode).toBe(200);
    const rows = (await h.pg.query<{ node_id: string; sort_key: number | null; valid_from: string }>(
      `select node_id, sort_key, valid_from from node_history where node_id in ($1, $2) and valid_from = $3 order by id`,
      [h.node.aud, h.node.tax, hour(1).toISOString()])).rows;
    const last = (id: string) => rows.filter((r) => r.node_id === id).at(-1)?.sort_key;
    expect([last(h.node.tax), last(h.node.aud)]).toEqual([1, 2]);
  });

  it('shows old names in a past matrix', async () => {
    await setClock(hour(1));
    expect((await call('PATCH', `/nodes/${h.node.fin}`, h.person.anika, { name: 'Finance and tax' })).statusCode).toBe(200);
    await setClock(hour(2));

    const before = (await call('GET', `/grants?at=${hour(0).toISOString()}`, h.person.anika)).json();
    expect(nameOf(before, h.node.fin)).toBe('Finance');
    const after = (await call('GET', `/grants?at=${hour(1).toISOString()}`, h.person.anika)).json();
    expect(nameOf(after, h.node.fin)).toBe('Finance and tax');
    const today = (await call('GET', '/grants', h.person.anika)).json();
    expect(nameOf(today, h.node.fin)).toBe('Finance and tax');
    expect(before.grants.map((g: any) => g.id).sort()).toEqual(today.grants.map((g: any) => g.id).sort());
  });

  it('uses the name at event time in the export', async () => {
    await setClock(hour(1));
    await h.app((tx) => appendEvent(tx, {
      action: 'document.opened', workspaceId: h.ws, resourceType: 'node', resourceId: h.node.aud1, data: {} }));
    await setClock(hour(2));
    expect((await call('PATCH', `/nodes/${h.node.aud1}`, h.person.anika, { name: 'AFS FY2025.pdf' })).statusCode).toBe(200);

    const rows = (await call('GET', '/events/export.csv', h.person.anika)).body.split('\r\n');
    const opened = rows.find((l) => l.includes('Opened document'));
    const renamed = rows.find((l) => l.includes(',Renamed,'));
    expect(opened).toContain('3.2.1 Audited financial statements FY2025.pdf');
    expect(renamed).toContain('3.2.1 AFS FY2025.pdf');
  });

  it('inherits from the folder at the time', async () => {
    await setClock(hour(1));
    expect((await call('PUT', '/grants', h.person.anika, { changes: [{ nodeId: h.node.tax, groupId: h.group.b, level: Level.View }] })).statusCode).toBe(200);
    await setClock(hour(3));
    const moved = await call('PATCH', `/nodes/${h.node.tax1}`, h.person.anika, { parentId: h.node.aud, confirmRenumberPublished: true });
    expect(moved.statusCode).toBe(200);
    await setClock(hour(4));

    const at = (when: Date) => h.app((tx) => effectiveAccess(tx, h.person.mei, h.node.tax1, { at: when }));
    expect((await at(hour(2))).level).toBe(Level.View);
    expect((await at(hour(4))).level).toBe(0);
    const listed = async (when: Date) => (await h.app((tx) => accessibleNodes(tx, h.person.mei, h.ws, { at: when }))).has(h.node.tax1);
    expect([await listed(hour(2)), await listed(hour(4))]).toEqual([true, false]);
    expect((await at(hour(0))).level).toBe(0);
  });

  it('keeps withdrawn and deleted nodes in history', async () => {
    await setClock(hour(1));
    expect((await call('POST', `/nodes/${h.node.aud1}/withdraw`, h.person.anika, { reason: 'Superseded' })).statusCode).toBe(200);
    await setClock(hour(2));
    // no delete route yet
    await h.pg.query(`update node set deleted_at = $2 where id = $1`, [h.node.tax1, hour(2).toISOString()]);
    await h.pg.query(`delete from node where id = $1`, [h.node.audDraft]);
    await setClock(hour(3));

    const history = await h.app((tx) => tx.query<{ node_id: string; state: string; deleted_at: string | null; op: string }>(
      `select node_id, state, deleted_at, op from node_history where node_id = any($1::uuid[]) order by id`,
      [[h.node.aud1, h.node.tax1, h.node.audDraft]]));
    const of = (id: string) => history.rows.filter((r) => r.node_id === id);
    expect(of(h.node.aud1).map((r) => r.state)).toEqual(['published', 'withdrawn']);
    expect(of(h.node.tax1).map((r) => r.deleted_at !== null)).toEqual([false, true]);
    expect(of(h.node.audDraft).map((r) => r.op)).toEqual(['insert', 'delete']);

    const tree = async (when: Date) => (await h.app((tx) => tx.query<{ node_id: string; state: string }>(
      `select node_id, state from node_tree_at($1, $2)`, [h.ws, when.toISOString()]))).rows;
    const past = await tree(hour(0));
    expect(past.map((r) => r.node_id)).toEqual(expect.arrayContaining([h.node.aud1, h.node.tax1, h.node.audDraft]));
    expect(past.find((r) => r.node_id === h.node.aud1)?.state).toBe('published');
    const now = await tree(hour(3));
    expect(now.find((r) => r.node_id === h.node.aud1)?.state).toBe('withdrawn');
    expect(now.map((r) => r.node_id)).not.toContain(h.node.tax1);
    expect(now.map((r) => r.node_id)).not.toContain(h.node.audDraft);
  });

  it('is append-only', async () => {
    const app_ = (sql: string) => h.app((tx) => tx.query(sql, [h.node.fin]));
    await expect(app_(`update node_history set name = 'Rewritten' where node_id = $1`)).rejects.toThrow(/permission denied/);
    await expect(app_(`delete from node_history where node_id = $1`)).rejects.toThrow(/permission denied/);
    await expect(h.app((tx) => tx.query(
      `insert into node_history (tenant_id, workspace_id, node_id, kind, name, state, path, op, valid_from, recorded_at)
       values (current_tenant_id(), $1, gen_random_uuid(), 'folder', 'Forged', 'published', 'nx', 'insert', now(), now())`, [h.ws])))
      .rejects.toThrow(/permission denied/);
    await expect(h.pg.query(`update node_history set name = 'Rewritten' where node_id = $1`, [h.node.fin])).rejects.toThrow(/never changed/);
    await expect(h.pg.query(`delete from node_history where node_id = $1`, [h.node.fin])).rejects.toThrow(/never deleted/);
    expect((await app_(`select 1 from node_history where node_id = $1`)).rows.length).toBe(1);
  });
});
