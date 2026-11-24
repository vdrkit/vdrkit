// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { effectiveAccess, type Channel, type OutgoingMessage } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';


let h: Heron;
let app: FastifyInstance;
let outbox: OutgoingMessage[];
let clock: Date;
const mailer: Channel = { name: 'email', send: async (m) => { outbox.push(m); return { status: 'accepted' }; } };

beforeEach(async () => {
  h = await heron();
  outbox = [];
  clock = T.at;
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => clock, mailer });
  const res = await call('PUT', `${W()}/grants`, h.person.anika, { changes: [
    { nodeId: h.node.fin, groupId: h.group.a, level: 20 },
    { nodeId: h.node.fin, groupId: h.group.contributors, level: 20, canUpload: true, canPublish: true },
  ] });
  expect(res.statusCode).toBe(200);
  clock = later(1);
});
afterEach(async () => { await app.close(); await h.pg.close(); });

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, person: string, payload?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1, ...extra }, ...(payload !== undefined ? { payload } : {}) });
const W = () => `/v1/workspaces/${h.ws}`;
const later = (m: number) => new Date(T.at.getTime() + m * 60_000);
const level = (p: string, n: string) => h.app((tx) => effectiveAccess(tx, p, n, { at: clock })).then((a) => a.level);
const publish = (person: string, nodeIds: string[], extra: Record<string, string> = {}) =>
  call('POST', `${W()}/publish`, person, { nodeIds }, extra);

async function node(parent: string, name: string, idx: string, kind = 'document', state = 'draft'): Promise<string> {
  return (await h.pg.query<{ id: string }>(
    `insert into node (tenant_id, workspace_id, parent_id, kind, name, index_number, state) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [h.t1, h.ws, parent, kind, name, idx, state])).rows[0]!.id;
}

async function uploadedBy(nodeId: string, personId: string, versionNo = 1) {
  const principal = (await h.pg.query<{ id: string }>(
    `insert into principal (tenant_id, kind, person_id, name) values ($1, 'person', $2, 'test') returning id`, [h.t1, personId])).rows[0]!.id;
  await h.pg.query(
    `insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, uploaded_by, processing_status)
     values ($1, $2, $3, 'k', $4, 1, 'application/pdf', $5, 'ready')`, [h.t1, nodeId, versionNo, 'a'.repeat(64), principal]);
}

describe('publish right', () => {
  it('lets a contributor publish', async () => {
    expect(await level(h.person.jan, h.node.audDraft)).toBe(0);
    const res = await publish(h.person.maria, [h.node.audDraft]);
    expect(res.statusCode).toBe(200);
    expect(res.json().published).toBe(1);
    expect(await level(h.person.jan, h.node.audDraft)).toBe(20);
    const by = (await h.pg.query<{ published_by: string }>(`select published_by from node where id = $1`, [h.node.audDraft])).rows[0]!;
    expect(by.published_by).toBe(h.person.maria);
    expect((await h.pg.query(`select 1 from notification where person_id = $1`, [h.person.jan])).rows).toHaveLength(1);
  });

  it('shows up in the matrix and my rights', async () => {
    const grants = (await call('GET', `${W()}/grants`, h.person.anika)).json().grants;
    expect(grants.find((g: any) => g.groupId === h.group.contributors && g.nodeId === h.node.fin)).toMatchObject({ canUpload: true, canPublish: true });
    const items = (await call('GET', `${W()}/nodes?parent=${h.node.aud}`, h.person.maria)).json().items;
    expect(items.find((n: any) => n.id === h.node.audDraft).access.allowed).toContain('publish');
    expect((await call('GET', `${W()}/nodes?parent=${h.node.aud}`, h.person.jan)).json().items[0].access.allowed).not.toContain('publish');
  });

  it('should refuse other top folders', async () => {
    const itDraft = await node(h.node.it, 'Network diagram.pdf', '6.1');
    expect((await publish(h.person.maria, [itDraft])).statusCode).toBe(404);
    await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.it, groupId: h.group.contributors, level: 20, canUpload: true }] });
    clock = later(2);
    const res = await publish(h.person.maria, [h.node.audDraft, itDraft]);
    expect([res.statusCode, res.json().reason]).toEqual([403, 'no_publish_right']);
    expect(res.json().items).toEqual([{ id: itDraft, indexNumber: '6.1' }]);
    expect(await level(h.person.jan, h.node.audDraft)).toBe(0);
  });

  it('cannot change grants or room settings', async () => {
    const res = await call('PUT', `${W()}/grants`, h.person.maria, { changes: [{ nodeId: h.node.it, groupId: h.group.contributors, level: 60, canPublish: true }] });
    expect([res.statusCode, res.json().reason]).toEqual([403, 'not_room_admin']);
    expect((await call('PATCH', `${W()}/settings`, h.person.maria, { fourEyesPublish: true })).statusCode).toBe(403);
  });

  it('refuses a draft under a draft folder', async () => {
    const folder = await node(h.node.fin, 'Treasury', '3.5', 'folder');
    const sub = await node(folder, 'Cash pooling', '3.5.1', 'folder');
    const doc = await node(sub, 'Cash pool agreement.pdf', '3.5.1.1');
    // publish only on the subfolder
    await call('PUT', `${W()}/grants`, h.person.anika, { changes: [
      { nodeId: h.node.fin, groupId: h.group.contributors, level: 20, canUpload: true },
      { nodeId: sub, personId: h.person.maria, level: 20, canPublish: true },
    ] });
    clock = later(2);
    const res = await publish(h.person.maria, [doc]);
    expect([res.statusCode, res.json().reason]).toEqual([403, 'no_publish_right']);
    expect(res.json().items).toEqual([{ id: folder, indexNumber: '3.5' }]);
    expect((await publish(h.person.anika, [folder])).statusCode).toBe(200);
    clock = later(3);
    expect((await publish(h.person.maria, [doc])).json().published).toBe(2);
  });

  it('limits withdraw to her folders', async () => {
    expect((await call('POST', `${W()}/nodes/${h.node.aud1}/withdraw`, h.person.maria, {})).statusCode).toBe(200);
    expect(await level(h.person.jan, h.node.aud1)).toBe(0);
    const itDoc = await node(h.node.it, 'Network diagram.pdf', '6.1', 'document', 'published');
    expect((await call('POST', `${W()}/nodes/${itDoc}/withdraw`, h.person.maria, {})).statusCode).toBe(404);
    expect((await call('POST', `${W()}/nodes/${h.node.tax1}/withdraw`, h.person.jan, {})).json().reason).toBe('no_publish_right');
  });
});

describe('release review', () => {
  it('lists only publishable drafts', async () => {
    await node(h.node.it, 'Network diagram.pdf', '6.1');
    const admin = (await call('POST', `${W()}/release-preview`, h.person.anika, {})).json().items;
    expect(admin.map((d: any) => d.indexNumber)).toEqual(['3.2.5', '6.1']);
    const mine = (await call('POST', `${W()}/release-preview`, h.person.maria, {})).json().items;
    expect(mine.map((d: any) => [d.indexNumber, d.groups.map((g: any) => g.name)])).toEqual([['3.2.5', ['Bidder A']]]);
    const jan = await call('POST', `${W()}/release-preview`, h.person.jan, {});
    expect([jan.statusCode, jan.json().reason]).toEqual([403, 'no_publish_right']);
    const outsider = (await h.pg.query<{ id: string }>(
      `insert into person (tenant_id, name, email) values ($1, 'Outsider', 'out@example.com') returning id`, [h.t1])).rows[0]!.id;
    expect((await call('POST', `${W()}/release-preview`, outsider, {})).statusCode).toBe(404);
  });
});

describe('four-eyes rule', () => {
  it('is off by default', async () => {
    expect((await call('GET', `${W()}/settings`, h.person.anika)).json().fourEyesPublish).toBe(false);
    const res = await call('PATCH', `${W()}/settings`, h.person.anika, { fourEyesPublish: true });
    expect([res.statusCode, res.json().fourEyesPublish]).toEqual([200, true]);
  });

  it('should block your own upload', async () => {
    await uploadedBy(h.node.audDraft, h.person.maria);
    await call('PATCH', `${W()}/settings`, h.person.anika, { fourEyesPublish: true });
    const res = await publish(h.person.maria, [h.node.audDraft]);
    expect([res.statusCode, res.json().reason]).toEqual([403, 'four_eyes']);
    expect(res.json().detail).toBe('This room needs a second person to publish. You uploaded this document yourself.');
    expect(await level(h.person.jan, h.node.audDraft)).toBe(0);
    expect((await publish(h.person.anika, [h.node.audDraft])).statusCode).toBe(200);
    expect(await level(h.person.jan, h.node.audDraft)).toBe(20);
  });

  it('exempts room admins', async () => {
    await uploadedBy(h.node.audDraft, h.person.anika, 1);
    await call('PATCH', `${W()}/settings`, h.person.anika, { fourEyesPublish: true });
    expect((await publish(h.person.anika, [h.node.audDraft])).statusCode).toBe(200);
  });

  it('checks older versions too', async () => {
    await uploadedBy(h.node.audDraft, h.person.maria, 1);
    await call('PATCH', `${W()}/settings`, h.person.anika, { fourEyesPublish: true });
    await uploadedBy(h.node.audDraft, h.person.anika, 2);
    const res = await publish(h.person.maria, [h.node.audDraft]);
    expect([res.statusCode, res.json().reason]).toEqual([403, 'four_eyes']);
    expect(await level(h.person.jan, h.node.audDraft)).toBe(0);
    await h.pg.query(`update document_version set withdrawn_at = now() where node_id = $1 and version_no = 1`, [h.node.audDraft]);
    expect((await publish(h.person.maria, [h.node.audDraft])).statusCode).toBe(200);
  });

  it('allows your own upload when off', async () => {
    await uploadedBy(h.node.audDraft, h.person.maria);
    expect((await publish(h.person.maria, [h.node.audDraft])).statusCode).toBe(200);
  });
});

describe('agents', () => {
  it('never publishes, reviews or withdraws', async () => {
    const agent = { 'x-dev-agent-max-level': '60' };
    const res = await publish(h.person.anika, [h.node.audDraft], agent);
    expect([res.statusCode, res.json().reason]).toEqual([403, 'agent_needs_approval']);
    expect((await call('POST', `${W()}/release-preview`, h.person.anika, {}, agent)).statusCode).toBe(403);
    expect((await call('POST', `${W()}/nodes/${h.node.aud1}/withdraw`, h.person.anika, {}, agent)).statusCode).toBe(403);
    expect((await publish(h.person.maria, [h.node.audDraft], agent)).statusCode).toBe(403);
    const items = (await call('GET', `${W()}/nodes?parent=${h.node.aud}`, h.person.maria, undefined, agent)).json().items;
    expect(items.every((n: any) => !n.access.allowed.includes('publish'))).toBe(true);
    expect(await level(h.person.jan, h.node.audDraft)).toBe(0);
  });
});
