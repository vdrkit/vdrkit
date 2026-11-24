// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptBuffer, encryptBuffer, newDataKey } from '../src/crypto/envelope.js';
import { convertStep, GotenbergClient, hashStep, MemoryStorage, runPipeline, ServiceUnavailable, type Original } from '../src/pipeline/pipeline.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/office/${name}`, import.meta.url));

let server: Server;
let baseUrl: string;
const received: { path: string; body: string }[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1');
      received.push({ path: req.url ?? '', body });
      if (body.includes('protected.xlsx')) {
        res.writeHead(400).end('LibreOffice failed to process a document: a password may be required, or, if one has been given, it is invalid. In any case, the exact cause is uncertain.');
      } else if (body.includes('damaged.docx')) {
        res.writeHead(400).end("LibreOffice failed to process a document: possible causes include malformed page ranges '' (nativePageRanges), or, if a password has been provided, it may not be required. In any case, the exact cause is uncertain.");
      } else if (body.includes('broken.docx')) {
        res.writeHead(500).end('Internal Server Error');
      } else if (body.includes('busy.docx')) {
        res.writeHead(503).end('Service Unavailable');
      } else {
        res.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF-1.7\n% converted by fake gotenberg\n%%EOF');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function upload(storage: MemoryStorage, key: Buffer, filename: string, body: Buffer): Promise<Original> {
  const storageKey = `ws/heron/originals/${filename}`;
  await storage.put(storageKey, await encryptBuffer(key, body, storageKey));
  return { versionId: 'v1', workspaceId: 'heron', storageKey, filename, mime: 'application/octet-stream' };
}

describe('processing pipeline', () => {
  it('hashes the original and converts Excel to PDF', async () => {
    const storage = new MemoryStorage();
    const key = newDataKey();
    const xlsx = fixture('accounts.xlsx');
    const original = await upload(storage, key, 'IFRS 16 lease reconciliation.xlsx', xlsx);
    const res = await runPipeline(original, [hashStep, convertStep(new GotenbergClient(baseUrl))], storage, key);

    expect(res).toMatchObject({ ok: true, completedSteps: ['hash', 'convert'] });
    expect(res.facts.sha256).toBe(createHash('sha256').update(xlsx).digest('hex'));
    expect(received.at(-1)!.path).toBe('/forms/libreoffice/convert');
    expect(received.at(-1)!.body).toContain('filename="IFRS 16 lease reconciliation.xlsx"');

    const pdf = res.derived.find((d) => d.kind === 'pdf')!;
    const stored = storage.objects.get(pdf.storageKey)!;
    expect(stored.subarray(0, 5).toString()).toBe('VDRK1');           // encrypted at rest
    expect((await decryptBuffer(key, stored, pdf.storageKey)).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('passes a PDF through without calling the converter', async () => {
    const storage = new MemoryStorage();
    const key = newDataKey();
    const before = received.length;
    const original = await upload(storage, key, 'Audited financial statements FY2025.pdf', Buffer.from('%PDF-1.4 real pdf'));
    const res = await runPipeline(original, [hashStep, convertStep(new GotenbergClient(baseUrl))], storage, key);
    expect(res.ok).toBe(true);
    expect(received.length).toBe(before);
    expect(res.derived[0]).toMatchObject({ kind: 'pdf', meta: { passthrough: true } });
  });

  it('explains a password-protected file in plain words', async () => {
    const storage = new MemoryStorage();
    const key = newDataKey();
    const original = await upload(storage, key, 'protected.xlsx', fixture('protected.xlsx'));
    const res = await runPipeline(original, [hashStep, convertStep(new GotenbergClient(baseUrl))], storage, key);
    expect(res).toMatchObject({ ok: false, failedStep: 'convert', completedSteps: ['hash'] });
    expect(res.error).toBe('The file is password protected, so VDRkit cannot convert it for viewing.');
  });

  it('reports other converter failures with the status code', async () => {
    const storage = new MemoryStorage();
    const key = newDataKey();
    const res = await runPipeline(await upload(storage, key, 'broken.docx', fixture('memo.docx')), [convertStep(new GotenbergClient(baseUrl))], storage, key);
    expect(res.error).toMatch(/Conversion to PDF failed \(500\)/);
  });

  it('reports a damaged file as damaged, not password protected', async () => {
    const storage = new MemoryStorage();
    const key = newDataKey();
    const res = await runPipeline(await upload(storage, key, 'damaged.docx', fixture('memo.docx').subarray(0, 3000)), [convertStep(new GotenbergClient(baseUrl))], storage, key);
    expect(res).toMatchObject({ ok: false, failedStep: 'convert',
      error: 'The file could not be read: it may be damaged. Open it on your computer, save it again and upload the new copy.' });
  });

  it('retries when the converter is busy', async () => {
    const storage = new MemoryStorage();
    const key = newDataKey();
    await expect(runPipeline(await upload(storage, key, 'busy.docx', fixture('memo.docx')), [convertStep(new GotenbergClient(baseUrl))], storage, key))
      .rejects.toBeInstanceOf(ServiceUnavailable);
    await expect(runPipeline(await upload(storage, key, 'memo.docx', fixture('memo.docx')), [convertStep(new GotenbergClient('http://127.0.0.1:9'))], storage, key))
      .rejects.toThrow(/Document conversion is not reachable/);
  });

  it('refuses a file named .pdf that is not a PDF', async () => {
    const storage = new MemoryStorage();
    const key = newDataKey();
    const res = await runPipeline(await upload(storage, key, 'invoice.pdf', Buffer.from('MZ executable')), [convertStep(new GotenbergClient(baseUrl))], storage, key);
    expect(res).toMatchObject({ ok: false, error: 'This file is not a real PDF. Open it on your computer, save it again and upload the new copy.' });
  });

  it('skips conversion for archives', async () => {
    const storage = new MemoryStorage();
    const key = newDataKey();
    const res = await runPipeline(await upload(storage, key, 'Patent family 1.zip', Buffer.from('PK zip')), [hashStep, convertStep(new GotenbergClient(baseUrl))], storage, key);
    expect(res).toMatchObject({ ok: true, completedSteps: ['hash'], derived: [] });
  });
});
