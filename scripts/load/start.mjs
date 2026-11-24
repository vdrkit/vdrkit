#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Runs the dist/ API or worker against the load db, in the background.
//   node scripts/load/start.mjs api      the API on LOAD_API_PORT (4601)
//   node scripts/load/start.mjs worker   the worker; set GOTENBERG_URL and CLAMAV_HOST/CLAMAV_PORT for real conversion and scanning
//   node scripts/load/start.mjs api --port 4602   a second API process on the same database
//   node scripts/load/start.mjs stop     stops every API and worker it started, by their PIDs
// Build first: corepack pnpm@9.15.4 --filter @vdrkit/core build && corepack pnpm@9.15.4 --filter @vdrkit/server build
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { API_PORT, APP_URL, AUTH_SECRET, MASTER_KEY, QUEUE_URL, ROOT, WORK } from './config.mjs';

const role = process.argv[2] ?? 'api';
const portArg = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : null;
const name = portArg ? `${role}-${portArg}` : role;
mkdirSync(WORK, { recursive: true });

function stop(r) {
  const f = `${WORK}/${r}.pid`;
  if (!existsSync(f)) return;
  const pid = readFileSync(f, 'utf8').trim();
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
  else try { process.kill(Number(pid), 'SIGTERM'); } catch { /* gone */ }
  rmSync(f);
  console.log(`Stopped ${r} (PID ${pid}).`);
}

if (role === 'stop') {
  for (const f of readdirSync(WORK).filter((x) => /^(api|worker)(-\d+)?\.pid$/.test(x))) stop(f.slice(0, -4));
  process.exit(0);
}
if (!['api', 'worker'].includes(role)) throw new Error('Use api, worker or stop.');
stop(name);

// minimal env: nothing that could carry mail settings or secrets
const pick = (keys) => Object.fromEntries(keys.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
const env = {
  ...pick(['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'GOTENBERG_URL', 'CLAMAV_HOST', 'CLAMAV_PORT', 'CLAMAV_MAX_BYTES',
    'DB_POOL_SIZE', 'RATE_LIMIT_STORE', 'PREVIEW_MAX_BYTES', 'UV_THREADPOOL_SIZE']),
  NODE_ENV: 'production',
  LOAD_ROLE: name,
  NODE_OPTIONS: `--import ${new URL('./memwatch.mjs', import.meta.url).href}${process.env.LOAD_NODE_OPTIONS ? ` ${process.env.LOAD_NODE_OPTIONS}` : ''}`,
  DATABASE_URL: APP_URL,
  QUEUE_DATABASE_URL: QUEUE_URL,
  BETTER_AUTH_SECRET: AUTH_SECRET,
  PUBLIC_URL: `http://127.0.0.1:${API_PORT}`,
  PORT: portArg ?? API_PORT,
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_DIR: `${WORK}/storage`,
  VDRKIT_MASTER_KEY: MASTER_KEY,
  CLAMAV_HOST: process.env.CLAMAV_HOST ?? '',
  WORKER_TENANT_IDS: 'de300000-0000-4000-8000-000000000001',
};
rmSync(`${WORK}/${name}-mem.json`, { force: true });
const out = openSync(`${WORK}/${name}.log`, 'w');
const child = spawn(process.execPath, [`${ROOT}apps/server/dist/main.js`, role], { cwd: `${ROOT}apps/server`, env, stdio: ['ignore', out, out], detached: true });
child.unref();
writeFileSync(`${WORK}/${name}.pid`, String(child.pid));
console.log(`Started ${name} (PID ${child.pid}), log in scripts/load/.work/${name}.log.`);
