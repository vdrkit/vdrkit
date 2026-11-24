#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Bulk import via the real upload path (3 transfers ahead, completions in order).
//   node scripts/load/bulk.mjs                 the 400 files of gen-files.mjs
//   node scripts/load/bulk.mjs --big           the 1 GiB file alone
//   node scripts/load/bulk.mjs --no-wait       do not wait for the worker to finish
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { API, ORIGIN, APP_URL, TENANT, WORK, core, pg } from './config.mjs';

const args = process.argv.slice(2);
const big = args.includes('--big');
const S = JSON.parse(readFileSync(`${WORK}/sessions.json`, 'utf8'));
const seller = S.people.find((p) => p.key === 's1');
let cookie = seller.cookie;
const ws = S.heron;
const MIME = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  jpg: 'image/jpeg', zip: 'application/zip' };

async function api(method, path, body, headers = {}) {
  const r = await fetch(`${API}${path}`, { method, headers: { origin: ORIGIN, cookie: `vdrkit.session_token=${cookie}`, ...(body && !(body instanceof Readable) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body instanceof Readable ? body : body ? JSON.stringify(body) : undefined, ...(body instanceof Readable ? { duplex: 'half' } : {}) });
  const sc = r.headers.get('set-cookie');
  const m = sc && /vdrkit\.session_token=([^;]+)/.exec(sc);
  if (m) { cookie = m[1]; seller.cookie = cookie; writeFileSync(`${WORK}/sessions.json`, JSON.stringify(S, null, 1)); }
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function sha256(file) {
  return new Promise((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (c) => h.update(c)).on('end', () => ok(h.digest('hex'))).on('error', fail);
  });
}

const memPeak = () => { try { return JSON.parse(readFileSync(`${WORK}/api-mem.json`, 'utf8')); } catch { return null; } };

async function main() {
  const manifest = big ? { files: [{ path: 'big.pdf', size: statSync(`${WORK}/big.pdf`).size, kind: 'pdf', full: `${WORK}/big.pdf` }] }
    : JSON.parse(readFileSync(`${WORK}/files.json`, 'utf8'));
  const files = manifest.files.map((f) => ({ ...f, full: f.full ?? `${WORK}/files/${f.path}` }));
  const total = files.reduce((a, f) => a + f.size, 0);
  const folder = await api('POST', `/v1/workspaces/${ws}/folders`, { parentId: null, name: `Bulk import ${new Date().toISOString().slice(11, 19)}${big ? ' big' : ''}` });
  console.log(`${files.length} files, ${(total / 1024 ** 3).toFixed(2)} GiB, into folder ${folder.indexNumber}.`);
  const memBefore = memPeak();
  const t0 = Date.now();
  const timings = [];
  let failed = 0;

  async function transfer(f) {
    const t = Date.now();
    const sha = await sha256(f.full);
    const s = await api('POST', `/v1/workspaces/${ws}/upload-sessions`, { targetFolderId: folder.id, path: f.path, size: f.size, sha256: sha, mime: MIME[f.kind] ?? 'application/octet-stream' });
    await api('PUT', s.uploadUrl, Readable.from(createReadStream(f.full)), { 'content-type': 'application/octet-stream', 'content-length': String(f.size) });
    return { s, ms: Date.now() - t };
  }

  const ahead = 3;
  const pending = [];
  let next = 0;
  for (; next < Math.min(ahead, files.length); next++) pending[next] = transfer(files[next]).catch((e) => e);
  const versions = [];
  for (let i = 0; i < files.length; i++) {
    const tr = await pending[i];
    if (tr instanceof Error) { failed++; console.error(`${files[i].path}: ${tr.message}`); }
    else {
      const t = Date.now();
      try {
        const done = await api('POST', `/v1/workspaces/${ws}/upload-sessions/${tr.s.id}/complete`, {});
        versions.push(done.versionId);
        timings.push({ path: files[i].path, size: files[i].size, transferMs: tr.ms, completeMs: Date.now() - t });
      } catch (e) { failed++; console.error(`${files[i].path}: ${e.message}`); }
    }
    if (next < files.length) { pending[next] = transfer(files[next]).catch((e) => e); next++; }
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1} done, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  const uploadMs = Date.now() - t0;
  const mem = memPeak();
  console.log(`Uploaded ${versions.length} of ${files.length} in ${(uploadMs / 1000).toFixed(1)} s (${(total / 1024 ** 2 / (uploadMs / 1000)).toFixed(0)} MiB/s), ${failed} failed.`);
  // none when the API runs in a container
  if (mem) console.log(`API peak RSS ${(mem.rss / 1024 ** 2).toFixed(0)} MiB, heap ${(mem.heapUsed / 1024 ** 2).toFixed(0)} MiB (before: ${memBefore ? (memBefore.rss / 1024 ** 2).toFixed(0) : '?'} MiB).`);
  const slowest = [...timings].sort((a, b) => b.completeMs - a.completeMs)[0];

  const out = { kind: big ? 'big' : 'bulk', files: files.length, bytes: total, uploaded: versions.length, failed, uploadMs, apiPeak: mem, slowestComplete: slowest };
  if (!args.includes('--no-wait')) {
    const pool = new pg.Pool({ connectionString: APP_URL, max: 1 });
    const db = core.fromPgPool(pool);
    const count = () => core.withTenant(db, TENANT, async (tx) => (await tx.query(
      `select processing_status as s, count(*)::int as n from document_version where id = any($1::uuid[]) group by 1`, [versions])).rows);
    let last = '';
    for (;;) {
      const rows = await count();
      const by = Object.fromEntries(rows.map((r) => [r.s, r.n]));
      const line = JSON.stringify(by);
      if (line !== last) { console.log(`  worker ${((Date.now() - t0) / 1000).toFixed(0)} s: ${line}`); last = line; }
      if (!by.pending && !by.processing) { out.drainMs = Date.now() - t0; out.statuses = by; break; }
      await new Promise((r) => setTimeout(r, 2000));
    }
    const failures = await core.withTenant(db, TENANT, async (tx) => (await tx.query(
      `select dv.failed_step, left(dv.processing_error, 160) as error, count(*)::int as n from document_version dv where dv.id = any($1::uuid[]) and dv.processing_status <> 'ready' group by 1, 2`, [versions])).rows);
    const facts = await core.withTenant(db, TENANT, async (tx) => (await tx.query(
      `select coalesce(sum(page_count), 0)::int as pages, jsonb_object_agg(coalesce(s, 'none'), n) as scans
         from (select metadata ->> 'virusScan' as s, count(*)::int as n, sum(page_count) as page_count from document_version where id = any($1::uuid[]) group by 1) x`,
      [versions])).rows[0]);
    out.failures = failures;
    out.facts = facts;
    out.workerPeak = (() => { try { return JSON.parse(readFileSync(`${WORK}/worker-mem.json`, 'utf8')); } catch { return null; } })();
    await pool.end();
    console.log(`Worker done ${(out.drainMs / 1000).toFixed(0)} s after the first upload started: ${JSON.stringify(out.statuses)}; ${facts.pages} pages; scans ${JSON.stringify(facts.scans)}.`);
    if (failures.length) console.log(`Not ready: ${JSON.stringify(failures)}`);
    if (out.workerPeak) console.log(`Worker peak RSS ${(out.workerPeak.rss / 1024 ** 2).toFixed(0)} MiB.`);
  }
  writeFileSync(`${WORK}/bulk-${out.kind}.json`, JSON.stringify(out, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
