// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Channel, OutgoingMessage } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { API_CSP } from '../src/app.js';
import { BetterAuthAuthenticator, betterAuthRoutes, createBetterAuth, type VdrAuth } from '../src/auth/better-auth.js';
import { sessionRoutes } from '../src/auth/session-routes.js';
import { linkPersonToLogin } from '../src/auth/person-link.js';
import { poolFromPGlite } from '../src/auth/pool.js';
import { heron, type Heron } from '../../../packages/core/test/fixture.js';


const URL_ = 'https://dataroom.example.com';
const EVIL = 'https://evil.example';
const SECRET = 'test-secret-test-secret-test-secret-0123456789';

class FakeMailer implements Channel {
  readonly name = 'fake';
  sent: OutgoingMessage[] = [];
  async send(msg: OutgoingMessage) { this.sent.push(msg); return { status: 'accepted' as const, providerMessageId: `m${this.sent.length}` }; }
  last() { return this.sent[this.sent.length - 1]!; }
}

let h: Heron;
let app: FastifyInstance | null = null;
let mail: FakeMailer;
let auth: VdrAuth;
const savedEnv = { ...process.env };

beforeEach(async () => {
  h = await heron();
  mail = new FakeMailer();
  await h.pg.query(`update workspace set require_two_factor = false`);
  await h.app((tx) => linkPersonToLogin(tx, h.person.jan));
});
afterEach(async () => {
  process.env = { ...savedEnv };
  await app?.close();
  app = null;
  await h.pg.close();
});

async function production(extra: { trustedOrigins?: string[] } = {}): Promise<FastifyInstance> {
  process.env.NODE_ENV = 'production';
  delete process.env.VDRKIT_DEV_AUTH;
  // rate limits off
  auth = createBetterAuth({ db: h.db, pool: h.appPool ?? poolFromPGlite(h.pg), secret: SECRET, publicUrl: URL_, mailer: mail,
    dbRole: 'vdrkit_app', builtInRateLimit: false });
  app = await buildApp({ db: h.db, dbRole: 'vdrkit_app', mailer: mail, rateLimit: false, publicUrl: URL_, auth: new BetterAuthAuthenticator(auth, h.db, 'vdrkit_app'),
    plugins: [betterAuthRoutes(auth, URL_), sessionRoutes(auth)], ...extra });
  return app;
}

async function signInJan(a: FastifyInstance): Promise<string> {
  const email = (await h.pg.query<{ email: string }>(`select email from person where id = $1`, [h.person.jan])).rows[0]!.email;
  expect((await a.inject({ method: 'POST', url: '/v1/auth/email-otp/send-verification-otp', headers: { origin: URL_ }, payload: { email, type: 'sign-in' } })).statusCode).toBe(200);
  await auth.vdrkit.signInMailSettled();
  const otp = /(\d{3}) ?(\d{3})/.exec(mail.last().subject)!.slice(1).join('');
  const res = await a.inject({ method: 'POST', url: '/v1/auth/sign-in/email-otp', headers: { origin: URL_ }, payload: { email, otp } });
  expect(res.statusCode).toBe(200);
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw : [String(raw)]).map((c) => c.split(';')[0]!).find((c) => c.includes('session_token'))!;
}

const write = (a: FastifyInstance, headers: Record<string, string>, method: 'PUT' | 'POST' = 'PUT') =>
  a.inject({ method, url: '/v1/me/open-at-sign-in', headers: { 'content-type': 'application/json', ...headers }, payload: { workspaceId: null } });

function expectRefused(res: Awaited<ReturnType<FastifyInstance['inject']>>) {
  expect(res.statusCode).toBe(403);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(res.json()).toMatchObject({ status: 403, title: 'Not allowed', reason: 'cross_site_request' });
}

describe('Origin check', () => {
  it('allows same-origin writes', async () => {
    const a = await production();
    const jan = await signInJan(a);
    expect((await write(a, { cookie: jan, origin: URL_ })).statusCode).toBe(200);
    expect((await write(a, { cookie: jan, referer: `${URL_}/rooms/x/documents?f=1` })).statusCode).toBe(200);
  });

  it('rejects cross-origin writes', async () => {
    const a = await production();
    const jan = await signInJan(a);
    expectRefused(await write(a, { cookie: jan, origin: EVIL }));
    expectRefused(await write(a, { origin: EVIL }));
    expectRefused(await write(a, { cookie: jan, origin: 'http://dataroom.example.com' }));
    expectRefused(await write(a, { cookie: jan, origin: 'https://dataroom.example.com:8443' }));
    expectRefused(await write(a, { cookie: jan, origin: 'null' }));
    expectRefused(await write(a, { cookie: jan, origin: EVIL, referer: `${URL_}/` }));
    expectRefused(await a.inject({ method: 'POST', url: '/v1/auth/email-otp/send-verification-otp', headers: { origin: EVIL }, payload: { email: 'jan@bidder-a.example', type: 'sign-in' } }));
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      expectRefused(await a.inject({ method, url: `/v1/workspaces/${h.ws}/nodes/${h.node.aud1}`, headers: { cookie: jan, origin: EVIL } }));
    }
  });

  it('rejects a foreign or invalid Referer', async () => {
    const a = await production();
    const jan = await signInJan(a);
    expectRefused(await write(a, { cookie: jan, referer: `${EVIL}/page` }));
    expectRefused(await write(a, { cookie: jan, referer: 'not an address' }));
  });

  it('rejects cookie writes without Origin or Referer', async () => {
    const a = await production();
    const jan = await signInJan(a);
    expectRefused(await write(a, { cookie: jan }));
    // either cookie name counts
    expect(jan.startsWith('__Secure-vdrkit.session_token=')).toBe(true);
    expectRefused(await write(a, { cookie: `theme=dark; ${jan}` }));
    expectRefused(await write(a, { cookie: `theme=dark; ${jan.replace('__Secure-', '')}` }));
    // SSR marks itself
    expect((await write(a, { cookie: jan, 'x-vdrkit-render': 'server' })).statusCode).toBe(200);
  });

  it('lets cookieless API clients through', async () => {
    const a = await production();
    expect((await write(a, {})).statusCode).toBe(401);
    await a.close();
    process.env.NODE_ENV = 'test';
    app = await buildApp({ db: h.db, dbRole: 'vdrkit_app', auth: new DevHeaderAuthenticator(), rateLimit: false, publicUrl: URL_ });
    const res = await write(app, { 'x-dev-tenant': h.t1, 'x-dev-person': h.person.jan });
    expect(res.statusCode).toBe(200);
  });

  it('ignores GET and HEAD', async () => {
    const a = await production();
    const jan = await signInJan(a);
    expect((await a.inject({ method: 'GET', url: '/v1/me', headers: { cookie: jan, origin: EVIL } })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/v1/me', headers: { cookie: jan } })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/v1/health', headers: { origin: EVIL } })).statusCode).toBe(200);
  });

  it('accepts configured extra origins', async () => {
    const a = await production({ trustedOrigins: ['http://127.0.0.1:3100/'] });
    const jan = await signInJan(a);
    expect((await write(a, { cookie: jan, origin: 'http://127.0.0.1:3100' })).statusCode).toBe(200);
    expectRefused(await write(a, { cookie: jan, origin: 'http://127.0.0.1:3101' }));
  });
});

describe('security headers', () => {
  const expectHeaders = (res: Awaited<ReturnType<FastifyInstance['inject']>>) => {
    expect(res.headers['content-security-policy']).toBe(API_CSP);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  };

  it("sets CSP and security headers on every response", async () => {
    expect(API_CSP).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const a = await production();
    const jan = await signInJan(a);
    expectHeaders(await a.inject({ method: 'GET', url: '/v1/me', headers: { cookie: jan } }));
    expectHeaders(await a.inject({ method: 'GET', url: '/v1/me' }));
    expectHeaders(await a.inject({ method: 'GET', url: '/v1/no-such-route', headers: { cookie: jan } }));
    expectHeaders(await write(a, { cookie: jan, origin: EVIL }));
    expectHeaders(await a.inject({ method: 'GET', url: '/v1/auth/get-session', headers: { cookie: jan } }));
    expectHeaders(await a.inject({ method: 'GET', url: '/health' }));
  });
});
