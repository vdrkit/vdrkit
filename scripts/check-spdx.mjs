#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// usage: check-spdx.mjs [--fix]   (skips design/ and generated files)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ID = 'SPDX-License-Identifier: AGPL-3.0-only';
const COMMENT = { ts: '//', tsx: '//', js: '//', mjs: '//', cjs: '//', sql: '--', sh: '#' };
const GENERATED = new Set([
  'apps/dataroom/src/api/schema.d.ts', // scripts/generate-api-types.mjs (openapi-typescript)
  'apps/dataroom/next-env.d.ts', // next build and next dev
]);

const SKIPPED = ['design/', 'node_modules/'];

export function headerFor(path) {
  const ext = /\.([a-z]+)$/.exec(path)?.[1];
  if (!ext || !(ext in COMMENT) || GENERATED.has(path)) return null;
  if (SKIPPED.some((d) => path.startsWith(d) || path.includes(`/${d}`))) return null;
  return `${COMMENT[ext]} ${ID}`;
}

function split(text) {
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const body = bom ? text.slice(1) : text;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/);
  const at = lines[0]?.startsWith('#!') ? 1 : 0;
  return { bom, eol, lines, at };
}

export function hasHeader(text, header) {
  const { lines, at } = split(text);
  return lines[at] === header;
}

export function withHeader(text, header) {
  if (hasHeader(text, header)) return text;
  const { bom, eol, lines, at } = split(text);
  lines.splice(at, 0, header);
  return bom + lines.join(eol);
}

function sourceFiles() {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return [...new Set(out.split('\n').map((l) => l.trim()).filter(Boolean))].filter((p) => headerFor(p) && existsSync(resolve(ROOT, p)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fix = process.argv.includes('--fix');
  const missing = [];
  const files = sourceFiles();
  for (const path of files) {
    const full = resolve(ROOT, path);
    const header = headerFor(path);
    const text = readFileSync(full, 'utf8');
    if (hasHeader(text, header)) continue;
    if (fix) writeFileSync(full, withHeader(text, header));
    missing.push(path);
  }
  if (fix) {
    console.log(missing.length ? `Added the SPDX header to ${missing.length} of ${files.length} files.` : `All ${files.length} files have the SPDX header.`);
  } else if (missing.length) {
    console.error(`${missing.length} of ${files.length} source files lack the licence header on their first line (after any #! line):`);
    for (const p of missing) console.error(`  ${p}`);
    console.error(`Add "${ID}" as a comment (// in TypeScript and JavaScript, -- in SQL, # in shell scripts), or run`);
    console.error('  node scripts/check-spdx.mjs --fix');
    process.exit(1);
  } else {
    console.log(`All ${files.length} source files have the SPDX header.`);
  }
}
