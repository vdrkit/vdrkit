// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { verifyChain, withTenant, type Channel, type OutgoingMessage } from '@vdrkit/core';
import { buildApp } from '../src/app.js';
import { DevHeaderAuthenticator } from '../src/auth.js';
import { DbKeyring } from '../src/crypto/keyring.js';
import { LocalKeyProvider } from '../src/crypto/envelope.js';
import { GotenbergClient, MemoryStorage } from '../src/pipeline/pipeline.js';
import { publishWhenReady, sendDueNotifications, type WorkerContext } from '../src/worker/jobs.js';
import { seedDemo, type DemoRoom } from '../src/demo/seed-demo.js';
import { freshDatabase, type TestPg } from '../../../packages/core/test/fixture.js';


let pg: TestPg;
let app: FastifyInstance;
let room: DemoRoom;
let db: Awaited<ReturnType<typeof freshDatabase>>['db'];
const outbox: OutgoingMessage[] = [];
const mailer: Channel = { name: 'email', send: async (m) => { outbox.push(m); return { status: 'accepted', providerMessageId: `<d${outbox.length}@mail.example>` }; } };
let ctx: WorkerContext;

beforeAll(async () => {
  const fresh = await freshDatabase();
  pg = fresh.pg;
  db = fresh.db;
  room = await seedDemo(db, { role: 'vdrkit_app' });
  app = await buildApp({ db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', rateLimit: false, storage: new MemoryStorage(), now: () => new Date() });
  ctx = {
    db, storage: new MemoryStorage(), keyring: new DbKeyring(new LocalKeyProvider(randomBytes(32).toString('base64'))),
    gotenberg: new GotenbergClient('http://127.0.0.1:9'), mailer, dbRole: 'vdrkit_app', now: () => new Date(), publicUrl: 'https://dataroom.example',
  };
}, 120_000);
afterAll(async () => { await app.close(); await pg.close(); });

const W = () => `/v1/workspaces/${room.workspaceId}`;
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', person: string, url: string, payload?: unknown) => app.inject({
  method, url: `${W()}${url}`, headers: { 'x-dev-tenant': room.tenantId, 'x-dev-person': person }, ...(payload !== undefined ? { payload } : {}),
});
const sql = <T>(text: string, params: unknown[] = []) => withTenant(db, room.tenantId, (tx) => tx.query<T>(text, params)).then((r) => r.rows);
const finish = (versionId: string) => withTenant(db, room.tenantId, (tx) => publishWhenReady(tx, versionId, new Date()), { role: 'vdrkit_app' });

async function draft(name: string): Promise<{ node: string; version: string }> {
  const parent = room.node['3.5']!;
  const node = (await sql<{ id: string }>(
    `insert into node (tenant_id, workspace_id, parent_id, kind, name, index_number, sort_key, state)
     select current_tenant_id(), $1, $2, 'document', $3,
            p.index_number || '.' || (coalesce(max(split_part(c.index_number, '.', nlevel(p.path) + 1)::int), 0) + 1), coalesce(max(c.sort_key), 0) + 1, 'draft'
       from node p left join node c on c.parent_id = p.id where p.id = $2 group by p.index_number, p.path returning id`,
    [room.workspaceId, parent, name]))[0]!.id;
  const principal = (await pg.query<{ id: string }>(`select id from principal where person_id = $1`, [room.person.maria])).rows[0]!.id;
  const version = (await sql<{ id: string }>(
    `insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, uploaded_by, processing_status, visible_to_group_ids, metadata)
     values (current_tenant_id(), $1, 1, 'test/' || gen_random_uuid(), encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 1000, 'application/pdf', $2, 'processing', '{}', '{}')
     returning id`, [node, principal]))[0]!.id;
  return { node, version };
}
const indexOf = async (node: string) => (await sql<{ index_number: string }>(`select index_number from node where id = $1`, [node]))[0]!.index_number;
const dashboard = async (person: string) => {
  const res = await call('GET', person, '/dashboard');
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
};

describe('dropped publish requests', () => {
  it('notifies the requester when the file fails', async () => {
    const d = await draft('Payment receipt.pdf');
    const res = await call('POST', room.person.johan, '/publish', { nodeIds: [d.node], whenReady: true });
    expect(res.json()).toMatchObject({ published: 0, waiting: 1 });
    await sql(`update document_version set processing_status = 'failed', processing_error = 'Broken' where id = $1`, [d.version]);
    expect(await finish(d.version)).toBe('dropped');

    const queued = await sql<{ person_id: string; category: string; mode: string }>(
      `select person_id, category, mode from notification where category = 'publish_dropped'`);
    expect(queued).toEqual([{ person_id: room.person.johan, category: 'publish_dropped', mode: 'immediate' }]);

    const ix = await indexOf(d.node);
    const sentence = `${ix} Payment receipt.pdf was not published: it could not be prepared for viewing. It is still a draft.`;
    const mine = await dashboard(room.person.johan);
    expect(mine.notPublished).toEqual([expect.objectContaining({ nodeId: d.node, name: 'Payment receipt.pdf', reason: 'failed', versionNo: null, text: sentence })]);
    expect((await dashboard(room.person.anika)).notPublished).toBeUndefined();

    expect(await sendDueNotifications(ctx, room.tenantId)).toMatchObject({ sent: 1 });
    const mail = outbox.at(-1)!;
    expect(mail.to).toBe('johan@seller.example.com');
    expect(mail.subject).toBe(`Project Heron: ${ix} Payment receipt.pdf was not published`);
    expect(mail.text).toContain(sentence);
    expect(mail.text).toContain('You get this email because you chose to hear in Project Heron when a publish you asked for did not happen.');
    const sent = (await pg.query<any>(
      `select e.data, c.personal from event e left join event_context c on c.event_id = e.id
        where e.action = 'notification.sent' and e.data ->> 'category' = 'publish_dropped'`)).rows;
    expect(sent).toHaveLength(1);
    expect(sent[0].data).toMatchObject({ recipient_person_id: room.person.johan, node_ids: [d.node], delivery_status: 'accepted', provider_message_id: `<d${outbox.length}@mail.example>` });
    expect(sent[0].personal).toEqual({ to: 'johan@seller.example.com', subject: mail.subject });
    const log = (await call('GET', room.person.anika, '/events?limit=200')).json().items;
    const entry = log.find((e: any) => e.action === 'notification.sent' && e.data?.category === 'publish_dropped');
    const proof = Object.fromEntries((entry.proof ?? []).map((x: { label: string; value: string }) => [x.label, x.value]));
    expect(proof).toMatchObject({ Email: 'Notification: A publish I asked for did not happen', Subject: mail.subject, Document: `${ix} Payment receipt.pdf` });

    expect((await call('POST', room.person.johan, `/versions/${d.version}/remove-draft`, {})).statusCode).toBe(200);
    expect((await dashboard(room.person.johan)).notPublished).toBeUndefined();
  });

  it('explains a refusal once the file is ready', async () => {
    const d = await draft('Bank letter.pdf');
    await call('POST', room.person.johan, '/publish', { nodeIds: [d.node], whenReady: true });
    await sql(`update document_version set processing_status = 'ready', page_count = 1 where id = $1`, [d.version]);
    expect((await call('PATCH', room.person.anika, '/settings', { state: 'frozen' })).statusCode).toBe(200);
    try {
      expect(await finish(d.version)).toBe('dropped');
    } finally {
      expect((await call('PATCH', room.person.anika, '/settings', { state: 'open' })).statusCode).toBe(200);
    }
    const ev = await sql<{ data: any }>(`select data from event where action = 'document.publish_request_dropped' and resource_id = $1`, [d.node]);
    expect(ev[0]!.data).toMatchObject({ reason: 'refused', code: 'room_frozen' });
    const ix = await indexOf(d.node);
    const sentence = `${ix} Bank letter.pdf was not published: the room was frozen when the file was ready. It is still a draft.`;
    expect((await dashboard(room.person.johan)).notPublished).toEqual([expect.objectContaining({ reason: 'refused', text: sentence })]);
    outbox.length = 0;
    await sendDueNotifications(ctx, room.tenantId);
    expect(outbox.map((m) => m.text).join('\n')).toContain(sentence);

    expect((await call('POST', room.person.johan, '/publish', { nodeIds: [d.node] })).statusCode).toBe(200);
    expect((await dashboard(room.person.johan)).notPublished).toBeUndefined();
  });

  it("respects the person's notification settings", async () => {
    const put = await call('PUT', room.person.johan, '/me/notifications', { events: { publish_dropped: { enabled: false } } });
    expect(put.statusCode, put.body).toBe(200);
    const mine = (await call('GET', room.person.johan, '/me/notifications')).json();
    expect(mine.events.find((e: any) => e.key === 'publish_dropped')).toMatchObject({
      label: 'A publish I asked for did not happen', enabled: false, roomDefault: { enabled: true, frequency: 'immediate' } });
    expect((await call('GET', room.person.jan, '/me/notifications')).json().events.some((e: any) => e.key === 'publish_dropped')).toBe(false);

    const before = (await sql<{ n: number }>(`select count(*)::int as n from notification where category = 'publish_dropped'`))[0]!.n;
    const d = await draft('Tax clearance.pdf');
    await call('POST', room.person.johan, '/publish', { nodeIds: [d.node], whenReady: true });
    await sql(`update document_version set processing_status = 'failed' where id = $1`, [d.version]);
    expect(await finish(d.version)).toBe('dropped');
    expect((await sql<{ n: number }>(`select count(*)::int as n from notification where category = 'publish_dropped'`))[0]!.n).toBe(before);
    expect((await dashboard(room.person.johan)).notPublished).toEqual([expect.objectContaining({ nodeId: d.node })]);
    await call('PUT', room.person.johan, '/me/notifications', { events: { publish_dropped: null } });
  });

  it('skips a queued email once the file is replaced', async () => {
    const d = await draft('Lease schedule.pdf');
    await call('POST', room.person.johan, '/publish', { nodeIds: [d.node], whenReady: true });
    await sql(`update document_version set processing_status = 'failed' where id = $1`, [d.version]);
    expect(await finish(d.version)).toBe('dropped');
    const principal = (await pg.query<{ id: string }>(`select id from principal where person_id = $1`, [room.person.maria])).rows[0]!.id;
    await sql(`insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, uploaded_by, processing_status, page_count, visible_to_group_ids, metadata)
      values (current_tenant_id(), $1, 2, 'test/' || gen_random_uuid(), encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 10, 'application/pdf', $2, 'ready', 1, '{}', '{}')`, [d.node, principal]);
    outbox.length = 0;
    expect(await sendDueNotifications(ctx, room.tenantId)).toMatchObject({ sent: 0, dropped: 1 });
    expect(outbox).toHaveLength(0);
    expect((await dashboard(room.person.johan)).notPublished ?? []).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ nodeId: d.node })]));
  });

  it('keeps the hash chain intact', async () => {
    expect((await withTenant(db, room.tenantId, (tx) => verifyChain(tx, room.workspaceId))).firstBroken).toBeNull();
  });
});
