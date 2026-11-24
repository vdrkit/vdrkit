// SPDX-License-Identifier: AGPL-3.0-only
// throwaway values for the local load db; env overrides
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\\/g, '/');
export const WORK = `${ROOT}scripts/load/.work`;

const env = process.env;
export const PG_PORT = env.LOAD_PG_PORT ?? '4620';
export const PG_HOST = env.LOAD_PG_HOST ?? '127.0.0.1';
export const APP_URL = env.LOAD_DATABASE_URL ?? `postgres://vdrkit_app:load_app@${PG_HOST}:${PG_PORT}/vdrkit`;
export const OWNER_URL = env.LOAD_MIGRATION_DATABASE_URL ?? `postgres://vdrkit_owner:load_owner@${PG_HOST}:${PG_PORT}/vdrkit`;
export const QUEUE_URL = env.LOAD_QUEUE_DATABASE_URL ?? `postgres://vdrkit_queue:load_queue@${PG_HOST}:${PG_PORT}/vdrkit`;
export const API_PORT = env.LOAD_API_PORT ?? '4601';
export const API = env.LOAD_API ?? `http://127.0.0.1:${API_PORT}`;
/** Origin header: required on cookie writes */
export const ORIGIN = `http://127.0.0.1:${API_PORT}`;
/** must match the API under test */
export const AUTH_SECRET = env.LOAD_AUTH_SECRET ?? 'load-test-only-secret-not-for-any-real-install-0001';
export const MASTER_KEY = env.LOAD_MASTER_KEY ?? Buffer.from('load-test-master-key-32-bytes!!!').toString('base64');

export const TENANT = 'de300000-0000-4000-8000-000000000001';

const require = createRequire(`${ROOT}apps/server/package.json`);
export const pg = require('pg');
export const core = await import(pathToFileURL(`${ROOT}packages/core/dist/index.js`).href);

export function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => (s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] : NaN);
  return { n: s.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s[s.length - 1] ?? NaN, mean: s.reduce((a, b) => a + b, 0) / (s.length || 1) };
}
