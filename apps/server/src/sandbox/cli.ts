// SPDX-License-Identifier: AGPL-3.0-only
import pg from 'pg';
import { fromPgPool, migrate, refuseUnsafeRole } from '@vdrkit/core';
import { LocalKeyProvider } from '../crypto/envelope.js';
import { clamAvFromEnv } from '../pipeline/virus-scan.js';
import { LocalDiskStorage } from '../storage/local-disk.js';
import { nextReset, refuseUnsafeSandboxEnv, RESET_TIME_TEXT, sandboxFlag } from './config.js';
import { resetSandbox, type ResetOptions } from './reset.js';
import { SandboxRefused } from './check.js';

export const SANDBOX_ROLES = ['sandbox-init', 'sandbox-reset', 'sandbox-scheduler'] as const;
export type SandboxRole = (typeof SANDBOX_ROLES)[number];

const log = (msg: string) => console.log(`[sandbox] ${msg}`);
const RETRIES = 4;
const RETRY_MS = 15 * 60_000;

async function runOnce(mode: 'init' | 'reset'): Promise<void> {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  const appUrl = process.env.DATABASE_URL;
  if (!ownerUrl) throw new Error('MIGRATION_DATABASE_URL is not set. The sandbox reset empties the tables as the database owner.');
  if (!appUrl) throw new Error('DATABASE_URL is not set.');
  const masterKey = process.env.VDRKIT_MASTER_KEY;
  if (!masterKey) throw new Error('VDRKIT_MASTER_KEY is not set.');
  const dir = process.env.STORAGE_LOCAL_DIR || './data/storage';
  const owner = new pg.Pool({ connectionString: ownerUrl, max: 2 });
  const app = new pg.Pool({ connectionString: appUrl, max: 4 });
  try {
    const ownerDb = fromPgPool(owner);
    const appDb = fromPgPool(app);
    await refuseUnsafeRole(ownerDb, 'MIGRATION_DATABASE_URL', 'sandbox reset');
    await refuseUnsafeRole(appDb, 'DATABASE_URL', 'sandbox reset');
    if (mode === 'init') await migrate(ownerDb, { log });
    const options: ResetOptions = {
      ownerDb, appDb, storageDir: dir, storage: new LocalDiskStorage(dir), keyProvider: new LocalKeyProvider(masterKey),
      gotenbergUrl: process.env.GOTENBERG_URL?.trim() || null, clamav: clamAvFromEnv(), log,
    };
    const cacheDir = process.env.SANDBOX_CACHE_DIR?.trim();
    if (cacheDir) options.cacheDir = cacheDir;
    const r = await resetSandbox(mode, options);
    log(r.action === 'kept' ? 'Kept the sandbox as it is.' : `Done (${r.action}, cache ${r.cache}, ${r.seconds} s).`);
  } finally {
    await owner.end();
    await app.end();
  }
}

export async function runSandboxRole(role: SandboxRole): Promise<void> {
  if (!sandboxFlag()) throw new Error(`"${role}" runs only with VDRKIT_SANDBOX=1. It empties the database: never point it at a real installation.`);
  refuseUnsafeSandboxEnv();
  if (role === 'sandbox-init') return runOnce('init');
  if (role === 'sandbox-reset') return runOnce('reset');
  log(`Resets the sandbox every day at ${RESET_TIME_TEXT}.`);
  for (;;) {
    const at = nextReset(new Date());
    log(`Next reset at ${at.toISOString()}.`);
    await new Promise((r) => setTimeout(r, Math.max(1000, at.getTime() - Date.now())));
    await resetWithRetries();
  }
}

// a failed reset may leave the sandbox down: retry soon
export async function resetWithRetries(run: () => Promise<void> = () => runOnce('reset'), waitMs = RETRY_MS, tries = RETRIES): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try {
      await run();
      return true;
    } catch (err) {
      // a refusal changes nothing and would refuse again
      if (err instanceof SandboxRefused || attempt >= tries) {
        console.error(`[sandbox] The reset failed${attempt > 1 ? ` ${attempt} times` : ''}; the next one runs tomorrow.`, err);
        return false;
      }
      console.error(`[sandbox] The reset failed; trying again in ${Math.round(waitMs / 60_000)} minutes (${attempt} of ${tries - 1}).`, err);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}
