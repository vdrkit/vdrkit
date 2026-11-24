// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { appendEvent, type Channel, type OutgoingMessage } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';


let h: Heron;
let app: FastifyInstance;
let outbox: OutgoingMessage[];
let clock: Date;
let thandi: string;
let board: string;
const principal: Record<string, string> = {};
const mailer: Channel = { name: 'email', send: async (m) => { outbox.push(m); return { status: 'accepted' }; } };

const as = (person: string, extra: Record<string, string> = {}) => ({ 'x-dev-person': person, 'x-dev-tenant': h.t1, ...extra });
const call = (method: 'GET' | 'POST' | 'PUT', url: string, person: string, payload?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: as(person, extra), ...(payload !== undefined ? { payload } : {}) });
const W = () => `/v1/workspaces/${h.ws}`;
const at = (iso: string) => new Date(iso);

async function read(person: string, node: string, iso: string, pages: number[], pageCount: number, minutes: number) {
  await h.pin(at(iso));
  await h.app(async (tx) => {
    const v = (await tx.query<{ id: string }>(
      `insert into document_version (tenant_id, node_id, version_no, sha256, size_bytes, mime, storage_key)
       select tenant_id, $1, coalesce((select max(version_no) from document_version where node_id = $1), 0) + 1, repeat('a', 64), 1, 'application/pdf', 'k'
         from node where id = $1 returning id`, [node])).rows[0]!.id;
    const end = new Date(at(iso).getTime() + minutes * 60_000).toISOString();
    const s = (await tx.query<{ id: string }>(
      `insert into view_session (tenant_id, workspace_id, node_id, version_id, person_id, opened_at, last_seen_at, page_count, pages_seen)
       values (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8) returning id`, [h.ws, node, v, person, iso, end, pageCount, pages])).rows[0]!.id;
    await appendEvent(tx, { action: 'document.opened', workspaceId: h.ws, actorId: principal[person], resourceType: 'node', resourceId: node,
      data: { version_id: v, page_count: pageCount, person_id: person, session_id: s } });
  });
}

beforeEach(async () => {
  h = await heron();
  outbox = [];
  clock = T.at;
  for (const id of Object.values(h.person)) {
    principal[id] = (await h.pg.query<{ id: string }>(
      `insert into principal (tenant_id, kind, person_id, name) select tenant_id, 'person', id, name from person where id = $1 returning id`, [id])).rows[0]!.id;
  }
  await h.pg.query(`update person set time_zone = 'Africa/Johannesburg' where id = $1`, [h.person.anika]);
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => clock, mailer, publicUrl: 'https://dataroom.example' });
  await h.pin(at('2026-11-05T08:00:00Z'));
  clock = at('2026-11-05T08:00:00Z');
  expect((await call('PUT', `${W()}/grants`, h.person.anika, { changes: [
    { nodeId: h.node.fin, groupId: h.group.a, level: 20 }, { nodeId: h.node.tax, groupId: h.group.b, level: 20 }] })).statusCode).toBe(200);
  thandi = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Thandi Board', 'thandi@drosvelt.example') returning id`, [h.t1])).rows[0]!.id;
  principal[thandi] = (await h.pg.query<{ id: string }>(`insert into principal (tenant_id, kind, person_id, name) values ($1, 'person', $2, 'Thandi Board') returning id`, [h.t1, thandi])).rows[0]!.id;
  board = (await call('POST', `${W()}/groups`, h.person.anika, { name: 'Heron board', partyId: h.party.seller, roleTemplate: 'observer' })).json().id;
  await h.pg.query(`insert into membership (tenant_id, person_id, group_id) values ($1, $2, $3)`, [h.t1, thandi, board]);
  await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.tax, groupId: board, level: 20 }] });

  await read(h.person.jan, h.node.aud1, '2026-11-10T08:30:00Z', [1, 2, 3], 12, 9);
  await read(h.person.jan, h.node.aud1, '2026-11-11T09:00:00Z', [4, 5, 6, 7, 8, 9, 10, 11], 12, 20);
  await read(h.person.mei, h.node.tax1, '2026-11-11T10:00:00Z', [1, 2], 2, 3);
  await h.pin(at('2026-11-11T11:00:00Z'));
  await h.app(async (tx) => {
    await appendEvent(tx, { action: 'document.downloaded', workspaceId: h.ws, actorId: principal[h.person.jan], resourceType: 'node', resourceId: h.node.aud1,
      data: { format: 'original', person_id: h.person.jan } });
    await appendEvent(tx, { action: 'access.blocked', workspaceId: h.ws, resourceType: 'node', resourceId: h.node.aud1,
      data: { nodeId: h.node.aud1, route: 'viewer.open', reason: 'no_access', previouslySeen: true, personId: h.person.mei } });
  });
  clock = T.at;
  await h.pin(T.at);
});
afterEach(async () => { await app.close(); await h.pg.close(); });

const log = async (person: string, query = '') => {
  const res = await call('GET', `${W()}/events${query}`, person);
  expect(res.statusCode).toBe(200);
  return res.json();
};

describe('activity log entries', () => {
  it('names person, group, verb and pages', async () => {
    const body = await log(h.person.anika);
    expect(body).toMatchObject({ reader: 'admin', timeZone: 'Africa/Johannesburg' });
    expect(body.total).toBe(body.matching);
    const views = body.items.filter((e: any) => e.action === 'document.opened');
    expect(views).toHaveLength(3);
    expect(views.at(-1)).toMatchObject({
      kind: 'view', verb: { label: 'Viewed', icon: 'view', tone: 'view' },
      person: { id: h.person.jan, name: 'Jan de Vries' }, group: { id: h.group.a, name: 'Bidder A', isAdmin: false, partyKind: 'bidder' },
      node: { indexNumber: '3.2.1', name: 'Audited financial statements FY2025.pdf' },
      coverage: { pagesSeen: 3, pageCount: 12, minutes: 9 },
    });
    const down = body.items.find((e: any) => e.action === 'document.downloaded');
    expect(down).toMatchObject({ kind: 'download', verb: { label: 'Downloaded' }, detail: 'Original file' });
    const blocked = body.items.find((e: any) => e.action === 'access.blocked');
    expect(blocked).toMatchObject({ kind: 'signin', verb: { label: 'Blocked link', tone: 'risk' }, person: { name: 'Mei Tanaka' }, group: { name: 'Bidder B' } });
    expect(blocked.detail).toContain('Old link');
  });

  it('shows levels before and after a permission change', async () => {
    const body = await log(h.person.anika, '?kind=access');
    const change = body.items.find((e: any) => e.action === 'grants.bulk_changed' && e.detail.includes('Heron board'));
    // dev header auth records no actor
    expect(change).toMatchObject({ verb: { label: 'Changed access' }, item: '3.4 Tax' });
    expect(change.detail).toBe('Heron board: No access → View');
    await h.app((tx) => appendEvent(tx, { action: 'grants.bulk_changed', workspaceId: h.ws, actorId: principal[h.person.anika], resourceType: 'workspace',
      resourceId: h.ws, data: { cells: [{ node_id: h.node.fin, group_id: h.group.b, level: 50 }, { node_id: h.node.tax, group_id: h.group.a, level: 50 }] } }));
    const two = (await log(h.person.anika, '?kind=access&limit=1')).items[0];
    expect(two).toMatchObject({ person: { name: 'Anika Pillay' }, group: { name: 'Room admins', isAdmin: true }, item: '2 permission changes' });
    expect(two.detail).toBe('Bidder B: No access → Download PDF; Bidder A: View → Download PDF');
    expect(body.items.find((e: any) => e.action === 'group.created')).toMatchObject({ item: 'Created group Heron board' });
  });

  it('filters by kind, person and group', async () => {
    const ids = async (q: string) => (await log(h.person.anika, q)).items.map((e: any) => e.action);
    expect(await ids('?kind=view')).toEqual(['document.opened', 'document.opened', 'document.opened']);
    expect(await ids('?kind=download')).toEqual(['document.downloaded']);
    expect((await log(h.person.anika, `?person=${h.person.mei}`)).items.map((e: any) => e.action)).toEqual(['access.blocked', 'document.opened']);
    expect((await log(h.person.anika, `?group=${h.group.a}`)).items.every((e: any) => e.person?.id === h.person.jan)).toBe(true);
    expect((await log(h.person.anika, `?group=${h.group.aFin}`)).items).toEqual([]);
    expect((await log(h.person.anika, `?node=${h.node.tax}&kind=view`)).items.map((e: any) => e.node.indexNumber)).toEqual(['3.4.6']);
    expect((await log(h.person.anika, '?q=tanaka')).items.every((e: any) => e.person?.name === 'Mei Tanaka')).toBe(true);
    expect((await log(h.person.anika, '?q=3.2&kind=view')).matching).toBe(2);
    expect((await log(h.person.anika, '?q=50%25')).items).toEqual([]);
    const day = await log(h.person.anika, '?from=2026-11-10&to=2026-11-10');
    expect(day.items.map((e: any) => e.occurredAt)).toEqual(['2026-11-10T08:30:00.000Z']);
    expect(day.matching).toBe(1);
    expect(day.total).toBeGreaterThan(5);
    expect((await call('GET', `${W()}/events?from=soon`, h.person.anika)).statusCode).toBe(400);
    expect((await call('GET', `${W()}/events?kind=everything`, h.person.anika)).statusCode).toBe(400);
  });

  it('hides housekeeping unless filtered by action', async () => {
    await h.app((tx) => appendEvent(tx, { action: 'document.processed', workspaceId: h.ws, resourceType: 'node', resourceId: h.node.tax1, data: {} }));
    const all = await log(h.person.anika);
    expect(all.items.map((e: any) => e.action)).not.toContain('document.processed');
    expect(all.total).toBe(all.matching);
    expect((await log(thandi)).items.map((e: any) => e.action)).not.toContain('document.processed');
    expect((await log(h.person.anika, '?action=document.processed')).items).toHaveLength(1);
  });

  it('pages back with beforeSeq', async () => {
    const first = await log(h.person.anika, '?limit=2');
    expect(first.items).toHaveLength(2);
    const next = await log(h.person.anika, `?limit=2&beforeSeq=${first.nextBeforeSeq}`);
    expect(next.items[0].seq).toBeLessThan(first.items[1].seq);
  });

  it('exports the filtered entries', async () => {
    const res = await call('GET', `${W()}/events/export.csv?kind=view&group=${h.group.a}`, h.person.anika);
    expect(res.statusCode).toBe(200);
    const lines = res.body.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('2026-11-11 11:00 SAST,Jan de Vries,Bidder A,Viewed,3.2.1 Audited financial statements FY2025.pdf,8 of 12 pages · 20 min,'
      + '"Version: Version 2 | Pages viewed: 8 of 12: 4–11 | Time spent: 20 min | Opened at: Wed 11 Nov 2026, 11:00:00 SAST"');
    expect(lines[2]).toContain('2026-11-10 10:30 SAST,Jan de Vries,Bidder A,Viewed');
    const logged = (await h.pg.query<any>(`select data from event where action = 'activity.exported'`)).rows[0].data;
    expect(logged.filters).toMatchObject({ kind: 'view', group_id: h.group.a });
  });
});

describe('who reads Activity', () => {
  it('should refuse non-admin roles', async () => {
    const routes = [`${W()}/events`, `${W()}/events/verify`, `${W()}/activity/summary`, `${W()}/activity/groups/${h.group.a}/people`];
    for (const p of [h.person.jan, h.person.lars, h.person.mei, h.person.maria]) {
      for (const url of routes) expect([url, (await call('GET', url, p)).statusCode]).toEqual([url, 403]);
    }
    for (const url of routes) expect((await call('GET', url, h.person.anika, undefined, { 'x-dev-agent-max-level': '60' })).statusCode).toBe(403);
  });

  it('limits observers to entries they can see', async () => {
    expect((await call('GET', `${W()}/events/export.csv`, h.person.anika)).statusCode).toBe(200);
    await h.app((tx) => appendEvent(tx, { action: 'grant.changed', workspaceId: h.ws, resourceType: 'node', resourceId: h.node.tax,
      data: { subject_group_id: h.group.b, before: { level: 20 }, after: { level: 50 } } }));
    expect((await log(h.person.anika, '?action=grant.changed')).items[0]).toMatchObject({ verb: { label: 'Changed access' }, detail: 'Bidder B: View → Download PDF' });
    const body = await log(thandi);
    expect(body.reader).toBe('observer');
    const actions = body.items.map((e: any) => e.action);
    expect(actions).toContain('document.opened');
    for (const a of ['grant.changed', 'grants.bulk_changed', 'activity.exported', 'group.created', 'document.downloaded', 'access.blocked']) expect(actions).not.toContain(a);
    expect(body.items.filter((e: any) => e.action === 'document.opened').map((e: any) => e.node.indexNumber)).toEqual(['3.4.6']);
    expect(JSON.stringify(body)).not.toContain('Audited financial statements');
    expect(body.total).toBe(body.items.length);
    const v = (await call('GET', `${W()}/events/verify`, thandi)).json();
    expect(v).toMatchObject({ intact: true, checked: null, firstBroken: null });
    expect((await call('GET', `${W()}/events/verify`, h.person.anika)).json().checked).toBeGreaterThan(body.total);
  });

  it('names only renumbered items an observer can see', async () => {
    await h.app((tx) => appendEvent(tx, { action: 'index.renumbered', workspaceId: h.ws, resourceType: 'node', resourceId: h.node.tax1,
      data: { changes: [{ id: h.node.tax1, from: '3.4.6', to: '3.4.7' }, { id: h.node.aud1, from: '3.2.1', to: '3.2.2' }] } }));
    const seen = (await log(thandi, '?action=index.renumbered')).items;
    expect(seen).toHaveLength(1);
    expect(seen[0].data.changes).toEqual([{ id: h.node.tax1, from: '3.4.6', to: '3.4.7' }]);
    expect(JSON.stringify(seen)).not.toContain(h.node.aud1);
    const admin = (await log(h.person.anika, '?action=index.renumbered')).items;
    expect(admin[0].data.changes).toHaveLength(2);
  });

  it('keeps watermark lines from observers', async () => {
    const watermark = ['Mei Lin', 'mei@bidder-b.example'];
    await h.app((tx) => appendEvent(tx, { action: 'document.downloaded', workspaceId: h.ws, actorId: principal[h.person.mei], resourceType: 'node', resourceId: h.node.tax1,
      data: { format: 'pdf', person_id: h.person.mei }, context: { personal: { watermark }, subjectPersonId: h.person.mei } }));
    const seen = (await log(thandi, '?action=document.downloaded')).items;
    expect(seen).toHaveLength(1);
    expect(seen[0].personal).toBeNull();
    expect(JSON.stringify(seen)).not.toContain('mei@bidder-b.example');
    const admin = (await log(h.person.anika, '?action=document.downloaded')).items.find((e: any) => e.resourceId === h.node.tax1);
    expect(admin.personal).toEqual({ watermark });
  });

  it('shows observers all timeline dates', async () => {
    const res = await call('POST', `${W()}/milestones`, h.person.anika,
      { title: 'Management presentation B', dueAt: '2026-12-08T08:00:00Z', visibleToGroupIds: [h.group.b], notify: false });
    expect(res.statusCode, res.body).toBe(201);
    const body = await log(thandi, '?action=milestone.changed');
    expect(body.items).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain(h.group.b);
    expect(JSON.stringify(body)).not.toContain('Bidder B');
  });

  it('hides log, summary and chain check from room observers', async () => {
    const routes = [`${W()}/events`, `${W()}/events/verify`, `${W()}/activity/summary`];
    for (const url of routes) expect([url, (await call('GET', url, thandi)).statusCode]).toEqual([url, 200]);
    for (const state of ['closed', 'archived']) {
      await h.pg.query(`update workspace set state = $2 where id = $1`, [h.ws, state]);
      for (const url of routes) {
        const res = await call('GET', url, thandi);
        expect([state, url, res.statusCode, res.json().reason]).toEqual([state, url, 403, 'room_closed']);
        expect((await call('GET', url, h.person.anika)).statusCode).toBe(200);
      }
    }
  });

  it('does not let observers export or list group members', async () => {
    expect((await call('GET', `${W()}/events/export.csv`, thandi)).statusCode).toBe(403);
    const people = await call('GET', `${W()}/activity/groups/${h.group.a}/people`, thandi);
    expect(people.statusCode).toBe(403);
    expect(people.json()).toMatchObject({ reason: 'not_room_admin' });
    expect(JSON.stringify(people.json())).not.toContain('Jan de Vries');
  });

  it('shows Activity in the menu for admins and observers', async () => {
    const can = async (p: string) => (await call('GET', `${W()}/shell`, p)).json().me.canReadActivity;
    expect(await can(h.person.anika)).toBe(true);
    expect(await can(thandi)).toBe(true);
    expect(await can(h.person.jan)).toBe(false);
    expect(await can(h.person.maria)).toBe(false);
  });
});

describe('Bidders in the last 7 days', () => {
  it('returns the 7-day bidder summary', async () => {
    const res = await call('GET', `${W()}/activity/summary`, h.person.anika);
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.days).toHaveLength(7);
    expect(s.days.at(-1)).toBe('2026-11-11T22:00:00.000Z');
    expect(s.groups.map((g: any) => g.name)).toEqual(['Bidder A', 'Bidder A financier', 'Bidder A Q&A team', 'Bidder B']);
    const a = s.groups.find((g: any) => g.id === h.group.a);
    expect(a).toMatchObject({ members: 1, active: 1, docsOpened: 1, docsVisible: 2, downloads: 1,
      pagesPerDay: [0, 0, 0, 0, 3, 8, 0], readsMost: [{ indexNumber: '3', name: 'Finance', share: 100 }] });
    const fin = s.groups.find((g: any) => g.id === h.group.aFin);
    expect(fin).toMatchObject({ parentName: 'Bidder A', members: 1, active: 0, docsVisible: 0, readsMost: [] });
    expect(s.groups.find((g: any) => g.id === h.group.b)).toMatchObject({ docsVisible: 1, pagesPerDay: [0, 0, 0, 0, 0, 2, 0] });
  });

  it('counts only what an observer can see', async () => {
    const s = (await call('GET', `${W()}/activity/summary`, thandi)).json();
    const a = s.groups.find((g: any) => g.id === h.group.a);
    expect(a).toMatchObject({ docsOpened: 0, docsVisible: 1, downloads: 0, pagesPerDay: [0, 0, 0, 0, 0, 0, 0], readsMost: [] });
  });

  it('matches the dashboard figures', async () => {
    // a reader far from the room: days still run in the room's zone
    await h.pg.query(`update person set time_zone = 'America/New_York' where id = $1`, [h.person.anika]);
    // someone whose access to Bidder A ended last week reads today: counted by neither
    const olga = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Olga Former', 'olga@bidder-a.example') returning id`, [h.t1])).rows[0]!.id;
    principal[olga] = (await h.pg.query<{ id: string }>(`insert into principal (tenant_id, kind, person_id, name) values ($1, 'person', $2, 'Olga Former') returning id`, [h.t1, olga])).rows[0]!.id;
    await h.pg.query(`insert into membership (tenant_id, person_id, group_id, valid_from, valid_to) values ($1, $2, $3, '2026-11-01', '2026-11-08')`, [h.t1, olga, h.group.a]);
    await read(olga, h.node.aud1, '2026-11-12T06:00:00Z', [1], 12, 2);
    // reading today in Bidder A, only a download today in Bidder B
    await read(h.person.jan, h.node.aud1, '2026-11-12T07:00:00Z', [1, 2], 12, 4);
    await h.pin(at('2026-11-12T07:30:00Z'));
    await h.app(async (tx) => {
      await appendEvent(tx, { action: 'document.downloaded', workspaceId: h.ws, actorId: principal[h.person.mei], resourceType: 'node', resourceId: h.node.tax1,
        data: { format: 'original', person_id: h.person.mei } });
    });
    await h.pin(T.at);

    const s = (await call('GET', `${W()}/activity/summary`, h.person.anika)).json();
    expect(s.timeZone).toBe('Africa/Johannesburg');
    expect(s.days.at(-1)).toBe('2026-11-11T22:00:00.000Z');
    const d = (await call('GET', `${W()}/dashboard`, h.person.anika)).json().activity;
    for (const g of s.groups) {
      expect(d.find((x: any) => x.groupId === g.id)?.members, g.name).toBe(g.members);
    }
    const sa = s.groups.find((g: any) => g.id === h.group.a);
    const da = d.find((g: any) => g.groupId === h.group.a);
    expect(sa).toMatchObject({ members: 1, active: 1, pagesPerDay: [0, 0, 0, 0, 3, 8, 2] });
    expect(da).toMatchObject({ members: 1, activeToday: 1, openedToday: 1, quietThisWeek: 0 });
    const sb = s.groups.find((g: any) => g.id === h.group.b);
    const db = d.find((g: any) => g.groupId === h.group.b);
    expect(sb).toMatchObject({ members: 1, active: 1, downloads: 1 });
    expect(db).toMatchObject({ members: 1, activeToday: 1, openedToday: 0, quietThisWeek: 0 });
  });
});

describe('group members and reminders', () => {
  it('lists reading per person', async () => {
    const inv = await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.a, people: [{ email: 'sven@bidder-a.example', givenName: 'Sven', familyName: 'Lund' }] });
    expect(inv.statusCode).toBe(201);
    const body = (await call('GET', `${W()}/activity/groups/${h.group.a}/people`, h.person.anika)).json();
    expect(body).toMatchObject({ group: { name: 'Bidder A' }, docsVisible: 2 });
    expect(body.people.map((p: any) => [p.name, p.status])).toEqual([['Jan de Vries', 'active'], ['Sven Lund', 'invited']]);
    expect(body.people[0]).toMatchObject({ docsRead: 1, pagesRead: 11, downloads: 1, minutes: 29, lastSeenAt: '2026-11-11T09:20:00.000Z' });
    expect(body.people[1]).toMatchObject({ invitedAt: T.at.toISOString(), lastSeenAt: null });
  });

  it('shows legacy subgroup leads as members', async () => {
    await h.pg.query(`update membership set role = 'lead' where person_id = $1 and group_id = $2`, [h.person.lars, h.group.aFin]);
    const body = (await call('GET', `${W()}/activity/groups/${h.group.aFin}/people`, h.person.anika)).json();
    expect(body.people.map((p: any) => [p.name, p.lead])).toEqual([['Lars Eriksen', false]]);
  });

  it('404s for a group outside the room', async () => {
    expect((await call('GET', `${W()}/activity/groups/${h.group.admins}/people`, h.person.anika)).statusCode).toBe(404);
    expect((await call('GET', `${W()}/activity/groups/${board}/people`, h.person.anika)).statusCode).toBe(404);
    expect((await call('GET', `${W()}/activity/groups/00000000-0000-4000-8000-000000000001/people`, h.person.anika)).statusCode).toBe(404);
  });

  it('flags members without NDA', async () => {
    await h.pg.query(`delete from acceptance where person_id = $1`, [h.person.mei]);
    const body = (await call('GET', `${W()}/activity/groups/${h.group.b}/people`, h.person.anika)).json();
    expect(body.people[0]).toMatchObject({ name: 'Mei Tanaka', status: 'nda' });
  });

  it('counts invited people as members', async () => {
    await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.a, people: [{ email: 'sven@bidder-a.example', givenName: 'Sven', familyName: 'Lund' }] });
    const s = (await call('GET', `${W()}/activity/summary`, h.person.anika)).json();
    expect(s.groups.find((g: any) => g.id === h.group.a)).toMatchObject({ active: 1, members: 2 });
  });

  it('sends a fresh invite link', async () => {
    await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.a, people: [{ email: 'sven@bidder-a.example', givenName: 'Sven', familyName: 'Lund' }] });
    const first = /\/invite\/(\S+)/.exec(outbox[0]!.text!)![1];
    const sven = (await call('GET', `${W()}/activity/groups/${h.group.a}/people`, h.person.anika)).json().people.find((p: any) => p.name === 'Sven Lund');
    outbox = [];
    clock = new Date(T.at.getTime() + 60_000);
    const res = await call('POST', `${W()}/memberships/${sven.membershipId}/remind`, h.person.anika);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ sentTo: 'sven@bidder-a.example', reason: 'invitation' });
    expect(outbox).toHaveLength(1);
    const token = /\/invite\/(\S+)/.exec(outbox[0]!.text!)![1];
    expect((await app.inject({ method: 'GET', url: `/v1/public/invitations/${token}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/v1/public/invitations/${first}` })).statusCode).toBe(410);
    const actions = (await h.pg.query<{ action: string }>(`select action from event where workspace_id = $1 order by seq desc limit 2`, [h.ws])).rows.map((r) => r.action);
    expect(actions).toEqual(['invitation.sent', 'invitation.reminded']);
    const jan = (await call('GET', `${W()}/activity/groups/${h.group.a}/people`, h.person.anika)).json().people.find((p: any) => p.name === 'Jan de Vries');
    expect((await call('POST', `${W()}/memberships/${jan.membershipId}/remind`, h.person.anika)).statusCode).toBe(409);
    expect((await call('POST', `${W()}/memberships/${sven.membershipId}/remind`, h.person.jan)).statusCode).toBe(403);
    expect((await call('POST', `${W()}/memberships/${sven.membershipId}/remind`, thandi)).statusCode).toBe(403);
    // one per hour
    clock = new Date(T.at.getTime() + 30 * 60_000);
    const again = await call('POST', `${W()}/memberships/${sven.membershipId}/remind`, h.person.anika);
    expect(again.statusCode).toBe(429);
    expect(again.json().detail).toBe('A reminder went to Sven Lund less than an hour ago. Try again later.');
    clock = new Date(T.at.getTime() + 62 * 60_000);
    expect((await call('POST', `${W()}/memberships/${sven.membershipId}/remind`, h.person.anika)).statusCode).toBe(200);
  });

  it('reminds members to accept the NDA', async () => {
    await h.pg.query(`delete from acceptance where person_id = $1`, [h.person.mei]);
    const mei = (await call('GET', `${W()}/activity/groups/${h.group.b}/people`, h.person.anika)).json().people.find((p: any) => p.name === 'Mei Tanaka');
    expect(mei.status).toBe('nda');
    outbox = [];
    const res = await call('POST', `${W()}/memberships/${mei.membershipId}/remind`, h.person.anika);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ reason: 'nda', expiresAt: null });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.subject).toBe('Reminder: accept the NDA for Project Heron');
    expect(outbox[0]!.text!).toContain(`https://dataroom.example/rooms/${h.ws}`);
    const rows = (await h.pg.query<{ action: string; data: any }>(`select action, data from event where workspace_id = $1 order by seq desc limit 2`, [h.ws])).rows;
    expect(rows.map((r) => r.action)).toEqual(['notification.sent', 'invitation.reminded']);
    expect(rows[1]!.data).toMatchObject({ person_id: h.person.mei, reason: 'nda' });
    expect((await log(thandi)).items.map((e: any) => e.action)).not.toContain('invitation.reminded');
  });
});
