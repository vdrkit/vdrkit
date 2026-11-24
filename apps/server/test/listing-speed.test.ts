// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { withTenant, type Database } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { DEMO_PEOPLE, seedDemo, type DemoRoom, type PersonKey } from '../src/demo/seed-demo.js';
import { freshDatabase, type TestPg } from '../../../packages/core/test/fixture.js';

// generous: real calls take 25-350 ms
const BOUND_MS = 2000;

let pg: TestPg;
let db: Database;
let room: DemoRoom;
let app: FastifyInstance;
const personas = Object.keys(DEMO_PEOPLE) as PersonKey[];

beforeAll(async () => {
  ({ db, pg } = await freshDatabase());
  room = await seedDemo(db, { role: 'vdrkit_app' });
  app = await buildApp({ db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', rateLimit: false, publicUrl: 'https://dataroom.example' });
}, 300_000);
afterAll(async () => { await app?.close(); await pg?.close(); });

const asApp = <R>(fn: Parameters<typeof withTenant<R>>[2]) => withTenant(db, room.tenantId, fn, { role: 'vdrkit_app' });

async function timed(person: PersonKey, path: string): Promise<number> {
  const t0 = performance.now();
  const res = await app.inject({ method: 'GET', url: `/v1/workspaces/${room.workspaceId}/${path}`,
    headers: { 'x-dev-tenant': room.tenantId, 'x-dev-person': room.person[person] } });
  const ms = performance.now() - t0;
  expect(res.statusCode, `${person} ${path}: ${res.body.slice(0, 200)}`).toBe(200);
  return ms;
}

describe('seeded room response times', () => {
  const calls: [string, () => string][] = [
    ['dashboard', () => 'dashboard'],
    ['search for a word', () => 'search?q=agreement'],
    ['search while typing', () => 'search?q=ag'],
    ['the top of Documents', () => 'nodes'],
    ['a folder in Documents', () => `nodes?parent=${room.node['3']}`],
  ];
  for (const [label, path] of calls) {
    it(label, async () => {
      const url = path();
      await timed('anika', url);   // warm up
      const slow: string[] = [];
      for (const p of personas) {
        const ms = await timed(p, url);
        if (ms > BOUND_MS) slow.push(`${p} ${Math.round(ms)} ms`);
      }
      expect(slow, `over ${BOUND_MS} ms`).toEqual([]);
    }, 300_000);
  }
});

describe('accessible_nodes()', () => {
  const when = () => new Date(Date.now() + 1000).toISOString();

  it('matches effective_level() per node', async () => {
    for (const p of personas) {
      const at = when();
      const [listed, single] = await asApp(async (tx) => [
        (await tx.query(`select node_id, level, can_upload, can_manage, can_publish from accessible_nodes($1, $2, $3, record_clock()) order by node_id`,
          [room.person[p], room.workspaceId, at])).rows,
        (await tx.query(`select nd.id as node_id, e.level, e.can_upload, e.can_manage, e.can_publish
                           from node nd cross join lateral effective_level($1, nd.id, $3, record_clock()) e
                          where nd.workspace_id = $2 and nd.deleted_at is null and (e.level > 0 or e.can_upload or e.can_manage or e.can_publish)
                          order by nd.id`, [room.person[p], room.workspaceId, at])).rows,
      ]);
      expect(listed.length, p).toBeGreaterThan(0);
      expect(listed, p).toEqual(single);
    }
  }, 300_000);

  it('is faster than effective_level() per node', async () => {
    const best = async (sql: string) => {
      let min = Infinity;
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        await asApp((tx) => tx.query(sql, [room.person.jan, room.workspaceId, when()]));
        min = Math.min(min, performance.now() - t0);
      }
      return min;
    };
    const listing = await best(`select count(*) from accessible_nodes($1, $2, $3, record_clock())`);
    const perNode = await best(`select count(*) from node nd cross join lateral effective_level($1, nd.id, $3, record_clock()) e
                                 where nd.workspace_id = $2 and nd.deleted_at is null and (e.level > 0 or e.can_upload or e.can_manage or e.can_publish)`);
    expect(listing * 4, `listing ${Math.round(listing)} ms, per node ${Math.round(perNode)} ms`).toBeLessThan(perNode);
  }, 120_000);
});
