// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { appendEvent, withTenant } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { LocalKeyProvider } from '../src/crypto/envelope.js';
import { DbKeyring } from '../src/crypto/keyring.js';
import { MemoryStorage } from '../src/pipeline/pipeline.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';


let h: Heron;
let app: FastifyInstance;
let clock: Date;

beforeEach(async () => {
  clock = T.at;
  h = await heron();
  app = await buildApp({
    db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => clock,
    storage: new MemoryStorage(), keyring: new DbKeyring(new LocalKeyProvider(randomBytes(32).toString('base64'))),
  });
});
afterEach(async () => {
  await app.close();
  await h.pg.close();
});

async function tick(minutes: number) {
  clock = new Date(clock.getTime() + minutes * 60_000);
  await h.pin(clock);
}

const W = () => `/v1/workspaces/${h.ws}`;
const as = (person: string, extra: Record<string, string> = {}) => ({ 'x-dev-person': person, 'x-dev-tenant': h.t1, 'user-agent': 'vitest', ...extra });
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, person: string, body?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: as(person, extra), ...(body ? { payload: body as object } : {}) });

const blocked = () => h.app(async (tx) => (await tx.query<{ resource_id: string; on_behalf_of_id: string | null; data: Record<string, unknown> }>(
  `select resource_id, on_behalf_of_id, data from event where action = 'access.blocked' order by seq`)).rows);

async function grant(groupId: string, level: number, nodeId = h.node.fin) {
  expect((await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId, groupId, level }] })).statusCode).toBe(200);
  await tick(1);
}

describe('blocked links', () => {
  it('returns 404 and records access.blocked', async () => {
    const refused = await call('POST', `${W()}/nodes/${h.node.aud1}/open`, h.person.jan);
    const missing = await call('POST', `${W()}/nodes/${randomUUID()}/open`, h.person.jan);
    expect(refused.statusCode).toBe(404);
    expect(refused.body).toBe(missing.body);
    expect(refused.headers['content-type']).toBe(missing.headers['content-type']);
    expect(refused.headers['content-length']).toBe(missing.headers['content-length']);

    const events = await blocked();
    expect(events).toHaveLength(1);
    expect(events[0]!.resource_id).toBe(h.node.aud1);
    expect(events[0]!.data).toEqual({ nodeId: h.node.aud1, route: 'viewer.open', reason: 'no_access', previouslySeen: false, personId: h.person.jan });
  });

  it('ignores unknown ids', async () => {
    for (const url of [`/nodes/${randomUUID()}`, `/nodes/${randomUUID()}/download`, `/nodes?parent=${randomUUID()}`]) {
      await call('GET', `${W()}${url}`, h.person.jan);
    }
    expect(await blocked()).toEqual([]);
  });

  it('ignores nodes of other tenants and rooms', async () => {
    const other = await withTenant(h.db, h.t2, async (tx) => {
      const ws = (await tx.query<{ id: string }>(`insert into workspace (tenant_id, name, state) values (current_tenant_id(), 'Other', 'active') returning id`)).rows[0]!.id;
      const node = (await tx.query<{ id: string }>(`insert into node (tenant_id, workspace_id, kind, name, index_number, state)
        values (current_tenant_id(), $1, 'document', 'Secret.pdf', '1', 'published') returning id`, [ws])).rows[0]!.id;
      return { ws, node };
    }, { role: 'vdrkit_app' });
    const sibling = await h.app(async (tx) => {
      const ws = (await tx.query<{ id: string }>(`insert into workspace (tenant_id, name, state) values (current_tenant_id(), 'Project Kite', 'active') returning id`)).rows[0]!.id;
      const node = (await tx.query<{ id: string }>(`insert into node (tenant_id, workspace_id, kind, name, index_number, state)
        values (current_tenant_id(), $1, 'document', 'Kite.pdf', '1', 'published') returning id`, [ws])).rows[0]!.id;
      return { ws, node };
    });
    const missing = await call('GET', `${W()}/nodes/${randomUUID()}`, h.person.jan);
    for (const [ws, node] of [[h.ws, other.node], [other.ws, other.node], [h.ws, sibling.node], [sibling.ws, sibling.node]] as const) {
      const res = await call('GET', `/v1/workspaces/${ws}/nodes/${node}`, h.person.jan);
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(missing.body);
    }
    expect(await blocked()).toEqual([]);
  });

  it('records one event per person and node per 10 minutes', async () => {
    for (let i = 0; i < 5; i++) expect((await call('GET', `${W()}/nodes/${h.node.aud1}`, h.person.jan)).statusCode).toBe(404);
    await call('GET', `${W()}/nodes/${h.node.aud1}/download`, h.person.jan);
    expect(await blocked()).toHaveLength(1);
    await tick(9);
    await call('GET', `${W()}/nodes/${h.node.aud1}`, h.person.jan);
    expect(await blocked()).toHaveLength(1);
    await call('GET', `${W()}/nodes/${h.node.aud1}`, h.person.mei);
    await call('GET', `${W()}/nodes/${h.node.aud1}`, h.person.jan, undefined, { 'x-dev-agent-max-level': '30' });
    await tick(2);
    await call('GET', `${W()}/nodes/${h.node.aud1}`, h.person.jan);
    const events = await blocked();
    expect(events).toHaveLength(4);
    const agent = events[2]!;
    expect(agent.data).toMatchObject({ personId: h.person.jan, agentId: 'dev-agent', route: 'nodes.get', reason: 'no_access' });
    expect(agent.on_behalf_of_id).toBe(h.person.jan);
  });

  it('sets previouslySeen', async () => {
    await grant(h.group.a, 30);
    expect((await call('GET', `${W()}/nodes/${h.node.aud1}`, h.person.jan)).statusCode).toBe(200);
    await h.app((tx) => appendEvent(tx, { action: 'document.opened', workspaceId: h.ws, resourceType: 'node', resourceId: h.node.aud1,
      data: { person_id: h.person.jan } }));
    await tick(60);
    expect((await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.a, reset: true }] })).statusCode).toBe(200);
    await tick(1);
    expect((await call('GET', `${W()}/nodes/${h.node.aud1}`, h.person.jan)).statusCode).toBe(404);
    expect((await call('GET', `${W()}/nodes/${h.node.tax1}`, h.person.jan)).statusCode).toBe(404);
    const events = await blocked();
    expect(events.map((e) => [e.resource_id, e.data.previouslySeen, e.data.reason])).toEqual([
      [h.node.aud1, true, 'no_access'],
      [h.node.tax1, false, 'no_access'],
    ]);
  });

  it('gives reason withdrawn or draft', async () => {
    await grant(h.group.a, 30);
    expect((await call('POST', `${W()}/nodes/${h.node.aud1}/withdraw`, h.person.anika, { reason: 'Restated' })).statusCode).toBe(200);
    await tick(1);
    expect((await call('GET', `${W()}/nodes/${h.node.aud1}`, h.person.jan)).statusCode).toBe(404);
    expect((await call('GET', `${W()}/nodes/${h.node.audDraft}`, h.person.jan)).statusCode).toBe(404);
    expect((await blocked()).map((e) => [e.resource_id, e.data.reason])).toEqual([
      [h.node.aud1, 'withdrawn'],
      [h.node.audDraft, 'draft'],
    ]);
  });

  it('gives reason version_hidden', async () => {
    await grant(h.group.a, 30);
    await grant(h.group.b, 30);
    await h.app((tx) => tx.query(
      `insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, visible_to_group_ids)
       values (current_tenant_id(), $1, 1, 'placeholder', $2, 1, 'application/pdf', $3::uuid[])`,
      [h.node.aud1, '0'.repeat(64), [h.group.a]]));
    expect((await call('GET', `${W()}/nodes/${h.node.aud1}`, h.person.jan)).statusCode).toBe(200);
    const refused = await call('GET', `${W()}/nodes/${h.node.aud1}`, h.person.mei);
    expect(refused.statusCode).toBe(404);
    expect(refused.body).toBe((await call('GET', `${W()}/nodes/${randomUUID()}`, h.person.mei)).body);
    expect((await blocked()).map((e) => [e.data.personId, e.data.reason, e.data.route])).toEqual([[h.person.mei, 'version_hidden', 'nodes.get']]);
  });

  it('records refused folder listings', async () => {
    const refused = await call('GET', `${W()}/nodes?parent=${h.node.aud}`, h.person.jan);
    const missing = await call('GET', `${W()}/nodes?parent=${randomUUID()}`, h.person.jan);
    expect(refused.statusCode).toBe(200);
    expect(refused.body).toBe(missing.body);
    expect((await blocked()).map((e) => [e.resource_id, e.data.route])).toEqual([[h.node.aud, 'nodes.list']]);
  });

  it('shows blocked links to admins under the old name', async () => {
    await call('GET', `${W()}/nodes/${h.node.aud1}`, h.person.jan);
    await tick(5);
    expect((await call('PATCH', `${W()}/nodes/${h.node.aud1}`, h.person.anika, { name: 'Restated statements FY2025.pdf' })).statusCode).toBe(200);

    expect((await call('GET', `${W()}/events`, h.person.jan)).statusCode).toBe(403);
    expect((await call('GET', `${W()}/events?action=access.blocked`, h.person.jan)).statusCode).toBe(403);
    expect((await call('GET', `${W()}/events/export.csv`, h.person.jan)).statusCode).toBe(403);
    expect((await call('GET', `${W()}/events`, h.person.jan, undefined, { 'x-dev-agent-max-level': '60' })).statusCode).toBe(403);

    const list = (await call('GET', `${W()}/events?action=access.blocked`, h.person.anika)).json().items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      action: 'access.blocked', actorName: 'Jan de Vries', resourceId: h.node.aud1,
      node: { name: 'Audited financial statements FY2025.pdf', indexNumber: '3.2.1' },
      data: { reason: 'no_access', route: 'nodes.get', previouslySeen: false },
    });

    const csv = (await call('GET', `${W()}/events/export.csv?action=access.blocked`, h.person.anika)).body.replace(/^\uFEFF/, '').split('\r\n');
    expect(csv).toHaveLength(3);
    expect(csv[1]).toContain('Jan de Vries,Bidder A,Blocked link,3.2.1 Audited financial statements FY2025.pdf,');
    expect(csv[1]).toContain('Their group has no access to this document. They saw a not-found page.');

    expect((await call('GET', `${W()}/events/verify`, h.person.anika)).json()).toMatchObject({ intact: true, firstBroken: null });
  });
});
