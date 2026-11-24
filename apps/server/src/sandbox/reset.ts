// SPDX-License-Identifier: AGPL-3.0-only
// the empty-or-marked check is all that stops this wiping a real install
// room keys survive: running processes may hold one
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';
import { withTenant, type Database } from '@vdrkit/core';
import { newDataKey, type KeyProvider } from '../crypto/envelope.js';
import type { Storage } from '../pipeline/pipeline.js';
import type { ClamAvClient } from '../pipeline/virus-scan.js';
import { linkPersonToLogin } from '../auth/person-link.js';
import { seedDemo, seedDemoRooms, seedSiteDemo } from '../demo/seed-demo.js';
import { seedDevActivity } from '../demo/seed-activity.js';
import { allSandboxDocuments, SANDBOX_PLAN, workspaceOf, type RoomDoc } from './room/catalogue.js';
import { cachedKeys, ensureCache, newKeyRow, restoreCache, type KeyRow, type RoomKey } from './room/cache.js';
import { isEmpty, notASandbox, sandboxState, SandboxRefused } from './check.js';
import { SANDBOX_SEED_VERSION, SANDBOX_TENANT_ID } from './config.js';
import { SANDBOX_PEOPLE, sandboxPersonId } from './people.js';

export const STORAGE_MARKER = '.vdrkit-sandbox';
export const CACHE_FOLDER = '.sandbox-cache';
const MARKER_TEXT = 'This folder belongs to the VDRkit sandbox. sandbox-reset empties it every day, except the sandbox cache.\n';

export interface ResetOptions {
  ownerDb: Database;
  appDb: Database;
  /** PGlite tests: superuser, switch role */
  appRole?: 'vdrkit_app';
  storageDir: string;
  storage: Storage;
  keyProvider: KeyProvider;
  gotenbergUrl?: string | null;
  clamav?: ClamAvClient | null;
  cacheDir?: string;
  documents?: (d: RoomDoc) => boolean;
  concurrency?: number;
  log?: (msg: string) => void;
}

export type ResetResult = {
  action: 'seeded' | 'reset' | 'kept';
  documents: number;
  pages: number;
  cache?: 'built' | 'used';
  seconds?: number;
};

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

function safeFolder(dir: string): string {
  const abs = resolve(dir);
  if (parse(abs).root === abs || abs.split(/[\\/]/).filter(Boolean).length < 2) {
    throw new SandboxRefused(`The files folder ${abs} is too near the root of the file system; the sandbox reset will not empty it.`);
  }
  return abs;
}

async function entriesOf(dir: string): Promise<string[]> {
  return existsSync(dir) ? readdir(dir) : [];
}

// the checks run on the owner's connection, the seed on the application's: both must reach one database
async function sameDatabase(owner: Database, app: Database): Promise<void> {
  const ask = async (db: Database) => (await db.transaction((tx) => tx.query<{ db: string; oid: string; started: string }>(
    `select current_database() as db, (select oid from pg_database where datname = current_database())::text as oid,
            pg_postmaster_start_time()::text as started`))).rows[0]!;
  const [a, b] = [await ask(owner), await ask(app)];
  if (a.db !== b.db || a.oid !== b.oid || a.started !== b.started) {
    throw new SandboxRefused(`MIGRATION_DATABASE_URL and DATABASE_URL reach different databases (${a.db} and ${b.db}, or two servers). `
      + "The sandbox reset changes nothing. Point both at the sandbox's database.");
  }
}

async function locked<T>(db: Database, fn: () => Promise<T>): Promise<T> {
  const key = 'vdrkit sandbox reset';
  if (!db.session) return fn();
  return db.session(async (s) => {
    await s.transaction((tx) => tx.query(`select pg_advisory_lock(hashtext($1))`, [key]));
    try {
      return await fn();
    } finally {
      await s.transaction((tx) => tx.query(`select pg_advisory_unlock(hashtext($1))`, [key])).catch(() => undefined);
    }
  });
}

export async function resetSandbox(mode: 'init' | 'reset', o: ResetOptions): Promise<ResetResult> {
  const log = o.log ?? (() => undefined);
  const dir = safeFolder(o.storageDir);
  const cacheDir = resolve(o.cacheDir ?? join(dir, CACHE_FOLDER));
  const started = Date.now();
  return locked(o.ownerDb, async () => {
    await sameDatabase(o.ownerDb, o.appDb);
    const state = await sandboxState(o.ownerDb);
    const files = await entriesOf(dir);
    let wipe = false;
    if (isEmpty(state)) {
      if (files.length && !files.includes(STORAGE_MARKER)) {
        throw new SandboxRefused(`The database is empty, but the files folder ${dir} is not, and it is not a sandbox folder. `
          + 'The sandbox reset does not empty it. Give the sandbox a folder of its own.');
      }
      wipe = files.length > 0;
    } else {
      const why = notASandbox(state);
      if (why) throw new SandboxRefused(`This database is not a sandbox: ${why}. The sandbox reset changes nothing.`);
      if (files.length && !files.includes(STORAGE_MARKER)) {
        throw new SandboxRefused(`The files folder ${dir} is not the sandbox's (it has no ${STORAGE_MARKER} file). The sandbox reset changes nothing.`);
      }
      if (mode === 'init' && state.seedVersion === SANDBOX_SEED_VERSION) {
        log('The sandbox is loaded and current. Nothing to do.');
        return { action: 'kept', documents: 0, pages: 0 };
      }
      wipe = true;
    }

    const keys = isEmpty(state) ? [] : await withTenant(o.ownerDb, SANDBOX_TENANT_ID, async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(`select * from workspace_key`);
      return rows;
    });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, STORAGE_MARKER), MARKER_TEXT);

    const roomKeys = new Map<string, RoomKey>();
    const old = await cachedKeys(cacheDir);
    const unwrap = (k: KeyRow, ws: string) => o.keyProvider.unwrap({ provider: k.provider, keyVersion: k.provider_key_version, blob: k.wrapped }, ws);
    for (const ws of new Set(allSandboxDocuments().map((d) => workspaceOf(SANDBOX_TENANT_ID, d)))) {
      const current = (keys as unknown as KeyRow[])
        .filter((k) => k.workspace_id === ws && k.wrapped)
        .sort((a, b) => b.version - a.version)[0];
      if (current) {
        roomKeys.set(ws, { row: current, dataKey: await unwrap(current, ws) });
        continue;
      }
      const cached = old.find((k) => k.workspace_id === ws && k.tenant_id === SANDBOX_TENANT_ID);
      const dataKey = cached && await unwrap(cached, ws).catch(() => null);
      let key: RoomKey;
      if (cached && dataKey) key = { row: cached, dataKey };
      else {
        const fresh = newDataKey();
        key = { row: newKeyRow(SANDBOX_TENANT_ID, ws, await o.keyProvider.wrap(fresh, ws)), dataKey: fresh };
      }
      roomKeys.set(ws, key);
      keys.push(key.row as unknown as Record<string, unknown>);
    }

    // before wiping: a cold build is slow
    const { manifest, built } = await ensureCache({
      dir: cacheDir, storageDir: dir, tenantId: SANDBOX_TENANT_ID, keys: roomKeys, gotenbergUrl: o.gotenbergUrl, clamav: o.clamav,
      documents: o.documents, concurrency: o.concurrency, log,
    });
    if (!built) log(`Using the sandbox cache: ${manifest.versions.length} files.`);

    if (wipe) {
      const tables = await o.ownerDb.transaction(async (tx) => (await tx.query<{ t: string }>(
        `select tablename as t from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations' order by 1`)).rows.map((r) => r.t));
      if (tables.length) {
        await o.ownerDb.transaction((tx) => tx.query(`truncate table ${tables.map(quote).join(', ')} restart identity cascade`));
      }
      // the marker stays: a reset that fails after this point must be able to run again
      for (const f of await entriesOf(dir)) {
        if (resolve(dir, f) !== cacheDir && f !== STORAGE_MARKER) await rm(join(dir, f), { recursive: true, force: true });
      }
      log(`Emptied ${tables.length} tables and the files folder.`);
    }

    const role = o.appRole ? { role: o.appRole } : {};
    const room = await seedDemo(o.appDb, { ...role, plan: SANDBOX_PLAN });
    // immediately: re-enables the reserved-address check
    await withTenant(o.ownerDb, SANDBOX_TENANT_ID, (tx) => tx.query(
      `insert into sandbox_instance (tenant_id, seed_version) values ($1, $2)`, [SANDBOX_TENANT_ID, SANDBOX_SEED_VERSION]));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, STORAGE_MARKER), MARKER_TEXT);
    await seedDemoRooms(o.appDb, { ...role, plan: SANDBOX_PLAN });
    await seedSiteDemo(o.appDb, role);

    await withTenant(o.appDb, SANDBOX_TENANT_ID, async (tx) => {
      await tx.query(`update workspace set require_two_factor = false`);
      for (const p of SANDBOX_PEOPLE) await linkPersonToLogin(tx, sandboxPersonId(p.key));
      if (keys.length) {
        await tx.query(`insert into workspace_key select * from json_populate_recordset(null::workspace_key, $1::json)
          where workspace_id in (select id from workspace)`, [JSON.stringify(keys)]);
      }
    }, role);

    const restored = await restoreCache({ manifest, dir: cacheDir, storageDir: dir, db: o.appDb, tenantOpts: role, keys: roomKeys });
    await seedDevActivity(o.appDb, room.tenantId, log);
    await o.ownerDb.exec('analyze').catch(() => undefined);
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    log(`Loaded Project Heron: ${room.counts.published} published documents and ${room.counts.drafts} drafts; ${restored.versions} files with ${restored.pages} pages, in ${seconds} s.`);
    return { action: isEmpty(state) ? 'seeded' : 'reset', documents: restored.versions, pages: restored.pages, cache: built ? 'built' : 'used', seconds };
  });
}
