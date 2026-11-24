// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { enqueueForEvent, sendNotification, type Channel } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { decryptBuffer, encryptBuffer, LocalKeyProvider } from '../src/crypto/envelope.js';
import { DbKeyring } from '../src/crypto/keyring.js';
import { convertStep, GotenbergClient, MemoryStorage, runPipeline } from '../src/pipeline/pipeline.js';
import { rasteriseStep } from '../src/pipeline/rasterise.js';
import { extractTextStep, indexText, parseExtractedText } from '../src/pipeline/extract-text.js';
import { recordDerived } from '../src/pipeline/record.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';


let h: Heron;
let app: FastifyInstance;
let storage: MemoryStorage;
let keyring: DbKeyring;
let clock: Date;
let v1: string;
let v2: string;
let originals: Record<string, Buffer>;

async function makePdf(pages: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) doc.addPage([595, 842]).drawText(text, { x: 50, y: 760, size: 14, font });
  return Buffer.from(await doc.save());
}

async function addVersion(nodeId: string, no: number, pages: string[], visibleTo: string[] = []): Promise<string> {
  const body = await makePdf(pages);
  const { key, version } = await h.app((tx) => keyring.dataKey(tx, h.ws));
  const storageKey = `ws/${h.ws}/originals/${nodeId}-v${no}`;
  await storage.put(storageKey, await encryptBuffer(key, body, storageKey));
  const id = await h.app(async (tx) => (await tx.query<{ id: string }>(
    `insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, key_version, visible_to_group_ids, created_at)
     values (current_tenant_id(), $1, $2, $3, $4, $5, 'application/pdf', $6, $7::uuid[], $8) returning id`,
    [nodeId, no, storageKey, createHash('sha256').update(body).digest('hex'), body.length, version, visibleTo,
      new Date(T.grantsSet.getTime() + no * 60_000).toISOString()])).rows[0]!.id);
  const result = await runPipeline(
    { versionId: id, workspaceId: h.ws, storageKey, filename: `v${no}.pdf`, mime: 'application/pdf' },
    [convertStep(new GotenbergClient('http://127.0.0.1:9')), rasteriseStep, extractTextStep], storage, key);
  expect(result.ok).toBe(true);
  await h.app((tx) => recordDerived(tx, id, result, { keyVersion: version }));
  await h.pg.query(`update document_version set processing_status = 'ready' where id = $1`, [id]);
  const text = result.derived.find((d) => d.kind === 'text')!;
  const extracted = parseExtractedText(await decryptBuffer(key, storage.objects.get(text.storageKey)!, text.storageKey));
  await h.app((tx) => indexText(tx, { workspaceId: h.ws, nodeId, versionId: id, pages: extracted }));
  originals[id] = body;
  return id;
}

async function grantGroup(group: string, node: string, level: number) {
  await h.pg.query(`insert into access_grant (tenant_id, workspace_id, node_id, subject_group_id, level, recorded_at)
    values ($1, $2, $3, $4, $5, $6)`, [h.t1, h.ws, node, group, level, T.grantsSet.toISOString()]);
}

const restrict = (version: string, groups: string[]) =>
  h.pg.query(`update document_version set visible_to_group_ids = $2::uuid[] where id = $1`, [version, groups]);

beforeEach(async () => {
  clock = T.at;
  originals = {};
  h = await heron();
  storage = new MemoryStorage();
  keyring = new DbKeyring(new LocalKeyProvider(randomBytes(32).toString('base64')));
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => clock, storage, keyring });
  for (const g of [h.group.a, h.group.aFin, h.group.b]) await grantGroup(g, h.node.fin, 60);
  await h.pg.query(`update node set published_at = $2 where id = $1`, [h.node.aud1, T.grantsSet.toISOString()]);
  v1 = await addVersion(h.node.aud1, 1, ['Version one revenue Germiston']);
  v2 = await addVersion(h.node.aud1, 2, ['Version two revenue Tarnley', 'Second page'], [h.group.a]);
}, 60_000);
afterEach(async () => {
  await app.close();
  await h.pg.close();
});

const as = (person: string, extra: Record<string, string> = {}) => ({ 'x-dev-person': person, 'x-dev-tenant': h.t1, 'user-agent': 'vitest', ...extra });
const W = () => `/v1/workspaces/${h.ws}`;
const get = (url: string, person: string, extra: Record<string, string> = {}) => app.inject({ method: 'GET', url: `${W()}${url}`, headers: as(person, extra) });
const post = (url: string, person: string, body?: unknown) => app.inject({ method: 'POST', url: `${W()}${url}`, headers: as(person), ...(body ? { payload: body } : {}) });
const listed = async (person: string, parent = h.node.aud, extra: Record<string, string> = {}) =>
  (await get(`/nodes?parent=${parent}`, person, extra)).json().items as any[];
const versionInList = async (person: string, node = h.node.aud1) => (await listed(person)).find((n) => n.id === node)?.version ?? 'absent';
const search = async (person: string, q: string) => (await get(`/search?q=${encodeURIComponent(q)}`, person)).json().items as any[];

describe('version visibility', () => {
  it('should show each bidder their version', async () => {
    expect(await versionInList(h.person.jan)).toMatchObject({ id: v2, number: 2, pageCount: 2 });
    expect(await versionInList(h.person.mei)).toMatchObject({ id: v1, number: 1, pageCount: 1 });
    expect(await versionInList(h.person.lars)).toMatchObject({ id: v2, number: 2 });
    expect((await get(`/nodes/${h.node.aud1}`, h.person.mei)).json().version).toMatchObject({ id: v1, number: 1 });
    expect((await get(`/nodes/${h.node.aud1}`, h.person.jan)).json().version).toMatchObject({ id: v2, number: 2 });
  });

  it('renumbers versions per viewer', async () => {
    const v3 = await addVersion(h.node.aud1, 3, ['Version three'], [h.group.b]);
    expect(await versionInList(h.person.mei)).toMatchObject({ id: v3, number: 2 });
    expect((await get(`/nodes/${h.node.aud1}`, h.person.mei)).json().version).toMatchObject({ id: v3, number: 2 });
    expect(await versionInList(h.person.jan)).toMatchObject({ id: v2, number: 2 });
    expect((await get(`/nodes/${h.node.aud1}`, h.person.anika)).json().version).toMatchObject({ id: v3, number: 3 });
  });

  it('should give each viewer their own details', async () => {
    const v3 = await addVersion(h.node.aud1, 3, ['Version three'], [h.group.b]);
    const mei = (await get(`/nodes/${h.node.aud1}`, h.person.mei)).json();
    expect(mei.version).toMatchObject({ id: v3, number: 2, count: 2, sizeBytes: originals[v3]!.length });
    expect(mei.version.pdfBytes).toBeGreaterThan(0);
    expect(mei.version).not.toHaveProperty('uploadedBy');
    expect(mei.publishedAt).toBe(T.grantsSet.toISOString());
    const anika = (await get(`/nodes/${h.node.aud1}`, h.person.anika)).json();
    expect(anika.version).toMatchObject({ number: 3, count: 3 });
    expect(anika.version).toHaveProperty('uploadedBy');
    expect((await listed(h.person.jan)).find((n) => n.id === h.node.aud1)?.read).toBe(false);
    expect((await post(`/nodes/${h.node.aud1}/open`, h.person.jan)).statusCode).toBe(200);
    expect((await listed(h.person.jan)).find((n) => n.id === h.node.aud1)?.read).toBe(true);
    expect((await listed(h.person.mei)).find((n) => n.id === h.node.aud1)?.read).toBe(false);
  });

  it('serves the visible version', async () => {
    const a = (await post(`/nodes/${h.node.aud1}/open`, h.person.jan)).json();
    expect(a).toMatchObject({ versionId: v2, pageCount: 2 });
    const b = (await post(`/nodes/${h.node.aud1}/open`, h.person.mei)).json();
    expect(b).toMatchObject({ versionId: v1, pageCount: 1 });
    expect((await get(`/nodes/${h.node.aud1}/pages/1?session=${b.sessionId}`, h.person.mei)).statusCode).toBe(200);
    expect((await get(`/nodes/${h.node.aud1}/pages/2?session=${b.sessionId}`, h.person.mei)).statusCode).toBe(404);

    const origB = await get(`/nodes/${h.node.aud1}/download?format=original`, h.person.mei);
    expect(origB.statusCode).toBe(200);
    expect(Buffer.compare(origB.rawPayload, originals[v1]!)).toBe(0);
    const origA = await get(`/nodes/${h.node.aud1}/download?format=original`, h.person.jan);
    expect(Buffer.compare(origA.rawPayload, originals[v2]!)).toBe(0);
    expect((await get(`/nodes/${h.node.aud1}/download?format=pdf`, h.person.mei)).statusCode).toBe(200);

    const events = await h.pg.query<{ data: any }>(
      `select data from event where action = 'document.downloaded' and data->>'person_id' = $1 order by seq`, [h.person.mei]);
    expect(events.rows.map((e) => e.data.version_id)).toEqual([v1, v1]);
  });

  it('searches only the visible version', async () => {
    expect(await search(h.person.mei, 'Tarnley')).toEqual([]);
    const hitB = await search(h.person.mei, 'Germiston');
    expect(hitB).toHaveLength(1);
    expect(hitB[0]).toMatchObject({ nodeId: h.node.aud1, matchedIn: 'content' });
    expect(hitB[0].snippet).toContain('Germiston');
    expect((await search(h.person.jan, 'Tarnley'))[0].snippet).toContain('Tarnley');
    expect(await search(h.person.jan, 'Germiston')).toEqual([]);
  });

  it('returns 404 with no visible version', async () => {
    await addVersion(h.node.tax1, 1, ['Tax clearance Ouma'], [h.group.a]);
    await h.pg.query(`update node set published_at = $2 where id = $1`, [h.node.tax1, T.grantsSet.toISOString()]);
    expect((await listed(h.person.mei, h.node.tax)).map((n) => n.id)).toEqual([]);
    expect((await listed(h.person.jan, h.node.tax)).map((n) => n.id)).toEqual([h.node.tax1]);
    expect((await get(`/nodes/${h.node.tax1}`, h.person.mei)).statusCode).toBe(404);
    expect((await post(`/nodes/${h.node.tax1}/open`, h.person.mei)).statusCode).toBe(404);
    expect((await get(`/nodes/${h.node.tax1}/download?format=original`, h.person.mei)).statusCode).toBe(404);
    expect(await search(h.person.mei, 'Tax clearance')).toEqual([]);
    expect(await search(h.person.mei, 'Ouma')).toEqual([]);
    expect((await search(h.person.jan, 'Ouma'))).toHaveLength(1);

    const dashB = (await get('/dashboard', h.person.mei)).json();
    const newB = dashB.newSinceLastVisit.flatMap((f: any) => f.items.map((i: any) => i.id));
    expect(newB).toContain(h.node.aud1);
    expect(newB).not.toContain(h.node.tax1);
    expect(dashB.myCoverage.total).toBe(1);
    const dashA = (await get('/dashboard', h.person.jan)).json();
    expect(dashA.newSinceLastVisit.flatMap((f: any) => f.items.map((i: any) => i.id))).toContain(h.node.tax1);
    expect(dashA.myCoverage.total).toBe(2);
  });

  it('drops the version on revoke', async () => {
    const m = (await h.pg.query<{ id: string }>(
      `insert into membership (tenant_id, person_id, group_id, recorded_at) values ($1, $2, $3, $4) returning id`,
      [h.t1, h.person.mei, h.group.a, T.setup.toISOString()])).rows[0]!.id;
    expect(await versionInList(h.person.mei)).toMatchObject({ id: v2 });
    clock = new Date(T.at.getTime() + 60_000);
    expect((await post(`/memberships/${m}/revoke`, h.person.anika)).statusCode).toBe(200);
    clock = new Date(T.at.getTime() + 120_000);
    expect(await versionInList(h.person.mei)).toMatchObject({ id: v1 });
    expect((await post(`/nodes/${h.node.aud1}/open`, h.person.mei)).json().versionId).toBe(v1);
    expect(await search(h.person.mei, 'Tarnley')).toEqual([]);
  });

  it('shows admins and uploaders everything', async () => {
    await restrict(v2, [h.group.b]);
    await restrict(v1, [h.group.b]);
    expect(await versionInList(h.person.anika)).toMatchObject({ id: v2 });
    expect(await versionInList(h.person.maria)).toMatchObject({ id: v2 });
    expect((await post(`/nodes/${h.node.aud1}/open`, h.person.anika)).json().versionId).toBe(v2);
    expect(await versionInList(h.person.jan)).toBe('absent');
    const agentView = await listed(h.person.maria, h.node.aud, { 'x-dev-agent-max-level': '60' });
    expect(agentView.find((n) => n.id === h.node.aud1)).toBeUndefined();
  });

  it('stops serving pages once the version is restricted', async () => {
    const s = (await post(`/nodes/${h.node.aud1}/open`, h.person.jan)).json();
    expect(s.versionId).toBe(v2);
    expect((await get(`/nodes/${h.node.aud1}/pages/1?session=${s.sessionId}`, h.person.jan)).statusCode).toBe(200);
    await restrict(v2, [h.group.b]);
    expect((await get(`/nodes/${h.node.aud1}/pages/1?session=${s.sessionId}`, h.person.jan)).statusCode).toBe(404);
    expect((await get(`/nodes/${h.node.aud1}/pages/1?session=${s.sessionId}&size=thumb`, h.person.jan)).statusCode).toBe(404);
    expect((await post(`/nodes/${h.node.aud1}/open`, h.person.jan)).json().versionId).toBe(v1);
  });
});

describe('version notifications', () => {
  const queuedFor = async () => (await h.pg.query<{ person_id: string }>(
    `select distinct n.person_id from notification n join notification_item i on i.notification_id = n.id`)).rows.map((r) => r.person_id).sort();

  it('notifies only groups that see the version', async () => {
    const queued = await h.app((tx) => enqueueForEvent(tx, {
      id: randomUUID(),
      action: 'document.version_published', workspaceId: h.ws, resourceId: h.node.aud1, versionId: v2,
      occurredAt: T.at, actorPersonId: h.person.anika,
    }));
    expect(await queuedFor()).toEqual([h.person.jan, h.person.lars, h.person.maria].sort());
    expect(queued).toBe(3);
    expect((await queuedFor()).includes(h.person.mei)).toBe(false);

    await restrict(v2, [h.group.b]);
    const sent: string[] = [];
    const channel: Channel = { name: 'test', send: async (msg) => { sent.push(msg.personId); return { status: 'accepted' }; } };
    const jans = (await h.pg.query<{ id: string }>(`select id from notification where person_id = $1`, [h.person.jan])).rows[0]!.id;
    const res = await h.app((tx) => sendNotification(tx, jans, channel, new Date(T.at.getTime() + 3_600_000)));
    expect(res).toMatchObject({ status: 'dropped', itemsDropped: 1 });
    const reason = await h.pg.query<{ dropped_reason: string }>(`select dropped_reason from notification_item where notification_id = $1`, [jans]);
    expect(reason.rows[0]!.dropped_reason).toBe('version_not_visible');
    expect(sent).toEqual([]);
  });

  it('should not announce hidden versions', async () => {
    const doc = (await h.pg.query<{ id: string }>(
      `insert into node (tenant_id, workspace_id, parent_id, kind, name, index_number, state)
       values ($1, $2, $3, 'document', 'Pension fund valuation.pdf', '3.2.6', 'draft') returning id`, [h.t1, h.ws, h.node.aud])).rows[0]!.id;
    await addVersion(doc, 1, ['Pension valuation'], [h.group.a]);
    const res = await post('/publish', h.person.anika, { nodeIds: [doc] });
    expect(res.statusCode).toBe(200);
    const who = await queuedFor();
    expect(who).toContain(h.person.jan);
    expect(who).not.toContain(h.person.mei);
  });
});
