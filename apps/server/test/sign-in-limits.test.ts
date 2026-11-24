// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Channel, OutgoingMessage } from '@vdrkit/core';
import { buildApp } from '../src/index.js';
import { BetterAuthAuthenticator, betterAuthRoutes, createBetterAuth, SIGN_IN_ADDRESS_LIMITED, type VdrAuth } from '../src/auth/better-auth.js';
import { linkPersonToLogin } from '../src/auth/person-link.js';
import { poolFromPGlite } from '../src/auth/pool.js';
import { SharedRateLimits } from '../src/rate-limit.js';
import { heron, type Heron } from '../../../packages/core/test/fixture.js';

const URL_ = 'https://dataroom.example.com';
const SECRET = 'test-secret-test-secret-test-secret-0123456789';
const OFFICE = '198.51.100.20';

class FakeMailer implements Channel {
  readonly name = 'fake';
  sent: OutgoingMessage[] = [];
  async send(msg: OutgoingMessage) {
    this.sent.push(msg);
    return { status: 'accepted' as const };
  }
}

let h: Heron;
let app: FastifyInstance;
let auth: VdrAuth;
let mail: FakeMailer;
let known: string;

beforeEach(async () => {
  h = await heron();
  mail = new FakeMailer();
  const shared = new SharedRateLimits(h.db, 'vdrkit_app');
  auth = createBetterAuth({ db: h.db, pool: h.appPool ?? poolFromPGlite(h.pg), secret: SECRET, publicUrl: URL_, mailer: mail,
    dbRole: 'vdrkit_app', rateLimitStorage: shared.betterAuthStorage() });
  app = await buildApp({
    db: h.db, auth: new BetterAuthAuthenticator(auth, h.db, 'vdrkit_app'), dbRole: 'vdrkit_app',
    mailer: mail, publicUrl: URL_, plugins: [betterAuthRoutes(auth, URL_)], rateLimit: { shared },
  });
  await h.app((tx) => linkPersonToLogin(tx, h.person.jan));
  known = (await h.pg.query<{ email: string }>(`select email from person where id = $1`, [h.person.jan])).rows[0]!.email;
});
afterEach(async () => {
  await app.close();
  await h.pg.close();
});

const askLink = (email: string, ip = OFFICE) => app.inject({ method: 'POST', url: '/v1/auth/sign-in/magic-link', headers: { origin: URL_ },
  payload: { email }, remoteAddress: ip });
const askCode = (email: string, ip = OFFICE) => app.inject({ method: 'POST', url: '/v1/auth/email-otp/send-verification-otp', headers: { origin: URL_ },
  payload: { email, type: 'sign-in' }, remoteAddress: ip });
const seen = (r: { statusCode: number; body: string }) => ({ status: r.statusCode, body: r.body });

describe('sign-in limits', () => {
  it('allows 100 emails per IP per 15 minutes', async () => {
    for (let i = 0; i < 100; i++) expect((await askLink(`person${i}@bidder.example`)).statusCode, `request ${i + 1}`).toBe(200);
    const over = await askLink('person100@bidder.example');
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ type: 'https://vdrkit.com/problems/rate-limited', status: 429 });
    expect((await askLink('person100@bidder.example', '198.51.100.21')).statusCode).toBe(200);
  }, 120_000);

  it('limits an address to 10', async () => {
    for (let i = 0; i < 5; i++) expect((await askLink(known, `203.0.113.${i + 1}`)).statusCode).toBe(200);
    for (let i = 5; i < 10; i++) expect((await askCode(known, `203.0.113.${i + 1}`)).statusCode).toBe(200);
    const over = await askLink(known.toUpperCase(), '203.0.113.50');
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ code: SIGN_IN_ADDRESS_LIMITED });
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    await auth.vdrkit.signInMailSettled();
    expect(mail.sent).toHaveLength(10);
    expect((await askLink('someone-else@bidder.example', '203.0.113.50')).statusCode).toBe(200);
  });

  it('should not reveal unknown addresses', async () => {
    const unknown = 'nobody@nowhere.example';
    for (let i = 0; i < 10; i++) {
      const a = await askLink(known, `203.0.113.${i + 1}`);
      const b = await askLink(unknown, `203.0.113.${i + 101}`);
      expect(seen(b)).toEqual(seen(a));
    }
    const a = await askLink(known, '203.0.113.60');
    const b = await askLink(unknown, '203.0.113.61');
    expect(a.statusCode).toBe(429);
    expect(seen(b)).toEqual(seen(a));
  });
});
