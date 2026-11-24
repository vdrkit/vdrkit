// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Channel, OutgoingMessage } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator, type Authenticator } from '../src/index.js';
import { BetterAuthAuthenticator, betterAuthRoutes, createBetterAuth, type VdrAuth } from '../src/auth/better-auth.js';
import { sessionRoutes } from '../src/auth/session-routes.js';
import { linkPersonToLogin } from '../src/auth/person-link.js';
import { poolFromPGlite } from '../src/auth/pool.js';
import { EMAIL_CHANGE_HOURS } from '../src/routes/email-change.js';
import { heron, type Heron } from '../../../packages/core/test/fixture.js';


const URL_ = 'https://dataroom.example.com';
const SECRET = 'test-secret-test-secret-test-secret-0123456789';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

class FakeMailer implements Channel {
  readonly name = 'fake';
  sent: OutgoingMessage[] = [];
  async send(msg: OutgoingMessage) { this.sent.push(msg); return { status: 'accepted' as const, providerMessageId: `m${this.sent.length}` }; }
  last() { return this.sent[this.sent.length - 1]!; }
  to(address: string) { return this.sent.filter((m) => m.to === address); }
}

class Browser {
  jar = new Map<string, string>();
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
  const sessions = new BetterAuthAuthenticator(auth, h.db, 'vdrkit_app');
  const dev = new DevHeaderAuthenticator();
  const both: Authenticator & { devOnly: true } = {
    devOnly: true,
    authenticate: (r: FastifyRequest, reply) => (r.headers['x-dev-person'] !== undefined ? dev.authenticate(r) : sessions.authenticate(r, reply)),
  };
  app = await buildApp({ db: h.db, auth: both, dbRole: 'vdrkit_app', now: () => clock, mailer: mail, publicUrl: URL_,
    plugins: [betterAuthRoutes(auth, URL_), sessionRoutes(auth)], rateLimit: false });
  for (const p of Object.values(h.person)) await h.app((tx) => linkPersonToLogin(tx, p));
});
afterEach(async () => { await app.close(); await h.pg.close(); });

type Method = 'GET' | 'POST';
const as = (person: string, method: Method, url: string, payload?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1, 'user-agent': 'vitest', ...extra },
    ...(payload !== undefined ? { payload: payload as object } : {}) });
const roomUrl = (person: string) => `/v1/workspaces/${h.ws}/people/${person}/email-change`;
const siteUrl = (person: string) => `/v1/site/accounts/${person}/email-change`;
const pub = (method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'user-agent': UA }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const req = (b: Browser, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin: URL_, 'user-agent': UA, ...(b.jar.size ? { cookie: b.header() } : {}) },
    ...(payload !== undefined ? { payload: payload as object } : {}) }).then((r) => b.take(r));
const emailOf = async (person: string) => (await h.pg.query<{ email: string }>(`select email from person where id = $1`, [person])).rows[0]!.email;
const actions = async (ws: string | null) => (await h.pg.query<{ action: string }>(
  `select action from event where ${ws ? 'workspace_id = $1' : 'workspace_id is null and $1::uuid is null'} and action like '%email_change%' order by seq`, [ws])).rows.map((r) => r.action);

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

async function codeStep(b: Browser, email: string) {
  const before = mail.sent.length;
  expect((await req(b, 'POST', '/v1/auth/email-otp/send-verification-otp', { email, type: 'sign-in' })).statusCode).toBe(200);
  await auth.vdrkit.signInMailSettled();
  if (mail.sent.length === before) return null;
  const otp = /\b(\d{6})\b/.exec(mail.last().subject.replaceAll(' ', ''))![1]!;
  return req(b, 'POST', '/v1/auth/sign-in/email-otp', { email, otp });
}

async function signUpWithTotp(b: Browser, email: string): Promise<string> {
  expect((await codeStep(b, email))!.statusCode).toBe(200);
  const enable = await req(b, 'POST', '/v1/auth/two-factor/enable', {});
  const secret = new URL(enable.json().totpURI).searchParams.get('secret')!;
  expect((await req(b, 'POST', '/v1/auth/two-factor/verify-totp', { code: totp(secret) })).statusCode).toBe(200);
  return secret;
}

function approvalOf(m: OutgoingMessage) {
  return decodeURIComponent(/\/email-change\/approve\/(\S+)/.exec(m.text!)![1]!);
}
const approve = (token: string) => pub('POST', '/v1/public/email-change/approve', { token });
const decline = (token: string) => pub('POST', '/v1/public/email-change/decline', { token });

function fromEmail(m: OutgoingMessage) {
  const token = decodeURIComponent(/\/email-change\/(\S+)/.exec(m.text!)![1]!);
  const code = /(\d{3}) ?(\d{3})/.exec(m.subject)!.slice(1).join('');
  return { token, code };
}

describe('room admin changes an email', () => {
  it('changes the email once the code is entered', async () => {
    const jan = new Browser();
    const secret = await signUpWithTotp(jan, 'jan@bidder-a.example');
    expect((await req(jan, 'GET', '/v1/me')).statusCode).toBe(200);

    const info = await as(h.person.anika, 'GET', roomUrl(h.person.jan));
    expect(info.json()).toEqual({ personId: h.person.jan, name: 'Jan de Vries', email: 'jan@bidder-a.example', otherRooms: 0, pending: null, needsApproval: true });

    const res = await as(h.person.anika, 'POST', roomUrl(h.person.jan), { email: ' Jan.de.Vries@Orrinby.example ' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ personId: h.person.jan, newEmail: 'jan.de.vries@orrinby.example', needsApproval: true, emailStatus: 'accepted' });
    expect(new Date(res.json().expiresAt).getTime() - clock.getTime()).toBe(EMAIL_CHANGE_HOURS * 3_600_000);
    expect(mail.to('jan.de.vries@orrinby.example')).toHaveLength(0);
    expect((await approve(approvalOf(mail.last()))).statusCode).toBe(200);

    const sent = mail.last();
    expect(sent.to).toBe('jan.de.vries@orrinby.example');
    expect(sent.subject).toMatch(/^Confirm your new sign-in address: \d{6}$/);
    expect(sent.text).toContain('Anika Pillay is changing the address you sign in with to this one, jan.de.vries@orrinby.example.');
    expect(sent.text).toContain('Until you confirm, you sign in with your old address.');
    const { token, code } = fromEmail(sent);
    expect(token.startsWith(`${h.t1}.`)).toBe(true);
    expect(await emailOf(h.person.jan)).toBe('jan@bidder-a.example');
    expect((await req(jan, 'GET', '/v1/me')).statusCode).toBe(200);
    expect((await as(h.person.anika, 'GET', roomUrl(h.person.jan))).json().pending).toMatchObject({ newEmail: 'jan.de.vries@orrinby.example' });

    expect((await pub('GET', `/v1/public/email-change/${encodeURIComponent(token)}`)).json()).toMatchObject({ newEmail: 'jan.de.vries@orrinby.example' });

    // wrong code
    const wrong = await pub('POST', '/v1/public/email-change/confirm', { token, code: code === '000000' ? '111111' : '000000' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().detail).toBe('That code is not right. You have 4 more tries.');
    expect(await emailOf(h.person.jan)).toBe('jan@bidder-a.example');

    const ok = await pub('POST', '/v1/public/email-change/confirm', { token, code });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ email: 'jan.de.vries@orrinby.example', sessionsEnded: 1 });
    expect(await emailOf(h.person.jan)).toBe('jan.de.vries@orrinby.example');
    expect((await pub('POST', '/v1/public/email-change/confirm', { token, code })).statusCode).toBe(410);

    expect((await req(jan, 'GET', '/v1/me')).statusCode).toBe(401);
    const notice = mail.to('jan@bidder-a.example').at(-1)!;
    expect(notice.subject).toBe('Your sign-in address has changed');
    expect(notice.text).toContain('From now on you sign in with jan.de.vries@orrinby.example. This address, jan@bidder-a.example, no longer works for signing in.');

    const again = new Browser();
    const first = await codeStep(again, 'jan.de.vries@orrinby.example');
    expect(first!.json().twoFactorRedirect).toBe(true);
    expect((await req(again, 'POST', '/v1/auth/two-factor/verify-totp', { code: totp(secret) })).statusCode).toBe(200);
    expect((await req(again, 'GET', '/v1/me')).json()).toMatchObject({ personId: h.person.jan, email: 'jan.de.vries@orrinby.example' });
    expect(await codeStep(new Browser(), 'jan@bidder-a.example')).toBeNull();

    expect(await actions(h.ws)).toEqual(['person.email_change_requested', 'person.email_change_approval_sent', 'person.email_change_approved',
      'person.email_change_code_sent', 'person.email_changed']);
    const changed = await as(h.person.anika, 'GET', `/v1/workspaces/${h.ws}/events?action=person.email_changed`);
    const entry = changed.json().items[0];
    expect(entry).toMatchObject({ action: 'person.email_changed', item: 'Changed the sign-in email of Jan de Vries',
      detail: 'jan@bidder-a.example → jan.de.vries@orrinby.example' });
    const asked = (await as(h.person.anika, 'GET', `/v1/workspaces/${h.ws}/events?action=person.email_change_requested`)).json().items[0];
    expect(asked).toMatchObject({ item: 'Asked to change the sign-in email of Jan de Vries',
      detail: 'To jan.de.vries@orrinby.example. It changes once they agree at their current address and enter the code sent to the new one.' });
    const data = (await h.pg.query<{ data: any }>(`select data from event where action = 'person.email_changed'`)).rows[0]!.data;
    expect(JSON.stringify(data)).not.toContain('@');
    await h.pg.query(`update person set is_site_admin = true where id = $1`, [h.person.anika]);
    const site = (await as(h.person.anika, 'GET', '/v1/site/events')).json().items;
    const s = site.find((x: any) => x.action === 'site.person.email_changed');
    expect(s).toMatchObject({ data: { person_id: h.person.jan, requested_by: h.person.anika },
      personal: { before: { email: 'jan@bidder-a.example' }, after: { email: 'jan.de.vries@orrinby.example' } } });
    expect(site.some((x: any) => x.action === 'site.person.email_changed_notice_sent')).toBe(true);
  });

  it('counts other rooms affected', async () => {
    const ws = (await h.pg.query<{ id: string }>(`insert into workspace (tenant_id, name, state) values ($1, 'Project Osprey', 'open') returning id`, [h.t1])).rows[0]!.id;
    const party = (await h.pg.query<{ id: string }>(`insert into party (tenant_id, workspace_id, name, kind) values ($1, $2, 'Bidder', 'bidder') returning id`, [h.t1, ws])).rows[0]!.id;
    const group = (await h.pg.query<{ id: string }>(`insert into groups (tenant_id, workspace_id, party_id, name) values ($1, $2, $3, 'Bidder') returning id`, [h.t1, ws, party])).rows[0]!.id;
    await h.pg.query(`insert into membership (tenant_id, person_id, group_id) values ($1, $2, $3)`, [h.t1, h.person.jan, group]);
    // Anika runs Osprey too
    const seller = (await h.pg.query<{ id: string }>(`insert into party (tenant_id, workspace_id, name, kind) values ($1, $2, 'Seller', 'seller') returning id`, [h.t1, ws])).rows[0]!.id;
    const admins = (await h.pg.query<{ id: string }>(`insert into groups (tenant_id, workspace_id, party_id, name, role_template) values ($1, $2, $3, 'Room admins', 'admin') returning id`,
      [h.t1, ws, seller])).rows[0]!.id;
    await h.pg.query(`insert into membership (tenant_id, person_id, group_id, recorded_at) values ($1, $2, $3, '2026-01-01')`, [h.t1, h.person.anika, admins]);
    expect((await as(h.person.anika, 'GET', roomUrl(h.person.jan))).json().otherRooms).toBe(1);
    await as(h.person.anika, 'POST', roomUrl(h.person.jan), { email: 'jan@new.example' });
    const { token, code } = fromEmail(mail.last());
    expect((await pub('POST', '/v1/public/email-change/confirm', { token, code })).statusCode).toBe(200);
    const rooms = (await h.pg.query<{ workspace_id: string }>(`select workspace_id from event where action = 'person.email_changed' order by workspace_id`)).rows.map((r) => r.workspace_id);
    expect(rooms.sort()).toEqual([h.ws, ws].sort());
  });

  it('replaces an earlier pending change', async () => {
    await as(h.person.anika, 'POST', roomUrl(h.person.mei), { email: 'mei@first.example' });
    const first = fromEmail(mail.last());
    await as(h.person.anika, 'POST', roomUrl(h.person.mei), { email: 'mei@second.example' });
    const second = fromEmail(mail.last());
    expect((await pub('POST', '/v1/public/email-change/confirm', first)).statusCode).toBe(410);
    expect((await pub('GET', `/v1/public/email-change/${encodeURIComponent(first.token)}`)).statusCode).toBe(410);
    expect((await pub('POST', '/v1/public/email-change/confirm', second)).statusCode).toBe(200);
    expect(await emailOf(h.person.mei)).toBe('mei@second.example');
  });

  it('expires after five wrong codes or three days', async () => {
    await as(h.person.anika, 'POST', roomUrl(h.person.mei), { email: 'mei@wrong.example' });
    const { token, code } = fromEmail(mail.last());
    const bad = code === '000000' ? '111111' : '000000';
    const answers: number[] = [];
    for (let i = 0; i < 5; i += 1) answers.push((await pub('POST', '/v1/public/email-change/confirm', { token, code: bad })).statusCode);
    expect(answers).toEqual([400, 400, 400, 400, 410]);
    expect((await pub('POST', '/v1/public/email-change/confirm', { token, code })).statusCode).toBe(410);
    expect(await emailOf(h.person.mei)).toBe('mei@bidder-b.example');

    await as(h.person.anika, 'POST', roomUrl(h.person.mei), { email: 'mei@late.example' });
    const late = fromEmail(mail.last());
    clock = new Date(clock.getTime() + EMAIL_CHANGE_HOURS * 3_600_000 + 1000);
    expect((await pub('POST', '/v1/public/email-change/confirm', late)).statusCode).toBe(410);
    expect(await emailOf(h.person.mei)).toBe('mei@bidder-b.example');
  });

  it('keeps addresses unique site-wide', async () => {
    const taken = async (email: string) => {
      const r = await as(h.person.anika, 'POST', roomUrl(h.person.mei), { email });
      expect(r.statusCode, email).toBe(409);
      expect(r.json().reason).toBe('email_taken');
    };
    await taken('jan@bidder-a.example');
    await taken('JAN@bidder-a.example');
    const other = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Olu Ade', 'olu@other.example') returning id`, [h.t2])).rows[0]!.id;
    await h.pg.query(`insert into auth_person (tenant_id, person_id, email) values ($1, $2, 'olu@other.example')`, [h.t2, other]);
    await taken('olu@other.example');
    await h.pg.query(`insert into auth_user (id, name, email, email_verified) values ('u-orphan', 'x', 'login@only.example', true)`);
    await taken('login@only.example');
    await as(h.person.anika, 'POST', roomUrl(h.person.jan), { email: 'wanted@x.example' });
    await taken('wanted@x.example');
    const same = await as(h.person.anika, 'POST', roomUrl(h.person.mei), { email: 'mei@bidder-b.example' });
    expect(same.statusCode).toBe(400);
    expect(same.json().detail).toBe('That is already their sign-in address.');
    // taken after the request
    await as(h.person.anika, 'POST', roomUrl(h.person.mei), { email: 'race@x.example' });
    const race = fromEmail(mail.last());
    await h.pg.query(`insert into auth_user (id, name, email, email_verified) values ('u-race', 'x', 'race@x.example', true)`);
    const r = await pub('POST', '/v1/public/email-change/confirm', race);
    expect(r.statusCode).toBe(409);
    expect(await emailOf(h.person.mei)).toBe('mei@bidder-b.example');
  });

  it('erasure removes a pending change', async () => {
    expect((await as(h.person.anika, 'POST', roomUrl(h.person.mei), { email: 'mei@erase.example' })).statusCode).toBe(200);
    expect((await h.pg.query(`select 1 from email_change where person_id = $1`, [h.person.mei])).rows).toHaveLength(1);
    await h.pg.query(`update person set erased_at = now() where id = $1`, [h.person.mei]);
    expect((await h.pg.query(`select 1 from email_change where person_id = $1`, [h.person.mei])).rows).toHaveLength(0);
  });
});

describe('the current address agrees first', () => {
  const MEI = 'mei@bidder-b.example';
  async function signedIn(person: string, email: string) {
    await h.pg.query(`insert into auth_user (id, name, email, email_verified) values ($1, 'x', $2, true)`, [`u-${person}`, email]);
    await h.app((tx) => tx.query(`update auth_person set user_id = $2 where person_id = $1`, [person, `u-${person}`]));
  }
  const pending = async () => (await as(h.person.anika, 'GET', roomUrl(h.person.mei))).json().pending;

  it('asks the current address and sends nothing to the new one', async () => {
    await signedIn(h.person.mei, MEI);
    expect((await as(h.person.anika, 'GET', roomUrl(h.person.mei))).json().needsApproval).toBe(true);
    const res = await as(h.person.anika, 'POST', roomUrl(h.person.mei), { email: 'mei@new.example' });
    expect(res.json()).toMatchObject({ newEmail: 'mei@new.example', needsApproval: true, emailStatus: 'accepted' });
    expect(mail.sent.map((m) => m.to)).toEqual([MEI]);
    const ask = mail.last();
    expect(ask.subject).toBe('Change your sign-in address?');
    expect(ask.text).toContain('Anika Pillay asked to change the address you sign in with from mei@bidder-b.example to mei@new.example.');
    expect(ask.text).toContain('Nothing changes unless you agree.');
    expect(ask.text).toContain('The link works for 3 days.');
    expect(await pending()).toMatchObject({ newEmail: 'mei@new.example', awaitingApproval: true });
    expect(await actions(h.ws)).toEqual(['person.email_change_requested', 'person.email_change_approval_sent']);
    const sent = (await as(h.person.anika, 'GET', `/v1/workspaces/${h.ws}/events?action=person.email_change_approval_sent`)).json().items[0];
    expect(sent).toMatchObject({ item: 'Asked Mei Tanaka to agree to a new sign-in email' });

    const token = approvalOf(ask);
    expect((await pub('GET', `/v1/public/email-change/approval/${encodeURIComponent(token)}`)).json()).toEqual({
      oldEmail: MEI, newEmail: 'mei@new.example', requestedBy: 'Anika Pillay', expiresAt: res.json().expiresAt });
    // the link to agree is not the code link
    expect((await pub('GET', `/v1/public/email-change/${encodeURIComponent(token)}`)).statusCode).toBe(410);
    expect((await pub('POST', '/v1/public/email-change/confirm', { token, code: '123456' })).statusCode).toBe(410);
  });

  it('refuses the code link until the current address agrees', async () => {
    await signedIn(h.person.mei, MEI);
    await as(h.person.anika, 'POST', roomUrl(h.person.mei), { email: 'mei@new.example' });
    // as if someone held the code link and code
    const row = (await h.pg.query<{ id: string }>(`select id from email_change where person_id = $1 and status = 'pending'`, [h.person.mei])).rows[0]!;
    const token = `${h.t1}.${'k'.repeat(43)}`;
    const hex = (s: string) => createHash('sha256').update(s).digest('hex');
    await h.pg.query(`update email_change set token_sha256 = $2, code_sha256 = $3 where id = $1`, [row.id, hex(token), hex(`${row.id}:123456`)]);
    expect((await pub('GET', `/v1/public/email-change/${encodeURIComponent(token)}`)).statusCode).toBe(410);
    expect((await pub('POST', '/v1/public/email-change/confirm', { token, code: '123456' })).statusCode).toBe(410);
    expect(await emailOf(h.person.mei)).toBe(MEI);
    expect((await h.pg.query<{ wrong_codes: number }>(`select wrong_codes from email_change where id = $1`, [row.id])).rows[0]!.wrong_codes).toBe(0);
  });

  it('sends the code to the new address once agreed', async () => {
    await signedIn(h.person.mei, MEI);
    await as(h.person.anika, 'POST', roomUrl(h.person.mei), { email: 'mei@new.example' });
    const token = approvalOf(mail.last());
    clock = new Date(clock.getTime() + 48 * 3_600_000);
    const ok = await approve(token);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ newEmail: 'mei@new.example', expiresAt: new Date(clock.getTime() + EMAIL_CHANGE_HOURS * 3_600_000).toISOString(), emailStatus: 'accepted' });
    expect(mail.to('mei@new.example')).toHaveLength(1);
    expect((await approve(token)).statusCode).toBe(410);
    expect(mail.to('mei@new.example')).toHaveLength(1);
    expect(await pending()).toMatchObject({ awaitingApproval: false });
    const approved = (await h.pg.query<{ actor_id: string | null; data: any }>(`select actor_id, data from event where action = 'person.email_change_approved'`)).rows[0]!;
    expect(approved.actor_id).toBeNull();
    expect(approved.data).toEqual({ person_id: h.person.mei, requested_by: h.person.anika });
    const entry = (await as(h.person.anika, 'GET', `/v1/workspaces/${h.ws}/events?action=person.email_change_approved`)).json().items[0];
    expect(entry).toMatchObject({ item: 'Mei Tanaka agreed to a new sign-in email', detail: 'A code went to mei@new.example.' });

    // past the first 72 hours
    clock = new Date(clock.getTime() + 48 * 3_600_000);
    const { token: link, code } = fromEmail(mail.last());
    expect((await pub('POST', '/v1/public/email-change/confirm', { token: link, code })).json()).toEqual({ email: 'mei@new.example', sessionsEnded: 0 });
    expect(await emailOf(h.person.mei)).toBe('mei@new.example');
    expect(mail.to(MEI).at(-1)!.subject).toBe('Your sign-in address has changed');
    expect(await actions(h.ws)).toEqual(['person.email_change_requested', 'person.email_change_approval_sent', 'person.email_change_approved',
      'person.email_change_code_sent', 'person.email_changed']);
  });

  it('keeps the address when refused', async () => {
    await signedIn(h.person.mei, MEI);
    await as(h.person.anika, 'POST', roomUrl(h.person.mei), { email: 'mei@new.example' });
    const token = approvalOf(mail.last());
    const before = mail.sent.length;
    const no = await decline(token);
    expect(no.statusCode).toBe(204);
    expect(mail.sent).toHaveLength(before);
    expect(await emailOf(h.person.mei)).toBe(MEI);
    expect(await pending()).toBeNull();
    expect((await h.pg.query<{ status: string }>(`select status from email_change where person_id = $1`, [h.person.mei])).rows[0]!.status).toBe('declined');
    expect((await approve(token)).statusCode).toBe(410);
    expect((await decline(token)).statusCode).toBe(410);
    expect(mail.to('mei@new.example')).toHaveLength(0);
    const entry = (await as(h.person.anika, 'GET', `/v1/workspaces/${h.ws}/events?action=person.email_change_declined`)).json().items[0];
    expect(entry).toMatchObject({ item: 'Mei Tanaka refused a new sign-in email', detail: 'They keep mei@bidder-b.example.' });
    expect((await h.pg.query<{ actor_id: string | null }>(`select actor_id from event where action = 'person.email_change_declined'`)).rows[0]!.actor_id).toBeNull();
  });

  it('answers the same for expired, replaced, used and unknown links', async () => {
    await signedIn(h.person.mei, MEI);
    const unknown = `${h.t1}.${'z'.repeat(43)}`;
    const gone = (await approve(unknown)).json();
    const answers = async (token: string) => {
      for (const r of [await pub('GET', `/v1/public/email-change/approval/${encodeURIComponent(token)}`), await approve(token), await decline(token)]) {
        expect(r.statusCode).toBe(410);
        expect(r.json()).toEqual(gone);
      }
    };
    await answers(unknown);
    expect((await pub('GET', '/v1/public/email-change/approval/nonsense')).json()).toEqual(gone);

    await as(h.person.anika, 'POST', roomUrl(h.person.mei), { email: 'mei@first.example' });
    const replaced = approvalOf(mail.last());
    await as(h.person.anika, 'POST', roomUrl(h.person.mei), { email: 'mei@second.example' });
    const used = approvalOf(mail.last());
    await answers(replaced);
    expect((await approve(used)).statusCode).toBe(200);
    await answers(used);

    await as(h.person.anika, 'POST', roomUrl(h.person.mei), { email: 'mei@late.example' });
    const late = approvalOf(mail.last());
    clock = new Date(clock.getTime() + EMAIL_CHANGE_HOURS * 3_600_000 + 1000);
    await answers(late);
    expect(mail.to('mei@late.example')).toHaveLength(0);
    expect(await emailOf(h.person.mei)).toBe(MEI);
  });

  it('skips the step for site admins and for people who never signed in', async () => {
    expect((await as(h.person.anika, 'GET', roomUrl(h.person.mei))).json().needsApproval).toBe(false);
    const direct = await as(h.person.anika, 'POST', roomUrl(h.person.mei), { email: 'mei@typo.example' });
    expect(direct.json()).toMatchObject({ needsApproval: false });
    expect(mail.sent.map((m) => m.to)).toEqual(['mei@typo.example']);
    expect(await pending()).toMatchObject({ awaitingApproval: false });

    await signedIn(h.person.mei, MEI);
    await h.pg.query(`update person set is_site_admin = true where id = $1`, [h.person.anika]);
    expect((await as(h.person.anika, 'GET', roomUrl(h.person.mei))).json().needsApproval).toBe(false);
    expect((await as(h.person.anika, 'POST', roomUrl(h.person.mei), { email: 'mei@room.example' })).json()).toMatchObject({ needsApproval: false });
    expect((await as(h.person.anika, 'GET', siteUrl(h.person.mei))).json().needsApproval).toBe(false);
    expect((await as(h.person.anika, 'POST', siteUrl(h.person.mei), { email: 'mei@site.example' })).json()).toMatchObject({ needsApproval: false });
    expect(mail.sent.map((m) => m.to)).toEqual(['mei@typo.example', 'mei@room.example', 'mei@site.example']);
  });

  it('stops a room admin moving a login to an address they control', async () => {
    await signedIn(h.person.mei, MEI);
    await as(h.person.anika, 'POST', roomUrl(h.person.mei), { email: 'anika.private@x.example' });
    expect(mail.to('anika.private@x.example')).toHaveLength(0);
    for (let i = 0; i < 6; i += 1) {
      expect((await pub('POST', '/v1/public/email-change/confirm', { token: `${h.t1}.${'q'.repeat(43)}`, code: String(i).repeat(6) })).statusCode).toBe(410);
    }
    // asking again only asks Mei again
    expect((await as(h.person.anika, 'POST', roomUrl(h.person.mei), { email: 'anika.private@x.example' })).json().needsApproval).toBe(true);
    expect(mail.to('anika.private@x.example')).toHaveLength(0);
    expect(mail.sent.every((m) => m.to === MEI)).toBe(true);
    expect(await emailOf(h.person.mei)).toBe(MEI);
  });

  describe('an account that was disabled and enabled again', () => {
    const link = async (person: string) => (await h.pg.query<{ user_id: string | null }>(`select user_id from auth_person where person_id = $1`, [person])).rows;
    const twoFactor = async (email: string) => (await h.pg.query<{ id: string; two_factor_enabled: boolean }>(
      `select id, two_factor_enabled from auth_user where email = $1`, [email])).rows[0];

    async function offAndOn(person: string) {
      await h.pg.query(`update person set is_site_admin = true where id = $1`, [h.person.maria]);
      expect((await as(h.person.maria, 'POST', `/v1/site/accounts/${person}/disable`, {})).statusCode).toBe(200);
      expect(await link(person)).toEqual([]);
      expect((await as(h.person.maria, 'POST', `/v1/site/accounts/${person}/enable`, {})).statusCode).toBe(200);
      expect(await link(person)).toEqual([{ user_id: null }]);
      const membership = (await h.pg.query<{ id: string }>(
        `select id from membership where person_id = $1 and superseded_at = 'infinity' order by recorded_at desc limit 1`, [person])).rows[0]!.id;
      expect((await as(h.person.anika, 'POST', `/v1/workspaces/${h.ws}/memberships/${membership}/restore`, {})).statusCode).toBe(200);
      mail.sent.length = 0;
    }

    it('still asks the current address', async () => {
      await signUpWithTotp(new Browser(), 'jan@bidder-a.example');
      await offAndOn(h.person.jan);
      expect((await as(h.person.anika, 'GET', roomUrl(h.person.jan))).json().needsApproval).toBe(true);
      const res = await as(h.person.anika, 'POST', roomUrl(h.person.jan), { email: 'anika.private@x.example' });
      expect(res.json()).toMatchObject({ needsApproval: true, emailStatus: 'accepted' });
      expect(mail.sent.map((m) => [m.to, m.subject])).toEqual([['jan@bidder-a.example', 'Change your sign-in address?']]);
      expect(await emailOf(h.person.jan)).toBe('jan@bidder-a.example');
    });

    it('asks on a sign-in in the log alone', async () => {
      await signUpWithTotp(new Browser(), 'jan@bidder-a.example');
      await offAndOn(h.person.jan);
      await h.pg.query(`delete from auth_user where email = 'jan@bidder-a.example'`);
      expect((await as(h.person.anika, 'POST', roomUrl(h.person.jan), { email: 'anika.private@x.example' })).json()).toMatchObject({ needsApproval: true });
      expect(mail.to('anika.private@x.example')).toHaveLength(0);
    });

    it('keeps login and authenticator on a site admin change', async () => {
      await signUpWithTotp(new Browser(), 'jan@bidder-a.example');
      const before = await twoFactor('jan@bidder-a.example');
      expect(before).toMatchObject({ two_factor_enabled: true });
      await offAndOn(h.person.jan);
      expect((await as(h.person.maria, 'POST', siteUrl(h.person.jan), { email: 'jan@orrinby.example' })).json()).toMatchObject({ needsApproval: false });
      const { token, code } = fromEmail(mail.last());
      expect((await pub('POST', '/v1/public/email-change/confirm', { token, code })).statusCode).toBe(200);
      // login moved, nothing left on the old address
      expect(await twoFactor('jan@orrinby.example')).toEqual(before);
      expect(await twoFactor('jan@bidder-a.example')).toBeUndefined();
      expect(await link(h.person.jan)).toEqual([{ user_id: before!.id }]);
    });
  });

  it('refuses people in rooms the admin does not run', async () => {
    await signedIn(h.person.jan, 'jan@bidder-a.example');
    const ws = (await h.pg.query<{ id: string }>(`insert into workspace (tenant_id, name, state) values ($1, 'Project Osprey', 'open') returning id`, [h.t1])).rows[0]!.id;
    const party = (await h.pg.query<{ id: string }>(`insert into party (tenant_id, workspace_id, name, kind) values ($1, $2, 'Bidder', 'bidder') returning id`, [h.t1, ws])).rows[0]!.id;
    const group = (await h.pg.query<{ id: string }>(`insert into groups (tenant_id, workspace_id, party_id, name) values ($1, $2, $3, 'Bidder') returning id`, [h.t1, ws, party])).rows[0]!.id;
    await h.pg.query(`insert into membership (tenant_id, person_id, group_id) values ($1, $2, $3)`, [h.t1, h.person.jan, group]);
    const r = await as(h.person.anika, 'POST', roomUrl(h.person.jan), { email: 'jan@new.example' });
    expect(r.statusCode).toBe(403);
    expect(r.json().reason).toBe('target_in_other_room');
    expect(mail.sent).toHaveLength(0);
    expect((await h.pg.query(`select 1 from email_change`)).rows).toHaveLength(0);
  });
});

describe('stale requests', () => {
  const MEI = 'mei@bidder-b.example';
  const login = async (email: string) => (await h.pg.query<{ id: string }>(`select id from auth_user where email = $1`, [email])).rows;
  const state = async () => (await h.pg.query<{ status: string }>(`select status from email_change order by requested_at desc limit 1`)).rows[0]!.status;

  // before the first sign-in, so no agreement step
  async function askedEarly() {
    const res = await as(h.person.anika, 'POST', roomUrl(h.person.mei), { email: 'anika.private@x.example' });
    expect(res.json()).toMatchObject({ needsApproval: false, emailStatus: 'accepted' });
    return fromEmail(mail.to('anika.private@x.example')[0]!);
  }
  const confirm = (t: { token: string; code: string }) => pub('POST', '/v1/public/email-change/confirm', t);

  it('does not move someone who signed in after it was made', async () => {
    const t = await askedEarly();
    await signUpWithTotp(new Browser(), MEI);
    expect(await login(MEI)).toHaveLength(1);

    expect((await confirm(t)).statusCode).toBe(410);
    expect(await emailOf(h.person.mei)).toBe(MEI);
    expect(await login(MEI)).toHaveLength(1);
    expect(await login('anika.private@x.example')).toEqual([]);
    expect(await state()).toBe('expired');
    expect((await as(h.person.anika, 'GET', roomUrl(h.person.mei))).json()).toMatchObject({ pending: null, needsApproval: true });
    // the right code changes nothing either way
    expect((await confirm(t)).statusCode).toBe(410);
  });

  it('still corrects people who never signed in', async () => {
    const t = await askedEarly();
    expect((await confirm(t)).statusCode).toBe(200);
    expect(await emailOf(h.person.mei)).toBe('anika.private@x.example');
  });

  it('ends when the person joins a room the requester does not run', async () => {
    const t = await askedEarly();
    const ws = (await h.pg.query<{ id: string }>(`insert into workspace (tenant_id, name, state) values ($1, 'Project Osprey', 'open') returning id`, [h.t1])).rows[0]!.id;
    const party = (await h.pg.query<{ id: string }>(`insert into party (tenant_id, workspace_id, name, kind) values ($1, $2, 'Bidder', 'bidder') returning id`, [h.t1, ws])).rows[0]!.id;
    const group = (await h.pg.query<{ id: string }>(`insert into groups (tenant_id, workspace_id, party_id, name) values ($1, $2, $3, 'Bidder') returning id`, [h.t1, ws, party])).rows[0]!.id;
    await h.pg.query(`insert into membership (tenant_id, person_id, group_id) values ($1, $2, $3)`, [h.t1, h.person.mei, group]);
    expect((await confirm(t)).statusCode).toBe(410);
    expect(await emailOf(h.person.mei)).toBe(MEI);
    expect(await state()).toBe('expired');
  });

  it('ends when the requester is no longer an admin of the room', async () => {
    const t = await askedEarly();
    await h.pg.query(`update membership set valid_to = now() - interval '1 second' where person_id = $1`, [h.person.anika]);
    expect((await confirm(t)).statusCode).toBe(410);
    expect(await emailOf(h.person.mei)).toBe(MEI);
  });

  it('ends when the requester loses the room before agreement', async () => {
    await signUpWithTotp(new Browser(), MEI);
    mail.sent.length = 0;
    expect((await as(h.person.anika, 'POST', roomUrl(h.person.mei), { email: 'mei@new.example' })).json()).toMatchObject({ needsApproval: true });
    const token = approvalOf(mail.last());
    await h.pg.query(`update membership set valid_to = now() - interval '1 second' where person_id = $1`, [h.person.anika]);
    expect((await approve(token)).statusCode).toBe(410);
    expect(mail.to('mei@new.example')).toHaveLength(0);
    expect(await state()).toBe('expired');
  });

  it('keeps the request of a site admin standing', async () => {
    await h.pg.query(`update person set is_site_admin = true where id = $1`, [h.person.maria]);
    expect((await as(h.person.maria, 'POST', siteUrl(h.person.mei), { email: 'mei@new.example' })).json()).toMatchObject({ needsApproval: false });
    const t = fromEmail(mail.to('mei@new.example')[0]!);
    await signUpWithTotp(new Browser(), MEI);
    expect((await confirm(t)).statusCode).toBe(200);
    expect(await emailOf(h.person.mei)).toBe('mei@new.example');
    // the login she signed in with moved along
    expect(await login('mei@new.example')).toHaveLength(1);
    expect(await login(MEI)).toEqual([]);
  });
});

describe('who may change an address', () => {
  it('refuses bidders, contributors and observers', async () => {
    for (const p of [h.person.jan, h.person.maria, h.person.lars, h.person.mei]) {
      for (const [m, url, body] of [['GET', roomUrl(h.person.mei), undefined], ['POST', roomUrl(h.person.mei), { email: 'x@y.example' }]] as const) {
        const r = await as(p, m, url, body);
        expect(r.statusCode, `${p} ${m}`).toBe(403);
        expect(r.json().reason).toBe('not_room_admin');
      }
      for (const [m, body] of [['GET', undefined], ['POST', { email: 'x@y.example' }]] as const) {
        const r = await as(p, m, siteUrl(h.person.mei), body);
        expect(r.statusCode).toBe(403);
        expect(r.json().reason).toBe('not_site_admin');
      }
    }
    expect(mail.sent).toHaveLength(0);
    expect((await h.pg.query(`select 1 from email_change`)).rows).toHaveLength(0);
  });

  it('limits room admins to their room', async () => {
    const outsider = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Eve Outsider', 'eve@x.example') returning id`, [h.t1])).rows[0]!.id;
    expect((await as(h.person.anika, 'GET', roomUrl(outsider))).statusCode).toBe(404);
    expect((await as(h.person.anika, 'POST', roomUrl(outsider), { email: 'eve@y.example' })).statusCode).toBe(404);
    await h.pg.query(`update membership set valid_to = now() - interval '1 second' where person_id = $1`, [h.person.mei]);
    expect((await as(h.person.anika, 'POST', roomUrl(h.person.mei), { email: 'mei@y.example' })).statusCode).toBe(404);

    await h.pg.query(`update person set is_site_admin = true where id = $1`, [h.person.maria]);
    const r = await as(h.person.anika, 'POST', roomUrl(h.person.maria), { email: 'maria@y.example' });
    expect(r.statusCode).toBe(403);
    expect(r.json().reason).toBe('target_is_site_admin');
    await h.pg.query(`update person set is_site_admin = true where id = $1`, [h.person.anika]);
    expect((await as(h.person.anika, 'POST', roomUrl(h.person.maria), { email: 'maria@y.example' })).statusCode).toBe(200);
    expect(mail.sent.map((m) => m.to)).toEqual(['maria@y.example']);
  });

  it('refuses agents and team view', async () => {
    const agent = await as(h.person.anika, 'POST', roomUrl(h.person.jan), { email: 'jan@agent.example' }, { 'x-dev-agent-max-level': '60' });
    expect(agent.statusCode).toBe(403);
    const seeAs = await as(h.person.anika, 'POST', roomUrl(h.person.jan), { email: 'jan@seeas.example' }, { 'x-vdrkit-see-as': h.group.a });
    expect(seeAs.statusCode).toBe(403);
    expect(mail.sent).toHaveLength(0);
  });

  it('refuses disabled accounts and dead links', async () => {
    await h.pg.query(`update person set disabled_at = now() where id = $1`, [h.person.mei]);
    const disabled = await as(h.person.anika, 'POST', roomUrl(h.person.mei), { email: 'mei@z.example' });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json().reason).toBe('account_disabled');
    for (const token of ['nonsense', `${h.t1}.${'a'.repeat(43)}`, `${h.t2}.${'b'.repeat(43)}`]) {
      expect((await pub('GET', `/v1/public/email-change/${token}`)).statusCode).toBe(410);
    }
    expect((await pub('POST', '/v1/public/email-change/confirm', { token: `${h.t1}.${'a'.repeat(43)}`, code: '123456' })).statusCode).toBe(410);
  });
});

describe('site admin changes an email', () => {
  it('changes anyone and logs it in every room', async () => {
    await h.pg.query(`update person set is_site_admin = true where id = $1`, [h.person.anika]);
    const info = await as(h.person.anika, 'GET', siteUrl(h.person.maria));
    expect(info.json()).toMatchObject({ email: 'maria@drosvelt.example', otherRooms: 1, pending: null });
    const res = await as(h.person.anika, 'POST', siteUrl(h.person.maria), { email: 'maria@botha.example' });
    expect(res.statusCode).toBe(200);
    expect(await actions(null)).toEqual(['site.person.email_change_requested', 'site.person.email_change_code_sent']);
    const { token, code } = fromEmail(mail.last());
    expect((await pub('POST', '/v1/public/email-change/confirm', { token, code })).json()).toEqual({ email: 'maria@botha.example', sessionsEnded: 0 });
    expect(await emailOf(h.person.maria)).toBe('maria@botha.example');
    const rooms = (await h.pg.query<{ workspace_id: string }>(`select workspace_id from event where action = 'person.email_changed'`)).rows.map((r) => r.workspace_id);
    expect(rooms).toEqual([h.ws]);
    expect((await h.pg.query<{ email: string }>(`select email from auth_person where person_id = $1`, [h.person.maria])).rows[0]!.email).toBe('maria@botha.example');
  });
});
