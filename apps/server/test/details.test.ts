// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { withTenant } from '@vdrkit/core';
import { buildApp } from '../src/app.js';
import { DevHeaderAuthenticator } from '../src/auth.js';
import { seedDemo, type DemoRoom } from '../src/demo/seed-demo.js';
import { freshDatabase, type TestPg } from '../../../packages/core/test/fixture.js';


let pg: TestPg;
let app: FastifyInstance;
let room: DemoRoom;
let db: Awaited<ReturnType<typeof freshDatabase>>['db'];

beforeAll(async () => {
  const fresh = await freshDatabase();
  pg = fresh.pg;
  db = fresh.db;
  room = await seedDemo(db, { role: 'vdrkit_app' });
  app = await buildApp({ db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', rateLimit: false });
}, 120_000);
afterAll(async () => { await app.close(); await pg.close(); });

const W = () => `/v1/workspaces/${room.workspaceId}`;
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', person: string, url: string, payload?: unknown) => app.inject({
  method, url: `${W()}${url}`, headers: { 'x-dev-tenant': room.tenantId, 'x-dev-person': person }, ...(payload !== undefined ? { payload } : {}),
});
const details = (person: string, ix: string) => call('GET', person, `/nodes/${room.node[ix]}/details`);
const sql = <T>(text: string, params: unknown[]) => withTenant(db, room.tenantId, (tx) => tx.query<T>(text, params)).then((r) => r.rows);

describe('GET .../nodes/{id}/details', () => {
  it('shows admins versions, audience and readers', async () => {
    const res = await details(room.person.anika, '2.4.3');
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.document).toMatchObject({ indexNumber: '2.4.3', state: 'published', path: [{ indexNumber: '2' }, { indexNumber: '2.4' }] });
    expect(d.versions.map((v: any) => [v.number, v.status])).toEqual([[2, 'waiting'], [1, 'current']]);
    expect(d.versions[1].releasedAt).toEqual(expect.any(String));
    expect(d.versions[1].releasedBy).toBe('Anika Pillay');
    expect(d.versions[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(d.versions[0].processing.steps).toEqual({ received: 'done', virus: 'skipped', pages: 'done', images: 'done', text: 'done' });
    expect(d.me).toMatchObject({ isAdmin: true, canUpload: true, canPublish: true });
    const level = (n: string) => d.access.groups.find((g: any) => g.name === n)?.level;
    expect([level('Bidder A'), level('Bidder B'), level('Bidder C'), level('Bidder C financiers')]).toEqual([40, 20, 20, 0]);
    expect(d.access.groups.every((g: any) => g.custom === false)).toBe(true);
    expect(d.access.folder.indexNumber).toBe('2.4');
    expect(d.reads.versionNumber).toBe(1);
    expect(d.reads.groups.map((g: any) => g.name)).toEqual(['Bidder A', 'Bidder B', 'Bidder C']);
  });

  it('hides readers and publish right from contributors', async () => {
    const d = (await details(room.person.maria, '3.2.7')).json();
    expect(d.me).toMatchObject({ isAdmin: false, canUpload: true, canPublish: false });
    expect(d.reads).toBeNull();
    expect(d.access).not.toBeNull();
    expect(d.versions[0]).toMatchObject({ number: 1, status: 'draft', uploadedBy: { name: 'Maria Botha' } });
    expect(d.versions[0].processing).toMatchObject({ status: 'pending', steps: { received: 'done', pages: 'waiting' } });
    expect(d.publishers.map((p: any) => p.name)).toEqual(['Johan Steyn', 'Anika Pillay']);
  });

  it('gives publishers the publish right in their folder', async () => {
    expect((await details(room.person.johan, '3.2.7')).json().me.canPublish).toBe(true);
  });

  it('hides groups and drafts from observers', async () => {
    const d = (await details(room.person.liesl, '2.4.2')).json();
    expect(d.access).toBeNull();
    expect(d.reads).toBeNull();
    expect(d.me).toMatchObject({ canUpload: false, canPublish: false });
    // observer only sees version 1
    const k = (await details(room.person.liesl, '2.4.3')).json();
    expect(k.versions.map((v: any) => v.number)).toEqual([1]);
    expect((await details(room.person.liesl, '3.2.7')).statusCode).toBe(404);
  });

  it('shows processing failures', async () => {
    await pg.query(`update document_version set processing_status = 'failed', failed_step = 'convert',
      processing_error = 'The PDF is protected with a password, so its pages cannot be read or watermarked.' where node_id = $1`, [room.node['3.2.7']]);
    const v = (await details(room.person.anika, '3.2.7')).json().versions[0];
    expect(v.processing).toEqual({ status: 'failed', error: expect.stringContaining('password'),
      steps: { received: 'done', virus: 'skipped', pages: 'failed', images: 'waiting', text: 'waiting' },
      virusSkip: { reason: 'not_configured', limitBytes: null }, noPreview: null });
    await pg.query(`update document_version set processing_status = 'pending', failed_step = null, processing_error = null where node_id = $1`, [room.node['3.2.7']]);
  });

  it('shows virus check results', async () => {
    const node = room.node['3.2.7'];
    await pg.query(`update document_version set processing_status = 'ready', metadata = metadata || '{"virusScan": "clean"}' where node_id = $1`, [node]);
    expect((await details(room.person.anika, '3.2.7')).json().versions[0].processing.steps.virus).toBe('done');
    await pg.query(`update document_version set processing_status = 'failed', failed_step = 'virus', metadata = metadata || '{"virusScan": "infected"}',
      processing_error = 'The virus scanner found Eicar-Test-Signature in this file. It is locked: nobody can open or download it. Remove it and upload a clean copy.'
      where node_id = $1`, [node]);
    const v = (await details(room.person.anika, '3.2.7')).json().versions[0];
    expect(v.processing).toEqual({ status: 'failed', error: expect.stringContaining('Eicar-Test-Signature'),
      steps: { received: 'done', virus: 'failed', pages: 'waiting', images: 'waiting', text: 'waiting' }, virusSkip: null, noPreview: null });
    await pg.query(`update document_version set processing_status = 'pending', failed_step = null, processing_error = null,
      metadata = metadata - 'virusScan' where node_id = $1`, [node]);
  });

  it('explains a skipped virus check', async () => {
    const node = room.node['3.2.7'];
    await pg.query(`update document_version set processing_status = 'ready', metadata = metadata || '{"virusScan": "too_large", "virusScanLimit": 1073741824}'
      where node_id = $1`, [node]);
    const v = (await details(room.person.anika, '3.2.7')).json().versions[0];
    expect([v.processing.steps.virus, v.processing.virusSkip]).toEqual(['skipped', { reason: 'too_large', limitBytes: 1073741824 }]);
    // older events have no limit
    await pg.query(`update document_version set metadata = metadata - 'virusScanLimit' where node_id = $1`, [node]);
    expect((await details(room.person.anika, '3.2.7')).json().versions[0].processing.virusSkip).toEqual({ reason: 'too_large', limitBytes: null });
    await pg.query(`update document_version set metadata = metadata || '{"virusScan": "clean"}' where node_id = $1`, [node]);
    expect((await details(room.person.anika, '3.2.7')).json().versions[0].processing.virusSkip).toBeNull();
    await pg.query(`update document_version set processing_status = 'pending', metadata = metadata - 'virusScan' where node_id = $1`, [node]);
  });

  it('returns 404 to the buyer side', async () => {
    const missing = await call('GET', room.person.jan, `/nodes/00000000-0000-4000-8000-000000000000/details`);
    for (const p of [room.person.jan, room.person.pieter, room.person.lars]) {
      const res = await details(p, '2.4.2');
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(missing.body);
    }
    expect((await details(room.person.anika, '2.4')).statusCode).toBe(404);
  });
});

describe('POST .../versions/{id}/remove-draft', () => {
  const versionOf = async (ix: string, no: number) =>
    (await sql<{ id: string }>(`select id from document_version where node_id = $1 and version_no = $2`, [room.node[ix], no]))[0]!.id;

  it('refuses contributors, bidders and published versions', async () => {
    const v2 = await versionOf('2.4.3', 2);
    const maria = await call('POST', room.person.maria, `/versions/${v2}/remove-draft`, {});
    expect(maria.statusCode).toBe(403);
    expect(maria.json().reason).toBe('no_publish_right');
    expect((await call('POST', room.person.jan, `/versions/${v2}/remove-draft`, {})).statusCode).toBe(404);
    const v1 = await versionOf('2.4.3', 1);
    const res = await call('POST', room.person.anika, `/versions/${v1}/remove-draft`, {});
    expect(res.statusCode).toBe(400);
  });

  it('removes a waiting version', async () => {
    const v2 = await versionOf('2.4.3', 2);
    const res = await call('POST', room.person.anika, `/versions/${v2}/remove-draft`, { reason: 'Wrong file' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: 'version', fallsBackTo: 1, filesDeleted: 1 });
    const d = (await details(room.person.anika, '2.4.3')).json();
    expect(d.versions.map((v: any) => [v.number, v.status])).toEqual([[2, 'removed'], [1, 'current']]);
    expect(d.me.viewerVersionId).toBe(d.versions[1].id);
    const preview = (await call('POST', room.person.anika, '/release-preview', { nodeIds: [room.node['2.4.3']] })).json();
    expect(preview.items).toEqual([]);
    expect((await call('POST', room.person.anika, '/publish', { versionIds: [v2] })).statusCode).toBe(400);
    const ev = await sql<{ data: any }>(`select data from event where action = 'document.draft_removed' and resource_id = $1`, [room.node['2.4.3']]);
    expect(ev[0]!.data).toMatchObject({ version_no: 2, removed: 'version', reason: 'Wrong file' });
    expect((await call('POST', room.person.anika, `/versions/${v2}/remove-draft`, {})).statusCode).toBe(400);
  });

  it('lets publishers remove a draft document', async () => {
    const draft = (await sql<{ id: string; index_number: string }>(
      `select id, index_number from node where parent_id = $1 and state = 'draft' and kind = 'document' order by index_number limit 1`, [room.node['3.5']]))[0]!;
    const v = (await sql<{ id: string }>(`select id from document_version where node_id = $1`, [draft.id]))[0]!.id;
    const res = await call('POST', room.person.johan, `/versions/${v}/remove-draft`, {});
    expect(res.json()).toEqual({ removed: 'document', fallsBackTo: null, filesDeleted: 1 });
    expect((await call('GET', room.person.anika, `/nodes/${draft.id}/details`)).statusCode).toBe(404);
    const list = (await call('GET', room.person.anika, `/nodes?parent=${room.node['3.5']}`)).json();
    expect(list.items.some((i: any) => i.id === draft.id)).toBe(false);
  });

  const draftsIn35 = () => sql<{ id: string; index_number: string; version: string }>(
    `select n.id, n.index_number, dv.id as version from node n join document_version dv on dv.node_id = n.id
      where n.parent_id = $1 and n.state = 'draft' and n.kind = 'document' and n.deleted_at is null
      order by string_to_array(n.index_number, '.')::int[] desc`, [room.node['3.5']]);

  it('lets contributors remove only their own drafts', async () => {
    const [mine, other] = await draftsIn35();
    const anikaPrincipal = (await pg.query<{ id: string }>(`select id from principal where person_id = $1`, [room.person.anika])).rows[0]!.id;
    await pg.query(`update document_version set uploaded_by = $2 where id = $1`, [other!.version, anikaPrincipal]);

    const d = async (id: string) => (await call('GET', room.person.maria, `/nodes/${id}/details`)).json().versions[0].canRemove;
    expect(await d(mine!.id)).toBe(true);
    expect(await d(other!.id)).toBe(false);
    expect((await call('GET', room.person.liesl, `/nodes/${room.node['2.4.3']}/details`)).json().versions.every((v: any) => v.canRemove === false)).toBe(true);

    const refused = await call('POST', room.person.maria, `/versions/${other!.version}/remove-draft`, {});
    expect(refused.statusCode).toBe(403);
    expect(refused.json().reason).toBe('no_publish_right');
    expect((await call('POST', room.person.liesl, `/versions/${mine!.version}/remove-draft`, {})).statusCode).toBe(404);

    const ok = await call('POST', room.person.maria, `/versions/${mine!.version}/remove-draft`, {});
    expect(ok.json()).toEqual({ removed: 'document', fallsBackTo: null, filesDeleted: 1 });
    const ev = await sql<{ data: any }>(`select data from event where action = 'document.draft_removed' and resource_id = $1`, [mine!.id]);
    expect(ev[0]!.data).toMatchObject({ person_id: room.person.maria, removed: 'document' });
  });

  it('blocks contributors in a frozen room', async () => {
    const canRemove = async (id: string) => (await call('GET', room.person.maria, `/nodes/${id}/details`)).json().versions[0].canRemove;
    let mine: { id: string; version: string } | undefined;
    for (const d of await draftsIn35()) if (await canRemove(d.id)) { mine = d; break; }
    expect(mine).toBeDefined();
    const state = (await sql<{ state: string }>(`select state from workspace where id = $1`, [room.workspaceId]))[0]!.state;
    expect((await call('PATCH', room.person.anika, '/settings', { state: 'frozen' })).statusCode).toBe(200);
    try {
      expect(await canRemove(mine!.id)).toBe(false);
      const res = await call('POST', room.person.maria, `/versions/${mine!.version}/remove-draft`, {});
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ reason: 'room_frozen', detail: 'The room is frozen, so you cannot remove your draft until a room admin unfreezes it.' });
    } finally {
      expect((await call('PATCH', room.person.anika, '/settings', { state })).statusCode).toBe(200);
    }
  });

  it('should not reuse removed draft numbers', async () => {
    const [last] = await draftsIn35();
    expect((await call('POST', room.person.anika, `/versions/${last!.version}/remove-draft`, {})).statusCode).toBe(200);
    // 3.5.24 was removed in the previous test
    const n = Math.max(...(await sql<{ ix: string }>(`select index_number as ix from node where parent_id = $1`, [room.node['3.5']])).map((r) => Number(r.ix.split('.').pop())));
    expect(n).toBeGreaterThan(Number(last!.index_number.split('.').pop()));
    const folder = await call('POST', room.person.anika, '/folders', { parentId: room.node['3.5'], name: 'Hedging' });
    expect(folder.statusCode).toBe(201);
    expect(folder.json().indexNumber).toBe(`3.5.${n + 1}`);
    const plan = (await call('POST', room.person.anika, '/upload-plans', { targetFolderId: room.node['3.5'], files: [{ path: 'Swap confirmation.pdf', size: 10 }] })).json();
    expect(JSON.stringify(plan)).toContain(`3.5.${n + 2}`);
  });

  it('keeps removed numbers after a folder move', async () => {
    const removed = await sql<{ ix: string }>(`select index_number as ix from node where parent_id = $1 and deleted_at is not null`, [room.node['3.5']]);
    expect(removed.length).toBeGreaterThan(0);
    const highest = Math.max(...(await sql<{ ix: string }>(`select index_number as ix from node where parent_id = $1`, [room.node['3.5']])).map((r) => Number(r.ix.split('.').pop())));
    const move = (data: unknown) => call('PATCH', room.person.anika, `/nodes/${room.node['3.5']}`, { ...(data as object), confirmRenumberPublished: true });
    const moved = await move({ parentId: room.node['2.4'] });
    expect(moved.statusCode).toBe(200);
    try {
      const prefix = (await sql<{ ix: string }>(`select index_number as ix from node where id = $1`, [room.node['3.5']]))[0]!.ix;
      expect(prefix.split('.')).toHaveLength(3);
      expect(removed.every((r) => r.ix.startsWith('3.5.'))).toBe(true);
      const folder = await call('POST', room.person.anika, '/folders', { parentId: room.node['3.5'], name: 'Interest rate swaps' });
      expect(folder.statusCode).toBe(201);
      expect(folder.json().indexNumber).toBe(`${prefix}.${highest + 1}`);
    } finally {
      expect((await move({ parentId: room.node['3'], position: 5 })).statusCode).toBe(200);
    }
  });
});

describe('processing and recent uploads', () => {
  it('returns only versions the caller uploaded', async () => {
    const mine = (await sql<{ id: string }>(`select id from document_version where node_id = $1`, [room.node['3.2.7']]))[0]!.id;
    const other = (await sql<{ id: string }>(`select id from document_version where node_id = $1`, [room.node['2.4.2']]))[0]!.id;
    const res = await call('POST', room.person.maria, '/versions/processing', { ids: [mine, other] });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: any) => [i.versionId, i.status])).toEqual([[mine, 'pending']]);
    expect((await call('POST', room.person.anika, '/versions/processing', { ids: [mine, other] })).json().items).toHaveLength(2);
    expect((await call('POST', room.person.jan, '/versions/processing', { ids: [mine] })).json().items).toEqual([]);
  });

  it('groups uploads per person and sitting', async () => {
    const all = (await call('GET', room.person.anika, '/uploads/recent?limit=10')).json().items;
    expect(all.length).toBeGreaterThan(1);
    expect(new Set(all.map((b: any) => b.person.name))).toEqual(new Set(['Anika Pillay', 'Maria Botha']));
    expect(all.filter((b: any) => b.first)).toHaveLength(1);
    const maria = (await call('GET', room.person.maria, '/uploads/recent?limit=10')).json().items;
    expect(maria.length).toBeGreaterThan(0);
    expect(maria.every((b: any) => b.person.name === 'Maria Botha')).toBe(true);
    expect(maria[0].drafts).toBeGreaterThan(0);
    expect(maria[0].folders.map((f: any) => f.indexNumber)).toEqual(['2.4', '3.2', '3.5']);
    expect((await call('GET', room.person.jan, '/uploads/recent')).json().items).toEqual([]);
  });

  it('hides folders the caller cannot see', async () => {
    const hide = await call('PUT', room.person.anika, '/grants', { changes: [{ nodeId: room.node['2.4'], groupId: room.group.finance, level: 0 }] });
    expect(hide.statusCode).toBe(200);
    const maria = (await call('GET', room.person.maria, '/uploads/recent?limit=10')).json().items;
    expect(maria[0].folders.map((f: any) => f.indexNumber)).toEqual(['3.2', '3.5']);
    expect(maria.some((b: any) => b.first)).toBe(false);
    const all = (await call('GET', room.person.anika, '/uploads/recent?limit=10')).json().items;
    expect(all.find((b: any) => b.person.name === 'Maria Botha').folders.map((f: any) => f.indexNumber)).toEqual(['2.4', '3.2', '3.5']);
  });
});

describe('frozen rooms and reordering', () => {
  const liveIn35 = () => sql<{ id: string; index_number: string; state: string; kind: string }>(
    `select id, index_number, state, kind from node where parent_id = $1 and deleted_at is null
      order by string_to_array(index_number, '.')::int[]`, [room.node['3.5']]);
  const draftVersion = (nodeId: string) => sql<{ id: string }>(
    `select id from document_version where node_id = $1 and withdrawn_at is null order by version_no desc limit 1`, [nodeId]).then((r) => r[0]!.id);

  it('lets admins and publishers remove drafts when frozen', async () => {
    const drafts = (await liveIn35()).filter((n) => n.kind === 'document' && n.state === 'draft');
    expect(drafts.length).toBeGreaterThanOrEqual(2);
    const state = (await sql<{ state: string }>(`select state from workspace where id = $1`, [room.workspaceId]))[0]!.state;
    expect((await call('PATCH', room.person.anika, '/settings', { state: 'frozen' })).statusCode).toBe(200);
    try {
      for (const [person, node] of [[room.person.anika, drafts[0]!], [room.person.johan, drafts[1]!]] as const) {
        const res = await call('POST', person, `/versions/${await draftVersion(node.id)}/remove-draft`, {});
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json().removed).toBe('document');
      }
      // reorder still blocked
      const live = await liveIn35();
      const reorder = await call('PATCH', room.person.anika, `/nodes/${live[live.length - 1]!.id}`, { position: 1, confirmRenumberPublished: true });
      expect([reorder.statusCode, reorder.json().reason]).toEqual([409, 'room_frozen']);
    } finally {
      expect((await call('PATCH', room.person.anika, '/settings', { state })).statusCode).toBe(200);
    }
  });

  it('renumbers documents on reorder', async () => {
    const removed = await sql<{ ix: string }>(`select index_number as ix from node where parent_id = $1 and deleted_at is not null`, [room.node['3.5']]);
    expect(removed.length).toBeGreaterThan(0);
    const before = await liveIn35();
    const last = before[before.length - 1]!;
    const res = await call('PATCH', room.person.anika, `/nodes/${last.id}`, { position: 1, confirmRenumberPublished: true });
    expect(res.statusCode, res.body).toBe(200);
    const after = await liveIn35();
    const prefix = (await sql<{ ix: string }>(`select index_number as ix from node where id = $1`, [room.node['3.5']]))[0]!.ix;
    // folders may have gaps
    const docs = after.filter((n) => n.kind === 'document');
    expect(docs.map((n) => n.index_number)).toEqual(docs.map((_, i) => `${prefix}.${i + 2}`));
    const hedging = before.find((n) => n.kind === 'folder' && n.id !== last.id)!;
    expect(after.find((n) => n.id === hedging.id)!.index_number).toBe(hedging.index_number);
    expect(after[0]!.id).toBe(last.id);
    expect(after[0]!.index_number).toBe(`${prefix}.1`);
    expect(after.some((n) => removed.some((r) => r.ix === n.index_number))).toBe(true);
  });
});
