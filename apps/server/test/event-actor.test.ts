// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { verifyChain } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';


let h: Heron;
let app: FastifyInstance;

beforeEach(async () => {
  h = await heron();
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at, publicUrl: 'https://dataroom.example' });
});
afterEach(async () => { await app.close(); await h.pg.close(); });

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, person: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1 }, ...(payload !== undefined ? { payload } : {}) });
const W = () => `/v1/workspaces/${h.ws}`;

describe('event actor', () => {
  it('records the admin who revoked a group', async () => {
    expect((await call('POST', `${W()}/groups/${h.group.b}/revoke`, h.person.anika, { reason: 'withdrew' })).statusCode).toBe(200);
    const events = (await call('GET', `${W()}/events?limit=20`, h.person.anika)).json().items as { action: string; actorName: string | null }[];
    const revoked = events.find((e) => e.action === 'group.revoked');
    expect(revoked?.actorName).toBe('Anika Pillay');
    // and the chain still verifies
    const row = (await h.pg.query<{ person_id: string | null }>(
      `select p.person_id from event e join principal p on p.id = e.actor_id where e.workspace_id = $1 and e.action = 'group.revoked'`, [h.ws])).rows[0];
    expect(row?.person_id).toBe(h.person.anika);
    const chain = await h.app((tx) => verifyChain(tx, h.ws));
    expect(chain.firstBroken).toBeNull();
    expect(chain.checked).toBeGreaterThan(0);
  });

  it('creates one principal per person', async () => {
    const count = async () => Number((await h.pg.query<{ n: string }>(
      `select count(*) as n from principal where kind = 'person' and person_id = $1 and revoked_at is null`, [h.person.anika])).rows[0]!.n);
    await call('GET', `${W()}/people`, h.person.anika);
    const after = await count();
    expect(after).toBeGreaterThanOrEqual(1);
    await call('GET', `${W()}/people`, h.person.anika);
    await call('POST', `${W()}/groups/${h.group.b}/revoke`, h.person.anika, {});
    expect(await count()).toBe(after);
  });

  it('skips refused requests', async () => {
    const outsider = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Eve', 'eve@x.example') returning id`, [h.t1])).rows[0]!.id;
    expect((await call('POST', `${W()}/groups/${h.group.b}/revoke`, outsider, {})).statusCode).toBe(404);
    expect((await h.pg.query(`select 1 from event where workspace_id = $1 and action = 'group.revoked'`, [h.ws])).rows).toHaveLength(0);
  });
});
