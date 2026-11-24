// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { DEFAULT_SOURCE_URL, sourceUrl } from '../src/routes/about.js';
import { VDRKIT_VERSION } from '../src/site/health.js';
import { heron, type Heron } from '../../../packages/core/test/fixture.js';

let h: Heron;
let app: FastifyInstance;
const saved = process.env.VDRKIT_SOURCE_URL;

beforeEach(async () => {
  h = await heron();
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app' });
});
afterEach(async () => {
  if (saved === undefined) delete process.env.VDRKIT_SOURCE_URL; else process.env.VDRKIT_SOURCE_URL = saved;
  await app.close();
  await h.pg.close();
});


describe('GET /v1/about', () => {
  it('should return the version and source url', async () => {
    delete process.env.VDRKIT_SOURCE_URL;
    const res = await app.inject({ method: 'GET', url: '/v1/about', headers: { 'x-dev-person': h.person.jan, 'x-dev-tenant': h.t1 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: VDRKIT_VERSION, sourceUrl: 'https://github.com/vdrkit/vdrkit', licence: 'AGPL-3.0-only' });
  });

  it('uses VDRKIT_SOURCE_URL when set', async () => {
    process.env.VDRKIT_SOURCE_URL = 'https://git.example.org/acme/vdrkit-fork/';
    const res = await app.inject({ method: 'GET', url: '/v1/about', headers: { 'x-dev-person': h.person.anika, 'x-dev-tenant': h.t1 } });
    expect(res.json().sourceUrl).toBe('https://git.example.org/acme/vdrkit-fork');
  });

  it('should require authentication', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/about' })).statusCode).toBe(401);
  });
});

describe('GET /v1/branding source link', () => {
  it('returns source and licence but no version', async () => {
    delete process.env.VDRKIT_SOURCE_URL;
    const res = await app.inject({ method: 'GET', url: '/v1/branding' });
    expect(res.statusCode).toBe(200);
    expect(res.json().sourceCode).toEqual({ url: 'https://github.com/vdrkit/vdrkit', licence: 'AGPL-3.0-only' });
    expect(JSON.stringify(res.json())).not.toContain(VDRKIT_VERSION);
    process.env.VDRKIT_SOURCE_URL = 'https://git.example.org/acme/vdrkit-fork';
    expect((await app.inject({ method: 'GET', url: '/v1/branding' })).json().sourceCode.url).toBe('https://git.example.org/acme/vdrkit-fork');
  });
});

describe('sourceUrl()', () => {
  it('accepts only http(s) urls', () => {
    expect(DEFAULT_SOURCE_URL).toBe('https://github.com/vdrkit/vdrkit');
    expect(sourceUrl(undefined)).toBe(DEFAULT_SOURCE_URL);
    expect(sourceUrl('  ')).toBe(DEFAULT_SOURCE_URL);
    expect(sourceUrl('javascript:alert(1)')).toBe(DEFAULT_SOURCE_URL);
    expect(sourceUrl('not a url')).toBe(DEFAULT_SOURCE_URL);
    expect(sourceUrl('http://intranet.example/vdrkit')).toBe('http://intranet.example/vdrkit');
  });
});
