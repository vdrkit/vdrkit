// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { fromPgPool, migrate, MIGRATIONS_DIR } from '@vdrkit/core';
import { emptyOwnerDatabase, TEST_DATABASE_URL } from '../../../packages/core/test/real-postgres.js';


const SERVER = fileURLToPath(new URL('..', import.meta.url));

interface Run { code: number | null; out: string }

function start(role: string, env: Record<string, string>, until?: RegExp): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', role], {
      cwd: SERVER,
      // only PATH from the shell
      env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', NODE_ENV: 'test', VDRKIT_DEV_AUTH: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Timed out:\n${out}`)); }, 50_000);
    const take = (b: Buffer) => {
      out += b.toString();
      if (until?.test(out)) child.kill('SIGTERM');
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', reject);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe('start-up without a database', () => {
  it('refuses an unknown role', async () => {
    const r = await start('serve', {});
    expect(r.code).toBe(1);
    expect(r.out).toContain('Unknown role "serve". Use api, worker or migrate.');
  });

  it('needs the owner connection to migrate', async () => {
    const r = await start('migrate', { DATABASE_URL: 'postgres://vdrkit_app:x@127.0.0.1:1/x' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('MIGRATION_DATABASE_URL is not set. The migrate command connects as the database owner.');
  });
});

describe.skipIf(!TEST_DATABASE_URL)('start-up on a real Postgres', () => {
  async function database() {
    const e = await emptyOwnerDatabase();
    const app = new URL(e.url.owner);
    app.username = 'vdrkit_app';
    app.password = 'vdrkit_app_test';
    cleanups.push(() => e.drop());
    return { owner: e.url.owner, app: app.toString(), superuser: e.url.superuser };
  }

  it('migrate applies each migration once', async () => {
    const url = await database();
    const first = await start('migrate', { MIGRATION_DATABASE_URL: url.owner });
    expect(first.code, first.out).toBe(0);
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql'));
    for (const f of files) expect(first.out).toMatch(new RegExp(`Migration ${f.replace('.', '\\.')} applied in \\d+ ms\\.`));
    expect(first.out).toContain(`Database is up to date: ${files.length} migrations applied.`);

    const second = await start('migrate', { MIGRATION_DATABASE_URL: url.owner });
    expect(second.code).toBe(0);
    expect(second.out).toContain(`Database is up to date: ${files.length} migrations, none pending.`);
  });

  it('migrate exits 1 on failure', async () => {
    const url = await database();
    const r = await start('migrate', { MIGRATION_DATABASE_URL: url.app });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/permission denied/);
  });

  it('API refuses to start until migrated', async () => {
    const url = await database();
    const dir = await mkdtemp(join(tmpdir(), 'vdrkit-start-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const last = files.at(-1)!;
    for (const f of files.slice(0, -1)) await copyFile(join(MIGRATIONS_DIR, f), join(dir, f));
    const owner = new pg.Pool({ connectionString: url.owner, max: 1 });
    try {
      await migrate(fromPgPool(owner), dir);
    } finally {
      await owner.end();
    }

    const refused = await start('api', { DATABASE_URL: url.app, PORT: '0' });
    expect(refused.code).toBe(1);
    expect(refused.out).toContain(`The database is not up to date: 1 migration not applied (${last}). The api does not start.`);

    const worker = await start('worker', { DATABASE_URL: url.app });
    expect(worker.code).toBe(1);
    expect(worker.out).toContain('The worker does not start.');

    const started = await start('api', { DATABASE_URL: url.app, MIGRATION_DATABASE_URL: url.owner, PORT: '0' }, /Server listening at/);
    expect(started.out).toContain(`Migration ${last} applied in `);
    expect(started.out).toMatch(/Server listening at/);
  });

  it('refuses roles that bypass RLS', async () => {
    const url = await database();
    const migrated = await start('migrate', { MIGRATION_DATABASE_URL: url.owner });
    expect(migrated.code, migrated.out).toBe(0);

    // superuser connection
    const api = await start('api', { DATABASE_URL: url.superuser, PORT: '0' });
    expect(api.code).toBe(1);
    expect(api.out).toContain('is a superuser. A superuser ignores row-level security, so every room would be visible to every query. The api does not start. Point DATABASE_URL at a role');
    expect(api.out).not.toMatch(/Server listening at/);

    const worker = await start('worker', { DATABASE_URL: url.superuser });
    expect(worker.code).toBe(1);
    expect(worker.out).toContain('The worker does not start. Point DATABASE_URL at a role');

    const migrate = await start('migrate', { MIGRATION_DATABASE_URL: url.superuser });
    expect(migrate.code).toBe(1);
    expect(migrate.out).toContain('The migration does not start. Point MIGRATION_DATABASE_URL at a role');

    const ok = await start('api', { DATABASE_URL: url.app, PORT: '0' }, /Server listening at/);
    expect(ok.out).toMatch(/Server listening at/);
  });
});
