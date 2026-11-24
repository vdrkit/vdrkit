// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { DevHeaderAuthenticator } from '../src/auth.js';
import { seedDemo, type DemoRoom } from '../src/demo/seed-demo.js';
import { freshDatabase, type TestPg } from '../../../packages/core/test/fixture.js';

let pg: TestPg;
let app: FastifyInstance;
let room: DemoRoom;

beforeAll(async () => {
  const { db, pg: p } = await freshDatabase();
  pg = p;
  room = await seedDemo(db, { role: 'vdrkit_app' });
  app = await buildApp({ db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', rateLimit: false });
}, 120_000);
afterAll(async () => { await app.close(); await pg.close(); });

const get = (person: string, url: string) => app.inject({
  method: 'GET', url: `/v1/workspaces/${room.workspaceId}${url}`,
  headers: { 'x-dev-tenant': room.tenantId, 'x-dev-person': person },
});
const audience = (person: string, ix: string) => get(person, `/nodes/${room.node[ix]}/audience`);

describe('GET /v1/workspaces/{ws}/nodes/{id}/audience', () => {
  it('tells contributors who will see a folder', async () => {
    const res = await audience(room.person.maria, '3.2');
    expect(res.statusCode).toBe(200);
    const a = res.json();
    expect(a.publishers.map((p: { name: string }) => p.name)).toEqual(['Johan Steyn', 'Anika Pillay']);
    expect(a.groups.filter((g: { level: number }) => g.level >= 20).length).toBe(4);
    expect(a.document).toBeNull();
  });

  it('answers publishers and admins', async () => {
    expect((await audience(room.person.johan, '3.2')).statusCode).toBe(200);
    const d = (await audience(room.person.anika, '2.4.2')).json();
    expect(d.document.publishedAt).toEqual(expect.any(String));
    expect(d.document.openedByGroups).toEqual(expect.any(Number));
  });

  it('returns 404 for buyer side and observers', async () => {
    for (const p of [room.person.jan, room.person.lars, room.person.liesl]) expect((await audience(p, '3.2')).statusCode).toBe(404);
    // contributor without upload rights
    expect((await audience(room.person.maria, '2.4')).statusCode).toBe(404);
  });

  it('shows the uploader to the seller side only', async () => {
    const seller = (await get(room.person.maria, `/nodes?parent=${room.node['3.2']}`)).json();
    const draft = seller.items.find((i: { indexNumber: string }) => i.indexNumber === '3.2.6');
    expect(draft.uploadedBy).toMatchObject({ name: 'Maria Botha' });
    const bidder = (await get(room.person.jan, `/nodes?parent=${room.node['2.4']}`)).json();
    expect(bidder.items.length).toBeGreaterThan(0);
    expect(bidder.items.every((i: object) => !('uploadedBy' in i))).toBe(true);
  });
});
