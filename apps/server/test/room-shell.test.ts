// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { DevHeaderAuthenticator } from '../src/auth.js';
import { seedDemo, stableId, type DemoRoom } from '../src/demo/seed-demo.js';
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

const shell = (person: string) => app.inject({
  method: 'GET', url: `/v1/workspaces/${room.workspaceId}/shell`,
  headers: { 'x-dev-tenant': room.tenantId, 'x-dev-person': person },
});

describe('room shell', () => {
  it('gives the demo room, people and nodes fixed ids', () => {
    expect(room.workspaceId).toBe(stableId(room.tenantId, 'workspace'));
    expect(room.person.jan).toBe(stableId(room.tenantId, 'person:jan'));
    expect(room.node['2.4.2']).toBe(stableId(room.tenantId, 'node:2.4.2'));
  });

  it('gives the room admin drafts, hidden folders and counts', async () => {
    const res = await shell(room.person.anika);
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.me).toMatchObject({ name: 'Anika Pillay', isAdmin: true });
    expect(s.room).toMatchObject({ name: 'Project Heron', timeZone: 'Africa/Johannesburg', runBy: 'Quillmont Advisory', bidderGroups: 4, myRoomCount: 1 });
    expect(s.documents.published).toBe(1248);
    const legal = s.index.find((f: { indexNumber: string }) => f.indexNumber === '2');
    expect(legal).toMatchObject({ documents: 213, drafts: 1, noBidderAccess: false });
    expect(s.index.filter((f: { parentId: string | null; noBidderAccess: boolean }) => !f.parentId && f.noBidderAccess).map((f: { indexNumber: string }) => f.indexNumber))
      .toEqual(['8', '9', '10', '11']);
    expect(s.attention).toEqual({ accessRequests: 0, foldersWithoutBidderAccess: 4 });
  });

  it('hides other groups and drafts from a bidder lead', async () => {
    const s = (await shell(room.person.jan)).json();
    expect(s.me).toMatchObject({ name: 'Jan de Vries', timeZone: 'Europe/London', isAdmin: false });
    expect(s.me.groups).toEqual([expect.objectContaining({ name: 'Bidder A', role: 'lead', partyKind: 'bidder' })]);
    expect(s.room.bidderGroups).toBeNull();
    expect(s.attention).toBeNull();
    expect(s.index.every((f: { drafts: number; noBidderAccess: null }) => f.drafts === 0 && f.noBidderAccess === null)).toBe(true);
    expect(s.index.map((f: { indexNumber: string }) => f.indexNumber)).not.toContain('8');
    expect(JSON.stringify(s)).not.toMatch(/Bidder [BC]/);
  });

  it('shows a financier only the folders their subgroup can see', async () => {
    const s = (await shell(room.person.lars)).json();
    expect(s.index.filter((f: { parentId: string | null }) => !f.parentId).map((f: { indexNumber: string }) => f.indexNumber)).toEqual(['3']);
  });

  it('returns logo URLs with a version', async () => {
    expect((await shell(room.person.jan)).json().room.logos).toEqual({ light: false, dark: false, version: null });
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const sha = 'a'.repeat(64);
    await pg.query(`insert into workspace_logo (workspace_id, tenant_id, variant, content_type, bytes, sha256) values ($1, $2, 'light', 'image/png', $3, $4)`,
      [room.workspaceId, room.tenantId, png, sha]);
    try {
      const logos = (await shell(room.person.jan)).json().room.logos;
      expect(logos).toEqual({ light: true, dark: false, version: 'aaaaaaaa' });
    } finally {
      await pg.query(`delete from workspace_logo where workspace_id = $1`, [room.workspaceId]);
    }
  });

  it('returns 404 outside the room', async () => {
    const res = await shell('00000000-0000-4000-8000-000000000000');
    expect(res.statusCode).toBe(404);
  });
});
