#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const [which = 'all', ...rest] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const cli = require.resolve('@playwright/test/cli');
const runs = which === 'all' ? ['firefox', 'webkit', 'edge'] : [which];
let failed = 0;
for (const browsers of runs) {
  console.log(`\n=== Playwright in ${browsers} ===\n`);
  const res = spawnSync(process.execPath, [cli, 'test', ...rest], { stdio: 'inherit', env: { ...process.env, E2E_BROWSERS: browsers } });
  if (res.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
