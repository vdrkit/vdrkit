// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Channel, OutgoingMessage } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { BetterAuthAuthenticator, betterAuthRoutes, createBetterAuth, type VdrAuth } from '../src/auth/better-auth.js';
import { sessionRoutes } from '../src/auth/session-routes.js';
import { linkPersonToLogin } from '../src/auth/person-link.js';
import { poolFromPGlite } from '../src/auth/pool.js';
import { ROTATE_AFTER_MS, ROTATION_GRACE_MS } from '../src/auth/sessions.js';
import { heron, type Heron } from '../../../packages/core/test/fixture.js';

const URL_ = 'https://dataroom.example.com';
const SECRET = 'test-secret-test-secret-test-secret-0123456789';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

class FakeMailer implements Channel {
  readonly name = 'fake';
  sent: OutgoingMessage[] = [];
  async send(msg: OutgoingMessage) {
    this.sent.push(msg);
    return { status: 'accepted' as const, providerMessageId: `m${this.sent.length}` };
  }
  last() { return this.sent[this.sent.length - 1]!; }
}

class Browser {
  jar = new Map<string, string>();
  constructor(readonly ua = CHROME) {}
  header() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  take(res: { headers: Record<string, unknown> }) {
    const raw = res.headers['set-cookie'];
    for (const c of Array.isArray(raw) ? raw : raw ? [String(raw)] : []) {
      const [pair, ...attrs] = String(c).split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (!value || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a))) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return res;
  }
  sessionToken() { return [...this.jar].find(([k]) => k.endsWith('session_token'))?.[1]; }
  clone() { const b = new Browser(this.ua); b.jar = new Map(this.jar); return b; }
}

let h: Heron;
let app: FastifyInstance;
let mail: FakeMailer;
let auth: VdrAuth;
let clock: Date;

beforeEach(async () => {
  h = await heron();
  mail = new FakeMailer();
  clock = new Date();
  auth = createBetterAuth({ db: h.db, pool: h.appPool ?? poolFromPGlite(h.pg), secret: SECRET, publicUrl: URL_, mailer: mail,
    dbRole: 'vdrkit_app', builtInRateLimit: false, now: () => clock });
  app = await buildApp({
    db: h.db, auth: new BetterAuthAuthenticator(auth, h.db, 'vdrkit_app'), dbRole: 'vdrkit_app', now: () => clock,
    mailer: mail, publicUrl: URL_, plugins: [betterAuthRoutes(auth, URL_), sessionRoutes(auth)], rateLimit: false,
  });
});
afterEach(async () => {
  await app.close();
  await h.pg.close();
});

const later = (ms: number) => { clock = new Date(clock.getTime() + ms); };
const emailOf = async (person: string) => (await h.pg.query<{ email: string }>(`select email from person where id = $1`, [person])).rows[0]!.email;
const link = (person: string) => h.app((tx) => linkPersonToLogin(tx, person));
const req = (b: Browser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin: URL_, 'user-agent': b.ua, ...(b.jar.size ? { cookie: b.header() } : {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) })
    .then(async (r) => { await auth.vdrkit.signInMailSettled(); return b.take(r); });
const myRooms = (b: Browser) => req(b, 'GET', '/v1/me/workspaces');
const policyOf = (b: Browser) => req(b, 'GET', '/v1/me/sign-in-policy');
const settings = (b: Browser, body: unknown) => req(b, 'PATCH', `/v1/workspaces/${h.ws}/settings`, body);

async function codeStep(b: Browser, email: string) {
  expect((await req(b, 'POST', '/v1/auth/email-otp/send-verification-otp', { email, type: 'sign-in' })).statusCode).toBe(200);
  const otp = /\b(\d{6})\b/.exec(mail.last().subject.replaceAll(' ', ''))![1]!;
  return req(b, 'POST', '/v1/auth/sign-in/email-otp', { email, otp });
}

// RFC 6238 TOTP
function totp(base32: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of base32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((x) => parseInt(x, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const o = mac[mac.length - 1]! & 0xf;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
const secretOf = (uri: string) => new URL(uri).searchParams.get('secret')!;
const otherCode = (secret: string) => totp(secret, Date.now() + 10 * 60_000);

async function signUpWithTotp(b: Browser, email: string): Promise<string> {
  expect((await codeStep(b, email)).statusCode).toBe(200);
  const enable = await req(b, 'POST', '/v1/auth/two-factor/enable', {});
  expect(enable.statusCode).toBe(200);
  const secret = secretOf(enable.json().totpURI);
  expect((await req(b, 'POST', '/v1/auth/two-factor/verify-totp', { code: totp(secret) })).statusCode).toBe(200);
  return secret;
}

async function signIn(b: Browser, email: string, secret: string, trustDevice = false) {
  const first = await codeStep(b, email);
  if (!first.json().twoFactorRedirect) return first;
  return req(b, 'POST', '/v1/auth/two-factor/verify-totp', { code: totp(secret), trustDevice });
}

async function events(action: string) {
  return (await h.pg.query<{ data: any; workspace_id: string | null; resource_id: string | null }>(
    `select data, workspace_id, resource_id from event where action = $1 order by seq`, [action])).rows;
}

async function secondRoom(person: string, cols: Record<string, unknown>) {
  const keys = Object.keys(cols);
  const ws = (await h.pg.query<{ id: string }>(
    `insert into workspace (tenant_id, name, state${keys.map((k) => `, ${k}`).join('')})
     values ($1, 'Project Osprey', 'active'${keys.map((_, i) => `, $${i + 2}`).join('')}) returning id`, [h.t1, ...Object.values(cols)])).rows[0]!.id;
  const party = (await h.pg.query<{ id: string }>(`insert into party (tenant_id, workspace_id, name, kind) values ($1, $2, 'Bidder', 'bidder') returning id`, [h.t1, ws])).rows[0]!.id;
  const group = (await h.pg.query<{ id: string }>(`insert into groups (tenant_id, workspace_id, party_id, name) values ($1, $2, $3, 'Bidder') returning id`, [h.t1, ws, party])).rows[0]!.id;
  await h.pg.query(`insert into membership (tenant_id, person_id, group_id) values ($1, $2, $3)`, [h.t1, person, group]);
  return ws;
}

describe('sign-in room settings', () => {
  it('has secure defaults', async () => {
    const dev = { 'x-dev-person': h.person.anika, 'x-dev-tenant': h.t1 };
    const devApp = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => clock, rateLimit: false });
    try {
      const get = await devApp.inject({ method: 'GET', url: `/v1/workspaces/${h.ws}/settings`, headers: dev });
      expect(get.json()).toMatchObject({ requireTwoFactor: true, allowTrustedBrowser: true, trustedBrowserDays: 30, idleSignOutMinutes: 240 });
      const patch = await devApp.inject({ method: 'PATCH', url: `/v1/workspaces/${h.ws}/settings`, headers: dev,
        payload: { requireTwoFactor: false, allowTrustedBrowser: false, trustedBrowserDays: 7, idleSignOutMinutes: 1440 } });
      expect(patch.statusCode).toBe(200);
      expect(patch.json()).toMatchObject({ requireTwoFactor: false, allowTrustedBrowser: false, trustedBrowserDays: 7, idleSignOutMinutes: 1440 });
      const ev = await events('workspace.settings_changed');
      expect(ev).toHaveLength(1);
      expect(ev[0]!.data.before).toMatchObject({ requireTwoFactor: true, trustedBrowserDays: 30, idleSignOutMinutes: 240 });
      expect(ev[0]!.data.after).toMatchObject({ requireTwoFactor: false, trustedBrowserDays: 7, idleSignOutMinutes: 1440 });
    } finally { await devApp.close(); }
  });

  it('rejects bad periods', async () => {
    const devApp = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => clock, rateLimit: false });
    try {
      const patch = (payload: object) => devApp.inject({ method: 'PATCH', url: `/v1/workspaces/${h.ws}/settings`,
        headers: { 'x-dev-person': h.person.anika, 'x-dev-tenant': h.t1 }, payload });
      for (const bad of [{ trustedBrowserDays: 0 }, { trustedBrowserDays: 91 }, { trustedBrowserDays: 2.5 }, { idleSignOutMinutes: 45 }, { idleSignOutMinutes: 0 }]) {
        const res = await patch(bad);
        expect(res.statusCode).toBe(400);
        expect(res.headers['content-type']).toContain('application/problem+json');
      }
      expect((await patch({ trustedBrowserDays: 90, idleSignOutMinutes: 30 })).statusCode).toBe(200);
      const bidder = await devApp.inject({ method: 'PATCH', url: `/v1/workspaces/${h.ws}/settings`,
        headers: { 'x-dev-person': h.person.jan, 'x-dev-tenant': h.t1 }, payload: { requireTwoFactor: false } });
      expect(bidder.statusCode).toBe(403);
    } finally { await devApp.close(); }
  });
});

describe('OpenAPI', () => {
  it('documents the sign-in routes', async () => {
    await app.ready();
    const doc = app.swagger() as any;
    for (const path of ['/v1/me/sign-in-policy', '/v1/me/trusted-browsers', '/v1/me/trusted-browsers/{id}', '/v1/me/sign-out-everywhere',
      '/v1/me/two-factor/new-phone', '/v1/me/two-factor/new-phone/confirm', '/v1/workspaces/{ws}/people/{personId}/reset-two-factor']) {
      expect(Object.keys(doc.paths)).toContain(path);
    }
    expect(Object.keys(doc.paths['/v1/workspaces/{ws}/settings'].patch.requestBody.content['application/json'].schema.properties))
      .toEqual(expect.arrayContaining(['requireTwoFactor', 'allowTrustedBrowser', 'trustedBrowserDays', 'idleSignOutMinutes']));
  });
});

describe('effective sign-in policy', () => {
  it('uses the strictest room', async () => {
    await secondRoom(h.person.jan, { trusted_browser_days: 5, idle_sign_out_minutes: 30 });
    await h.pg.query(`update workspace set require_two_factor = false where id = $1`, [h.ws]);
    await link(h.person.jan);
    const b = new Browser();
    expect((await codeStep(b, await emailOf(h.person.jan))).statusCode).toBe(200);
    const res = await policyOf(b);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ requireTwoFactor: true, allowTrustedBrowser: true, trustedBrowserDays: 5, idleSignOutMinutes: 30,
      rooms: 2, twoFactorEnabled: false, twoFactorSetUpAt: null, twoFactorSetupRequired: true });
  });
});

describe('two-factor set-up date', () => {
  it('is set by the first correct code', async () => {
    await h.pg.query(`update workspace set require_two_factor = false where id = $1`, [h.ws]);
    await link(h.person.jan);
    const email = await emailOf(h.person.jan);
    const plain = new Browser();
    expect((await codeStep(plain, email)).statusCode).toBe(200);
    expect((await policyOf(plain)).json()).toMatchObject({ twoFactorEnabled: false, twoFactorSetUpAt: null });

    const dbNow = new Date('2026-11-03T09:30:00.000Z');
    await h.pin(dbNow);
    const b = new Browser();
    await signUpWithTotp(b, email);
    expect((await policyOf(b)).json().twoFactorSetUpAt).toBe(dbNow.toISOString());
  });
});

describe('two-factor enforcement', () => {
  it('should only allow set-up until an authenticator is added', async () => {
    await link(h.person.jan);
    const b = new Browser();
    expect((await codeStep(b, await emailOf(h.person.jan))).statusCode).toBe(200);
    for (const url of ['/v1/me/workspaces', `/v1/workspaces/${h.ws}/nodes`, `/v1/workspaces/${h.ws}/nodes/${h.node.aud1}`, '/v1/me/trusted-browsers']) {
      const res = await req(b, 'GET', url);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ type: 'https://vdrkit.com/problems/two-factor-setup-required', reason: 'two_factor_setup_required' });
    }
    expect((await policyOf(b)).json().twoFactorSetupRequired).toBe(true);
    const enable = await req(b, 'POST', '/v1/auth/two-factor/enable', {});
    expect(enable.statusCode).toBe(200);
    expect(Object.keys(enable.json()).sort()).toEqual(['method', 'totpURI']);
    expect((await req(b, 'POST', '/v1/auth/two-factor/verify-totp', { code: totp(secretOf(enable.json().totpURI)) })).statusCode).toBe(200);
    expect((await myRooms(b)).statusCode).toBe(200);
    expect((await policyOf(b)).json()).toMatchObject({ twoFactorEnabled: true, twoFactorSetupRequired: false });
  });

  it('allows email alone when no room requires two-factor', async () => {
    await h.pg.query(`update workspace set require_two_factor = false where id = $1`, [h.ws]);
    await link(h.person.jan);
    const b = new Browser();
    await codeStep(b, await emailOf(h.person.jan));
    expect((await myRooms(b)).statusCode).toBe(200);
    await h.pg.query(`update workspace set require_two_factor = true where id = $1`, [h.ws]);
    expect((await myRooms(b)).statusCode).toBe(403);
  });

  it('disables ways around the authenticator app', async () => {
    await link(h.person.jan);
    const b = new Browser();
    await signUpWithTotp(b, await emailOf(h.person.jan));
    for (const path of ['/two-factor/disable', '/two-factor/verify-backup-code', '/two-factor/generate-backup-codes', '/two-factor/send-otp', '/two-factor/verify-otp']) {
      expect((await req(b, 'POST', `/v1/auth${path}`, { code: '123456' })).statusCode).toBe(404);
    }
    const on = await h.pg.query<{ on: boolean }>(`select two_factor_enabled as on from auth_user`);
    expect(on.rows[0]!.on).toBe(true);
  });

  it('has no password reset', async () => {
    await link(h.person.jan);
    const email = await emailOf(h.person.jan);
    const b = new Browser();
    await signUpWithTotp(b, email);
    const before = mail.sent.length;
    for (const path of ['/email-otp/request-password-reset', '/forget-password/email-otp']) {
      expect((await req(new Browser(), 'POST', `/v1/auth${path}`, { email })).statusCode, path).toBe(404);
    }
    expect((await req(new Browser(), 'POST', '/v1/auth/email-otp/reset-password', { email, otp: '123456', password: 'correct horse battery staple' })).statusCode).toBe(404);
    for (const path of ['/email-otp/request-email-change', '/email-otp/change-email']) {
      expect((await req(b, 'POST', `/v1/auth${path}`, { newEmail: 'jan@elsewhere.example', otp: '123456' })).statusCode, path).toBe(404);
    }
    await auth.vdrkit.signInMailSettled();
    expect(mail.sent.length).toBe(before);
    expect((await h.pg.query(`select 1 from auth_account where provider_id = 'credential'`)).rows).toEqual([]);
  });

  it('hides unused Better Auth routes', async () => {
    await link(h.person.jan);
    const b = new Browser();
    await signUpWithTotp(b, await emailOf(h.person.jan));
    const sessions = await req(b, 'GET', '/v1/auth/list-sessions');
    expect(sessions.statusCode).toBe(404);
    expect(sessions.body).not.toMatch(/token/i);
    for (const [path, body] of [
      ['/revoke-sessions', {}], ['/revoke-other-sessions', {}], ['/update-user', { name: 'Someone else' }],
      ['/change-password', { currentPassword: 'x', newPassword: 'correct horse battery staple' }], ['/delete-user', {}],
    ] as const) {
      expect((await req(b, 'POST', `/v1/auth${path}`, body)).statusCode, path).toBe(404);
    }
    expect((await h.pg.query(`select name from auth_user where name = 'Someone else'`)).rows).toEqual([]);
    expect((await req(b, 'GET', '/v1/auth/get-session')).statusCode).toBe(200);
  });

  it('never returns the TOTP secret', async () => {
    await link(h.person.jan);
    const b = new Browser();
    await signUpWithTotp(b, await emailOf(h.person.jan));
    const r = await req(b, 'POST', '/v1/auth/two-factor/get-totp-uri', {});
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toMatch(/otpauth|secret=/i);
    await link(h.person.mei);
    const c = new Browser();
    await codeStep(c, await emailOf(h.person.mei));
    expect((await req(c, 'POST', '/v1/auth/two-factor/enable', {})).statusCode).toBe(200);
    const early = await req(c, 'POST', '/v1/auth/two-factor/get-totp-uri', {});
    expect(early.statusCode).toBe(404);
    expect(early.body).not.toMatch(/otpauth|secret=/i);
  });
});

describe('sign-in emails', () => {
  it('are single use and expire', async () => {
    await h.pg.query(`update workspace set require_two_factor = false where id = $1`, [h.ws]);
    await link(h.person.jan);
    const email = await emailOf(h.person.jan);
    const b = new Browser();

    expect((await req(b, 'POST', '/v1/auth/email-otp/send-verification-otp', { email, type: 'sign-in' })).statusCode).toBe(200);
    const otp = /\b(\d{6})\b/.exec(mail.last().subject.replaceAll(' ', ''))![1]!;
    const codeMail = mail.last();
    const exp = await h.pg.query<{ s: number }>(`select extract(epoch from expires_at - created_at)::int as s from auth_verification order by created_at desc limit 1`);
    expect(Math.abs(exp.rows[0]!.s - 15 * 60)).toBeLessThan(5);
    expect((await req(b, 'POST', '/v1/auth/sign-in/email-otp', { email, otp })).statusCode).toBe(200);
    expect((await req(new Browser(), 'POST', '/v1/auth/sign-in/email-otp', { email, otp })).statusCode).toBe(400);

    expect((await req(b, 'POST', '/v1/auth/sign-in/magic-link', { email })).statusCode).toBe(200);
    const linkMail = mail.last();
    const url = new URL(/https:\/\/\S+/.exec(linkMail.text!)![0]);
    const linkExp = await h.pg.query<{ s: number }>(`select extract(epoch from expires_at - created_at)::int as s from auth_verification order by created_at desc limit 1`);
    expect(Math.abs(linkExp.rows[0]!.s - 15 * 60)).toBeLessThan(5);
    const verify = `/v1/auth/magic-link/verify?token=${url.searchParams.get('token')}`;
    const first = new Browser();
    expect((await req(first, 'GET', verify)).statusCode).toBe(200);
    expect((await myRooms(first)).statusCode).toBe(200);
    const second = new Browser();
    await req(second, 'GET', verify);
    expect((await myRooms(second)).statusCode).toBe(401);

    for (const m of [codeMail, linkMail]) {
      const text = [m.subject, m.text!, m.html!].join('\n');
      expect(text).toContain('within 15 minutes');
      expect(text).not.toMatch(/Project Heron|Heron|Osprey|Bidder/);
    }
  });

  it('give one sign-in per email', async () => {
    await h.pg.query(`update workspace set require_two_factor = false where id = $1`, [h.ws]);
    await link(h.person.jan);
    const email = await emailOf(h.person.jan);
    const oneEmail = async () => {
      expect((await req(new Browser(), 'POST', '/v1/auth/sign-in/magic-link', { email })).statusCode).toBe(200);
      const m = mail.last();
      const otp = /(\d{3}) ?(\d{3})/.exec(m.subject)!.slice(1).join('');
      const token = new URL(/https:\/\/\S+/.exec(m.text!)![0]).searchParams.get('token')!;
      return { otp, verify: `/v1/auth/magic-link/verify?token=${token}` };
    };

    const a = await oneEmail();
    const byCode = new Browser();
    expect((await req(byCode, 'POST', '/v1/auth/sign-in/email-otp', { email, otp: a.otp })).statusCode).toBe(200);
    const linkAfterCode = new Browser();
    await req(linkAfterCode, 'GET', a.verify);
    expect((await myRooms(linkAfterCode)).statusCode).toBe(401);

    const b = await oneEmail();
    const byLink = new Browser();
    expect((await req(byLink, 'GET', b.verify)).statusCode).toBe(200);
    expect((await myRooms(byLink)).statusCode).toBe(200);
    expect((await req(new Browser(), 'POST', '/v1/auth/sign-in/email-otp', { email, otp: b.otp })).statusCode).toBe(400);

    const c = await oneEmail();
    const wrong = c.otp === '000000' ? '111111' : '000000';
    expect((await req(new Browser(), 'POST', '/v1/auth/sign-in/email-otp', { email, otp: wrong })).statusCode).toBe(400);
    const stillLink = new Browser();
    expect((await req(stillLink, 'GET', c.verify)).statusCode).toBe(200);
    expect((await myRooms(stillLink)).statusCode).toBe(200);
  });
});

describe('trusted browsers', () => {
  async function trusted() {
    await link(h.person.jan);
    const email = await emailOf(h.person.jan);
    const setup = new Browser();
    const secret = await signUpWithTotp(setup, email);
    const b = new Browser();
    const res = await signIn(b, email, secret, true);
    expect(res.statusCode).toBe(200);
    return { email, secret, b };
  }

  it('should skip the app on a trusted browser', async () => {
    const { email, b } = await trusted();
    const again = await codeStep(b, email);
    expect(again.json().twoFactorRedirect).toBeUndefined();
    expect((await myRooms(b)).statusCode).toBe(200);
    expect((await codeStep(new Browser(), email)).json().twoFactorRedirect).toBe(true);
  });

  it('does not extend the trust period on use', async () => {
    const { email, b } = await trusted();
    later(20 * DAY);
    expect((await codeStep(b, email)).json().twoFactorRedirect).toBeUndefined();
    later(11 * DAY);
    expect((await codeStep(b, email)).json().twoFactorRedirect).toBe(true);
  });

  it('follows the strictest room', async () => {
    const { email, secret, b } = await trusted();
    const osprey = await secondRoom(h.person.jan, { trusted_browser_days: 3 });
    later(4 * DAY);
    expect((await codeStep(b, email)).json().twoFactorRedirect).toBe(true);

    await h.pg.query(`update workspace set state = 'deleted' where id = $1`, [osprey]);
    const c = new Browser();
    expect((await signIn(c, email, secret, true)).statusCode).toBe(200);
    expect((await codeStep(c, email)).json().twoFactorRedirect).toBeUndefined();
    await h.pg.query(`update workspace set allow_trusted_browser = false where id = $1`, [h.ws]);
    expect((await codeStep(c, email)).json().twoFactorRedirect).toBe(true);
  });

  it('ignores the trust box if not allowed', async () => {
    await h.pg.query(`update workspace set allow_trusted_browser = false where id = $1`, [h.ws]);
    const { email, b } = await trusted();
    expect((await codeStep(b, email)).json().twoFactorRedirect).toBe(true);
    expect((await h.pg.query(`select 1 from auth_trusted_browser`)).rows).toHaveLength(0);
  });

  it('lists and revokes my trusted browsers', async () => {
    const { email, secret, b } = await trusted();
    const phone = new Browser(IPHONE);
    expect((await signIn(phone, email, secret, true)).statusCode).toBe(200);
    const list = await req(b, 'GET', '/v1/me/trusted-browsers');
    expect(list.statusCode).toBe(200);
    const items = list.json().items as { id: string; browser: string; thisBrowser: boolean; trustedUntil: string }[];
    expect(items.map((i) => [i.browser, i.thisBrowser]).sort()).toEqual([['Chrome on Windows', true], ['Safari on iPhone', false]]);
    expect(new Date(items[0]!.trustedUntil).getTime() - clock.getTime()).toBeLessThanOrEqual(30 * DAY);

    const iphone = items.find((i) => !i.thisBrowser)!;
    expect((await req(b, 'DELETE', `/v1/me/trusted-browsers/${iphone.id}`)).statusCode).toBe(204);
    expect((await codeStep(phone, email)).json().twoFactorRedirect).toBe(true);
    expect((await events('auth.trusted_browser_removed'))[0]!.data).toMatchObject({ person_id: h.person.jan, browser: 'Safari on iPhone' });
  });

  it("never exposes another person's browsers", async () => {
    const { b } = await trusted();
    const janBrowser = (await req(b, 'GET', '/v1/me/trusted-browsers')).json().items[0].id;
    await link(h.person.mei);
    const mei = new Browser();
    await signUpWithTotp(mei, await emailOf(h.person.mei));
    expect((await req(mei, 'GET', '/v1/me/trusted-browsers')).json().items).toEqual([]);
    expect((await req(mei, 'DELETE', `/v1/me/trusted-browsers/${janBrowser}`)).statusCode).toBe(404);
    expect((await req(b, 'GET', '/v1/me/trusted-browsers')).json().items).toHaveLength(1);
  });
});

describe('sign-out after inactivity', () => {
  async function signedIn() {
    await link(h.person.jan);
    const b = new Browser();
    await signUpWithTotp(b, await emailOf(h.person.jan));
    expect((await myRooms(b)).statusCode).toBe(200);
    return b;
  }

  it('signs out after the idle time and logs it', async () => {
    const b = await signedIn();
    later(241 * MIN);
    const res = await myRooms(b);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ type: 'https://vdrkit.com/problems/signed-out-inactive' });
    expect(res.json().detail).toContain('4 hours');
    expect((await events('auth.signed_out_inactive'))[0]!.data).toMatchObject({ person_id: h.person.jan, idle_minutes: 240 });
    expect((await myRooms(b)).statusCode).toBe(401);
  });

  it('ends active sessions after 30 days', async () => {
    const b = await signedIn();
    const busy = async (ms: number) => {
      later(ms);
      await h.pg.query(`update auth_session set last_active_at = $1`, [new Date(clock.getTime() - MIN).toISOString()]);
    };
    await busy(30 * DAY - 120 * MIN);
    expect((await myRooms(b)).statusCode).toBe(200);
    await busy(180 * MIN);
    const res = await myRooms(b);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ type: 'https://vdrkit.com/problems/session-expired' });
    expect(res.json().detail).toContain('30 days ago');
    expect((await events('auth.signed_out_expired'))[0]!.data).toMatchObject({ person_id: h.person.jan, max_days: 30 });
    expect(await events('auth.signed_out_inactive')).toHaveLength(0);
    expect((await h.pg.query(`select 1 from auth_session`)).rows).toHaveLength(0);
    expect((await myRooms(b)).statusCode).toBe(401);
  });

  it('logs idle sign-outs on Better Auth routes', async () => {
    const b = await signedIn();
    later(241 * MIN);
    const res = await req(b, 'GET', '/v1/auth/get-session');
    expect(res.body === 'null' || res.json() === null).toBe(true);
    expect((await h.pg.query(`select 1 from auth_session`)).rows).toHaveLength(0);
    const ev = await events('auth.signed_out_inactive');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data).toMatchObject({ person_id: h.person.jan, idle_minutes: 240 });
  });

  it('deletes and logs atomically', async () => {
    const b = await signedIn();
    later(241 * MIN);
    await h.pg.query(`create function fail_idle_event() returns trigger language plpgsql as $$
      begin if new.action = 'auth.signed_out_inactive' then raise exception 'event store down'; end if; return new; end $$`);
    await h.pg.query(`create trigger fail_idle_event before insert on event for each row execute function fail_idle_event()`);
    expect((await myRooms(b)).statusCode).toBe(500);
    expect((await h.pg.query(`select 1 from auth_session`)).rows).toHaveLength(1);
    expect(await events('auth.signed_out_inactive')).toHaveLength(0);
    await h.pg.query(`drop trigger fail_idle_event on event`);
    expect((await myRooms(b)).statusCode).toBe(401);
    expect((await h.pg.query(`select 1 from auth_session`)).rows).toHaveLength(0);
    expect(await events('auth.signed_out_inactive')).toHaveLength(1);
  });

  it('resets the idle clock on every request', async () => {
    const b = await signedIn();
    for (let i = 0; i < 12; i++) {
      later(3 * 60 * MIN);
      expect((await myRooms(b)).statusCode).toBe(200);
    }
  });

  it('uses the shortest idle time', async () => {
    const b = await signedIn();
    await secondRoom(h.person.jan, { idle_sign_out_minutes: 30 });
    later(29 * MIN);
    expect((await myRooms(b)).statusCode).toBe(200);
    later(31 * MIN);
    expect((await myRooms(b)).statusCode).toBe(401);
  });

  it('applies to Better Auth routes', async () => {
    await h.pg.query(`update workspace set require_two_factor = false where id = $1`, [h.ws]);
    await link(h.person.jan);
    const b = new Browser();
    await codeStep(b, await emailOf(h.person.jan));
    later(241 * MIN);
    expect((await req(b, 'POST', '/v1/auth/two-factor/enable', {})).statusCode).toBe(401);
    const s = await req(b, 'GET', '/v1/auth/get-session');
    expect(s.json()).toBeNull();
  });
});

describe('session renewal', () => {
  it('rotates the token with a short grace period', async () => {
    await link(h.person.jan);
    const b = new Browser();
    await signUpWithTotp(b, await emailOf(h.person.jan));
    const before = b.sessionToken();
    const old = b.clone();
    later(ROTATE_AFTER_MS + MIN);
    const res = await myRooms(b);
    expect(res.statusCode).toBe(200);
    expect(b.sessionToken()).toBeDefined();
    expect(b.sessionToken()).not.toBe(before);
    later(ROTATION_GRACE_MS / 2);
    expect((await myRooms(old)).statusCode).toBe(200);
    later(ROTATION_GRACE_MS);
    expect((await myRooms(old)).statusCode).toBe(401);
    expect((await myRooms(b)).statusCode).toBe(200);
  });
});

describe('sign out everywhere', () => {
  it('should keep the current session', async () => {
    await link(h.person.jan);
    const email = await emailOf(h.person.jan);
    const a = new Browser();
    const secret = await signUpWithTotp(a, email);
    const other = new Browser(IPHONE);
    expect((await signIn(other, email, secret)).statusCode).toBe(200);
    expect((await myRooms(other)).statusCode).toBe(200);
    const res = await req(a, 'POST', '/v1/me/sign-out-everywhere');
    expect(res.json()).toEqual({ sessionsEnded: 1 });
    expect((await myRooms(other)).statusCode).toBe(401);
    expect((await myRooms(a)).statusCode).toBe(200);
    expect((await events('auth.signed_out_everywhere'))[0]!.data).toMatchObject({ person_id: h.person.jan, sessions_ended: 1 });
  });
});

describe('two-factor reset by a room admin', () => {
  it('removes the app, trusted browsers and sessions', async () => {
    await link(h.person.jan);
    await link(h.person.anika);
    const email = await emailOf(h.person.jan);
    const jan = new Browser();
    const secret = await signUpWithTotp(jan, email);
    const trustedJan = new Browser(IPHONE);
    await signIn(trustedJan, email, secret, true);
    const anika = new Browser();
    await signUpWithTotp(anika, await emailOf(h.person.anika));

    const res = await req(anika, 'POST', `/v1/workspaces/${h.ws}/people/${h.person.jan}/reset-two-factor`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ personId: h.person.jan, hadTwoFactor: true, sessionsEnded: 2, trustedBrowsersRemoved: 1 });
    expect((await myRooms(jan)).statusCode).toBe(401);
    expect((await myRooms(trustedJan)).statusCode).toBe(401);
    const ev = await events('auth.two_factor_reset');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ workspace_id: h.ws, resource_id: h.person.jan, data: { person_id: h.person.jan, had_two_factor: true } });

    const back = await codeStep(trustedJan, email);
    expect(back.json().twoFactorRedirect).toBeUndefined();
    expect((await myRooms(trustedJan)).statusCode).toBe(403);
    expect((await policyOf(trustedJan)).json().twoFactorSetupRequired).toBe(true);
    await req(trustedJan, 'POST', '/v1/auth/two-factor/enable', {}).then(async (e) => {
      expect((await req(trustedJan, 'POST', '/v1/auth/two-factor/verify-totp', { code: totp(secretOf(e.json().totpURI)) })).statusCode).toBe(200);
    });
    expect((await myRooms(trustedJan)).statusCode).toBe(200);
  });

  it('is never for yourself', async () => {
    await link(h.person.anika);
    const anika = new Browser();
    await signUpWithTotp(anika, await emailOf(h.person.anika));
    const res = await req(anika, 'POST', `/v1/workspaces/${h.ws}/people/${h.person.anika}/reset-two-factor`);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toBe('You cannot reset your own two-factor sign-in. Use Move to a new phone in your profile, or ask a site admin.');
    expect(await events('auth.two_factor_reset')).toHaveLength(0);
    expect((await myRooms(anika)).statusCode).toBe(200);
  });

  it('needs admin of the same room', async () => {
    await link(h.person.jan);
    await link(h.person.mei);
    const jan = new Browser();
    await signUpWithTotp(jan, await emailOf(h.person.jan));
    const mei = new Browser();
    await signUpWithTotp(mei, await emailOf(h.person.mei));
    expect((await req(jan, 'POST', `/v1/workspaces/${h.ws}/people/${h.person.mei}/reset-two-factor`)).statusCode).toBe(403);
    expect((await myRooms(mei)).statusCode).toBe(200);

    await link(h.person.anika);
    const anika = new Browser();
    await signUpWithTotp(anika, await emailOf(h.person.anika));
    const stranger = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Outsider', 'out@example.com') returning id`, [h.t1])).rows[0]!.id;
    const res = await req(anika, 'POST', `/v1/workspaces/${h.ws}/people/${stranger}/reset-two-factor`);
    expect(res.statusCode).toBe(404);
    expect((await events('auth.two_factor_reset'))).toHaveLength(0);
  });

  it('needs an active membership', async () => {
    await link(h.person.jan);
    await link(h.person.anika);
    const jan = new Browser();
    await signUpWithTotp(jan, await emailOf(h.person.jan));
    const anika = new Browser();
    await signUpWithTotp(anika, await emailOf(h.person.anika));
    const reset = () => req(anika, 'POST', `/v1/workspaces/${h.ws}/people/${h.person.jan}/reset-two-factor`);
    for (const change of [`status = 'approved'`, `status = 'revoked'`, `valid_to = now() - interval '1 day'`, `valid_from = now() + interval '1 day'`]) {
      await h.pg.query(`update membership set status = 'active', valid_from = '-infinity', valid_to = 'infinity' where person_id = $1`, [h.person.jan]);
      await h.pg.query(`update membership set ${change} where person_id = $1`, [h.person.jan]);
      const res = await reset();
      expect(res.statusCode).toBe(404);
    }
    const on = await h.pg.query<{ on: boolean }>(`select two_factor_enabled as on from auth_user where lower(email) = lower($1)`, [await emailOf(h.person.jan)]);
    expect(on.rows[0]!.on).toBe(true);
    expect(await events('auth.two_factor_reset')).toHaveLength(0);
  });

  it('refuses a login shared with another organisation', async () => {
    await link(h.person.jan);
    await link(h.person.anika);
    const email = await emailOf(h.person.jan);
    const jan = new Browser();
    await signUpWithTotp(jan, email);
    const anika = new Browser();
    await signUpWithTotp(anika, await emailOf(h.person.anika));
    expect((await myRooms(jan)).statusCode).toBe(200); // binds the link to the login
    const userId = (await h.pg.query<{ user_id: string }>(`select user_id from auth_person where person_id = $1`, [h.person.jan])).rows[0]!.user_id;
    expect(userId).toBeTruthy();
    const other = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Jan elsewhere', $2) returning id`, [h.t2, email])).rows[0]!.id;
    await h.pg.query(`insert into auth_person (tenant_id, person_id, email, user_id) values ($1, $2, $3, $4)`, [h.t2, other, email, userId]);

    const res = await req(anika, 'POST', `/v1/workspaces/${h.ws}/people/${h.person.jan}/reset-two-factor`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ type: 'https://vdrkit.com/problems/two-factor-reset-elsewhere' });
    expect((await h.pg.query<{ on: boolean }>(`select two_factor_enabled as on from auth_user where id = $1`, [userId])).rows[0]!.on).toBe(true);
    expect((await h.pg.query(`select 1 from auth_two_factor where user_id = $1`, [userId])).rows).toHaveLength(1);
    expect((await h.pg.query(`select 1 from auth_session where user_id = $1`, [userId])).rows.length).toBeGreaterThan(0);
    expect(await events('auth.two_factor_reset')).toHaveLength(0);

    await h.pg.query(`update auth_person set user_id = null where tenant_id = $1`, [h.t2]);
    expect((await req(anika, 'POST', `/v1/workspaces/${h.ws}/people/${h.person.jan}/reset-two-factor`)).statusCode).toBe(409);
  });

  it('leaves site admins to site admins', async () => {
    await link(h.person.jan);
    await link(h.person.anika);
    const email = await emailOf(h.person.jan);
    const jan = new Browser();
    await signUpWithTotp(jan, email);
    const anika = new Browser();
    await signUpWithTotp(anika, await emailOf(h.person.anika));
    await h.pg.query(`update person set is_site_admin = true where id = $1`, [h.person.jan]);
    const res = await req(anika, 'POST', `/v1/workspaces/${h.ws}/people/${h.person.jan}/reset-two-factor`);
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe('target_is_site_admin');
    const on = await h.pg.query<{ on: boolean }>(`select two_factor_enabled as on from auth_user where lower(email) = lower($1)`, [email]);
    expect(on.rows[0]!.on).toBe(true);
    expect((await myRooms(jan)).statusCode).toBe(200);
    expect(await events('auth.two_factor_reset')).toHaveLength(0);

    await h.pg.query(`update person set is_site_admin = true where id = $1`, [h.person.anika]);
    expect((await req(anika, 'POST', `/v1/workspaces/${h.ws}/people/${h.person.jan}/reset-two-factor`)).statusCode).toBe(200);
  });

  it('logs in every room of the person', async () => {
    const osprey = await secondRoom(h.person.jan, {});
    await link(h.person.jan);
    await link(h.person.anika);
    const jan = new Browser();
    await signUpWithTotp(jan, await emailOf(h.person.jan));
    const anika = new Browser();
    await signUpWithTotp(anika, await emailOf(h.person.anika));
    // jan is also in another room
    const refused = await req(anika, 'POST', `/v1/workspaces/${h.ws}/people/${h.person.jan}/reset-two-factor`);
    expect([refused.statusCode, refused.json().reason]).toEqual([403, 'target_in_other_room']);
    await h.pg.query(`update person set is_site_admin = true where id = $1`, [h.person.anika]);
    expect((await req(anika, 'POST', `/v1/workspaces/${h.ws}/people/${h.person.jan}/reset-two-factor`)).statusCode).toBe(200);
    const ev = await events('auth.two_factor_reset');
    expect(ev.map((e) => e.workspace_id).sort()).toEqual([h.ws, osprey].sort());
    for (const e of ev) expect(e.data).toMatchObject({ person_id: h.person.jan, reset_here: e.workspace_id === h.ws });
    expect(ev.find((e) => e.workspace_id === h.ws)!.data.reset_in_workspace_id).toBe(h.ws);
    expect(ev.find((e) => e.workspace_id === osprey)!.data).not.toHaveProperty('reset_in_workspace_id');
  });
});

describe('moving to a new phone', () => {
  it('needs codes from both phones', async () => {
    await link(h.person.jan);
    const email = await emailOf(h.person.jan);
    const b = new Browser();
    const oldSecret = await signUpWithTotp(b, email);

    const start = await req(b, 'POST', '/v1/me/two-factor/new-phone');
    expect(start.statusCode).toBe(200);
    const newSecret = secretOf(start.json().totpURI);
    expect(newSecret).not.toBe(oldSecret);

    const confirm = (oldCode: string, newCode: string) => req(b, 'POST', '/v1/me/two-factor/new-phone/confirm', { oldCode, newCode });
    const wrongOld = await confirm(otherCode(oldSecret), totp(newSecret));
    expect(wrongOld.statusCode).toBe(400);
    expect(wrongOld.json().detail).toContain('old phone');
    const wrongNew = await confirm(totp(oldSecret), otherCode(newSecret));
    expect(wrongNew.statusCode).toBe(400);
    expect(wrongNew.json().detail).toContain('new phone');
    expect((await signIn(new Browser(), email, oldSecret)).statusCode).toBe(200);

    const setUp = (await policyOf(b)).json().twoFactorSetUpAt;
    expect(setUp).not.toBeNull();
    later(2 * MIN);
    const dbNow = new Date(new Date(setUp).getTime() + 5 * 86_400_000);
    await h.pin(dbNow);
    expect((await confirm(totp(oldSecret), totp(newSecret))).statusCode).toBe(200);
    expect((await policyOf(b)).json().twoFactorSetUpAt).toBe(dbNow.toISOString());
    expect((await signIn(new Browser(), email, oldSecret)).statusCode).toBe(401);
    expect((await signIn(new Browser(), email, newSecret)).statusCode).toBe(200);
    expect(await events('auth.two_factor_moved')).toHaveLength(1);
  });

  it('restarts after five wrong codes', async () => {
    await link(h.person.jan);
    const b = new Browser();
    const oldSecret = await signUpWithTotp(b, await emailOf(h.person.jan));
    const newSecret = secretOf((await req(b, 'POST', '/v1/me/two-factor/new-phone')).json().totpURI);
    for (let i = 0; i < 5; i++) await req(b, 'POST', '/v1/me/two-factor/new-phone/confirm', { oldCode: totp(oldSecret), newCode: otherCode(newSecret) });
    const late = await req(b, 'POST', '/v1/me/two-factor/new-phone/confirm', { oldCode: totp(oldSecret), newCode: totp(newSecret) });
    expect(late.statusCode).toBe(409);

    await h.pg.query(`update workspace set require_two_factor = false where id = $1`, [h.ws]);
    await link(h.person.mei);
    const mei = new Browser();
    await codeStep(mei, await emailOf(h.person.mei));
    expect((await req(mei, 'POST', '/v1/me/two-factor/new-phone')).statusCode).toBe(400);
  });
});

describe('sign-in audit trail', () => {
  const IP = '203.0.113.18';
  const from = (b: Browser, ip: string, method: 'GET' | 'POST', url: string, payload?: unknown, extra: Record<string, string> = {}) =>
    app.inject({ method, url, remoteAddress: ip, headers: { origin: URL_, 'user-agent': b.ua, ...(b.jar.size ? { cookie: b.header() } : {}), ...extra },
      ...(payload !== undefined ? { payload: payload as object } : {}) }).then(async (r) => { await auth.vdrkit.signInMailSettled(); return b.take(r); });
  const withContext = async (action: string) => (await h.pg.query<{ workspace_id: string | null; data: any; ip: string | null; user_agent: string | null; personal: any }>(
    `select e.workspace_id, e.data, host(ec.ip) as ip, ec.user_agent, ec.personal from event e left join event_context ec on ec.event_id = e.id
      where e.action = $1 order by e.seq`, [action])).rows;
  const codeFrom = async (b: Browser, ip: string, email: string, extra: Record<string, string> = {}) => {
    expect((await from(b, ip, 'POST', '/v1/auth/email-otp/send-verification-otp', { email, type: 'sign-in' }, extra)).statusCode).toBe(200);
    return /\b(\d{6})\b/.exec(mail.last().subject.replaceAll(' ', ''))![1]!;
  };

  it('logs IP and browser', async () => {
    await h.pg.query(`update workspace set require_two_factor = false where id = $1`, [h.ws]);
    await link(h.person.jan);
    const email = await emailOf(h.person.jan);
    const b = new Browser();
    // only Fastify request.ip counts
    const spoof = { 'x-forwarded-for': '192.0.2.4', 'x-vdrkit-client-ip': '192.0.2.8' };
    const otp = await codeFrom(b, IP, email, spoof);
    expect(mail.last().text).toContain(`from Chrome on Windows, IP address ${IP}.`);
    expect(mail.last().text).not.toMatch(/1\.2\.3\.4|5\.6\.7\.8/);
    expect((await from(b, IP, 'POST', '/v1/auth/sign-in/email-otp', { email, otp }, spoof)).statusCode).toBe(200);
    const rows = await withContext('auth.signed_in');
    expect(rows.map((r) => r.workspace_id)).toEqual([null, h.ws]);
    for (const r of rows) {
      expect(r.data).toEqual({ person_id: h.person.jan, method: 'email_code' });
      expect([r.ip, r.user_agent]).toEqual([IP, CHROME]);
    }
    expect(await withContext('auth.sign_in_failed')).toEqual([]);
  });

  it('logs in every organisation when none is named', async () => {
    await h.pg.query(`update workspace set require_two_factor = false where id = $1`, [h.ws]);
    await link(h.person.jan);
    const email = await emailOf(h.person.jan);
    const other = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Jan elsewhere', $2) returning id`, [h.t2, email])).rows[0]!.id;
    await h.pg.query(`insert into auth_person (tenant_id, person_id, email) values ($1, $2, $3)`, [h.t2, other, email]);
    const b = new Browser();
    const otp = await codeFrom(b, IP, email);
    expect((await from(b, IP, 'POST', '/v1/auth/sign-in/email-otp', { email, otp })).statusCode).toBe(200);
    const rows = (await h.pg.query<{ tenant_id: string; workspace_id: string | null; person: string }>(
      `select tenant_id, workspace_id, data->>'person_id' as person from event where action = 'auth.signed_in' order by seq`)).rows;
    expect(rows.filter((r) => r.tenant_id === h.t1).map((r) => [r.workspace_id, r.person])).toEqual([[null, h.person.jan], [h.ws, h.person.jan]]);
    expect(rows.filter((r) => r.tenant_id === h.t2).map((r) => [r.workspace_id, r.person])).toEqual([[null, other]]);
  });

  it('logs two-factor sign-ins once complete', async () => {
    await h.pg.query(`insert into site_instance (tenant_id) values ($1)`, [h.t1]);
    await link(h.person.jan);
    const email = await emailOf(h.person.jan);
    const secret = await signUpWithTotp(new Browser(), email);
    const before = (await events('auth.signed_in')).length;
    const since = async () => (await events('auth.signed_in')).slice(before);

    const b = new Browser();
    const first = await codeStep(b, email);
    expect(first.json().twoFactorRedirect).toBe(true);
    expect(await since()).toEqual([]);      // the first step alone is not a sign-in
    const wrong = await req(b, 'POST', '/v1/auth/two-factor/verify-totp', { code: otherCode(secret) });
    expect(wrong.statusCode).toBeGreaterThanOrEqual(400);
    expect((await withContext('auth.sign_in_failed')).map((r) => [r.data, r.personal])).toEqual([
      [{ reason: 'wrong_authenticator_code', method: 'authenticator' }, { email }]]);
    expect((await req(b, 'POST', '/v1/auth/two-factor/verify-totp', { code: totp(secret) })).statusCode).toBe(200);
    expect((await since()).map((e) => [e.workspace_id, e.data.method])).toEqual([[null, 'authenticator'], [h.ws, 'authenticator']]);

    await h.pg.query(`update workspace set require_two_factor = false where id = $1`, [h.ws]);
    await link(h.person.mei);
    const meiEmail = await emailOf(h.person.mei);
    expect((await req(new Browser(), 'POST', '/v1/auth/sign-in/magic-link', { email: meiEmail })).statusCode).toBe(200);
    const token = new URL(/https:\/\/\S+/.exec(mail.last().text!)![0]).searchParams.get('token')!;
    await req(new Browser(), 'GET', `/v1/auth/magic-link/verify?token=${token}`);
    expect((await events('auth.signed_in')).filter((e) => e.data.person_id === h.person.mei).map((e) => [e.workspace_id, e.data])).toEqual([
      [null, { person_id: h.person.mei, method: 'email_link' }], [h.ws, { person_id: h.person.mei, method: 'email_link' }]]);
  });

  it('logs failures alike for any address', async () => {
    await h.pg.query(`insert into site_instance (tenant_id) values ($1)`, [h.t1]);
    await h.pg.query(`update workspace set require_two_factor = false where id = $1`, [h.ws]);
    await link(h.person.jan);
    const email = await emailOf(h.person.jan);
    const otp = await codeFrom(new Browser(), IP, email);
    const wrongCode = otp === '000000' ? '111111' : '000000';
    const known = await from(new Browser(), IP, 'POST', '/v1/auth/sign-in/email-otp', { email, otp: wrongCode });
    const unknown = await from(new Browser(), IP, 'POST', '/v1/auth/sign-in/email-otp', { email: 'nobody@nowhere.example', otp: wrongCode });
    expect([unknown.statusCode, unknown.json()]).toEqual([known.statusCode, known.json()]);
    expect((await req(new Browser(), 'POST', '/v1/auth/sign-in/magic-link', { email })).statusCode).toBe(200);
    const token = new URL(/https:\/\/\S+/.exec(mail.last().text!)![0]).searchParams.get('token')!;
    await req(new Browser(), 'GET', `/v1/auth/magic-link/verify?token=${token}`);
    await from(new Browser(), IP, 'GET', `/v1/auth/magic-link/verify?token=${token}`);
    await from(new Browser(), IP, 'GET', '/v1/auth/magic-link/verify?token=made-up-token');
    const rows = await withContext('auth.sign_in_failed');
    expect(rows.map((r) => [r.workspace_id, r.data.reason, r.personal?.email ?? null, r.ip])).toEqual([
      [null, 'wrong_code', email, IP],
      [null, 'wrong_code', 'nobody@nowhere.example', IP],
      [null, 'link_used_or_expired', null, IP],
      [null, 'link_used_or_expired', null, IP],
    ]);
  });

  it('shows sign-ins in Activity to room admins only', async () => {
    await h.pg.query(`update workspace set require_two_factor = false where id = $1`, [h.ws]);
    for (const p of [h.person.anika, h.person.jan, h.person.mei]) await link(p);
    const anika = new Browser();
    expect((await codeStep(anika, await emailOf(h.person.anika))).statusCode).toBe(200);
    expect((await codeStep(new Browser(), await emailOf(h.person.jan))).statusCode).toBe(200);
    const log = await req(anika, 'GET', `/v1/workspaces/${h.ws}/events?action=auth.signed_in`);
    expect(log.statusCode).toBe(200);
    const jan = log.json().items.find((e: any) => e.person?.id === h.person.jan);
    expect([jan.verb.label, jan.item, jan.detail]).toEqual(['Signed in', 'Signed in', 'Email code']);
    const mei = new Browser();
    expect((await codeStep(mei, await emailOf(h.person.mei))).statusCode).toBe(200);
    expect((await req(mei, 'GET', `/v1/workspaces/${h.ws}/events`)).statusCode).toBeGreaterThanOrEqual(403);
    const obs = (await h.pg.query<{ id: string }>(`insert into groups (tenant_id, workspace_id, party_id, name, role_template) values ($1, $2, $3, 'Heron management', 'observer') returning id`,
      [h.t1, h.ws, h.party.seller])).rows[0]!.id;
    const liesl = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Liesl van Wyk', 'liesl@drosvelt.example') returning id`, [h.t1])).rows[0]!.id;
    await h.pg.query(`insert into membership (tenant_id, person_id, group_id) values ($1, $2, $3)`, [h.t1, liesl, obs]);
    await link(liesl);
    const lb = new Browser();
    expect((await codeStep(lb, 'liesl@drosvelt.example')).statusCode).toBe(200);
    const theirs = await req(lb, 'GET', `/v1/workspaces/${h.ws}/events`);
    expect(theirs.statusCode).toBe(200);
    expect(theirs.json().items.filter((e: any) => e.action.startsWith('auth.'))).toEqual([]);
  });
});
