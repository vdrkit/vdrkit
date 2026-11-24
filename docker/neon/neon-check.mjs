#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Preflight for Neon or another outside Postgres. Needs a built @vdrkit/core.
//   NEON_MIGRATION_URL="postgresql://vdrkit_owner:...@ep-xxxx.REGION.aws.neon.tech/vdrkit?sslmode=require" \
//   NEON_DATABASE_URL="postgresql://vdrkit_app:...@ep-xxxx-pooler.REGION.aws.neon.tech/vdrkit?sslmode=require" \
//   NEON_QUEUE_URL="postgresql://vdrkit_queue:...@ep-xxxx-pooler.REGION.aws.neon.tech/vdrkit?sslmode=require" \
//   node docker/neon/neon-check.mjs
//   NEON_MIGRATION_URL  vdrkit_owner on the DIRECT host (no "-pooler"): the migration lock is held by the session
//   NEON_DATABASE_URL   vdrkit_app, pooled host recommended: the API and the worker
//   NEON_QUEUE_URL      vdrkit_queue, pooled or direct: pg-boss
//   NEON_ALLOW_PLAIN=1  allows connections without sslmode (only for a local stand-in, never for Neon)
// writes only migrations, the pgboss schema, a probe tenant and job (both deleted). Output has host names.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(repo, 'apps', 'server', 'package.json'));
const pg = require('pg');
const PgBoss = require('pg-boss');
const core = await import(pathToFileURL(join(repo, 'packages', 'core', 'dist', 'index.js')).href);

const env = process.env;
const urls = { migration: env.NEON_MIGRATION_URL, app: env.NEON_DATABASE_URL, queue: env.NEON_QUEUE_URL };
const report = [];
let failed = false;
const out = (status, step, detail = '') => {
  report.push({ status, step, detail });
  if (status === 'failed') failed = true;
  console.log(`[neon-check] ${status.padEnd(7)} ${step}${detail ? `: ${detail}` : ''}`);
};

for (const [k, v] of Object.entries(urls)) if (!v) { console.error(`Set NEON_${k === 'app' ? 'DATABASE' : k.toUpperCase()}_URL. See the top of this file.`); process.exit(2); }

const pools = [];
const pool = (url, max = 4) => { const p = new pg.Pool({ connectionString: url, max }); pools.push(p); return p; };
const host = (u) => new URL(u).hostname;
const isPooler = (u) => /-pooler\./.test(host(u));

try {
  for (const [k, u] of Object.entries(urls)) {
    const sslmode = new URL(u).searchParams.get('sslmode');
    if (!sslmode || sslmode === 'disable' || sslmode === 'prefer') {
      out(env.NEON_ALLOW_PLAIN === '1' ? 'warning' : 'failed', `${k} connection uses TLS`, `sslmode=${sslmode ?? '(none)'}; Neon needs sslmode=require`);
    } else out('ok', `${k} connection uses TLS`, `sslmode=${sslmode}`);
  }
  if (isPooler(urls.migration)) out('failed', 'migrations use the direct host', `${host(urls.migration)} is a pooler; remove "-pooler" from the host name`);
  else out('ok', 'migrations use the direct host', host(urls.migration));
  out(isPooler(urls.app) ? 'ok' : 'warning', 'the API and the worker use the pooled host', isPooler(urls.app)
    ? host(urls.app) : `${host(urls.app)} is direct; it works, but the pooled host (with "-pooler") allows many more connections`);

  const owner = core.fromPgPool(pool(urls.migration, 1));
  const app = core.fromPgPool(pool(urls.app, 8));
  const queue = core.fromPgPool(pool(urls.queue, 2));
  for (const [k, db] of [['owner', owner], ['app', app], ['queue', queue]]) {
    const c = await core.checkRole(db);
    if (c.problems.length) out(k === 'queue' ? 'warning' : 'failed', `${k} role is safe for row-level security`, c.problems.join(' '));
    else out('ok', `${k} role is safe for row-level security`, `${c.role}: not a superuser, no BYPASSRLS`);
  }
  const info = (await owner.transaction((tx) => tx.query(`select current_setting('server_version') as v, current_user as u,
      pg_get_userbyid(d.datdba) as dba, current_database() as db,
      exists (select 1 from pg_available_extensions where name = 'ltree') as ltree
    from pg_database d where d.datname = current_database()`))).rows[0];
  out(Number(info.v.split('.')[0]) >= 16 ? 'ok' : 'failed', 'Postgres 16 or later', info.v);
  out(info.dba === info.u ? 'ok' : 'failed', 'the owner role owns the database', `${info.db} is owned by ${info.dba}; the migrations run as ${info.u}`);
  out(info.ltree ? 'ok' : 'failed', 'the ltree extension is available');

  const t = Date.now();
  const applied = await core.migrate(owner, { log: (line) => console.log(`[neon-check]         ${line}`) });
  out('ok', 'migrations', `${applied.length} applied in ${Date.now() - t} ms`);
  const status = await core.migrationStatus(app);
  out(status.pending.length ? 'failed' : 'ok', 'the app role sees every migration applied', status.pending.length ? `pending: ${status.pending.join(', ')}` : '');

  const loose = (await owner.transaction((tx) => tx.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
        and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
        and not (c.relrowsecurity and c.relforcerowsecurity) order by 1`))).rows.map((r) => r.relname);
  out(loose.length ? 'failed' : 'ok', 'row-level security is forced on every table with a tenant_id', loose.length ? `not forced: ${loose.join(', ')}` : '');
  // empty db proves nothing: probe tenant, visible only inside itself
  const probe = randomUUID();
  const inTenant = (db, tenantId, sql, params = []) => db.transaction(async (tx) => {
    if (tenantId) await tx.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
    return (await tx.query(sql, params)).rows[0];
  });
  await inTenant(owner, probe, `insert into tenant (id, name, metadata) values ($1, 'vdrkit-neon-check probe', '{"neon_check_probe": true}')`, [probe]);
  try {
    const own = (await inTenant(app, probe, `select count(*)::int as n from tenant where id = $1`, [probe])).n;
    const other = (await inTenant(app, randomUUID(), `select count(*)::int as n from tenant`)).n;
    const none = (await inTenant(app, null, `select count(*)::int as n from tenant`)).n;
    out(own === 1 ? 'ok' : 'failed', 'the app role sees its own tenant', `${own} of 1 probe row visible inside the probe tenant`);
    out(other === 0 && none === 0 ? 'ok' : 'failed', 'the app role sees no row of another tenant',
      `${other} tenant rows visible to an unknown tenant, ${none} with no tenant set (the probe tenant exists)`);
  } finally {
    const gone = await inTenant(owner, probe, `with d as (delete from tenant where id = $1 returning 1) select count(*)::int as n from d`, [probe])
      .then((r) => r.n === 1, () => false);
    if (!gone) out('failed', 'the probe tenant is deleted', `delete it by hand: as vdrkit_owner, select set_config('app.tenant_id', '${probe}', false); delete from tenant where id = '${probe}';`);
  }

  // SET LOCAL must not leak across pooled transactions
  let leaks = 0;
  await Promise.all(Array.from({ length: 40 }, async () => {
    const id = randomUUID();
    const inside = await app.transaction(async (tx) => {
      await tx.query(`select set_config('app.tenant_id', $1, true)`, [id]);
      return (await tx.query(`select current_setting('app.tenant_id', true) as t`)).rows[0].t;
    });
    const after = await app.transaction(async (tx) => (await tx.query(`select coalesce(current_setting('app.tenant_id', true), '') as t`)).rows[0].t);
    if (inside !== id || after !== '') leaks++;
  }));
  out(leaks ? 'failed' : 'ok', 'the tenant setting stays inside its transaction on the pooled connection', `${40 - leaks} of 40 transactions clean`);

  const boss = new PgBoss({ connectionString: urls.queue, schema: 'pgboss', max: 2 });
  boss.on('error', (e) => out('warning', 'pg-boss reported', e.message));
  await boss.start();
  const name = 'vdrkit-neon-check';
  await boss.createQueue(name);
  const jobId = await boss.send(name, { at: new Date().toISOString() });
  const [job] = await boss.fetch(name);
  if (job?.id === jobId) await boss.complete(name, job.id);
  // pg-boss 10 won't delete a queue whose partition has history
  await boss.deleteJob(name, jobId);
  await boss.stop({ graceful: false, wait: true });
  out(job?.id === jobId ? 'ok' : 'failed', 'pg-boss sends and fetches a job', job?.id === jobId ? '' : `sent ${jobId}, fetched ${job?.id ?? 'nothing'}`);

  const time = async (db) => {
    const ms = [];
    for (let i = 0; i < 20; i++) { const s = performance.now(); await db.transaction((tx) => tx.query('select 1')); ms.push(performance.now() - s); }
    ms.sort((x, y) => x - y);
    return `median ${ms[10].toFixed(1)} ms, slowest ${ms[19].toFixed(1)} ms (20 transactions)`;
  };
  out('ok', 'round trips, app (pooled)', await time(app));
  out('ok', 'round trips, owner (direct)', await time(owner));
} catch (err) {
  out('failed', 'unexpected error', err instanceof Error ? err.message : String(err));
} finally {
  await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
}

console.log(JSON.stringify({ ok: !failed, report }, null, 2));
process.exit(failed ? 1 : 0);
