// SPDX-License-Identifier: AGPL-3.0-only
// Dev only: public sandbox on PGlite. --reset keeps the page cache
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.NODE_ENV === 'production') {
  console.error('dev:sandbox: not for production (NODE_ENV=production)');
  process.exit(1);
}
process.env.NODE_ENV ??= 'development';
process.env.VDRKIT_SANDBOX = '1';
process.env.STORAGE_DRIVER = 'local';

const here = fileURLToPath(new URL('.', import.meta.url));
const DIR = resolve(process.env.VDRKIT_DEV_DIR ?? resolve(here, '../../.dev-db-sandbox'));
const CACHE = `${DIR}-cache`;
const PORT = Number(process.env.API_PORT ?? 3141);
const publicUrl = process.env.PUBLIC_URL ?? 'http://127.0.0.1:3140';
const log = (msg: string) => console.log(`[dev:sandbox] ${msg}`);

if (process.argv.includes('--reset') && existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
mkdirSync(CACHE, { recursive: true });
// lives with the cache, which outlives --reset
const keyFile = resolve(CACHE, 'master.key');
if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('base64'), { mode: 0o600 });
const secretFile = resolve(DIR, 'auth.secret');
if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString('base64'), { mode: 0o600 });

const { PGlite } = await import('@electric-sql/pglite');
const { ltree } = await import('@electric-sql/pglite/contrib/ltree');
const { fromPGlite, migrate } = await import('@vdrkit/core');
const { buildApp } = await import('../../src/app.js');
const { BetterAuthAuthenticator, betterAuthRoutes, createBetterAuth } = await import('../../src/auth/better-auth.js');
const { sessionRoutes } = await import('../../src/auth/session-routes.js');
const { poolFromPGlite } = await import('../../src/auth/pool.js');
const { LocalKeyProvider } = await import('../../src/crypto/envelope.js');
const { DbKeyring } = await import('../../src/crypto/keyring.js');
const { LocalDiskStorage } = await import('../../src/storage/local-disk.js');
const { MemoryQueue } = await import('../../src/worker/jobs.js');
const { checkSandboxStart } = await import('../../src/sandbox/check.js');
const { resetSandbox } = await import('../../src/sandbox/reset.js');
const { sandboxMailer } = await import('../../src/sandbox/mail.js');

const lite = new PGlite(resolve(DIR, 'pgdata'), { extensions: { ltree } });
const db = fromPGlite(lite);
await migrate(db);
const storageDir = resolve(DIR, 'storage');
const storage = new LocalDiskStorage(storageDir);
const keyProvider = new LocalKeyProvider(readFileSync(keyFile, 'utf8').trim());
const loaded = await resetSandbox('init', {
  ownerDb: db, appDb: db, appRole: 'vdrkit_app', storageDir, storage, keyProvider,
  gotenbergUrl: process.env.GOTENBERG_URL?.trim() || null, clamav: null, log,
  cacheDir: resolve(CACHE, 'files-cache'),
});
if (loaded.action === 'kept') log('The sandbox is loaded.');
else log(`Loaded the sandbox (${loaded.action}, cache ${loaded.cache}, ${loaded.seconds} s).`);
await lite.exec('analyze');
for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_URL', 'MAIL_FROM']) delete process.env[k];
await checkSandboxStart(db, 'api', { dbRole: 'vdrkit_app' });

const addresses = [publicUrl, publicUrl.replace('127.0.0.1', 'localhost'), publicUrl.replace('localhost', '127.0.0.1')];
const origins = [...new Set(addresses.map((u) => new URL(u).origin))];
const auth = createBetterAuth({
  db, pool: poolFromPGlite(lite), secret: readFileSync(secretFile, 'utf8').trim(), publicUrl, mailer: sandboxMailer, storage, dbRole: 'vdrkit_app',
  trustedOrigins: origins, builtInRateLimit: false,
});
const app = await buildApp({
  db, auth: new BetterAuthAuthenticator(auth, db, 'vdrkit_app'), dbRole: 'vdrkit_app', logger: process.env.DEV_API_LOG === '1',
  storage, keyring: new DbKeyring(keyProvider), queue: new MemoryQueue(), mailer: sandboxMailer, publicUrl, trustedOrigins: origins,
  rateLimit: false,
  plugins: [betterAuthRoutes(auth, publicUrl), sessionRoutes(auth)],
  site: { setup: false },
  sandbox: { auth },
});
await app.listen({ host: process.env.API_HOST ?? '127.0.0.1', port: PORT });
log(`Sandbox API on http://127.0.0.1:${PORT}/v1 (PGlite in ${DIR}). Open ${publicUrl}/try.`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => { void app.close().finally(() => lite.close().finally(() => process.exit(0))); });
}
