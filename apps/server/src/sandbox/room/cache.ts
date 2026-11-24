// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';
import { withTenant, type Database, type TenantOptions } from '@vdrkit/core';
import { decryptBuffer, encryptBuffer } from '../../crypto/envelope.js';
import { indexText, parseExtractedText } from '../../pipeline/extract-text.js';
import { GotenbergClient, runPipeline, ServiceUnavailable, type Derived } from '../../pipeline/pipeline.js';
import type { ClamAvClient } from '../../pipeline/virus-scan.js';
import { LocalDiskStorage } from '../../storage/local-disk.js';
import { PIPELINE_STEPS } from '../../worker/jobs.js';
import { SandboxRefused } from '../check.js';
import { allSandboxDocuments, versionIdOf, versionsOf, workspaceOf, type RoomDoc } from './catalogue.js';
import { renderDocument } from './render.js';

// bump when generators, layout or Office writers change
export const CONTENT_VERSION = 2;

export const CACHE_MARKER = '.vdrkit-sandbox-cache';
const MANIFEST = 'manifest.json';

export interface KeyRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  version: number;
  provider: string;
  provider_key_version: number;
  wrapped: string;
  created_at: string;
  destroyed_at: null;
}

export interface CachedVersion {
  id: string;
  workspaceId: string;
  ix: string;
  versionNo: number;
  storageKey: string;
  sha256: string;
  size: number;
  pageCount: number | null;
  facts: { virusScan: unknown; virusSignature: unknown; previewSkipped: unknown };
  derived: Derived[];
  stored: Record<string, number>;
}

export interface Manifest {
  format: 2;
  fingerprint: string;
  tenantId: string;
  keys: KeyRow[];
  converter: 'gotenberg' | 'rendition' | 'mixed';
  builtAt: string;
  buildSeconds: number;
  versions: CachedVersion[];
}

export interface RoomKey { row: KeyRow; dataKey: Buffer }

export interface CacheOptions {
  dir: string;
  tenantId: string;
  keys: Map<string, RoomKey>;
  gotenbergUrl?: string | null;
  clamav?: ClamAvClient | null;
  documents?: (d: RoomDoc) => boolean;
  concurrency?: number;
  log?: (msg: string) => void;
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function selected(o: Pick<CacheOptions, 'documents'>): RoomDoc[] {
  return allSandboxDocuments().filter((d) => !o.documents || o.documents(d));
}

export function fingerprint(o: Pick<CacheOptions, 'documents'>): string {
  const docs = selected(o).map((d) => [d.room ?? 'heron', d.ix, d.name, d.ext, d.kind, d.p, d.pages, d.status, versionsOf(d)]);
  return sha(JSON.stringify({ CONTENT_VERSION, docs }));
}

async function safeCacheDir(dir: string, storageDir?: string): Promise<string> {
  const abs = resolve(dir);
  if (parse(abs).root === abs || abs.split(/[\\/]/).filter(Boolean).length < 2 || (storageDir && resolve(storageDir) === abs)) {
    throw new SandboxRefused(`The sandbox cache folder ${abs} is a root or the files folder itself. Give the cache a folder of its own.`);
  }
  if (existsSync(abs)) {
    const entries = await readdir(abs);
    if (entries.length && !entries.includes(CACHE_MARKER)) {
      throw new SandboxRefused(`The folder ${abs} is not empty and is not the sandbox cache (it has no ${CACHE_MARKER} file). The sandbox reset leaves it alone.`);
    }
  }
  return abs;
}

export async function usableCache(o: Pick<CacheOptions, 'dir' | 'keys' | 'documents' | 'tenantId'>,
  log: (msg: string) => void = () => {}): Promise<Manifest | null> {
  const file = join(o.dir, MANIFEST);
  if (!existsSync(file)) return null;
  let m: Manifest;
  try {
    m = JSON.parse(await readFile(file, 'utf8')) as Manifest;
  } catch {
    log('The sandbox cache manifest cannot be read; building the cache again.');
    return null;
  }
  if (m.format !== 2 || m.fingerprint !== fingerprint(o) || m.tenantId !== o.tenantId) {
    log('The sandbox room has changed since the cache was built; building it again.');
    return null;
  }
  for (const v of m.versions) {
    const want = o.keys.get(v.workspaceId)?.row;
    const had = m.keys.find((k) => k.workspace_id === v.workspaceId);
    if (!want || !had || had.wrapped !== want.wrapped || had.version !== want.version) {
      log('The cache was built under another data key; building it again.');
      return null;
    }
  }
  for (const v of m.versions) {
    for (const [key, size] of Object.entries(v.stored)) {
      const s = await stat(join(o.dir, 'files', ...key.split('/'))).catch(() => null);
      if (!s || s.size !== size) {
        log(`The cache is missing ${key}; building it again.`);
        return null;
      }
    }
  }
  return m;
}

// falls back to the generated rendition once Gotenberg is down
class BuildConverter extends GotenbergClient {
  used = new Set<'gotenberg' | 'rendition'>();
  private down = false;
  constructor(private readonly real: GotenbergClient | null, private readonly renditions: Map<string, Buffer>, private readonly log: (m: string) => void) {
    super('http://gotenberg.invalid');
  }
  override async officeToPdf(filename: string, body: Buffer): Promise<Buffer> {
    if (this.real && !this.down) {
      try {
        const pdf = await this.real.officeToPdf(filename, body);
        this.used.add('gotenberg');
        return pdf;
      } catch (e) {
        if (!(e instanceof ServiceUnavailable)) throw e;
        this.down = true;
        this.log(`Gotenberg is not reachable (${e.message}); the remaining Office files use their generated PDFs.`);
      }
    }
    const pdf = this.renditions.get(sha(body));
    if (!pdf) throw new Error(`No converter for ${filename}.`);
    this.used.add('rendition');
    return pdf;
  }
}

export async function buildCache(o: CacheOptions & { storageDir?: string }): Promise<Manifest> {
  const log = o.log ?? (() => undefined);
  const dir = await safeCacheDir(o.dir, o.storageDir);
  // swap in at the end; a failed build keeps the old cache
  const tmp = await safeCacheDir(`${dir}.new`, o.storageDir);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(join(tmp, 'files'), { recursive: true });
  await writeFile(join(tmp, CACHE_MARKER), 'The VDRkit sandbox cache: processed files of the sandbox room. sandbox-reset rebuilds it when needed.\n');
  const storage = new LocalDiskStorage(join(tmp, 'files'));
  const renditions = new Map<string, Buffer>();
  const converter = new BuildConverter(o.gotenbergUrl ? new GotenbergClient(o.gotenbergUrl) : null, renditions, log);
  const steps = PIPELINE_STEPS({ clamav: o.clamav ?? null, gotenberg: converter });
  const jobs = selected(o).flatMap((d) => versionsOf(d).map((v) => ({ d, v })));
  const out: CachedVersion[] = new Array(jobs.length);
  const started = Date.now();
  let next = 0;
  let done = 0;
  let pages = 0;

  async function one(i: number): Promise<void> {
    const { d, v } = jobs[i]!;
    const r = await renderDocument(d, v);
    if (r.rendition) renditions.set(sha(r.original), r.rendition);
    const id = versionIdOf(o.tenantId, d, v);
    const ws = workspaceOf(o.tenantId, d);
    const key = o.keys.get(ws);
    if (!key) throw new Error(`No data key for the room of ${d.room ?? 'heron'} ${d.ix}.`);
    const storageKey = `ws/${ws}/v/${id}/original`;
    await storage.put(storageKey, await encryptBuffer(key.dataKey, r.original, storageKey));
    const original = { versionId: id, workspaceId: ws, storageKey, filename: r.filename, mime: r.mime };
    const res = await runPipeline(original, steps, storage, key.dataKey);
    if (!res.ok) throw new Error(`Processing ${d.ix} version ${v} (${r.filename}) failed at ${res.failedStep}: ${res.error}`);
    const pageCount = typeof res.facts.pageCount === 'number' ? res.facts.pageCount : null;
    if (!pageCount) throw new Error(`${d.ix} version ${v} (${r.filename}) has no pages.`);
    const stored: Record<string, number> = {};
    for (const key of [storageKey, ...res.derived.map((x) => x.storageKey)]) stored[key] = (await storage.size(key)) ?? -1;
    out[i] = {
      id, workspaceId: ws, ix: d.ix, versionNo: v, storageKey, sha256: sha(r.original), size: r.original.length, pageCount,
      facts: { virusScan: res.facts.virusScan ?? null, virusSignature: res.facts.virusSignature ?? null, previewSkipped: res.facts.previewSkipped ?? null },
      derived: res.derived, stored,
    };
    done++;
    pages += pageCount;
    if (done % 25 === 0 || done === jobs.length) {
      log(`  processed ${done} of ${jobs.length} files, ${pages} pages, ${Math.round((Date.now() - started) / 1000)} s`);
    }
  }

  // first failure stops every worker
  let failed = false;
  const workers = Array.from({ length: Math.max(1, o.concurrency ?? 2) }, async () => {
    while (!failed && next < jobs.length) {
      try {
        await one(next++);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  });
  await Promise.all(workers);

  let used: Manifest['converter'] = converter.used.has('gotenberg') ? 'gotenberg' : 'rendition';
  if (converter.used.size === 2) used = 'mixed';
  const rooms = new Set(out.map((v) => v.workspaceId));
  const manifest: Manifest = {
    format: 2, fingerprint: fingerprint(o), tenantId: o.tenantId, keys: [...rooms].map((w) => o.keys.get(w)!.row),
    converter: used,
    builtAt: new Date().toISOString(), buildSeconds: Math.round((Date.now() - started) / 1000), versions: out,
  };
  await writeFile(join(tmp, MANIFEST), JSON.stringify(manifest));
  await rm(dir, { recursive: true, force: true });
  await rename(tmp, dir);
  log(`Built the sandbox cache: ${out.length} files, ${pages} pages, in ${manifest.buildSeconds} s (Office files: ${manifest.converter}).`);
  return manifest;
}

export async function ensureCache(o: CacheOptions & { storageDir?: string }): Promise<{ manifest: Manifest; built: boolean }> {
  await safeCacheDir(o.dir, o.storageDir);
  const ok = await usableCache(o, o.log);
  if (ok) return { manifest: ok, built: false };
  return { manifest: await buildCache(o), built: true };
}

export async function restoreCache(o: {
  manifest: Manifest; dir: string; storageDir: string; db: Database; tenantOpts: TenantOptions; keys: Map<string, RoomKey>;
}): Promise<{ versions: number; pages: number }> {
  const m = o.manifest;
  await cp(join(o.dir, 'files'), o.storageDir, { recursive: true, force: true });
  const storage = new LocalDiskStorage(o.storageDir);
  const texts = new Map<string, string[]>();
  for (const v of m.versions) {
    const t = v.derived.find((x) => x.kind === 'text');
    if (!t) continue;
    const body = await decryptBuffer(o.keys.get(v.workspaceId)!.dataKey, await storage.get(t.storageKey), t.storageKey);
    texts.set(v.id, parseExtractedText(body));
  }
  const keyVersion = (v: CachedVersion) => m.keys.find((k) => k.workspace_id === v.workspaceId)!.version;
  await withTenant(o.db, m.tenantId, async (tx) => {
    const rows = m.versions.map((v) => ({
      id: v.id, storage_key: v.storageKey, sha256: v.sha256, size: v.size, key_version: keyVersion(v), page_count: v.pageCount,
      meta: JSON.stringify(Object.fromEntries(Object.entries({ sandboxFile: true, pageCount: v.pageCount, ...v.facts }).filter(([, x]) => x != null))),
    }));
    const updated = await tx.query<{ id: string }>(
      `update document_version d
          set storage_key = x.storage_key, sha256 = x.sha256, size_bytes = x.size, key_version = x.key_version, page_count = x.page_count,
              processing_status = 'ready', processing_error = null, failed_step = null,
              metadata = (d.metadata - 'placeholder') || x.meta::jsonb
         from json_to_recordset($1::json) as x(id uuid, storage_key text, sha256 text, size bigint, key_version int, page_count int, meta text)
        where d.id = x.id
       returning d.id`, [JSON.stringify(rows)]);
    if (updated.rows.length !== rows.length) {
      throw new Error(`The sandbox cache holds ${rows.length} versions, but only ${updated.rows.length} are in the room. Raise CONTENT_VERSION or delete the cache.`);
    }
    const derived = m.versions.flatMap((v) => v.derived.map((d) => ({
      version_id: v.id, kind: d.kind, step: d.step, storage_key: d.storageKey, sha256: d.sha256, key_version: keyVersion(v),
      metadata: JSON.stringify({ ...d.meta, size: d.size }),
    })));
    await tx.query(
      `insert into derived_file (tenant_id, version_id, kind, step, storage_key, sha256, key_version, metadata)
       select current_tenant_id(), x.version_id, x.kind, x.step, x.storage_key, x.sha256, x.key_version, x.metadata::jsonb
         from json_to_recordset($1::json) as x(version_id uuid, kind text, step text, storage_key text, sha256 text, key_version int, metadata text)`,
      [JSON.stringify(derived)]);
    const nodes = new Map((await tx.query<{ id: string; node_id: string }>(`select id, node_id from document_version where id = any($1::uuid[])`,
      [m.versions.map((v) => v.id)])).rows.map((r) => [r.id, r.node_id]));
    for (const v of m.versions) {
      await indexText(tx, { workspaceId: v.workspaceId, nodeId: nodes.get(v.id)!, versionId: v.id, pages: texts.get(v.id) ?? [] });
    }
  }, o.tenantOpts);
  return { versions: m.versions.length, pages: m.versions.reduce((s, v) => s + (v.pageCount ?? 0), 0) };
}

export function newKeyRow(tenantId: string, workspaceId: string, wrapped: { provider: string; keyVersion: number; blob: string }): KeyRow {
  return {
    id: randomUUID(), tenant_id: tenantId, workspace_id: workspaceId, version: 1, provider: wrapped.provider, provider_key_version: wrapped.keyVersion,
    wrapped: wrapped.blob, created_at: new Date().toISOString(), destroyed_at: null,
  };
}

export async function cachedKeys(dir: string): Promise<KeyRow[]> {
  try {
    const m = JSON.parse(await readFile(join(dir, MANIFEST), 'utf8')) as Partial<Manifest>;
    return Array.isArray(m.keys) ? m.keys : [];
  } catch {
    return [];
  }
}

export async function cacheSize(dir: string): Promise<number> {
  let n = 0;
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(d, e.name));
      else n += (await stat(join(d, e.name))).size;
    }
  };
  if (existsSync(dir)) await walk(dir);
  return n;
}
