// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Channel, OutgoingMessage } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator, devOrSessionAuthenticator } from '../src/index.js';
import { authFromEnv } from '../src/auth-from-env.js';
import { BetterAuthAuthenticator, betterAuthRoutes, createBetterAuth, type VdrAuth } from '../src/auth/better-auth.js';
import { linkPersonToLogin } from '../src/auth/person-link.js';
import { poolFromPGlite } from '../src/auth/pool.js';
import { heron, type Heron } from '../../../packages/core/test/fixture.js';


const URL_ = 'https://dataroom.example.com';
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

const forged = (person: string) => ({
  'x-dev-tenant': h.t1, 'x-dev-person': person, cookie: `vdrkit-dev-persona=anika`, origin: URL_,
});

function production() {
  process.env.NODE_ENV = 'production';
  delete process.env.VDRKIT_DEV_AUTH;
  process.env.BETTER_AUTH_SECRET = SECRET;
  process.env.PUBLIC_URL = URL_;
}

async function signInJan(a: FastifyInstance, auth: VdrAuth): Promise<string> {
  const email = (await h.pg.query<{ email: string }>(`select email from person where id = $1`, [h.person.jan])).rows[0]!.email;
  const send = await a.inject({ method: 'POST', url: '/v1/auth/email-otp/send-verification-otp', headers: { origin: URL_ }, payload: { email, type: 'sign-in' } });
  expect(send.statusCode).toBe(200);
  await auth.vdrkit.signInMailSettled();
  const otp = /(\d{3}) ?(\d{3})/.exec(mail.last().subject)!.slice(1).join('');
  const res = await a.inject({ method: 'POST', url: '/v1/auth/sign-in/email-otp', headers: { origin: URL_ }, payload: { email, otp } });
  expect(res.statusCode).toBe(200);
  const raw = res.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw : [String(raw)]).map((c) => c.split(';')[0]!).find((c) => c.includes('session_token'));
  expect(cookie).toBeTruthy();
  return cookie!;
}

describe('dev switcher in production', () => {
  it('should require a secret and real sessions', async () => {
    production();
    delete process.env.BETTER_AUTH_SECRET;
    const pool = (h.appPool ?? poolFromPGlite(h.pg)) as unknown as pg.Pool;
    await expect(authFromEnv(h.db, pool, mail)).rejects.toThrow('BETTER_AUTH_SECRET must be set to at least 32 random characters.');
    production();
    const signIn = await authFromEnv(h.db, pool, mail);
    expect(signIn.auth).toBeInstanceOf(BetterAuthAuthenticator);
    expect((signIn.auth as { devOnly?: boolean }).devOnly).toBeUndefined();
  });

  it('needs VDRKIT_DEV_AUTH and NODE_ENV=development', async () => {
    const pool = (h.appPool ?? poolFromPGlite(h.pg)) as unknown as pg.Pool;
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.VDRKIT_DEV_AUTH;
    for (const env of ['development', 'test']) {
      process.env.NODE_ENV = env;
      await expect(authFromEnv(h.db, pool, mail)).rejects.toThrow('BETTER_AUTH_SECRET must be set to at least 32 random characters.');
    }
    process.env.VDRKIT_DEV_AUTH = '1';
    expect((await authFromEnv(h.db, pool, mail)).auth).toBeInstanceOf(DevHeaderAuthenticator);
    process.env.NODE_ENV = 'production';
    await expect(authFromEnv(h.db, pool, mail)).rejects.toThrow('BETTER_AUTH_SECRET must be set to at least 32 random characters.');
  });

  it('should not build an app with a dev authenticator', async () => {
    production();
    const sessions = new BetterAuthAuthenticator(createBetterAuth({ db: h.db, pool: h.appPool ?? poolFromPGlite(h.pg), secret: SECRET, publicUrl: URL_,
      dbRole: 'vdrkit_app', builtInRateLimit: false }), h.db, 'vdrkit_app');
    for (const auth of [new DevHeaderAuthenticator(), devOrSessionAuthenticator(sessions)]) {
      await expect(buildApp({ db: h.db, auth, dbRole: 'vdrkit_app' })).rejects.toThrow('The development authenticator is only allowed when NODE_ENV is test or development.');
    }
  });

  it('returns 401 for forged headers', async () => {
    production();
    const pool = (h.appPool ?? poolFromPGlite(h.pg)) as unknown as pg.Pool;
    const signIn = await authFromEnv(h.db, pool, mail);
    app = await buildApp({ db: h.db, dbRole: 'vdrkit_app', mailer: mail, rateLimit: false, ...signIn } as Parameters<typeof buildApp>[0]);
    for (const url of ['/v1/me', '/v1/me/workspaces', `/v1/workspaces/${h.ws}/people`, `/v1/workspaces/${h.ws}/events`]) {
      for (const headers of [forged(h.person.anika), { ...forged(h.person.anika), 'x-dev-agent-max-level': '60' }]) {
        const res = await app.inject({ method: 'GET', url, headers });
        expect(res.statusCode, url).toBe(401);
      }
    }
    expect([401, 404]).toContain((await app.inject({ method: 'GET', url: '/v1/dev/mailbox?to=jan%40bidder-a.example', headers: forged(h.person.anika) })).statusCode);
  });

  it('ignores headers next to a real session', async () => {
    production();
    const pool = (h.appPool ?? poolFromPGlite(h.pg)) as unknown as pg.Pool;
    const signIn = await authFromEnv(h.db, pool, mail);
    app = await buildApp({ db: h.db, dbRole: 'vdrkit_app', mailer: mail, rateLimit: false, ...signIn } as Parameters<typeof buildApp>[0]);
    const jan = await signInJan(app, signIn.betterAuth!);
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { ...forged(h.person.anika), cookie: `${jan}; vdrkit-dev-persona=anika` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().personId).toBe(h.person.jan);
    const people = await app.inject({ method: 'GET', url: `/v1/workspaces/${h.ws}/people`, headers: { ...forged(h.person.anika), cookie: jan } });
    expect(people.statusCode).toBe(403);
  });
});

describe('dev switcher in development', () => {
  let auth: VdrAuth;
  async function devApp() {
    process.env.NODE_ENV = 'development';
    auth = createBetterAuth({ db: h.db, pool: h.appPool ?? poolFromPGlite(h.pg), secret: SECRET, publicUrl: URL_, mailer: mail,
      dbRole: 'vdrkit_app', builtInRateLimit: false });
    app = await buildApp({ db: h.db, auth: devOrSessionAuthenticator(new BetterAuthAuthenticator(auth, h.db, 'vdrkit_app')), dbRole: 'vdrkit_app',
      mailer: mail, publicUrl: URL_, plugins: [betterAuthRoutes(auth, URL_)], rateLimit: false });
    return app;
  }

  it('should prefer a real session', async () => {
    const a = await devApp();
    const jan = await signInJan(a, auth);
    const me = await a.inject({ method: 'GET', url: '/v1/me', headers: { ...forged(h.person.anika), cookie: `vdrkit-dev-persona=anika; ${jan}` } });
    expect(me.json().personId).toBe(h.person.jan);
  });

  it('falls back to the switcher', async () => {
    const a = await devApp();
    const anika = await a.inject({ method: 'GET', url: '/v1/me', headers: forged(h.person.anika) });
    expect(anika.json().personId).toBe(h.person.anika);
    const stale = await a.inject({ method: 'GET', url: '/v1/me', headers: { ...forged(h.person.anika), cookie: 'vdrkit.session_token=made-up.value' } });
    expect(stale.json().personId).toBe(h.person.anika);
    expect((await a.inject({ method: 'GET', url: '/v1/me', headers: { origin: URL_ } })).statusCode).toBe(401);
  });
});
