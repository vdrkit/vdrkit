#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Load-test seed. Throwaway database only.
//   node scripts/load/seed.mjs            the demo room, 55 load people with sessions, and six weeks of history
//   node scripts/load/seed.mjs --kite     also a second room with 10,000 published documents
// All writes via withTenant as vdrkit_app (RLS applies). Idempotent.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { APP_URL, AUTH_SECRET, TENANT, WORK, core, pg, ROOT } from './config.mjs';

const { seedDemo, stableId } = await import(`file:///${ROOT}apps/server/src/demo/seed-demo.ts`);
const { withTenant, fromPgPool, setGrant, appendEvent } = core;

const args = process.argv.slice(2);
const pool = new pg.Pool({ connectionString: APP_URL, max: 2 });
const db = fromPgPool(pool);
const sid = (k) => stableId(TENANT, k);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const log = (m) => console.log(`[seed] ${m}`);

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BIDDERS = [
  ...Array.from({ length: 20 }, (_, i) => ({ key: `ba${i + 1}`, group: 'a', domain: 'bidder-a.example.com' })),
  ...Array.from({ length: 15 }, (_, i) => ({ key: `bb${i + 1}`, group: 'b', domain: 'bidder-b.example.com' })),
  ...Array.from({ length: 10 }, (_, i) => ({ key: `bc${i + 1}`, group: 'c', domain: 'bidder-c.example.com' })),
  ...Array.from({ length: 5 }, (_, i) => ({ key: `bf${i + 1}`, group: 'cFin', domain: 'bidder-c.example.com' })),
];
const SELLERS = Array.from({ length: 5 }, (_, i) => ({ key: `s${i + 1}`, group: 'admins', domain: 'seller.example.com' }));
const HERON_GROUPS = { admins: 'Room admins', a: 'Bidder A', b: 'Bidder B', c: 'Bidder C', cFin: 'Bidder C financiers' };

async function main() {
  mkdirSync(WORK, { recursive: true });
  const t0 = Date.now();
  const heron = await seedDemo(db, { tenantId: TENANT });
  log(heron.skipped ? 'Project Heron already there.' : `Project Heron: ${heron.counts.published} published, ${heron.counts.drafts} drafts (${Date.now() - t0} ms).`);
  const heronWs = sid('workspace');

  await people();
  await joinRoom(heronWs, Object.fromEntries(Object.entries(HERON_GROUPS).map(([k, name]) => [k, sid(`group:${name}`)])), 'heron');
  await history(heronWs, 'heron', 60_000, 40_000);

  if (args.includes('--kite')) {
    const groups = await kite();
    await joinRoom(sid('load:kite:workspace'), groups, 'kite');
    await history(sid('load:kite:workspace'), 'kite', 250_000, 150_000);
  }
  await sessions();
  await pool.end();
  log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
}

async function people() {
  await withTenant(db, TENANT, async (tx) => {
    if ((await tx.query(`select 1 from person where id = $1`, [sid('load:person:s1')])).rows.length) return log('Load people already there.');
    for (const p of [...BIDDERS, ...SELLERS]) {
      const id = sid(`load:person:${p.key}`);
      const email = `load-${p.key}@${p.domain}`;
      await tx.query(`insert into person (id, tenant_id, name, email, time_zone, company) values ($1, current_tenant_id(), $2, $3, 'Africa/Johannesburg', 'Load test')`,
        [id, `Load ${p.key.toUpperCase()}`, email]);
      await tx.query(`insert into principal (id, tenant_id, kind, person_id, name) values ($1, current_tenant_id(), 'person', $2, $3)`, [sid(`load:principal:${p.key}`), id, p.key]);
      const user = `load-user-${p.key}`;
      await tx.query(`insert into auth_user (id, name, email, email_verified, two_factor_enabled) values ($1, $2, $3, true, true) on conflict (id) do nothing`, [user, `Load ${p.key}`, email]);
      await tx.query(`insert into auth_person (tenant_id, person_id, email, user_id) values (current_tenant_id(), $1, $2, $3)`, [id, email, user]);
    }
    log(`Added ${BIDDERS.length} bidders and ${SELLERS.length} sellers.`);
  });
}

async function joinRoom(ws, group, tag) {
  await withTenant(db, TENANT, async (tx) => {
    const p1 = sid('load:person:s1');
    if ((await tx.query(`select 1 from membership m join groups g on g.id = m.group_id where m.person_id = $1 and g.workspace_id = $2`, [p1, ws])).rows.length) return;
    for (const p of [...BIDDERS, ...SELLERS]) {
      await tx.query(`insert into membership (tenant_id, person_id, group_id, role) values (current_tenant_id(), $1, $2, $3)`,
        [sid(`load:person:${p.key}`), group[p.group], p.group === 'admins' ? 'admin' : 'member']);
    }
    const nda = (await tx.query(`select av.id from agreement a join agreement_version av on av.agreement_id = a.id
       where a.workspace_id = $1 and a.kind = 'nda' and av.published_at is not null order by av.version_no desc limit 1`, [ws])).rows[0];
    if (nda) {
      for (const p of BIDDERS) {
        await tx.query(`insert into acceptance (tenant_id, agreement_version_id, person_id, accepted_at) values (current_tenant_id(), $1, $2, now())`,
          [nda.id, sid(`load:person:${p.key}`)]);
      }
    }
    log(`${tag}: memberships for the load people.`);
  });
}

// log entries use the db clock, so all land today; view sessions are back-dated
async function history(ws, tag, events, sessions) {
  const done = await withTenant(db, TENANT, async (tx) =>
    (await tx.query(`select 1 from event where workspace_id = $1 and action = 'load.history_seeded' limit 1`, [ws])).rows.length > 0);
  if (done) return log(`${tag}: history already there.`);
  const t0 = Date.now();
  const r = rng(tag.length * 7777);
  const readers = [...BIDDERS, ...SELLERS].map((p) => sid(`load:person:${p.key}`));
  const visible = new Map();
  await withTenant(db, TENANT, async (tx) => {
    for (const person of readers) {
      const rows = (await tx.query(`select n.id, a.version_id from readable_nodes($1, $2, now(), record_clock(), false) a join node n on n.id = a.node_id
         where n.kind = 'document' and n.state = 'published' and a.version_id is not null`, [person, ws])).rows;
      visible.set(person, rows);
    }
  });
  const batch = 5_000;
  for (let done = 0; done < sessions; done += batch) {
    const rows = [];
    for (let i = 0; i < Math.min(batch, sessions - done); i++) {
      const person = readers[Math.floor(r() * readers.length)];
      const docs = visible.get(person);
      if (!docs.length) continue;
      const d = docs[Math.floor(r() * docs.length)];
      const pages = 4 + Math.floor(r() * 60);
      const opened = new Date(Date.now() - Math.floor(r() * 42 * 86_400_000));
      const seen = Math.max(1, Math.floor(pages * r()));
      rows.push([d.id, d.version_id, person, opened.toISOString(), new Date(opened.getTime() + seen * 40_000).toISOString(), pages, seen]);
    }
    await withTenant(db, TENANT, (tx) => tx.query(
      `insert into view_session (tenant_id, workspace_id, node_id, version_id, person_id, opened_at, last_seen_at, page_count, pages_seen)
       select current_tenant_id(), $1, u.n, u.v, u.p, u.o, u.l, u.c, array(select generate_series(1, u.s))
         from unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::timestamptz[], $6::timestamptz[], $7::int[], $8::int[]) as u(n, v, p, o, l, c, s)`,
      [ws, ...[0, 1, 2, 3, 4, 5, 6].map((k) => rows.map((x) => x[k]))]));
  }
  log(`${tag}: ${sessions} view sessions (${Date.now() - t0} ms).`);

  const t1 = Date.now();
  for (let done = 0; done < events; done += batch) {
    const rows = [];
    for (let i = 0; i < Math.min(batch, events - done); i++) {
      const person = readers[Math.floor(r() * readers.length)];
      const docs = visible.get(person);
      if (!docs.length) continue;
      const d = docs[Math.floor(r() * docs.length)];
      const x = r();
      const action = x < 0.8 ? 'document.opened' : x < 0.97 ? 'document.downloaded' : 'auth.signed_in';
      const data = action === 'document.downloaded' ? { format: r() < 0.5 ? 'pdf' : 'original', version_id: d.version_id, person_id: person }
        : action === 'auth.signed_in' ? { person_id: person, method: 'email_code' }
        : { version_id: d.version_id, page_count: 4 + Math.floor(r() * 60), person_id: person };
      rows.push([action, action === 'auth.signed_in' ? 'person' : 'node', action === 'auth.signed_in' ? person : d.id, JSON.stringify(data)]);
    }
    // append_event keeps chain and sequence
    await withTenant(db, TENANT, (tx) => tx.query(
      `select count(append_event(u.a, $1, null, null, u.rt, u.ri, u.d::jsonb))
         from unnest($2::text[], $3::text[], $4::uuid[], $5::text[]) with ordinality as u(a, rt, ri, d, o)`,
      [ws, ...[0, 1, 2, 3].map((k) => rows.map((x) => x[k]))]));
  }
  await withTenant(db, TENANT, (tx) => appendEvent(tx, { action: 'load.history_seeded', workspaceId: ws, resourceType: 'workspace', resourceId: ws, data: { events, sessions } }));
  log(`${tag}: ${events} log entries (${Date.now() - t1} ms).`);
}

async function kite() {
  const ws = sid('load:kite:workspace');
  const g = (k) => sid(`load:kite:group:${k}`);
  const group = { admins: g('admins'), observers: g('observers'), a: g('a'), b: g('b'), c: g('c'), cFin: g('cFin') };
  const exists = await withTenant(db, TENANT, async (tx) => (await tx.query(`select 1 from workspace where id = $1`, [ws])).rows.length > 0);
  if (exists) { log('Project Kite already there.'); return group; }
  const t0 = Date.now();
  const r = rng(424242);
  const anika = sid('person:anika');
  const actor = sid('principal:anika');
  await withTenant(db, TENANT, async (tx) => {
    await tx.query(`insert into workspace (id, tenant_id, name, state, requires_nda, time_zone) values ($1, current_tenant_id(), 'Project Kite', 'open', true, 'Africa/Johannesburg')`, [ws]);
    const party = async (k, name, kind) => {
      await tx.query(`insert into party (id, tenant_id, workspace_id, name, kind) values ($1, current_tenant_id(), $2, $3, $4)`, [sid(`load:kite:party:${k}`), ws, name, kind]);
      return sid(`load:kite:party:${k}`);
    };
    const seller = await party('seller', 'Kite Industrial', 'seller');
    const pa = await party('a', 'Bidder A', 'bidder');
    const pb = await party('b', 'Bidder B', 'bidder');
    const pc = await party('c', 'Bidder C', 'bidder');
    const mk = (k, partyId, name, role = 'member', parent = null) => tx.query(
      `insert into groups (id, tenant_id, workspace_id, party_id, name, role_template, parent_group_id) values ($1, current_tenant_id(), $2, $3, $4, $5, $6)`,
      [group[k], ws, partyId, name, role, parent]);
    await mk('admins', seller, 'Room admins', 'admin');
    await mk('observers', seller, 'Kite management', 'observer');
    await mk('a', pa, 'Bidder A');
    await mk('b', pb, 'Bidder B');
    await mk('c', pc, 'Bidder C');
    await mk('cFin', pc, 'Bidder C financiers', 'member', group.c);
    await tx.query(`insert into membership (tenant_id, person_id, group_id, role) values (current_tenant_id(), $1, $2, 'admin')`, [anika, group.admins]);
    const agreement = (await tx.query(`insert into agreement (tenant_id, workspace_id, kind, name) values (current_tenant_id(), $1, 'nda', 'Project Kite confidentiality undertaking') returning id`, [ws])).rows[0].id;
    await tx.query(`insert into agreement_version (tenant_id, agreement_id, version_no, body, published_at) values (current_tenant_id(), $1, 1, 'Project Kite NDA.', now())`, [agreement]);

    const grant = (node, subject, level, sw = {}) => setGrant(tx, { workspaceId: ws, nodeId: node, subject, level, canUpload: !!sw.up, canManage: !!sw.manage,
      canPublish: !!sw.publish, actorId: actor, ...(sw.effect ? { effect: sw.effect } : {}) });

    const folders = [];   // { id, ix, depth, leaf }
    let sort = 0;
    const addFolder = async (parent, ix, name, depth) => {
      const id = sid(`load:kite:node:${ix}`);
      await tx.query(`insert into node (id, tenant_id, workspace_id, parent_id, kind, name, index_number, sort_key, state, published_at, published_by)
        values ($1, current_tenant_id(), $2, $3, 'folder', $4, $5, $6, 'published', now(), $7)`, [id, ws, parent, name, ix, ++sort, anika]);
      const f = { id, ix, depth, kids: [] };
      folders.push(f);
      return f;
    };
    const TOP = ['Corporate', 'Legal', 'Finance', 'Commercial', 'Operations', 'HR', 'IT', 'Property', 'Tax', 'Insurance', 'Environmental', 'Intellectual property', 'Data protection'];
    const tops = [];
    for (const [i, name] of TOP.entries()) {
      const top = await addFolder(null, String(i + 1), name, 0);
      tops.push(top);
      await grant(top.id, { groupId: group.admins }, 60, { up: true, manage: true, publish: true });
      if (i < 10) {
        await grant(top.id, { groupId: group.observers }, 20);
        await grant(top.id, { groupId: group.a }, 40);
        await grant(top.id, { groupId: group.b }, 20);
        await grant(top.id, { groupId: group.c }, 20);
      }
      if (name === 'Finance' || name === 'Tax') await grant(top.id, { groupId: group.cFin }, 20);
      const subs = 3 + Math.floor(r() * 6);
      for (let s = 1; s <= subs; s++) {
        const sub = await addFolder(top.id, `${i + 1}.${s}`, `${name} part ${s}`, 1);
        top.kids.push(sub);
        const x = r();
        if (i < 10 && x < 0.15) await grant(sub.id, { groupId: group.b }, 0);
        else if (i < 10 && x < 0.3) await grant(sub.id, { groupId: group.a }, 50);
        else if (i < 10 && x < 0.38) await grant(sub.id, { groupId: group.c }, 40);
        if ((name === 'Finance' || name === 'Tax') && r() < 0.5) await grant(sub.id, { groupId: group.cFin }, 50);
        if (r() < 0.35) {
          const deep = 2 + Math.floor(r() * 4);
          for (let d = 1; d <= deep; d++) {
            const leaf = await addFolder(sub.id, `${i + 1}.${s}.${d}`, `${name} part ${s} section ${d}`, 2);
            sub.kids.push(leaf);
            if (i < 10 && r() < 0.1) await grant(leaf.id, { groupId: group.a }, 0);
          }
        }
      }
    }
    await grant(tops[3].id, { personId: sid('load:person:ba1') }, 0, { effect: 'deny' });
    await grant(tops[5].id, { personId: sid('load:person:bb1') }, 0, { effect: 'deny' });

    const leaves = folders.filter((f) => f.kids.length === 0 && f.depth > 0);
    const weights = leaves.map(() => 0.2 + r() * r() * 4);
    const wsum = weights.reduce((a, b) => a + b, 0);
    const PUBLISHED = 10_000, DRAFTS = 1_000;
    const per = weights.map((w) => Math.floor((w / wsum) * PUBLISHED));
    per[0] += PUBLISHED - per.reduce((a, b) => a + b, 0);
    const draftPer = weights.map((w) => Math.floor((w / wsum) * DRAFTS));
    draftPer[0] += DRAFTS - draftPer.reduce((a, b) => a + b, 0);
    let docGrants = 0;
    for (const [li, leaf] of leaves.entries()) {
      const n = per[li] + draftPer[li];
      const rows = Array.from({ length: n }, (_, k) => {
        const ix = `${leaf.ix}.${k + 1}`;
        const draft = k >= per[li];
        return { id: sid(`load:kite:node:${ix}`), ix, name: `Kite document ${ix}.pdf`, sort: k + 1, draft, pages: 1 + Math.floor(r() * 120) };
      });
      await tx.query(
        `insert into node (id, tenant_id, workspace_id, parent_id, kind, name, index_number, sort_key, state, published_at, published_by)
         select u.id, current_tenant_id(), $1, $2, 'document', u.name, u.ix, u.sort, case when u.draft then 'draft' else 'published' end,
                case when u.draft then null else now() end, case when u.draft then null else $3::uuid end
           from unnest($4::uuid[], $5::text[], $6::text[], $7::int[], $8::boolean[]) as u(id, name, ix, sort, draft)`,
        [ws, leaf.id, anika, rows.map((x) => x.id), rows.map((x) => x.name), rows.map((x) => x.ix), rows.map((x) => x.sort), rows.map((x) => x.draft)]);
      await tx.query(
        `insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, uploaded_by, processing_status, page_count, metadata)
         select current_tenant_id(), u.id, 1, 'load/' || u.id, u.sha, u.pages * 61440 + 18000, 'application/pdf', $1, 'ready', u.pages, '{"load": true, "placeholder": "no file stored"}'::jsonb
           from unnest($2::uuid[], $3::text[], $4::int[]) as u(id, sha, pages)`,
        [actor, rows.map((x) => x.id), rows.map((x) => sha(x.ix)), rows.map((x) => x.pages)]);
      for (const d of rows.filter((x) => !x.draft)) {
        const x = r();
        if (x < 0.006) { await grant(d.id, { groupId: group.a }, 60); docGrants++; }
        else if (x < 0.01) { await grant(d.id, { groupId: group.c }, 0); docGrants++; }
      }
    }
    log(`Project Kite: ${folders.length} folders, ${PUBLISHED} published, ${DRAFTS} drafts, ${docGrants} document grants (${Date.now() - t0} ms).`);
  });
  return group;
}

async function sessions() {
  const out = { tenantId: TENANT, heron: sid('workspace'), kite: sid('load:kite:workspace'), people: [] };
  await withTenant(db, TENANT, async (tx) => {
    for (const p of [...BIDDERS, ...SELLERS]) {
      const user = `load-user-${p.key}`;
      const token = randomBytes(24).toString('base64url');
      await tx.query(`delete from auth_session where user_id = $1`, [user]);
      await tx.query(`insert into auth_session (id, user_id, token, expires_at, last_active_at, token_issued_at, user_agent, ip_address)
        values ($1, $2, $3, now() + interval '7 days', now(), now(), 'vdrkit-load', '127.0.0.1')`, [`load-s-${p.key}-${token.slice(0, 6)}`, user, token]);
      const sig = createHmacB64(token);
      out.people.push({ key: p.key, group: p.group, personId: sid(`load:person:${p.key}`), cookie: encodeURIComponent(`${token}.${sig}`) });
    }
  });
  out.admin = { personId: sid('person:anika') };
  writeFileSync(`${WORK}/sessions.json`, JSON.stringify(out, null, 1));
  log(`Sessions for ${out.people.length} people in scripts/load/.work/sessions.json.`);
}

function createHmacB64(value) {
  return createHmac('sha256', AUTH_SECRET).update(value).digest('base64');
}

main().catch((e) => { console.error(e); process.exit(1); });
