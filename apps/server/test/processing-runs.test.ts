// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as mupdf from 'mupdf';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';
import { decryptBuffer, encryptBuffer, LocalKeyProvider } from '../src/crypto/envelope.js';
import { DbKeyring } from '../src/crypto/keyring.js';
import { GotenbergClient, MemoryStorage, runPipeline, type Step } from '../src/pipeline/pipeline.js';
import {
  MAX_RESTARTS, MemoryQueue, PROCESS_MAX_MS, processVersion, STUCK_AFTER_MS, STUCK_REASON, sweepExpiredUploads, sweepStuckProcessing, TOO_LONG_REASON,
  UPLOAD_SWEEP_GRACE_MS, type WorkerContext,
} from '../src/worker/jobs.js';
import { handleProcessVersion, OUTAGE_TRIES } from '../src/worker/runner.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';

let h: Heron;
let ctx: WorkerContext;
let storage: MemoryStorage;
let keyring: DbKeyring;
let clock: Date;

beforeEach(async () => {
  h = await heron();
  storage = new MemoryStorage();
  keyring = new DbKeyring(new LocalKeyProvider(randomBytes(32).toString('base64')));
  clock = T.at;
  ctx = { db: h.db, storage, keyring, gotenberg: new GotenbergClient('http://127.0.0.1:9'), dbRole: 'vdrkit_app', now: () => clock };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.pg.close();
});

async function pdf(pages: string[]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) doc.addPage([595, 842]).drawText(text, { x: 60, y: 760, size: 14, font });
  return Buffer.from(await doc.save());
}

async function upload(nodeId: string, filename: string, bytes: Buffer) {
  await h.pg.query(`update node set name = $2 where id = $1`, [nodeId, filename]);
  return h.app(async (tx) => {
    const { key, version } = await keyring.dataKey(tx, h.ws);
    const storageKey = `ws/${h.ws}/originals/${nodeId}`;
    await storage.put(storageKey, await encryptBuffer(key, bytes, storageKey));
    const sha = createHash('sha256').update(bytes).digest('hex');
    return (await tx.query<{ id: string }>(
      `insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, key_version)
       values (current_tenant_id(), $1, 1, $2, $3, $4, 'application/pdf', $5) returning id`,
      [nodeId, storageKey, sha, bytes.length, version])).rows[0]!.id;
  });
}

const one = async <T>(text: string, params: unknown[]) => (await h.pg.query<T>(text, params)).rows[0]!;

describe('text extraction', () => {
  it('keeps a PDF viewable when text extraction fails', async () => {
    const v = await upload(h.node.audDraft, "Auditor's management letter FY2025.pdf", await pdf(['Scanned page one', 'Scanned page two']));
    await h.pg.query(`update document_version set publish_when_ready = $2 where id = $1`,
      [v, JSON.stringify({ person_id: h.person.anika, actor_id: null, quiet: true, at: T.at.toISOString() })]);
    vi.spyOn(mupdf.Page.prototype, 'toStructuredText').mockImplementation(() => { throw new Error('broken text layer'); });

    expect(await processVersion(ctx, h.t1, v)).toEqual({ status: 'ready', pageCount: 2 });

    const dv = await one<any>(`select processing_status, processing_error, page_count, metadata ->> 'searchSkipped' as search_skipped, publish_when_ready
      from document_version where id = $1`, [v]);
    expect(dv).toEqual({ processing_status: 'ready', processing_error: null, page_count: 2, search_skipped: 'unreadable', publish_when_ready: null });
    const kinds = (await h.pg.query<{ kind: string; n: number }>(`select kind, count(*)::int n from derived_file where version_id = $1 group by kind order by kind`, [v])).rows;
    expect(kinds).toEqual([{ kind: 'page_image', n: 2 }, { kind: 'pdf', n: 1 }, { kind: 'thumbnail', n: 2 }]);
    expect((await h.pg.query(`select 1 from document_text where version_id = $1`, [v])).rows).toHaveLength(0);
    const ev = await one<{ data: any }>(`select data from event where action = 'document.processed'`, []);
    expect(ev.data).toMatchObject({ search_skipped: 'unreadable', note: expect.stringContaining('will not appear in search') });
    expect((await one<{ state: string }>(`select state from node where id = $1`, [h.node.audDraft])).state).toBe('published');
  });
});

describe('tall pages', () => {
  // 32,000 px high at viewer width
  it('scales them down instead of failing', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([200, 4000]).drawText('Till roll', { x: 20, y: 3900, size: 14, font });
    const v = await upload(h.node.aud1, 'Till roll.pdf', Buffer.from(await doc.save()));
    expect(await processVersion(ctx, h.t1, v)).toEqual({ status: 'ready', pageCount: 1 });
    const page = await one<{ storage_key: string }>(`select storage_key from derived_file where version_id = $1 and kind = 'page_image'`, [v]);
    const { key } = await h.app((tx) => keyring.dataKey(tx, h.ws));
    const meta = await sharp(await decryptBuffer(key, await storage.get(page.storage_key), page.storage_key)).metadata();
    expect([meta.width, meta.height]).toEqual([1600, 16_000]);
  });
});

// blocks the first read until released
function holdFirstRead() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let reached!: () => void;
  const waiting = new Promise<void>((r) => { reached = r; });
  const get = storage.get.bind(storage);
  let first = true;
  vi.spyOn(storage, 'get').mockImplementation(async (key) => {
    if (first && key.includes('/originals/')) {
      first = false;
      reached();
      await gate;
    }
    return get(key);
  });
  return { waiting, release };
}

const derivedCounts = async (v: string) =>
  (await h.pg.query<{ kind: string; n: number }>(`select kind, count(*)::int n from derived_file where version_id = $1 group by kind order by kind`, [v])).rows;

describe('duplicate runs', () => {
  it('leaves one result when a retry overtakes the first run', async () => {
    const v = await upload(h.node.aud1, 'Audited financial statements FY2025.pdf', await pdf(['Revenue rose', 'Germiston plant']));
    const hold = holdFirstRead();
    const first = processVersion(ctx, h.t1, v);
    await hold.waiting;
    clock = new Date(T.at.getTime() + 15 * 60_000 + 1000);
    expect(await processVersion(ctx, h.t1, v)).toEqual({ status: 'ready', pageCount: 2 });
    hold.release();
    expect(await first).toEqual({ status: 'superseded', pageCount: null });

    expect(await derivedCounts(v)).toEqual([{ kind: 'page_image', n: 2 }, { kind: 'pdf', n: 1 }, { kind: 'text', n: 1 }, { kind: 'thumbnail', n: 2 }]);
    expect((await h.pg.query(`select 1 from document_text where version_id = $1`, [v])).rows).toHaveLength(2);
    expect((await h.pg.query(`select 1 from event where action = 'document.processed'`)).rows).toHaveLength(1);
    // what the viewer counts as pages
    const pages = await one<{ n: number }>(`select count(*)::int as n from derived_file where version_id = $1 and kind = 'page_image'`, [v]);
    expect(pages.n).toBe(2);
    for (const f of (await h.pg.query<{ storage_key: string }>(`select storage_key from derived_file where version_id = $1`, [v])).rows) {
      expect(storage.objects.has(f.storage_key)).toBe(true);
    }
  });

  it('replaces the earlier set when a version is processed again', async () => {
    const v = await upload(h.node.aud1, 'Audited financial statements FY2025.pdf', await pdf(['Revenue rose', 'Germiston plant']));
    expect(await processVersion(ctx, h.t1, v)).toEqual({ status: 'ready', pageCount: 2 });
    clock = new Date(T.at.getTime() + 60_000);
    expect(await processVersion(ctx, h.t1, v)).toEqual({ status: 'ready', pageCount: 2 });
    expect(await derivedCounts(v)).toEqual([{ kind: 'page_image', n: 2 }, { kind: 'pdf', n: 1 }, { kind: 'text', n: 1 }, { kind: 'thumbnail', n: 2 }]);
    expect((await h.pg.query(`select 1 from document_text where version_id = $1`, [v])).rows).toHaveLength(2);
  });

  it('keeps a swept version failed', async () => {
    const v = await upload(h.node.aud1, 'Audited financial statements FY2025.pdf', await pdf(['Revenue rose']));
    const hold = holdFirstRead();
    const first = processVersion(ctx, h.t1, v);
    await hold.waiting;
    clock = new Date(T.at.getTime() + STUCK_AFTER_MS + 1000);
    expect(await sweepStuckProcessing(ctx)).toEqual({ failed: 1 });
    hold.release();
    expect(await first).toEqual({ status: 'superseded', pageCount: null });

    const dv = await one<any>(`select processing_status, processing_error, failed_step from document_version where id = $1`, [v]);
    expect(dv).toEqual({ processing_status: 'failed', processing_error: STUCK_REASON, failed_step: 'worker' });
    expect(await derivedCounts(v)).toEqual([]);
    expect((await h.pg.query(`select 1 from event where action = 'document.processed'`)).rows).toHaveLength(0);
  });
});

describe('long runs and silent workers', () => {
  const row = (v: string) => one<{ processing_status: string; processing_error: string | null; restarts: number | null }>(
    `select processing_status, processing_error, (metadata ->> 'processing_restarts')::int as restarts from document_version where id = $1`, [v]);
  const beats = async (v: string) => (await one<{ at: Date | null }>(`select processing_heartbeat_at as at from document_version where id = $1`, [v])).at;
  const tick = () => new Promise((r) => setTimeout(r, 60));

  it('lets a reporting run finish', async () => {
    ctx = { ...ctx, heartbeatMs: 10 };
    const v = await upload(h.node.aud1, 'Audited financial statements FY2025.pdf', await pdf(['Revenue rose']));
    const hold = holdFirstRead();
    const run = processVersion(ctx, h.t1, v);
    await hold.waiting;
    // an hour in
    clock = new Date(T.at.getTime() + 60 * 60_000);
    await tick();
    expect((await beats(v))!.toISOString()).toBe(clock.toISOString());
    expect(await sweepStuckProcessing(ctx, { queue: new MemoryQueue() })).toEqual({ failed: 0 });
    hold.release();
    expect(await run).toEqual({ status: 'ready', pageCount: 1 });
  });

  it('restarts a silent run once, then gives up', async () => {
    const v = await upload(h.node.aud1, 'Audited financial statements FY2025.pdf', await pdf(['Revenue rose']));
    const queue = new MemoryQueue();
    for (let i = 1; i <= MAX_RESTARTS; i += 1) {
      await h.pg.query(`update document_version set processing_status = 'processing', processing_started_at = $2, processing_heartbeat_at = $2 where id = $1`,
        [v, clock.toISOString()]);
      clock = new Date(clock.getTime() + STUCK_AFTER_MS - 1000);
      expect(await sweepStuckProcessing(ctx, { queue })).toEqual({ failed: 0 });
      clock = new Date(clock.getTime() + 2000);
      expect(await sweepStuckProcessing(ctx, { queue })).toEqual({ failed: 0, restarted: 1 });
      expect(await row(v)).toEqual({ processing_status: 'pending', processing_error: null, restarts: i });
    }
    expect(queue.jobs).toEqual(Array(MAX_RESTARTS).fill({ name: 'process-version', payload: { tenantId: h.t1, versionId: v } }));
    const log = (await h.pg.query<{ data: any }>(`select data from event where action = 'document.processing_restarted' order by seq`)).rows.map((r) => r.data);
    expect(log).toEqual([{ version_id: v, reason: 'worker_stopped', restarts: 1 }, { version_id: v, reason: 'worker_stopped', restarts: 2 }]);

    await h.pg.query(`update document_version set processing_status = 'processing', processing_started_at = $2, processing_heartbeat_at = $2 where id = $1`,
      [v, clock.toISOString()]);
    clock = new Date(clock.getTime() + STUCK_AFTER_MS + 1000);
    expect(await sweepStuckProcessing(ctx, { queue })).toEqual({ failed: 1 });
    expect(await row(v)).toMatchObject({ processing_status: 'failed', processing_error: STUCK_REASON });
    expect(queue.jobs).toHaveLength(MAX_RESTARTS);
  });

  it('fails runs past two hours', async () => {
    const v = await upload(h.node.aud1, 'Audited financial statements FY2025.pdf', await pdf(['Revenue rose']));
    const queue = new MemoryQueue();
    await h.pg.query(`update document_version set processing_status = 'processing', processing_started_at = $2 where id = $1`, [v, clock.toISOString()]);
    clock = new Date(clock.getTime() + PROCESS_MAX_MS - 60_000);
    await h.pg.query(`update document_version set processing_heartbeat_at = $2 where id = $1`, [v, clock.toISOString()]);
    expect(await sweepStuckProcessing(ctx, { queue })).toEqual({ failed: 0 });
    clock = new Date(clock.getTime() + 2 * 60_000);
    await h.pg.query(`update document_version set processing_heartbeat_at = $2 where id = $1`, [v, clock.toISOString()]);
    expect(await sweepStuckProcessing(ctx, { queue })).toEqual({ failed: 1 });
    expect(await row(v)).toMatchObject({ processing_status: 'failed', processing_error: TOO_LONG_REASON });
    expect(queue.jobs).toEqual([]);
    const ev = await one<{ data: any }>(`select data from event where action = 'document.processing_failed'`, []);
    expect(ev.data).toMatchObject({ version_id: v, too_long: true, stuck: true });
  });

  it('stops between steps when told to', async () => {
    const ran: string[] = [];
    const step = (name: string): Step => ({ name, appliesTo: () => true, run: async () => { ran.push(name); } });
    const out = await runPipeline({ versionId: 'v', workspaceId: h.ws, storageKey: 'k', filename: 'a.pdf', mime: 'application/pdf' },
      [step('one'), step('two'), step('three')], storage, randomBytes(32), { stop: () => (ran.length >= 2 ? TOO_LONG_REASON : null) });
    expect(ran).toEqual(['one', 'two']);
    expect(out).toMatchObject({ ok: false, failedStep: 'three', error: TOO_LONG_REASON, completedSteps: ['one', 'two'] });
  });

  it('stops a run that was taken over', async () => {
    ctx = { ...ctx, heartbeatMs: 10 };
    const v = await upload(h.node.aud1, 'Audited financial statements FY2025.pdf', await pdf(['Revenue rose', 'Germiston plant']));
    const hold = holdFirstRead();
    const run = processVersion(ctx, h.t1, v);
    await hold.waiting;
    // no queue, so the sweep fails it
    clock = new Date(T.at.getTime() + PROCESS_MAX_MS + 60_000);
    expect(await sweepStuckProcessing(ctx)).toEqual({ failed: 1 });
    await tick();
    hold.release();
    expect(await run).toEqual({ status: 'superseded', pageCount: null });
    expect(await derivedCounts(v)).toEqual([]);
    // it stopped before it made page images
    expect([...storage.objects.keys()].filter((k) => k.includes('/rasterise/'))).toEqual([]);
  });
});

describe('converter or scanner down', () => {
  const job = (versionId: string, waits?: number) => ({ id: 'j', name: 'process-version', data: { tenantId: h.t1, versionId, ...(waits === undefined ? {} : { waits }) } });
  const status = async (v: string) => (await one<{ s: string }>(`select processing_status as s from document_version where id = $1`, [v])).s;

  // a text file goes through the converter
  async function notes() {
    await h.pg.query(`update node set name = 'Board notes.txt' where id = $1`, [h.node.aud1]);
    return h.app(async (tx) => {
      const { key, version } = await keyring.dataKey(tx, h.ws);
      const bytes = Buffer.from('Board notes');
      const storageKey = `ws/${h.ws}/originals/${h.node.aud1}`;
      await storage.put(storageKey, await encryptBuffer(key, bytes, storageKey));
      return (await tx.query<{ id: string }>(
        `insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, key_version)
         values (current_tenant_id(), $1, 1, $2, $3, $4, 'application/octet-stream', $5) returning id`,
        [h.node.aud1, storageKey, createHash('sha256').update(bytes).digest('hex'), bytes.length, version])).rows[0]!.id;
    });
  }

  it('retries without counting an attempt', async () => {
    const v = await notes();
    const queue = new MemoryQueue();
    expect(await handleProcessVersion(ctx, job(v), queue)).toEqual({ status: 'waiting', pageCount: null });
    expect(await status(v)).toBe('pending');
    expect(queue.jobs).toEqual([{ name: 'process-version', payload: { tenantId: h.t1, versionId: v, waits: 1 } }]);
    expect(await handleProcessVersion(ctx, job(v, 7), queue)).toEqual({ status: 'waiting', pageCount: null });
    expect(queue.jobs.at(-1)!.payload).toEqual({ tenantId: h.t1, versionId: v, waits: 8 });
    expect((await h.pg.query(`select 1 from event where action = 'document.processing_failed'`)).rows).toEqual([]);
  });

  it('gives up after an hour', async () => {
    const v = await notes();
    const queue = new MemoryQueue();
    await expect(handleProcessVersion(ctx, job(v, OUTAGE_TRIES), queue)).rejects.toThrow('Document conversion is not reachable');
    expect(queue.jobs).toEqual([]);
    expect(await status(v)).toBe('processing');
  });
});

describe('upload sweep', () => {
  it('skips quarantine files it cannot delete', async () => {
    const principal = (await one<{ id: string }>(`insert into principal (tenant_id, kind, person_id, name) values ($1, 'person', $2, 'Anika') returning id`,
      [h.t1, h.person.anika])).id;
    const keys = ['quarantine/a', 'quarantine/b'];
    for (const [i, key] of keys.entries()) {
      await storage.put(key, Buffer.from('plain bytes'));
      await h.pg.query(`insert into upload_session (tenant_id, workspace_id, person_id, principal_id, relative_path, declared_size, declared_sha256, mime,
          quarantine_key, created_at, expires_at)
        values ($1, $2, $3, $4, $5, 11, $6, 'application/pdf', $7, $8, $9)`,
        [h.t1, h.ws, h.person.anika, principal, `File ${i}.pdf`, 'a'.repeat(64), key, T.at.toISOString(), new Date(T.at.getTime() + i * 1000).toISOString()]);
    }
    const remove = storage.delete.bind(storage);
    const broken = vi.spyOn(storage, 'delete').mockImplementation(async (key) => {
      if (key === 'quarantine/a') throw new Error('storage is down');
      return remove(key);
    });
    const later = () => new Date(T.at.getTime() + UPLOAD_SWEEP_GRACE_MS + 60_000);
    expect(await sweepExpiredUploads({ ...ctx, now: later })).toEqual({ swept: 1, failed: 1 });
    const status = async () => (await h.pg.query<{ quarantine_key: string; status: string }>(
      `select quarantine_key, status from upload_session order by quarantine_key`)).rows;
    expect(await status()).toEqual([{ quarantine_key: 'quarantine/a', status: 'open' }, { quarantine_key: 'quarantine/b', status: 'expired' }]);
    expect([...storage.objects.keys()].filter((k) => k.startsWith('quarantine/'))).toEqual(['quarantine/a']);

    broken.mockRestore();
    expect(await sweepExpiredUploads({ ...ctx, now: later })).toEqual({ swept: 1 });
    expect((await status()).map((r) => r.status)).toEqual(['expired', 'expired']);
    expect(storage.objects.has('quarantine/a')).toBe(false);
  });
});
