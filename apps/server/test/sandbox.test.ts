// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { fromPgPool, withTenant, type Database } from '@vdrkit/core';
import { buildApp } from '../src/index.js';
import { BetterAuthAuthenticator, betterAuthRoutes, createBetterAuth } from '../src/auth/better-auth.js';
import { sessionRoutes } from '../src/auth/session-routes.js';
import { poolFromPGlite } from '../src/auth/pool.js';
import { LocalKeyProvider } from '../src/crypto/envelope.js';
import { DbKeyring } from '../src/crypto/keyring.js';
import { LocalDiskStorage } from '../src/storage/local-disk.js';
import { MemoryQueue } from '../src/worker/jobs.js';
import { DEMO_TENANT_ID, stableId } from '../src/demo/seed-demo.js';
import { checkSandboxStart, notASandbox, sandboxState, SandboxRefused, type SandboxState } from '../src/sandbox/check.js';
import { nextReset, refuseUnsafeSandboxEnv, sandboxFlag, SANDBOX_MAX_FILE_BYTES, SANDBOX_TENANT_ID, SANDBOX_UPLOADS_PER_VISITOR_PER_DAY } from '../src/sandbox/config.js';
import { sandboxMailer } from '../src/sandbox/mail.js';
import { SANDBOX_PEOPLE, SANDBOX_WORKSPACE_ID } from '../src/sandbox/people.js';
import { CACHE_FOLDER, resetSandbox, STORAGE_MARKER, type ResetOptions } from '../src/sandbox/reset.js';
import { resetWithRetries } from '../src/sandbox/cli.js';
import { sandboxDocuments } from '../src/sandbox/room/catalogue.js';
import { CACHE_MARKER } from '../src/sandbox/room/cache.js';
import { decryptBuffer } from '../src/crypto/envelope.js';
import { freshDatabase, heron, TEST_DATABASE_URL, type TestPg } from '../../../packages/core/test/fixture.js';

const URL_ = 'https://demo.example.com';
const SECRET = 'sandbox-test-secret-sandbox-test-secret-0123';
const SANDBOX_ENV = { VDRKIT_SANDBOX: '1', STORAGE_DRIVER: 'local' };
const sid = (key: string) => stableId(DEMO_TENANT_ID, key);
const ANIKA = sid('person:anika');
const JAN = sid('person:jan');

const made: string[] = [];
async function folder(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'vdrkit-sandbox-test-'));
  made.push(d);
  return d;
}
afterAll(async () => { for (const d of made) await rm(d, { recursive: true, force: true }); });

const masterKey = randomBytes(32).toString('base64');
const SAMPLE = (() => {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const d of sandboxDocuments()) {
    const k = `${d.kind}:${d.ext}`;
    if (!seen.has(k) || d.status === 'upd' || d.status === 'rev' || d.ix === '3.5.2') { seen.add(k); out.add(d.ix); }
  }
  return out;
})();
const resetOptions = (db: Database, dir: string, owner = db): ResetOptions => ({
  ownerDb: owner, appDb: db, appRole: 'vdrkit_app', storageDir: dir, storage: new LocalDiskStorage(dir), keyProvider: new LocalKeyProvider(masterKey),
  gotenbergUrl: null, clamav: null, documents: (d) => !!d.room || SAMPLE.has(d.ix),
});

// PGlite has no owner role
function ownerOf(d: { db: Database; ownerUrl?: string }): { db: Database; end(): Promise<void> } {
  if (!d.ownerUrl) return { db: d.db, end: async () => undefined };
  const pool = new pg.Pool({ connectionString: d.ownerUrl, max: 2 });
  return { db: fromPgPool(pool), end: () => pool.end() };
}

const VALID: SandboxState = { markerTenant: SANDBOX_TENANT_ID, seedVersion: 1, siteTenant: SANDBOX_TENANT_ID, tenants: 1, otherTenants: 0, outsidePeople: 0, outsideLogins: 0 };

describe('sandbox settings', () => {
  it('accepts only VDRKIT_SANDBOX=1', () => {
    expect(sandboxFlag({})).toBe(false);
    expect(sandboxFlag({ VDRKIT_SANDBOX: '' })).toBe(false);
    expect(sandboxFlag({ VDRKIT_SANDBOX: '0' })).toBe(false);
    expect(sandboxFlag({ VDRKIT_SANDBOX: '1' })).toBe(true);
    expect(() => sandboxFlag({ VDRKIT_SANDBOX: 'true' })).toThrow(/Set it to 1/);
  });

  it('refuses unsafe settings', () => {
    expect(() => refuseUnsafeSandboxEnv({ ...SANDBOX_ENV, SMTP_HOST: 'smtp.example.net' })).toThrow(/mail settings are set \(SMTP_HOST\)/);
    expect(() => refuseUnsafeSandboxEnv({ ...SANDBOX_ENV, MAIL_FROM: 'demo@example.com', SMTP_URL: 'smtp://x' })).toThrow(/SMTP_URL, MAIL_FROM/);
    expect(() => refuseUnsafeSandboxEnv({ ...SANDBOX_ENV, VDRKIT_DEMO_EMAIL_DOMAINS: 'realcompany.com' })).toThrow(/VDRKIT_DEMO_EMAIL_DOMAINS/);
    expect(() => refuseUnsafeSandboxEnv({ VDRKIT_SANDBOX: '1', STORAGE_DRIVER: 's3', S3_BUCKET: 'b' })).toThrow(/STORAGE_DRIVER=local/);
    expect(() => refuseUnsafeSandboxEnv({ ...SANDBOX_ENV, SMTP_HOST: '  ' })).not.toThrow();
  });

  it("uses the seed's tenant and resets at 03:00", () => {
    expect(SANDBOX_TENANT_ID).toBe(DEMO_TENANT_ID);
    expect(nextReset(new Date('2026-11-20T02:59:00Z')).toISOString()).toBe('2026-11-20T03:00:00.000Z');
    expect(nextReset(new Date('2026-11-20T03:00:00Z')).toISOString()).toBe('2026-11-21T03:00:00.000Z');
  });

  it('lists what makes a database not a sandbox', () => {
    expect(notASandbox(VALID)).toBeNull();
    expect(notASandbox({ ...VALID, markerTenant: null })).toMatch(/no sandbox marker/);
    expect(notASandbox({ ...VALID, siteTenant: '00000000-0000-4000-8000-000000000001' })).toMatch(/first-run setup/);
    expect(notASandbox({ ...VALID, otherTenants: 1, tenants: 2 })).toMatch(/1 tenant besides/);
    expect(notASandbox({ ...VALID, outsidePeople: 3 })).toMatch(/3 people have a real email address/);
    expect(notASandbox({ ...VALID, outsideLogins: 1 })).toMatch(/1 login has a real email address/);
  });
});

describe('the start check', () => {
  it('refuses the flag on an empty database', async () => {
    const { db, pg } = await freshDatabase();
    try {
      await expect(checkSandboxStart(db, 'api', { env: SANDBOX_ENV, dbRole: 'vdrkit_app' })).rejects.toThrow(/not a sandbox: it carries no sandbox marker.*The api does not start/);
      const warn: string[] = [];
      expect(await checkSandboxStart(db, 'api', { env: {}, dbRole: 'vdrkit_app', warn: (m) => warn.push(m) })).toBe(false);
      expect(warn).toEqual([]);
    } finally { await pg.close(); }
  });

  it('refuses the flag on a normal installation', async () => {
    const h = await heron();
    try {
      await expect(checkSandboxStart(h.db, 'worker', { env: SANDBOX_ENV, dbRole: 'vdrkit_app' })).rejects.toBeInstanceOf(SandboxRefused);
      await expect(checkSandboxStart(h.db, 'api', { env: { ...SANDBOX_ENV, SMTP_HOST: 'smtp.example.net' }, dbRole: 'vdrkit_app' })).rejects.toThrow(/never sends email/);
      await h.app((tx) => tx.query(`insert into person (tenant_id, name, email) values (current_tenant_id(), 'Real Person', 'real.person@gmail.com')`));
      expect((await sandboxState(h.db, 'vdrkit_app')).outsidePeople).toBe(1);
    } finally { await h.pg.close(); }
  });

  it('should not reset a normal installation', async () => {
    const h = await heron();
    const owner = ownerOf(h);
    const dir = await folder();
    try {
      await expect(resetSandbox('reset', resetOptions(h.db, dir, owner.db))).rejects.toThrow(/not a sandbox: it carries no sandbox marker/);
      await expect(resetSandbox('init', resetOptions(h.db, dir, owner.db))).rejects.toBeInstanceOf(SandboxRefused);
      expect((await h.pg.query<{ n: number }>(`select count(*)::int as n from workspace`)).rows[0]!.n).toBe(1);
      expect((await h.pg.query<{ n: number }>(`select count(*)::int as n from person`)).rows[0]!.n).toBeGreaterThan(3);
      expect(await readdir(dir)).toEqual([]);
    } finally { await owner.end(); await h.pg.close(); }
  });

  it('refuses to reset across two databases', async () => {
    const sandbox = await freshDatabase();
    const other = await heron();
    const owner = ownerOf(sandbox);
    const dir = await folder();
    try {
      await expect(resetSandbox('init', resetOptions(other.db, dir, owner.db))).rejects.toThrow(
        /MIGRATION_DATABASE_URL and DATABASE_URL reach different databases .* The sandbox reset changes nothing/);
      expect((await other.pg.query<{ n: number }>(`select count(*)::int as n from workspace`)).rows[0]!.n).toBe(1);
      expect(await readdir(dir)).toEqual([]);
    } finally { await owner.end(); await sandbox.pg.close(); await other.pg.close(); }
  });

  it('retries failed resets', async () => {
    const quiet = console.error;
    console.error = () => undefined;
    try {
      let n = 0;
      expect(await resetWithRetries(async () => { if (++n < 3) throw new Error('the database went away'); }, 1, 4)).toBe(true);
      expect(n).toBe(3);
      n = 0;
      expect(await resetWithRetries(async () => { n++; throw new Error('still down'); }, 1, 4)).toBe(false);
      expect(n).toBe(4);
      n = 0;
      expect(await resetWithRetries(async () => { n++; throw new SandboxRefused('not a sandbox'); }, 1, 4)).toBe(false);
      expect(n).toBe(1);
    } finally { console.error = quiet; }
  });

  it('refuses a cache folder with other files', async () => {
    const fresh = await freshDatabase();
    const owner = ownerOf(fresh);
    const dir = await folder();
    try {
      await writeFile(join(dir, 'someone-elses-file.txt'), 'keep me');
      await expect(resetSandbox('init', resetOptions(fresh.db, dir, owner.db))).rejects.toThrow(/not a sandbox folder/);
      expect(await readdir(dir)).toEqual(['someone-elses-file.txt']);
    } finally { await owner.end(); await fresh.pg.close(); }
  });
});

describe('a sandbox', () => {
  let db: Database;
  let pg: TestPg;
  let owner: ReturnType<typeof ownerOf>;
  let ownerUrl: string | undefined;
  let dir: string;
  let app: FastifyInstance;
  let normal: FastifyInstance;
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows;

  beforeAll(async () => {
    const fresh = await freshDatabase();
    ({ db, pg, ownerUrl } = fresh);
    owner = ownerOf(fresh);
    dir = await folder();
    const r = await resetSandbox('init', resetOptions(db, dir, owner.db));
    expect(r.action).toBe('seeded');
    expect(r.cache).toBe('built');
    expect(r.documents).toBeGreaterThan(30);
    const auth = createBetterAuth({ db, pool: fresh.appPool ?? poolFromPGlite(pg), secret: SECRET, publicUrl: URL_, mailer: sandboxMailer, dbRole: 'vdrkit_app', builtInRateLimit: false });
    const common = {
      db, auth: new BetterAuthAuthenticator(auth, db, 'vdrkit_app'), dbRole: 'vdrkit_app' as const, mailer: sandboxMailer, publicUrl: URL_,
      plugins: [betterAuthRoutes(auth, URL_), sessionRoutes(auth)], rateLimit: false as const, storage: new LocalDiskStorage(dir),
      keyring: new DbKeyring(new LocalKeyProvider(masterKey)), queue: new MemoryQueue(), site: { setup: false as const },
    };
    app = await buildApp({ ...common, sandbox: { auth } });
    normal = await buildApp(common);
  }, 240_000);
  afterAll(async () => {
    await app?.close();
    await normal?.close();
    await owner?.end();
    await pg?.close();
  });

  const post = (a: FastifyInstance, url: string, payload: unknown, cookie?: string, origin = URL_) =>
    a.inject({ method: 'POST', url, headers: { origin, ...(cookie ? { cookie } : {}) }, payload: payload as object });
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, cookie: string, payload?: unknown) =>
    app.inject({ method, url, headers: { origin: URL_, cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie'] ?? '').split(';')[0]!;
  async function enter(person: string, cookie?: string): Promise<string> {
    const res = await post(app, '/v1/sandbox/sign-in', { person }, cookie);
    expect(res.statusCode, res.body).toBe(200);
    return cookieOf(res);
  }

  it('warns without the flag', async () => {
    expect(await checkSandboxStart(db, 'api', { env: SANDBOX_ENV, dbRole: 'vdrkit_app' })).toBe(true);
    const warn: string[] = [];
    expect(await checkSandboxStart(db, 'api', { env: {}, dbRole: 'vdrkit_app', warn: (m) => warn.push(m) })).toBe(false);
    expect(warn.join('')).toMatch(/marked as the VDRkit sandbox, but VDRKIT_SANDBOX is not set/);
    expect(await q(`select require_two_factor from workspace group by 1`)).toEqual([{ require_two_factor: false }]);
    expect(existsSync(join(dir, STORAGE_MARKER))).toBe(true);
    await expect(withTenant(db, SANDBOX_TENANT_ID, (tx) => tx.query(`delete from sandbox_instance`), { role: 'vdrkit_app' })).rejects.toThrow(/permission denied/);
  });

  const HERON = SANDBOX_WORKSPACE_ID;
  const app_ = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    withTenant(db, SANDBOX_TENANT_ID, async (tx) => (await tx.query<T>(sql, params)).rows, { role: 'vdrkit_app' });

  it('loads the sandbox room', async () => {
    const [n] = await app_<{ published: number; drafts: number; top: number }>(
      `select count(*) filter (where kind = 'document' and state = 'published')::int as published, count(*) filter (where kind = 'document' and state = 'draft')::int as drafts,
              count(*) filter (where parent_id is null)::int as top from node where workspace_id = $1`, [HERON]);
    expect(n!.published).toBeGreaterThanOrEqual(280);
    expect(n!.published).toBeLessThanOrEqual(320);
    expect(n!.drafts).toBeGreaterThanOrEqual(20);
    expect(n!.drafts).toBeLessThanOrEqual(40);
    expect(n!.top).toBe(11);
    const [v] = await app_<{ waiting: number; released: number }>(
      `select count(*) filter (where awaiting_release)::int as waiting, count(*) filter (where not awaiting_release)::int as released
         from document_version d join node n on n.id = d.node_id where n.workspace_id = $1 and d.version_no = 2`, [HERON]);
    expect(v).toEqual({ waiting: 3, released: 3 });
    expect(await app_(`select 1 from document_version where processing_status <> 'ready'`)).toEqual([]);
    const reads = async (person: string) => (await app_<{ top: string }>(
      `select distinct split_part(n.index_number, '.', 1) as top from readable_nodes($1, $2, now(), record_clock(), false) a join node n on n.id = a.node_id
        where n.kind = 'document' order by 1`, [sid(`person:${person}`), HERON])).map((x) => x.top).sort((a, b) => Number(a) - Number(b));
    expect(await reads('jan')).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']);
    expect(await reads('mei')).toEqual(['1', '2', '3', '4', '5', '7', '10', '11']);
    expect(await reads('sipho')).toEqual(['1', '2', '3', '4', '5', '6', '7', '9', '10']);
    expect(await reads('lars')).toEqual(['3']);
    expect(await app_(`select email from person where email !~ '@([a-z0-9-]+[.])*example[.]com$'`)).toEqual([]);
  });

  it('processes the sample files', async () => {
    const versions = await app_<{ id: string; ix: string; pages: number; images: number; thumbs: number; texts: number; status: string; mime: string }>(
      `select d.id, n.index_number as ix, d.page_count as pages, d.processing_status as status, d.mime,
              (select count(*)::int from derived_file f where f.version_id = d.id and f.kind = 'page_image') as images,
              (select count(*)::int from derived_file f where f.version_id = d.id and f.kind = 'thumbnail') as thumbs,
              (select count(*)::int from document_text t where t.version_id = d.id) as texts
         from document_version d join node n on n.id = d.node_id where n.workspace_id = $1 and not d.metadata ? 'placeholder'`, [HERON]);
    expect(new Set(versions.map((x) => x.ix))).toEqual(SAMPLE);
    expect(new Set(versions.map((x) => x.mime.split('.').pop()))).toEqual(new Set(['application/pdf', 'document', 'sheet', 'presentation']));
    for (const x of versions) {
      expect(x.status, x.ix).toBe('ready');
      expect(x.pages, x.ix).toBeGreaterThanOrEqual(1);
      expect(x.pages, x.ix).toBeLessThanOrEqual(15);
      expect(x.images, x.ix).toBe(x.pages);
      expect(x.thumbs, x.ix).toBe(x.pages);
      expect(x.texts, x.ix).toBeGreaterThan(0);
    }
    const [img] = await app_<{ storage_key: string }>(`select f.storage_key from derived_file f join document_version d on d.id = f.version_id
      join node n on n.id = d.node_id where n.index_number = '3.5.2' and f.kind = 'page_image' order by f.storage_key limit 1`);
    const dk = await withTenant(db, SANDBOX_TENANT_ID, (tx) => new DbKeyring(new LocalKeyProvider(masterKey)).dataKey(tx, HERON), { role: 'vdrkit_app' });
    const page = await decryptBuffer(dk.key, await new LocalDiskStorage(dir).get(img!.storage_key), img!.storage_key);
    expect(page.subarray(0, 4).toString()).toBe('RIFF');
    const others = await app_<{ ws: string; n: number; placeholders: number; images: number }>(
      `select n.workspace_id as ws, count(*)::int as n, count(*) filter (where d.metadata ? 'placeholder')::int as placeholders,
              min((select count(*) from derived_file f where f.version_id = d.id and f.kind = 'page_image'))::int as images
         from document_version d join node n on n.id = d.node_id where n.workspace_id <> $1 group by 1`, [HERON]);
    expect(others.map((x) => x.n).reduce((a, b) => a + b, 0)).toBe(20);
    for (const x of others) {
      expect(x.placeholders, x.ws).toBe(0);
      expect(x.images, x.ws).toBeGreaterThan(0);
    }
    const roomKeys = await app_<{ n: number }>(`select count(distinct workspace_id)::int as n from workspace_key where workspace_id = any($1::uuid[])`,
      [[HERON, ...others.map((x) => x.ws)]]);
    expect(roomKeys).toEqual([{ n: 4 }]);
    const hits = await app_<{ ix: string }>(`select distinct n.index_number as ix from document_text t join node n on n.id = t.node_id
      where to_tsvector('english', t.body) @@ phraseto_tsquery('english', 'consents tracker for the sale')`);
    expect(hits.map((h) => h.ix)).toContain('3.5.2');
  });

  it('refuses a foreign cache folder', async () => {
    const other = await folder();
    await writeFile(join(other, 'keep-me.txt'), 'not the cache');
    await expect(resetSandbox('reset', { ...resetOptions(db, dir, owner.db), cacheDir: other })).rejects.toThrow(/not the sandbox cache/);
    expect(await readdir(other)).toEqual(['keep-me.txt']);
    expect(await q(`select count(*)::int as n from workspace where id = $1`, [HERON])).toEqual([{ n: 1 }]);
    expect(existsSync(join(dir, CACHE_FOLDER, CACHE_MARKER))).toBe(true);
  });

  it('refuses a real address while the marker exists', async () => {
    await expect(withTenant(db, SANDBOX_TENANT_ID, (tx) => tx.query(
      `insert into person (tenant_id, name, email) values (current_tenant_id(), 'Real', 'someone@gmail.com')`), { role: 'vdrkit_app' })).rejects.toMatchObject({ code: 'VS001' });
    await withTenant(db, SANDBOX_TENANT_ID, (tx) => tx.query(
      `insert into person (tenant_id, name, email) values (current_tenant_id(), 'Invented', 'invented@team.example.com')`), { role: 'vdrkit_app' });
  });

  it('serves the Try VDRkit page only in sandbox mode', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/sandbox' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.resetTime).toBe('03:00 UTC');
    expect(body.people.map((p: { key: string }) => p.key)).toEqual(SANDBOX_PEOPLE.map((p) => p.key));
    expect(body.people[0]).toMatchObject({ key: 'anika', name: 'Anika Pillay', group: 'admin' });
    expect((await normal.inject({ method: 'GET', url: '/v1/sandbox' })).statusCode).toBe(404);
  });

  it('has no sandbox sign-in outside sandbox mode', async () => {
    expect((await post(normal, '/v1/sandbox/sign-in', { person: 'anika' })).statusCode).toBe(404);
    expect((await normal.inject({ method: 'POST', url: '/v1/sandbox/sign-in', payload: { person: 'anika' } })).statusCode).toBe(404);
    // /v1/sandbox skips auth
    await normal.ready();
    expect(normal.printRoutes({ commonPrefix: false })).not.toContain('sandbox');
    expect(app.printRoutes({ commonPrefix: false })).toContain('sandbox');
  });

  it('signs a visitor in as a demo person', async () => {
    const res = await post(app, '/v1/sandbox/sign-in', { person: 'jan' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ person: 'jan', name: 'Jan de Vries', next: `/rooms/${SANDBOX_WORKSPACE_ID}/dashboard` });
    const jan = cookieOf(res);
    expect(String(res.headers['set-cookie'])).toMatch(/HttpOnly/i);
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: jan } });
    expect(me.statusCode).toBe(200);
    expect(me.json().name).toBe('Jan de Vries');
    expect(await q(`select ip_address, user_agent from auth_session where user_id = 'sandbox-jan'`)).toEqual([{ ip_address: null, user_agent: null }]);
    const anika = await enter('anika', jan);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: jan } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: anika } })).json().name).toBe('Anika Pillay');
  });

  it("accepts only demo people's keys from this site", async () => {
    expect((await post(app, '/v1/sandbox/sign-in', { person: 'thabo' })).statusCode).toBe(400);
    expect((await post(app, '/v1/sandbox/sign-in', { person: ANIKA })).statusCode).toBe(400);
    expect((await post(app, '/v1/sandbox/sign-in', { person: 'anika', personId: ANIKA })).statusCode).toBe(400);
    expect((await post(app, '/v1/sandbox/sign-in', {})).statusCode).toBe(400);
    const cross = await post(app, '/v1/sandbox/sign-in', { person: 'anika' }, undefined, 'https://evil.example.net');
    expect(cross.statusCode).toBe(403);
    expect(cross.headers['set-cookie']).toBeUndefined();
  });

  it('has no email sign-in or two-factor set-up', async () => {
    expect((await post(app, '/v1/auth/sign-in/magic-link', { email: 'anika@seller.example.com' })).statusCode).toBe(404);
    expect((await post(app, '/v1/auth/email-otp/send-verification-otp', { email: 'anika@seller.example.com', type: 'sign-in' })).statusCode).toBe(404);
    const cookie = await enter('maria');
    expect((await post(app, '/v1/auth/two-factor/enable', {}, cookie)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/auth/get-session', headers: { cookie } })).statusCode).toBe(200);
    expect((await post(app, '/v1/auth/sign-out', {}, cookie)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('should refuse changes that break the demo', async () => {
    const anika = await enter('anika');
    const refused = async (method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload: unknown = {}) => {
      const res = await call(method, url, anika, payload);
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(403);
      expect(res.json().reason, url).toBe('sandbox_refused');
    };
    await refused('PATCH', '/v1/site/settings', { organisationName: 'Taken over' });
    await refused('PATCH', '/v1/site/settings', { mail: { host: 'smtp.example.net' } });
    await refused('DELETE', '/v1/site/settings/mail');
    await refused('POST', '/v1/site/mail/test', { to: 'x@example.com' });
    await refused('POST', `/v1/site/accounts/${JAN}/disable`);
    await refused('POST', `/v1/site/accounts/${JAN}/reset-two-factor`);
    await refused('POST', '/v1/site/admins', { email: 'new@example.com' });
    await refused('POST', '/v1/workspaces', { name: 'My own room' });
    await refused('PATCH', `/v1/workspaces/${SANDBOX_WORKSPACE_ID}/settings`, { requireTwoFactor: true });
    await refused('PATCH', `/v1/workspaces/${SANDBOX_WORKSPACE_ID}/settings`, { state: 'closed' });
    await refused('POST', `/v1/workspaces/${SANDBOX_WORKSPACE_ID}/people/${JAN}/email-change`, { email: 'jan@example.net' });
    await refused('POST', '/v1/me/sign-out-everywhere');
    const [m] = await q<{ id: string }>(`select m.id from membership m join groups g on g.id = m.group_id where m.person_id = $1 and g.workspace_id = $2`, [JAN, SANDBOX_WORKSPACE_ID]);
    await refused('POST', `/v1/workspaces/${SANDBOX_WORKSPACE_ID}/memberships/${m!.id}/revoke`);
    await refused('POST', `/v1/workspaces/${SANDBOX_WORKSPACE_ID}/groups/${sid('group:Bidder A')}/revoke`);
    await refused('PATCH', `/v1/workspaces/${SANDBOX_WORKSPACE_ID}/groups/${sid('group:Bidder A')}`, { accessEndsAt: '2026-01-01T00:00:00Z' });
    const ok = await call('PATCH', `/v1/workspaces/${SANDBOX_WORKSPACE_ID}/settings`, anika, { name: 'Project Heron renamed' });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('sends no invitation emails', async () => {
    const anika = await enter('anika');
    const invite = (email: string) => call('POST', `/v1/workspaces/${SANDBOX_WORKSPACE_ID}/invitations`, anika,
      { groupId: sid('group:Bidder A'), people: [{ email }] });
    const real = await invite('someone@gmail.com');
    expect(real.statusCode, real.body).toBe(422);
    expect(real.json()).toMatchObject({ reason: 'sandbox_address' });
    const ok = await invite('new.analyst@bidder-a.example.com');
    expect(ok.statusCode, ok.body).toBe(201);
    const events = await q<{ action: string }>(`select action from event where resource_id = $1 order by seq`, [ok.json().invitations[0].id]);
    expect(events.map((e) => e.action)).toEqual(['invitation.created', 'invitation.not_sent']);
  });

  it('caps uploads per file and per day', async () => {
    const anika = await enter('anika');
    const start = (size: number, n: number) => call('POST', `/v1/workspaces/${SANDBOX_WORKSPACE_ID}/upload-sessions`, anika,
      { targetFolderId: sid('node:1'), path: `Sandbox file ${n}.pdf`, size, sha256: 'a'.repeat(64), mime: 'application/pdf' });
    const big = await start(SANDBOX_MAX_FILE_BYTES + 1, 0);
    expect(big.statusCode).toBe(413);
    expect(big.json().reason).toBe('sandbox_file_too_large');
    for (let i = 1; i <= SANDBOX_UPLOADS_PER_VISITOR_PER_DAY; i++) expect((await start(1000, i)).statusCode).toBe(201);
    const over = await start(1000, 99);
    expect(over.statusCode).toBe(429);
    expect(over.json().reason).toBe('sandbox_upload_limit');
  });

  it('resets the demo but keeps keys', async () => {
    const keysBefore = await q<{ workspace_id: string; wrapped: string }>(`select workspace_id, wrapped from workspace_key order by workspace_id, version`);
    expect(keysBefore.length).toBeGreaterThan(0);
    expect(await q(`select name from workspace where id = $1`, [SANDBOX_WORKSPACE_ID])).toEqual([{ name: 'Project Heron renamed' }]);
    await writeFile(join(dir, 'visitor-left-this.bin'), 'x');

    const before = await q<{ n: number }>(`select count(*)::int as n from derived_file`);
    const r = await resetSandbox('reset', resetOptions(db, dir, owner.db));
    expect(r.action).toBe('reset');
    expect(r.cache).toBe('used');
    expect(await q(`select count(*)::int as n from derived_file`)).toEqual(before);
    expect(existsSync(join(dir, CACHE_FOLDER, CACHE_MARKER))).toBe(true);
    expect(await q(`select name from workspace where id = $1`, [SANDBOX_WORKSPACE_ID])).toEqual([{ name: 'Project Heron' }]);
    expect(await q(`select count(*)::int as n from upload_session`)).toEqual([{ n: 0 }]);
    expect(await q(`select count(*)::int as n from auth_session`)).toEqual([{ n: 0 }]);
    expect(await q(`select count(*)::int as n from person where email like '%new.analyst%' or email like 'invented@%'`)).toEqual([{ n: 0 }]);
    expect(existsSync(join(dir, 'visitor-left-this.bin'))).toBe(false);
    expect(existsSync(join(dir, STORAGE_MARKER))).toBe(true);
    expect(await q(`select workspace_id, wrapped from workspace_key order by workspace_id, version`)).toEqual(keysBefore);
    expect(await checkSandboxStart(db, 'api', { env: SANDBOX_ENV, dbRole: 'vdrkit_app' })).toBe(true);
    await enter('pieter');
    expect((await resetSandbox('init', resetOptions(db, dir, owner.db))).action).toBe('kept');
  }, 240_000);

  it.skipIf(!TEST_DATABASE_URL)('runs one reset at a time', async () => {
    // as a second sandbox-reset process
    const second = ownerOf({ db, ownerUrl });
    const lines: string[] = [];
    try {
      const run = (who: string, ownerDb: Database) => resetSandbox('reset', { ...resetOptions(db, dir, ownerDb), log: () => lines.push(who) });
      const results = await Promise.all([run('a', owner.db), run('b', second.db)]);
      expect(results.map((r) => r.action)).toEqual(['reset', 'reset']);
    } finally { await second.end(); }
    expect(new Set(lines)).toEqual(new Set(['a', 'b']));
    expect(lines.filter((who, i) => i > 0 && who !== lines[i - 1])).toHaveLength(1);
    expect(await checkSandboxStart(db, 'api', { env: SANDBOX_ENV, dbRole: 'vdrkit_app' })).toBe(true);
  }, 240_000);

  it('recovers from a half-done reset', async () => {
    let calls = 0;
    const dropping: Database = {
      transaction: (fn) => (++calls > 1 ? Promise.reject(new Error('the connection dropped')) : db.transaction(fn)),
      exec: () => Promise.reject(new Error('the connection dropped')),
    };
    await expect(resetSandbox('reset', resetOptions(dropping, dir, owner.db))).rejects.toThrow('the connection dropped');
    expect(await q(`select count(*)::int as n from workspace`)).toEqual([{ n: 0 }]);
    expect(existsSync(join(dir, STORAGE_MARKER))).toBe(true);
    const r = await resetSandbox('reset', resetOptions(db, dir, owner.db));
    expect(r.action).not.toBe('kept');
    expect(await q(`select name from workspace where id = $1`, [SANDBOX_WORKSPACE_ID])).toEqual([{ name: 'Project Heron' }]);
    expect(await checkSandboxStart(db, 'api', { env: SANDBOX_ENV, dbRole: 'vdrkit_app' })).toBe(true);
  }, 240_000);

  it('reuses the cache and key on a new database', async () => {
    const fresh = await freshDatabase();
    const freshOwner = ownerOf(fresh);
    try {
      const r = await resetSandbox('init', resetOptions(fresh.db, dir, freshOwner.db));
      expect(r).toMatchObject({ action: 'seeded', cache: 'used' });
      const keys = `select workspace_id, wrapped from workspace_key order by workspace_id, version`;
      expect((await fresh.pg.query(keys)).rows).toEqual(await q(keys));
    } finally { await freshOwner.end(); await fresh.pg.close(); }
  }, 240_000);
});
