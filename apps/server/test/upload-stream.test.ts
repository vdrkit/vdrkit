// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { LocalKeyProvider } from '../src/crypto/envelope.js';
import { DbKeyring } from '../src/crypto/keyring.js';
import { MemoryStorage, type Storage } from '../src/pipeline/pipeline.js';
import { LocalDiskStorage } from '../src/storage/index.js';
import { MemoryQueue } from '../src/worker/jobs.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';


let h: Heron;
let app: FastifyInstance;
let dir: string;

async function start(storage: Storage) {
  const keyring = new DbKeyring(new LocalKeyProvider(randomBytes(32).toString('base64')));
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at, storage, keyring, queue: new MemoryQueue() });
}

beforeEach(async () => {
  h = await heron();
  dir = await mkdtemp(join(tmpdir(), 'vdrkit-upload-stream-'));
});
afterEach(async () => { await app.close(); await h.pg.close(); await rm(dir, { recursive: true, force: true }); });

const W = () => `/v1/workspaces/${h.ws}`;
const headers = () => ({ 'x-dev-person': h.person.maria, 'x-dev-tenant': h.t1 });
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function lazyBody(total: number, chunk = 64 * 1024) {
  const stats = { read: 0 };
  const stream = new Readable({
    read() {
      if (stats.read >= total) { this.push(null); return; }
      const n = Math.min(chunk, total - stats.read);
      stats.read += n;
      this.push(Buffer.alloc(n, 7));
    },
  });
  return { stream, stats };
}

async function startSession(bytes: Buffer, declaredSize = bytes.length) {
  const res = await app.inject({ method: 'POST', url: `${W()}/upload-sessions`, headers: headers(),
    payload: { targetFolderId: h.node.aud, path: 'Letter.pdf', size: declaredSize, sha256: sha(bytes), mime: 'application/pdf' } });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; uploadUrl: string };
}

const put = (url: string, payload: Buffer | Readable, extra: Record<string, string> = {}) =>
  app.inject({ method: 'PUT', url, headers: { ...headers(), 'content-type': 'application/octet-stream', ...extra }, payload });

async function filesIn(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(root, { withFileTypes: true, recursive: true })) if (e.isFile()) out.push(e.name);
  return out;
}

describe('streamed uploads', () => {
  it('rejects a missing session early', async () => {
    await start(new LocalDiskStorage(dir));
    const total = 256 * 1024 * 1024;
    const { stream, stats } = lazyBody(total);
    const res = await put(`${W()}/upload-sessions/${randomUUID()}/content`, stream);
    expect(res.statusCode).toBe(404);
    expect(res.headers.connection).toBe('close');
    expect(stats.read).toBeLessThan(total / 16);
    expect(await filesIn(dir)).toEqual([]);
  });

  it('rejects sessions of other people', async () => {
    await start(new LocalDiskStorage(dir));
    const s = await startSession(Buffer.from('%PDF-1.4 hello'));
    const total = 64 * 1024 * 1024;
    const { stream, stats } = lazyBody(total);
    const res = await app.inject({ method: 'PUT', url: s.uploadUrl, payload: stream,
      headers: { 'x-dev-person': h.person.anika, 'x-dev-tenant': h.t1, 'content-type': 'application/octet-stream' } });
    expect(res.statusCode).toBe(404);
    expect(stats.read).toBeLessThan(total / 4);
  });

  it('checks Content-Length first', async () => {
    await start(new LocalDiskStorage(dir));
    const s = await startSession(Buffer.from('%PDF-1.4 hello'));
    const { stream, stats } = lazyBody(64 * 1024 * 1024);
    const res = await put(s.uploadUrl, stream, { 'content-length': String(64 * 1024 * 1024) });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain('were declared');
    expect(stats.read).toBeLessThan(16 * 1024 * 1024);
    expect(await filesIn(dir)).toEqual([]);
  });

  it('stops at the declared size', async () => {
    await start(new LocalDiskStorage(dir));
    const declared = 1024 * 1024;
    const s = await startSession(Buffer.alloc(declared, 7));
    const total = 64 * 1024 * 1024;
    const { stream, stats } = lazyBody(total);
    const res = await put(s.uploadUrl, stream);
    expect(res.statusCode).toBe(400);
    expect(stats.read).toBeLessThan(total / 4);
    expect(await filesIn(dir)).toEqual([]);
  });

  it('should drop a short body', async () => {
    await start(new LocalDiskStorage(dir));
    const bytes = Buffer.from('%PDF-1.4 hello');
    const s = await startSession(bytes, bytes.length + 10);
    const res = await put(s.uploadUrl, Readable.from([bytes]));
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain(`${bytes.length} bytes`);
    expect(await filesIn(dir)).toEqual([]);
  });

  it('streams to quarantine on disk', async () => {
    await start(new LocalDiskStorage(dir));
    const bytes = randomBytes(3 * 1024 * 1024 + 17);
    const s = await startSession(bytes);
    const res = await put(s.uploadUrl, Readable.from([bytes.subarray(0, 1000), bytes.subarray(1000)]));
    expect(res.statusCode).toBe(204);
    const store = new LocalDiskStorage(dir);
    expect(sha(await store.get(`quarantine/${h.ws}/${s.id}`))).toBe(sha(bytes));
    expect((await filesIn(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('falls back to a Buffer', async () => {
    const memory = new MemoryStorage();
    await start(memory);
    const bytes = Buffer.from('%PDF-1.4 hello');
    const s = await startSession(bytes);
    expect((await put(s.uploadUrl, bytes)).statusCode).toBe(204);
    expect(memory.objects.get(`quarantine/${h.ws}/${s.id}`)?.equals(bytes)).toBe(true);
  });

  it('cleans up after a cancel', async () => {
    let arrived!: () => void;
    let resume!: () => void;
    const streaming = new Promise<void>((r) => { arrived = r; });
    const held = new Promise<void>((r) => { resume = r; });
    class SlowStorage extends MemoryStorage {
      override async put(key: string, body: Buffer) {
        arrived();
        await held;
        await super.put(key, body);
      }
    }
    const memory = new SlowStorage();
    await start(memory);
    const bytes = Buffer.from('%PDF-1.4 the unencrypted letter');
    const s = await startSession(bytes);
    const sending = put(s.uploadUrl, bytes);
    await streaming;
    const cancel = await app.inject({ method: 'DELETE', url: `${W()}/upload-sessions/${s.id}`, headers: headers() });
    expect(cancel.statusCode).toBe(204);
    resume();
    const res = await sending;
    expect([res.statusCode, res.json().detail]).toEqual([409, 'This upload is no longer open.']);
    expect([...memory.objects.keys()].filter((k) => k.startsWith('quarantine/'))).toEqual([]);
  });
});

describe('LocalDiskStorage.putStream', () => {
  it('cleans up a failed stream', async () => {
    const store = new LocalDiskStorage(dir);
    const failing = new Readable({
      read() { this.push(Buffer.alloc(1024)); this.destroy(new Error('connection reset')); },
    });
    await expect(store.putStream('quarantine/a/b', failing)).rejects.toThrow('connection reset');
    expect(await filesIn(dir)).toEqual([]);
    expect(await store.size('quarantine/a/b')).toBeNull();
  });
});
