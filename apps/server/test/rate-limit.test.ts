// SPDX-License-Identifier: AGPL-3.0-only
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, DevHeaderAuthenticator, type AppOptions } from '../src/index.js';
import { normalisedPath, SharedRateLimits } from '../src/rate-limit.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';

let h: Heron;
let app: FastifyInstance;

const start = async (rateLimit: AppOptions['rateLimit']) => {
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at, rateLimit });
};
beforeEach(async () => { h = await heron(); });
afterEach(async () => {
  await app.close();
  await h.pg.close();
});

const as = (person: string) => ({ 'x-dev-person': person, 'x-dev-tenant': h.t1 });
const get = (url: string, person: string, ip = '10.0.0.1') => app.inject({ method: 'GET', url, headers: as(person), remoteAddress: ip });
const rooms = '/v1/me/workspaces';
const BAD_TOKEN = { token: `${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}.${'x'.repeat(32)}`, givenName: 'Sven', familyName: 'Lund', company: 'Skjolvik Partners' };
const accept = (ip: string) => app.inject({ method: 'POST', url: '/v1/public/invitations/accept', payload: BAD_TOKEN, remoteAddress: ip });

describe('rate limits', () => {
  it('should return 429 with Retry-After', async () => {
    await start({ general: { max: 3, windowMs: 60_000 } });
    for (let i = 0; i < 3; i++) expect((await get(rooms, h.person.anika)).statusCode).toBe(200);
    const res = await get(rooms, h.person.anika);
    expect(res.statusCode).toBe(429);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ type: 'https://vdrkit.com/problems/rate-limited', title: 'Too many requests', status: 429 });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('counts per person', async () => {
    await start({ general: { max: 2, windowMs: 60_000 } });
    await get(rooms, h.person.anika, '10.0.0.1');
    await get(rooms, h.person.anika, '10.0.0.2');
    expect((await get(rooms, h.person.anika, '10.0.0.3')).statusCode).toBe(429);
    expect((await get(rooms, h.person.jan, '10.0.0.1')).statusCode).toBe(200);
  });

  it('is stricter for listing, search and pages', async () => {
    await start({ general: { max: 100, windowMs: 60_000 }, heavy: { max: 2, windowMs: 60_000 } });
    const list = `/v1/workspaces/${h.ws}/nodes`;
    expect((await get(list, h.person.anika)).statusCode).toBe(200);
    expect((await get(`/v1/workspaces/${h.ws}/search?q=audit`, h.person.anika)).statusCode).toBe(200);
    expect((await get(list, h.person.anika)).statusCode).toBe(429);
    expect((await get(rooms, h.person.anika)).statusCode).toBe(200);
  });

  it('counts uploads separately', async () => {
    await start({ general: { max: 2, windowMs: 60_000 }, upload: { max: 3, windowMs: 60_000 } });
    const status = (id: string) => `/v1/workspaces/${h.ws}/upload-sessions/${id}`;
    const missing = '00000000-0000-4000-8000-000000000000';
    for (let i = 0; i < 3; i++) expect((await get(status(missing), h.person.anika)).statusCode).not.toBe(429);
    expect((await get(status(missing), h.person.anika)).statusCode).toBe(429);
    expect((await get(rooms, h.person.anika)).statusCode).toBe(200);
    expect((await get(rooms, h.person.anika)).statusCode).toBe(200);
    expect((await get(rooms, h.person.anika)).statusCode).toBe(429);
  });

  it('keeps the upload plan under the general limit', async () => {
    await start({ general: { max: 1, windowMs: 60_000 }, upload: { max: 100, windowMs: 60_000 } });
    const plan = () => app.inject({ method: 'POST', url: `/v1/workspaces/${h.ws}/upload-plans`, headers: as(h.person.jan),
      payload: { files: [{ path: 'a.pdf', size: 1 }] }, remoteAddress: '10.0.0.1' });
    expect((await plan()).statusCode).not.toBe(429);
    expect((await plan()).statusCode).toBe(429);
  });

  it('limits invitation accepts', async () => {
    await start({ signIn: { max: 2, windowMs: 60_000 } });
    expect((await accept('10.0.0.9')).statusCode).toBe(410);
    expect((await accept('10.0.0.9')).statusCode).toBe(410);
    expect((await accept('10.0.0.9')).statusCode).toBe(429);
    expect((await accept('10.0.0.10')).statusCode).toBe(410);
  });

  it('should count proxied visitors separately', async () => {
    app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at,
      rateLimit: { signIn: { max: 2, windowMs: 60_000 } }, trustProxy: 'loopback, linklocal, uniquelocal' });
    const viaWeb = (client: string) => app.inject({ method: 'POST', url: '/v1/public/invitations/accept', payload: BAD_TOKEN,
      remoteAddress: '172.21.0.7', headers: { 'x-forwarded-for': client } });
    expect((await viaWeb('198.51.100.1')).statusCode).toBe(410);
    expect((await viaWeb('198.51.100.1')).statusCode).toBe(410);
    expect((await viaWeb('198.51.100.1')).statusCode).toBe(429);
    expect((await viaWeb('198.51.100.2')).statusCode).toBe(410);
    // public address: header ignored
    const direct = (client: string) => app.inject({ method: 'POST', url: '/v1/public/invitations/accept', payload: BAD_TOKEN,
      remoteAddress: '203.0.113.9', headers: { 'x-forwarded-for': client } });
    expect((await direct('198.51.100.3')).statusCode).toBe(410);
    expect((await direct('198.51.100.4')).statusCode).toBe(410);
    expect((await direct('198.51.100.5')).statusCode).toBe(429);
  });

  it('limits /v1/auth by address', async () => {
    await start({ signIn: { max: 1, windowMs: 60_000 } });
    const signIn = () => app.inject({ method: 'POST', url: '/v1/auth/sign-in/magic-link', payload: { email: 'a@b.c' }, remoteAddress: '10.0.0.7' });
    expect((await signIn()).statusCode).toBe(404); // no Better Auth mounted here
    expect((await signIn()).statusCode).toBe(429);
  });

  it('gives the setup code its own limit', async () => {
    await start({});
    const unlock = () => app.inject({ method: 'POST', url: '/v1/setup/unlock', payload: { code: 'wrong' }, remoteAddress: '10.0.0.9' });
    for (let i = 0; i < 10; i++) expect((await unlock()).statusCode).not.toBe(429);
    expect((await unlock()).statusCode).toBe(429);
    expect((await accept('10.0.0.9')).statusCode).toBe(410);
  });

  it('cannot be bypassed with dot segments', async () => {
    expect(normalisedPath('/v1/auth/email-otp/send-verification-otp?x=1')).toBe('/v1/auth/email-otp/send-verification-otp');
    for (const url of ['/v1/auth/x/%2e%2e/email-otp/send-verification-otp', '/v1/auth/x/../email-otp/send-verification-otp',
      '/v1/auth/x/%2E%2E/sign-in/magic-link', '/v1/workspaces/./x']) {
      expect([url, normalisedPath(url)]).toEqual([url, null]);
    }
    // inject normalises the path
    await start({ signIn: { max: 1, windowMs: 60_000 } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const send = (path: string) => new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end(JSON.stringify({ email: 'a@b.c' }));
    });
    expect(await send('/v1/auth/x/%2e%2e/email-otp/send-verification-otp')).toBe(400);
    expect(await send('/v1/auth/x/%2E%2E/email-otp/send-verification-otp')).toBe(400);
    expect(await send('/v1/auth/email-otp/send-verification-otp')).toBe(404);
    expect(await send('/v1/auth/email-otp/send-verification-otp')).toBe(429);
  });

  it('limits bad credentials', async () => {
    await start({ anonymous: { max: 2, windowMs: 60_000 } });
    const anon = () => app.inject({ method: 'GET', url: rooms, remoteAddress: '10.0.0.8' });
    expect((await anon()).statusCode).toBe(401);
    expect((await anon()).statusCode).toBe(401);
    expect((await anon()).statusCode).toBe(429);
  });

  it('has defaults', async () => {
    await start(undefined);
    const res = await get(rooms, h.person.anika);
    expect(res.headers['x-ratelimit-limit']).toBe('600');
    expect((await get(`/v1/workspaces/${h.ws}/nodes`, h.person.anika)).headers['x-ratelimit-limit']).toBe('120');
    expect((await get(`/v1/workspaces/${h.ws}/upload-sessions/00000000-0000-4000-8000-000000000000`, h.person.anika)).headers['x-ratelimit-limit']).toBe('3000');
    expect((await accept('10.0.0.11')).headers['x-ratelimit-limit']).toBe('100');
  });

  it('can be switched off', async () => {
    await start(false);
    for (let i = 0; i < 20; i++) expect((await get(rooms, h.person.anika)).statusCode).toBe(200);
    expect((await get(rooms, h.person.anika)).headers['x-ratelimit-limit']).toBeUndefined();
  });
});

describe('shared store', () => {
  let other: FastifyInstance | null = null;
  afterEach(async () => { await other?.close(); other = null; });
  const instance = (rateLimit: AppOptions['rateLimit']) =>
    buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at, rateLimit });
  const getOn = (a: FastifyInstance, url: string, person: string, ip = '10.0.0.1') => a.inject({ method: 'GET', url, headers: as(person), remoteAddress: ip });

  it('should share a limit across instances', async () => {
    const shared = () => ({ shared: new SharedRateLimits(h.db, 'vdrkit_app'), general: { max: 4, windowMs: 60_000 } });
    app = await instance(shared());
    other = await instance(shared());
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await getOn(i % 2 ? other : app, rooms, h.person.anika)).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 429, 429]);
    expect(Number((await getOn(app, rooms, h.person.anika)).headers['retry-after'])).toBeGreaterThan(0);
    expect((await getOn(other, rooms, h.person.jan)).statusCode).toBe(200);
  });

  it('shares sign-in limits', async () => {
    const shared = () => ({ shared: new SharedRateLimits(h.db, 'vdrkit_app'), signIn: { max: 3, windowMs: 15 * 60_000 } });
    app = await instance(shared());
    other = await instance(shared());
    const tryOn = (a: FastifyInstance, ip: string) => a.inject({ method: 'POST', url: '/v1/public/invitations/accept', payload: BAD_TOKEN, remoteAddress: ip });
    expect([(await tryOn(app, '10.1.0.1')).statusCode, (await tryOn(other, '10.1.0.1')).statusCode, (await tryOn(app, '10.1.0.1')).statusCode])
      .toEqual([410, 410, 410]);
    expect((await tryOn(other, '10.1.0.1')).statusCode).toBe(429);
    expect((await tryOn(other, '10.1.0.2')).statusCode).toBe(410);
  });

  it('counts per instance in memory', async () => {
    app = await instance({ general: { max: 2, windowMs: 60_000 } });
    other = await instance({ general: { max: 2, windowMs: 60_000 } });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await getOn(i % 2 ? other : app, rooms, h.person.anika)).statusCode);
    expect(codes).toEqual([200, 200, 200, 200]);
  });

  it('purges old windows', async () => {
    app = await instance(false);
    const store = new SharedRateLimits(h.db, 'vdrkit_app');
    expect(await store.hit('test:window', 50)).toMatchObject({ current: 1 });
    expect((await store.hit('test:window', 50)).current).toBe(2);
    await new Promise((r) => setTimeout(r, 80));
    const fresh = await store.hit('test:window', 50);
    expect(fresh.current).toBe(1);
    expect(fresh.ttl).toBeGreaterThan(0);
    expect(fresh.ttl).toBeLessThanOrEqual(50);
    await h.pg.query(`update rate_limit_counter set window_ends_at = now() - interval '2 minutes' where key_hash = sha256(convert_to('test:window', 'UTF8'))`);
    await store.hit('test:live', 60_000);
    expect(await store.purge()).toBe(1);
    expect((await h.pg.query<{ n: number }>(`select count(*)::int as n from rate_limit_counter`)).rows[0]!.n).toBe(1);
  });

  it("stores Better Auth's limits too", async () => {
    app = await instance(false);
    const auth = new SharedRateLimits(h.db, 'vdrkit_app').betterAuthStorage();
    const rule = { window: 10, max: 2 };
    expect(await auth.consume('10.0.0.1|/sign-in/email-otp', rule)).toEqual({ allowed: true, retryAfter: null });
    expect(await auth.consume('10.0.0.1|/sign-in/email-otp', rule)).toEqual({ allowed: true, retryAfter: null });
    const third = await auth.consume('10.0.0.1|/sign-in/email-otp', rule);
    expect(third.allowed).toBe(false);
    expect(third.retryAfter).toBeGreaterThan(0);
    expect(third.retryAfter).toBeLessThanOrEqual(10);
  });

  it('stores hashed keys only', async () => {
    app = await instance(false);
    await new SharedRateLimits(h.db, 'vdrkit_app').hit('signIn:203.0.113.9', 60_000);
    const rows = (await h.pg.query<{ key_hash: Uint8Array }>(`select key_hash from rate_limit_counter`)).rows;
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0]!.key_hash).toString('latin1')).not.toContain('203.0.113.9');
    for (const sql of ['select * from rate_limit_counter', `delete from rate_limit_counter`]) {
      await expect(h.db.transaction(async (tx) => { await tx.query('set local role vdrkit_app'); return tx.query(sql); }))
        .rejects.toThrow(/permission denied/);
    }
  });

  it('rejects bad windows', async () => {
    app = await instance(false);
    await expect(h.db.transaction((tx) => tx.query(`select * from rate_limit_hit('k', 0)`))).rejects.toThrow(/window/);
    await expect(h.db.transaction((tx) => tx.query(`select * from rate_limit_hit('', 1000)`))).rejects.toThrow(/key/);
  });
});
