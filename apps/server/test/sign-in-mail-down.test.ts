// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Channel, OutgoingMessage } from '@vdrkit/core';
import { buildApp } from '../src/index.js';
import { BetterAuthAuthenticator, betterAuthRoutes, createBetterAuth, EMAIL_NOT_SENT, EMAIL_NOT_SENT_MESSAGE, type VdrAuth } from '../src/auth/better-auth.js';
import { channelProbe, MailHealth } from '../src/auth/mail-health.js';
import { linkPersonToLogin } from '../src/auth/person-link.js';
import { poolFromPGlite } from '../src/auth/pool.js';
import { heron, type Heron } from '../../../packages/core/test/fixture.js';


const URL_ = 'https://dataroom.example.com';
const SECRET = 'test-secret-test-secret-test-secret-0123456789';
const UNKNOWN = 'nobody@nowhere.example';

class FlakyMailer implements Channel {
  readonly name = 'email';
  sent: OutgoingMessage[] = [];
  attempts = 0;
  sendFails = true;
  verifyFails = true;
  hold: Promise<void> | null = null;
  async send(msg: OutgoingMessage) {
    this.attempts++;
    if (this.sendFails) return { status: 'failed' as const, error: 'connect ECONNREFUSED 10.0.0.25:587' };
    this.sent.push(msg);
    return { status: 'accepted' as const };
  }
  async verify() {
    if (this.hold) await this.hold;
    if (this.verifyFails) throw new Error('connect ECONNREFUSED 10.0.0.25:587');
  }
}

let h: Heron;
let app: FastifyInstance;
let mail: FlakyMailer;
let health: MailHealth;
let auth: VdrAuth;
let t: number;
let known: string;

beforeEach(async () => {
  h = await heron();
  mail = new FlakyMailer();
  t = Date.parse('2026-11-15T08:00:00Z');
  health = new MailHealth(channelProbe(mail), { clock: () => t });
  auth = createBetterAuth({ db: h.db, pool: h.appPool ?? poolFromPGlite(h.pg), secret: SECRET, publicUrl: URL_, mailer: mail,
    mailHealth: health, dbRole: 'vdrkit_app', builtInRateLimit: false });
  app = await buildApp({
    db: h.db, auth: new BetterAuthAuthenticator(auth, h.db, 'vdrkit_app'), dbRole: 'vdrkit_app',
    mailer: mail, publicUrl: URL_, plugins: [betterAuthRoutes(auth, URL_)], rateLimit: false,
  });
  await h.app((tx) => linkPersonToLogin(tx, h.person.jan));
  known = (await h.pg.query<{ email: string }>(`select email from person where id = $1`, [h.person.jan])).rows[0]!.email;
});
afterEach(async () => {
  await app.close();
  await h.pg.close();
});

const post = (path: string, payload: object) => app.inject({ method: 'POST', url: `/v1/auth${path}`, headers: { origin: URL_ }, payload })
  .then(async (r) => { await auth.vdrkit.signInMailSettled(); return r; });
const askLink = (email: string) => post('/sign-in/magic-link', { email });
const askCode = (email: string) => post('/email-otp/send-verification-otp', { email, type: 'sign-in' });
const seen = (r: { statusCode: number; body: string }) => ({ status: r.statusCode, body: r.body });

describe('mail down', () => {
  it('returns the same error for any address', async () => {
    expect(seen(await askLink(UNKNOWN))).toEqual({ status: 200, body: '{"status":true}' });
    await health.settled();
    const before = mail.attempts;

    const forKnown = await askLink(known);
    const forUnknown = await askLink(UNKNOWN);
    expect(forKnown.statusCode).toBe(503);
    expect(forKnown.json()).toMatchObject({ code: EMAIL_NOT_SENT, message: 'We could not send the email right now. Try again in a few minutes.' });
    expect(EMAIL_NOT_SENT_MESSAGE).toBe('We could not send the email right now. Try again in a few minutes.');
    expect(seen(forUnknown)).toEqual(seen(forKnown));
    expect(seen(await askCode(known))).toEqual(seen(await askCode(UNKNOWN)));
    expect((await askCode(known)).statusCode).toBe(503);
    expect(mail.attempts).toBe(before);
    expect((await h.pg.query(`select 1 from auth_verification where identifier like 'magic-link:%' and value::jsonb ->> 'email' = $1`, [known])).rows)
      .toHaveLength(0);
  });

  it('answers alike when only the send fails', async () => {
    mail.verifyFails = false;
    await askLink(UNKNOWN);
    await health.settled();
    const forKnown = await askLink(known);
    const forUnknown = await askLink(UNKNOWN);
    expect(seen(forKnown)).toEqual({ status: 200, body: '{"status":true}' });
    expect(seen(forUnknown)).toEqual(seen(forKnown));
    expect(mail.attempts).toBe(1);   // only the known address sends
    expect((await h.pg.query<{ action: string }>(`select action from event where action like 'auth.magic_link.%'`)).rows.map((r) => r.action))
      .toEqual(['auth.magic_link.not_sent']);
    expect(seen(await askLink(UNKNOWN))).toEqual({ status: 200, body: '{"status":true}' });
  });

  it('never waits for the mail check', async () => {
    let release!: () => void;
    mail.hold = new Promise<void>((r) => { release = r; });
    mail.verifyFails = false;
    mail.sendFails = false;
    expect((await askLink(UNKNOWN)).statusCode).toBe(200);
    expect((await askLink(known)).statusCode).toBe(200);
    expect(mail.sent.map((m) => m.to)).toEqual([known]);
    release();
    await health.settled();
  });

  it('rechecks after a minute', async () => {
    await askLink(UNKNOWN);
    await health.settled();
    expect((await askLink(known)).statusCode).toBe(503);
    mail.verifyFails = false;
    mail.sendFails = false;
    t += 30_000;
    expect((await askLink(known)).statusCode).toBe(503);
    t += 31_000;
    expect((await askLink(UNKNOWN)).statusCode).toBe(503);
    await health.settled();
    expect((await askLink(known)).statusCode).toBe(200);
    expect(mail.sent.map((m) => m.to)).toEqual([known]);
  });

  it('treats a timeout or no channel as down', async () => {
    const slow = new MailHealth(() => new Promise<void>(() => {}), { timeoutMs: 20 });
    expect(slow.ok()).toBe(true);
    await slow.settled();
    expect(slow.ok()).toBe(false);
    const none = new MailHealth(channelProbe(undefined));
    none.ok();
    await none.settled();
    expect(none.ok()).toBe(false);
    // no server check (dev mailbox) counts as working
    const plain = new MailHealth(channelProbe({ name: 'email', send: async () => ({ status: 'accepted' }) }));
    plain.ok();
    await plain.settled();
    expect(plain.ok()).toBe(true);
  });
});
