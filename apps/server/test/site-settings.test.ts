// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { appendEvent, verifyChain, withTenant } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { LocalKeyProvider } from '../src/crypto/envelope.js';
import { MemoryStorage } from '../src/pipeline/pipeline.js';
import { callerForLogin } from '../src/auth/person-link.js';
import { SiteMailChannel } from '../src/site/mail.js';
import { heron, T, TEST_DATABASE_URL, type Heron } from '../../../packages/core/test/fixture.js';
import { fakeProbes, fakeResolver, fakeTransport, png, TEST_ENV } from './site-helpers.js';

let h: Heron;
let app: FastifyInstance;
let mail: ReturnType<typeof fakeTransport>;
let storage: MemoryStorage;
let thabo: string;
let mailer: SiteMailChannel;
const keyProvider = new LocalKeyProvider(randomBytes(32).toString('base64'));

async function build(opts: { keyProvider?: boolean; env?: Record<string, string> } = {}) {
  mailer = new SiteMailChannel({ db: h.db, dbRole: 'vdrkit_app', env: opts.env ?? TEST_ENV, keyProvider, transport: mail.factory });
  return buildApp({
    db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at, storage, rateLimit: false, mailer,
    publicUrl: 'https://dataroom.quillmont.example',
    site: {
      env: opts.env ?? TEST_ENV, mailTransport: mail.factory, probes: fakeProbes(), setup: false,
      ...(opts.keyProvider === false ? {} : { keyProvider }),
      resolver: fakeResolver({
        'quillmont.example': ['v=spf1 include:_spf.quillmont.example ~all', 'google-site-verification=abc'],
        'dataroom._domainkey.quillmont.example': ['v=DKIM1; k=rsa; p=MIIBIjANBg'],
      }),
    },
  });
}

beforeEach(async () => {
  h = await heron();
  mail = fakeTransport();
  storage = new MemoryStorage();
  await h.pg.query(`update person set is_site_admin = true where id = $1`, [h.person.anika]);
  thabo = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email, is_site_admin) values ($1, 'Thabo Molefe', 'thabo@quillmont.example', true) returning id`, [h.t1])).rows[0]!.id;
  await h.pg.query(`insert into site_instance (tenant_id) values ($1)`, [h.t1]);
  app = await build();
});
afterEach(async () => {
  await app.close();
  await h.pg.close();
});

const as = (person: string, tenant?: string) => ({ 'x-dev-person': person, 'x-dev-tenant': tenant ?? h.t1 });
const get = (url: string, person = h.person.anika) => app.inject({ method: 'GET', url, headers: as(person) });
const send = (method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, person = h.person.anika) =>
  app.inject({ method, url, headers: as(person), ...(payload === undefined ? {} : { payload: payload as object }) });

const MAIL = { host: 'mail.quillmont.example', port: 465, security: 'tls', user: 'dataroom@quillmont.example', password: 'db-secret-pw',
  fromAddress: 'dataroom@quillmont.example' };

describe('who may use site settings', () => {
  const ROUTES: [string, string, unknown?][] = [
    ['GET', '/v1/site/settings'], ['PATCH', '/v1/site/settings', { organisationName: 'Nope' }], ['DELETE', '/v1/site/settings/mail'],
    ['POST', '/v1/site/mail/test', {}], ['GET', '/v1/site/mail/domain-check'], ['GET', '/v1/site/rooms'],
    ['POST', '/v1/site/rooms/00000000-0000-4000-8000-000000000000/join', { reason: 'Because I can' }],
    ['POST', '/v1/site/room-creators', { email: 'x@quillmont.example' }], ['POST', '/v1/site/admins', { email: 'x@quillmont.example' }],
    ['GET', '/v1/site/accounts'], ['GET', '/v1/site/health'], ['GET', '/v1/site/events'], ['GET', '/v1/site/sign-in-failures'],
    ['DELETE', '/v1/site/branding/logos/light'],
    ['POST', '/v1/site/accounts/00000000-0000-4000-8000-000000000000/reset-two-factor', {}],
    ['POST', '/v1/site/accounts/00000000-0000-4000-8000-000000000000/enable', {}],
  ];

  it('refuses non-site-admins', async () => {
    await h.pg.query(`update person set is_site_admin = false where id = $1`, [h.person.anika]);
    for (const p of [h.person.anika, h.person.maria, h.person.jan]) {
      for (const [method, url, body] of ROUTES) {
        const res = await app.inject({ method: method as 'GET', url, headers: as(p), ...(body === undefined ? {} : { payload: body as object }) });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json().reason).toBe('not_site_admin');
      }
    }
  });

  it('refuses agents', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/site/settings', headers: { ...as(h.person.anika), 'x-dev-agent-max-level': '60' } });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a disabled site admin', async () => {
    await h.pg.query(`update person set disabled_at = now() where id = $1`, [thabo]);
    expect((await get('/v1/site/settings', thabo)).statusCode).toBe(403);
  });

  it('should require a caller', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/site/settings' })).statusCode).toBe(401);
  });
});

describe('outgoing email', () => {
  it('shows .env settings without the password', async () => {
    const res = await get('/v1/site/settings');
    expect(res.json().mail).toEqual({ source: 'env', host: 'smtp.quillmont.example', port: 587, security: 'starttls', user: 'dataroom@quillmont.example',
      passwordSet: true, fromAddress: 'dataroom@quillmont.example', dkimSelector: 'default' });
    expect(res.body).not.toContain('env-secret-pw');
  });

  it('encrypts the password', async () => {
    const saved = await send('PATCH', '/v1/site/settings', { mail: MAIL });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().mail).toMatchObject({ source: 'database', host: 'mail.quillmont.example', port: 465, security: 'tls', passwordSet: true });
    expect(saved.body).not.toContain('db-secret-pw');
    const row = (await h.pg.query<any>(`select * from site_settings`)).rows[0];
    expect(JSON.stringify(row)).not.toContain('db-secret-pw');
    expect(row.mail_password_wrapped.provider).toBe('local');

    await send('PATCH', '/v1/site/settings', { mail: { ...MAIL, port: 587, security: 'starttls', password: '' } });
    await send('POST', '/v1/site/mail/test', {});
    expect(mail.sent.at(-1)!.settings).toMatchObject({ host: 'mail.quillmont.example', password: 'db-secret-pw', from: 'dataroom@quillmont.example' });

    const events = (await h.pg.query<any>(`select action, data from event where workspace_id is null order by seq`)).rows;
    expect(events.map((e: any) => e.action)).toEqual(['site.settings.changed', 'site.settings.changed', 'site.mail.test_sent']);
    expect(events[0].data).toMatchObject({ fields: ['mail'], mail_password_changed: true, actor_person_id: h.person.anika });
    expect(events[1].data).toMatchObject({ mail_password_changed: false });
    expect(JSON.stringify(events)).not.toContain('db-secret-pw');
  });

  it('ignores sender names', async () => {
    const saved = await send('PATCH', '/v1/site/settings', { mail: { ...MAIL, fromName: 'Quillmont mail' } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().mail).not.toHaveProperty('fromName');
    expect((await h.pg.query<any>(`select mail_from_name from site_settings`)).rows[0].mail_from_name).toBeNull();
    await h.pg.query(`update site_settings set mail_from_name = 'Old sender name'`);
    await send('POST', '/v1/site/mail/test', {});
    expect(mail.sent.at(-1)!.settings.from).toBe('dataroom@quillmont.example');
    expect((await get('/v1/site/settings')).body).not.toContain('Old sender name');
  });

  it('keeps the installation password on first save', async () => {
    await send('PATCH', '/v1/site/settings', { mail: { ...MAIL, host: 'smtp.quillmont.example', password: undefined } });
    await send('POST', '/v1/site/mail/test', {});
    expect(mail.sent.at(-1)!.settings.password).toBe('env-secret-pw');
  });

  it('needs a master key for passwords', async () => {
    await app.close();
    app = await build({ keyProvider: false });
    const res = await send('PATCH', '/v1/site/settings', { mail: MAIL });
    expect(res.statusCode).toBe(503);
    expect((await h.pg.query(`select mail_host from site_settings where mail_host is not null`)).rows).toHaveLength(0);
  });

  it('prefers saved settings', async () => {
    const msg = { personId: h.person.anika, to: 'anika@quillmont.example', subject: 'Hello', lines: ['Hi'] };
    await mailer.send(msg);
    expect(mail.sent.at(-1)!.settings.host).toBe('smtp.quillmont.example');
    await send('PATCH', '/v1/site/settings', { mail: MAIL });
    await mailer.send(msg);
    expect(mail.sent.at(-1)!.settings).toMatchObject({ host: 'mail.quillmont.example', password: 'db-secret-pw' });
    const back = await send('DELETE', '/v1/site/settings/mail');
    expect(back.json().mail.source).toBe('env');
    await mailer.send(msg);
    expect(mail.sent.at(-1)!.settings.host).toBe('smtp.quillmont.example');
  });

  it('records nothing as sent without a mail server', async () => {
    await app.close();
    app = await build({ env: {} });
    expect((await get('/v1/site/settings')).json().mail.source).toBe('none');
    expect(await mailer.send({ personId: h.person.anika, to: 'a@b.example', subject: 's', lines: [] })).toEqual({ status: 'failed', error: 'No mail server is configured' });
    expect(mail.sent).toHaveLength(0);
  });

  it('sends a test email with unsaved settings', async () => {
    const res = await send('POST', '/v1/site/mail/test', { mail: { ...MAIL, password: 'unsaved-pw' } });
    expect(res.json()).toMatchObject({ status: 'accepted', sentTo: 'anika@quillmont.example', server: 'mail.quillmont.example:465 (TLS)' });
    expect(mail.sent.at(-1)!.msg.to).toBe('anika@quillmont.example');
    expect((await get('/v1/site/settings')).json().mail.source).toBe('env');
    mail.state.accept = false;
    const bad = await send('POST', '/v1/site/mail/test', {});
    expect(bad.json()).toMatchObject({ status: 'failed', error: 'The mail server refused the user name or password. Error code: 535.' });
    const ev = (await h.pg.query<any>(`select action, data from event where workspace_id is null order by seq`)).rows;
    expect(ev.map((e: any) => e.action)).toEqual(['site.mail.test_sent', 'site.mail.test_not_sent']);
    expect(JSON.stringify(ev)).not.toContain('unsaved-pw');
  });

  it('checks SPF, DKIM and DMARC', async () => {
    const res = (await get('/v1/site/mail/domain-check?selector=dataroom')).json();
    expect(res).toMatchObject({
      domain: 'quillmont.example',
      spf: { status: 'pass', record: 'v=spf1 include:_spf.quillmont.example ~all' },
      dkim: { status: 'pass', selector: 'dataroom', name: 'dataroom._domainkey.quillmont.example' },
      dmarc: { status: 'missing', record: null },
    });
    expect(res.dmarc.fix).toContain('v=DMARC1; p=none');
    const def = (await get('/v1/site/mail/domain-check')).json();
    expect(def.dkim).toMatchObject({ selector: 'default', status: 'missing' });
    await send('PATCH', '/v1/site/settings', { dkimSelector: 'dataroom' });
    expect((await get('/v1/site/mail/domain-check')).json().dkim.status).toBe('pass');
  });
});

describe('branding', () => {
  it('uploads, replaces and removes logos', async () => {
    const up = await app.inject({ method: 'PUT', url: '/v1/site/branding/logos/light?filename=quillmont-logo.png', headers: { ...as(h.person.anika), 'content-type': 'image/png' }, payload: png(360, 80) });
    expect(up.statusCode).toBe(200);
    expect(up.json().organisation.logos.light).toMatchObject({ filename: 'quillmont-logo.png', displaySize: { width: 180, height: 40 } });
    expect(up.body).not.toContain('site/');   // never the storage key
    const first = [...storage.objects.keys()];
    await app.inject({ method: 'PUT', url: '/v1/site/branding/logos/light', headers: { ...as(h.person.anika), 'content-type': 'image/png' }, payload: png(100, 20) });
    expect([...storage.objects.keys()]).not.toContain(first[0]);
    expect(storage.objects.size).toBe(1);

    const pub = await app.inject({ method: 'GET', url: '/v1/branding' });
    expect(pub.statusCode).toBe(200);
    expect(pub.json()).toMatchObject({ organisationName: 'Quillmont Advisory', logos: { light: { width: 100, height: 20 }, dark: null } });
    const file = await app.inject({ method: 'GET', url: '/v1/branding/logos/light' });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['content-security-policy']).toContain("default-src 'none'");
    expect(file.headers['x-content-type-options']).toBe('nosniff');

    const rm = await send('DELETE', '/v1/site/branding/logos/light');
    expect(rm.json().organisation.logos.light).toBeNull();
    expect(storage.objects.size).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/v1/branding/logos/light' })).statusCode).toBe(404);
    const actions = (await h.pg.query<any>(`select action from event where workspace_id is null order by seq`)).rows.map((r: any) => r.action);
    expect(actions).toEqual(['site.logo.uploaded', 'site.logo.replaced', 'site.logo.removed']);
  });

  it('should convert SVG logos to PNG', async () => {
    const NS = 'xmlns="http://www.w3.org/2000/svg" width="90" height="20"';
    for (const svg of [
      `<svg ${NS} onload="alert(1)"><rect width="90" height="20" fill="#036"/></svg>`,
      `<svg ${NS}><style>rect { fill: #036 }</style><rect width="90" height="20"/><image href="https://tracker.example/x.png" width="9" height="9"/></svg>`,
      `<svg ${NS}><foreignObject width="9" height="9"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject><rect width="90" height="20" fill="#036"/></svg>`,
      `<svg ${NS}><script>alert(1)</script><a href="javascript:alert(1)"><rect width="90" height="20" fill="#036"/></a></svg>`,
    ]) {
      const res = await app.inject({ method: 'PUT', url: '/v1/site/branding/logos/dark?filename=quillmont.svg', headers: { ...as(h.person.anika), 'content-type': 'image/svg+xml' }, payload: svg });
      expect(res.statusCode, svg).toBe(200);
      expect(res.json().organisation.logos.dark).toMatchObject({ filename: 'quillmont.svg', mime: 'image/png', width: 720, height: 160, displaySize: { width: 180, height: 40 } });
      const stored = [...storage.objects.values()];
      expect(stored).toHaveLength(1);
      expect(Buffer.from(stored[0]!).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
      const file = await app.inject({ method: 'GET', url: '/v1/branding/logos/dark' });
      expect(file.headers['content-type']).toBe('image/png');
      expect(file.body).not.toContain('<svg');
    }
    for (const bad of ['<svg xmlns="http://www.w3.org/2000/svg"><rect', 'not an svg at all']) {
      const res = await app.inject({ method: 'PUT', url: '/v1/site/branding/logos/light', headers: { ...as(h.person.anika), 'content-type': 'image/svg+xml' }, payload: bad });
      expect([res.statusCode, res.json().detail]).toEqual([400, 'This file is not an SVG image. Upload a PNG or SVG file.']);
    }
    const tooBig = await app.inject({ method: 'PUT', url: '/v1/site/branding/logos/light', headers: { ...as(h.person.anika), 'content-type': 'image/svg+xml' },
      payload: `<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"><!-- ${'x'.repeat(520 * 1024)} --></svg>` });
    expect([tooBig.statusCode, tooBig.json().detail]).toEqual([400, 'A logo can be at most 512 KB.']);
    const gif = await app.inject({ method: 'PUT', url: '/v1/site/branding/logos/dark', headers: { ...as(h.person.anika), 'content-type': 'application/octet-stream' }, payload: Buffer.from('GIF89a') });
    expect([400, 415]).toContain(gif.statusCode);
  });

  it('serves a legacy SVG logo as PNG', async () => {
    const key = 'site/legacy/branding/logo-light.svg';
    await storage.put(key, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="90" height="20"><rect width="90" height="20" fill="#036"/></svg>'));
    await h.pg.query(`insert into site_settings (tenant_id, logo_light) values ($1, $2)
      on conflict (tenant_id) do update set logo_light = excluded.logo_light`,
      [h.t1, JSON.stringify({ key, filename: 'old.svg', mime: 'image/svg+xml', size: 100, width: 90, height: 20, sha256: 'a'.repeat(64) })]);
    const file = await app.inject({ method: 'GET', url: '/v1/branding/logos/light' });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.rawPayload.subarray(1, 4).toString('latin1')).toBe('PNG');
  });

  it('renames the organisation', async () => {
    const res = await send('PATCH', '/v1/site/settings', { organisationName: 'Quillmont Advisory (Pty) Ltd' });
    expect(res.json().organisation.name).toBe('Quillmont Advisory (Pty) Ltd');
    expect((await h.pg.query<any>(`select name from tenant where id = $1`, [h.t1])).rows[0].name).toBe('Quillmont Advisory (Pty) Ltd');
    await send('PATCH', '/v1/site/settings', { organisationName: 'Quillmont Advisory (Pty) Ltd' });
    const ev = (await h.pg.query<any>(`select action, data from event where workspace_id is null`)).rows;
    expect(ev).toEqual([{ action: 'site.settings.changed', data: expect.objectContaining({ fields: ['organisationName'] }) }]);
    expect(await h.app((tx) => verifyChain(tx, h.t1))).toMatchObject({ firstBroken: null });
  });
});

describe('privacy notice', () => {
  const pub = async () => (await app.inject({ method: 'GET', url: '/v1/branding' })).json();
  const page = () => app.inject({ method: 'GET', url: '/v1/branding/privacy' });

  it('starts empty', async () => {
    expect((await get('/v1/site/settings')).json().organisation.privacyNotice).toEqual({ kind: 'none' });
    expect((await pub()).privacyNotice).toBeNull();
    expect((await page()).statusCode).toBe(404);
  });

  it('saves a web address and logs it', async () => {
    const res = await send('PATCH', '/v1/site/settings', { privacyNotice: { url: 'https://quillmont.example/privacy' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().organisation.privacyNotice).toEqual({ kind: 'url', url: 'https://quillmont.example/privacy' });
    expect((await pub()).privacyNotice).toEqual({ kind: 'url', url: 'https://quillmont.example/privacy' });
    expect((await page()).statusCode).toBe(404);
    const ev = (await get('/v1/site/events')).json().items[0];
    expect(ev).toMatchObject({ action: 'site.settings.changed', data: { fields: ['privacyNotice'] } });
    await send('PATCH', '/v1/site/settings', { privacyNotice: { url: 'https://quillmont.example/privacy' } });
    expect((await h.pg.query(`select 1 from event where action = 'site.settings.changed'`)).rows).toHaveLength(1);
  });

  it('saves pasted text as a public page', async () => {
    expect((await send('PATCH', '/v1/site/settings', { privacyNotice: { url: 'https://quillmont.example/privacy' } })).statusCode).toBe(200);
    const text = '  Quillmont Advisory processes your name and email address.\r\n\r\n<script>alert(1)</script> stays text.  ';
    const res = await send('PATCH', '/v1/site/settings', { privacyNotice: { text } });
    expect(res.json().organisation.privacyNotice).toEqual({ kind: 'text', text: 'Quillmont Advisory processes your name and email address.\n\n<script>alert(1)</script> stays text.' });
    expect((await pub()).privacyNotice).toEqual({ kind: 'page' });
    const p = await page();
    expect(p.statusCode).toBe(200);
    expect(p.headers['content-type']).toContain('application/json');
    expect(p.json()).toEqual({ organisationName: 'Quillmont Advisory', text: 'Quillmont Advisory processes your name and email address.\n\n<script>alert(1)</script> stays text.' });
    const row = (await h.pg.query<any>(`select privacy_url, privacy_text from site_settings where tenant_id = $1`, [h.t1])).rows[0];
    expect(row.privacy_url).toBeNull();
  });

  it('removes the notice with null', async () => {
    expect((await send('PATCH', '/v1/site/settings', { privacyNotice: { text: 'Our notice.' } })).statusCode).toBe(200);
    expect((await send('PATCH', '/v1/site/settings', { privacyNotice: null })).json().organisation.privacyNotice).toEqual({ kind: 'none' });
    expect((await pub()).privacyNotice).toBeNull();
    expect((await page()).statusCode).toBe(404);
  });

  it('validates input', async () => {
    for (const bad of [{ url: 'javascript:alert(1)' }, { url: 'quillmont.example/privacy' }, { url: 'https://a b.example' }, { text: '   ' },
      { url: 'https://quillmont.example/p', text: 'x' }, { text: 'x'.repeat(50_001) }]) {
      expect((await send('PATCH', '/v1/site/settings', { privacyNotice: bad })).statusCode, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
    const res = await send('PATCH', '/v1/site/settings', { privacyNotice: { url: 'https://evil.example' } }, h.person.maria);
    expect(res.statusCode).toBe(403);
    expect((await pub()).privacyNotice).toBeNull();
  });

  it('is enforced by the database', async () => {
    await send('PATCH', '/v1/site/settings', { privacyNotice: { text: 'Our notice.' } });
    await expect(h.pg.query(`update site_settings set privacy_url = 'https://x.example' where tenant_id = $1`, [h.t1])).rejects.toThrow();
    await expect(h.pg.query(`update site_settings set privacy_text = null, privacy_url = 'javascript:alert(1)' where tenant_id = $1`, [h.t1])).rejects.toThrow();
  });
});

describe('rooms', () => {
  it('lists every room without its content', async () => {
    await h.pg.query(`insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime) values ($1, $2, 1, 'k', $3, 2048, 'application/pdf')`, [h.t1, h.node.aud1, 'a'.repeat(64)]);
    const res = await get('/v1/site/rooms', thabo);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toEqual([expect.objectContaining({
      id: h.ws, name: 'Project Heron', seller: 'Seller', state: 'open', people: 5, storageBytes: 2048, youAreAdmin: false,
      roomAdmins: [{ personId: h.person.anika, name: 'Anika Pillay' }],
    })]);
    expect(body.totals).toEqual({ rooms: 1, storageBytes: 2048 });
    for (const secret of ['Finance', 'Audited', 'Tax', 'FY2025']) expect(res.body).not.toContain(secret);
  });

  it('has no access before joining', async () => {
    for (const path of ['nodes', `nodes/${h.node.aud1}`, 'dashboard', 'events']) {
      expect((await get(`/v1/workspaces/${h.ws}/${path}`, thabo)).statusCode, path).toBe(404);
    }
  });

  it('joins a room with a reason', async () => {
    expect((await send('POST', `/v1/site/rooms/${h.ws}/join`, { reason: '' }, thabo)).statusCode).toBe(400);
    expect((await send('POST', `/v1/site/rooms/${h.ws}/join`, {}, thabo)).statusCode).toBe(400);

    const res = await send('POST', `/v1/site/rooms/${h.ws}/join`, { reason: 'Anika is on leave and the bidders need access today' }, thabo);
    expect(res.statusCode).toBe(200);
    expect(res.json().notified).toEqual([{ personId: h.person.anika, status: 'accepted' }]);
    const email = mail.sent.at(-1)!.msg;
    expect(email.to).toBe('anika@quillmont.example');
    expect(email.subject).toBe('Thabo Molefe, site admin, joined Project Heron');
    expect(email.text!).toContain('Anika is on leave and the bidders need access today');

    expect((await get(`/v1/workspaces/${h.ws}/nodes/${h.node.aud1}`, thabo)).statusCode).toBe(200);
    const log = (await get(`/v1/workspaces/${h.ws}/events`, h.person.anika)).json().items;
    const joined = log.find((e: any) => e.action === 'workspace.site_admin_joined');
    expect(joined).toMatchObject({ actorName: 'Thabo Molefe', data: { reason: 'Anika is on leave and the bidders need access today', person_id: thabo } });
    expect(log.map((e: any) => e.action)).toContain('workspace.join_notice_sent');
    const site = (await h.pg.query<any>(`select action from event where workspace_id is null`)).rows.map((r: any) => r.action);
    expect(site).toEqual(['site.room_joined']);

    expect((await send('POST', `/v1/site/rooms/${h.ws}/join`, { reason: 'Again please' }, thabo)).statusCode).toBe(409);
    expect((await get('/v1/site/rooms', thabo)).json().items[0].youAreAdmin).toBe(true);
  });

  it('returns 404 for a deleted or foreign room', async () => {
    // state trigger needs tenant 2
    if (TEST_DATABASE_URL) await h.pg.query(`select set_config('app.tenant_id', $1, false)`, [h.t2]);
    const other = (await h.pg.query<{ id: string }>(`insert into workspace (tenant_id, name) values ($1, 'Elsewhere') returning id`, [h.t2])).rows[0]!.id;
    if (TEST_DATABASE_URL) await h.pg.query(`select set_config('app.tenant_id', $1, false)`, [h.t1]);
    expect((await send('POST', `/v1/site/rooms/${other}/join`, { reason: 'Curious about it' }, thabo)).statusCode).toBe(404);
    await h.pg.query(`update workspace set state = 'deleted' where id = $1`, [h.ws]);
    expect((await send('POST', `/v1/site/rooms/${h.ws}/join`, { reason: 'Curious about it' }, thabo)).statusCode).toBe(404);
  });
});

describe('who may create rooms', () => {
  const create = (person: string) => send('POST', '/v1/workspaces', { name: 'Project Osprey' }, person);

  it('lets listed people create rooms', async () => {
    expect((await create(h.person.maria)).statusCode).toBe(404);
    const add = await send('POST', '/v1/site/room-creators', { email: 'maria@drosvelt.example' });
    expect(add.json()).toMatchObject({ personId: h.person.maria, created: false, emailStatus: 'accepted' });
    const room = await create(h.person.maria);
    expect(room.statusCode).toBe(201);
    const mine = (await get('/v1/me/workspaces', h.person.maria)).json().items;
    expect(mine.map((w: any) => `${w.name}:${w.isAdmin}`)).toEqual(['Project Heron:false', 'Project Osprey:true']);
    expect((await get('/v1/site/rooms', h.person.maria)).statusCode).toBe(403);

    expect((await send('DELETE', `/v1/site/room-creators/${h.person.maria}`)).statusCode).toBe(204);
    expect((await create(h.person.maria)).statusCode).toBe(404);
    expect((await get(`/v1/workspaces/${room.json().id}/settings`, h.person.maria)).statusCode).toBe(200);
    expect((await create(thabo)).statusCode).toBe(201);
  });

  it('refuses to list a site admin as a creator', async () => {
    const before = (await get('/v1/site/settings')).json().rooms.creators;
    const res = await send('POST', '/v1/site/room-creators', { email: 'thabo@quillmont.example' });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toBe('Thabo Molefe is a site admin. Site admins can always create rooms, so they are not listed here.');
    expect(res.json().reason).toBe('already_site_admin');
    expect((await get('/v1/site/settings')).json().rooms.creators).toEqual(before);
    expect((await h.pg.query(`select 1 from event where action = 'site.room_creator.added'`)).rows).toHaveLength(0);
    expect((await create(thabo)).statusCode).toBe(201);
  });

  it('adds a creator without an account', async () => {
    const res = (await send('POST', '/v1/site/room-creators', { email: 'ruth.mahlangu@quillmont.example' })).json();
    expect(res).toMatchObject({ name: 'Ruth Mahlangu', created: true });
    expect((await h.pg.query(`select 1 from auth_person where person_id = $1`, [res.personId])).rows).toHaveLength(1);
    expect((await get('/v1/site/settings')).json().rooms.creators.map((c: any) => c.name)).toEqual(['Ruth Mahlangu']);
  });

  it('defaults to site admins only', async () => {
    const settings = (await get('/v1/site/settings')).json();
    expect(settings.rooms).toEqual({ creators: [] });
    expect((await create(h.person.maria)).statusCode).toBe(404);
    expect((await create(thabo)).statusCode).toBe(201);
    await send('PATCH', '/v1/site/settings', { whoCanCreateRooms: 'domain', organisationDomain: 'heron.example' });
    expect((await create(h.person.maria)).statusCode).toBe(404);
    const ev = (await h.pg.query<any>(`select data from event where action = 'site.settings.changed' order by seq`)).rows.map((r: any) => r.data.fields);
    expect(ev).toEqual([['organisationDomain']]);
  });

  it('should block disabled people', async () => {
    expect((await send('POST', '/v1/site/room-creators', { email: 'maria@drosvelt.example' })).statusCode).toBe(200);
    expect((await send('POST', `/v1/site/accounts/${h.person.maria}/disable`, {})).statusCode).toBe(200);
    expect((await create(h.person.maria)).statusCode).toBe(404);
  });
});

describe('accounts', () => {
  async function signIn(person: string, userId: string, at: string, twoFactor = false) {
    const email = (await h.pg.query<{ email: string }>(`select email from person where id = $1`, [person])).rows[0]!.email;
    await h.pg.query(`insert into auth_user (id, name, email, email_verified, two_factor_enabled) values ($1, $1, $2, true, $3)`, [userId, email, twoFactor]);
    await h.pg.query(`insert into auth_person (tenant_id, person_id, email, user_id) values ($1, $2, $3, $4)
                      on conflict (tenant_id, person_id) do update set user_id = excluded.user_id`, [h.t1, person, email, userId]);
    await h.pg.query(`insert into auth_session (id, user_id, token, expires_at, created_at) values ($1, $2, $1, now() + interval '1 day', $3)`, [`s-${userId}`, userId, at]);
  }

  it('lists and searches accounts', async () => {
    await signIn(h.person.jan, 'u-jan', '2026-11-12T07:00:00Z', true);
    await signIn(h.person.maria, 'u-maria', '2026-11-11T07:00:00Z');
    const staff = (await get('/v1/site/accounts')).json();
    expect(staff.items.map((a: any) => a.name)).toEqual(['Anika Pillay', 'Thabo Molefe']);
    expect(staff.items[0]).toMatchObject({ isSiteAdmin: true, isYou: true, rooms: 1, twoFactor: 'not_set_up' });
    expect(staff.total).toBe(2);

    const all = (await get('/v1/site/accounts?filter=everyone&limit=3')).json();
    expect(all.total).toBe(6);
    expect(all.items.map((a: any) => a.name)).toEqual(['Jan de Vries', 'Maria Botha', 'Anika Pillay']);
    expect(all.items[0]).toMatchObject({ lastSignInAt: '2026-11-12T07:00:00.000Z', twoFactor: 'on', rooms: 1 });
    expect(all.items[1]).toMatchObject({ twoFactor: 'off' });
    const page2 = (await get('/v1/site/accounts?filter=everyone&limit=3&offset=3')).json();
    expect(page2.items).toHaveLength(3);
    expect(page2.total).toBe(6);

    const found = (await get('/v1/site/accounts?q=skarvik')).json();
    expect(found.items.map((a: any) => a.name)).toEqual(['Lars Eriksen']);
    expect((await get('/v1/site/accounts?q=%25')).json().total).toBe(0);
  });

  it('disables an account', async () => {
    await h.pg.query(`insert into auth_user (id, name, email, email_verified) values ('u-jan', 'Jan', 'jan@bidder-a.example', true)`);
    const login = { userId: 'u-jan', email: 'jan@bidder-a.example', emailVerified: true };
    await h.app((tx) => tx.query(`insert into auth_person (tenant_id, person_id, email) values (current_tenant_id(), $1, 'jan@bidder-a.example')`, [h.person.jan]));
    expect(await callerForLogin(h.db, login, { dbRole: 'vdrkit_app' })).not.toBeNull();
    await h.pg.query(`insert into auth_session (id, user_id, token, expires_at) values ('s1', 'u-jan', 't1', now() + interval '1 day'), ('s2', 'u-jan', 't2', now() + interval '1 day')`);

    const res = await send('POST', `/v1/site/accounts/${h.person.jan}/disable`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ personId: h.person.jan, sessionsEnded: 2 });
    expect((await h.pg.query(`select 1 from auth_session where user_id = 'u-jan'`)).rows).toHaveLength(0);
    expect(await callerForLogin(h.db, login, { dbRole: 'vdrkit_app' })).toBeNull();
    expect((await h.pg.query(`select 1 from membership where person_id = $1`, [h.person.jan])).rows.length).toBeGreaterThan(0);
    expect((await h.pg.query<any>(`select data from event where action = 'site.account.disabled'`)).rows[0].data).toMatchObject({ person_id: h.person.jan, sessions_ended: 2 });
    expect((await h.pg.query(`select 1 from event where action = 'account.disabled' and workspace_id = $1`, [h.ws])).rows).toHaveLength(1);
    const at = (await h.pg.query<any>(`select disabled_at from person where id = $1`, [h.person.jan])).rows[0].disabled_at;
    expect(new Date(at).toISOString()).toBe(T.at.toISOString());

    expect((await send('POST', `/v1/site/accounts/${h.person.jan}/disable`, {})).statusCode).toBe(409);
    expect((await send('POST', '/v1/site/admins', { email: 'jan@bidder-a.example' })).statusCode).toBe(409);
    expect((await get('/v1/site/accounts?q=jan')).json().items[0].disabledAt).not.toBeNull();
  });

  it('refuses own and foreign accounts', async () => {
    expect((await send('POST', `/v1/site/accounts/${h.person.anika}/disable`, {})).statusCode).toBe(409);
    const other = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Other', 'o@x.example') returning id`, [h.t2])).rows[0]!.id;
    expect((await send('POST', `/v1/site/accounts/${other}/disable`, {})).statusCode).toBe(404);
    expect((await h.pg.query<any>(`select disabled_at from person where id = $1`, [other])).rows[0].disabled_at).toBeNull();
  });

  it('adds a site admin', async () => {
    const res = (await send('POST', '/v1/site/admins', { email: 'lindiwe.zulu@quillmont.example', name: 'Lindiwe Zulu' })).json();
    expect(res).toMatchObject({ name: 'Lindiwe Zulu', created: true, emailStatus: 'accepted' });
    expect(mail.sent.at(-1)!.msg).toMatchObject({ to: 'lindiwe.zulu@quillmont.example', subject: 'You are now a site admin of Quillmont Advisory data rooms' });
    expect((await get('/v1/site/settings', res.personId)).statusCode).toBe(200);
    const maria = (await send('POST', '/v1/site/admins', { email: 'MARIA@drosvelt.example' })).json();
    expect(maria).toMatchObject({ personId: h.person.maria, created: false });
    expect((await send('POST', '/v1/site/admins', { email: 'maria@drosvelt.example' })).statusCode).toBe(409);
    const actions = (await get('/v1/site/events')).json().items.map((e: any) => `${e.action}:${e.actorName}`);
    expect(actions).toEqual(['site.admin.notice_sent:Anika Pillay', 'site.admin.added:Anika Pillay', 'site.admin.notice_sent:Anika Pillay', 'site.admin.added:Anika Pillay']);
  });
});

describe('failed sign-ins', () => {
  const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
  // the database stamps the time
  const failed = async (reason: string, email: string | null, minutesAgo: number, tenant = h.t1) => {
    await h.pin(new Date(T.at.getTime() - minutesAgo * 60_000));
    await withTenant(h.db, tenant, (tx) => appendEvent(tx, { action: 'auth.sign_in_failed', resourceType: 'sign_in',
      data: { reason, method: reason.includes('link') ? 'email_link' : 'email_code' },
      context: { ip: '203.0.113.18', userAgent: CHROME, personal: email ? { email } : null } }));
    await h.pin(T.at);
  };

  it('lists recent failures', async () => {
    // kept 30 days
    await failed('wrong_code', 'old@bidder-a.example', 60 * 24 * 31);
    await failed('wrong_code', 'jan@bidder-a.example', 60 * 30);
    await failed('wrong_code', 'nobody@nowhere.example', 30);
    await failed('link_used_or_expired', null, 10);
    const res = await get('/v1/site/sign-in-failures');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((i: any) => [i.reason, i.email, i.method, i.ip, i.browser])).toEqual([
      ['link_used_or_expired', null, 'email_link', '203.0.113.18', 'Chrome on Windows'],
      ['wrong_code', 'nobody@nowhere.example', 'email_code', '203.0.113.18', 'Chrome on Windows'],
      ['wrong_code', 'jan@bidder-a.example', 'email_code', '203.0.113.18', 'Chrome on Windows'],
    ]);
    expect(body.last24Hours).toBe(2);
    const page = (await get('/v1/site/sign-in-failures?limit=1')).json();
    expect(page.items).toHaveLength(1);
    const next = (await get(`/v1/site/sign-in-failures?limit=1&beforeSeq=${page.nextBeforeSeq}`)).json();
    expect(next.items[0].email).toBe('nobody@nowhere.example');
  });

  it('shows nothing to other tenants or room admins', async () => {
    await failed('wrong_code', 'jan@bidder-a.example', 5, h.t2);
    expect((await get('/v1/site/sign-in-failures')).json().items).toEqual([]);
    await h.pg.query(`update person set is_site_admin = false where id = $1`, [h.person.anika]);
    expect((await get('/v1/site/sign-in-failures')).statusCode).toBe(403);
  });
});

describe('two-factor reset by a site admin', () => {
  async function login(person: string, userId: string, twoFactor = true) {
    const email = (await h.pg.query<{ email: string }>(`select email from person where id = $1`, [person])).rows[0]!.email;
    await h.pg.query(`insert into auth_user (id, name, email, email_verified, two_factor_enabled) values ($1, $1, $2, true, $3)`, [userId, email, twoFactor]);
    await h.pg.query(`insert into auth_person (tenant_id, person_id, email, user_id) values ($1, $2, $3, $4)
                      on conflict (tenant_id, person_id) do update set user_id = excluded.user_id`, [h.t1, person, email, userId]);
    await h.pg.query(`insert into auth_session (id, user_id, token, expires_at) values ($1, $2, $1, now() + interval '1 day')`, [`s-${userId}`, userId]);
  }

  it("resets another site admin's two-factor", async () => {
    await login(thabo, 'u-thabo');
    const res = await send('POST', `/v1/site/accounts/${thabo}/reset-two-factor`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ personId: thabo, hadTwoFactor: true, sessionsEnded: 1, trustedBrowsersRemoved: 0 });
    expect((await h.pg.query<any>(`select two_factor_enabled from auth_user where id = 'u-thabo'`)).rows[0].two_factor_enabled).toBe(false);
    expect((await h.pg.query(`select 1 from auth_session where user_id = 'u-thabo'`)).rows).toHaveLength(0);
    const ev = (await get('/v1/site/events')).json().items[0];
    expect(ev).toMatchObject({ action: 'site.account.two_factor_reset', actorName: 'Anika Pillay', data: { person_id: thabo, had_two_factor: true, sessions_ended: 1 } });
    expect((await h.pg.query(`select 1 from event where action = 'auth.two_factor_reset'`)).rows).toHaveLength(0);
    expect((await get(`/v1/site/accounts?q=thabo`)).json().items[0].twoFactor).toBe('off');
  });

  it("logs it in each of the person's rooms", async () => {
    await login(h.person.jan, 'u-jan');
    expect((await send('POST', `/v1/site/accounts/${h.person.jan}/reset-two-factor`, {})).statusCode).toBe(200);
    const ev = (await h.pg.query<any>(`select workspace_id, data from event where action = 'auth.two_factor_reset'`)).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ workspace_id: h.ws, data: { person_id: h.person.jan, reset_by_site_admin: true, by_person_id: h.person.anika } });
  });

  it('refuses invalid targets and non-site-admins', async () => {
    await login(h.person.anika, 'u-anika');
    expect((await send('POST', `/v1/site/accounts/${h.person.anika}/reset-two-factor`, {})).statusCode).toBe(409);
    expect((await h.pg.query<any>(`select two_factor_enabled from auth_user where id = 'u-anika'`)).rows[0].two_factor_enabled).toBe(true);
    await h.pg.query(`update person set disabled_at = now() where id = $1`, [h.person.lars]);
    expect((await send('POST', `/v1/site/accounts/${h.person.lars}/reset-two-factor`, {})).statusCode).toBe(409);
    const other = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Other', 'o@x.example') returning id`, [h.t2])).rows[0]!.id;
    expect((await send('POST', `/v1/site/accounts/${other}/reset-two-factor`, {})).statusCode).toBe(404);
    const res = await send('POST', `/v1/site/accounts/${h.person.anika}/reset-two-factor`, {}, h.person.maria);
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe('not_site_admin');
    expect((await h.pg.query(`select 1 from event where action like '%two_factor_reset'`)).rows).toHaveLength(0);
  });

  it("refuses a login that opens another organisation's rooms", async () => {
    await login(h.person.jan, 'u-jan');
    await h.pg.query(`insert into person (id, tenant_id, name, email) values ('00000000-0000-4000-8000-0000000000aa', $1, 'Jan elsewhere', 'jan@bidder-a.example')`, [h.t2]);
    await h.pg.query(`insert into auth_person (tenant_id, person_id, email, user_id) values ($1, '00000000-0000-4000-8000-0000000000aa', 'jan@bidder-a.example', 'u-jan')`, [h.t2]);
    const res = await send('POST', `/v1/site/accounts/${h.person.jan}/reset-two-factor`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('login_used_by_another_organisation');
    expect((await h.pg.query<any>(`select two_factor_enabled from auth_user where id = 'u-jan'`)).rows[0].two_factor_enabled).toBe(true);
  });
});

describe('site rights', () => {
  it('tells each person only about themselves', async () => {
    expect((await get('/v1/site/me')).json()).toEqual({ isSiteAdmin: true, canCreateRooms: true });
    expect((await get('/v1/site/me', h.person.jan)).json()).toEqual({ isSiteAdmin: false, canCreateRooms: false });
    await send('POST', '/v1/site/room-creators', { email: 'maria@drosvelt.example' });
    expect((await get('/v1/site/me', h.person.maria)).json()).toEqual({ isSiteAdmin: false, canCreateRooms: true });
    await h.pg.query(`update person set disabled_at = now() where id = $1`, [thabo]);
    expect((await get('/v1/site/me', thabo)).json()).toEqual({ isSiteAdmin: false, canCreateRooms: false });
    const agent = await app.inject({ method: 'GET', url: '/v1/site/me', headers: { ...as(h.person.anika), 'x-dev-agent-max-level': '60' } });
    expect(agent.json()).toEqual({ isSiteAdmin: false, canCreateRooms: false });
    expect((await app.inject({ method: 'GET', url: '/v1/site/me' })).statusCode).toBe(401);
  });
});

describe('alerts settings', () => {
  it('saves alert recipients and delay', async () => {
    const res = await send('PATCH', '/v1/site/settings', { alerts: { notifySiteAdmins: false, extraEmail: 'it@quillmont.example', afterMinutes: 5 } });
    expect(res.json().alerts).toEqual({ notifySiteAdmins: false, extraEmail: 'it@quillmont.example', afterMinutes: 5 });
    expect((await send('PATCH', '/v1/site/settings', { alerts: { afterMinutes: 10 } })).statusCode).toBe(400);
  });
});

describe('mail password and logging', () => {
  it('keeps the saved password on its own server', async () => {
    const elsewhere = { ...MAIL, host: 'attacker.example', port: 587, security: 'starttls', password: undefined };
    const test = await send('POST', '/v1/site/mail/test', { mail: elsewhere });
    expect(test.statusCode).toBe(400);
    expect(test.json().detail).toContain('Type the password again');
    expect((await send('PATCH', '/v1/site/settings', { mail: elsewhere })).statusCode).toBe(400);
    expect((await send('POST', '/v1/site/mail/test', { mail: { ...elsewhere, host: 'smtp.quillmont.example', user: 'someone-else@quillmont.example' } })).statusCode).toBe(400);
    expect(mail.sent).toHaveLength(0);
    expect((await h.pg.query(`select 1 from site_settings where mail_host is not null`)).rows).toHaveLength(0);

    await send('PATCH', '/v1/site/settings', { mail: MAIL });
    expect((await send('POST', '/v1/site/mail/test', { mail: { ...MAIL, host: 'attacker.example', password: '' } })).statusCode).toBe(400);
    expect(mail.sent).toHaveLength(0);
    expect((await send('POST', '/v1/site/mail/test', { mail: { ...MAIL, host: 'MAIL.quillmont.example', port: 587, security: 'starttls', password: '' } })).json().status).toBe('accepted');
    expect(mail.sent.at(-1)!.settings.password).toBe('db-secret-pw');
    expect((await send('POST', '/v1/site/mail/test', { mail: { ...MAIL, host: 'other.example', password: 'typed-here' } })).json().status).toBe('accepted');
    expect(mail.sent.at(-1)!.settings).toMatchObject({ host: 'other.example', password: 'typed-here' });
    expect((await send('POST', '/v1/site/mail/test', { mail: { ...MAIL, host: 'relay.example', user: null, password: undefined } })).json().status).toBe('accepted');
    expect(mail.sent.at(-1)!.settings.password).toBeUndefined();
  });

  it('hides server replies on failure', async () => {
    mail.state.accept = false;
    mail.state.error = 'ECONNECTION 220: internal-db-01.corp ESMTP Postfix (Debian) ready, admin@corp';
    const r1 = (await send('POST', '/v1/site/mail/test', {})).json();
    expect(r1.status).toBe('failed');
    expect(r1.error).not.toContain('internal-db-01');
    expect(r1.error).toBe('The mail server could not be reached or refused the message. Error code: ECONNECTION 220.');
    mail.state.error = 'connect ECONNREFUSED 10.0.0.7:25';
    expect((await send('POST', '/v1/site/mail/test', {})).json().error).toBe('The mail server refused the connection. Check the server name and port. Error code: ECONNREFUSED.');
    const ev = (await h.pg.query<any>(`select data from event where action = 'site.mail.test_not_sent' order by seq`)).rows;
    expect(JSON.stringify(ev)).not.toContain('internal-db-01');
  });

  it('keeps sign-in noise out of the site log', async () => {
    await send('PATCH', '/v1/site/settings', { organisationName: 'Quillmont Advisory Ltd' });
    await h.app((tx) => appendEvent(tx, { action: 'auth.email_code.sent', resourceType: 'person', resourceId: h.person.jan,
      data: { recipient_person_id: h.person.jan, channel: 'email', delivery_status: 'accepted' } }));
    const items = (await get('/v1/site/events')).json().items;
    expect(items.map((e: any) => e.action)).toEqual(['site.settings.changed']);
  });

  it('sends no invitation to a disabled account', async () => {
    await send('POST', `/v1/site/accounts/${h.person.jan}/disable`, {});
    const sentBefore = mail.sent.length;
    const res = await app.inject({ method: 'POST', url: `/v1/workspaces/${h.ws}/invitations`, headers: as(h.person.anika),
      payload: { groupId: h.group.b, people: [{ email: 'jan@bidder-a.example', name: 'Jan de Vries' }] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain('disabled account');
    expect(mail.sent.length).toBe(sentBefore);
    expect((await h.pg.query(`select 1 from invitation where person_id = $1`, [h.person.jan])).rows).toHaveLength(0);
  });
});
