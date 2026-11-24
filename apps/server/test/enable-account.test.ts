// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { verifyChain, type Channel, type OutgoingMessage } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { callerForLogin } from '../src/auth/person-link.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';


let h: Heron;
let app: FastifyInstance;
let thabo: string;
let clock: Date;
let outbox: OutgoingMessage[];
const mailer: Channel = { name: 'email', send: async (m) => { outbox.push(m); return { status: 'accepted', providerMessageId: `<e${outbox.length}@mail.example>` }; } };

beforeEach(async () => {
  h = await heron();
  outbox = [];
  clock = T.at;
  for (const id of Object.values(h.person)) {
    await h.pg.query(`insert into principal (tenant_id, kind, person_id, name) select tenant_id, 'person', id, name from person where id = $1`, [id]);
  }
  thabo = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email, is_site_admin) values ($1, 'Thabo Molefe', 'thabo@quillmont.example', true) returning id`, [h.t1])).rows[0]!.id;
  await h.pg.query(`insert into site_instance (tenant_id) values ($1)`, [h.t1]);
  await h.pg.query(`update workspace set require_two_factor = false where id = $1`, [h.ws]);
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => clock, mailer, rateLimit: false, publicUrl: 'https://dataroom.example' });
});
afterEach(async () => {
  await app.close();
  await h.pg.close();
});

const as = (person: string) => ({ 'x-dev-person': person, 'x-dev-tenant': h.t1 });
const call = (method: 'GET' | 'POST', url: string, person: string, payload?: unknown) =>
  app.inject({ method, url, headers: as(person), ...(payload !== undefined ? { payload: payload as object } : { payload: {} }) });
const W = () => `/v1/workspaces/${h.ws}`;
const later = async (minutes: number) => { clock = new Date(T.at.getTime() + minutes * 60_000); await h.pin(clock); };

async function janIn(group = h.group.a) {
  const people = (await call('GET', `${W()}/people`, h.person.anika)).json();
  return people.parties.flatMap((p: any) => p.groups).find((g: any) => g.id === group).members.find((m: any) => m.personId === h.person.jan);
}

describe('enable account', () => {
  it('requires site admin', async () => {
    await call('POST', `/v1/site/accounts/${h.person.jan}/disable`, thabo);
    for (const p of [h.person.anika, h.person.maria, h.person.lars]) {
      const res = await call('POST', `/v1/site/accounts/${h.person.jan}/enable`, p);
      expect(res.statusCode, p).toBe(403);
      expect(res.json().reason).toBe('not_site_admin');
    }
    const other = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email, is_site_admin, disabled_at) values ($1, 'Old Admin', 'old@quillmont.example', true, now()) returning id`, [h.t1])).rows[0]!.id;
    expect((await call('POST', `/v1/site/accounts/${h.person.jan}/enable`, other)).statusCode).toBe(403);
    expect((await h.pg.query<any>(`select disabled_at from person where id = $1`, [h.person.jan])).rows[0].disabled_at).not.toBeNull();
  });

  it('lists reachable rooms for the disable warning', async () => {
    const room = (await h.pg.query<{ name: string }>(`select name from workspace where id = $1`, [h.ws])).rows[0]!.name;
    expect((await call('GET', '/v1/site/accounts?q=jan', thabo)).json().items[0]).toMatchObject({ rooms: 1, roomNames: [room] });
  });

  it('ends sessions, trusted browsers and email changes on disable', async () => {
    await h.pg.query(`insert into auth_user (id, name, email, email_verified, two_factor_enabled) values ('u-jan', 'Jan', 'jan@bidder-a.example', true, true)`);
    await h.pg.query(`insert into auth_session (id, user_id, token, expires_at) values ('s-jan', 'u-jan', 't-jan', now() + interval '1 day')`);
    await h.pg.query(`insert into auth_trusted_browser (user_id, trust_identifier, created_at, trusted_until) values ('u-jan', 'trust-jan', now(), now() + interval '30 days')`);
    await h.pg.query(
      `insert into email_change (tenant_id, person_id, old_email, new_email, token_sha256, code_sha256, requested_by, requested_at, expires_at)
       values ($1, $2, 'jan@bidder-a.example', 'jan@elsewhere.example', $3, $4, $5, now(), now() + interval '3 days')`,
      [h.t1, h.person.jan, 'a'.repeat(64), 'b'.repeat(64), thabo]);

    const res = await call('POST', `/v1/site/accounts/${h.person.jan}/disable`, thabo);
    expect([res.statusCode, res.json().sessionsEnded]).toEqual([200, 1]);
    expect((await h.pg.query(`select 1 from auth_session where user_id = 'u-jan'`)).rows).toEqual([]);
    expect((await h.pg.query(`select 1 from auth_trusted_browser where user_id = 'u-jan'`)).rows).toEqual([]);
    expect((await h.pg.query<{ status: string }>(`select status from email_change where person_id = $1`, [h.person.jan])).rows).toEqual([{ status: 'replaced' }]);
    const site = (await call('GET', '/v1/site/events', thabo)).json().items.find((e: any) => e.action === 'site.account.disabled');
    expect(site.data).toMatchObject({ sessions_ended: 1, trusted_browsers_removed: 1, email_changes_closed: 1 });

    await later(60);
    expect((await call('POST', `/v1/site/accounts/${h.person.jan}/enable`, thabo)).statusCode).toBe(200);
    expect((await h.pg.query<{ status: string }>(`select status from email_change where person_id = $1`, [h.person.jan])).rows).toEqual([{ status: 'replaced' }]);
  });

  it('keeps 2FA across disable and enable', async () => {
    await h.pg.query(`update workspace set require_two_factor = true where id = $1`, [h.ws]);
    await h.pg.query(`insert into auth_user (id, name, email, email_verified, two_factor_enabled) values ('u-jan', 'Jan', 'jan@bidder-a.example', true, true)`);
    await h.app((tx) => tx.query(`insert into auth_person (tenant_id, person_id, email, user_id) values (current_tenant_id(), $1, 'jan@bidder-a.example', 'u-jan')`, [h.person.jan]));
    expect((await call('POST', `/v1/site/accounts/${h.person.jan}/disable`, thabo)).statusCode).toBe(200);
    await later(60);
    expect((await call('POST', `/v1/site/accounts/${h.person.jan}/enable`, thabo)).statusCode).toBe(200);
    expect((await call('GET', '/v1/site/accounts?q=jan', thabo)).json().items[0]).toMatchObject({ twoFactor: 'on' });
    await later(120);
    const restore = await call('POST', `${W()}/memberships/${(await janIn()).membershipId}/restore`, h.person.anika);
    expect(restore.statusCode, restore.body).toBe(200);
    expect(restore.json()).toMatchObject({ twoFactorReady: true, twoFactorAgain: false });
  });

  it('enables sign-in and leaves room access revoked', async () => {
    await h.pg.query(`insert into auth_user (id, name, email, email_verified) values ('u-jan', 'Jan', 'jan@bidder-a.example', true)`);
    await h.app((tx) => tx.query(`insert into auth_person (tenant_id, person_id, email, user_id) values (current_tenant_id(), $1, 'jan@bidder-a.example', 'u-jan')`, [h.person.jan]));
    const login = { userId: 'u-jan', email: 'jan@bidder-a.example', emailVerified: true };
    expect((await janIn()).status).toBe('active');

    expect((await call('POST', `/v1/site/accounts/${h.person.jan}/disable`, thabo)).statusCode).toBe(200);
    expect(await callerForLogin(h.db, login, { dbRole: 'vdrkit_app' })).toBeNull();

    await later(60);
    const res = await call('POST', `/v1/site/accounts/${h.person.jan}/enable`, thabo);
    expect(res.statusCode, res.body).toBe(200);
    const room = (await h.pg.query<{ name: string }>(`select name from workspace where id = $1`, [h.ws])).rows[0]!.name;
    expect(res.json()).toEqual({ personId: h.person.jan, rooms: 1, roomNames: [room], membershipsRevoked: 1 });
    expect((await h.pg.query<any>(`select disabled_at, disabled_by from person where id = $1`, [h.person.jan])).rows[0]).toEqual({ disabled_at: null, disabled_by: null });
    expect(await callerForLogin(h.db, login, { dbRole: 'vdrkit_app' })).toMatchObject({ principal: { kind: 'person', personId: h.person.jan } });
    expect((await call('GET', '/v1/site/accounts?q=jan', thabo)).json().items[0]).toMatchObject({ disabledAt: null, rooms: 0, roomNames: [] });

    expect((await janIn()).status).toBe('revoked');
    expect([403, 404]).toContain((await call('GET', `${W()}/dashboard`, h.person.jan)).statusCode);

    const site = (await call('GET', '/v1/site/events', thabo)).json().items.find((e: any) => e.action === 'site.account.enabled');
    expect(site).toMatchObject({ actorName: 'Thabo Molefe', data: { person_id: h.person.jan, rooms: 1, memberships_revoked: 1 } });
    const roomLog = (await h.pg.query<any>(`select action, data from event where workspace_id = $1 and action in ('account.enabled', 'membership.revoked') order by seq`, [h.ws])).rows;
    expect(roomLog).toEqual([
      { action: 'membership.revoked', data: expect.objectContaining({ person_id: h.person.jan, group_id: h.group.a, because: 'account_enabled', by_person_id: thabo }) },
      { action: 'account.enabled', data: { person_id: h.person.jan, by_person_id: thabo } },
    ]);
    const entries = (await call('GET', `${W()}/events?limit=200`, h.person.anika)).json().items;
    expect(entries.some((e: any) => e.action === 'account.enabled')).toBe(true);

    await later(120);
    const restore = await call('POST', `${W()}/memberships/${(await janIn()).membershipId}/restore`, h.person.anika);
    expect(restore.statusCode, restore.body).toBe(200);
    expect(restore.json()).toMatchObject({ groups: ['Bidder A'], email: 'accepted', twoFactorAgain: false });
    expect((await janIn()).status).toBe('active');
    expect((await call('GET', `${W()}/dashboard`, h.person.jan)).statusCode).toBe(200);
    expect((await h.app((tx) => verifyChain(tx, h.ws))).firstBroken).toBeNull();
  });

  it('cancels pending invitations on disable', async () => {
    const email = 'dita@bidder-a.example';
    const invited = await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.a, people: [{ email }] });
    expect(invited.statusCode, invited.body).toBeLessThan(300);
    const dita = (await h.pg.query<{ id: string }>(`select id from person where email = $1`, [email])).rows[0]!.id;
    const invitations = async () => (await h.pg.query<{ status: string }>(
      `select i.status from invitation i join membership m on m.id = i.membership_id where m.person_id = $1 order by i.created_at`, [dita])).rows.map((r) => r.status);
    expect(await invitations()).toEqual(['pending']);

    const inviteLog = async () => (await h.pg.query<{ action: string }>(
      `select action from event where workspace_id = $1 and action like 'invitation.%' order by seq`, [h.ws])).rows.map((r) => r.action);
    const logged = await inviteLog();
    expect(logged.length).toBeGreaterThan(0);

    await later(5);
    expect((await call('POST', `/v1/site/accounts/${dita}/disable`, thabo)).statusCode).toBe(200);
    expect(await invitations()).toEqual(['revoked']);
    // cancelled, not erased: the invitation stays in the log
    expect(await inviteLog()).toEqual(logged);

    await later(10);
    expect((await call('POST', `/v1/site/accounts/${dita}/enable`, thabo)).statusCode).toBe(200);
    const member = async (person: string) => {
      const people = (await call('GET', `${W()}/people`, h.person.anika)).json();
      return people.parties.flatMap((p: any) => p.groups).find((g: any) => g.id === h.group.a).members.find((m: any) => m.personId === person);
    };
    expect(await member(dita)).toMatchObject({ status: 'revoked', neverAccepted: true });
    const restore = await call('POST', `${W()}/memberships/${(await member(dita)).membershipId}/restore`, h.person.anika);
    expect([restore.statusCode, restore.json().reason]).toEqual([409, 'never_accepted']);

    // someone who did accept still gets Restore
    await call('POST', `${W()}/memberships/${(await member(h.person.jan)).membershipId}/revoke`, h.person.anika);
    expect(await member(h.person.jan)).toMatchObject({ status: 'revoked', neverAccepted: false });

    await later(15);
    const again = await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.a, people: [{ email }] });
    expect(again.statusCode, again.body).toBeLessThan(300);
    expect(await invitations()).toEqual(['revoked', 'pending']);
  });

  it('should not remind disabled accounts', async () => {
    const email = 'dita@bidder-a.example';
    await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.a, people: [{ email }] });
    const dita = (await h.pg.query<{ id: string }>(`select id from person where email = $1`, [email])).rows[0]!.id;
    const member = async (person: string) => {
      const people = (await call('GET', `${W()}/people`, h.person.anika)).json();
      return people.parties.flatMap((p: any) => p.groups).find((g: any) => g.id === h.group.a).members.find((m: any) => m.personId === person);
    };
    expect(await member(dita)).toMatchObject({ status: 'invited', disabled: false });

    // invitation still pending
    await h.pg.query(`update person set disabled_at = now() where id = $1`, [dita]);
    await later(90);
    const sent = outbox.length;
    const res = await call('POST', `${W()}/memberships/${(await member(dita)).membershipId}/remind`, h.person.anika);
    expect([res.statusCode, res.json().reason]).toEqual([409, 'account_disabled']);
    expect(outbox.length).toBe(sent);
    expect(await member(dita)).toMatchObject({ status: 'invited', disabled: true });
    expect(await member(h.person.jan)).toMatchObject({ disabled: false });
  });

  it('refuses active, foreign and erased accounts', async () => {
    const res = await call('POST', `/v1/site/accounts/${h.person.jan}/enable`, thabo);
    expect([res.statusCode, res.json().detail]).toEqual([409, 'This account is not disabled.']);
    const other = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email, disabled_at) values ($1, 'Other', 'o@x.example', now()) returning id`, [h.t2])).rows[0]!.id;
    expect((await call('POST', `/v1/site/accounts/${other}/enable`, thabo)).statusCode).toBe(404);
    expect((await h.pg.query<any>(`select disabled_at from person where id = $1`, [other])).rows[0].disabled_at).not.toBeNull();
    await h.pg.query(`update person set disabled_at = now(), erased_at = now() where id = $1`, [h.person.lars]);
    expect((await call('POST', `/v1/site/accounts/${h.person.lars}/enable`, thabo)).statusCode).toBe(404);
  });

  it('revokes nothing without open access', async () => {
    const m = await janIn();
    await call('POST', `${W()}/memberships/${m.membershipId}/revoke`, h.person.anika);
    await later(10);
    await call('POST', `/v1/site/accounts/${h.person.jan}/disable`, thabo);
    await later(20);
    expect((await call('POST', `/v1/site/accounts/${h.person.jan}/enable`, thabo)).json()).toMatchObject({ rooms: 0, membershipsRevoked: 0 });
    await later(30);
    expect((await call('POST', `${W()}/memberships/${(await janIn()).membershipId}/restore`, h.person.anika)).statusCode).toBe(200);
  });
});

describe('Restore access and 2FA', () => {
  it('skips the 2FA line when it was never set up', async () => {
    await h.pg.query(`update workspace set require_two_factor = true where id = $1`, [h.ws]);
    await call('POST', `${W()}/memberships/${(await janIn()).membershipId}/revoke`, h.person.anika);
    await later(1);
    const res = await call('POST', `${W()}/memberships/${(await janIn()).membershipId}/restore`, h.person.anika);
    expect(res.json()).toMatchObject({ twoFactorReady: false, twoFactorAgain: false });
    expect(outbox.at(-1)!.text).not.toContain('two-factor');
  });

  it('mentions 2FA after a reset', async () => {
    await h.pg.query(`update workspace set require_two_factor = true where id = $1`, [h.ws]);
    await h.pg.query(`insert into auth_user (id, name, email, email_verified, two_factor_enabled) values ('u-jan', 'Jan', 'jan@bidder-a.example', true, true)`);
    await h.app((tx) => tx.query(`insert into auth_person (tenant_id, person_id, email, user_id) values (current_tenant_id(), $1, 'jan@bidder-a.example', 'u-jan')`, [h.person.jan]));
    const reset = await call('POST', `/v1/site/accounts/${h.person.jan}/reset-two-factor`, thabo);
    expect(reset.json()).toMatchObject({ hadTwoFactor: true });
    await later(1);
    await call('POST', `${W()}/memberships/${(await janIn()).membershipId}/revoke`, h.person.anika);
    await later(2);
    const res = await call('POST', `${W()}/memberships/${(await janIn()).membershipId}/restore`, h.person.anika);
    expect(res.json()).toMatchObject({ twoFactorReady: false, twoFactorAgain: true });
    expect(outbox.at(-1)!.text).toContain('When you sign in, you set up two-factor sign-in again with an authenticator app.');
  });
});
