// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { requestIdFrom } from '../src/app.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('request id', () => {
  let h: Heron;
  let app: FastifyInstance;
  beforeAll(async () => {
    h = await heron();
    app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at, rateLimit: false,
      plugins: [async (a) => { a.get('/v1/test/id', { schema: { hide: true } }, async (req) => ({ id: req.id })); }] });
  });
  afterAll(async () => {
    await app.close();
    await h.pg.close();
  });
  const idFor = async (value?: string) =>
    (await app.inject({ method: 'GET', url: '/v1/test/id',
      headers: { 'x-dev-person': h.person.jan, 'x-dev-tenant': h.t1, ...(value === undefined ? {} : { 'x-request-id': value }) } })).json().id as string;

  it("keeps a load balancer's id", async () => {
    expect(await idFor('7f9c2ba4-e88f-4d2a-9b1c-3c1e0f6d5a21')).toBe('7f9c2ba4-e88f-4d2a-9b1c-3c1e0f6d5a21');
    expect(await idFor('Root_1-67891233-abcdef012345678912345678')).toBe('Root_1-67891233-abcdef012345678912345678');
  });

  it('replaces anything else with its own', async () => {
    expect(await idFor()).toMatch(UUID);
    for (const value of ['jan@bidder-a.example', 'a b', 'x'.repeat(65), '<script>', '']) expect(await idFor(value)).toMatch(UUID);
    expect(requestIdFrom(['a', 'b'])).toMatch(UUID);
    expect(requestIdFrom('x'.repeat(64))).toBe('x'.repeat(64));
  });
});
