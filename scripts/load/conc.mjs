#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// 50 bidders + 5 sellers at once; run bulk.mjs first.
//   node scripts/load/conc.mjs --prepare             grant the bidder groups the latest "Bulk import" folder and publish it
//   node scripts/load/conc.mjs [--minutes 3] [--think 1000] [--label realistic] [--no-images] [--bidders 50] [--sellers 5]
// --think: mean pause between steps, ms (0 = stress)
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { API, ORIGIN, APP_URL, OWNER_URL, TENANT, WORK, core, pg, stats } from './config.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const S = JSON.parse(readFileSync(`${WORK}/sessions.json`, 'utf8'));
// --apis 4601,4602: one person per API
const APIS = (arg('--apis', '') || '').split(',').filter(Boolean).map((p) => `http://127.0.0.1:${p}`);
const apiFor = (who) => (APIS.length ? APIS[[...who].reduce((a, c) => a + c.charCodeAt(0), 0) % APIS.length] : API);
const ws = S.heron;
const jar = new Map(S.people.map((p) => [p.key, p.cookie]));
const save = () => { for (const p of S.people) p.cookie = jar.get(p.key); writeFileSync(`${WORK}/sessions.json`, JSON.stringify(S, null, 1)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lat = new Map();     // kind -> [ms]
const codes = new Map();   // kind:status -> n
let requests = 0;
let bytes = 0;

async function call(who, kind, method, path, body, headers = {}) {
  const t = performance.now();
  let status = 0;
  let text = null;
  try {
    const isStream = body instanceof Readable;
    const r = await fetch(`${apiFor(who)}${path}`, { method, headers: { origin: ORIGIN, cookie: `vdrkit.session_token=${jar.get(who)}`, ...(body && !isStream ? { 'content-type': 'application/json' } : {}), ...headers },
      body: isStream ? body : body ? JSON.stringify(body) : undefined, ...(isStream ? { duplex: 'half' } : {}) });
    status = r.status;
    const sc = r.headers.get('set-cookie');
    const m = sc && /vdrkit\.session_token=([^;]+)/.exec(sc);
    if (m && m[1]) jar.set(who, m[1]);
    const buf = Buffer.from(await r.arrayBuffer());
    bytes += buf.length;
    if ((r.headers.get('content-type') ?? '').includes('json')) text = buf.toString();
  } catch (e) {
    status = `net:${e.cause?.code ?? e.message}`;
  }
  const ms = performance.now() - t;
  requests++;
  if (!lat.has(kind)) lat.set(kind, []);
  lat.get(kind).push(ms);
  const k = `${kind}:${status}`;
  codes.set(k, (codes.get(k) ?? 0) + 1);
  return { status, json: () => (text ? JSON.parse(text) : null) };
}

const owner = () => new pg.Pool({ connectionString: OWNER_URL, max: 1 });

async function bulkFolder(tx) {
  return (await tx.query(`select id, index_number from node where workspace_id = $1 and parent_id is null and name like 'Bulk import%' and name not like '%big'
    order by created_at desc limit 1`, [ws])).rows[0];
}

async function prepare() {
  const pool = new pg.Pool({ connectionString: APP_URL, max: 1 });
  const db = core.fromPgPool(pool);
  const { stableId } = await import(`file:///${(await import('./config.mjs')).ROOT}apps/server/src/demo/seed-demo.ts`);
  const group = (name) => stableId(TENANT, `group:${name}`);
  const { folder, docs } = await core.withTenant(db, TENANT, async (tx) => {
    const folder = await bulkFolder(tx);
    for (const [name, level] of [['Bidder A', 50], ['Bidder B', 20], ['Bidder C', 40], ['Bidder C financiers', 40]]) {
      await core.setGrant(tx, { workspaceId: ws, nodeId: folder.id, subject: { groupId: group(name) }, level, actorId: stableId(TENANT, 'principal:anika') });
    }
    const docs = (await tx.query(`select n.id from node n join node f on f.id = $1 and n.path <@ f.path where n.kind = 'document' and n.state = 'draft'`, [folder.id])).rows.map((r) => r.id);
    return { folder, docs };
  });
  await pool.end();
  const r = await call('s1', 'publish', 'POST', `/v1/workspaces/${ws}/publish`, { nodeIds: docs, quiet: true });
  console.log(`Folder ${folder.index_number}: grants set, publish answered ${r.status} ${JSON.stringify(r.json())}.`);
  save();
}

async function readable() {
  const pool = new pg.Pool({ connectionString: APP_URL, max: 1 });
  const db = core.fromPgPool(pool);
  const out = await core.withTenant(db, TENANT, async (tx) => {
    const folder = await bulkFolder(tx);
    const folders = (await tx.query(`select n.id from node n join node f on f.id = $1 and n.path <@ f.path where n.kind = 'folder'`, [folder.id])).rows.map((r) => r.id);
    const docs = (await tx.query(`select n.id, n.parent_id, coalesce(dv.page_count, 0) as pages from node n join node f on f.id = $1 and n.path <@ f.path
       join document_version dv on dv.node_id = n.id and dv.version_no = 1
      where n.kind = 'document' and n.state = 'published' and dv.processing_status = 'ready' and dv.page_count > 0`, [folder.id])).rows;
    return { folders, docs };
  });
  await pool.end();
  return out;
}

async function bidder(p, plan, until, think) {
  const pause = () => (think ? sleep(think * (0.5 + Math.random())) : Promise.resolve());
  while (Date.now() < until) {
    await call(p.key, 'shell', 'GET', `/v1/workspaces/${ws}/shell`);
    await pause();
    await call(p.key, 'list', 'GET', `/v1/workspaces/${ws}/nodes`);
    await pause();
    const f = plan.folders[Math.floor(Math.random() * plan.folders.length)];
    await call(p.key, 'list', 'GET', `/v1/workspaces/${ws}/nodes?parent=${f}`);
    await pause();
    const d = plan.docs[Math.floor(Math.random() * plan.docs.length)];
    const o = await call(p.key, 'open', 'POST', `/v1/workspaces/${ws}/nodes/${d.id}/open`, {});
    if (o.status === 200 && !args.includes('--no-images')) {
      const s = o.json();
      const thumbs = Math.min(8, s.pageCount);
      await Promise.all([
        call(p.key, 'page', 'GET', `/v1/workspaces/${ws}/nodes/${d.id}/pages/1?session=${s.sessionId}`),
        ...Array.from({ length: thumbs }, (_, i) => call(p.key, 'thumb', 'GET', `/v1/workspaces/${ws}/nodes/${d.id}/pages/${i + 1}?session=${s.sessionId}&size=thumb`)),
      ]);
      for (let n = 2; n <= Math.min(4, s.pageCount); n++) {
        await pause();
        await call(p.key, 'page', 'GET', `/v1/workspaces/${ws}/nodes/${d.id}/pages/${n}?session=${s.sessionId}`);
      }
    }
    if (p.group === 'a' && Math.random() < 0.15) await call(p.key, 'download', 'GET', `/v1/workspaces/${ws}/nodes/${d.id}/download?format=pdf`);
    if (Math.random() < 0.2) await call(p.key, 'search', 'GET', `/v1/workspaces/${ws}/search?q=load`);
    await pause();
  }
}

async function seller(p, until, think, files) {
  const MIME = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', jpg: 'image/jpeg' };
  const folder = await call(p.key, 'folder', 'POST', `/v1/workspaces/${ws}/folders`, { parentId: null, name: `Seller ${p.key} ${Date.now()}` });
  const fid = folder.json()?.id;
  let uploaded = 0;
  while (Date.now() < until && fid) {
    const f = files[Math.floor(Math.random() * files.length)];
    const full = `${WORK}/files/${f.path}`;
    const sha = await new Promise((ok) => { const h = createHash('sha256'); createReadStream(full).on('data', (c) => h.update(c)).on('end', () => ok(h.digest('hex'))); });
    const s = await call(p.key, 'upload-start', 'POST', `/v1/workspaces/${ws}/upload-sessions`, { targetFolderId: fid, path: `${uploaded + 1} ${f.path.split('/')[1]}`, size: f.size, sha256: sha, mime: MIME[f.kind] });
    if (s.status !== 201) { await sleep(1000); continue; }
    const put = await call(p.key, 'upload-bytes', 'PUT', s.json().uploadUrl, Readable.from(createReadStream(full)), { 'content-type': 'application/octet-stream', 'content-length': String(f.size) });
    if (put.status === 204) await call(p.key, 'upload-complete', 'POST', `/v1/workspaces/${ws}/upload-sessions/${s.json().id}/complete`, {});
    uploaded++;
    if (think) await sleep(think * 2);
  }
  return uploaded;
}

async function main() {
  if (args.includes('--prepare')) return prepare();
  const minutes = Number(arg('--minutes', '3'));
  const think = Number(arg('--think', '1000'));
  const label = arg('--label', think ? 'realistic' : 'stress');
  const plan = await readable();
  if (!plan.docs.length) throw new Error('No published, processed documents in the import folder. Run bulk.mjs and conc.mjs --prepare first.');
  const files = JSON.parse(readFileSync(`${WORK}/files.json`, 'utf8')).files.filter((f) => f.kind !== 'zip' && f.size < 12 * 1024 * 1024);
  const allBidders = S.people.filter((p) => p.group !== 'admins');
  const nBidders = Math.min(allBidders.length, Number(arg('--bidders', String(allBidders.length))));
  const bidders = allBidders.filter((_, i) => Math.floor((i * nBidders) / allBidders.length) !== Math.floor(((i + 1) * nBidders) / allBidders.length));
  const sellers = S.people.filter((p) => p.group === 'admins').slice(0, Number(arg('--sellers', '5')));
  console.log(`${bidders.length} bidders and ${sellers.length} sellers for ${minutes} min, think ${think} ms, ${plan.docs.length} documents.`);

  const mon = owner();
  const conn = [];
  let monitoring = true;
  const watch = (async () => {
    while (monitoring) {
      const r = (await mon.query(`select usename, count(*)::int as n, count(*) filter (where state = 'active')::int as active,
          count(*) filter (where wait_event_type = 'Lock')::int as lock_waits
        from pg_stat_activity where datname = 'vdrkit' and usename in ('vdrkit_app', 'vdrkit_queue') group by usename`).catch(() => ({ rows: [] }))).rows;
      conn.push({ t: Date.now(), rows: r });
      await sleep(2000);
    }
  })();

  const t0 = Date.now();
  const until = t0 + minutes * 60_000;
  const ticker = setInterval(() => console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)} s: ${requests} requests, ${[...codes].filter(([k]) => !/:2\d\d$/.test(k)).map(([k, n]) => `${k}=${n}`).join(' ') || 'no errors'}`), 30_000);
  const [, ups] = await Promise.all([
    Promise.all(bidders.map((p, i) => sleep(i * 100).then(() => bidder(p, plan, until, think)))),
    Promise.all(sellers.map((p) => seller(p, until, think, files))),
  ]);
  clearInterval(ticker);
  monitoring = false;
  await watch;
  await mon.end();
  save();
  const secs = (Date.now() - t0) / 1000;
  const kinds = Object.fromEntries([...lat].map(([k, xs]) => [k, stats(xs)]));
  const errors = Object.fromEntries([...codes].filter(([k]) => !/:2\d\d$/.test(k)));
  const peakConn = conn.reduce((m, c) => { for (const r of c.rows) m[r.usename] = { n: Math.max(m[r.usename]?.n ?? 0, r.n), active: Math.max(m[r.usename]?.active ?? 0, r.active), lockWaits: Math.max(m[r.usename]?.lockWaits ?? 0, r.lock_waits) }; return m; }, {});
  const api = (() => { try { return JSON.parse(readFileSync(`${WORK}/api-mem.json`, 'utf8')); } catch { return null; } })();
  console.log(`\n${requests} requests in ${secs.toFixed(0)} s: ${(requests / secs).toFixed(1)} per second, ${(bytes / 1024 ** 2 / secs).toFixed(1)} MiB/s out; ${ups.reduce((a, b) => a + b, 0)} files uploaded.`);
  for (const [k, s] of Object.entries(kinds)) console.log(`${k.padEnd(16)} n ${String(s.n).padStart(6)}  p50 ${s.p50.toFixed(0).padStart(5)} ms  p95 ${s.p95.toFixed(0).padStart(5)} ms  p99 ${s.p99.toFixed(0).padStart(5)} ms`);
  console.log(`Not 2xx: ${JSON.stringify(errors)}`);
  console.log(`Peak database connections: ${JSON.stringify(peakConn)}; API peak RSS ${api ? (api.rss / 1024 ** 2).toFixed(0) : '?'} MiB.`);
  writeFileSync(`${WORK}/conc-${label}.json`, JSON.stringify({ label, minutes, think, requests, secs, rps: requests / secs, bytes, uploads: ups, kinds, errors, peakConn, api }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
