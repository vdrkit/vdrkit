// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { verifyChain, withTenant } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { LocalKeyProvider } from '../src/crypto/envelope.js';
import { MemoryStorage } from '../src/pipeline/pipeline.js';
import { SiteMailChannel } from '../src/site/mail.js';
import { callerForLogin } from '../src/auth/person-link.js';
import { freshDatabase, heron, T, type TestPg } from '../../../packages/core/test/fixture.js';
import type { Database } from '@vdrkit/core';
import { fakeProbes, fakeTransport, png, TEST_ENV } from './site-helpers.js';

let db: Database;
let pg: TestPg;
let clock: Date;
let logs: string[];
let mail: ReturnType<typeof fakeTransport>;
let storage: MemoryStorage;
const apps: FastifyInstance[] = [];
let codes: string[];
let codeIndex: number;

async function start(opts: { env?: Record<string, string | undefined>; keyProvider?: boolean; rateLimit?: false | Record<string, unknown> } = {}) {
  const app = await buildApp({
    db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => clock, storage, publicUrl: 'https://dataroom.quillmont.example',
    rateLimit: (opts.rateLimit ?? false) as false,
    site: {
      env: opts.env ?? TEST_ENV, mailTransport: mail.factory, probes: fakeProbes(),
      ...(opts.keyProvider === false ? {} : { keyProvider: new LocalKeyProvider(randomBytes(32).toString('base64')) }),
      setup: {
        log: (l) => logs.push(l),
        generateCode: () => codes[codeIndex++] ?? 'ZZZZ-ZZZZ',
        fetch: (async () => new Response('{"status":"ok"}', { status: 200 })) as unknown as typeof fetch,
      },
    },
  });
  await app.ready();
  apps.push(app);
  return app;
}

beforeEach(async () => {
  ({ db, pg } = await freshDatabase());
  clock = T.at;
  logs = [];
  codes = ['K7QM-4XWD', 'P9RT-2HNB', 'W3XY-8CDF'];
  codeIndex = 0;
  mail = fakeTransport();
  storage = new MemoryStorage();
});
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  await pg.close();
});

const tokenHeader = (token: string) => ({ 'x-vdrkit-setup-token': token });

async function unlock(app: FastifyInstance, code = 'K7QM-4XWD') {
  const res = await app.inject({ method: 'POST', url: '/v1/setup/unlock', payload: { code } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

const ADMIN = { givenName: 'Anika', familyName: 'Pillay', company: 'Quillmont Advisory', email: 'anika@quillmont.example' };

async function fillIn(app: FastifyInstance, token: string) {
  const h = tokenHeader(token);
  expect((await app.inject({ method: 'PUT', url: '/v1/setup/admin', headers: h, payload: ADMIN })).statusCode).toBe(200);
  expect((await app.inject({ method: 'PUT', url: '/v1/setup/organisation', headers: h, payload: { name: 'Quillmont Advisory' } })).statusCode).toBe(200);
}

describe('setup code', () => {
  it('prints a one-time code at first start', async () => {
    const app = await start();
    expect(logs).toEqual(['Setup code: K7QM-4XWD']);
    expect((await app.inject({ method: 'GET', url: '/v1/setup' })).json()).toEqual({ open: true, version: expect.any(String) });
  });

  it('prints nothing once accounts exist', async () => {
    const h = await heron();
    const app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', rateLimit: false,
      site: { env: {}, mailTransport: mail.factory, probes: fakeProbes(), setup: { log: (l) => logs.push(l) } } });
    await app.ready();
    try {
      expect(logs).toEqual([]);
      expect((await app.inject({ method: 'GET', url: '/v1/setup' })).json()).toEqual({ open: false, version: null });
      const res = await app.inject({ method: 'POST', url: '/v1/setup/unlock', payload: { code: 'K7QM-4XWD' } });
      expect(res.statusCode).toBe(404);
    } finally { await app.close(); await h.pg.close(); }
  });

  it('refuses wrong codes and missing tokens', async () => {
    const app = await start();
    const wrong = await app.inject({ method: 'POST', url: '/v1/setup/unlock', payload: { code: 'AAAA-BBBB' } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().detail).toContain('not the setup code');
    for (const [method, url] of [['GET', '/v1/setup/draft'], ['GET', '/v1/setup/checks'], ['PUT', '/v1/setup/admin'], ['POST', '/v1/setup/test-email'], ['POST', '/v1/setup/finish']] as const) {
      const r1 = await app.inject({ method, url, payload: method === 'GET' ? undefined : ADMIN });
      expect(r1.statusCode, url).toBe(401);
      const r2 = await app.inject({ method, url, headers: tokenHeader('made-up-token'), payload: method === 'GET' ? undefined : ADMIN });
      expect(r2.statusCode, url).toBe(401);
    }
  });

  it('accepts lower case and no dash, once', async () => {
    const app = await start();
    const token = await unlock(app, 'k7qm4xwd');
    expect((await app.inject({ method: 'GET', url: '/v1/setup/draft', headers: tokenHeader(token) })).statusCode).toBe(200);
    const again = await app.inject({ method: 'POST', url: '/v1/setup/unlock', payload: { code: 'K7QM-4XWD' } });
    expect(again.statusCode).toBe(401);
  });

  it('locks an address after ten wrong codes', async () => {
    const app = await start();
    const from = (remoteAddress: string, code: string) => app.inject({ method: 'POST', url: '/v1/setup/unlock', remoteAddress, payload: { code } });
    for (let i = 0; i < 10; i++) await from('203.0.113.9', `AAAA-AAA${i}`);
    const res = await from('203.0.113.9', 'K7QM-4XWD');
    expect(res.statusCode).toBe(401);
    expect(res.json().detail).toContain('Too many wrong codes');
    expect((await from('198.51.100.20', 'K7QM-4XWD')).statusCode).toBe(200);
  });

  it('locks everyone after 1,000 wrong codes', async () => {
    const app = await start();
    for (let i = 0; i < 1000; i++) {
      await app.inject({ method: 'POST', url: '/v1/setup/unlock', remoteAddress: `10.${(i >> 8) & 255}.${i & 255}.1`, payload: { code: 'AAAA-AAAA' } });
    }
    const res = await app.inject({ method: 'POST', url: '/v1/setup/unlock', remoteAddress: '198.51.100.20', payload: { code: 'K7QM-4XWD' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().detail).toContain('Too many wrong codes');
  });

  it('expires after 24 hours', async () => {
    const app = await start();
    clock = new Date(T.at.getTime() + 24 * 3600_000 + 1000);
    const res = await app.inject({ method: 'POST', url: '/v1/setup/unlock', payload: { code: 'K7QM-4XWD' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().detail).toContain('expired');
  });

  it('gives a new code on restart', async () => {
    await start();
    const second = await start();
    expect(logs).toEqual(['Setup code: K7QM-4XWD', 'Setup code: P9RT-2HNB']);
    expect((await second.inject({ method: 'POST', url: '/v1/setup/unlock', payload: { code: 'K7QM-4XWD' } })).statusCode).toBe(401);
    await unlock(second, 'P9RT-2HNB');
  });

  it('has its own unlock limit', async () => {
    const app = await start({ rateLimit: { setupUnlock: { max: 3, windowMs: 60_000 } } });
    const codes2 = [];
    for (let i = 0; i < 4; i++) codes2.push((await app.inject({ method: 'POST', url: '/v1/setup/unlock', payload: { code: 'AAAA-BBBB' } })).statusCode);
    expect(codes2).toEqual([401, 401, 401, 429]);
  });
});

describe('setup steps', () => {
  it('runs the checks', async () => {
    const app = await start();
    const token = await unlock(app);
    const res = (await app.inject({ method: 'GET', url: '/v1/setup/checks', headers: tokenHeader(token) })).json();
    expect(res.items.map((i: any) => `${i.key}:${i.status}`)).toEqual(['database:ok', 'storage:ok', 'conversion:ok', 'virus_scanner:warning', 'web_address:ok']);
    expect(res.ready).toBe(true);
  });

  it('prefills mail from .env', async () => {
    const app = await start();
    const token = await unlock(app);
    const res = await app.inject({ method: 'GET', url: '/v1/setup/draft', headers: tokenHeader(token) });
    expect(res.json().mail).toEqual({ host: 'smtp.quillmont.example', port: 587, security: 'starttls', user: 'dataroom@quillmont.example',
      fromAddress: 'dataroom@quillmont.example', passwordSet: true, source: 'env' });
    expect(res.body).not.toContain('env-secret-pw');
  });

  it('checks logos and stores them as PNG', async () => {
    const app = await start();
    const h = tokenHeader(await unlock(app));
    const ok = await app.inject({ method: 'PUT', url: '/v1/setup/logos/light?filename=quillmont.png', headers: { ...h, 'content-type': 'image/png' }, payload: png(720, 160) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().organisation.logos.light).toMatchObject({ filename: 'quillmont.png', width: 720, height: 160, displaySize: { width: 180, height: 40 } });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 20"><rect width="90" height="20"/></svg>';
    const dark = await app.inject({ method: 'PUT', url: '/v1/setup/logos/dark', headers: { ...h, 'content-type': 'image/svg+xml' }, payload: svg });
    // 4x: 720 x 160 for 180 x 40
    expect(dark.json().organisation.logos.dark).toMatchObject({ mime: 'image/png', width: 720, height: 160, displaySize: { width: 180, height: 40 } });
    const scripted = await app.inject({ method: 'PUT', url: '/v1/setup/logos/dark', headers: { ...h, 'content-type': 'image/svg+xml' },
      payload: '<svg xmlns="http://www.w3.org/2000/svg" width="90" height="20"><script>alert(1)</script><rect width="90" height="20"/></svg>' });
    expect(scripted.statusCode).toBe(200);
    const served = await app.inject({ method: 'GET', url: '/v1/setup/logos/dark', headers: h });
    expect([served.headers['content-type'], served.rawPayload.subarray(1, 4).toString('latin1')]).toEqual(['image/png', 'PNG']);
    const bad = await app.inject({ method: 'PUT', url: '/v1/setup/logos/dark', headers: { ...h, 'content-type': 'image/svg+xml' }, payload: '<svg><script>' });
    expect(bad.statusCode).toBe(400);
    const fake = await app.inject({ method: 'PUT', url: '/v1/setup/logos/dark', headers: { ...h, 'content-type': 'image/png' }, payload: Buffer.from('<html>not a png</html>') });
    expect(fake.statusCode).toBe(400);
    const removed = await app.inject({ method: 'DELETE', url: '/v1/setup/logos/dark', headers: h });
    expect(removed.json().organisation.logos.dark).toBeNull();
    expect(storage.objects.size).toBe(1);
  });
});

describe('the mail password during setup', () => {
  it('keeps the .env password on its own server', async () => {
    const app = await start();
    const token = await unlock(app);
    const h = tokenHeader(token);
    await fillIn(app, token);
    const form = { host: 'attacker.example', port: 587, security: 'starttls', user: 'dataroom@quillmont.example', fromAddress: 'dataroom@quillmont.example' };
    const res = await app.inject({ method: 'PUT', url: '/v1/setup/mail', headers: h, payload: form });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain('Type the password again');
    expect((await app.inject({ method: 'GET', url: '/v1/setup/draft', headers: h })).json().mail.host).toBe('smtp.quillmont.example');

    expect((await app.inject({ method: 'PUT', url: '/v1/setup/mail', headers: h, payload: { ...form, host: 'smtp.quillmont.example', port: 465, security: 'tls' } })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: '/v1/setup/test-email', headers: h });
    expect(mail.sent.at(-1)!.settings).toMatchObject({ host: 'smtp.quillmont.example', port: 465, password: 'env-secret-pw' });

    expect((await app.inject({ method: 'PUT', url: '/v1/setup/mail', headers: h, payload: { ...form, host: 'mail.quillmont.example', password: 'typed-secret' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/v1/setup/mail', headers: h, payload: { ...form } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/v1/setup/mail', headers: h, payload: { ...form, host: 'mail.quillmont.example' } })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: '/v1/setup/test-email', headers: h });
    expect(mail.sent.at(-1)!.settings).toMatchObject({ host: 'mail.quillmont.example', password: 'typed-secret' });
    expect(mail.sent.every((m) => m.settings.host !== 'attacker.example')).toBe(true);
  });
});

describe('the setup test email', () => {
  it("uses the browser's time zone, or UTC", async () => {
    const app = await start();
    const token = await unlock(app);
    const h = tokenHeader(token);
    await fillIn(app, token);
    const sentLine = () => /Sent\s*:?\s*([^\n]+)/.exec(mail.sent.at(-1)!.msg.text!)![1]!;
    expect((await app.inject({ method: 'POST', url: '/v1/setup/test-email', headers: h, payload: { timeZone: 'Africa/Johannesburg' } })).json().status).toBe('accepted');
    expect(sentLine()).toMatch(/SAST/);
    await app.inject({ method: 'POST', url: '/v1/setup/test-email', headers: h, payload: { timeZone: 'Mars/Olympus_Mons' } });
    expect(sentLine()).toMatch(/UTC|GMT/);
    await app.inject({ method: 'POST', url: '/v1/setup/test-email', headers: h });
    expect(sentLine()).toMatch(/UTC|GMT/);
  });
});

describe('finishing setup', () => {
  it('needs a test email with the same settings', async () => {
    const app = await start();
    const token = await unlock(app);
    const h = tokenHeader(token);
    await fillIn(app, token);
    expect((await app.inject({ method: 'POST', url: '/v1/setup/finish', headers: h })).statusCode).toBe(409);

    mail.state.accept = false;
    const refused = (await app.inject({ method: 'POST', url: '/v1/setup/test-email', headers: h })).json();
    expect(refused).toMatchObject({ status: 'failed', sentTo: 'anika@quillmont.example', error: 'The mail server refused the user name or password. Error code: 535.' });
    expect((await app.inject({ method: 'POST', url: '/v1/setup/finish', headers: h })).statusCode).toBe(409);

    mail.state.accept = true;
    const ok = (await app.inject({ method: 'POST', url: '/v1/setup/test-email', headers: h })).json();
    expect(ok).toMatchObject({ status: 'accepted', sentTo: 'anika@quillmont.example', server: 'smtp.quillmont.example:587 (STARTTLS)' });
    expect(mail.sent.at(-1)!.settings).toMatchObject({ host: 'smtp.quillmont.example', user: 'dataroom@quillmont.example', password: 'env-secret-pw' });

    await app.inject({ method: 'PUT', url: '/v1/setup/mail', headers: h, payload: {
      host: 'mail.quillmont.example', port: 465, security: 'tls', user: 'dataroom@quillmont.example', password: 'typed-secret', fromAddress: 'dataroom@quillmont.example' } });
    expect((await app.inject({ method: 'GET', url: '/v1/setup/draft', headers: h })).json().testEmail.current).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/v1/setup/finish', headers: h })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/v1/setup/test-email', headers: h })).json().status).toBe('accepted');

    const done = await app.inject({ method: 'POST', url: '/v1/setup/finish', headers: h });
    expect(done.statusCode).toBe(201);
    const out = done.json();
    expect(out).toMatchObject({ email: 'anika@quillmont.example', signInUrl: 'https://dataroom.quillmont.example/sign-in' });

    const person = (await pg.query<any>(`select name, given_name, family_name, company, email, is_site_admin, can_create_rooms, metadata from person where id = $1`, [out.personId])).rows[0];
    expect(person).toMatchObject({ name: 'Anika Pillay', email: 'anika@quillmont.example', is_site_admin: true, can_create_rooms: true,
      given_name: 'Anika', family_name: 'Pillay', company: 'Quillmont Advisory' });
    expect(person.metadata).not.toHaveProperty('given_name');
    expect((await pg.query(`select 1 from auth_person where person_id = $1`, [out.personId])).rows).toHaveLength(1);
    const s = (await pg.query<any>(`select * from site_settings`)).rows[0];
    expect(s).toMatchObject({ org_name: 'Quillmont Advisory', org_domain: 'quillmont.example', mail_host: 'mail.quillmont.example', mail_port: 465, mail_security: 'tls' });
    expect(JSON.stringify(s)).not.toContain('typed-secret');
    expect(s.mail_password_wrapped).toMatchObject({ provider: 'local' });
    expect((await pg.query(`select tenant_id from site_instance`)).rows).toEqual([{ tenant_id: out.tenantId }]);
    const ev = (await pg.query<any>(`select action, data from event where workspace_id is null`)).rows;
    expect(ev).toEqual([{ action: 'site.setup.completed', data: expect.objectContaining({ person_id: out.personId, mail_source: 'database' }) }]);
    expect(await withTenant(db, out.tenantId, (tx) => verifyChain(tx, out.tenantId))).toMatchObject({ firstBroken: null });

    await pg.query(`insert into auth_user (id, name, email, email_verified) values ('u-anika', 'Anika Pillay', 'anika@quillmont.example', true)`);
    const caller = await callerForLogin(db, { userId: 'u-anika', email: 'anika@quillmont.example', emailVerified: true }, { dbRole: 'vdrkit_app' });
    expect(caller).toMatchObject({ tenantId: out.tenantId, principal: { personId: out.personId } });
  });

  it('lets the new admin sign in at once', async () => {
    const keyProvider = new LocalKeyProvider(randomBytes(32).toString('base64'));
    const mailer = new SiteMailChannel({ db, dbRole: 'vdrkit_app', env: {}, keyProvider, transport: mail.factory, cacheMs: 60_000 });
    const app = await buildApp({
      db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => clock, storage, publicUrl: 'https://dataroom.quillmont.example',
      rateLimit: false, mailer,
      site: { env: {}, mailTransport: mail.factory, probes: fakeProbes(), keyProvider,
        setup: { log: (l) => logs.push(l), generateCode: () => codes[codeIndex++] ?? 'ZZZZ-ZZZZ',
          fetch: (async () => new Response('{"status":"ok"}', { status: 200 })) as unknown as typeof fetch } },
    });
    await app.ready();
    apps.push(app);
    const msg = { to: 'anika@quillmont.example', subject: 'Sign in', text: 'Your code' };
    expect(await mailer.send(msg)).toEqual({ status: 'failed', error: 'No mail server is configured' });

    const token = await unlock(app);
    const h = tokenHeader(token);
    await fillIn(app, token);
    expect((await app.inject({ method: 'PUT', url: '/v1/setup/mail', headers: h, payload: {
      host: 'smtp.quillmont.example', port: 587, security: 'starttls', user: null, fromAddress: 'dataroom@quillmont.example' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/setup/test-email', headers: h })).json().status).toBe('accepted');
    expect((await app.inject({ method: 'POST', url: '/v1/setup/finish', headers: h })).statusCode).toBe(201);

    expect(await mailer.send(msg)).toMatchObject({ status: 'accepted' });
    expect(mail.sent.at(-1)!.settings).toMatchObject({ host: 'smtp.quillmont.example', port: 587 });
  });

  it('closes setup for good', async () => {
    const app = await start();
    const token = await unlock(app);
    const h = tokenHeader(token);
    await fillIn(app, token);
    await app.inject({ method: 'POST', url: '/v1/setup/test-email', headers: h });
    expect((await app.inject({ method: 'POST', url: '/v1/setup/finish', headers: h })).statusCode).toBe(201);

    for (const [method, url] of [['GET', '/v1/setup/draft'], ['PUT', '/v1/setup/admin'], ['POST', '/v1/setup/finish'], ['POST', '/v1/setup/test-email']] as const) {
      expect((await app.inject({ method, url, headers: h, payload: method === 'GET' ? undefined : ADMIN })).statusCode, url).toBe(404);
    }
    expect((await app.inject({ method: 'GET', url: '/v1/setup' })).json()).toEqual({ open: false, version: null });
    logs = [];
    const again = await start();
    expect(logs).toEqual([]);
    expect((await again.inject({ method: 'POST', url: '/v1/setup/unlock', payload: { code: 'P9RT-2HNB' } })).statusCode).toBe(404);
  });

  it('returns 404 for anything once closed', async () => {
    const app = await start();
    expect((await app.inject({ method: 'GET', url: '/v1/setup' })).json().version).toMatch(/^\d+\.\d+\.\d+/);
    expect((await app.inject({ method: 'PUT', url: '/v1/setup/admin', payload: { nonsense: true } })).statusCode).toBe(400);
    const token = await unlock(app);
    const h = tokenHeader(token);
    await fillIn(app, token);
    await app.inject({ method: 'POST', url: '/v1/setup/test-email', headers: h });
    expect((await app.inject({ method: 'POST', url: '/v1/setup/finish', headers: h })).statusCode).toBe(201);
    const closed: [string, string, unknown, string?][] = [
      ['PUT', '/v1/setup/admin', { nonsense: true }], ['POST', '/v1/setup/unlock', {}], ['PUT', '/v1/setup/mail', { host: '' }],
      ['PUT', '/v1/setup/organisation', { name: 1 }], ['PUT', '/v1/setup/logos/light', png(10, 10), 'image/png'], ['GET', '/v1/setup/logos/light', undefined],
      ['DELETE', '/v1/setup/logos/sideways', undefined], ['GET', '/v1/setup/checks', undefined],
    ];
    for (const [method, url, payload, type] of closed) {
      const res = await app.inject({ method: method as 'GET', url, headers: { ...h, ...(type ? { 'content-type': type } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json().detail).toBe('Setup is finished. Sign in instead.');
    }
    expect((await app.inject({ method: 'GET', url: '/v1/setup' })).json()).toEqual({ open: false, version: null });
  });

  it('keeps .env as the mail source', async () => {
    const app = await start();
    const token = await unlock(app);
    const h = tokenHeader(token);
    await fillIn(app, token);
    await app.inject({ method: 'POST', url: '/v1/setup/test-email', headers: h });
    expect((await app.inject({ method: 'POST', url: '/v1/setup/finish', headers: h })).statusCode).toBe(201);
    const s = (await pg.query<any>(`select mail_host, mail_password_wrapped from site_settings`)).rows[0];
    expect(s).toEqual({ mail_host: null, mail_password_wrapped: null });
  });

  it('should finish only one of two setups', async () => {
    // two processes, one database
    const a = await start();
    const b = await start();
    const ta = await unlock(a, 'K7QM-4XWD');
    const tb = await unlock(b, 'P9RT-2HNB');
    for (const [app, t] of [[a, ta], [b, tb]] as const) {
      await fillIn(app, t);
      await app.inject({ method: 'POST', url: '/v1/setup/test-email', headers: tokenHeader(t) });
    }
    const [ra, rb] = await Promise.all([
      a.inject({ method: 'POST', url: '/v1/setup/finish', headers: tokenHeader(ta) }),
      b.inject({ method: 'POST', url: '/v1/setup/finish', headers: tokenHeader(tb) }),
    ]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([201, 404]);
    expect((await pg.query(`select id from tenant`)).rows).toHaveLength(1);
    expect((await pg.query(`select 1 from person`)).rows).toHaveLength(1);
  });

  it('refuses a second finish while the first runs', async () => {
    const app = await start();
    const token = await unlock(app);
    const h = tokenHeader(token);
    await fillIn(app, token);
    await app.inject({ method: 'POST', url: '/v1/setup/test-email', headers: h });
    const [r1, r2] = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/v1/setup/finish', headers: h })));
    expect([r1!.statusCode, r2!.statusCode].sort()).toEqual([201, 409]);
  });

  it('needs a master key for a typed password', async () => {
    const app = await start({ keyProvider: false });
    const token = await unlock(app);
    const h = tokenHeader(token);
    await fillIn(app, token);
    await app.inject({ method: 'PUT', url: '/v1/setup/mail', headers: h, payload: {
      host: 'mail.quillmont.example', port: 587, security: 'starttls', user: 'x@quillmont.example', password: 'typed', fromAddress: 'x@quillmont.example' } });
    await app.inject({ method: 'POST', url: '/v1/setup/test-email', headers: h });
    const res = await app.inject({ method: 'POST', url: '/v1/setup/finish', headers: h });
    expect(res.statusCode).toBe(503);
    expect((await pg.query(`select 1 from tenant`)).rows).toHaveLength(0);
  });
});
