// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ListMultipartUploadsCommand } from '@aws-sdk/client-s3';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { LocalKeyProvider } from '../src/crypto/envelope.js';
import { DbKeyring } from '../src/crypto/keyring.js';
import { GotenbergClient, MemoryStorage } from '../src/pipeline/pipeline.js';
import { ClamAvClient } from '../src/pipeline/virus-scan.js';
import { S3Storage } from '../src/storage/s3.js';
import { MemoryQueue, processVersion, type WorkerContext } from '../src/worker/jobs.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';

// Opt-in. Set GOTENBERG_URL, CLAMAV_HOST and CLAMAV_PORT, or S3_TEST_ENDPOINT, S3_TEST_BUCKET,
// S3_TEST_ACCESS_KEY_ID and S3_TEST_SECRET_ACCESS_KEY (S3_TEST_REGION, S3_TEST_CORS_ORIGIN optional).
// The protected Office fixtures use the password "heron".
const GOTENBERG = process.env.GOTENBERG_URL;
const CLAMAV = process.env.CLAMAV_HOST;
const S3 = process.env.S3_TEST_ENDPOINT && process.env.S3_TEST_BUCKET ? process.env.S3_TEST_ENDPOINT : '';

const fixture = (name: string) => readFileSync(resolve(__dirname, 'fixtures/office', name));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
// EICAR, reversed
const eicar = () => Buffer.from('*H+H$!ELIF-TSET-SURIVITNA-DRADNATS-RACIE$}7)CC7)^P(45XZP\\4[PA@%P!O5X'.split('').reverse().join(''));

describe.skipIf(!GOTENBERG || !CLAMAV)('real Gotenberg and ClamAV', () => {
  let h: Heron;
  let app: FastifyInstance;
  let ctx: WorkerContext;
  beforeEach(async () => {
    h = await heron();
    const storage = new MemoryStorage();
    const keyring = new DbKeyring(new LocalKeyProvider(randomBytes(32).toString('base64')));
    app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at, storage, keyring, queue: new MemoryQueue() });
    ctx = { db: h.db, storage, keyring, dbRole: 'vdrkit_app', now: () => T.at, gotenberg: new GotenbergClient(GOTENBERG!),
      clamav: new ClamAvClient(CLAMAV!, Number(process.env.CLAMAV_PORT ?? 3310)) };
  });
  afterEach(async () => { await app.close(); await h.pg.close(); });

  const headers = () => ({ 'x-dev-person': h.person.anika, 'x-dev-tenant': h.t1 });
  const W = () => `/v1/workspaces/${h.ws}`;

  async function runFile(name: string, bytes: Buffer) {
    const s = (await app.inject({ method: 'POST', url: `${W()}/upload-sessions`, headers: headers(),
      payload: { targetFolderId: h.node.aud, path: name, size: bytes.length, sha256: sha(bytes) } })).json();
    expect((await app.inject({ method: 'PUT', url: s.uploadUrl, headers: { ...headers(), 'content-type': 'application/octet-stream' }, payload: bytes })).statusCode).toBe(204);
    const done = (await app.inject({ method: 'POST', url: `${W()}/upload-sessions/${s.id}/complete`, headers: headers(), payload: {} })).json();
    const result = await processVersion(ctx, h.t1, done.versionId);
    const details = (await app.inject({ method: 'GET', url: `${W()}/nodes/${done.nodeId}/details`, headers: headers() })).json();
    const steps = details.versions.find((v: any) => v.id === done.versionId)?.processing.steps;
    return { result, nodeId: done.nodeId as string, versionId: done.versionId as string, steps };
  }
  const text = async (versionId: string) => (await h.pg.query<{ body: string }>(
    `select string_agg(body, ' ' order by page) as body from document_text where version_id = $1`, [versionId])).rows[0]?.body ?? '';

  it.each([
    ['Board memo.docx', 'memo.docx', 'Drosvelt Holdings board memo'],
    ['Accounts.xlsx', 'accounts.xlsx', 'EBITDA'],
    ['Board memo.pptx', 'memo.pptx', null],
  ])('converts %s, scans it clean, renders pages and indexes its text', async (name, file, words) => {
    const r = await runFile(name, fixture(file));
    expect(r.result).toMatchObject({ status: 'ready' });
    expect(r.result.pageCount).toBeGreaterThanOrEqual(1);
    expect(r.steps).toEqual({ received: 'done', virus: 'done', pages: 'done', images: 'done', text: 'done' });
    if (words) expect(await text(r.versionId)).toContain(words);
  });

  it.each([
    ['Protected.docx', 'protected.docx', 'convert', 'The file is password protected, so VDRkit cannot convert it for viewing.'],
    ['Protected.xlsx', 'protected.xlsx', 'convert', 'The file is password protected, so VDRkit cannot convert it for viewing.'],
    ['Protected.pdf', 'protected.pdf', 'rasterise', 'The PDF is password protected, so VDRkit cannot show it in the viewer.'],
  ])('fails %s with a plain reason at the step that met the password', async (name, file, step, reason) => {
    const r = await runFile(name, fixture(file));
    expect(r.result).toMatchObject({ status: 'failed', failedStep: step, error: reason });
  });

  it('flags a damaged file', async () => {
    const r = await runFile('Damaged.docx', fixture('memo.docx').subarray(0, 3000));
    expect(r.result).toMatchObject({ status: 'failed', failedStep: 'convert',
      error: 'The file could not be read: it may be damaged. Open it on your computer, save it again and upload the new copy.' });
    expect(r.steps).toMatchObject({ received: 'done', virus: 'done', pages: 'failed' });
  });

  it('refuses random bytes named .xlsx', async () => {
    const r = await runFile('Cash flow.xlsx', randomBytes(50_000));
    expect(r.result).toMatchObject({ status: 'failed', failedStep: 'convert',
      error: 'This file is not a real Excel workbook. Open it on your computer, save it again and upload the new copy.' });
    expect(r.steps).toMatchObject({ received: 'done', virus: 'done', pages: 'failed' });
  });

  it('should stop EICAR', async () => {
    const r = await runFile('Invoice.docx', eicar());
    expect(r.result).toMatchObject({ status: 'failed', failedStep: 'virus' });
    expect(r.result.error).toMatch(/^The virus scanner found .*EICAR.* in this file\. It is locked/i);
    expect(r.steps).toEqual({ received: 'done', virus: 'failed', pages: 'waiting', images: 'waiting', text: 'waiting' });
    const dl = await app.inject({ method: 'GET', url: `${W()}/nodes/${r.nodeId}/download?format=original`, headers: headers() });
    expect([dl.statusCode, dl.json().reason]).toEqual([409, 'virus_found']);
    const ev = (await h.pg.query<{ data: any }>(`select data from event where action = 'document.processing_failed'`)).rows[0]!.data;
    expect(ev).toMatchObject({ failed_step: 'virus', virus_scan: 'infected' });
  });

  it('scans clean and EICAR files', async () => {
    expect(await ctx.clamav!.scan(Readable.from([fixture('memo.docx')]))).toEqual({ status: 'clean' });
    const r = await ctx.clamav!.scan(Readable.from([eicar()]));
    expect(r.status).toBe('infected');
    expect((r as { signature: string }).signature).toMatch(/EICAR/i);
  });
});

describe.skipIf(!S3)('real S3 storage', () => {
  const store = () => new S3Storage({ endpoint: S3, region: process.env.S3_TEST_REGION ?? 'us-east-1', bucket: process.env.S3_TEST_BUCKET!, forcePathStyle: true,
    accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY! });
  const prefix = `test/${randomBytes(4).toString('hex')}`;
  const collect = async (s: Readable) => { const out: Buffer[] = []; for await (const c of s) out.push(c as Buffer); return Buffer.concat(out); };

  it('streams a multipart upload and reads ranges', async () => {
    const s3 = store();
    const data = randomBytes(40 * 1024 * 1024 + 11);
    await s3.putStream(`${prefix}/big`, Readable.from((function* () { for (let i = 0; i < data.length; i += 1024 * 1024) yield data.subarray(i, i + 1024 * 1024); })()));
    expect(await s3.size(`${prefix}/big`)).toBe(data.length);
    expect(sha(await collect(await s3.getStream(`${prefix}/big`, { start: 17 * 1024 * 1024 - 5, end: 33 * 1024 * 1024 })))).toBe(
      sha(data.subarray(17 * 1024 * 1024 - 5, 33 * 1024 * 1024 + 1)));
    await s3.delete(`${prefix}/big`);
  });

  it('aborts a failed streamed upload', async () => {
    const s3 = store();
    let sent = 0;
    const failing = new Readable({ read() { if (sent++ < 20) this.push(randomBytes(1024 * 1024)); else this.destroy(new Error('connection reset')); } });
    await expect(s3.putStream(`${prefix}/broken`, failing)).rejects.toThrow('connection reset');
    expect(await s3.size(`${prefix}/broken`)).toBeNull();
    const open = await s3.client.send(new ListMultipartUploadsCommand({ Bucket: s3.bucket, Prefix: `${prefix}/` }));
    expect(open.Uploads ?? []).toEqual([]);
  });

  it('resumes presigned uploads', async () => {
    const s3 = store();
    const key = `quarantine/${prefix}/upload`;
    const part = 5 * 1024 * 1024;
    const data = randomBytes(part + 100);
    const { uploadId, urls } = await s3.multipart.start(key, [part, 100], 600);
    const origin = process.env.S3_TEST_CORS_ORIGIN;
    const first = await fetch(urls[0]!, { method: 'PUT', body: data.subarray(0, part), headers: origin ? { origin } : {} });
    expect(first.status).toBe(200);
    if (origin) {
      // ETag must be exposed to the origin
      expect(first.headers.get('access-control-allow-origin')).toBe(origin);
      expect((first.headers.get('access-control-expose-headers') ?? '').toLowerCase()).toContain('etag');
    }
    const held = await s3.multipart.listParts!(key, uploadId);
    expect(held).toEqual([{ partNumber: 1, etag: first.headers.get('etag'), size: part }]);
    const fresh = await s3.multipart.presignPart!(key, uploadId, 2, 100, 600);
    // the length is signed
    expect((await fetch(fresh, { method: 'PUT', body: data.subarray(part) .subarray(0, 50) })).ok).toBe(false);
    const second = await fetch(fresh, { method: 'PUT', body: data.subarray(part) });
    expect(second.status).toBe(200);
    await s3.multipart.complete(key, uploadId, [{ partNumber: 1, etag: held[0]!.etag }, { partNumber: 2, etag: second.headers.get('etag')! }]);
    expect(sha(await s3.get(key))).toBe(sha(data));
    await s3.delete(key);
  });

  it('leaves no parts behind after abort', async () => {
    const s3 = store();
    const key = `quarantine/${prefix}/cancelled`;
    const { uploadId, urls } = await s3.multipart.start(key, [5 * 1024 * 1024], 600);
    expect((await fetch(urls[0]!, { method: 'PUT', body: randomBytes(5 * 1024 * 1024) })).status).toBe(200);
    await s3.multipart.abort(key, uploadId);
    const open = await s3.client.send(new ListMultipartUploadsCommand({ Bucket: s3.bucket, Prefix: `quarantine/${prefix}/` }));
    expect(open.Uploads ?? []).toEqual([]);
  });
});
