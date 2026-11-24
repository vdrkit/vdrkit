// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { verifyChain, withTenant } from '@vdrkit/core';
import { buildApp } from '../src/app.js';
import { DevHeaderAuthenticator } from '../src/auth.js';
import { MemoryStorage } from '../src/pipeline/pipeline.js';
import { PENDING_REASON, PENDING_STUCK_AFTER_MS, publishWhenReady, STUCK_AFTER_MS, sweepStuckProcessing } from '../src/worker/jobs.js';
import { seedDemo, type DemoRoom } from '../src/demo/seed-demo.js';
import { freshDatabase, type TestPg } from '../../../packages/core/test/fixture.js';


let pg: TestPg;
let app: FastifyInstance;
let room: DemoRoom;
let db: Awaited<ReturnType<typeof freshDatabase>>['db'];
const storage = new MemoryStorage();

beforeAll(async () => {
  const fresh = await freshDatabase();
  pg = fresh.pg;
  db = fresh.db;
  room = await seedDemo(db, { role: 'vdrkit_app' });
  app = await buildApp({ db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', rateLimit: false, storage });
}, 120_000);
afterAll(async () => { await app.close(); await pg.close(); });

const W = () => `/v1/workspaces/${room.workspaceId}`;
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', person: string, url: string, payload?: unknown) => app.inject({
  method, url: `${W()}${url}`, headers: { 'x-dev-tenant': room.tenantId, 'x-dev-person': person }, ...(payload !== undefined ? { payload } : {}),
});
const sql = <T>(text: string, params: unknown[] = []) => withTenant(db, room.tenantId, (tx) => tx.query<T>(text, params)).then((r) => r.rows);
const versionsOf = (nodeId: string) => sql<{ id: string; version_no: number; processing_status: string; awaiting_release: boolean; withdrawn_at: string | null; metadata: any; publish_when_ready: any }>(
  `select id, version_no, processing_status, awaiting_release, withdrawn_at, metadata, publish_when_ready from document_version where node_id = $1 order by version_no`, [nodeId]);
const stateOf = async (nodeId: string) => (await sql<{ state: string; deleted_at: string | null }>(`select state, deleted_at from node where id = $1`, [nodeId]))[0]!;
const setRoomState = (state: string) => call('PATCH', room.person.anika, '/settings', { state });
const ws = () => room.workspaceId;

async function addVersion(nodeId: string, opts: { status: string; awaiting: boolean; uploader?: string }): Promise<string> {
  const principal = (await pg.query<{ id: string }>(`select id from principal where person_id = $1`, [opts.uploader ?? room.person.anika])).rows[0]!.id;
  return (await sql<{ id: string }>(
    `insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, uploaded_by, processing_status, page_count,
       awaiting_release, visible_to_group_ids, metadata)
     select current_tenant_id(), $1, coalesce(max(version_no), 0) + 1, 'test/' || gen_random_uuid(), encode(sha256(gen_random_uuid()::text::bytea), 'hex'),
            1000, 'application/pdf', $2, $3, case when $3 = 'ready' then 3 end, $4, '{}', '{}'
       from document_version where node_id = $1 returning id`, [nodeId, principal, opts.status, opts.awaiting]))[0]!.id;
}

async function addDraft(parentId: string, name: string, uploader: string, status = 'ready'): Promise<string> {
  const id = (await sql<{ id: string }>(
    `insert into node (tenant_id, workspace_id, parent_id, kind, name, index_number, sort_key, state)
     select current_tenant_id(), $1, $2, 'document', $3,
            p.index_number || '.' || (coalesce(max(split_part(c.index_number, '.', nlevel(p.path) + 1)::int), 0) + 1), coalesce(max(c.sort_key), 0) + 1, 'draft'
       from node p left join node c on c.parent_id = p.id where p.id = $2 group by p.index_number, p.path returning id`, [ws(), parentId, name]))[0]!.id;
  await addVersion(id, { status, awaiting: false, uploader });
  return id;
}

describe('Publish now', () => {
  it('publishes ready files now and the rest when processed', async () => {
    const ready = room.node['3.2.6']!;
    const busy = room.node['3.2.7']!;
    expect((await versionsOf(busy))[0]!.processing_status).toBe('pending');
    const res = await call('POST', room.person.johan, '/publish', { nodeIds: [ready, busy], whenReady: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ published: 1, waiting: 1 });
    expect((await stateOf(ready)).state).toBe('published');
    expect((await stateOf(busy)).state).toBe('draft');
    expect((await versionsOf(busy))[0]!.publish_when_ready).toMatchObject({ person_id: room.person.johan, quiet: false });
    const asked = await sql<{ data: any }>(`select data from event where action = 'document.publish_requested' and resource_id = $1`, [busy]);
    expect(asked[0]!.data).toMatchObject({ index_number: '3.2.7', person_id: room.person.johan });

    const v = (await versionsOf(busy))[0]!.id;
    await sql(`update document_version set processing_status = 'ready', page_count = 2 where id = $1`, [v]);
    expect(await withTenant(db, room.tenantId, (tx) => publishWhenReady(tx, v, new Date()), { role: 'vdrkit_app' })).toBe('published');
    expect((await stateOf(busy)).state).toBe('published');
    expect((await versionsOf(busy))[0]!.publish_when_ready).toBeNull();
    const pub = await sql<{ data: any }>(`select data from event where action = 'document.published' and resource_id = $1`, [busy]);
    expect(pub[0]!.data).toMatchObject({ index_number: '3.2.7', person_id: room.person.johan });
    expect(await withTenant(db, room.tenantId, (tx) => publishWhenReady(tx, v, new Date()), { role: 'vdrkit_app' })).toBeNull();
  });

  it('refuses failed files and people without the right', async () => {
    const draft = (await sql<{ id: string }>(`select id from node where parent_id = $1 and state = 'draft' and kind = 'document' and deleted_at is null
      order by string_to_array(index_number, '.')::int[] limit 2`, [room.node['3.5']]));
    const [a, b] = [draft[0]!.id, draft[1]!.id];
    await sql(`update document_version set processing_status = 'failed', processing_error = 'Broken' where node_id = $1`, [b]);
    const res = await call('POST', room.person.johan, '/publish', { nodeIds: [a, b], whenReady: true });
    expect([res.statusCode, res.json().reason]).toEqual([409, 'not_ready']);
    expect((await stateOf(a)).state).toBe('draft');
    expect((await call('POST', room.person.maria, '/publish', { nodeIds: [a], whenReady: true })).statusCode).toBe(403);
    expect((await call('POST', room.person.liesl, '/publish', { nodeIds: [a], whenReady: true })).statusCode).toBe(403);
    expect((await call('POST', room.person.jan, '/publish', { nodeIds: [a], whenReady: true })).statusCode).toBe(403);
    expect((await stateOf(a)).state).toBe('draft');
  });

  it('drops the request when refused later', async () => {
    const drafts = await sql<{ id: string }>(`select id from node where parent_id = $1 and state = 'draft' and kind = 'document' and deleted_at is null
      order by string_to_array(index_number, '.')::int[] desc limit 2`, [room.node['3.5']]);
    const [frozenOne, failingOne] = [drafts[0]!.id, drafts[1]!.id];
    for (const id of [frozenOne, failingOne]) await sql(`update document_version set processing_status = 'processing' where node_id = $1`, [id]);
    const res = await call('POST', room.person.johan, '/publish', { nodeIds: [frozenOne, failingOne], whenReady: true });
    expect(res.json()).toMatchObject({ published: 0, waiting: 2 });

    const v1 = (await versionsOf(frozenOne))[0]!.id;
    const v2 = (await versionsOf(failingOne))[0]!.id;
    expect((await setRoomState('frozen')).statusCode).toBe(200);
    try {
      await sql(`update document_version set processing_status = 'ready' where id = $1`, [v1]);
      expect(await withTenant(db, room.tenantId, (tx) => publishWhenReady(tx, v1, new Date()), { role: 'vdrkit_app' })).toBe('dropped');
    } finally {
      expect((await setRoomState('open')).statusCode).toBe(200);
    }
    expect((await stateOf(frozenOne)).state).toBe('draft');
    await sql(`update document_version set processing_status = 'failed' where id = $1`, [v2]);
    expect(await withTenant(db, room.tenantId, (tx) => publishWhenReady(tx, v2, new Date()), { role: 'vdrkit_app' })).toBe('dropped');
    const dropped = await sql<{ data: any }>(`select data from event where action = 'document.publish_request_dropped' order by occurred_at, id`);
    expect(dropped.map((d) => d.data)).toEqual([
      expect.objectContaining({ version_id: v1, reason: 'refused', detail: expect.stringContaining('frozen') }),
      expect.objectContaining({ version_id: v2, reason: 'failed' }),
    ]);
    expect((await versionsOf(frozenOne))[0]!.publish_when_ready).toBeNull();
  });
});

describe('stuck versions', () => {
  it('releases a ready version past a stuck one', async () => {
    const doc = room.node['2.4.3']!;
    const [, v2] = await versionsOf(doc);
    await sql(`update document_version set processing_status = 'pending' where id = $1`, [v2!.id]);
    const v3 = await addVersion(doc, { status: 'ready', awaiting: true });
    const review = (await call('GET', room.person.anika, `/release-review?folder=${room.node['2.4']}`)).json();
    const items = review.items.filter((i: any) => i.id === doc);
    expect(items.map((i: any) => [i.versionId, i.blocked])).toEqual([[v2!.id, 'processing'], [v3, null]]);
    const res = await call('POST', room.person.anika, '/publish', { versionIds: [v3] });
    expect(res.statusCode, res.body).toBe(200);
    const after = await versionsOf(doc);
    expect(after.map((v) => [v.version_no, v.awaiting_release, !!v.withdrawn_at, !!v.metadata.removed_draft])).toEqual([
      [1, false, false, false], [2, false, true, true], [3, false, false, false]]);
    const again = (await call('GET', room.person.anika, `/release-review?folder=${room.node['2.4']}`)).json();
    expect(again.items.some((i: any) => i.id === doc)).toBe(false);
    const ev = await sql<{ data: any }>(`select data from event where action = 'document.draft_removed' and resource_id = $1`, [doc]);
    expect(ev.map((e) => e.data)).toEqual([expect.objectContaining({ version_no: 2, superseded_by: 3 })]);
  });

  it('publishes a draft whose first version failed', async () => {
    const doc = await addDraft(room.node['2.4']!, 'Second try.pdf', room.person.anika);
    const [v1] = await versionsOf(doc);
    await sql(`update document_version set processing_status = 'failed', processing_error = 'Broken' where id = $1`, [v1!.id]);
    await addVersion(doc, { status: 'ready', awaiting: false });
    const review = (await call('GET', room.person.anika, `/release-review?folder=${room.node['2.4']}`)).json();
    expect(review.items.find((i: any) => i.id === doc).blocked).toBeNull();
    const res = await call('POST', room.person.anika, '/publish', { nodeIds: [doc] });
    expect(res.statusCode, res.body).toBe(200);
    expect((await stateOf(doc)).state).toBe('published');
  });
});

describe('pending versions', () => {
  it('fails versions stuck for 2 hours', async () => {
    const seeded = await sql<{ queued_at: string }>(`select queued_at from document_version where node_id = $1 order by version_no limit 1`, [room.node['3.2.7']]);
    expect(seeded[0]!.queued_at).not.toBeNull();
    const doc = room.node['2.4.12']!;
    const v = await addVersion(doc, { status: 'pending', awaiting: true });
    const queued = new Date('2026-11-19T08:00:00Z');
    await sql(`update document_version set queued_at = $2 where id = $1`, [v, queued.toISOString()]);
    await sql(`update document_version set processing_started_at = null`);
    const ctx = { db, dbRole: 'vdrkit_app' as const, now: () => new Date(queued.getTime() + PENDING_STUCK_AFTER_MS - 60_000) };
    const status = async () => (await sql<{ processing_status: string; processing_error: string | null }>(
      `select processing_status, processing_error from document_version where id = $1`, [v]))[0]!;
    await sweepStuckProcessing(ctx);
    expect((await status()).processing_status).toBe('pending');
    // queue still moving
    const later = new Date(queued.getTime() + PENDING_STUCK_AFTER_MS + 60_000);
    const other = await addVersion(room.node['2.4.11']!, { status: 'ready', awaiting: true });
    await sql(`update document_version set processing_started_at = $2 where id = $1`, [other, new Date(later.getTime() - 5 * 60_000).toISOString()]);
    await sweepStuckProcessing({ ...ctx, now: () => later });
    expect((await status()).processing_status).toBe('pending');
    // no worker running
    await sweepStuckProcessing({ ...ctx, now: () => new Date(later.getTime() + STUCK_AFTER_MS) });
    expect(await status()).toEqual({ processing_status: 'failed', processing_error: PENDING_REASON });
    expect(PENDING_REASON).toBe('VDRkit did not start processing this file within 2 hours. Ask your administrator to check the worker, then choose Process again.');
    const ev = await sql<{ data: any }>(`select data from event where action = 'document.processing_failed' and data ->> 'version_id' = $1`, [v]);
    expect(ev[0]!.data).toMatchObject({ failed_step: 'worker', never_started: true, error: PENDING_REASON });
    expect((await call('GET', room.person.anika, `/release-review?folder=${room.node['2.4']}`)).json()
      .items.find((i: any) => i.versionId === v).blocked).toBe('failed');
  });
});

describe('delete draft', () => {
  const firstVersion = async (nodeId: string) => (await versionsOf(nodeId))[0]!.id;

  it('refuses people without upload rights', async () => {
    const draft = [{ id: await addDraft(room.node['2.4']!, 'Maria upload.pdf', room.person.maria) }];
    const own = await firstVersion(draft[0]!.id);
    for (const p of [room.person.jan, room.person.lars]) {
      expect((await call('POST', p, `/versions/${own}/remove-draft`, {})).statusCode).toBe(404);
    }
    expect([403, 404]).toContain((await call('POST', room.person.liesl, `/versions/${own}/remove-draft`, {})).statusCode);
    const pubV = await firstVersion(room.node['2.4.4']!);
    expect([400, 403, 404]).toContain((await call('POST', room.person.jan, `/versions/${pubV}/remove-draft`, {})).statusCode);
    expect((await call('POST', room.person.maria, `/versions/${own}/remove-draft`, {})).statusCode).toBe(404);
    const johan = await call('POST', room.person.johan, `/versions/${own}/remove-draft`, {});
    expect([403, 404]).toContain(johan.statusCode);
    expect((await stateOf(draft[0]!.id)).deleted_at).toBeNull();
  });

  it('deletes the draft and its stored files', async () => {
    const drafts = await sql<{ id: string; sha256: string; storage_key: string; version: string }>(
      `select n.id, dv.sha256, dv.storage_key, dv.id as version from node n join document_version dv on dv.node_id = n.id
        where n.parent_id = $1 and n.state = 'draft' and n.deleted_at is null order by string_to_array(n.index_number, '.')::int[] limit 1`, [room.node['3.5']]);
    const d = drafts[0]!;
    await sql(`update document_version set processing_status = 'processing' where id = $1`, [d.version]);
    await storage.put(d.storage_key, Buffer.from('original'));
    for (const [kind, key] of [['pdf', `test/${d.version}/pdf`], ['page_image', `test/${d.version}/p1`]]) {
      await storage.put(key!, Buffer.from(kind!));
      await sql(`insert into derived_file (tenant_id, version_id, kind, step, storage_key, sha256) values (current_tenant_id(), $1, $2, 'test', $3, $4)`,
        [d.version, kind, key, 'a'.repeat(64)]);
    }
    await sql(`insert into document_text (tenant_id, workspace_id, node_id, version_id, page, body) values (current_tenant_id(), $1, $2, $3, 1, 'Secret words')`,
      [ws(), d.id, d.version]);

    const res = await call('POST', room.person.maria, `/versions/${d.version}/remove-draft`, { reason: 'Uploaded by mistake' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ removed: 'document', fallsBackTo: null, filesDeleted: 3 });
    expect([...storage.objects.keys()].filter((k) => k.includes(d.version) || k === d.storage_key)).toEqual([]);
    expect(await sql(`select 1 from derived_file where version_id = $1`, [d.version])).toEqual([]);
    expect(await sql(`select 1 from document_text where version_id = $1`, [d.version])).toEqual([]);
    expect((await versionsOf(d.id))[0]!.metadata).toMatchObject({ removed_draft: true, files_deleted: true });
    const ev = await sql<{ action: string; data: any }>(`select action, data from event where resource_id = $1 order by occurred_at, id`, [d.id]);
    expect(ev.at(-1)).toMatchObject({ action: 'document.draft_removed', data: { removed: 'document', files_deleted: 3, reason: 'Uploaded by mistake' } });
    expect((await withTenant(db, room.tenantId, (tx) => verifyChain(tx, ws()), { role: 'vdrkit_app' })).firstBroken).toBeNull();
    const live = await firstVersion(room.node['2.4.1']!);
    await expect(sql(`select forget_removed_draft_files($1)`, [live])).rejects.toThrow(/removed draft/);
    const plan = (await call('POST', room.person.anika, '/upload-plans', { targetFolderId: room.node['3.5'],
      files: [{ path: 'Again.pdf', size: 1000, sha256: d.sha256 }] })).json();
    expect(plan.files[0].status).toBe('new');
  });

  it('discards a waiting version of a published document', async () => {
    const doc = room.node['2.4.2']!;
    const v = await addVersion(doc, { status: 'ready', awaiting: true });
    const res = await call('POST', room.person.anika, `/versions/${v}/remove-draft`, {});
    expect(res.json()).toMatchObject({ removed: 'version', fallsBackTo: 1 });
    expect((await stateOf(doc))).toMatchObject({ state: 'published', deleted_at: null });
  });

  it('names the duplicated document', async () => {
    const sha = (await sql<{ sha256: string }>(`select sha256 from document_version where node_id = $1 order by version_no limit 1`, [room.node['2.4.1']]))[0]!.sha256;
    const plan = (await call('POST', room.person.anika, '/upload-plans', { targetFolderId: room.node['2.4'],
      files: [{ path: 'Copy.pdf', size: 1000, sha256: sha }] })).json();
    expect(plan.files[0]).toMatchObject({ status: 'duplicate_skipped', duplicateOf: '2.4.1', duplicateName: 'Master services agreement Kwelanet Business.pdf' });
  });
});

describe('folder numbers', () => {
  const tops = () => sql<{ id: string; index_number: string; sort_key: number }>(
    `select id, index_number, sort_key from node where workspace_id = $1 and parent_id is null and deleted_at is null order by sort_key`, [ws()]);

  it('sets a folder number such as 100', async () => {
    const before = await tops();
    const ins = room.node['8']!;
    const res = await call('PATCH', room.person.anika, `/nodes/${ins}`, { number: 100, confirmRenumberPublished: true });
    expect(res.statusCode, res.body).toBe(200);
    const after = await tops();
    expect(after.map((t) => t.index_number)).toEqual(['1', '2', '3', '4', '5', '6', '7', '9', '10', '11', '100']);
    expect(after.find((t) => t.id === ins)!.index_number).toBe('100');
    expect(before.filter((t) => t.id !== ins).every((t) => after.find((a) => a.id === t.id)!.index_number === t.index_number)).toBe(true);
    const kids = await sql<{ index_number: string }>(`select index_number from node where parent_id = $1 and deleted_at is null`, [ins]);
    expect(kids.every((k) => k.index_number.startsWith('100.'))).toBe(true);
    const list = (await call('GET', room.person.anika, '/nodes')).json().items.map((i: any) => i.indexNumber);
    expect(list).toEqual(['1', '2', '3', '4', '5', '6', '7', '9', '10', '11', '100']);
    const shell = (await call('GET', room.person.anika, '/shell')).json();
    expect(shell.index.filter((f: any) => !f.parentId).map((f: any) => f.indexNumber)).toEqual(list);
    // first free number, not 101
    const created = await call('POST', room.person.anika, '/folders', { name: 'Tax structuring' });
    expect(created.json().indexNumber).toBe('8');
    expect((await tops()).map((t) => t.index_number)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '100']);
    const next = await call('POST', room.person.anika, '/folders', { name: 'Administration' });
    expect(next.json().indexNumber).toBe('12');
  });

  it('moves colliding folders and undoes', async () => {
    const before = await tops();
    const eight = before.find((t) => t.index_number === '8')!;
    const res = await call('PATCH', room.person.anika, `/nodes/${eight.id}`, { number: 10, confirmRenumberPublished: true });
    expect(res.statusCode, res.body).toBe(200);
    expect((await tops()).map((t) => t.index_number)).toEqual(['1', '2', '3', '4', '5', '6', '7', '9', '10', '11', '12', '13', '100']);
    expect((await tops()).find((t) => t.id === eight.id)!.index_number).toBe('10');
    const changes = res.json().renumbered as { id: string; from: string; to: string }[];
    expect(changes.filter((c) => !c.from.includes('.') && !c.to.includes('.')).map((c) => `${c.from}>${c.to}`).sort())
      .toEqual(['10>11', '11>12', '12>13', '8>10']);
    const undo = await call('POST', room.person.anika, '/index/restore', { items: changes.map((c) => ({ id: c.id, indexNumber: c.from })) });
    expect(undo.statusCode, undo.body).toBe(200);
    expect((await tops()).map((t) => [t.id, t.index_number])).toEqual(before.map((t) => [t.id, t.index_number]));
    const hundred = before.find((t) => t.index_number === '100')!;
    const drag = await call('PATCH', room.person.anika, `/nodes/${hundred.id}`, { beforeId: before.find((t) => t.index_number === '9')!.id, confirmRenumberPublished: true });
    expect(drag.statusCode, drag.body).toBe(200);
    expect((await tops()).map((t) => t.index_number)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13']);
    expect((await call('POST', room.person.johan, '/index/restore', { items: [] })).statusCode).toBe(403);
    const now = await tops();
    const clash = await call('POST', room.person.anika, '/index/restore', { items: [{ id: now[0]!.id, indexNumber: now[1]!.index_number }] });
    expect(clash.statusCode).toBe(400);
    expect((await tops()).map((t) => t.index_number)).toEqual(now.map((t) => t.index_number));
  });

  it('keeps document numbers consecutive', async () => {
    const docs = () => sql<{ id: string; index_number: string }>(`select id, index_number from node where parent_id = $1 and deleted_at is null
      order by string_to_array(index_number, '.')::int[]`, [room.node['3.2']]);
    const before = await docs();
    const last = before.at(-1)!;
    const res = await call('PATCH', room.person.anika, `/nodes/${last.id}`, { number: 50, confirmRenumberPublished: true });
    expect(res.statusCode, res.body).toBe(200);
    expect((await docs()).map((d) => d.index_number)).toEqual(before.map((_, i) => `3.2.${i + 1}`));
    const first = await call('PATCH', room.person.anika, `/nodes/${last.id}`, { number: 1, confirmRenumberPublished: true });
    expect(first.statusCode).toBe(200);
    const after = await docs();
    expect(after.map((d) => d.index_number)).toEqual(before.map((_, i) => `3.2.${i + 1}`));
    expect(after[0]!.id).toBe(last.id);
  });

  it('finds the folder that was number 100 by its old number', async () => {
    const res = await call('GET', room.person.anika, '/search?q=100');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().items[0]).toMatchObject({ nodeId: room.node['8'], kind: 'folder', indexNumber: '9', wasNumber: '100' });
  });
});

describe('Drafts to publish card', () => {
  it('lists drafts the publisher may publish', async () => {
    const johan = (await call('GET', room.person.johan, '/dashboard')).json();
    expect(johan.role).toBe('member');
    expect(johan.toPublish.count).toBeGreaterThan(0);
    expect(johan.toPublish.byFolder.every((f: any) => f.folder.startsWith('3.'))).toBe(true);
    const inFinance = (await sql<{ n: number }>(`select count(*)::int as n from node n join node t on t.path @> n.path and nlevel(t.path) = 1
      where t.id = $1 and n.kind = 'document' and n.state = 'draft' and n.deleted_at is null`, [room.node['3']]))[0]!.n;
    expect(johan.toPublish.count).toBe(inFinance);
    expect(johan.toPublish.byFolder.reduce((a: number, f: any) => a + f.count, 0)).toBe(inFinance);
    expect(johan.toPublish.byFolder[0].folderId).toEqual(expect.any(String));
    for (const p of [room.person.maria, room.person.liesl, room.person.jan]) {
      expect((await call('GET', p, '/dashboard')).json().toPublish).toBeUndefined();
    }
  });
});
