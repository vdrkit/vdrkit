// SPDX-License-Identifier: AGPL-3.0-only
// node apps/server/scripts/export-openapi.mjs [out.json]  (build first)
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

process.env.NODE_ENV ??= 'development';
const { buildApp } = await import('../dist/app.js');

const refuse = () => {
  throw new Error('export-openapi: the stand-in dependencies must not be used.');
};
const db = new Proxy({}, { get: refuse });
const auth = { authenticate: async () => null };

const { sessionRoutes } = await import('../dist/auth/session-routes.js');
const betterAuth = new Proxy({}, {
  get(_target, key) {
    if (key !== 'vdrkit') refuse();
    return new Proxy({}, { get: refuse });
  },
});

const app = await buildApp({ db, auth, rateLimit: false, logger: false, skipStartupTasks: true, plugins: [sessionRoutes(betterAuth)] });
await app.ready();
const doc = app.swagger();
await app.close();

const out = resolve(process.argv[2] ?? 'openapi.json');
await writeFile(out, JSON.stringify(doc, null, 2) + '\n');
console.log(`Wrote ${Object.keys(doc.paths ?? {}).length} paths to ${out}`);
