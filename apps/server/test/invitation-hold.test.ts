// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Channel, OutgoingMessage } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { MemoryQueue, sendWaitingInvitations, type WaitingInvitationsPayload, type WorkerContext } from '../src/worker/jobs.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';


const DAY = 86_400_000;
let h: Heron;
let app: FastifyInstance;
let outbox: OutgoingMessage[];
let now: Date;
let queue: MemoryQueue | null;
const mailer: Channel = { name: 'email', send: async (m) => { outbox.push(m); return { status: 'accepted', providerMessageId: `pm-${outbox.length}` }; } };
const PUBLIC = 'https://dataroom.example';

async function start(withQueue: boolean) {
  queue = withQueue ? new MemoryQueue() : null;
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => now, mailer, publicUrl: PUBLIC,
    ...(queue ? { queue } : {}) });
}

beforeEach(async () => {
  h = await heron();
  outbox = [];
  now = T.at;
  await h.pg.query(`update person set can_create_rooms = true where id = $1`, [h.person.anika]);
  await start(false);
});
afterEach(async () => { await app.close(); await h.pg.close(); });

type Method = 'GET' | 'POST' | 'PATCH';
const call = (method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-dev-person': h.person.anika, 'x-dev-tenant': h.t1 }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const W = () => `/v1/workspaces/${h.ws}`;
const setState = async (state: string) => {
  const res = await call('PATCH', `${W()}/settings`, { state });
  expect(res.statusCode).toBe(200);
  return res.json();
};
const inviteTo = async (groupId: string, ...emails: string[]) => {
  const res = await call('POST', `${W()}/invitations`, { groupId, people: emails.map((email) => ({ email })) });
  expect(res.statusCode).toBe(201);
  return res.json().invitations as { id: string; email: string; personId: string; waits: boolean }[];
};
const events = async (action: string) =>
  (await h.pg.query<{ resource_id: string; data: any }>(`select resource_id, data from event where workspace_id = $1 and action = $2 order by seq`, [h.ws, action])).rows;
const member = async (email: string) => {
  const people = (await call('GET', `${W()}/people`)).json();
  for (const p of people.parties) for (const g of p.groups) for (const m of g.members) if (m.email === email) return m;
  throw new Error(`${email} is not listed`);
};
const tokenIn = (m: OutgoingMessage) => /\/invite\/([^\s"<]+)/.exec(m.text ?? '')![1]!;
const worker = () => ({ db: h.db, dbRole: 'vdrkit_app', mailer, now: () => now, publicUrl: 'https://worker.example' }) as unknown as WorkerContext;

describe('while the room is preparing', () => {
  beforeEach(async () => { await setState('preparing'); });

  it('holds bidder invitations', async () => {
    const [inv] = await inviteTo(h.group.b, 'kofi@bidder-b.example');
    expect(inv!.waits).toBe(true);
    expect(outbox).toHaveLength(0);
    expect((await events('invitation.created'))[0]!.data).toMatchObject({ waits_for_room: true });
    expect(await events('invitation.held')).toEqual([expect.objectContaining({ resource_id: inv!.id, data: expect.objectContaining({ room_state: 'preparing' }) })]);
    expect(await events('invitation.sent')).toEqual([]);
    expect(await events('invitation.not_sent')).toEqual([]);
    expect(await member('kofi@bidder-b.example')).toMatchObject({ status: 'invited', invitationWaits: true, invitedAt: null });
    expect((await call('GET', `${W()}/settings`)).json().waitingInvitations).toBe(1);
  });

  it('sends seller-side invitations at once', async () => {
    const [inv] = await inviteTo(h.group.contributors, 'thandi@drosvelt.example');
    expect(inv!.waits).toBe(false);
    expect(outbox.map((m) => m.to)).toEqual(['thandi@drosvelt.example']);
    expect(await events('invitation.sent')).toHaveLength(1);
    expect(await events('invitation.held')).toEqual([]);
    expect(await member('thandi@drosvelt.example')).toMatchObject({ invitationWaits: false, invitedAt: T.at.toISOString() });
    expect((await call('GET', `${W()}/settings`)).json().waitingInvitations).toBe(0);
  });

  it('invites extra room admins at once', async () => {
    const res = await call('POST', '/v1/workspaces', { name: 'Project Osprey', timeZone: 'Africa/Johannesburg', start: 'empty', admins: [{ email: 'co@adviser.example' }] });
    expect(res.statusCode).toBe(201);
    expect(outbox.map((m) => m.to)).toEqual(['co@adviser.example']);
  });

  it('refuses Remind for a held invitation', async () => {
    await inviteTo(h.group.b, 'kofi@bidder-b.example');
    const m = await member('kofi@bidder-b.example');
    const res = await call('POST', `${W()}/memberships/${m.membershipId}/remind`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ title: 'Invitation not sent yet' });
    expect(res.json().detail).toContain('goes out when you open the room');
    expect(outbox).toHaveLength(0);
    expect(await events('invitation.reminded')).toEqual([]);
  });

  it('refuses Remind after a return to preparing', async () => {
    await setState('open');
    await inviteTo(h.group.b, 'kofi@bidder-b.example');
    expect(outbox).toHaveLength(1);
    await setState('preparing');
    const m = await member('kofi@bidder-b.example');
    expect(m.invitationWaits).toBe(false);
    const res = await call('POST', `${W()}/memberships/${m.membershipId}/remind`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ title: 'The room is not open' });
    expect(res.json().detail).toContain('being prepared');
    expect(outbox).toHaveLength(1);
  });

  it('skips revoked invitations', async () => {
    await inviteTo(h.group.b, 'kofi@bidder-b.example', 'ama@bidder-b.example');
    const m = await member('kofi@bidder-b.example');
    expect((await call('POST', `${W()}/memberships/${m.membershipId}/revoke`, {})).statusCode).toBeLessThan(300);
    expect((await call('GET', `${W()}/settings`)).json().waitingInvitations).toBe(1);
    await setState('open');
    expect(outbox.map((x) => x.to)).toEqual(['ama@bidder-b.example']);
  });
});

describe('when the room opens', () => {
  it('queues held invitations for the worker', async () => {
    await app.close();
    await start(true);
    await setState('preparing');
    const [inv] = await inviteTo(h.group.b, 'kofi@bidder-b.example');
    expect(outbox).toHaveLength(0);

    now = new Date(T.at.getTime() + 10 * DAY);
    expect((await call('GET', `${W()}/settings`)).json().waitingInvitations).toBe(1);
    await setState('open');
    expect(outbox).toHaveLength(0);
    expect(queue!.jobs).toEqual([{ name: 'send-waiting-invitations',
      payload: { tenantId: h.t1, workspaceId: h.ws, actorId: expect.any(String), publicUrl: PUBLIC } }]);
    const changed = (await events('workspace.state_changed')).at(-1)!;
    expect(changed.data).toMatchObject({ before: 'preparing', after: 'open', invitations_to_send: 1 });

    now = new Date(now.getTime() + 60_000);
    const sentAt = now;
    expect(await sendWaitingInvitations(worker(), queue!.jobs[0]!.payload as unknown as WaitingInvitationsPayload)).toEqual({ sent: 1, notSent: 0 });
    expect(outbox.map((m) => m.to)).toEqual(['kofi@bidder-b.example']);
    expect(outbox[0]!.text).toContain(`${PUBLIC}/invite/`);
    expect(outbox[0]!.text).toContain('Anika Pillay');
    expect(await events('invitation.sent')).toEqual([expect.objectContaining({ resource_id: inv!.id })]);

    // expiry counts from the send
    const row = (await h.pg.query<{ expires_at: Date; sent_at: Date; waits_for_room: boolean }>(
      `select expires_at, sent_at, waits_for_room from invitation where id = $1`, [inv!.id])).rows[0]!;
    expect(row.waits_for_room).toBe(false);
    expect(new Date(row.sent_at).toISOString()).toBe(sentAt.toISOString());
    expect(new Date(row.expires_at).toISOString()).toBe(new Date(sentAt.getTime() + 14 * DAY).toISOString());
    expect(await member('kofi@bidder-b.example')).toMatchObject({ invitationWaits: false, invitedAt: sentAt.toISOString(), status: 'invited' });

    const token = tokenIn(outbox[0]!);
    now = new Date(T.at.getTime() + 15 * DAY);
    expect((await app.inject({ method: 'GET', url: `/v1/public/invitations/${token}` })).statusCode).toBe(200);
    now = new Date(sentAt.getTime() + 14 * DAY + 60_000);
    expect((await app.inject({ method: 'GET', url: `/v1/public/invitations/${token}` })).statusCode).toBe(410);

    expect(await sendWaitingInvitations(worker(), queue!.jobs[0]!.payload as unknown as WaitingInvitationsPayload)).toEqual({ sent: 0, notSent: 0 });
    expect(outbox).toHaveLength(1);
  });

  it('sends inline without a job queue', async () => {
    await setState('preparing');
    await inviteTo(h.group.b, 'kofi@bidder-b.example', 'ama@bidder-b.example');
    const real = mailer.send;
    let first = true;
    mailer.send = async (m) => {
      if (first) { first = false; return { status: 'failed', error: 'Mailbox unavailable' }; }
      return real(m);
    };
    try {
      await setState('open');
    } finally {
      mailer.send = real;
    }
    expect(outbox).toHaveLength(1);
    expect(await events('invitation.sent')).toHaveLength(1);
    expect(await events('invitation.not_sent')).toHaveLength(1);
    expect((await call('GET', `${W()}/settings`)).json().waitingInvitations).toBe(0);
  });

  it('allows Remind once open', async () => {
    await setState('preparing');
    await inviteTo(h.group.b, 'kofi@bidder-b.example');
    await setState('open');
    expect(outbox).toHaveLength(1);
    now = new Date(T.at.getTime() + 2 * 3_600_000);
    const m = await member('kofi@bidder-b.example');
    const res = await call('POST', `${W()}/memberships/${m.membershipId}/remind`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ reason: 'invitation', delivery: 'accepted' });
    expect(outbox).toHaveLength(2);
    expect((await app.inject({ method: 'GET', url: `/v1/public/invitations/${tokenIn(outbox[0]!)}` })).statusCode).toBe(410);
    expect((await app.inject({ method: 'GET', url: `/v1/public/invitations/${tokenIn(outbox[1]!)}` })).statusCode).toBe(200);
  });

  it('sends when frozen', async () => {
    await setState('preparing');
    await inviteTo(h.group.b, 'kofi@bidder-b.example');
    await setState('frozen');
    expect(outbox.map((m) => m.to)).toEqual(['kofi@bidder-b.example']);
  });
});

describe('other room states', () => {
  it('sends at once when open', async () => {
    const [inv] = await inviteTo(h.group.b, 'kofi@bidder-b.example');
    expect(inv!.waits).toBe(false);
    expect(outbox).toHaveLength(1);
    expect(await events('invitation.held')).toEqual([]);
  });

  it('sends at once when frozen', async () => {
    await setState('frozen');
    await inviteTo(h.group.b, 'kofi@bidder-b.example');
    expect(outbox).toHaveLength(1);
  });

  it('holds invitations when closed', async () => {
    await setState('closed');
    const [inv] = await inviteTo(h.group.b, 'kofi@bidder-b.example');
    expect(inv!.waits).toBe(true);
    expect(outbox).toHaveLength(0);
    await setState('preparing');
    expect(outbox).toHaveLength(0);
    await setState('open');
    expect(outbox.map((m) => m.to)).toEqual(['kofi@bidder-b.example']);
  });

  it('gives held invitations no working link', async () => {
    await setState('preparing');
    const [inv] = await inviteTo(h.group.b, 'kofi@bidder-b.example');
    const token = `${h.t1}.${'x'.repeat(43)}`;
    await h.pg.query(`update invitation set token_sha256 = encode(sha256(convert_to($2, 'UTF8')), 'hex') where id = $1`, [inv!.id, token]);
    expect((await app.inject({ method: 'GET', url: `/v1/public/invitations/${token}` })).statusCode).toBe(410);
    const accept = await app.inject({ method: 'POST', url: '/v1/public/invitations/accept',
      payload: { token, givenName: 'Kofi', familyName: 'Mensah', company: 'Bidder B' } });
    expect(accept.statusCode).toBe(410);
    expect(await events('invitation.accepted')).toEqual([]);
  });
});

describe('send-waiting-invitations job', () => {
  it('rejects a payload without tenant or room', async () => {
    const { assertPayload } = await import('../src/worker/pg-boss-queue.js');
    expect(() => assertPayload('send-waiting-invitations', { workspaceId: h.ws })).toThrow(/tenant/);
    expect(() => assertPayload('send-waiting-invitations', { tenantId: h.t1 })).toThrow(/room/);
    expect(() => assertPayload('send-waiting-invitations', { tenantId: h.t1, workspaceId: h.ws })).not.toThrow();
  });

  it('sends nothing if the room closed again', async () => {
    await app.close();
    await start(true);
    await setState('preparing');
    await inviteTo(h.group.b, 'kofi@bidder-b.example');
    await setState('open');
    await setState('closed');
    expect(await sendWaitingInvitations(worker(), queue!.jobs[0]!.payload as unknown as WaitingInvitationsPayload)).toEqual({ sent: 0, notSent: 0 });
    expect(outbox).toHaveLength(0);
    expect((await call('GET', `${W()}/settings`)).json().waitingInvitations).toBe(1);
  });
});
