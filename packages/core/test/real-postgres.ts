// SPDX-License-Identifier: AGPL-3.0-only
// Runs the tests on a real Postgres when TEST_DATABASE_URL points at a superuser on a throwaway server.
// Each file migrates a template database as vdrkit_owner; each fixture gets a copy and connects as vdrkit_app.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll } from 'vitest';
import { fromPgPool, migrate, type Database } from '../src/index.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const OWNER_PASSWORD = 'vdrkit_owner_test';
const APP_PASSWORD = 'vdrkit_app_test';

export interface TestPg {
  query<T = any>(text: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

export interface RealDatabase {
  db: Database;
  appPool: pg.Pool;
  pg: TestPg;
  url: { owner: string; app: string; superuser: string };
}

function urlFor(base: string, database: string, user?: string, password?: string): string {
  const u = new URL(base);
  u.pathname = `/${database}`;
  if (user) {
    u.username = user;
    u.password = password ?? '';
  }
  return u.toString();
}

let adminPool: pg.Pool | null = null;
function admin(): pg.Pool {
  adminPool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  return adminPool;
}

async function ensureRole(client: pg.PoolClient, name: string, password: string): Promise<void> {
  const r = await client.query<{ rolcanlogin: boolean }>(`select rolcanlogin from pg_roles where rolname = $1`, [name]);
  if (!r.rows[0]) await client.query(`create role ${name} login nosuperuser nobypassrls password '${password}'`);
  else if (!r.rows[0].rolcanlogin) await client.query(`alter role ${name} login password '${password}'`);
}

let rolesReady: Promise<void> | null = null;
function ensureRoles(): Promise<void> {
  rolesReady ??= (async () => {
    // test files run in parallel processes
    const client = await admin().connect();
    try {
      await client.query(`select pg_advisory_lock(hashtext('vdrkit test roles'))`);
      await ensureRole(client, 'vdrkit_owner', OWNER_PASSWORD);
      await ensureRole(client, 'vdrkit_app', APP_PASSWORD);
    } finally {
      await client.query(`select pg_advisory_unlock(hashtext('vdrkit test roles'))`).catch(() => undefined);
      client.release();
    }
  })();
  return rolesReady;
}

const fileTag = randomBytes(5).toString('hex');
let template: Promise<string> | null = null;
let copies = 0;
const open = new Set<string>();

function ensureTemplate(): Promise<string> {
  template ??= (async () => {
    await ensureRoles();
    const name = `vdrkit_t_${fileTag}`;
    await admin().query(`create database ${name} owner vdrkit_owner`);
    const owner = new pg.Pool({ connectionString: urlFor(TEST_DATABASE_URL!, name, 'vdrkit_owner', OWNER_PASSWORD), max: 1 });
    try {
      await migrate(fromPgPool(owner));
    } catch (err) {
      await owner.end();
      await admin().query(`drop database if exists ${name} with (force)`);
      throw err;
    }
    await owner.end();
    return name;
  })();
  return template;
}

// pool.end() can return before the server sees the connections close
async function dropDatabase(name: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const r = await admin().query(`select count(*)::int n from pg_stat_activity where datname = $1`, [name]);
    if (r.rows[0].n === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await admin().query(`drop database if exists ${name} with (force)`);
}

export async function realDatabase(): Promise<RealDatabase & { close(): Promise<void> }> {
  const tpl = await ensureTemplate();
  const name = `${tpl}_${++copies}`;
  await admin().query(`create database ${name} template ${tpl} owner vdrkit_owner`);
  open.add(name);
  const url = {
    owner: urlFor(TEST_DATABASE_URL!, name, 'vdrkit_owner', OWNER_PASSWORD),
    app: urlFor(TEST_DATABASE_URL!, name, 'vdrkit_app', APP_PASSWORD),
    superuser: urlFor(TEST_DATABASE_URL!, name),
  };
  const appPool = new pg.Pool({ connectionString: url.app, max: 4 });
  const su = new pg.Pool({ connectionString: url.superuser, max: 1 });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.all([appPool.end(), su.end()]);
    await dropDatabase(name);
    open.delete(name);
  };
  return {
    db: fromPgPool(appPool),
    appPool,
    url,
    pg: {
      async query(text, params) {
        const r = await su.query(text, params as unknown[]);
        return { rows: r.rows, affectedRows: r.rowCount ?? 0 };
      },
      exec: (sql) => su.query(sql),
      close,
    },
    close,
  };
}

export async function emptyOwnerDatabase(): Promise<{ url: { owner: string; superuser: string }; drop(): Promise<void> }> {
  await ensureRoles();
  const name = `vdrkit_e_${fileTag}_${++copies}`;
  await admin().query(`create database ${name} owner vdrkit_owner`);
  open.add(name);
  return {
    url: {
      owner: urlFor(TEST_DATABASE_URL!, name, 'vdrkit_owner', OWNER_PASSWORD),
      superuser: urlFor(TEST_DATABASE_URL!, name),
    },
    async drop() {
      await dropDatabase(name);
      open.delete(name);
    },
  };
}

if (TEST_DATABASE_URL) {
  afterAll(async () => {
    for (const name of open) await dropDatabase(name);
    open.clear();
    if (template) {
      const name = await template.catch(() => null);
      if (name) await admin().query(`drop database if exists ${name} with (force)`);
    }
    await adminPool?.end();
    adminPool = null;
  });
}
