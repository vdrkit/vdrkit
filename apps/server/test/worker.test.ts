// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { appendEvent, enqueueForEvent, setGrant, verifyChain, type Channel, type OutgoingMessage } from '@vdrkit/core';
import { encryptBuffer, LocalKeyProvider } from '../src/crypto/envelope.js';
import { DbKeyring } from '../src/crypto/keyring.js';
import { GotenbergClient, MemoryStorage } from '../src/pipeline/pipeline.js';
import { processVersion, sendDueNotifications, type WorkerContext } from '../src/worker/jobs.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';

let server: Server;
let gotenbergUrl: string;
beforeAll(async () => {
  server = createServer((req, res) => { req.resume(); req.on('end', () => res.writeHead(400).end('the document is password protected')); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  gotenbergUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

let h: Heron;
let ctx: WorkerContext;
let storage: MemoryStorage;
let keyring: DbKeyring;
let outbox: OutgoingMessage[];
let clock: Date;
const mailer: Channel = { name: 'email', send: async (m) => { outbox.push(m); return { status: 'accepted' }; } };

beforeEach(async () => {
  h = await heron();
  storage = new MemoryStorage();
  keyring = new DbKeyring(new LocalKeyProvider(randomBytes(32).toString('base64')));
  outbox = [];
  clock = T.at;
  ctx = { db: h.db, storage, keyring, gotenberg: new GotenbergClient(gotenbergUrl), mailer, dbRole: 'vdrkit_app', now: () => clock };
});
afterEach(async () => { await h.pg.close(); });

async function pdf(pages: string[]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) doc.addPage([595, 842]).drawText(text, { x: 60, y: 760, size: 14, font });
  return Buffer.from(await doc.save());
}

async function upload(nodeId: string, filename: string, bytes: Buffer, opts: { wrongHash?: boolean } = {}) {
  await h.pg.query(`update node set name = $2 where id = $1`, [nodeId, filename]);
  return h.app(async (tx) => {
    const { key, version } = await keyring.dataKey(tx, h.ws);
    const storageKey = `ws/${h.ws}/originals/${nodeId}`;
    await storage.put(storageKey, await encryptBuffer(key, bytes, storageKey));
    const sha = opts.wrongHash ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex');
    return (await tx.query<{ id: string }>(
      `insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, key_version)
       values (current_tenant_id(), $1, 1, $2, $3, $4, 'application/octet-stream', $5) returning id`,
      [nodeId, storageKey, sha, bytes.length, version])).rows[0]!.id;
  });
}

describe('process-version job', () => {
  it('processes an uploaded PDF', async () => {
    const v = await upload(h.node.aud1, 'Audited financial statements FY2025.pdf', await pdf(['Revenue rose to R 1.42 billion', 'Germiston plant capacity']));
    expect(await processVersion(ctx, h.t1, v)).toEqual({ status: 'ready', pageCount: 2 });

    const kinds = (await h.pg.query<{ kind: string; n: number }>(`select kind, count(*)::int n from derived_file where version_id = $1 group by kind order by kind`, [v])).rows;
    expect(kinds).toEqual([{ kind: 'page_image', n: 2 }, { kind: 'pdf', n: 1 }, { kind: 'text', n: 1 }, { kind: 'thumbnail', n: 2 }]);
    const text = (await h.pg.query<{ page: number; body: string }>(`select page, body from document_text where version_id = $1 order by page`, [v])).rows;
    expect(text.map((t) => t.page)).toEqual([1, 2]);
    expect(text[1]!.body).toContain('Germiston');
    const dv = (await h.pg.query<any>(`select processing_status, page_count from document_version where id = $1`, [v])).rows[0];
    expect(dv).toEqual({ processing_status: 'ready', page_count: 2 });
    expect((await h.pg.query(`select 1 from event where action = 'document.processed'`)).rows).toHaveLength(1);
    expect(await h.app((tx) => verifyChain(tx, h.ws))).toMatchObject({ firstBroken: null });
  });

  it('explains password-protected files', async () => {
    const v = await upload(h.node.tax1, 'Customer master data export.xlsx', readFileSync(new URL('./fixtures/office/protected.xlsx', import.meta.url)));
    const r = await processVersion(ctx, h.t1, v);
    expect(r).toMatchObject({ status: 'failed', failedStep: 'convert', error: 'The file is password protected, so VDRkit cannot convert it for viewing.' });
    const dv = (await h.pg.query<any>(`select processing_status, processing_error from document_version where id = $1`, [v])).rows[0];
    expect(dv.processing_status).toBe('failed');
    expect((await h.pg.query(`select data->>'failed_step' as s from event where action = 'document.processing_failed'`)).rows).toEqual([{ s: 'convert' }]);
  });

  it('refuses a hash mismatch', async () => {
    const v = await upload(h.node.aud1, 'Tampered.pdf', await pdf(['x']), { wrongHash: true });
    expect(await processVersion(ctx, h.t1, v)).toMatchObject({ status: 'failed', failedStep: 'hash' });
    expect((await h.pg.query(`select 1 from document_text where version_id = $1`, [v])).rows).toHaveLength(0);
  });
});

describe('send-due-notifications job', () => {
  it('sends due messages and holds the rest', async () => {
    await h.app((tx) => setGrant(tx, { workspaceId: h.ws, nodeId: h.node.fin, subject: { groupId: h.group.a }, level: 20, now: T.grantsSet }));
    await h.app(async (tx) => {
      const ev = await appendEvent(tx, { action: 'document.published', workspaceId: h.ws, resourceType: 'node', resourceId: h.node.aud1, occurredAt: T.at });
      await enqueueForEvent(tx, { id: ev.id, action: ev.action, workspaceId: h.ws, resourceId: h.node.aud1, occurredAt: T.at, actorPersonId: h.person.anika });
    });
    clock = new Date(T.at.getTime() + 5 * 60_000);
    expect(await sendDueNotifications(ctx, h.t1)).toEqual({ sent: 0, dropped: 0, failed: 0 });
    clock = new Date(T.at.getTime() + 11 * 60_000);
    const r = await sendDueNotifications(ctx, h.t1);
    expect(r.sent).toBeGreaterThanOrEqual(1);
    expect(outbox.map((m) => m.to)).toContain('jan@bidder-a.example');
    expect((await h.pg.query(`select 1 from event where action = 'notification.sent'`)).rows.length).toBe(r.sent);
  });
});
