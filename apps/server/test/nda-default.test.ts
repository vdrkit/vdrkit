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
  await h.pg.query(`update person set can_create_rooms = true where id = $1`, [h.person.anika]);
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at, mailer, publicUrl: 'https://dataroom.example' });
});
afterEach(async () => { await app.close(); await h.pg.close(); });

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';
const call = (method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-dev-person': h.person.anika, 'x-dev-tenant': h.t1 }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const NDA_TEXT = 'Confidentiality undertaking for Project Osprey, clause 1 to 12.';

async function newRoom(): Promise<string> {
  const res = await call('POST', '/v1/workspaces', { name: 'Project Osprey', timeZone: 'Africa/Johannesburg', start: 'empty' });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}
const settingsEvents = async (ws: string) =>
  (await call('GET', `/v1/workspaces/${ws}/events?action=workspace.settings_changed`)).json().items as { data: any }[];

describe('first NDA version', () => {
  it('turns on Ask for the NDA', async () => {
    const ws = await newRoom();
    expect((await call('GET', `/v1/workspaces/${ws}/settings`)).json().requiresNda).toBe(false);
    const pub = await call('PUT', `/v1/workspaces/${ws}/nda`, { body: NDA_TEXT, name: 'Osprey NDA 2026-11' });
    expect(pub.statusCode).toBe(200);
    expect(pub.json()).toMatchObject({ versionNo: 1, mode: 'everyone', requiresNda: true });
    expect((await call('GET', `/v1/workspaces/${ws}/settings`)).json().requiresNda).toBe(true);
    expect((await call('GET', `/v1/workspaces/${ws}/nda/overview`)).json().required).toBe(true);
    const ev = await settingsEvents(ws);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data).toMatchObject({ first_nda: true, before: { requiresNda: false }, after: { requiresNda: true } });
  });

  it('leaves the switch off for later versions', async () => {
    const ws = await newRoom();
    await call('PUT', `/v1/workspaces/${ws}/nda`, { body: NDA_TEXT });
    expect((await call('PATCH', `/v1/workspaces/${ws}/settings`, { requiresNda: false })).statusCode).toBe(200);
    const pub = await call('PUT', `/v1/workspaces/${ws}/nda`, { body: `${NDA_TEXT} Clause 13 added.`, mode: 'everyone' });
    expect(pub.json()).toMatchObject({ versionNo: 2, requiresNda: false });
    expect((await call('GET', `/v1/workspaces/${ws}/settings`)).json().requiresNda).toBe(false);
    expect((await settingsEvents(ws)).map((e) => e.data.first_nda ?? false)).toEqual([false, true]);
  });

  it('logs nothing when already on', async () => {
    const pub = await call('PUT', `/v1/workspaces/${h.ws}/nda`, { body: NDA_TEXT, mode: 'correction' });
    expect(pub.json()).toMatchObject({ versionNo: 2, requiresNda: true });
    expect(await settingsEvents(h.ws)).toEqual([]);
  });
});
