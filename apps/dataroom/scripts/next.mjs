#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const [cmd = 'dev', ...rest] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const bin = require.resolve('next/dist/bin/next');
const port = process.env.PORT || '3100';
const host = process.env.HOSTNAME_BIND || '127.0.0.1';
const child = spawn(process.execPath, [bin, cmd, '--port', port, '--hostname', host, ...rest], { stdio: 'inherit', env: process.env });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
