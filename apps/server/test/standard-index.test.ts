// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Channel, OutgoingMessage } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';


let h: Heron;
let app: FastifyInstance;
let outbox: OutgoingMessage[];
const mailer: Channel = { name: 'email', send: async (m) => { outbox.push(m); return { status: 'accepted', providerMessageId: `pm-${outbox.length}` }; } };

beforeEach(async () => {
  h = await heron();
  outbox = [];
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at, mailer, publicUrl: 'https://dataroom.example' });
});
afterEach(async () => { await app.close(); await h.pg.close(); });

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, person: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1 }, ...(payload !== undefined ? { payload } : {}) });

async function emptyRoom(): Promise<string> {
  await h.pg.query(`update person set can_create_rooms = true where id = $1`, [h.person.anika]);
  const res = await call('POST', '/v1/workspaces', h.person.anika, { name: 'Project Ibis', start: 'empty', timeZone: 'Africa/Johannesburg' });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id;
}

const nodes = (ws: string) => h.pg.query<{ index_number: string; name: string; state: string; parent_id: string | null; id: string }>(
  `select id, index_number, name, state, parent_id from node where workspace_id = $1 order by sort_key`, [ws]);

describe('standard index', () => {
  it('creates 11 folders and 40 subfolders as drafts', async () => {
    const ws = await emptyRoom();
    const res = await call('POST', `/v1/workspaces/${ws}/standard-index`, h.person.anika);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({ folders: 11, subfolders: 40 });

    const rows = (await nodes(ws)).rows;
    expect(rows).toHaveLength(51);
    expect(rows.every((r) => r.state === 'draft')).toBe(true);
    const tops = rows.filter((r) => !r.parent_id).map((r) => `${r.index_number} ${r.name}`);
    expect(tops.slice(0, 3)).toEqual(['1 Corporate', '2 Legal', '3 Finance']);
    expect(rows.find((r) => r.index_number === '3.1')?.name).toBe('Management accounts');

    // only the room admins group holds grants
    const grants = (await h.pg.query<{ role_template: string; n: number }>(
      `select g.role_template, count(*)::int as n from access_grant a join groups g on g.id = a.subject_group_id
        where a.workspace_id = $1 group by g.role_template`, [ws])).rows;
    expect(grants).toEqual([{ role_template: 'admin', n: 11 }]);

    const ev = (await h.pg.query<{ data: any }>(`select data from event where workspace_id = $1 and action = 'workspace.standard_index_created'`, [ws])).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data).toMatchObject({ person_id: h.person.anika, folders: 11, subfolders: 40 });
    const log = await call('GET', `/v1/workspaces/${ws}/events?action=workspace.standard_index_created`, h.person.anika);
    expect(log.statusCode, log.body).toBe(200);
    expect(JSON.stringify(log.json())).toContain('Created the standard M&A index');
  });

  it('refuses a second time', async () => {
    const ws = await emptyRoom();
    expect((await call('POST', `/v1/workspaces/${ws}/standard-index`, h.person.anika)).statusCode).toBe(201);
    const again = await call('POST', `/v1/workspaces/${ws}/standard-index`, h.person.anika);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ reason: 'room_not_empty' });
    expect((await nodes(ws)).rows).toHaveLength(51);
  });

  it('refuses a room that has or had folders', async () => {
    const heron = await call('POST', `/v1/workspaces/${h.ws}/standard-index`, h.person.anika);
    expect(heron.statusCode).toBe(409);
    expect(heron.json()).toMatchObject({ reason: 'room_not_empty', detail: expect.stringContaining('already has folders') });

    const ws = await emptyRoom();
    const f = await call('POST', `/v1/workspaces/${ws}/folders`, h.person.anika, { name: 'Scratch' });
    expect(f.statusCode, f.body).toBe(201);
    await h.pg.query(`update node set deleted_at = now() where id = $1`, [f.json().id]);
    const res = await call('POST', `/v1/workspaces/${ws}/standard-index`, h.person.anika);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: 'room_not_empty', detail: expect.stringContaining('removed folders') });
  });

  it('is for room admins only', async () => {
    const ws = await emptyRoom();
    for (const p of [h.person.maria, h.person.jan]) {
      const res = await call('POST', `/v1/workspaces/${ws}/standard-index`, p);
      expect(res.statusCode).toBe(404);
    }
    expect((await nodes(ws)).rows).toHaveLength(0);
    for (const p of [h.person.maria, h.person.jan]) {
      const res = await call('POST', `/v1/workspaces/${h.ws}/standard-index`, p);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ reason: 'not_room_admin' });
    }
  });

  it('refuses while the room is frozen', async () => {
    const ws = await emptyRoom();
    expect((await call('PATCH', `/v1/workspaces/${ws}/settings`, h.person.anika, { state: 'frozen' })).statusCode).toBe(200);
    const res = await call('POST', `/v1/workspaces/${ws}/standard-index`, h.person.anika);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: 'room_frozen' });
    expect((await nodes(ws)).rows).toHaveLength(0);
  });
});
