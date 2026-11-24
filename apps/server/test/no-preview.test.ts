// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deflateRawSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { verifyChain } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { decryptBuffer, encryptBuffer, LocalKeyProvider } from '../src/crypto/envelope.js';
import { DbKeyring } from '../src/crypto/keyring.js';
import { notAnImage, picturePdf, readPicture } from '../src/pipeline/image.js';
import { GotenbergClient, MemoryStorage, ServiceUnavailable } from '../src/pipeline/pipeline.js';
import { InlineQueue, type JobFailure } from '../src/worker/inline-queue.js';
import { PENDING_REASON, PENDING_STUCK_AFTER_MS, processVersion, STUCK_AFTER_MS, STUCK_REASON, sweepStuckProcessing, type WorkerContext } from '../src/worker/jobs.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';


let server: Server;
let gotenbergUrl: string;
let answer: 'error' | 'pdf' = 'error';
let converterCalls = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    converterCalls++;
    req.resume();
    req.on('end', () => (answer === 'error' ? res.writeHead(500).end('LibreOffice crashed') : res.writeHead(200).end('%PDF-1.4 nonsense')));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  gotenbergUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

let h: Heron;
let ctx: WorkerContext;
let storage: MemoryStorage;
let keyring: DbKeyring;
let clock: Date;
let app: FastifyInstance;

beforeEach(async () => {
  h = await heron();
  storage = new MemoryStorage();
  keyring = new DbKeyring(new LocalKeyProvider(randomBytes(32).toString('base64')));
  clock = T.at;
  answer = 'error';
  converterCalls = 0;
  ctx = { db: h.db, storage, keyring, gotenberg: new GotenbergClient(gotenbergUrl), dbRole: 'vdrkit_app', now: () => clock };
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => clock, storage, keyring });
});
afterEach(async () => { await app.close(); await h.pg.close(); });

const svg = (w: number, hgt: number) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hgt}"><rect width="${w}" height="${hgt}" fill="#2a6"/><circle cx="${w / 2}" cy="${hgt / 2}" r="${Math.min(w, hgt) / 3}" fill="#fa3"/></svg>`);
const png = (w = 800, hgt = 600) => sharp(svg(w, hgt)).png().toBuffer();
const jpeg = (w = 800, hgt = 600) => sharp(svg(w, hgt)).jpeg().toBuffer();

function bmp(w: number, hgt: number): Buffer {
  const row = Math.ceil((w * 3) / 4) * 4;
  const b = Buffer.alloc(54 + row * hgt);
  b.write('BM', 0, 'latin1');
  b.writeUInt32LE(b.length, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(w, 18);
  b.writeInt32LE(hgt, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(row * hgt, 34);
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) b.set([200, 100, 50], 54 + y * row + x * 3);
  return b;
}

function crc32(b: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of b) {
    let c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: [string, string][]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const n = Buffer.from(name);
    const data = Buffer.from(text);
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(8, 8); l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(packed.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(n.length, 26);
    locals.push(l, n, packed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(packed.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    centrals.push(c, n);
    offset += 30 + n.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const threeMf = () => zip([
  ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'],
  ['3D/3dmodel.model', '<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>'],
]);

async function upload(nodeId: string, filename: string, bytes: Buffer): Promise<string> {
  await h.pg.query(`update node set name = $2 where id = $1`, [nodeId, filename]);
  const principal = (await h.pg.query<{ id: string }>(
    `insert into principal (tenant_id, kind, person_id, name) values ($1, 'person', $2, 'anika') returning id`, [h.t1, h.person.anika])).rows[0]!.id;
  return h.app(async (tx) => {
    const { key, version } = await keyring.dataKey(tx, h.ws);
    const storageKey = `ws/${h.ws}/originals/${nodeId}/${randomBytes(4).toString('hex')}`;
    await storage.put(storageKey, await encryptBuffer(key, bytes, storageKey));
    return (await tx.query<{ id: string }>(
      `insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, key_version, uploaded_by)
       values (current_tenant_id(), $1, 1, $2, $3, $4, 'application/octet-stream', $5, $6) returning id`,
      [nodeId, storageKey, createHash('sha256').update(bytes).digest('hex'), bytes.length, version, principal])).rows[0]!.id;
  });
}

const kinds = async (v: string) => (await h.pg.query<{ kind: string; step: string; n: number }>(
  `select kind, step, count(*)::int n from derived_file where version_id = $1 group by kind, step order by kind`, [v])).rows;
const versionRow = async (v: string) => (await h.pg.query<any>(
  `select processing_status, processing_error, failed_step, page_count, metadata ->> 'previewSkipped' as preview_skipped from document_version where id = $1`, [v])).rows[0];

const as = (person: string) => ({ 'x-dev-person': person, 'x-dev-tenant': h.t1, 'user-agent': 'vitest' });
const W = () => `/v1/workspaces/${h.ws}`;
const call = (method: 'GET' | 'POST' | 'PUT', url: string, person: string, payload?: unknown) =>
  app.inject({ method, url: `${W()}${url}`, headers: as(person), ...(payload !== undefined ? { payload } : {}) });

describe('file types', () => {
  it('renders a PNG as one page', async () => {
    const v = await upload(h.node.aud1, 'Site photo.png', await png());
    expect(await processVersion(ctx, h.t1, v)).toEqual({ status: 'ready', pageCount: 1 });
    expect(await kinds(v)).toEqual([
      { kind: 'page_image', step: 'rasterise', n: 1 }, { kind: 'pdf', step: 'image', n: 1 },
      { kind: 'text', step: 'extract', n: 1 }, { kind: 'thumbnail', step: 'rasterise', n: 1 },
    ]);
    expect(await versionRow(v)).toMatchObject({ processing_status: 'ready', page_count: 1, preview_skipped: null });
    expect(converterCalls).toBe(0);
    const ev = (await h.pg.query<any>(`select data from event where action = 'document.processed'`)).rows[0].data;
    expect(ev.steps).toEqual(['hash', 'virus', 'convert', 'image', 'rasterise', 'extract', 'preview']);
    // 800 x 600 px is 600 x 450 pt
    const f = (await h.pg.query<{ storage_key: string }>(`select storage_key from derived_file where version_id = $1 and kind = 'pdf'`, [v])).rows[0]!;
    const key = await h.app((tx) => keyring.keyFor(tx, h.ws, null));
    const doc = await PDFDocument.load(await decryptBuffer(key, await storage.get(f.storage_key), f.storage_key));
    expect(doc.getPages().map((p) => p.getSize())).toEqual([{ width: 600, height: 450 }]);
  });

  it('applies EXIF orientation', async () => {
    const turned = await sharp(await jpeg(200, 100)).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const v = await upload(h.node.aud1, 'Phone photo.JPEG', turned);
    expect(await processVersion(ctx, h.t1, v)).toEqual({ status: 'ready', pageCount: 1 });
    expect(await readPicture(turned, 'jpeg')).toMatchObject({ kind: 'png', width: 100, height: 200 });
    const plain = await jpeg(200, 100);
    expect(await readPicture(plain, 'jpg')).toMatchObject({ kind: 'jpg', width: 200, height: 100, bytes: plain });
    // pooled Buffer with a non-zero offset
    const pooled = Buffer.from((await sharp(svg(120, 80)).jpeg({ quality: 60 }).toBuffer()).toString('base64'), 'base64');
    expect(pooled.byteOffset).toBeGreaterThan(0);
    expect((await picturePdf(await readPicture(pooled, 'jpg'))).pages).toBe(1);
  });

  it('reads BMP and splits long images', async () => {
    expect(await readPicture(bmp(6, 4), 'bmp')).toMatchObject({ kind: 'png', width: 6, height: 4 });
    const tall = await readPicture(await png(100, 500), 'png');
    const { pdf, pages } = await picturePdf(tall);
    expect(pages).toBe(4);
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(4);
  });

  it('marks .3mf as ready without preview', async () => {
    const v = await upload(h.node.aud1, 'Bracket v3.3mf', threeMf());
    expect(await processVersion(ctx, h.t1, v)).toEqual({ status: 'ready', pageCount: null });
    expect(await kinds(v)).toEqual([]);
    expect(await versionRow(v)).toMatchObject({ processing_status: 'ready', page_count: null, preview_skipped: 'file_type', failed_step: null });
    expect(converterCalls).toBe(0);
    expect((await h.pg.query(`select 1 from event where action = 'document.processed'`)).rows).toHaveLength(1);
    expect(await h.app((tx) => verifyChain(tx, h.ws))).toMatchObject({ firstBroken: null });
  });

  it('fails renamed fake files', async () => {
    const v = await upload(h.node.aud1, 'Not a photo.png', Buffer.from('just some text, not an image'));
    expect(await processVersion(ctx, h.t1, v)).toEqual({ status: 'failed', pageCount: null, failedStep: 'image', error: notAnImage('png') });
    expect(notAnImage('png')).toBe('This file is not a real PNG image, or it is damaged. Open it on your computer, save it again and upload the new copy.');
    const d = await upload(h.node.tax1, 'Contract.docx', randomBytes(2000));
    expect(await processVersion(ctx, h.t1, d)).toMatchObject({ status: 'failed', failedStep: 'convert',
      error: 'This file is not a real Word document. Open it on your computer, save it again and upload the new copy.' });
    const z = await upload(h.node.audDraft, 'Scan export.xyz', randomBytes(500));
    expect(await processVersion(ctx, h.t1, z)).toEqual({ status: 'ready', pageCount: null });
    expect(converterCalls).toBe(0);
  });

  it('fails converter errors with a reason', async () => {
    const v = await upload(h.node.aud1, 'Notes.txt', Buffer.from('Board notes'));
    expect(await processVersion(ctx, h.t1, v)).toMatchObject({ status: 'failed', failedStep: 'convert', error: 'Conversion to PDF failed (500). The file may be damaged or of a kind the converter cannot read. Save it again on your computer, or upload it as a PDF.' });
    expect((await versionRow(v)).processing_status).toBe('failed');
  });
});

describe('stuck processing', () => {
  it('fails versions whose worker went silent', async () => {
    ctx = { ...ctx, gotenberg: new GotenbergClient('http://127.0.0.1:9') };
    const v = await upload(h.node.aud1, 'Notes.txt', Buffer.from('Board notes'));
    await expect(processVersion(ctx, h.t1, v)).rejects.toBeInstanceOf(ServiceUnavailable);
    expect((await versionRow(v)).processing_status).toBe('processing');
    const started = clock;

    clock = new Date(started.getTime() + STUCK_AFTER_MS - 60_000);
    expect(await sweepStuckProcessing(ctx)).toEqual({ failed: 0 });
    clock = new Date(started.getTime() + STUCK_AFTER_MS + 60_000);
    expect(await sweepStuckProcessing(ctx)).toEqual({ failed: 1 });
    expect(await versionRow(v)).toMatchObject({ processing_status: 'failed', failed_step: 'worker', processing_error: STUCK_REASON });
    expect(STUCK_REASON).toBe('VDRkit stopped processing this file because the worker stopped more than once while working on it. Ask your administrator to check the worker, then choose Process again.');
    const ev = (await h.pg.query<any>(`select data from event where action = 'document.processing_failed'`)).rows.map((r) => r.data);
    expect(ev).toEqual([{ version_id: v, failed_step: 'worker', error: STUCK_REASON, stuck: true }]);
    expect(await sweepStuckProcessing(ctx)).toEqual({ failed: 0 });

    const dash = await call('GET', '/dashboard', h.person.anika);
    expect(dash.statusCode).toBe(200);
    expect(dash.json().toDo.failedProcessing).toEqual([expect.objectContaining({ nodeId: h.node.aud1, error: STUCK_REASON })]);
  });

  it('leaves recent and ready versions alone', async () => {
    const recent = await upload(h.node.aud1, 'Photo.png', await png());
    await h.pg.query(`update document_version set processing_status = 'processing', processing_started_at = $2 where id = $1`,
      [recent, new Date(clock.getTime() - 5 * 60_000).toISOString()]);
    const pending = await upload(h.node.tax1, 'Waiting.png', await png());
    expect(await sweepStuckProcessing(ctx)).toEqual({ failed: 0 });
    clock = new Date(clock.getTime() + 2 * 86_400_000);
    expect(await sweepStuckProcessing(ctx)).toEqual({ failed: 2 });
    clock = T.at;
    expect(await versionRow(pending)).toMatchObject({ processing_status: 'failed', failed_step: 'worker', processing_error: PENDING_REASON });

    expect((await versionRow(recent)).processing_status).toBe('failed');
    expect(await processVersion(ctx, h.t1, recent)).toEqual({ status: 'ready', pageCount: 1 });
    expect(await versionRow(recent)).toMatchObject({ processing_status: 'ready', processing_error: null, failed_step: null });
  });

  it('finds stuck versions through tenants_with_stuck_processing', async () => {
    const v = await upload(h.node.aud1, 'Photo.png', await png());
    await h.pg.query(`update document_version set processing_status = 'processing', processing_started_at = $2 where id = $1`, [v, '2026-01-01T00:00:00Z']);
    const seen = await h.db.transaction(async (tx) => {
      await tx.query('set local role vdrkit_app');
      const direct = (await tx.query(`select 1 from document_version`)).rows.length;
      const tenants = (await tx.query<{ t: string }>(`select t from tenants_with_stuck_processing($1) t`, [clock.toISOString()])).rows.map((r) => r.t);
      const after = (await tx.query(`select 1 from document_version`)).rows.length;
      return { direct, tenants, after };
    });
    expect(seen).toEqual({ direct: 0, tenants: [h.t1], after: 0 });
  });
});

describe('dev queue', () => {
  it('skips a hanging job', async () => {
    const ran: string[] = [];
    const failures: [string, JobFailure['kind']][] = [];
    const q = new InlineQueue({
      timeoutMs: 50,
      async run(_name, payload) {
        if (payload.versionId === 'hangs') await new Promise(() => undefined);
        if (payload.versionId === 'throws') throw new Error('converter down');
        ran.push(String(payload.versionId));
      },
      async onFailure(_name, payload, failure) { failures.push([String(payload.versionId), failure.kind]); },
    });
    for (const id of ['first', 'hangs', 'throws', 'last']) await q.enqueue('process-version', { tenantId: h.t1, versionId: id });
    await q.idle();
    expect(ran).toEqual(['first', 'last']);
    expect(failures).toEqual([['hangs', 'timeout'], ['throws', 'error']]);
  });
});

describe('files without preview', () => {
  async function ready3mf(): Promise<string> {
    const v = await upload(h.node.aud1, 'Bracket v3.3mf', threeMf());
    await processVersion(ctx, h.t1, v);
    return v;
  }
  const grant = (group: string, level: number) => h.pg.query(
    `insert into access_grant (tenant_id, workspace_id, node_id, subject_group_id, level, recorded_at) values ($1, $2, $3, $4, $5, $6)`,
    [h.t1, h.ws, h.node.fin, group, level, T.grantsSet.toISOString()]);

  it('lists the file as ready', async () => {
    await ready3mf();
    const res = await call('GET', `/nodes?parent=${h.node.aud}`, h.person.anika);
    const item = res.json().items.find((i: any) => i.id === h.node.aud1);
    expect(item.version).toMatchObject({ status: 'ready', pageCount: null, noPreview: 'file_type' });
    const details = (await call('GET', `/nodes/${h.node.aud1}/details`, h.person.anika)).json();
    expect(details.versions[0].processing).toMatchObject({ status: 'ready', noPreview: 'file_type',
      steps: { received: 'done', virus: 'skipped', pages: 'skipped', images: 'skipped', text: 'skipped' } });
  });

  it('downloads the original at level 60', async () => {
    await ready3mf();
    await grant(h.group.a, 60);
    await grant(h.group.b, 50);
    const open = await call('POST', `/nodes/${h.node.aud1}/open`, h.person.jan);
    expect(open.statusCode).toBe(409);
    expect(open.json()).toMatchObject({ reason: 'no_preview', noPreview: 'file_type',
      detail: '3MF files cannot be shown in the browser. Download the file to open it on your computer.' });
    expect((await h.pg.query(`select 1 from view_session`)).rows).toHaveLength(0);

    const orig = await call('GET', `/nodes/${h.node.aud1}/download?format=original`, h.person.jan);
    expect(orig.statusCode).toBe(200);
    expect(orig.rawPayload.equals(threeMf())).toBe(true);
    const logged = (await h.pg.query<any>(`select data from event where action = 'document.downloaded'`)).rows.map((r) => r.data);
    expect(logged).toEqual([expect.objectContaining({ format: 'original', person_id: h.person.jan })]);

    const pdf = await call('GET', `/nodes/${h.node.aud1}/download?format=pdf`, h.person.mei);
    expect(pdf.statusCode).toBe(409);
    expect(pdf.json()).toMatchObject({ reason: 'no_preview',
      detail: 'This file has no PDF copy, because it cannot be shown in the browser. Only people allowed to download original files can download it.' });
    expect((await call('GET', `/nodes/${h.node.aud1}/download?format=original`, h.person.mei)).statusCode).toBe(403);
  });

  it('explains the preview limit', async () => {
    const v = await ready3mf();
    await h.pg.query(`update document_version set metadata = metadata || '{"previewSkipped": "too_large"}' where id = $1`, [v]);
    const open = await call('POST', `/nodes/${h.node.aud1}/open`, h.person.anika);
    expect(open.json()).toMatchObject({ reason: 'no_preview', noPreview: 'too_large',
      detail: 'This file is too large to show in the browser. Download the file to open it on your computer.' });
  });

  it('publishes from Release review', async () => {
    const v = await upload(h.node.audDraft, 'Bracket v3.3mf', threeMf());
    await processVersion(ctx, h.t1, v);
    const review = (await call('GET', '/release-review', h.person.anika)).json();
    expect(review.items.find((i: any) => i.id === h.node.audDraft)).toMatchObject({ blocked: null, noPreview: 'file_type', downloadOnly: false });
    const res = await call('POST', '/publish', h.person.anika, { nodeIds: [h.node.audDraft] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ published: 1 });
  });

  it('publishes a failed file only on admin confirmation', async () => {
    const v = await upload(h.node.audDraft, 'Not a photo.png', Buffer.from('text'));
    await processVersion(ctx, h.t1, v);
    const item = (await call('GET', '/release-review', h.person.anika)).json().items.find((i: any) => i.id === h.node.audDraft);
    expect(item).toMatchObject({ blocked: 'failed', downloadOnly: true });

    const refused = await call('POST', '/publish', h.person.anika, { nodeIds: [h.node.audDraft] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().detail).toBe("3.2.5 Not a photo.png could not be prepared for viewing, so it cannot be released. Upload a new copy first.");

    // publisher is not an admin
    const right = await call('PUT', '/grants', h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.contributors, level: 20, canUpload: true, canPublish: true }] });
    expect(right.statusCode).toBe(200);
    const contributor = await call('POST', '/publish', h.person.maria, { nodeIds: [h.node.audDraft], downloadOnly: true });
    expect(contributor.statusCode).toBe(409);

    const ok = await call('POST', '/publish', h.person.anika, { nodeIds: [h.node.audDraft], downloadOnly: true });
    expect(ok.statusCode).toBe(200);
    const ev = (await h.pg.query<any>(`select data from event where action = 'document.published' and resource_id = $1`, [h.node.audDraft])).rows[0].data;
    expect(ev).toMatchObject({ download_only: true });
    await grant(h.group.a, 60);
    expect((await call('POST', `/nodes/${h.node.audDraft}/open`, h.person.jan)).json()).toMatchObject({ reason: 'no_preview', noPreview: 'failed' });
    expect((await call('GET', `/nodes/${h.node.audDraft}/download?format=original`, h.person.jan)).statusCode).toBe(200);
  });

  it('never offers infected or unscanned originals', async () => {
    const v = await upload(h.node.audDraft, 'Invoice.png', await png());
    await h.pg.query(`update document_version set processing_status = 'failed', failed_step = 'virus', metadata = '{"virusScan": "infected"}' where id = $1`, [v]);
    expect((await call('GET', '/release-review', h.person.anika)).json().items.find((i: any) => i.id === h.node.audDraft)).toMatchObject({ downloadOnly: false });
    expect((await call('POST', '/publish', h.person.anika, { nodeIds: [h.node.audDraft], downloadOnly: true })).statusCode).toBe(409);
    await h.pg.query(`update document_version set failed_step = 'worker', metadata = '{}' where id = $1`, [v]);
    expect((await call('GET', '/release-review', h.person.anika)).json().items.find((i: any) => i.id === h.node.audDraft)).toMatchObject({ downloadOnly: false });
    expect((await call('POST', '/publish', h.person.anika, { nodeIds: [h.node.audDraft], downloadOnly: true })).statusCode).toBe(409);
  });
});
