// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { effectiveAccess, type Channel, type OutgoingMessage } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';

const A2 = { givenName: 'Sven', familyName: 'Lund', company: 'Skjolvik Partners' };



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

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, person: string, payload?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1, ...extra }, ...(payload !== undefined ? { payload } : {}) });
const W = () => `/v1/workspaces/${h.ws}`;
const later = (m: number) => new Date(T.at.getTime() + m * 60_000);
const level = (p: string, n: string) => h.app((tx) => effectiveAccess(tx, p, n, { at: clock })).then((a) => a.level);
const grant = (nodeId: string, s: Record<string, string>, lvl: number) => call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId, ...s, level: lvl }] });
async function membershipOf(personId: string) {
  const people = (await call('GET', `${W()}/people`, h.person.anika)).json();
  return people.parties.flatMap((p: any) => p.groups).flatMap((g: any) => g.members).filter((m: any) => m.personId === personId);
}

describe('membership history', () => {
  it("doesn't restore a revoked member when the expiry changes", async () => {
    await grant(h.node.fin, { groupId: h.group.b }, 20);
    const [mei] = await membershipOf(h.person.mei);
    clock = later(10);
    await call('POST', `${W()}/memberships/${mei.membershipId}/revoke`, h.person.anika);
    clock = later(20);
    const res = await call('PATCH', `${W()}/memberships/${mei.membershipId}`, h.person.anika, { accessEndsAt: '2027-06-30T00:00:00Z' });
    expect(res.statusCode).toBe(400);
    expect(await level(h.person.mei, h.node.aud1)).toBe(0);
  });

  it('shows an accepted invitee once and revokes them', async () => {
    await grant(h.node.fin, { groupId: h.group.b }, 20);
    await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.b, people: [{ email: 'sven@bidder-b.example', name: 'Sven Lund' }] });
    const token = /\/invite\/(\S+)/.exec(outbox[0]!.text!)![1];
    clock = later(30);
    const sven = (await app.inject({ method: 'POST', url: '/v1/public/invitations/accept', payload: { token, ...A2 } })).json().personId;
    await h.pg.query(`insert into acceptance (tenant_id, agreement_version_id, person_id, accepted_at) values ($1, $2, $3, $4)`, [h.t1, h.nda.v1, sven, later(31).toISOString()]);
    clock = later(40);
    const rows = await membershipOf(sven);
    expect(rows.map((r: any) => r.status)).toEqual(['active']);
    expect(await level(sven, h.node.aud1)).toBe(20);
    clock = later(50);
    expect((await call('POST', `${W()}/memberships/${rows[0].membershipId}/revoke`, h.person.anika)).statusCode).toBe(200);
    expect(await level(sven, h.node.aud1)).toBe(0);
  });

  it('refuses an invitation whose access period ended', async () => {
    await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.b, people: [{ email: 'late@bidder-b.example', name: 'Late' }], accessExpiresAt: later(60).toISOString() });
    const token = /\/invite\/(\S+)/.exec(outbox[0]!.text!)![1];
    clock = later(120);
    expect((await app.inject({ method: 'POST', url: '/v1/public/invitations/accept', payload: { token, ...A2 } })).statusCode).toBe(410);
  });

  it('returns 400 for a malformed token', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/public/invitations/accept', payload: { token: `${'z'.repeat(36)}.${'x'.repeat(43)}`, ...A2 } });
    expect(res.statusCode).toBe(400);
  });
});

describe('milestones', () => {
  it('does not leak a new date to groups that lose sight of it', async () => {
    const id = (await call('POST', `${W()}/milestones`, h.person.anika, { title: 'Management presentations', dueAt: '2026-12-08T08:00:00Z' })).json().id;
    await h.pg.exec(`delete from notification_item; delete from notification;`);
    clock = later(5);
    await call('PATCH', `${W()}/milestones/${id}`, h.person.anika, { dueAt: '2026-12-09T08:00:00Z', visibleToGroupIds: [h.group.a] });
    const forMei = (await h.pg.query<{ data: any }>(
      `select e.data from notification n join notification_item i on i.notification_id = n.id join event e on e.id = i.event_id where n.person_id = $1`,
      [h.person.mei])).rows.map((r) => r.data);
    expect(forMei).toEqual([{ change: 'removed', title: 'Management presentations' }]);
  });
});

describe('release review', () => {
  it('lists people granted access by name', async () => {
    await grant(h.node.aud, { personId: h.person.mei }, 50);
    const items = (await call('POST', `${W()}/release-preview`, h.person.anika, {})).json().items;
    expect(items[0].people).toEqual([{ id: h.person.mei, name: 'Mei Tanaka', level: 50 }]);
  });
});

describe('member-only pages', () => {
  it('shows only the NDA until it is accepted', async () => {
    await h.pg.query(`insert into agreement_version (tenant_id, agreement_id, version_no, body, published_at) values ($1, $2, 2, 'Version 2 of the undertaking', $3)`,
      [h.t1, h.nda.agreement, later(-1).toISOString()]);
    const ms = await call('GET', `${W()}/milestones`, h.person.jan);
    expect([ms.statusCode, ms.json().reason]).toEqual([403, 'nda_not_accepted']);
    expect((await call('GET', `${W()}/dashboard`, h.person.jan)).statusCode).toBe(403);
    expect((await call('GET', `${W()}/nda`, h.person.jan)).statusCode).toBe(200);
  });

  it('caps an agent on the dashboard', async () => {
    await grant(h.node.fin, { groupId: h.group.a }, 60);
    const d = (await call('GET', `${W()}/dashboard`, h.person.jan, undefined, { 'x-dev-agent-max-level': '10' })).json();
    expect(d.myCoverage.total).toBe(0);
    expect(d.newSinceLastVisit.flatMap((f: any) => f.items).length).toBe(2);
  });
});

describe('documents', () => {
  it('refuses to move a folder into its own subfolder', async () => {
    const res = await call('PATCH', `${W()}/nodes/${h.node.fin}`, h.person.anika, { parentId: h.node.aud, confirmRenumberPublished: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toBe('A folder cannot be moved into itself or one of its own subfolders.');
  });
});
