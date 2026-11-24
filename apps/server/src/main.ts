// SPDX-License-Identifier: AGPL-3.0-only
import { availableParallelism } from 'node:os';
import pg from 'pg';
import { fromPgPool, migrate, migrationStatus, refuseUnsafeRole, type Channel, type Database } from '@vdrkit/core';
import { buildApp, type AppOptions, type SiteOptions } from './app.js';
import type { Storage } from './pipeline/pipeline.js';
import { authFromEnv } from './auth-from-env.js';
import { describeSmtp } from './mail/smtp.js';
import { SiteMailChannel } from './site/mail.js';
import { LocalKeyProvider } from './crypto/envelope.js';
import { storageFromEnv } from './storage/index.js';
import { SharedRateLimits } from './rate-limit.js';
import { checkSandboxStart } from './sandbox/check.js';
import { RESET_TIME_TEXT } from './sandbox/config.js';
import { sandboxMailer } from './sandbox/mail.js';
import { LOGGER, refusePlaceholders, trustProxyFrom } from './startup.js';

// main.js [api | worker | migrate]
async function main() {
  // libuv default (4) starves watermarking; must be set before first use
  process.env.UV_THREADPOOL_SIZE ??= String(Math.min(32, Math.max(4, availableParallelism())));
  const role = process.argv[2] ?? 'api';
  refusePlaceholders();
  if (role.startsWith('sandbox-')) {
    const { runSandboxRole, SANDBOX_ROLES } = await import('./sandbox/cli.js');
    if ((SANDBOX_ROLES as readonly string[]).includes(role)) return runSandboxRole(role as (typeof SANDBOX_ROLES)[number]);
  }
  if (!['api', 'worker', 'migrate'].includes(role)) throw new Error(`Unknown role "${role}". Use api, worker or migrate.`);
  if (role === 'migrate') {
    if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is not set. The migrate command connects as the database owner.');
    await applyMigrations(process.env.MIGRATION_DATABASE_URL);
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');
  if (role === 'api') {
    // parallelism comes from the threadpool instead
    const { default: sharp } = await import('sharp');
    sharp.concurrency(1);
  }
  const { queueRoleWarning } = await import('./worker/pg-boss-queue.js');
  const queueWarning = queueRoleWarning(process.env);
  if (queueWarning) console.error(`
${'!'.repeat(80)}
${queueWarning}
${'!'.repeat(80)}
`);

  if (process.env.MIGRATION_DATABASE_URL) await applyMigrations(process.env.MIGRATION_DATABASE_URL);

  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.DB_POOL_SIZE ?? 10) });
  const db = fromPgPool(pool);
  // superuser/BYPASSRLS would silently skip RLS
  await refuseUnsafeRole(db, 'DATABASE_URL', role);
  await refuseOutdatedDatabase(db, role);
  const sandbox = await checkSandboxStart(db, role);
  const storage = storageFromEnv();
  const keyProvider = process.env.VDRKIT_MASTER_KEY ? new LocalKeyProvider(process.env.VDRKIT_MASTER_KEY) : undefined;
  const mailer: Channel = sandbox ? sandboxMailer : new SiteMailChannel({ db, keyProvider });
  const mailServer = describeSmtp();
  if (sandbox) console.log(`Sandbox mode: invented data, no email, wiped daily at ${RESET_TIME_TEXT}.`);
  else if (mailServer) console.log(`Outgoing email through ${mailServer}, unless Site settings has its own.`);
  else console.log('No mail server in the installation file: emails are recorded as not sent until Site settings has one.');

  if (role === 'worker') {
    const { runWorker, touchHeartbeat } = await import('./worker-main.js');
    const { stop, alive } = await runWorker({ db, storage, mailer });
    const beat = process.env.VDRKIT_HEARTBEAT_FILE;
    if (beat) {
      const touch = () => touchHeartbeat(beat, alive).catch((err) => console.error('Heartbeat file:', err));
      await touch();
      setInterval(() => void touch(), 30_000).unref();
    }
    for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => { stop().then(() => process.exit(0), () => process.exit(1)); });
    return;
  }

  const files = storage && process.env.VDRKIT_MASTER_KEY ? await uploadDeps(url) : {};
  const shared = (process.env.RATE_LIMIT_STORE ?? 'postgres') === 'memory' ? undefined : new SharedRateLimits(db);
  const { betterAuth, ...signIn } = await authFromEnv(db, pool, mailer, storage, shared);
  if (sandbox && !betterAuth) throw new Error('Sandbox mode needs real sign-in sessions: set BETTER_AUTH_SECRET and PUBLIC_URL.');
  const site: SiteOptions = {};
  if (keyProvider) site.keyProvider = keyProvider;
  if (sandbox) site.setup = false;
  const options: AppOptions = {
    db, logger: LOGGER, storage, mailer, ...files, ...signIn, site,
    rateLimit: shared ? { shared } : {},
    // only Caddy on the private network may set X-Forwarded-For
    trustProxy: trustProxyFrom(),
  };
  if (sandbox && betterAuth) options.sandbox = { auth: betterAuth };
  const app = await buildApp(options);
  await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3001) });
  // close lets sign-in emails still in flight go out
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => { app.close().then(() => process.exit(0), () => process.exit(1)); });
}

async function applyMigrations(ownerUrl: string): Promise<void> {
  const owner = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  try {
    // owner runs the security definer functions: BYPASSRLS would cross tenants
    await refuseUnsafeRole(fromPgPool(owner), 'MIGRATION_DATABASE_URL', 'migration');
    await migrate(fromPgPool(owner), { log: (line) => console.log(line) });
  } finally {
    await owner.end();
  }
}

async function refuseOutdatedDatabase(db: Database, role: string): Promise<void> {
  const { pending, unknown } = await migrationStatus(db);
  if (pending.length) {
    const list = pending.length > 5 ? `${pending.slice(0, 5).join(', ')} and ${pending.length - 5} more` : pending.join(', ');
    throw new Error(`The database is not up to date: ${pending.length} migration${pending.length === 1 ? '' : 's'} not applied (${list}). `
      + `The ${role} does not start. Run the migrate command first ("docker compose run --rm migrate"), or set MIGRATION_DATABASE_URL so this process applies them.`);
  }
  if (unknown.length) console.error(`The database has ${unknown.length} migration${unknown.length === 1 ? '' : 's'} this version does not know (${unknown.join(', ')}). It was migrated by a newer version.`);
}

async function uploadDeps(url: string) {
  const { LocalKeyProvider } = await import('./crypto/envelope.js');
  const { DbKeyring } = await import('./crypto/keyring.js');
  const { PgBossQueue } = await import('./worker/pg-boss-queue.js');
  const { default: PgBoss } = await import('pg-boss');
  const boss = new PgBoss({ connectionString: process.env.QUEUE_DATABASE_URL ?? url, schema: 'pgboss' });
  boss.on('error', (err) => console.error('pg-boss:', err));
  await boss.start();
  return {
    keyring: new DbKeyring(new LocalKeyProvider(process.env.VDRKIT_MASTER_KEY!)),
    queue: new PgBossQueue(boss as unknown as ConstructorParameters<typeof PgBossQueue>[0]),
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
