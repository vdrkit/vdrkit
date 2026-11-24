#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Heavy-screen response times, sequential, against the running API.
//   node scripts/load/measure.mjs
//   node scripts/load/measure.mjs --room kite         (run seed.mjs --kite first)
//   node scripts/load/measure.mjs --label after -n 60
// Rotates over people so per-person rate limits stay out of it.
import { writeFileSync } from 'node:fs';
import { API, ORIGIN, TENANT, WORK, core, stats } from './config.mjs';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const room = arg('--room', 'heron');
const label = arg('--label', 'run');
const N = Number(arg('-n', '40'));
const only = arg('--only', '');

const S = JSON.parse(readFileSync(`${WORK}/sessions.json`, 'utf8'));
const { stableId } = await import(`file:///${(await import('./config.mjs')).ROOT}apps/server/src/demo/seed-demo.ts`);
const ws = room === 'kite' ? S.kite : S.heron;
const node = (ix) => (room === 'kite' ? stableId(TENANT, `load:kite:node:${ix}`) : stableId(TENANT, `node:${ix}`));
const group = (k) => (room === 'kite' ? stableId(TENANT, `load:kite:group:${k}`) : stableId(TENANT, `group:${{ a: 'Bidder A', b: 'Bidder B', c: 'Bidder C', cFin: 'Bidder C financiers' }[k]}`));
const people = (g) => S.people.filter((p) => p.group === g);
const jar = new Map(S.people.map((p) => [p.key, p.cookie]));

/** API rotates tokens after 15 min; keep the new one */
function saveJar() {
  for (const p of S.people) p.cookie = jar.get(p.key);
  writeFileSync(`${WORK}/sessions.json`, JSON.stringify(S, null, 1));
}

async function call(p, path, method = 'GET') {
  const t = performance.now();
  const r = await fetch(`${API}${path}`, { method, headers: { origin: ORIGIN, cookie: `vdrkit.session_token=${jar.get(p.key)}`, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
  const body = await r.arrayBuffer();
  const ms = performance.now() - t;
  const sc = r.headers.get('set-cookie');
  const m = sc && /vdrkit\.session_token=([^;]+)/.exec(sc);
  if (m && m[1]) { jar.set(p.key, m[1]); saveJar(); }
  if (r.status >= 400) throw new Error(`${method} ${path} as ${p.key}: ${r.status} ${Buffer.from(body).toString().slice(0, 300)}`);
  return { ms, bytes: body.byteLength, json: () => JSON.parse(Buffer.from(body).toString()) };
}

const BIG = room === 'kite' ? null : '4';
async function biggestFolder() {
  if (BIG) return node(BIG);
  // seed numbers docs per folder: highest number = largest leaf
  const { pg, APP_URL, core: c } = await import('./config.mjs');
  const pool = new pg.Pool({ connectionString: APP_URL, max: 1 });
  const row = await c.withTenant(c.fromPgPool(pool), TENANT, async (tx) => (await tx.query(
    `select parent_id from node where workspace_id = $1 and kind = 'document' group by parent_id order by count(*) desc limit 1`, [ws])).rows[0]);
  await pool.end();
  return row.parent_id;
}

const big = await biggestFolder();

async function viewable() {
  const { pg, APP_URL, core: c } = await import('./config.mjs');
  const pool = new pg.Pool({ connectionString: APP_URL, max: 1 });
  const row = await c.withTenant(c.fromPgPool(pool), TENANT, async (tx) => (await tx.query(
    `select n.id from node n join document_version dv on dv.node_id = n.id
      where n.workspace_id = $1 and n.kind = 'document' and dv.processing_status = 'ready' and dv.page_count >= 4 and not dv.metadata ? 'placeholder'
      order by n.state = 'published' desc, dv.created_at, n.id limit 1`, [S.heron])).rows[0]);
  await pool.end();
  return row?.id;
}
const doc = room === 'heron' ? await viewable() : null;

async function openFirstPage(p) {
  const t = performance.now();
  const o = (await call(p, `/v1/workspaces/${ws}/nodes/${doc}/open`, 'POST')).json();
  const r = await call(p, `/v1/workspaces/${ws}/nodes/${doc}/pages/1?session=${o.sessionId}`);
  return { ms: performance.now() - t, bytes: r.bytes, json: () => ({ pageCount: o.pageCount }) };
}
const sc = [
  ['list: top level (bidder A)', 'a', () => `/v1/workspaces/${ws}/nodes`],
  ['list: largest folder (bidder A)', 'a', () => `/v1/workspaces/${ws}/nodes?parent=${big}`],
  ['list: largest folder (bidder C financiers)', 'cFin', () => `/v1/workspaces/${ws}/nodes?parent=${big}`],
  ['list: largest folder (room admin)', 'admins', () => `/v1/workspaces/${ws}/nodes?parent=${big}`],
  ['list: small folder (bidder B)', 'b', () => `/v1/workspaces/${ws}/nodes?parent=${node(room === 'kite' ? '2.1' : '2.4')}`],
  ['search: "agreement" (bidder A)', 'a', () => `/v1/workspaces/${ws}/search?q=${room === 'kite' ? 'section' : 'agreement'}`],
  ['search: "2024" names only (bidder B)', 'b', () => `/v1/workspaces/${ws}/search?q=${room === 'kite' ? 'document' : '2024'}&match=names`],
  ['search: "agreement" (room admin)', 'admins', () => `/v1/workspaces/${ws}/search?q=${room === 'kite' ? 'section' : 'agreement'}`],
  ['search: no hits (bidder C)', 'c', () => `/v1/workspaces/${ws}/search?q=zzqxv`],
  ['permissions E3 (room admin)', 'admins', () => `/v1/workspaces/${ws}/permissions`],
  ['activity F1: log, no filter', 'admins', () => `/v1/workspaces/${ws}/events?limit=100`],
  ['activity F1: downloads', 'admins', () => `/v1/workspaces/${ws}/events?kind=download&limit=100`],
  ['activity F1: group Bidder B', 'admins', () => `/v1/workspaces/${ws}/events?group=${group('b')}&limit=100`],
  ['activity F1: one person', 'admins', () => `/v1/workspaces/${ws}/events?person=${S.people.find((p) => p.key === 'ba3').personId}&limit=100`],
  ['activity F1: folder and text', 'admins', () => `/v1/workspaces/${ws}/events?node=${node(room === 'kite' ? '3' : '3')}&q=load&limit=100`],
  ['activity F1: text, a document name', 'admins', () => `/v1/workspaces/${ws}/events?q=${room === 'kite' ? 'document 4.2' : 'Tarnley'}&limit=100`],
  ['activity F1: summary (7 days)', 'admins', () => `/v1/workspaces/${ws}/activity/summary`],
  ['dashboard C1 (bidder A)', 'a', () => `/v1/workspaces/${ws}/dashboard`],
  ['dashboard C1 (room admin)', 'admins', () => `/v1/workspaces/${ws}/dashboard`],
  ['room shell (bidder A)', 'a', () => `/v1/workspaces/${ws}/shell`],
  ...(doc ? [['viewer: open and first page (room admin)', 'admins', null], ['viewer: open and first page (bidder A)', 'a', null]] : []),
].filter(([name]) => !only || name.includes(only));

const results = [];
for (const [name, kind, path] of sc) {
  const ps = people(kind);
  let i = 0;
  const next = () => ps[i++ % ps.length];
  let info = '';
  try {
    for (let w = 0; w < 3; w++) {
      const r = path ? await call(next(), path()) : await openFirstPage(next());
      if (w === 0) {
        const j = r.json();
        info = j.pageCount ? `${j.pageCount} pages` : Array.isArray(j.items) ? `${j.items.length} items${j.total != null ? ` of ${j.total}` : ''}` : j.folders ? `${j.folders.length} folders` : '';
        info += `, ${(r.bytes / 1024).toFixed(0)} KiB`;
      }
    }
    const ms = [];
    for (let k = 0; k < N; k++) ms.push((path ? await call(next(), path()) : await openFirstPage(next())).ms);
    const s = stats(ms);
    results.push({ name, ...s, info });
    console.log(`${name.padEnd(46)} p50 ${s.p50.toFixed(0).padStart(5)} ms  p95 ${s.p95.toFixed(0).padStart(5)} ms  max ${s.max.toFixed(0).padStart(5)} ms  ${info}`);
  } catch (e) {
    results.push({ name, error: String(e.message) });
    console.log(`${name.padEnd(46)} ERROR ${e.message}`);
  }
}
writeFileSync(`${WORK}/measure-${room}-${label}.json`, JSON.stringify({ room, label, n: N, at: new Date().toISOString(), results }, null, 1));
