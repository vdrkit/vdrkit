// SPDX-License-Identifier: AGPL-3.0-only
// Dev only: push one large file through the API and report its peak memory
//   tsx --tsconfig tsconfig.dev.json scripts/large-file-check.ts --storage local|s3 --port 4102 --file big.bin
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
function arg(name: string, fallback?: string) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1]! : fallback;
}
const MiB = 1024 * 1024;

if (process.env.NODE_ENV === 'production') { console.error('large-file-check is for development only.'); process.exit(1); }

if (args[0] === 'serve') await serve();
else await check();

async function serve() {
  process.env.NODE_ENV = 'test';
  const { PGlite } = await import('@electric-sql/pglite');
  const { ltree } = await import('@electric-sql/pglite/contrib/ltree');
  const { fromPGlite, migrate, withTenant } = await import('@vdrkit/core');
  const { seedDemo } = await import('../src/demo/seed-demo.js');
  const { buildApp, DevHeaderAuthenticator } = await import('../src/index.js');
  const { DbKeyring } = await import('../src/crypto/keyring.js');
  const { LocalKeyProvider } = await import('../src/crypto/envelope.js');
  const { storageFromEnv } = await import('../src/storage/index.js');
  const storage = storageFromEnv();
  if (!storage) throw new Error('Set STORAGE_DRIVER=local with STORAGE_LOCAL_DIR, or the S3_* settings.');
  const db = fromPGlite(new PGlite({ extensions: { ltree } }));
  await migrate(db);
  const room = await seedDemo(db, { role: 'vdrkit_app' });
  const folder = await withTenant(db, room.tenantId, async (tx) => (await tx.query<{ id: string }>(
    `select id from node where workspace_id = $1 and kind = 'folder' and parent_id is null order by index_number limit 1`, [room.workspaceId])).rows[0]!.id,
  { role: 'vdrkit_app' });
  // no worker here; fake the virus step or downloads stay blocked
  const queue = {
    async enqueue(_name: string, payload: Record<string, unknown>) {
      await withTenant(db, String(payload.tenantId), (tx) => tx.query(
        `update document_version set metadata = metadata || '{"virusScan": "not_configured"}' where id = $1`, [payload.versionId]), { role: 'vdrkit_app' });
    },
  };
  const app = await buildApp({
    db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', storage, rateLimit: false, logger: process.env.LARGE_FILE_LOG === '1',
    keyring: new DbKeyring(new LocalKeyProvider(randomBytes(32).toString('base64'))), queue, site: { setup: false },
  });
  const mem = { baseline: 0, peakRss: 0, peakHeap: 0, peakExternal: 0, peakArrayBuffers: 0 };
  const sample = () => {
    const m = process.memoryUsage();
    mem.peakRss = Math.max(mem.peakRss, m.rss);
    mem.peakHeap = Math.max(mem.peakHeap, m.heapUsed);
    mem.peakExternal = Math.max(mem.peakExternal, m.external);
    mem.peakArrayBuffers = Math.max(mem.peakArrayBuffers, m.arrayBuffers);
  };
  setInterval(sample, 50).unref();
  app.get('/__memory', async (req) => {
    if ((req.query as { reset?: string }).reset) {
      global.gc?.();
      const m = process.memoryUsage();
      Object.assign(mem, { baseline: m.rss, peakRss: m.rss, peakHeap: m.heapUsed, peakExternal: m.external, peakArrayBuffers: m.arrayBuffers });
    }
    sample();
    return { ...mem, now: process.memoryUsage().rss, maxRssOs: process.resourceUsage().maxRSS * 1024 };
  });
  await app.listen({ host: '127.0.0.1', port: Number(arg('--port', '4102')) });
  console.log(JSON.stringify({ ready: true, ws: room.workspaceId, tenant: room.tenantId, person: room.person.anika, folder }));
}

async function check() {
  const port = Number(arg('--port', '4102'));
  const size = Number(arg('--size', String(Math.round(1.2 * 1024 * MiB))));
  const storageKind = arg('--storage', 'local')!;
  const tmp = await mkdtemp(join(tmpdir(), 'vdrkit-large-'));
  const file = resolve(arg('--file', join(tmp, 'large.bin'))!);

  const sha = await ensureFile(file, size);
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test' };
  if (storageKind === 'local') Object.assign(env, { STORAGE_DRIVER: 'local', STORAGE_LOCAL_DIR: join(tmp, 'storage') });
  else env.STORAGE_DRIVER = 's3';

  const here = fileURLToPath(new URL('.', import.meta.url));
  const child = spawn(process.execPath, ['--expose-gc', '--import', 'tsx', fileURLToPath(import.meta.url), 'serve', '--port', String(port)],
    { cwd: resolve(here, '..'), env: { ...env, TSX_TSCONFIG_PATH: resolve(here, '../tsconfig.dev.json') }, stdio: ['ignore', 'pipe', 'inherit'] });
  const ids = await new Promise<{ ws: string; tenant: string; person: string; folder: string }>((ok, fail) => {
    let out = '';
    child.stdout!.on('data', (d: Buffer) => {
      if (process.env.LARGE_FILE_LOG === '1') process.stderr.write(d);
      out += d.toString();
      const line = out.split('\n').find((l) => l.startsWith('{"ready"'));
      if (line) ok(JSON.parse(line));
    });
    child.on('exit', (c) => fail(new Error(`The API stopped (${c}).`)));
  });
  console.log(`API pid ${child.pid} on port ${port}, storage ${storageKind}, file ${(size / MiB).toFixed(0)} MiB`);
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'x-dev-person': ids.person, 'x-dev-tenant': ids.tenant };
  const json = async (method: string, path: string, body?: unknown) => {
    const init: RequestInit = { method, headers };
    if (body) {
      init.headers = { ...headers, 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(base + path, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };

  try {
    const baseline = await json('GET', '/__memory?reset=1');
    const t0 = Date.now();
    const s = await json('POST', `/v1/workspaces/${ids.ws}/upload-sessions`,
      { targetFolderId: ids.folder, path: 'Large/Data room export.zip', size, sha256: sha, mime: 'application/zip' });
    let parts: { partNumber: number; etag: string }[] | undefined;
    if (s.method === 'direct') {
      await put(base + s.uploadUrl, file, 0, size - 1, { ...headers, 'content-type': 'application/octet-stream' });
    } else {
      parts = [];
      const queue = [...s.parts] as { partNumber: number; url: string }[];
      const worker = async () => {
        for (let p = queue.shift(); p; p = queue.shift()) {
          const from = (p.partNumber - 1) * s.partSize;
          const etag = await put(p.url, file, from, Math.min(size, from + s.partSize) - 1, {});
          parts!.push({ partNumber: p.partNumber, etag });
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
    }
    const t1 = Date.now();
    const done = await json('POST', `/v1/workspaces/${ids.ws}/upload-sessions/${s.id}/complete`, parts ? { parts } : {});
    const t2 = Date.now();
    const afterUpload = await json('GET', '/__memory');

    const download = `${base}/v1/workspaces/${ids.ws}/nodes/${done.nodeId}/download?format=original`;
    const dl = await hashDownload(download, headers);
    const t3 = Date.now();
    const from = size - 10 * MiB - 3;
    const ranged = await hashDownload(download, { ...headers, range: `bytes=${from}-` });
    const expected = await hashFile(file, from, size - 1);
    const end = await json('GET', '/__memory');
    const mib = (n: number) => `${(n / MiB).toFixed(0)} MiB`;
    console.log(JSON.stringify({
      storage: storageKind, sizeBytes: size, method: s.method, sha256Matches: dl.sha === sha, downloadedBytes: dl.bytes,
      rangeStatus: ranged.status, rangeMatches: ranged.sha === expected && ranged.bytes === size - from,
      seconds: { send: (t1 - t0) / 1000, complete: (t2 - t1) / 1000, download: (t3 - t2) / 1000 },
      memory: { baselineRss: mib(baseline.baseline), peakRssUpload: mib(afterUpload.peakRss), peakRss: mib(end.peakRss),
        peakAboveBaseline: mib(end.peakRss - baseline.baseline), peakHeapUsed: mib(end.peakHeap), peakArrayBuffers: mib(end.peakArrayBuffers), osMaxRss: mib(end.maxRssOs) },
    }, null, 2));
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function ensureFile(file: string, size: number): Promise<string> {
  if (!existsSync(file) || statSync(file).size !== size) {
    const out = createWriteStream(file);
    const block = randomBytes(MiB);
    for (let written = 0; written < size;) {
      const n = Math.min(MiB, size - written);
      // defeat dedup
      block.writeUInt32BE(written / MiB, 0);
      if (!out.write(block.subarray(0, n))) await new Promise((r) => out.once('drain', r));
      written += n;
    }
    await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
  }
  return hashFile(file);
}

async function hashFile(file: string, start?: number, end?: number): Promise<string> {
  const h = createHash('sha256');
  for await (const c of createReadStream(file, start !== undefined ? { start, end } : {})) h.update(c as Buffer);
  return h.digest('hex');
}

function put(url: string, file: string, start: number, end: number, headers: Record<string, string>): Promise<string> {
  const u = new URL(url);
  const send = u.protocol === 'https:' ? httpsRequest : request;
  return new Promise((ok, fail) => {
    const req = send(u, { method: 'PUT', headers: { ...headers, 'content-length': end - start + 1 } }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => { body += d.toString(); });
      res.on('end', () => (res.statusCode! < 300 ? ok(String(res.headers.etag ?? '')) : fail(new Error(`PUT ${u.pathname}: ${res.statusCode} ${body}`))));
    });
    req.on('error', fail);
    createReadStream(file, { start, end }).pipe(req);
  });
}

function hashDownload(url: string, headers: Record<string, string>): Promise<{ sha: string; bytes: number; status: number }> {
  return new Promise((ok, fail) => {
    request(url, { headers }, (res) => {
      const h = createHash('sha256');
      let bytes = 0;
      res.on('data', (d: Buffer) => { h.update(d); bytes += d.length; });
      res.on('end', () => ok({ sha: h.digest('hex'), bytes, status: res.statusCode ?? 0 }));
      res.on('error', fail);
    }).on('error', fail).end();
  });
}
