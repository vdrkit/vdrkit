// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalDiskStorage, S3Storage, storageFromEnv } from '../src/storage/index.js';


const body = (req: IncomingMessage) => new Promise<Buffer>((resolve) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks)));
});

let server: Server;
let endpoint: string;
const objects = new Map<string, Buffer>();
const uploads = new Map<string, Map<number, Buffer>>();
const seen: string[] = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    const key = decodeURIComponent(url.pathname);
    const q = url.searchParams;
    seen.push(`${req.method} ${key}${q.has('uploads') ? '?uploads' : ''}${q.has('partNumber') ? `?part=${q.get('partNumber')}` : ''}${q.has('X-Amz-Signature') ? ' signed' : ''}`);
    const data = await body(req);
    const xml = (s: string) => res.writeHead(200, { 'content-type': 'application/xml' }).end(`<?xml version="1.0" encoding="UTF-8"?>${s}`);
    if (req.method === 'POST' && q.has('uploads')) {
      const id = `u${uploads.size + 1}`;
      uploads.set(id, new Map());
      return xml(`<InitiateMultipartUploadResult><Bucket>vdrkit</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (req.method === 'PUT' && q.has('partNumber')) {
      uploads.get(q.get('uploadId')!)!.set(Number(q.get('partNumber')), data);
      return res.writeHead(200, { etag: `"p${q.get('partNumber')}"` }).end();
    }
    if (req.method === 'POST' && q.has('uploadId')) {
      const parts = uploads.get(q.get('uploadId')!)!;
      const numbers = [...data.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => Number(m[1]));
      objects.set(key, Buffer.concat(numbers.map((n) => parts.get(n)!)));
      uploads.delete(q.get('uploadId')!);
      return xml(`<CompleteMultipartUploadResult><Key>${key}</Key><ETag>"done"</ETag></CompleteMultipartUploadResult>`);
    }
    if (req.method === 'DELETE' && q.has('uploadId')) { uploads.delete(q.get('uploadId')!); return res.writeHead(204).end(); }
    if (req.method === 'PUT') { objects.set(key, data); return res.writeHead(200, { etag: '"x"' }).end(); }
    if (req.method === 'DELETE') { objects.delete(key); return res.writeHead(204).end(); }
    if (req.method === 'HEAD') {
      const o = objects.get(key);
      return o ? res.writeHead(200, { 'content-length': o.length }).end() : res.writeHead(404).end();
    }
    if (req.method === 'GET') {
      const o = objects.get(key);
      if (!o) {
        return res.writeHead(404, { 'content-type': 'application/xml' })
          .end('<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>Not found</Message></Error>');
      }
      return res.writeHead(200, { 'content-length': o.length }).end(o);
    }
    res.writeHead(400).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const s3 = () => new S3Storage({ endpoint, region: 'us-east-1', bucket: 'vdrkit', accessKeyId: 'test', secretAccessKey: 'test', forcePathStyle: true });

describe('S3Storage', () => {
  it('puts, gets and deletes objects with path-style URLs', async () => {
    const store = s3();
    await store.put('ws/1/v/2/original', Buffer.from('sealed bytes'));
    expect(objects.get('/vdrkit/ws/1/v/2/original')?.toString()).toBe('sealed bytes');
    expect((await store.get('ws/1/v/2/original')).toString()).toBe('sealed bytes');
    await store.delete('ws/1/v/2/original');
    await expect(store.get('ws/1/v/2/original')).rejects.toThrow('No object at ws/1/v/2/original');
  });

  it('presigns multipart part URLs and joins the parts', async () => {
    const store = s3();
    const { uploadId, urls } = await store.multipart.start('quarantine/w/s1', [12, 11], 3600);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain(`${endpoint}/vdrkit/quarantine/w/s1?`);
    expect(urls[0]).toContain('X-Amz-Expires=3600');
    // part length is signed into the URL
    expect(new URL(urls[0]!).searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
    const etags = [];
    for (const [i, part] of ['first half, ', 'second half'].entries()) {
      const res = await fetch(urls[i]!, { method: 'PUT', body: part });
      expect(res.status).toBe(200);
      etags.push({ partNumber: i + 1, etag: res.headers.get('etag')! });
    }
    await store.multipart.complete('quarantine/w/s1', uploadId, etags.reverse());
    expect((await store.get('quarantine/w/s1')).toString()).toBe('first half, second half');
    expect(await store.size('quarantine/w/s1')).toBe(23);
    expect(await store.size('quarantine/w/none')).toBeNull();
    expect(seen.filter((s) => s.includes('?part=')).every((s) => s.endsWith(' signed'))).toBe(true);
  });

  it('aborts a multipart upload', async () => {
    const store = s3();
    const { uploadId } = await store.multipart.start('quarantine/w/s2', [5], 60);
    await store.multipart.abort('quarantine/w/s2', uploadId);
    expect(uploads.has(uploadId)).toBe(false);
  });
});

describe('LocalDiskStorage', () => {
  it('refuses keys outside its folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vdrkit-storage-'));
    try {
      const store = new LocalDiskStorage(dir);
      await store.put('ws/1/v/2/original', Buffer.from('abc'));
      expect((await store.get('ws/1/v/2/original')).toString()).toBe('abc');
      expect(await store.size('ws/1/v/2/original')).toBe(3);
      expect(await store.size('ws/1/v/9/original')).toBeNull();
      await store.delete('ws/1/v/2/original');
      await store.delete('ws/1/v/2/original');
      await expect(store.get('ws/1/v/2/original')).rejects.toThrow('No object at');
      for (const bad of ['../escape', 'ws/../../escape', '/abs', 'a\\b', 'a//b', '']) {
        await expect(store.put(bad, Buffer.from('x'))).rejects.toThrow('Invalid storage key');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('driver selection', () => {
  it('picks s3 or local, and refuses an unknown driver', () => {
    expect(storageFromEnv({})).toBeUndefined();
    expect(storageFromEnv({ STORAGE_DRIVER: 'local', STORAGE_LOCAL_DIR: tmpdir() })).toBeInstanceOf(LocalDiskStorage);
    const s = storageFromEnv({ S3_BUCKET: 'vdrkit', S3_ENDPOINT: endpoint, S3_FORCE_PATH_STYLE: 'true' });
    expect(s).toBeInstanceOf(S3Storage);
    expect((s as S3Storage).bucket).toBe('vdrkit');
    expect(() => storageFromEnv({ STORAGE_DRIVER: 's3' })).toThrow('S3_BUCKET');
    expect(() => storageFromEnv({ STORAGE_DRIVER: 'ftp' })).toThrow('Unknown STORAGE_DRIVER');
  });
});
