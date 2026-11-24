// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { DevHeaderAuthenticator } from '../src/auth.js';
import { roomDay, seedDemo, seedDemoRooms, stableId, type DemoRoom, type MoreRooms } from '../src/demo/seed-demo.js';
import { freshDatabase, pinClock, type TestPg } from '../../../packages/core/test/fixture.js';


let pg: TestPg;
let app: FastifyInstance;
let room: DemoRoom;
let more: MoreRooms;
const clock = new Date('2026-11-14T10:00:00Z');

beforeAll(async () => {
  const { db, pg: p } = await freshDatabase();
  pg = p;
  const seeded = new Date('2026-11-13T18:00:00Z');
  await pinClock(pg, seeded);
  room = await seedDemo(db, { role: 'vdrkit_app', today: roomDay(seeded) });
  more = await seedDemoRooms(db, { role: 'vdrkit_app', today: roomDay(seeded) });
  await pinClock(pg, clock);
  app = await buildApp({ db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', rateLimit: false, now: () => clock });
}, 180_000);
afterAll(async () => { await app.close(); await pg.close(); });

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';
const call = (method: Method, url: string, person: string, payload?: unknown) => app.inject({
  method, url, headers: { 'x-dev-tenant': room.tenantId, 'x-dev-person': person }, ...(payload !== undefined ? { payload } : {}),
});
const myRooms = async (person: string) => {
  const res = await call('GET', '/v1/me/rooms', person);
  expect(res.statusCode).toBe(200);
  return res.json();
};
const card = (b: { rooms: { name: string }[] }, name: string) => b.rooms.find((r) => r.name === name) as any;

describe('GET /v1/me/rooms', () => {
  it('seeds the extra rooms once', async () => {
    expect(more.workspace.weaver).toBe(stableId(room.tenantId, 'workspace:weaver'));
    expect(more.skipped).toBe(false);
  });

  it('returns rooms for a room admin', async () => {
    const b = await myRooms(room.person.anika);
    expect(b).toMatchObject({ runBy: 'Quillmont Advisory', canCreateRooms: true, isSiteAdmin: true, openAtSignInWorkspaceId: room.workspaceId });
    expect(b.rooms.map((r: { name: string }) => r.name)).toEqual(['Project Heron', 'Project Osprey', 'Project Falcon']);
    expect(card(b, 'Project Heron')).toMatchObject({
      state: 'open', isAdmin: true, side: 'seller', sellerName: 'Drosvelt Holdings', canEnter: true, openAtSignIn: true,
      groups: [{ name: 'Room admins', role: 'admin', partyKind: 'seller', subgroup: false }],
      attention: { newDocuments: null, colleagueRequests: 0, draftsWaiting: 441, ndaToAccept: false },
      nextMilestone: { title: 'Q&A round 1 closes', dueAt: '2026-11-20T15:00:00.000Z' },
    });
    expect(card(b, 'Project Osprey')).toMatchObject({ state: 'preparing', canEnter: true, attention: { draftsWaiting: 12 }, lastVisitAt: '2026-11-13T14:05:00.000Z' });
    expect(card(b, 'Project Falcon')).toMatchObject({ state: 'frozen', nextMilestone: { title: 'Signing' } });
    expect(b.past).toEqual([expect.objectContaining({ name: 'Project Kingfisher', kind: 'closed', isAdmin: true, canOpen: true, endedAt: '2026-10-30T15:00:00.000Z' })]);
  });

  it('returns rooms for a bidder lead', async () => {
    const b = await myRooms(room.person.jan);
    expect(b).toMatchObject({ canCreateRooms: false, isSiteAdmin: false, openAtSignInWorkspaceId: null });
    expect(b.rooms.map((r: { name: string }) => r.name)).toEqual(['Project Weaver', 'Project Heron']);
    const heron = card(b, 'Project Heron');
    expect(heron).toMatchObject({ isAdmin: false, side: 'buyer', sellerName: null, groups: [{ name: 'Bidder A', role: 'lead', partyKind: 'bidder', subgroup: false }] });
    expect(heron.attention).toMatchObject({ colleagueRequests: 0, draftsWaiting: null, ndaToAccept: false });
    expect(heron.attention.newDocuments.count).toBeGreaterThan(0);
    expect(heron.nextMilestone.title).toBe('Q&A round 1 closes');
    const weaver = card(b, 'Project Weaver');
    expect(weaver).toMatchObject({ groups: [{ name: 'Bidder 2', role: 'member' }], sellerName: null,
      attention: { newDocuments: { count: 3, since: '2026-11-09T10:00:00.000Z' }, colleagueRequests: null, draftsWaiting: null },
      nextMilestone: { title: 'Management presentation' } });
    expect(weaver.nextMilestone.dueAt).toMatch(/T09:00:00\.000Z$/);
    expect(b.past).toEqual([{ id: more.workspace.marlin, name: 'Project Marlin', kind: 'access_ended', isAdmin: false, sellerName: null,
      logos: { light: false, dark: false },
      groups: [{ name: 'Bidder 1', role: 'member', partyKind: 'bidder', subgroup: false }], endedAt: '2026-10-01T00:00:00.000Z',
      lastVisitAt: '2026-09-30T13:00:00.000Z', canOpen: false }]);
    const text = JSON.stringify(b);
    expect(text).not.toMatch(/Bidder [BC]|Drosvelt Holdings|Weaver Textiles|Marlin Marine|Room admins/);
  });

  it('counts drafts for publishers only', async () => {
    const johan = card(await myRooms(room.person.johan), 'Project Heron');
    expect(johan).toMatchObject({ side: 'seller', sellerName: 'Drosvelt Holdings' });
    expect(johan.attention.draftsWaiting).toBeGreaterThan(0);
    expect(johan.attention.colleagueRequests).toBeNull();
    expect(card(await myRooms(room.person.maria), 'Project Heron').attention.draftsWaiting).toBeNull();
    const liesl = await myRooms(room.person.liesl);
    expect(card(liesl, 'Project Heron').attention).toMatchObject({ draftsWaiting: null, colleagueRequests: null });
    expect(liesl.rooms).toHaveLength(1);
  });

  it('shows financiers their subgroup', async () => {
    const lars = card(await myRooms(room.person.lars), 'Project Heron');
    expect(lars.groups).toEqual([{ name: 'Bidder C financiers', role: 'member', partyKind: 'bidder', subgroup: true }]);
    expect((await call('GET', '/v1/me/rooms', '00000000-0000-4000-8000-000000000000')).statusCode).toBe(403);
  });

  it('counts pending requests', async () => {
    const asked = await call('POST', `/v1/workspaces/${room.workspaceId}/team-requests`, room.person.jan,
      { givenName: 'Ruan', familyName: 'Venter', email: 'ruan@bidder-a.example.com', company: 'Orrinby Capital' });
    expect(asked.statusCode).toBe(201);
    expect(card(await myRooms(room.person.jan), 'Project Heron').attention.colleagueRequests).toBe(1);
    expect(card(await myRooms(room.person.anika), 'Project Heron').attention.colleagueRequests).toBe(1);
    expect(card(await myRooms(room.person.pieter), 'Project Heron').attention.colleagueRequests).toBeNull();
  });

  it('sets the sign-in room', async () => {
    const set = await call('PUT', '/v1/me/open-at-sign-in', room.person.jan, { workspaceId: more.workspace.weaver });
    expect(set.statusCode).toBe(200);
    let b = await myRooms(room.person.jan);
    expect(b.openAtSignInWorkspaceId).toBe(more.workspace.weaver);
    expect(card(b, 'Project Weaver').openAtSignIn).toBe(true);
    expect((await call('PUT', '/v1/me/open-at-sign-in', room.person.jan, { workspaceId: more.workspace.marlin })).statusCode).toBe(404);
    expect((await call('PUT', '/v1/me/open-at-sign-in', room.person.jan, { workspaceId: null })).statusCode).toBe(200);
    b = await myRooms(room.person.jan);
    expect(b.openAtSignInWorkspaceId).toBeNull();
  });

  it('handles preparing and closed rooms', async () => {
    const thandi = more.thandi;
    const signInPick = async () => {
      const w = await call('GET', '/v1/me/workspaces', room.person.jan);
      expect(w.statusCode).toBe(200);
      return w.json().openAtSignInWorkspaceId;
    };
    expect((await call('PUT', '/v1/me/open-at-sign-in', room.person.jan, { workspaceId: more.workspace.weaver })).statusCode).toBe(200);
    expect(await signInPick()).toBe(more.workspace.weaver);
    expect((await call('PATCH', `/v1/workspaces/${more.workspace.weaver}/settings`, thandi, { state: 'preparing' })).statusCode).toBe(200);
    const prepRooms = await myRooms(room.person.jan);
    const prep = card(prepRooms, 'Project Weaver');
    expect(prep).toMatchObject({ state: 'preparing', canEnter: false, nextMilestone: null, openAtSignIn: false,
      attention: { newDocuments: null, colleagueRequests: null, draftsWaiting: null, ndaToAccept: false } });
    // preparing again
    expect(prepRooms.openAtSignInWorkspaceId).toBeNull();
    expect(await signInPick()).toBeNull();
    // open again
    expect((await call('PATCH', `/v1/workspaces/${more.workspace.weaver}/settings`, thandi, { state: 'open' })).statusCode).toBe(200);
    expect(await signInPick()).toBe(more.workspace.weaver);
    expect(card(await myRooms(room.person.jan), 'Project Weaver').openAtSignIn).toBe(true);

    expect((await call('PATCH', `/v1/workspaces/${more.workspace.weaver}/settings`, thandi, { state: 'closed' })).statusCode).toBe(200);
    const b = await myRooms(room.person.jan);
    expect(b.rooms.map((r: { name: string }) => r.name)).toEqual(['Project Heron']);
    expect(b.past.map((p: { name: string; kind: string; canOpen: boolean }) => [p.name, p.kind, p.canOpen]))
      .toEqual([['Project Weaver', 'closed', false], ['Project Marlin', 'access_ended', false]]);
    expect(b.past[0].sellerName).toBeNull();
    // closed
    expect(b.openAtSignInWorkspaceId).toBeNull();
    expect(await signInPick()).toBeNull();
    // closing cleared the choice
    expect((await pg.query(`select 1 from person where open_at_sign_in_workspace_id = $1`, [more.workspace.weaver])).rows).toHaveLength(0);
    expect((await call('PATCH', `/v1/workspaces/${more.workspace.weaver}/settings`, thandi, { state: 'open' })).statusCode).toBe(200);
    expect(await signInPick()).toBeNull();
    const log = (await call('GET', `/v1/workspaces/${more.workspace.weaver}/events?action=workspace.open_at_sign_in_cleared`, thandi)).json().items;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: 'workspace.open_at_sign_in_cleared', data: { people: 1 } });
    expect((await call('PATCH', `/v1/workspaces/${more.workspace.weaver}/settings`, thandi, { state: 'closed' })).statusCode).toBe(200);
    expect((await call('GET', `/v1/workspaces/${more.workspace.weaver}/events?action=workspace.open_at_sign_in_cleared`, thandi)).json().items).toHaveLength(1);
  });

  it('keeps the seller name after access ends', async () => {
    await pg.query(`update membership set valid_to = '2026-11-01T00:00:00Z' where person_id = $1`, [room.person.johan]);
    const b = await myRooms(room.person.johan);
    expect(b.rooms).toEqual([]);
    expect(b.past).toEqual([expect.objectContaining({ name: 'Project Heron', kind: 'access_ended', sellerName: 'Drosvelt Holdings',
      canOpen: false, logos: { light: false, dark: false } })]);
  });

  it('refuses agents', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me/rooms',
      headers: { 'x-dev-tenant': room.tenantId, 'x-dev-person': room.person.jan, 'x-dev-agent-max-level': '20' } });
    expect(res.statusCode).toBe(403);
  });
});
