// SPDX-License-Identifier: AGPL-3.0-only
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import PgBoss from 'pg-boss';
import { fromPgPool, migrationStatus, refuseUnsafeRole, type Channel, type Database } from '@vdrkit/core';
import { LocalKeyProvider } from './crypto/envelope.js';
import { DbKeyring } from './crypto/keyring.js';
import { describeSmtp } from './mail/smtp.js';
import { SiteMailChannel } from './site/mail.js';
import { probesFromEnv } from './site/health.js';
import { GotenbergClient, type Storage } from './pipeline/pipeline.js';
import { clamAvFromEnv } from './pipeline/virus-scan.js';
import { storageFromEnv } from './storage/index.js';
import type { WorkerContext } from './worker/jobs.js';
import type { BossLike } from './worker/pg-boss-queue.js';
import { registerWorker } from './worker/runner.js';
import { sandboxFlag } from './sandbox/config.js';
import { refusePlaceholders } from './startup.js';

// QUEUE_DATABASE_URL: never vdrkit_app or the owner

export interface WorkerDeps {
  db: Database;
  storage: Storage;
  boss?: BossLike;
  mailer?: Channel;
}

function tenantOverride(): (() => Promise<string[]>) | undefined {
  const fixed = process.env.WORKER_TENANT_IDS?.split(',').map((s) => s.trim()).filter(Boolean);
  return fixed?.length ? async () => fixed : undefined;
}

// startup checks when run directly
export async function refuseUnsafeWorkerStart(db: Database): Promise<void> {
  await refuseUnsafeRole(db, 'DATABASE_URL', 'worker');
  const { pending, unknown } = await migrationStatus(db);
  if (pending.length) {
    const list = pending.length > 5 ? `${pending.slice(0, 5).join(', ')} and ${pending.length - 5} more` : pending.join(', ');
    throw new Error(`The database is not up to date: ${pending.length} migration${pending.length === 1 ? '' : 's'} not applied (${list}). `
      + 'The worker does not start. Run the migrate command first ("docker compose run --rm migrate").');
  }
  if (unknown.length) console.error(`The database has ${unknown.length} migration${unknown.length === 1 ? '' : 's'} this version does not know (${unknown.join(', ')}). It was migrated by a newer version.`);
}

export async function runWorker(deps: Partial<WorkerDeps> = {}): Promise<{ stop: () => Promise<void>; alive: () => Promise<void> }> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');
  refusePlaceholders();
  if (sandboxFlag() && !deps.mailer) throw new Error('In sandbox mode, start the worker as "node dist/main.js worker", which checks the database first.');
  const masterKey = process.env.VDRKIT_MASTER_KEY;
  if (!masterKey) throw new Error('VDRKIT_MASTER_KEY is not set.');
  const storage = deps.storage ?? storageFromEnv();
  const site = process.env.SITE_ADDRESS;
  const publicUrl = process.env.PUBLIC_URL || (site ? `https://${site}` : undefined);
  if (!storage) throw new Error('No file storage is configured. Set STORAGE_DRIVER and its settings (see src/storage/index.ts).');

  const pool = deps.db ? null : new pg.Pool({ connectionString: url, max: Number(process.env.DB_POOL_SIZE ?? 5) });
  const db = deps.db ?? fromPgPool(pool!);
  if (pool) {
    try {
      await refuseUnsafeWorkerStart(db);
    } catch (err) {
      await pool.end();
      throw err;
    }
  }
  const mailer = deps.mailer ?? new SiteMailChannel({ db, keyProvider: new LocalKeyProvider(masterKey) });
  if (!deps.mailer && !describeSmtp()) console.error('No mail server in the installation file: emails go out only once Site settings has one.');
  const boss = deps.boss ?? (new PgBoss({ connectionString: process.env.QUEUE_DATABASE_URL ?? url, schema: 'pgboss' }) as unknown as BossLike);
  boss.on('error', (err) => console.error('pg-boss:', err));
  await boss.start();

  const ctx: WorkerContext = {
    db,
    storage,
    keyring: new DbKeyring(new LocalKeyProvider(masterKey)),
    gotenberg: new GotenbergClient(process.env.GOTENBERG_URL ?? 'http://gotenberg:3000'),
    clamav: clamAvFromEnv(),
    mailer,
    now: () => new Date(),
  };
  if (publicUrl) ctx.publicUrl = publicUrl;
  await registerWorker(boss, ctx, {
    listTenants: tenantOverride(),
    notifyCron: process.env.NOTIFY_CRON ?? '* * * * *',
    reminderCron: process.env.REMINDER_CRON ?? '* * * * *',
    log: (msg, extra) => console.log(JSON.stringify({ msg, ...extra })),
    healthProbes: probesFromEnv({ db, storage, mail: mailer }),
    healthCron: process.env.HEALTH_CRON ?? '* * * * *',
    purgeCron: process.env.PURGE_CRON ?? '17 3 * * *',
    publicUrl,
  });
  console.log('Worker started: process-version, send-due-notifications, send-deadline-reminders and site-health (every minute), purge-failed-sign-ins (daily).');

  const stop = async () => {
    await boss.stop({ graceful: true, timeout: 30_000 });
    await pool?.end();
  };
  const alive = async () => {
    await boss.getQueue('process-version');
    await db.transaction((tx) => tx.query('select 1'));
  };
  return { stop, alive };
}

export async function touchHeartbeat(file: string, alive: () => Promise<unknown>, timeoutMs = 10_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      alive(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } catch (err) {
    const why = err instanceof Error ? err.message : err;
    console.error(`Worker heartbeat skipped: the job queue or the database did not answer (${why}).`);
    return false;
  } finally {
    clearTimeout(timer);
  }
  await writeFile(file, new Date().toISOString());
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWorker().then(({ stop }) => {
    const shutdown = () => {
      stop().then(() => process.exit(0), () => process.exit(1));
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
