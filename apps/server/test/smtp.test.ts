// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { BetterAuthAuthenticator, betterAuthRoutes, createBetterAuth, type VdrAuth } from '../src/auth/better-auth.js';
import { linkPersonToLogin } from '../src/auth/person-link.js';
import { poolFromPGlite } from '../src/auth/pool.js';
import { SmtpChannel, describeSmtp, smtpChannelFromEnv, smtpSettingsFromEnv, smtpTransportOptions } from '../src/mail/smtp.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';

// no network

const FROM = 'Project data room <dataroom@example.com>';
const PASSWORD = 'not-a-real-password-9f3c';

const msg = (over: Partial<{ subject: string; lines: string[] }> = {}) => ({
  personId: '00000000-0000-4000-8000-000000000001', to: 'anika@example.com',
  subject: over.subject ?? 'Your data room sign-in code: 482913',
  lines: over.lines ?? ['Your sign-in code is 482913.', 'Sign in: https://dataroom.example.com/v1/auth/magic-link/verify?token=SECRET-TOKEN-1234'],
});

const failing = (error: Error & { code?: string; responseCode?: number }) => nodemailer.createTransport({
  name: 'failing', version: '1',
  send: (_mail: unknown, cb: (err: Error | null) => void) => cb(error),
} as never);

describe('mail settings', () => {
  it('returns undefined without a server', () => {
    expect(smtpSettingsFromEnv({ MAIL_FROM: FROM })).toBeNull();
    expect(smtpChannelFromEnv({})).toBeUndefined();
    expect(describeSmtp({})).toBeNull();
  });

  it('defaults to 587 with STARTTLS', () => {
    const s = smtpSettingsFromEnv({ SMTP_HOST: 'mail.example.com', SMTP_USER: 'info@example.com', SMTP_PASSWORD: PASSWORD, MAIL_FROM: FROM })!;
    expect(s).toEqual({ host: 'mail.example.com', port: 587, security: 'starttls', user: 'info@example.com', password: PASSWORD, from: FROM });
    const o = smtpTransportOptions(s);
    expect(o).toMatchObject({ host: 'mail.example.com', port: 587, secure: false, requireTLS: true, logger: false, debug: false,
      auth: { user: 'info@example.com', pass: PASSWORD }, disableFileAccess: true, disableUrlAccess: true });
    expect(o.connectionTimeout).toBeGreaterThan(0);
    expect(o.greetingTimeout).toBeGreaterThan(0);
    expect(o.socketTimeout).toBeGreaterThan(0);
  });

  it('supports SMTP_SECURE=tls', () => {
    const s = smtpSettingsFromEnv({ SMTP_HOST: 'mail.example.com', SMTP_PORT: '465', SMTP_SECURE: 'tls', MAIL_FROM: FROM })!;
    expect(s).toMatchObject({ port: 465, security: 'tls' });
    expect(s.user).toBeUndefined();
    expect(smtpTransportOptions(s)).toMatchObject({ secure: true, requireTLS: false });
    expect(smtpTransportOptions(s).auth).toBeUndefined();
  });

  it('reads SMTP_URL', () => {
    const s = smtpSettingsFromEnv({ SMTP_URL: 'smtp://info%40example.com:p%40ss%3Aword@mail.example.com', MAIL_FROM: FROM })!;
    expect(s).toEqual({ host: 'mail.example.com', port: 587, security: 'starttls', user: 'info@example.com', password: 'p@ss:word', from: FROM });
    expect(smtpSettingsFromEnv({ SMTP_URL: 'smtps://mail.example.com', MAIL_FROM: FROM })).toMatchObject({ port: 465, security: 'tls' });
  });

  it('rejects bad settings', () => {
    expect(() => smtpSettingsFromEnv({ SMTP_HOST: 'mail.example.com' })).toThrow(/MAIL_FROM/);
    expect(() => smtpSettingsFromEnv({ SMTP_HOST: 'mail.example.com', SMTP_SECURE: 'ssl', MAIL_FROM: FROM })).toThrow(/SMTP_SECURE/);
    expect(() => smtpSettingsFromEnv({ SMTP_HOST: 'mail.example.com', SMTP_PORT: 'x', MAIL_FROM: FROM })).toThrow(/SMTP_PORT/);
    expect(() => smtpSettingsFromEnv({ SMTP_URL: 'http://mail.example.com', MAIL_FROM: FROM })).toThrow(/smtp:\/\//);
  });

  it('describes the server without credentials', () => {
    const d = describeSmtp({ SMTP_HOST: 'mail.example.com', SMTP_USER: 'info@example.com', SMTP_PASSWORD: PASSWORD, MAIL_FROM: FROM })!;
    expect(d).toBe('mail.example.com:587 (STARTTLS required)');
  });

  it('builds a channel without connecting', () => {
    const ch = smtpChannelFromEnv({ SMTP_HOST: 'mail.invalid', SMTP_USER: 'u', SMTP_PASSWORD: PASSWORD, MAIL_FROM: FROM });
    expect(ch).toBeInstanceOf(SmtpChannel);
    expect(ch!.name).toBe('email');
  });
});

describe('SMTP channel', () => {
  it('escapes HTML', async () => {
    const out = msg({ lines: ['Fish & <chips>', 'Second line'] });
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const spy = vi.spyOn(transport, 'sendMail');
    const r = await new SmtpChannel(transport, FROM).send(out);
    expect(r.status).toBe('accepted');
    expect(r.providerMessageId).toMatch(/@/);
    const info = await spy.mock.results[0]!.value as { envelope: { from: string; to: string[] }; message: string };
    expect(info.envelope).toEqual({ from: 'dataroom@example.com', to: ['anika@example.com'] });
    const m = JSON.parse(info.message);
    expect(m.from).toEqual({ address: 'dataroom@example.com', name: 'Project data room' });
    expect(m.to).toEqual([{ address: 'anika@example.com', name: '' }]);
    expect(m.subject).toBe(out.subject);
    expect(m.text).toBe('Fish & <chips>\n\nSecond line');
    expect(m.html).toBe('<p>Fish &amp; &lt;chips&gt;</p>\n<p>Second line</p>');
  });

  it('writes the expected headers', async () => {
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    const spy = vi.spyOn(transport, 'sendMail');
    expect((await new SmtpChannel(transport, FROM).send(msg())).status).toBe('accepted');
    const raw = String(((await spy.mock.results[0]!.value) as { message: Buffer }).message);
    expect(raw).toMatch(/^From: Project data room <dataroom@example\.com>$/m);
    expect(raw).toMatch(/^To: anika@example\.com$/m);
  });

  it('hides the password in failures', async () => {
    const logs: unknown[] = [];
    const err = Object.assign(new Error(`Invalid login: 535 bad credentials for ${PASSWORD} while sending 482913`), { code: 'EAUTH', responseCode: 535 });
    const r = await new SmtpChannel(failing(err), FROM, (m, extra) => logs.push({ m, ...extra }), PASSWORD).send(msg({ lines: ['482913'] }));
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/^EAUTH 535: Invalid login/);
    expect(r.error).not.toContain(PASSWORD);
    expect(r.error).not.toContain('482913');
    expect(logs).toEqual([{ m: 'mail.failed', person_id: msg().personId, reason: r.error }]);
  });

  it('fails on a refused recipient', async () => {
    const transport = { sendMail: async () => ({ messageId: '<x@y>', accepted: [], rejected: ['anika@example.com'] }) };
    const r = await new SmtpChannel(transport as never, FROM, () => {}).send(msg());
    expect(r).toMatchObject({ status: 'failed', error: 'The mail server refused the recipient' });
  });
});

describe('sign-in email through SMTP', () => {
  const URL_ = 'https://dataroom.example.com';
  const SECRET = 'test-secret-test-secret-test-secret-0123456789';
  let h: Heron;
  let app: FastifyInstance | undefined;
  let auth: VdrAuth | undefined;
  const written: string[] = [];

  beforeEach(async () => {
    h = await heron();
    written.length = 0;
    for (const k of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { written.push(a.map(String).join(' ')); });
    }
    vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { written.push(String(c)); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { written.push(String(c)); return true; });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
    app = undefined;
    await h.pg.close();
  });

  async function start(transport: Parameters<typeof nodemailer.createTransport>[0]) {
    const sent = nodemailer.createTransport(transport as never);
    const spy = vi.spyOn(sent, 'sendMail');
    const mailer = new SmtpChannel(sent, FROM, undefined, PASSWORD);
    auth = createBetterAuth({ db: h.db, pool: h.appPool ?? poolFromPGlite(h.pg), secret: SECRET, publicUrl: URL_, mailer, dbRole: 'vdrkit_app', builtInRateLimit: false });
    app = await buildApp({
      db: h.db, auth: new BetterAuthAuthenticator(auth, h.db, 'vdrkit_app'), dbRole: 'vdrkit_app', now: () => T.at, logger: true,
      mailer, publicUrl: URL_, plugins: [betterAuthRoutes(auth, URL_)], rateLimit: false,
    });
    await h.app((tx) => linkPersonToLogin(tx, h.person.anika));
    const email = (await h.pg.query<{ email: string }>(`select email from person where id = $1`, [h.person.anika])).rows[0]!.email;
    return { spy, email };
  }
  const post = (path: string, payload: object) => app!.inject({ method: 'POST', url: `/v1/auth${path}`, headers: { origin: URL_ }, payload })
    .then(async (r) => { await auth!.vdrkit.signInMailSettled(); return r; });
  const authEvents = async () => (await h.pg.query<{ action: string; data: any }>(`select action, data from event where action like 'auth.%' order by seq`)).rows;

  it('sends the code and link without logging them', async () => {
    const { spy, email } = await start({ jsonTransport: true });
    expect((await post('/sign-in/magic-link', { email })).statusCode).toBe(200);
    expect((await post('/email-otp/send-verification-otp', { email, type: 'sign-in' })).statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
    const link = /https:\/\/\S+/.exec(String(spy.mock.calls[0]![0].text))![0];
    const code = /\b(\d{6})\b/.exec(String(spy.mock.calls[1]![0].subject).replaceAll(' ', ''))![1]!;
    expect(spy.mock.calls[0]![0]).toMatchObject({ from: '"Quillmont Advisory data rooms" <dataroom@example.com>', to: email });
    const token = new URL(link).searchParams.get('token')!;
    expect(written.length).toBeGreaterThan(0);
    for (const line of written) {
      expect(line).not.toContain(token);
      expect(line).not.toContain(code);
      expect(line).not.toContain(PASSWORD);
    }
    expect((await authEvents()).map((e) => e.action)).toEqual(['auth.magic_link.sent', 'auth.email_code.sent']);
  });

  it('records a failed send without logging secrets', async () => {
    const err = Object.assign(new Error(`Connection timeout (auth ${PASSWORD})`), { code: 'ETIMEDOUT' });
    const { spy, email } = await start({ name: 'failing', version: '1', send: (_m: unknown, cb: (e: Error) => void) => cb(err) });
    expect((await post('/email-otp/send-verification-otp', { email, type: 'sign-in' })).statusCode).toBe(200);
    const code = /\b(\d{6})\b/.exec(String(spy.mock.calls[0]![0].subject).replaceAll(' ', ''))![1]!;
    const ev = await authEvents();
    expect(ev.map((e) => e.action)).toEqual(['auth.email_code.not_sent']);
    expect(ev[0]!.data).toMatchObject({ delivery_status: 'failed', error: 'ETIMEDOUT: Connection timeout (auth [removed])' });
    expect(written.some((l) => l.includes('mail.failed'))).toBe(true);
    for (const line of written) {
      expect(line).not.toContain(code);
      expect(line).not.toContain(PASSWORD);
    }
  });
});
