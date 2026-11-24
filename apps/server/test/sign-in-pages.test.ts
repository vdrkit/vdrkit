// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Channel, OutgoingMessage } from '@vdrkit/core';
import { buildApp } from '../src/index.js';
import { DevHeaderAuthenticator } from '../src/auth.js';
import { BetterAuthAuthenticator, betterAuthRoutes, createBetterAuth, signInLinkFor, type VdrAuth } from '../src/auth/better-auth.js';
import { sessionRoutes } from '../src/auth/session-routes.js';
import { linkPersonToLogin } from '../src/auth/person-link.js';
import { poolFromPGlite } from '../src/auth/pool.js';
import { errorReference } from '../src/problems.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';


const URL_ = 'https://dataroom.example.com';
const SECRET = 'test-secret-test-secret-test-secret-0123456789';

class FakeMailer implements Channel {
  readonly name = 'fake';
  sent: OutgoingMessage[] = [];
  async send(msg: OutgoingMessage) {
    this.sent.push(msg);
    return { status: 'accepted' as const, providerMessageId: `m${this.sent.length}` };
  }
  last() { return this.sent[this.sent.length - 1]!; }
}

let h: Heron;
let app: FastifyInstance;
let dev: FastifyInstance;
let mail: FakeMailer;
let auth: VdrAuth;

beforeEach(async () => {
  h = await heron();
  mail = new FakeMailer();
  auth = createBetterAuth({ db: h.db, pool: h.appPool ?? poolFromPGlite(h.pg), secret: SECRET, publicUrl: URL_, mailer: mail, dbRole: 'vdrkit_app', builtInRateLimit: false });
  app = await buildApp({
    db: h.db, auth: new BetterAuthAuthenticator(auth, h.db, 'vdrkit_app'), dbRole: 'vdrkit_app', now: () => T.at,
    mailer: mail, publicUrl: URL_, plugins: [betterAuthRoutes(auth, URL_), sessionRoutes(auth)], rateLimit: false,
  });
  dev = await buildApp({
    db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at, mailer: mail, publicUrl: URL_, rateLimit: false,
    plugins: [async (a) => { a.get('/v1/test/fault', { schema: { hide: true } }, async () => { throw new Error('boom'); }); }],
  });
});
afterEach(async () => {
  await app.close();
  await dev.close();
  await h.pg.close();
});

const as = (person: string) => ({ 'x-dev-tenant': h.t1, 'x-dev-person': person });
const emailOf = async (person: string) => (await h.pg.query<{ email: string }>(`select email from person where id = $1`, [person])).rows[0]!.email;
const headers = (cookie?: string) => ({ origin: URL_, ...(cookie ? { cookie } : {}) });
const authPost = (path: string, payload: unknown, cookie?: string) =>
  app.inject({ method: 'POST', url: `/v1/auth${path}`, headers: headers(cookie), payload: payload as object })
    .then(async (r) => { await auth.vdrkit.signInMailSettled(); return r; });
const cookiesOf = (res: { headers: Record<string, unknown> }) => {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return list.map((c) => c.split(';')[0]!).filter((c) => !c.endsWith('=')).join('; ');
};

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

describe('sign-in email', () => {
  it('sends the link and code in one email', async () => {
    await h.app((tx) => linkPersonToLogin(tx, h.person.jan));
    const email = await emailOf(h.person.jan);
    expect((await authPost('/sign-in/magic-link', { email, callbackURL: `/rooms/${h.ws}/documents` })).statusCode).toBe(200);
    expect(mail.sent).toHaveLength(1);
    const first = mail.last();
    expect(first.subject).toMatch(/^Your sign-in code: \d{6}$/);
    const text = first.text!;
    const link = new URL(/https:\/\/\S+/.exec(text)![0]);
    expect(link.origin + link.pathname).toBe(`${URL_}/sign-in/link`);
    expect(link.searchParams.get('next')).toBe(`/rooms/${h.ws}/documents`);
    expect(text).toContain('The link and the code work once, within 15 minutes.');

    await authPost('/sign-in/magic-link', { email });
    expect(mail.sent).toHaveLength(2);
    const old = await app.inject({ method: 'GET', url: `/v1/auth/magic-link/verify?token=${link.searchParams.get('token')}`, headers: headers() });
    expect(old.statusCode).toBe(302);
    const oldCode = /(\d{3}) ?(\d{3})/.exec(first.subject)!.slice(1).join('');
    const newCode = /(\d{3}) ?(\d{3})/.exec(mail.last().subject)!.slice(1).join('');
    if (oldCode !== newCode) expect((await authPost('/sign-in/email-otp', { email, otp: oldCode })).statusCode).toBe(400);
    const ok = await authPost('/sign-in/email-otp', { email, otp: newCode });
    expect(ok.statusCode).toBe(200);
  });

  it('sends nothing to an unknown address', async () => {
    const res = await authPost('/sign-in/magic-link', { email: 'nobody@example.org' });
    expect(res.statusCode).toBe(200);
    expect(mail.sent).toHaveLength(0);
  });

  it('keeps next on this site', () => {
    const verify = (cb: string) => `${URL_}/v1/auth/magic-link/verify?token=t&callbackURL=${encodeURIComponent(cb)}`;
    expect(new URL(signInLinkFor(URL_, verify('/rooms/x'), 't')).searchParams.get('next')).toBe('/rooms/x');
    for (const cb of ['//evil.example', 'https://evil.example/', '/\\evil.example', '/']) {
      expect(new URL(signInLinkFor(URL_, verify(cb), 't')).searchParams.get('next')).toBeNull();
    }
  });
});

describe('authenticator step', () => {
  it('says whether the browser may be trusted', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/public/sign-in/pending', headers: headers() })).statusCode).toBe(404);
    await h.app((tx) => linkPersonToLogin(tx, h.person.jan));
    await h.pg.query(`update workspace set trusted_browser_days = 14`);
    const email = await emailOf(h.person.jan);
    await authPost('/sign-in/magic-link', { email });
    const code = /(\d{3}) ?(\d{3})/.exec(mail.last().subject)!.slice(1).join('');
    const session = cookiesOf(await authPost('/sign-in/email-otp', { email, otp: code }));
    const enable = await authPost('/two-factor/enable', {}, session);
    const secret = new URL(enable.json().totpURI).searchParams.get('secret')!;
    expect((await authPost('/two-factor/verify-totp', { code: totp(secret) }, session)).statusCode).toBe(200);

    await authPost('/sign-in/magic-link', { email });
    const code2 = /(\d{3}) ?(\d{3})/.exec(mail.last().subject)!.slice(1).join('');
    const pending = await authPost('/sign-in/email-otp', { email, otp: code2 });
    expect(pending.json()).toMatchObject({ twoFactorRedirect: true });
    const res = await app.inject({ method: 'GET', url: '/v1/public/sign-in/pending', headers: headers(cookiesOf(pending)) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ allowTrustedBrowser: true, trustedBrowserDays: 14 });
  });
});

describe('invitation link', () => {
  async function invite() {
    const res = await dev.inject({ method: 'POST', url: `/v1/workspaces/${h.ws}/invitations`, headers: as(h.person.anika),
      payload: { groupId: h.group.a, people: [{ email: 'sven@bidder-a.example' }], role: 'member', accessExpiresAt: '2027-01-29T16:00:00.000Z' } });
    expect(res.statusCode).toBe(201);
    return /\/invite\/(\S+)/.exec(mail.last().text!)![1]!;
  }

  it('shows invitation details or 410', async () => {
    const token = await invite();
    const res = await app.inject({ method: 'GET', url: `/v1/public/invitations/${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      workspaceId: h.ws, roomName: 'Project Heron', runBy: 'Quillmont Advisory', onBehalfOf: 'Seller', groupName: 'Bidder A',
      accessEndsAt: '2027-01-29T16:00:00.000Z', email: 'sven@bidder-a.example', givenName: null, company: null, accepted: false,
    });
    expect(res.json().invitedBy).toBeTruthy();

    const wrong = await app.inject({ method: 'GET', url: `/v1/public/invitations/${h.t1}.${'x'.repeat(43)}` });
    const garbage = await app.inject({ method: 'GET', url: '/v1/public/invitations/not-a-token' });
    expect(wrong.statusCode).toBe(410);
    expect(garbage.body).toBe(wrong.body);

    expect((await app.inject({ method: 'POST', url: '/v1/public/invitations/accept',
      payload: { token, givenName: 'Sven', familyName: 'Lund', company: 'Skjolvik Partners' } })).statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: `/v1/public/invitations/${token}` });
    expect(after.json()).toEqual({
      workspaceId: h.ws, roomName: '', runBy: '', onBehalfOf: null, invitedBy: null, groupName: '', accessEndsAt: null, roomTimeZone: 'UTC',
      email: 'sven@bidder-a.example', givenName: null, familyName: null, company: null, jobTitle: null, accepted: true, requireTwoFactor: true,
    });
  });
});

describe('NDA', () => {
  it('returns the agreement and its PDF', async () => {
    await h.pg.query(`delete from acceptance where person_id = $1`, [h.person.jan]);
    const res = await dev.inject({ method: 'GET', url: `/v1/workspaces/${h.ws}/nda`, headers: as(h.person.jan) });
    expect(res.statusCode).toBe(200);
    const nda = res.json();
    expect(nda).toMatchObject({ mustAccept: true, versionNo: 1, name: 'Project Heron NDA', roomName: 'Project Heron', runBy: 'Quillmont Advisory',
      sellerName: 'Seller', pages: 1 });
    expect(nda.publishedAt).toBeTruthy();
    expect(nda.contactName).toBeTruthy();

    const pdf = await dev.inject({ method: 'GET', url: `/v1/workspaces/${h.ws}/nda/pdf`, headers: as(h.person.jan) });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const other = await dev.inject({ method: 'GET', url: `/v1/workspaces/${h.ws}/nda/pdf`, headers: { 'x-dev-tenant': h.t1, 'x-dev-person': '00000000-0000-4000-8000-000000000000' } });
    expect(other.statusCode).toBe(404);
  });
});

describe('my rooms', () => {
  it('names the seller and a room admin', async () => {
    const res = await dev.inject({ method: 'GET', url: '/v1/me/workspaces', headers: as(h.person.jan) });
    expect(res.statusCode).toBe(200);
    const room = res.json().items[0];
    expect(room).toMatchObject({ name: 'Project Heron', onBehalfOf: 'Seller' });
    expect(room.contactName).toBeTruthy();
    expect(room).toHaveProperty('stateSince');
  });
});

describe('server errors', () => {
  it('should include a reference in 500s', async () => {
    const res = await dev.inject({ method: 'GET', url: '/v1/test/fault', headers: { ...as(h.person.jan), 'x-request-id': 'req-123' } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ title: 'Something went wrong', reference: errorReference('req-123') });
    expect(errorReference('req-123')).toMatch(/^[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
    expect(res.body).not.toContain('boom');
  });
});
