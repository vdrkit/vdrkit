// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptBuffer, newDataKey } from '../src/crypto/envelope.js';
import { MemoryStorage, runPipeline, ServiceUnavailable } from '../src/pipeline/pipeline.js';
import { ClamAvClient, clamAvFromEnv, virusScanStep } from '../src/pipeline/virus-scan.js';

let server: Server;
let port: number;
const received: number[] = [];
const MARKER = 'not-a-real-virus-just-a-marker';
const LIMIT = 300_000;

beforeAll(async () => {
  server = createServer((s: Socket) => {
    let buf = Buffer.alloc(0);
    let header = false;
    let total = 0;
    let body = Buffer.alloc(0);
    let over = false;
    s.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!header) {
        const end = buf.indexOf(0);
        if (end < 0) return;
        expect(buf.subarray(0, end).toString()).toBe('zINSTREAM');
        buf = buf.subarray(end + 1);
        header = true;
      }
      while (buf.length >= 4) {
        const n = buf.readUInt32BE(0);
        if (n === 0) {
          received.push(total);
          if (over) s.end();
          else s.end(body.includes(MARKER) ? `stream: Test.Marker FOUND\0` : 'stream: OK\0');
          return;
        }
        if (buf.length < 4 + n) return;
        total += n;
        body = Buffer.concat([body, buf.subarray(4, 4 + n)]).subarray(-MARKER.length * 2 - 65_536);
        buf = buf.subarray(4 + n);
        // keep the connection open so the test does not race
        if (total > LIMIT && !over) { over = true; s.write('INSTREAM size limit exceeded. ERROR\0'); }
      }
    });
    s.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const scan = (b: Buffer, p = port) => new ClamAvClient('127.0.0.1', p, 5_000).scan(Readable.from([b]));

describe('the ClamAV client', () => {
  it('reads a clean verdict', async () => {
    expect(await scan(Buffer.alloc(200_000, 1))).toEqual({ status: 'clean' });
    expect(received.at(-1)).toBe(200_000);
  });

  it('names the signature it found', async () => {
    expect(await scan(Buffer.concat([Buffer.alloc(100_000), Buffer.from(MARKER)]))).toEqual({ status: 'infected', signature: 'Test.Marker' });
  });

  it('reports too large files', async () => {
    expect(await scan(Buffer.alloc(LIMIT * 3, 2))).toEqual({ status: 'too_large' });
  });

  it('treats a missing scanner as a service problem', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const p = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    await expect(scan(Buffer.from('x'), p)).rejects.toBeInstanceOf(ServiceUnavailable);
    await expect(scan(Buffer.from('x'), p)).rejects.toThrow(/The virus scanner is not reachable \(ECONNREFUSED\)/);
  });

  it('reads CLAMAV_HOST and CLAMAV_PORT', () => {
    expect(clamAvFromEnv({})).toBeNull();
    expect(clamAvFromEnv({ CLAMAV_HOST: 'clamav', CLAMAV_PORT: '3311' })).toMatchObject({ host: 'clamav', port: 3311, maxBytes: 1024 * 1024 * 1024 });
    expect(clamAvFromEnv({ CLAMAV_HOST: 'clamav', CLAMAV_MAX_BYTES: '1073741824' })).toMatchObject({ port: 3310, maxBytes: 1073741824 });
  });
});

describe('the virus step in the pipeline', () => {
  async function run(body: Buffer, clam: ClamAvClient | null) {
    const storage = new MemoryStorage();
    const key = newDataKey();
    await storage.put('ws/w/v/1/original', await encryptBuffer(key, body, 'ws/w/v/1/original'));
    return runPipeline({ versionId: '1', workspaceId: 'w', storageKey: 'ws/w/v/1/original', filename: 'x.zip', mime: 'application/zip' },
      [virusScanStep(clam)], storage, key);
  }

  it('records the verdict and carries on', async () => {
    const clam = new ClamAvClient('127.0.0.1', port, 5_000, LIMIT);
    expect(await run(Buffer.from('fine'), clam)).toMatchObject({ ok: true, facts: { virusScan: 'clean' } });
    expect(await run(Buffer.alloc(LIMIT * 2), clam)).toMatchObject({ ok: true, facts: { virusScan: 'too_large', virusScanLimit: LIMIT } });
    expect(await run(Buffer.from('fine'), null)).toMatchObject({ ok: true, facts: { virusScan: 'not_configured' } });
  });

  it('fails the file with the signature', async () => {
    const res = await run(Buffer.from(`data ${MARKER} data`), new ClamAvClient('127.0.0.1', port));
    expect(res).toMatchObject({ ok: false, failedStep: 'virus', facts: { virusScan: 'infected', virusSignature: 'Test.Marker' },
      error: 'The virus scanner found Test.Marker in this file. It is locked: nobody can open or download it. Remove it and upload a clean copy.' });
  });
});
