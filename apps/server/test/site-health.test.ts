// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Channel, OutgoingMessage } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { MemoryStorage } from '../src/pipeline/pipeline.js';
import { compareVersions, defaultProbes, runHealthAlerts, updateChecker, type HealthProbes } from '../src/site/health.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';
import { fakeProbes } from './site-helpers.js';

let h: Heron;
let outbox: OutgoingMessage[];
let accept: boolean;
const mailer: Channel = { name: 'email', send: async (m) => { outbox.push(m); return accept ? { status: 'accepted' } : { status: 'failed', error: 'refused' }; } };
let thabo: string;

beforeEach(async () => {
  h = await heron();
  outbox = [];
  accept = true;
  await h.pg.query(`update person set is_site_admin = true where id = $1`, [h.person.anika]);
  thabo = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email, is_site_admin) values ($1, 'Thabo Molefe', 'thabo@quillmont.example', true) returning id`, [h.t1])).rows[0]!.id;
  await h.pg.query(`insert into site_instance (tenant_id) values ($1)`, [h.t1]);
});
afterEach(async () => { await h.pg.close(); });

const at = (minutes: number) => new Date(T.at.getTime() + minutes * 60_000);

async function alertRun(min: number, o: { probes: HealthProbes; publicUrl?: string }) {
  await h.pin(at(min));
  return runHealthAlerts({ db: h.db, dbRole: 'vdrkit_app', mailer, ...o });
}

describe('health alerts', () => {
  it('emails site admins after 15 minutes', async () => {
    const probes = fakeProbes({ conversion: 'failing' });
    const run = (min: number) => alertRun(min, { probes, publicUrl: 'https://dataroom.quillmont.example' });

    expect((await run(0)).alerted).toEqual([]);
    expect((await run(14)).alerted).toEqual([]);
    expect(outbox).toHaveLength(0);
    expect((await run(15)).alerted).toEqual(['conversion']);
    expect(outbox.map((m) => m.to).sort()).toEqual(['anika@quillmont.example', 'thabo@quillmont.example']);
    expect(outbox[0]!.subject).toBe('Problem: document conversion is not working');
    expect(outbox[0]!.text).toContain('Document conversion is not working');
    expect(outbox[0]!.text).toContain('For: 15 minutes');
    expect(outbox[0]!.text).toContain('Effect: New Word, Excel and PowerPoint files cannot be converted');
    expect(outbox[0]!.text).toContain('Last error: Document conversion is down');
    expect(outbox[0]!.text).toContain('Open Health: https://dataroom.quillmont.example/site/settings/health');
    expect(outbox[0]!.text).toContain('You get this email because you are a site admin of Quillmont Advisory data rooms.');
    expect(outbox[0]!.fromName).toBe('Quillmont Advisory data rooms');      // the site's name
    expect((await run(16)).alerted).toEqual([]);
    expect((await run(90)).alerted).toEqual([]);
    expect(outbox).toHaveLength(2);

    probes.status.conversion = 'ok';
    expect((await run(91)).recovered).toEqual(['conversion']);
    expect(outbox).toHaveLength(4);
    expect(outbox[3]!.subject).toBe('Recovered: document conversion works again');
    expect(outbox[3]!.text).toContain('Outage: 1 hour 31 minutes');
    expect(outbox[3]!.html).toContain('#E4F3EA');
    expect((await run(92)).recovered).toEqual([]);

    const ev = (await h.pg.query<any>(`select action, data from event where workspace_id is null order by seq`)).rows;
    expect(ev.map((e: any) => e.action)).toEqual(['site.health.alert_sent', 'site.health.alert_sent', 'site.health.recovery_sent', 'site.health.recovery_sent']);
    expect(ev[0].data).toMatchObject({ checks: ['conversion'], delivery_status: 'accepted' });
  });

  it('follows the delay and extra address', async () => {
    await h.pg.query(`insert into site_settings (tenant_id, alert_admins, alert_extra_email, alert_after_minutes) values ($1, false, 'it@quillmont.example', 5)`, [h.t1]);
    const probes = fakeProbes({ email: 'failing' });
    const run = (min: number) => alertRun(min, { probes });
    await run(0);
    probes.status.email = 'ok';
    await run(3);            // a restart: back within the delay
    probes.status.email = 'failing';
    await run(4);
    expect((await run(8)).alerted).toEqual([]);
    expect((await run(9)).alerted).toEqual(['email']);
    expect(outbox.map((m) => m.to)).toEqual(['it@quillmont.example']);
    expect(outbox[0]!.text).toContain('this address is set to get the health alerts of Quillmont Advisory data rooms');
    expect(outbox[0]!.text).not.toContain('Open Health');
  });

  it('strips file paths from the last error', async () => {
    await h.pg.query(`update person set time_zone = 'Africa/Johannesburg' where is_site_admin`);
    await h.pg.query(`insert into site_settings (tenant_id, alert_admins, alert_extra_email, alert_after_minutes) values ($1, false, 'it@quillmont.example', 5)`, [h.t1]);
    const probes: HealthProbes = { async run() {
      const ok = await fakeProbes({}).run();
      return ok.map((c) => (c.key === 'storage' ? { ...c, status: 'failing' as const, detail: 'Files could not be written or read.',
        error: String.raw`EACCES: permission denied, open 'C:\vdrkit\storage\health\probe.txt'` } : c));
    } };
    await alertRun(0, { probes });
    await alertRun(5, { probes });
    const m = outbox[0]!;
    expect(m.to).toBe('it@quillmont.example');
    expect(m.text).toContain('Last error: Files could not be written or read. Error code: EACCES.');
    expect(m.text).not.toMatch(/C:\\|probe\.txt|permission denied/);
    expect(m.text).toContain('Since: Thu 12 Nov 2026, 10:00 SAST');
  });

  it('records failed alerts', async () => {
    accept = false;
    const probes = fakeProbes({ email: 'failing' });
    await alertRun(0, { probes });
    await alertRun(15, { probes });
    const ev = (await h.pg.query<any>(`select action, data from event where workspace_id is null order by seq`)).rows;
    expect(ev.map((e: any) => e.action)).toEqual(['site.health.alert_not_sent', 'site.health.alert_not_sent']);
    expect(ev[0].data).toMatchObject({ error: 'refused' });
  });

  it('sends alerts without the site address', async () => {
    await h.pg.query(`insert into site_settings (tenant_id, privacy_text) values ($1, 'We keep your data safe.')`, [h.t1]);
    const probes = fakeProbes({ conversion: 'failing' });
    await alertRun(0, { probes });
    expect((await alertRun(15, { probes })).alerted).toEqual(['conversion']);
    expect(outbox).toHaveLength(2);
    expect(outbox[0]!.text).not.toContain('Privacy notice');

    probes.status.conversion = 'ok';
    expect((await alertRun(16, { probes, publicUrl: 'https://bad host' })).recovered).toEqual(['conversion']);
    const ev = (await h.pg.query<any>(`select action, data from event where workspace_id is null order by seq`)).rows;
    expect(ev.map((e: any) => e.action)).toEqual(['site.health.alert_sent', 'site.health.alert_sent', 'site.health.recovery_not_sent', 'site.health.recovery_not_sent']);
    expect(ev[2].data.error).toMatch(/^The email could not be built/);
  });

  it('ignores warnings', async () => {
    const probes = fakeProbes();
    for (const m of [0, 20, 80]) await alertRun(m, { probes });
    expect(outbox).toHaveLength(0);
  });

  it('does nothing before setup', async () => {
    await h.pg.query(`delete from site_instance`);
    const r = await alertRun(60, { probes: fakeProbes({ database: 'failing' }) });
    expect(r.tenantId).toBeNull();
    expect((await h.pg.query(`select 1 from site_health_state`)).rows).toHaveLength(0);
  });
});

describe('health routes', () => {
  let app: FastifyInstance;
  const probes = fakeProbes();
  let now: Date;
  beforeEach(async () => {
    now = T.at;
    probes.status.storage = undefined as never;
    app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => now, rateLimit: false,
      publicUrl: 'https://dataroom.quillmont.example', site: { env: {}, probes, setup: false } });
  });
  afterEach(async () => { await app.close(); });

  it('serves /health without sign-in', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
    probes.status.storage = 'failing';
    await alertRun(0, { probes });
    const down = await app.inject({ method: 'GET', url: '/health' });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toEqual({ status: 'failing' });
    probes.status.storage = 'ok';
    await alertRun(0, { probes });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    await h.pin(at(11));
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(503);
  });

  it('fails if the worker never checked', async () => {
    await h.pg.query(`update tenant set created_at = $2 where id = $1`, [h.t1, at(-5)]);
    await h.pin(at(0));
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);   // new installation
    await h.pin(at(6));
    const down = await app.inject({ method: 'GET', url: '/health' });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toEqual({ status: 'failing' });
    const n = (await app.inject({ method: 'GET', url: '/v1/site/notice', headers: { 'x-dev-person': thabo, 'x-dev-tenant': h.t1 } })).json();
    expect(n).toMatchObject({ show: true, items: [], workerStopped: true });
    await alertRun(6, { probes });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('uses the database clock', async () => {
    await alertRun(0, { probes });
    now = at(60);   // the API's clock runs an hour ahead
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    now = at(-60);  // or an hour behind
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const st = (await h.pg.query<any>(`select last_checked_at from site_health_state limit 1`)).rows[0];
    expect(new Date(st.last_checked_at).toISOString()).toBe(at(0).toISOString());
  });

  it('shows site admins every check', async () => {
    probes.status.conversion = 'failing';
    await alertRun(-20, { probes });
    await alertRun(0, { probes });
    const res = await app.inject({ method: 'GET', url: '/v1/site/health', headers: { 'x-dev-person': thabo, 'x-dev-tenant': h.t1 } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((i: any) => `${i.key}:${i.status}`)).toEqual([
      'database:ok', 'storage:ok', 'email:ok', 'conversion:failing', 'virus_scanner:warning', 'backups:not_checked', 'version:ok']);
    expect(body.items[3]).toMatchObject({ failingSince: at(-20).toISOString(), alertedAt: at(0).toISOString() });
    expect(body).toMatchObject({ status: 'failing', problems: 2, monitorUrl: 'https://dataroom.quillmont.example/health', alerts: { afterMinutes: 15 } });
    expect((await app.inject({ method: 'GET', url: '/v1/site/health', headers: { 'x-dev-person': h.person.maria, 'x-dev-tenant': h.t1 } })).statusCode).toBe(403);
    probes.status.conversion = undefined as never;
  });
});

describe('the checks themselves', () => {
  it('checks storage, ClamAV and Gotenberg', async () => {
    let asked = '';
    const fetchFake = (async (url: string) => { asked = url; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    const results = await defaultProbes({ db: h.db, dbRole: 'vdrkit_app', storage: new MemoryStorage(), gotenbergUrl: 'http://gotenberg:3000/', fetch: fetchFake, clamav: null }).run();
    const by = Object.fromEntries(results.map((r) => [r.key, r.status]));
    expect(by).toEqual({ database: 'ok', storage: 'ok', email: 'failing', conversion: 'ok', virus_scanner: 'warning', backups: 'not_checked', version: 'ok' });
    expect(asked).toBe('http://gotenberg:3000/health');
  });

  it('treats a throw as failing', async () => {
    const fetchFake = (async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:3000'); }) as unknown as typeof fetch;
    const results = await defaultProbes({ db: h.db, gotenbergUrl: 'http://gotenberg:3000', fetch: fetchFake, clamav: { host: '127.0.0.1', port: 1 } }).run();
    const conv = results.find((r) => r.key === 'conversion')!;
    expect(conv).toMatchObject({ status: 'failing',
      detail: 'The document converter (Gotenberg) could not be reached, so Word, Excel and PowerPoint files cannot be converted.' });
    expect(results.find((r) => r.key === 'storage')!.status).toBe('failing');
    expect(results.find((r) => r.key === 'virus_scanner')).toMatchObject({ status: 'failing',
      detail: 'ClamAV did not answer, so new uploads cannot be processed: each one fails after a few tries. If ClamAV is not meant to run here, set CLAMAV_HOST= (empty) in the installation file.' });
  });
});

describe('the update check', () => {
  it('compares versions', () => {
    const order = ['0.9.9', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-rc', '1.0.0-rc.1', '1.0.0-rc.2', '1.0.0-rc.10', '1.0.0', '1.0.1-rc.1', '1.0.1', 'v1.1.0', '2.0.0'];
    for (let i = 0; i < order.length; i++) {
      for (let j = 0; j < order.length; j++) {
        expect(Math.sign(compareVersions(order[i]!, order[j]!)), `${order[i]} against ${order[j]}`).toBe(Math.sign(i - j));
      }
    }
    expect(compareVersions('1.0.0+build.5', '1.0.0')).toBe(0);
  });

  it('offers the release to a release candidate', async () => {
    const feed = (version: string) => (async () => new Response(JSON.stringify({ tag_name: `v${version}` }), { status: 200 })) as unknown as typeof fetch;
    const check = (current: string, latest: string) => updateChecker({ version: current, updateUrl: 'https://feed.example/latest', fetch: feed(latest) })();
    expect(await check('1.0.0-rc', '1.0.0')).toMatchObject({ current: '1.0.0-rc', latest: '1.0.0', available: true });
    expect(await check('1.0.0', '1.0.0')).toMatchObject({ available: false });
    expect(await check('1.0.0', '1.0.0-rc')).toMatchObject({ available: false });
    expect(await check('1.0.0-rc', '1.0.0-rc')).toMatchObject({ available: false });
  });
});

describe('site admin notice', () => {
  let app: FastifyInstance;
  const probes = fakeProbes();
  beforeEach(async () => {
    app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at, rateLimit: false,
      publicUrl: 'https://dataroom.quillmont.example', site: { env: {}, probes, setup: false } });
  });
  afterEach(async () => { await app.close(); probes.status.conversion = undefined as never; });
  const notice = (person: string) => app.inject({ method: 'GET', url: '/v1/site/notice', headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1 } });

  it('appears after the delay', async () => {
    probes.status.conversion = 'failing';
    await alertRun(0, { probes });
    expect((await notice(thabo)).json()).toMatchObject({ show: false, items: [] });   // a restart does not flash a notice
    await alertRun(15, { probes });
    const on = (await notice(thabo)).json();
    expect(on).toEqual({ show: true, items: [{ key: 'conversion', label: 'Document conversion', failingSince: at(0).toISOString() }],
      workerStopped: false, healthUrl: 'https://dataroom.quillmont.example/site/settings/health' });
    for (const p of [h.person.maria, h.person.jan]) {
      const r = await notice(p);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ show: false, items: [], workerStopped: false, healthUrl: null });
    }
    probes.status.conversion = 'ok';
    await alertRun(16, { probes });
    expect((await notice(thabo)).json().show).toBe(false);
  });

  it('shows when the worker stops', async () => {
    await alertRun(0, { probes });
    await h.pin(at(11));
    expect((await notice(thabo)).json()).toMatchObject({ show: true, items: [], workerStopped: true });
  });
});

describe('update notice', () => {
  const feed = (body: unknown, status = 200) => {
    const calls: string[] = [];
    const f = (async (url: string) => { calls.push(url); return new Response(JSON.stringify(body), { status }); }) as unknown as typeof fetch;
    return { calls, f };
  };

  it('says when a newer version is out', async () => {
    const { calls, f } = feed({ tag_name: 'v1.0.4' });
    let clock = T.at;
    const probes = defaultProbes({ db: h.db, dbRole: 'vdrkit_app', storage: new MemoryStorage(), gotenbergUrl: 'http://g', clamav: null, version: '1.0.3',
      updateUrl: 'https://releases.example/vdrkit/latest', fetch: f, now: () => clock });
    const v = (await probes.run()).find((r) => r.key === 'version')!;
    expect(v).toMatchObject({ status: 'ok', detail: 'VDRkit 1.0.3. Version 1.0.4 is available. Whoever installed VDRkit updates it with docker compose pull.' });
    expect(await probes.update!()).toMatchObject({ current: '1.0.3', latest: '1.0.4', available: true });
    expect(calls.filter((u) => u.includes('releases'))).toHaveLength(1);
    clock = new Date(T.at.getTime() + 7 * 3600_000);
    await probes.update!();
    expect(calls.filter((u) => u.includes('releases'))).toHaveLength(2);
  });

  it('needs a feed', async () => {
    const off = defaultProbes({ db: h.db, version: '1.0.3', clamav: null });
    expect(await off.update!()).toMatchObject({ latest: null, available: false, note: expect.stringContaining('VDRKIT_UPDATE_URL') });
    const { f } = feed({ message: 'Not Found' }, 404);
    const broken = defaultProbes({ db: h.db, version: '1.0.3', clamav: null, updateUrl: 'https://releases.example/x', fetch: f });
    const v = (await broken.run()).find((r) => r.key === 'version')!;
    expect(v.status).toBe('ok');
    expect(v.detail).toContain('Could not check for a newer version');
    const same = defaultProbes({ db: h.db, version: '1.0.4', clamav: null, updateUrl: 'https://releases.example/x', fetch: feed({ version: '1.0.4' }).f });
    expect((await same.run()).find((r) => r.key === 'version')!.detail).toBe('VDRkit 1.0.4, the latest version.');
  });

  it('shows in detailed health', async () => {
    const probes = { ...fakeProbes(), update: async () => ({ current: '1.0.3', latest: '1.0.4', available: true, checkedAt: T.at.toISOString(), note: null }) };
    const app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at, rateLimit: false,
      site: { env: {}, probes, setup: false } });
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/site/health', headers: { 'x-dev-person': thabo, 'x-dev-tenant': h.t1 } });
      expect(res.json().update).toEqual({ current: '1.0.3', latest: '1.0.4', available: true, checkedAt: T.at.toISOString(), note: null });
    } finally { await app.close(); }
  });
});
