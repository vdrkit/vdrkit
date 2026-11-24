// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { effectiveAccess } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { decryptBuffer, LocalKeyProvider } from '../src/crypto/envelope.js';
import { DbKeyring } from '../src/crypto/keyring.js';
import { GotenbergClient, MemoryStorage, type MultipartUploads } from '../src/pipeline/pipeline.js';
import { MemoryQueue, processVersion } from '../src/worker/jobs.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';


let h: Heron;
let app: FastifyInstance;
let storage: MemoryStorage;
let keyring: DbKeyring;
let queue: MemoryQueue;
let clock: Date;

async function start(store: MemoryStorage = new MemoryStorage()) {
  storage = store;
  keyring = new DbKeyring(new LocalKeyProvider(randomBytes(32).toString('base64')));
  queue = new MemoryQueue();
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => clock, storage, keyring, queue });
}

beforeEach(async () => {
  h = await heron();
  clock = T.at;
  await start();
});
afterEach(async () => { await app.close(); await h.pg.close(); });

const W = () => `/v1/workspaces/${h.ws}`;
const later = (m: number) => new Date(T.at.getTime() + m * 60_000);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const headers = (person: string, extra: Record<string, string> = {}) => ({ 'x-dev-person': person, 'x-dev-tenant': h.t1, ...extra });
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, person: string, payload?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: headers(person, extra), ...(payload !== undefined ? { payload } : {}) });
const sendBytes = (url: string, person: string, body: Buffer) =>
  app.inject({ method: 'PUT', url, headers: { ...headers(person), 'content-type': 'application/octet-stream' }, payload: body });

async function pdf(text: string) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText(text, { x: 60, y: 760, size: 14, font });
  return Buffer.from(await doc.save());
}

interface Upload { person: string; path: string; bytes: Buffer; targetFolderId?: string | null; replacesNodeId?: string; plannedNumber?: number; declare?: { size?: number; sha256?: string }; complete?: Record<string, unknown> }

async function upload(u: Upload) {
  const started = await call('POST', `${W()}/upload-sessions`, u.person, {
    ...(u.replacesNodeId ? { replacesNodeId: u.replacesNodeId } : { targetFolderId: u.targetFolderId ?? null }),
    path: u.path, size: u.declare?.size ?? u.bytes.length, sha256: u.declare?.sha256 ?? sha(u.bytes), mime: 'application/pdf',
    ...(u.plannedNumber ? { plannedNumber: u.plannedNumber } : {}),
  });
  if (started.statusCode !== 201) return { started, sent: null, completed: null };
  const s = started.json();
  expect(s.method).toBe('direct');
  const sent = await sendBytes(s.uploadUrl, u.person, u.bytes);
  const completed = await call('POST', `${W()}/upload-sessions/${s.id}/complete`, u.person, u.complete ?? {});
  return { started, sent, completed, sessionId: s.id as string };
}

const nodeRow = (id: string) => h.pg.query<{ name: string; index_number: string; state: string; parent_id: string; kind: string }>(
  `select name, index_number, state, parent_id, kind from node where id = $1`, [id]).then((r) => r.rows[0]!);
const quarantined = () => [...storage.objects.keys()].filter((k) => k.startsWith('quarantine/'));
const events = (action: string) => h.pg.query<{ data: any; resource_id: string }>(`select data, resource_id from event where action = $1`, [action]).then((r) => r.rows);

describe('upload', () => {
  it('stores a dropped file as an encrypted draft', async () => {
    const bytes = await pdf('Facility letter');
    const { started, sent, completed } = await upload({ person: h.person.maria, targetFolderId: h.node.aud, path: 'Bank letters/Facility letter.pdf', bytes });
    expect(started.statusCode).toBe(201);
    expect(sent!.statusCode).toBe(204);
    expect(completed!.statusCode).toBe(200);
    const out = completed!.json();
    expect(out).toMatchObject({ versionNo: 1, indexNumber: '3.2.6.1', awaitingRelease: false });
    expect(out.createdFolders).toEqual([{ id: expect.any(String), indexNumber: '3.2.6', name: 'Bank letters' }]);
    expect(await nodeRow(out.nodeId)).toMatchObject({ name: 'Facility letter.pdf', state: 'draft', kind: 'document', parent_id: out.createdFolders[0].id });
    expect((await nodeRow(out.createdFolders[0].id)).state).toBe('draft');

    const v = (await h.pg.query<{ storage_key: string; sha256: string; size_bytes: string; key_version: number }>(
      `select storage_key, sha256, size_bytes, key_version from document_version where id = $1`, [out.versionId])).rows[0]!;
    expect(v.storage_key).toBe(`ws/${h.ws}/v/${out.versionId}/original`);
    expect([v.sha256, Number(v.size_bytes), v.key_version]).toEqual([sha(bytes), bytes.length, 1]);
    const stored = await storage.get(v.storage_key);
    expect(stored.includes(bytes.subarray(0, 64))).toBe(false);
    const key = await h.app((tx) => keyring.keyFor(tx, h.ws, v.key_version));
    expect((await decryptBuffer(key, stored, v.storage_key)).equals(bytes)).toBe(true);
    expect(quarantined()).toEqual([]);

    expect((await h.app((tx) => effectiveAccess(tx, h.person.jan, out.nodeId, { at: clock }))).level).toBe(0);
    expect((await events('document.uploaded')).map((e) => e.resource_id)).toEqual([out.nodeId]);
    expect((await events('folder.created'))[0]!.data).toMatchObject({ index_number: '3.2.6', via: 'upload' });

    expect(queue.jobs).toEqual([{ name: 'process-version', payload: { tenantId: h.t1, versionId: out.versionId } }]);
    const ctx = { db: h.db, storage, keyring, gotenberg: new GotenbergClient('http://127.0.0.1:9'), dbRole: 'vdrkit_app' as const, now: () => clock };
    expect((await processVersion(ctx, h.t1, out.versionId)).status).toBe('ready');
  });

  it('merges same-named folders', async () => {
    const { completed } = await upload({ person: h.person.maria, targetFolderId: h.node.fin, path: '02 Audited financials/Going concern memo.pdf', bytes: await pdf('memo') });
    const out = completed!.json();
    expect(out.createdFolders).toEqual([]);
    expect(out.indexNumber).toBe('3.2.6');
    expect((await nodeRow(out.nodeId)).parent_id).toBe(h.node.aud);
    const loose = (await upload({ person: h.person.maria, targetFolderId: h.node.fin, path: 'Budget 2027.pdf', bytes: await pdf('budget') })).completed!.json();
    expect(loose.indexNumber).toBe('3.5');
  });

  it('keeps the planned number', async () => {
    const second = (await upload({ person: h.person.maria, targetFolderId: h.node.aud, path: 'Bank letters/b.pdf', bytes: await pdf('b'), plannedNumber: 2 })).completed!.json();
    const third = (await upload({ person: h.person.maria, targetFolderId: h.node.aud, path: 'Bank letters/c.pdf', bytes: await pdf('c'), plannedNumber: 3 })).completed!.json();
    expect([second.indexNumber, third.indexNumber]).toEqual(['3.2.6.2', '3.2.6.3']);
    const taken = (await upload({ person: h.person.maria, targetFolderId: h.node.aud, path: 'Bank letters/d.pdf', bytes: await pdf('d'), plannedNumber: 2 })).completed!.json();
    const plain = (await upload({ person: h.person.maria, targetFolderId: h.node.aud, path: 'Bank letters/e.pdf', bytes: await pdf('e') })).completed!.json();
    expect([taken.indexNumber, plain.indexNumber]).toEqual(['3.2.6.4', '3.2.6.5']);
    const bad = await call('POST', `${W()}/upload-sessions`, h.person.maria, { targetFolderId: h.node.aud, path: 'x.pdf', size: 1, sha256: sha(Buffer.from('x')), plannedNumber: 0 });
    expect(bad.statusCode).toBe(400);
  });

  it('ignores the planned number next to a hidden item', async () => {
    await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.tax, groupId: h.group.contributors, level: 0 }] });
    clock = later(1);
    const free = (await upload({ person: h.person.maria, targetFolderId: h.node.fin, path: 'a.pdf', bytes: await pdf('a'), plannedNumber: 8 })).completed!.json();
    const hidden = (await upload({ person: h.person.maria, targetFolderId: h.node.fin, path: 'b.pdf', bytes: await pdf('b'), plannedNumber: 4 })).completed!.json();
    expect([free.indexNumber, hidden.indexNumber]).toEqual(['3.5', '3.6']);
    const admin = (await upload({ person: h.person.anika, targetFolderId: h.node.fin, path: 'c.pdf', bytes: await pdf('c'), plannedNumber: 9 })).completed!.json();
    expect(admin.indexNumber).toBe('3.9');
  });

  it('records the uploader', async () => {
    const out = (await upload({ person: h.person.maria, targetFolderId: h.node.aud, path: 'Letter.pdf', bytes: await pdf('x') })).completed!.json();
    const p = (await h.pg.query<{ kind: string; person_id: string }>(
      `select p.kind, p.person_id from document_version dv join principal p on p.id = dv.uploaded_by where dv.id = $1`, [out.versionId])).rows[0];
    expect(p).toEqual({ kind: 'person', person_id: h.person.maria });
    await upload({ person: h.person.maria, targetFolderId: h.node.aud, path: 'Letter 2.pdf', bytes: await pdf('y') });
    expect((await h.pg.query(`select 1 from principal where person_id = $1`, [h.person.maria])).rows).toHaveLength(1);
  });

  it('should be idempotent on completion', async () => {
    const r = await upload({ person: h.person.maria, targetFolderId: h.node.aud, path: 'Letter.pdf', bytes: await pdf('x') });
    const again = await call('POST', `${W()}/upload-sessions/${r.sessionId}/complete`, h.person.maria, {});
    expect(again.statusCode).toBe(200);
    expect(again.json().versionId).toBe(r.completed!.json().versionId);
    expect((await h.pg.query(`select 1 from document_version where node_id = $1`, [r.completed!.json().nodeId])).rows).toHaveLength(1);
    expect(queue.jobs).toHaveLength(1);
  });
});

describe('rejections', () => {
  it('refuses a SHA-256 mismatch', async () => {
    const bytes = await pdf('real');
    const { completed, sessionId } = await upload({ person: h.person.maria, targetFolderId: h.node.aud, path: 'Letter.pdf', bytes, declare: { sha256: sha(Buffer.from('other')) } });
    expect([completed!.statusCode, completed!.json().reason]).toEqual([422, 'hash_mismatch']);
    expect((await h.pg.query(`select 1 from node where name = 'Letter.pdf'`)).rows).toEqual([]);
    expect((await h.pg.query<{ status: string }>(`select status from upload_session where id = $1`, [sessionId])).rows[0]!.status).toBe('rejected');
    expect((await events('upload.rejected'))[0]!.data).toMatchObject({ reason: 'hash_mismatch', received_sha256: sha(bytes) });
    expect(quarantined()).toEqual([]);
    expect(queue.jobs).toEqual([]);
    expect((await call('POST', `${W()}/upload-sessions/${sessionId}/complete`, h.person.maria, {})).statusCode).toBe(409);
  });

  it('refuses a size mismatch', async () => {
    const bytes = await pdf('real');
    const { sent } = await upload({ person: h.person.maria, targetFolderId: h.node.aud, path: 'Letter.pdf', bytes, declare: { size: bytes.length + 1 } });
    expect(sent!.statusCode).toBe(400);
    const s = (await call('POST', `${W()}/upload-sessions`, h.person.maria, { targetFolderId: h.node.aud, path: 'Letter.pdf', size: 10, sha256: sha(bytes) })).json();
    await storage.put(`quarantine/${h.ws}/${s.id}`, bytes);
    const res = await call('POST', `${W()}/upload-sessions/${s.id}/complete`, h.person.maria, {});
    expect([res.statusCode, res.json().reason]).toEqual([422, 'size_mismatch']);
    expect((await h.pg.query(`select 1 from document_version`)).rows).toHaveLength(0);
  });

  it('needs the upload right', async () => {
    const bytes = await pdf('x');
    expect((await upload({ person: h.person.maria, targetFolderId: h.node.it, path: 'Diagram.pdf', bytes })).started.statusCode).toBe(404);
    await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.it, groupId: h.group.contributors, level: 20 }] });
    clock = later(1);
    const res = (await upload({ person: h.person.maria, targetFolderId: h.node.it, path: 'Diagram.pdf', bytes })).started;
    expect([res.statusCode, res.json().reason]).toEqual([403, 'no_upload_right']);
    expect((await upload({ person: h.person.maria, path: 'Loose.pdf', bytes })).started.json().reason).toBe('not_room_admin');
    const outsider = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Out', 'out@example.com') returning id`, [h.t1])).rows[0]!.id;
    expect((await upload({ person: outsider, targetFolderId: h.node.aud, path: 'x.pdf', bytes })).started.statusCode).toBe(404);
  });

  it('does not merge into a folder without upload rights', async () => {
    await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.aud, groupId: h.group.contributors, level: 20, canUpload: false }] });
    clock = later(1);
    const { completed } = await upload({ person: h.person.maria, targetFolderId: h.node.fin, path: 'Audited financials/Planted.pdf', bytes: await pdf('x') });
    expect([completed!.statusCode, completed!.json().reason]).toEqual([403, 'no_upload_right']);
    expect(completed!.json().detail).toMatch(/You cannot upload into 3.2 Audited financials/);
    expect((await h.pg.query(`select 1 from node where name = 'Planted.pdf'`)).rows).toHaveLength(0);
  });

  it('ignores numbers in folder names next to hidden items', async () => {
    await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.tax, groupId: h.group.contributors, level: 0 }] });
    clock = later(1);
    const free = (await upload({ person: h.person.maria, targetFolderId: h.node.fin, path: '07 Probe/a.pdf', bytes: await pdf('a') })).completed!.json();
    const taken = (await upload({ person: h.person.maria, targetFolderId: h.node.fin, path: '04 Probe two/b.pdf', bytes: await pdf('b') })).completed!.json();
    expect([free.createdFolders[0].indexNumber, taken.createdFolders[0].indexNumber]).toEqual(['3.5', '3.6']);
    const admin = (await upload({ person: h.person.anika, targetFolderId: h.node.fin, path: '09 Admin/c.pdf', bytes: await pdf('c') })).completed!.json();
    expect(admin.createdFolders[0].indexNumber).toBe('3.9');
  });

  it('rechecks the right on complete', async () => {
    const bytes = await pdf('x');
    const s = (await call('POST', `${W()}/upload-sessions`, h.person.maria, { targetFolderId: h.node.aud, path: 'Letter.pdf', size: bytes.length, sha256: sha(bytes) })).json();
    await sendBytes(s.uploadUrl, h.person.maria, bytes);
    await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.contributors, level: 20 }] });
    clock = later(1);
    const res = await call('POST', `${W()}/upload-sessions/${s.id}/complete`, h.person.maria, {});
    expect([res.statusCode, res.json().reason]).toEqual([403, 'no_upload_right']);
  });

  it('refuses agents', async () => {
    const bytes = await pdf('x');
    const res = await call('POST', `${W()}/upload-sessions`, h.person.anika,
      { targetFolderId: h.node.aud, path: 'Letter.pdf', size: bytes.length, sha256: sha(bytes) }, { 'x-dev-agent-max-level': '60' });
    expect([res.statusCode, res.json().reason]).toEqual([403, 'agent_needs_approval']);
    const s = (await call('POST', `${W()}/upload-sessions`, h.person.anika, { targetFolderId: h.node.aud, path: 'Letter.pdf', size: bytes.length, sha256: sha(bytes) })).json();
    const done = await call('POST', `${W()}/upload-sessions/${s.id}/complete`, h.person.anika, {}, { 'x-dev-agent-max-level': '60' });
    expect(done.json().reason).toBe('agent_needs_approval');
  });

  it("treats another person's session as missing", async () => {
    const bytes = await pdf('x');
    const s = (await call('POST', `${W()}/upload-sessions`, h.person.maria, { targetFolderId: h.node.aud, path: 'Letter.pdf', size: bytes.length, sha256: sha(bytes) })).json();
    expect((await sendBytes(s.uploadUrl, h.person.anika, bytes)).statusCode).toBe(404);
    expect((await call('POST', `${W()}/upload-sessions/${s.id}/complete`, h.person.anika, {})).statusCode).toBe(404);
    expect((await call('DELETE', `${W()}/upload-sessions/${s.id}`, h.person.anika)).statusCode).toBe(404);
  });

  it('refuses frozen rooms and expired sessions', async () => {
    const bytes = await pdf('x');
    const s = (await call('POST', `${W()}/upload-sessions`, h.person.maria, { targetFolderId: h.node.aud, path: 'Letter.pdf', size: bytes.length, sha256: sha(bytes) })).json();
    await sendBytes(s.uploadUrl, h.person.maria, bytes);
    clock = later(25 * 60);
    expect((await call('POST', `${W()}/upload-sessions/${s.id}/complete`, h.person.maria, {})).statusCode).toBe(410);
    await h.pg.query(`update workspace set state = 'frozen' where id = $1`, [h.ws]);
    expect((await upload({ person: h.person.maria, targetFolderId: h.node.aud, path: 'Letter.pdf', bytes })).started.statusCode).toBe(409);
  });

  it('cleans up on cancel', async () => {
    const bytes = await pdf('x');
    const s = (await call('POST', `${W()}/upload-sessions`, h.person.maria, { targetFolderId: h.node.aud, path: 'Letter.pdf', size: bytes.length, sha256: sha(bytes) })).json();
    await sendBytes(s.uploadUrl, h.person.maria, bytes);
    expect(quarantined()).toHaveLength(1);
    expect((await call('DELETE', `${W()}/upload-sessions/${s.id}`, h.person.maria)).statusCode).toBe(204);
    expect(quarantined()).toEqual([]);
    expect((await call('POST', `${W()}/upload-sessions/${s.id}/complete`, h.person.maria, {})).statusCode).toBe(409);
  });
});

describe('new versions', () => {
  it('hides new versions until released', async () => {
    await h.pg.query(`insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime)
      values ($1, $2, 1, 'k', $3, 1, 'application/pdf')`, [h.t1, h.node.aud1, 'a'.repeat(64)]);
    const bytes = await pdf('Restated statements');
    const out = (await upload({ person: h.person.maria, replacesNodeId: h.node.aud1, path: 'FY2025 restated.pdf', bytes })).completed!.json();
    expect(out).toMatchObject({ nodeId: h.node.aud1, versionNo: 2, indexNumber: '3.2.1', awaitingRelease: true, createdFolders: [] });
    const v = (await h.pg.query<{ visible_to_group_ids: string[] }>(`select visible_to_group_ids from document_version where id = $1`, [out.versionId])).rows[0]!;
    expect(v.visible_to_group_ids.sort()).toEqual([h.group.admins, h.group.contributors].sort());
    expect(await nodeRow(h.node.aud1)).toMatchObject({ state: 'published', name: 'Audited financial statements FY2025.pdf' });
    expect((await events('document.version_uploaded'))[0]!.data).toMatchObject({ version_no: 2 });
    await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.a, level: 20 }] });
    clock = later(1);
    const visible = (person: string) => h.app((tx) => tx.query<{ v: string }>(`select visible_version($1, $2, $3) as v`, [person, h.node.aud1, clock.toISOString()]))
      .then((r) => r.rows[0]!.v);
    const v1 = (await h.pg.query<{ id: string }>(`select id from document_version where node_id = $1 and version_no = 1`, [h.node.aud1])).rows[0]!.id;
    expect(await visible(h.person.jan)).toBe(v1);
    expect(await visible(h.person.maria)).toBe(out.versionId);
    expect(queue.jobs[0]!.payload).toEqual({ tenantId: h.t1, versionId: out.versionId });
  });

  it('should refuse a different file type', async () => {
    const out = (await upload({ person: h.person.maria, replacesNodeId: h.node.audDraft, path: 'letter v2.pdf', bytes: await pdf('v2') })).completed!.json();
    expect(out).toMatchObject({ versionNo: 1, awaitingRelease: false });
    const again = (await upload({ person: h.person.maria, replacesNodeId: h.node.audDraft, path: 'letter v3.pdf', bytes: await pdf('v3') })).completed!.json();
    expect(again.versionNo).toBe(2);
    const docx = (await upload({ person: h.person.maria, replacesNodeId: h.node.audDraft, path: 'letter.docx', bytes: Buffer.from('x') })).started;
    expect(docx.statusCode).toBe(400);
    expect((await upload({ person: h.person.maria, replacesNodeId: h.node.aud, path: 'x.pdf', bytes: Buffer.from('x') })).started.statusCode).toBe(400);
  });

  it('can take the new file name', async () => {
    const kept = (await upload({ person: h.person.maria, replacesNodeId: h.node.audDraft, path: 'letter v2.pdf', bytes: await pdf('v2') })).completed!.json();
    expect(kept.versionNo).toBe(1);
    const before = (await nodeRow(h.node.audDraft)).name;
    expect(before).not.toBe('letter v2.pdf');
    const renamed = await upload({ person: h.person.maria, replacesNodeId: h.node.audDraft, path: 'letter v3.pdf', bytes: await pdf('v3'), complete: { useFileName: true } });
    expect(renamed.completed!.statusCode).toBe(200);
    expect((await nodeRow(h.node.audDraft)).name).toBe('letter v3.pdf');
    expect((await events('node.renamed')).some((e) => e.resource_id === h.node.audDraft)).toBe(true);
  });
});

describe('four-eyes publishing', () => {
  it("blocks a publisher's own upload but not a room admin's", async () => {
    await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.contributors, level: 20, canUpload: true, canPublish: true }] });
    expect((await call('PATCH', `${W()}/settings`, h.person.anika, { fourEyesPublish: true })).statusCode).toBe(200);
    clock = later(1);
    const out = (await upload({ person: h.person.maria, targetFolderId: h.node.aud, path: 'Management letter response.pdf', bytes: await pdf('x') })).completed!.json();
    const own = await call('POST', `${W()}/publish`, h.person.maria, { nodeIds: [out.nodeId] });
    expect([own.statusCode, own.json().reason]).toEqual([403, 'four_eyes']);
    expect(own.json().items).toEqual([{ id: out.nodeId, indexNumber: out.indexNumber }]);
    expect((await nodeRow(out.nodeId)).state).toBe('draft');
    const early = await call('POST', `${W()}/publish`, h.person.anika, { nodeIds: [out.nodeId] });
    expect([early.statusCode, early.json().reason]).toEqual([409, 'not_ready']);
    await h.pg.query(`update document_version set processing_status = 'ready' where node_id = $1`, [out.nodeId]);
    const second = await call('POST', `${W()}/publish`, h.person.anika, { nodeIds: [out.nodeId] });
    expect([second.statusCode, second.json().published]).toEqual([200, 1]);
  });
});

// fake S3 multipart with signed part lengths
class MultipartMemoryStorage extends MemoryStorage {
  readonly parts = new Map<string, Map<number, Buffer>>();
  reads = 0;
  readonly multipart: MultipartUploads = {
    start: async (key, partSizes) => {
      const uploadId = `up-${this.parts.size + 1}`;
      this.parts.set(uploadId, new Map());
      return { uploadId, urls: partSizes.map((size, i) => `memory://${key}?uploadId=${uploadId}&partNumber=${i + 1}&length=${size}`) };
    },
    complete: async (key, uploadId, parts) => {
      const got = this.parts.get(uploadId)!;
      await this.put(key, Buffer.concat(parts.sort((a, b) => a.partNumber - b.partNumber).map((p) => {
        if (p.etag !== `"etag-${p.partNumber}"`) throw new Error('ETag mismatch');
        return got.get(p.partNumber)!;
      })));
    },
    abort: async (_key, uploadId) => { this.parts.delete(uploadId); },
  };
  override async get(key: string) {
    this.reads++;
    return super.get(key);
  }
  sendPart(url: string, body: Buffer) {
    const u = new URL(url);
    if (Number(u.searchParams.get('length')) !== body.length) throw new Error('SignatureDoesNotMatch: content-length');
    this.parts.get(u.searchParams.get('uploadId')!)!.set(Number(u.searchParams.get('partNumber')), body);
    return `"etag-${u.searchParams.get('partNumber')}"`;
  }
}

describe('presigned uploads', () => {
  it('hands out part URLs', async () => {
    await app.close();
    const store = new MultipartMemoryStorage();
    await start(store);
    const bytes = await pdf('presigned');
    const s = (await call('POST', `${W()}/upload-sessions`, h.person.maria, { targetFolderId: h.node.aud, path: 'Letter.pdf', size: bytes.length, sha256: sha(bytes) })).json();
    expect(s.method).toBe('presigned');
    expect(s.parts).toHaveLength(1);
    expect((await sendBytes(`${W()}/upload-sessions/${s.id}/content`, h.person.maria, bytes)).statusCode).toBe(400);
    const etag = store.sendPart(s.parts[0].url, bytes);
    expect((await call('POST', `${W()}/upload-sessions/${s.id}/complete`, h.person.maria, { parts: [] })).statusCode).toBe(400);
    const res = await call('POST', `${W()}/upload-sessions/${s.id}/complete`, h.person.maria, { parts: [{ partNumber: 1, etag }] });
    expect(res.statusCode).toBe(200);
    expect(res.json().indexNumber).toBe('3.2.6');
    expect([...store.objects.keys()].filter((k) => k.startsWith('quarantine/'))).toEqual([]);
  });

  it('refuses oversized parts and objects', async () => {
    await app.close();
    const store = new MultipartMemoryStorage();
    await start(store);
    const bytes = await pdf('small');
    const s = (await call('POST', `${W()}/upload-sessions`, h.person.maria, { targetFolderId: h.node.aud, path: 'Letter.pdf', size: bytes.length, sha256: sha(bytes) })).json();
    expect(() => store.sendPart(s.parts[0].url, Buffer.concat([bytes, Buffer.alloc(1024)]))).toThrow(/content-length/);
    const etag = store.sendPart(s.parts[0].url, bytes);
    store.multipart.complete = async (key) => { await store.put(key, Buffer.alloc(bytes.length * 4)); };
    store.reads = 0;
    const res = await call('POST', `${W()}/upload-sessions/${s.id}/complete`, h.person.maria, { parts: [{ partNumber: 1, etag }] });
    expect([res.statusCode, res.json().reason]).toEqual([422, 'size_mismatch']);
    expect(store.reads).toBe(0);
  });
});

describe('frozen rooms', () => {
  it('refuses start and complete', async () => {
    const bytes = await pdf('Facility letter');
    const started = await call('POST', `${W()}/upload-sessions`, h.person.maria, {
      targetFolderId: h.node.aud, path: 'Facility letter.pdf', size: bytes.length, sha256: sha(bytes), mime: 'application/pdf' });
    expect(started.statusCode).toBe(201);
    const s = started.json();
    expect((await sendBytes(s.uploadUrl, h.person.maria, bytes)).statusCode).toBe(204);

    expect((await call('PATCH', `${W()}/settings`, h.person.anika, { state: 'frozen' })).statusCode).toBe(200);
    const refused = { status: 409, reason: 'room_frozen', detail: 'The room is frozen. Nobody can upload until a room admin opens it again in Room settings.' };
    const late = await call('POST', `${W()}/upload-sessions/${s.id}/complete`, h.person.maria, {});
    expect({ status: late.statusCode, reason: late.json().reason, detail: late.json().detail }).toEqual(refused);
    const again = (await upload({ person: h.person.anika, targetFolderId: h.node.aud, path: 'Other.pdf', bytes })).started;
    expect({ status: again.statusCode, reason: again.json().reason, detail: again.json().detail }).toEqual(refused);
    expect((await h.pg.query(`select 1 from node where workspace_id = $1 and name in ('Facility letter.pdf', 'Other.pdf')`, [h.ws])).rows).toHaveLength(0);
  });
});
