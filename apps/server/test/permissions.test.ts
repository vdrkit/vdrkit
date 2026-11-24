// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';


let h: Heron;
let app: FastifyInstance;
let clock: Date;
const hour = (n: number) => new Date(T.at.getTime() + n * 3_600_000);
async function setClock(at: Date) { clock = at; await h.pin(at); }

beforeEach(async () => {
  h = await heron();
  clock = T.at;
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => clock });
});
afterEach(async () => {
  await app.close();
  await h.pg.close();
});

const call = (method: 'GET' | 'PUT' | 'PATCH', url: string, person: string, payload?: unknown) =>
  app.inject({ method, url: `/v1/workspaces/${h.ws}${url}`, headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1 }, ...(payload ? { payload } : {}) });

const cell = (body: any, g: string, n: string) => body.effective.find((e: any) => e.groupId === g && e.nodeId === n);

describe('GET /permissions', () => {
  it('returns groups, folders, grants and levels', async () => {
    const res = await call('GET', '/permissions', h.person.anika);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.past).toBe(false);
    expect(body.room).toMatchObject({ state: 'open', fourEyesPublish: false, summaryTimes: ['08:00'] });
    expect(body.groups.map((g: any) => g.name)).toContain('Bidder A financier');
    expect(body.groups.find((g: any) => g.id === h.group.contributors)).toMatchObject({ people: 1, soleMember: 'Maria Botha' });
    expect(body.nodes.every((n: any) => n.kind === 'folder')).toBe(true);
    expect(body.nodes.find((n: any) => n.id === h.node.aud)).toMatchObject({ published: 1, drafts: 1 });
    expect(cell(body, h.group.contributors, h.node.aud)).toMatchObject({ level: 20, canUpload: true, sourceNodeId: h.node.fin });
    expect(cell(body, h.group.a, h.node.fin)).toMatchObject({ level: 0, sourceNodeId: null });
  });

  it('should require room admin', async () => {
    for (const p of [h.person.jan, h.person.maria, h.person.lars]) {
      const res = await call('GET', '/permissions', p);
      expect(res.statusCode, p).toBe(403);
      expect(res.json().reason).toBe('not_room_admin');
    }
  });

  it('returns 404 to non-members', async () => {
    const outsider = (await h.pg.query<{ id: string }>(
      `insert into person (tenant_id, name, email) values ($1, 'Outsider', 'out@example.com') returning id`, [h.t1])).rows[0]!.id;
    const res = await call('GET', '/permissions', outsider);
    const missing = await app.inject({ method: 'GET', url: '/v1/workspaces/00000000-0000-4000-8000-000000000000/permissions',
      headers: { 'x-dev-person': outsider, 'x-dev-tenant': h.t1 } });
    expect(res.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(res.json().title).toBe(missing.json().title);
  });

  it('shows a past moment read-only', async () => {
    await setClock(hour(1));
    const put = await call('PUT', '/grants', h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.a, level: 40 }] });
    expect(put.statusCode).toBe(200);
    await setClock(hour(26));
    const today = (await call('GET', '/permissions', h.person.anika)).json();
    expect(cell(today, h.group.a, h.node.fin).level).toBe(40);
    expect(today.history.map((x: any) => x.at)).not.toContain(hour(1).toISOString());
    expect(today.history.map((x: any) => x.at)).toContain(T.grantsSet.toISOString());

    const before = (await call('GET', `/permissions?at=${hour(0).toISOString()}`, h.person.anika)).json();
    expect(before.past).toBe(true);
    expect(cell(before, h.group.a, h.node.fin).level).toBe(0);
    const after = (await call('GET', `/permissions?at=${hour(1).toISOString()}`, h.person.anika)).json();
    expect(cell(after, h.group.a, h.node.fin).level).toBe(40);
  });

  it('offers earlier changes from today', async () => {
    await setClock(hour(1));
    expect((await call('PUT', '/grants', h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.a, level: 20 }] })).statusCode).toBe(200);
    await setClock(hour(2));
    expect((await call('PUT', '/grants', h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.a, level: 50 }] })).statusCode).toBe(200);
    await setClock(hour(3));
    const moments = (await call('GET', '/permissions', h.person.anika)).json().history.map((x: any) => x.at);
    expect(moments).toContain(hour(1).toISOString());
    expect(moments).not.toContain(hour(2).toISOString());
    expect(moments).toContain(T.grantsSet.toISOString());
  });

  it('rejects future moments', async () => {
    const res = await call('GET', `/permissions?at=${hour(5).toISOString()}`, h.person.anika);
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain('in the past');
  });

  it('lists person grants', async () => {
    const put = await call('PUT', '/grants', h.person.anika, { changes: [
      { nodeId: h.node.fin, personId: h.person.jan, effect: 'deny' },
      { nodeId: h.node.aud, personId: h.person.maria, level: 50, canPublish: true },
    ] });
    expect(put.statusCode).toBe(200);
    const body = (await call('GET', '/permissions', h.person.anika)).json();
    expect(body.personGrants.find((g: any) => g.personId === h.person.jan)).toMatchObject({ nodeId: h.node.fin, effect: 'deny', level: 0, groupIds: [h.group.a] });
    expect(body.personGrants.find((g: any) => g.personId === h.person.maria)).toMatchObject({ nodeId: h.node.aud, effect: 'allow', level: 50, canPublish: true, groupIds: [h.group.contributors] });
  });

  it('lists future grants', async () => {
    const from = hour(48).toISOString();
    expect((await call('PUT', '/grants', h.person.anika, { changes: [{ nodeId: h.node.it, groupId: h.group.b, level: 20, validFrom: from }] })).statusCode).toBe(200);
    const body = (await call('GET', '/permissions', h.person.anika)).json();
    expect(body.grants.find((g: any) => g.nodeId === h.node.it && g.groupId === h.group.b)).toMatchObject({ inForce: false, validFrom: from });
    expect(cell(body, h.group.b, h.node.it).level).toBe(0);
  });
});

describe('frozen room', () => {
  it('saves grants as one event', async () => {
    await h.pg.query(`update workspace set state = 'frozen' where id = $1`, [h.ws]);
    await h.pg.query(`insert into workspace_state_history (tenant_id, workspace_id, state, valid_from, recorded_at) values ($1, $2, 'frozen', $3, $3)`,
      [h.t1, h.ws, new Date(T.at.getTime() - 60_000).toISOString()]);
    await setClock(hour(1));
    const res = await call('PUT', '/grants', h.person.anika, { changes: [
      { nodeId: h.node.fin, groupId: h.group.a, level: 50 },
      { nodeId: h.node.tax, groupId: h.group.a, level: 0 },
    ] });
    expect(res.statusCode).toBe(200);
    expect(res.json().changed).toBe(2);
    const body = (await call('GET', '/permissions', h.person.anika)).json();
    expect(body.room.state).toBe('frozen');
    expect(cell(body, h.group.a, h.node.aud).level).toBe(50);
    expect(cell(body, h.group.a, h.node.tax)).toMatchObject({ level: 0, sourceNodeId: h.node.tax });
    // subgroup has no grant of its own
    expect(cell(body, h.group.aFin, h.node.fin).level).toBe(0);
    const events = await h.pg.query(`select action from event where workspace_id = $1 and action like 'grant%'`, [h.ws]);
    expect(events.rows.map((r: any) => r.action)).toEqual(['grants.bulk_changed']);
  });

  it('keeps adding files, publishing and managing for the seller side', async () => {
    const refused = { status: 400, detail: 'Only the seller side may add files, publish or manage. Bidders and financiers get a level only.' };
    for (const right of ['canUpload', 'canPublish', 'canManage']) {
      const group = await call('PUT', '/grants', h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.a, level: 20, [right]: true }] });
      expect({ status: group.statusCode, detail: group.json().detail }, right).toEqual(refused);
      expect(group.json().items).toEqual([h.group.a]);
      const person = await call('PUT', '/grants', h.person.anika, { changes: [{ nodeId: h.node.fin, personId: h.person.jan, level: 20, [right]: true }] });
      expect({ status: person.statusCode, detail: person.json().detail }, right).toEqual(refused);
    }
    expect((await h.pg.query(`select 1 from access_grant where (can_upload or can_publish or can_manage)
      and (subject_group_id = $1 or subject_person_id = $2)`, [h.group.a, h.person.jan])).rows).toEqual([]);
    // nor someone whose invitation to a bidder group is still open
    const invited = await app.inject({ method: 'POST', url: `/v1/workspaces/${h.ws}/invitations`, headers: { 'x-dev-person': h.person.anika, 'x-dev-tenant': h.t1 },
      payload: { groupId: h.group.a, people: [{ email: 'sven@bidder-a.example', givenName: 'Sven', familyName: 'Lund' }] } });
    expect(invited.statusCode).toBe(201);
    const sven = (await h.pg.query<{ id: string }>(`select id from person where email = 'sven@bidder-a.example'`)).rows[0]!.id;
    const pending = await call('PUT', '/grants', h.person.anika, { changes: [{ nodeId: h.node.fin, personId: sven, level: 20, canUpload: true }] });
    expect({ status: pending.statusCode, detail: pending.json().detail }).toEqual(refused);
    // the seller team still can
    expect((await call('PUT', '/grants', h.person.anika, { changes: [
      { nodeId: h.node.tax, groupId: h.group.contributors, level: 20, canUpload: true, canPublish: true },
      { nodeId: h.node.tax, personId: h.person.maria, level: 20, canUpload: true },
    ] })).statusCode).toBe(200);
  });

  it('refuses bidders', async () => {
    const res = await call('PUT', '/grants', h.person.jan, { changes: [{ nodeId: h.node.fin, groupId: h.group.a, level: 60 }] });
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.json())).not.toContain('Bidder B');
  });
});
