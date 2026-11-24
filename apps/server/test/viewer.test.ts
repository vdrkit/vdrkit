// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as mupdf from 'mupdf';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';
import { verifyChain } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { decryptBuffer, encryptBuffer, LocalKeyProvider } from '../src/crypto/envelope.js';
import { DbKeyring } from '../src/crypto/keyring.js';
import { convertStep, GotenbergClient, MemoryStorage, runPipeline } from '../src/pipeline/pipeline.js';
import { PAGE_WIDTH, pageImageType, rasteriseStep, THUMB_WIDTH } from '../src/pipeline/rasterise.js';
import { recordDerived } from '../src/pipeline/record.js';
import { attachment, viewerRoutes } from '../src/routes/viewer.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';

let h: Heron;
let app: FastifyInstance;
let storage: MemoryStorage;
let keyring: DbKeyring;
let original: Buffer;
let versionId: string;
let cleanPage1Key: string;

async function makePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const n of [1, 2]) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Drosvelt Holdings audited financial statements FY2025, page ${n}`, { x: 50, y: 780, size: 14, font });
    page.drawText('Revenue R 412.6 million', { x: 50, y: 740, size: 12, font });
  }
  return Buffer.from(await doc.save());
}

async function seedDocument() {
  original = await makePdf();
  const { key, version } = await h.app((tx) => keyring.dataKey(tx, h.ws));
  const storageKey = `ws/${h.ws}/originals/aud1-v1`;
  await storage.put(storageKey, await encryptBuffer(key, original, storageKey));
  versionId = await h.app(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, key_version, processing_status)
       values (current_tenant_id(), $1, 1, $2, $3, $4, 'application/pdf', $5, 'ready') returning id`,
      [h.node.aud1, storageKey, createHash('sha256').update(original).digest('hex'), original.length, version]);
    return rows[0]!.id;
  });
  const result = await runPipeline(
    { versionId, workspaceId: h.ws, storageKey, filename: 'Audited financial statements FY2025.pdf', mime: 'application/pdf' },
    [convertStep(new GotenbergClient('http://127.0.0.1:9')), rasteriseStep], storage, key);
  expect(result).toMatchObject({ ok: true, completedSteps: ['convert', 'rasterise'], facts: { pageCount: 2 } });
  await h.app((tx) => recordDerived(tx, versionId, result, { keyVersion: version }));
  cleanPage1Key = result.derived.find((d) => d.kind === 'page_image' && d.meta?.page === 1)!.storageKey;
}

async function grantGroup(group: string, level: number) {
  await h.pg.query(`insert into access_grant (tenant_id, workspace_id, node_id, subject_group_id, level, recorded_at)
    values ($1, $2, $3, $4, $5, $6)`, [h.t1, h.ws, h.node.fin, group, level, T.grantsSet.toISOString()]);
}

let clock: Date;

beforeEach(async () => {
  clock = T.at;
  h = await heron();
  storage = new MemoryStorage();
  keyring = new DbKeyring(new LocalKeyProvider(randomBytes(32).toString('base64')));
  app = await buildApp({
    db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => clock,
    storage, keyring,
  });
  await seedDocument();
});
afterEach(async () => {
  await app.close();
  await h.pg.close();
});

const as = (person: string, extra: Record<string, string> = {}) => ({ 'x-dev-person': person, 'x-dev-tenant': h.t1, 'user-agent': 'vitest', ...extra });
const base = () => `/v1/workspaces/${h.ws}/nodes`;
const open = (person: string, node = h.node.aud1, extra: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: `${base()}/${node}/open`, headers: as(person, extra) });
const page = (person: string, session: string, n: number, size = 'full', node = h.node.aud1, extra: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: `${base()}/${node}/pages/${n}?session=${session}&size=${size}`, headers: as(person, extra) });
const download = (person: string, format: string, node = h.node.aud1, extra: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: `${base()}/${node}/download?format=${format}`, headers: as(person, extra) });
const MISSING = '00000000-0000-4000-8000-000000000000';

const meanLuminance = async (img: Buffer) => {
  const s = await sharp(img).removeAlpha().stats();
  return s.channels.reduce((a, c) => a + c.mean, 0) / s.channels.length;
};

describe('pipeline outputs', () => {
  it('records encrypted page images and thumbnails', async () => {
    const rows = await h.app((tx) => tx.query<{ kind: string; page: number; width: number; key_version: number }>(
      `select kind, (metadata->>'page')::int as page, (metadata->>'width')::int as width, key_version
         from derived_file where version_id = $1 order by kind, page`, [versionId]));
    expect(rows.rows).toEqual([
      { kind: 'page_image', page: 1, width: PAGE_WIDTH, key_version: 1 },
      { kind: 'page_image', page: 2, width: PAGE_WIDTH, key_version: 1 },
      { kind: 'pdf', page: null, width: null, key_version: 1 },
      { kind: 'thumbnail', page: 1, width: THUMB_WIDTH, key_version: 1 },
      { kind: 'thumbnail', page: 2, width: THUMB_WIDTH, key_version: 1 },
    ]);
    expect(storage.objects.get(cleanPage1Key)!.subarray(0, 5).toString()).toBe('VDRK1');
  });
});

describe('page image types', () => {
  it('detects WebP', () => {
    expect(pageImageType('ws/1/v/2/rasterise/page_image-1.webp')).toBe('image/webp');
    expect(pageImageType('ws/1/v/2/rasterise/page_image-1', 'image/webp')).toBe('image/webp');
    expect(pageImageType('ws/1/v/2/rasterise/page_image-1')).toBe('image/png');
    expect(pageImageType('ws/1/v/2/rasterise/page_image-1', null)).toBe('image/png');
  });
});

describe('viewer', () => {
  it('opens a document and reports coverage', async () => {
    await grantGroup(h.group.a, 20);
    const opened = await open(h.person.jan);
    expect(opened.statusCode).toBe(200);
    const s = opened.json();
    expect(s).toMatchObject({ versionId, pageCount: 2 });

    expect((await page(h.person.jan, s.sessionId, 2)).statusCode).toBe(200);
    expect((await page(h.person.jan, s.sessionId, 2)).statusCode).toBe(200);
    expect((await page(h.person.jan, s.sessionId, 1, 'thumb')).statusCode).toBe(200);

    const cov = await app.inject({ method: 'GET', url: `${base()}/${h.node.aud1}/coverage`, headers: as(h.person.anika) });
    expect(cov.statusCode).toBe(200);
    expect(cov.json()).toEqual({
      versionId, pageCount: 2,
      people: [{
        personId: h.person.jan, name: 'Jan de Vries', email: 'jan@bidder-a.example', pagesSeen: 1, pageCount: 2,
        firstOpenedAt: T.at.toISOString(), lastSeenAt: T.at.toISOString(),
      }],
    });

    const notAdmin = await app.inject({ method: 'GET', url: `${base()}/${h.node.aud1}/coverage`, headers: as(h.person.jan) });
    expect(notAdmin.statusCode).toBe(403);
  });

  it('should return a watermarked page', async () => {
    await grantGroup(h.group.a, 20);
    const s = (await open(h.person.jan)).json();
    const res = await page(h.person.jan, s.sessionId, 1);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cache-control']).toBe('private, no-store');
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: PAGE_WIDTH });

    const { key } = await h.app((tx) => keyring.dataKey(tx, h.ws));
    const derived = (await h.app((tx) => tx.query<{ kind: string; page: number; storage_key: string }>(
      `select kind, (metadata->>'page')::int as page, storage_key from derived_file where version_id = $1 and kind in ('page_image', 'thumbnail')`,
      [versionId]))).rows;
    const seen: string[] = [];
    for (const n of [1, 2]) {
      for (const [size, kind, width] of [['full', 'page_image', PAGE_WIDTH], ['thumb', 'thumbnail', THUMB_WIDTH]] as const) {
        const served = await page(h.person.jan, s.sessionId, n, size);
        expect(served.statusCode, served.body).toBe(200);
        expect((await sharp(served.rawPayload).metadata()).width).toBe(width);
        const at = derived.find((d) => d.kind === kind && d.page === n)!.storage_key;
        const clean = await decryptBuffer(key, storage.objects.get(at)!, at);
        expect(await meanLuminance(served.rawPayload), `${size} page ${n}`).toBeLessThan((await meanLuminance(clean)) - 1);
        seen.push(`${size} ${n}`);
      }
    }
    expect(seen).toEqual(['full 1', 'thumb 1', 'full 2', 'thumb 2']);
    // past the end looks the same as missing
    const pastEnd = await page(h.person.jan, s.sessionId, 3);
    const missing = await page(h.person.jan, s.sessionId, 1, 'full', MISSING);
    expect([pastEnd.statusCode, missing.statusCode]).toEqual([404, 404]);
    expect(pastEnd.body).toBe(missing.body);
  });

  it('stores pages and thumbnails as WebP', async () => {
    const rows = (await h.app((tx) => tx.query<{ kind: string; storage_key: string; content_type: string; size: number }>(
      `select kind, storage_key, metadata->>'contentType' as content_type, (metadata->>'size')::int as size
         from derived_file where version_id = $1 and kind in ('page_image', 'thumbnail')`, [versionId]))).rows;
    expect(rows).toHaveLength(4);
    const { key } = await h.app((tx) => keyring.dataKey(tx, h.ws));
    for (const r of rows) {
      expect(r.storage_key).toMatch(/\/(page_image|thumbnail)-\d\.webp$/);
      expect(r.content_type).toBe('image/webp');
      const clean = await decryptBuffer(key, storage.objects.get(r.storage_key)!, r.storage_key);
      expect(clean.subarray(0, 4).toString('latin1')).toBe('RIFF');
      expect(clean.subarray(8, 12).toString('latin1')).toBe('WEBP');
      expect(clean.length).toBe(r.size);
      expect((await sharp(clean).metadata()).width).toBe(r.kind === 'page_image' ? PAGE_WIDTH : THUMB_WIDTH);
    }
    // text pages are lossless
    const page1 = await decryptBuffer(key, storage.objects.get(cleanPage1Key)!, cleanPage1Key);
    expect(page1.length).toBeLessThan(150 * 1024);
  });

  it('converts old PNG pages', async () => {
    await grantGroup(h.group.a, 20);
    const { key, version } = await h.app((tx) => keyring.dataKey(tx, h.ws));
    const webp = await decryptBuffer(key, storage.objects.get(cleanPage1Key)!, cleanPage1Key);
    const png = await sharp(webp).png().toBuffer();
    // no extension, no content type
    const oldKey = `ws/${h.ws}/v/${versionId}/rasterise/page_image-1`;
    await storage.put(oldKey, await encryptBuffer(key, png, oldKey));
    await h.app((tx) => tx.query(
      `update derived_file set storage_key = $2, metadata = metadata - 'contentType', key_version = $3
        where version_id = $1 and kind = 'page_image' and (metadata->>'page')::int = 1`, [versionId, oldKey, version]));
    const s = (await open(h.person.jan)).json();
    const res = await page(h.person.jan, s.sessionId, 1);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(await sharp(res.rawPayload).metadata()).toMatchObject({ format: 'webp', width: PAGE_WIDTH });
    expect(await meanLuminance(res.rawPayload)).toBeLessThan((await meanLuminance(png)) - 1);
  });

  it('marks pages with every watermark item off', async () => {
    await grantGroup(h.group.a, 20);
    // can't be set through the API
    await h.pg.query(`update workspace set metadata = metadata || $2::jsonb where id = $1`,
      [h.ws, JSON.stringify({ watermark: { name: false, email: false, group: false, dateTime: false, ip: false } })]);
    const { key, version } = await h.app((tx) => keyring.dataKey(tx, h.ws));
    const clean = await decryptBuffer(key, storage.objects.get(cleanPage1Key)!, cleanPage1Key);
    const s = (await open(h.person.jan)).json();
    const res = await page(h.person.jan, s.sessionId, 1);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(Buffer.compare(res.rawPayload, clean)).not.toBe(0);
    expect(await meanLuminance(res.rawPayload)).toBeLessThan((await meanLuminance(clean)) - 1);

    const oldKey = `ws/${h.ws}/v/${versionId}/rasterise/page_image-2`;
    const png = await sharp({ create: { width: PAGE_WIDTH, height: 2263, channels: 3, background: '#ffffff' } }).png().toBuffer();
    await storage.put(oldKey, await encryptBuffer(key, png, oldKey));
    await h.app((tx) => tx.query(
      `update derived_file set storage_key = $2, metadata = metadata - 'contentType', key_version = $3
        where version_id = $1 and kind = 'page_image' and (metadata->>'page')::int = 2`, [versionId, oldKey, version]));
    const old = await page(h.person.jan, s.sessionId, 2);
    expect(old.statusCode).toBe(200);
    expect(old.headers['content-type']).toBe('image/webp');
    expect((await sharp(old.rawPayload).metadata()).format).toBe('webp');
  });

  it('returns not found without access', async () => {
    await grantGroup(h.group.a, 20);
    const s = (await open(h.person.jan)).json();
    const pairs = [
      [await open(h.person.mei), await open(h.person.mei, MISSING)],
      [await page(h.person.mei, s.sessionId, 1), await page(h.person.mei, s.sessionId, 1, 'full', MISSING)],
      [await download(h.person.mei, 'pdf'), await download(h.person.mei, 'pdf', MISSING)],
      [await download(h.person.mei, 'original'), await download(h.person.mei, 'original', MISSING)],
    ];
    for (const [hidden, missing] of pairs) {
      expect([hidden!.statusCode, missing!.statusCode]).toEqual([404, 404]);
      expect(hidden!.json()).toEqual(missing!.json());
    }
  });

  it("refuses someone else's session", async () => {
    await grantGroup(h.group.a, 20);
    const s = (await open(h.person.anika)).json();
    const theirs = await page(h.person.jan, s.sessionId, 1);
    const unknown = await page(h.person.jan, MISSING, 1);
    expect([theirs.statusCode, unknown.statusCode]).toEqual([404, 404]);
    expect(theirs.body).toBe(unknown.body);
  });

  it('ends a session after 8 hours', async () => {
    await grantGroup(h.group.a, 20);
    const s = (await open(h.person.jan)).json();
    expect(s.expiresAt).toBe(new Date(T.at.getTime() + 8 * 3600_000).toISOString());
    clock = new Date(T.at.getTime() + 8 * 3600_000 - 1000);
    expect((await page(h.person.jan, s.sessionId, 1)).statusCode).toBe(200);
    clock = new Date(T.at.getTime() + 8 * 3600_000);
    const res = await page(h.person.jan, s.sessionId, 1);
    expect([res.statusCode, res.json().type]).toEqual([410, 'https://vdrkit.com/problems/session-ended']);
    const again = (await open(h.person.jan)).json();
    expect((await page(h.person.jan, again.sessionId, 1)).statusCode).toBe(200);
  });

  it('stops serving pages when access is withdrawn', async () => {
    await grantGroup(h.group.a, 20);
    const s = (await open(h.person.jan)).json();
    expect((await page(h.person.jan, s.sessionId, 1)).statusCode).toBe(200);
    await h.pg.query(`update membership set valid_to = $1 where person_id = $2`, [new Date(T.at.getTime() - 1000).toISOString(), h.person.jan]);
    expect((await page(h.person.jan, s.sessionId, 1)).statusCode).toBe(404);
  });

  it('returns 403 at name-only access', async () => {
    await grantGroup(h.group.a, 10);
    const res = await open(h.person.jan);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ reason: 'needs_level_20' });
  });
});

describe('download note', () => {
  const note = async (person: string) => (await app.inject({ method: 'GET', url: `${base()}/${h.node.aud1}`, headers: as(person) })).json().watermark;
  const setFields = (fields: Record<string, boolean>) =>
    h.pg.query(`update workspace set metadata = metadata || $2::jsonb where id = $1`, [h.ws, JSON.stringify({ watermark: fields })]);
  const pdfText = async (person: string) => {
    const res = await download(person, 'pdf');
    expect(res.statusCode).toBe(200);
    return mupdf.Document.openDocument(res.rawPayload, 'application/pdf').loadPage(0).toStructuredText('preserve-whitespace').asText();
  };

  it('lists the default watermark fields', async () => {
    await grantGroup(h.group.a, 50);
    const n = await note(h.person.jan);
    expect(n).toEqual({ name: 'Jan de Vries', email: 'jan@bidder-a.example', group: expect.any(String), dateTime: true, ip: false });
    const text = await pdfText(h.person.jan);
    for (const v of [n.name, n.email, n.group]) expect(text).toContain(v);
  });

  it('follows the watermark switches', async () => {
    await grantGroup(h.group.a, 50);
    await setFields({ name: false, email: true, group: false, dateTime: false, ip: true });
    const n = await note(h.person.jan);
    expect(n).toEqual({ name: null, email: 'jan@bidder-a.example', group: null, dateTime: false, ip: true });
    const text = await pdfText(h.person.jan);
    expect(text).toContain('jan@bidder-a.example');
    expect(text).not.toContain('Jan de Vries');

    // all off: falls back to email
    await setFields({ name: false, email: false, group: false, dateTime: false, ip: false });
    expect(await note(h.person.jan)).toEqual({ name: null, email: 'jan@bidder-a.example', group: null, dateTime: false, ip: false });
    expect(await pdfText(h.person.jan)).toContain('jan@bidder-a.example');
  });

  it('is on documents only', async () => {
    await grantGroup(h.group.a, 20);
    const folder = (await app.inject({ method: 'GET', url: `${base()}/${h.node.fin}`, headers: as(h.person.jan) })).json();
    expect(folder.kind).toBe('folder');
    expect(folder.watermark).toBeUndefined();
  });
});

describe('downloads', () => {
  it('refuses PDF downloads at view level', async () => {
    await grantGroup(h.group.a, 20);
    const res = await download(h.person.jan, 'pdf');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ reason: 'needs_level_50', detail: 'Your access to this document does not include downloading it as a PDF.' });
  });

  it('stamps every page', async () => {
    await grantGroup(h.group.a, 50);
    const res = await download(h.person.jan, 'pdf');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="Audited financial statements FY2025.pdf"; filename*=UTF-8''Audited%20financial%20statements%20FY2025.pdf`);
    const doc = mupdf.Document.openDocument(res.rawPayload, 'application/pdf');
    expect(doc.countPages()).toBe(2);
    for (let i = 0; i < 2; i++) {
      const text = doc.loadPage(i).toStructuredText('preserve-whitespace').asText();
      expect(text).toContain('Jan de Vries');
      expect(text).toContain('jan@bidder-a.example');
      expect(text).toContain(`page ${i + 1}`);
    }
    expect((await download(h.person.jan, 'original')).statusCode).toBe(403);
  });

  it('gives the original only at level 60', async () => {
    await grantGroup(h.group.a, 50);
    const refused = await download(h.person.jan, 'original');
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ reason: 'needs_level_60' });

    const res = await download(h.person.anika, 'original');
    expect(res.statusCode).toBe(200);
    expect(Buffer.compare(res.rawPayload, original)).toBe(0);
  });

  it('records opens and downloads in the chain', async () => {
    await grantGroup(h.group.a, 50);
    const s = (await open(h.person.jan)).json();
    await page(h.person.jan, s.sessionId, 1);
    await page(h.person.jan, s.sessionId, 2);
    const pdf = await download(h.person.jan, 'pdf');
    const orig = await download(h.person.anika, 'original');

    const events = await h.app((tx) => tx.query<{ action: string; data: any; ip: string; user_agent: string }>(
      `select e.action, e.data, host(c.ip) as ip, c.user_agent from event e left join event_context c on c.event_id = e.id
        where e.workspace_id = $1 order by e.chain_pos`, [h.ws]));
    expect(events.rows.map((e) => e.action)).toEqual(
      ['document.opened', 'document.page_viewed', 'document.page_viewed', 'document.downloaded', 'document.downloaded']);
    expect(events.rows[0]!.data).toMatchObject({ version_id: versionId, page_count: 2 });
    expect(events.rows[0]).toMatchObject({ ip: '127.0.0.1', user_agent: 'vitest' });
    expect(events.rows.slice(1, 3).map((e) => e.data)).toMatchObject([
      { version_id: versionId, page: 1, person_id: h.person.jan, session_id: s.sessionId, watermark_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      { version_id: versionId, page: 2, person_id: h.person.jan, session_id: s.sessionId },
    ]);
    expect(events.rows[3]!.data).toMatchObject({ format: 'pdf', version_id: versionId, sha256: createHash('sha256').update(pdf.rawPayload).digest('hex'),
      watermark_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(events.rows[4]!.data).toMatchObject({ format: 'original', sha256: createHash('sha256').update(orig.rawPayload).digest('hex') });
    expect(events.rows[4]!.data.watermark_sha256).toBeUndefined();

    const chain = await h.app((tx) => verifyChain(tx, h.ws));
    expect(chain).toEqual({ checked: 5, firstBroken: null });
  });

  it('logs each page once per session', async () => {
    await grantGroup(h.group.a, 50);
    const s = (await open(h.person.jan)).json();
    await page(h.person.jan, s.sessionId, 1);
    await page(h.person.jan, s.sessionId, 1);
    await page(h.person.jan, s.sessionId, 2, 'thumb');
    const again = (await open(h.person.jan)).json();
    await page(h.person.jan, again.sessionId, 1);
    await download(h.person.jan, 'pdf');

    const rows = (await h.app((tx) => tx.query<{ action: string; data: any; personal: any }>(
      `select e.action, e.data, c.personal from event e left join event_context c on c.event_id = e.id
        where e.workspace_id = $1 and e.action in ('document.page_viewed', 'document.downloaded') order by e.chain_pos`, [h.ws]))).rows;
    expect(rows.map((r) => [r.action, r.data.page ?? null, r.data.session_id ?? null])).toEqual([
      ['document.page_viewed', 1, s.sessionId], ['document.page_viewed', 1, again.sessionId], ['document.downloaded', null, null]]);
    const pdf = rows[2]!;
    expect(pdf.data.watermark_sha256).toBe(createHash('sha256').update(pdf.personal.watermark.join('\n')).digest('hex'));
    expect(rows[0]!.data.watermark_sha256).toBe(pdf.data.watermark_sha256);
  });

  it('writes no page events in see-as mode', async () => {
    await grantGroup(h.group.a, 20);
    const seeAs = { 'x-vdrkit-see-as': h.group.a };
    const s = (await open(h.person.anika, h.node.aud1, seeAs)).json();
    expect((await page(h.person.anika, s.sessionId, 1, 'full', h.node.aud1, seeAs)).statusCode).toBe(200);
    const n = await h.pg.query<{ n: number }>(`select count(*)::int as n from event where action = 'document.page_viewed'`);
    expect(n.rows[0]!.n).toBe(0);
  });

  it('leaves watermark text out of the hash', async () => {
    await grantGroup(h.group.a, 50);
    const s = (await open(h.person.jan)).json();
    await page(h.person.jan, s.sessionId, 2);
    await page(h.person.jan, s.sessionId, 1);
    await download(h.person.jan, 'pdf');
    await download(h.person.anika, 'original');
    const ctx = await h.app((tx) => tx.query<{ action: string; data: any; personal: any; subject_person_id: string | null }>(
      `select e.action, e.data, c.personal, c.subject_person_id from event e join event_context c on c.event_id = e.id
        where e.workspace_id = $1 and e.action = 'document.downloaded' order by e.chain_pos`, [h.ws]));
    const [pdf, orig] = ctx.rows;
    // erasable, not hashed
    expect(pdf!.personal.watermark.join(' ')).toContain('Jan de Vries');
    expect(pdf!.subject_person_id).toBe(h.person.jan);
    expect(JSON.stringify(pdf!.data)).not.toContain('Jan de Vries');
    expect(orig!.personal).toBeNull();

    const log = (await app.inject({ method: 'GET', url: `/v1/workspaces/${h.ws}/events`, headers: as(h.person.anika) })).json().items as any[];
    const proof = (action: string, who: string) => Object.fromEntries(log.find((e) => e.action === action && e.person?.name === who).proof
      .map((x: { label: string; value: string }) => [x.label, x.value]));
    const opened = proof('document.opened', 'Jan de Vries');
    expect(opened).toMatchObject({ Version: 'Version 1', 'Pages viewed': '2 of 2: 1–2', 'Time spent': 'Under a minute', 'IP address': '127.0.0.1' });
    const jan = proof('document.downloaded', 'Jan de Vries');
    expect(jan).toMatchObject({ Version: 'Version 1', Format: 'PDF with watermark', 'IP address': '127.0.0.1' });
    expect(jan.Watermark).toContain('Jan de Vries');
    expect(jan['File fingerprint (SHA-256)']).toMatch(/^[0-9a-f]{64}$/);
    expect(proof('document.downloaded', 'Anika Pillay')).toMatchObject({ Format: 'Original file, unchanged', Watermark: 'None: the original file is never stamped' });

    await h.pg.query(`update person set erased_at = now() where id = $1`, [h.person.jan]);
    const after = await h.app((tx) => tx.query<{ personal: any }>(
      `select c.personal from event e join event_context c on c.event_id = e.id where e.workspace_id = $1 and e.action = 'document.downloaded' order by e.chain_pos limit 1`, [h.ws]));
    expect(after.rows[0]!.personal).toBeNull();
    expect((await h.app((tx) => verifyChain(tx, h.ws))).firstBroken).toBeNull();
  });
});

describe('archived room', () => {
  it('stays readable for a joining site admin', async () => {
    const W = `/v1/workspaces/${h.ws}`;
    const day = (n: number) => new Date(T.at.getTime() + n * 86_400_000);
    for (const [n, state] of [[1, 'closed'], [2, 'archived']] as const) {
      clock = day(n);
      expect((await app.inject({ method: 'PATCH', url: `${W}/settings`, headers: as(h.person.anika), payload: { state } })).statusCode).toBe(200);
    }
    clock = day(3);
    await h.pg.query(`update person set is_site_admin = true where id = $1`, [h.person.maria]);
    const joined = await app.inject({ method: 'POST', url: `/v1/site/rooms/${h.ws}/join`, headers: as(h.person.maria), payload: { reason: 'To hand the room over' } });
    expect(joined.statusCode, joined.body).toBe(200);

    const session = (await open(h.person.maria)).json().sessionId;
    expect((await page(h.person.maria, session, 1)).statusCode).toBe(200);
    const file = await download(h.person.maria, 'original');
    expect(file.statusCode).toBe(200);
    expect(Buffer.compare(file.rawPayload, original)).toBe(0);

    const csv = await app.inject({ method: 'GET', url: `${W}/events/export.csv`, headers: as(h.person.maria) });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('Audited financial statements');
    expect((await app.inject({ method: 'GET', url: `${W}/events/verify`, headers: as(h.person.maria) })).json())
      .toMatchObject({ intact: true, firstBroken: null });
  });
});

describe('document.opened', () => {
  const sessionsAndOpens = () => h.app(async (tx) => ({
    sessions: (await tx.query<{ id: string }>(`select id from view_session where node_id = $1 order by id`, [h.node.aud1])).rows.map((r) => r.id),
    opened: (await tx.query<{ sid: string }>(
      `select data ->> 'session_id' as sid from event where workspace_id = $1 and action = 'document.opened' order by sid`, [h.ws])).rows.map((r) => r.sid),
  }));

  const openAndHangUp = (port: number) => new Promise<void>((resolve) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: `${base()}/${h.node.aud1}/open`, headers: as(h.person.jan) });
    req.on('error', () => resolve());
    req.on('close', () => resolve());
    req.end(() => req.destroy());
  });

  const waitFor = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 50));
  };

  it('records the open even when the client hangs up', async () => {
    await grantGroup(h.group.a, 20);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let seen!: () => void;
    const arrived = new Promise<void>((r) => { seen = r; });
    const auth = new DevHeaderAuthenticator();
    const live = await buildApp({
      db: h.db, dbRole: 'vdrkit_app', now: () => clock, storage, keyring,
      auth: { authenticate: async (req) => { seen(); await gate; return auth.authenticate(req); } },
    });
    try {
      await live.listen({ port: 0, host: '127.0.0.1' });
      const port = (live.server.address() as AddressInfo).port;
      const hungUp = openAndHangUp(port);
      await arrived;
      await hungUp;
      release();
      await waitFor(async () => (await sessionsAndOpens()).opened.length === 1);
      await Promise.all([1, 2, 3, 4, 5].map(() => openAndHangUp(port)));
      await new Promise((r) => setTimeout(r, 300));
      await waitFor(async () => { const x = await sessionsAndOpens(); return x.sessions.length === x.opened.length; });
    } finally {
      await live.close();
    }
    const { sessions, opened } = await sessionsAndOpens();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(opened).toEqual(sessions);
    const chain = await h.app((tx) => verifyChain(tx, h.ws));
    expect(chain).toEqual({ checked: opened.length, firstBroken: null });
  });

  it('needs an opened session', async () => {
    await grantGroup(h.group.a, 20);
    expect((await page(h.person.jan, MISSING, 1)).statusCode).toBe(404);
    expect((await page(h.person.jan, MISSING, 1, 'thumb')).statusCode).toBe(404);
    expect((await sessionsAndOpens())).toEqual({ sessions: [], opened: [] });
  });
});

describe('agents', () => {
  it('lets a view-level agent open pages but not download', async () => {
    const agent = { 'x-dev-agent-max-level': '20' };
    const opened = await open(h.person.anika, h.node.aud1, agent);
    expect(opened.statusCode).toBe(200);
    expect((await page(h.person.anika, opened.json().sessionId, 1, 'full', h.node.aud1, agent)).statusCode).toBe(200);
    const pdf = await download(h.person.anika, 'pdf', h.node.aud1, agent);
    expect(pdf.statusCode).toBe(403);
    expect((await download(h.person.anika, 'original', h.node.aud1, agent)).statusCode).toBe(403);
    expect((await download(h.person.anika, 'pdf')).statusCode).toBe(200);
  });
});

describe('set-up and filenames', () => {
  it('fails clearly without storage or keys', async () => {
    const bare = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at });
    const res = await bare.inject({ method: 'GET', url: `${base()}/${h.node.aud1}/download?format=original`, headers: as(h.person.anika) });
    expect(res.statusCode).toBe(500);
    expect(res.json().detail).toMatch(/File storage is not configured/);
    await bare.close();
  });

  it('quotes download filenames', () => {
    const h1 = attachment('Q3 "final"; report\r\nété.pdf');
    expect(h1).not.toMatch(/[\r\n]/);
    expect(h1.split('"').length).toBe(3);
    expect(h1).toContain("filename*=UTF-8''Q3%20%22final%22%3B%20report__%C3%A9t%C3%A9.pdf");
  });
});
