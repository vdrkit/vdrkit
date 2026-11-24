#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// API on PGlite + Next.js with dev auth.
//   corepack pnpm@9.15.4 dev:stack                                  # Next on 3100, API on 3101
//   corepack pnpm@9.15.4 dev:stack -- --port 3200 --api-port 3201   # or PORT=3200 API_PORT=3201
//   corepack pnpm@9.15.4 dev:stack -- --reset                       # reload the demo data first
//   corepack pnpm@9.15.4 dev:stack -- --sign-in                     # real sign-in; codes go to the API log
//   corepack pnpm@9.15.4 dev:stack -- --sign-in --empty --reset     # an empty installation, first-run setup at /setup
//   corepack pnpm@9.15.4 dev:stack -- --no-real-mail                # never send real email, whatever .env says
//   corepack pnpm@9.15.4 dev:stack -- --no-converter                # no Gotenberg, whatever GOTENBERG_URL says
// Mail, Gotenberg and demo-domain settings come from env or .env (never printed).
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { devStackConverterEnv } from './dev-converter-env.mjs';
import { devStackDemoEnv } from './dev-demo-env.mjs';
import { devStackMailEnv } from './dev-mail-env.mjs';

if (process.env.NODE_ENV === 'production') {
  console.error('dev:stack is for development only.');
  process.exit(1);
}

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const port = arg('--port') ?? process.env.PORT ?? '3100';
const apiPort = arg('--api-port') ?? process.env.API_PORT ?? '3101';
const root = fileURLToPath(new URL('..', import.meta.url));
const win = process.platform === 'win32';
const realSignIn = args.includes('--sign-in');
const mailEnv = devStackMailEnv(process.env, resolve(root, '.env'), { noRealMail: args.includes('--no-real-mail') });
const converterEnv = devStackConverterEnv(process.env, resolve(root, '.env'), { noConverter: args.includes('--no-converter') });
const demoEnv = devStackDemoEnv(process.env, resolve(root, '.env'));
const env = { ...process.env, PORT: port, API_PORT: apiPort, VDRKIT_DEV_AUTH: realSignIn ? '' : '1', NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'development',
  PUBLIC_URL: process.env.PUBLIC_URL ?? `http://127.0.0.1:${port}` };

function run(name, cmdArgs, extraEnv = {}) {
  const child = spawn(win ? 'pnpm.cmd' : 'pnpm', cmdArgs, { cwd: root, env: { ...env, ...extraEnv }, stdio: 'inherit', shell: win, detached: !win });
  child.on('exit', (code) => { console.log(`[dev:stack] ${name} stopped (${code ?? 'signal'}).`); stopAll(code ?? 1); });
  return child;
}

const apiFlags = ['--reset', '--empty'].filter((f) => args.includes(f));
// .env extras: API only
const api = run('API', ['--filter', '@vdrkit/server', 'dev:pglite', ...(apiFlags.length ? ['--', ...apiFlags] : [])], { ...mailEnv, ...converterEnv, ...demoEnv });
const web = run('Next.js', ['--filter', '@vdrkit/dataroom', 'dev']);
console.log(`[dev:stack] Front end http://127.0.0.1:${port}${realSignIn ? ' (real sign-in)' : ''}, API http://127.0.0.1:${apiPort}/v1. Ctrl C stops both.`);

let stopping = false;
function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of [api, web]) {
    if (c.exitCode !== null || !c.pid) continue;
    // kill by tree PID, never all node processes
    if (win) spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else try { process.kill(-c.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  process.exit(code);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => stopAll(0));
