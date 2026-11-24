// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Channel, OutgoingMessage } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';
import { CAN_RACE, together } from './race.js';

let h: Heron;
let app: FastifyInstance;
let outbox: OutgoingMessage[];
const mailer: Channel = { name: 'email', send: async (m) => { outbox.push(m); return { status: 'accepted', providerMessageId: `pm-${outbox.length}` }; } };

beforeEach(async () => {
  h = await heron();
  outbox = [];
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at, mailer, publicUrl: 'https://dataroom.example' });
});
afterEach(async () => { await app.close(); await h.pg.close(); });

type Method = 'GET' | 'POST' | 'PATCH';
const call = (method: Method, url: string, person: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1 }, ...(payload !== undefined ? { payload } : {}) });
const W = () => `/v1/workspaces/${h.ws}`;
const current = async (person: string) => (await h.pg.query<{ id: string; status: string; revoked: boolean; open: boolean }>(
  `select id, status, coalesce((metadata ->> 'revoked')::boolean, false) as revoked, valid_to > $2 as open
     from membership where person_id = $1 and superseded_at = 'infinity' order by valid_from, recorded_at`, [person, T.at.toISOString()])).rows;
const membershipOf = async (person: string) => (await current(person)).at(-1)!.id;
const canEnter = async (person: string) => (await call('GET', `${W()}/nodes`, person)).statusCode === 200;
const later = new Date(T.at.getTime() + 30 * 86_400_000).toISOString();

describe.skipIf(!CAN_RACE)('two changes to one membership at once', () => {
  it('revoking wins over a new end date', async () => {
    const id = await membershipOf(h.person.mei);
    const done = await together(h, () => [
      call('POST', `${W()}/memberships/${id}/revoke`, h.person.anika),
      call('PATCH', `${W()}/memberships/${id}`, h.person.anika, { accessEndsAt: later }),
    ]);
    expect(done[0]!.statusCode, done[0]!.body).toBe(200);
    // the end date either came first, or was refused because access had ended
    expect([200, 400]).toContain(done[1]!.statusCode);
    expect((await current(h.person.mei)).filter((m) => m.open && !m.revoked)).toEqual([]);
    expect(await canEnter(h.person.mei)).toBe(false);
  });

  it('restores once when Restore is sent twice', async () => {
    const id = await membershipOf(h.person.mei);
    expect((await call('POST', `${W()}/memberships/${id}/revoke`, h.person.anika)).statusCode).toBe(200);
    const revoked = await membershipOf(h.person.mei);
    const done = await together(h, () => [
      call('POST', `${W()}/memberships/${revoked}/restore`, h.person.anika),
      call('POST', `${W()}/memberships/${revoked}/restore`, h.person.anika),
    ]);
    expect(done.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(done.find((r) => r.statusCode === 409)!.json().reason).toBe('not_revoked');
    expect((await current(h.person.mei)).filter((m) => m.open && !m.revoked)).toHaveLength(1);

    expect((await call('POST', `${W()}/memberships/${await membershipOf(h.person.mei)}/revoke`, h.person.anika)).statusCode).toBe(200);
    expect(await canEnter(h.person.mei)).toBe(false);
  });

  it('settles a role change against a revoke without an error', async () => {
    const id = await membershipOf(h.person.mei);
    const done = await together(h, () => [
      call('POST', `${W()}/memberships/${id}/make-lead`, h.person.anika),
      call('POST', `${W()}/memberships/${id}/revoke`, h.person.anika),
    ]);
    expect(done.every((r) => r.statusCode < 500), done.map((r) => r.body).join('\n')).toBe(true);
    expect(done[1]!.statusCode).toBe(200);
    expect(await canEnter(h.person.mei)).toBe(false);
  });
});
