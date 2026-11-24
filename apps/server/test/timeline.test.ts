// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sendNotification, type Channel, type OutgoingMessage } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';


let h: Heron;
let app: FastifyInstance;
let outbox: OutgoingMessage[];
let clock: Date;
const mailer: Channel = { name: 'email', send: async (m) => { outbox.push(m); return { status: 'accepted' }; } };

beforeEach(async () => {
  h = await heron();
  outbox = [];
  clock = T.at;
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => clock, mailer });
});
afterEach(async () => { await app.close(); await h.pg.close(); });

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, person: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1 }, ...(payload !== undefined ? { payload } : {}) });
const W = () => `/v1/workspaces/${h.ws}`;
const later = (m: number) => new Date(T.at.getTime() + m * 60_000);
const queued = async (personId: string) => (await h.pg.query<{ id: string; mode: string }>(
  `select id, mode from notification where person_id = $1 and category = 'deadlines' and status = 'open' order by first_event_at`, [personId])).rows;
const clearQueue = () => h.pg.exec(`delete from notification_item; delete from notification;`);

describe('timeline emails', () => {
  it('logs but emails nobody when email is off', async () => {
    const res = await call('POST', `${W()}/milestones`, h.person.anika, { title: 'Q&A cut-off', dueAt: '2027-01-22T15:00:00Z', notify: false });
    expect(res.statusCode).toBe(201);
    expect(await queued(h.person.jan)).toEqual([]);
    clock = later(5);
    await call('PATCH', `${W()}/milestones/${res.json().id}`, h.person.anika, { dueAt: '2027-01-29T15:00:00Z', visibleToGroupIds: [h.group.a], notify: false });
    expect(await queued(h.person.mei)).toEqual([]);
    expect(await queued(h.person.jan)).toEqual([]);
    const logged = (await h.pg.query<{ data: any }>(`select data from event where action = 'milestone.changed' order by occurred_at`)).rows.map((r) => r.data);
    expect(logged.map((d) => [d.change, d.emailed]).sort()).toEqual([['added', false], ['changed', false]]);
  });

  it('emails only the groups that see a date', async () => {
    await call('POST', `${W()}/milestones`, h.person.anika, { title: 'Management presentation', dueAt: '2026-12-08T08:00:00Z', visibleToGroupIds: [h.group.b] });
    expect(await queued(h.person.mei)).toHaveLength(1);
    expect(await queued(h.person.jan)).toEqual([]);
  });

  it('sends an earlier date right away', async () => {
    await h.pg.query(`insert into notification_policy (tenant_id, workspace_id, scope, person_id, category, mode) values ($1, $2, 'user', $3, 'deadlines', 'digest')`,
      [h.t1, h.ws, h.person.jan]);
    const id = (await call('POST', `${W()}/milestones`, h.person.anika, { title: 'Non-binding offers due', dueAt: '2026-11-27T15:00:00Z' })).json().id;
    expect((await queued(h.person.jan)).map((n) => n.mode)).toEqual(['digest']);
    await clearQueue();
    clock = later(5);
    await call('PATCH', `${W()}/milestones/${id}`, h.person.anika, { dueAt: '2026-12-04T15:00:00Z' });
    expect((await queued(h.person.jan)).map((n) => n.mode)).toEqual(['digest']);
    await clearQueue();
    clock = later(10);
    await call('PATCH', `${W()}/milestones/${id}`, h.person.anika, { dueAt: '2026-11-25T15:00:00Z' });
    expect((await queued(h.person.jan)).map((n) => n.mode)).toEqual(['immediate']);
  });

  it('gives the date when only the title changed', async () => {
    const id = (await call('POST', `${W()}/milestones`, h.person.anika, { title: 'Offers due', dueAt: '2026-11-27T15:00:00Z' })).json().id;
    await clearQueue();
    clock = later(5);
    await call('PATCH', `${W()}/milestones/${id}`, h.person.anika, { title: 'Non-binding offers due' });
    const [n] = await queued(h.person.jan);
    expect((await h.app((tx) => sendNotification(tx, n!.id, mailer, later(6)))).status).toBe('sent');
    expect(outbox[0]!.lines).toEqual([expect.stringMatching(/^Non-binding offers due: Fri 27 Nov/)]);
    expect(outbox[0]!.lines!.join(' ')).not.toMatch(/moved/);
  });
});

describe('silent saves and removals', () => {
  it('records nothing when a save changes nothing', async () => {
    const id = (await call('POST', `${W()}/milestones`, h.person.anika, { title: 'Offers due', dueAt: '2026-11-27T15:00:00Z', visibleToGroupIds: [h.group.a, h.group.b] })).json().id;
    const phase = (await call('POST', `${W()}/milestones`, h.person.anika, { title: 'Binding offers due', dueAt: '2027-02-12T15:00:00Z', phase: { name: 'Second round', startsOn: '2027-01-04' } })).json().id;
    await clearQueue();
    const count = async () => (await h.pg.query(`select 1 from event where action = 'milestone.changed'`)).rows.length;
    const logged = await count();
    clock = later(5);
    // dialogs resend every field, in any order
    const same = await call('PATCH', `${W()}/milestones/${id}`, h.person.anika, { title: 'Offers due', dueAt: '2026-11-27T15:00:00.000Z', visibleToGroupIds: [h.group.b, h.group.a], notify: true });
    expect(same.statusCode).toBe(200);
    expect(same.json().title).toBe('Offers due');
    const samePhase = await call('PATCH', `${W()}/milestones/${phase}`, h.person.anika, { title: 'Binding offers due', dueAt: '2027-02-12T15:00:00Z', phase: { name: 'Second round', startsOn: '2027-01-04' } });
    expect(samePhase.statusCode).toBe(200);
    expect(await queued(h.person.jan)).toEqual([]);
    expect(await queued(h.person.mei)).toEqual([]);
    expect(await count()).toBe(logged);
    await call('PATCH', `${W()}/milestones/${phase}`, h.person.anika, { title: 'Binding offers due', dueAt: '2027-02-12T15:00:00Z', phase: { name: 'Second round', startsOn: '2027-01-05' } });
    expect(await queued(h.person.jan)).toHaveLength(1);
  });

  it('removes a date without email', async () => {
    const a = (await call('POST', `${W()}/milestones`, h.person.anika, { title: 'Site visit', dueAt: '2026-12-02T08:00:00Z', visibleToGroupIds: [h.group.b] })).json().id;
    const b = (await call('POST', `${W()}/milestones`, h.person.anika, { title: 'Site visit 2', dueAt: '2026-12-03T08:00:00Z', visibleToGroupIds: [h.group.b] })).json().id;
    await clearQueue();
    clock = later(5);
    expect((await call('DELETE', `${W()}/milestones/${a}?notify=false`, h.person.anika)).statusCode).toBe(204);
    expect(await queued(h.person.mei)).toEqual([]);
    const logged = (await h.pg.query<{ data: any }>(`select data from event where action = 'milestone.changed' and resource_id = $1 and data->>'change' = 'removed'`, [a])).rows[0]!.data;
    expect([logged.change, logged.emailed]).toEqual(['removed', false]);
    expect((await call('DELETE', `${W()}/milestones/${b}`, h.person.anika)).statusCode).toBe(204);
    expect(await queued(h.person.mei)).toHaveLength(1);
  });
});

describe('phases', () => {
  it('refuses a phase that starts after its deadline', async () => {
    const bad = await call('POST', `${W()}/milestones`, h.person.anika, { title: 'Binding offers due', dueAt: '2027-02-12T15:00:00Z', phase: { name: 'Second round', startsOn: '2027-02-13' } });
    expect(bad.statusCode).toBe(400);
    // 23:30 UTC on 11 Feb is 12 Feb in Johannesburg
    const edge = await call('POST', `${W()}/milestones`, h.person.anika, { title: 'Binding offers due', dueAt: '2027-02-11T23:30:00Z', phase: { name: 'Second round', startsOn: '2027-02-12' } });
    expect(edge.statusCode).toBe(201);
    const moved = await call('PATCH', `${W()}/milestones/${edge.json().id}`, h.person.anika, { dueAt: '2027-02-10T15:00:00Z' });
    expect(moved.statusCode).toBe(400);
  });

  it('keeps a phase deadline for every group', async () => {
    const res = await call('POST', `${W()}/milestones`, h.person.anika, { title: 'Signing', dueAt: '2027-03-31T15:00:00Z', visibleToGroupIds: [h.group.a], phase: { name: 'Final round', startsOn: null } });
    expect(res.statusCode).toBe(400);
  });
});

describe('date groups', () => {
  it('lists non-seller groups with their time zones', async () => {
    await h.pg.query(`update person set time_zone = 'Europe/London' where id = $1`, [h.person.jan]);
    await h.pg.query(`update person set time_zone = 'Africa/Johannesburg' where id = $1`, [h.person.mei]);
    await h.pg.query(`update membership set role = 'lead' where person_id = $1`, [h.person.jan]);
    const res = await call('GET', `${W()}/timeline/groups`, h.person.anika);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.roomTimeZone).toBe('Africa/Johannesburg');
    const by = Object.fromEntries(body.items.map((g: any) => [g.name, [g.timeZone, g.zoneFrom, g.parentGroupId]]));
    expect(by).toEqual({
      'Bidder A': ['Europe/London', 'lead', null],
      'Bidder A financier': ['UTC', 'members', h.group.a],
      'Bidder A Q&A team': ['Africa/Johannesburg', 'room', null],
      'Bidder B': ['Africa/Johannesburg', 'members', null],
    });
    expect(body.items.map((g: any) => g.name).slice(0, 2)).toEqual(['Bidder A', 'Bidder A financier']);
  });

  it('is for room admins only', async () => {
    expect((await call('GET', `${W()}/timeline/groups`, h.person.jan)).statusCode).toBe(404);
    expect((await call('GET', `${W()}/timeline/groups`, h.person.maria)).statusCode).toBe(404);
    const stranger = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Eve', 'eve@x.example') returning id`, [h.t1])).rows[0]!.id;
    expect((await call('GET', `${W()}/timeline/groups`, stranger)).statusCode).toBe(404);
  });
});

describe('date visibility', () => {
  it('shows all dates to the seller team, bidders only theirs', async () => {
    const observers = (await h.pg.query<{ id: string }>(
      `insert into groups (tenant_id, workspace_id, party_id, name, role_template) values ($1, $2, $3, 'Heron management', 'observer') returning id`,
      [h.t1, h.ws, h.party.seller])).rows[0]!.id;
    const liesl = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Liesl van Wyk', 'liesl@drosvelt.example') returning id`, [h.t1])).rows[0]!.id;
    await h.pg.query(`insert into membership (tenant_id, person_id, group_id, recorded_at) values ($1, $2, $3, $4)`, [h.t1, liesl, observers, T.setup.toISOString()]);
    await call('POST', `${W()}/milestones`, h.person.anika, { title: 'Final offers due', dueAt: '2027-02-26T15:00:00Z', notify: false });
    await call('POST', `${W()}/milestones`, h.person.anika, { title: 'Management presentation B', dueAt: '2026-12-08T08:00:00Z', visibleToGroupIds: [h.group.b], notify: false });
    const titles = async (person: string) => {
      const res = await call('GET', `${W()}/milestones`, person);
      expect(res.statusCode, res.body).toBe(200);
      return res.json().items.map((m: any) => m.title);
    };
    const all = ['Management presentation B', 'Final offers due'];
    expect(await titles(h.person.anika)).toEqual(all);
    expect(await titles(liesl)).toEqual(all);
    expect(await titles(h.person.maria)).toEqual(all);
    expect(await titles(h.person.mei)).toEqual(all);
    expect(await titles(h.person.jan)).toEqual(['Final offers due']);
    const seen = (await call('GET', `${W()}/milestones`, liesl)).json().items;
    expect(seen.every((m: any) => m.visibleToGroupIds === undefined)).toBe(true);
    const dash = (await call('GET', `${W()}/dashboard`, liesl)).json();
    expect(dash.milestones.map((m: any) => m.title)).toEqual(all);
  });
});
