// SPDX-License-Identifier: AGPL-3.0-only
// usage: node prune.mjs /out/server  (drops better-auth's optional peers, musl builds, .d.ts, maps)
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '/out/server');
const store = join(root, 'node_modules', '.pnpm');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const unused = [
  /^@next\+/, /^next@/, /^@playwright\+/, /^playwright(-core)?@/, /^esbuild@/, /^@esbuild\+/, /^vite@/, /^vitest@/,
  /^@vitest\+/, /^rollup@/, /^@rollup\+/, /^typescript@/, /^@types\+/, /^caniuse-lite@/, /^styled-jsx@/, /^react@/,
  /^react-dom@/, /^scheduler@/, /^@swc\+/, /linuxmusl/,
];
// keep only the server's own sharp and its @img builds
const sharpDir = readdirSync(store).find((d) => d.startsWith(`sharp@${pkg.dependencies.sharp}`));
if (!sharpDir) throw new Error(`sharp@${pkg.dependencies.sharp} is not in the deploy output`);
const keepImg = new Set();
const imgLinks = join(store, sharpDir, 'node_modules', '@img');
for (const name of readdirSync(imgLinks)) {
  const target = readlinkSync(join(imgLinks, name));
  const dir = target.split(/[\\/]/).find((part) => part.startsWith('@img+'));
  if (dir) keepImg.add(dir);
}

let freed = 0;
const size = (p) => {
  const st = lstatSync(p);
  if (!st.isDirectory()) return st.size;
  return readdirSync(p).reduce((n, f) => n + size(join(p, f)), 0);
};
const remove = (p) => { freed += size(p); rmSync(p, { recursive: true, force: true }); };

for (const dir of readdirSync(store)) {
  const isOtherSharp = dir.startsWith('sharp@') && dir !== sharpDir;
  const isOtherImg = dir.startsWith('@img+') && !keepImg.has(dir);
  if (isOtherSharp || isOtherImg || unused.some((r) => r.test(dir))) remove(join(store, dir));
}

const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p);
    else if (/\.(map|d\.ts|d\.mts|d\.cts)$/.test(name)) { freed += st.size; rmSync(p); }
  }
};
walk(join(root, 'node_modules'));
console.log(`prune: removed ${(freed / 1024 / 1024).toFixed(0)} MB from ${basename(root)}`);

// -e resolves bare names from cwd
const deps = [...Object.keys(pkg.dependencies), 'better-auth/api', 'better-auth/cookies', 'better-auth/crypto', 'better-auth/plugins'];
execFileSync(process.execPath, ['--input-type=module', '-e', `for (const d of ${JSON.stringify(deps)}) await import(d);`], { cwd: root, stdio: 'inherit' });
console.log(`prune: all ${deps.length} dependencies of the server still load`);
