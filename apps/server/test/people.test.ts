// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { effectiveAccess, type Channel, type OutgoingMessage } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';


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

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const call = (method: Method, url: string, person: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1 }, ...(payload !== undefined ? { payload } : {}) });
const W = () => `/v1/workspaces/${h.ws}`;
const tokenFrom = (m: OutgoingMessage) => /\/invite\/(\S+)/.exec(m.text!)![1]!;
const invitationFor = (token: string) => app.inject({ method: 'GET', url: `/v1/public/invitations/${token}` });
const people = async () => (await call('GET', `${W()}/people`, h.person.anika)).json();
const groupOf = async (id: string) => (await people()).parties.flatMap((p: any) => p.groups).find((g: any) => g.id === id);
const level = (person: string, node: string) => h.app((tx) => effectiveAccess(tx, person, node, { at: clock })).then((a) => a.level);
const actions = async () => (await h.pg.query<{ action: string }>(`select action from event where workspace_id = $1 order by seq`, [h.ws])).rows.map((r) => r.action);
const membershipOf = async (person: string, group: string) => (await h.pg.query<{ id: string }>(
  `select id from membership where person_id = $1 and group_id = $2 and superseded_at = 'infinity' order by valid_from desc limit 1`, [person, group])).rows[0]!.id;
const invite = (body: Record<string, unknown>) => call('POST', `${W()}/invitations`, h.person.anika, body);

describe('people list', () => {
  it('lists groups and people', async () => {
    await h.pg.query(`update groups set organisation = 'Orrinby Capital', valid_to = '2027-01-29T21:59:00Z' where id = $1`, [h.group.a]);
    await h.pg.query(`insert into workspace_visit (tenant_id, workspace_id, person_id, last_visit_at) values ($1, $2, $3, $4)`,
      [h.t1, h.ws, h.person.jan, '2026-11-11T09:00:00Z']);
    await invite({ groupId: h.group.a, people: [{ email: 'chris@bidder-a.example' }] });
    const a = await groupOf(h.group.a);
    expect(a).toMatchObject({ organisation: 'Orrinby Capital', accessEndsAt: '2027-01-29T21:59:00.000Z', revoked: false, revokedAt: null });
    const jan = a.members.find((m: any) => m.personId === h.person.jan);
    expect(jan).toMatchObject({ status: 'active', ndaAccepted: true, lastSignedInAt: '2026-11-11T09:00:00.000Z', siteAdmin: false });
    const chris = a.members.find((m: any) => m.email === 'chris@bidder-a.example');
    expect(chris).toMatchObject({ status: 'invited', ndaAccepted: false, lastSignedInAt: null, invitedAt: T.at.toISOString(),
      accessEndsAt: '2027-01-29T21:59:00.000Z' });
    const team = await groupOf(h.group.contributors);
    expect(team.members[0]).toMatchObject({ ndaAccepted: null });
    expect(team).toMatchObject({ uploadFolders: ['3 Finance'], publishFolders: [] });
  });

  it('should require room admin', async () => {
    for (const p of [h.person.jan, h.person.maria, h.person.lars]) expect((await call('GET', `${W()}/people`, p)).statusCode).toBe(403);
    const outsider = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Eve', 'eve@x.example') returning id`, [h.t1])).rows[0]!.id;
    const missing = await call('GET', `/v1/workspaces/00000000-0000-4000-8000-000000000000/people`, h.person.anika);
    const refused = await call('GET', `${W()}/people`, outsider);
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toEqual(missing.json());
  });
});

describe('create group', () => {
  it('creates a bidder group with access', async () => {
    const res = await call('POST', `${W()}/groups`, h.person.anika, {
      name: 'Bidder E', newParty: { name: 'Brivenhall Capital', kind: 'bidder' }, organisation: 'Brivenhall Capital', accessEndsAt: '2027-01-29T21:59:00Z',
      access: [{ nodeId: h.node.fin, level: 50 }, { nodeId: h.node.it, level: 0 }] });
    expect(res.statusCode).toBe(201);
    const id = res.json().id;
    expect(await groupOf(id)).toMatchObject({ name: 'Bidder E', organisation: 'Brivenhall Capital', accessEndsAt: '2027-01-29T21:59:00.000Z' });
    const ev = (await h.pg.query<any>(`select data from event where action = 'group.created' and resource_id = $1`, [id])).rows[0].data;
    expect(ev.access).toEqual([{ node_id: h.node.fin, level: 50, can_upload: false, can_publish: false }]);
    await invite({ groupId: id, people: [{ email: 'ola@atlas.example' }] });
    await app.inject({ method: 'POST', url: '/v1/public/invitations/accept', payload: { token: tokenFrom(outbox[0]!), givenName: 'Ola', familyName: 'Berg', company: 'Brivenhall Capital' } });
    const ola = (await h.pg.query<{ id: string }>(`select id from person where email = 'ola@atlas.example'`)).rows[0]!.id;
    await h.pg.query(`insert into acceptance (tenant_id, agreement_version_id, person_id) values ($1, $2, $3)`, [h.t1, h.nda.v1, ola]);
    expect(await level(ola, h.node.fin)).toBe(50);
    expect(await level(ola, h.node.it)).toBe(0);
  });

  it('allows upload and publish for seller groups only', async () => {
    const seller = await call('POST', `${W()}/groups`, h.person.anika, { name: 'Heron tax', partyId: h.party.seller, organisation: 'Drosvelt Holdings',
      access: [{ nodeId: h.node.fin, level: 20, canUpload: true, canPublish: true }] });
    expect(seller.statusCode).toBe(201);
    expect(await groupOf(seller.json().id)).toMatchObject({ uploadFolders: ['3 Finance'], publishFolders: ['3 Finance'] });
    const bidder = await call('POST', `${W()}/groups`, h.person.anika, { name: 'Bidder F', newParty: { name: 'F', kind: 'bidder' },
      access: [{ nodeId: h.node.fin, level: 20, canUpload: true }] });
    expect(bidder.statusCode).toBe(400);
  });

  it('caps a subgroup by its parent', async () => {
    await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.b, level: 20 }] });
    await h.pg.query(`update groups set valid_to = '2027-01-29T21:59:00Z' where id = $1`, [h.group.b]);
    const over = await call('POST', `${W()}/groups`, h.person.anika, { name: 'Bidder B financiers', parentGroupId: h.group.b,
      access: [{ nodeId: h.node.fin, level: 50 }] });
    expect(over.statusCode).toBe(400);
    const ok = await call('POST', `${W()}/groups`, h.person.anika, { name: 'Bidder B financiers', parentGroupId: h.group.b,
      accessEndsAt: '2027-06-30T21:59:00Z', access: [{ nodeId: h.node.fin, level: 20 }] });
    expect(ok.statusCode).toBe(201);
    expect((await groupOf(ok.json().id)).accessEndsAt).toBe('2027-01-29T21:59:00.000Z');
  });

  it('accepts only top-level folders of the room', async () => {
    const sub = await call('POST', `${W()}/groups`, h.person.anika, { name: 'X', partyId: h.party.seller, access: [{ nodeId: h.node.aud, level: 20 }] });
    expect(sub.statusCode).toBe(400);
    const jan = await call('POST', `${W()}/groups`, h.person.jan, { name: 'Bidder X', newParty: { name: 'X', kind: 'bidder' } });
    expect(jan.statusCode).toBe(403);
  });
});

describe('edit group', () => {
  it('moves the end date for group and members', async () => {
    await h.pg.query(`update groups set valid_to = '2026-11-27T21:59:00Z' where id = any($1::uuid[])`, [[h.group.a, h.group.aFin]]);
    await invite({ groupId: h.group.a, people: [{ email: 'chris@bidder-a.example' }] });
    await invite({ groupId: h.group.a, accessExpiresAt: '2026-11-20T21:59:00Z', people: [{ email: 'own@bidder-a.example' }] });
    const res = await call('PATCH', `${W()}/groups/${h.group.a}`, h.person.anika, { name: 'Bidder A', organisation: 'Orrinby Capital', accessEndsAt: '2027-01-29T21:59:00Z' });
    expect(res.statusCode).toBe(200);
    expect(res.json().membershipsChanged).toBe(1);
    const a = await groupOf(h.group.a);
    expect(a).toMatchObject({ organisation: 'Orrinby Capital', accessEndsAt: '2027-01-29T21:59:00.000Z' });
    expect((await groupOf(h.group.aFin)).accessEndsAt).toBe('2027-01-29T21:59:00.000Z');
    expect(a.members.find((m: any) => m.email === 'chris@bidder-a.example').accessEndsAt).toBe('2027-01-29T21:59:00.000Z');
    expect(a.members.find((m: any) => m.email === 'own@bidder-a.example').accessEndsAt).toBe('2026-11-20T21:59:00.000Z');
    const hist = (await h.pg.query(`select 1 from membership m join person p on p.id = m.person_id where p.email = 'chris@bidder-a.example'`)).rows;
    expect(hist.length).toBe(2);
    const ev = (await h.pg.query<any>(`select data from event where action = 'group.details_changed'`)).rows[0].data;
    expect(ev).toMatchObject({ fields: ['organisation', 'accessEndsAt'], before: { accessEndsAt: '2026-11-27T21:59:00.000Z' } });
    clock = new Date('2026-12-01T08:00:00Z');
    await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.a, level: 20 }] });
    expect(await level(h.person.jan, h.node.fin)).toBe(20);
  });

  it('keeps an earlier subgroup end date', async () => {
    await h.pg.query(`update groups set valid_to = '2027-01-29T21:59:00Z' where id = $1`, [h.group.a]);
    await h.pg.query(`update groups set valid_to = '2026-12-01T21:59:00Z' where id = $1`, [h.group.aFin]);
    const lars = await membershipOf(h.person.lars, h.group.aFin);
    await h.pg.query(`update membership set valid_to = '2026-12-01T21:59:00Z' where id = $1`, [lars]);
    expect((await call('PATCH', `${W()}/groups/${h.group.a}`, h.person.anika, { accessEndsAt: '2027-06-30T21:59:00Z' })).statusCode).toBe(200);
    expect((await groupOf(h.group.aFin)).accessEndsAt).toBe('2026-12-01T21:59:00.000Z');
    expect((await call('PATCH', `${W()}/groups/${h.group.a}`, h.person.anika, { accessEndsAt: null })).statusCode).toBe(200);
    expect((await groupOf(h.group.aFin)).accessEndsAt).toBe('2026-12-01T21:59:00.000Z');
    expect((await groupOf(h.group.aFin)).members.find((m: any) => m.personId === h.person.lars).accessEndsAt).toBe('2026-12-01T21:59:00.000Z');
    clock = new Date('2026-12-02T08:00:00Z');
    expect(await level(h.person.lars, h.node.fin)).toBe(0);
  });

  it('shortens a subgroup with its parent', async () => {
    await h.pg.query(`update groups set valid_to = '2027-01-29T21:59:00Z' where id = $1`, [h.group.a]);
    await h.pg.query(`update groups set valid_to = '2026-12-31T21:59:00Z' where id = $1`, [h.group.aFin]);
    const lars = await membershipOf(h.person.lars, h.group.aFin);
    await h.pg.query(`update membership set valid_to = '2026-12-31T21:59:00Z' where id = $1`, [lars]);
    const res = await call('PATCH', `${W()}/groups/${h.group.a}`, h.person.anika, { accessEndsAt: '2026-12-10T21:59:00Z' });
    expect(res.statusCode).toBe(200);
    const fin = await groupOf(h.group.aFin);
    expect(fin.accessEndsAt).toBe('2026-12-10T21:59:00.000Z');
    expect(fin.members.find((m: any) => m.personId === h.person.lars).accessEndsAt).toBe('2026-12-10T21:59:00.000Z');
  });

  it('rejects invalid end dates', async () => {
    await h.pg.query(`update groups set valid_to = '2027-01-29T21:59:00Z' where id = $1`, [h.group.a]);
    expect((await call('PATCH', `${W()}/groups/${h.group.a}`, h.person.anika, { accessEndsAt: '2026-11-01T00:00:00Z' })).statusCode).toBe(400);
    expect((await call('PATCH', `${W()}/groups/${h.group.aFin}`, h.person.anika, { accessEndsAt: '2027-06-30T21:59:00Z' })).statusCode).toBe(400);
    expect((await call('PATCH', `${W()}/groups/${h.group.admins}`, h.person.anika, { accessEndsAt: '2027-01-29T21:59:00Z' })).statusCode).toBe(400);
    expect((await call('PATCH', `${W()}/groups/${h.group.a}`, h.person.jan, { name: 'Mine' })).statusCode).toBe(403);
  });
});

describe('revoke group', () => {
  it('records the revoke and kills open links', async () => {
    await invite({ groupId: h.group.b, people: [{ email: 'tom@bidder-b.example' }] });
    const token = tokenFrom(outbox[0]!);
    expect((await invitationFor(token)).statusCode).toBe(200);
    clock = new Date(T.at.getTime() + 60_000);
    const res = await call('POST', `${W()}/groups/${h.group.b}/revoke`, h.person.anika, { reason: 'withdrew from the process' });
    expect(res.statusCode).toBe(200);
    const b = await groupOf(h.group.b);
    expect(b).toMatchObject({ revoked: true, revokedBy: 'Anika Pillay', revokedReason: 'withdrew from the process', accessEndsAt: null });
    expect(b.revokedAt).toBe(clock.toISOString());
    expect((await invitationFor(token)).statusCode).toBe(410);
    expect(await level(h.person.mei, h.node.fin)).toBe(0);
  });
});

describe('invite', () => {
  it('invites members and leads together', async () => {
    const res = await invite({ groupId: h.group.a, people: [{ email: 'm@bidder-a.example' }, { email: 'l@bidder-a.example', role: 'lead' }] });
    expect(res.statusCode).toBe(201);
    const a = await groupOf(h.group.a);
    expect(a.members.find((m: any) => m.email === 'l@bidder-a.example').role).toBe('lead');
    expect(a.members.find((m: any) => m.email === 'm@bidder-a.example').role).toBe('member');
    expect(outbox[1]!.text!).toContain('You are invited as a lead for Bidder A.');
    expect(outbox[0]!.text!).not.toContain('as a lead');
    expect((await actions()).filter((x) => x === 'invitation.sent')).toHaveLength(2);
  });

  it('keeps everyone on one side of the room', async () => {
    const bothSides = 'Nobody can be on both sides of a room.';
    const toBidders = await invite({ groupId: h.group.a, people: [{ email: 'maria@drosvelt.example' }] });
    expect(toBidders.statusCode).toBe(400);
    expect(toBidders.json().detail).toBe(`maria@drosvelt.example is on the seller side of this room, so they cannot join a bidder group. ${bothSides} Revoke their seller access first.`);
    const toSeller = await invite({ groupId: h.group.contributors, people: [{ email: 'jan@bidder-a.example' }] });
    expect(toSeller.statusCode).toBe(400);
    expect(toSeller.json().detail).toBe(`jan@bidder-a.example is in a bidder group of this room, so they cannot join the seller side. ${bothSides} Revoke their bidder access first.`);

    // an open invitation counts
    expect((await invite({ groupId: h.group.a, people: [{ email: 'new@x.example' }] })).statusCode).toBe(201);
    expect((await invite({ groupId: h.group.contributors, people: [{ email: 'new@x.example' }] })).statusCode).toBe(400);
    // a second bidder group is the same side
    expect((await invite({ groupId: h.group.b, people: [{ email: 'new@x.example' }] })).statusCode).toBe(201);

    // after the revoke, the other side is open
    const jan = (await h.pg.query<{ id: string }>(
      `select id from membership where person_id = $1 and superseded_at = 'infinity' order by recorded_at desc limit 1`, [h.person.jan])).rows[0]!.id;
    expect((await call('POST', `${W()}/memberships/${jan}/revoke`, h.person.anika, {})).statusCode).toBe(200);
    expect((await invite({ groupId: h.group.contributors, people: [{ email: 'jan@bidder-a.example' }] })).statusCode).toBe(201);
    const revoked = (await h.pg.query<{ id: string }>(
      `select m.id from membership m where m.person_id = $1 and m.group_id = $2 and m.superseded_at = 'infinity' order by m.recorded_at desc limit 1`,
      [h.person.jan, h.group.a])).rows[0]!.id;
    const back = await call('POST', `${W()}/memberships/${revoked}/restore`, h.person.anika, {});
    expect(back.statusCode).toBe(400);
    expect(back.json().detail).toContain(bothSides);
  });

  it('asks to drop personal rights before joining a bidder group', async () => {
    // personal publish right
    expect((await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.fin, personId: h.person.maria, level: 20, canPublish: true }] })).statusCode).toBe(200);
    const maria = (await h.pg.query<{ id: string }>(
      `select id from membership where person_id = $1 and superseded_at = 'infinity' order by recorded_at desc limit 1`, [h.person.maria])).rows[0]!.id;
    expect((await call('POST', `${W()}/memberships/${maria}/revoke`, h.person.anika, {})).statusCode).toBe(200);
    const res = await invite({ groupId: h.group.a, people: [{ email: 'maria@drosvelt.example' }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toBe('maria@drosvelt.example may still add files or publish in this room, set for them by name in Permissions. Take that away before they join a bidder group.');
  });
});

describe('remind', () => {
  it('sends a new link and kills the old one', async () => {
    await invite({ groupId: h.group.a, people: [{ email: 'chris@bidder-a.example' }] });
    const old = tokenFrom(outbox[0]!);
    const m = (await groupOf(h.group.a)).members.find((x: any) => x.email === 'chris@bidder-a.example');
    const res = await call('POST', `${W()}/memberships/${m.membershipId}/remind`, h.person.anika);
    expect(res.json()).toMatchObject({ reason: 'invitation', sentTo: 'chris@bidder-a.example', delivery: 'accepted' });
    expect(outbox).toHaveLength(2);
    expect((await invitationFor(old)).statusCode).toBe(410);
    expect((await invitationFor(tokenFrom(outbox[1]!))).statusCode).toBe(200);
    expect(await actions()).toContain('invitation.reminded');
  });

  it('renews an expired link', async () => {
    await invite({ groupId: h.group.a, people: [{ email: 'chris@bidder-a.example' }] });
    clock = new Date(T.at.getTime() + 15 * 86_400_000);
    const m = (await groupOf(h.group.a)).members.find((x: any) => x.email === 'chris@bidder-a.example');
    expect(m.status).toBe('link_expired');
    await call('POST', `${W()}/memberships/${m.membershipId}/remind`, h.person.anika);
    expect((await groupOf(h.group.a)).members.find((x: any) => x.email === 'chris@bidder-a.example').status).toBe('invited');
  });

  it('reminds about the NDA', async () => {
    await h.pg.query(`delete from acceptance where person_id = $1`, [h.person.mei]);
    const res = await call('POST', `${W()}/memberships/${await membershipOf(h.person.mei, h.group.b)}/remind`, h.person.anika);
    expect(res.json()).toEqual({ reason: 'nda', sentTo: 'mei@bidder-b.example', expiresAt: null, delivery: 'accepted' });
    expect(outbox[0]).toMatchObject({ to: 'mei@bidder-b.example', subject: 'Reminder: accept the NDA for Project Heron' });
    expect(await actions()).toContain('invitation.reminded');
    expect((await call('POST', `${W()}/memberships/${await membershipOf(h.person.jan, h.group.a)}/remind`, h.person.anika)).statusCode).toBe(409);
    expect((await call('POST', `${W()}/memberships/${await membershipOf(h.person.mei, h.group.b)}/remind`, h.person.jan)).statusCode).toBe(403);
  });

  it('limits to one per hour, no NDA reminder for sellers', async () => {
    await invite({ groupId: h.group.a, people: [{ email: 'chris@bidder-a.example' }] });
    const m = (await groupOf(h.group.a)).members.find((x: any) => x.email === 'chris@bidder-a.example');
    expect((await call('POST', `${W()}/memberships/${m.membershipId}/remind`, h.person.anika)).statusCode).toBe(200);
    const again = await call('POST', `${W()}/memberships/${m.membershipId}/remind`, h.person.anika);
    expect(again.statusCode).toBe(429);
    expect(outbox).toHaveLength(2);
    clock = new Date(T.at.getTime() + 61 * 60_000);
    expect((await call('POST', `${W()}/memberships/${m.membershipId}/remind`, h.person.anika)).statusCode).toBe(200);

    await h.pg.query(`delete from acceptance where person_id = $1`, [h.person.maria]);
    expect((await call('POST', `${W()}/memberships/${await membershipOf(h.person.maria, h.group.contributors)}/remind`, h.person.anika)).statusCode).toBe(409);
  });
});

describe('edit person', () => {
  it('updates name, company and role', async () => {
    const res = await call('PATCH', `${W()}/people/${h.person.jan}`, h.person.anika, { givenName: 'Jan', familyName: 'de Vries', company: 'Orrinby Capital', jobTitle: 'Partner' });
    expect(res.json()).toMatchObject({ name: 'Jan de Vries', company: 'Orrinby Capital', jobTitle: 'Partner' });
    const ev = (await call('GET', `${W()}/events?action=person.details_changed`, h.person.anika)).json().items[0];
    expect(ev.personal).toEqual({ before: { company: null, jobTitle: null }, after: { company: 'Orrinby Capital', jobTitle: 'Partner' } });
  });

  it('edits invited people too', async () => {
    await invite({ groupId: h.group.a, people: [{ email: 'chris@bidder-a.example' }] });
    const id = (await groupOf(h.group.a)).members.find((x: any) => x.email === 'chris@bidder-a.example').personId;
    const res = await call('PATCH', `${W()}/people/${id}`, h.person.anika, { givenName: 'Chris', familyName: 'Adams' });
    expect(res.json().name).toBe('Chris Adams');
    expect(await actions()).toContain('person.details_changed');
  });

  it('refuses outsiders and site admins', async () => {
    const outsider = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Eve', 'eve@x.example') returning id`, [h.t1])).rows[0]!.id;
    expect((await call('PATCH', `${W()}/people/${outsider}`, h.person.anika, { givenName: 'Evil' })).statusCode).toBe(404);
    await h.pg.query(`update person set is_site_admin = true where id = $1`, [h.person.jan]);
    expect((await call('PATCH', `${W()}/people/${h.person.jan}`, h.person.anika, { givenName: 'X' })).statusCode).toBe(403);
    expect((await call('PATCH', `${W()}/people/${h.person.mei}`, h.person.jan, { givenName: 'X' })).statusCode).toBe(403);
  });
});

describe('colleague request decisions', () => {
  beforeEach(async () => { await h.pg.query(`update membership set role = 'lead' where person_id = $1`, [h.person.jan]); });
  const ask = async () => {
    const res = await call('POST', `${W()}/team-requests`, h.person.jan,
      { givenName: 'Peter', familyName: 'Moss', email: 'peter.moss@thornquist-legal.example', company: 'Thornquist Legal', jobTitle: 'Tax adviser', reason: 'Tax due diligence' });
    outbox.splice(0, outbox.length);
    return res;
  };

  it('emails room admins the request', async () => {
    const res = await call('POST', `${W()}/team-requests`, h.person.jan,
      { givenName: 'Peter', familyName: 'Moss', email: 'peter.moss@thornquist-legal.example', company: 'Thornquist Legal', jobTitle: 'Tax adviser', reason: 'Tax due diligence' });
    expect(res.statusCode).toBe(201);
    expect(outbox.map((m) => m.to)).toEqual(['anika@quillmont.example']);
    const m = outbox[0]!;
    expect(m.subject).toBe('Jan de Vries asks to add a colleague to Bidder A');
    expect(m.fromName).toBe('Project Heron data room');
    expect(m.text).toContain('Name: Peter Moss');
    expect(m.text).toContain('Email: peter.moss@thornquist-legal.example');
    expect(m.text).toContain('Company: Thornquist Legal');
    expect(m.text).toContain('Role: Tax adviser');
    expect(m.text).toContain('> Tax due diligence');
    expect(m.text).toContain(`Review the request: https://dataroom.example/rooms/${h.ws}/people\n`);
    expect(m.text).toContain('You get this email because you are a room admin of Project Heron.');
    // no approve link in the email
    expect(m.html).not.toMatch(/decide|approve/i);
    expect(await actions()).toContain('team_request.admin_told');

    await call('PUT', `${W()}/me/notifications`, h.person.anika, { events: { requests: { enabled: false } } });
    outbox.splice(0, outbox.length);
    const asked = await call('POST', `${W()}/team-requests`, h.person.jan,
      { givenName: 'Ann', familyName: 'Lee', email: 'ann@thornquist-legal.example', company: 'Thornquist Legal', reason: 'Tax' });
    expect(asked.statusCode, asked.body).toBe(201);
    expect(outbox).toHaveLength(0);
  });

  it('notifies on approve', async () => {
    const id = (await ask()).json().id;
    await call('POST', `${W()}/team-requests/${id}/decide`, h.person.anika, { decision: 'approve' });
    expect(outbox.map((m) => m.to).sort()).toEqual(['jan@bidder-a.example', 'peter.moss@thornquist-legal.example']);
    expect(outbox.find((m) => m.to === 'jan@bidder-a.example')!.subject).toBe('Peter Moss is invited to Bidder A');
    expect(await actions()).toContain('team_request.lead_told');
  });

  it('sends the decline reason to the lead', async () => {
    const id = (await ask()).json().id;
    await call('POST', `${W()}/team-requests/${id}/decide`, h.person.anika, { decision: 'decline', note: 'Once 3.4 Tax is open to bidders.' });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.text).toContain('Reason from the room admin: Once 3.4 Tax is open to bidders.');
  });

  it('tells nobody when the lead lost access', async () => {
    const first = (await ask()).json().id;
    await h.pg.query(`update person set disabled_at = now() where id = $1`, [h.person.jan]);
    expect((await call('POST', `${W()}/team-requests/${first}/decide`, h.person.anika, { decision: 'decline', note: 'No.' })).statusCode).toBe(200);
    expect(outbox).toHaveLength(0);
    await h.pg.query(`update person set disabled_at = null where id = $1`, [h.person.jan]);
    const second = (await call('POST', `${W()}/team-requests`, h.person.jan,
      { givenName: 'Ann', familyName: 'Lee', email: 'ann@thornquist-legal.example', company: 'Thornquist Legal', reason: 'Tax' })).json().id;
    expect(second).toBeTypeOf('string');
    outbox.splice(0, outbox.length);
    expect((await call('POST', `${W()}/memberships/${await membershipOf(h.person.jan, h.group.a)}/revoke`, h.person.anika)).statusCode).toBe(200);
    expect((await call('POST', `${W()}/team-requests/${second}/decide`, h.person.anika, { decision: 'decline' })).statusCode).toBe(200);
    expect(outbox).toHaveLength(0);
    expect(await actions()).not.toContain('team_request.lead_told');
  });
});
