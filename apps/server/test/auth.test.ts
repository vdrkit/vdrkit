// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Channel, OutgoingMessage } from '@vdrkit/core';
import { buildApp } from '../src/index.js';
import { BetterAuthAuthenticator, betterAuthRoutes, createBetterAuth, type VdrAuth } from '../src/auth/better-auth.js';
import { callerForLogin, linkPersonToLogin } from '../src/auth/person-link.js';
import { poolFromPGlite } from '../src/auth/pool.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';

const A2 = { givenName: 'Sven', familyName: 'Lund', company: 'Skjolvik Partners' };



const URL_ = 'https://dataroom.example.com';
const SECRET = 'test-secret-test-secret-test-secret-0123456789';

class FakeMailer implements Channel {
  readonly name = 'fake';
  sent: OutgoingMessage[] = [];
  // slow mail server
  hold: Promise<void> | null = null;
  async send(msg: OutgoingMessage) {
    await this.hold;
    this.sent.push(msg);
    return { status: 'accepted' as const, providerMessageId: `m${this.sent.length}` };
  }
  last() { return this.sent[this.sent.length - 1]!; }
}

let h: Heron;
let app: FastifyInstance;
let mail: FakeMailer;
let auth: VdrAuth;

beforeEach(async () => {
  h = await heron();
  await h.pg.query(`update workspace set require_two_factor = false`);
  mail = new FakeMailer();
  auth = createBetterAuth({ db: h.db, pool: h.appPool ?? poolFromPGlite(h.pg), secret: SECRET, publicUrl: URL_, mailer: mail, dbRole: 'vdrkit_app', builtInRateLimit: false });
  app = await buildApp({
    db: h.db, auth: new BetterAuthAuthenticator(auth, h.db, 'vdrkit_app'), dbRole: 'vdrkit_app', now: () => T.at,
    mailer: mail, publicUrl: URL_, plugins: [betterAuthRoutes(auth, URL_)], rateLimit: false,
  });
});
afterEach(async () => {
  await app.close();
  await h.pg.close();
});

const emailOf = async (person: string) => (await h.pg.query<{ email: string }>(`select email from person where id = $1`, [person])).rows[0]!.email;
const link = (person: string) => h.app((tx) => linkPersonToLogin(tx, person));
const headers = (cookie?: string) => ({ origin: URL_, ...(cookie ? { cookie } : {}) });
const authPost = (path: string, payload: unknown, cookie?: string) =>
  app.inject({ method: 'POST', url: `/v1/auth${path}`, headers: headers(cookie), payload: payload as object })
    .then(async (r) => { await auth.vdrkit.signInMailSettled(); return r; });
const cookiesOf = (res: { headers: Record<string, unknown> }) => {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return list.map((c) => c.split(';')[0]!).filter((c) => !c.endsWith('=')).join('; ');
};
const myRooms = (cookie: string) => app.inject({ method: 'GET', url: '/v1/me/workspaces', headers: headers(cookie) });

async function signInByMagicLink(email: string): Promise<string> {
  expect((await authPost('/sign-in/magic-link', { email })).statusCode).toBe(200);
  const url = new URL(/https:\/\/\S+/.exec(mail.last().text!)![0]);
  const token = url.searchParams.get('token')!;
  const res = await app.inject({ method: 'GET', url: `/v1/auth/magic-link/verify?token=${token}`, headers: headers() });
  expect(res.statusCode).toBe(200);
  return cookiesOf(res);
}

async function signInByCode(email: string) {
  expect((await authPost('/email-otp/send-verification-otp', { email, type: 'sign-in' })).statusCode).toBe(200);
  const otp = /\b(\d{6})\b/.exec(mail.last().subject.replaceAll(' ', ''))![1]!;
  return authPost('/sign-in/email-otp', { email, otp });
}

function totp(base32: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of base32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const o = mac[mac.length - 1]! & 0xf;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

describe('sign-in by magic link', () => {
  it('signs in a linked person', async () => {
    await link(h.person.anika);
    const cookie = await signInByMagicLink(await emailOf(h.person.anika));
    const res = await myRooms(cookie);
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).toContain('Project Heron');
    const bound = await h.pg.query<{ user_id: string | null }>(`select user_id from auth_person where person_id = $1`, [h.person.anika]);
    expect(bound.rows[0]!.user_id).not.toBeNull();
  });

  it('sends and audits the link', async () => {
    await link(h.person.anika);
    await authPost('/sign-in/magic-link', { email: await emailOf(h.person.anika) });
    expect(mail.sent).toHaveLength(1);
    expect(mail.last().personId).toBe(h.person.anika);
    const ev = await h.pg.query<{ action: string; data: any }>(`select action, data from event where action like 'auth.%'`);
    expect(ev.rows.map((e) => e.action)).toEqual(['auth.magic_link.sent']);
    expect(ev.rows[0]!.data).toMatchObject({ recipient_person_id: h.person.anika, channel: 'email', delivery_status: 'accepted' });
  });

  it('sends nothing to unknown addresses', async () => {
    const res = await authPost('/sign-in/magic-link', { email: 'stranger@example.com' });
    expect(res.statusCode).toBe(200);
    expect(mail.sent).toHaveLength(0);
  });

  it('answers without waiting for the mail server', async () => {
    await link(h.person.anika);
    let release!: () => void;
    mail.hold = new Promise((r) => { release = r; });
    const ask = (email: string) => Promise.race([
      app.inject({ method: 'POST', url: '/v1/auth/sign-in/magic-link', headers: headers(), payload: { email } }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the response waited for the mail server')), 5_000)),
    ]);
    const known = await ask(await emailOf(h.person.anika));
    const unknown = await ask('stranger@example.com');
    expect({ status: known.statusCode, body: known.body }).toEqual({ status: unknown.statusCode, body: unknown.body });
    expect(known.statusCode).toBe(200);
    expect(mail.sent).toHaveLength(0);
    release();
    await auth.vdrkit.signInMailSettled();
    expect(mail.sent.map((m) => m.personId)).toEqual([h.person.anika]);
    const ev = await h.pg.query<{ action: string }>(`select action from event where action like 'auth.%'`);
    expect(ev.rows.map((e) => e.action)).toEqual(['auth.magic_link.sent']);
  });

  it('should require a session', async () => {
    const res = await myRooms('');
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('denies erased people', async () => {
    await link(h.person.jan);
    const cookie = await signInByMagicLink(await emailOf(h.person.jan));
    expect((await myRooms(cookie)).statusCode).toBe(200);
    await h.pg.query(`update person set erased_at = now() where id = $1`, [h.person.jan]);
    expect((await myRooms(cookie)).statusCode).toBe(401);
  });
});

describe('sign-in by email code', () => {
  it('signs in with the code', async () => {
    await link(h.person.maria);
    const res = await signInByCode(await emailOf(h.person.maria));
    expect(res.statusCode).toBe(200);
    expect((await myRooms(cookiesOf(res))).statusCode).toBe(200);
    const ev = await h.pg.query<{ action: string }>(`select action from event where action like 'auth.%'`);
    expect(ev.rows.map((e) => e.action)).toEqual(['auth.email_code.sent', 'auth.signed_in', 'auth.signed_in']);
  });

  it('rejects a wrong code', async () => {
    await link(h.person.maria);
    const email = await emailOf(h.person.maria);
    await authPost('/email-otp/send-verification-otp', { email, type: 'sign-in' });
    const res = await authPost('/sign-in/email-otp', { email, otp: '000000' });
    expect(res.statusCode).toBe(400);
    expect(cookiesOf(res)).not.toContain('session_token');
  });
});

describe('TOTP second factor', () => {
  it('requires the TOTP code after the email code', async () => {
    await link(h.person.anika);
    const email = await emailOf(h.person.anika);
    const first = cookiesOf(await signInByCode(email));

    const enable = await authPost('/two-factor/enable', {}, first);
    expect(enable.statusCode).toBe(200);
    const secret = new URL(enable.json().totpURI).searchParams.get('secret')!;
    const confirm = await authPost('/two-factor/verify-totp', { code: totp(secret) }, first);
    expect(confirm.statusCode).toBe(200);

    const again = await signInByCode(email);
    expect(again.json()).toMatchObject({ twoFactorRedirect: true });
    const pending = cookiesOf(again);
    expect((await myRooms(pending)).statusCode).toBe(401);

    expect((await authPost('/two-factor/verify-totp', { code: '000000' }, pending)).statusCode).toBe(401);
    const done = await authPost('/two-factor/verify-totp', { code: totp(secret) }, pending);
    expect(done.statusCode).toBe(200);
    expect((await myRooms(cookiesOf(done))).statusCode).toBe(200);
  });

  it('guards the magic link', async () => {
    await link(h.person.anika);
    const email = await emailOf(h.person.anika);
    const first = await signInByMagicLink(email);
    const enable = await authPost('/two-factor/enable', {}, first);
    const secret = new URL(enable.json().totpURI).searchParams.get('secret')!;
    await authPost('/two-factor/verify-totp', { code: totp(secret) }, first);

    await authPost('/sign-in/magic-link', { email });
    const token = new URL(/https:\/\/\S+/.exec(mail.last().text!)![0]).searchParams.get('token')!;
    const res = await app.inject({ method: 'GET', url: `/v1/auth/magic-link/verify?token=${token}`, headers: headers() });
    expect(res.json()).toMatchObject({ twoFactorRedirect: true });
    expect((await myRooms(cookiesOf(res))).statusCode).toBe(401);

    await authPost('/sign-in/magic-link', { email });
    const emailed = new URL(/https:\/\/\S+/.exec(mail.last().text!)![0]);
    const viaBrowser = await app.inject({ method: 'GET', url: emailed.pathname + emailed.search, headers: headers() });
    expect((await myRooms(cookiesOf(viaBrowser))).statusCode).toBe(401);
  });
});

describe('invitation acceptance leads to sign-in', () => {
  it('lets the invited address sign in', async () => {
    await link(h.person.anika);
    const admin = await signInByMagicLink(await emailOf(h.person.anika));
    const inv = await app.inject({ method: 'POST', url: `/v1/workspaces/${h.ws}/invitations`, headers: headers(admin),
      payload: { groupId: h.group.a, people: [{ email: 'sven@bidder-a.example', name: 'Sven' }], role: 'member' } });
    expect(inv.statusCode).toBe(201);
    const token = /\/invite\/(\S+)/.exec(mail.last().text!)![1]!;

    const before = mail.sent.length;
    await authPost('/sign-in/magic-link', { email: 'sven@bidder-a.example' });
    expect(mail.sent.length).toBe(before);

    expect((await app.inject({ method: 'POST', url: '/v1/public/invitations/accept', payload: { token, ...A2 } })).statusCode).toBe(200);
    const cookie = await signInByMagicLink('sven@bidder-a.example');
    expect((await myRooms(cookie)).statusCode).toBe(200);
  });
});

describe('from login to caller', () => {
  it('does not link unverified emails', async () => {
    await link(h.person.lars);
    const email = await emailOf(h.person.lars);
    await h.pg.query(`insert into auth_user (id, name, email, email_verified) values ('u1', 'x', $1, false)`, [email]);
    expect(await callerForLogin(h.db, { userId: 'u1', email, emailVerified: false })).toBeNull();
    expect(await callerForLogin(h.db, { userId: 'u1', email, emailVerified: true }))
      .toEqual({ tenantId: h.t1, principal: { kind: 'person', personId: h.person.lars }, actorId: null });
  });

  it('asks which tenant for a login in two tenants', async () => {
    const email = await emailOf(h.person.mei);
    const other = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Mei', $2) returning id`, [h.t2, email])).rows[0]!.id;
    await link(h.person.mei);
    await h.db.transaction(async (tx) => {
      await tx.query(`select set_config('app.tenant_id', $1, true)`, [h.t2]);
      await linkPersonToLogin(tx, other);
    });
    await h.pg.query(`insert into auth_user (id, name, email, email_verified) values ('u2', 'Mei', $1, true)`, [email]);
    const login = { userId: 'u2', email, emailVerified: true };
    await expect(callerForLogin(h.db, login, { dbRole: 'vdrkit_app' })).rejects.toMatchObject({ problem: { status: 400 } });
    expect((await callerForLogin(h.db, login, { tenantId: h.t2, dbRole: 'vdrkit_app' }))?.principal).toEqual({ kind: 'person', personId: other });
    expect(await callerForLogin(h.db, login, { tenantId: '00000000-0000-4000-8000-000000000000', dbRole: 'vdrkit_app' })).toBeNull();
  });

  it('refuses a tenant the login does not belong to', async () => {
    const email = await emailOf(h.person.lars);
    await link(h.person.lars);
    await h.pg.query(`insert into auth_user (id, name, email, email_verified) values ('u3', 'Lars', $1, true)`, [email]);
    const login = { userId: 'u3', email, emailVerified: true };
    expect((await callerForLogin(h.db, login, { tenantId: h.t1, dbRole: 'vdrkit_app' }))?.tenantId).toBe(h.t1);
    // someone else's tenant
    expect(await callerForLogin(h.db, login, { tenantId: h.t2, dbRole: 'vdrkit_app' })).toBeNull();
    expect(await callerForLogin(h.db, login, { tenantId: 'not-a-uuid', dbRole: 'vdrkit_app' })).toBeNull();
  });

  it('logs sign-in emails only in the requested tenant', async () => {
    const email = await emailOf(h.person.mei);
    const other = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Mei', $2) returning id`, [h.t2, email])).rows[0]!.id;
    await link(h.person.mei);
    await h.db.transaction(async (tx) => {
      await tx.query(`select set_config('app.tenant_id', $1, true)`, [h.t2]);
      await linkPersonToLogin(tx, other);
    });
    const authEvents = async () => (await h.pg.query<{ tenant_id: string }>(`select tenant_id from event where action like 'auth.%'`)).rows.map((r) => r.tenant_id);
    // no tenant: not logged anywhere
    await authPost('/sign-in/magic-link', { email });
    expect(mail.sent).toHaveLength(1);
    expect(await authEvents()).toEqual([]);
    await app.inject({ method: 'POST', url: '/v1/auth/sign-in/magic-link', headers: { ...headers(), 'x-vdrkit-tenant': h.t2 }, payload: { email } });
    await auth.vdrkit.signInMailSettled();
    expect(await authEvents()).toEqual([h.t2]);
  });

  it('restricts link writes to the tenant', async () => {
    await expect(h.app((tx) => tx.query(`insert into auth_person (tenant_id, person_id, email) values ($1, $2, 'x@y.z')`, [h.t2, h.person.anika])))
      .rejects.toThrow();
  });
});
