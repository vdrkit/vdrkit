// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { verifyChain, type Channel, type OutgoingMessage } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';


let h: Heron;
let app: FastifyInstance;
let outbox: OutgoingMessage[];
let refuse = false;
let clock: Date;
const mailer: Channel = {
  name: 'email',
  send: async (m) => {
    outbox.push(m);
    return refuse ? { status: 'failed', error: `550 Mailbox ${m.to} unavailable` } : { status: 'accepted', providerMessageId: `<m${outbox.length}@mail.example>` };
  },
};

const as = (person: string) => ({ 'x-dev-person': person, 'x-dev-tenant': h.t1, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36' });
const call = (method: 'GET' | 'POST' | 'PUT', url: string, person: string, payload?: unknown) =>
  app.inject({ method, url, headers: as(person), ...(payload !== undefined ? { payload: payload as object } : {}) });
const W = () => `/v1/workspaces/${h.ws}`;

beforeEach(async () => {
  h = await heron();
  outbox = [];
  refuse = false;
  clock = T.at;
  for (const id of Object.values(h.person)) {
    await h.pg.query(`insert into principal (tenant_id, kind, person_id, name) select tenant_id, 'person', id, name from person where id = $1`, [id]);
  }
  await h.pg.query(`update person set time_zone = 'Africa/Johannesburg' where id = $1`, [h.person.anika]);
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => clock, mailer, publicUrl: 'https://dataroom.example' });
});
afterEach(async () => {
  await app.close();
  await h.pg.close();
});

async function log(person = h.person.anika): Promise<any[]> {
  const res = await call('GET', `${W()}/events?limit=200`, person);
  expect(res.statusCode).toBe(200);
  return res.json().items;
}
const proofOf = (e: any) => Object.fromEntries((e.proof ?? []).map((x: { label: string; value: string }) => [x.label, x.value]));
async function contextOf(action: string) {
  return (await h.pg.query<any>(
    `select e.data, c.personal, host(c.ip) as ip, c.subject_person_id from event e left join event_context c on c.event_id = e.id
      where e.workspace_id = $1 and e.action = $2 order by e.chain_pos`, [h.ws, action])).rows;
}
const chainIntact = async () => (await h.app((tx) => verifyChain(tx, h.ws))).firstBroken === null;

describe('emails in the activity log', () => {
  it('records invitation proof, address only in the erasable part', async () => {
    const res = await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.a, people: [{ email: 'sanne@orrinby.example' }], role: 'member' });
    expect(res.statusCode).toBeLessThan(300);
    const [sent] = await contextOf('invitation.sent');
    expect(sent.data).toMatchObject({ channel: 'email', mail_type: 'invitation', delivery_status: 'accepted', provider_message_id: '<m1@mail.example>' });
    expect(JSON.stringify(sent.data)).not.toContain('sanne@orrinby.example');
    expect(sent.personal).toEqual({ to: 'sanne@orrinby.example', subject: outbox[0]!.subject });

    const entry = (await log()).find((e) => e.action === 'invitation.sent');
    const p = proofOf(entry);
    expect(p).toMatchObject({ Email: 'Invitation', Subject: outbox[0]!.subject, Room: 'Project Heron', 'Mail server': 'Accepted, message ID <m1@mail.example>' });
    expect(p.To).toContain('sanne@orrinby.example');
    expect(p['Sent at']).toMatch(/^\w{3} \d+ \w{3} 2026, \d\d:\d\d:\d\d SAST$/);
    expect(entry.detail).toMatch(/^Invitation to /);
    expect(await chainIntact()).toBe(true);
  });

  it('records why an email was refused', async () => {
    refuse = true;
    await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.a, people: [{ email: 'piet@orrinby.example' }], role: 'member' });
    const [failed] = await contextOf('invitation.not_sent');
    expect(failed.data.error).toBe('550 Mailbox [recipient] unavailable');
    const p = proofOf((await log()).find((e) => e.action === 'invitation.not_sent'));
    expect(p['Mail server']).toBe('Not accepted: 550 Mailbox [recipient] unavailable');
  });

  it('includes proof in the CSV export', async () => {
    await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.a, people: [{ email: 'sanne@orrinby.example' }], role: 'member' });
    const csv = (await call('GET', `${W()}/events/export.csv`, h.person.anika)).body;
    expect(csv.split('\r\n')[0]).toBe('\uFEFFTime,Person,Group,Action,Document,Details,Proof');
    expect(csv).toContain('Email: Invitation | To: ');
    expect(csv).toContain('Mail server: Accepted, message ID <m1@mail.example>');
  });
});

describe('NDA acceptance', () => {
  beforeEach(async () => { await h.pg.query(`delete from acceptance where person_id = $1`, [h.person.jan]); });

  it('logs one acceptance when it is sent twice', async () => {
    const first = await call('POST', `${W()}/nda/accept`, h.person.jan, { versionId: h.nda.v1 });
    const again = await call('POST', `${W()}/nda/accept`, h.person.jan, { versionId: h.nda.v1 });
    expect([first.statusCode, again.statusCode]).toEqual([200, 200]);
    expect(again.json().acceptedAt).toBe(first.json().acceptedAt);
    expect(await contextOf('agreement.accepted')).toHaveLength(1);
  });

  it('records version, text hash, time and IP', async () => {
    expect((await call('POST', `${W()}/nda/accept`, h.person.jan, { versionId: h.nda.v1 })).statusCode).toBe(200);
    const [accepted] = await contextOf('agreement.accepted');
    const sha = createHash('sha256').update('Confidentiality undertaking, version 1', 'utf8').digest('hex');
    expect(accepted.data).toMatchObject({ person_id: h.person.jan, version_no: 1, text_sha256: sha, accepted_at: T.at.toISOString() });
    expect(accepted.ip).toBe('127.0.0.1');
    expect(JSON.stringify(accepted.data)).not.toContain('127.0.0.1');

    const p = proofOf((await log()).find((e) => e.action === 'agreement.accepted'));
    expect(p).toMatchObject({ 'NDA version': 'Version 1', 'Text fingerprint (SHA-256)': sha, 'IP address': '127.0.0.1', Browser: 'Chrome on Windows' });
    expect(p['Accepted at']).toMatch(/2026, \d\d:\d\d:\d\d SAST$/);
    expect(await chainIntact()).toBe(true);
  });
});

describe('permission and group changes', () => {
  it('records before and after levels for a matrix save', async () => {
    expect((await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.a, level: 20 }] })).statusCode).toBe(200);
    clock = new Date(T.at.getTime() + 60_000);
    await h.pin(clock);
    expect((await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.aud, groupId: h.group.a, level: 50 }] })).statusCode).toBe(200);
    const cells = (await contextOf('grants.bulk_changed')).map((e) => e.data.cells[0]);
    expect(cells[0]).toMatchObject({ before_level: 0, after_level: 20 });
    expect(cells[1]).toMatchObject({ before_level: 20, after_level: 50 });
    const latest = (await log()).find((e) => e.action === 'grants.bulk_changed');
    expect(latest.proof).toEqual([{ label: 'Bidder A, 3.2 Audited financials', value: 'View → Download PDF' }]);
    expect(await chainIntact()).toBe(true);
  });

  it('records role changes and revokes', async () => {
    const people = (await call('GET', `${W()}/people`, h.person.anika)).json();
    const jan = people.parties.flatMap((p: any) => p.groups).find((g: any) => g.id === h.group.a).members.find((m: any) => m.personId === h.person.jan);
    await call('POST', `${W()}/memberships/${jan.membershipId}/make-lead`, h.person.anika);
    await call('POST', `${W()}/memberships/${jan.membershipId}/revoke`, h.person.anika);
    const entries = await log();
    expect(proofOf(entries.find((e) => e.action === 'membership.role_changed'))).toEqual({ Group: 'Bidder A', Before: 'Member', After: 'Lead' });
    expect(proofOf(entries.find((e) => e.action === 'membership.revoked'))).toEqual({ Group: 'Bidder A', Before: 'Lead of Bidder A', After: 'No access' });
  });
});

describe('Restore access', () => {
  async function janMembership() {
    const people = (await call('GET', `${W()}/people`, h.person.anika)).json();
    return people.parties.flatMap((p: any) => p.groups).find((g: any) => g.id === h.group.a).members.find((m: any) => m.personId === h.person.jan);
  }

  it('should restore group, role and end date', async () => {
    await h.pg.query(`update workspace set require_two_factor = false where id = $1`, [h.ws]);
    const until = '2027-01-29T13:00:00.000Z';
    const before = await janMembership();
    await app.inject({ method: 'PATCH', url: `${W()}/memberships/${before.membershipId}`, headers: as(h.person.anika), payload: { accessEndsAt: until } });
    await call('POST', `${W()}/memberships/${(await janMembership()).membershipId}/make-lead`, h.person.anika);
    clock = new Date(T.at.getTime() + 3600_000);
    await call('POST', `${W()}/memberships/${(await janMembership()).membershipId}/revoke`, h.person.anika);
    expect((await janMembership()).status).toBe('revoked');

    clock = new Date(T.at.getTime() + 2 * 3600_000);
    outbox = [];
    const res = await call('POST', `${W()}/memberships/${(await janMembership()).membershipId}/restore`, h.person.anika);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ groups: ['Bidder A'], accessEndsAt: until, twoFactorReady: true, email: 'accepted' });
    const now = await janMembership();
    expect(now).toMatchObject({ status: 'active', role: 'lead', accessEndsAt: until });

    await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.a, level: 20 }] });
    expect((await call('GET', `${W()}/nodes/${h.node.aud1}`, h.person.jan)).statusCode).toBe(200);

    const mail = outbox.find((m) => m.to === 'jan@bidder-a.example')!;
    expect(mail.subject).toBe('Your access to Project Heron is back');
    expect(mail.text).toContain('Anika Pillay restored your access to the Project Heron data room. You are back in Bidder A, with the same access as before. Your access runs until Fri 29 Jan 2027.');
    expect(mail.text).toContain(`Sign in: https://dataroom.example/sign-in?next=${encodeURIComponent(`/rooms/${h.ws}`)}`);
    expect(mail.text).not.toContain('two-factor');

    const entries = await log();
    const restored = entries.find((e) => e.action === 'membership.restored');
    expect(restored).toMatchObject({ kind: 'access', item: 'Restored access of Jan de Vries', detail: 'Bidder A' });
    expect(proofOf(restored)).toEqual({ Group: 'Bidder A', Before: 'No access, revoked', After: 'Lead of Bidder A, until Fri 29 Jan 2027' });
    const told = entries.find((e) => e.action === 'notification.sent' && e.data.mail_type === 'access_restored');
    expect(proofOf(told)).toMatchObject({ Email: 'Access restored', Subject: 'Your access to Project Heron is back', 'Mail server': 'Accepted, message ID <m1@mail.example>' });
    expect(await chainIntact()).toBe(true);

    const again = await call('POST', `${W()}/memberships/${now.membershipId}/restore`, h.person.anika);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ reason: 'not_revoked', detail: 'Jan de Vries still has access to Bidder A.' });
  });

  it('asks to set up 2FA again after a reset', async () => {
    await h.pg.query(`update workspace set require_two_factor = true where id = $1`, [h.ws]);
    // had an authenticator before the reset
    await h.pg.query(`insert into auth_user (id, name, email, email_verified, two_factor_enabled) values ('u-jan', 'Jan', 'jan@bidder-a.example', true, true)`);
    await h.app((tx) => tx.query(`insert into auth_person (tenant_id, person_id, email, user_id) values (current_tenant_id(), $1, 'jan@bidder-a.example', 'u-jan')`, [h.person.jan]));
    expect((await call('POST', `${W()}/people/${h.person.jan}/reset-two-factor`, h.person.anika, {})).json()).toMatchObject({ hadTwoFactor: true });
    const m = await janMembership();
    await call('POST', `${W()}/memberships/${m.membershipId}/revoke`, h.person.anika);
    clock = new Date(T.at.getTime() + 60_000);
    const res = await call('POST', `${W()}/memberships/${(await janMembership()).membershipId}/restore`, h.person.anika);
    expect(res.json()).toMatchObject({ twoFactorReady: false, twoFactorAgain: true });
    expect(outbox.at(-1)!.text).toContain('When you sign in, you set up two-factor sign-in again with an authenticator app.');
  });

  it('refuses disabled accounts, closed groups and non-admins', async () => {
    const m = await janMembership();
    expect((await call('POST', `${W()}/memberships/${m.membershipId}/revoke`, h.person.anika)).statusCode).toBe(200);
    const revoked = (await janMembership()).membershipId;
    expect([403, 404]).toContain((await call('POST', `${W()}/memberships/${revoked}/restore`, h.person.jan)).statusCode);
    expect([403, 404]).toContain((await call('POST', `${W()}/memberships/${revoked}/restore`, h.person.maria)).statusCode);

    await h.pg.query(`update person set disabled_at = now() where id = $1`, [h.person.jan]);
    const disabled = await call('POST', `${W()}/memberships/${revoked}/restore`, h.person.anika);
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json()).toMatchObject({ reason: 'account_disabled',
      detail: 'A site admin disabled the account of Jan de Vries, so access cannot be restored here. Ask a site admin.' });

    await h.pg.query(`update person set disabled_at = null where id = $1`, [h.person.jan]);
    await h.pg.query(`update groups set valid_to = $2 where id = $1`, [h.group.a, new Date(T.at.getTime() - 1000).toISOString()]);
    const closed = await call('POST', `${W()}/memberships/${revoked}/restore`, h.person.anika);
    expect(closed.statusCode).toBe(409);
    expect(closed.json()).toMatchObject({ reason: 'group_closed' });
  });

  it('erasure clears addresses and keeps the chain valid', async () => {
    const m = await janMembership();
    expect((await call('POST', `${W()}/memberships/${m.membershipId}/revoke`, h.person.anika)).statusCode).toBe(200);
    expect((await call('POST', `${W()}/memberships/${(await janMembership()).membershipId}/restore`, h.person.anika)).statusCode).toBe(200);
    await h.pg.query(`update person set erased_at = now() where id = $1`, [h.person.jan]);
    const left = (await h.pg.query<{ n: number }>(`select count(*)::int as n from event_context where subject_person_id = $1 and personal is not null`, [h.person.jan])).rows[0]!.n;
    expect(left).toBe(0);
    expect(await chainIntact()).toBe(true);
  });
});
