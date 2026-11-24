// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Channel, OutgoingMessage } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';


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

const call = (method: 'GET' | 'POST', url: string, person: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1 }, ...(payload !== undefined ? { payload } : {}) });
const canCreate = (p: string) => h.pg.query(`update person set can_create_rooms = true where id = $1`, [p]);

describe('room creators', () => {
  it('returns canCreateRooms and siteAdmin', async () => {
    expect((await call('GET', '/v1/me', h.person.anika)).json()).toMatchObject({ canCreateRooms: false, isSiteAdmin: false, organisation: 'Quillmont Advisory' });
    await canCreate(h.person.anika);
    expect((await call('GET', '/v1/me', h.person.anika)).json()).toMatchObject({ canCreateRooms: true, isSiteAdmin: false });
    await h.pg.query(`update person set is_site_admin = true where id = $1`, [h.person.jan]);
    expect((await call('GET', '/v1/me', h.person.jan)).json()).toMatchObject({ canCreateRooms: true, isSiteAdmin: true });
  });

  it('denies disabled accounts', async () => {
    await h.pg.query(`update person set is_site_admin = true, can_create_rooms = true where id = $1`, [h.person.anika]);
    await h.pg.query(`update person set disabled_at = $2 where id = $1`, [h.person.anika, T.at.toISOString()]);
    const me = await call('GET', '/v1/me', h.person.anika);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ canCreateRooms: false, isSiteAdmin: false });
    expect((await call('GET', '/v1/room-templates/standard', h.person.anika)).statusCode).toBe(404);
    const res = await call('POST', '/v1/workspaces', h.person.anika, { name: 'Project Ghost', start: 'empty' });
    expect(res.statusCode).toBe(404);
  });
});

describe('Standard M&A index preview', () => {
  it('lists 11 folders and 40 subfolders', async () => {
    await canCreate(h.person.anika);
    const res = await call('GET', '/v1/room-templates/standard', h.person.anika);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ folders: 11, subfolders: 40 });
    expect(body.items.map((f: any) => `${f.indexNumber} ${f.name}`)).toEqual([
      '1 Corporate', '2 Legal', '3 Finance', '4 Commercial', '5 HR', '6 IT', '7 Property', '8 Insurance', '9 Environmental',
      '10 Intellectual property', '11 Data protection']);
    expect(body.items.map((f: any) => f.children.length)).toEqual([6, 6, 5, 4, 4, 3, 3, 2, 2, 3, 2]);
    expect(body.items[2].children[0]).toEqual({ indexNumber: '3.1', name: 'Management accounts' });

    const room = (await call('POST', '/v1/workspaces', h.person.anika, { name: 'Project Ibis', start: 'standard' })).json();
    const made = (await h.pg.query<{ index_number: string; name: string }>(
      `select index_number, name from node where workspace_id = $1 and kind = 'folder' order by sort_key, index_number`, [room.id])).rows;
    const want = body.items.flatMap((f: any) => [f, ...f.children]).map((f: any) => `${f.indexNumber} ${f.name}`).sort();
    expect(made.map((f) => `${f.index_number} ${f.name}`).sort()).toEqual(want);
  });

  it('returns 404 to people who cannot create rooms', async () => {
    const missing = (await call('GET', '/v1/workspaces/00000000-0000-4000-8000-000000000000/shell', h.person.jan)).json();
    for (const p of [h.person.anika, h.person.jan, h.person.maria, h.person.lars]) {
      for (const res of [
        await call('GET', '/v1/room-templates/standard', p),
        await call('GET', `/v1/workspaces/name-check?name=${encodeURIComponent('Project Heron')}`, p),
        await call('POST', '/v1/workspaces', p, { name: 'Project Ghost', start: 'empty' }),
      ]) {
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual(missing);
      }
    }
  });
});

describe('create room', () => {
  it('creates the room in Preparing', async () => {
    await canCreate(h.person.anika);
    const res = await call('POST', '/v1/workspaces', h.person.anika, {
      name: '  Project   Ibis ', seller: 'Ibis Packaging (Pty) Ltd', timeZone: 'Africa/Johannesburg', start: 'standard',
      admins: [{ email: 'co.adviser@otherfirm.example' }],
    });
    expect(res.statusCode).toBe(201);
    const { id, invitedAdmins } = res.json();
    expect(invitedAdmins).toHaveLength(1);
    expect(outbox.map((m) => m.to)).toContain('co.adviser@otherfirm.example');
    const shell = await call('GET', `/v1/workspaces/${id}/shell`, h.person.anika);
    expect(shell.statusCode).toBe(200);
    expect(shell.json().room).toMatchObject({ state: 'preparing', timeZone: 'Africa/Johannesburg' });
    const ev = (await h.pg.query<{ action: string }>(`select action from event where workspace_id = $1 order by seq`, [id])).rows.map((r) => r.action);
    expect(ev[0]).toBe('workspace.created');
    expect((await call('GET', `/v1/workspaces/${id}/shell`, h.person.jan)).statusCode).toBe(404);
    expect((await call('GET', `/v1/workspaces/name-check?name=project%20ibis`, h.person.anika)).json()).toEqual({ available: false });
  });

  it('refuses people without the right', async () => {
    expect((await call('GET', `/v1/workspaces/name-check?name=Project%20Heron`, h.person.jan)).statusCode).toBe(404);
    expect((await call('POST', '/v1/workspaces', h.person.jan, { name: 'Project Ibis' })).statusCode).toBe(404);
  });
});
