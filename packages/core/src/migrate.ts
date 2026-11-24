// SPDX-License-Identifier: AGPL-3.0-only
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from './db.js';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export const MIGRATION_LOCK_KEY = 'vdrkit migrations';

export interface MigrateOptions {
  dir?: string;
  log?: (line: string) => void;
  lockWaitMs?: number;
  lockPollMs?: number;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class MigrationError extends Error {
  constructor(readonly file: string, cause: unknown) {
    super(`Migration ${file} failed and was rolled back. Nothing after it was applied. ${messageOf(cause)}`, { cause });
    this.name = 'MigrationError';
  }
}

async function migrationFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
}

// Run as owner. Without a session (pooler), the schema_migrations insert is the guard against double runs.
export async function migrate(db: Database, options: string | MigrateOptions = {}): Promise<string[]> {
  const o: MigrateOptions = typeof options === 'string' ? { dir: options } : options;
  const dir = o.dir ?? MIGRATIONS_DIR;
  const log = o.log ?? (() => undefined);
  const files = await migrationFiles(dir);
  const run = async (s: Database) => {
    await acquireLock(s, log, o.lockWaitMs ?? 15 * 60_000, o.lockPollMs ?? 1000);
    try {
      const ledger = `create table if not exists schema_migrations (
        name text primary key, applied_at timestamptz not null default now())`;
      // racy even with if not exists
      await s.exec(ledger).catch(() => s.exec(ledger));
      const isDone = async (file: string) => {
        const { rows } = await s.transaction((tx) =>
          tx.query<{ name: string }>('select name from schema_migrations where name = $1', [file]));
        return rows.length > 0;
      };
      const { rows } = await s.transaction((tx) => tx.query<{ name: string }>('select name from schema_migrations'));
      const done = new Set(rows.map((r) => r.name));
      const todo = files.filter((f) => !done.has(f));
      if (todo.length === 0) {
        log(`Database is up to date: ${files.length} migrations, none pending.`);
        return [];
      }
      log(`Applying ${todo.length} of ${files.length} migrations.`);
      const applied: string[] = [];
      for (const file of todo) {
        const sql = await readFile(join(dir, file), 'utf8');
        const started = Date.now();
        try {
          await s.exec(`begin;\ninsert into schema_migrations (name) values ('${file.replace(/'/g, "''")}');\n${sql}\ncommit;`);
        } catch (err) {
          await s.exec('rollback').catch(() => undefined);
          if ((err as { code?: string }).code === '23505' && await isDone(file)) {
            log(`Migration ${file} was applied by another instance meanwhile.`);
            continue;
          }
          log(`Migration ${file} failed after ${Date.now() - started} ms and was rolled back.`);
          throw new MigrationError(file, err);
        }
        log(`Migration ${file} applied in ${Date.now() - started} ms.`);
        applied.push(file);
      }
      log(`Database is up to date: ${applied.length} migrations applied.`);
      return applied;
    } finally {
      await s.transaction((tx) => tx.query(`select pg_advisory_unlock(hashtext($1))`, [MIGRATION_LOCK_KEY])).catch(() => undefined);
    }
  };
  return db.session ? db.session(run) : run(db);
}

async function acquireLock(s: Database, log: (line: string) => void, waitMs: number, pollMs: number): Promise<void> {
  const tryLock = async () => {
    const { rows } = await s.transaction((tx) =>
      tx.query<{ ok: boolean }>(`select pg_try_advisory_lock(hashtext($1)) as ok`, [MIGRATION_LOCK_KEY]));
    return rows[0]?.ok === true;
  };
  if (await tryLock()) return;
  log('Another instance is applying migrations. Waiting for it to finish.');
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, pollMs));
    if (await tryLock()) return;
  }
  throw new Error(`Another instance has held the migration lock for ${Math.round(waitMs / 1000)} seconds. Check for a stuck migration, then start again.`);
}

export async function migrationStatus(db: Database, dir: string = MIGRATIONS_DIR): Promise<{ pending: string[]; unknown: string[] }> {
  const files = await migrationFiles(dir);
  let names: string[];
  try {
    names = (await db.transaction((tx) => tx.query<{ name: string }>('select name from schema_migrations'))).rows.map((r) => r.name);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '42P01') return { pending: files, unknown: [] };
    // granted to vdrkit_app in 0250
    if (code === '42501') return { pending: files.filter((f) => f >= '0250'), unknown: [] };
    throw err;
  }
  const have = new Set(names);
  const shipped = new Set(files);
  return { pending: files.filter((f) => !have.has(f)), unknown: names.filter((n) => !shipped.has(n)).sort() };
}
