// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';
import { CAN_RACE, together } from './race.js';

let h: Heron;
let app: FastifyInstance;

beforeEach(async () => {
  h = await heron();
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at });
});
afterEach(async () => { await app.close(); await h.pg.close(); });

const call = (method: 'GET' | 'POST', url: string, person: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1 }, ...(payload !== undefined ? { payload } : {}) });
const W = () => `/v1/workspaces/${h.ws}`;
const count = async (action: string, node: string) => (await h.pg.query(`select 1 from event where action = $1 and resource_id = $2`, [action, node])).rows.length;

describe.skipIf(!CAN_RACE)('two changes to one index at once', () => {
  it('gives two new folders different numbers', async () => {
    const done = await together(h, () => [
      call('POST', `${W()}/folders`, h.person.anika, { name: 'Tax' }),
      call('POST', `${W()}/folders`, h.person.anika, { name: 'Insurance' }),
    ]);
    expect(done.map((r) => r.statusCode), done.map((r) => r.body).join('\n')).toEqual([201, 201]);
    const numbers = done.map((r) => r.json().indexNumber);
    expect(new Set(numbers).size).toBe(2);
    const twice = await h.pg.query(
      `select index_number from node where workspace_id = $1 and parent_id is null and deleted_at is null group by index_number having count(*) > 1`, [h.ws]);
    expect(twice.rows).toEqual([]);
  });

  it('withdraws a published item once', async () => {
    const done = await together(h, () => [
      call('POST', `${W()}/nodes/${h.node.aud1}/withdraw`, h.person.anika, {}),
      call('POST', `${W()}/nodes/${h.node.aud1}/withdraw`, h.person.anika, {}),
    ]);
    expect(done.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    expect(await count('document.withdrawn', h.node.aud1)).toBe(1);
  });

  it('publishes a draft once, with one log entry', async () => {
    const draft = { id: h.node.audDraft };
    const done = await together(h, () => [
      call('POST', `${W()}/publish`, h.person.anika, { nodeIds: [draft.id], quiet: true }),
      call('POST', `${W()}/publish`, h.person.anika, { nodeIds: [draft.id], quiet: true }),
    ]);
    expect(done.every((r) => r.statusCode < 500), done.map((r) => r.body).join('\n')).toBe(true);
    expect(await count('document.published', draft.id)).toBe(1);
  });
});
